/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Parser-based declaration extraction for the CE-00.2 coverage classifier.
//
// Every declaration of a stylesheet becomes one record. Nothing is dropped:
// records that the recovered Alpha 1 measurement did not count (custom
// properties, @keyframes frames, layers outside the measured layer) stay in
// the output with an explicit denominator reason. Selectors are never kept:
// only their standard state context (pseudo-classes, pseudo-elements and
// allow-listed attribute names) survives, so consumer class names, ids and
// attribute values cannot leak into published fixtures.

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PUBLIC_DIGESTER } from './digest.mjs';
import { STATE_ATTRIBUTE } from './publication.mjs';

const require = createRequire(import.meta.url);
const postcss = require('postcss');

export const PARSER = Object.freeze({
  name: 'postcss',
  version: require('postcss/package.json').version,
});

export const sha256 = (data) =>
  crypto.createHash('sha256').update(data).digest('hex');

// Reads one balanced parenthesized group starting at `open` (a "(").
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === '"' || c === "'") {
      const end = skipString(text, i);
      i = end;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function skipString(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return text.length - 1;
}

const NESTED_SELECTOR_PSEUDO = new Set([
  'is',
  'not',
  'has',
  'where',
  'matches',
  'host',
  'host-context',
  'slotted',
]);

// Collects the standard state context of a selector list. Class, id and type
// selectors are counted, never named.
export function selectorState(selector, into = null) {
  const out = into ?? {
    pseudoClasses: new Set(),
    pseudoElements: new Set(),
    attributes: new Set(),
    redactedAttributes: 0,
    compoundSelectors: 0,
  };
  const text = selector;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === '.' || c === '#') {
      out.compoundSelectors++;
      i++;
      while (i < text.length && /[\w\-\\\u0080-\uffff]/.test(text[i])) {
        if (text[i] === '\\') i++;
        i++;
      }
      i--;
    } else if (c === '[') {
      let end = i + 1;
      while (end < text.length && text[end] !== ']') {
        if (text[end] === '\\') end++;
        else if (text[end] === '"' || text[end] === "'")
          end = skipString(text, end);
        end++;
      }
      const name = text
        .slice(i + 1, end)
        .split(/[~|^$*]?=/)[0]
        .trim()
        .toLowerCase();
      if (STATE_ATTRIBUTE.test(name)) out.attributes.add(name);
      else out.redactedAttributes++;
      i = end;
    } else if (c === ':') {
      const element = text[i + 1] === ':';
      let j = i + (element ? 2 : 1);
      const start = j;
      while (j < text.length && /[\w-]/.test(text[j])) j++;
      const name = text.slice(start, j).toLowerCase();
      // Legacy single-colon pseudo-elements are pseudo-elements.
      if (
        element ||
        ['before', 'after', 'first-line', 'first-letter'].includes(name)
      ) {
        out.pseudoElements.add(`::${name}`);
      } else {
        out.pseudoClasses.add(`:${name}`);
      }
      if (text[j] === '(') {
        const close = balanced(text, j);
        const inner = text.slice(j + 1, close);
        if (NESTED_SELECTOR_PSEUDO.has(name)) selectorState(inner, out);
        i = close;
      } else {
        i = j - 1;
      }
    }
  }
  return out;
}

// Compact state: empty members are omitted.
const finishState = (state) => {
  const out = {};
  for (const key of ['pseudoClasses', 'pseudoElements', 'attributes']) {
    if (state[key].size > 0) out[key] = [...state[key]].sort();
  }
  if (state.redactedAttributes > 0)
    out.redactedAttributes = state.redactedAttributes;
  return out;
};

// Value redaction. Every redaction keeps a stable placeholder and the SHA-256
// of the removed text, so a holder of the private input can verify it.
// A long run of base64/hex-like characters is opaque unless it is a plain
// kebab-case CSS identifier such as a long custom-property name.
const KEBAB_IDENTIFIER = /^-*[a-z]+(-[a-z0-9]+)*$/;
const REDACTIONS = [
  ['url', /url\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)/gi],
  ['string', /"(?:\\.|[^"\\])+"|'(?:\\.|[^'\\])+'/g],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/g],
  ['uri', /\b[a-z][a-z0-9+.-]*:\/\/[^\s,)]+/gi],
  ['opaque', /(?<![#\w:-])[A-Za-z0-9+/_=-]{24,}(?![\w-])/g, KEBAB_IDENTIFIER],
];

export function redactValue(value, digester = PUBLIC_DIGESTER) {
  const redactions = [];
  let out = value;
  for (const [kind, pattern, keep] of REDACTIONS) {
    out = out.replace(pattern, (match) => {
      if (match.startsWith('<redacted:') || keep?.test(match)) return match;
      const digest = digester.of(match);
      redactions.push({ kind, digest: `${digester.scheme}:${digest}` });
      const placeholder = `<redacted:${kind}:${digester.scheme}:${digest}>`;
      if (kind === 'url') return `url(${placeholder})`;
      if (kind === 'string') return `"${placeholder}"`;
      return placeholder;
    });
  }
  // Anything that is still not plain CSS value text is reported, not kept.
  if (/[^\x20-\x7e]/.test(out)) {
    const digest = digester.of(out);
    redactions.push({
      kind: 'non-ascii-text',
      digest: `${digester.scheme}:${digest}`,
    });
    out = `<redacted:non-ascii-text:${digester.scheme}:${digest}>`;
  }
  return { value: out, redactions };
}

// Context parameters that may carry consumer names are reduced to a digest.
function atRuleContext(node, digester) {
  const name = node.name.toLowerCase();
  let params = node.params.replace(/\s+/g, ' ').trim();
  if (/keyframes$/.test(name)) params = '<keyframes-name>';
  else if (
    !['media', 'supports', 'layer', 'font-face'].includes(name) &&
    params
  )
    params = `<redacted:params:${digester.scheme}:${digester.of(node.params)}>`;
  return params ? `@${name} ${params}` : `@${name}`;
}

/**
 * Extracts every declaration of `css`.
 *
 * options.baselineLayer: when set, only declarations inside `@layer <name>`
 *   belong to the Alpha 1 baseline denominator.
 * Source positions are returned separately (`position`) and are never part
 * of a published record.
 */
export function extractDeclarations(css, options = {}) {
  const { baselineLayer = null, digester = PUBLIC_DIGESTER } = options;
  const root = postcss.parse(css);
  const records = [];
  let ordinal = 0;
  root.walkDecls((decl) => {
    const atRules = [];
    let layer = null;
    let keyframes = false;
    let descriptor = null;
    const state = {
      pseudoClasses: new Set(),
      pseudoElements: new Set(),
      attributes: new Set(),
      redactedAttributes: 0,
      compoundSelectors: 0,
    };
    let selectorCount = 0;
    for (let p = decl.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule') {
        const name = p.name.toLowerCase();
        if (name === 'layer' && layer == null) layer = p.params.trim();
        if (/keyframes$/.test(name)) keyframes = name;
        if (name === 'font-face') descriptor = 'font-face';
        atRules.unshift(atRuleContext(p, digester));
      } else if (p.type === 'rule' && !keyframes) {
        selectorCount++;
        selectorState(p.selector, state);
      }
    }
    const line = decl.source?.start?.line ?? 0;
    const column = decl.source?.start?.column ?? 0;
    const custom = decl.prop.startsWith('--');
    let denominator = 'alpha1-baseline';
    let reason = null;
    if (custom) {
      denominator = 'outside-alpha1-baseline';
      reason = 'custom-property';
    } else if (keyframes === 'keyframes') {
      // The recovered measurement removed `@keyframes` blocks only.
      denominator = 'outside-alpha1-baseline';
      reason = 'keyframes-frame';
    } else if (baselineLayer != null && layer !== baselineLayer) {
      denominator = 'outside-alpha1-baseline';
      reason = 'layer-outside-measured-input';
    }
    const context = {};
    if (layer != null) context.layer = layer;
    const conditions = atRules.filter((a) => !a.startsWith('@layer'));
    if (conditions.length > 0) context.atRules = conditions;
    if (keyframes !== false) context.keyframes = true;
    if (descriptor != null) context.descriptor = descriptor;
    const selector = finishState(state);
    if (Object.keys(selector).length > 0) context.state = selector;
    if (selectorCount > 1) context.nestedRules = selectorCount;
    records.push({
      ordinal: ordinal++,
      position: { line, column },
      property: custom ? decl.prop : decl.prop.toLowerCase(),
      value: decl.value.trim(),
      important: decl.important === true,
      context,
      denominator,
      excludedReason: reason,
    });
  });
  return records;
}
