/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 schema subset (decision D2).
 *
 * A closed-keyword subset of JSON Schema. Every legal schema has exactly one
 * runtime check, one TypeScript rendering (`codegen.js`) and one serialized
 * size bound (`maxJsonBytes`), so validation, types and descriptions cannot
 * drift apart. `pattern` is not a keyword: identifier formats are fixed
 * character-class checks named in `FORMATS`.
 *
 * Unit: `maxLength` and `minLength` count the UTF-8 bytes of the string's JSON
 * serialization, quotes excluded. A bound is then a bound on response bytes.
 */

export const SCHEMA_KEYWORDS = Object.freeze([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
  'description',
  'oneOf',
  'format',
]);

export const SCHEMA_TYPES = Object.freeze([
  'object',
  'array',
  'string',
  'integer',
  'boolean',
  'null',
]);

/**
 * Closed formats. `record` marks an opaque list record in an OUTPUT schema: a
 * compiler-produced value that is never cut or reshaped and is withheld whole
 * when it exceeds the record ceiling (§3.10). It is the only open object.
 */
export const FORMATS = Object.freeze({
  'request-id': { type: 'string', maxLength: 128, safe: true },
  'project-relative-path': { type: 'string', maxLength: 4096, safe: false },
  sha256: { type: 'string', maxLength: 64, safe: true },
  'hex-digest': { type: 'string', maxLength: 64, safe: true },
  uuid: { type: 'string', maxLength: 36, safe: true },
  record: { type: 'object', maxLength: null, safe: false },
  // A slice of a record's canonical (ASCII) serialization, sized by the
  // packer against the response budget like a record. Output-only.
  chunk: { type: 'string', maxLength: null, safe: true },
});

/** Formats whose size the packer accounts for, never the frame. */
const PACKED_FORMATS = new Set(['record', 'chunk']);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function stringBytes(value) {
  return jsonBytes(value) - 2;
}

function typesOf(schema) {
  if (schema.type == null) return null;
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function isRequestIdChar(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 45 ||
    code === 46 ||
    code === 58 ||
    code === 95
  );
}

function allChars(value, test) {
  for (let i = 0; i < value.length; i += 1) {
    if (!test(value.charCodeAt(i), i)) return false;
  }
  return true;
}

const isAsciiPrintable = (code) => code >= 32 && code <= 126;

const isLowerHex = (code) =>
  (code >= 48 && code <= 57) || (code >= 97 && code <= 102);

const FORMAT_CHECKS = {
  'request-id': (value) =>
    value.length >= 1 &&
    value.length <= 128 &&
    allChars(value, isRequestIdChar),
  'project-relative-path': (value) =>
    value !== '' &&
    stringBytes(value) <= 4096 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..'),
  sha256: (value) => value.length === 64 && allChars(value, isLowerHex),
  'hex-digest': (value) =>
    value.length >= 1 && value.length <= 64 && allChars(value, isLowerHex),
  chunk: (value) => allChars(value, isAsciiPrintable),
  uuid: (value) =>
    value.length === 36 &&
    allChars(value, (code, i) =>
      i === 8 || i === 13 || i === 18 || i === 23
        ? code === 45
        : isLowerHex(code),
    ),
};

function fail(path, message) {
  throw new TypeError(
    `pandamstyle agent schema at ${path.join('.') || '<root>'}: ${message}`,
  );
}

/**
 * Checks that `schema` uses the subset only. `position` is `input` or
 * `output`; output strings must carry a bound, and `record` is output-only and
 * allowed only as the items of an array.
 */
export function compileSchema(schema, position, path = [], parent = null) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema))
    fail(path, 'a schema must be an object');
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.includes(key)) fail(path, `keyword ${key} is closed`);
  }
  if (schema.description != null && typeof schema.description !== 'string')
    fail(path, 'description must be a string');
  if (schema.oneOf != null) {
    compileOneOf(schema, position, path);
    return;
  }
  if ('const' in schema) {
    const value = schema.const;
    if (
      !['string', 'number', 'boolean'].includes(typeof value) &&
      value !== null
    )
      fail(path, 'const must be a scalar');
    for (const key of Object.keys(schema)) {
      if (!['const', 'description'].includes(key))
        fail(path, `const does not combine with ${key}`);
    }
    return;
  }
  const types = typesOf(schema);
  if (types == null || types.length === 0) fail(path, 'type is required');
  for (const type of types) {
    if (!SCHEMA_TYPES.includes(type)) fail(path, `type ${type} is closed`);
  }
  if (new Set(types).size !== types.length) fail(path, 'duplicate type');
  const has = (type) => types.includes(type);
  const allowed = new Set(['type', 'description']);
  if (schema.format != null) {
    const format =
      typeof schema.format === 'string' && Object.hasOwn(FORMATS, schema.format)
        ? FORMATS[schema.format]
        : null;
    if (format == null) fail(path, `format ${schema.format} is closed`);
    if (!has(format.type))
      fail(path, `format ${schema.format} needs ${format.type}`);
    allowed.add('format');
    if (PACKED_FORMATS.has(schema.format) && position !== 'output')
      fail(path, `${schema.format} is output-only`);
    if (schema.format === 'record') {
      if (position !== 'output') fail(path, 'record is output-only');
      if (parent !== 'items')
        fail(path, 'record is allowed only as array items');
      for (const key of Object.keys(schema)) {
        if (!['type', 'format', 'description'].includes(key))
          fail(path, `record does not combine with ${key}`);
      }
      return;
    }
  }
  if (has('object')) {
    for (const key of ['properties', 'required', 'additionalProperties'])
      allowed.add(key);
    if (schema.additionalProperties !== false)
      fail(path, 'additionalProperties must be false');
    const properties = schema.properties ?? {};
    if (typeof properties !== 'object' || Array.isArray(properties))
      fail(path, 'properties must be an object');
    const required = schema.required ?? [];
    if (!Array.isArray(required)) fail(path, 'required must be an array');
    for (const name of required) {
      if (!Object.hasOwn(properties, name))
        fail(path, `required ${name} is not a declared property`);
    }
    for (const [name, child] of Object.entries(properties))
      compileSchema(child, position, [...path, name], 'property');
  }
  if (has('array')) {
    allowed.add('items');
    allowed.add('maxItems');
    if (schema.items == null) fail(path, 'items is required');
    if (!Number.isSafeInteger(schema.maxItems) || schema.maxItems < 0)
      fail(path, 'maxItems is required');
    compileSchema(schema.items, position, [...path, '[]'], 'items');
  }
  if (has('string')) {
    for (const key of ['minLength', 'maxLength', 'enum']) allowed.add(key);
    if (schema.enum != null) {
      if (
        !Array.isArray(schema.enum) ||
        schema.enum.length === 0 ||
        !schema.enum.every((value) => typeof value === 'string')
      )
        fail(path, 'enum must be a non-empty string list');
    } else if (
      schema.format == null &&
      !Number.isSafeInteger(schema.maxLength)
    ) {
      // Unbounded strings are refused in both positions: an input string is
      // bounded by the schema, and an output string names its source bound.
      fail(path, 'a string needs maxLength, enum or a bounded format');
    }
  }
  if (has('integer')) {
    allowed.add('minimum');
    allowed.add('maximum');
    for (const key of ['minimum', 'maximum']) {
      if (schema[key] != null && !Number.isSafeInteger(schema[key]))
        fail(path, `${key} must be a safe integer`);
    }
  }
  for (const key of Object.keys(schema)) {
    if (!allowed.has(key)) fail(path, `keyword ${key} does not apply here`);
  }
}

function compileOneOf(schema, position, path) {
  for (const key of Object.keys(schema)) {
    if (!['oneOf', 'description'].includes(key))
      fail(path, `oneOf does not combine with ${key}`);
  }
  if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2)
    fail(path, 'oneOf needs at least two branches');
  const discriminator = oneOfDiscriminator(schema);
  if (discriminator == null)
    fail(path, 'oneOf branches need a shared required const property');
  for (const [index, branch] of schema.oneOf.entries())
    compileSchema(branch, position, [...path, `oneOf${index}`], 'oneOf');
}

/** The property every branch requires as a distinct `const`. */
export function oneOfDiscriminator(schema) {
  const [first] = schema.oneOf;
  if (first?.type !== 'object') return null;
  for (const name of first.required ?? []) {
    const values = schema.oneOf.map((branch) =>
      branch?.type === 'object' &&
      (branch.required ?? []).includes(name) &&
      branch.properties?.[name] != null &&
      'const' in branch.properties[name]
        ? branch.properties[name].const
        : undefined,
    );
    if (
      values.every((value) => value !== undefined) &&
      new Set(values).size === values.length
    )
      return name;
  }
  return null;
}

function typeOfValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isSafeInteger(value)) return 'integer';
  return typeof value;
}

/**
 * Validates a snapshot against a compiled schema. Returns `null` or the first
 * failure as `{ path, keyword }`. The path holds declared property names,
 * `oneOf` branch names and array indexes only, never a request key or value.
 */
export function validateSchema(schema, value, path = []) {
  if (schema.oneOf != null) {
    const discriminator = oneOfDiscriminator(schema);
    if (typeOfValue(value) !== 'object') return { path, keyword: 'type' };
    const branch = schema.oneOf.find(
      (candidate) =>
        Object.hasOwn(value, discriminator) &&
        candidate.properties[discriminator].const === value[discriminator],
    );
    if (branch == null)
      return { path: [...path, discriminator], keyword: 'oneOf' };
    return validateSchema(branch, value, path);
  }
  if ('const' in schema)
    return value === schema.const ? null : { path, keyword: 'const' };
  const actual = typeOfValue(value);
  const types = typesOf(schema);
  if (!types.includes(actual)) return { path, keyword: 'type' };
  switch (actual) {
    case 'object': {
      if (schema.format === 'record') return null;
      const properties = schema.properties ?? {};
      for (const name of schema.required ?? []) {
        if (!Object.hasOwn(value, name))
          return { path: [...path, name], keyword: 'required' };
      }
      for (const key of Object.keys(value)) {
        // The unknown key itself is agent text: only its container is named.
        if (!Object.hasOwn(properties, key))
          return { path, keyword: 'additionalProperties' };
      }
      for (const [name, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, name)) continue;
        const failure = validateSchema(child, value[name], [...path, name]);
        if (failure != null) return failure;
      }
      return null;
    }
    case 'array': {
      if (value.length > schema.maxItems) return { path, keyword: 'maxItems' };
      for (let i = 0; i < value.length; i += 1) {
        const failure = validateSchema(schema.items, value[i], [...path, i]);
        if (failure != null) return failure;
      }
      return null;
    }
    case 'string': {
      if (schema.enum != null && !schema.enum.includes(value))
        return { path, keyword: 'enum' };
      if (schema.format != null && !FORMAT_CHECKS[schema.format](value))
        return { path, keyword: 'format' };
      const bytes = stringBytes(value);
      if (schema.maxLength != null && bytes > schema.maxLength)
        return { path, keyword: 'maxLength' };
      if (schema.minLength != null && bytes < schema.minLength)
        return { path, keyword: 'minLength' };
      return null;
    }
    case 'integer': {
      if (schema.minimum != null && value < schema.minimum)
        return { path, keyword: 'minimum' };
      if (schema.maximum != null && value > schema.maximum)
        return { path, keyword: 'maximum' };
      return null;
    }
    default:
      return null;
  }
}

const SCALAR_BYTES = { boolean: 5, null: 4 };

/**
 * An upper bound on the JSON bytes of any value the schema admits. Arrays of
 * `record` items count as empty: records are accounted for by the response
 * packer against the record ceiling, never by the frame.
 */
export function maxJsonBytes(schema) {
  if (schema.oneOf != null)
    return Math.max(...schema.oneOf.map((branch) => maxJsonBytes(branch)));
  if ('const' in schema) return jsonBytes(schema.const);
  let max = 0;
  for (const type of typesOf(schema)) {
    max = Math.max(max, maxBytesOfType(schema, type));
  }
  return max;
}

function maxBytesOfType(schema, type) {
  switch (type) {
    case 'object': {
      if (schema.format === 'record') return Infinity;
      const entries = Object.entries(schema.properties ?? {});
      let bytes = 2 + Math.max(0, entries.length - 1);
      for (const [name, child] of entries) {
        bytes += jsonBytes(name) + 1 + maxJsonBytes(child);
      }
      return bytes;
    }
    case 'array':
      if (schema.items.format === 'record') return 2;
      return (
        2 +
        schema.maxItems * maxJsonBytes(schema.items) +
        Math.max(0, schema.maxItems - 1)
      );
    case 'string':
      if (schema.enum != null)
        return Math.max(...schema.enum.map((value) => jsonBytes(value)));
      if (schema.maxLength != null) return schema.maxLength + 2;
      if (PACKED_FORMATS.has(schema.format)) return 2;
      return FORMATS[schema.format].maxLength + 2;
    case 'integer': {
      const low = schema.minimum ?? -MAX_SAFE;
      const high = schema.maximum ?? MAX_SAFE;
      return Math.max(String(low).length, String(high).length);
    }
    default:
      return SCALAR_BYTES[type];
  }
}
