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

import { evaluateTargets } from './evaluate';
import { stableJson } from './resolve';

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
  const origins = new Map(ruleOrigins.map((origin) => [origin.className, origin]));
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
 */
export function evaluateProjectTargets({
  resolution,
  resolutionDiagnostics = [],
  designSystem,
  designSystemRules,
  pages,
  useCSSLayers = false,
  engineOptions = {},
}) {
  const enforcement = enforcementOf(resolution);
  const injected = Object.fromEntries(
    designSystemRules.map(([key, rule]) => [key, rule]),
  );
  const sources = [
    ...designSystemTargetSources(injected),
    ...pages.flatMap(({ file, rules, ruleOrigins }) =>
      pageTargetSources(file, rules, ruleOrigins),
    ),
  ];
  const result = evaluateTargets({
    resolution,
    sources,
    enhancements: designSystem.registry.enhancements ?? [],
    conditions: conditionDefinitions(designSystem.registry),
    intrinsic: { useCSSLayers, engineOptions },
    domainOf: structuralDomainOfCss,
  });
  const failingProfiles = new Set();
  for (const feature of result.facts.features) {
    if (!feature.required) continue;
    for (const profile of feature.profiles) {
      if (profile.state === 'incompatible' || profile.state === 'unknown') {
        failingProfiles.add(profile.ref);
      }
    }
  }
  const { digest: _evaluationDigest, ...body } = result.facts;
  const factsBody = {
    ...body,
    enforcement,
    profileStatus: resolution.profiles.map((profile) => ({
      ref: profile.ref,
      status: failingProfiles.has(profile.ref) ? 'failing' : 'passing',
    })),
  };
  const facts = {
    ...factsBody,
    digest:
      'sha256:' +
      crypto.createHash('sha256').update(stableJson(factsBody)).digest('hex'),
  };
  const findings =
    enforcement === 'enforced'
      ? { errors: result.errors, advisory: [] }
      : {
          errors: [],
          advisory: result.errors.map((d) => ({
            ...d,
            severity: 'warning',
            context: { ...d.context, enforcement: 'advisory' },
          })),
        };
  return {
    facts,
    errors: findings.errors,
    warnings: [
      ...resolutionDiagnostics,
      ...findings.advisory,
      ...result.warnings,
      ...result.infos,
    ],
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
        feature.profiles.some((p) => p.state === 'incompatible' || p.state === 'unknown'),
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
