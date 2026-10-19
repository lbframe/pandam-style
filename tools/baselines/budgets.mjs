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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO,
  coefficientOfVariation,
  fileSha256,
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
export function deriveBudgets(policy, raws, resultRefs, options = {}) {
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
        sha256:
          options.manifestSha256 ??
          fileSha256(path.join(REPO, policy.baseline.manifest)),
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

// Threat model: a verdict is computed from run files, budgets, policy,
// manifest and workloads records that may be wrong by mistake or on purpose.
// Invariant: `pass` requires every input it depends on to be validated
// against the committed record at the evaluated revision; anything that
// cannot be validated fails closed (`fail` for a wrong input, `inconclusive`
// for insufficient evidence, `not-release` for unbound budgets).

export const BENCH_DIR = 'benchmarks/core-evolution';
export const MANIFEST_PATH = `${BENCH_DIR}/epochs/alpha1/manifest.v1.json`;
export const WORKLOADS_PATH = `${BENCH_DIR}/workloads.v1.json`;
export const HARNESS_FILES = [
  'lib.mjs',
  'sample.mjs',
  'measure.mjs',
  'workloads.mjs',
  'summarize.mjs',
];
const BUDGETS_RE = /^benchmarks\/core-evolution\/budgets\.v(\d+)\.json$/;
const REQUIRED_HOSTS = [
  'vite',
  'next',
  '@rsbuild/core',
  '@rspack/core',
  'react',
  'react-dom',
];

function runGit(args, root) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  return result.status === 0 ? result.stdout : null;
}

// Committed files at one revision, read from Git objects only.
export function gitSource(rev = 'HEAD', root = REPO) {
  const commit = runGit(
    ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`],
    root,
  )
    ?.toString()
    .trim();
  if (!commit) throw new Error(`unknown revision ${rev}`);
  return {
    rev,
    commit,
    read: (file) => runGit(['cat-file', 'blob', `${commit}:${file}`], root),
    list: (dir) =>
      (
        runGit(
          ['ls-tree', '--name-only', `${commit}:${dir}`],
          root,
        )?.toString() ?? ''
      )
        .split('\n')
        .filter(Boolean)
        .map((name) => `${dir}/${name}`),
    // The blob of the earliest commit, in this revision's history, that added
    // the file; a later re-addition or edit does not move it.
    firstBlob: (file) => {
      const added = runGit(
        ['log', commit, '--diff-filter=A', '--format=%H', '--', file],
        root,
      )
        ?.toString()
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1);
      return added
        ? runGit(['cat-file', 'blob', `${added}:${file}`], root)
        : null;
    },
  };
}

export function inForceBudgets(source) {
  const versions = source
    .list(BENCH_DIR)
    .map((file) => [file, Number(BUDGETS_RE.exec(file)?.[1])])
    .filter(([, n]) => Number.isInteger(n))
    .sort((a, b) => b[1] - a[1]);
  return versions[0]?.[0] ?? null;
}

const jsonOf = (bytes) => {
  try {
    return bytes == null ? null : JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
};

// Verifies one committed budgets version and, recursively, its predecessors:
// unchanged since first committed, named after its version, bound to an
// existing policy of the same version, to the committed manifest, workloads
// record and baseline results by digest, re-derivable byte for byte from
// them, and a valid successor of its predecessor.
export function verifyBudgetsChain(source, file, seen = new Set()) {
  const problems = [];
  const at = `${file}@${source.commit.slice(0, 12)}`;
  if (seen.has(file)) return { problems: [`${at}: predecessor cycle`] };
  seen.add(file);
  const bytes = source.read(file);
  const budgets = jsonOf(bytes);
  if (budgets == null)
    return {
      problems: [`${at}: missing or unreadable at the evaluated revision`],
    };
  const first = source.firstBlob(file);
  if (first == null || sha256(first) !== sha256(bytes))
    problems.push(`${at}: differs from the version first committed`);
  const version = budgets.policyVersion;
  if (BUDGETS_RE.exec(file)?.[1] !== String(version))
    problems.push(`${at}: file name does not match policyVersion ${version}`);
  const policyPath = `${BENCH_DIR}/budget-policy.v${version}.json`;
  const policyBytes = source.read(policyPath);
  if (budgets.policy?.path !== policyPath || policyBytes == null)
    problems.push(`${at}: no committed ${policyPath}`);
  else if (sha256(policyBytes) !== budgets.policy.sha256)
    problems.push(
      `${at}: ${policyPath} differs from the policy it was frozen with`,
    );
  const manifestBytes = source.read(MANIFEST_PATH);
  if (
    budgets.baseline?.manifest?.path !== MANIFEST_PATH ||
    manifestBytes == null ||
    sha256(manifestBytes) !== budgets.baseline.manifest.sha256
  )
    problems.push(`${at}: alpha1 manifest missing or changed`);
  const workloadsBytes = source.read(WORKLOADS_PATH);
  if (
    budgets.baseline?.workloads?.path !== WORKLOADS_PATH ||
    workloadsBytes == null ||
    sha256(workloadsBytes) !== budgets.baseline.workloads.sha256
  )
    problems.push(`${at}: workloads record missing or changed`);
  const raws = [];
  for (const ref of budgets.baseline?.results ?? []) {
    const raw = source.read(ref.path);
    if (raw == null)
      problems.push(`${at}: baseline evidence ${ref.path} is not committed`);
    else if (sha256(raw) !== ref.sha256)
      problems.push(`${at}: baseline evidence ${ref.path} digest differs`);
    else raws.push(jsonOf(raw));
  }
  if ((budgets.baseline?.results ?? []).length === 0)
    problems.push(`${at}: no baseline evidence`);
  if (problems.length === 0) {
    const policy = {
      ...jsonOf(policyBytes),
      __path: policyPath,
      __sha256: sha256(policyBytes),
    };
    let derived = null;
    try {
      derived = `${JSON.stringify(deriveBudgets(policy, raws, budgets.baseline.results, { manifestSha256: sha256(manifestBytes) }), null, 2)}\n`;
    } catch (error) {
      problems.push(`${at}: cannot re-derive: ${error.message}`);
    }
    if (derived != null && derived !== bytes.toString('utf8'))
      problems.push(
        `${at}: does not re-derive from its policy and baseline evidence`,
      );
  }
  problems.push(
    ...policyChainProblems(
      budgets,
      (p) =>
        jsonOf(source.read(p)) ?? { baseline: { results: [] }, budgets: [] },
      (p) => (source.read(p) == null ? null : sha256(source.read(p))),
    ).map((p) => `${at}: ${p}`),
  );
  if (version > 1 && budgets.supersedes?.path != null) {
    const previous = verifyBudgetsChain(source, budgets.supersedes.path, seen);
    problems.push(...previous.problems);
  }
  return { budgets, problems };
}

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function safeGet(metric, result) {
  try {
    return metric.get(result);
  } catch {
    return undefined;
  }
}

// Run-level validation: the alpha1 control must be the unchanged manifest
// artifact, the environment must match the frozen pins, the plan and
// harness must be the committed ones, and the candidate must be identified.
function runChecks(raw, context, reference, candidate) {
  const problems = [];
  const refusals = [];
  const label = raw?.label ?? '<unlabelled run>';
  const { manifest, workloads, harness, pins, workloadsSha256 } = context;
  const epochs = Array.isArray(raw?.epochs) ? raw.epochs : [];
  const ref = epochs.find((e) => e?.name === reference);
  const cand = epochs.find((e) => e?.name === candidate);
  if (epochs.filter((e) => e?.name === reference).length !== 1)
    refusals.push(`${label}: no single ${reference} control epoch in the run`);
  if (epochs.filter((e) => e?.name === candidate).length !== 1)
    refusals.push(
      `${label}: no single candidate epoch ${candidate} in the run`,
    );
  if (raw?.workloadsRecord?.sha256 !== workloadsSha256)
    problems.push(`${label}: workloads record differs from the committed one`);
  const plan = workloads?.plans?.[raw?.plan?.id];
  const { id: _planId, ...recordedPlan } = raw?.plan ?? {};
  if (plan == null || JSON.stringify(recordedPlan) !== JSON.stringify(plan))
    refusals.push(`${label}: plan is not the committed plan ${raw?.plan?.id}`);
  if (raw?.repositoryDirty !== false)
    refusals.push(`${label}: measured with an uncommitted harness`);
  for (const file of HARNESS_FILES)
    if (harness != null && raw?.harness?.[file] !== harness[file])
      refusals.push(
        `${label}: harness ${file} is not the evaluated revision's`,
      );
  if (raw?.environment?.node !== pins?.node)
    problems.push(
      `${label}: Node ${raw?.environment?.node} is not the pinned ${pins?.node}`,
    );
  if (
    typeof pins?.nodeBinarySha256 !== 'string' ||
    raw?.environment?.nodeBinarySha256 !== pins.nodeBinarySha256
  )
    problems.push(
      `${label}: Node binary digest is missing or not the pinned archived binary`,
    );
  if (ref != null) {
    for (const pkg of manifest.packages)
      if (
        ref.packages?.[pkg.name]?.integrity !== pkg.registry.registryIntegrity
      )
        problems.push(
          `${label}: ${reference} does not run the unchanged ${pkg.name} tarball`,
        );
    if (
      ref.installedPandamstyle?.sha256 !==
      manifest.closure.installedPandamstyle.sha256
    )
      problems.push(
        `${label}: ${reference} installed @pandamstyle tree is not the manifest's`,
      );
    const lock = manifest.lockfiles.find((l) =>
      l.path.endsWith('closure/package-lock.json'),
    );
    if (ref.packageLockSha256 !== lock?.sha256)
      problems.push(
        `${label}: ${reference} closure lockfile is not the manifest's`,
      );
    for (const host of REQUIRED_HOSTS)
      if (ref.hosts?.[host] !== manifest.closure.hosts[host])
        problems.push(
          `${label}: ${reference} host ${host} is not the manifest's`,
        );
  }
  if (
    cand != null &&
    (typeof cand.packageLockSha256 !== 'string' ||
      typeof cand.installedPandamstyle?.sha256 !== 'string' ||
      cand.packages == null)
  )
    refusals.push(`${label}: candidate ${candidate} identity is not recorded`);
  return {
    problems,
    refusals,
    identity:
      cand == null
        ? null
        : {
            name: cand.name,
            packageLockSha256: cand.packageLockSha256 ?? null,
            installedPandamstyle: cand.installedPandamstyle?.sha256 ?? null,
            packages: cand.packages ?? null,
          },
  };
}

// Every planned observation of one epoch for one budget: a status per round
// (ok, missing, duplicate, failed, invalid) and the valid values.
function observe(raw, epoch, budget, metric, valid) {
  const planned = raw?.plan?.repetitions?.[budget.workload]?.[metric.kind];
  const samples = (raw?.samples ?? []).filter(
    (s) =>
      s?.epoch === epoch &&
      s?.workload === budget.workload &&
      s?.kind === metric.kind,
  );
  const counts = {
    planned: Number.isInteger(planned) ? planned : 0,
    ok: 0,
    missing: 0,
    duplicate: 0,
    failed: 0,
    invalid: 0,
    unplanned: 0,
  };
  const byRound = new Map();
  for (const s of samples) {
    if (!Number.isInteger(s.round) || s.round < 0 || s.round >= counts.planned)
      counts.unplanned++;
    else byRound.set(s.round, [...(byRound.get(s.round) ?? []), s]);
  }
  const rounds = new Map();
  for (let r = 0; r < counts.planned; r++) {
    const found = byRound.get(r) ?? [];
    if (found.length === 0) counts.missing++;
    else if (found.length > 1) counts.duplicate++;
    else if (found[0].result?.ok !== true) counts.failed++;
    else {
      const value = safeGet(metric, found[0].result);
      if (!valid(value)) counts.invalid++;
      else {
        counts.ok++;
        rounds.set(r, { value, index: found[0].index });
      }
    }
  }
  return {
    counts,
    rounds,
    complete:
      counts.ok === counts.planned &&
      counts.unplanned === 0 &&
      counts.planned > 0,
  };
}

export function evaluate(
  budgets,
  raws,
  {
    candidate,
    reference = 'alpha1',
    manifest,
    workloads,
    workloadsSha256,
    harness,
    pins,
  },
) {
  const problems = [];
  const refusals = [];
  const identities = [];
  const context = {
    manifest,
    workloads,
    harness,
    pins: pins ?? budgets.baseline?.environment,
    workloadsSha256: workloadsSha256 ?? budgets.baseline?.workloads?.sha256,
  };
  if (!Array.isArray(raws) || raws.length === 0)
    refusals.push('no run to evaluate');
  if (reference !== budgets.baseline?.epoch)
    refusals.push(
      `the control must be the budgets' baseline epoch ${budgets.baseline?.epoch}, not ${reference}`,
    );
  if (candidate == null || candidate === reference)
    refusals.push('the candidate must be a named epoch other than the control');
  const labels = (raws ?? []).map((raw) => raw?.label);
  if (new Set(labels).size !== labels.length)
    refusals.push('the same run is given more than once');
  for (const raw of raws ?? []) {
    const checked = runChecks(raw, context, reference, candidate);
    problems.push(...checked.problems);
    refusals.push(...checked.refusals);
    identities.push({ label: raw?.label ?? null, candidate: checked.identity });
  }
  const samples = (raws ?? []).flatMap((r) => r?.samples ?? []);
  const metrics = metricsFor(samples.filter((s) => s?.result != null));
  const results = [];
  for (const budget of budgets.budgets) {
    const metric =
      metrics.find((m) => m.id === budget.metric) ??
      (budget.metric.startsWith('incremental.')
        ? incrementalMetric(budget.metric)
        : null);
    const entry = {
      workload: budget.workload,
      metric: budget.metric,
      class: budget.class,
      limit: budget.limit,
    };
    const present = (raws ?? []).filter(
      (raw) =>
        Array.isArray(raw?.workloads) &&
        raw.workloads.some((w) => w?.id === budget.workload),
    );
    if (metric == null || present.length === 0) {
      results.push({ ...entry, status: 'not-run' });
      continue;
    }
    const ratio = budget.limit.mode === 'paired-ratio';
    const valid =
      budget.class === 'identity'
        ? (v) => typeof v === 'string'
        : ratio || budget.limit.mode === 'absolute'
          ? isPositive
          : isCount;
    const totals = { candidate: {}, control: {}, pairs: 0, nonAdjacent: 0 };
    const add = (into, counts) => {
      for (const [k, v] of Object.entries(counts)) into[k] = (into[k] ?? 0) + v;
    };
    const pairs = [];
    const controlValues = [];
    const candidateValues = [];
    let spread = 0;
    let complete = true;
    for (const raw of present) {
      const c = observe(raw, candidate, budget, metric, valid);
      const r = observe(raw, reference, budget, metric, valid);
      add(totals.candidate, c.counts);
      add(totals.control, r.counts);
      complete = complete && c.complete && r.complete;
      for (const [round, obs] of c.rounds) {
        candidateValues.push(obs.value);
        const control = r.rounds.get(round);
        if (control == null) continue;
        if (Math.abs(control.index - obs.index) !== 1) totals.nonAdjacent++;
        else pairs.push([control.value, obs.value]);
      }
      const values = [...r.rounds.values()].map((o) => o.value);
      controlValues.push(...values);
      if (ratio) spread = Math.max(spread, relativeSpread(values) ?? Infinity);
    }
    totals.pairs = pairs.length;
    const detail = { observations: totals };
    if ((totals.candidate.failed ?? 0) > 0) {
      results.push({
        ...entry,
        ...detail,
        status: 'fail',
        reason: `${totals.candidate.failed} candidate samples failed`,
      });
      continue;
    }
    if (!complete || totals.nonAdjacent > 0) {
      results.push({
        ...entry,
        ...detail,
        status: 'inconclusive',
        reason:
          'planned observations missing, duplicated, failed, invalid or not interleaved',
      });
      continue;
    }
    if (ratio) {
      const paired = pairedRatio(pairs);
      Object.assign(detail, { pairedRatio: paired, controlSpread: spread });
      if (pairs.length < budget.limit.minPairs)
        results.push({
          ...entry,
          ...detail,
          status: 'inconclusive',
          reason: 'fewer pairs than the minimum',
        });
      else if (!(spread <= budget.limit.noiseCeiling))
        results.push({
          ...entry,
          ...detail,
          status: 'inconclusive',
          reason: 'alpha1 control spread exceeds the noise ceiling',
        });
      else if (paired.upper <= budget.limit.maxRatio)
        results.push({ ...entry, ...detail, status: 'pass' });
      else if (paired.median > budget.limit.maxRatio)
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
      const value = median(candidateValues);
      results.push({
        ...entry,
        ...detail,
        status: value <= budget.limit.maxMedian ? 'pass' : 'fail',
        value,
      });
    } else if (budget.class === 'deterministic') {
      const controlDistinct = [...new Set(controlValues)];
      if (
        controlDistinct.length !== 1 ||
        controlDistinct[0] !== budget.baseline.value
      )
        problems.push(
          `${budget.workload} ${budget.metric}: ${reference} did not reproduce its frozen value ${budget.baseline.value} (${controlDistinct.join(', ')})`,
        );
      const distinct = [...new Set(candidateValues)];
      const pass =
        distinct.length === 1 && distinct[0] <= budget.limit.maxValue;
      results.push({
        ...entry,
        ...detail,
        status: pass ? 'pass' : 'fail',
        value: distinct.length === 1 ? distinct[0] : distinct,
        ...(distinct.length > 1
          ? { reason: 'non-deterministic candidate output' }
          : {}),
      });
    } else if (budget.class === 'identity') {
      const distinct = [...new Set(candidateValues)];
      const pass = distinct.length === 1 && distinct[0] === budget.limit.equals;
      results.push({
        ...entry,
        ...detail,
        status: pass ? 'pass' : 'fail',
        value: distinct.length === 1 ? distinct[0] : distinct,
      });
    } else
      results.push({
        ...entry,
        ...detail,
        status: 'inconclusive',
        reason: 'unknown budget kind',
      });
  }
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
    candidateIdentity: identities,
    counts: {
      pass: count('pass'),
      fail: count('fail'),
      inconclusive: count('inconclusive'),
      notRun: count('not-run'),
      unknown: (budgets.unknown ?? []).length,
    },
    load: (raws ?? []).map((raw) => ({
      label: raw?.label ?? null,
      before: raw?.load?.before?.at(-1) ?? null,
      after: raw?.load?.after ?? null,
      batch: raw?.load?.batch ?? null,
    })),
    results,
    unknown: (budgets.unknown ?? []).map((u) => ({ ...u, status: 'unknown' })),
  };
}

// An incremental metric defined by its id, for budgets whose edit has no
// sample at all in the run (its observations then count as missing).
function incrementalMetric(id) {
  const [, edit, field] =
    /^incremental\.(.+)\.(totalMs|toDiagnosticsMs)$/.exec(id) ?? [];
  if (edit == null) return null;
  return {
    id,
    kind: 'compile',
    class: 'timing',
    get: (r) => {
      const found = r.incremental?.find((e) => e.id === edit);
      return found == null
        ? undefined
        : median(
            found.iterations
              .filter((i) => i.iteration > 0)
              .map((i) => i[field]),
          );
    },
  };
}

// Release gate: budgets, policy, manifest, workloads and harness come from
// Git at `rev`, the budgets version in force there is verified back to
// version 1, and the run files are validated against them. A `--budgets`
// file that is not byte-identical to the in-force committed version is
// evaluated in non-release mode and can never pass.
export function gate({
  rev = 'HEAD',
  budgetsFile = null,
  rawFiles,
  candidate,
  reference = 'alpha1',
  root = REPO,
}) {
  const source = gitSource(rev, root);
  const provenance = {
    rev,
    commit: source.commit,
    mode: 'release',
    budgets: null,
    problems: [],
  };
  const inForce = inForceBudgets(source);
  let budgets = null;
  if (inForce == null)
    provenance.problems.push(`no committed budgets at ${rev}`);
  else {
    provenance.budgets = inForce;
    const chain = verifyBudgetsChain(source, inForce);
    provenance.problems.push(...chain.problems);
    budgets = chain.budgets;
  }
  if (budgetsFile != null) {
    const bytes = fs.readFileSync(budgetsFile);
    const relative = path.relative(root, path.resolve(budgetsFile));
    if (
      inForce == null ||
      relative !== inForce ||
      sha256(bytes) !== sha256(source.read(inForce))
    ) {
      provenance.mode = 'non-release';
      provenance.budgets = relative;
      budgets = jsonOf(bytes);
    }
  }
  const manifest = jsonOf(source.read(MANIFEST_PATH));
  const workloadsBytes = source.read(WORKLOADS_PATH);
  const harness = Object.fromEntries(
    HARNESS_FILES.map((f) => [
      f,
      source.read(`tools/baselines/${f}`) == null
        ? null
        : sha256(source.read(`tools/baselines/${f}`)),
    ]),
  );
  const raws = rawFiles.map((file) => jsonOf(fs.readFileSync(file)));
  const report =
    budgets == null || manifest == null || workloadsBytes == null
      ? {
          kind: 'pandamstyle-ce003-gate',
          verdict: 'fail',
          problems: ['budgets, manifest or workloads record unavailable'],
          refusals: [],
          results: [],
          counts: {},
        }
      : evaluate(budgets, raws, {
          candidate,
          reference,
          manifest,
          workloads: jsonOf(workloadsBytes),
          workloadsSha256: sha256(workloadsBytes),
          harness,
          pins: budgets.baseline?.environment,
        });
  report.provenance = provenance;
  if (provenance.mode === 'release' && provenance.problems.length > 0) {
    report.problems = [...provenance.problems, ...report.problems];
    report.verdict = 'fail';
  }
  if (provenance.mode === 'non-release' && report.verdict === 'pass')
    report.verdict = 'not-release';
  return report;
}

// ---------------------------------------------------------------------- cli

function collect(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === flag) out.push(path.resolve(argv[i + 1]));
  return out;
}

const option = (argv, flag) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...argv] = process.argv.slice(2);
  if (command === 'freeze') {
    const files = collect(argv, '--results');
    const policy = loadPolicy(collect(argv, '--policy')[0]);
    const budgets = deriveBudgets(
      policy,
      files.map(readJson),
      files.map(resultRef),
    );
    writeJson(collect(argv, '--out')[0], budgets);
    console.log(
      `${budgets.budgets.length} budgets, ${budgets.unknown.length} unknown metrics`,
    );
  } else if (command === 'gate') {
    const report = gate({
      rev: option(argv, '--rev') ?? 'HEAD',
      budgetsFile: collect(argv, '--budgets')[0] ?? null,
      rawFiles: collect(argv, '--results'),
      candidate: option(argv, '--candidate'),
      reference: option(argv, '--reference') ?? 'alpha1',
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `verdict ${report.verdict} (${report.provenance.mode} at ${report.provenance.commit.slice(0, 12)}): ${JSON.stringify(report.counts)}; problems: ${report.problems.length}; refusals: ${report.refusals.length}\n`,
    );
    process.exitCode = report.verdict === 'pass' ? 0 : 1;
  } else {
    console.error('usage: budgets.mjs freeze|gate ...');
    process.exitCode = 2;
  }
}
