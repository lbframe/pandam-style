/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - metadata references (AG-03.1, design note §3.4, §3.5, §3.7.1).
 *
 * Resolution against the declared vocabulary, the visibility rule (a
 * consumer-visible entity references only consumer-visible entities), the
 * replacement graph (same kind, acyclic) and the private-name match over every
 * `free` and `literal` string of consumer-visible metadata.
 */

import { addressKey } from './diagnostics';
import { isPlain, kindOfAddress, stringClassOf } from './schema';

/**
 * The declared vocabulary the metadata may name, from the normalized
 * registry data. `recipes` maps an id to `{ visibility, slots, axes }`.
 */
export function vocabularyOf({
  tokens,
  themeNames,
  conditionNames,
  recipes,
  patternIds,
  propertyKeys,
}) {
  return {
    tokens: new Map(
      Object.values(tokens).map((t) => [
        t.tokenId,
        { visibility: t.visibility, category: t.category },
      ]),
    ),
    themes: new Set(themeNames),
    conditions: new Set(conditionNames),
    recipes: new Map(
      Object.entries(recipes).map(([recipeId, r]) => [
        recipeId,
        {
          visibility: r.visibility,
          slots: r.slots ?? [],
          axes: Object.fromEntries(
            r.axisOrder.map((axis) => [axis, Object.keys(r.variants[axis])]),
          ),
        },
      ]),
    ),
    patterns: new Set(patternIds),
    properties: new Set(propertyKeys),
  };
}

/** `{ kind, visibility, category? }` of a declared entity, or null. */
export function resolveAddress(vocabulary, address) {
  const kind = kindOfAddress(address);
  switch (kind) {
    case 'system':
      return { kind, visibility: 'public' };
    case 'token': {
      const token = vocabulary.tokens.get(address.token);
      return token == null
        ? null
        : { kind, visibility: token.visibility, category: token.category };
    }
    case 'theme':
      return vocabulary.themes.has(address.theme)
        ? { kind, visibility: 'public' }
        : null;
    case 'condition':
      return vocabulary.conditions.has(address.condition)
        ? { kind, visibility: 'public' }
        : null;
    case 'pattern':
      return vocabulary.patterns.has(address.pattern)
        ? { kind, visibility: 'public' }
        : null;
    case 'property':
      return vocabulary.properties.has(address.property)
        ? { kind, visibility: 'public' }
        : null;
    case 'component':
      return { kind, visibility: 'public' };
    default: {
      const recipe = vocabulary.recipes.get(address.recipe);
      if (recipe == null || !vocabulary.recipes.has(address.recipe))
        return null;
      const found = { kind, visibility: recipe.visibility };
      if (kind === 'recipe') return found;
      if (kind === 'slot')
        return recipe.slots.includes(address.slot) ? found : null;
      if (!Object.hasOwn(recipe.axes, address.variant)) return null;
      if (kind === 'axis') return found;
      return recipe.axes[address.variant].includes(address.value)
        ? found
        : null;
    }
  }
}

/**
 * Checks the references of one entity's own `meta`. Returns the declared
 * replacement edge `{ from, to }` when it is valid, else null.
 */
export function checkReferences(entity, vocabulary, report) {
  const { own, address, visibility } = entity;
  const self = addressKey(address);
  const source = visibility === 'public';
  (own.relations ?? []).forEach((relation, i) => {
    const field = ['relations', i, 'target'];
    const target = relation.target;
    const component = Object.hasOwn(target, 'component');
    if (component !== (relation.relation === 'implemented-by')) {
      report('metadata.reference-kind', field, {
        reason: component ? 'component-relation' : 'implemented-by-target',
      });
      return;
    }
    if (component) return;
    const found = resolveAddress(vocabulary, target);
    if (found == null) return report('metadata.unknown-reference', field, {});
    if (addressKey(target) === self)
      return report('metadata.self-reference', field, {});
    if (source && found.visibility !== 'public')
      report('metadata.private-reference', field, {});
    return undefined;
  });
  const replacement = own.deprecated?.replacement;
  if (replacement === undefined) return null;
  const field = ['deprecated', 'replacement'];
  const sourceKind = kindOfAddress(address);
  const targetKind = kindOfAddress(replacement);
  if (targetKind === 'component') {
    report('metadata.replacement-kind', field, {
      expectedKind: sourceKind,
      actualKind: targetKind,
    });
    return null;
  }
  const found = resolveAddress(vocabulary, replacement);
  if (found == null) {
    report('metadata.unknown-reference', field, {});
    return null;
  }
  if (source && found.visibility !== 'public') {
    report('metadata.private-reference', field, {});
    return null;
  }
  if (targetKind !== sourceKind) {
    report('metadata.replacement-kind', field, {
      expectedKind: sourceKind,
      actualKind: targetKind,
    });
    return null;
  }
  if (
    sourceKind === 'token' &&
    vocabulary.tokens.get(address.token).category !== found.category
  ) {
    report('metadata.replacement-kind', field, {
      expectedKind: sourceKind,
      actualKind: targetKind,
      reason: 'category',
    });
    return null;
  }
  if (
    (sourceKind === 'slot' ||
      sourceKind === 'axis' ||
      sourceKind === 'value') &&
    (replacement.recipe !== address.recipe ||
      (sourceKind === 'value' && replacement.variant !== address.variant))
  ) {
    report('metadata.replacement-kind', field, {
      expectedKind: sourceKind,
      actualKind: targetKind,
      reason: 'scope',
    });
    return null;
  }
  return { from: self, to: addressKey(replacement) };
}

/**
 * Every cycle of the functional replacement graph, once each, as the list of
 * its addresses (keys) walked from its smallest key. Iterative: a chain of any
 * length uses constant stack.
 */
export function replacementCycles(edges) {
  const next = new Map(edges.map(({ from, to }) => [from, to]));
  const color = new Map(); // 1 = on the current walk, 2 = done
  const cycles = [];
  for (const start of [...next.keys()].sort()) {
    if (color.has(start)) continue;
    const walk = [];
    let node = start;
    while (node !== undefined && !color.has(node)) {
      color.set(node, 1);
      walk.push(node);
      node = next.get(node);
    }
    if (node !== undefined && color.get(node) === 1) {
      const cycle = walk.slice(walk.indexOf(node));
      const smallest = [...cycle].sort()[0];
      const from = cycle.indexOf(smallest);
      cycles.push([...cycle.slice(from), ...cycle.slice(0, from)]);
    }
    for (const visited of walk) color.set(visited, 2);
  }
  return cycles;
}

/** `N(s)` of the design note §3.7.1, with one space at each end. */
// Run-time regexes: the bundle must stay one-byte source (see schema.js).
const CASE_BOUNDARY = new RegExp('([\\p{Ll}\\p{Nd}])(\\p{Lu})', 'gu');
const NON_WORD = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

export function normalizeForNames(text) {
  const words = text
    .normalize('NFC')
    .replace(CASE_BOUNDARY, '$1 $2')
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .trim();
  return words === '' ? [] : words.split(' ');
}

/** A matcher of private token and recipe ids (§3.7.1). */
export function privateNameMatcher(vocabulary) {
  const phrases = new Map();
  let width = 0;
  const add = (id, privateKind) => {
    const words = normalizeForNames(id);
    if (words.length === 0) return;
    width = Math.max(width, words.length);
    if (!phrases.has(words.join(' ')))
      phrases.set(words.join(' '), privateKind);
  };
  for (const [tokenId, token] of vocabulary.tokens)
    if (token.visibility === 'private') add(tokenId, 'token');
  for (const [recipeId, recipe] of vocabulary.recipes)
    if (recipe.visibility === 'private') add(recipeId, 'recipe');
  return (text) => {
    if (phrases.size === 0) return null;
    const words = normalizeForNames(text);
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= width && i + n <= words.length; n++) {
        const kind = phrases.get(words.slice(i, i + n).join(' '));
        if (kind !== undefined) return kind;
      }
    }
    return null;
  };
}

/**
 * Runs the private-name match over every string leaf of a consumer-visible
 * entity's own `meta`. An unclassified string position is an internal error
 * (fail closed): the schema and `stringClassOf` must cover every string.
 */
export function checkPrivateNames(own, matcher, report) {
  // `path` classifies; `field` is reported, with the author-chosen keys under
  // `select` and `parameters` (axis, parameter and condition names) replaced
  // by `{ index }` (§3.9).
  const walk = (value, path, field, opaque) => {
    if (typeof value === 'string') {
      const cls = stringClassOf(path);
      if (cls == null)
        throw new Error(
          `internal: unclassified metadata string at ${JSON.stringify(field)}`,
        );
      if (cls === 'vocabulary') return;
      const privateKind = matcher(value);
      if (privateKind != null)
        report('metadata.private-identifier', field, { privateKind });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) =>
        walk(item, [...path, i], [...field, i], opaque),
      );
    } else if (isPlain(value)) {
      Object.keys(value).forEach((key, index) => {
        const inner = opaque || key === 'select' || key === 'parameters';
        walk(
          value[key],
          [...path, key],
          [...field, opaque ? { index } : key],
          inner,
        );
      });
    }
  };
  walk(own, [], [], false);
}
