/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Gate method of benchmarks/agentic/baseline/POLICY.md section 5
// (baseline/stats.mjs): monotonicity under contested, missing, retried and
// unknown observations, finite-sample calibration, determinism, unclean
// reference repetitions. Includes the reproductions of review r1 (R1-R3)
// and r2 (R5).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUND,
  GATES,
  MAX_DROPPED_REFERENCE_PER,
  MIN_CLEAN_REFERENCE_PER_TASK,
  OUTCOMES,
  decideGate,
  minimumDetectable,
  latencyCuts,
  normalizeLatency,
  orient,
  permutationTest,
  referenceEvidence,
  seededRandom,
} from '../baseline/stats.mjs';
import { lowerBound, simulate, upperBound } from '../baseline/simulate.mjs';

const ok = { clean: true, value: 0 };
const fail = { clean: true, value: 1 };
const contested = { clean: false };
const missing = { clean: false };
const val = (value) => ({ clean: true, value });
const unknown = { clean: false };

const units = (reference, candidate) =>
  reference.map((r, i) => ({ reference: r, candidate: candidate[i] }));
const decide = (gate, reference, candidate, opts = {}) =>
  decideGate({ gate, model: 'm', units: units(reference, candidate), ...opts });
const p = (gate, reference, candidate, opts = {}) =>
  decide(gate, reference, candidate, opts).pValue;
// pass < insufficient-reference < block: a higher rank is a worse outcome.
const rank = (d) => OUTCOMES.indexOf(d.outcome);
// A candidate degradation never improves the outcome, never raises a decided
// p-value, and never changes the reference accounting.
function assertCandidateMonotone(before, after, what) {
  assert.ok(
    rank(after) >= rank(before),
    `${what}: ${before.outcome} -> ${after.outcome}`,
  );
  if (before.pValue != null && after.pValue != null)
    assert.ok(
      after.pValue <= before.pValue + 1e-12,
      `${what}: p ${before.pValue} -> ${after.pValue}`,
    );
  assert.deepEqual(after.reference, before.reference, `${what}: reference`);
}

// ---------------------------------------------------------------- R1

test('R1 review reproduction (25 tasks): failures turned into contested retry successes keep the block', () => {
  // Every baseline repetition succeeds, one per task after a retry on 7
  // tasks (the most the 75 planned repetitions allow); the candidate fails
  // once on each of 15 tasks.
  const reference = Array.from({ length: 25 }, (_, t) => [
    t < 7 ? contested : ok,
    ok,
    ok,
  ]);
  const honest = reference.map((_, t) => [t < 15 ? fail : ok, ok, ok]);
  const forged = reference.map((_, t) => [t < 15 ? contested : ok, ok, ok]);
  const a = decide('success.application', reference, honest);
  const b = decide('success.application', reference, forged);
  assert.equal(b.pValue, a.pValue);
  assert.equal(a.outcome, 'block');
  assert.equal(b.outcome, 'block');
  // The review's baseline (a retry on every task: 25 of 75 dropped) is not
  // enough reference evidence; forging changes nothing there either.
  const all = reference.map(() => [contested, ok, ok]);
  assert.equal(
    decide('success.application', all, honest).outcome,
    'insufficient-reference',
  );
  assert.equal(
    decide('success.application', all, forged).outcome,
    'insufficient-reference',
  );
});

test('R1 review reproduction: a failure turned into a contested retry success never changes the decision', () => {
  // 7 report tasks; the baseline is 21/21 with one contested success.
  const reference = Array.from({ length: 7 }, (_, t) => [
    t === 0 ? contested : ok,
    ok,
    ok,
  ]);
  const failures = [2, 1, 1, 1, 1, 1, 1]; // honest candidate: 13/21
  const honest = failures.map((f) => [0, 1, 2].map((i) => (i < f ? fail : ok)));
  const forged = honest.map((r) => [...r]);
  forged[0][0] = contested; // the retry "succeeded"
  const a = decideGate({
    gate: 'success.report',
    model: 'm',
    units: units(reference, honest),
  });
  const b = decideGate({
    gate: 'success.report',
    model: 'm',
    units: units(reference, forged),
  });
  assert.equal(a.pValue, b.pValue);
  assert.equal(a.outcome, b.outcome);
  // One statistic decides: there is no second (point) comparison.
  assert.deepEqual(Object.keys(a).sort(), [
    'alpha',
    'blocks',
    'gate',
    'method',
    'model',
    'observed',
    'outcome',
    'pValue',
    'passes',
    'reference',
  ]);
});

// Statuses of one repetition and the degradations that must never help the
// candidate: a success failing, any repetition becoming contested (a retry),
// missing (an omitted or discarded attempt).
const STATUSES = { ok, fail, contested, missing };
const WORSE = {
  ok: ['fail', 'contested', 'missing'],
  fail: ['contested', 'missing'],
  contested: ['missing'],
  missing: [],
};
const isClean = (k) => k === 'ok' || k === 'fail';

function* patterns(n) {
  const keys = Object.keys(STATUSES);
  for (let i = 0; i < keys.length ** n; i += 1) {
    const out = [];
    let x = i;
    for (let j = 0; j < n; j += 1) {
      out.push(keys[x % keys.length]);
      x = Math.floor(x / keys.length);
    }
    yield out;
  }
}

test('R1 class: every success-type outcome is monotone in the candidate, exhaustively over one task (3 + 3 repetitions)', () => {
  // The varying task sits beside 10 clean tasks, so that up to three of its
  // reference repetitions may be dropped (the cap) and every outcome occurs.
  // Alone, the context is just short of blocking (p = 0.0025).
  const ctxRef = Array.from({ length: 10 }, () => [ok, ok, ok]);
  const ctxCand = Array.from({ length: 10 }, (_, t) => [
    t < 6 ? fail : ok,
    t < 2 ? fail : ok,
    ok,
  ]);
  const run = (ref, cand) =>
    decide(
      'success.application',
      [ref.map((k) => STATUSES[k]), ...ctxRef],
      [cand.map((k) => STATUSES[k]), ...ctxCand],
    );
  const seen = new Set();
  let checked = 0;
  for (const pat of patterns(6)) {
    const ref = pat.slice(0, 3);
    const cand = pat.slice(3);
    const base = run(ref, cand);
    seen.add(base.outcome);
    // Fewer than two clean reference repetitions: insufficient, whatever
    // the candidate.
    assert.equal(
      base.outcome === 'insufficient-reference',
      ref.filter(isClean).length < MIN_CLEAN_REFERENCE_PER_TASK,
    );
    if (base.pValue != null) {
      // An unclean reference repetition is removed, never imputed.
      const clean = ref.filter(isClean).map((k) => STATUSES[k].value);
      const direct = permutationTest({
        strata: [
          {
            reference: clean,
            candidate: cand.map((k) => (isClean(k) ? STATUSES[k].value : 1)),
          },
          ...ctxRef.map((r, t) => ({
            reference: r.map((x) => x.value),
            candidate: ctxCand[t].map((x) => x.value),
          })),
        ],
        design: 'between-runs',
        integer: true,
      });
      assert.equal(base.pValue, direct.pValue);
    }
    for (let i = 0; i < 3; i += 1) {
      for (const w of WORSE[cand[i]]) {
        const c2 = [...cand];
        c2[i] = w;
        assertCandidateMonotone(
          base,
          run(ref, c2),
          `${cand} -> ${c2} vs ${ref}`,
        );
        checked += 1;
      }
      // A reference failure becoming unclean never loosens the gate.
      if (ref[i] === 'fail')
        for (const w of ['contested', 'missing']) {
          const r2 = [...ref];
          r2[i] = w;
          const q = run(r2, cand);
          if (q.pValue != null)
            assert.ok(
              q.pValue <= base.pValue + 1e-12,
              `${ref} -> ${r2} vs ${cand}`,
            );
          checked += 1;
        }
    }
  }
  assert.deepEqual([...seen].sort(), [...OUTCOMES].sort());
  assert.ok(checked > 8000, `${checked} transitions`);
});

test('R1 class: monotone over random multi-task success patterns (seeded property test)', () => {
  const rand = seededRandom('r1-property');
  const keys = Object.keys(STATUSES);
  const pick = () => keys[Math.floor(rand() * keys.length)];
  // Reference repetitions are mostly clean, so that every outcome occurs.
  const pickRef = () => (rand() < 0.08 ? pick() : rand() < 0.7 ? 'ok' : 'fail');
  const seen = new Set();
  for (let n = 0; n < 400; n += 1) {
    const tasks = 2 + Math.floor(rand() * 24);
    const ref = Array.from({ length: tasks }, () => [
      pickRef(),
      pickRef(),
      pickRef(),
    ]);
    const cand = Array.from({ length: tasks }, () => [pick(), pick(), pick()]);
    const map = (x) => x.map((r) => r.map((k) => STATUSES[k]));
    const base = decide('success.critical', map(ref), map(cand));
    seen.add(base.outcome);
    const t = Math.floor(rand() * tasks);
    const i = Math.floor(rand() * 3);
    for (const w of WORSE[cand[t][i]]) {
      const c2 = cand.map((r) => [...r]);
      c2[t][i] = w;
      assertCandidateMonotone(
        base,
        decide('success.critical', map(ref), map(c2)),
        'candidate',
      );
    }
    // Many degradations at once.
    const c3 = cand.map((r) =>
      r.map((k) =>
        rand() < 0.3 && WORSE[k].length
          ? WORSE[k][Math.floor(rand() * WORSE[k].length)]
          : k,
      ),
    );
    assertCandidateMonotone(
      base,
      decide('success.critical', map(ref), map(c3)),
      'candidate (many)',
    );
    if (ref[t][i] === 'fail') {
      const r2 = ref.map((r) => [...r]);
      r2[t][i] = 'contested';
      const q = decide('success.critical', map(r2), map(cand));
      if (q.pValue != null && base.pValue != null)
        assert.ok(q.pValue <= base.pValue + 1e-12, 'reference failure dropped');
    }
  }
  assert.equal(seen.size, 3, [...seen].join());
});

// ---------------------------------------------------------------- R2

test('R2 review reproduction: hiding the expensive observations never improves the context gate', () => {
  // 44 tasks; baseline tokens [100, 100, 200]; the candidate's true values
  // are [100, 100, 1e6] on 10 tasks, the baseline's elsewhere.
  const L = Math.log;
  const reference = Array.from({ length: 44 }, () => [
    val(L(100)),
    val(L(100)),
    val(L(200)),
  ]);
  const truth = reference.map((r, t) =>
    t < 10 ? [val(L(100)), val(L(100)), val(L(1e6))] : [...r],
  );
  const hidden = truth.map((r, t) => (t < 10 ? [r[0], r[1], unknown] : r));
  const a = decideGate({
    gate: 'context.input',
    model: 'm',
    units: units(reference, truth),
  });
  const b = decideGate({
    gate: 'context.input',
    model: 'm',
    units: units(reference, hidden),
  });
  assert.ok(b.pValue <= a.pValue, `${b.pValue} <= ${a.pValue}`);
  assert.equal(a.blocks, true, 'the complete data block');
  assert.equal(b.blocks, true, 'the selectively hidden data block too');
});

test('R2 class: hiding any subset of observations (unknown, missing cell, discarded attempt) never improves a cost or latency gate', () => {
  const rand = seededRandom('r2-property');
  for (const gate of [
    'context.input',
    'repair.cycles',
    'latency.p50',
    'latency.p95',
  ]) {
    const g = GATES[gate];
    const value = () =>
      g.scale === 'count'
        ? Math.floor(rand() * 4)
        : 8 + 3 * rand() + (rand() < 0.1 ? 4 : 0);
    for (let n = 0; n < 40; n += 1) {
      const strata = g.design === 'paired' ? 30 : 2 + Math.floor(rand() * 20);
      const reps = g.design === 'paired' ? 1 : 3;
      const ref = Array.from({ length: strata }, () =>
        Array.from({ length: reps }, () => val(value())),
      );
      const cand = Array.from({ length: strata }, () =>
        Array.from({ length: reps }, () => val(value())),
      );
      const opts = { draws: 499, cuts: { p50: 9.5, p95: 11.5 } };
      const base = p(gate, ref, cand, opts);
      // Candidate side: hide a random subset, sometimes a whole cell.
      const c2 = cand.map((r) =>
        rand() < 0.1
          ? r.map(() => missing)
          : r.map((x) => (rand() < 0.2 ? unknown : x)),
      );
      assert.ok(p(gate, ref, c2, opts) <= base + 1e-12, `${gate} candidate`);
    }
  }
});

test('R2 class: a worse candidate value never helps, draw by draw (Monte Carlo gates too)', () => {
  const rand = seededRandom('r2-monotone');
  for (let n = 0; n < 60; n += 1) {
    const ref = Array.from({ length: 12 }, () =>
      [0, 1, 2].map(() => 9 + rand()),
    );
    const cand = Array.from({ length: 12 }, () =>
      [0, 1, 2].map(() => 9 + rand()),
    );
    const t = Math.floor(rand() * 12);
    const i = Math.floor(rand() * 3);
    const run = (c) =>
      permutationTest({
        strata: ref.map((r, k) => ({ reference: r, candidate: c[k] })),
        design: 'between-runs',
        integer: false,
        draws: 999,
        seed: `case-${n}`,
      }).pValue;
    const worse = cand.map((r) => [...r]);
    worse[t][i] += rand() * 3;
    assert.ok(run(worse) <= run(cand));
  }
});

// ---------------------------------------------------------------- R3

test('R3 review reproduction: a zero-variance baseline never blocks one rare repair', () => {
  // Repairs with probability 0.001, 25 tasks x 3; an all-zero baseline.
  const zero = Array.from({ length: 25 }, () => [val(0), val(0), val(0)]);
  const one = zero.map((r, t) => (t === 0 ? [val(1), val(0), val(0)] : r));
  const d = decideGate({
    gate: 'repair.cycles',
    model: 'm',
    units: units(zero, one),
  });
  assert.equal(d.method, 'exact');
  assert.equal(d.blocks, false);
  assert.ok(Math.abs(d.pValue - 0.5) < 1e-12);
  // A single repair on each of 3 tasks: P = 2^-3, far from blocking.
  const three = zero.map((r, t) => (t < 3 ? [val(1), val(0), val(0)] : r));
  assert.equal(
    decideGate({ gate: 'repair.cycles', model: 'm', units: units(zero, three) })
      .blocks,
    false,
  );
});

test('R3 class: identical values in a stratum carry no evidence either way', () => {
  for (const scale of ['binary', 'count']) {
    const gate = scale === 'binary' ? 'success.application' : 'repair.cycles';
    const same = Array.from({ length: 10 }, () => [val(1), val(1), val(1)]);
    assert.equal(p(gate, same, same), 1);
  }
});

test('R3 class: false-block rate of an unchanged candidate stays within the advertised bound (quick simulation)', () => {
  const out = simulate({ sims: 400, mcSims: 40, draws: 999 });
  assert.equal(out.results.length, 14);
  assert.deepEqual(out.sizeViolations, []);
  // Unclean reference repetitions (review r2, R5): the review's 10 where
  // the cap allows them, and the outcome-dependent stress cases, reported.
  const r5 = out.results.filter((r) => r.uncleanReference);
  assert.equal(r5.length, 6);
  assert.ok(r5.some((r) => r.uncleanReference.count === 10));
  assert.ok(Array.isArray(out.stressViolations));
  for (const id of out.stressViolations)
    assert.ok(out.results.find((r) => r.id === id).stress, id);
  for (const r of out.results)
    assert.ok(
      r.falseBlocks.upper95 >= r.falseBlocks.rate &&
        r.falseBlocks.lower95 <= r.falseBlocks.rate,
    );
  assert.ok(upperBound(0, 2000) < 0.0015);
  assert.ok(Math.abs(upperBound(5, 100) - 0.1023) < 0.001);
  // No underflow at large n (review r1 scale).
  assert.ok(Math.abs(upperBound(932, 20000) - 0.0485) < 0.001);
  assert.ok(Math.abs(lowerBound(932, 20000) - 0.0447) < 0.001);
});

test('R3 class: the method is deterministic (fixed seeds) and refuses values outside its scale', () => {
  const ref = Array.from({ length: 8 }, (_, t) => [
    val(9),
    val(9.5 + t / 10),
    val(10),
  ]);
  const cand = ref.map((r) => r.map((x) => val(x.value + 0.2)));
  const a = decideGate({
    gate: 'context.input',
    model: 'claude-haiku',
    units: units(ref, cand),
  });
  const b = decideGate({
    gate: 'context.input',
    model: 'claude-haiku',
    units: units(ref, cand),
  });
  assert.equal(a.method, 'monte-carlo');
  assert.equal(a.pValue, b.pValue);
  assert.throws(
    () => orient(val(0.5), 'candidate', 'binary'),
    /not an integer/,
  );
  assert.throws(() => orient(val(2), 'candidate', 'binary'), /outside/);
  assert.throws(() => orient(val(BOUND), 'candidate', 'log'), /outside/);
  assert.throws(() => orient(val(NaN), 'candidate', 'log'), /finite/);
  assert.throws(() => orient({ clean: true }, 'reference', 'count'), /finite/);
});

test('the minimum detectable regression is stated from the baseline alone', () => {
  const ref = Array.from({ length: 25 }, () => [ok, ok, ok]);
  const m = minimumDetectable({
    gate: 'success.application',
    model: 'm',
    reference: ref,
  });
  assert.ok(m.successesDropped > 0 && m.successesDropped < 75);
  const tiny = Array.from({ length: 7 }, () => [ok, ok, ok]);
  assert.ok(
    minimumDetectable({ gate: 'success.report', model: 'm', reference: tiny })
      .successesDropped > 1,
  );
  const counts = Array.from({ length: 25 }, () => [val(0), val(1), val(0)]);
  assert.equal(
    typeof minimumDetectable({
      gate: 'repair.cycles',
      model: 'm',
      reference: counts,
    }).cyclesAddedPerRepetition,
    'number',
  );
});

test('a quantile ratio is not monotone under the swap test, so the latency gates count exceedances of frozen cuts', () => {
  // Executed counterexample (nearest-rank p75 of four pairs).
  const q = (x) => [...x].sort((a, b) => a - b)[Math.ceil(0.75 * x.length) - 1];
  const pv = (c, a) => {
    const t = q(c) - q(a);
    let n = 0;
    for (let m = 0; m < 16; m += 1) {
      const c2 = c.map((v, i) => ((m >> i) & 1 ? a[i] : v));
      const a2 = a.map((v, i) => ((m >> i) & 1 ? c[i] : v));
      if (q(c2) - q(a2) >= t) n += 1;
    }
    return n / 16;
  };
  const a = [4, 2, 4, 2];
  assert.ok(
    pv([1, 4, 4, 4], a) > pv([1, 4, 4, 3], a),
    'slower, yet a larger p',
  );
  assert.deepEqual(
    Object.keys(GATES).filter((g) => g.startsWith('latency')),
    ['latency.p50', 'latency.p95'],
  );
});

test('latency gates: frozen cuts from the baseline alone; a slowdown against the control blocks, an unchanged candidate does not', () => {
  const rand = seededRandom('latency');
  const tasks = Array.from({ length: 44 }, (_, t) => `t${t}`);
  const base = Object.fromEntries(
    tasks.map((t, i) => [
      t,
      [0, 1, 2].map(() => val(3 + (i % 5) * 0.3 + 0.3 * rand())),
    ]),
  );
  base.t0[1] = contested; // excluded from the cuts
  const { medians, cuts } = latencyCuts(base);
  assert.ok(cuts.p95 > cuts.p50);
  assert.equal(Object.keys(medians).length, 44);
  const pairs = (shift) =>
    tasks.flatMap((t, i) =>
      [0, 1, 2].map(() => {
        const x = 3 + (i % 5) * 0.3 + 0.3 * rand();
        return {
          reference: [normalizeLatency(val(x), t, medians)],
          candidate: [normalizeLatency(val(x + shift), t, medians)],
        };
      }),
    );
  const same = decideGate({
    gate: 'latency.p50',
    model: 'm',
    units: pairs(0),
    cuts,
  });
  assert.equal(same.blocks, false);
  assert.equal(same.method, 'exact');
  const slower = decideGate({
    gate: 'latency.p50',
    model: 'm',
    units: pairs(0.3),
    cuts,
  });
  assert.equal(slower.blocks, true);
  // A missing candidate attempt exceeds every cut; a missing control is
  // dropped with its pair, never bounded.
  assert.equal(
    orient(normalizeLatency(missing, 't1', medians), 'candidate', 'log') >
      cuts.p95,
    true,
  );
  assert.throws(
    () => orient(normalizeLatency(missing, 't1', medians), 'reference', 'log'),
    /dropped, never bounded/,
  );
  assert.throws(
    () => normalizeLatency(val(1), 'unknown-task', medians),
    /no frozen median/,
  );
  assert.throws(
    () => decideGate({ gate: 'latency.p95', model: 'm', units: pairs(0) }),
    /frozen cut/,
  );
});

// ---------------------------------------------------------------- R5

// One gate of each class, with a planned reference shape like the baseline.
const CLASSES = [
  {
    gate: 'success.application',
    tasks: 25,
    reps: 3,
    value: (r) => (r() < 0.6 ? 0 : 1),
  },
  { gate: 'safety', tasks: 44, reps: 3, value: (r) => (r() < 0.9 ? 0 : 1) },
  {
    gate: 'repair.cycles',
    tasks: 25,
    reps: 3,
    value: (r) => Math.floor(r() * r() * 4),
  },
  { gate: 'context.input', tasks: 44, reps: 3, value: (r) => 9 + 2 * r() },
  { gate: 'latency.p50', tasks: 132, reps: 1, value: (r) => r() - 0.5 },
  { gate: 'latency.p95', tasks: 132, reps: 1, value: (r) => r() - 0.3 },
];
const CUTS = { p50: 0, p95: 0.6 };
const opts = { cuts: CUTS, draws: 999 };

test('R5 review reproduction: unclean reference repetitions never block an identical candidate, in every gate class', () => {
  for (const { gate, tasks, reps } of CLASSES) {
    const binary = GATES[gate].scale === 'binary';
    const value = (t) =>
      binary
        ? t < 10
          ? 1
          : 0
        : gate === 'context.input'
          ? Math.log(100)
          : gate.startsWith('latency')
            ? 2
            : 1;
    const make = () =>
      Array.from({ length: tasks }, (_, t) =>
        Array.from({ length: reps }, () => val(value(t))),
      );
    const ref = make();
    const clean = decide(gate, ref, make(), opts);
    assert.equal(clean.outcome, 'pass', gate);
    // The review's 10 unclean reference repetitions, then the most the cap
    // allows, then one more.
    const cap = Math.floor((tasks * reps) / MAX_DROPPED_REFERENCE_PER);
    for (const k of [10, cap, cap + 1]) {
      const r2 = ref.map((r, t) =>
        t < k ? [{ clean: false, value: value(t) }, ...r.slice(1)] : r,
      );
      const d = decide(gate, r2, make(), opts);
      assert.equal(d.blocks, false, `${gate} k=${k}`);
      assert.equal(
        d.outcome,
        k <= cap ? 'pass' : 'insufficient-reference',
        `${gate} k=${k}`,
      );
      assert.equal(d.reference.dropped, k);
      if (d.outcome === 'pass')
        assert.equal(d.pValue, clean.pValue, `${gate} k=${k}`);
      else assert.equal(d.passes, false);
    }
  }
  // A candidate using 100x fewer tokens passes against a contaminated
  // baseline (the review's second case).
  const L = Math.log;
  const d = decide(
    'context.input',
    Array.from({ length: 44 }, (_, t) => [
      t < 10 ? { clean: false } : val(L(100)),
      val(L(100)),
      val(L(100)),
    ]),
    Array.from({ length: 44 }, () => [val(0), val(0), val(0)]),
  );
  assert.equal(d.outcome, 'pass');
  assert.equal(d.pValue, 1);
});

test('R5 class: the minimum clean reference evidence, per task, per gate and per pair', () => {
  assert.equal(MIN_CLEAN_REFERENCE_PER_TASK, 2);
  assert.equal(MAX_DROPPED_REFERENCE_PER, 10);
  const ref = Array.from({ length: 25 }, () => [ok, ok, fail]);
  const cand = Array.from({ length: 25 }, () => [fail, fail, fail]);
  // A task with one clean reference repetition: insufficient, listed.
  const one = ref.map((r, t) => (t === 3 ? [contested, missing, fail] : r));
  const d1 = decide('success.application', one, cand);
  assert.equal(d1.outcome, 'insufficient-reference');
  assert.deepEqual(d1.reference.insufficientStrata, [3]);
  assert.equal(d1.pValue, null);
  assert.equal(d1.passes, false);
  assert.equal(d1.blocks, false);
  // Two clean ones: decided, and here a block (a regressed candidate).
  const two = ref.map((r, t) => (t === 3 ? [contested, ok, fail] : r));
  assert.equal(decide('success.application', two, cand).outcome, 'block');
  // The per-gate cap: 7 of 75 dropped is decided, 8 is not.
  const drop = (k) => ref.map((r, t) => (t < k ? [missing, ...r.slice(1)] : r));
  const d7 = decide('success.application', drop(7), cand);
  assert.deepEqual(
    [
      d7.outcome,
      d7.reference.dropped,
      d7.reference.maxDropped,
      d7.reference.planned,
    ],
    ['block', 7, 7, 75],
  );
  assert.equal(
    decide('success.application', drop(8), cand).outcome,
    'insufficient-reference',
  );
  // Paired: a pair whose control is unclean is dropped, exactly as if it
  // had not been run; at most 13 of 132.
  const rand = seededRandom('r5-paired');
  const pairs = Array.from({ length: 132 }, () => ({
    reference: [val(rand() - 0.5)],
    candidate: [val(rand() - 0.2)],
  }));
  const dirty = pairs.map((u, i) =>
    i % 10 === 0 && i < 130 ? { ...u, reference: [contested] } : u,
  );
  const kept = pairs.filter((_, i) => !(i % 10 === 0 && i < 130));
  const a = decideGate({
    gate: 'latency.p50',
    model: 'm',
    units: dirty,
    cuts: CUTS,
  });
  const b = decideGate({
    gate: 'latency.p50',
    model: 'm',
    units: kept,
    cuts: CUTS,
  });
  assert.equal(a.reference.dropped, 13);
  assert.equal(a.pValue, b.pValue);
  assert.equal(a.outcome, b.outcome);
  const more = dirty.map((u, i) =>
    i === 1 ? { ...u, reference: [missing] } : u,
  );
  assert.equal(
    decideGate({ gate: 'latency.p50', model: 'm', units: more, cuts: CUTS })
      .outcome,
    'insufficient-reference',
  );
  // No clean control at all.
  assert.equal(
    referenceEvidence([{ reference: [missing] }], 'paired').sufficient,
    false,
  );
});

function randomCase(c, rand, uncleanShare) {
  const reps = () =>
    Array.from({ length: c.reps }, () =>
      rand() < uncleanShare ? { clean: false } : val(c.value(rand)),
    );
  return {
    ref: Array.from({ length: c.tasks }, () =>
      Array.from({ length: c.reps }, () =>
        rand() < uncleanShare / 3 ? { clean: false } : val(c.value(rand)),
      ),
    ),
    cand: Array.from({ length: c.tasks }, reps),
  };
}
// One candidate degradation: a worse value, or the repetition becoming
// unclean (missing, contested, retried, unknown).
function degrade(c, cand, rand) {
  const out = cand.map((r) => [...r]);
  for (let n = 1 + Math.floor(rand() * 4); n > 0; n -= 1) {
    const t = Math.floor(rand() * out.length);
    const i = Math.floor(rand() * out[t].length);
    const x = out[t][i];
    if (!x.clean || rand() < 0.5) out[t][i] = { clean: false };
    else if (GATES[c.gate].scale === 'binary') out[t][i] = val(1);
    else if (GATES[c.gate].scale === 'count')
      out[t][i] = val(x.value + 1 + Math.floor(rand() * 3));
    else out[t][i] = val(x.value + rand() * 2);
  }
  return out;
}

test('R5 class: reference accounting reads the reference alone, and every outcome is monotone in the candidate, in every gate class', () => {
  const rand = seededRandom('r5-monotone');
  for (const c of CLASSES) {
    const seen = new Set();
    for (let n = 0; n < 60; n += 1) {
      const { ref, cand } = randomCase(c, rand, [0, 0.1, 0.25][n % 3]);
      const base = decide(c.gate, ref, cand, opts);
      seen.add(base.outcome);
      // Another candidate entirely: the same reference accounting.
      const other = randomCase(c, rand, 0.3).cand;
      assert.deepEqual(
        decide(c.gate, ref, other, opts).reference,
        base.reference,
      );
      assertCandidateMonotone(
        base,
        decide(c.gate, ref, degrade(c, cand, rand), opts),
        c.gate,
      );
    }
    assert.ok(
      seen.has('pass') && seen.has('insufficient-reference'),
      `${c.gate}: ${[...seen]}`,
    );
  }
});

test('R5 class: a dropped reference failure never loosens a gate; a dropped success can, only within the minimums', () => {
  // Exact gates (binary, count, paired exceedances). Dropping a reference
  // value at least as bad as every value of its stratum, or a control that
  // exceeds the cut, never raises the p-value.
  const rand = seededRandom('r5-loosen');
  let loosened = 0;
  for (const c of CLASSES.filter((x) => x.gate !== 'context.input')) {
    const paired = GATES[c.gate].design === 'paired';
    for (let n = 0; n < 60; n += 1) {
      const { ref, cand } = randomCase(c, rand, 0);
      const base = decide(c.gate, ref, cand, opts);
      const cut = paired ? CUTS[GATES[c.gate].cut] : null;
      const worst = (t) =>
        paired
          ? ref[t][0].value > cut
            ? 0
            : -1
          : ref[t].findIndex(
              (x) =>
                x.value >=
                Math.max(
                  ...ref[t].map((y) => y.value),
                  ...cand[t].map((y) => y.value),
                ),
            );
      const best = (t) =>
        paired
          ? ref[t][0].value <= cut
            ? 0
            : -1
          : ref[t].findIndex(
              (x) =>
                x.value <=
                Math.min(
                  ...ref[t].map((y) => y.value),
                  ...cand[t].map((y) => y.value),
                ),
            );
      const dropAll = (pick) => {
        const r2 = ref.map((r) => [...r]);
        let k = 0;
        const cap = Math.floor((c.tasks * c.reps) / MAX_DROPPED_REFERENCE_PER);
        for (let t = 0; t < r2.length && k < cap; t += 1) {
          const i = pick(t);
          if (i >= 0) {
            r2[t][i] = { clean: false };
            k += 1;
          }
        }
        return decide(c.gate, r2, cand, opts);
      };
      const onFailures = dropAll(worst);
      assert.notEqual(onFailures.outcome, 'insufficient-reference');
      assert.ok(
        onFailures.pValue <= base.pValue + 1e-12,
        `${c.gate}: on failures`,
      );
      const onSuccesses = dropAll(best);
      assert.notEqual(onSuccesses.outcome, 'insufficient-reference');
      if (onSuccesses.pValue > base.pValue + 1e-12) loosened += 1;
    }
  }
  // The residual the policy states (section 5.1): reference contamination
  // concentrated on successes loosens, within the cap only.
  assert.ok(loosened > 0);
  // The candidate cannot reach it: dropping is decided by the reference.
  const ref = Array.from({ length: 25 }, () => [ok, ok, fail]);
  const r2 = ref.map((r, t) => (t < 8 ? [contested, ...r.slice(1)] : r));
  for (const cand of [
    ref,
    ref.map(() => [fail, fail, fail]),
    ref.map(() => [missing, missing, missing]),
  ])
    assert.equal(
      decide('success.application', r2, cand).outcome,
      'insufficient-reference',
    );
});

test('R5 class: an unclean reference repetition is never imputed, including in the stated minimum detectable regression', () => {
  assert.throws(
    () => orient(contested, 'reference', 'binary'),
    /dropped, never bounded/,
  );
  assert.throws(
    () => orient(missing, 'reference', 'count'),
    /dropped, never bounded/,
  );
  assert.equal(orient(missing, 'candidate', 'binary'), 1);
  const ref = Array.from({ length: 25 }, (_, t) => [
    t < 7 ? contested : ok,
    ok,
    t % 2 ? fail : ok,
  ]);
  const cleanOnly = ref.map((r) => r.filter((x) => x.clean));
  for (const gate of ['success.application', 'repair.cycles'])
    assert.deepEqual(
      minimumDetectable({ gate, model: 'm', reference: ref }),
      minimumDetectable({ gate, model: 'm', reference: cleanOnly }),
    );
  const short = ref.map((r, t) => (t === 0 ? [contested, missing, ok] : r));
  assert.deepEqual(
    minimumDetectable({
      gate: 'success.application',
      model: 'm',
      reference: short,
    }).insufficientReference.insufficientStrata,
    [0],
  );
});
