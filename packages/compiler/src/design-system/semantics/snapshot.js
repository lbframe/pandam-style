/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - semantic metadata input (AG-03.1, design note §3.2, §3.8.1).
 *
 * `collectMetaInputs` is the single reader of `meta` positions in a
 * definition: the registry, the ordinals of private entities and
 * `resolvePrivateEntity` all use it, so a position cannot be read in one place
 * and missed in another. `snapshotMetadata` copies one `meta` value into
 * frozen plain data, reading descriptors before values, so the compiler never
 * invokes an author accessor (I6).
 */

import { PATTERN_IDS } from '../patterns/compile';

/**
 * Caps. Identifier lengths in addresses belong to CE #134, which is open: the
 * caps below are the design note's provisional defaults (§3.3, §3.8.2) and
 * must not go below #134's identifier limits once they land.
 */
export const META_CAPS = Object.freeze({
  entityBytes: 4096,
  totalBytes: 1024 * 1024,
  depth: 12,
  semanticRole: 64,
  description: 512,
  listText: 256,
  listItems: 8,
  terms: 16,
  termBytes: 48,
  relations: 16,
  examples: 4,
  reason: 256,
  componentModule: 256,
  componentExport: 128,
});

/**
 * `undefined` when no own `meta` key, else `{ value }`, `{ accessor: true }`
 * or `{ unreadable: true }` when inspecting the record throws (B5).
 */
export function metaSlotOf(record) {
  if (record === null || typeof record !== 'object') return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, 'meta');
  } catch {
    return { unreadable: true };
  }
  if (descriptor === undefined) return undefined;
  return 'value' in descriptor
    ? { value: descriptor.value }
    : { accessor: true };
}

/** The token leaf predicate shared with `flattenTokens`. */
export function isTokenLeaf(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    (typeof entry.value === 'string' ||
      typeof entry.value === 'number' ||
      typeof entry.ref === 'string')
  );
}

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

// Collections (token categories and groups, themes, conditions, recipes) are
// read by the compiler with `Object.keys` on any object, arrays included, so
// the metadata traversal reads exactly the same shapes (fix round 1, B4).
const isCollection = (value) => value !== null && typeof value === 'object';

/**
 * Every `meta` slot of a definition, and every unsupported `meta` position.
 * `entities` are in definition order: `{ kind, address, visibility, slot }`.
 * `positions` are `{ reason, field }`, `field` in index form (§3.9).
 */
export function collectMetaInputs(definition) {
  // Public input is plain data (ingress, §3.8.0). For an internal caller, a
  // traversal that throws is reported as unreadable, never as a raw error
  // (fix round 1, B5).
  try {
    return collectMetaInputsUnguarded(definition);
  } catch {
    return { entities: [], positions: [], unreadable: true };
  }
}

function collectMetaInputsUnguarded(definition) {
  const entities = [];
  const positions = [];
  if (!isCollection(definition)) return { entities, positions };
  const own = (record, key) =>
    isCollection(record) && Object.hasOwn(record, key)
      ? record[key]
      : undefined;

  const systemSlot = metaSlotOf(definition);
  if (systemSlot !== undefined) {
    entities.push({
      kind: 'system',
      address: { system: true },
      visibility: 'public',
      slot: systemSlot,
    });
  }

  const tokens = own(definition, 'tokens');
  const seenTokens = new Set();
  const walkTokens = (node, category, prefix, field, override) => {
    if (!isCollection(node)) return;
    const keys = Object.keys(node);
    keys.forEach((key, index) => {
      if (key === '') return;
      const entry = node[key];
      if (key === 'meta') {
        positions.push({
          reason: 'token-group',
          field: [...field, 'meta'],
        });
        return;
      }
      const path = prefix === '' ? key : `${prefix}.${key}`;
      const at = [...field, { index }];
      if (isTokenLeaf(entry)) {
        const slot = metaSlotOf(entry);
        if (slot === undefined) return;
        if (override) {
          positions.push({
            reason: 'theme-override-leaf',
            field: [...at, 'meta'],
          });
          return;
        }
        const tokenId = `${category}.${path}`;
        if (seenTokens.has(tokenId)) return;
        seenTokens.add(tokenId);
        entities.push({
          kind: 'token',
          address: { token: tokenId },
          visibility: entry.visibility === 'private' ? 'private' : 'public',
          slot,
        });
      } else if (isCollection(entry)) {
        walkTokens(entry, category, path, at, override);
      }
    });
  };
  const walkCategories = (root, field, override) => {
    if (!isCollection(root)) return;
    Object.keys(root).forEach((category, index) => {
      if (category === 'meta') {
        positions.push({ reason: 'token-category', field: [...field, 'meta'] });
        return;
      }
      walkTokens(root[category], category, '', [...field, { index }], override);
    });
  };
  walkCategories(tokens, ['tokens'], false);

  const themes = own(definition, 'themes');
  if (isCollection(themes)) {
    Object.keys(themes).forEach((name, index) => {
      const theme = themes[name];
      const slot = metaSlotOf(theme);
      if (slot !== undefined) {
        entities.push({
          kind: 'theme',
          address: { theme: name },
          visibility: 'public',
          slot,
        });
      }
      walkCategories(
        own(theme, 'tokens'),
        ['themes', { index }, 'tokens'],
        true,
      );
    });
  }

  const conditions = own(definition, 'conditions');
  if (isCollection(conditions)) {
    for (const name of Object.keys(conditions)) {
      const slot = metaSlotOf(conditions[name]);
      if (slot === undefined) continue;
      entities.push({
        kind: 'condition',
        address: { condition: name },
        visibility: 'public',
        slot,
      });
    }
  }

  const recipes = own(definition, 'recipes');
  if (isCollection(recipes)) {
    for (const recipeId of Object.keys(recipes)) {
      const recipe = recipes[recipeId];
      const slot = metaSlotOf(recipe);
      if (slot === undefined) continue;
      entities.push({
        kind: 'recipe',
        address: { recipe: recipeId },
        visibility:
          isRecord(recipe) && recipe.visibility === 'private'
            ? 'private'
            : 'public',
        slot,
      });
    }
  }

  const domains = own(definition, 'propertyDomains');
  if (isRecord(domains)) {
    for (const property of Object.keys(domains)) {
      const slot = metaSlotOf(domains[property]);
      if (slot === undefined) continue;
      entities.push({
        kind: 'property',
        address: { property },
        visibility: 'public',
        slot,
      });
    }
  }
  return { entities, positions };
}

/** The pattern ids a system `meta.patterns` map may name. */
export const PATTERN_ID_SET = new Set(PATTERN_IDS);

/**
 * Copies one `meta` value into frozen plain data, or reports why it cannot.
 * Returns `{ value }` or `{ issue: { reason, field } }`. Strings are kept by
 * reference: nothing is measured or copied twice.
 */
export function snapshotMetadata(input, caps = META_CAPS) {
  const onPath = new Set();
  // Every reflective operation on an author object is guarded: a throwing or
  // lying Proxy trap becomes the closed reason `unreadable`, never a raw
  // error carrying author text (fix round 1, B5).
  const guard = (op, field) => {
    try {
      return op();
    } catch (error) {
      if (error instanceof MetaIssue) throw error;
      throw issue('unreadable', field);
    }
  };
  const describe = (value, key, field) => {
    const descriptor = guard(
      () => Object.getOwnPropertyDescriptor(value, key),
      field,
    );
    if (descriptor === undefined) throw issue('unreadable', field);
    return descriptor;
  };
  const walk = (value, field, depth) => {
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return value;
    if (type === 'number') {
      if (!Number.isFinite(value)) throw issue('non-finite', field);
      if (Object.is(value, -0)) throw issue('negative-zero', field);
      return value;
    }
    if (value === null) return null;
    if (type === 'undefined') throw issue('undefined', field);
    if (type === 'function') throw issue('function', field);
    if (type !== 'object') throw issue(type, field);
    if (depth > caps.depth) throw issue('depth', field);
    if (onPath.has(value)) throw issue('cycle', field);
    const proto = guard(() => Object.getPrototypeOf(value), field);
    const array = guard(() => Array.isArray(value), field);
    if (
      array
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    ) {
      throw issue('prototype', field);
    }
    onPath.add(value);
    const keys = guard(() => Reflect.ownKeys(value), field);
    let out;
    if (array) {
      const length = describe(value, 'length', field).value;
      for (const key of keys) {
        if (key === 'length') continue;
        if (
          typeof key !== 'string' ||
          !/^(?:0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= length
        )
          throw issue('array-shape', field);
      }
      out = [];
      for (let i = 0; i < length; i++) {
        const descriptor = guard(
          () => Object.getOwnPropertyDescriptor(value, String(i)),
          [...field, i],
        );
        if (descriptor === undefined) throw issue('hole', [...field, i]);
        if (!('value' in descriptor)) throw issue('accessor', [...field, i]);
        out.push(walk(descriptor.value, [...field, i], depth + 1));
      }
    } else {
      out = {};
      keys.forEach((key, index) => {
        if (typeof key === 'symbol') throw issue('symbol-key', field);
        const at = [...field, { index }];
        const descriptor = describe(value, key, at);
        if (!('value' in descriptor)) throw issue('accessor', at);
        if (!descriptor.enumerable) throw issue('non-enumerable', at);
        Object.defineProperty(out, key, {
          value: walk(descriptor.value, at, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
    }
    onPath.delete(value);
    return Object.freeze(out);
  };
  try {
    return { value: walk(input, [], 1) };
  } catch (error) {
    if (error instanceof MetaIssue) return { issue: error.detail };
    throw error;
  }
}

class MetaIssue extends Error {
  constructor(detail) {
    super(detail.reason);
    this.detail = detail;
  }
}
const issue = (reason, field) => new MetaIssue({ reason, field });

// Built at run time: the bundle must stay one-byte source.
const PROTOCOL_ESCAPED = new RegExp('[\\u007f-\\uffff]', 'g');

/**
 * Size in bytes of the AG-01.1 protocol serialization (`canonicalJson` in
 * protocol/envelope.js): `JSON.stringify`, then every UTF-16 unit in
 * U+007F..U+FFFF replaced by the six ASCII bytes of its `\\uXXXX` escape.
 * It is computed from the same `JSON.stringify` output and the same character
 * class, so it equals that serializer's byte count exactly (fix round 1, B6);
 * a differential test holds the two together. Key order does not change it.
 */
export function canonicalSize(value) {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  const escaped = json.match(PROTOCOL_ESCAPED);
  return json.length + 5 * (escaped === null ? 0 : escaped.length);
}
