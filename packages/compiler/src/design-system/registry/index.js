/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - canonical registry (ARC-07/ARC-08, D-03/D-04).
 * Token semantics carried over from @pandacss/token-dictionary
 * (chakra-ui/panda @ 1a310482, packages/token-dictionary): identity by path
 * `category.segment`, references between tokens, per-theme views.
 * Panda emission replaced: the registry produces inputs for the fork
 * du fork (defineVars/createTheme), pas de CSS propre.
 */

import { createHash } from 'crypto';
import { diagnostic, PmsError, Codes } from '../../protocol/diagnostics';

const lexicalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalize(value) {
  if (Array.isArray(value)) {
    // Semantic order preserved (axisOrder, cycle paths...)
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalize(value[k]);
    }
    return out;
  }
  return value;
}

export function registryDigest(registryPayload) {
  const json = JSON.stringify(canonicalize(registryPayload));
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

function flattenTokens(category, node, prefix, out, diagnostics, source) {
  for (const key of Object.keys(node)) {
    if (key === '') {
      diagnostics.push(
        diagnostic({
          code: Codes.UNKNOWN_TOKEN,
          phase: 'registry',
          message: `Segment de chemin de token vide dans ${category}.`,
          source,
        }),
      );
      continue;
    }
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const entry = node[key];
    if (
      entry !== null &&
      typeof entry === 'object' &&
      (typeof entry.value === 'string' ||
        typeof entry.value === 'number' ||
        typeof entry.ref === 'string')
    ) {
      const tokenId = `${category}.${path}`;
      if (out[tokenId] != null) {
        diagnostics.push(
          diagnostic({
            code: Codes.DUPLICATE_TOKEN,
            phase: 'registry',
            message: `Duplicate token identifier: ${tokenId}.`,
            source,
            context: { tokenId },
          }),
        );
        continue;
      }
      out[tokenId] = {
        tokenId,
        category,
        path,
        visibility: entry.visibility === 'private' ? 'private' : 'public',
        value: entry.value != null ? String(entry.value) : null,
        ref: typeof entry.ref === 'string' ? entry.ref : null,
      };
    } else if (entry !== null && typeof entry === 'object') {
      flattenTokens(category, entry, path, out, diagnostics, source);
    } else {
      diagnostics.push(
        diagnostic({
          code: Codes.FORBIDDEN_VALUE,
          phase: 'registry',
          message: `Invalid token definition at ${category}.${path}.`,
          source,
          context: { tokenId: `${category}.${path}` },
        }),
      );
    }
  }
}

export function buildRegistry(definition) {
  const diagnostics = [];
  const {
    systemId,
    tokens = {},
    themes = {},
    conditions = {},
    recipes = {},
  } = definition;
  const tokensOut = {};

  for (const category of Object.keys(tokens)) {
    flattenTokens(
      category,
      tokens[category],
      '',
      tokensOut,
      diagnostics,
      definition.__source ?? 'design-system',
    );
  }

  // Reference and cycle resolution (ARC-08). No silent fallback.
  const resolved = {};
  const visiting = [];
  const resolveToken = (tokenId) => {
    if (resolved[tokenId]) return resolved[tokenId];
    const t = tokensOut[tokenId];
    if (t == null) {
      throw new PmsError([
        diagnostic({
          code: Codes.UNKNOWN_TOKEN,
          phase: 'registry',
          message: `Unknown token reference: ${tokenId}.`,
          context: { tokenId, visiting: [...visiting] },
        }),
      ]);
    }
    if (visiting.includes(tokenId)) {
      throw new PmsError([
        diagnostic({
          code: Codes.TOKEN_CYCLE,
          phase: 'registry',
          message: `Token reference cycle: ${[
            ...visiting.slice(visiting.indexOf(tokenId)),
            tokenId,
          ].join(' -> ')}.`,
          context: { cycle: [...visiting, tokenId] },
        }),
      ]);
    }
    visiting.push(tokenId);
    let value = t.value;
    if (t.ref != null) {
      const target = tokensOut[t.ref];
      if (target == null) {
        throw new PmsError([
          diagnostic({
            code: Codes.UNKNOWN_TOKEN,
            phase: 'registry',
            message: `Token ${tokenId} references ${t.ref}, which is absent from the registry.`,
            context: { tokenId, missingRef: t.ref },
          }),
        ]);
      }
      if (target.category !== t.category) {
        throw new PmsError([
          diagnostic({
            code: Codes.INVALID_TOKEN_CATEGORY,
            phase: 'registry',
            message: `Token ${tokenId} (${t.category}) references ${t.ref} (${target.category}).`,
            context: {
              tokenId,
              ref: t.ref,
              expected: t.category,
              actual: target.category,
            },
          }),
        ]);
      }
      value = resolveToken(t.ref);
    }
    visiting.pop();
    resolved[tokenId] = value;
    return value;
  };
  for (const tokenId of Object.keys(tokensOut)) {
    resolveToken(tokenId);
  }

  // Themes: complete base + partial overrides (D-04). An unknown reference
  // dans une surcharge = erreur, jamais de fallback.
  const themeDefs = {};
  for (const themeName of Object.keys(themes)) {
    themeDefs[themeName] = {};
    const overrides = themes[themeName]?.tokens ?? {};
    const flat = {};
    for (const category of Object.keys(overrides)) {
      flattenTokens(
        category,
        overrides[category],
        '',
        flat,
        diagnostics,
        `theme:${themeName}`,
      );
    }
    for (const tokenId of Object.keys(flat)) {
      const base = tokensOut[tokenId];
      if (base == null) {
        throw new PmsError([
          diagnostic({
            code: Codes.UNKNOWN_TOKEN,
            phase: 'registry',
            message: `The ${themeName}/${tokenId} override matches no token.`,
            context: { themeName, tokenId },
          }),
        ]);
      }
      const o = flat[tokenId];
      if (o.ref != null) {
        if (tokensOut[o.ref] == null) {
          throw new PmsError([
            diagnostic({
              code: Codes.UNKNOWN_TOKEN,
              phase: 'registry',
              message: `The ${themeName}/${tokenId} override references ${o.ref}, which is absent.`,
              context: { themeName, tokenId, missingRef: o.ref },
            }),
          ]);
        }
        // The override reuses an already-resolved identity: the value below is
        // the referenced token's own value, not a re-resolution of this one.
        themeDefs[themeName][tokenId] = resolveToken(o.ref);
      } else if (o.value != null) {
        themeDefs[themeName][tokenId] = o.value;
      }
    }
  }

  // Conditions: name -> canonical definition, P0 subset (D-14).
  const conds = {};
  const conditionOrder = [];
  for (const name of Object.keys(conditions)) {
    const c = conditions[name];
    const def = typeof c === 'string' ? c : (c?.selector ?? c?.atRule);
    if (typeof def !== 'string' || def === '') {
      diagnostics.push(
        diagnostic({
          code: Codes.UNKNOWN_CONDITION,
          phase: 'registry',
          message: `Condition ${name} has no definition.`,
          context: { condition: name },
        }),
      );
      continue;
    }
    const kind =
      typeof c === 'object' &&
      c != null &&
      c.selector == null &&
      c.atRule != null
        ? 'at-rule'
        : def.trimStart().startsWith('@')
          ? 'at-rule'
          : 'selector';
    conds[name] = { name, definition: def, kind };
    conditionOrder.push(name);
  }

  // Recipes: base + axes + defaults; axisOrder = declaration order (ARC-10).
  const recs = {};
  for (const recipeId of Object.keys(recipes)) {
    const r = recipes[recipeId];
    const unsupported = ['slots', 'compoundVariants', 'jsx'].filter(
      (k) => r[k] != null && (Array.isArray(r[k]) ? r[k].length : true),
    );
    if (unsupported.length > 0) {
      throw new PmsError([
        diagnostic({
          code: Codes.UNSUPPORTED_FEATURE,
          phase: 'registry',
          message: `Recipe ${recipeId}: capability not delivered in P0 (${unsupported.join(', ')}).`,
          context: { recipeId, unsupported },
        }),
      ]);
    }
    const axisOrder = Object.keys(r.variants ?? {});
    recs[recipeId] = {
      recipeId,
      base: r.base ?? {},
      variants: r.variants ?? {},
      defaultVariants: r.defaultVariants ?? {},
      axisOrder,
      visibility: r.visibility === 'private' ? 'private' : 'public',
    };
  }

  const payload = {
    systemId,
    tokens: tokensOut,
    resolved,
    themeDefs,
    conds,
    // Condition order is retained because it can affect stable projection and
    // cascade tie-breaking even though the condition map is canonicalized by
    // key for the digest.
    conditionOrder,
    recs,
  };
  const allTokenIds = Object.keys(tokensOut);
  const publicTokenIds = allTokenIds.filter(
    (tokenId) => tokensOut[tokenId].visibility === 'public',
  );
  const allTokenIdsByCategory = {};
  const publicTokenIdsByCategory = {};
  for (const tokenId of allTokenIds) {
    const { category, visibility } = tokensOut[tokenId];
    (allTokenIdsByCategory[category] ??= []).push(tokenId);
    if (visibility === 'public') {
      (publicTokenIdsByCategory[category] ??= []).push(tokenId);
    }
  }
  const vocabularyDomains = {
    allTokenIds,
    publicTokenIds,
    allTokenIdsByCategory,
    publicTokenIdsByCategory,
    conditionNames: [...conditionOrder],
    themeNames: Object.keys(themeDefs).sort(lexicalCompare),
    allRecipeIds: Object.keys(recs).sort(lexicalCompare),
    publicRecipeIds: Object.keys(recs)
      .filter((recipeId) => recs[recipeId].visibility === 'public')
      .sort(lexicalCompare),
  };
  return {
    systemId,
    tokens: tokensOut,
    resolvedValues: resolved,
    themes: themeDefs,
    conditions: conds,
    conditionOrder,
    recipes: recs,
    vocabularyDomains,
    diagnostics,
    registryDigest: registryDigest(payload),
  };
}
