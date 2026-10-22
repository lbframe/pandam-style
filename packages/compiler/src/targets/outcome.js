/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The per-target outcome function.
 *
 * Total and ordered: every (feature, engine, target range) gets exactly one of
 * five states, with a reason from a finite enum and the basis of the answer.
 * Compiler recognition and browser evidence stay separate inputs: a feature the
 * catalog does not recognize is `unknown` before any data is read.
 *
 * Nothing here is ever `native` on the strength of a partial implementation, a
 * prefix the emitted CSS does not use, a flag, a BCD note nobody reviewed, or
 * another feature's statement.
 */

import { caveatDisposition, inapplicability } from './catalog';
import { compatData } from './data';
import { compareVersions, parseVersion } from './versions';

export const STATES = Object.freeze([
  'native',
  'transformed-with-proof',
  'equivalent-fallback',
  'incompatible',
  'unknown',
]);

export const REASONS = Object.freeze([
  'full-support-at-floor',
  'support-after-floor',
  'no-support',
  'prefixed-only',
  'flagged-only',
  'alternative-name-only',
  'partial-implementation',
  'reviewed-partial',
  'platform-inapplicable',
  'unreviewed-caveat',
  'blocking-caveat',
  'removed-before-latest',
  'no-data',
  'ranged-data',
  'preview-only',
  'engine-not-in-data',
  'unrecognized-construct',
  'obsolete-engine',
  'platform-scoped',
  'invalid-combination',
  'transformation-proven',
  'equivalent-proven',
]);

export const BASES = Object.freeze([
  'catalog',
  'compat-data',
  'derived-from-electron',
  'executed',
  'executed-simulator',
]);

// Worst-first severity used to summarize engines and combinations.
const SEVERITY = Object.freeze({
  native: 0,
  'transformed-with-proof': 1,
  'equivalent-fallback': 2,
  unknown: 3,
  incompatible: 4,
});

/**
 * A committed review applies only from its `effectiveFrom` floor; below it the
 * note counts as unreviewed (fail closed). A review naming `properties`
 * accepts only records scoped to one of them; any other scoped property is
 * refused on that engine.
 */
function applicableReview(review, floor, scope = null) {
  if (review == null) return null;
  if (
    review.effectiveFrom != null &&
    compareVersions(
      floor,
      String(review.effectiveFrom).split('.').map(Number),
    ) < 0
  ) {
    return null;
  }
  if (Array.isArray(review.properties) && scope?.property != null) {
    if (!review.properties.includes(scope.property)) {
      return { ...review, disposition: 'blocking' };
    }
  }
  return review;
}

/** A review that can make a partial statement native. */
function isPartialReview(review) {
  return (
    review != null &&
    review.partial === true &&
    typeof review.missing === 'string' &&
    review.missing.trim() !== '' &&
    typeof review.rationale === 'string' &&
    review.rationale.trim() !== ''
  );
}

export function worseState(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

function matchesName(statement, match) {
  return (
    (statement.x ?? null) === (match?.prefix ?? null) &&
    (statement.n ?? null) === (match?.alternativeName ?? null)
  );
}

function appliesAt(statement, floor) {
  const added = parseVersion(statement.a);
  if (added.kind === 'release' && compareVersions(added.parts, floor) > 0) {
    return false;
  }
  if (added.kind === 'ranged' && compareVersions(added.parts, floor) > 0) {
    return false;
  }
  if (added.kind !== 'release' && added.kind !== 'ranged') return false;
  if (statement.r != null) {
    const removed = parseVersion(statement.r);
    if (
      removed.kind === 'release' &&
      compareVersions(removed.parts, floor) <= 0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * One engine at one target range, from the statements of ONE BCD path.
 *
 * `range` is `{ floor, upTo }`: `upTo` null means every later release.
 * `reviews` resolves a caveat disposition; it defaults to the committed
 * catalog reviews and is injectable for tests.
 */
export function statementOutcome({
  path,
  engine,
  statements,
  match = null,
  range,
  scope = null,
  reviews = caveatDisposition,
}) {
  const basis = 'compat-data';
  if (statements == null) {
    return {
      state: 'unknown',
      reason: 'engine-not-in-data',
      basis,
      caveats: [],
    };
  }
  const floor = String(range.floor).split('.').map(Number);
  const named = statements.filter((s) => matchesName(s, match));
  const full = named.filter((s) => s.f == null && s.p == null);

  const fullAtFloor = full.find((s) => appliesAt(s, floor));
  if (fullAtFloor != null) {
    if (fullAtFloor.r != null) {
      const removed = parseVersion(fullAtFloor.r);
      const limit =
        range.upTo == null ? null : String(range.upTo).split('.').map(Number);
      if (
        removed.kind === 'release' &&
        (limit == null || compareVersions(removed.parts, limit) <= 0)
      ) {
        return {
          state: 'incompatible',
          reason: 'removed-before-latest',
          basis,
          caveats: [],
        };
      }
    }
    if (fullAtFloor.t != null) {
      const review = applicableReview(
        reviews(path, engine, fullAtFloor.t),
        floor,
        scope,
      );
      const caveat = {
        path,
        engine,
        note: fullAtFloor.t,
        disposition: review?.disposition ?? 'unreviewed',
      };
      if (review == null) {
        return {
          state: 'unknown',
          reason: 'unreviewed-caveat',
          basis,
          caveats: [caveat],
        };
      }
      if (review.disposition === 'blocking') {
        return {
          state: 'incompatible',
          reason: 'blocking-caveat',
          basis,
          caveats: [caveat],
        };
      }
      return {
        state: 'native',
        reason: 'full-support-at-floor',
        basis,
        caveats: [caveat],
      };
    }
    return {
      state: 'native',
      reason: 'full-support-at-floor',
      basis,
      caveats: [],
    };
  }

  // A partial implementation is native only with a committed partial review
  // (`partial: true`) that names the missing sub-behavior (`missing`) and why
  // the emitted use does not depend on it (`rationale`). Otherwise, including
  // under a plain note review, it is `unknown`; a blocking review refuses it.
  const partialAtFloor = named.find(
    (s) => s.p != null && s.f == null && appliesAt(s, floor),
  );
  if (partialAtFloor != null) {
    const candidate =
      partialAtFloor.t == null
        ? null
        : applicableReview(
            reviews(path, engine, partialAtFloor.t),
            floor,
            scope,
          );
    const review = isPartialReview(candidate) ? candidate : null;
    const caveat = {
      path,
      engine,
      note: partialAtFloor.t ?? null,
      partial: true,
      disposition: review == null ? 'unreviewed' : review.disposition,
      ...(review == null ? {} : { missing: review.missing }),
    };
    if (review == null) {
      return {
        state: 'unknown',
        reason: 'partial-implementation',
        basis,
        caveats: [caveat],
      };
    }
    if (review.disposition === 'blocking') {
      return {
        state: 'incompatible',
        reason: 'blocking-caveat',
        basis,
        caveats: [caveat],
      };
    }
    if (partialAtFloor.r != null) {
      // Support has to continue: a full statement must take over no later
      // than the partial one ends.
      const removed = parseVersion(partialAtFloor.r);
      const continued = full.some((s) => {
        const added = parseVersion(s.a);
        return (
          added.kind === 'release' &&
          removed.kind === 'release' &&
          compareVersions(added.parts, removed.parts) <= 0
        );
      });
      if (!continued) {
        return {
          state: 'incompatible',
          reason: 'removed-before-latest',
          basis,
          caveats: [caveat],
        };
      }
    }
    return {
      state: 'native',
      reason: 'reviewed-partial',
      basis,
      caveats: [caveat],
    };
  }

  // Not native at the floor. Name the most specific reason.
  const fullLater = full.some((s) => {
    const added = parseVersion(s.a);
    return added.kind === 'release' && compareVersions(added.parts, floor) > 0;
  });
  if (fullLater) {
    return {
      state: 'incompatible',
      reason: 'support-after-floor',
      basis,
      caveats: [],
    };
  }
  const fullRanged = full.some((s) => parseVersion(s.a).kind === 'ranged');
  if (fullRanged) {
    return { state: 'unknown', reason: 'ranged-data', basis, caveats: [] };
  }
  if (named.some((s) => s.f != null && appliesAt(s, floor))) {
    return {
      state: 'incompatible',
      reason: 'flagged-only',
      basis,
      caveats: [],
    };
  }
  const applicableOther = statements.filter(
    (s) => !matchesName(s, match) && appliesAt(s, floor),
  );
  if (applicableOther.some((s) => s.x != null)) {
    return {
      state: 'incompatible',
      reason: 'prefixed-only',
      basis,
      caveats: [],
    };
  }
  if (applicableOther.some((s) => s.n != null)) {
    return {
      state: 'incompatible',
      reason: 'alternative-name-only',
      basis,
      caveats: [],
    };
  }
  if (named.some((s) => s.a === 'preview')) {
    return { state: 'unknown', reason: 'preview-only', basis, caveats: [] };
  }
  if (named.some((s) => s.a === true || s.a == null)) {
    return { state: 'unknown', reason: 'no-data', basis, caveats: [] };
  }
  if (named.some((s) => s.r != null && parseVersion(s.r).kind === 'release')) {
    return { state: 'incompatible', reason: 'no-support', basis, caveats: [] };
  }
  if (statements.every((s) => s.a === false)) {
    return { state: 'incompatible', reason: 'no-support', basis, caveats: [] };
  }
  if (statements.some((s) => s.a === 'preview')) {
    return { state: 'unknown', reason: 'preview-only', basis, caveats: [] };
  }
  if (named.length === 0) {
    return { state: 'incompatible', reason: 'no-support', basis, caveats: [] };
  }
  return { state: 'unknown', reason: 'no-data', basis, caveats: [] };
}

/**
 * The outcome of one catalog record on one resolved engine target.
 *
 * `target` is `{ engine, floor, upTo, basis, dataEngine, platform }` from the
 * resolution record; `dataEngine` is the BCD browser whose statements apply
 * (`chrome` for an Electron-derived target).
 */
export function featureOutcome(
  record,
  target,
  { data = compatData(), reviews } = {},
) {
  const base = {
    feature: record.feature,
    engine: target.engine,
    floor: target.floor,
    proof: null,
    caveats: [],
  };
  if (!record.recognized) {
    return {
      ...base,
      state: 'unknown',
      reason: 'unrecognized-construct',
      basis: 'catalog',
    };
  }
  if (record.fixed != null) {
    return { ...base, ...record.fixed, basis: 'catalog' };
  }
  if (record.kind === 'platform' && target.platform !== record.platform) {
    return {
      ...base,
      state: 'incompatible',
      reason: 'platform-scoped',
      basis: 'catalog',
    };
  }
  if (record.kind === 'combination' && record.bcd.length === 0) {
    // Never better than any component; the components are evaluated where
    // they are emitted, so the combination itself only adds its restriction.
    return {
      ...base,
      state: 'native',
      reason: 'full-support-at-floor',
      basis: 'catalog',
      restriction: record.restriction ?? null,
    };
  }
  if (record.bcd.length === 0) {
    return { ...base, state: 'unknown', reason: 'no-data', basis: 'catalog' };
  }
  let worst = null;
  for (const { path, match } of record.bcd) {
    const entry = data.entry(path);
    const engineKey = target.dataEngine ?? target.engine;
    const outcome = statementOutcome({
      path,
      engine: engineKey,
      statements: entry?.e?.[engineKey],
      match,
      range: target,
      scope: record.scope ?? null,
      reviews,
    });
    if (
      target.basis === 'derived-from-electron' &&
      outcome.basis === 'compat-data'
    ) {
      outcome.basis = 'derived-from-electron';
    }
    if (worst == null || SEVERITY[outcome.state] > SEVERITY[worst.state]) {
      worst = { ...outcome, path };
    } else {
      worst.caveats = [...worst.caveats, ...outcome.caveats];
    }
  }
  // A transform-table pair: where the base form is not acceptable, the
  // emitted variant carries the declaration if its own statements are native
  // at this floor. The proof is the committed table entry (transforms.js).
  if (
    record.transform != null &&
    (worst.state === 'incompatible' || worst.state === 'unknown')
  ) {
    const engineKey = target.dataEngine ?? target.engine;
    const variantNative = record.bcd.every(({ path }) => {
      const entry = data.entry(path);
      return (
        statementOutcome({
          path,
          engine: engineKey,
          statements: entry?.e?.[engineKey],
          match: { prefix: record.transform.prefix },
          range: target,
          scope: record.scope ?? null,
          reviews,
        }).state === 'native'
      );
    });
    if (variantNative) {
      return {
        ...base,
        ...worst,
        state: 'transformed-with-proof',
        reason: 'transformation-proven',
        basis:
          target.basis === 'derived-from-electron'
            ? 'derived-from-electron'
            : 'compat-data',
        proof: {
          transform: record.transform.id,
          kind: record.transform.kind,
          variant: record.transform.variant,
          data: { state: worst.state, reason: worst.reason },
        },
      };
    }
  }
  // Reviewed platform inapplicability turns a non-native answer into an
  // equivalent: "no effect" is what the platform correctly does.
  if (worst.state === 'incompatible' || worst.state === 'unknown') {
    const entry = inapplicability(record.feature, target.engine);
    if (entry != null) {
      return {
        ...base,
        ...worst,
        state: 'equivalent-fallback',
        reason: 'platform-inapplicable',
        basis: 'catalog',
        equivalent: {
          kind: 'no-effect',
          review: entry.reason,
          data: { state: worst.state, reason: worst.reason },
        },
      };
    }
  }
  return { ...base, ...worst };
}

/** The worst engine state of a feature on a profile. */
export function summarize(outcomes) {
  return outcomes.reduce(
    (state, outcome) => worseState(state, outcome.state),
    'native',
  );
}
