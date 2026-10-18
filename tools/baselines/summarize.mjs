/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Metric definitions and summaries for CE-00.3 raw results.
//
//   node tools/baselines/summarize.mjs <raw.json> [<raw.json> ...] [--out <file>]
//
// Several raw files of the same plan and environment may be pooled. Each
// metric is summarized per (epoch, workload): median and nearest-rank p95
// with distribution-free 95% order-statistic intervals. Deterministic output
// metrics must be identical across every sample; a difference is reported as
// non-determinism, never averaged. With two or more epochs, every timing,
// memory and runtime metric also gets the ratio of medians against the first
// epoch with a seeded percentile-bootstrap interval.

import path from 'node:path';
import {
  bootstrapRatio,
  readJson,
  summarize,
  writeJson,
  median,
} from './lib.mjs';

const warm = (iterations) => iterations.filter((i) => i.iteration > 0);

// class: timing | memory | runtime | deterministic
export const METRICS = [
  {
    id: 'full.totalMs',
    kind: 'compile',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.full.totalMs,
  },
  {
    id: 'full.toDiagnosticsMs',
    kind: 'compile',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.full.toDiagnosticsMs,
  },
  {
    id: 'compiler.importMs',
    kind: 'compile',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.importMs,
  },
  {
    id: 'full.cpuMs',
    kind: 'compile',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.afterFull.userCpuMs + r.afterFull.systemCpuMs,
  },
  {
    id: 'full.maxRssBytes',
    kind: 'compile',
    class: 'memory',
    unit: 'bytes',
    get: (r) => r.afterFull.maxRssBytes,
  },
  {
    id: 'session.maxRssBytes',
    kind: 'compile',
    class: 'memory',
    unit: 'bytes',
    get: (r) => r.final.maxRssBytes,
  },
  {
    id: 'css.bytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.css.bytes,
  },
  {
    id: 'css.gzipBytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.css.gzipBytes,
  },
  {
    id: 'css.brotliBytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.css.brotliBytes,
  },
  {
    id: 'css.styleRules',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.css.styleRules,
  },
  {
    id: 'css.atRules',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.css.atRules,
  },
  {
    id: 'css.declarations',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.css.declarations,
  },
  {
    id: 'css.distinctClassNames',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.css.distinctClassNames,
  },
  {
    id: 'designModule.bytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.designModule.bytes,
  },
  {
    id: 'designModule.gzipBytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.designModule.gzipBytes,
  },
  {
    id: 'declarations.bytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.declarationsBytes,
  },
  {
    id: 'compiledModules.bytes',
    kind: 'compile',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.output.compiledModules.bytes,
  },
  {
    id: 'compiledModules.count',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.compiledModules.count,
  },
  {
    id: 'report.ruleCount',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.report.ruleCount,
  },
  {
    id: 'report.designSystemRuleCount',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.report.designSystemRuleCount,
  },
  {
    id: 'report.consumerRuleCount',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.report.consumerRuleCount,
  },
  {
    id: 'variants.recipeSelections',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.variants.recipeSelections,
  },
  {
    id: 'variants.recipeAxisValues',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.variants.recipeAxisValues,
  },
  {
    id: 'variants.compoundVariants',
    kind: 'compile',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.output.variants.compoundVariants,
  },
  {
    id: 'output.cssSha256',
    kind: 'compile',
    class: 'identity',
    get: (r) => r.output.css.sha256,
  },
  {
    id: 'output.compiledModulesSha256',
    kind: 'compile',
    class: 'identity',
    get: (r) => r.output.compiledModules.sha256,
  },
  {
    id: 'output.restoredAfterEdits',
    kind: 'compile',
    class: 'identity',
    get: (r) => String(r.restoredToFullOutput),
  },
  {
    id: 'consistency.incrementalEqualsCanonical',
    kind: 'consistency',
    class: 'identity',
    get: (r) =>
      String(
        r.canonical.length > 0 &&
          r.canonical.every(
            (c) => c.equal != null && Object.values(c.equal).every(Boolean),
          ),
      ),
  },
  {
    id: 'runtime.propsNsPerCall',
    kind: 'runtime',
    class: 'runtime',
    unit: 'ns',
    get: (r) => r.propsNsPerCall,
  },
  {
    id: 'runtime.recipeSelectNsPerCall',
    kind: 'runtime',
    class: 'runtime',
    unit: 'ns',
    get: (r) => r.recipeSelectNsPerCall,
  },
  {
    id: 'runtime.renderNsPerCall',
    kind: 'runtime',
    class: 'runtime',
    unit: 'ns',
    get: (r) => r.renderNsPerCall,
  },
  {
    id: 'runtime.moduleLoadMs',
    kind: 'runtime',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.moduleLoadMs,
  },
  {
    id: 'runtime.recordedPropsCalls',
    kind: 'runtime',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.recordedPropsCalls,
  },
  {
    id: 'runtime.recordedRecipeSelections',
    kind: 'runtime',
    class: 'deterministic',
    unit: 'count',
    get: (r) => r.recordedRecipeSelections,
  },
  {
    id: 'vite.buildMs',
    kind: 'vite',
    class: 'timing',
    unit: 'ms',
    get: (r) => r.buildMs,
  },
  {
    id: 'vite.maxRssBytes',
    kind: 'vite',
    class: 'memory',
    unit: 'bytes',
    get: (r) => r.final.maxRssBytes,
  },
  {
    id: 'vite.cssBytes',
    kind: 'vite',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.css.bytes,
  },
  {
    id: 'vite.cssGzipBytes',
    kind: 'vite',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.css.gzipBytes,
  },
  {
    id: 'vite.jsBytes',
    kind: 'vite',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.js.bytes,
  },
  {
    id: 'vite.jsGzipBytes',
    kind: 'vite',
    class: 'deterministic',
    unit: 'bytes',
    get: (r) => r.js.gzipBytes,
  },
  {
    id: 'vite.distSha256',
    kind: 'vite',
    class: 'identity',
    get: (r) => r.distSha256,
  },
];

// Incremental metrics are generated per edit id: the per-sample median of the
// warm iterations (iteration 0 is a warm-up and excluded), and the pooled warm
// iterations for the p95 tail.
function incrementalMetrics(samples) {
  const ids = new Set();
  for (const s of samples)
    if (s.kind === 'compile' && s.result.ok)
      for (const e of s.result.incremental ?? []) ids.add(e.id);
  const out = [];
  for (const id of [...ids].sort())
    for (const field of ['totalMs', 'toDiagnosticsMs'])
      out.push({
        id: `incremental.${id}.${field}`,
        kind: 'compile',
        class: 'timing',
        unit: 'ms',
        get: (r) => {
          const edit = r.incremental?.find((e) => e.id === id);
          return edit == null
            ? null
            : median(warm(edit.iterations).map((i) => i[field]));
        },
        pooled: (r) => {
          const edit = r.incremental?.find((e) => e.id === id);
          return edit == null ? [] : warm(edit.iterations).map((i) => i[field]);
        },
      });
  return out;
}

export function metricsFor(samples) {
  return [...METRICS, ...incrementalMetrics(samples)];
}

function groupKey(sample) {
  return `${sample.epoch}\0${sample.workload}`;
}

export function summarizeRun(...raws) {
  const samples = raws.flatMap((raw) => raw.samples);
  const epochs = raws[0].epochs.map((e) => e.name);
  const metrics = metricsFor(samples);
  const groups = new Map();
  for (const sample of samples) {
    if (!groups.has(groupKey(sample))) groups.set(groupKey(sample), []);
    groups.get(groupKey(sample)).push(sample);
  }
  const results = [];
  const failures = samples
    .filter((s) => !s.result.ok)
    .map((s) => ({
      index: s.index,
      epoch: s.epoch,
      workload: s.workload,
      kind: s.kind,
      error: s.result.error.slice(0, 500),
    }));
  for (const [key, group] of groups) {
    const [epoch, workload] = key.split('\0');
    for (const metric of metrics) {
      const ok = group.filter((s) => s.kind === metric.kind && s.result.ok);
      if (ok.length === 0) continue;
      const values = ok
        .map((s) => metric.get(s.result))
        .filter((v) => v != null);
      if (values.length === 0) continue;
      const entry = {
        epoch,
        workload,
        metric: metric.id,
        class: metric.class,
        unit: metric.unit ?? null,
        n: values.length,
      };
      if (metric.class === 'deterministic' || metric.class === 'identity') {
        const distinct = [...new Set(values.map(String))];
        entry.deterministic = distinct.length === 1;
        entry.value = distinct.length === 1 ? values[0] : null;
        if (distinct.length > 1) entry.distinctValues = distinct;
      } else {
        entry.stats = summarize(values);
        if (metric.pooled != null) {
          const pooled = ok.flatMap((s) => metric.pooled(s.result));
          entry.pooledIterations = summarize(pooled);
        }
      }
      results.push(entry);
    }
  }
  const comparisons = [];
  if (epochs.length > 1) {
    const reference = epochs[0];
    for (const entry of results) {
      if (entry.epoch === reference || entry.stats == null) continue;
      const base = results.find(
        (e) =>
          e.epoch === reference &&
          e.workload === entry.workload &&
          e.metric === entry.metric,
      );
      if (base?.stats == null) continue;
      const metric = metrics.find((m) => m.id === entry.metric);
      const valuesOf = (epoch) =>
        samples
          .filter(
            (s) =>
              s.epoch === epoch &&
              s.workload === entry.workload &&
              s.kind === metric.kind &&
              s.result.ok,
          )
          .map((s) => metric.get(s.result))
          .filter((v) => v != null);
      comparisons.push({
        workload: entry.workload,
        metric: entry.metric,
        reference,
        candidate: entry.epoch,
        medianRatio: bootstrapRatio(valuesOf(reference), valuesOf(entry.epoch)),
      });
    }
    for (const entry of results) {
      if (entry.epoch === reference || entry.value === undefined) continue;
      const base = results.find(
        (e) =>
          e.epoch === reference &&
          e.workload === entry.workload &&
          e.metric === entry.metric,
      );
      if (base == null || base.value === undefined) continue;
      comparisons.push({
        workload: entry.workload,
        metric: entry.metric,
        reference,
        candidate: entry.epoch,
        identical: String(base.value) === String(entry.value),
        referenceValue: base.value,
        candidateValue: entry.value,
      });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'pandamstyle-ce003-summary',
    labels: raws.map((r) => r.label),
    statisticalMethod:
      'Per (epoch, workload, metric): median and nearest-rank p95 over independent fresh-process samples, each with a distribution-free 95% order-statistic interval (null = unbounded at this n). Incremental edits: one value per sample (median of warm iterations, iteration 0 excluded); pooledIterations also summarizes every warm iteration for the tail. Epoch comparisons: ratio of medians with a seeded (307) 2,000-round percentile bootstrap. Deterministic metrics must be identical across samples.',
    epochs,
    sampleCount: samples.length,
    failures,
    results,
    comparisons,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv.splice(outIndex, 2)[1] : null;
  const summary = summarizeRun(...argv.map((f) => readJson(path.resolve(f))));
  if (out) writeJson(path.resolve(out), summary);
  else process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
