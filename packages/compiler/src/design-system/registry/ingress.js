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

// Definitions copied by `snapshotDefinition` that hold no own `meta` key
// anywhere: the semantics build skips them without walking them again
// (AG-03.1 perf). Identity-keyed, so only these exact copies qualify.
const METALESS_COPIES = new WeakSet();
// Every `snapshotDefinition` copy: plain data with this realm's prototypes,
// so reading it (e.g. to key a cache) runs no author code.
const INGRESS_COPIES = new WeakSet();

/** True for an object returned by `snapshotDefinition`. */
export function isIngressCopy(definition) {
  return (
    definition !== null &&
    typeof definition === 'object' &&
    INGRESS_COPIES.has(definition)
  );
}

/** True for a `snapshotDefinition` copy that holds no `meta` key at all. */
export function isMetalessCopy(definition) {
  return (
    definition !== null &&
    typeof definition === 'object' &&
    METALESS_COPIES.has(definition)
  );
}

// Every reflective read of one author object, guarded as one unit (fix round
// 1, B5): a trap that throws or answers inconsistently (a key without a
// descriptor) gives `null`, reported as `unreadable`. The caught value is
// never inspected, so a thrown Proxy runs no further author code.
function readObject(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, keys[i]);
      if (descriptor === undefined) return null;
      descriptors[i] = descriptor;
    }
    return { proto, array, keys, descriptors };
  } catch {
    return null;
  }
}

function intrinsicOrUnreadable(proto, name) {
  if (proto === (name === 'Object' ? Object.prototype : Array.prototype))
    return true;
  try {
    return isIntrinsicPrototype(proto, name);
  } catch {
    return null;
  }
}

/**
 * The plain-data copy of a definition, or a thrown `PmsError`. `undefined`
 * and `null` pass through.
 *
 * The path to the current node is kept in primitive stacks and turned into a
 * `field` only when a shape is refused, so an accepted definition allocates
 * nothing beyond its copy.
 */
export function snapshotDefinition(definition) {
  const seen = new Map();
  const pathKeys = [];
  const pathIndexes = [];
  const pathNamed = [];
  let hasMeta = false;
  const fieldOf = () =>
    pathKeys.map((key, i) => (pathNamed[i] ? key : { index: pathIndexes[i] }));
  const fail = (reason) => {
    throw new ShapeError(reason, fieldOf());
  };
  const failAt = (reason, key, index, named) => {
    pathKeys.push(key);
    pathIndexes.push(index);
    pathNamed.push(named);
    fail(reason);
  };
  const walk = (value, context) => {
    const type = typeof value;
    if (
      value === null ||
      type === 'string' ||
      type === 'number' ||
      type === 'boolean' ||
      type === 'undefined'
    )
      return value;
    if (type === 'function') fail('function');
    if (type === 'symbol') fail('symbol-value');
    if (type === 'bigint') fail('bigint');
    const prior = seen.get(value);
    if (prior !== undefined) return prior;
    const read = readObject(value);
    if (read === null) fail('unreadable');
    const { proto, array, keys, descriptors } = read;
    if (array) {
      const intrinsic = intrinsicOrUnreadable(proto, 'Array');
      if (intrinsic === null) fail('unreadable');
      if (!intrinsic) fail('prototype');
      const lengthAt = keys.indexOf('length');
      if (lengthAt < 0) fail('unreadable');
      const length = descriptors[lengthAt].value;
      const out = new Array(length);
      seen.set(value, out);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === 'length') continue;
        if (
          typeof key !== 'string' ||
          !INDEX_KEY.test(key) ||
          Number(key) >= length
        )
          fail('array-shape');
        const index = Number(key);
        const descriptor = descriptors[i];
        if (!('value' in descriptor)) failAt('accessor', index, index, true);
        pathKeys.push(index);
        pathIndexes.push(index);
        pathNamed.push(true);
        // Holes stay holes: they hold no behaviour.
        out[index] = walk(descriptor.value, 'opaque');
        pathKeys.pop();
        pathIndexes.pop();
        pathNamed.pop();
      }
      return out;
    }
    if (proto !== null) {
      const intrinsic = intrinsicOrUnreadable(proto, 'Object');
      if (intrinsic === null) fail('unreadable');
      if (!intrinsic) fail('prototype');
    }
    if (keys.length === 1 && keys[0] === TOKEN_REF) {
      const descriptor = descriptors[0];
      if (!('value' in descriptor) || typeof descriptor.value !== 'string')
        fail('token-mark');
      return Object.freeze({ [TOKEN_REF]: descriptor.value });
    }
    let isLeaf = false;
    if (context === 'node') {
      for (let i = 0; i < keys.length && !isLeaf; i++) {
        const d = descriptors[i];
        if (!('value' in d)) continue;
        isLeaf =
          (keys[i] === 'value' &&
            (typeof d.value === 'string' || typeof d.value === 'number')) ||
          (keys[i] === 'ref' && typeof d.value === 'string');
      }
    }
    const named = namesOf(context, isLeaf);
    const out = {};
    seen.set(value, out);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (typeof key === 'symbol') fail('symbol-key');
      const descriptor = descriptors[i];
      const isNamed = named.includes(key);
      if (!('value' in descriptor)) failAt('accessor', key, i, isNamed);
      if (!descriptor.enumerable) failAt('non-enumerable', key, i, isNamed);
      if (key === 'meta') hasMeta = true;
      pathKeys.push(key);
      pathIndexes.push(i);
      pathNamed.push(isNamed);
      const copied = walk(descriptor.value, childContext(context, key, isLeaf));
      pathKeys.pop();
      pathIndexes.pop();
      pathNamed.pop();
      // An own `__proto__` stays an own key; every other key is a plain
      // data property of a fresh object.
      if (key === '__proto__')
        Object.defineProperty(out, key, {
          value: copied,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else out[key] = copied;
    }
    return out;
  };
  let copy;
  try {
    copy = walk(definition, 'root');
  } catch (error) {
    if (error instanceof ShapeError)
      throw new PmsError([shapeDiagnostic(error.reason, error.field)]);
    throw error;
  }
  if (copy !== null && typeof copy === 'object') {
    INGRESS_COPIES.add(copy);
    if (!hasMeta) METALESS_COPIES.add(copy);
  }
  return copy;
}

/**
 * The own `definition` property of an input container (`config`,
 * `transaction`), copied by `snapshotDefinition`, without invoking an
 * accessor on the container's own `definition` property either.
 */
export function ownDefinitionOf(container) {
  if (container === null || typeof container !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(container, 'definition');
  } catch {
    throw new PmsError([shapeDiagnostic('unreadable', [])]);
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor))
    throw new PmsError([shapeDiagnostic('accessor', [])]);
  return snapshotDefinition(descriptor.value);
}
