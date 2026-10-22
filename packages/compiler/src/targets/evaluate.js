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

import { applyTransforms } from './transforms';
import { featuresOf } from './catalog';
import { constructKey, extractConstructs } from './extract';
import { featureOutcome, summarize, worseState } from './outcome';
import { stableJson } from './resolve';
import { Codes, diagnostic } from '../protocol/diagnostics';

export const FACTS_KIND = 'pandamstyle-target-facts';
export const FACTS_SCHEMA_VERSION = 1;
// Protocol v1 default candidate bound.
const CANDIDATE_LIMIT = 32;

function sha256(text) {
  return 'sha256:' + crypto.createHash('sha256').update(text).digest('hex');
}

// Extraction results per emitted CSS text, and catalog records per construct.
// Both are bounded and evicted together: a record is only reachable through
// the extraction results that produced it.
const EXTRACTION_LIMIT = 50000;
const RECORD_LIMIT = 20000;
const extractionCache = new Map();
const recordCache = new Map();

function evictExtraction() {
  extractionCache.clear();
  recordCache.clear();
}

/** Sizes of the process-wide extraction caches (retention tests). */
export function extractionCacheSizes() {
  return { texts: extractionCache.size, constructs: recordCache.size };
}

/** Feature records and their contexts for one emitted CSS text (memoized). */
const DECLARED_CUSTOM_PROPERTY = /(--[A-Za-z0-9_-]+)\s*:/g;

/**
 * The extraction key of a text: the text, plus the grammars of the custom
 * properties it declares when they are known (a design-system token of a
 * color category), since those decide how their keywords read.
 */
function extractionKey(cssText, grammars) {
  if (grammars == null || grammars.size === 0 || !cssText.includes('--')) {
    return cssText;
  }
  let known = '';
  for (const [, name] of cssText.matchAll(DECLARED_CUSTOM_PROPERTY)) {
    const grammar = grammars.get(name);
    if (grammar != null) known += `${name}=${grammar};`;
  }
  return known === '' ? cssText : `${cssText}\u0000${known}`;
}

export function featuresOfCss(cssText, grammars = null) {
  const cacheKey = extractionKey(cssText, grammars);
  const cached = extractionCache.get(cacheKey);
  if (cached != null) return cached;
  if (
    extractionCache.size >= EXTRACTION_LIMIT ||
    recordCache.size >= RECORD_LIMIT
  ) {
    evictExtraction();
  }
  const out = [];
  for (const { construct, context } of extractConstructs(cssText, {
    grammars: cacheKey === cssText ? null : grammars,
  })) {
    const key = constructKey(construct);
    let records = recordCache.get(key);
    if (records == null) {
      records = featuresOf(construct);
      recordCache.set(key, records);
    }
    for (const record of records) out.push({ record, context });
  }
  extractionCache.set(cacheKey, out);
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

function roleOf(owner) {
  return owner.role === 'generated' ? (owner.label ?? 'generated') : owner.role;
}

/** Owner counts by role, keys sorted. */
function sortedCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => compareStrings(a, b)),
  );
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

// A candidate passes where the compiler's own emission of it does: natively,
// or through a proven transformation of the stage.
function nativeEverywhere(cssText, resolution) {
  return featuresOfCss(applyTransforms(cssText)).every(({ record }) =>
    profileOutcomes(record, resolution).every(
      (p) => p.state === 'native' || p.state === 'transformed-with-proof',
    ),
  );
}

// ---------------------------------------------------------------- units ----
//
// A revision's feature uses are the sum of independent units: the design
// system's own rules, each covered page file, and the compiler-intrinsic
// emission. A unit's summary is computed once per unit identity (a page
// contribution's rule list, the design system's `injected` rules, the
// intrinsic CSS text) and an accumulator adds and removes only the units that
// changed, so a revision pays for what changed, not for the whole project.

// A use backed by a fallback written in the value is tracked apart from a
// required use of the same feature.
function useKeyOf(record) {
  return record.fallback == null
    ? record.feature
    : `${record.feature}\u0000${record.fallback.kind}`;
}

/**
 * Feature uses of a list of sources with their owner groups:
 *
 *   useKey -> { record, occurrences, groups: [{ owner, context, count }] }
 *
 * A group is one owner file, role and label: its number of distinct owners
 * and only its first owner (lowest owner key) with that owner's first
 * context, which is all a diagnostic needs.
 */
function ownerGroupsOf(sources) {
  const building = new Map();
  for (const { owner, css, grammars } of sources) {
    const oKey = ownerKey(owner);
    const gKey = `${owner.role}|${owner.file ?? ''}|${roleOf(owner)}`;
    // Claims attach to the CSS the compiler emits: the transformed text.
    for (const entry of featuresOfCss(applyTransforms(css), grammars)) {
      const key = useKeyOf(entry.record);
      let use = building.get(key);
      if (use == null) {
        use = { record: entry.record, occurrences: 0, groups: new Map() };
        building.set(key, use);
      }
      use.occurrences += 1;
      let group = use.groups.get(gKey);
      if (group == null) {
        group = new Map();
        use.groups.set(gKey, group);
      }
      if (!group.has(oKey)) group.set(oKey, { owner, context: entry.context });
    }
  }
  const uses = new Map();
  for (const [key, use] of building) {
    const groups = [];
    for (const owners of use.groups.values()) {
      let firstKey = null;
      let first = null;
      for (const [oKey, entry] of owners) {
        if (firstKey == null || compareStrings(oKey, firstKey) < 0) {
          firstKey = oKey;
          first = entry;
        }
      }
      groups.push({
        owner: first.owner,
        context: first.context,
        count: owners.size,
      });
    }
    uses.set(key, { record: use.record, occurrences: use.occurrences, groups });
  }
  return uses;
}

/**
 * A unit's feature uses in the compact form a live unit keeps: parallel
 * arrays of use keys and (shared) records, occurrence and owner counts in one
 * typed array, and the owner role once when the unit has a single one. The
 * owner groups a diagnostic reads are kept for small units (`sourcesOf` is
 * null) and rebuilt from `sourcesOf()` for pages, whose sources the session
 * holds anyway. The function itself is kept, not a closure over it: one less
 * object per live page.
 */
class UnitSummary {
  constructor(rich, sourcesOf = null) {
    const n = rich.size;
    this.keys = new Array(n);
    this.records = new Array(n);
    this.counts = new Int32Array(n * 2);
    let role;
    const perUse = new Array(n);
    let single = true;
    let i = 0;
    for (const [key, use] of rich) {
      this.keys[i] = key;
      this.records[i] = use.record;
      this.counts[i * 2] = use.occurrences;
      const roles = {};
      for (const group of use.groups) {
        this.counts[i * 2 + 1] += group.count;
        const r = roleOf(group.owner);
        roles[r] = (roles[r] ?? 0) + group.count;
        if (role === undefined) role = r;
        else if (r !== role) single = false;
      }
      perUse[i] = roles;
      i += 1;
    }
    // One role for the whole unit (a page, the design system, the compiler),
    // or per-use role counts.
    this.role = single ? (role ?? null) : null;
    this.roles = single ? null : perUse;
    this.kept = sourcesOf == null ? rich : null;
    this.sourcesOf = sourcesOf;
    this.groupCache = null;
  }

  /** The unit's uses with their owner groups. */
  richUses() {
    return this.kept ?? ownerGroupsOf(this.sourcesOf());
  }

  get size() {
    return this.keys.length;
  }

  /** Owner counts by role of use `i`. */
  rolesAt(i) {
    return this.roles == null
      ? { [this.role]: this.counts[i * 2 + 1] }
      : this.roles[i];
  }

  /**
   * Owner groups of a use (diagnostics only), or [] when absent. A summary's
   * sources never change, so the groups a diagnostic asked for are kept: only
   * failing uses are asked for, and an unchanged page answers the next
   * revision without rebuilding its groups.
   */
  groups(useKey) {
    if (!this.keys.includes(useKey)) return [];
    let groups = this.groupCache?.get(useKey);
    if (groups === undefined) {
      groups = this.richUses().get(useKey)?.groups ?? [];
      this.groupCache ??= new Map();
      this.groupCache.set(useKey, groups);
    }
    return groups;
  }

  /**
   * The same uses read from other sources with identical content (a
   * recompiled page): the arrays are shared, the summary itself is never
   * changed, since identity caches hold it.
   */
  withSources(sourcesOf) {
    const view = Object.create(UnitSummary.prototype);
    view.keys = this.keys;
    view.records = this.records;
    view.counts = this.counts;
    view.role = this.role;
    view.roles = this.roles;
    view.kept = null;
    view.sourcesOf = sourcesOf;
    view.groupCache = null;
    return view;
  }
}

const structureKeys = new WeakMap();

/**
 * The structure of a summary: its feature keys, occurrence and owner counts
 * and roles, without owner contexts. Two summaries with the same structure
 * give the same totals and facts entries.
 */
export function structureKey(summary) {
  const known = structureKeys.get(summary);
  if (known != null) return known;
  const parts = [];
  for (let i = 0; i < summary.size; i += 1) {
    parts.push(
      `${summary.keys[i]}\u0001${summary.counts[i * 2]}\u0001${summary.counts[i * 2 + 1]}\u0001${stableJson(summary.rolesAt(i))}`,
    );
  }
  const key = parts.join('\u0002');
  structureKeys.set(summary, key);
  return key;
}

/** The unit summary of a list of sources, keeping its owner groups. */
export function summarizeSources(sources) {
  return new UnitSummary(ownerGroupsOf(sources));
}

/**
 * The unit summary of a page: its owner groups are rebuilt from `sourcesOf`
 * when a diagnostic needs them instead of being kept.
 */
export function summarizePage(sourcesOf) {
  return new UnitSummary(ownerGroupsOf(sourcesOf()), sourcesOf);
}

const unitCache = new WeakMap();

/**
 * A unit summary built once per unit identity (an object) and the other
 * inputs its sources depend on (`deps`, compared by identity: a page's file
 * and rule origins).
 */
export function cachedUnit(identity, buildSummary, deps = []) {
  const cached = unitCache.get(identity);
  if (
    cached != null &&
    cached.deps.length === deps.length &&
    cached.deps.every((dep, i) => dep === deps[i])
  ) {
    return cached.summary;
  }
  const summary = buildSummary();
  unitCache.set(identity, { deps, summary });
  return summary;
}

/** The summary of a unit's sources, computed once per unit identity. */
export function unitSummary(identity, sourcesOf) {
  return cachedUnit(identity, () => summarizeSources(sourcesOf()));
}

const INTRINSIC_OWNER = Object.freeze({
  role: 'generated',
  file: null,
  line: null,
  column: null,
  label: 'compiler-intrinsic',
});
const intrinsicCache = new Map();

function intrinsicSummary(intrinsic) {
  const css = intrinsicCss(intrinsic);
  let summary = intrinsicCache.get(css);
  if (summary == null) {
    summary = summarizeSources([{ owner: INTRINSIC_OWNER, css }]);
    intrinsicCache.set(css, summary);
  }
  return summary;
}

/**
 * The sum of unit summaries, maintained incrementally. `sync(entries)` takes
 * the revision's `[unitId, summary]` list; a unit whose summary object is the
 * one already counted costs a lookup. Owner keys are unique across units
 * (they name the file, or the design system, or the compiler), so totals are
 * plain sums; the owner groups of a feature are read back from the live units
 * only when a diagnostic needs them.
 *
 * The accumulator also keeps, per live unit id, the content key its summary
 * was built from (`reuse`), so an unchanged recompiled page keeps its summary.
 * Both are dropped with the unit: nothing outlives the session or a removed
 * file.
 */
export function createTargetAccumulator() {
  const units = new Map();
  const reused = new Map();
  const uses = new Map();
  // Feature keys whose totals or owner groups changed since the evaluation
  // last read them.
  let touched = new Set();
  let version = 0;
  const add = (summary) => {
    for (let i = 0; i < summary.size; i += 1) {
      const key = summary.keys[i];
      touched.add(key);
      let total = uses.get(key);
      if (total == null) {
        total = {
          record: summary.records[i],
          occurrences: 0,
          ownersTotal: 0,
          roles: {},
          units: 0,
        };
        uses.set(key, total);
      }
      total.units += 1;
      total.occurrences += summary.counts[i * 2];
      total.ownersTotal += summary.counts[i * 2 + 1];
      for (const [role, count] of Object.entries(summary.rolesAt(i))) {
        total.roles[role] = (total.roles[role] ?? 0) + count;
      }
    }
  };
  const remove = (summary) => {
    for (let i = 0; i < summary.size; i += 1) {
      const key = summary.keys[i];
      touched.add(key);
      const total = uses.get(key);
      total.units -= 1;
      total.occurrences -= summary.counts[i * 2];
      total.ownersTotal -= summary.counts[i * 2 + 1];
      for (const [role, count] of Object.entries(summary.rolesAt(i))) {
        total.roles[role] -= count;
      }
      if (total.units === 0) uses.delete(key);
    }
  };
  return {
    sync(entries) {
      let changed = false;
      let known = 0;
      for (const [id, summary] of entries) {
        const previous = units.get(id);
        if (previous !== undefined) known += 1;
        if (previous === summary) continue;
        if (previous != null) remove(previous);
        add(summary);
        units.set(id, summary);
        changed = true;
      }
      // A unit can only have disappeared if fewer known ids came back.
      if (known < units.size - (entries.length - known)) {
        const live = new Set(entries.map(([id]) => id));
        for (const [id, previous] of units) {
          if (live.has(id)) continue;
          remove(previous);
          units.delete(id);
          reused.delete(id);
          changed = true;
        }
      }
      if (changed) version += 1;
      return { uses, version };
    },
    /**
     * The summary for unit `id` built from content `key`: when the unit's
     * content key is unchanged, `view(previous)` (the previous uses read
     * from the new sources), counted in place of the previous summary since
     * its totals are the same; otherwise `build()`.
     */
    reuse(id, key, build, view) {
      const previous = reused.get(id);
      if (previous != null && previous.key === key) {
        const summary = view(previous.summary);
        if (units.get(id) === previous.summary) units.set(id, summary);
        reused.set(id, { key, summary });
        return summary;
      }
      const summary = build();
      reused.set(id, { key, summary });
      return summary;
    },
    /** Owner groups of a feature across the live units (diagnostics only). */
    groupsOf(useKey) {
      const out = [];
      for (const summary of units.values()) out.push(...summary.groups(useKey));
      return out;
    },
    /** The feature keys touched since the last call, then forgets them. */
    takeTouched() {
      const out = touched;
      touched = new Set();
      return out;
    },
    /**
     * Marks the keys of a unit whose owner contexts changed while its totals
     * did not (a reused summary rebound to new sources).
     */
    touchKeys(keys) {
      for (const key of keys) touched.add(key);
      version += 1;
    },
    /**
     * Counts `summary` for unit `id` in place of the previous one, without
     * recounting, when both have the same structure (a token value edit
     * rewrites rule texts but not the features they use). Only the owner
     * contexts changed: keys whose cached diagnostics read them are
     * evaluated again.
     */
    reuseStructure(id, summary) {
      const previous = units.get(id);
      if (previous == null || previous === summary) return summary;
      if (structureKey(previous) !== structureKey(summary)) return summary;
      units.set(id, summary);
      const perKey = this.memo?.perKey;
      const stale = summary.keys.filter(
        (key) => (perKey?.get(key)?.errors.length ?? 0) > 0,
      );
      if (stale.length > 0) this.touchKeys(stale);
      return summary;
    },
    /** Live unit and retained content-key counts (retention tests). */
    retained() {
      return { units: units.size, contentKeys: reused.size, uses: uses.size };
    },
    // The last evaluation, reused while nothing it depends on changed.
    memo: null,
  };
}

/**
 * Diagnostic groups of a feature: one per owner role and file, located at
 * the file's first owner (lowest owner key), ordered by that owner key, with
 * the number of distinct owners in the file.
 */
function ownerGroups(groups) {
  const byFile = new Map();
  for (const group of groups) {
    const fileKey = `${group.owner.role}|${group.owner.file ?? ''}`;
    const key = ownerKey(group.owner);
    const merged = byFile.get(fileKey);
    if (merged == null) {
      byFile.set(fileKey, { ...group, key });
    } else {
      merged.count += group.count;
      if (compareStrings(key, merged.key) < 0) {
        merged.owner = group.owner;
        merged.context = group.context;
        merged.key = key;
      }
    }
  }
  return [...byFile.values()].sort((a, b) => compareStrings(a.key, b.key));
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const entryCache = new Map();

/** One facts entry, memoized by everything it is a function of. */
function featureEntry(resolution, use, mapKey, policy, keys) {
  const roles = sortedCounts(use.roles);
  const ownersTotal = use.ownersTotal;
  const key = [
    resolution.digest,
    mapKey,
    policy == null ? '' : stableJson(policy.fallback),
    use.occurrences,
    stableJson(roles),
    ownersTotal,
  ].join('\u0000');
  keys.push(key);
  let entry = entryCache.get(key);
  if (entry != null) return entry;
  const profiles = profileOutcomes(use.record, resolution);
  entry = deepFreeze({
    feature: use.record.feature,
    kind: use.record.kind,
    parent: use.record.parent,
    recognized: use.record.recognized,
    required: policy == null,
    enhancement: policy == null ? null : policy.fallback,
    occurrences: use.occurrences,
    // Owner counts by role, never file paths: the facts and their digest
    // must not depend on where the project is checked out. Diagnostics keep
    // the source locations.
    owners: roles,
    ownersTotal,
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
        ...(outcome.proof == null ? {} : { proof: outcome.proof }),
      })),
    })),
  });
  if (entryCache.size > 20000) entryCache.clear();
  entryCache.set(key, entry);
  return entry;
}

const candidateCache = new Map();
const factsCache = new Map();

function memoCandidates(key, compute) {
  let value = candidateCache.get(key);
  if (value == null) {
    value = compute();
    if (candidateCache.size > 5000) candidateCache.clear();
    candidateCache.set(key, value);
  }
  return value;
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
/**
 * The policy of the construct a syntax form qualifies: a form key is
 * `<parent key>/<suffix>`, and a declared fallback of the construct applies
 * to every way of writing it.
 */
function inheritedPolicy(record, policies) {
  if (
    record.parent == null ||
    !record.feature.startsWith(`${record.parent}/`)
  ) {
    return null;
  }
  let key = record.feature;
  for (let cut = key.lastIndexOf('/'); cut > 0; cut = key.lastIndexOf('/')) {
    key = key.slice(0, cut);
    const policy = policies.get(key);
    if (policy != null)
      return { feature: record.feature, fallback: policy.fallback };
  }
  return null;
}

/**
 * Facts entry and diagnostics of one feature key: a pure function of the
 * key's totals, its owner groups (read only when a diagnostic needs them),
 * the resolution and the policies.
 */
function evaluateKey(mapKey, use, ctx) {
  const { resolution, policies, conditions, domainOf, target } = ctx;
  const errors = [];
  const warnings = [];
  const key = use.record.feature;
  // An author-declared fallback: a design-system enhancement policy, or a
  // fallback chain written in the value itself (font stacks).
  const policy =
    use.record.fallback != null
      ? { feature: key, fallback: use.record.fallback }
      : (policies.get(key) ?? inheritedPolicy(use.record, policies));
  const profiles = profileOutcomes(use.record, resolution);
  const entryKeys = [];
  const entry = featureEntry(resolution, use, mapKey, policy, entryKeys);
  // Owner groups are read only where a diagnostic needs them.
  let groups = null;
  const groupsOf = () => (groups ??= ownerGroups(target.groupsOf(mapKey)));

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
    for (const group of groupsOf()) {
      const { owner, context } = group;
      const usedConditions = conditionsUsing(context, conditions);
      let candidates = [];
      let repair;
      if (
        owner.role === 'page' &&
        use.record.kind === 'value' &&
        context.property != null
      ) {
        // The admitted values come from the design system's effective
        // property table: its digest is part of the key.
        candidates = memoCandidates(
          `${resolution.digest}|${domainOf?.digest ?? ''}|value|${context.property}`,
          () => valueCandidates(context.property, domainOf, resolution),
        );
        repair = {
          kind: 'replace-with-value',
          applicable: candidates.length > 0,
          target: { property: context.property },
          expected: {
            states: ['native', 'transformed-with-proof', 'equivalent-fallback'],
          },
          reason:
            candidates.length > 0
              ? null
              : 'no admitted value of this property is native on every announced profile',
        };
      } else if (owner.role === 'page' && usedConditions.length > 0) {
        candidates = memoCandidates(
          `${resolution.digest}|conditions|${stableJson(conditions)}`,
          () => conditionCandidates(conditions, resolution),
        );
        repair = {
          kind: 'replace-condition',
          applicable: candidates.length > 0,
          target: { conditions: usedConditions },
          expected: {
            states: ['native', 'transformed-with-proof', 'equivalent-fallback'],
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
            states: ['native', 'transformed-with-proof', 'equivalent-fallback'],
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
            occurrencesInFile: group.count,
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

  return { entry, entryKey: entryKeys[0], errors, warnings };
}

/**
 * Evaluates one revision.
 *
 * `sources`      [{ owner: { role, file, line, column, label }, css }]
 * `units`        [[unitId, summary]] for units summarized by the caller
 * `enhancements` normalized design-system policies [{ feature, fallback }]
 * `conditions`   the registry's conditions [{ name, definition }]
 * `intrinsic`    { useCSSLayers, engineOptions }
 * `domainOf`     property -> admitted structural values, for candidates
 * `accumulator`  the session's accumulator: only the feature keys touched
 *                since its previous evaluation are evaluated again
 */
export function evaluateTargets({
  resolution,
  sources = [],
  units = [],
  enhancements = [],
  conditions = [],
  intrinsic = {},
  domainOf = null,
  accumulator = null,
}) {
  const entries = [
    ...units,
    ['compiler-intrinsic', intrinsicSummary(intrinsic)],
  ];
  if (sources.length > 0) entries.push(['sources', summarizeSources(sources)]);
  const target = accumulator ?? createTargetAccumulator();
  const { uses, version } = target.sync(entries);
  const paramsKey = [
    resolution.digest,
    stableJson(enhancements),
    stableJson(conditions),
  ].join('\u0000');
  const memo = target.memo;
  // Nothing the evaluation reads changed: the previous result stands.
  if (
    memo != null &&
    memo.version === version &&
    memo.paramsKey === paramsKey &&
    memo.domainOf === domainOf
  ) {
    return memo.result;
  }
  // Same parameters: only the touched keys are evaluated again.
  const incremental =
    memo != null && memo.paramsKey === paramsKey && memo.domainOf === domainOf;
  const touched = target.takeTouched();
  const perKey = incremental ? memo.perKey : new Map();
  let keys = incremental ? memo.keys : null;
  let entriesChanged = !incremental;
  const ctx = {
    resolution,
    policies: new Map(enhancements.map((policy) => [policy.feature, policy])),
    conditions,
    domainOf,
    target,
  };
  const pending = incremental ? touched : uses.keys();
  for (const mapKey of pending) {
    const use = uses.get(mapKey);
    const previous = perKey.get(mapKey);
    if (use == null) {
      if (previous != null) {
        perKey.delete(mapKey);
        keys = null;
        entriesChanged = true;
      }
      continue;
    }
    const next = evaluateKey(mapKey, use, ctx);
    if (previous == null) keys = null;
    if (previous?.entry !== next.entry) entriesChanged = true;
    perKey.set(mapKey, next);
  }
  keys ??= [...perKey.keys()].sort(compareStrings);

  const errors = [];
  const warnings = [];
  const infos = [];
  for (const mapKey of keys) {
    const result = perKey.get(mapKey);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
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

  // The facts are a function of their entries only: an unchanged set of
  // entries (a style or token value edit) keeps the facts and their digest.
  let facts = entriesChanged ? null : memo.result.facts;
  if (facts == null) {
    const entryKeys = keys.map((mapKey) => perKey.get(mapKey).entryKey);
    const factsKey = entryKeys.join('\u0001');
    facts = factsCache.get(factsKey);
    if (facts == null) {
      const features = keys.map((mapKey) => perKey.get(mapKey).entry);
      facts = factsOf(resolution, features);
      if (factsCache.size > 256) factsCache.clear();
      factsCache.set(factsKey, facts);
    }
  }
  const result = { facts, errors, warnings, infos };
  target.memo = { version, paramsKey, domainOf, perKey, keys, result };
  return result;
}

/**
 * The facts of a feature list. Each entry is serialized once; the facts
 * digest and the project facts digest splice the entries' serialization into
 * their own stable JSON, byte for byte what `stableJson` gives.
 */
function factsOf(resolution, features) {
  const body = {
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
  return {
    ...body,
    digest: sha256(stableJsonSpliced(body, features, featuresJson(features))),
  };
}

const entryJsonCache = new WeakMap();

/**
 * `stableJson(entry)` for a facts entry, written for its fixed shape (keys in
 * sorted order) and memoized per frozen entry: entries are shared across
 * revisions, so an entry is serialized once. A test asserts byte equality
 * with `stableJson` on every entry the workloads produce.
 */
export function entryJson(entry) {
  let json = entryJsonCache.get(entry);
  if (json != null) return json;
  const profiles = entry.profiles.map(
    (profile) =>
      `{"engines":[${profile.engines.map(engineJson).join(',')}],"ref":${stableJson(
        profile.ref,
      )},"state":${stableJson(profile.state)}}`,
  );
  json =
    `{"enhancement":${stableJson(entry.enhancement)}` +
    `,"feature":${stableJson(entry.feature)}` +
    `,"kind":${stableJson(entry.kind)}` +
    `,"occurrences":${stableJson(entry.occurrences)}` +
    `,"owners":${stableJson(entry.owners)}` +
    `,"ownersTotal":${stableJson(entry.ownersTotal)}` +
    `,"parent":${stableJson(entry.parent)}` +
    `,"profiles":[${profiles.join(',')}]` +
    `,"recognized":${stableJson(entry.recognized)}` +
    `,"required":${stableJson(entry.required)}}`;
  entryJsonCache.set(entry, json);
  return json;
}

function engineJson(outcome) {
  return (
    `{"basis":${stableJson(outcome.basis)}` +
    (outcome.caveats === undefined
      ? ''
      : `,"caveats":${stableJson(outcome.caveats)}`) +
    `,"engine":${stableJson(outcome.engine)}` +
    `,"floor":${stableJson(outcome.floor)}` +
    (outcome.path === undefined ? '' : `,"path":${stableJson(outcome.path)}`) +
    (outcome.proof === undefined
      ? ''
      : `,"proof":${stableJson(outcome.proof)}`) +
    `,"reason":${stableJson(outcome.reason)}` +
    (outcome.restriction === undefined
      ? ''
      : `,"restriction":${stableJson(outcome.restriction)}`) +
    `,"state":${stableJson(outcome.state)}}`
  );
}

/** `stableJson(features)` of a facts feature list, from memoized entries. */
export function featuresJson(features) {
  return `[${features.map(entryJson).join(',')}]`;
}

/**
 * `stableJson(value)` where the object `spliced` (found anywhere in `value`)
 * is replaced by its known serialization `json`.
 */
export function stableJsonSpliced(value, spliced, json) {
  if (value === spliced) return json;
  if (value === null || typeof value !== 'object') return stableJson(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJsonSpliced(v, spliced, json)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJsonSpliced(value[key], spliced, json)}`,
    )
    .join(',')}}`;
}

const designSystemFactsCache = new Map();

/**
 * The facts of the design system's own emitted rules (snapshot `targetFacts`).
 * Facts do not depend on owner contexts, conditions or candidates, so they are
 * memoized by the summary's structure: a token value edit that leaves the
 * features unchanged keeps the facts.
 */
export function designSystemTargetFacts({ resolution, summary, enhancements }) {
  const key = [
    resolution.digest,
    stableJson(enhancements),
    structureKey(summary),
  ].join('\u0003');
  let facts = designSystemFactsCache.get(key);
  if (facts == null) {
    facts = evaluateTargets({
      resolution,
      units: [['design-system', summary]],
      enhancements,
    }).facts;
    if (designSystemFactsCache.size > 32) designSystemFactsCache.clear();
    designSystemFactsCache.set(key, facts);
  }
  return facts;
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
