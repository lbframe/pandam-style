/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-00.3 non-regression budgets: derivation and release gate.
//
//   node tools/baselines/budgets.mjs freeze --policy <policy.json> \
//     --results <raw.json> [--results <raw.json> ...] --out <budgets.vN.json>
//   node tools/baselines/budgets.mjs gate --budgets <budgets.vN.json> \
//     --results <raw.json> [...] --candidate <epoch> [--reference alpha1]
//
// `freeze` applies the versioned threshold rule of a policy file to observed
// baseline results; rerunning freeze on the same inputs reproduces the
// committed budgets, so a budget cannot differ from its rule and data. `gate` compares a
// candidate epoch with the unchanged alpha1 artifact measured in the same
// interleaved run(s): timing, memory and runtime budgets are ratios of
// contemporaneous medians and p95s, deterministic budgets are absolute
// limits on the frozen alpha1 values. Metrics without a budget stay `unknown`
// and are listed; an unrun budgeted metric makes the verdict `incomplete`,
// never `pass`.

import fs from 'node:fs';
import path from 'node:path';
import {
  REPO,
  fileSha256,
  git,
  median,
  quantile,
  readJson,
  sha256,
  summarize,
  writeJson,
} from './lib.mjs';
import { metricsFor } from './summarize.mjs';

const RATIO_CLASSES = new Set(['timing', 'memory', 'runtime']);

export function roundUp(value, step) {
  return Math.round(Math.ceil(value / step - 1e-9) * step * 1000) / 1000;
}

function valuesOf(raws, epochs, workload, metric) {
  const out = [];
  for (const raw of raws)
    for (const s of raw.samples)
      if (
        epochs.includes(s.epoch) &&
        s.workload === workload &&
        s.kind === metric.kind &&
        s.result.ok
      ) {
        const v = metric.get(s.result);
        if (v != null) out.push(v);
      }
  return out;
}

const deviation = (a, b) =>
  a == null || b == null || a === 0 ? null : Math.abs(b / a - 1);

// Observed null noise of one metric: the largest relative difference of
// medians (and of p95s) between any two measurements of the same unchanged
// artifact, within a run (epochs) and across runs (same epoch).
export function noiseOf(raws, epochs, workload, metric) {
  const cells = [];
  for (const raw of raws)
    for (const epoch of epochs) {
      const values = valuesOf([raw], [epoch], workload, metric);
      if (values.length > 0)
        cells.push({
          label: `${raw.label}/${epoch}`,
          median: median(values),
          p95: quantile(values, 0.95),
        });
    }
  let medianNoise = 0;
  let p95Noise = 0;
  for (let i = 0; i < cells.length; i++)
    for (let j = i + 1; j < cells.length; j++) {
      medianNoise = Math.max(
        medianNoise,
        deviation(cells[i].median, cells[j].median) ?? 0,
      );
      p95Noise = Math.max(p95Noise, deviation(cells[i].p95, cells[j].p95) ?? 0);
    }
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    cells: cells.length,
    medianNoise: round(medianNoise),
    p95Noise: round(p95Noise),
  };
}

function resultRef(file) {
  const raw = readJson(file);
  return {
    path: path.relative(REPO, file),
    sha256: fileSha256(file),
    label: raw.label,
  };
}

// Derives budgets from a policy (threshold rule, budgeted metrics, unknown
// metrics) and baseline raws. Pure: identical inputs give identical output.
export function deriveBudgets(policy, raws, resultRefs) {
  const epochs = policy.baseline.pooledEpochs;
  const samples = raws.flatMap((r) => r.samples);
  const metrics = metricsFor(samples);
  const budgets = [];
  const workloads = [...new Set(samples.map((s) => s.workload))].sort();
  for (const workload of workloads)
    for (const metric of metrics) {
      if (
        !policy.budgetedMetrics.includes(metric.id) &&
        !(
          metric.id.startsWith('incremental.') &&
          policy.budgetedMetrics.includes('incremental.*')
        )
      )
        continue;
      const values = valuesOf(raws, epochs, workload, metric);
      if (values.length === 0) continue;
      const entry = {
        workload,
        metric: metric.id,
        class: metric.class,
        unit: metric.unit ?? null,
      };
      if (RATIO_CLASSES.has(metric.class)) {
        const rule = policy.thresholdRule[metric.class];
        const stats = summarize(values);
        const noise = noiseOf(raws, epochs, workload, metric);
        entry.baseline = {
          n: stats.n,
          median: stats.median,
          p95: stats.p95,
          medianCi95: [stats.medianCi95.lower, stats.medianCi95.upper],
          p95Ci95: [stats.p95Ci95.lower, stats.p95Ci95.upper],
        };
        entry.noise = noise;
        entry.limit = {
          maxMedianRatio: roundUp(
            Math.max(
              rule.minMedianRatio,
              1 + rule.noiseMultiplier * noise.medianNoise,
            ),
            rule.roundUpTo,
          ),
          maxP95Ratio: roundUp(
            Math.max(
              rule.minP95Ratio,
              1 + rule.noiseMultiplier * noise.p95Noise,
            ),
            rule.roundUpTo,
          ),
        };
      } else if (metric.class === 'deterministic') {
        const distinct = [...new Set(values)];
        if (distinct.length !== 1)
          throw new Error(
            `${workload} ${metric.id} is not deterministic in the baseline: ${distinct.join(', ')}`,
          );
        const growth =
          policy.thresholdRule.deterministic.growth[metric.id] ??
          policy.thresholdRule.deterministic.growth.default;
        entry.baseline = { value: distinct[0] };
        entry.limit = {
          maxValue: Math.floor(distinct[0] * (1 + growth)),
          growth,
        };
      } else if (metric.class === 'identity') {
        const distinct = [...new Set(values.map(String))];
        if (distinct.length !== 1)
          throw new Error(
            `${workload} ${metric.id} differs across the baseline`,
          );
        entry.baseline = { value: distinct[0] };
        entry.limit = {
          equals: policy.thresholdRule.identity[metric.id] ?? distinct[0],
        };
      } else continue;
      budgets.push(entry);
    }
  const environments = raws.map((r) => r.environment);
  return {
    schemaVersion: 1,
    kind: 'pandamstyle-ce003-budgets',
    policyVersion: policy.policyVersion,
    supersedes: policy.supersedes ?? null,
    justification: policy.justification,
    relaxations: policy.relaxations ?? [],
    policy: { path: policy.__path, sha256: policy.__sha256 },
    baseline: {
      epoch: policy.baseline.epoch,
      pooledEpochs: epochs,
      manifest: {
        path: policy.baseline.manifest,
        sha256: fileSha256(path.join(REPO, policy.baseline.manifest)),
      },
      workloads: {
        path: raws[0].workloadsRecord.path,
        sha256: raws[0].workloadsRecord.sha256,
      },
      results: resultRefs,
      environment: {
        cpu: environments[0].cpu,
        logicalCores: environments[0].logicalCores,
        os: environments[0].os,
        kernel: environments[0].kernel,
        node: environments[0].node,
        nodeBinarySha256: environments[0].nodeBinarySha256,
        filesystem: environments[0].filesystem,
      },
    },
    thresholdRule: policy.thresholdRule,
    comparison: policy.comparison,
    budgets,
    unknown: policy.unknown,
    changePolicy: policy.changePolicy,
  };
}

export function loadPolicy(file) {
  const policy = readJson(file);
  policy.__path = path.relative(REPO, file);
  policy.__sha256 = fileSha256(file);
  return policy;
}

// ------------------------------------------------------------- policy chain

// A committed frozen file must equal the blob of the commit that added it.
// Returns null when intact or not yet committed, otherwise a reason.
export function frozenFileChange(
  relativePath,
  readCurrent = (p) => fs.readFileSync(path.join(REPO, p)),
) {
  let added;
  try {
    added = git(['log', '--diff-filter=A', '--format=%H', '--', relativePath])
      .trim()
      .split('\n')
      .filter(Boolean)
      .at(-1);
  } catch {
    return null;
  }
  if (!added) return null;
  const original = git(['cat-file', 'blob', `${added}:${relativePath}`], {
    encoding: 'buffer',
  });
  return sha256(original) === sha256(readCurrent(relativePath))
    ? null
    : `${relativePath} differs from the version frozen in ${added.slice(0, 12)}`;
}

function looser(previous, next) {
  if (previous == null || next == null) return false;
  for (const key of ['maxMedianRatio', 'maxP95Ratio', 'maxValue'])
    if (
      previous[key] != null &&
      (next[key] == null || next[key] > previous[key])
    )
      return true;
  if (previous.equals != null && next.equals !== previous.equals) return true;
  return false;
}

// Rules for a budgets version N > 1: it names the exact predecessor, gives a
// justification, rests on a new baseline (no reused result file), and lists
// every loosened or removed budget as a justified relaxation.
export function policyChainProblems(
  budgets,
  loadByPath = (p) => readJson(path.join(REPO, p)),
  digestByPath = (p) => fileSha256(path.join(REPO, p)),
) {
  const problems = [];
  if (!Number.isInteger(budgets.policyVersion) || budgets.policyVersion < 1)
    problems.push('policyVersion must be a positive integer');
  if (
    typeof budgets.justification !== 'string' ||
    budgets.justification.trim().length < 20
  )
    problems.push('a budgets version needs a justification');
  if (budgets.policyVersion === 1) {
    if (budgets.supersedes != null)
      problems.push('version 1 cannot supersede another version');
    if ((budgets.relaxations ?? []).length > 0)
      problems.push('version 1 has nothing to relax');
    return problems;
  }
  if (budgets.supersedes?.path == null || budgets.supersedes?.sha256 == null) {
    problems.push(
      `version ${budgets.policyVersion} must name its predecessor by path and sha256`,
    );
    return problems;
  }
  if (digestByPath(budgets.supersedes.path) !== budgets.supersedes.sha256)
    problems.push(
      'the predecessor digest does not match the committed predecessor',
    );
  const previous = loadByPath(budgets.supersedes.path);
  if (previous.policyVersion !== budgets.policyVersion - 1)
    problems.push('versions must increase by one');
  const previousResults = new Set(
    previous.baseline.results.map((r) => r.sha256),
  );
  if (budgets.baseline.results.some((r) => previousResults.has(r.sha256)))
    problems.push(
      'a new budgets version needs a new comparable baseline, not reused results',
    );
  const relaxed = new Set(
    (budgets.relaxations ?? [])
      .filter(
        (r) =>
          typeof r.justification === 'string' &&
          r.justification.trim().length >= 20,
      )
      .map((r) => `${r.workload}\0${r.metric}`),
  );
  for (const old of previous.budgets) {
    const next = budgets.budgets.find(
      (b) => b.workload === old.workload && b.metric === old.metric,
    );
    if (
      (next == null || looser(old.limit, next.limit)) &&
      !relaxed.has(`${old.workload}\0${old.metric}`)
    )
      problems.push(
        `${old.workload} ${old.metric} is ${next == null ? 'removed' : 'loosened'} without a justified relaxation`,
      );
  }
  for (const u of previous.unknown ?? [])
    if (
      !(budgets.unknown ?? []).some((n) => n.id === u.id) &&
      !budgets.budgets.some((b) => b.metric === u.id)
    )
      problems.push(`unknown metric ${u.id} disappeared without a budget`);
  return problems;
}

// --------------------------------------------------------------------- gate

export function evaluate(
  budgets,
  raws,
  { candidate, reference = 'alpha1', manifest },
) {
  const problems = [];
  for (const raw of raws) {
    const names = raw.epochs.map((e) => e.name);
    if (!names.includes(reference) || !names.includes(candidate))
      problems.push(
        `${raw.label}: ${reference} and ${candidate} must be measured in the same run`,
      );
    if (raw.workloadsRecord.sha256 !== budgets.baseline.workloads.sha256)
      problems.push(
        `${raw.label}: workloads record differs from the budgets baseline`,
      );
    const ref = raw.epochs.find((e) => e.name === reference);
    if (ref != null && manifest != null)
      for (const pkg of manifest.packages)
        if (
          ref.packages[pkg.name]?.integrity !== pkg.registry.registryIntegrity
        )
          problems.push(
            `${raw.label}: ${reference} does not run the unchanged ${pkg.name} tarball`,
          );
  }
  const samples = raws.flatMap((r) => r.samples);
  const metrics = metricsFor(samples);
  const results = [];
  for (const budget of budgets.budgets) {
    const metric = metrics.find((m) => m.id === budget.metric);
    const ref =
      metric == null
        ? []
        : valuesOf(raws, [reference], budget.workload, metric);
    const cand =
      metric == null
        ? []
        : valuesOf(raws, [candidate], budget.workload, metric);
    const failedRuns = samples.filter(
      (s) =>
        s.epoch === candidate &&
        s.workload === budget.workload &&
        metric != null &&
        s.kind === metric.kind &&
        !s.result.ok,
    ).length;
    const entry = {
      workload: budget.workload,
      metric: budget.metric,
      class: budget.class,
      limit: budget.limit,
    };
    if (failedRuns > 0) {
      results.push({
        ...entry,
        status: 'fail',
        reason: `${failedRuns} candidate samples failed`,
      });
      continue;
    }
    if (cand.length === 0 || ref.length === 0) {
      results.push({ ...entry, status: 'not-run' });
      continue;
    }
    if (RATIO_CLASSES.has(budget.class)) {
      const medianRatio = median(cand) / median(ref);
      const p95Ratio = quantile(cand, 0.95) / quantile(ref, 0.95);
      const pass =
        medianRatio <= budget.limit.maxMedianRatio &&
        p95Ratio <= budget.limit.maxP95Ratio;
      results.push({
        ...entry,
        status: pass ? 'pass' : 'fail',
        medianRatio: Math.round(medianRatio * 1e4) / 1e4,
        p95Ratio: Math.round(p95Ratio * 1e4) / 1e4,
        n: { reference: ref.length, candidate: cand.length },
      });
    } else if (budget.class === 'deterministic') {
      const refDistinct = [...new Set(ref)];
      const candDistinct = [...new Set(cand)];
      if (refDistinct.length !== 1 || refDistinct[0] !== budget.baseline.value)
        problems.push(
          `${budget.workload} ${budget.metric}: ${reference} did not reproduce its frozen value ${budget.baseline.value} (${refDistinct.join(', ')})`,
        );
      const pass =
        candDistinct.length === 1 && candDistinct[0] <= budget.limit.maxValue;
      results.push({
        ...entry,
        status: pass ? 'pass' : 'fail',
        value: candDistinct.length === 1 ? candDistinct[0] : candDistinct,
        ...(candDistinct.length > 1
          ? { reason: 'non-deterministic candidate output' }
          : {}),
      });
    } else if (budget.class === 'identity') {
      const values = [...new Set(cand.map(String))];
      const pass = values.length === 1 && values[0] === budget.limit.equals;
      results.push({
        ...entry,
        status: pass ? 'pass' : 'fail',
        value: values.length === 1 ? values[0] : values,
      });
    }
  }
  problems.push(...policyChainProblems(budgets));
  const failed = results.filter((r) => r.status === 'fail').length;
  const notRun = results.filter((r) => r.status === 'not-run').length;
  const verdict =
    problems.length > 0 || failed > 0
      ? 'fail'
      : notRun > 0
        ? 'incomplete'
        : 'pass';
  return {
    kind: 'pandamstyle-ce003-gate',
    budgets: { policyVersion: budgets.policyVersion },
    reference,
    candidate,
    verdict,
    problems,
    counts: {
      pass: results.filter((r) => r.status === 'pass').length,
      fail: failed,
      notRun,
      unknown: (budgets.unknown ?? []).length,
    },
    results,
    unknown: (budgets.unknown ?? []).map((u) => ({ ...u, status: 'unknown' })),
  };
}

// ---------------------------------------------------------------------- cli

function collect(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === flag) out.push(path.resolve(argv[i + 1]));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...argv] = process.argv.slice(2);
  const one = (flag) => collect(argv, flag)[0];
  if (command === 'freeze') {
    const files = collect(argv, '--results');
    const policy = loadPolicy(one('--policy'));
    const budgets = deriveBudgets(
      policy,
      files.map(readJson),
      files.map(resultRef),
    );
    writeJson(one('--out'), budgets);
    console.log(
      `${budgets.budgets.length} budgets, ${budgets.unknown.length} unknown metrics`,
    );
  } else if (command === 'gate') {
    const budgetsFile = one('--budgets');
    const budgets = readJson(budgetsFile);
    const files = collect(argv, '--results');
    const candidate = argv[argv.indexOf('--candidate') + 1];
    const reference = argv.includes('--reference')
      ? argv[argv.indexOf('--reference') + 1]
      : 'alpha1';
    const manifest = readJson(path.join(REPO, budgets.baseline.manifest.path));
    const report = evaluate(budgets, files.map(readJson), {
      candidate,
      reference,
      manifest,
    });
    const frozen = frozenFileChange(path.relative(REPO, budgetsFile));
    if (frozen != null) {
      report.problems.push(frozen);
      report.verdict = 'fail';
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `verdict ${report.verdict}: ${JSON.stringify(report.counts)}; problems: ${report.problems.length}\n`,
    );
    process.exitCode = report.verdict === 'pass' ? 0 : 1;
  } else {
    console.error('usage: budgets.mjs freeze|gate ...');
    process.exitCode = 2;
  }
}
