/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Gate method of benchmarks/agentic/baseline/POLICY.md section 5
// (baseline/stats.mjs): monotonicity under contested, missing, retried and
// unknown observations, finite-sample calibration, determinism. Includes the
// reproductions of review r1 (R1-R3).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOUND,
  GATES,
  decideGate,
  minimumDetectable,
  latencyCuts,
  normalizeLatency,
  orient,
  permutationTest,
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
const p = (gate, reference, candidate, opts = {}) =>
  decideGate({ gate, model: 'm', units: units(reference, candidate), ...opts })
    .pValue;

// ---------------------------------------------------------------- R1

test('R1 review reproduction (25 tasks): failures turned into contested retry successes keep the block', () => {
  // Every baseline repetition succeeds, one per task after a retry; the
  // candidate fails once on each of 15 tasks.
  const reference = Array.from({ length: 25 }, () => [contested, ok, ok]);
  const honest = reference.map((_, t) => [t < 15 ? fail : ok, ok, ok]);
  const forged = reference.map((_, t) => [t < 15 ? contested : ok, ok, ok]);
  const a = p('success.application', reference, honest);
  assert.equal(p('success.application', reference, forged), a);
  assert.ok(a < 0.00185, `blocks: ${a}`);
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
  assert.equal(a.blocks, b.blocks);
  // One statistic decides: there is no second (point) comparison.
  assert.deepEqual(Object.keys(a).sort(), [
    'alpha',
    'blocks',
    'gate',
    'method',
    'model',
    'observed',
    'pValue',
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
// On the reference side, contamination must never loosen the gate.
const CONTAMINATED = {
  ok: ['contested', 'missing'],
  fail: ['contested', 'missing'],
  contested: ['missing'],
  missing: ['contested'],
};

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

test('R1 class: every success-type decision is monotone, exhaustively over one task (3 + 3 repetitions)', () => {
  const tol = 1e-12;
  let checked = 0;
  for (const pat of patterns(6)) {
    const ref = pat.slice(0, 3);
    const cand = pat.slice(3);
    const base = p(
      'success.application',
      [ref.map((k) => STATUSES[k])],
      [cand.map((k) => STATUSES[k])],
    );
    for (let i = 0; i < 3; i += 1) {
      for (const w of WORSE[cand[i]]) {
        const c2 = [...cand];
        c2[i] = w;
        const q = p(
          'success.application',
          [ref.map((k) => STATUSES[k])],
          [c2.map((k) => STATUSES[k])],
        );
        assert.ok(q <= base + tol, `candidate ${cand} -> ${c2} vs ${ref}`);
        checked += 1;
      }
      for (const w of CONTAMINATED[ref[i]]) {
        const r2 = [...ref];
        r2[i] = w;
        const q = p(
          'success.application',
          [r2.map((k) => STATUSES[k])],
          [cand.map((k) => STATUSES[k])],
        );
        assert.ok(q <= base + tol, `reference ${ref} -> ${r2} vs ${cand}`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 20000, `${checked} transitions`);
});

test('R1 class: monotone over random multi-task success patterns (seeded property test)', () => {
  const rand = seededRandom('r1-property');
  const keys = Object.keys(STATUSES);
  const pick = () => keys[Math.floor(rand() * keys.length)];
  for (let n = 0; n < 400; n += 1) {
    const tasks = 2 + Math.floor(rand() * 24);
    const ref = Array.from({ length: tasks }, () => [pick(), pick(), pick()]);
    const cand = Array.from({ length: tasks }, () => [pick(), pick(), pick()]);
    const map = (x) => x.map((r) => r.map((k) => STATUSES[k]));
    const base = p('success.critical', map(ref), map(cand));
    const t = Math.floor(rand() * tasks);
    const i = Math.floor(rand() * 3);
    for (const w of WORSE[cand[t][i]]) {
      const c2 = cand.map((r) => [...r]);
      c2[t][i] = w;
      assert.ok(p('success.critical', map(ref), map(c2)) <= base + 1e-12);
    }
    for (const w of CONTAMINATED[ref[t][i]]) {
      const r2 = ref.map((r) => [...r]);
      r2[t][i] = w;
      assert.ok(p('success.critical', map(r2), map(cand)) <= base + 1e-12);
    }
  }
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
      // Reference side: contamination never loosens.
      const r2 = ref.map((r) => r.map((x) => (rand() < 0.2 ? contested : x)));
      assert.ok(p(gate, r2, cand, opts) <= base + 1e-12, `${gate} reference`);
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
  assert.equal(out.results.length, 8);
  assert.deepEqual(out.sizeViolations, []);
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
  // A missing candidate attempt exceeds every cut; a missing control never.
  assert.equal(
    orient(normalizeLatency(missing, 't1', medians), 'candidate', 'log') >
      cuts.p95,
    true,
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
