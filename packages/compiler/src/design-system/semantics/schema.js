/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - closed metadata schemas (AG-03.1, design note §3.3, §3.7).
 *
 * Copy-or-reject: every `meta` object is closed, nothing has a default, text
 * is never trimmed or normalized (I3). Child containers that hold no child
 * are invalid, so the view split stays injective (§3.3, I12). Every string a
 * stored `meta` can hold has a class (`stringClassOf`, §3.7.1): the
 * private-name match runs on `free` and `literal` strings, and an unclassified
 * string fails closed.
 */

import { META_CAPS, PATTERN_ID_SET } from './snapshot';

const COMMON = ['description', 'usage', 'restrictions', 'terms'];
const DESCRIBED = [...COMMON, 'semanticRole', 'relations'];

/** The closed field set of each entity kind. */
export const FIELDS = Object.freeze({
  system: Object.freeze([...COMMON, 'patterns']),
  token: Object.freeze([...DESCRIBED, 'examples', 'deprecated']),
  theme: Object.freeze([...DESCRIBED, 'deprecated']),
  condition: Object.freeze([...DESCRIBED, 'examples', 'deprecated']),
  recipe: Object.freeze([
    ...DESCRIBED,
    'examples',
    'deprecated',
    'slots',
    'variants',
  ]),
  slot: Object.freeze([...DESCRIBED, 'deprecated']),
  axis: Object.freeze([...DESCRIBED, 'deprecated']),
  value: Object.freeze([...DESCRIBED, 'deprecated']),
  pattern: Object.freeze([...DESCRIBED, 'examples', 'deprecated']),
  property: Object.freeze([...DESCRIBED, 'examples']),
});

/** Keys of a parent `meta` that hold child entities, by kind. */
export const CHILD_KEYS = Object.freeze({
  system: Object.freeze(['patterns']),
  recipe: Object.freeze(['slots', 'variants']),
});

export const RELATIONS = Object.freeze([
  'related',
  'pairs-with',
  'alternative',
  'implemented-by',
]);

/** Allowed address key sets, in canonical key order (§3.4). */
export const ADDRESS_SHAPES = Object.freeze([
  Object.freeze(['token']),
  Object.freeze(['theme']),
  Object.freeze(['condition']),
  Object.freeze(['recipe']),
  Object.freeze(['recipe', 'slot']),
  Object.freeze(['recipe', 'variant']),
  Object.freeze(['recipe', 'variant', 'value']),
  Object.freeze(['pattern']),
  Object.freeze(['property']),
  Object.freeze(['component']),
]);

const IDENTIFIER = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
// Built at run time from escaped strings: the bundle must stay one-byte
// source, and a regex literal with `\p{}` or non-ASCII ranges would be
// expanded by the build into literal characters.
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');
const INVISIBLE = new RegExp(
  '[\\u00ad\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]',
);
const EXPORT_NAME = new RegExp('^[\\p{ID_Start}$_][\\p{ID_Continue}$]*$', 'u');

export const isPlain = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

/** The `metadata.text` reason of a string, or null when it conforms (§3.7). */
export function textReason(value, max) {
  if (typeof value !== 'string') return { reason: 'not-string' };
  if (value === '') return { reason: 'empty' };
  const bytes = bytesOf(value);
  if (bytes > max) return { reason: 'too-long', bytes, limit: max };
  if (!value.isWellFormed()) return { reason: 'ill-formed' };
  if (CONTROL.test(value)) return { reason: 'control-character' };
  if (INVISIBLE.test(value)) return { reason: 'invisible-character' };
  if (value.trim() !== value) return { reason: 'surrounding-space' };
  if (value.normalize('NFC') !== value) return { reason: 'not-nfc' };
  return null;
}

/** The kind of the entity an address names. */
export function kindOfAddress(address) {
  if (Object.hasOwn(address, 'system')) return 'system';
  if (Object.hasOwn(address, 'token')) return 'token';
  if (Object.hasOwn(address, 'theme')) return 'theme';
  if (Object.hasOwn(address, 'condition')) return 'condition';
  if (Object.hasOwn(address, 'pattern')) return 'pattern';
  if (Object.hasOwn(address, 'property')) return 'property';
  if (Object.hasOwn(address, 'component')) return 'component';
  if (Object.hasOwn(address, 'value')) return 'value';
  if (Object.hasOwn(address, 'variant')) return 'axis';
  if (Object.hasOwn(address, 'slot')) return 'slot';
  return 'recipe';
}

/**
 * Validates one entity's `meta` (already snapshotted). `report(rule, field,
 * extra)` receives every issue. Returns `{ own, children }`: `own` is the
 * entity's own fields; `children` are `{ kind, key, value, field }` entries
 * still to be validated as entities by the caller. `declared` gives, for a
 * recipe, `{ slots, axes: { [axis]: values } }`.
 */
export function validateEntityMeta(kind, meta, report, declared = null) {
  if (!isPlain(meta)) {
    report('metadata.field-type', [], { reason: 'not-object' });
    return null;
  }
  const allowed = FIELDS[kind];
  const childKeys = CHILD_KEYS[kind] ?? [];
  const own = {};
  const children = [];
  Object.keys(meta).forEach((key, index) => {
    if (!allowed.includes(key)) {
      report('metadata.unknown-field', [{ index }], {});
      return;
    }
    const value = meta[key];
    if (childKeys.includes(key)) {
      collectChildren(kind, key, value, report, declared, children);
      return;
    }
    own[key] = value;
    validateField(kind, key, value, [key], report);
  });
  return { own, children };
}

function collectChildren(kind, key, value, report, declared, children) {
  const field = [key];
  if (!isPlain(value)) {
    report('metadata.field-type', field, { reason: 'not-object' });
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    report('metadata.field-type', field, { reason: 'empty-map' });
    return;
  }
  keys.forEach((name, index) => {
    const at = [key, { index }];
    if (kind === 'system') {
      if (!PATTERN_ID_SET.has(name)) {
        report('metadata.unknown-child', at, {});
        return;
      }
      children.push({ kind: 'pattern', key: [name], value: value[name] });
      return;
    }
    if (key === 'slots') {
      if (!(declared?.slots ?? []).includes(name)) {
        report('metadata.unknown-child', at, {});
        return;
      }
      children.push({ kind: 'slot', key: [name], value: value[name] });
      return;
    }
    // variants.<axis>: { meta?, values? }
    const values = declared?.axes?.[name];
    if (values === undefined || !Object.hasOwn(declared.axes, name)) {
      report('metadata.unknown-child', at, {});
      return;
    }
    const entry = value[name];
    if (!isPlain(entry)) {
      report('metadata.field-type', at, { reason: 'not-object' });
      return;
    }
    const entryKeys = Object.keys(entry);
    if (entryKeys.length === 0) {
      report('metadata.field-type', at, { reason: 'empty-axis-entry' });
      return;
    }
    entryKeys.forEach((entryKey, entryIndex) => {
      if (entryKey !== 'meta' && entryKey !== 'values') {
        report('metadata.unknown-field', [...at, { index: entryIndex }], {});
      }
    });
    if (Object.hasOwn(entry, 'meta')) {
      children.push({ kind: 'axis', key: [name], value: entry.meta });
    }
    if (Object.hasOwn(entry, 'values')) {
      const map = entry.values;
      const mapField = [...at, 'values'];
      if (!isPlain(map)) {
        report('metadata.field-type', mapField, { reason: 'not-object' });
        return;
      }
      const valueKeys = Object.keys(map);
      if (valueKeys.length === 0) {
        report('metadata.field-type', mapField, { reason: 'empty-map' });
        return;
      }
      valueKeys.forEach((valueName, valueIndex) => {
        if (!values.includes(valueName)) {
          report(
            'metadata.unknown-child',
            [...mapField, { index: valueIndex }],
            {},
          );
          return;
        }
        children.push({
          kind: 'value',
          key: [name, valueName],
          value: map[valueName],
        });
      });
    }
  });
}

function validateField(kind, key, value, field, report) {
  const caps = META_CAPS;
  const text = (item, max, at) => {
    const problem = textReason(item, max);
    if (problem != null) report('metadata.text', at, problem);
  };
  const list = (max) => {
    if (!Array.isArray(value)) {
      report('metadata.field-type', field, { reason: 'not-array' });
      return false;
    }
    if (value.length === 0) {
      report('metadata.field-type', field, { reason: 'empty-array' });
      return false;
    }
    if (value.length > max) {
      report('metadata.field-type', field, {
        reason: 'too-many',
        bytes: null,
        limit: max,
      });
      return false;
    }
    return true;
  };
  switch (key) {
    case 'description':
      text(value, caps.description, field);
      return;
    case 'usage':
    case 'restrictions':
      if (list(caps.listItems))
        value.forEach((item, i) => text(item, caps.listText, [...field, i]));
      return;
    case 'semanticRole':
      identifier(value, caps.semanticRole, field, report);
      return;
    case 'terms':
      if (!list(caps.terms)) return;
      value.forEach((item, i) =>
        identifier(item, caps.termBytes, [...field, i], report),
      );
      if (new Set(value).size !== value.length)
        report('metadata.field-type', field, { reason: 'duplicate' });
      return;
    case 'relations': {
      if (!list(caps.relations)) return;
      const seen = new Set();
      value.forEach((relation, i) => {
        const at = [...field, i];
        if (!isPlain(relation)) {
          report('metadata.field-type', at, { reason: 'not-object' });
          return;
        }
        const keys = Object.keys(relation).sort().join();
        if (keys !== 'relation,target') {
          report('metadata.field-type', at, { reason: 'relation-shape' });
          return;
        }
        if (!RELATIONS.includes(relation.relation)) {
          report('metadata.field-type', [...at, 'relation'], {
            reason: 'enum',
          });
        }
        referenceShape(relation.target, [...at, 'target'], report);
        const identity = JSON.stringify([relation.relation, relation.target]);
        if (seen.has(identity))
          report('metadata.field-type', at, { reason: 'duplicate' });
        seen.add(identity);
      });
      return;
    }
    case 'deprecated': {
      if (!isPlain(value)) {
        report('metadata.field-type', field, { reason: 'not-object' });
        return;
      }
      Object.keys(value).forEach((member, index) => {
        if (member === 'reason')
          text(value.reason, caps.reason, [...field, 'reason']);
        else if (member === 'replacement')
          referenceShape(value.replacement, [...field, 'replacement'], report);
        else report('metadata.unknown-field', [...field, { index }], {});
      });
      return;
    }
    case 'examples':
      if (!list(caps.examples)) return;
      value.forEach((example, i) =>
        exampleShape(kind, example, [...field, i], report),
      );
      return;
    default:
      throw new Error(`metadata field without a validator: ${key}`);
  }
}

function identifier(value, max, field, report) {
  if (typeof value !== 'string') {
    report('metadata.field-type', field, { reason: 'not-string' });
  } else if (bytesOf(value) > max) {
    report('metadata.field-type', field, {
      reason: 'too-long',
      bytes: bytesOf(value),
      limit: max,
    });
  } else if (!IDENTIFIER.test(value)) {
    report('metadata.field-type', field, { reason: 'identifier' });
  }
}

const nonEmptyString = (value) => typeof value === 'string' && value !== '';

/** Structural check of a reference (§3.4); resolution is in references.js. */
export function referenceShape(target, field, report) {
  if (!isPlain(target)) {
    report('metadata.field-type', field, { reason: 'reference-shape' });
    return false;
  }
  const keys = Object.keys(target).sort();
  const shape = ADDRESS_SHAPES.find(
    (candidate) => [...candidate].sort().join() === keys.join(),
  );
  if (shape == null) {
    report('metadata.field-type', field, { reason: 'reference-shape' });
    return false;
  }
  if (shape[0] === 'component') {
    const component = target.component;
    if (
      !isPlain(component) ||
      Object.keys(component).sort().join() !== 'export,module'
    ) {
      report('metadata.field-type', [...field, 'component'], {
        reason: 'reference-shape',
      });
      return false;
    }
    let ok = true;
    const module = component.module;
    const problem = textReason(module, META_CAPS.componentModule);
    if (problem != null) {
      report('metadata.text', [...field, 'component', 'module'], problem);
      ok = false;
    } else if (
      module.startsWith('/') ||
      module.includes('\\') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(module) ||
      module.split('/').some((s) => s === '' || s === '.' || s === '..')
    ) {
      report('metadata.reference-kind', [...field, 'component', 'module'], {
        reason: 'component-module',
      });
      ok = false;
    }
    const name = component.export;
    if (
      typeof name !== 'string' ||
      name === '' ||
      bytesOf(name) > META_CAPS.componentExport ||
      !EXPORT_NAME.test(name)
    ) {
      report('metadata.reference-kind', [...field, 'component', 'export'], {
        reason: 'component-export',
      });
      ok = false;
    }
    return ok;
  }
  for (const key of shape) {
    if (!nonEmptyString(target[key])) {
      report('metadata.field-type', [...field, key], {
        reason: 'reference-shape',
      });
      return false;
    }
  }
  return true;
}

/** An example value: a JSON scalar or `{ token }` (§3.6). */
function valueShape(value) {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    isPlain(value) &&
    Object.keys(value).join() === 'token' &&
    nonEmptyString(value.token)
  );
}

const EXAMPLE_KEYS = Object.freeze({
  token: { required: ['property'], optional: ['condition'] },
  condition: { required: ['property', 'value'], optional: [] },
  property: { required: ['value'], optional: [] },
  pattern: { required: ['parameters'], optional: [] },
  recipe: { required: [], optional: ['select', 'slot'] },
});

function exampleShape(kind, example, field, report) {
  const bad = () =>
    report('metadata.field-type', field, { reason: 'example-shape' });
  if (!isPlain(example)) return bad();
  const spec = EXAMPLE_KEYS[kind];
  const keys = Object.keys(example);
  if (
    keys.some(
      (k) => !spec.required.includes(k) && !spec.optional.includes(k),
    ) ||
    spec.required.some((k) => !keys.includes(k))
  )
    return bad();
  if (
    (Object.hasOwn(example, 'property') && !nonEmptyString(example.property)) ||
    (Object.hasOwn(example, 'condition') &&
      !nonEmptyString(example.condition)) ||
    (Object.hasOwn(example, 'slot') && !nonEmptyString(example.slot)) ||
    (Object.hasOwn(example, 'value') && !valueShape(example.value))
  )
    return bad();
  if (Object.hasOwn(example, 'select')) {
    const select = example.select;
    if (
      !isPlain(select) ||
      Object.values(select).some(
        (v) =>
          !(
            typeof v === 'string' ||
            typeof v === 'boolean' ||
            (typeof v === 'number' && Number.isFinite(v))
          ),
      )
    )
      return bad();
  }
  if (Object.hasOwn(example, 'parameters')) {
    const parameters = example.parameters;
    if (!isPlain(parameters)) return bad();
    for (const parameter of Object.values(parameters)) {
      if (valueShape(parameter)) continue;
      // A responsive map: condition name -> value.
      if (
        !isPlain(parameter) ||
        Object.keys(parameter).length === 0 ||
        !Object.values(parameter).every(valueShape)
      )
        return bad();
    }
  }
  return undefined;
}

/**
 * The class of a string at `path` inside an entity's own `meta` (§3.7.1):
 * `free`, `vocabulary` or `literal`; `null` for an unclassified position.
 * Paths are field names and array indexes. Strings found as object keys are
 * never classified here: own-field keys are closed, and every other key
 * (`select` axes, `parameters` names, responsive conditions) is vocabulary.
 */
export function stringClassOf(path) {
  const [head, ...rest] = path;
  const isIndex = (segment) => typeof segment === 'number';
  const address = (tail) => {
    if (tail.length === 1) return 'vocabulary';
    if (
      tail.length === 2 &&
      tail[0] === 'component' &&
      (tail[1] === 'module' || tail[1] === 'export')
    )
      return 'free';
    return null;
  };
  switch (head) {
    case 'description':
    case 'semanticRole':
      return rest.length === 0 ? 'free' : null;
    case 'usage':
    case 'restrictions':
    case 'terms':
      return rest.length === 1 && isIndex(rest[0]) ? 'free' : null;
    case 'deprecated':
      if (rest.length === 1 && rest[0] === 'reason') return 'free';
      if (rest[0] === 'replacement') return address(rest.slice(1));
      return null;
    case 'relations':
      if (!isIndex(rest[0])) return null;
      if (rest.length === 2 && rest[1] === 'relation') return 'vocabulary';
      if (rest[1] === 'target') return address(rest.slice(2));
      return null;
    case 'examples': {
      if (!isIndex(rest[0])) return null;
      const tail = rest.slice(1);
      if (
        tail.length === 1 &&
        ['property', 'condition', 'slot'].includes(tail[0])
      )
        return 'vocabulary';
      if (tail[0] === 'select' && tail.length === 2) return 'vocabulary';
      if (tail[0] === 'value' || tail[0] === 'parameters') {
        const last = tail[tail.length - 1];
        return last === 'token' && tail.length > 1 ? 'vocabulary' : 'literal';
      }
      return null;
    }
    default:
      return null;
  }
}
