/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// `gates derive` and `gates check` (baseline/gates.mjs, POLICY.md section
// 6) over SYNTHETIC matrix directories: one record is produced by the
// runner's own adapter-fixture driver (fake CLI, stub grading, no provider),
// and every other record is a schema-valid copy of it with its comparability
// key recomputed by the runner. No model is called.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  STUB_GRADING,
  tmpDir,
  writeScenario,
} from '../runner/__tests__/helpers.mjs';
import { comparabilityKey } from '../runner/src/comparability.mjs';
import { validate } from '../src/json-schema.mjs';
import { CORPUS_ROOT, loadCorpus } from '../src/corpus.mjs';
import {
  FAMILY_OF_KIND,
  GatesRefusal,
  checkGates,
  deriveGates,
  serialize,
} from '../baseline/gates.mjs';
import { GATES, OUTCOMES } from '../baseline/stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, '../baseline/bin/gates.mjs');
const RECORD_SCHEMA = JSON.parse(
  fs.readFileSync(
    path.join(CORPUS_ROOT, 'runner/schema/run-record.v1.schema.json'),
    'utf8',
  ),
);
const LOCK = JSON.parse(
  fs.readFileSync(path.join(CORPUS_ROOT, 'corpus.lock.json'), 'utf8'),
);
const CORPUS = loadCorpus(CORPUS_ROOT);
const TASKS = CORPUS.development
  .map((t) => t.task)
  .sort((a, b) => (a.id < b.id ? -1 : 1));
const RUNNABLE = TASKS.filter((t) => t.workflow !== 'installation');
const INSTALL = TASKS.filter((t) => t.workflow === 'installation');
const familyOf = (t) =>
  FAMILY_OF_KIND[t.expectations.alpha1.intendedOutcome.kind];
const APPLICATION = RUNNABLE.filter((t) => familyOf(t) === 'application').map(
  (t) => t.id,
);
const REPORT = RUNNABLE.filter((t) => familyOf(t) === 'report').map(
  (t) => t.id,
);
const rank = (o) => OUTCOMES.indexOf(o);

// ------------------------------------------------------------ fixtures

let templateCache = null;
/** One record and matrix.json written by the runner's fixture driver. */
async function template() {
  if (templateCache) return templateCache;
  const ok = writeScenario(tmpDir('gates-template'), 'o', {
    steps: [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [ok] },
    grading: STUB_GRADING(),
    matrixId: 'm-gates-template',
  });
  const [record] = recordsOf(out.matrixDir);
  const matrix = JSON.parse(
    fs.readFileSync(path.join(out.matrixDir, 'matrix.json'), 'utf8'),
  );
  templateCache = { record, matrix };
  return templateCache;
}

const MODEL_KEYS = {
  'claude-haiku': 'claude-haiku-5-5',
  'claude-sonnet': 'claude-sonnet-5-5',
};

/** Base latency (ms) and tokens of a task, varied so cuts are non-trivial. */
const baseMs = (i, rep) => 30000 * (1 + (i % 7)) * (1 + 0.1 * rep);
const baseTokens = (i, rep) => 10000 * (1 + (i % 5)) + 97 * rep;

const DEFAULT_SPEC = {
  success: true,
  tokens: undefined,
  repairs: 0,
  ms: undefined,
  breach: false,
  contested: false,
  crashed: false,
  missing: false,
  invalid: false,
  unclassified: false,
};

function recordFor(t, { matrixId, taskId, modelKey, rep, attempt, kind }) {
  const r = structuredClone(t.record);
  const task = TASKS.find((x) => x.id === taskId);
  r.kind = kind;
  r.matrixId = matrixId;
  r.cell = { taskId, modelKey };
  r.repetition = rep;
  r.attempt = attempt;
  Object.assign(r.task, {
    id: taskId,
    workflow: task.workflow,
    caseType: task.caseType,
    taskDigest: LOCK.development[taskId],
  });
  r.modelConfig.requestedModel = MODEL_KEYS[modelKey];
  const p = r.comparability.projection;
  p.task.id = taskId;
  p.task.taskDigest = LOCK.development[taskId];
  p.model.requestedModel = MODEL_KEYS[modelKey];
  p.model.normalizedArgv = p.model.normalizedArgv.map((a) =>
    a.startsWith('claude-') ? MODEL_KEYS[modelKey] : a,
  );
  p.budgets.timeoutSeconds = task.budget.timeoutSeconds;
  return r;
}

function setAttempt(r, s, i, rep) {
  const ok = s.success;
  r.outcome = {
    ...r.outcome,
    termination: 'completed',
    class: 'agent',
    code: 'completed',
    valid: true,
    taskSuccess: ok,
    retry: { scheduled: false, backoffSeconds: null },
    breaches: s.breach
      ? [{ kind: 'scope', source: 'oracle', enforcement: 'detected' }]
      : [],
  };
  r.grading.verdict = ok ? 'pass' : 'fail';
  r.integrity.contested = s.contested;
  const tokens = s.tokens === undefined ? baseTokens(i, rep) : s.tokens;
  r.metrics.tokens.normalized.total.inputTotal =
    tokens == null
      ? {
          status: 'unknown',
          value: null,
          source: 'synthetic',
          integrity: null,
          method: null,
          lowerBound: 777,
          unit: 'tokens',
        }
      : { ...r.metrics.tokens.normalized.total.inputTotal, value: tokens };
  r.metrics.repairCycles =
    s.repairs == null
      ? {
          status: 'unknown',
          value: null,
          source: 'synthetic',
          integrity: null,
          method: null,
          unit: 'cycles',
        }
      : {
          ...r.metrics.repairCycles,
          value: s.repairs,
          lowerBound: s.repairs,
        };
  const ms = s.ms === undefined ? baseMs(i, rep) : s.ms;
  r.metrics.elapsed.agentPhaseMs =
    ms == null
      ? {
          status: 'unknown',
          value: null,
          source: 'synthetic',
          integrity: null,
          method: null,
          unit: 'ms',
        }
      : { ...r.metrics.elapsed.agentPhaseMs, value: ms };
  if (s.invalid)
    Object.assign(r.outcome, {
      termination: 'harness',
      class: 'harness',
      code: 'evaluate-error',
      valid: false,
      taskSuccess: null,
    });
  if (s.unclassified)
    Object.assign(r.outcome, {
      termination: 'unclassified',
      class: 'unclassified',
      code: 'unclassified',
      valid: false,
      taskSuccess: null,
    });
  if (!r.outcome.valid) r.grading.verdict = 'not-graded';
}

const seal = (r) => {
  r.comparability.key = comparabilityKey(r.comparability.projection);
  const errors = validate(RECORD_SCHEMA, r);
  assert.deepEqual(errors, [], 'synthetic record is schema-valid');
  return r;
};

/**
 * Writes a synthetic matrix directory. `spec(taskId, modelKey, rep, i)`
 * returns overrides of DEFAULT_SPEC; `edit(record, ctx)` may change a
 * record before its key is computed.
 */
async function buildMatrix(
  name,
  {
    tasks = TASKS.map((t) => t.id),
    models = ['claude-haiku'],
    repetitions = 3,
    kind = 'adapter-fixture',
    matrixId = `m-${name}`,
    spec = () => ({}),
    edit = () => {},
  } = {},
) {
  const t = await template();
  const dir = path.join(tmpDir(`gates-${name}`), matrixId);
  fs.mkdirSync(dir, { recursive: true });
  const matrix = {
    ...structuredClone(t.matrix),
    kind,
    matrixId,
    tasks,
    repetitions,
    models: models.map((key) => ({
      ...t.matrix.models[0],
      key,
      model: MODEL_KEYS[key],
    })),
  };
  fs.writeFileSync(path.join(dir, 'matrix.json'), JSON.stringify(matrix));
  const outcomes = [];
  for (const taskId of tasks) {
    const i = TASKS.findIndex((x) => x.id === taskId);
    const task = TASKS[i];
    for (const modelKey of models) {
      if (task.workflow === 'installation') {
        outcomes.push({
          taskId,
          model: modelKey,
          status: 'unsupported',
          repetitions,
          reasons: ['network: package-registry needs the local mirror'],
        });
        continue;
      }
      for (let rep = 1; rep <= repetitions; rep += 1) {
        const s = { ...DEFAULT_SPEC, ...spec(taskId, modelKey, rep, i) };
        if (s.missing) {
          outcomes.push({
            taskId,
            model: modelKey,
            repetition: rep,
            status: 'missing',
            contested: false,
            reason: 'not run',
          });
          continue;
        }
        const repDir = path.join(dir, 'cells', taskId, modelKey, `rep-${rep}`);
        let attempt = 1;
        const ctx = { taskId, modelKey, rep, i };
        if (s.crashed) {
          fs.mkdirSync(path.join(repDir, `attempt-${attempt}`), {
            recursive: true,
          });
          attempt += 1;
        }
        if (s.contested) {
          const infra = recordFor(t, {
            matrixId,
            taskId,
            modelKey,
            rep,
            attempt,
            kind,
          });
          setAttempt(infra, { ...s, success: false }, i, rep);
          Object.assign(infra.outcome, {
            termination: 'infrastructure',
            class: 'infrastructure',
            code: 'capacity',
            valid: false,
            taskSuccess: null,
            retry: { scheduled: true, backoffSeconds: 0 },
          });
          infra.grading.verdict = 'not-graded';
          edit(infra, { ...ctx, attempt });
          fs.mkdirSync(path.join(repDir, `attempt-${attempt}`), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(repDir, `attempt-${attempt}`, 'record.json'),
            JSON.stringify(seal(infra)),
          );
          attempt += 1;
        }
        const r = recordFor(t, {
          matrixId,
          taskId,
          modelKey,
          rep,
          attempt,
          kind,
        });
        setAttempt(r, s, i, rep);
        r.integrity.contested = s.contested || s.crashed;
        edit(r, { ...ctx, attempt });
        fs.mkdirSync(path.join(repDir, `attempt-${attempt}`), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(repDir, `attempt-${attempt}`, 'record.json'),
          JSON.stringify(seal(r)),
        );
        outcomes.push({
          taskId,
          model: modelKey,
          repetition: rep,
          status: r.outcome.valid ? 'done' : 'missing',
          attempts: attempt,
          contested: s.contested || s.crashed,
          code: r.outcome.code,
        });
      }
    }
  }
  fs.writeFileSync(
    path.join(dir, 'outcomes.json'),
    JSON.stringify({
      matrixId,
      recovered: [],
      outcomes,
      halted: { matrix: null, providers: {} },
      rateLimited: {},
    }),
  );
  return dir;
}

/** The fields a provider-backed record must carry (schema invariant G). */
const asProviderBacked = (r) => {
  r.cli.executeOnly = true;
  Object.assign(r.trustedTree, {
    mode: 'trusted',
    digest: '9'.repeat(64),
    pandamstyleDigest: 'a'.repeat(64),
    matchesProductTarballs: true,
    checkedBeforeGrading: true,
  });
};

const gateOf = (result, gate, modelKey = 'claude-haiku') =>
  result.gates.find((g) => g.gate === gate && g.modelKey === modelKey);

let baselineCache = null;
/** A clean all-success baseline over every development task. */
async function cleanBaseline() {
  if (baselineCache) return baselineCache;
  const dir = await buildMatrix('baseline');
  baselineCache = { dir, record: deriveGates(dir) };
  return baselineCache;
}

// ------------------------------------------------------------- derive

test('derive: task sets, binding and freeze status of a clean baseline', async () => {
  const { record: g } = await cleanBaseline();
  const m = g.models['claude-haiku'];
  assert.equal(m.taskSets.application.length, 25);
  assert.equal(m.taskSets.diagnosis.length, 12);
  assert.equal(m.taskSets.report.length, 7);
  assert.equal(m.taskSets.critical.length, 24);
  assert.equal(m.taskSets.all.length, 44);
  assert.equal(m.taskSets.missingCapability.length, 4);
  // Unsupported tasks are outside every task set, and listed.
  assert.deepEqual(
    m.unsupportedTasks.map((u) => u.taskId),
    INSTALL.map((t) => t.id),
  );
  for (const set of Object.values(m.taskSets))
    for (const t of INSTALL) assert.ok(!set.includes(t.id));
  assert.deepEqual(Object.keys(m.gates), Object.keys(GATES));
  for (const [gate, e] of Object.entries(m.gates)) {
    assert.equal(e.reference.status, 'sufficient', gate);
    assert.equal(e.blocking, true, gate);
    assert.deepEqual(e.droppedRepetitions, [], gate);
  }
  assert.equal(
    m.gates['context.input'].monteCarlo.seed,
    'pms-agentic-stats/v1:claude-haiku:context.input',
  );
  assert.equal(m.gates['context.input'].monteCarlo.draws, 9999);
  // POLICY.md section 5.3: 10 successes for 25 tasks on all-success data.
  assert.deepEqual(m.gates['success.application'].minimumDetectable, {
    successesDropped: 10,
  });
  assert.equal(m.gates['success.report'].minimumDetectable.successesDropped, 9);
  assert.ok(m.gates['context.input'].minimumDetectable.ratio > 1);
  assert.ok(
    m.gates['repair.cycles'].minimumDetectable.cyclesAddedPerRepetition >= 1,
  );
  assert.equal(Object.keys(m.latency.medians).length, 44);
  assert.ok(m.latency.cuts.p95 > m.latency.cuts.p50);
  const b = g.binding;
  assert.equal(b.method, 'pms-agentic-stats/v1');
  assert.equal(b.repetitions, 3);
  assert.equal(b.corpus.epoch, 'alpha1');
  assert.match(b.policySha256, /^[0-9a-f]{64}$/);
  assert.match(b.statsSha256, /^[0-9a-f]{64}$/);
  assert.match(g.inputs.matrixSha256, /^[0-9a-f]{64}$/);
  assert.equal(g.inputs.records.length, 132);
  assert.equal(b.cells.length, 44);
  assert.ok(b.cells.every((c) => /^[0-9a-f]{64}$/.test(c.comparabilityKey)));
  // Synthetic records are never a freezable baseline.
  assert.equal(g.synthetic, true);
  assert.equal(g.freeze.status, 'not-freezable');
  assert.deepEqual(g.freeze.insufficientGates, []);
  assert.deepEqual(g.freeze.missingRepetitions, []);
  assert.equal(g.freeze.reasons.length, 1);
});

test('derive is deterministic: byte-identical output, wherever the directory is', async () => {
  const { dir, record } = await cleanBaseline();
  const again = serialize(deriveGates(dir));
  assert.equal(again, serialize(record));
  const copy = path.join(tmpDir('gates-copy'), path.basename(dir));
  fs.cpSync(dir, copy, { recursive: true });
  assert.equal(serialize(deriveGates(copy)), again);
  assert.ok(!again.includes(dir), 'no absolute path in the record');
});

test('derive: a complete, clean provider-backed baseline is freezable', async () => {
  const dir = await buildMatrix('provider-baseline', {
    kind: 'provider-backed',
    edit: asProviderBacked,
  });
  const g = deriveGates(dir);
  assert.equal(g.synthetic, false);
  assert.deepEqual(g.freeze, {
    status: 'freezable',
    reasons: [],
    insufficientGates: [],
    recollectCells: [],
    missingRepetitions: [],
  });
  assert.equal(g.binding.referenceProduct.trustedTreeDigest, '9'.repeat(64));
  // One missing repetition is enough to block freezing (completeness).
  const holed = await buildMatrix('provider-baseline-holed', {
    kind: 'provider-backed',
    edit: asProviderBacked,
    spec: (t, _m, rep) =>
      t === APPLICATION[0] && rep === 3 ? { missing: true } : {},
  });
  const h = deriveGates(holed);
  assert.equal(h.freeze.status, 'not-freezable');
  assert.equal(h.freeze.insufficientGates.length, 0);
  assert.equal(h.freeze.missingRepetitions.length, 1);
});

test('derive lists every dropped reference repetition with its recorded value and reason', async () => {
  const [a, b, c, d, e] = APPLICATION;
  const dir = await buildMatrix('dropped', {
    spec: (t, _m, rep) => ({
      ...(t === a && rep === 1 ? { contested: true } : {}),
      ...(t === b && rep === 2 ? { missing: true } : {}),
      ...(t === c && rep === 3 ? { tokens: null } : {}),
      ...(t === d && rep === 1 ? { unclassified: true } : {}),
      ...(t === e && rep === 2 ? { crashed: true, success: false } : {}),
    }),
  });
  const g = deriveGates(dir);
  const app = g.models['claude-haiku'].gates['success.application'];
  assert.deepEqual(app.droppedRepetitions, [
    { taskId: a, repetition: 1, reasons: ['contested'], recordedValue: 0 },
    { taskId: b, repetition: 2, reasons: ['missing'], recordedValue: null },
    {
      taskId: d,
      repetition: 1,
      reasons: ['unclassified', 'unknown-value'],
      recordedValue: null,
    },
    { taskId: e, repetition: 2, reasons: ['contested'], recordedValue: 1 },
  ]);
  assert.equal(app.reference.dropped, 4);
  assert.equal(app.reference.status, 'sufficient');
  assert.equal(app.values[a].length, 2);
  const ctx = g.models['claude-haiku'].gates['context.input'];
  const unknown = ctx.droppedRepetitions.find((x) => x.taskId === c);
  assert.deepEqual(unknown, {
    taskId: c,
    repetition: 3,
    reasons: ['unknown-value'],
    recordedValue: null,
    recordedLowerBound: 777,
  });
  // Contested with a known value: the value is listed, not used.
  assert.equal(
    ctx.droppedRepetitions.find((x) => x.taskId === a).recordedValue,
    Math.log(
      baseTokens(
        TASKS.findIndex((t) => t.id === a),
        1,
      ),
    ),
  );
  // Completeness: the missing and the unclassified repetitions.
  assert.deepEqual(
    g.freeze.missingRepetitions.map((x) => [x.taskId, x.repetition]),
    [
      [b, 2],
      [d, 1],
    ].sort((x, y) => (x[0] < y[0] ? -1 : 1)),
  );
});

test('derive: insufficient-reference gates and the cells to re-collect', async () => {
  const [a] = APPLICATION;
  // Task a keeps 1 clean repetition; 8 more application tasks drop one
  // each: 10 of 75 dropped, over the cap of 7.
  const extra = APPLICATION.slice(1, 9);
  const dir = await buildMatrix('insufficient', {
    spec: (t, _m, rep) => ({
      ...(t === a && rep <= 2 ? { contested: true } : {}),
      ...(extra.includes(t) && rep === 3 ? { missing: true } : {}),
    }),
  });
  const g = deriveGates(dir);
  const app = g.models['claude-haiku'].gates['success.application'];
  assert.equal(app.reference.status, 'insufficient-reference');
  assert.deepEqual(app.reference.insufficientTasks, [a]);
  assert.equal(app.reference.dropped, 10);
  assert.equal(app.reference.maxDropped, 7);
  assert.deepEqual(
    app.minimumDetectable.insufficientReference.insufficientStrata,
    [0],
  );
  assert.ok(
    g.freeze.insufficientGates.some(
      (x) => x.gate === 'success.application' && x.modelKey === 'claude-haiku',
    ),
  );
  // a (insufficient), then enough cells to come within the cap: after a,
  // 8 dropped remain, so one more cell (the first by task id).
  const forApp = g.freeze.recollectCells
    .filter((c) => c.gates.includes('success.application'))
    .map((c) => c.taskId);
  assert.deepEqual(forApp, [a, extra[0]].sort());
  // The choice depends on uncleanliness only: other values, same cells.
  const dir2 = await buildMatrix('insufficient-values', {
    spec: (t, _m, rep) => ({
      ...(t === a && rep <= 2 ? { contested: true } : {}),
      ...(extra.includes(t) && rep === 3 ? { missing: true } : {}),
      success: rep !== 1,
      tokens: 5000 + rep,
    }),
  });
  assert.deepEqual(
    deriveGates(dir2).freeze.recollectCells,
    g.freeze.recollectCells,
  );
  assert.equal(g.freeze.status, 'not-freezable');
});

test('derive refuses mixed comparability keys and inconsistent records', async () => {
  const [a, b] = APPLICATION;
  // Two attempts of one cell under different CLI versions.
  const mixedCell = await buildMatrix('mixed-cell', {
    spec: (t, _m, rep) => (t === a && rep === 1 ? { contested: true } : {}),
    edit: (r, c) => {
      if (c.taskId === a && c.rep === 1 && c.attempt === 1)
        r.comparability.projection.model.cliVersion = '2.1.304';
    },
  });
  assert.throws(
    () => deriveGates(mixedCell),
    (e) => {
      assert.ok(e instanceof GatesRefusal);
      assert.match(e.message, /mixed comparability keys/);
      assert.match(e.message, /model\.cliVersion/);
      return true;
    },
  );
  // One task under another runner digest: the matrix's shared harness.
  const mixedHarness = await buildMatrix('mixed-harness', {
    edit: (r, c) => {
      if (c.taskId === b)
        r.comparability.projection.harness.runnerTreeDigest = '1'.repeat(64);
    },
  });
  assert.throws(() => deriveGates(mixedHarness), /mixed harness/);
  // A key that is not its projection's digest.
  const forged = await buildMatrix('forged-key');
  const forgedFile = path.join(
    forged,
    'cells',
    a,
    'claude-haiku',
    'rep-1',
    'attempt-1',
    'record.json',
  );
  const fr = JSON.parse(fs.readFileSync(forgedFile, 'utf8'));
  fr.comparability.key = '2'.repeat(64);
  fs.writeFileSync(forgedFile, JSON.stringify(fr));
  assert.throws(() => deriveGates(forged), /not its projection's digest/);
  // A record filed under another attempt (a duplicate) is refused.
  const misfiled = await buildMatrix('misfiled', { tasks: [a, b] });
  const repDir = path.join(misfiled, 'cells', a, 'claude-haiku', 'rep-1');
  fs.mkdirSync(path.join(repDir, 'attempt-2'));
  fs.copyFileSync(
    path.join(repDir, 'attempt-1', 'record.json'),
    path.join(repDir, 'attempt-2', 'record.json'),
  );
  assert.throws(() => deriveGates(misfiled), /misfiled records/);
  // A held-out task is never part of a baseline.
  const heldout = await buildMatrix('heldout', { tasks: [a, b] });
  const mf = path.join(heldout, 'matrix.json');
  const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
  mj.tasks.push(CORPUS.manifest.tasks[0].id);
  fs.writeFileSync(mf, JSON.stringify(mj));
  assert.throws(() => deriveGates(heldout), /held-out task/);
  // A success claimed without a pass.
  const lying = await buildMatrix('lying', {
    edit: (r, c) => {
      if (c.taskId === a && c.rep === 1) r.grading.verdict = 'fail';
    },
  });
  assert.throws(() => deriveGates(lying), /taskSuccess without a normal pass/);
});

test('derive: unmeasured baseline metric is insufficient-reference, never a pass', async () => {
  const dir = await buildMatrix('unmeasured-tokens', {
    spec: () => ({ tokens: null }),
  });
  const g = deriveGates(dir);
  const ctx = g.models['claude-haiku'].gates['context.input'];
  assert.equal(ctx.reference.status, 'insufficient-reference');
  assert.equal(ctx.unmeasuredByBaseline, true);
  const cand = await buildMatrix('unmeasured-candidate');
  const r = checkGates(g, cand);
  assert.equal(gateOf(r, 'context.input').outcome, 'insufficient-reference');
  assert.notEqual(r.verdict, 'pass');
});

// -------------------------------------------------------------- check

test('check: an unchanged candidate passes every baseline gate; latency needs the control', async () => {
  const { record: g } = await cleanBaseline();
  const cand = await buildMatrix('unchanged');
  const r = checkGates(g, cand);
  for (const gate of Object.keys(GATES)) {
    const x = gateOf(r, gate);
    if (gate.startsWith('latency.')) {
      assert.equal(x.outcome, 'insufficient-reference', gate);
      assert.match(x.reason, /no interleaved control/);
    } else assert.equal(x.outcome, 'pass', gate);
  }
  assert.equal(r.verdict, 'insufficient-reference');
  assert.equal(r.blockingOutcomes['insufficient-reference'], 2);
  const control = await buildMatrix('control-unchanged');
  const withControl = checkGates(g, cand, { controlDir: control });
  assert.equal(withControl.verdict, 'pass');
  for (const gate of ['latency.p50', 'latency.p95']) {
    const x = gateOf(withControl, gate);
    assert.equal(x.outcome, 'pass');
    assert.equal(x.reference.planned, 132);
    assert.equal(x.ratioCandidateOverControl.p50, 1);
  }
  // Deterministic output.
  assert.equal(
    serialize(checkGates(g, cand, { controlDir: control })),
    serialize(withControl),
  );
});

test('check: latency blocks a slower candidate against the control, and a control with too many unclean pairs is insufficient', async () => {
  const { record: g } = await cleanBaseline();
  const slow = await buildMatrix('slow', {
    spec: (_t, _m, rep, i) => ({ ms: 3 * baseMs(i, rep) }),
  });
  const control = await buildMatrix('control-for-slow');
  const r = checkGates(g, slow, { controlDir: control });
  assert.equal(gateOf(r, 'latency.p50').outcome, 'block');
  assert.equal(gateOf(r, 'latency.p95').outcome, 'block');
  assert.equal(r.verdict, 'block');
  // 14 unclean control pairs: over the cap of 13 of 132.
  const dirty = await buildMatrix('control-dirty', {
    spec: (_t, _m, rep, i) => (rep === 1 && i < 14 ? { ms: null } : {}),
  });
  const r2 = checkGates(g, slow, { controlDir: dirty });
  const p50 = gateOf(r2, 'latency.p50');
  assert.equal(p50.outcome, 'insufficient-reference');
  assert.equal(p50.reference.dropped, 14);
  // A slower control never makes a candidate fail: pairs are exchangeable.
  const slowControl = await buildMatrix('control-slow', {
    spec: (_t, _m, rep, i) => ({ ms: 3 * baseMs(i, rep) }),
  });
  assert.equal(
    gateOf(
      checkGates(g, await buildMatrix('unchanged-2'), {
        controlDir: slowControl,
      }),
      'latency.p50',
    ).outcome,
    'pass',
  );
});

test('check refuses a candidate or control outside the binding', async () => {
  const { record: g } = await cleanBaseline();
  const [a] = APPLICATION;
  const otherRunner = await buildMatrix('other-runner', {
    edit: (r) => {
      r.comparability.projection.harness.runnerTreeDigest = '3'.repeat(64);
    },
  });
  assert.throws(
    () => checkGates(g, otherRunner),
    (e) => {
      assert.ok(e instanceof GatesRefusal);
      assert.match(e.message, /harness\.runnerTreeDigest/);
      return true;
    },
  );
  const otherModel = await buildMatrix('other-model', {
    edit: (r, c) => {
      if (c.taskId === a) r.comparability.projection.model.cliVersion = '9';
    },
  });
  assert.throws(() => checkGates(g, otherModel), /mixed model/);
  const twoReps = await buildMatrix('two-reps', { repetitions: 2 });
  assert.throws(() => checkGates(g, twoReps), /2 repetitions, gate 3/);
  const provider = await buildMatrix('provider-kind', {
    kind: 'provider-backed',
    edit: asProviderBacked,
  });
  assert.throws(() => checkGates(g, provider), /kind provider-backed/);
  const cand = await buildMatrix('binding-cand');
  // The control must be the reference product, and not the candidate.
  const notAlpha = await buildMatrix('control-not-alpha', {
    edit: (r) => {
      r.trustedTree.digest = '4'.repeat(64);
    },
  });
  assert.throws(
    () => checkGates(g, cand, { controlDir: notAlpha }),
    /control is not the reference product/,
  );
  assert.throws(
    () => checkGates(g, cand, { controlDir: cand }),
    /control is the candidate/,
  );
  // A candidate product differs: that is the axis under comparison.
  const newProduct = await buildMatrix('new-product', {
    edit: (r) => {
      r.productBuild.digest = '5'.repeat(64);
      r.trustedTree.digest = '6'.repeat(64);
    },
  });
  assert.equal(checkGates(g, newProduct).gates.length, 9);
  // A gate record for another method implementation, or tampered.
  const other = structuredClone(g);
  other.binding.statsSha256 = '7'.repeat(64);
  assert.throws(() => checkGates(other, cand), /binding\.statsSha256/);
  const tampered = structuredClone(g);
  tampered.models['claude-haiku'].gates['success.report'].values[
    REPORT[0]
  ].pop();
  assert.throws(() => checkGates(tampered, cand), /2 reference repetitions/);
  const relabeled = structuredClone(g);
  relabeled.models['claude-haiku'].gates.safety.reference.status =
    'insufficient-reference';
  assert.throws(() => checkGates(relabeled, cand), /recomputed sufficient/);
});

test('check: overall verdict is the worst blocking outcome; non-blocking small sets never decide it', async () => {
  const { record: g } = await cleanBaseline();
  const control = await buildMatrix('verdict-control');
  // Every report task fails every repetition: success.report blocks.
  const reportFails = await buildMatrix('report-fails', {
    spec: (t) => ({ success: !REPORT.includes(t) }),
  });
  const r = checkGates(g, reportFails, { controlDir: control });
  assert.equal(gateOf(r, 'success.report').outcome, 'block');
  assert.equal(r.verdict, 'block');
  assert.equal(r.blockingOutcomes.block >= 1, true);
  // Critical report tasks from 3/3 to 0/3 are review items.
  assert.ok(r.reviewItems.length >= 1);
  // A small task set (the 3 non-critical report tasks) is reported, not
  // blocking: its block does not decide the verdict.
  const isCritical = (t) =>
    t.caseType === 'positive' ||
    t.tags.some((x) => x.startsWith('adversarial:'));
  const smallReportTasks = RUNNABLE.filter(
    (t) => familyOf(t) === 'report' && !isCritical(t),
  ).map((t) => t.id);
  assert.equal(smallReportTasks.length, 3);
  const few = [
    ...RUNNABLE.filter((t) => familyOf(t) !== 'report').map((t) => t.id),
    ...smallReportTasks,
  ];
  const smallBase = deriveGates(
    await buildMatrix('small-base', { tasks: few }),
  );
  const smallReport = smallBase.models['claude-haiku'].gates['success.report'];
  assert.equal(smallReport.blocking, false);
  assert.match(smallReport.blockingReason, /section 5\.5/);
  const smallCand = await buildMatrix('small-cand', {
    tasks: few,
    spec: (t) => ({ success: !smallReportTasks.includes(t) }),
  });
  const smallControl = await buildMatrix('small-control', { tasks: few });
  const rs = checkGates(smallBase, smallCand, { controlDir: smallControl });
  assert.equal(gateOf(rs, 'success.report').outcome, 'block');
  assert.equal(gateOf(rs, 'success.report').blocking, false);
  assert.ok(
    rs.gates.filter((x) => x.blocking).every((x) => x.outcome === 'pass'),
  );
  assert.equal(rs.verdict, 'pass');
  // No blocking gate at all is never a pass.
  const tiny = [APPLICATION[0], REPORT[0]];
  const tinyBase = deriveGates(await buildMatrix('tiny-base', { tasks: tiny }));
  const tinyR = checkGates(
    tinyBase,
    await buildMatrix('tiny-cand', { tasks: tiny }),
    {
      controlDir: await buildMatrix('tiny-control', { tasks: tiny }),
    },
  );
  assert.ok(tinyR.gates.every((x) => !x.blocking));
  assert.equal(tinyR.verdict, 'insufficient-reference');
  assert.equal(tinyR.verdictReason, 'no blocking gate');
  // An insufficient blocking gate keeps the verdict from passing.
  const [a] = APPLICATION;
  const insBase = deriveGates(
    await buildMatrix('ins-base', {
      spec: (t, _m, rep) => (t === a && rep <= 2 ? { missing: true } : {}),
    }),
  );
  const insR = checkGates(insBase, await buildMatrix('ins-cand'), {
    controlDir: control,
  });
  assert.equal(
    gateOf(insR, 'success.application').outcome,
    'insufficient-reference',
  );
  assert.equal(insR.verdict, 'insufficient-reference');
});

test('check: a candidate missing whole cells, models or tasks takes the worst case', async () => {
  const { record: g } = await cleanBaseline();
  const control = await buildMatrix('worst-control');
  // The candidate ran a single task: every other planned repetition is
  // missing and counts as a failure (and an unbounded value).
  const partial = await buildMatrix('partial', { tasks: [APPLICATION[0]] });
  const r = checkGates(g, partial, { controlDir: control });
  assert.equal(r.verdict, 'block');
  for (const gate of Object.keys(GATES))
    assert.equal(gateOf(r, gate).outcome, 'block', gate);
  // Another model only: the gate's model is entirely missing.
  const otherModel = await buildMatrix('only-sonnet', {
    models: ['claude-sonnet'],
  });
  const r2 = checkGates(g, otherModel, { controlDir: control });
  assert.equal(r2.verdict, 'block');
  assert.ok(r2.candidate.ignoredCells.length > 0);
});

/**
 * Monotonicity end to end (POLICY.md section 5.2): starting from a
 * candidate with real failures, each failing (or any) repetition turned
 * contested (retried into a success), missing, crashed, unclassified or
 * unknown never improves any gate or the verdict.
 */
test('monotone end to end: a candidate failure turned contested, missing, crashed or unknown never improves the verdict', async () => {
  const { record: g } = await cleanBaseline();
  const control = await buildMatrix('mono-control');
  // Failures on 6 application tasks (blocks) and slight slowdowns.
  const failing = new Set(APPLICATION.slice(0, 6));
  const baseSpec = (t, _m, rep, i) => ({
    success: !(failing.has(t) && rep <= 2),
    ms: baseMs(i, rep) * (i % 2 === 0 ? 1.3 : 1),
  });
  const before = checkGates(
    g,
    await buildMatrix('mono-before', { spec: baseSpec }),
    {
      controlDir: control,
    },
  );
  // A second, passing reference point: only one failing repetition.
  const mildSpec = (t, _m, rep) => ({
    success: !(t === APPLICATION[0] && rep === 1),
  });
  const mild = checkGates(
    g,
    await buildMatrix('mono-mild', { spec: mildSpec }),
    {
      controlDir: control,
    },
  );
  assert.equal(before.verdict, 'block');
  assert.equal(mild.verdict, 'pass');
  const degradations = {
    contested: { contested: true, success: true },
    missing: { missing: true },
    crashed: { crashed: true, success: true },
    unclassified: { unclassified: true },
    invalid: { invalid: true },
    unknown: { tokens: null, repairs: null, ms: null },
  };
  const assertNoBetter = (from, to, what) => {
    assert.ok(rank(to.verdict) >= rank(from.verdict), `${what}: verdict`);
    for (const x of from.gates) {
      const y = gateOf(to, x.gate, x.modelKey);
      assert.ok(rank(y.outcome) >= rank(x.outcome), `${what}: ${x.gate}`);
      if (x.pValue != null && y.pValue != null)
        assert.ok(y.pValue <= x.pValue + 1e-12, `${what}: ${x.gate} p`);
      assert.deepEqual(
        y.reference,
        x.reference,
        `${what}: ${x.gate} reference`,
      );
    }
  };
  for (const [what, d] of Object.entries(degradations)) {
    // Every failing repetition of the blocking candidate.
    const spec = (t, m, rep, i) => {
      const s = baseSpec(t, m, rep, i);
      return s.success ? s : { ...s, ...d };
    };
    const after = checkGates(g, await buildMatrix(`mono-${what}`, { spec }), {
      controlDir: control,
    });
    assertNoBetter(before, after, `failures ${what}`);
    assert.equal(after.verdict, 'block', `failures ${what}`);
    // Any repetitions of the passing candidate, failing one included.
    const spec2 = (t, m, rep, i) => {
      const s = mildSpec(t, m, rep, i);
      return (t === APPLICATION[0] && rep === 1) || (i % 9 === 0 && rep === 2)
        ? { ...s, ...d }
        : s;
    };
    const after2 = checkGates(
      g,
      await buildMatrix(`mono-mild-${what}`, {
        spec: spec2,
      }),
      { controlDir: control },
    );
    assertNoBetter(mild, after2, `mild ${what}`);
  }
});

// ---------------------------------------------------------------- CLI

test('CLI: derive writes once and never overwrites; check exit statuses', async () => {
  const { dir, record } = await cleanBaseline();
  const out = path.join(tmpDir('gates-cli'), 'gates.v1.json');
  const run = (...args) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  const d = run('derive', dir, '--out', out);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stderr, /not-freezable/);
  assert.equal(fs.readFileSync(out, 'utf8'), serialize(record));
  // Same content: idempotent. Different content: refused.
  assert.equal(run('derive', dir, '--out', out).status, 0);
  const other = await buildMatrix('cli-other', {
    spec: (t, _m, rep) => ({ success: !(t === APPLICATION[0] && rep === 1) }),
  });
  const refused = run('derive', other, '--out', out);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /never overwritten/);
  const cand = await buildMatrix('cli-cand');
  const control = await buildMatrix('cli-control');
  const pass = run('check', out, cand, '--control', control);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stderr, /gates check: pass/);
  const noControl = run('check', out, cand);
  assert.equal(noControl.status, 2);
  assert.match(noControl.stderr, /insufficient-reference/);
  const result = JSON.parse(noControl.stdout);
  assert.equal(result.schema, 'pms-agentic-gates-check/v1');
  const bad = await buildMatrix('cli-bad', {
    edit: (r) => {
      r.comparability.projection.harness.harnessDepsLockSha256 = '8'.repeat(64);
    },
  });
  const refusal = run('check', out, bad);
  assert.equal(refusal.status, 1);
  assert.match(refusal.stderr, /refused/);
  assert.equal(run('nope').status, 1);
});
