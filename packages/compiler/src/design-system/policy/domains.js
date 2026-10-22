/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - effective property domains (CE-02.1, CE-02.2).
 *
 * `effectiveDomain` is the only function that computes the domain a design
 * system admits for a property. Every consumer (value acceptance, generated
 * types, the manifest, diagnostics, repair and target candidates) reads the
 * effective rows built here, never a descriptor's `standard` or `default`.
 *
 * A design system narrows or approves a property's domain through
 * `propertyDomains` (`normalizePropertyDomains`, run in `buildRegistry`): an
 * override may hold only members of the descriptor's `standard` domain, and it
 * is the WHOLE effective domain. Without overrides, every row is the
 * compiler-owned default and the table is one shared, frozen object.
 *
 * CE-02.2: every domain is finite (`values`, `tokens`, `resources`). An
 * author literal is in `standard` when it is a standard value, a keyword
 * branch of the descriptor grammar, a canonical numeric literal satisfying a
 * numeric branch (policy/literals.js), or one of the CSS-wide keywords
 * `inherit`, `initial`, `unset` and `revert`. Anything else is refused with
 * the rule of its class; nothing is rewritten silently.
 */

import {
  CATALOG_VERSION,
  ENFORCED_FIELDS,
  catalogDigest,
  descriptorKeys,
  descriptorOf,
  digestOfRows,
  grammarOf,
} from './descriptors';
import { Codes, diagnostic } from '../../protocol/diagnostics';
import { patternEmissions } from '../patterns/compile';
import {
  CSS_ZERO,
  checkNumericLiteral,
  isCanonicalSpelling,
  readNumeric,
} from './literals';

export const PROPERTY_CATALOG_KIND = 'pandamstyle-property-catalog';
// 2 (CE-02.2): a domain has no `range` member any more.
export const PROPERTY_CATALOG_SCHEMA_VERSION = 2;

/** CSS-wide keywords an author may approve per property (CE-02.2). */
export const CSS_WIDE_KEYWORDS = Object.freeze([
  'inherit',
  'initial',
  'unset',
  'revert',
]);
// Its meaning depends on cascade layers (CE-07): never approvable here.
const CSS_WIDE_UNSUPPORTED = Object.freeze(['revert-layer']);

/**
 * The effective domain of a descriptor. With an override, exactly the
 * override: a member it does not restate is empty, whatever `default` holds.
 * Without one, the descriptor's `default`. Null for a row without a domain
 * (composite forms, platform extensions).
 */
export function effectiveDomain(descriptor, override = null) {
  if (descriptor == null || descriptor.default == null) return null;
  if (override == null) return descriptor.default;
  return Object.freeze({
    values: Object.freeze([...(override.values ?? [])]),
    tokens: Object.freeze([...(override.tokens ?? [])]),
    resources: Object.freeze([]),
  });
}

/**
 * The CSS zero, defined once. Where a domain lists the CSS zero `'0'` (a
 * length or keyword list), the numeric `0` of style objects is the same value:
 * the domain stores `'0'`, acceptance admits both spellings, and the generated
 * types admit both. On a legacy numeric row (`opacity`, `flex*`), `0` is a
 * number like any other and `'0'` is not admitted, as in Alpha 1.
 */
export { CSS_ZERO };

/** The stored spelling of an approved literal: `'0'` for the CSS zero. */
export function canonicalLiteral(value, standardValues) {
  return (value === 0 || value === CSS_ZERO) &&
    standardValues.includes(CSS_ZERO)
    ? CSS_ZERO
    : value;
}

/** The literals a domain's generated type admits: both zero spellings. */
export function literalTypeValues(domain) {
  return domain.values.includes(CSS_ZERO)
    ? [...domain.values, 0]
    : [...domain.values];
}

const sameValue = (a, b) =>
  a === b || (a === 0 && b === CSS_ZERO) || (a === CSS_ZERO && b === 0);
const hasValue = (values, value) => values.some((v) => sameValue(v, value));

/** Whether domain `a` admits nothing that domain `b` does not. */
function domainWithin(a, b) {
  return (
    a.values.every((v) => hasValue(b.values, v)) &&
    a.tokens.every((t) => b.tokens.includes(t))
  );
}

function effectiveRow(descriptor, override = null) {
  const domain = effectiveDomain(descriptor, override);
  const out = {};
  for (const field of ENFORCED_FIELDS) {
    if (field === 'domain') out.domain = domain;
    else if (field === 'origin') {
      // `narrowed` admits nothing the compiler default does not; `approved`
      // admits a standard member the default leaves out.
      out.origin =
        override == null
          ? 'default'
          : domainWithin(domain, descriptor.default)
            ? 'narrowed'
            : 'approved';
    } else out[field] = descriptor[field];
  }
  return Object.freeze(out);
}

let defaultProperties = null;

function buildProperties(overrides) {
  const descriptors = Object.create(null);
  const rows = [];
  for (const key of descriptorKeys()) {
    const descriptor = descriptorOf(key);
    const override =
      overrides != null && Object.hasOwn(overrides, key)
        ? overrides[key]
        : null;
    const row =
      override == null && defaultProperties != null
        ? defaultProperties.descriptors[key]
        : effectiveRow(descriptor, override);
    descriptors[key] = row;
    rows.push(row);
  }
  return Object.freeze({
    kind: PROPERTY_CATALOG_KIND,
    schemaVersion: PROPERTY_CATALOG_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    catalogDigest: catalogDigest(),
    digest: digestOfRows(rows, ENFORCED_FIELDS),
    descriptors: Object.freeze(descriptors),
  });
}

// Tables with overrides, by the canonical text of the normalized overrides:
// an unchanged `propertyDomains` keeps the same table object across design
// system rebuilds, so identity-keyed memos (target candidates) keep hitting.
const tablesByOverrides = new Map();
const TABLE_CACHE_LIMIT = 16;

/**
 * The effective property table of a design-system registry: the snapshot's
 * `properties` member. Built from the registry's normalized `propertyDomains`
 * and the compiler defaults, never from any other input.
 */
export function effectivePropertiesOf(registry) {
  if (defaultProperties == null) defaultProperties = buildProperties(null);
  const overrides = registry?.propertyDomains;
  if (overrides == null || Object.keys(overrides).length === 0) {
    return defaultProperties;
  }
  const key = JSON.stringify(overrides);
  let table = tablesByOverrides.get(key);
  if (table == null) {
    table = buildProperties(overrides);
    if (tablesByOverrides.size >= TABLE_CACHE_LIMIT) tablesByOverrides.clear();
    tablesByOverrides.set(key, table);
  }
  return table;
}

// ---------------------------------------------------------------------------
// `propertyDomains`: design-system author data.

const MEMBERS = new Set(['values', 'tokens']);
// CE-02.1's continuous `range` member; CE-02.2 removes it (enumerate values).
const REMOVED_MEMBERS = new Set(['range']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return (
    (proto === Object.prototype || proto === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function domainError(rule, message, context) {
  return {
    ...diagnostic({
      code: Codes.INVALID_PROPERTY_DOMAIN,
      severity: 'error',
      phase: 'registry',
      message,
      source: null,
      rule: `property-domains.${rule}`,
      context,
    }),
    // Author data: no page-role repair edits the design-system definition.
    repair: {
      kind: 'edit-design-system-definition',
      applicable: false,
      target: { property: context.property ?? null },
      expected: null,
      reason: 'property domains are design-system author data',
    },
  };
}

const NUMERIC_RULE_MESSAGES = {
  'non-finite': 'is not a finite number',
  'out-of-bounds': 'is outside the bounds of the grammar',
  'number-not-length': 'is a unitless number where the grammar takes a unit',
  'unit-not-applicable': 'has a unit the grammar does not take',
  'non-integer': 'is not an integer',
  precision: 'has more than 4 fraction digits',
};

/**
 * Whether an author literal is a value of a descriptor's `standard` domain
 * (CE-02.2). Returns `{ stored }` (its one canonical spelling) or
 * `{ rule, message, canonical?, constraint? }` naming the refusal.
 */
function approvableValue(descriptor, value) {
  const { standard } = descriptor;
  const property = descriptor.key;
  const shown = JSON.stringify(value);
  // A reviewed standard value, exactly; the CSS zero in both spellings only
  // where the standard domain lists the CSS zero (a numeric row's 0 is a
  // number, never '0').
  if (
    standard.values.includes(value) ||
    ((value === 0 || value === CSS_ZERO) && standard.values.includes(CSS_ZERO))
  ) {
    return { stored: canonicalLiteral(value, standard.values) };
  }
  if (typeof value === 'string') {
    if (CSS_WIDE_KEYWORDS.includes(value)) return { stored: value };
    const lower = value.trim().toLowerCase();
    if (CSS_WIDE_UNSUPPORTED.includes(lower)) {
      return {
        rule: 'css-wide-unsupported',
        message: `${shown} cannot be approved: its meaning depends on cascade layers.`,
      };
    }
    const grammar = grammarOf(property);
    if (grammar.keywords.includes(value)) return { stored: value };
    const keyword =
      CSS_WIDE_KEYWORDS.find((k) => k === lower) ??
      grammar.keywords.find((k) => k.toLowerCase() === lower) ??
      standard.values.find(
        (v) => typeof v === 'string' && v.toLowerCase() === lower,
      );
    if (keyword !== undefined) {
      return {
        rule: 'non-canonical',
        message: `${shown} is spelled ${JSON.stringify(keyword)} in ${property}.`,
        canonical: keyword,
      };
    }
  }
  const numeric = checkNumericLiteral(standard.numeric, value);
  if (numeric != null) {
    if (numeric.ok) {
      if (isCanonicalSpelling(value, numeric.canonical)) {
        return { stored: numeric.canonical };
      }
      return {
        rule: 'non-canonical',
        message: `${shown} is spelled ${JSON.stringify(numeric.canonical)}.`,
        canonical: numeric.canonical,
      };
    }
    return {
      rule:
        numeric.reason === 'number-not-length'
          ? 'unit-not-applicable'
          : numeric.reason,
      message: `${shown} ${NUMERIC_RULE_MESSAGES[numeric.reason]} of ${property} (${descriptor.grammar}).`,
      constraint: standard.numeric.map(describeConstraint),
    };
  }
  // Only an opaque branch could match: a compiler gap, not an authoring error.
  const grammar = grammarOf(property);
  if (grammar.opaque.length > 0) {
    return {
      rule: 'grammar-unsupported',
      message: `${shown} cannot be approved for ${property}: the compiler admits only its reviewed values and grammar keywords and numbers (${descriptor.grammar}).`,
    };
  }
  return {
    rule: 'grammar-mismatch',
    message: `${shown} is not a value of ${property} (${descriptor.grammar}).`,
  };
}

/** A JSON description of a numeric constraint, for diagnostics. */
export function describeConstraint(constraint) {
  return {
    type: constraint.type,
    min: constraint.min,
    max: constraint.max,
    ...(constraint.units.length > 0 ? { units: [...constraint.units] } : {}),
  };
}

/**
 * Validates and normalizes `definition.propertyDomains`. Each key names a
 * standard, admitted property; each entry holds only `values` and `tokens`,
 * each a member of the descriptor's `standard` domain (see the module
 * comment for what a value of `standard` is). Returns
 * `{ propertyDomains, diagnostics }`; `propertyDomains` holds the valid
 * entries, sorted by key, frozen.
 */
export function normalizePropertyDomains(input, tokens = {}) {
  const diagnostics = [];
  const out = {};
  const fail = (rule, message, context) =>
    diagnostics.push(domainError(rule, message, context));
  if (input == null)
    return { propertyDomains: Object.freeze(out), diagnostics };
  if (!isPlainRecord(input)) {
    fail(
      'malformed',
      '`propertyDomains` must be a plain object keyed by property.',
      {
        property: null,
      },
    );
    return { propertyDomains: Object.freeze(out), diagnostics };
  }
  const categories = new Set();
  for (const id of Object.keys(tokens)) categories.add(tokens[id].category);
  for (const property of Object.keys(input).sort()) {
    const descriptor = descriptorOf(property);
    const entry = input[property];
    const at = { property };
    if (descriptor == null) {
      fail(
        'unknown-property',
        `"${property}" is not a property the compiler describes.`,
        {
          ...at,
          admitted: descriptorKeys().filter(
            (k) => descriptorOf(k).default != null,
          ),
        },
      );
      continue;
    }
    if (descriptor.form === 'rejected-composite') {
      fail(
        'composite-form',
        `"${property}" is a refused composite form; declare its longhands.`,
        at,
      );
      continue;
    }
    if (descriptor.status !== 'standard') {
      fail(
        'platform-extension',
        `"${property}" is a platform extension; platform extensions are not admitted.`,
        {
          ...at,
          platform: descriptor.platform,
        },
      );
      continue;
    }
    if (!isPlainRecord(entry)) {
      fail(
        'malformed-entry',
        `propertyDomains.${property} must be an object with values or tokens.`,
        at,
      );
      continue;
    }
    const members = Object.keys(entry);
    const removed = members.filter((m) => REMOVED_MEMBERS.has(m));
    if (removed.length > 0) {
      fail(
        'range-removed',
        `propertyDomains.${property}.range was removed (CE-02.2): every domain is finite; list the approved numbers in values.`,
        {
          ...at,
          member: 'range',
          admitted: [...MEMBERS],
        },
      );
      continue;
    }
    const unknown = members.filter((m) => !MEMBERS.has(m));
    if (unknown.length > 0) {
      fail(
        'unknown-member',
        `propertyDomains.${property} has unknown member(s): ${unknown.join(', ')}.`,
        {
          ...at,
          member: unknown[0],
          admitted: [...MEMBERS],
        },
      );
      continue;
    }
    if (members.length === 0) {
      fail(
        'empty',
        `propertyDomains.${property} must restate at least one of values, tokens.`,
        at,
      );
      continue;
    }
    const standard = descriptor.standard;
    const normalized = {};
    let ok = true;
    for (const member of ['values', 'tokens']) {
      if (!Object.hasOwn(entry, member)) continue;
      const list = entry[member];
      if (!Array.isArray(list) || list.length === 0) {
        fail(
          'malformed-member',
          `propertyDomains.${property}.${member} must be a non-empty array.`,
          {
            ...at,
            member,
          },
        );
        ok = false;
        continue;
      }
      const seen = [];
      for (const value of list) {
        if (
          member === 'values' &&
          typeof value === 'number' &&
          !Number.isFinite(value)
        ) {
          fail(
            'non-finite',
            `propertyDomains.${property}.values holds ${String(value)}; a numeric value is finite.`,
            { ...at, member, value: String(value) },
          );
          ok = false;
          continue;
        }
        const primitive =
          member === 'tokens'
            ? typeof value === 'string'
            : typeof value === 'string' || typeof value === 'number';
        if (!primitive) {
          fail(
            'malformed-value',
            `propertyDomains.${property}.${member} holds a value that is not a ${member === 'tokens' ? 'category name' : 'string or finite number'}.`,
            {
              ...at,
              member,
              value: typeof value === 'number' ? String(value) : typeof value,
            },
          );
          ok = false;
          continue;
        }
        if (seen.some((v) => sameValue(v, value))) {
          fail(
            'duplicate',
            `propertyDomains.${property}.${member} lists ${JSON.stringify(value)} twice.`,
            {
              ...at,
              member,
              value,
            },
          );
          ok = false;
          continue;
        }
        if (member === 'values') {
          const verdict = approvableValue(descriptor, value);
          if (verdict.rule != null) {
            fail(verdict.rule, verdict.message, {
              ...at,
              member,
              value,
              ...(verdict.canonical === undefined
                ? {}
                : { canonical: verdict.canonical }),
              ...(verdict.constraint == null
                ? {}
                : { constraint: verdict.constraint }),
              admitted: [...standard.values],
            });
            ok = false;
            continue;
          }
          seen.push(verdict.stored);
          continue;
        }
        seen.push(value);
        if (!standard.tokens.includes(value)) {
          fail(
            'outside-standard',
            `${JSON.stringify(value)} is not an approvable token category of ${property}.`,
            {
              ...at,
              member,
              value,
              admitted: [...standard.tokens],
            },
          );
          ok = false;
          continue;
        }
        if (member === 'tokens' && !categories.has(value)) {
          fail(
            'empty-category',
            `propertyDomains.${property} approves the token category "${value}", which declares no token.`,
            {
              ...at,
              member,
              value,
            },
          );
          ok = false;
        }
      }
      normalized[member] = seen;
    }
    if (ok) out[property] = normalized;
  }
  return { propertyDomains: deepFreeze(out), diagnostics };
}

/**
 * Pattern conflicts of an effective table: every literal value and token
 * category a pattern can emit must stay admitted, so the manifest never
 * advertises a pattern selection the policy would refuse.
 */
export function patternConflicts(properties) {
  const diagnostics = [];
  if (properties === defaultProperties) return diagnostics;
  const emissions = patternEmissions();
  for (const patternId of Object.keys(emissions)) {
    for (const [property, emitted] of Object.entries(emissions[patternId])) {
      const row = propertyRow(properties, property);
      if (row == null || row.origin === 'default') continue;
      for (const value of emitted.values) {
        if (!literalAllowed(row.domain, value)) {
          diagnostics.push(
            domainError(
              'pattern-conflict',
              `The ${property} domain excludes ${JSON.stringify(value)}, which patterns.${patternId}() emits.`,
              {
                property,
                member: 'values',
                value,
                patternId,
                admitted: admittedValues(row.domain),
              },
            ),
          );
        }
      }
      for (const category of emitted.tokens) {
        if (!row.domain.tokens.includes(category)) {
          diagnostics.push(
            domainError(
              'pattern-conflict',
              `The ${property} domain excludes ${category} tokens, which patterns.${patternId}() emits.`,
              {
                property,
                member: 'tokens',
                value: category,
                patternId,
                admitted: [...row.domain.tokens],
              },
            ),
          );
        }
      }
    }
  }
  return diagnostics;
}

const PROTOTYPE_NAMES = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]);

/**
 * True for `__proto__`, `constructor`, `prototype` and every other
 * Object.prototype member name: never a property, refused before any
 * condition dispatch.
 */
export function isPrototypeName(key) {
  return typeof key === 'string' && PROTOTYPE_NAMES.has(key);
}

/** The effective row of an authoring key, or null. Own keys only. */
export function propertyRow(properties, key) {
  return typeof key === 'string' && Object.hasOwn(properties.descriptors, key)
    ? properties.descriptors[key]
    : null;
}

/** True when a row admits values: a standard property that is not a refused form. */
export function isAdmitted(row) {
  return row != null && row.domain != null;
}

/** Whether a literal (non-token) value belongs to a domain. */
export function literalAllowed(domain, value) {
  if (domain.values.includes(value)) return true;
  // The CSS zero (see CSS_ZERO): a domain listing '0' admits numeric 0.
  return value === 0 && domain.values.includes(CSS_ZERO);
}

/** The admitted values of a domain as reported in diagnostics. */
export function admittedValues(domain) {
  return [...domain.values];
}

/**
 * Why a literal is not in a row's effective domain (CE-02.2), computed on the
 * refusal path only: `{ reason, canonical? }`. `canonical` is the in-domain
 * spelling of a value written differently. Reasons: `null-value`,
 * `css-wide-keyword`, `non-finite`, `non-canonical`, `number-not-length`,
 * `precision`, `not-in-domain`.
 */
export function refusalReason(row, value) {
  if (value === null || value === undefined) return { reason: 'null-value' };
  const domain = row.domain;
  const descriptor = descriptorOf(row.key);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { reason: 'non-finite' };
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    const spelled = domain.values.find(
      (v) => typeof v === 'string' && v.toLowerCase() === lower,
    );
    if (spelled !== undefined) {
      return { reason: 'non-canonical', canonical: spelled };
    }
    if (
      CSS_WIDE_KEYWORDS.includes(lower) ||
      CSS_WIDE_UNSUPPORTED.includes(lower)
    ) {
      return { reason: 'css-wide-keyword' };
    }
  }
  const numeric = checkNumericLiteral(descriptor?.standard?.numeric, value);
  if (numeric != null) {
    if (numeric.ok) {
      if (
        !isCanonicalSpelling(value, numeric.canonical) &&
        literalAllowed(domain, numeric.canonical)
      ) {
        return { reason: 'non-canonical', canonical: numeric.canonical };
      }
      return { reason: 'not-in-domain' };
    }
    if (
      ['number-not-length', 'precision', 'non-finite'].includes(numeric.reason)
    ) {
      return { reason: numeric.reason };
    }
    return { reason: 'not-in-domain' };
  }
  // A number on a row whose grammar has no numeric branch: still a number
  // where a length is written with a unit, when the domain lists lengths.
  const reading = readNumeric(value);
  if (
    reading?.number === true &&
    reading.value !== 0 &&
    domain.values.some((v) => readNumeric(v)?.unit != null)
  ) {
    return { reason: 'number-not-length' };
  }
  return { reason: 'not-in-domain' };
}

const domainOfCssCache = new WeakMap();

/**
 * CSS (kebab-case) property -> admitted finite values, or null, for the
 * candidates of target diagnostics. One function per effective table, so the
 * target evaluation memo, keyed on its identity, keeps hitting while the table
 * is unchanged and is recomputed when it changes.
 */
export function domainOfCssFor(properties) {
  let domainOf = domainOfCssCache.get(properties);
  if (domainOf == null) {
    const byCss = new Map();
    for (const row of Object.values(properties.descriptors)) {
      if (isAdmitted(row) && row.domain.values.length > 0) {
        byCss.set(row.css, row.domain.values);
      }
    }
    domainOf = (cssProperty) => byCss.get(String(cssProperty)) ?? null;
    // Cross-revision candidate caches key on the table, not on the function.
    domainOf.digest = properties.digest;
    domainOfCssCache.set(properties, domainOf);
  }
  return domainOf;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const kebab = (key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const manifestCache = new WeakMap();

/**
 * The manifest projection of an effective table: admitted rows and refused
 * composite forms, keyed by authoring key. Empty members, a `css` equal to the
 * kebab-case key, a form other than `rejected-composite` and the `default`
 * origin are omitted: the generated design module embeds this object, and its
 * size is budgeted.
 */
export function propertyManifestOf(properties) {
  let manifest = manifestCache.get(properties);
  if (manifest == null) {
    const byProperty = {};
    for (const row of Object.values(properties.descriptors)) {
      if (row.status !== 'standard') continue;
      const entry = {};
      if (row.css !== kebab(row.key)) entry.css = row.css;
      if (row.domain != null) {
        if (row.domain.values.length > 0) entry.values = [...row.domain.values];
        if (row.domain.tokens.length > 0) entry.tokens = [...row.domain.tokens];
      }
      if (row.form === 'rejected-composite') entry.form = row.form;
      if (row.origin !== 'default') entry.origin = row.origin;
      byProperty[row.key] = entry;
    }
    manifest = deepFreeze({
      catalogVersion: properties.catalogVersion,
      digest: properties.digest,
      byProperty,
    });
    manifestCache.set(properties, manifest);
  }
  return manifest;
}

const domainsCache = new WeakMap();

/**
 * Admitted authoring keys and their effective domains, for agent candidate
 * and repair queries. The domain objects are the rows' own frozen domains.
 */
export function propertyDomainsOf(properties) {
  let domains = domainsCache.get(properties);
  if (domains == null) {
    const keys = [];
    const byProperty = {};
    for (const row of Object.values(properties.descriptors)) {
      if (!isAdmitted(row)) continue;
      keys.push(row.key);
      byProperty[row.key] = row.domain;
    }
    domains = deepFreeze({ keys, byProperty });
    domainsCache.set(properties, domains);
  }
  return domains;
}
