/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Private oracle/test access. This module is bundled to a CJS file by the
// compiler build, outside the published package and its export map.
export {
  assertCoverageConsistency,
  buildProject,
  collectCoveredFiles,
  createCompilerSession,
  coverageGapDiagnostics,
  relativeToCwd,
  walkFiles,
} from '../../packages/compiler/src/project/session/fresh.js';
export { compileFile } from '../../packages/compiler/src/frontend/babel/compile-file.js';
export {
  createPatternIR,
  patternStyles,
  PATTERN_IDS,
  PATTERN_CATALOG,
} from '../../packages/compiler/src/design-system/patterns/compile.js';
export {
  beginGeneration,
  digestOfTree,
  withGeneration,
} from '../../packages/compiler/src/artifacts/publication/transaction.js';
export { generateDesignSystemModule } from '../../packages/compiler/src/artifacts/javascript/design-module.js';
export { generateDesignSystemDeclarations } from '../../packages/compiler/src/artifacts/types/design-declarations.js';
export {
  createArtifactSet,
  designDeclarationFile,
  validateArtifactSet,
  withDesignSystemCssIdentity,
} from '../../packages/compiler/src/artifacts/metadata/artifact-set.js';
export { buildDesignSystem } from '../../packages/compiler/src/design-system/registry/build-system.js';
export {
  candidateDomainOf,
  createCanonicalDesignSystemSnapshot,
  repairDomainOf,
  runtimeProjectionOf,
} from '../../packages/compiler/src/design-system/registry/snapshot.js';
export {
  buildRegistry,
  registryDigest,
} from '../../packages/compiler/src/design-system/registry/index.js';
export {
  propertyCategory,
  propertyKind,
  supportedProperties,
} from '../../packages/compiler/src/design-system/policy/properties.js';
export {
  defineRecipe,
  isStyleRef,
} from '../../packages/compiler/src/design-system/recipes/compile.js';
export {
  compileStyles,
  compileTokens,
  renderCss,
} from '../../packages/compiler/src/engine/lowering/styles.js';
export { pandamstyleBabelPlugin } from '../../packages/compiler/src/frontend/babel/plugin.js';
export {
  createUsageContext,
  readModuleFacts,
  resolvePmsAccess,
  REQUIRED_HELPERS,
} from '../../packages/compiler/src/frontend/babel/evaluate.js';
export {
  createFilesystemWatcher,
  createChangeJournal,
  generationScratchPaths,
} from '../../packages/compiler/src/hosts/watcher/index.js';
export {
  Codes,
  PmsError,
  diagnostic,
  formatDiagnostic,
} from '../../packages/compiler/src/protocol/diagnostics.js';
export {
  buildAgentResult,
  buildCoverageReport,
  coverageSummary,
  machineDiagnostic,
  AGENT_RESULT_KIND,
  AGENT_RESULT_SCHEMA_VERSION,
  BUILD_REPORT_KIND,
  BUILD_REPORT_SCHEMA_VERSION,
  COVERAGE_REPORT_FILE,
  COVERAGE_REPORT_KIND,
  COVERAGE_REPORT_SCHEMA_VERSION,
  DEFAULT_AFFECTED_ENTRY_LIMIT,
  DEFAULT_CANDIDATE_LIMIT,
} from '../../packages/compiler/src/protocol/diagnostics-result.js';
export {
  clearModuleCache,
  clearModuleOverlay,
  moduleEdgesOf,
  moduleGraphCacheStats,
  moduleSummaryOfCode,
  moduleSummaryOfFile,
  resolveDesignSystemModule,
  resolveRelativeFile,
  DESIGN_SYSTEM_MARKER,
} from '../../packages/compiler/src/project/graph/resolution.js';
export {
  createCoverageGraph,
  coverageGraphStats,
  refreshCoverageClosure,
  verifyCoverageGraph,
} from '../../packages/compiler/src/project/graph/coverage.js';
export { createCssState } from '../../packages/compiler/src/project/css-state/index.js';
export {
  DIRTY_INPUT_MODES,
  explicitAgentProvider,
  fullScanProvider,
  normalizeMutationTransaction,
  resolveProvider,
} from '../../packages/compiler/src/project/mutations/transaction.js';
export { createProjectSession } from '../../packages/compiler/src/project/session/index.js';
export { createProjectSession as createPublicProjectSession } from '../../packages/compiler/src/api/project.js';
export { projectServiceResourceStats } from '../../packages/compiler/src/api/project.js';
export { createHostBridge } from '../../packages/compiler/src/api/host.js';
export {
  Provenance,
  isAdmitted,
  provenanceOf,
} from '../../packages/compiler/src/semantics/provenance/index.js';
export {
  token,
  mintTokenRef,
  tokenPathOf,
} from '../../packages/compiler/src/design-system/tokens/ref.js';
export {
  count,
  installPerfCollector,
  perfCollector,
  perfMetricNames,
  perfNow,
  perfSnapshot,
  phase,
  setPerfEngineName,
  workEliminated,
} from '../../packages/compiler/src/observability/metrics.js';
export { defaultOptions as engineDefaultOptions } from '../../packages/compiler/src/engine/ordering/defaults.js';
export {
  addAncestorSelector,
  addSpecificityLevel,
  createRuleComparator,
  layerHeader,
  logicalFloatVars,
  lowerAtomicStyles,
  lowerTokenVariables,
  normalizeEngineOptions,
  processStylexRules,
  projectTheme,
  splitConstantRules,
  transformRuleEntry,
} from '../../packages/compiler/src/engine/index.js';
export { evaluateStaticExpression } from '../../packages/compiler/src/frontend/babel/static-evaluator.js';
export { createPassState } from '../../packages/compiler/src/frontend/babel/pass-state.js';
export { conformanceDefinition } from '../fixtures/design-systems/conformance.js';
