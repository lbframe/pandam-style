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

// The statistic an absolute limit applies to. `median` is the default.
// `min` (the minimum over all samples) is allowed only for absolute peak-RSS
// memory budgets: garbage-collector headroom is one-sided additive noise on
// peak RSS, so the minimum estimates the working-set floor. Any other
// statistic, or `min` anywhere else, is refused.
export const STATISTICS = ['median', 'min'];
const minAllowed = (cls, metric) =>
  cls === 'memory' && /(^|\.)maxRssBytes$/.test(metric);

// The policy's per-budget statistic overrides (thresholdRule.statistic), after
// validation. A policy without the field uses the median everywhere.
function statisticOverrides(policy, metrics) {
  const rule = policy.thresholdRule.statistic;
  const overrides = new Map();
  if (rule == null) return overrides;
  if (rule.default !== 'median')
    throw new Error(`statistic default must be median, not ${rule.default}`);
  for (const o of rule.overrides ?? []) {
    const metric = metrics.find((m) => m.id === o.metric);
    if (!STATISTICS.includes(o.statistic))
      throw new Error(
        `${o.workload} ${o.metric}: unknown statistic ${o.statistic}`,
      );
    if (o.statistic === 'min' && !minAllowed(metric?.class, o.metric))
      throw new Error(
        `${o.workload} ${o.metric}: statistic min is allowed only for absolute peak-RSS memory budgets`,
      );
    const key = `${o.workload}\0${o.metric}`;
    if (overrides.has(key))
      throw new Error(`${o.workload} ${o.metric}: statistic given twice`);
    overrides.set(key, o.statistic);
  }
  return overrides;
}

// Statistic problems of a budgets file, checked by the gate whatever its
// origin: an unknown statistic, or `min` outside absolute peak-RSS budgets.
export function statisticProblems(budgets) {
  const problems = [];
  for (const b of budgets?.budgets ?? []) {
    const statistic = b.limit?.statistic ?? 'median';
    const at = `${b.workload} ${b.metric}`;
    if (!STATISTICS.includes(statistic))
      problems.push(`${at}: unknown statistic ${statistic}`);
    else if (
      statistic === 'min' &&
      !(
        b.limit.mode === 'absolute' &&
        minAllowed(b.class, b.metric) &&
        Number.isFinite(b.limit.maxMin)
      )
    )
      problems.push(
        `${at}: statistic min is allowed only for absolute peak-RSS memory budgets`,
      );
  }
  return problems;
}

// Derives budgets from a policy (threshold rule, budgeted metrics, unknown
// metrics) and baseline raws. Pure: identical inputs give identical output.
export function deriveBudgets(policy, raws, resultRefs, options = {}) {
  const epochs = [policy.baseline.reference, policy.baseline.nullEpoch];
  const samples = raws.flatMap((r) => r.samples);
  const metrics = metricsFor(samples);
  const statistics = statisticOverrides(policy, metrics);
  const used = new Set();
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
        const key = `${workload}\0${metric.id}`;
        if (statistics.get(key) === 'min') {
          // Absolute by declaration. The factor follows the memory rule on
          // the reproducibility of the minimum itself: the CV of the minima
          // of each baseline run and epoch.
          used.add(key);
          const minima = [];
          for (const raw of raws)
            for (const epoch of epochs) {
              const v = valuesOf([raw], [epoch], workload, metric);
              if (v.length > 0) minima.push(Math.min(...v));
            }
          const min = Math.min(...values);
          const minimaCv = coefficientOfVariation(minima) ?? 0;
          entry.baseline.informational = false;
          entry.baseline.statistic = 'min';
          entry.baseline.min = min;
          entry.baseline.minima = minima;
          entry.baseline.cv = cv;
          entry.baseline.minimaCv = minimaCv;
          const factor = roundUp(
            Math.max(memory.floor, 1 + memory.cvMultiplier * minimaCv),
            memory.roundUpTo,
          );
          entry.limit = {
            mode: 'absolute',
            statistic: 'min',
            maxMin: Math.floor(min * factor),
            factor,
          };
        } else if (
          metric.class === 'memory' &&
          cv != null &&
          cv <= memory.maxCv
        ) {
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
  for (const key of statistics.keys())
    if (!used.has(key))
      throw new Error(
        `statistic override for ${key.replace('\0', ' ')} matches no derived budget`,
      );
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
  if ((previous.statistic ?? 'median') !== (next.statistic ?? 'median'))
    return true;
  for (const key of [
    'maxRatio',
    'noiseCeiling',
    'maxMedian',
    'maxMin',
    'maxValue',
  ])
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
  const planIds = [...new Set(raws.map((raw) => raw?.plan?.id))];
  if (raws.length > 0 && planIds.length !== 1)
    problems.push(`${at}: baseline evidence mixes plans`);
  return {
    budgets,
    problems,
    planId: planIds.length === 1 ? planIds[0] : null,
  };
}

// ----------------------------------------------------------- reconciliation

// Before any statistic, every raw run is reconciled 1:1 against the cells
// that the committed plan, workloads record, harness, manifest and budgets
// pins at the evaluated revision require: exact keys (nothing missing or
// extra) and value types for every object, the exact sample cells (epoch,
// workload, kind, round), incremental edits and iterations, canonical
// comparisons, identities and environment. The raw `workloads` list is only
// checked, never used to select what is inspected. Any reconciliation error
// makes the verdict non-passing.

const RAW_KIND = 'pandamstyle-ce003-raw-results';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
export const RECORDED_HOSTS = [
  'vite',
  'next',
  '@rsbuild/core',
  '@rspack/core',
  'react',
  'react-dom',
  '@vitejs/plugin-react',
  'playwright-core',
  'typescript',
];
const PROJECTIONS = [
  'css',
  'designModule',
  'declarations',
  'manifest',
  'artifacts',
  'compiledModules',
];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const T = {
  pos: (v) => finite(v) && v > 0,
  nonneg: (v) => finite(v) && v >= 0,
  int: (v) => Number.isInteger(v) && v >= 0,
  posint: (v) => Number.isInteger(v) && v > 0,
  str: (v) => typeof v === 'string' && v.length > 0,
  strOrNull: (v) => v === null || (typeof v === 'string' && v.length > 0),
  bool: (v) => typeof v === 'boolean',
  sha: (v) => typeof v === 'string' && HEX64.test(v),
  sha40: (v) => typeof v === 'string' && HEX40.test(v),
  integrity: (v) => typeof v === 'string' && INTEGRITY.test(v),
  date: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  eq: (expected) => (v) => v === expected,
  triple: (v) =>
    Array.isArray(v) && v.length === 3 && v.every((x) => finite(x) && x >= 0),
};

// Checks `value` against `spec`: a predicate, or an object of exact keys
// (every key required, no other key allowed).
function check(value, spec, at, errors) {
  if (typeof spec === 'function') {
    if (!spec(value)) errors.push(`${at}: invalid value`);
    return;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${at}: expected an object`);
    return;
  }
  for (const key of Object.keys(value))
    if (!(key in spec)) errors.push(`${at}.${key}: unexpected key`);
  for (const [key, inner] of Object.entries(spec)) {
    if (!(key in value)) errors.push(`${at}.${key}: missing`);
    else check(value[key], inner, `${at}.${key}`, errors);
  }
}

function checkArray(value, at, errors, length, each) {
  if (!Array.isArray(value)) return errors.push(`${at}: expected an array`);
  if (length != null && value.length !== length)
    errors.push(`${at}: expected ${length} elements, found ${value.length}`);
  value.forEach((item, i) => each(item, `${at}[${i}]`, i));
}

const SNAPSHOT = {
  at: T.date,
  loadavg: T.triple,
  windowMs: T.pos,
  cpuUtilisation: T.nonneg,
  busyCores: T.nonneg,
  foreignBusyProcesses: T.int,
  foreignBusyCores: T.nonneg,
  foreignHeavyCores: T.nonneg,
};
// CPU times come from process.resourceUsage(), which the kernel may account
// in ticks: a process can legitimately record zero system (or user) time.
// Zero is valid; negative, non-finite and missing values stay invalid. Peak
// RSS of a running process cannot be zero.
const USAGE = {
  maxRssBytes: T.pos,
  userCpuMs: T.nonneg,
  systemCpuMs: T.nonneg,
};
const SIZES = { bytes: T.pos, gzipBytes: T.pos, brotliBytes: T.pos };
const ITERATION_TIMES = [
  'applyMs',
  'validateMs',
  'compileMs',
  'toDiagnosticsMs',
  'totalMs',
];

function compileSpec(kind) {
  return {
    ok: T.eq(true),
    kind: T.eq(kind),
    importMs: T.pos,
    full: {
      initializeMs: T.pos,
      validateMs: T.pos,
      compileMs: T.pos,
      toDiagnosticsMs: T.pos,
      totalMs: T.pos,
    },
    afterFull: USAGE,
    output: {
      css: {
        ...SIZES,
        sha256: T.sha,
        styleRules: T.posint,
        atRules: T.int,
        declarations: T.posint,
        distinctClassNames: T.posint,
        balanced: T.eq(true),
      },
      designModule: { ...SIZES, sha256: T.sha },
      declarationsBytes: T.pos,
      compiledModules: { count: T.posint, bytes: T.pos, sha256: T.sha },
      metadataBytes: {
        'artifacts.json': T.pos,
        'manifest.json': T.pos,
        'build-report.json': T.pos,
      },
      report: {
        ruleCount: T.posint,
        designSystemRuleCount: T.int,
        consumerRuleCount: T.int,
        cssBytes: T.pos,
        coveredFileCount: T.posint,
        analysedFileCount: T.posint,
      },
      variants: {
        recipes: T.int,
        recipeAxisValues: T.int,
        recipeSelections: T.int,
        compoundVariants: T.int,
        themes: T.int,
        conditions: T.int,
        tokens: T.int,
      },
    },
    incremental: () => true,
    restoredToFullOutput: T.eq(true),
    final: USAGE,
    wallMs: T.pos,
    ...(kind === 'consistency' ? { canonical: () => true } : {}),
  };
}

const RESULT_SPECS = {
  compile: compileSpec('compile'),
  consistency: compileSpec('consistency'),
  runtime: {
    ok: T.eq(true),
    kind: T.eq('runtime'),
    modules: T.posint,
    moduleLoadMs: T.pos,
    recordedPropsCalls: T.int,
    rejectedPropsCalls: T.int,
    recordedRecipeSelections: T.int,
    renders: T.int,
    renderErrors: T.int,
    propsNsPerCall: () => true,
    recipeSelectNsPerCall: () => true,
    renderNsPerCall: () => true,
    sink: T.eq(true),
    final: USAGE,
    wallMs: T.pos,
  },
  vite: {
    ok: T.eq(true),
    kind: T.eq('vite'),
    importMs: T.pos,
    buildMs: T.pos,
    css: { files: T.posint, ...SIZES },
    js: { files: T.posint, ...SIZES },
    distSha256: T.sha,
    final: USAGE,
    wallMs: T.pos,
  },
};

function checkResult(result, kind, workload, plan, at, errors) {
  if (result?.ok === false) {
    check(result, { ok: T.eq(false), error: T.str }, at, errors);
    return;
  }
  check(result, RESULT_SPECS[kind], at, errors);
  if (kind === 'compile' || kind === 'consistency') {
    const iterations =
      kind === 'consistency'
        ? 2
        : (plan.incrementalIterationsByWorkload?.[workload.id] ??
          plan.incrementalIterations);
    const edits = workload.edits ?? [];
    checkArray(
      result?.incremental,
      `${at}.incremental`,
      errors,
      edits.length,
      (edit, eat, e) => {
        check(
          edit,
          {
            id: T.eq(edits[e].id),
            iterations: () => true,
            restoredCssSha256: T.sha,
          },
          eat,
          errors,
        );
        checkArray(
          edit?.iterations,
          `${eat}.iterations`,
          errors,
          iterations,
          (it, iat, k) =>
            check(
              it,
              {
                iteration: T.eq(k),
                direction: T.eq(k % 2 === 0 ? 'forward' : 'back'),
                ...Object.fromEntries(ITERATION_TIMES.map((f) => [f, T.pos])),
              },
              iat,
              errors,
            ),
        );
      },
    );
    if (kind === 'consistency')
      checkArray(
        result?.canonical,
        `${at}.canonical`,
        errors,
        edits.length,
        (c, cat, e) => {
          const digests = Object.fromEntries(
            PROJECTIONS.map((p) => [p, T.sha]),
          );
          check(
            c,
            {
              id: T.eq(edits[e].id),
              equal: Object.fromEntries(PROJECTIONS.map((p) => [p, T.bool])),
              incremental: digests,
              canonical: digests,
            },
            cat,
            errors,
          );
          for (const p of PROJECTIONS)
            if (c?.equal?.[p] !== (c?.incremental?.[p] === c?.canonical?.[p]))
              errors.push(
                `${cat}.equal.${p}: contradicts the recorded digests`,
              );
        },
      );
  }
  if (kind === 'runtime')
    for (const [field, count] of [
      ['propsNsPerCall', 'recordedPropsCalls'],
      ['recipeSelectNsPerCall', 'recordedRecipeSelections'],
      ['renderNsPerCall', 'renders'],
    ]) {
      const ok =
        result?.[count] === 0
          ? result?.[field] === null
          : T.pos(result?.[field]);
      if (!ok)
        errors.push(`${at}.${field}: invalid for ${count} ${result?.[count]}`);
    }
}

function identitySpec(manifest) {
  return {
    name: T.str,
    closure: T.str,
    packageLockSha256: T.sha,
    packages: Object.fromEntries(
      manifest.packages.map((p) => [
        p.name,
        { version: T.str, resolved: T.str, integrity: T.integrity },
      ]),
    ),
    installedPandamstyle: { sha256: T.sha, files: T.posint, bytes: T.posint },
    hosts: Object.fromEntries(RECORDED_HOSTS.map((h) => [h, T.str])),
  };
}

// The identity that must agree across pooled runs of one epoch.
const identityKey = (epoch) =>
  JSON.stringify({
    packageLockSha256: epoch?.packageLockSha256,
    packages: epoch?.packages,
    installedPandamstyle: epoch?.installedPandamstyle,
    hosts: epoch?.hosts,
  });

// Reconciles one raw run with the committed expectations. Returns errors.
export function reconcile(raw, expected) {
  const errors = [];
  const {
    plan,
    workloadsRecord,
    workloadsSha256,
    harness,
    pins,
    manifest,
    reference,
    candidate,
  } = expected;
  const at = raw?.label ?? '<run>';
  check(
    raw,
    {
      schemaVersion: T.eq(1),
      kind: T.eq(RAW_KIND),
      label: T.str,
      plan: () => true,
      workloadsRecord: {
        path: T.eq(WORKLOADS_PATH),
        sha256: T.eq(workloadsSha256),
      },
      harness: Object.fromEntries(
        HARNESS_FILES.map((f) => [f, T.eq(harness[f])]),
      ),
      repositoryCommit: T.sha40,
      repositoryDirty: T.eq(false),
      environment: {
        os: T.str,
        kernel: T.str,
        architecture: T.str,
        cpu: T.str,
        logicalCores: T.posint,
        memoryBytes: T.posint,
        scalingGovernor: T.strOrNull,
        boost: T.strOrNull,
        filesystem: T.str,
        node: T.eq(pins?.node),
        nodeBinary: T.str,
        nodeBinarySha256: T.eq(pins?.nodeBinarySha256),
      },
      quietRule: {
        maxCpuUtilisation: T.nonneg,
        maxForeignHeavyCores: T.nonneg,
        description: T.str,
      },
      epochs: () => true,
      workloads: () => true,
      load: {
        before: (v) => Array.isArray(v) && v.length > 0,
        after: SNAPSHOT,
        quietAtStart: T.bool,
        quietRequired: T.bool,
        quietAtEnd: T.bool,
        batch: {
          maxLoadavg1: T.nonneg,
          maxSampleCpuUtilisation: T.nonneg,
          meanSampleCpuUtilisation: T.nonneg,
        },
      },
      seed: T.int,
      startedAt: T.date,
      finishedAt: T.date,
      samples: () => true,
    },
    at,
    errors,
  );
  if (raw === null || typeof raw !== 'object') return errors;
  if (plan == null || JSON.stringify(raw.plan) !== JSON.stringify(plan))
    errors.push(`${at}.plan: not the committed plan of the baseline`);
  checkArray(raw.load?.before, `${at}.load.before`, errors, null, (s, sat) =>
    check(s, SNAPSHOT, sat, errors),
  );

  // Epochs: exactly the control and the candidate, each fully identified.
  const names = (Array.isArray(raw.epochs) ? raw.epochs : []).map(
    (e) => e?.name,
  );
  if (
    names.length !== 2 ||
    !names.includes(reference) ||
    !names.includes(candidate) ||
    reference === candidate
  )
    errors.push(`${at}.epochs: must be exactly ${reference} and ${candidate}`);
  checkArray(raw.epochs, `${at}.epochs`, errors, null, (e, eat) =>
    check(e, identitySpec(manifest), eat, errors),
  );

  // Expected sample cells, from the committed plan only. A planned workload
  // is either entirely absent from the run (its budgets are not run) or
  // complete; the raw workloads list must name exactly the measured ones.
  const samples = Array.isArray(raw.samples) ? raw.samples : [];
  if (!Array.isArray(raw.samples))
    errors.push(`${at}.samples: expected an array`);
  const byWorkload = new Map(workloadsRecord.workloads.map((w) => [w.id, w]));
  const measured = new Set();
  samples.forEach((s, i) => {
    const sat = `${at}.samples[${i}]`;
    check(
      s,
      {
        index: T.eq(i),
        round: T.int,
        epoch: (v) => v === reference || v === candidate,
        workload: (v) =>
          typeof v === 'string' && plan?.repetitions?.[v] != null,
        kind: (v) =>
          typeof v === 'string' &&
          plan?.repetitions?.[s?.workload]?.[v] != null,
        startedAt: T.date,
        load: {
          loadavgBefore: T.triple,
          loadavgAfter: T.triple,
          cpuUtilisation: T.nonneg,
        },
        result: () => true,
      },
      sat,
      errors,
    );
    const workload = byWorkload.get(s?.workload);
    if (
      workload != null &&
      RESULT_SPECS[s?.kind] != null &&
      plan?.repetitions?.[s.workload]?.[s.kind] != null
    ) {
      measured.add(s.workload);
      checkResult(s.result, s.kind, workload, plan, `${sat}.result`, errors);
    }
  });
  const cells = new Map();
  for (const s of samples) {
    const key = `${s?.epoch}\0${s?.workload}\0${s?.kind}\0${s?.round}`;
    cells.set(key, [...(cells.get(key) ?? []), s]);
  }
  for (const id of measured) {
    for (const [kind, count] of Object.entries(plan.repetitions[id]))
      for (let round = 0; round < count; round++) {
        const pair = [reference, candidate].map(
          (epoch) => cells.get(`${epoch}\0${id}\0${kind}\0${round}`) ?? [],
        );
        for (const [n, found] of pair.entries())
          if (found.length !== 1)
            errors.push(
              `${at}: ${[reference, candidate][n]} ${id} ${kind} round ${round} has ${found.length} samples`,
            );
        if (
          pair.every((f) => f.length === 1) &&
          Math.abs(pair[0][0].index - pair[1][0].index) !== 1
        )
          errors.push(`${at}: ${id} ${kind} round ${round} is not interleaved`);
      }
  }
  for (const [key, found] of cells) {
    const [, id, kind, round] = key.split('\0');
    const count = plan?.repetitions?.[id]?.[kind];
    if (count == null || !(Number(round) < count) || found.length > 1)
      errors.push(
        `${at}: unplanned or duplicate cell ${key.replace(/\0/g, ' ')}`,
      );
  }
  const listed = Array.isArray(raw.workloads) ? raw.workloads : [];
  checkArray(raw.workloads, `${at}.workloads`, errors, null, (w, wat) =>
    check(
      w,
      {
        id: T.str,
        contentSha256: T.eq(byWorkload.get(w?.id)?.contentSha256),
        files: T.posint,
        bytes: T.posint,
      },
      wat,
      errors,
    ),
  );
  const ids = listed.map((w) => w?.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== measured.size ||
    ids.some((id) => !measured.has(id))
  )
    errors.push(
      `${at}.workloads: must list exactly the measured workloads ${[...measured].sort().join(', ')}`,
    );
  return errors;
}

// ------------------------------------------------------------------- gate

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function safeGet(metric, result) {
  try {
    return metric.get(result);
  } catch {
    return undefined;
  }
}

// Control identity against the manifest; candidate identity consistent
// across pooled runs.
function identityChecks(raws, { manifest, reference, candidate }) {
  const problems = [];
  const refusals = [];
  for (const raw of raws) {
    const label = raw?.label ?? '<run>';
    const ref = (raw?.epochs ?? []).find((e) => e?.name === reference);
    if (ref == null) continue;
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
  for (const epoch of [reference, candidate]) {
    const keys = new Set(
      raws.map((raw) =>
        identityKey((raw?.epochs ?? []).find((e) => e?.name === epoch)),
      ),
    );
    if (keys.size > 1)
      refusals.push(`${epoch}: identity differs across pooled runs`);
  }
  const identity = raws.map(
    (raw) => (raw?.epochs ?? []).find((e) => e?.name === candidate) ?? null,
  )[0];
  return {
    problems,
    refusals,
    candidateIdentity:
      identity == null
        ? null
        : {
            name: identity.name,
            packageLockSha256: identity.packageLockSha256,
            installedPandamstyle: identity.installedPandamstyle?.sha256,
            packages: identity.packages,
          },
  };
}

// Samples of one run by (epoch, workload, kind, round). Built afresh on every
// evaluation, so it always reflects the run being judged.
function indexSamples(raw) {
  const index = new Map();
  for (const s of Array.isArray(raw?.samples) ? raw.samples : []) {
    const key = `${s?.epoch}\0${s?.workload}\0${s?.kind}\0${s?.round}`;
    index.set(key, [...(index.get(key) ?? []), s]);
  }
  return index;
}

// pairedRatio is a pure, seeded function of its pairs; identical pairs are
// computed once.
const pairedMemo = new Map();
function pairedRatioOf(pairs) {
  const key = pairs.map(([a, b]) => `${a},${b}`).join(';');
  if (!pairedMemo.has(key)) pairedMemo.set(key, pairedRatio(pairs));
  return pairedMemo.get(key);
}

// Valid planned observations of one epoch for one budget, by round.
function observe(raw, index, epoch, budget, metric, valid, plan) {
  const planned = plan?.repetitions?.[budget.workload]?.[metric.kind] ?? 0;
  const rounds = new Map();
  const counts = { planned, ok: 0, failed: 0, invalid: 0, missing: 0 };
  for (let round = 0; round < planned; round++) {
    const found =
      index.get(`${epoch}\0${budget.workload}\0${metric.kind}\0${round}`) ?? [];
    if (found.length !== 1) counts.missing++;
    else if (found[0].result?.ok !== true) counts.failed++;
    else {
      const value = safeGet(metric, found[0].result);
      if (!valid(value)) counts.invalid++;
      else {
        counts.ok++;
        rounds.set(round, { value, index: found[0].index });
      }
    }
  }
  return { counts, rounds };
}

// An incremental metric defined by its id, independent of what a run holds.
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

const METRIC_BY_ID = new Map(metricsFor([]).map((m) => [m.id, m]));
const metricOf = (id) => METRIC_BY_ID.get(id) ?? incrementalMetric(id);

// Evaluates committed budgets against raw runs. `expected` carries the
// committed plan, workloads record and digest, harness digests, manifest and
// environment pins of the evaluated revision.
export function evaluate(
  budgets,
  raws,
  { candidate, reference = 'alpha1', expected },
) {
  const problems = [...statisticProblems(budgets)];
  const refusals = [];
  const reconciliation = [];
  raws = Array.isArray(raws) ? raws : [];
  if (raws.length === 0) refusals.push('no run to evaluate');
  if (reference !== budgets.baseline?.epoch)
    refusals.push(
      `the control must be the budgets' baseline epoch ${budgets.baseline?.epoch}, not ${reference}`,
    );
  if (candidate == null || candidate === reference)
    refusals.push('the candidate must be a named epoch other than the control');
  const labels = raws.map((raw) => raw?.label);
  if (new Set(labels).size !== labels.length)
    refusals.push('the same run is given more than once');
  const context = {
    ...expected,
    reference,
    candidate,
    pins: expected.pins ?? budgets.baseline?.environment,
  };
  for (const raw of raws) reconciliation.push(...reconcile(raw, context));
  if (reconciliation.length > 0)
    refusals.push(
      `${reconciliation.length} reconciliation errors against the committed expectations`,
    );
  const identity = identityChecks(raws, context);
  problems.push(...identity.problems);
  refusals.push(...identity.refusals);
  const plan = expected.plan;
  const indexes = new Map(raws.map((raw) => [raw, indexSamples(raw)]));
  const results = [];
  for (const budget of budgets.budgets) {
    const metric = metricOf(budget.metric);
    const entry = {
      workload: budget.workload,
      metric: budget.metric,
      class: budget.class,
      limit: budget.limit,
    };
    // A workload is measured in a run when the run holds any sample of it;
    // the raw workloads list is reconciled, not trusted.
    const present = raws.filter(
      (raw) =>
        Array.isArray(raw?.samples) &&
        raw.samples.some((s) => s?.workload === budget.workload),
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
      const c = observe(
        raw,
        indexes.get(raw),
        candidate,
        budget,
        metric,
        valid,
        plan,
      );
      const r = observe(
        raw,
        indexes.get(raw),
        reference,
        budget,
        metric,
        valid,
        plan,
      );
      add(totals.candidate, c.counts);
      add(totals.control, r.counts);
      complete =
        complete &&
        c.counts.ok === c.counts.planned &&
        r.counts.ok === r.counts.planned &&
        c.counts.planned > 0;
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
          'planned observations missing, failed, invalid or not interleaved',
      });
      continue;
    }
    if (ratio) {
      const paired = pairedRatioOf(pairs);
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
      const min = budget.limit.statistic === 'min';
      const value = min
        ? Math.min(...candidateValues)
        : median(candidateValues);
      const limit = min ? budget.limit.maxMin : budget.limit.maxMedian;
      results.push({
        ...entry,
        ...detail,
        status: value <= limit ? 'pass' : 'fail',
        value,
        ...(min ? { statistic: 'min' } : {}),
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
    reconciliation: {
      errors: reconciliation.length,
      first: reconciliation.slice(0, 50),
    },
    candidateIdentity: identity.candidateIdentity,
    counts: {
      pass: count('pass'),
      fail: count('fail'),
      inconclusive: count('inconclusive'),
      notRun: count('not-run'),
      unknown: (budgets.unknown ?? []).length,
    },
    load: raws.map((raw) => ({
      label: raw?.label ?? null,
      before: raw?.load?.before?.at?.(-1) ?? null,
      after: raw?.load?.after ?? null,
      batch: raw?.load?.batch ?? null,
    })),
    results,
    unknown: (budgets.unknown ?? []).map((u) => ({ ...u, status: 'unknown' })),
  };
}

// Release context: budgets, policy, manifest, workloads record, harness and
// the baseline plan read from Git at `rev`, with the budgets in force
// verified back to version 1. A `--budgets` file that is not byte-identical
// to that committed version switches to non-release mode.
export function prepareGate({ rev = 'HEAD', budgetsFile = null, root = REPO }) {
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
  let planId = null;
  if (inForce == null)
    provenance.problems.push(`no committed budgets at ${rev}`);
  else {
    provenance.budgets = inForce;
    const chain = verifyBudgetsChain(source, inForce);
    provenance.problems.push(...chain.problems);
    budgets = chain.budgets;
    planId = chain.planId;
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
  const workloadsRecord = jsonOf(workloadsBytes);
  const harness = Object.fromEntries(
    HARNESS_FILES.map((f) => {
      const bytes = source.read(`tools/baselines/${f}`);
      return [f, bytes == null ? null : sha256(bytes)];
    }),
  );
  const plan =
    planId == null || workloadsRecord?.plans?.[planId] == null
      ? null
      : { id: planId, ...workloadsRecord.plans[planId] };
  const ready = budgets != null && manifest != null && workloadsRecord != null;
  return {
    provenance,
    budgets,
    expected: ready
      ? {
          plan,
          workloadsRecord,
          workloadsSha256: sha256(workloadsBytes),
          harness,
          manifest,
          pins: budgets.baseline?.environment,
        }
      : null,
  };
}

// An input the evaluation cannot even process fails closed.
function evaluateSafely(budgets, raws, options) {
  try {
    return evaluate(budgets, raws, options);
  } catch (error) {
    return {
      kind: 'pandamstyle-ce003-gate',
      verdict: 'inconclusive',
      problems: [],
      refusals: [`evaluation error: ${error.message}`],
      results: [],
      counts: {},
    };
  }
}

export function judge(prepared, raws, { candidate, reference = 'alpha1' }) {
  const { provenance, budgets, expected } = prepared;
  const report =
    expected == null
      ? {
          kind: 'pandamstyle-ce003-gate',
          verdict: 'fail',
          problems: ['budgets, manifest or workloads record unavailable'],
          refusals: [],
          results: [],
          counts: {},
        }
      : evaluateSafely(budgets, raws, { candidate, reference, expected });
  report.provenance = provenance;
  if (provenance.mode === 'release' && provenance.problems.length > 0) {
    report.problems = [...provenance.problems, ...report.problems];
    report.verdict = 'fail';
  }
  if (provenance.mode === 'non-release' && report.verdict === 'pass')
    report.verdict = 'not-release';
  return report;
}

export function gate({
  rev = 'HEAD',
  budgetsFile = null,
  rawFiles,
  candidate,
  reference = 'alpha1',
  root = REPO,
}) {
  const prepared = prepareGate({ rev, budgetsFile, root });
  const raws = rawFiles.map((file) => {
    try {
      return jsonOf(fs.readFileSync(file));
    } catch {
      return null;
    }
  });
  return judge(prepared, raws, { candidate, reference });
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
