/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - demonstrator assembly (ARC-02/ARC-03).
 * Un seul registre alimente politique, compilation et manifeste ;
 * les styles passent tous par le moteur du fork.
 */

import { props as stylexProps } from '@stylexjs/stylex';

import { buildRegistry } from './registry';
import { compileTokens, compileStyles, renderCss } from './compiler';
import { defineRecipe, isStyleRef } from './recipe';
import { token } from './token';
import { supportedProperties } from './policy';
import { PmsError } from './diagnostics';
// Benchmark-only measurement hooks (Spike 1).
import { count, phase as perfPhase } from './perf';

export function buildDesignSystem(definition, options = {}) {
  count('design_system_builds');
  const registry = perfPhase('ds_build_registry_ms', () =>
    buildRegistry(definition),
  );
  if (registry.diagnostics.some((d) => d.severity === 'error')) {
    throw new PmsError(registry.diagnostics);
  }

  const tokenCompilation = perfPhase('ds_token_compile_ms', () =>
    compileTokens(registry, options),
  );
  const {
    varsByToken,
    themeClasses,
    varGroupHash,
    injected: tokenStyles,
  } = tokenCompilation;

  const injected = { ...tokenStyles };
  const recipeInjected = {};

  const compileStyleObject = (styleObj, nsName) => {
    const { compiled, injected: rules } = compileStyles({
      registry,
      varsByToken,
      namespaces: { [nsName]: styleObj },
      role: 'system',
      allowPrivateTokens: true,
      source: `design-system:${nsName}`,
      options,
    });
    Object.assign(recipeInjected, rules);
    return compiled[nsName];
  };

  const recipes = {};
  perfPhase('ds_recipe_compile_ms', () => {
    for (const recipeId of Object.keys(registry.recipes)) {
      recipes[recipeId] = defineRecipe(
        { recipeId, ...registry.recipes[recipeId] },
        compileStyleObject,
      );
    }
  });
  Object.assign(injected, recipeInjected);

  const create = (namespaces, callOptions = {}) => {
    const result = compileStyles({
      registry,
      varsByToken,
      namespaces,
      role: 'consumer',
      allowPrivateTokens: false,
      source: callOptions.source ?? 'consumer',
      options,
    });
    // Consumer rules join the same generation (ARC-14).
    Object.assign(injected, result.injected);
    return result;
  };

  const themes = {};
  for (const name of Object.keys(themeClasses)) {
    themes[name] = { $$css: true, [varGroupHash]: themeClasses[name] };
  }

  const props = (...args) => {
    const compiled = args.map((a) => {
      if (a == null || a === false) return null;
      if (isStyleRef(a)) return a.refs;
      return a;
    });
    return stylexProps(...compiled);
  };

  const publicTokens = Object.keys(registry.tokens).filter(
    (id) => registry.tokens[id].visibility === 'public',
  );

  const manifest = perfPhase('ds_manifest_ms', () => ({
    schemaVersion: 1,
    systemId: registry.systemId,
    registryDigest: registry.registryDigest,
    compilerContractVersion: 'pms-0.1',
    capabilities: {
      slots: false,
      compoundVariants: false,
      patterns: false,
      rawDynamicStyles: false,
    },
    tokens: Object.fromEntries(
      publicTokens.map((id) => [
        id,
        { category: registry.tokens[id].category },
      ]),
    ),
    conditions: Object.keys(registry.conditions),
    themes: Object.keys(themeClasses).filter((t) => t !== 'base'),
    recipes: Object.fromEntries(
      Object.keys(recipes).map((id) => [
        id,
        {
          axes: recipes[id].variantMap,
          axisOrder: recipes[id].axisOrder,
          defaults: registry.recipes[id].defaultVariants,
        },
      ]),
    ),
    supportedProperties: supportedProperties(),
  }));

  return {
    registry,
    varsByToken,
    themes,
    themeClasses,
    recipes,
    create,
    token,
    props,
    manifest,
    renderCss: () => renderCss(injected),
    injected,
  };
}
