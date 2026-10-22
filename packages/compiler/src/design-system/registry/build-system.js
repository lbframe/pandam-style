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
import { createCanonicalDesignSystemSnapshot, deepFreeze } from './snapshot';
import {
  compileTokens,
  compileStyles,
  renderCss,
} from '../../engine/lowering/styles';
import { defineRecipe } from '../recipes/compile';
import { toRuntimeRefs, toThemeRefs } from '../../artifacts/javascript/refs';
import { token } from '../tokens/ref';
import { effectivePropertiesOf } from '../policy/domains';
import { designSystemTargetFacts, unitSummary } from '../../targets/evaluate';
import { tokenGrammars } from '../../targets/catalog';
import { PmsError } from '../../protocol/diagnostics';
// Benchmark-only measurement hooks (Spike 1).
import { count, phase as perfPhase } from '../../observability/metrics';

/**
 * `context.targets` is the project's target resolution record (CE-01.1). When
 * present, the snapshot records it and the target facts of the design
 * system's own emitted rules. `context.authorTexts` is a holder a session
 * keeps across rebuilds; see buildRegistry.
 */
export function buildDesignSystem(definition, options = {}, context = {}) {
  count('design_system_builds');
  const registry = perfPhase('ds_build_registry_ms', () =>
    buildRegistry(definition, { authorTexts: context.authorTexts ?? null }),
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

  const targets = context.targets ?? null;
  const targetFacts =
    targets == null
      ? null
      : perfPhase('ds_target_facts_ms', () =>
          designSystemTargetFacts({
            resolution: targets,
            summary: unitSummary(injected, () =>
              designSystemTargetSources(injected, varsByToken),
            ),
            enhancements: registry.enhancements,
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
      properties: effectivePropertiesOf(registry),
      targets,
      targetFacts: targetFacts == null ? null : designSystemFacts(targetFacts),
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

/**
 * The design system's own rules as target-evaluation sources. Each carries
 * the value grammar of the token custom properties it may declare (from the
 * token's category), so a token keyword is read where it is consumed.
 */
export function designSystemTargetSources(injected, varsByToken = null) {
  const grammars = tokenGrammars(varsByToken);
  const sources = [];
  for (const key of Object.keys(injected)) {
    const { ltr, rtl } = injected[key];
    const owner = {
      role: 'design-system',
      file: null,
      line: null,
      column: null,
      label: 'design-system',
    };
    if (typeof ltr === 'string') sources.push({ owner, css: ltr, grammars });
    if (typeof rtl === 'string') sources.push({ owner, css: rtl, grammars });
  }
  return sources;
}

/**
 * Registry conditions as `{ name, definition }` (the registry stores
 * `{ name, definition, kind }`), for diagnostics context.
 */
export function conditionDefinitions(registry) {
  return (registry.conditionOrder ?? []).map((name) => ({
    name,
    definition: registry.conditions[name]?.definition ?? null,
  }));
}

const designSystemFactsCache = new WeakMap();

/**
 * The design-system scope of evaluated facts, deep-frozen once per facts
 * object: unchanged facts (a token value edit) keep the same frozen record,
 * which the snapshot does not walk again.
 */
function designSystemFacts(facts) {
  let scoped = designSystemFactsCache.get(facts);
  if (scoped == null) {
    scoped = deepFreeze({ ...facts, scope: 'design-system' });
    designSystemFactsCache.set(facts, scoped);
  }
  return scoped;
}
