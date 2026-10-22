/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The compiler-owned CSS transformation stage (CE-01.2, D-BP-07/D-BP-09).
 *
 * One pure, declaration-local function over a rule text, driven only by the
 * committed table `catalog/transforms.v1.json`. It takes no target, host, file
 * or ordering input, so CSS bytes never depend on targets, and applying it per
 * rule equals applying it to the complete candidate. Rule ordering reads the
 * untransformed text; the final serialization (`transformRuleEntry`) and the
 * texts target extraction reads both go through `applyTransforms`.
 *
 * `prefix-alias`: `user-select:none` becomes
 * `-webkit-user-select:none;user-select:none`. The standard form stays last.
 */

import table from './catalog/transforms.v1.json';

export const TRANSFORM_TABLE_KIND = 'pandamstyle-transform-table';
export const TRANSFORM_KINDS = Object.freeze(['prefix-alias']);

const VENDOR_PREFIXES = new Set(['-webkit-', '-moz-']);

const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '';

/** Problems of a transform table; an empty list means it is admissible. */
export function transformTableProblems(candidate) {
  const problems = [];
  if (
    candidate == null ||
    candidate.kind !== TRANSFORM_TABLE_KIND ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.entries)
  ) {
    return ['table'];
  }
  const ids = new Set();
  const names = new Set();
  candidate.entries.forEach((entry, index) => {
    const at = (problem) => problems.push(`entries[${index}]: ${problem}`);
    if (!TRANSFORM_KINDS.includes(entry?.kind)) {
      at('unknown kind');
      return;
    }
    if (!nonEmptyString(entry.id) || ids.has(entry.id)) at('id');
    ids.add(entry.id);
    if (!/^[a-z][a-z-]*$/.test(entry.property ?? '')) at('property');
    if (!VENDOR_PREFIXES.has(entry.prefix)) at('prefix');
    if (entry.variant !== `${entry.prefix}${entry.property}`) at('variant');
    for (const name of [entry.property, entry.variant]) {
      if (names.has(name)) at(`property ${name} in two entries`);
      names.add(name);
    }
    if (
      !Array.isArray(entry.values) ||
      entry.values.length === 0 ||
      !entry.values.every((v) => /^[a-z][a-z-]*$/.test(v))
    ) {
      at('values');
    }
    const proof = entry.proof;
    if (proof == null || typeof proof !== 'object') {
      at('proof');
      return;
    }
    if (!nonEmptyString(proof.rationale)) at('proof.rationale');
    if (
      !Array.isArray(proof.fixtures) ||
      proof.fixtures.length === 0 ||
      !proof.fixtures.every(nonEmptyString)
    ) {
      at('proof.fixtures');
    }
    const executed = proof.evidence?.executed;
    if (
      !Array.isArray(executed) ||
      executed.length === 0 ||
      !executed.every(
        (e) =>
          e.class === 'E4' &&
          Array.isArray(e.engines) &&
          e.engines.length > 0 &&
          nonEmptyString(e.test),
      )
    ) {
      at('proof.evidence.executed');
    }
    const deferred = proof.evidence?.deferred ?? [];
    if (
      !Array.isArray(deferred) ||
      !deferred.every(
        (d) =>
          Array.isArray(d.engines) &&
          Number.isInteger(d.issue) &&
          nonEmptyString(d.check),
      )
    ) {
      at('proof.evidence.deferred');
    }
  });
  return problems;
}

function compile(candidate) {
  const problems = transformTableProblems(candidate);
  if (problems.length > 0) {
    throw new Error(
      `pandamstyle: the transform table is not admissible: ${problems.join('; ')}`,
    );
  }
  const entries = candidate.entries.map((entry) =>
    Object.freeze({
      ...entry,
      values: Object.freeze([...entry.values]),
      needle: `${entry.property}:`,
      valueSet: new Set(entry.values),
    }),
  );
  return Object.freeze({
    entries: Object.freeze(entries),
    byProperty: new Map(entries.map((e) => [e.property, e])),
    byVariant: new Map(entries.map((e) => [e.variant, e])),
  });
}

const committed = compile(table);

/** The committed table (test seam: `compileTransformTable` for others). */
export function transformTable() {
  return table;
}

export function compileTransformTable(candidate) {
  return compile(candidate);
}

/** The entry whose base property is `name`, or null. */
export function transformOfProperty(name, compiled = committed) {
  return compiled.byProperty.get(name) ?? null;
}

/** The entry whose variant is `name`, or null. */
export function transformOfVariant(name, compiled = committed) {
  return compiled.byVariant.get(name) ?? null;
}

const QUOTE_DOUBLE = 34;
const QUOTE_SINGLE = 39;
const BACKSLASH = 92;

function isSpace(code) {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

/** Whether `index` starts a declaration name: after `{` or `;` (and space). */
function startsDeclaration(text, index) {
  let k = index - 1;
  while (k >= 0 && isSpace(text.charCodeAt(k))) k -= 1;
  if (k < 0) return false;
  const code = text.charCodeAt(k);
  return code === 123 || code === 59;
}

/** Positions inside a quoted string, computed only when a rewrite may apply. */
function quotedAt(text, index) {
  let quote = 0;
  for (let i = 0; i < index; i += 1) {
    const code = text.charCodeAt(i);
    if (quote !== 0) {
      if (code === BACKSLASH) i += 1;
      else if (code === quote) quote = 0;
    } else if (code === QUOTE_DOUBLE || code === QUOTE_SINGLE) {
      quote = code;
    }
  }
  return quote !== 0;
}

/** End of a declaration value starting at `from`: the next `;` or `}`. */
function valueEnd(text, from) {
  for (let i = from; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 59 || code === 125) return i;
  }
  return text.length;
}

function keywordOf(rawValue) {
  return rawValue
    .replace(/!\s*important\s*$/i, '')
    .trim()
    .toLowerCase();
}

function rewriteEntry(text, entry) {
  let out = '';
  let from = 0;
  let at = text.indexOf(entry.needle);
  while (at !== -1) {
    const start = at;
    const valueStart = at + entry.needle.length;
    const end = valueEnd(text, valueStart);
    at = text.indexOf(entry.needle, end);
    if (!startsDeclaration(text, start) || quotedAt(text, start)) continue;
    const rawValue = text.slice(valueStart, end);
    if (!entry.valueSet.has(keywordOf(rawValue))) continue;
    // Already paired (an idempotent second application).
    const pair = `${entry.variant}:${rawValue};`;
    if (text.slice(Math.max(0, start - pair.length), start) === pair) continue;
    out += text.slice(from, start) + pair;
    from = start;
  }
  return from === 0 && out === '' ? text : out + text.slice(from);
}

/**
 * The transformed rule text. Returns the same string when no entry applies;
 * the cost on a rule without a table property is one `includes` per entry.
 */
export function applyTransforms(text, compiled = committed) {
  if (typeof text !== 'string') return text;
  let result = text;
  for (const entry of compiled.entries) {
    if (result.includes(entry.needle)) result = rewriteEntry(result, entry);
  }
  return result;
}
