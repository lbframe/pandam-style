/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-01.1 browser targets and capability outcomes. See
 * docs/architecture/ce-01.1-browser-targets.md.
 */

export { compatData, compatDataFromText } from './data';
export { compareVersions, isReleaseString, parseVersion } from './versions';
export { extractConstructs } from './extract';
export {
  CATALOG_KIND,
  CATALOG_SCHEMA_VERSION,
  COMBINATIONS,
  PLATFORM_FEATURES,
  caveatCatalog,
  caveatDisposition,
  featureByKey,
  featuresOf,
  inapplicability,
  inapplicableCatalog,
} from './catalog';
export {
  BASES,
  REASONS,
  STATES,
  featureOutcome,
  statementOutcome,
  summarize,
  worseState,
} from './outcome';
export {
  ANNOUNCEABLE,
  BROWSERSLIST_OPTIONS,
  BUILTIN_PROFILES,
  BUILTIN_RESOLUTIONS,
  BUILTIN_PROFILE_REFS,
  DATA_PINS,
  DEFAULT_PROFILE_REF,
  RESOLUTION_KIND,
  RESOLUTION_SCHEMA_VERSION,
  dataPackages,
  liveBrowsers,
  precomputedBrowsers,
  refusedTerms,
  resolveTargets,
  stableJson,
} from './resolve';
export {
  FACTS_KIND,
  FACTS_SCHEMA_VERSION,
  evaluateRequirements,
  createTargetAccumulator,
  evaluateTargets,
  stableJsonCached,
  summarizeSources,
  unitSummary,
  featuresOfCss,
  intrinsicCss,
  profileOutcomes,
} from './evaluate';
export { FALLBACK_KINDS, normalizeEnhancements } from './policy';
export {
  enforcementOf,
  evaluateProjectTargets,
  pageTargetSources,
  targetReportSection,
} from './project';
export {
  DEVICES,
  EVIDENCE_CLASSES,
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  evidenceBasis,
  evidenceProblems,
  evidenceSupports,
} from './evidence';
