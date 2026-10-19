/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Revision-level target evaluation.
 *
 * Every emitted construct is a REQUIRED capability unless the design-system
 * author declared it an optional enhancement with a fallback policy.
 *
 *   required + incompatible/unknown on a profile  -> error, the profile fails
 *   required + native/transformed/equivalent      -> recorded fact only
 *   enhancement + not native somewhere            -> warning; ok unaffected
 *   enhancement + native on every profile         -> info; the policy is inert
 *
 * The facts (`pandamstyle-target-facts`, schema 1) are a pure function of the
 * resolution record and the emitted CSS, ordered deterministically.
 */

import crypto from 'crypto';

import { featuresOf } from './catalog';
import { extractConstructs } from './extract';
import { featureOutcome, summarize, worseState } from './outcome';
import { stableJson } from './resolve';
import { Codes, diagnostic } from '../protocol/diagnostics';

export const FACTS_KIND = 'pandamstyle-target-facts';
export const FACTS_SCHEMA_VERSION = 1;
const OWNER_SAMPLE = 4;
// Protocol v1 default candidate bound.
const CANDIDATE_LIMIT = 32;

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

const extractionCache = new Map();
const recordCache = new Map();

/** Feature records and their contexts for one emitted CSS text (memoized). */
export function featuresOfCss(cssText) {
  const cached = extractionCache.get(cssText);
  if (cached != null) return cached;
  const out = [];
  for (const { construct, context } of extractConstructs(cssText)) {
    const key = JSON.stringify(construct);
    let records = recordCache.get(key);
    if (records == null) {
      records = featuresOf(construct);
      recordCache.set(key, records);
    }
    for (const record of records) out.push({ record, context });
  }
  if (extractionCache.size > 50000) extractionCache.clear();
  extractionCache.set(cssText, out);
  return out;
}

/**
 * Constructs the compiler emits by itself, independent of any source:
 * the cascade-layer wrappers or the `:not(#\#)` specificity ladder that
 * stands in for them, and the logical-float custom properties.
 */
export function intrinsicCss({
  useCSSLayers = false,
  engineOptions = {},
} = {}) {
  const parts = [];
  parts.push(
    useCSSLayers
      ? '@layer priority1, priority2;\n@layer priority2{.x:hover{color:red}}'
      : '.x:not(#\\#):hover{color:red}',
  );
  if (engineOptions.enableLogicalStylesPolyfill === true) {
    parts.push(':root{--x-float-start:left}');
  }
  return parts.join('\n');
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ownerKey(owner) {
  return `${owner.role}|${owner.file ?? ''}|${owner.line ?? ''}|${owner.column ?? ''}`;
}

const outcomeCache = new Map();

/** Profile-level outcomes of one record (memoized per resolution digest). */
export function profileOutcomes(record, resolution) {
  const key =
    resolution.digest == null
      ? null
      : `${resolution.digest}|${record.feature}|${record.recognized}`;
  if (key != null && outcomeCache.has(key)) return outcomeCache.get(key);
  const outcomes = computeProfileOutcomes(record, resolution);
  if (key != null) {
    if (outcomeCache.size > 20000) outcomeCache.clear();
    outcomeCache.set(key, outcomes);
  }
  return outcomes;
}

function computeProfileOutcomes(record, resolution) {
  return resolution.profiles.map((profile) => {
    const engines = profile.engines.map((target) =>
      featureOutcome(record, { ...target, platform: profile.platform }),
    );
    return { ref: profile.ref, state: summarize(engines), engines };
  });
}

function conditionsUsing(context, conditions) {
  const fragments = [
    context.selector ?? '',
    ...(context.atRules ?? []).map((a) => `@${a.name} ${a.prelude}`),
  ];
  return conditions
    .filter(({ definition }) =>
      fragments.some(
        (fragment) =>
          typeof definition === 'string' &&
          definition.length > 0 &&
          fragment
            .replace(/\s+/g, '')
            .includes(definition.replace(/^&/, '').replace(/\s+/g, '')),
      ),
    )
    .map(({ name }) => name)
    .sort(compareStrings);
}

function nativeEverywhere(cssText, resolution) {
  return featuresOfCss(cssText).every(({ record }) =>
    profileOutcomes(record, resolution).every((p) => p.state === 'native'),
  );
}

/** Admitted values of a structural property that are native on every profile. */
function valueCandidates(property, domainOf, resolution) {
  const domain = domainOf?.(property);
  if (domain == null) return [];
  return [...domain]
    .map(String)
    .filter((value) => nativeEverywhere(`.x{${property}:${value}}`, resolution))
    .sort(compareStrings);
}

function conditionCandidates(conditions, resolution) {
  return conditions
    .filter(({ definition }) => {
      if (typeof definition !== 'string') return false;
      const css = definition.startsWith('@')
        ? `${definition}{.x{color:red}}`
        : `.x${definition.replace(/^&/, '')}{color:red}`;
      return nativeEverywhere(css, resolution);
    })
    .map(({ name }) => name)
    .sort(compareStrings);
}

/**
 * Evaluates one revision.
 *
 * `sources`      [{ owner: { role, file, line, column, label }, css }]
 * `enhancements` normalized design-system policies [{ feature, fallback }]
 * `conditions`   the registry's conditions [{ name, definition }]
 * `intrinsic`    { useCSSLayers, engineOptions }
 * `domainOf`     property -> admitted structural values, for candidates
 */
export function evaluateTargets({
  resolution,
  sources,
  enhancements = [],
  conditions = [],
  intrinsic = {},
  domainOf = null,
}) {
  const uses = new Map();
  // A use backed by a fallback written in the value is tracked apart from a
  // required use of the same feature.
  const useKey = (rec) =>
    rec.fallback == null
      ? rec.feature
      : `${rec.feature}\u0000${rec.fallback.kind}`;
  const record = (entry, owner) => {
    const key = useKey(entry.record);
    let use = uses.get(key);
    if (use == null) {
      use = { record: entry.record, owners: new Map(), occurrences: 0 };
      uses.set(key, use);
    }
    use.occurrences += 1;
    const oKey = ownerKey(owner);
    if (!use.owners.has(oKey)) {
      use.owners.set(oKey, { owner, context: entry.context });
    }
  };
  for (const { owner, css } of sources) {
    for (const entry of featuresOfCss(css)) record(entry, owner);
  }
  for (const entry of featuresOfCss(intrinsicCss(intrinsic))) {
    record(entry, {
      role: 'generated',
      file: null,
      line: null,
      column: null,
      label: 'compiler-intrinsic',
    });
  }

  const policies = new Map(
    enhancements.map((policy) => [policy.feature, policy]),
  );
  const errors = [];
  const warnings = [];
  const infos = [];
  const features = [];

  for (const mapKey of [...uses.keys()].sort(compareStrings)) {
    const use = uses.get(mapKey);
    const key = use.record.feature;
    // An author-declared fallback: a design-system enhancement policy, or a
    // fallback chain written in the value itself (font stacks).
    const policy =
      use.record.fallback != null
        ? { feature: key, fallback: use.record.fallback }
        : (policies.get(key) ?? null);
    const profiles = profileOutcomes(use.record, resolution);
    const owners = [...use.owners.values()].sort((a, b) =>
      compareStrings(ownerKey(a.owner), ownerKey(b.owner)),
    );
    features.push({
      feature: key,
      kind: use.record.kind,
      parent: use.record.parent,
      recognized: use.record.recognized,
      required: policy == null,
      enhancement: policy == null ? null : policy.fallback,
      occurrences: use.occurrences,
      owners: owners.slice(0, OWNER_SAMPLE).map(({ owner }) => owner),
      ownersTotal: owners.length,
      profiles: profiles.map((profile) => ({
        ref: profile.ref,
        state: profile.state,
        engines: profile.engines.map((outcome) => ({
          engine: outcome.engine,
          floor: outcome.floor,
          state: outcome.state,
          reason: outcome.reason,
          basis: outcome.basis,
          ...(outcome.path == null ? {} : { path: outcome.path }),
          ...(outcome.caveats.length === 0 ? {} : { caveats: outcome.caveats }),
          ...(outcome.restriction == null
            ? {}
            : { restriction: outcome.restriction }),
        })),
      })),
    });

    for (const profile of profiles) {
      const failing = profile.engines.filter(
        (outcome) =>
          outcome.state === 'incompatible' || outcome.state === 'unknown',
      );
      if (failing.length === 0) continue;
      const engines = failing.map((outcome) => ({
        engine: outcome.engine,
        floor: outcome.floor,
        state: outcome.state,
        reason: outcome.reason,
        basis: outcome.basis,
      }));
      if (policy != null) {
        warnings.push(
          diagnostic({
            code: Codes.TARGET_ENHANCEMENT_DEGRADED,
            severity: 'warning',
            phase: 'targets',
            message: `Optional enhancement ${key} is not native on ${failing.map((o) => o.engine).join(', ')} in ${profile.ref}; fallback "${policy.fallback.kind}" applies there.`,
            source: null,
            rule: 'targets.enhancement.degraded',
            context: {
              feature: key,
              profile: profile.ref,
              engines,
              fallback: policy.fallback,
            },
          }),
        );
        continue;
      }
      // One diagnostic per (feature, profile, owner file), located at the
      // first occurrence in that file.
      const byFile = new Map();
      for (const entry of owners) {
        const fileKey = `${entry.owner.role}|${entry.owner.file ?? ''}`;
        if (!byFile.has(fileKey)) byFile.set(fileKey, []);
        byFile.get(fileKey).push(entry);
      }
      for (const group of byFile.values()) {
        const first = group[0];
        const { owner, context } = first;
        const usedConditions = conditionsUsing(context, conditions);
        let candidates = [];
        let repair;
        if (
          owner.role === 'page' &&
          use.record.kind === 'value' &&
          context.property != null
        ) {
          candidates = valueCandidates(context.property, domainOf, resolution);
          repair = {
            kind: 'replace-with-value',
            applicable: candidates.length > 0,
            target: { property: context.property },
            expected: {
              states: [
                'native',
                'transformed-with-proof',
                'equivalent-fallback',
              ],
            },
            reason:
              candidates.length > 0
                ? null
                : 'no admitted value of this property is native on every announced profile',
          };
        } else if (owner.role === 'page' && usedConditions.length > 0) {
          candidates = conditionCandidates(conditions, resolution);
          repair = {
            kind: 'replace-condition',
            applicable: candidates.length > 0,
            target: { conditions: usedConditions },
            expected: {
              states: [
                'native',
                'transformed-with-proof',
                'equivalent-fallback',
              ],
            },
            reason:
              candidates.length > 0
                ? null
                : 'no declared condition is native on every announced profile',
          };
        } else {
          repair = {
            kind: owner.role === 'page' ? 'unknown' : 'declare-enhancement',
            applicable: false,
            target: { feature: key },
            expected: {
              states: [
                'native',
                'transformed-with-proof',
                'equivalent-fallback',
              ],
            },
            reason:
              owner.role === 'page'
                ? 'the construct is required by the emitted CSS and has no structured replacement'
                : 'an authorized design-system change: declare an enhancement with a fallback, or raise the target floor',
          };
        }
        const state = summarize(failing);
        const unknownOnly = state === 'unknown';
        errors.push({
          ...diagnostic({
            code: unknownOnly
              ? Codes.TARGET_CAPABILITY_UNKNOWN
              : Codes.TARGET_CAPABILITY_INCOMPATIBLE,
            severity: 'error',
            phase: 'targets',
            message: `${key} is ${state} on ${failing.map((o) => `${o.engine} ${o.floor} (${o.reason})`).join(', ')} in target profile ${profile.ref}, and no enhancement policy covers it.`,
            source:
              owner.file == null
                ? null
                : {
                    file: owner.file,
                    line: owner.line ?? null,
                    column: owner.column ?? null,
                    role: owner.role,
                  },
            rule: unknownOnly
              ? 'targets.capability.evidence'
              : 'targets.capability.required',
            context: {
              feature: key,
              owner: owner.label ?? owner.role,
              property: context.property ?? null,
              value: context.value ?? null,
              selector: context.selector ?? null,
              atRules: (context.atRules ?? []).map((a) =>
                `@${a.name} ${a.prelude}`.trim(),
              ),
              conditions: usedConditions,
              profile: profile.ref,
              state,
              engines,
              occurrencesInFile: group.length,
            },
          }),
          role: owner.role === 'generated' ? 'generated' : owner.role,
          expected: {
            states: ['native', 'transformed-with-proof', 'equivalent-fallback'],
            profile: profile.ref,
          },
          candidates: candidates
            .slice(0, CANDIDATE_LIMIT)
            .map((candidate) => ({ value: candidate })),
          candidatesTotal: candidates.length,
          candidatesTruncated: candidates.length > CANDIDATE_LIMIT,
          repair,
        });
      }
    }
  }

  for (const policy of enhancements) {
    const use = uses.get(policy.feature);
    if (use == null) continue;
    const profiles = profileOutcomes(use.record, resolution);
    if (profiles.every((profile) => profile.state === 'native')) {
      infos.push(
        diagnostic({
          code: Codes.TARGET_ENHANCEMENT_INEFFECTIVE,
          severity: 'info',
          phase: 'targets',
          message: `Enhancement policy for ${policy.feature} has no effect: it is native on every announced profile.`,
          source: null,
          rule: 'targets.enhancement.ineffective',
          context: {
            feature: policy.feature,
            profiles: profiles.map((p) => p.ref),
          },
        }),
      );
    }
  }

  const factsBody = {
    kind: FACTS_KIND,
    schemaVersion: FACTS_SCHEMA_VERSION,
    resolutionDigest: resolution.digest,
    profiles: resolution.profiles.map((profile) => profile.ref),
    features,
    counts: {
      features: features.length,
      required: features.filter((f) => f.required).length,
      enhancements: features.filter((f) => !f.required).length,
      failingRequired: features.filter(
        (f) =>
          f.required &&
          f.profiles.some(
            (p) => p.state === 'incompatible' || p.state === 'unknown',
          ),
      ).length,
    },
  };
  const facts = { ...factsBody, digest: sha256(stableJson(factsBody)) };
  return { facts, errors, warnings, infos };
}

/**
 * D-BP-13: a reusable package's requirement set against an application's
 * resolved targets. A package publishes requirements, never targets; the
 * application resolves targets once and evaluates them here.
 */
export function evaluateRequirements(requirements, resolution, recordOf) {
  const failing = [];
  for (const feature of [...requirements].sort(compareStrings)) {
    const record = recordOf(feature);
    const profiles =
      record == null
        ? resolution.profiles.map((profile) => ({
            ref: profile.ref,
            state: 'unknown',
          }))
        : profileOutcomes(record, resolution);
    const state = profiles.reduce((s, p) => worseState(s, p.state), 'native');
    if (state === 'incompatible' || state === 'unknown') {
      failing.push({
        feature,
        state,
        profiles: profiles.map((p) => ({ ref: p.ref, state: p.state })),
      });
    }
  }
  return { ok: failing.length === 0, failing };
}
