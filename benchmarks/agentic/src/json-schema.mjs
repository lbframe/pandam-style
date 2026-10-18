/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal JSON Schema (draft 2020-12 subset) validator for the agentic corpus.
//
// The corpus schemas only use the keywords implemented here. An unknown
// keyword is a schema authoring error, not a silently ignored constraint, so
// `validateSchemaKeywords` rejects it before any document is validated.

const SUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  '$comment',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'oneOf',
  'anyOf',
  'allOf',
  'if',
  'then',
  'not',
  'minProperties',
  'examples',
  'default',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function typeMatches(expected, value) {
  const actual = typeOf(value);
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref ${ref}: only local refs are allowed`);
  }
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (node == null) throw new Error(`Unresolved $ref ${ref}`);
  return node;
}

export function validateSchemaKeywords(schema, at = '#') {
  const errors = [];
  if (typeof schema === 'boolean') return errors;
  if (schema == null || typeof schema !== 'object') {
    return [`${at}: schema must be an object or boolean`];
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) errors.push(`${at}: unsupported keyword ${key}`);
  }
  const children = [];
  for (const key of ['properties', '$defs']) {
    for (const [name, child] of Object.entries(schema[key] ?? {})) {
      children.push([child, `${at}/${key}/${name}`]);
    }
  }
  for (const key of [
    'items',
    'additionalProperties',
    'propertyNames',
    'not',
    'if',
    'then',
  ]) {
    if (schema[key] != null && typeof schema[key] === 'object') {
      children.push([schema[key], `${at}/${key}`]);
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    (schema[key] ?? []).forEach((child, i) =>
      children.push([child, `${at}/${key}/${i}`]),
    );
  }
  for (const [child, path] of children) {
    errors.push(...validateSchemaKeywords(child, path));
  }
  return errors;
}

function validateNode(root, schema, value, at, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${at}: no value is allowed here`);
    return;
  }
  if (schema.$ref != null) {
    validateNode(root, resolveRef(root, schema.$ref), value, at, errors);
  }
  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum != null && !schema.enum.some((v) => deepEqual(v, value))) {
    errors.push(
      `${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`,
    );
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${at}: string shorter than ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${at}: string longer than ${schema.maxLength}`);
    }
    if (
      schema.pattern != null &&
      !new RegExp(schema.pattern, 'u').test(value)
    ) {
      errors.push(
        `${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`,
      );
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${at}: fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${at}: more than ${schema.maxItems} items`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length)
        errors.push(`${at}: items are not unique`);
    }
    if (schema.items != null) {
      value.forEach((item, i) =>
        validateNode(root, schema.items, item, `${at}/${i}`, errors),
      );
    }
  }
  if (typeOf(value) === 'object') {
    const keys = Object.keys(value);
    if (schema.minProperties != null && keys.length < schema.minProperties) {
      errors.push(`${at}: fewer than ${schema.minProperties} properties`);
    }
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        errors.push(`${at}: missing required property ${name}`);
      }
    }
    for (const key of keys) {
      if (schema.propertyNames != null) {
        validateNode(root, schema.propertyNames, key, `${at}/${key}`, errors);
      }
      if (schema.properties != null && Object.hasOwn(schema.properties, key)) {
        validateNode(
          root,
          schema.properties[key],
          value[key],
          `${at}/${key}`,
          errors,
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property ${key}`);
      } else if (
        schema.additionalProperties != null &&
        typeof schema.additionalProperties === 'object'
      ) {
        validateNode(
          root,
          schema.additionalProperties,
          value[key],
          `${at}/${key}`,
          errors,
        );
      }
    }
  }
  for (const sub of schema.allOf ?? []) {
    validateNode(root, sub, value, at, errors);
  }
  if (schema.anyOf != null) {
    const ok = schema.anyOf.some((sub) => {
      const local = [];
      validateNode(root, sub, value, at, local);
      return local.length === 0;
    });
    if (!ok) errors.push(`${at}: value matches none of anyOf`);
  }
  if (schema.oneOf != null) {
    const branchErrors = schema.oneOf.map((sub) => {
      const local = [];
      validateNode(root, sub, value, at, local);
      return local;
    });
    const matched = branchErrors.filter((e) => e.length === 0).length;
    if (matched !== 1) {
      const detail =
        matched === 0
          ? branchErrors
              .map((e, i) => `[${i}] ${e.slice(0, 3).join('; ')}`)
              .join(' | ')
          : `${matched} branches matched`;
      errors.push(`${at}: value must match exactly one of oneOf (${detail})`);
    }
  }
  if (schema.not != null) {
    const local = [];
    validateNode(root, schema.not, value, at, local);
    if (local.length === 0)
      errors.push(`${at}: value matches a forbidden schema`);
  }
  if (schema.if != null) {
    const local = [];
    validateNode(root, schema.if, value, at, local);
    if (local.length === 0 && schema.then != null) {
      validateNode(root, schema.then, value, at, errors);
    }
  }
}

export function validate(schema, value) {
  const errors = [];
  validateNode(schema, schema, value, '#', errors);
  return errors;
}
