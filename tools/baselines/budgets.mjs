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
// committed budgets, so a budget cannot differ from its rule and data.
//
// `gate` compares a candidate epoch with the unchanged alpha1 control
// measured in the same interleaved run(s). Timing and runtime budgets (and
// memory cells too noisy for an absolute limit) are paired ratios: the
// median of per-round ratios candidate/alpha1 with a bootstrap interval. A
// ratio budget passes when the interval's upper bound is within the limit,
// fails when the median ratio exceeds it, and is otherwise `inconclusive`;
// it is also `inconclusive` when the run lacks interleaved alpha1 pairs or
// when the alpha1 control's own spread exceeds the frozen noise ceiling.
// Stable memory and deterministic outputs have absolute limits. Metrics
// without a budget stay `unknown`. Only a run where every budget passes is
// `pass`; absolute times are informational only.

import fs from 'node:fs';
import path from 'node:path';
import {
  REPO,
  coefficientOfVariation,
  fileSha256,
  git,
  median,
  pairedRatio,
  readJson,
  relativeSpread,
  sha256,
  summarize,
  writeJson,
} from './lib.mjs';
import { metricsFor, pairsOf } from './summarize.mjs';

const MEASURED_CLASSES = new Set(['timing', 'memory', 'runtime']);

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
  const epochs = [policy.baseline.reference, policy.baseline.nullEpoch];
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
      if (MEASURED_CLASSES.has(metric.class)) {
        const stats = summarize(values);
        entry.baseline = {
          informational: true,
          n: stats.n,
          median: stats.median,
          p95: stats.p95,
          medianCi95: [stats.medianCi95.lower, stats.medianCi95.upper],
        };
        const memory = policy.thresholdRule.memory;
        const cv = coefficientOfVariation(values);
        if (metric.class === 'memory' && cv != null && cv <= memory.maxCv) {
          entry.baseline.informational = false;
          entry.baseline.cv = cv;
          const factor = roundUp(
            Math.max(memory.floor, 1 + memory.cvMultiplier * cv),
            memory.roundUpTo,
          );
          entry.limit = {
            mode: 'absolute',
            maxMedian: Math.floor(stats.median * factor),
            factor,
          };
        } else {
          const rule = policy.thresholdRule.pairedRatio;
          const { reference, nullEpoch } = policy.baseline;
          const uppers = [];
          const spreads = [];
          for (const raw of raws) {
            const { pairs } = pairsOf(
              [raw],
              reference,
              nullEpoch,
              workload,
              metric,
            );
            const ratio = pairedRatio(pairs);
            if (ratio != null) uppers.push(ratio.upper);
            spreads.push(
              relativeSpread(valuesOf([raw], [reference], workload, metric)) ??
                0,
            );
          }
          const pooled = pairedRatio(
            pairsOf(raws, reference, nullEpoch, workload, metric).pairs,
          );
          if (pooled != null) uppers.push(pooled.upper);
          entry.null = {
            pooled,
            maxUpper: Math.max(...uppers),
            maxControlSpread: Math.max(...spreads),
          };
          if (metric.class === 'memory') entry.baseline.cv = cv;
          entry.limit = {
            mode: 'paired-ratio',
            maxRatio: roundUp(
              Math.max(rule.floor[metric.class], ...uppers),
              rule.roundUpTo,
            ),
            noiseCeiling: roundUp(
              Math.max(
                rule.noiseCeiling.floor,
                rule.noiseCeiling.multiplier * Math.max(...spreads),
              ),
              rule.noiseCeiling.roundUpTo,
            ),
            minPairs: rule.minPairs,
          };
        }
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
      epoch: policy.baseline.reference,
      nullEpoch: policy.baseline.nullEpoch,
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
  if (previous.mode !== next.mode) return true;
  for (const key of ['maxRatio', 'noiseCeiling', 'maxMedian', 'maxValue'])
    if (
      previous[key] != null &&
      (next[key] == null || next[key] > previous[key])
    )
      return true;
  if (previous.minPairs != null && !(next.minPairs >= previous.minPairs))
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
  const refusals = [];
  for (const raw of raws) {
    const names = raw.epochs.map((e) => e.name);
    if (!names.includes(reference))
      refusals.push(
        `${raw.label}: no interleaved ${reference} control in the run`,
      );
    if (!names.includes(candidate))
      refusals.push(`${raw.label}: candidate ${candidate} is not in the run`);
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
    if (cand.length === 0) {
      results.push({ ...entry, status: 'not-run' });
      continue;
    }
    if (budget.limit.mode === 'paired-ratio') {
      const { pairs, interleaved, unpaired } = pairsOf(
        raws,
        reference,
        candidate,
        budget.workload,
        metric,
      );
      const spread = Math.max(
        ...raws.map(
          (raw) =>
            relativeSpread(
              valuesOf([raw], [reference], budget.workload, metric),
            ) ?? 0,
        ),
      );
      const ratio = pairedRatio(pairs);
      const detail = {
        pairedRatio: ratio,
        controlSpread: spread,
        interleaved,
        unpaired,
      };
      if (!interleaved || unpaired > 0 || pairs.length < budget.limit.minPairs)
        results.push({
          ...entry,
          ...detail,
          status: 'inconclusive',
          reason: 'missing or non-interleaved alpha1 control pairs',
        });
      else if (spread > budget.limit.noiseCeiling)
        results.push({
          ...entry,
          ...detail,
          status: 'inconclusive',
          reason: 'alpha1 control spread exceeds the noise ceiling',
        });
      else if (ratio.upper <= budget.limit.maxRatio)
        results.push({ ...entry, ...detail, status: 'pass' });
      else if (ratio.median > budget.limit.maxRatio)
        results.push({
          ...entry,
          ...detail,
          status: 'fail',
          reason: 'median paired ratio exceeds the limit',
        });
      else
        results.push({
          ...entry,
          ...detail,
          status: 'inconclusive',
          reason: 'interval straddles the limit',
        });
    } else if (budget.limit.mode === 'absolute') {
      const value = median(cand);
      results.push({
        ...entry,
        status: value <= budget.limit.maxMedian ? 'pass' : 'fail',
        value,
        n: cand.length,
      });
    } else if (budget.class === 'deterministic') {
      const refDistinct = [...new Set(ref)];
      const candDistinct = [...new Set(cand)];
      if (
        ref.length > 0 &&
        (refDistinct.length !== 1 || refDistinct[0] !== budget.baseline.value)
      )
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
  const count = (status) => results.filter((r) => r.status === status).length;
  const verdict =
    problems.length > 0 || count('fail') > 0
      ? 'fail'
      : refusals.length > 0 || count('inconclusive') > 0
        ? 'inconclusive'
        : count('not-run') > 0
          ? 'incomplete'
          : 'pass';
  return {
    kind: 'pandamstyle-ce003-gate',
    budgets: { policyVersion: budgets.policyVersion },
    reference,
    candidate,
    verdict,
    problems,
    refusals,
    counts: {
      pass: count('pass'),
      fail: count('fail'),
      inconclusive: count('inconclusive'),
      notRun: count('not-run'),
      unknown: (budgets.unknown ?? []).length,
    },
    load: raws.map((raw) => ({
      label: raw.label,
      before: raw.load.before?.at(-1) ?? null,
      after: raw.load.after,
      batch: raw.load.batch ?? null,
    })),
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
