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
 * In this version no design system declares an override, so every row is the
 * compiler-owned default and the effective table is one shared, frozen object.
 * The `propertyDomains` schema that supplies overrides arrives with the next
 * CE-02.1 change.
 */

import {
  CATALOG_VERSION,
  ENFORCED_FIELDS,
  catalogDigest,
  descriptorKeys,
  descriptorOf,
  digestOfRows,
} from './descriptors';

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

function effectiveRow(descriptor, override = null) {
  const out = {};
  for (const field of ENFORCED_FIELDS) {
    if (field === 'domain') out.domain = effectiveDomain(descriptor, override);
    else if (field === 'origin') out.origin = 'default';
    else out[field] = descriptor[field];
  }
  return Object.freeze(out);
}

let defaultProperties = null;

function buildDefaultProperties() {
  const descriptors = Object.create(null);
  const rows = [];
  for (const key of descriptorKeys()) {
    const row = effectiveRow(descriptorOf(key));
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

/**
 * The effective property table of a design-system registry: the snapshot's
 * `properties` member. Built once and shared while no override exists.
 */
export function effectivePropertiesOf(_registry) {
  if (defaultProperties == null) defaultProperties = buildDefaultProperties();
  return defaultProperties;
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
  // CSS treats the numeric zero accepted by style-object APIs as the same
  // value as the explicit CSS string `"0"`.
  if (value === 0 && domain.values.includes('0')) return true;
  const range = domain.range;
  return (
    range != null &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= range.min &&
    value <= range.max
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
        `number in [${domain.range.min}, ${domain.range.max}]`,
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
