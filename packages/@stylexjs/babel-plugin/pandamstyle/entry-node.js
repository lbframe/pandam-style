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
export { createProjectSession } from './session';
// The incremental CSS state, exported so its ownership and ordering semantics
// can be tested directly rather than only through a whole project build.
export { createCssState } from './css-state';
export {
  createChangeJournal,
  createFilesystemWatcher,
  generationScratchPaths,
} from './watcher';
export {
  DIRTY_INPUT_MODES,
  normalizeMutationTransaction,
  explicitAgentProvider,
  fullScanProvider,
  resolveProvider,
} from './dirty-input';
export { buildDesignSystem } from './index';
// The agent-facing result contract and the audit document schemas (Spike 4,
// Phase C). Exported so a host can name the schema versions it is written
// against, and so a test can assert the shapes directly rather than through a
// session that happens to produce them.
export {
  AGENT_RESULT_KIND,
  AGENT_RESULT_SCHEMA_VERSION,
  BUILD_REPORT_KIND,
  BUILD_REPORT_SCHEMA_VERSION,
  COVERAGE_REPORT_KIND,
  COVERAGE_REPORT_SCHEMA_VERSION,
  COVERAGE_REPORT_FILE,
  DEFAULT_AFFECTED_ENTRY_LIMIT,
  DEFAULT_CANDIDATE_LIMIT,
  buildAgentResult,
  buildCoverageReport,
  coverageSummary,
  machineDiagnostic,
} from './agent-result';
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
  moduleGraphCacheStats,
  resolveDesignSystemModule,
  resolveRelativeFile,
  clearModuleCache,
  moduleEdgesOf,
  moduleSummaryOfCode,
  DESIGN_SYSTEM_MARKER,
} from './module-graph';
export { REQUIRED_HELPERS } from './evaluate-usage';
export { defaultOptions as engineDefaultOptions } from '../src/shared/utils/default-options';
// Benchmark-only measurement surface (Spike 1). Exported so a benchmark driver
// can install a collector; a consumer that ignores it runs the exact same
// compilation, because every hook is a null check when no collector is set.
export {
  installPerfCollector,
  perfCollector,
  perfSnapshot,
  perfNow,
  workEliminated,
  setPerfEngineName,
  perfMetricNames,
} from './perf';
