/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - semantic metadata views (AG-03.1, design note §3.10).
 *
 * One projection of the canonical side table, for two audiences. The consumer
 * view lists only consumer-visible entities; the author view lists every
 * entity. `meta` holds declared metadata only, verbatim, and is absent when
 * nothing is declared; the view never synthesizes meaning (I3). Parents and
 * children are split, and the split is injective on valid states (I12).
 * PR 1 serves this through no operation (AG-03.2 does).
 */

import { PATTERN_IDS } from '../patterns/compile';
import { addressKey } from './diagnostics';
import { ownFields } from './build';
import { isPlain, kindOfAddress, ownValue } from './schema';
import { resolveAddress, vocabularyOf } from './references';

export const SEMANTICS_VIEW_KIND = 'pandamstyle-semantics-view';
export const SEMANTICS_VIEW_SCHEMA_VERSION = 1;

/** The vocabulary of a canonical snapshot's registry. */
export function snapshotVocabulary(snapshot) {
  const registry = snapshot.registry;
  return vocabularyOf({
    tokens: registry.tokens,
    themeNames: Object.keys(registry.themes),
    conditionNames: registry.conditionOrder,
    recipes: registry.recipes,
    patternIds: PATTERN_IDS,
    propertyKeys: Object.keys(registry.propertyDomains ?? {}),
  });
}

/** `{ audience: 'consumer' | 'author' }` view of a canonical snapshot. */
export function semanticsViewOf(snapshot, { audience = 'consumer' } = {}) {
  if (audience !== 'consumer' && audience !== 'author')
    throw new TypeError(`unknown semantics view audience: ${audience}`);
  const registry = snapshot.registry;
  const semantics = registry.semantics;
  const vocabulary = snapshotVocabulary(snapshot);
  const entities = [];
  const add = (address, origin, meta) => {
    const visibility =
      resolveAddress(vocabulary, address)?.visibility ?? 'public';
    if (audience === 'consumer' && visibility !== 'public') return;
    const entry = {
      entity: address,
      visibility,
      origin: { entity: origin, meta: 'definition' },
    };
    if (meta !== undefined) {
      if (audience === 'consumer') assertConsumerSafe(meta, vocabulary);
      entry.meta = meta;
    }
    entities.push(entry);
  };

  add(
    { system: true },
    'definition',
    semantics.system === undefined
      ? undefined
      : ownFields('system', semantics.system),
  );
  for (const tokenId of Object.keys(registry.tokens))
    add({ token: tokenId }, 'definition', ownValue(semantics.tokens, tokenId));
  for (const name of Object.keys(registry.themes))
    add({ theme: name }, 'definition', ownValue(semantics.themes, name));
  for (const name of registry.conditionOrder)
    add(
      { condition: name },
      'definition',
      ownValue(semantics.conditions, name),
    );
  for (const patternId of PATTERN_IDS)
    add(
      { pattern: patternId },
      'compiler',
      ownValue(ownValue(semantics.system, 'patterns'), patternId),
    );
  for (const property of Object.keys(registry.propertyDomains ?? {}))
    add(
      { property },
      'definition',
      ownValue(semantics.propertyDomains, property),
    );
  for (const recipeId of Object.keys(registry.recipes)) {
    const recipe = registry.recipes[recipeId];
    const meta = ownValue(semantics.recipes, recipeId);
    add(
      { recipe: recipeId },
      'definition',
      meta === undefined ? undefined : ownFields('recipe', meta),
    );
    for (const slot of recipe.slots ?? [])
      add(
        { recipe: recipeId, slot },
        'definition',
        ownValue(ownValue(meta, 'slots'), slot),
      );
    for (const axis of recipe.axisOrder) {
      // Own-property lookups only (fix round 1, B3): a value named
      // `constructor` or `toString` must not inherit an invented `meta`.
      const entry = ownValue(ownValue(meta, 'variants'), axis);
      add(
        { recipe: recipeId, variant: axis },
        'definition',
        ownValue(entry, 'meta'),
      );
      for (const value of Object.keys(recipe.variants[axis]))
        add(
          { recipe: recipeId, variant: axis, value },
          'definition',
          ownValue(ownValue(entry, 'values'), value),
        );
    }
  }
  entities.sort((a, b) => {
    const x = addressKey(a.entity);
    const y = addressKey(b.entity);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return {
    kind: SEMANTICS_VIEW_KIND,
    schemaVersion: SEMANTICS_VIEW_SCHEMA_VERSION,
    audience,
    designSystem: {
      systemId: snapshot.identity.systemId,
      registryDigest: snapshot.identity.registryDigest,
    },
    componentTargets: 'declared-unverified',
    entities,
  };
}

/**
 * Defense in depth: validation already guarantees that consumer-visible
 * metadata references no private entity. A failure is an internal error,
 * never a silent drop.
 */
function assertConsumerSafe(meta, vocabulary) {
  const targets = [
    ...(meta.relations ?? []).map((relation) => relation.target),
    ...(meta.deprecated?.replacement === undefined
      ? []
      : [meta.deprecated.replacement]),
  ];
  // Token references written as data inside examples, under any key.
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!isPlain(value)) return undefined;
    const keys = Object.keys(value);
    if (
      keys.length === 1 &&
      keys[0] === 'token' &&
      typeof value.token === 'string'
    )
      targets.push({ token: value.token });
    else for (const key of keys) walk(ownValue(value, key));
    return undefined;
  };
  walk(ownValue(meta, 'examples'));
  for (const target of targets) {
    if (!isPlain(target) || kindOfAddress(target) === 'component') continue;
    if (resolveAddress(vocabulary, target)?.visibility !== 'public')
      throw new Error(
        'internal: consumer-visible metadata references a non-public entity',
      );
  }
}
