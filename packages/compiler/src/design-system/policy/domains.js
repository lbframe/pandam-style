/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - effective property domains (CE-02.1).
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
 */

import {
  CATALOG_VERSION,
  ENFORCED_FIELDS,
  catalogDigest,
  descriptorKeys,
  descriptorOf,
  digestOfRows,
} from './descriptors';
import { Codes, diagnostic } from '../../protocol/diagnostics';
import { patternEmissions } from '../patterns/compile';

export const PROPERTY_CATALOG_KIND = 'pandamstyle-property-catalog';
export const PROPERTY_CATALOG_SCHEMA_VERSION = 1;

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
    range: override.range == null ? null : Object.freeze({ ...override.range }),
  });
}

// A range's upper bound; an absent `max` is unbounded.
const upper = (range) => range.max ?? Infinity;
const inRange = (range, value) =>
  range != null &&
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= range.min &&
  value <= upper(range);

/**
 * The CSS zero, defined once. Where a domain lists the CSS zero `'0'` (a
 * length or keyword list), the numeric `0` of style objects is the same value:
 * the domain stores `'0'`, acceptance admits both spellings, and the generated
 * types admit both. On a legacy numeric row (`opacity`, `flex*`), `0` is a
 * number like any other and `'0'` is not admitted, as in Alpha 1.
 */
export const CSS_ZERO = '0';

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
    a.values.every(
      (v) =>
        hasValue(b.values, v) || (typeof v === 'number' && inRange(b.range, v)),
    ) &&
    a.tokens.every((t) => b.tokens.includes(t)) &&
    (a.range == null ||
      (b.range != null &&
        a.range.min >= b.range.min &&
        upper(a.range) <= upper(b.range)))
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

const MEMBERS = new Set(['values', 'tokens', 'range']);
// AG-03.1: an entry may also hold `meta`. It is validated and stored by the
// metadata side table (`registry.semantics.propertyDomains`), never in the
// normalized entry, the effective table or `snapshot.properties` (design note
// §3.1.1, agreed with the CE owner, CE note amended by #138).
const META_MEMBER = 'meta';

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

/**
 * Validates and normalizes `definition.propertyDomains`. Each key names a
 * standard, admitted property; each entry holds only `values`, `tokens` and
 * `range`, each a member of the descriptor's `standard` domain. Returns
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
        `propertyDomains.${property} must be an object with values, tokens or range.`,
        at,
      );
      continue;
    }
    const members = Object.keys(entry).filter((m) => m !== META_MEMBER);
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
        `propertyDomains.${property} must restate at least one of values, tokens, range.`,
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
        const primitive =
          member === 'tokens'
            ? typeof value === 'string'
            : typeof value === 'string' ||
              (typeof value === 'number' && Number.isFinite(value));
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
        seen.push(
          member === 'tokens'
            ? value
            : canonicalLiteral(value, standard.values),
        );
        const inStandard =
          member === 'tokens'
            ? standard.tokens.includes(value)
            : hasValue(standard.values, value) ||
              (typeof value === 'number' && inRange(standard.range, value));
        if (!inStandard) {
          fail(
            'outside-standard',
            `${JSON.stringify(value)} is not an approvable ${member === 'tokens' ? 'token category' : 'value'} of ${property}.`,
            {
              ...at,
              member,
              value,
              admitted:
                member === 'tokens'
                  ? [...standard.tokens]
                  : admittedValues(standard),
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
    if (Object.hasOwn(entry, 'range')) {
      // `{ min, max }`, or `{ min }` for no upper bound: finite numbers only,
      // the JSON-safe encoding of the manifest.
      const range = entry.range;
      const keys = isPlainRecord(range) ? Object.keys(range).sort().join() : '';
      const finite = (bound) =>
        typeof bound === 'number' && Number.isFinite(bound);
      const valid =
        (keys === 'max,min' || keys === 'min') &&
        finite(range.min) &&
        (keys === 'min' || (finite(range.max) && range.min <= range.max));
      if (!valid) {
        fail(
          'malformed-member',
          `propertyDomains.${property}.range must be { min, max } or { min } with finite bounds and min <= max.`,
          { ...at, member: 'range' },
        );
        ok = false;
      } else if (
        standard.range == null ||
        range.min < standard.range.min ||
        upper(range) > upper(standard.range)
      ) {
        fail(
          'outside-standard',
          `The range [${range.min}, ${range.max ?? 'unbounded'}] is not within an approvable range of ${property}.`,
          {
            ...at,
            member: 'range',
            value:
              keys === 'min'
                ? { min: range.min }
                : { min: range.min, max: range.max },
            admitted:
              standard.range == null
                ? []
                : admittedValues({ values: [], range: standard.range }),
          },
        );
        ok = false;
      } else {
        normalized.range =
          keys === 'min'
            ? { min: range.min }
            : { min: range.min, max: range.max };
      }
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
  if (value === 0 && domain.values.includes(CSS_ZERO)) return true;
  const range = domain.range;
  return (
    range != null &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    (range.max == null || value <= range.max)
  );
}

/**
 * The admitted values of a domain as reported in diagnostics: its finite
 * values, and a range as the text Alpha 1 reported (a continuous interval,
 * not an enumeration).
 */
export function admittedValues(domain) {
  return domain.range == null
    ? [...domain.values]
    : [
        ...domain.values,
        // Alpha 1's text; an unbounded range reads `Infinity` here, as before.
        `number in [${domain.range.min}, ${domain.range.max ?? Infinity}]`,
      ];
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
        if (row.domain.range != null) {
          // `max` is absent for an unbounded range, as in the domain.
          entry.range = { ...row.domain.range, legacy: true };
        }
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
