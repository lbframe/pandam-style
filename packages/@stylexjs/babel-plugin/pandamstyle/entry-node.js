/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - Node entry point.
 *
 * Bundles the fork's compiler engine together with the PandamStyle modules, so
 * the published package genuinely contains the fork code (ARC-01) rather than
 * delegating to two upstream installations.
 */

export {
  buildProject,
  collectCoveredFiles,
  createCompilerSession,
  compileFile,
  assertCoverageConsistency,
} from './build';
export { beginGeneration, withGeneration, digestOfTree } from './generation';
export { buildDesignSystem } from './index';
export { buildRegistry, registryDigest } from './registry';
export { supportedProperties, propertyKind, propertyCategory } from './policy';
export { token, mintTokenRef, tokenPathOf } from './token';
export { compileStyles, compileTokens, renderCss } from './compiler';
export { defineRecipe, isStyleRef } from './recipe';
export { selectRecipeRefs, makeRecipeSpec } from './recipe-select';
export { generateDesignSystemModule } from './codegen';
export { pandamstyleBabelPlugin } from './babel-plugin';
export { Provenance, isAdmitted, provenanceOf } from './provenance';
export { conformanceDefinition } from './conformance';
export { PmsError, Codes, diagnostic, formatDiagnostic } from './diagnostics';
export {
  resolveDesignSystemModule,
  resolveRelativeFile,
  clearModuleCache,
  moduleEdgesOf,
  DESIGN_SYSTEM_MARKER,
} from './module-graph';
export { REQUIRED_HELPERS } from './evaluate-usage';
export { defaultOptions as engineDefaultOptions } from '../src/shared/utils/default-options';
