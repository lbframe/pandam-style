/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - audience-safe metadata diagnostics (AG-03.1, design note
 * §3.9, §3.9.1).
 *
 * Every `PMS_INVALID_METADATA` diagnostic is built here, in its safe form, so
 * every path that carries it (SDK `validate()`, agent `check` and
 * `records.read`, formatted output) carries only that form (I7, I11):
 *
 * - a consumer-visible entity is shown by its address; a private one as
 *   `{ kind, visibility: 'private', ordinal }`, its rank among the private
 *   entities of that kind that have an own `meta` key, by canonical address;
 * - `field` holds closed field names, array indexes and `{ index }`
 *   placeholders, never an author string;
 * - `message` names consumer-visible entities only; `source` is constant;
 * - no metadata value is ever copied.
 */

import { Codes, diagnostic } from '../../protocol/diagnostics';
import { collectMetaInputs, snapshotMetadata } from './snapshot';
import { CHILD_KEYS, isPlain } from './schema';

export const addressKey = (address) => JSON.stringify(address);

const CONTEXT_KEYS = new Set([
  'reason',
  'bytes',
  'limit',
  'expectedKind',
  'actualKind',
  'privateKind',
  'cycleLength',
  'cycle',
  'cause',
]);

const RULE_TEXT = Object.freeze({
  'metadata.malformed': 'the value is not plain metadata data',
  'metadata.unsupported-position': '`meta` is not supported at this position',
  'metadata.unknown-field': 'a field is outside the closed schema of this kind',
  'metadata.field-type': 'a field has the wrong type, count or grammar',
  'metadata.text': 'a text field breaks the text rules',
  'metadata.too-large': "the entity's own metadata exceeds its size cap",
  'metadata.total-too-large': "the definition's metadata exceeds its size cap",
  'metadata.unknown-child':
    'a child key names no declared slot, axis, value or pattern',
  'metadata.unknown-reference': 'a reference names no declared entity',
  'metadata.private-reference':
    'consumer-visible metadata references a private entity',
  'metadata.self-reference': 'an entity references itself',
  'metadata.reference-kind':
    'a relation or component target has the wrong kind',
  'metadata.replacement-kind':
    'a replacement is not of the same kind, category or scope',
  'metadata.replacement-cycle': 'replacements form a cycle',
  'metadata.invalid-example': 'an example does not compile',
  'metadata.private-identifier':
    'consumer-visible metadata text names a private entity',
});

/** The kind of a child of `parentKind` stored under `key`. */
const childKindOf = (key) =>
  key === 'patterns' ? 'pattern' : key === 'slots' ? 'slot' : 'variants';

/**
 * The private entities of a definition that have an own `meta` key, in
 * canonical address order, as `Map<addressKey, { kind, ordinal }>`. A pure
 * function of the definition: the registry, the example stage and
 * `resolvePrivateEntity` compute the same ordinals.
 */
export function privateEntityOrder(definition) {
  const { entities } = collectMetaInputs(definition);
  const recipes =
    isPlain(definition) && isPlain(definition.recipes)
      ? definition.recipes
      : {};
  const found = [];
  for (const entity of entities) {
    if (entity.visibility !== 'private') continue;
    found.push({ kind: entity.kind, address: entity.address });
    if (entity.kind !== 'recipe' || !('value' in entity.slot)) continue;
    const snapshot = snapshotMetadata(entity.slot.value);
    if (snapshot.issue != null || !isPlain(snapshot.value)) continue;
    const declared = declaredRecipe(recipes[entity.address.recipe]);
    for (const child of childEntities('recipe', snapshot.value, declared)) {
      found.push({
        kind: child.kind,
        address: childAddress(entity.address, child),
      });
    }
  }
  found.sort((a, b) => {
    const x = addressKey(a.address);
    const y = addressKey(b.address);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const order = new Map();
  const counters = {};
  for (const { kind, address } of found) {
    const key = addressKey(address);
    if (order.has(key)) continue;
    counters[kind] = (counters[kind] ?? -1) + 1;
    order.set(key, { kind, ordinal: counters[kind] });
  }
  return order;
}

/** `{ slots, axes }` declared by a recipe definition, read leniently. */
export function declaredRecipe(recipe) {
  const slots =
    isPlain(recipe) && Array.isArray(recipe.slots)
      ? recipe.slots.filter((slot) => typeof slot === 'string')
      : [];
  const axes = {};
  if (isPlain(recipe) && isPlain(recipe.variants)) {
    for (const axis of Object.keys(recipe.variants)) {
      const values = recipe.variants[axis];
      axes[axis] = isPlain(values) ? Object.keys(values) : [];
    }
  }
  return { slots, axes };
}

/**
 * The declared child entities of a parent `meta` (a snapshot), without
 * validating them: `{ kind, key, value }`. Undeclared keys are not entities.
 */
export function childEntities(kind, meta, declared) {
  const out = [];
  for (const key of CHILD_KEYS[kind] ?? []) {
    const map = meta[key];
    if (!isPlain(map)) continue;
    for (const name of Object.keys(map)) {
      const childKind = childKindOf(key);
      if (childKind === 'pattern' || childKind === 'slot') {
        if (childKind === 'slot' && !declared.slots.includes(name)) continue;
        out.push({ kind: childKind, key: [name], value: map[name] });
        continue;
      }
      if (!Object.hasOwn(declared.axes, name) || !isPlain(map[name])) continue;
      const entry = map[name];
      if (Object.hasOwn(entry, 'meta'))
        out.push({ kind: 'axis', key: [name], value: entry.meta });
      if (isPlain(entry.values)) {
        for (const value of Object.keys(entry.values)) {
          if (!declared.axes[name].includes(value)) continue;
          out.push({
            kind: 'value',
            key: [name, value],
            value: entry.values[value],
          });
        }
      }
    }
  }
  return out;
}

/** The address of a child entity. */
export function childAddress(parent, child) {
  switch (child.kind) {
    case 'pattern':
      return { pattern: child.key[0] };
    case 'slot':
      return { recipe: parent.recipe, slot: child.key[0] };
    case 'axis':
      return { recipe: parent.recipe, variant: child.key[0] };
    default:
      return {
        recipe: parent.recipe,
        variant: child.key[0],
        value: child.key[1],
      };
  }
}

/**
 * The diagnostic factory for one definition. `isPrivate(address)` comes from
 * the registry's vocabulary; `order` from `privateEntityOrder`.
 */
export function createMetadataReporter({ order, isPrivate }) {
  const safeEntity = (address) => {
    if (address == null) return null;
    if (!isPrivate(address)) return address;
    const ranked = order.get(addressKey(address));
    // Fail closed: a private entity without an ordinal must never be shown.
    if (ranked == null)
      throw new Error('internal: private metadata entity without an ordinal');
    return {
      kind: ranked.kind,
      visibility: 'private',
      ordinal: ranked.ordinal,
    };
  };
  const label = (address) => {
    if (address == null) return 'the design-system definition';
    if (isPrivate(address))
      return `a private ${order.get(addressKey(address))?.kind ?? 'entity'}`;
    if (Object.hasOwn(address, 'system')) return 'the design system';
    return Object.entries(address)
      .map(([key, value]) =>
        key === 'component' ? 'a component' : `${key} ${JSON.stringify(value)}`,
      )
      .join(', ');
  };
  return function metadataDiagnostic(rule, address, field = [], extra = {}) {
    const context = { entity: safeEntity(address), field };
    for (const [key, value] of Object.entries(extra)) {
      if (!CONTEXT_KEYS.has(key))
        throw new Error(`internal: metadata context key ${key} is not closed`);
      context[key] = key === 'cycle' ? value.map(safeEntity) : value;
    }
    return {
      ...diagnostic({
        code: Codes.INVALID_METADATA,
        severity: 'error',
        phase: 'registry',
        message: `Metadata of ${label(address)}: ${RULE_TEXT[rule]}.`,
        source: 'design-system',
        rule,
        context,
      }),
      repair: {
        kind: 'edit-design-system-definition',
        applicable: false,
        target: null,
        expected: null,
        reason: 'metadata is design-system author data',
      },
    };
  };
}

/**
 * The address of a private entity shown in safe form, recomputed from the
 * definition (§3.9.1). In-process only: not exported from any package entry
 * and reachable from no operation. Null when nothing matches.
 */
export function resolvePrivateEntity(definition, safe) {
  if (!isPlain(safe) || safe.visibility !== 'private') return null;
  for (const [key, ranked] of privateEntityOrder(definition)) {
    if (ranked.kind === safe.kind && ranked.ordinal === safe.ordinal)
      return JSON.parse(key);
  }
  return null;
}
