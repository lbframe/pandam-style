/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The immutable compiler authority for one design-system identity.
 *
 * Registry entries, compiled references, the tooling catalog and the CSS
 * inputs are assembled once here. Consumer artifacts and agent domains are
 * projections of this object; callers must not infer vocabulary from a
 * generated artifact.
 */

import { PATTERN_CATALOG, PATTERN_IDS } from '../patterns/compile';

const ABI_VERSION = 1;
const COMPILER_CONTRACT_VERSION = 'pms-0.1';
const MANIFEST_SCHEMA_VERSION = 1;
const lexicalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const DESIGN_SYSTEM_CAPABILITIES = Object.freeze({
  slots: true,
  compoundVariants: true,
  patterns: true,
  rawDynamicStyles: false,
});

export function deepFreeze(value, seen = new WeakSet()) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    seen.has(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(value[key], seen);
  }
  return Object.freeze(value);
}

function cloneRules(rules) {
  return Object.fromEntries(
    Object.entries(rules).map(([key, rule]) => [key, { ...rule }]),
  );
}

function tokenRowsOf(registry) {
  return Object.keys(registry.tokens).map((tokenId) => {
    const token = registry.tokens[tokenId];
    return {
      tokenId,
      category: token.category,
      path: token.path,
      visibility: token.visibility,
      kind: token.ref == null ? 'primitive' : 'alias',
      ref: token.ref,
      resolvedValue: registry.resolvedValues[tokenId],
    };
  });
}

function publicTokenCatalog(tokenRows) {
  const rows = tokenRows.filter((token) => token.visibility === 'public');
  const tokens = {};
  for (const token of rows) {
    tokens[token.tokenId] = { category: token.category };
  }
  return tokens;
}

function publicSemanticTokenCatalog(tokenRows) {
  const publicIds = new Set(
    tokenRows
      .filter((token) => token.visibility === 'public')
      .map((token) => token.tokenId),
  );
  const semanticTokens = {};
  for (const token of tokenRows) {
    if (token.visibility !== 'public' || token.kind !== 'alias') continue;
    semanticTokens[token.tokenId] = {
      category: token.category,
      kind: token.kind,
      ...(token.ref != null && publicIds.has(token.ref)
        ? { ref: token.ref }
        : {}),
    };
  }
  return semanticTokens;
}

function recipeCatalogOf(recipes, definitions) {
  const out = {};
  for (const recipeId of Object.keys(recipes).sort(lexicalCompare)) {
    if (definitions[recipeId].visibility !== 'public') continue;
    const recipe = recipes[recipeId];
    out[recipeId] = {
      axisOrder: [...recipe.axisOrder],
      axes: Object.fromEntries(
        recipe.axisOrder.map((axis) => [axis, [...recipe.variantMap[axis]]]),
      ),
      defaults: { ...recipe.defaultVariants },
      ...(recipe.slotOrder === undefined
        ? {}
        : { slots: [...recipe.slotOrder] }),
      ...(definitions[recipeId].compounds.length === 0
        ? {}
        : {
            compoundVariants: definitions[recipeId].compounds.map(
              ({ when }) => ({ when }),
            ),
          }),
    };
  }
  return out;
}

/** Build and deeply freeze the complete canonical design-system snapshot. */
export function createCanonicalDesignSystemSnapshot({
  registry,
  varsByToken,
  themeClasses,
  themes,
  recipes,
  cssRules,
  supportedProperties,
}) {
  const tokens = tokenRowsOf(registry);
  const publicTokens = tokens.filter((token) => token.visibility === 'public');
  const tokenCategories = [
    ...new Set(publicTokens.map((token) => token.category)),
  ].sort(lexicalCompare);
  const tokenPathsByCategory = Object.fromEntries(
    tokenCategories.map((category) => [
      category,
      publicTokens
        .filter((token) => token.category === category)
        .map((token) => token.tokenId),
    ]),
  );
  const conditionNames = [
    ...(registry.conditionOrder ?? Object.keys(registry.conditions)),
  ];
  const conditions = conditionNames.map((name) => ({
    name,
    definition: registry.conditions[name].definition,
    kind: registry.conditions[name].kind,
  }));
  const themeIds = [
    'base',
    ...Object.keys(themeClasses)
      .filter((name) => name !== 'base')
      .sort(lexicalCompare),
  ];
  const publicRecipeIds = Object.keys(recipes)
    .filter((recipeId) => registry.recipes[recipeId].visibility === 'public')
    .sort(lexicalCompare);
  const recipesCatalog = recipeCatalogOf(recipes, registry.recipes);
  const publicTokenIds = new Set(publicTokens.map((token) => token.tokenId));
  const themeDetails = Object.fromEntries(
    themeIds
      .filter((name) => name !== 'base')
      .map((name) => {
        const metadata = registry.themeMetadata?.[name] ?? {};
        return [
          name,
          {
            extends: registry.themeParents?.[name] ?? 'base',
            declaredOverrides: (metadata.declaredOverrides ?? []).filter(
              (tokenId) => publicTokenIds.has(tokenId),
            ),
            overrides: (metadata.overrides ?? []).filter((tokenId) =>
              publicTokenIds.has(tokenId),
            ),
            remaps: Object.fromEntries(
              Object.entries(metadata.remaps ?? {}).filter(
                ([tokenId, target]) =>
                  publicTokenIds.has(tokenId) && publicTokenIds.has(target),
              ),
            ),
          },
        ];
      }),
  );
  const semanticTokens = tokens
    .filter((token) => token.kind === 'alias')
    .map(({ tokenId, category, path, visibility, kind, ref }) => ({
      tokenId,
      category,
      path,
      visibility,
      kind,
      ref,
    }));

  const identity = {
    systemId: registry.systemId,
    registryDigest: registry.registryDigest,
    abiVersion: ABI_VERSION,
    compilerContractVersion: COMPILER_CONTRACT_VERSION,
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
  };
  const capabilities = { ...DESIGN_SYSTEM_CAPABILITIES };
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    ...identity,
    capabilities,
    tokens: publicTokenCatalog(tokens),
    semanticTokens: publicSemanticTokenCatalog(tokens),
    tokenCategories,
    conditions,
    themes: themeIds.filter((name) => name !== 'base'),
    themeDetails,
    recipes: recipesCatalog,
    patterns: PATTERN_CATALOG,
    supportedProperties,
  };
  const publicConditions = [...conditionNames];
  const candidateDomains = {
    tokens: {
      all: publicTokens.map((token) => token.tokenId),
      byCategory: tokenPathsByCategory,
    },
    recipes: {
      ids: publicRecipeIds,
      byRecipe: Object.fromEntries(
        publicRecipeIds.map((recipeId) => [
          recipeId,
          {
            axes: [...recipes[recipeId].axisOrder],
            values: Object.fromEntries(
              recipes[recipeId].axisOrder.map((axis) => [
                axis,
                [...recipes[recipeId].variantMap[axis]],
              ]),
            ),
            ...(recipes[recipeId].slotOrder === undefined
              ? {}
              : { slots: [...recipes[recipeId].slotOrder] }),
          },
        ]),
      ),
    },
    themes: themeIds.filter((name) => name !== 'base'),
    conditions: publicConditions,
    patterns: { ids: [...PATTERN_IDS], byPattern: PATTERN_CATALOG },
  };

  return deepFreeze({
    documentKind: 'pandamstyle-canonical-design-system',
    identity,
    capabilities,
    registry,
    vocabulary: {
      tokens,
      publicTokenPaths: publicTokens.map((token) => token.tokenId),
      tokenCategories,
      tokenPathsByCategory,
      semanticTokens,
      conditions,
      conditionNames,
      themes: themeIds,
      themeDetails,
      publicRecipeIds,
      recipes: recipesCatalog,
      patterns: PATTERN_CATALOG,
    },
    compiled: {
      varsByToken: { ...varsByToken },
      themeClasses: { ...themeClasses },
      themes: { ...themes },
      recipes: { ...recipes },
      cssRules: cloneRules(cssRules),
    },
    tooling: {
      manifest,
      candidateDomains,
      repairDomains: {
        tokensByCategory: tokenPathsByCategory,
        recipeAxes: candidateDomains.recipes.byRecipe,
        themes: candidateDomains.themes,
        conditions: candidateDomains.conditions,
        patterns: candidateDomains.patterns,
      },
    },
  });
}

/** Read an agent candidate domain without consulting generated catalog data. */
export function candidateDomainOf(snapshot, query = {}) {
  const domain = snapshot.tooling.candidateDomains.tokens;
  const ids =
    query.category == null
      ? domain.all
      : (domain.byCategory[query.category] ?? []);
  return query.allowPrivate === true
    ? snapshot.vocabulary.tokens
        .filter(
          (token) =>
            query.category == null || token.category === query.category,
        )
        .map((token) => token.tokenId)
    : ids;
}

/** Read the public repair domain corresponding to a structured expectation. */
export function repairDomainOf(snapshot, query = {}) {
  const domains = snapshot.tooling.repairDomains;
  switch (query.kind) {
    case 'token':
      return query.category == null
        ? domains.tokensByCategory
        : (domains.tokensByCategory[query.category] ?? []);
    case 'recipe':
      return query.recipeId == null
        ? domains.recipeAxes
        : (domains.recipeAxes[query.recipeId] ?? null);
    case 'theme':
      return domains.themes;
    case 'condition':
      return domains.conditions;
    case 'pattern':
      return query.patternId == null
        ? domains.patterns
        : (domains.patterns.byPattern[query.patternId] ?? null);
    default:
      return null;
  }
}

/** Runtime-safe names and compiled refs derived from the canonical snapshot. */
export function runtimeProjectionOf(snapshot) {
  const themes = snapshot.vocabulary.themes.map((themeId) =>
    Object.freeze([themeId, snapshot.compiled.themes[themeId]]),
  );
  const recipes = snapshot.vocabulary.publicRecipeIds.map((recipeId) =>
    Object.freeze([recipeId, snapshot.compiled.recipes[recipeId]]),
  );
  return Object.freeze({
    identity: snapshot.identity,
    manifest: snapshot.tooling.manifest,
    themes: Object.freeze(themes),
    recipes: Object.freeze(recipes),
  });
}
