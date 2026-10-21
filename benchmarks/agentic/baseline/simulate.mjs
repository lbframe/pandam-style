/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// False-block calibration of the gate method (POLICY.md section 5.6): an
// unchanged candidate (reference and candidate drawn from the same
// distribution) over representative scenarios, including the review's
// zero-variance and Gaussian cases and unclean reference repetitions (review
// r2, R5). Deterministic (seeded).
//
//   node benchmarks/agentic/baseline/simulate.mjs [--sims N] [--mc-sims N]

import { fileURLToPath } from 'node:url';
import {
  DRAWS,
  GATE_ALPHA,
  GATE_COUNT,
  FAMILY_ALPHA,
  decideGate,
  seededRandom,
} from './stats.mjs';

const normal = (rand) => {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const bernoulli = (rand, p) => (rand() < p ? 1 : 0);
const rep = (value) => ({ clean: true, value });

/** Scenarios: each draws one repetition's value for a task (and side). */
const CLEAN_SCENARIOS = [
  {
    id: 'success-25-mixed',
    gate: 'success.application',
    strata: 25,
    // Per-task success probability: mostly near-certain, some uncertain.
    setup: (t) => [1, 0.999, 0.99, 0.9, 0.7, 0.5, 0.2, 0][t % 8],
    draw: (rand, p) => 1 - bernoulli(rand, p),
  },
  {
    id: 'success-7-near-certain',
    gate: 'success.report',
    strata: 7,
    setup: () => 0.999,
    draw: (rand, p) => 1 - bernoulli(rand, p),
  },
  {
    // Review r1, R3: a repair with probability 0.001, 25 tasks x 3.
    id: 'repairs-25-rare-review',
    gate: 'repair.cycles',
    strata: 25,
    setup: () => 0.001,
    draw: (rand, p) => bernoulli(rand, p),
  },
  {
    // Skewed counts: geometric with task-dependent mean.
    id: 'repairs-25-geometric',
    gate: 'repair.cycles',
    strata: 25,
    setup: (t) => 0.3 + 0.6 * ((t % 5) / 4),
    draw: (rand, q) => {
      let k = 0;
      while (rand() > q && k < 50) k += 1;
      return k;
    },
  },
  {
    // Review r1, R3: Gaussian log costs, 25 tasks.
    id: 'tokens-25-gaussian-review',
    gate: 'context.input',
    strata: 25,
    setup: (t) => 9 + (t % 7) * 0.5,
    draw: (rand, mu) => mu + 0.3 * normal(rand),
  },
  {
    // Heavy tail: occasional 20x runs.
    id: 'tokens-44-heavy-tail',
    gate: 'context.input',
    strata: 44,
    setup: (t) => 10 + (t % 11) * 0.3,
    draw: (rand, mu) =>
      mu + 0.5 * normal(rand) + (rand() < 0.05 ? Math.log(20) : 0),
  },
  {
    // Interleaved control: 132 pairs sharing a pair-level load effect; a
    // fixed cut (any frozen cut keeps the false-block rate).
    id: 'latency-132-pairs-p50',
    gate: 'latency.p50',
    strata: 132,
    paired: true,
    cuts: { p50: 4, p95: 5.3 },
    setup: () => null,
    draw: (rand) => 4 + 0.4 * normal(rand),
  },
  {
    // Skewed: occasional slow attempts.
    id: 'latency-132-pairs-p95',
    gate: 'latency.p95',
    strata: 132,
    paired: true,
    cuts: { p50: 4, p95: 5.3 },
    setup: () => null,
    draw: (rand) => 4 + 0.4 * normal(rand) + (rand() < 0.05 ? 1.5 : 0),
  },
];

// Unclean reference repetitions (review r2, R5), dropped by the method:
// `count` of them, at most one per task, so that the minimum clean evidence
// holds (the review's 10 where the cap allows it, otherwise the cap).
// `at-random`: independent of the values, the case the test is exact for.
// `on-failures`: stress, outside that assumption: each falls on a worst
// value of a task whose reference values differ (a reference failure
// contested more often than a success).
const contaminated = (id, count, select) => ({
  ...CLEAN_SCENARIOS.find((s) => s.id === id),
  id: `${id}-reference-${select}-${count}`,
  contaminate: { count, select },
  stress: select === 'on-failures',
});

export const SCENARIOS = [
  ...CLEAN_SCENARIOS,
  contaminated('success-25-mixed', 7, 'at-random'),
  contaminated('repairs-25-geometric', 7, 'at-random'),
  contaminated('tokens-44-heavy-tail', 10, 'at-random'),
  contaminated('latency-132-pairs-p50', 10, 'at-random'),
  contaminated('success-25-mixed', 7, 'on-failures'),
  contaminated('repairs-25-geometric', 7, 'on-failures'),
];

/** Marks `count` reference repetitions unclean, at most one per stratum. */
function contaminate(units, { count, select }, rand) {
  const order = units.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  let picked = order;
  if (select === 'on-failures') {
    const spread = (u) => {
      const v = u.reference.map((r) => r.value);
      return Math.max(...v) - Math.min(...v);
    };
    picked = order
      .filter((i) => spread(units[i]) > 0)
      .sort((a, b) => spread(units[b]) - spread(units[a]));
  }
  for (const i of picked.slice(0, count)) {
    const ref = units[i].reference;
    let k = Math.floor(rand() * ref.length);
    if (select === 'on-failures')
      k = ref.reduce((m, r, j) => (r.value > ref[m].value ? j : m), 0);
    ref[k] = { clean: false };
  }
}

// P(X <= x) for X ~ Binomial(n, p), summed in log space (no underflow).
function binomialCdf(x, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return x >= n ? 1 : 0;
  const logs = [];
  let l = n * Math.log1p(-p);
  logs.push(l);
  for (let k = 1; k <= x; k += 1) {
    l += Math.log((n - k + 1) / k) + Math.log(p) - Math.log1p(-p);
    logs.push(l);
  }
  const m = Math.max(...logs);
  return Math.min(
    1,
    Math.exp(m) * logs.reduce((a, v) => a + Math.exp(v - m), 0),
  );
}

/** One-sided 95% Clopper-Pearson upper bound of a binomial proportion. */
export function upperBound(x, n) {
  if (x >= n) return 1;
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(x, n, mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** One-sided 95% Clopper-Pearson lower bound of a binomial proportion. */
export function lowerBound(x, n) {
  if (x <= 0) return 0;
  let lo = 0;
  let hi = x / n;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    // P(X >= x) at mid.
    if (1 - binomialCdf(x - 1, n, mid) < 0.05) lo = mid;
    else hi = mid;
  }
  return lo;
}

const rate = (x, n, alpha) => ({
  count: x,
  rate: x / n,
  lower95: lowerBound(x, n),
  upper95: upperBound(x, n),
  alpha,
  // A size violation is shown only when even the lower bound exceeds alpha.
  exceedsAlpha: lowerBound(x, n) > alpha,
});

function runScenario(s, sims, draws) {
  const rand = seededRandom(`simulate:${s.id}`);
  const params = Array.from({ length: s.strata }, (_, t) => s.setup(t));
  let blocks = 0;
  let nominal = 0;
  for (let i = 0; i < sims; i += 1) {
    const units = params.map((p) => {
      if (s.paired) {
        // Shared pair-level load; exchangeable within the pair.
        const load = 0.5 * normal(rand);
        return {
          reference: [rep(s.draw(rand, p) + load)],
          candidate: [rep(s.draw(rand, p) + load)],
        };
      }
      return {
        reference: [0, 1, 2].map(() => rep(s.draw(rand, p))),
        candidate: [0, 1, 2].map(() => rep(s.draw(rand, p))),
      };
    });
    if (s.contaminate) contaminate(units, s.contaminate, rand);
    const d = decideGate({
      gate: s.gate,
      model: `sim-${i}`,
      units,
      cuts: s.cuts,
      draws,
    });
    if (d.outcome === 'insufficient-reference')
      throw new Error(`${s.id}: the reference must stay sufficient`);
    if (d.blocks) blocks += 1;
    if (d.pValue <= 0.05) nominal += 1;
  }
  return {
    id: s.id,
    gate: s.gate,
    ...(s.contaminate
      ? { uncleanReference: s.contaminate, stress: s.stress }
      : {}),
    sims,
    falseBlocks: rate(blocks, sims, GATE_ALPHA),
    // The same tests at a per-gate level of 0.05, where a size violation
    // would be visible with this many simulations.
    atNominal005: rate(nominal, sims, 0.05),
  };
}

export function simulate({ sims = 20000, mcSims = 2000, draws = DRAWS } = {}) {
  const results = SCENARIOS.map((s) => {
    const real = s.gate === 'context.input';
    return runScenario(s, real ? mcSims : sims, draws);
  });
  const violates = (r) =>
    r.falseBlocks.exceedsAlpha || r.atNominal005.exceedsAlpha;
  return {
    alpha: GATE_ALPHA,
    gates: GATE_COUNT,
    familyAlpha: FAMILY_ALPHA,
    draws,
    results,
    sizeViolations: results
      .filter((r) => !r.stress && violates(r))
      .map((r) => r.id),
    // Outside the exchangeability the guarantee assumes: reported, never
    // hidden (POLICY.md section 5.6).
    stressViolations: results
      .filter((r) => r.stress && violates(r))
      .map((r) => r.id),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? dflt : Number(process.argv[i + 1]);
  };
  const out = simulate({
    sims: arg('--sims', 20000),
    mcSims: arg('--mc-sims', 2000),
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
