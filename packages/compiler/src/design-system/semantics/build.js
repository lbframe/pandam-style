/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the canonical metadata side table (AG-03.1, design note §3.1).
 *
 * `buildSemantics` validates every `meta` of a definition against the
 * registry's declared vocabulary and returns `registry.semantics`: the
 * verbatim, validated `meta` values keyed by entity, in null-prototype maps,
 * deep-frozen. Compiled records never hold metadata, so no compilation hash,
 * semantic unit or generated artifact can see it (I2). Every issue is
 * reported, in safe form (§3.9.1); an entity whose `meta` fails its snapshot
 * or schema gets no further check (no cascades).
 */

import {
  canonicalSize,
  collectMetaInputs,
  META_CAPS,
  snapshotMetadata,
} from './snapshot';
import { CHILD_KEYS, defineOwn, ownValue, validateEntityMeta } from './schema';
import {
  addressKey,
  childAddress,
  createMetadataReporter,
  privateEntityOrder,
} from './diagnostics';
import {
  checkPrivateNames,
  checkReferences,
  privateNameMatcher,
  replacementCycles,
  resolveAddress,
} from './references';

const nullRecord = () => Object.create(null);

/** Whether an address names a private entity, by the vocabulary. */
export const isPrivateIn = (vocabulary) => (address) =>
  resolveAddress(vocabulary, address)?.visibility === 'private';

/**
 * `{ semantics, diagnostics }` for `definition`; `vocabularyOf()` returns the
 * registry's vocabulary (see references.js `vocabularyOf`).
 */
// The side table of a definition without metadata: one shared frozen value,
// so the common case allocates nothing on the session path.
const EMPTY_SEMANTICS = deepFreezeTable({
  tokens: nullRecord(),
  themes: nullRecord(),
  conditions: nullRecord(),
  recipes: nullRecord(),
  propertyDomains: nullRecord(),
});

/** Whether a side table holds no metadata at all. */
export function isEmptySemantics(semantics) {
  return (
    semantics === EMPTY_SEMANTICS ||
    (semantics.system === undefined &&
      ['tokens', 'themes', 'conditions', 'recipes', 'propertyDomains'].every(
        (table) => Object.keys(semantics[table]).length === 0,
      ))
  );
}

export function buildSemantics(definition, vocabularyOf) {
  const {
    entities: inputs,
    positions,
    unreadable,
  } = collectMetaInputs(definition);
  if (unreadable) {
    const diagnose = createMetadataReporter({
      order: new Map(),
      isPrivate: () => false,
    });
    return {
      semantics: EMPTY_SEMANTICS,
      diagnostics: [
        diagnose('metadata.malformed', null, [], { reason: 'unreadable' }),
      ],
      entities: [],
    };
  }
  if (inputs.length === 0 && positions.length === 0)
    return { semantics: EMPTY_SEMANTICS, diagnostics: [], entities: [] };
  // `vocabularyOf` is a thunk: the vocabulary is built only when needed.
  const vocabulary = vocabularyOf();
  const diagnose = createMetadataReporter({
    order: privateEntityOrder(definition),
    isPrivate: isPrivateIn(vocabulary),
  });
  const diagnostics = [];
  for (const { reason, field } of positions) {
    diagnostics.push(
      diagnose('metadata.unsupported-position', null, field, { reason }),
    );
  }

  const semantics = {
    tokens: nullRecord(),
    themes: nullRecord(),
    conditions: nullRecord(),
    recipes: nullRecord(),
    propertyDomains: nullRecord(),
  };
  const TABLE = {
    token: ['tokens', 'token'],
    theme: ['themes', 'theme'],
    condition: ['conditions', 'condition'],
    recipe: ['recipes', 'recipe'],
    property: ['propertyDomains', 'property'],
  };
  const valid = []; // entities whose meta passed snapshot and schema
  let total = 0;
  for (const input of inputs) {
    const { kind, address, visibility, slot } = input;
    // Only declared entities: an invalid property-domain entry is reported by
    // CE-02.1, not here.
    if (resolveAddress(vocabulary, address) == null) continue;
    const report = (rule, field, extra) =>
      diagnostics.push(diagnose(rule, address, field, extra));
    if (slot.accessor || slot.unreadable) {
      report('metadata.malformed', [], {
        reason: slot.accessor ? 'accessor' : 'unreadable',
      });
      continue;
    }
    const snapshot = snapshotMetadata(slot.value);
    if (snapshot.issue != null) {
      report('metadata.malformed', snapshot.issue.field, {
        reason: snapshot.issue.reason,
      });
      continue;
    }
    const recipe =
      kind === 'recipe' ? vocabulary.recipes.get(address.recipe) : null;
    let before = diagnostics.length;
    const checked = validateEntityMeta(kind, snapshot.value, report, recipe);
    if (checked == null) continue;
    const family = [
      {
        kind,
        address,
        visibility,
        own: checked.own,
        ok: diagnostics.length === before,
      },
    ];
    for (const child of checked.children) {
      const childAddr = childAddress(address, child);
      const childReport = (rule, field, extra) =>
        diagnostics.push(diagnose(rule, childAddr, field, extra));
      before = diagnostics.length;
      const result = validateEntityMeta(child.kind, child.value, childReport);
      if (result != null)
        family.push({
          kind: child.kind,
          address: childAddr,
          visibility,
          own: result.own,
          ok: diagnostics.length === before,
        });
    }
    for (const member of family) {
      const size = canonicalSize(member.own);
      total += size;
      if (size > META_CAPS.entityBytes) {
        diagnostics.push(
          diagnose('metadata.too-large', member.address, [], {
            bytes: size,
            limit: META_CAPS.entityBytes,
          }),
        );
      }
    }
    if (kind === 'system') semantics.system = snapshot.value;
    else semantics[TABLE[kind][0]][address[TABLE[kind][1]]] = snapshot.value;
    for (const { ok, ...member } of family) if (ok) valid.push(member);
  }
  if (total > META_CAPS.totalBytes) {
    diagnostics.push(
      diagnose('metadata.total-too-large', null, [], {
        bytes: total,
        limit: META_CAPS.totalBytes,
      }),
    );
  }

  const matcher = privateNameMatcher(vocabulary);
  const edges = [];
  for (const entity of valid) {
    const report = (rule, field, extra) =>
      diagnostics.push(diagnose(rule, entity.address, field, extra));
    const edge = checkReferences(entity, vocabulary, report);
    if (edge != null) edges.push(edge);
    if (entity.visibility === 'public')
      checkPrivateNames(entity.own, matcher, report);
  }
  for (const cycle of replacementCycles(edges)) {
    const addresses = cycle.map((key) => JSON.parse(key));
    diagnostics.push(
      diagnose(
        'metadata.replacement-cycle',
        addresses[0],
        ['deprecated', 'replacement'],
        {
          cycleLength: cycle.length,
          cycle: addresses.slice(0, 16),
        },
      ),
    );
  }
  return {
    semantics: deepFreezeTable(semantics),
    diagnostics,
    entities: valid,
  };
}

function deepFreezeTable(table) {
  for (const key of Object.keys(table)) {
    if (key !== 'system') Object.freeze(table[key]);
  }
  return Object.freeze(table);
}

/**
 * The entities of a built side table with their own fields, for the example
 * stage and the views: `{ kind, address, visibility, own }`. Children follow
 * their parent; the order is canonical by address.
 */
export function semanticEntities(semantics, vocabulary) {
  const out = [];
  const push = (kind, address, meta) => {
    out.push({
      kind,
      address,
      visibility: resolveAddress(vocabulary, address)?.visibility ?? 'public',
      own: ownFields(kind, meta),
    });
  };
  if (semantics.system !== undefined) {
    push('system', { system: true }, semantics.system);
    for (const [name, meta] of Object.entries(
      ownValue(semantics.system, 'patterns') ?? {},
    ))
      push('pattern', { pattern: name }, meta);
  }
  for (const [id, meta] of Object.entries(semantics.tokens))
    push('token', { token: id }, meta);
  for (const [name, meta] of Object.entries(semantics.themes))
    push('theme', { theme: name }, meta);
  for (const [name, meta] of Object.entries(semantics.conditions))
    push('condition', { condition: name }, meta);
  for (const [property, meta] of Object.entries(semantics.propertyDomains))
    push('property', { property }, meta);
  for (const [recipeId, meta] of Object.entries(semantics.recipes)) {
    push('recipe', { recipe: recipeId }, meta);
    for (const [slot, child] of Object.entries(ownValue(meta, 'slots') ?? {}))
      push('slot', { recipe: recipeId, slot }, child);
    for (const [axis, entry] of Object.entries(
      ownValue(meta, 'variants') ?? {},
    )) {
      if (Object.hasOwn(entry, 'meta'))
        push(
          'axis',
          { recipe: recipeId, variant: axis },
          ownValue(entry, 'meta'),
        );
      for (const [value, child] of Object.entries(
        ownValue(entry, 'values') ?? {},
      ))
        push('value', { recipe: recipeId, variant: axis, value }, child);
    }
  }
  return out.sort((a, b) => {
    const x = addressKey(a.address);
    const y = addressKey(b.address);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** An entity's own fields: its `meta` without child containers. */
export function ownFields(kind, meta) {
  const children = CHILD_KEYS[kind];
  if (children === undefined) return meta;
  const own = {};
  for (const key of Object.keys(meta))
    if (!children.includes(key)) defineOwn(own, key, meta[key]);
  return own;
}
