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
import { validateRecipeDefinition } from '../recipes/validate';

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

  // Themes form a validated inheritance graph. Each compiled theme is a
  // sparse, complete override against the base token set so it can be applied
  // as one scoped class to any element, including a nested subtree.
  const themeNames = Object.keys(themes).sort(lexicalCompare);
  const themeParents = {};
  const themeOverrides = {};
  const themeSource = (themeName) =>
    definition.__source == null
      ? `themes.${themeName}`
      : `${definition.__source}#themes.${themeName}`;
  const failTheme = (code, themeName, message, context = {}) => {
    throw new PmsError([
      diagnostic({
        code,
        phase: 'registry',
        message,
        source: themeSource(themeName),
        rule: 'theme.validation',
        context: { themeName, ...context },
      }),
    ]);
  };

  for (const themeName of themeNames) {
    const themeDefinition = themes[themeName];
    if (
      themeName === 'base' ||
      themeDefinition == null ||
      typeof themeDefinition !== 'object' ||
      Array.isArray(themeDefinition)
    ) {
      failTheme(
        Codes.INVALID_THEME,
        themeName,
        `Theme ${themeName} must be an object and "base" is reserved.`,
        { reservedName: themeName === 'base' },
      );
    }
    const parent =
      themeDefinition.extends === undefined ? 'base' : themeDefinition.extends;
    if (typeof parent !== 'string' || parent.length === 0) {
      failTheme(
        Codes.INVALID_THEME,
        themeName,
        `Theme ${themeName} must extend "base" or another named theme.`,
        { parent },
      );
    }
    themeParents[themeName] = parent;
    const overrides =
      themeDefinition.tokens === undefined ? {} : themeDefinition.tokens;
    if (
      overrides == null ||
      typeof overrides !== 'object' ||
      Array.isArray(overrides)
    ) {
      failTheme(
        Codes.INVALID_THEME,
        themeName,
        `Theme ${themeName}.tokens must be an object of token overrides.`,
        { field: 'tokens' },
      );
    }
    const flat = {};
    for (const category of Object.keys(overrides)) {
      flattenTokens(
        category,
        overrides[category],
        '',
        flat,
        diagnostics,
        themeSource(themeName),
      );
    }
    themeOverrides[themeName] = flat;
    for (const tokenId of Object.keys(flat)) {
      const base = tokensOut[tokenId];
      if (base == null) {
        failTheme(
          Codes.UNKNOWN_TOKEN,
          themeName,
          `The ${themeName}/${tokenId} override matches no token.`,
          { tokenId },
        );
      }
      const override = flat[tokenId];
      if (override.ref != null) {
        const target = tokensOut[override.ref];
        if (target == null) {
          failTheme(
            Codes.UNKNOWN_TOKEN,
            themeName,
            `The ${themeName}/${tokenId} override references ${override.ref}, which is absent.`,
            { tokenId, missingRef: override.ref },
          );
        }
        if (target.category !== base.category) {
          failTheme(
            Codes.INVALID_TOKEN_CATEGORY,
            themeName,
            `The ${themeName}/${tokenId} override references ${override.ref} from a different token category.`,
            {
              tokenId,
              ref: override.ref,
              expected: base.category,
              actual: target.category,
            },
          );
        }
      }
    }
  }

  const themeVisit = new Map();
  const themeOrder = [];
  const visitTheme = (themeName, stack = []) => {
    const state = themeVisit.get(themeName);
    if (state === 'visited') return;
    if (state === 'visiting') {
      const cycleStart = stack.indexOf(themeName);
      const cycle = [...stack.slice(cycleStart), themeName];
      failTheme(
        Codes.THEME_CYCLE,
        themeName,
        `Theme inheritance cycle: ${cycle.join(' -> ')}.`,
        { cycle },
      );
    }
    themeVisit.set(themeName, 'visiting');
    const parent = themeParents[themeName];
    if (parent !== 'base') {
      if (!Object.hasOwn(themes, parent)) {
        failTheme(
          Codes.UNKNOWN_THEME,
          themeName,
          `Theme ${themeName} extends unknown theme ${parent}.`,
          { parent, admitted: ['base', ...themeNames] },
        );
      }
      visitTheme(parent, [...stack, themeName]);
    }
    themeVisit.set(themeName, 'visited');
    themeOrder.push(themeName);
  };
  for (const themeName of themeNames) visitTheme(themeName);

  const resolveThemeOverride = (
    contextTheme,
    sourceTheme,
    tokenId,
    visiting,
  ) => {
    const override = themeOverrides[sourceTheme][tokenId];
    if (override != null) {
      if (override.ref != null) {
        return resolveThemeToken(contextTheme, override.ref, visiting);
      }
      if (override.value != null) return override.value;
    }
    const parent = themeParents[sourceTheme];
    if (parent !== 'base') {
      return resolveThemeOverride(contextTheme, parent, tokenId, visiting);
    }
    return resolved[tokenId];
  };
  const resolveThemeToken = (themeName, tokenId, visiting = []) => {
    const marker = `${themeName}/${tokenId}`;
    if (visiting.includes(marker)) {
      const cycle = [...visiting.slice(visiting.indexOf(marker)), marker];
      failTheme(
        Codes.THEME_TOKEN_CYCLE,
        themeName,
        `Theme token reference cycle: ${cycle.join(' -> ')}.`,
        { tokenId, cycle },
      );
    }
    return resolveThemeOverride(themeName, themeName, tokenId, [
      ...visiting,
      marker,
    ]);
  };

  const themeDefs = {};
  const themeMetadata = {};
  for (const themeName of themeOrder) {
    const inheritedTokens = new Set();
    let ancestor = themeName;
    while (ancestor !== 'base') {
      for (const tokenId of Object.keys(themeOverrides[ancestor])) {
        inheritedTokens.add(tokenId);
      }
      ancestor = themeParents[ancestor];
    }
    const effective = {};
    for (const tokenId of [...inheritedTokens].sort(lexicalCompare)) {
      const value = resolveThemeToken(themeName, tokenId);
      if (value !== resolved[tokenId]) effective[tokenId] = value;
    }
    const remaps = {};
    for (const tokenId of [...inheritedTokens].sort(lexicalCompare)) {
      let sourceTheme = themeName;
      while (sourceTheme !== 'base') {
        const override = themeOverrides[sourceTheme][tokenId];
        if (override != null) {
          if (override.ref != null) remaps[tokenId] = override.ref;
          break;
        }
        sourceTheme = themeParents[sourceTheme];
      }
    }
    themeDefs[themeName] = effective;
    themeMetadata[themeName] = {
      extends: themeParents[themeName],
      declaredOverrides: Object.keys(themeOverrides[themeName]).sort(
        lexicalCompare,
      ),
      overrides: Object.keys(effective),
      remaps,
    };
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
    recs[recipeId] = validateRecipeDefinition(recipeId, recipes[recipeId]);
  }

  const payload = {
    systemId,
    tokens: tokensOut,
    resolved,
    themeDefs,
    themeParents,
    themeOverrides,
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
    themeParents,
    themeOverrides,
    themeMetadata,
    conditions: conds,
    conditionOrder,
    recipes: recs,
    vocabularyDomains,
    diagnostics,
    registryDigest: registryDigest(payload),
  };
}
