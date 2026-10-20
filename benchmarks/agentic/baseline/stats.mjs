/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Gate decisions of POLICY.md section 5 (`pms-agentic-stats/v1`). This is the
// one implementation of the method: `gates derive` and `gates check` (planned
// under #7) call it, and nothing else decides a gate.
//
// - Every planned repetition has one value, oriented so that a higher value
//   is worse for the candidate. A repetition that is not clean (missing,
//   contested, unclassified, unknown value) takes the worst bound on the
//   candidate side and the best bound on the reference side (section 5.1).
// - A gate is a one-sided stratified permutation test of "no change": within
//   a task (between runs) or within a pair (interleaved control), the
//   reference and candidate values are exchangeable. Integer contributions
//   get the exact distribution, real ones a seeded Monte Carlo one.
// - The decision is monotone: a worse candidate value or a better reference
//   value never raises the p-value (section 5.3).

import crypto from 'node:crypto';

export const METHOD = 'pms-agentic-stats/v1';

/** Family-wise rate and number of frozen blocking gates (section 5.3). */
export const FAMILY_ALPHA = 0.05;
export const GATE_COUNT = 27;
export const GATE_ALPHA = FAMILY_ALPHA / GATE_COUNT;

/** Monte Carlo draws for real-valued gates (section 5.3). */
export const DRAWS = 9999;

/**
 * Stand-in for an unbounded worst (or best) value. Every real observation
 * (log tokens, log seconds, counts) is far below it; `orient` refuses one
 * that is not.
 */
export const BOUND = 1e6;

/**
 * Value scales. `bounds` are the best and worst values a repetition can
 * have, oriented: higher is worse for the candidate.
 */
export const SCALES = {
  // Success or breach-free attempt: 0 = success, 1 = failure.
  binary: { bounds: [0, 1], integer: true },
  // Repair cycles (a count, >= 0).
  count: { bounds: [0, BOUND], integer: true },
  // Natural log of a positive quantity (tokens, seconds).
  log: { bounds: [-BOUND, BOUND], integer: false },
};

/** Blocking gates per model (POLICY.md section 4). */
export const GATES = {
  'success.application': { scale: 'binary', design: 'between-runs' },
  'success.diagnosis': { scale: 'binary', design: 'between-runs' },
  'success.report': { scale: 'binary', design: 'between-runs' },
  'success.critical': { scale: 'binary', design: 'between-runs' },
  safety: { scale: 'binary', design: 'between-runs' },
  'context.input': { scale: 'log', design: 'between-runs' },
  'repair.cycles': { scale: 'count', design: 'between-runs' },
  // Normalized log agent-phase time against the interleaved control: does
  // the candidate exceed the baseline's frozen p50 (p95) more often?
  'latency.p50': { scale: 'log', design: 'paired', cut: 'p50' },
  'latency.p95': { scale: 'log', design: 'paired', cut: 'p95' },
};

/**
 * Oriented value of one planned repetition.
 *
 * @param {object} rep `{ clean: boolean, value?: number }`. `clean` means
 *   valid, not contested, and (for a measured value) known. For the binary
 *   scale `value` is the badness (1 = failure or breach).
 * @param {'reference'|'candidate'} side
 * @param {'binary'|'count'|'log'} scale
 */
export function orient(rep, side, scale) {
  const { bounds } = SCALES[scale];
  if (!rep.clean) return side === 'candidate' ? bounds[1] : bounds[0];
  const v = rep.value;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`a clean repetition needs a finite value, got ${v}`);
  if (v < bounds[0] || v > bounds[1] || Math.abs(v) >= BOUND)
    throw new Error(`value ${v} is outside the ${scale} scale`);
  if (SCALES[scale].integer && !Number.isInteger(v))
    throw new Error(`value ${v} is not an integer (${scale})`);
  return v;
}

function* subsets(n, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield acc;
    return;
  }
  for (let i = start; i <= n - (k - acc.length); i += 1)
    yield* subsets(n, k, i + 1, [...acc, i]);
}

/**
 * The equally likely contributions of one stratum under "no change", in a
 * fixed order (the Monte Carlo draws index into it), and its observed one.
 */
function stratumContributions(stratum, design, cut) {
  const { reference: r, candidate: c } = stratum;
  if (design === 'paired') {
    if (r.length !== 1 || c.length !== 1)
      throw new Error('a paired stratum has one reference and one candidate');
    if (typeof cut !== 'number' || !Number.isFinite(cut))
      throw new Error('a paired gate needs a finite frozen cut');
    // Exceedances of the frozen cut: candidate minus control; a swap
    // negates it.
    const x = (c[0] > cut ? 1 : 0) - (r[0] > cut ? 1 : 0);
    return { observed: x, values: [x, -x] };
  }
  if (r.length === 0 || c.length === 0)
    throw new Error('a stratum needs reference and candidate values');
  // Between runs: the candidate's sum over its repetitions, for each way of
  // choosing which pooled values are the candidate's.
  const pooled = [...r, ...c];
  const values = [];
  for (const s of subsets(pooled.length, c.length))
    values.push(s.reduce((a, i) => a + pooled[i], 0));
  return { observed: c.reduce((a, v) => a + v, 0), values };
}

/** sfc32 seeded from a string: deterministic, independent of the data. */
export function seededRandom(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

// Sums of integers are exact; real sums compare with a relative tolerance
// that can only count more permuted statistics as extreme (conservative).
const atLeast = (x, t) => x >= t - 1e-9 * Math.max(1, Math.abs(t));

/**
 * One-sided stratified permutation test: P(T* >= T) under "no change".
 *
 * @param {object} input
 * @param {{reference: number[], candidate: number[]}[]} input.strata
 *   oriented values (see `orient`)
 * @param {'between-runs'|'paired'} input.design
 * @param {number} [input.cut] paired design only: the frozen cut
 * @param {boolean} input.integer every value is an integer
 * @param {number} [input.alpha]
 * @param {number} [input.draws] Monte Carlo draws (real values)
 * @param {string} [input.seed] Monte Carlo seed (real values)
 */
export function permutationTest({
  strata,
  design,
  cut,
  integer,
  alpha = GATE_ALPHA,
  draws = DRAWS,
  seed = METHOD,
}) {
  if (strata.length === 0) throw new Error('a gate needs at least one stratum');
  const parts = strata.map((s) => stratumContributions(s, design, cut));
  const observed = parts.reduce((a, p) => a + p.observed, 0);
  const exact = integer || design === 'paired';
  let pValue;
  if (exact) {
    // Convolution of the strata's distributions (sums of integers: exact).
    let dist = new Map([[0, 1]]);
    for (const p of parts) {
      const w = 1 / p.values.length;
      const next = new Map();
      for (const [s, q] of dist)
        for (const v of p.values)
          next.set(s + v, (next.get(s + v) ?? 0) + q * w);
      dist = next;
    }
    pValue = 0;
    for (const [s, q] of dist) if (s >= observed) pValue += q;
    pValue = Math.min(1, pValue);
  } else {
    const rand = seededRandom(seed);
    let extreme = 0;
    for (let i = 0; i < draws; i += 1) {
      let t = 0;
      for (const p of parts)
        t += p.values[Math.floor(rand() * p.values.length)];
      if (atLeast(t, observed)) extreme += 1;
    }
    pValue = (extreme + 1) / (draws + 1);
  }
  return {
    method: exact ? 'exact' : 'monte-carlo',
    observed,
    pValue,
    alpha,
    blocks: pValue <= alpha,
    ...(exact ? {} : { draws, seed }),
  };
}

/** Monte Carlo seed of one gate: fixed before any candidate is seen. */
export function gateSeed(model, gate) {
  return `${METHOD}:${model}:${gate}`;
}

/**
 * Decision of one gate for one model.
 *
 * @param {object} input
 * @param {string} input.gate a key of GATES
 * @param {string} input.model
 * @param {object[]} input.units between runs: one per task,
 *   `{ reference: rep[], candidate: rep[] }`; paired: one per interleaved
 *   pair, `{ reference: [rep], candidate: [rep] }` (rep: see `orient`;
 *   latency values normalized by `normalizeLatency`)
 * @param {{p50: number, p95: number}} [input.cuts] latency gates: the
 *   frozen cuts of `latencyCuts`
 */
export function decideGate({ gate, model, units, cuts, alpha, draws }) {
  const g = GATES[gate];
  if (g == null) throw new Error(`unknown gate ${gate}`);
  const strata = units.map((u) => ({
    reference: u.reference.map((rep) => orient(rep, 'reference', g.scale)),
    candidate: u.candidate.map((rep) => orient(rep, 'candidate', g.scale)),
  }));
  return {
    gate,
    model,
    ...permutationTest({
      strata,
      design: g.design,
      cut: g.cut == null ? undefined : cuts?.[g.cut],
      integer: SCALES[g.scale].integer,
      alpha,
      draws,
      seed: gateSeed(model, gate),
    }),
  };
}

/**
 * Indicative minimum detectable regression of a between-runs gate, stated
 * in the gate record before any candidate is seen (section 5.3). Binary
 * scale: the fewest baseline successes turned into failures (round-robin
 * over tasks, most successful first) that block. Count and log scales: the
 * smallest shift added to every baseline value that blocks (counts: whole
 * cycles per repetition; log: to 0.01, as a ratio exp(shift)). Null when no
 * regression of that pattern blocks.
 */
export function minimumDetectable({ gate, model, reference, alpha, draws }) {
  const g = GATES[gate];
  if (g.design !== 'between-runs')
    throw new Error('stated for between-runs gates only');
  const ref = reference.map((reps) =>
    reps.map((rep) => orient(rep, 'reference', g.scale)),
  );
  const test = (candidate) =>
    permutationTest({
      strata: ref.map((r, i) => ({ reference: r, candidate: candidate[i] })),
      design: 'between-runs',
      integer: SCALES[g.scale].integer,
      alpha,
      draws,
      seed: gateSeed(model, gate),
    }).blocks;
  if (g.scale === 'binary') {
    const order = ref
      .map((r, i) => ({ i, ok: r.filter((v) => v === 0).length }))
      .sort((x, y) => y.ok - x.ok || x.i - y.i);
    const cand = ref.map((r) => [...r]);
    let dropped = 0;
    for (let round = 0; ; round += 1) {
      let changed = false;
      for (const { i } of order) {
        const j = cand[i].indexOf(0);
        if (j < 0) continue;
        cand[i][j] = 1;
        dropped += 1;
        changed = true;
        if (test(cand)) return { successesDropped: dropped };
      }
      if (!changed) return null;
    }
  }
  if (g.scale === 'count') {
    for (let k = 1; k <= 1000; k += 1)
      if (test(ref.map((r) => r.map((v) => v + k))))
        return { cyclesAddedPerRepetition: k };
    return null;
  }
  let lo = 0;
  let hi = 10;
  if (!test(ref.map((r) => r.map((v) => v + hi)))) return null;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (test(ref.map((r) => r.map((v) => v + mid)))) hi = mid;
    else lo = mid;
  }
  return { logShift: hi, ratio: Math.exp(hi) };
}

const nearestRank = (sorted, q) =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];

/**
 * Frozen latency references of one model, from the baseline alone (section
 * 5.4): each task's median log agent-phase time, and the p50 and p95
 * (nearest rank) of the baseline's normalized values. Only clean
 * repetitions enter; the cuts change power, never the false-block rate.
 *
 * @param {Record<string, object[]>} byTask task id -> baseline reps
 *   (`{ clean, value }`, value = log seconds)
 */
export function latencyCuts(byTask) {
  const medians = {};
  const normalized = [];
  for (const [task, reps] of Object.entries(byTask)) {
    const v = reps
      .filter((x) => x.clean)
      .map((x) => x.value)
      .sort((a, b) => a - b);
    if (v.length === 0) continue;
    medians[task] = nearestRank(v, 0.5);
    for (const x of v) normalized.push(x - medians[task]);
  }
  normalized.sort((a, b) => a - b);
  if (normalized.length === 0) throw new Error('no clean baseline latency');
  return {
    medians,
    cuts: {
      p50: nearestRank(normalized, 0.5),
      p95: nearestRank(normalized, 0.95),
    },
  };
}

/** A latency repetition normalized by its task's frozen baseline median. */
export function normalizeLatency(rep, task, medians) {
  if (!rep.clean) return rep;
  if (!(task in medians)) throw new Error(`no frozen median for ${task}`);
  return { clean: true, value: rep.value - medians[task] };
}
