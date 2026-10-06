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

import { props as coreProps } from '@pandamstyle/core';

import { buildRegistry } from './index';
import { createCanonicalDesignSystemSnapshot } from './snapshot';
import {
  compileTokens,
  compileStyles,
  renderCss,
} from '../../engine/lowering/styles';
import { defineRecipe } from '../recipes/compile';
import { toRuntimeRefs, toThemeRefs } from '../../artifacts/javascript/refs';
import { token } from '../tokens/ref';
import { supportedProperties } from '../policy/properties';
import { PmsError } from '../../protocol/diagnostics';
// Benchmark-only measurement hooks (Spike 1).
import { count, phase as perfPhase } from '../../observability/metrics';

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
    for (const recipeId of registry.vocabularyDomains.allRecipeIds) {
      recipes[recipeId] = defineRecipe(
        {
          recipeId,
          systemId: registry.systemId,
          ...registry.recipes[recipeId],
        },
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
  const coreThemes = toThemeRefs(themes, registry.systemId);

  const props = (...args) =>
    coreProps(
      ...args.map((arg) => {
        const themeId = Object.keys(themes).find((id) => themes[id] === arg);
        return themeId === undefined
          ? toRuntimeRefs(arg, registry.systemId)
          : coreThemes[themeId];
      }),
    );

  const snapshot = perfPhase('ds_snapshot_build_ms', () =>
    createCanonicalDesignSystemSnapshot({
      registry,
      varsByToken,
      themeClasses,
      themes,
      recipes,
      cssRules: injected,
      supportedProperties: supportedProperties(),
    }),
  );
  const manifest = perfPhase('ds_manifest_ms', () => snapshot.tooling.manifest);

  return {
    snapshot,
    registry: snapshot.registry,
    varsByToken: snapshot.compiled.varsByToken,
    themes: snapshot.compiled.themes,
    themeClasses: snapshot.compiled.themeClasses,
    recipes: snapshot.compiled.recipes,
    create,
    token,
    props,
    manifest,
    renderCss: () => renderCss(injected),
    injected,
  };
}
