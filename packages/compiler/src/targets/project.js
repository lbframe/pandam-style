/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Project-level target evaluation, shared by the Project Service session and
 * the fresh full build so both produce the same facts for the same revision.
 *
 * Enforcement follows the configuration's provenance:
 *
 *   targets declared   `enforced`: a required incompatible/unknown capability
 *                      is an error and fails the revision.
 *   targets absent     `advisory`: the default profile is still resolved and
 *                      every outcome recorded (a failing profile is recorded as
 *                      failing), but the same findings are warnings.
 */

import {
  conditionDefinitions,
  designSystemTargetSources,
  structuralDomainOfCss,
} from '../design-system/registry/build-system';
import crypto from 'crypto';

import {
  cachedUnit,
  evaluateTargets,
  featuresJson,
  stableJsonSpliced,
  summarizePage,
  unitSummary,
} from './evaluate';

export function enforcementOf(resolution) {
  return resolution.provenance.origin === 'default' ? 'advisory' : 'enforced';
}

function ruleSources(rules, owner) {
  const sources = [];
  for (const [, rule] of rules) {
    if (typeof rule?.ltr === 'string') sources.push({ owner, css: rule.ltr });
    if (typeof rule?.rtl === 'string') sources.push({ owner, css: rule.rtl });
  }
  return sources;
}

/** Page contributions as target sources, located at their `create()` call. */
export function pageTargetSources(file, rules, ruleOrigins = []) {
  const origins = new Map(
    ruleOrigins.map((origin) => [origin.className, origin]),
  );
  const sources = [];
  for (const [className, rule] of rules) {
    const origin = origins.get(className);
    const owner = {
      role: 'page',
      file,
      line: origin?.line ?? null,
      column: origin == null ? null : origin.column + 1,
    };
    sources.push(...ruleSources([[className, rule]], owner));
  }
  return sources;
}

/**
 * Evaluates a revision. `designSystemRules` are the design system's own rule
 * entries for the revision; `pages` are `{ file, rules, ruleOrigins }`.
 * Returns `{ facts, errors, warnings }` with enforcement already applied.
 *
 * Each page's summary is cached on its rule list and the design system's on
 * its `injected` rules, so an `accumulator` (the session's) re-reads only what
 * changed; without one the evaluation is a one-shot pure function.
 */
export function evaluateProjectTargets({
  resolution,
  resolutionDiagnostics = [],
  designSystem,
  designSystemRules,
  pages,
  useCSSLayers = false,
  engineOptions = {},
  accumulator = null,
}) {
  const enforcement = enforcementOf(resolution);
  const injected =
    designSystem.injected ??
    Object.fromEntries(designSystemRules.map(([key, rule]) => [key, rule]));
  const designSystemSummary = unitSummary(injected, () =>
    designSystemTargetSources(injected),
  );
  const units = [
    [
      'design-system',
      accumulator == null
        ? designSystemSummary
        : accumulator.reuseStructure('design-system', designSystemSummary),
    ],
  ];
  for (const { file, rules, ruleOrigins } of pages) {
    units.push([
      file,
      cachedUnit(
        rules,
        () => pageSummary(file, rules, ruleOrigins, accumulator),
        [file, ruleOrigins],
      ),
    ]);
  }
  const result = evaluateTargets({
    resolution,
    units,
    enhancements: designSystem.registry.enhancements ?? [],
    conditions: conditionDefinitions(designSystem.registry),
    intrinsic: { useCSSLayers, engineOptions },
    domainOf: structuralDomainOfCss,
    accumulator,
  });
  // The projected facts depend only on the evaluated facts and enforcement,
  // so unchanged facts keep their object and digest.
  let byEnforcement = projectedFacts.get(result.facts);
  if (byEnforcement == null) {
    byEnforcement = new Map();
    projectedFacts.set(result.facts, byEnforcement);
  }
  let facts = byEnforcement.get(enforcement);
  if (facts == null) {
    facts = projectFacts(result.facts, resolution, enforcement);
    byEnforcement.set(enforcement, facts);
  }
  const advisory =
    enforcement === 'enforced'
      ? []
      : result.errors.map((d) => ({
          ...d,
          severity: 'warning',
          context: { ...d.context, enforcement: 'advisory' },
        }));
  return {
    facts,
    errors: enforcement === 'enforced' ? result.errors : [],
    warnings: [
      ...resolutionDiagnostics,
      ...advisory,
      ...result.warnings,
      ...result.infos,
    ],
  };
}

/**
 * The content key of a page's emitted rules and their locations: a digest
 * streamed over the rule texts, so no copy of the CSS is kept.
 */
function pageContentKey(rules, ruleOrigins) {
  const origins = new Map(
    ruleOrigins.map((origin) => [origin.className, origin]),
  );
  const hash = crypto.createHash('sha256');
  for (const [className, rule] of rules) {
    const origin = origins.get(className);
    hash.update(rule?.ltr ?? '\u0001');
    hash.update('\u0000');
    hash.update(rule?.rtl ?? '\u0001');
    hash.update(
      `\u0000${origin?.line ?? ''}\u0000${origin?.column ?? ''}\u0000`,
    );
  }
  return hash.digest('base64');
}

/**
 * A page's summary. With the session's accumulator, a recompiled page whose
 * emitted rules and locations are unchanged (a theme or token edit recompiles
 * its consumers) keeps its previous summary, which the accumulator then
 * skips; the accumulator drops the entry with the file.
 */
function pageSummary(file, rules, ruleOrigins = [], accumulator = null) {
  const sourcesOf = () => pageTargetSources(file, rules, ruleOrigins);
  return accumulator == null
    ? summarizePage(sourcesOf)
    : accumulator.reuse(
        file,
        pageContentKey(rules, ruleOrigins),
        () => summarizePage(sourcesOf),
        (previous) => previous.withSources(sourcesOf),
      );
}

const projectedFacts = new WeakMap();

function projectFacts(evaluated, resolution, enforcement) {
  const failingProfiles = new Set();
  for (const feature of evaluated.features) {
    if (!feature.required) continue;
    for (const profile of feature.profiles) {
      if (profile.state === 'incompatible' || profile.state === 'unknown') {
        failingProfiles.add(profile.ref);
      }
    }
  }
  const { digest: _evaluationDigest, ...body } = evaluated;
  const factsBody = {
    ...body,
    enforcement,
    profileStatus: resolution.profiles.map((profile) => ({
      ref: profile.ref,
      status: failingProfiles.has(profile.ref) ? 'failing' : 'passing',
    })),
  };
  return {
    ...factsBody,
    digest:
      'sha256:' +
      crypto
        .createHash('sha256')
        .update(
          // The evaluation serialized each feature entry already.
          stableJsonSpliced(
            factsBody,
            evaluated.features,
            featuresJson(evaluated.features),
          ),
        )
        .digest('hex'),
  };
}

const REPORT_FAILING_LIMIT = 32;

/**
 * The bounded build-report section: identities, enforcement, profile status,
 * counts and the failing required features (capped, with total and
 * truncation). The full per-feature facts are deterministic from the same
 * inputs and are identified by `factsDigest`; the report never serializes the
 * whole table, as for coverage.
 */
export function targetReportSection(facts) {
  const failing = facts.features
    .filter(
      (feature) =>
        feature.required &&
        feature.profiles.some(
          (p) => p.state === 'incompatible' || p.state === 'unknown',
        ),
    )
    .map((feature) => ({
      feature: feature.feature,
      profiles: feature.profiles
        .filter((p) => p.state !== 'native')
        .map((p) => ({ ref: p.ref, state: p.state })),
    }));
  return {
    kind: 'pandamstyle-target-report',
    schemaVersion: 1,
    factsDigest: facts.digest,
    resolutionDigest: facts.resolutionDigest,
    enforcement: facts.enforcement,
    profiles: facts.profileStatus,
    counts: facts.counts,
    failing: failing.slice(0, REPORT_FAILING_LIMIT),
    failingTotal: failing.length,
    failingTruncated: failing.length > REPORT_FAILING_LIMIT,
  };
}
