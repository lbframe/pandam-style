/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Run report (DESIGN.md section 7). Every value is kept; statistics sit
// beside the values, never a mean alone. Unknown values are counted and
// excluded from statistics, never treated as 0. Success is reported as a
// point estimate and as a conservative lower bound that counts every
// contested, unclassified or missing repetition as non-success (section 5.3).

import fs from 'node:fs';
import path from 'node:path';
import { median, readJson } from './util.mjs';

export const REPORT_SCHEMA = 'pms-agentic-run-report/v1';

export function loadMatrix(matrixDir) {
  const matrix = readJson(path.join(matrixDir, 'matrix.json'));
  const outcomes = fs.existsSync(path.join(matrixDir, 'outcomes.json'))
    ? readJson(path.join(matrixDir, 'outcomes.json'))
    : { outcomes: [], halted: {} };
  const records = [];
  const cellsDir = path.join(matrixDir, 'cells');
  if (fs.existsSync(cellsDir))
    for (const task of fs.readdirSync(cellsDir).sort())
      for (const model of fs.readdirSync(path.join(cellsDir, task)).sort())
        for (const rep of fs
          .readdirSync(path.join(cellsDir, task, model))
          .sort())
          for (const att of fs
            .readdirSync(path.join(cellsDir, task, model, rep))
            .sort()) {
            const f = path.join(cellsDir, task, model, rep, att, 'record.json');
            if (fs.existsSync(f)) records.push(readJson(f));
          }
  return { matrix, outcomes, records };
}

function stat(measures) {
  const known = measures.filter((m) => m != null && m.status !== 'unknown');
  const values = known.map((m) => m.value);
  const statuses = [...new Set(known.map((m) => m.status))];
  return {
    values: measures.map((m) =>
      m == null || m.status === 'unknown' ? null : m.value,
    ),
    unknown: measures.length - known.length,
    statuses,
    methods: [...new Set(known.map((m) => m.method).filter(Boolean))],
    min: values.length ? Math.min(...values) : null,
    median: median(values),
    max: values.length ? Math.max(...values) : null,
  };
}

export function buildReport({ matrix, outcomes, records }) {
  const kinds = new Set(records.map((r) => r.kind));
  if (kinds.size > 1)
    throw new Error('refusing to aggregate records of different kinds');
  const kind = [...kinds][0] ?? matrix.kind;
  const cells = new Map();
  const key = (t, m) => `${t}\0${m}`;
  for (const r of records) {
    const k = key(r.cell.taskId, r.cell.modelKey);
    if (!cells.has(k))
      cells.set(k, {
        taskId: r.cell.taskId,
        modelKey: r.cell.modelKey,
        reps: new Map(),
      });
    const c = cells.get(k);
    if (!c.reps.has(r.repetition)) c.reps.set(r.repetition, []);
    c.reps.get(r.repetition).push(r);
  }
  const unsupported = outcomes.outcomes.filter(
    (o) => o.status === 'unsupported',
  );
  const missingOutcomes = outcomes.outcomes.filter(
    (o) => o.status === 'missing',
  );

  const cellReports = [];
  const breaches = [];
  const infra = {};
  for (const c of [...cells.values()].sort((a, b) =>
    key(a.taskId, a.modelKey).localeCompare(key(b.taskId, b.modelKey)),
  )) {
    const reps = [];
    for (const [rep, attempts] of [...c.reps.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      attempts.sort((a, b) => a.attempt - b.attempt);
      const final = attempts.at(-1);
      const contested =
        attempts.length > 1 || final.integrity.contested === true;
      for (const a of attempts) {
        if (
          a.outcome.class === 'infrastructure' ||
          a.outcome.class === 'unclassified'
        ) {
          const p = a.cli?.name ?? 'unknown';
          infra[p] ??= {};
          infra[p][a.outcome.code] =
            a.outcome.code in infra[p] ? infra[p][a.outcome.code] + 1 : 1;
        }
        const anyBreach =
          a.outcome.breaches.length > 0 ||
          a.metrics.scopeViolations.realized.length > 0 ||
          a.integrity.anomalies.length > 0 ||
          a.provider.primaryModelFidelity === 'violated' ||
          a.metrics.vocabularyCompliance === 'fail';
        if (anyBreach)
          breaches.push({
            taskId: c.taskId,
            modelKey: c.modelKey,
            repetition: rep,
            attempt: a.attempt,
            verdict: a.grading.verdict,
            breaches: a.outcome.breaches,
            realizedScope: a.metrics.scopeViolations.realized,
            vocabulary: a.metrics.vocabularyCompliance,
            anomalies: a.integrity.anomalies,
            fidelity: a.provider.primaryModelFidelity,
          });
      }
      reps.push({
        repetition: rep,
        attempts: attempts.map((a) => ({
          attempt: a.attempt,
          class: a.outcome.class,
          code: a.outcome.code,
          termination: a.outcome.termination,
          verdict: a.grading.verdict,
          retryScheduled: a.outcome.retry.scheduled,
        })),
        valid: final.outcome.valid,
        contested,
        verdict: final.grading.verdict,
        taskSuccess: final.outcome.valid ? final.outcome.taskSuccess : null,
        firstPassSuccess: final.metrics.firstPassSuccess,
        evidence: final.evidence.completeness,
        failingChecks: final.grading.failingRequiredChecks ?? [],
        record: final,
      });
    }
    const valid = reps.filter((r) => r.valid);
    const planned = matrix.repetitions;
    const successes = valid.filter((r) => r.taskSuccess === true);
    const uncontested = successes.filter((r) => !r.contested);
    const metric = (f) => stat(valid.map((r) => f(r.record)));
    cellReports.push({
      taskId: c.taskId,
      modelKey: c.modelKey,
      planned,
      valid: valid.length,
      missing: planned - valid.length,
      success: {
        k: successes.length,
        n: valid.length,
        pointEstimate: valid.length ? successes.length / valid.length : null,
        lowerBound: planned ? uncontested.length / planned : null,
        lowerBoundK: uncontested.length,
        contested: reps.filter((r) => r.contested).length,
      },
      firstPass: {
        true: valid.filter((r) => r.firstPassSuccess === true).length,
        false: valid.filter((r) => r.firstPassSuccess === false).length,
        unknown: valid.filter((r) => r.firstPassSuccess === 'unknown').length,
      },
      metrics: {
        toolCalls: metric((r) => r.metrics.toolCalls.total),
        agentSteps: metric((r) => r.metrics.agentSteps),
        repairCycles: metric((r) => r.metrics.repairCycles),
        inputTokens: metric(
          (r) => r.metrics.tokens.normalized.total.inputTotal,
        ),
        outputTokens: metric(
          (r) => r.metrics.tokens.normalized.total.outputTotal,
        ),
        cost: metric((r) => r.metrics.cost),
        agentPhaseMs: metric((r) => r.metrics.elapsed.agentPhaseMs),
        toolOutputBytes: metric((r) => r.metrics.toolCost.outputBytes),
      },
      latencyLabel: 'indicative',
      repetitions: reps.map(({ record, ...rest }) => ({
        ...rest,
        comparabilityKey: record.comparability.key,
      })),
    });
  }

  const perModel = {};
  for (const cr of cellReports) {
    const rec = [...cells.values()].find(
      (c) => c.taskId === cr.taskId && c.modelKey === cr.modelKey,
    );
    const anyRecord = [...rec.reps.values()][0][0];
    const pm = (perModel[cr.modelKey] ??= {
      byWorkflow: {},
      byCaseType: {},
      k: 0,
      nValid: 0,
      nPlanned: 0,
      lowerBoundK: 0,
    });
    for (const [bucket, name] of [
      [pm.byWorkflow, anyRecord.task.workflow],
      [pm.byCaseType, anyRecord.task.caseType],
    ]) {
      bucket[name] ??= { k: 0, nValid: 0, nPlanned: 0 };
      bucket[name].k += cr.success.k;
      bucket[name].nValid += cr.success.n;
      bucket[name].nPlanned += cr.planned;
    }
    pm.k += cr.success.k;
    pm.nValid += cr.success.n;
    pm.nPlanned += cr.planned;
    pm.lowerBoundK += cr.success.lowerBoundK;
  }

  return {
    schema: REPORT_SCHEMA,
    kind,
    synthetic: kind === 'adapter-fixture',
    matrixId: matrix.matrixId,
    productBuild: records[0]?.productBuild ?? null,
    trustedTree: records[0]?.trustedTree ?? null,
    comparabilityKeys: [...new Set(records.map((r) => r.comparability.key))],
    cells: cellReports,
    perModel,
    breaches,
    unsupported,
    missing: missingOutcomes,
    infrastructure: infra,
    halted: outcomes.halted ?? {},
  };
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const vals = (s) => s.values.map((v) => (v == null ? '?' : v)).join(', ');

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Agentic evaluation report ${report.matrixId}`);
  if (report.synthetic)
    lines.push(
      '',
      '**Synthetic: adapter-fixture records, not provider measurements.**',
    );
  lines.push(
    '',
    '## Cells',
    '',
    '| Task | Model | k/n (valid) | point | lower bound | contested | missing | first pass (t/f/?) | tool calls | tokens in | tokens out | cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const c of report.cells)
    lines.push(
      `| ${c.taskId} | ${c.modelKey} | ${c.success.k}/${c.success.n} | ${pct(c.success.pointEstimate)} | ${pct(c.success.lowerBound)} | ${c.success.contested} | ${c.missing} | ${c.firstPass.true}/${c.firstPass.false}/${c.firstPass.unknown} | ${vals(c.metrics.toolCalls)} | ${vals(c.metrics.inputTokens)} | ${vals(c.metrics.outputTokens)} | ${vals(c.metrics.cost)} |`,
    );
  lines.push(
    '',
    'Values are listed per valid repetition; `?` is unknown. Stream-derived values are estimates (`cli-stream-unattested`). Latencies are indicative.',
  );
  lines.push('', '## Policy and scope breaches', '');
  if (report.breaches.length === 0) lines.push('None.');
  for (const b of report.breaches)
    lines.push(
      `- ${b.taskId} / ${b.modelKey} rep ${b.repetition} attempt ${b.attempt} (verdict ${b.verdict}): ${[...b.breaches.map((x) => `${x.kind} (${x.enforcement})`), ...b.realizedScope.map((x) => `scope: ${x}`), b.vocabulary === 'fail' ? 'vocabulary: fail' : null, ...b.anomalies.map((x) => `stream: ${x}`), b.fidelity === 'violated' ? 'model fidelity violated' : null].filter(Boolean).join('; ')}`,
    );
  lines.push('', '## Unsupported / not run', '');
  if (report.unsupported.length === 0) lines.push('None.');
  for (const u of report.unsupported)
    lines.push(
      `- ${u.taskId}${u.model ? ` / ${u.model}` : ''}: ${u.reasons.join('; ')}`,
    );
  lines.push('', '## Missing repetitions', '');
  if (report.missing.length === 0) lines.push('None.');
  for (const m of report.missing)
    lines.push(`- ${m.taskId} / ${m.model} rep ${m.repetition}: ${m.reason}`);
  lines.push(
    '',
    '## Infrastructure',
    '',
    '```json',
    JSON.stringify(report.infrastructure, null, 2),
    '```',
    '',
  );
  return lines.join('\n');
}
