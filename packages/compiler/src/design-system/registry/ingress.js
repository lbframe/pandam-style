/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - definition ingress (AG-03.1, design note §3.8.0).
 *
 * `snapshotDefinition` is the only copy of a definition that enters the
 * compiler through the public API. It accepts a closed set of shapes:
 * primitives, plain objects, arrays and `token()` marks. It reads own
 * property descriptors only, never performs `[[Get]]` on the source, and
 * builds fresh objects with this realm's prototypes. Once copied, nothing the
 * author wrote can run when a later stage reads, hashes or serializes the
 * definition (I6). Anything else is `PMS_INVALID_DEFINITION`, rule
 * `definition.shape`, with a closed `reason` and a `field` in which every
 * author-named segment is `{ index }`.
 */

import { Codes, diagnostic, PmsError } from '../../protocol/diagnostics';

const TOKEN_REF = Symbol.for('pandamstyle.tokenRef');
const INDEX_KEY = /^(?:0|[1-9][0-9]*)$/;

// Keys shown by name in `field`, by context. Every other key is author-named.
const NAMED = {
  root: [
    'systemId',
    'tokens',
    'themes',
    'conditions',
    'recipes',
    'enhancements',
    'propertyDomains',
    'meta',
  ],
  leaf: ['value', 'ref', 'visibility', 'meta'],
  theme: ['extends', 'tokens', 'meta'],
  condition: ['selector', 'atRule', 'meta'],
  recipe: [
    'base',
    'variants',
    'defaultVariants',
    'compoundVariants',
    'slots',
    'visibility',
    'jsx',
    'meta',
  ],
  domain: ['values', 'tokens', 'range', 'meta'],
  range: ['min', 'max'],
};

// The context of a child node. Contexts: root, categories (a token tree or a
// theme's overrides), node (a token group or leaf), themes, theme,
// conditions, condition, recipes, recipe, domains, domain, range, opaque.
const FROM_ROOT = {
  tokens: 'categories',
  themes: 'themes',
  conditions: 'conditions',
  recipes: 'recipes',
  propertyDomains: 'domains',
};
const COLLECTIONS = {
  categories: 'node',
  themes: 'theme',
  conditions: 'condition',
  recipes: 'recipe',
  domains: 'domain',
};

function childContext(context, key, isLeaf) {
  if (context === 'root') return FROM_ROOT[key] ?? 'opaque';
  if (Object.hasOwn(COLLECTIONS, context)) return COLLECTIONS[context];
  if (context === 'node') return isLeaf ? 'opaque' : 'node';
  if (context === 'theme' && key === 'tokens') return 'categories';
  if (context === 'domain' && key === 'range') return 'range';
  return 'opaque';
}

function namesOf(context, isLeaf) {
  if (context === 'node') return isLeaf ? NAMED.leaf : [];
  return Object.hasOwn(NAMED, context) ? NAMED[context] : [];
}

function isIntrinsicPrototype(proto, name) {
  if (proto === null) return false;
  if (
    name === 'Object' ? proto === Object.prototype : proto === Array.prototype
  )
    return true;
  const parent = Object.getPrototypeOf(proto);
  if (
    name === 'Object'
      ? parent !== null
      : !isIntrinsicPrototype(parent, 'Object')
  )
    return false;
  const constructor = Object.getOwnPropertyDescriptor(proto, 'constructor');
  if (constructor === undefined || !('value' in constructor)) return false;
  const fn = constructor.value;
  if (typeof fn !== 'function') return false;
  const prototype = Object.getOwnPropertyDescriptor(fn, 'prototype');
  if (prototype === undefined || prototype.value !== proto) return false;
  return (
    Function.prototype.toString.call(fn) ===
    `function ${name}() { [native code] }`
  );
}

class ShapeError extends Error {
  constructor(reason, field) {
    super(reason);
    this.reason = reason;
    this.field = field;
  }
}

function shapeDiagnostic(reason, field) {
  return diagnostic({
    code: Codes.INVALID_DEFINITION,
    phase: 'design-system',
    rule: 'definition.shape',
    message: `The design-system definition must be plain data (${reason}).`,
    source: 'design-system',
    context: { field, reason },
  });
}

/**
 * The plain-data copy of a definition, or a thrown `PmsError`. `undefined`
 * and `null` pass through.
 */
export function snapshotDefinition(definition) {
  const seen = new Map();
  const walk = (value, field, context) => {
    const type = typeof value;
    if (
      value === null ||
      type === 'string' ||
      type === 'number' ||
      type === 'boolean' ||
      type === 'undefined'
    )
      return value;
    if (type === 'function') throw new ShapeError('function', field);
    if (type === 'symbol') throw new ShapeError('symbol-value', field);
    if (type === 'bigint') throw new ShapeError('bigint', field);
    if (seen.has(value)) return seen.get(value);
    let proto;
    let keys;
    try {
      proto = Object.getPrototypeOf(value);
      keys = Reflect.ownKeys(value);
    } catch {
      throw new ShapeError('unreadable', field);
    }
    const describe = (key) => {
      try {
        return Object.getOwnPropertyDescriptor(value, key);
      } catch {
        throw new ShapeError('unreadable', field);
      }
    };
    if (Array.isArray(value)) {
      if (!isIntrinsicPrototype(proto, 'Array'))
        throw new ShapeError('prototype', field);
      const length = describe('length').value;
      const out = new Array(length);
      seen.set(value, out);
      for (const key of keys) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string' ||
          !INDEX_KEY.test(key) ||
          Number(key) >= length
        )
          throw new ShapeError('array-shape', field);
        const descriptor = describe(key);
        const at = [...field, Number(key)];
        if (!('value' in descriptor)) throw new ShapeError('accessor', at);
        // Holes stay holes: they hold no behaviour.
        Object.defineProperty(out, key, {
          value: walk(descriptor.value, at, 'opaque'),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    if (proto !== null && !isIntrinsicPrototype(proto, 'Object'))
      throw new ShapeError('prototype', field);
    if (keys.length === 1 && keys[0] === TOKEN_REF) {
      const descriptor = describe(TOKEN_REF);
      if (!('value' in descriptor) || typeof descriptor.value !== 'string')
        throw new ShapeError('token-mark', field);
      return Object.freeze({ [TOKEN_REF]: descriptor.value });
    }
    const descriptors = keys.map((key) => [key, describe(key)]);
    const isLeaf =
      context === 'node' &&
      descriptors.some(
        ([key, d]) =>
          (key === 'value' &&
            'value' in d &&
            (typeof d.value === 'string' || typeof d.value === 'number')) ||
          (key === 'ref' && 'value' in d && typeof d.value === 'string'),
      );
    const named = namesOf(context, isLeaf);
    const out = {};
    seen.set(value, out);
    descriptors.forEach(([key, descriptor], index) => {
      if (typeof key === 'symbol') throw new ShapeError('symbol-key', field);
      const at = [...field, named.includes(key) ? key : { index }];
      if (!('value' in descriptor)) throw new ShapeError('accessor', at);
      if (!descriptor.enumerable) throw new ShapeError('non-enumerable', at);
      const next = childContext(context, key, isLeaf);
      Object.defineProperty(out, key, {
        value: walk(descriptor.value, at, next),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    return out;
  };
  try {
    return walk(definition, [], 'root');
  } catch (error) {
    if (error instanceof ShapeError)
      throw new PmsError([shapeDiagnostic(error.reason, error.field)]);
    throw error;
  }
}

/**
 * The own `definition` property of an input container (`config`,
 * `transaction`), copied by `snapshotDefinition`, without invoking an
 * accessor on the container's own `definition` property either.
 */
export function ownDefinitionOf(container) {
  if (container === null || typeof container !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(container, 'definition');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor))
    throw new PmsError([shapeDiagnostic('accessor', [])]);
  return snapshotDefinition(descriptor.value);
}
