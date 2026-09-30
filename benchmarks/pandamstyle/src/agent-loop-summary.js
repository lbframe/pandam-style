/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the agent-loop summary (Spike 4, Phase C).
 *
 * The campaign writes one long JSONL row per metric per revision. This turns it
 * into the tables a reader actually needs, and it is deliberately conservative
 * about what it will claim:
 *
 *   variants are NOT ranked when they do different amounts of work
 *     `full_audit_requested` produces three megabytes of evidence that
 *     `compact_agent_result` does not, so their latencies are not comparable and
 *     are labelled `comparable: false` with the reason. A faster number for less
 *     work has not won anything.
 *
 *   the four milestones are never collapsed
 *     diagnostics-ready, generation-ready, generation-committed and audit-ready
 *     are four numbers. The distance between the first and the last is the cost
 *     this phase is about, so collapsing them would delete the measurement.
 *
 *   medians are reported with their session count
 *     every observation of a cell comes from the same process, so the values are
 *     correlated and a median over all of them is a statistic of that process,
 *     not of the workload. The count is reported beside every median so a reader
 *     can see how much independent evidence there is.
 *
 * USAGE
 *
 *   node src/agent-loop-summary.js -i <observations.jsonl> -o <summary.json>
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The variant table is duplicated from the harness rather than required from
// it: `agent-loop.js` is a driver, and a summariser that cannot run without
// loading a driver is a summariser that cannot be pointed at a file from a
// previous run on a machine where the driver has since changed.
const VARIANTS = {
  full_metadata: {
    auditPolicy: 'inline',
    publishes: true,
    audits: false,
    label: 'the pre-Phase-C artifact: the whole coverage array inline',
  },
  compact_agent_result: {
    auditPolicy: 'reference',
    publishes: false,
    audits: false,
    label: 'diagnostics only; nothing published',
  },
  compact_agent_result_plus_compact_publish_metadata: {
    auditPolicy: 'reference',
    publishes: true,
    audits: false,
    label: 'diagnostics, then a publication with counts and a reference',
  },
  full_audit_requested: {
    auditPolicy: 'reference',
    publishes: true,
    audits: true,
    label: 'diagnostics, publication, and the requested coverage document',
  },
};

/**
 * Which variants may be compared with which, and why.
 *
 * A comparison is allowed when the two cells do the SAME work. The audit variant
 * is the one that does not: it materialises a document the others do not write.
 */
const COMPARABLE = (() => {
  const groups = new Map();
  const key = (v) => `${v.publishes}|${v.audits}`;
  for (const [name, variant] of Object.entries(VARIANTS)) {
    if (!groups.has(key(variant))) groups.set(key(variant), []);
    groups.get(key(variant)).push(name);
  }
  const out = new Map();
  for (const members of groups.values()) {
    for (const a of members) {
      for (const b of members) {
        out.set(`${a}|${b}`, { comparable: true, reason: null });
      }
    }
  }
  for (const name of Object.keys(VARIANTS)) {
    for (const other of Object.keys(VARIANTS)) {
      if (out.has(`${name}|${other}`)) continue;
      out.set(`${name}|${other}`, {
        comparable: false,
        reason:
          name === other
            ? null
            : `these two do different amounts of work: ${VARIANTS[name].label} vs ${VARIANTS[other].label}. A faster number for less work has not won anything.`,
      });
    }
  }
  return out;
})();

function quantiles(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => {
    // Upper-rank: the value at ceil(q*n) - 1. Documented rather than averaged,
    // so a p95 of 7 observations is the 7th and not an interpolation of two
    // samples that were never taken.
    const rank = Math.max(1, Math.ceil(q * sorted.length));
    return sorted[rank - 1];
  };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let input = null;
  let output = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-i' || argv[i] === '--input') input = argv[++i];
    else if (argv[i] === '-o' || argv[i] === '--output') output = argv[++i];
  }
  if (input == null) {
    process.stderr.write('agent-loop-summary: -i is required\n');
    process.exit(2);
  }
  const rows = fs
    .readFileSync(input, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));

  const errors = rows.filter((r) => r.status === 'error');
  const byCell = new Map();
  for (const row of rows) {
    if (row.status === 'error') continue;
    const key = [
      row.corpus,
      row.scenario,
      row.variant,
      row.metric,
      row.unit,
    ].join('|');
    if (!byCell.has(key)) {
      byCell.set(key, { values: [], sessions: new Set(), statuses: new Set() });
    }
    const cell = byCell.get(key);
    cell.values.push(row.value);
    cell.sessions.add(row.session_id);
    cell.statuses.add(row.status);
  }

  const cells = [];
  for (const [key, cell] of byCell) {
    const [corpus, scenario, variant, metric, unit] = key.split('|');
    cells.push({
      corpus,
      scenario,
      variant,
      metric,
      unit,
      sessions: cell.sessions.size,
      statuses: [...cell.statuses],
      // A cell that mixes `ok` and `unsupported` is reported as such rather
      // than as a smaller number: the unsupported observations are exactly the
      // ones a reader must not mistake for zeros.
      partial: cell.statuses.size > 1,
      ...quantiles(cell.values),
    });
  }
  cells.sort((a, b) =>
    [a.corpus, a.scenario, a.variant, a.metric].join('|') <
    [b.corpus, b.scenario, b.variant, b.metric].join('|')
      ? -1
      : 1,
  );

  // The headline table: one row per (corpus, scenario), the four milestones of
  // the compact publishing variant, and the four variants' metadata bytes.
  const headline = [];
  const keys = new Set(rows.map((r) => `${r.corpus}|${r.scenario}`));
  for (const key of keys) {
    const [corpus, scenario] = key.split('|');
    const pick = (variant, metric) =>
      cells.find(
        (c) =>
          c.corpus === corpus &&
          c.scenario === scenario &&
          c.variant === variant &&
          c.metric === metric,
      );
    const row = { corpus, scenario };
    for (const [label, metric] of [
      ['agent_edit_to_diagnostics_ms', 'agent_edit_to_diagnostics_ms'],
      [
        'agent_edit_to_generation_ready_ms',
        'agent_edit_to_generation_ready_ms',
      ],
      [
        'agent_edit_to_generation_committed_ms',
        'agent_edit_to_generation_committed_ms',
      ],
      ['agent_edit_to_audit_report_ms', 'agent_edit_to_audit_report_ms'],
    ]) {
      const compact = pick('compact_agent_result', metric);
      const published = pick(
        'compact_agent_result_plus_compact_publish_metadata',
        metric,
      );
      const audited = pick('full_audit_requested', metric);
      row[label] = {
        compact_agent_result: compact?.p50 ?? null,
        compact_publish: published?.p50 ?? null,
        full_audit_requested: audited?.p50 ?? null,
        sessions: published?.sessions ?? compact?.sessions ?? 0,
      };
    }
    row.metadata_bytes = {
      full_metadata: pick('full_metadata', 'build_report_bytes')?.p50 ?? null,
      compact_publish:
        pick(
          'compact_agent_result_plus_compact_publish_metadata',
          'build_report_bytes',
        )?.p50 ?? null,
      coverage_document:
        pick('full_audit_requested', 'coverage_report_bytes')?.p50 ?? null,
    };
    row.agent_result_bytes =
      pick('compact_agent_result', 'agent_result_bytes')?.p50 ?? null;
    row.work = {
      filesCompiled:
        pick('compact_agent_result', 'files_compiled')?.p50 ?? null,
      filesRecompiled:
        pick('compact_agent_result', 'files_recompiled')?.p50 ?? null,
      filesReused: pick('compact_agent_result', 'files_reused')?.p50 ?? null,
      dirtyFilesRead:
        pick('compact_agent_result', 'dirty_files_read')?.p50 ?? null,
      dirtyFilesHashed:
        pick('compact_agent_result', 'dirty_files_hashed')?.p50 ?? null,
    };
    row.reuseLoop = {
      affected_ms:
        pick('compact_agent_result', 'session_compile_affected_ms')?.p50 ??
        null,
      reuse_ms:
        pick('compact_agent_result', 'session_reuse_iteration_ms')?.p50 ?? null,
      coverage_entries_ms:
        pick('compact_agent_result', 'session_coverage_entries_ms')?.p50 ??
        null,
      entries_iterated:
        pick('compact_agent_result', 'covered_entries_iterated')?.p50 ?? null,
    };
    row.metadata_timings = {
      build_report_build_ms:
        pick(
          'compact_agent_result_plus_compact_publish_metadata',
          'build_report_build_ms',
        )?.p50 ?? null,
      build_report_serialize_ms:
        pick(
          'compact_agent_result_plus_compact_publish_metadata',
          'build_report_serialize_ms',
        )?.p50 ?? null,
      coverage_report_build_ms:
        pick('full_audit_requested', 'coverage_report_build_ms')?.p50 ?? null,
      coverage_report_serialize_ms:
        pick('full_audit_requested', 'coverage_report_serialize_ms')?.p50 ??
        null,
      agent_result_build_ms:
        pick('compact_agent_result', 'agent_result_build_ms')?.p50 ?? null,
      agent_result_serialize_ms:
        pick('compact_agent_result', 'agent_result_serialize_ms')?.p50 ?? null,
    };
    headline.push(row);
  }
  headline.sort((a, b) =>
    a.corpus + a.scenario < b.corpus + b.scenario ? -1 : 1,
  );

  const document = {
    documentKind: 'pandamstyle-agent-loop-summary',
    schemaVersion: 1,
    input,
    rows: rows.length,
    errors: errors.map((e) => ({
      scenario: e.scenario,
      variant: e.variant,
      metric: e.metric,
      detail: e.detail,
    })),
    error_count: errors.length,
    variants: Object.fromEntries(
      Object.entries(VARIANTS).map(([k, v]) => [k, v]),
    ),
    comparability: Object.fromEntries(COMPARABLE),
    headline,
    cells,
    statistics: {
      method: 'upper-rank percentiles over the observed values',
      confidence_intervals:
        'not computed, and that is stated rather than implied: every ' +
        'observation of a cell comes from the same process, so the values are ' +
        'correlated and a median over them is a statistic of that process',
      sessions_reported: true,
    },
  };
  const text = JSON.stringify(document, null, 2) + '\n';
  if (output != null) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, text, 'utf8');
  }
  process.stdout.write(text);
  if (errors.length > 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { COMPARABLE, VARIANTS, quantiles };
