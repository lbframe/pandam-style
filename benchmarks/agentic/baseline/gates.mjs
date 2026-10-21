/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `gates derive` and `gates check` (POLICY.md section 6). Both read the
// runner's own matrix directories (matrix.json, outcomes.json and every
// record), through the runner's loader and report, and decide nothing
// themselves: every gate decision, reference accounting, cut and minimum
// detectable regression comes from `stats.mjs` (`pms-agentic-stats/v1`).
//
// - `deriveGates(baselineDir)` builds the gate record (`pms-agentic-gates/v1`)
//   deterministically: the same inputs give byte-identical output.
// - `checkGates(gateRecord, candidateDir, { controlDir })` applies it to a
//   candidate matrix and, for the latency gates, an interleaved control.
//
// Inputs whose comparability keys are mixed, or that do not match the gate
// record's binding, are refused (`GatesRefusal`), never compared.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTask, loadCorpus } from '../src/corpus.mjs';
import {
  comparabilityKey,
  diffProjections,
} from '../runner/src/comparability.mjs';
import { buildReport, loadMatrix } from '../runner/src/report.mjs';
import {
  DRAWS,
  FAMILY_ALPHA,
  GATES,
  GATE_ALPHA,
  GATE_COUNT,
  MAX_DROPPED_REFERENCE_PER,
  METHOD,
  MIN_CLEAN_REFERENCE_PER_TASK,
  OUTCOMES,
  decideGate,
  gateSeed,
  latencyCuts,
  minimumDetectable,
  normalizeLatency,
  orient,
  referenceEvidence,
} from './stats.mjs';

export const GATES_SCHEMA = 'pms-agentic-gates/v1';
export const CHECK_SCHEMA = 'pms-agentic-gates-check/v1';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(HERE, '..');
const POLICY_FILE = path.join(HERE, 'POLICY.md');
const STATS_FILE = path.join(HERE, 'stats.mjs');
const TOOL_FILE = fileURLToPath(import.meta.url);

/** POLICY.md section 5.5: a smaller task set is reported, not blocking. */
export const MIN_BLOCKING_TASKS = 5;

/** POLICY.md section 3: outcome family of each `intendedOutcome.kind`. */
export const FAMILY_OF_KIND = {
  'application-success': 'application',
  'integration-success': 'application',
  'capability-gap-diagnosis': 'diagnosis',
  'vocabulary-gap-diagnosis': 'diagnosis',
  'conflict-diagnosis': 'diagnosis',
  clarification: 'diagnosis',
  refusal: 'diagnosis',
  'read-only-report': 'report',
};

/** POLICY.md section 4: the task set of each blocking gate. */
export const GATE_TASK_SET = {
  'success.application': 'application',
  'success.diagnosis': 'diagnosis',
  'success.report': 'report',
  'success.critical': 'critical',
  safety: 'all',
  'context.input': 'all',
  'repair.cycles': 'application',
  'latency.p50': 'all',
  'latency.p95': 'all',
};
if (
  JSON.stringify(Object.keys(GATE_TASK_SET)) !==
  JSON.stringify(Object.keys(GATES))
)
  throw new Error('gates.mjs and stats.mjs disagree on the gate set');

/** Projection groups that one model's cells share (DESIGN.md section 1.4). */
const SHARED_PER_MODEL = [
  'version',
  'harness',
  'model',
  'policy',
  'containers',
];
/** ... and that every cell of a matrix shares. */
const SHARED_ALL = ['version', 'harness'];
const SHARED_TASK_FIELDS = ['epoch', 'corpusVersion', 'corpusLockSha256'];

/** Refusal of an input: never a comparison. */
export class GatesRefusal extends Error {
  constructor(message, details = []) {
    super(
      details.length > 0
        ? `${message}:\n${details.map((d) => `  - ${d}`).join('\n')}`
        : message,
    );
    this.name = 'GatesRefusal';
    this.details = details;
  }
}

const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha256 = (f) => sha256(fs.readFileSync(f));
const cellKey = (taskId, modelKey) => `${taskId}\0${modelKey}`;
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted keys, recursively: the output's bytes depend on content only. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort(byId)
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}

/** Deterministic serialization of a gate record or a check result. */
export function serialize(doc) {
  return `${JSON.stringify(canonical(doc), null, 2)}\n`;
}

const projectionDigest = (x) => sha256(JSON.stringify(canonical(x ?? null)));

function sharedProjection(projection, groups) {
  const out = {};
  for (const g of groups) out[g] = projection[g] ?? null;
  out.task = {};
  for (const f of SHARED_TASK_FIELDS)
    out.task[f] = projection.task?.[f] ?? null;
  return out;
}

function sharedDiff(a, b) {
  const out = [];
  for (const g of Object.keys(a))
    if (g === 'task') {
      for (const f of SHARED_TASK_FIELDS)
        if (a.task[f] !== b.task?.[f]) out.push(`task.${f}`);
    } else if (projectionDigest(a[g]) !== projectionDigest(b[g])) out.push(g);
  return out;
}

// ------------------------------------------------------------ matrix input

/**
 * One matrix directory, read through the runner's loader and report (one
 * derivation of `valid`, `contested` and the breach section). Every planned
 * repetition of every cell gets an entry, with or without records.
 */
export function readMatrix(matrixDir) {
  const dir = path.resolve(matrixDir);
  if (!fs.existsSync(path.join(dir, 'matrix.json')))
    throw new GatesRefusal(`not a matrix directory (no matrix.json): ${dir}`);
  const loaded = loadMatrix(dir);
  let report;
  try {
    report = buildReport(loaded);
  } catch (e) {
    throw new GatesRefusal(`the runner report refuses ${dir}: ${e.message}`);
  }
  const { matrix, records, outcomes } = loaded;
  const problems = [];
  if (!Number.isInteger(matrix.repetitions) || matrix.repetitions < 1)
    problems.push('matrix.json has no planned repetitions');
  const finals = new Map();
  for (const r of records) {
    const where = `${r.cell?.taskId}/${r.cell?.modelKey} rep ${r.repetition} attempt ${r.attempt}`;
    if (r.matrixId !== matrix.matrixId)
      problems.push(`${where}: record of matrix ${r.matrixId}`);
    if (r.kind !== matrix.kind) problems.push(`${where}: kind ${r.kind}`);
    if (r.task?.split !== 'development')
      problems.push(`${where}: split ${r.task?.split}`);
    if (r.task?.id !== r.cell?.taskId) problems.push(`${where}: task id`);
    if (comparabilityKey(r.comparability.projection) !== r.comparability.key)
      problems.push(
        `${where}: comparability key is not its projection's digest`,
      );
    // A task success is a pass that terminated normally (POLICY.md section
    // 3); a record claiming otherwise is refused, not interpreted.
    if (
      r.outcome.taskSuccess === true &&
      (r.grading.verdict !== 'pass' ||
        r.outcome.termination !== 'completed' ||
        r.outcome.class !== 'agent' ||
        r.outcome.valid !== true)
    )
      problems.push(`${where}: taskSuccess without a normal pass`);
    const k = `${cellKey(r.cell.taskId, r.cell.modelKey)}\0${r.repetition}`;
    if (!finals.has(k) || finals.get(k).attempt < r.attempt) finals.set(k, r);
  }
  if (problems.length > 0)
    throw new GatesRefusal(`inconsistent records in ${dir}`, problems);

  const unsupported = new Map();
  for (const o of outcomes.outcomes ?? [])
    if (o.status === 'unsupported')
      for (const m of matrix.models ?? [])
        if (o.model == null || o.model === m.key)
          unsupported.set(cellKey(o.taskId, m.key), o.reasons ?? []);

  const breaches = new Set(
    report.breaches.map(
      (b) => `${cellKey(b.taskId, b.modelKey)}\0${b.repetition}`,
    ),
  );
  const cells = new Map();
  for (const c of report.cells) {
    const k = cellKey(c.taskId, c.modelKey);
    const reps = c.repetitions.map((rep) => ({
      taskId: c.taskId,
      modelKey: c.modelKey,
      repetition: rep.repetition,
      status: rep.status,
      valid: rep.valid,
      contested: rep.contested,
      attempts: rep.attempts.length,
      final: finals.get(`${k}\0${rep.repetition}`) ?? null,
      breach: breaches.has(`${k}\0${rep.repetition}`),
    }));
    if (unsupported.has(k) && reps.some((r) => r.attempts > 0))
      throw new GatesRefusal(
        `${c.taskId}/${c.modelKey} is unsupported and has records in ${dir}`,
      );
    cells.set(k, {
      taskId: c.taskId,
      modelKey: c.modelKey,
      unsupported: unsupported.get(k) ?? null,
      reps,
    });
  }

  const recordFiles = [];
  const crashedAttempts = [];
  const cellsDir = path.join(dir, 'cells');
  const walk = (d) => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => byId(a.name, b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (
          /^attempt-\d+$/.test(e.name) &&
          !fs.existsSync(path.join(p, 'record.json'))
        )
          crashedAttempts.push(path.relative(dir, p).split(path.sep).join('/'));
        walk(p);
      } else if (e.name === 'record.json') {
        const file = path.relative(dir, p).split(path.sep).join('/');
        const bytes = fs.readFileSync(p);
        // The report groups records by their own fields: a record filed
        // under another cell, repetition or attempt is refused.
        const r = JSON.parse(bytes.toString('utf8'));
        const expected = `cells/${r.cell?.taskId}/${r.cell?.modelKey}/rep-${r.repetition}/attempt-${r.attempt}/record.json`;
        if (file !== expected) misfiled.push(`${file} holds ${expected}`);
        recordFiles.push({ file, sha256: sha256(bytes) });
      }
    }
  };
  const misfiled = [];
  if (fs.existsSync(cellsDir)) walk(cellsDir);
  if (misfiled.length > 0)
    throw new GatesRefusal(`misfiled records in ${dir}`, misfiled);
  const outcomesFile = path.join(dir, 'outcomes.json');
  return {
    dir,
    matrix,
    records,
    cells,
    inputs: {
      matrixSha256: fileSha256(path.join(dir, 'matrix.json')),
      outcomesSha256: fs.existsSync(outcomesFile)
        ? fileSha256(outcomesFile)
        : null,
      records: recordFiles,
      crashedAttempts,
    },
  };
}

/**
 * Comparability of one matrix's records with itself: one key per cell, and
 * the groups every cell of a model (or of the matrix) shares are equal.
 * Returns each cell's key and projection and each model's shared groups.
 */
function bindMatrix(m) {
  const problems = [];
  const cellKeys = new Map();
  const perModel = new Map();
  let all = null;
  for (const r of m.records) {
    const k = cellKey(r.cell.taskId, r.cell.modelKey);
    const p = r.comparability.projection;
    const prior = cellKeys.get(k);
    if (prior == null)
      cellKeys.set(k, { key: r.comparability.key, projection: p });
    else if (prior.key !== r.comparability.key)
      problems.push(
        `${r.cell.taskId}/${r.cell.modelKey}: mixed comparability keys (${diffProjections(prior.projection, p).join(', ')})`,
      );
    const shared = sharedProjection(p, SHARED_PER_MODEL);
    const pm = perModel.get(r.cell.modelKey);
    if (pm == null) perModel.set(r.cell.modelKey, shared);
    else {
      const d = sharedDiff(pm, shared);
      if (d.length > 0)
        problems.push(
          `${r.cell.taskId}/${r.cell.modelKey}: model ${r.cell.modelKey} has mixed ${d.join(', ')}`,
        );
    }
    const sa = sharedProjection(p, SHARED_ALL);
    if (all == null) all = sa;
    else {
      const d = sharedDiff(all, sa);
      if (d.length > 0)
        problems.push(
          `${r.cell.taskId}/${r.cell.modelKey}: the matrix has mixed ${d.join(', ')}`,
        );
    }
  }
  if (problems.length > 0)
    throw new GatesRefusal(
      `mixed comparability keys in ${m.dir}`,
      [...new Set(problems)].sort(byId),
    );
  return { cellKeys, perModel, all };
}

// ------------------------------------------------------ reference accounting

/**
 * The reference accounting of one gate (POLICY.md section 5.1), from
 * `stats.mjs` `referenceEvidence` over the reference repetitions grouped by
 * task, with the insufficient strata named by task id. One derivation for
 * the baseline in `derive`, its verification in `check`, and the
 * interleaved control of the latency gates.
 *
 * @param {string[]} tasks the gate's task set, in order
 * @param {object[][]} reference per task, its reps (`{ clean, value? }`)
 */
export function referenceAccounting(tasks, reference) {
  if (reference.length !== tasks.length)
    throw new Error('one reference list per task');
  const ev = referenceEvidence(
    reference.map((reps) => ({ reference: reps, candidate: [] })),
    'between-runs',
  );
  return {
    status: ev.sufficient ? 'sufficient' : 'insufficient-reference',
    planned: ev.planned,
    dropped: ev.dropped,
    maxDropped: ev.maxDropped,
    insufficientTasks: ev.insufficientStrata.map((i) => tasks[i]),
  };
}

// ------------------------------------------------------- repetition values

/**
 * The value of one planned repetition for one gate, oriented as in
 * `stats.mjs` (higher is worse), and why it is not clean (POLICY.md section
 * 5.1): `missing` (no attempt), `invalid` (no valid attempt), `unclassified`,
 * `contested` or `unknown-value`. `recordedValue` is the oriented value its
 * last record carries, when it has one, clean or not.
 */
export function repetitionValue(rep, gate) {
  const reasons = [];
  const f = rep.final;
  if (rep.status === 'unsupported') reasons.push('unsupported');
  else if (f == null) reasons.push('missing');
  else if (f.outcome.class === 'unclassified') reasons.push('unclassified');
  else if (!rep.valid) reasons.push('invalid');
  if (rep.contested) reasons.push('contested');
  let recorded = null;
  let lowerBound = null;
  if (f != null) {
    const scale = GATES[gate].scale;
    if (gate === 'safety') recorded = rep.breach ? 1 : 0;
    else if (scale === 'binary') {
      const s = f.outcome.taskSuccess;
      recorded = s === true ? 0 : s === false ? 1 : null;
    } else {
      const m =
        gate === 'context.input'
          ? f.metrics.tokens.normalized.total.inputTotal
          : gate === 'repair.cycles'
            ? f.metrics.repairCycles
            : f.metrics.elapsed.agentPhaseMs;
      const known =
        m != null &&
        m.status !== 'unknown' &&
        typeof m.value === 'number' &&
        Number.isFinite(m.value);
      if (typeof m?.lowerBound === 'number') lowerBound = m.lowerBound;
      if (gate === 'repair.cycles')
        recorded =
          known && Number.isInteger(m.value) && m.value >= 0 ? m.value : null;
      else if (gate === 'context.input')
        recorded = known && m.value > 0 ? Math.log(m.value) : null;
      // Latency: natural log of agent-phase seconds (POLICY.md section 5.4).
      else recorded = known && m.value > 0 ? Math.log(m.value / 1000) : null;
    }
  }
  if (recorded == null && f != null) reasons.push('unknown-value');
  const out = {
    repetition: rep.repetition,
    clean: reasons.length === 0,
    value: reasons.length === 0 ? recorded : undefined,
    reasons,
    recordedValue: recorded,
  };
  if (lowerBound != null && recorded == null)
    out.recordedLowerBound = lowerBound;
  return out;
}

const forStats = (v) =>
  v.clean ? { clean: true, value: v.value } : { clean: false };

function repetitionsOf(m, taskId, modelKey, repetitions) {
  const cell = m.cells.get(cellKey(taskId, modelKey));
  const out = [];
  for (let r = 1; r <= repetitions; r += 1)
    out.push(
      cell?.reps.find((x) => x.repetition === r) ?? {
        taskId,
        modelKey,
        repetition: r,
        status: 'missing',
        valid: false,
        contested: false,
        attempts: 0,
        final: null,
        breach: false,
      },
    );
  return out;
}

function countReasons(values) {
  const counts = {};
  for (const v of values)
    for (const r of v.reasons) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}

function pointEstimate(gate, clean) {
  const n = clean.length;
  if (n === 0) return { clean: 0 };
  const mean = clean.reduce((a, v) => a + v, 0) / n;
  const scale = GATES[gate].scale;
  if (scale === 'binary')
    return gate === 'safety'
      ? {
          clean: n,
          breachFree: n - clean.filter((v) => v === 1).length,
          fraction: 1 - mean,
        }
      : {
          clean: n,
          successes: clean.filter((v) => v === 0).length,
          fraction: 1 - mean,
        };
  if (scale === 'count') return { clean: n, mean };
  return GATES[gate].design === 'paired'
    ? { clean: n, geometricMeanSeconds: Math.exp(mean) }
    : { clean: n, geometricMeanTokens: Math.exp(mean) };
}

// ------------------------------------------------------------------ derive

const EMPTY_SETS = () => ({
  application: [],
  diagnosis: [],
  report: [],
  critical: [],
  all: [],
  missingCapability: [],
});

/**
 * The task sets of POLICY.md sections 3 and 4 over the runnable tasks
 * `all` (sorted), from the checkout's corpus: one derivation for `derive`
 * and for the verification of a gate record in `check`.
 */
export function taskSetsFrom(loaded, epoch, all) {
  const heldout = new Set((loaded.manifest?.tasks ?? []).map((t) => t.id));
  const sets = EMPTY_SETS();
  for (const taskId of all) {
    if (heldout.has(taskId))
      throw new GatesRefusal(`held-out task ${taskId} in the matrix`);
    const entry = findTask(loaded, taskId);
    if (entry == null || !loaded.development.includes(entry))
      throw new GatesRefusal(
        `${taskId} is not a development task of the corpus`,
      );
    const kind = entry.task.expectations?.[epoch]?.intendedOutcome?.kind;
    const family = FAMILY_OF_KIND[kind];
    if (family == null)
      throw new GatesRefusal(
        `${taskId}: no outcome family for intended outcome ${kind} (epoch ${epoch})`,
      );
    sets[family].push(taskId);
    sets.all.push(taskId);
    if (kind === 'capability-gap-diagnosis')
      sets.missingCapability.push(taskId);
    // POLICY.md section 3: critical by rule, never by result.
    if (
      entry.task.caseType === 'positive' ||
      (entry.task.tags ?? []).some((t) => t.startsWith('adversarial:'))
    )
      sets.critical.push(taskId);
  }
  return sets;
}

function taskSets(loaded, matrix, modelKey, m) {
  const heldout = new Set((loaded.manifest?.tasks ?? []).map((t) => t.id));
  const runnable = [];
  const unsupported = [];
  for (const taskId of [...(matrix.tasks ?? [])].sort(byId)) {
    if (heldout.has(taskId))
      throw new GatesRefusal(`held-out task ${taskId} in the matrix`);
    const cell = m.cells.get(cellKey(taskId, modelKey));
    if (cell?.unsupported != null)
      unsupported.push({ taskId, reasons: cell.unsupported });
    else runnable.push(taskId);
  }
  return {
    sets: taskSetsFrom(loaded, matrix.epoch, runnable),
    unsupported,
  };
}

/** POLICY.md section 5.5: whether a gate over `tasks` blocks. */
function blockingOf(tasks) {
  return tasks.length >= MIN_BLOCKING_TASKS
    ? { blocking: true }
    : {
        blocking: false,
        blockingReason: `fewer than ${MIN_BLOCKING_TASKS} runnable tasks (POLICY.md section 5.5): reported, not blocking`,
      };
}

/** Section 5.2: the Monte Carlo seed and draws of a real-valued gate. */
function monteCarloOf(modelKey, gate) {
  const spec = GATES[gate];
  return spec.design === 'between-runs' && spec.scale === 'log'
    ? { seed: gateSeed(modelKey, gate), draws: DRAWS }
    : null;
}

/** The latency medians and cuts from a gate's clean baseline values. */
function latencyOf(tasks, values) {
  const byTask = {};
  for (const t of tasks)
    byTask[t] = values[t].map((value) => ({ clean: true, value }));
  return Object.values(byTask).some((v) => v.length > 0)
    ? latencyCuts(byTask)
    : null;
}

/** Why a gate record cannot be frozen (POLICY.md section 6, step 2). */
function freezeReasons({ kind, missing, insufficient, unbound }) {
  const reasons = [];
  if (kind !== 'provider-backed')
    reasons.push(`kind ${kind}: synthetic records, not a baseline`);
  if (missing > 0)
    reasons.push(
      `${missing} runnable repetitions have no valid attempt (section 6, step 2)`,
    );
  if (insufficient > 0)
    reasons.push(
      `${insufficient} gates are insufficient-reference (section 5.1)`,
    );
  if (unbound > 0)
    reasons.push(`${unbound} runnable cells have no record, hence no key`);
  return reasons;
}

/**
 * Cells to collect again before freezing (POLICY.md section 6, step 2), from
 * which repetitions are unclean only, never from their values: every
 * insufficient task's cell, then the cells with the most unclean
 * repetitions (ties by task id) until the dropped count is within the cap.
 */
function recollectFor(gateEntry, uncleanByTask) {
  const chosen = new Set(gateEntry.reference.insufficientTasks);
  let remaining =
    gateEntry.reference.dropped -
    [...chosen].reduce((a, t) => a + (uncleanByTask[t] ?? 0), 0);
  const order = Object.entries(uncleanByTask)
    .filter(([t, n]) => n > 0 && !chosen.has(t))
    .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]));
  for (const [t, n] of order) {
    if (remaining <= gateEntry.reference.maxDropped) break;
    chosen.add(t);
    remaining -= n;
  }
  return [...chosen].sort(byId);
}

/**
 * Derives the gate record from one baseline matrix directory (POLICY.md
 * section 6, step 3). Deterministic: no clock, no absolute path, sorted
 * keys; the Monte Carlo seeds are fixed per model and gate.
 */
export function deriveGates(baselineDir) {
  const m = readMatrix(baselineDir);
  const { matrix } = m;
  const bound = bindMatrix(m);
  const loaded = loadCorpus(CORPUS_ROOT);
  const R = matrix.repetitions;
  const problems = [];
  const lockSha = fileSha256(path.join(CORPUS_ROOT, 'corpus.lock.json'));
  const productKeys = new Set();
  for (const r of m.records) {
    if (r.task.epoch !== matrix.epoch)
      problems.push(`${r.task.id}: record epoch ${r.task.epoch}`);
    if (r.task.corpusLockSha256 !== lockSha)
      problems.push(
        `${r.task.id}: recorded corpus.lock.json ${r.task.corpusLockSha256} is not this checkout's ${lockSha} (the task families are read from it)`,
      );
    productKeys.add(
      JSON.stringify([
        r.productBuild.digest,
        r.productBuild.epoch,
        r.productBuild.sourceCommit,
        r.trustedTree.digest,
        r.trustedTree.pandamstyleDigest,
      ]),
    );
  }
  if (productKeys.size > 1)
    problems.push('the baseline records name more than one reference product');
  if (problems.length > 0)
    throw new GatesRefusal(
      'the baseline does not match its binding',
      [...new Set(problems)].sort(byId),
    );
  const first = m.records[0] ?? null;

  const models = {};
  const missingRepetitions = [];
  const recollect = new Map();
  const insufficientGates = [];
  for (const model of [...(matrix.models ?? [])].sort((a, b) =>
    byId(a.key, b.key),
  )) {
    const { sets, unsupported } = taskSets(loaded, matrix, model.key, m);
    for (const t of sets.all)
      for (const rep of repetitionsOf(m, t, model.key, R))
        if (!rep.valid)
          missingRepetitions.push({
            taskId: t,
            modelKey: model.key,
            repetition: rep.repetition,
            reason:
              rep.final == null
                ? 'missing'
                : `invalid: ${rep.final.outcome.class} ${rep.final.outcome.code}`,
          });
    const gates = {};
    let latency = null;
    for (const [gate, spec] of Object.entries(GATES)) {
      const tasks = sets[GATE_TASK_SET[gate]];
      const values = {};
      const dropped = [];
      const units = [];
      const uncleanByTask = {};
      const all = [];
      for (const t of tasks) {
        const vs = repetitionsOf(m, t, model.key, R).map((rep) =>
          repetitionValue(rep, gate),
        );
        all.push(...vs);
        values[t] = vs.filter((v) => v.clean).map((v) => v.value);
        uncleanByTask[t] = vs.filter((v) => !v.clean).length;
        for (const v of vs)
          if (!v.clean)
            dropped.push({
              taskId: t,
              repetition: v.repetition,
              reasons: v.reasons,
              recordedValue: v.recordedValue,
              ...(v.recordedLowerBound != null
                ? { recordedLowerBound: v.recordedLowerBound }
                : {}),
            });
        units.push({ reference: vs.map(forStats), candidate: [] });
      }
      // The baseline side of every gate, latency included (its cuts and
      // medians), needs the minimum clean evidence of section 5.1.
      const reference = referenceAccounting(
        tasks,
        units.map((u) => u.reference),
      );
      const sufficient = reference.status === 'sufficient';
      const entry = {
        scale: spec.scale,
        design: spec.design,
        taskSet: GATE_TASK_SET[gate],
        tasks,
        ...blockingOf(tasks),
        reference,
        values,
        droppedRepetitions: dropped,
        unclean: countReasons(all),
        unmeasuredByBaseline:
          all.length > 0 && all.every((v) => v.recordedValue == null),
        pointEstimate: pointEstimate(gate, Object.values(values).flat()),
      };
      entry.monteCarlo = monteCarloOf(model.key, gate);
      if (spec.design === 'between-runs') {
        entry.minimumDetectable = minimumDetectable({
          gate,
          model: model.key,
          reference: units.map((u) => u.reference),
        });
      } else {
        entry.cut = spec.cut;
        latency ??= latencyOf(tasks, values);
      }
      if (!sufficient) {
        insufficientGates.push({ modelKey: model.key, gate });
        for (const t of recollectFor(entry, uncleanByTask)) {
          const k = cellKey(t, model.key);
          if (!recollect.has(k))
            recollect.set(k, { taskId: t, modelKey: model.key, gates: [] });
          recollect.get(k).gates.push(gate);
        }
      }
      gates[gate] = entry;
    }
    const mc = gates['success.diagnosis'];
    const mcValues = sets.missingCapability.flatMap((t) => mc.values[t]);
    models[model.key] = {
      config: model,
      projection: bound.perModel.get(model.key) ?? null,
      taskSets: sets,
      unsupportedTasks: unsupported,
      latency,
      gates,
      reported: {
        // POLICY.md section 3: its own line, not a blocking gate (5.5).
        missingCapabilityDiagnosis: {
          tasks: sets.missingCapability,
          blocking: false,
          ...pointEstimate('success.diagnosis', mcValues),
          dropped: mc.droppedRepetitions.filter((d) =>
            sets.missingCapability.includes(d.taskId),
          ).length,
        },
      },
    };
  }

  const cells = [];
  for (const model of Object.keys(models))
    for (const t of models[model].taskSets.all) {
      const c = bound.cellKeys.get(cellKey(t, model));
      cells.push({
        taskId: t,
        modelKey: model,
        comparabilityKey: c?.key ?? null,
        projection: c?.projection ?? null,
      });
    }
  const reasons = freezeReasons({
    kind: matrix.kind,
    missing: missingRepetitions.length,
    insufficient: insufficientGates.length,
    unbound: cells.filter((c) => c.comparabilityKey == null).length,
  });

  return {
    schema: GATES_SCHEMA,
    synthetic: matrix.kind !== 'provider-backed',
    binding: {
      method: METHOD,
      alpha: FAMILY_ALPHA,
      gateCount: GATE_COUNT,
      gateAlpha: GATE_ALPHA,
      draws: DRAWS,
      minCleanReferencePerTask: MIN_CLEAN_REFERENCE_PER_TASK,
      maxDroppedReferencePer: MAX_DROPPED_REFERENCE_PER,
      minBlockingTasks: MIN_BLOCKING_TASKS,
      policySha256: fileSha256(POLICY_FILE),
      statsSha256: fileSha256(STATS_FILE),
      toolSha256: fileSha256(TOOL_FILE),
      kind: matrix.kind,
      matrixId: matrix.matrixId,
      repetitions: R,
      corpus: {
        version: first?.task.corpusVersion ?? loaded.corpus.corpusVersion,
        lockSha256: lockSha,
        epoch: matrix.epoch,
        split: 'development',
      },
      harness: {
        runnerTreeDigest: first?.harness.runnerTreeDigest ?? null,
        harnessDepsLockSha256: first?.harness.harnessDepsLockSha256 ?? null,
        commits: [...new Set(m.records.map((r) => r.harness.commit))].sort(
          byId,
        ),
      },
      referenceProduct: {
        buildDigest: first?.productBuild.digest ?? null,
        epoch: first?.productBuild.epoch ?? null,
        sourceCommit: first?.productBuild.sourceCommit ?? null,
        trustedTreeDigest: first?.trustedTree.digest ?? null,
        pandamstyleDigest: first?.trustedTree.pandamstyleDigest ?? null,
      },
      matrixProductBuild: matrix.productBuild ?? null,
      shared: bound.all,
      cells,
    },
    inputs: m.inputs,
    freeze: {
      status: reasons.length === 0 ? 'freezable' : 'not-freezable',
      reasons,
      insufficientGates,
      // All three repetitions of each cell, by a supplementary matrix.
      recollectCells: [...recollect.values()].sort(
        (a, b) => byId(a.modelKey, b.modelKey) || byId(a.taskId, b.taskId),
      ),
      missingRepetitions,
    },
    models,
  };
}

// ------------------------------------------------------------------- check

/** A gate's frozen baseline, per task: clean values, then dropped ones. */
function referenceUnits(e, candidateOf = () => []) {
  return e.tasks.map((t) => ({
    reference: [
      ...e.values[t].map((value) => ({ clean: true, value })),
      ...e.droppedRepetitions
        .filter((x) => x.taskId === t)
        .map(() => ({ clean: false })),
    ],
    candidate: candidateOf(t),
  }));
}

const show = (v) => {
  const text = JSON.stringify(v ?? null);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

/** Field-by-field comparison of recorded and recomputed values. */
function compareFields(problems, where, recorded, expected, fields) {
  for (const f of fields)
    if (serialize(recorded?.[f] ?? null) !== serialize(expected?.[f] ?? null))
      problems.push(
        `${where}: ${f} does not recompute (recorded ${show(recorded?.[f])}, recomputed ${show(expected?.[f])})`,
      );
}

const keysOf = (...objects) =>
  [...new Set(objects.flatMap((o) => Object.keys(o ?? {})))].sort(byId);

/**
 * Every recorded value `check` relies on is recomputed from the record's
 * baseline data (task sets, clean values and dropped repetitions, cell
 * projections) through the same derivations as `derive`, or the record is
 * refused, field by field. A record that is not freezable is refused
 * (POLICY.md section 6.2). `minimumDetectable`, point estimates, unclean
 * counts, `recollectCells` and the inputs' digests are neither used nor
 * reported by `check`, so they are not verified here.
 */
function verifyGateRecord(g, loaded) {
  const problems = [];
  if (g?.schema !== GATES_SCHEMA) problems.push(`schema ${g?.schema}`);
  const b = g?.binding ?? {};
  const expect = {
    method: METHOD,
    alpha: FAMILY_ALPHA,
    gateCount: GATE_COUNT,
    gateAlpha: GATE_ALPHA,
    draws: DRAWS,
    minCleanReferencePerTask: MIN_CLEAN_REFERENCE_PER_TASK,
    maxDroppedReferencePer: MAX_DROPPED_REFERENCE_PER,
    minBlockingTasks: MIN_BLOCKING_TASKS,
    statsSha256: fileSha256(STATS_FILE),
  };
  for (const [k, v] of Object.entries(expect))
    if (b[k] !== v) problems.push(`binding.${k} ${b[k]} is not ${v}`);
  const R = b.repetitions;
  if (!Number.isInteger(R) || R < 1)
    problems.push(`binding.repetitions ${R} is not a positive integer`);
  // The task sets are recomputed from the checkout's corpus: it must be the
  // record's.
  compareFields(
    problems,
    'binding.corpus',
    b.corpus,
    { lockSha256: fileSha256(path.join(CORPUS_ROOT, 'corpus.lock.json')) },
    ['lockSha256'],
  );
  compareFields(
    problems,
    'record',
    g,
    { synthetic: b.kind !== 'provider-backed' },
    ['synthetic'],
  );
  if (problems.length > 0)
    throw new GatesRefusal(
      'the gate record is not usable by this checkout',
      problems,
    );

  const models = Object.keys(g.models ?? {}).sort(byId);
  const insufficientGates = [];
  const missingRepetitions = [];
  const expectedCells = [];
  for (const model of models) {
    const mg = g.models[model];
    const where = model;
    // Task sets, from the runnable tasks through the corpus.
    const all = Array.isArray(mg.taskSets?.all) ? mg.taskSets.all : [];
    compareFields(
      problems,
      where,
      { 'taskSets.all': mg.taskSets?.all },
      { 'taskSets.all': [...new Set(all)].sort(byId) },
      ['taskSets.all'],
    );
    let sets = EMPTY_SETS();
    try {
      sets = taskSetsFrom(loaded, b.corpus.epoch, all);
    } catch (e) {
      problems.push(`${where}: taskSets.all: ${e.message}`);
    }
    compareFields(
      problems,
      `${where} taskSets`,
      mg.taskSets,
      sets,
      keysOf(mg.taskSets, sets),
    );
    const unsupported = (mg.unsupportedTasks ?? []).map((u) => u.taskId);
    for (const t of unsupported.filter((x) => all.includes(x)))
      problems.push(`${where}: ${t} is both runnable and unsupported`);
    for (const t of sets.all)
      expectedCells.push({ taskId: t, modelKey: model });

    for (const [gate, spec] of Object.entries(GATES)) {
      const e = mg.gates?.[gate];
      const at = `${model} ${gate}`;
      if (e == null) {
        problems.push(`${model}: gate ${gate} is absent`);
        continue;
      }
      const tasks = sets[GATE_TASK_SET[gate]];
      compareFields(
        problems,
        at,
        e,
        {
          scale: spec.scale,
          design: spec.design,
          taskSet: GATE_TASK_SET[gate],
          tasks,
          ...blockingOf(tasks),
          cut: spec.cut,
          monteCarlo: monteCarloOf(model, gate),
        },
        [
          'scale',
          'design',
          'taskSet',
          'tasks',
          'blocking',
          'blockingReason',
          'cut',
          'monteCarlo',
        ],
      );
      // The baseline data itself: one value list per task, every value on
      // its scale, every dropped repetition planned and named once.
      const values = e.values ?? {};
      compareFields(
        problems,
        at,
        { 'values (tasks)': Object.keys(values).sort(byId) },
        { 'values (tasks)': [...tasks].sort(byId) },
        ['values (tasks)'],
      );
      let complete = true;
      for (const t of tasks) {
        const vs = Array.isArray(values[t]) ? values[t] : [];
        if (!Array.isArray(values[t])) complete = false;
        for (const v of vs)
          try {
            orient({ clean: true, value: v }, 'reference', spec.scale);
          } catch (err) {
            complete = false;
            problems.push(`${at} ${t}: ${err.message}`);
          }
        const reps = (e.droppedRepetitions ?? [])
          .filter((d) => d.taskId === t)
          .map((d) => d.repetition);
        if (
          new Set(reps).size !== reps.length ||
          reps.some((r) => !Number.isInteger(r) || r < 1 || r > R)
        ) {
          complete = false;
          problems.push(`${at} ${t}: dropped repetitions ${show(reps)}`);
        }
        const n = vs.length + reps.length;
        if (n !== R) {
          complete = false;
          problems.push(`${at} ${t}: ${n} reference repetitions`);
        }
      }
      for (const d of e.droppedRepetitions ?? [])
        if (!tasks.includes(d.taskId)) {
          complete = false;
          problems.push(
            `${at}: dropped repetition of ${d.taskId}, not in the gate`,
          );
        }
      if (!complete) continue;
      // The recorded accounting is the method's, recomputed: every field,
      // and no other one.
      const expected = referenceAccounting(
        e.tasks,
        referenceUnits(e).map((u) => u.reference),
      );
      const recorded = e.reference ?? {};
      const fields = keysOf(expected, recorded).filter(
        (f) => serialize(expected[f]) !== serialize(recorded[f]),
      );
      if (fields.length > 0)
        problems.push(
          `${at}: recorded reference accounting does not recompute (${fields.map((f) => `${f}: recorded ${JSON.stringify(recorded[f] ?? null)}, recomputed ${JSON.stringify(expected[f] ?? null)}`).join('; ')})`,
        );
      if (expected.status !== 'sufficient')
        insufficientGates.push({ modelKey: model, gate });
      // Repetitions without a valid attempt, from the gate over every
      // runnable task whose value is known whenever a record exists.
      if (gate === 'safety')
        for (const d of e.droppedRepetitions)
          if (
            d.reasons?.some((r) =>
              ['missing', 'invalid', 'unclassified', 'unsupported'].includes(r),
            )
          )
            missingRepetitions.push({
              taskId: d.taskId,
              modelKey: model,
              repetition: d.repetition,
            });
    }

    // One metric, one baseline: gates over the same values agree.
    const gates = mg.gates ?? {};
    const sameData = (gateA, gateB, t) => {
      const strip = (x) =>
        (x?.droppedRepetitions ?? [])
          .filter((d) => d.taskId === t)
          .map((d) => [d.repetition, d.reasons]);
      return (
        serialize(gates[gateA]?.values?.[t] ?? null) ===
          serialize(gates[gateB]?.values?.[t] ?? null) &&
        serialize(strip(gates[gateA])) === serialize(strip(gates[gateB]))
      );
    };
    for (const t of sets.critical) {
      const family = sets.application.includes(t)
        ? 'success.application'
        : sets.diagnosis.includes(t)
          ? 'success.diagnosis'
          : 'success.report';
      if (!sameData('success.critical', family, t))
        problems.push(
          `${model}: success.critical and ${family} disagree on ${t}`,
        );
    }
    for (const t of sets.all)
      if (!sameData('latency.p50', 'latency.p95', t))
        problems.push(`${model}: latency.p50 and latency.p95 disagree on ${t}`);
    // Latency medians and cuts, from the latency baseline values.
    let latency = null;
    try {
      latency = latencyOf(sets.all, gates['latency.p50']?.values ?? {});
    } catch (err) {
      problems.push(`${model}: latency: ${err.message}`);
    }
    compareFields(
      problems,
      `${model} latency`,
      mg.latency,
      latency,
      keysOf(mg.latency, latency),
    );
    // The model's shared projection groups, from its cells' projections.
    const own = (b.cells ?? []).filter(
      (c) => c.modelKey === model && c.projection != null,
    );
    const shared =
      own.length > 0
        ? sharedProjection(own[0].projection, SHARED_PER_MODEL)
        : null;
    for (const c of own)
      if (
        sharedDiff(shared, sharedProjection(c.projection, SHARED_PER_MODEL))
          .length > 0
      )
        problems.push(
          `${model}: cell ${c.taskId} differs in a shared projection group`,
        );
    compareFields(problems, model, mg, { projection: shared }, ['projection']);
  }

  // Cells: one per runnable task and model, each key its projection's.
  compareFields(
    problems,
    'binding',
    { cells: (b.cells ?? []).map((c) => [c.taskId, c.modelKey]) },
    { cells: expectedCells.map((c) => [c.taskId, c.modelKey]) },
    ['cells'],
  );
  for (const c of b.cells ?? []) {
    const at = `binding cell ${c.taskId}/${c.modelKey}`;
    if ((c.comparabilityKey == null) !== (c.projection == null))
      problems.push(`${at}: a key without a projection, or the reverse`);
    else if (c.projection != null) {
      if (comparabilityKey(c.projection) !== c.comparabilityKey)
        problems.push(`${at}: the key is not its projection's digest`);
      if (c.projection.task?.id !== c.taskId)
        problems.push(
          `${at}: the projection is of task ${c.projection.task?.id}`,
        );
    }
  }
  const keyed = (b.cells ?? []).filter((c) => c.projection != null);
  compareFields(
    problems,
    'binding',
    b,
    {
      shared:
        keyed.length > 0
          ? sharedProjection(keyed[0].projection, SHARED_ALL)
          : null,
    },
    ['shared'],
  );
  for (const c of keyed)
    if (
      sharedDiff(b.shared ?? {}, sharedProjection(c.projection, SHARED_ALL))
        .length > 0
    )
      problems.push(
        `binding cell ${c.taskId}/${c.modelKey}: differs from binding.shared`,
      );

  // Freezing, recomputed; a record that is not freezable is never applied.
  const reasons = freezeReasons({
    kind: b.kind,
    missing: missingRepetitions.length,
    insufficient: insufficientGates.length,
    unbound: (b.cells ?? []).filter((c) => c.comparabilityKey == null).length,
  });
  const freeze = g.freeze ?? {};
  compareFields(
    problems,
    'freeze',
    {
      ...freeze,
      missingRepetitions: (freeze.missingRepetitions ?? []).map((x) => [
        x.taskId,
        x.modelKey,
        x.repetition,
      ]),
    },
    {
      status: reasons.length === 0 ? 'freezable' : 'not-freezable',
      reasons,
      insufficientGates,
      missingRepetitions: missingRepetitions
        .sort(
          (x, y) =>
            byId(x.modelKey, y.modelKey) ||
            byId(x.taskId, y.taskId) ||
            x.repetition - y.repetition,
        )
        .map((x) => [x.taskId, x.modelKey, x.repetition]),
    },
    ['status', 'reasons', 'insufficientGates', 'missingRepetitions'],
  );
  if (freeze.status !== 'freezable' || reasons.length > 0)
    problems.push(
      `freeze.status ${show(freeze.status)}: a gate record that is not freezable is never applied (POLICY.md section 6.2)`,
    );
  if (problems.length > 0)
    throw new GatesRefusal(
      'the gate record is not usable by this checkout',
      problems,
    );
}

/** Binding of a candidate or control matrix to the gate record. */
function verifyBinding(g, m, role) {
  const b = g.binding;
  const problems = [];
  if (m.matrix.kind !== b.kind)
    problems.push(`kind ${m.matrix.kind}, gate ${b.kind}`);
  if (m.matrix.repetitions !== b.repetitions)
    problems.push(`${m.matrix.repetitions} repetitions, gate ${b.repetitions}`);
  if (m.matrix.epoch !== b.corpus.epoch)
    problems.push(`epoch ${m.matrix.epoch}, gate ${b.corpus.epoch}`);
  const cells = new Map(b.cells.map((c) => [cellKey(c.taskId, c.modelKey), c]));
  const ignored = new Set();
  for (const r of m.records) {
    const where = `${r.cell.taskId}/${r.cell.modelKey} rep ${r.repetition} attempt ${r.attempt}`;
    const c = cells.get(cellKey(r.cell.taskId, r.cell.modelKey));
    if (c == null) {
      ignored.add(`${r.cell.taskId}/${r.cell.modelKey}`);
      continue;
    }
    const p = r.comparability.projection;
    if (c.comparabilityKey != null) {
      if (r.comparability.key !== c.comparabilityKey)
        problems.push(
          `${where}: comparability key differs (${diffProjections(c.projection, p).join(', ') || 'key'})`,
        );
    } else {
      // No baseline record for that cell: its gates are insufficient, but
      // the groups every cell of the model shares still bind it.
      const shared = g.models[r.cell.modelKey]?.projection;
      const d =
        shared == null
          ? ['model']
          : sharedDiff(shared, sharedProjection(p, SHARED_PER_MODEL));
      if (d.length > 0) problems.push(`${where}: ${d.join(', ')} differ`);
    }
    if (role === 'control') {
      const rp = b.referenceProduct;
      if (
        r.trustedTree.digest !== rp.trustedTreeDigest ||
        r.trustedTree.pandamstyleDigest !== rp.pandamstyleDigest ||
        r.productBuild.sourceCommit !== rp.sourceCommit ||
        r.productBuild.epoch !== rp.epoch
      )
        problems.push(`${where}: the control is not the reference product`);
    }
  }
  if (problems.length > 0)
    throw new GatesRefusal(
      `the ${role} matrix does not match the gate record's binding`,
      [...new Set(problems)].sort(byId),
    );
  return [...ignored].sort(byId);
}

/**
 * The accounting a result reports, in the task-id form of
 * `referenceAccounting`, after checking that `decideGate` counted the same
 * repetitions.
 */
function sameCounts(accounting, decided) {
  for (const f of ['planned', 'dropped', 'maxDropped'])
    if (accounting[f] !== decided[f])
      throw new Error(`reference accounting disagrees with decideGate on ${f}`);
  if (decided.sufficient !== (accounting.status === 'sufficient'))
    throw new Error('reference accounting disagrees with decideGate');
  return accounting;
}

const nearestRank = (sorted, q) =>
  sorted.length === 0
    ? null
    : sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];

/**
 * Applies a gate record to a candidate matrix (POLICY.md sections 4 and 5).
 * Every gate is decided by `decideGate`; the latency gates need the
 * interleaved control (`controlDir`) and are `insufficient-reference`
 * without it. Pairs are formed by task, model and repetition index: the
 * candidate's repetition r with the control's repetition r. The verdict is
 * `pass` only when every blocking gate passes; otherwise the worst blocking
 * outcome (`insufficient-reference` before `block`).
 */
export function checkGates(
  gateRecord,
  candidateDir,
  { controlDir = null } = {},
) {
  verifyGateRecord(gateRecord, loadCorpus(CORPUS_ROOT));
  const R = gateRecord.binding.repetitions;
  const cand = readMatrix(candidateDir);
  bindMatrix(cand);
  const ignored = verifyBinding(gateRecord, cand, 'candidate');
  let control = null;
  if (controlDir != null) {
    control = readMatrix(controlDir);
    if (control.matrix.matrixId === cand.matrix.matrixId)
      throw new GatesRefusal('the control is the candidate matrix');
    bindMatrix(control);
    verifyBinding(gateRecord, control, 'control');
  }

  const results = [];
  const reviewItems = [];
  for (const [modelKey, mg] of Object.entries(gateRecord.models).sort((a, b) =>
    byId(a[0], b[0]),
  )) {
    for (const [gate, spec] of Object.entries(GATES)) {
      const e = mg.gates[gate];
      const candidateValues = new Map(
        e.tasks.map((t) => [
          t,
          repetitionsOf(cand, t, modelKey, R).map((rep) =>
            repetitionValue(rep, gate),
          ),
        ]),
      );
      const all = [...candidateValues.values()].flat();
      const base = {
        modelKey,
        gate,
        blocking: e.blocking,
        tasks: e.tasks.length,
        candidate: {
          planned: all.length,
          unclean: countReasons(all),
          pointEstimate: pointEstimate(
            gate,
            all.filter((v) => v.clean).map((v) => v.value),
          ),
        },
      };
      const insufficient = (reason, reference = null) => ({
        ...base,
        outcome: 'insufficient-reference',
        reason,
        pValue: null,
        reference,
      });
      if (e.tasks.length === 0) {
        results.push(insufficient('empty task set'));
        continue;
      }
      // The baseline's accounting (task-id form), as verified.
      const baselineReference = referenceAccounting(
        e.tasks,
        referenceUnits(e).map((u) => u.reference),
      );
      if (spec.design === 'paired') {
        if (control == null) {
          results.push(insufficient('no interleaved control (--control)'));
          continue;
        }
        if (baselineReference.status !== 'sufficient' || mg.latency == null) {
          results.push(
            insufficient(
              'the baseline latency values have insufficient clean evidence',
              baselineReference,
            ),
          );
          continue;
        }
        // The control is the reference: before its repetitions become
        // pairs, every task keeps the minimum clean evidence of section 5.1
        // (and the dropped cap holds), from the control alone.
        const controlValues = new Map(
          e.tasks.map((t) => [
            t,
            repetitionsOf(control, t, modelKey, R).map((rep) =>
              repetitionValue(rep, gate),
            ),
          ]),
        );
        const controlReference = referenceAccounting(
          e.tasks,
          e.tasks.map((t) => controlValues.get(t).map(forStats)),
        );
        if (controlReference.status !== 'sufficient') {
          results.push(
            insufficient(
              `the interleaved control lacks the minimum clean evidence (POLICY.md section 5.1)${controlReference.insufficientTasks.length > 0 ? `: ${controlReference.insufficientTasks.join(', ')}` : ''}`,
              controlReference,
            ),
          );
          continue;
        }
        const units = [];
        const ctrl = [];
        const candNorm = [];
        for (const t of e.tasks) {
          const cv = candidateValues.get(t);
          const kv = controlValues.get(t);
          for (let i = 0; i < R; i += 1) {
            const c = normalizeLatency(forStats(cv[i]), t, mg.latency.medians);
            const k = normalizeLatency(forStats(kv[i]), t, mg.latency.medians);
            units.push({ reference: [k], candidate: [c] });
            if (c.clean) candNorm.push(c.value);
            if (k.clean) ctrl.push(k.value);
          }
        }
        const d = decideGate({
          gate,
          model: modelKey,
          units,
          cuts: mg.latency.cuts,
        });
        candNorm.sort((a, b) => a - b);
        ctrl.sort((a, b) => a - b);
        const ratio = (q) => {
          const a = nearestRank(candNorm, q);
          const b = nearestRank(ctrl, q);
          return a == null || b == null ? null : Math.exp(a - b);
        };
        results.push({
          ...base,
          outcome: d.outcome,
          pValue: d.pValue,
          method: d.method,
          observed: d.observed ?? null,
          alpha: d.alpha,
          // The control's accounting, in the task-id form; the pairs'
          // accounting of decideGate counts the same repetitions.
          reference: sameCounts(controlReference, d.reference),
          cut: { name: spec.cut, value: mg.latency.cuts[spec.cut] },
          // Reported, never deciding (POLICY.md section 5.4).
          ratioCandidateOverControl: { p50: ratio(0.5), p95: ratio(0.95) },
        });
        continue;
      }
      const units = referenceUnits(e, (t) =>
        candidateValues.get(t).map(forStats),
      );
      const d = decideGate({ gate, model: modelKey, units });
      results.push({
        ...base,
        outcome: d.outcome,
        pValue: d.pValue,
        method: d.method,
        observed: d.observed ?? null,
        alpha: d.alpha,
        reference: sameCounts(baselineReference, d.reference),
        ...(d.seed ? { monteCarlo: { seed: d.seed, draws: d.draws } } : {}),
      });
      // POLICY.md section 4: a critical cell from 3/3 to 0/3 is reviewed.
      if (gate === 'success.critical')
        for (const t of e.tasks) {
          const ref = e.values[t];
          const cv = candidateValues.get(t);
          if (
            ref.length === R &&
            ref.every((v) => v === 0) &&
            cv.every((v) => !v.clean || v.value !== 0)
          )
            reviewItems.push({
              modelKey,
              taskId: t,
              item: `critical cell ${R}/${R} in the baseline, 0/${R} for the candidate (mandatory review, not blocking)`,
            });
        }
    }
  }

  const blocking = results.filter((r) => r.blocking);
  let verdict;
  let verdictReason;
  if (blocking.length === 0) {
    verdict = 'insufficient-reference';
    verdictReason = 'no blocking gate';
  } else {
    verdict = blocking.reduce(
      (w, r) =>
        OUTCOMES.indexOf(r.outcome) > OUTCOMES.indexOf(w) ? r.outcome : w,
      'pass',
    );
    verdictReason =
      verdict === 'pass'
        ? 'every blocking gate passes'
        : `${blocking.filter((r) => r.outcome !== 'pass').length} blocking gates do not pass`;
  }
  const counts = Object.fromEntries(
    OUTCOMES.map((o) => [o, blocking.filter((r) => r.outcome === o).length]),
  );
  return {
    schema: CHECK_SCHEMA,
    synthetic: gateRecord.synthetic || cand.matrix.kind !== 'provider-backed',
    gateRecord: {
      sha256: sha256(serialize(gateRecord)),
      matrixId: gateRecord.binding.matrixId,
      freezeStatus: gateRecord.freeze.status,
      policySha256: gateRecord.binding.policySha256,
      policyMatchesCheckout:
        gateRecord.binding.policySha256 === fileSha256(POLICY_FILE),
    },
    candidate: {
      matrixId: cand.matrix.matrixId,
      kind: cand.matrix.kind,
      inputs: cand.inputs,
      productBuild: [
        ...new Set(cand.records.map((r) => r.productBuild.digest)),
      ].sort(byId),
      trustedTree: [
        ...new Set(cand.records.map((r) => r.trustedTree.digest)),
      ].sort(byId),
      ignoredCells: ignored,
    },
    control:
      control == null
        ? null
        : {
            matrixId: control.matrix.matrixId,
            inputs: control.inputs,
            pairing:
              'task, model and repetition index; order inside a pair not verified',
          },
    // POLICY.md section 6: non-latency gates do not control for provider drift.
    driftCaveat:
      'the success, critical, safety, context and repair gates compare with the frozen baseline and do not control for provider-side model drift',
    gates: results,
    reviewItems,
    blockingOutcomes: counts,
    verdict,
    verdictReason,
  };
}
