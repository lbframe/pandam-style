/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Closed published surface for the CE-00.2 records derived from or describing
// the private consumer. Every string in those records must sit at a schema
// location whose type is closed:
//
//   - `const` or `enum`: a value from a fixed list;
//   - `pattern` anchored with ^...$ and bounded by `maxLength`: an id, digest,
//     commit, timestamp or path of fixed shape;
//   - `x-closed`: a named closed type checked in code (CSS strings through the
//     token allow-list, registry names, allow-listed pseudo-classes, ...).
//
// Object keys are strings too: a key must be a declared property or pass a
// closed `propertyNames` schema. walkClosedSurface() checks every leaf and key
// of a document; schemaOpenLocations() checks the schema itself, so a field
// that happens to be absent from the data cannot hide an open type.

import { COMPOSITE_LONGHANDS } from '../../tools/coverage/classify.mjs';
import { KEYED_PLACEHOLDER } from '../../tools/coverage/digest.mjs';
import {
  AUTHORED_IDENTIFIERS,
  CSS_KEYWORDS,
  DESCRIPTOR_NAMES,
  MAX_TEXT_LENGTH,
  PSEUDO_CLASSES,
  PSEUDO_ELEMENTS,
  STATE_ATTRIBUTES,
  tokenProblems,
} from '../../tools/coverage/publication.mjs';

const LONGHANDS = new Set(Object.values(COMPOSITE_LONGHANDS).flat());
const PUBLIC_PLACEHOLDER =
  /^<redacted:(url|string|email|uri|opaque|non-ascii-text|identifier|at-rule|at-rule-params|params|property|token):sha256:[0-9a-f]{64}>$/;
const IDENT = /^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/;
const QUERY = /^@(media|supports) (.+)$/;

/**
 * Closed-type checkers. `ctx` holds the approved consumer identifiers and the
 * registry names. Each returns null when the value is allowed.
 */
export function closedProblem(kind, value, ctx) {
  const authored = kind.startsWith('authored-');
  const base = authored ? kind.slice('authored-'.length) : kind;
  const approved = authored ? ctx.approvedAuthored : ctx.approved;
  const placeholder = (v) =>
    KEYED_PLACEHOLDER.test(v) || (authored && PUBLIC_PLACEHOLDER.test(v));
  if (value == null) return null;
  if (typeof value !== 'string') return `${kind}: not a string`;
  if (value.length > MAX_TEXT_LENGTH) return `${kind}: too long`;
  switch (base) {
    case 'css-value': {
      const problems = tokenProblems(value, approved, { keyed: !authored });
      return problems.length ? `${kind}: ${problems[0]}` : null;
    }
    case 'css-property':
      if (ctx.registryNames.has(value) || DESCRIPTOR_NAMES.has(value))
        return null;
      if (value.startsWith('--'))
        return approved.has(value) || placeholder(value.slice(2))
          ? null
          : `${kind}: custom property ${value} is not approved`;
      return placeholder(value) && value.startsWith('<redacted:property:')
        ? null
        : `${kind}: ${value} is not a registry property`;
    case 'css-layer':
      return (IDENT.test(value) &&
        (CSS_KEYWORDS.has(value.toLowerCase()) || approved.has(value))) ||
        placeholder(value)
        ? null
        : `${kind}: layer ${value} is not approved`;
    case 'css-at-rule': {
      if (value === '@font-face' || value === '@keyframes <keyframes-name>')
        return null;
      if (placeholder(value) && value.startsWith('<redacted:at-rule:'))
        return null;
      const query = QUERY.exec(value);
      if (query == null) return `${kind}: ${value} is not a closed at-rule`;
      if (placeholder(query[2])) return null;
      const problems = tokenProblems(query[2], approved, { keyed: !authored });
      return problems.length ? `${kind}: ${problems[0]}` : null;
    }
    case 'pseudo-class':
      return PSEUDO_CLASSES.has(value) ? null : `${kind}: ${value}`;
    case 'pseudo-element':
      return PSEUDO_ELEMENTS.has(value) ? null : `${kind}: ${value}`;
    case 'state-attribute':
      return STATE_ATTRIBUTES.has(value) ? null : `${kind}: ${value}`;
    case 'composite-longhand':
      return LONGHANDS.has(value) ? null : `${kind}: ${value}`;
    case 'registry-name':
      return ctx.registryNames.has(value) ? null : `${kind}: ${value}`;
    default:
      return `unknown closed type ${kind}`;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** JSON Schema subset plus `propertyNames`, `maxLength` and `x-closed`. */
export function validateSchema(schema, value, where, out, ctx) {
  if (out.length > 40) return;
  if (
    schema.const !== undefined &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  ) {
    out.push(`${where}: expected ${JSON.stringify(schema.const)}`);
    return;
  }
  if (
    schema.enum &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  ) {
    out.push(`${where}: ${JSON.stringify(value)} not in enum`);
    return;
  }
  if (schema.type) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    if (
      !types.includes(actual) &&
      !(actual === 'integer' && types.includes('number'))
    ) {
      out.push(`${where}: expected ${types.join('|')}, got ${actual}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength)
      out.push(`${where}: too short`);
    if (schema.maxLength != null && value.length > schema.maxLength)
      out.push(`${where}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      out.push(
        `${where}: ${value.slice(0, 80)} does not match ${schema.pattern}`,
      );
  }
  if (schema['x-closed'] && value !== null) {
    const problem = closedProblem(schema['x-closed'], value, ctx);
    if (problem) out.push(`${where}: ${problem}`);
  }
  if (
    typeof value === 'number' &&
    schema.minimum != null &&
    value < schema.minimum
  )
    out.push(`${where}: below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems)
      out.push(`${where}: fewer than ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems)
      out.push(`${where}: more than ${schema.maxItems} items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      out.push(`${where}: duplicate items`);
    if (schema.items)
      value.forEach((item, i) =>
        validateSchema(schema.items, item, `${where}[${i}]`, out, ctx),
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) out.push(`${where}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validateSchema(
          schema.properties[key],
          item,
          `${where}.${key}`,
          out,
          ctx,
        );
        continue;
      }
      if (schema.propertyNames)
        validateSchema(
          schema.propertyNames,
          key,
          `${where}[key ${key}]`,
          out,
          ctx,
        );
      if (schema.additionalProperties === false) {
        out.push(`${where}: unexpected property ${key}`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        validateSchema(
          schema.additionalProperties,
          item,
          `${where}.${key}`,
          out,
          ctx,
        );
      }
    }
  }
}

// The closed type of a string-capable schema node, or null when it is open.
export function closedType(schema) {
  if (schema == null) return null;
  if (schema.const !== undefined) return 'enum';
  if (schema.enum) return 'enum';
  if (schema['x-closed'] && schema.maxLength != null)
    return `x-closed:${schema['x-closed']}`;
  if (
    schema.pattern &&
    schema.pattern.startsWith('^') &&
    schema.pattern.endsWith('$') &&
    schema.maxLength != null
  )
    return 'pattern';
  return null;
}

const generalize = (where) => where.replace(/\[\d+\]/g, '[]');

/**
 * Walks every string leaf and every object key of `value`. Returns the leaf
 * count, the closed type of each generalized path, and the open locations.
 */
export function walkClosedSurface(schema, value, where = '$') {
  const result = { leaves: 0, keys: 0, types: new Map(), open: [] };
  const visit = (s, v, at) => {
    if (typeof v === 'string') {
      result.leaves += 1;
      const type = closedType(s);
      if (type == null) result.open.push(`${at}: open string`);
      else result.types.set(generalize(at), type);
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => visit(s?.items, item, `${at}[${i}]`));
    } else if (v && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        const declared = s?.properties?.[key];
        if (declared) {
          visit(declared, item, `${at}.${key}`);
          continue;
        }
        result.keys += 1;
        const keyType = closedType(s?.propertyNames);
        if (keyType == null) result.open.push(`${at}: open key ${key}`);
        else result.types.set(`${generalize(at)}{key}`, keyType);
        visit(s?.additionalProperties, item, `${at}.${key}`);
      }
    }
  };
  visit(schema, value, where);
  return result;
}

/** Every schema node that admits a string must be closed. */
export function schemaOpenLocations(schema, where = '$') {
  const open = [];
  const visit = (s, at) => {
    if (s == null || typeof s !== 'object') return;
    const types = [s.type].flat().filter(Boolean);
    const admitsString =
      types.includes('string') ||
      (types.length === 0 &&
        s.const === undefined &&
        !s.enum &&
        !s.properties &&
        !s.items);
    if (admitsString && closedType(s) == null && at !== '$') open.push(at);
    if (s.type === 'object' || s.properties) {
      for (const [k, v] of Object.entries(s.properties ?? {}))
        visit(v, `${at}.${k}`);
      if (s.additionalProperties && typeof s.additionalProperties === 'object')
        visit(s.additionalProperties, `${at}{value}`);
      if (
        s.additionalProperties !== false &&
        closedType(s.propertyNames) == null
      )
        open.push(`${at}{key}`);
      if (s.propertyNames) visit(s.propertyNames, `${at}{key}`);
    }
    if (s.items) visit(s.items, `${at}[]`);
  };
  visit(schema, where);
  return open;
}

export { AUTHORED_IDENTIFIERS };
