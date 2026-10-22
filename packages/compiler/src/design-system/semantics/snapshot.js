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

/** `undefined` when no own `meta` key, else `{ value }` or `{ accessor: true }`. */
export function metaSlotOf(record) {
  if (record === null || typeof record !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, 'meta');
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

/**
 * Every `meta` slot of a definition, and every unsupported `meta` position.
 * `entities` are in definition order: `{ kind, address, visibility, slot }`.
 * `positions` are `{ reason, field }`, `field` in index form (§3.9).
 */
export function collectMetaInputs(definition) {
  const entities = [];
  const positions = [];
  if (!isRecord(definition)) return { entities, positions };
  const own = (record, key) =>
    isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined;

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
    if (!isRecord(node)) return;
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
      } else if (isRecord(entry)) {
        walkTokens(entry, category, path, at, override);
      }
    });
  };
  const walkCategories = (root, field, override) => {
    if (!isRecord(root)) return;
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
  if (isRecord(themes)) {
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
  if (isRecord(conditions)) {
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
  if (isRecord(recipes)) {
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
    const proto = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (
      array
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    ) {
      throw issue('prototype', field);
    }
    onPath.add(value);
    const keys = Reflect.ownKeys(value);
    let out;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length').value;
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
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor === undefined) throw issue('hole', [...field, i]);
        if (!('value' in descriptor)) throw issue('accessor', [...field, i]);
        out.push(walk(descriptor.value, [...field, i], depth + 1));
      }
    } else {
      out = {};
      keys.forEach((key, index) => {
        if (typeof key === 'symbol') throw issue('symbol-key', field);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        const at = [...field, { index }];
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

/**
 * Size in the AG-01.1 canonical serialization: JSON with sorted keys and every
 * non-ASCII UTF-16 unit escaped as `\uXXXX`.
 */
export function canonicalSize(value) {
  if (value === null) return 4;
  switch (typeof value) {
    case 'string':
      return stringSize(value);
    case 'number':
    case 'boolean':
      return JSON.stringify(value).length;
    default:
      break;
  }
  if (Array.isArray(value)) {
    let size = 2 + Math.max(0, value.length - 1);
    for (const item of value) size += canonicalSize(item);
    return size;
  }
  const keys = Object.keys(value);
  let size = 2 + Math.max(0, keys.length - 1);
  for (const key of keys)
    size += stringSize(key) + 1 + canonicalSize(value[key]);
  return size;
}

function stringSize(text) {
  let size = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) size += 2;
    else if (
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    )
      size += 2;
    else if (code < 0x20 || code > 0x7f) size += 6;
    else size += 1;
  }
  return size;
}
