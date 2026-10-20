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
import { loadCorpus, findTask } from '../../src/corpus.mjs';
import { repetitionContested } from './contested.mjs';
import { CORPUS_ROOT, median, readJson } from './util.mjs';

export const REPORT_SCHEMA = 'pms-agentic-run-report/v1';

export function loadMatrix(matrixDir) {
  const matrix = readJson(path.join(matrixDir, 'matrix.json'));
  const outcomes = fs.existsSync(path.join(matrixDir, 'outcomes.json'))
    ? readJson(path.join(matrixDir, 'outcomes.json'))
    : { outcomes: [], halted: {} };
  const records = [];
  // Attempt directories without a record (a crash or an aborted provider
  // start): part of the attempt history that decides `contested`.
  const crashed = [];
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
            else if (/^attempt-\d+$/.test(att) && /^rep-\d+$/.test(rep))
              crashed.push({
                taskId: task,
                modelKey: model,
                repetition: Number(rep.slice(4)),
              });
          }
  const loaded = loadCorpus(CORPUS_ROOT);
  const taskMeta = {};
  for (const t of matrix.tasks ?? []) {
    const e = findTask(loaded, t);
    if (e != null)
      taskMeta[t] = { workflow: e.task.workflow, caseType: e.task.caseType };
  }
  return { matrix, outcomes, records, crashed, taskMeta };
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

export function buildReport({
  matrix,
  outcomes,
  records,
  crashed = [],
  taskMeta = {},
}) {
  const kinds = new Set(records.map((r) => r.kind));
  if (kinds.size > 1)
    throw new Error('refusing to aggregate records of different kinds');
  const kind = [...kinds][0] ?? matrix.kind;
  // Seeded from the planned matrix (section 7): every task x model cell and
  // every repetition is reported, with or without records.
  const cells = new Map();
  const key = (t, m) => `${t}\0${m}`;
  for (const taskId of matrix.tasks ?? [])
    for (const model of matrix.models ?? [])
      cells.set(key(taskId, model.key), {
        taskId,
        modelKey: model.key,
        reps: new Map(),
      });
  for (const r of records) {
    const c = cells.get(key(r.cell.taskId, r.cell.modelKey));
    if (c == null)
      throw new Error(
        `record of an unplanned cell ${r.cell.taskId}/${r.cell.modelKey}`,
      );
    if (!(r.repetition >= 1 && r.repetition <= matrix.repetitions))
      throw new Error(`record of an unplanned repetition ${r.repetition}`);
    if (!c.reps.has(r.repetition)) c.reps.set(r.repetition, []);
    c.reps.get(r.repetition).push(r);
  }
  const outcomeFor = (t, m, rep) =>
    outcomes.outcomes.find(
      (o) =>
        o.taskId === t &&
        o.model === m &&
        (o.repetition === rep || o.status === 'unsupported'),
    ) ?? null;
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
    const cellUnsupported =
      outcomes.outcomes.find(
        (o) =>
          o.taskId === c.taskId &&
          o.model === c.modelKey &&
          o.status === 'unsupported',
      ) ?? null;
    for (let rep = 1; rep <= matrix.repetitions; rep += 1) {
      const attempts = c.reps.get(rep) ?? [];
      // Section 5.3: the matrix's own derivation over the same history.
      const contested = repetitionContested({
        records: attempts,
        crashed: crashed.filter(
          (x) =>
            x.taskId === c.taskId &&
            x.modelKey === c.modelKey &&
            x.repetition === rep,
        ).length,
      });
      if (attempts.length === 0) {
        const o = outcomeFor(c.taskId, c.modelKey, rep);
        reps.push({
          repetition: rep,
          attempts: [],
          valid: false,
          contested,
          status: cellUnsupported ? 'unsupported' : 'missing',
          reason: cellUnsupported
            ? cellUnsupported.reasons.join('; ')
            : (o?.reason ?? 'not run'),
          verdict: null,
          taskSuccess: null,
          firstPassSuccess: null,
          evidence: null,
          failingChecks: [],
          record: null,
        });
        continue;
      }
      attempts.sort((a, b) => a.attempt - b.attempt);
      const final = attempts.at(-1);
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
        status: final.outcome.valid ? 'valid' : 'missing',
        reason: final.outcome.valid
          ? null
          : `invalid: ${final.outcome.class} ${final.outcome.code}`,
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
    const unsupportedReps = reps.filter(
      (r) => r.status === 'unsupported',
    ).length;
    const successes = valid.filter((r) => r.taskSuccess === true);
    const uncontested = successes.filter((r) => !r.contested);
    const metric = (f) => stat(valid.map((r) => f(r.record)));
    cellReports.push({
      taskId: c.taskId,
      modelKey: c.modelKey,
      planned,
      valid: valid.length,
      missing: planned - unsupportedReps - valid.length,
      unsupported: unsupportedReps,
      success: {
        k: successes.length,
        n: valid.length,
        pointEstimate: valid.length ? successes.length / valid.length : null,
        // Over the runnable planned repetitions: missing, invalid and
        // contested ones count as non-success.
        lowerBound:
          planned - unsupportedReps > 0
            ? uncontested.length / (planned - unsupportedReps)
            : null,
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
        comparabilityKey: record?.comparability?.key ?? null,
      })),
    });
  }

  const perModel = {};
  for (const cr of cellReports) {
    const meta = taskMeta[cr.taskId] ?? {};
    const pm = (perModel[cr.modelKey] ??= {
      byWorkflow: {},
      byCaseType: {},
      k: 0,
      nValid: 0,
      nPlanned: 0,
      nUnsupported: 0,
      nMissing: 0,
      lowerBoundK: 0,
    });
    for (const [bucket, name] of [
      [pm.byWorkflow, meta.workflow ?? 'unknown'],
      [pm.byCaseType, meta.caseType ?? 'unknown'],
    ]) {
      bucket[name] ??= {
        k: 0,
        nValid: 0,
        nPlanned: 0,
        nUnsupported: 0,
        nMissing: 0,
      };
      bucket[name].k += cr.success.k;
      bucket[name].nValid += cr.success.n;
      bucket[name].nPlanned += cr.planned;
      bucket[name].nUnsupported += cr.unsupported;
      bucket[name].nMissing += cr.missing;
    }
    pm.k += cr.success.k;
    pm.nValid += cr.success.n;
    pm.nPlanned += cr.planned;
    pm.nUnsupported += cr.unsupported;
    pm.nMissing += cr.missing;
    pm.lowerBoundK += cr.success.lowerBoundK;
  }
  for (const pm of Object.values(perModel)) {
    const runnable = pm.nPlanned - pm.nUnsupported;
    pm.pointEstimate = pm.nValid ? pm.k / pm.nValid : null;
    pm.lowerBound = runnable > 0 ? pm.lowerBoundK / runnable : null;
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
