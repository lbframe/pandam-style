/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Matrix planning and execution (DESIGN.md sections 1.1, 5.2, 5.3 and Q8).
// Repetition indices are fixed when planned. Only infrastructure failures
// start a new attempt; every repetition that consumed such a retry is
// contested. A rate or usage limit is never retried: it halts its provider
// for the rest of the run. Refused tasks are recorded as `unsupported / not
// run`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus, findTask } from '../../src/corpus.mjs';
import { BOUNDS, runAttempt, writeRecord } from './attempt.mjs';
import { heldoutRefusal } from './capabilities.mjs';
import {
  buildProjection,
  comparabilityKey,
  normalizeArgv,
  normalizeEnv,
} from './comparability.mjs';
import {
  checkCredentialSource,
  credentialConfigErrors,
  credentialFromConfig,
} from './credentials.mjs';
import { corpusInfo } from './identity.mjs';
import { recoverStale } from './recovery.mjs';
import { RedactionSet, scanFile } from './redact.mjs';
import { activeRefusals } from './refusals.mjs';
import { removeOwned } from './safefs.mjs';
import {
  CORPUS_ROOT,
  digestJson,
  isInside,
  nowIso,
  readJson,
  sha256,
  writeFileAtomic,
} from './util.mjs';

export const MATRIX_SCHEMA = 'pms-agentic-matrix/v1';

export function validateMatrixConfig(config, { home } = {}) {
  const errors = [];
  const keys = (config.models ?? []).map((m) => m.key);
  for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i)))
    errors.push(`duplicate model key ${k}`);
  const tasks = config.tasks ?? [];
  for (const t of new Set(tasks.filter((t, i) => tasks.indexOf(t) !== i)))
    errors.push(`duplicate task ${t}`);
  if (config.schema !== MATRIX_SCHEMA)
    errors.push(`schema must be ${MATRIX_SCHEMA}`);
  if (!['provider-backed', 'adapter-fixture'].includes(config.kind))
    errors.push('kind');
  if (!(config.maxAttempts >= 1 && config.maxAttempts <= 3))
    errors.push('maxAttempts must be 1..3');
  if (!(config.repetitions >= 1)) errors.push('repetitions');
  if (config.kind === 'provider-backed') {
    if (config.adapterFixtures != null)
      errors.push('adapterFixtures only in adapter-fixture matrices');
    if (config.budgets?.timeoutSecondsOverride != null)
      errors.push('timeoutSecondsOverride only in adapter-fixture matrices');
    if (config.authorization !== 'orchestrator-go')
      errors.push(
        'provider-backed matrices need authorization "orchestrator-go"',
      );
    if (process.env.CI)
      errors.push('provider-backed runs are never started in CI');
  }
  if ((config.schedule?.concurrencyPerProvider ?? 1) !== 1)
    errors.push(
      'this runner executes attempts sequentially: concurrencyPerProvider must be 1',
    );
  for (const m of config.models ?? [])
    if (m.toolPolicy?.web !== false || m.toolPolicy?.subagents !== false)
      errors.push(`model ${m.key}: web and subagents must be disabled (Q4)`);
  // Section 4.6: every provider of the matrix names its credential source;
  // there is no default directory.
  for (const cli of new Set((config.models ?? []).map((m) => m.cli)))
    errors.push(
      ...credentialConfigErrors(cli, config.credentials?.[cli], {
        kind: config.kind,
        ...(home ? { home } : {}),
      }),
    );
  for (const t of config.tasks ?? []) {
    const refusal = heldoutRefusal({ taskId: t });
    if (refusal) errors.push(refusal);
  }
  return errors;
}

export function maxToolCallsFor(config, task) {
  const v = config.budgets?.maxToolCalls ?? 'corpus-maxTurns-hint';
  return v === 'corpus-maxTurns-hint' ? task.budget.maxTurns : Number(v);
}

export function cliMaxTurnsFor(config, maxToolCalls) {
  const v = config.budgets?.cliMaxTurns ?? '2x-maxToolCalls';
  if (v === 'none') return null;
  return v === '2x-maxToolCalls' ? 2 * maxToolCalls : Number(v);
}

function inWindow(date, windows) {
  if (!windows || windows.length === 0) return true;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return windows.some((w) => {
    const [a, b] = w.split('-').map((x) => {
      const [h, m] = x.split(':').map(Number);
      return h * 60 + m;
    });
    return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
  });
}

export function backoffSeconds({ attempt, rateLimit, retry }) {
  const base = retry?.baseSeconds ?? 60;
  const cap = retry?.capSeconds ?? 1800;
  if (rateLimit?.resetsAt != null) {
    const resets =
      rateLimit.resetsAt < 1e12
        ? rateLimit.resetsAt * 1000
        : rateLimit.resetsAt;
    const s = Math.ceil((resets - Date.now()) / 1000);
    if (s > 0) return Math.min(s, cap);
  }
  return Math.min(base * 2 ** (attempt - 1), cap);
}

/** Identity a resumed matrix must match exactly (section 1.5). */
/**
 * Identity of the selected external inputs, known before any attempt:
 * the fixture closure each planned task installs (as declared by its
 * installer: `installer.identity`) and the grading dependencies (mode and
 * trusted tree digests). An installer without a declared identity is
 * recorded as `undeclared` (its records can never be reused, see
 * repetitionState).
 */
export function inputIdentity({ config, grading, installFor, loaded = null }) {
  const closures = {};
  for (const taskId of config.tasks ?? []) {
    let installer = null;
    try {
      const task = loaded ? (findTask(loaded, taskId)?.task ?? null) : null;
      installer = installFor({ model: config.models?.[0], task, taskId });
    } catch {
      installer = undefined;
    }
    closures[taskId] =
      installer == null ? null : (installer.identity ?? 'undeclared');
  }
  return {
    closures,
    grading: {
      mode: grading?.mode ?? null,
      hostCommands: grading?.hostCommands === true,
      trusted:
        grading?.mode === 'trusted'
          ? {
              digest: grading.trustedExpected?.digest ?? null,
              pandamstyleDigest:
                grading.trustedExpected?.pandamstyleDigest ?? null,
            }
          : null,
    },
  };
}

export function matrixIdentity(config, identity, inputs = null) {
  return {
    inputs,
    configDigest: digestJson(config),
    kind: config.kind,
    harness: {
      runnerTreeDigest: identity.harness.runnerTreeDigest,
      harnessDepsLockSha256: identity.harness.harnessDepsLockSha256,
      corpusLockSha256: identity.harness.corpusLockSha256,
    },
    productBuild: identity.productBuild?.digest ?? null,
    dependencies: identity.dependencies ?? null,
  };
}

function attemptIndex(name) {
  const m = /^attempt-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * State of one planned repetition from its attempt directories (resume).
 * Records of another matrix, cell, model or kind refuse the resume; an
 * attempt directory without a record (a crash) counts as a used, contested
 * attempt; a cancelled attempt does not count.
 */
export function repetitionState({
  cellDir,
  matrixId,
  taskId,
  model,
  kind,
  expectedInstall = null,
}) {
  const dirs = fs.existsSync(cellDir)
    ? fs
        .readdirSync(cellDir)
        .map((d) => [d, attemptIndex(d)])
        .filter(([, i]) => i != null)
        .sort((x, y) => x[1] - y[1])
    : [];
  const records = [];
  let crashed = 0;
  for (const [d] of dirs) {
    const f = path.join(cellDir, d, 'record.json');
    if (!fs.existsSync(f)) {
      crashed += 1;
      continue;
    }
    const r = readJson(f);
    const mismatch = [];
    if (r.matrixId !== matrixId) mismatch.push('matrixId');
    if (r.kind !== kind) mismatch.push('kind');
    if (r.cell?.taskId !== taskId || r.cell?.modelKey !== model.key)
      mismatch.push('cell');
    if (r.modelConfig?.requestedModel !== model.model) mismatch.push('model');
    if (r.cli?.name !== model.cli) mismatch.push('cli');
    // The closure the record was installed from must be the one selected now,
    // provably: an undeclared installer cannot vouch for reuse.
    if (r.install != null || expectedInstall != null) {
      const declared =
        expectedInstall === 'undeclared' ? null : expectedInstall;
      if (
        declared == null ||
        r.install == null ||
        r.install.closureLockSha256 !== declared.closureLockSha256 ||
        r.install.nonProductLockSha256 !== declared.nonProductLockSha256
      )
        mismatch.push('fixture closure');
    }
    if (mismatch.length > 0)
      throw Object.assign(
        new Error(`resume refused: ${f} differs (${mismatch.join(', ')})`),
        { code: 'resume' },
      );
    records.push(r);
  }
  const last = records.at(-1) ?? null;
  return {
    nextIndex: (dirs.at(-1)?.[1] ?? 0) + 1,
    used:
      dirs.length -
      records.filter((r) => r.outcome.code === 'cancelled').length,
    done: records.some((r) => r.outcome.valid),
    contested:
      crashed > 0 || records.some((r) => r.outcome.class === 'infrastructure'),
    finalInvalid:
      last != null &&
      crashed === 0 &&
      !last.outcome.valid &&
      last.outcome.code !== 'cancelled' &&
      last.classificationDetail?.retry !== true
        ? last
        : null,
    records,
  };
}

/**
 * Runs a matrix. `executorFor({ model, task, repetition, attempt })` returns
 * the executor (and, for adapter fixtures, the scenario).
 */
export async function runMatrix({
  config,
  runsRoot,
  identity,
  grading,
  executorFor,
  effectiveConfigFor = () => null,
  credentialFor = null,
  stateDir = null,
  installFor = () => null,
  home = undefined,
  bounds = {},
  sweepLabels = false,
  signal = null,
  clock = {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  matrixId = `m-${new Date().toISOString().replace(/[:.]/g, '-')}`,
}) {
  const errors = validateMatrixConfig(config, { home });
  if (errors.length > 0)
    throw new Error(`invalid matrix: ${errors.join('; ')}`);
  if (config.kind === 'provider-backed') {
    if (!identity.harness.clean)
      throw new Error('provider-backed matrices refuse a dirty checkout');
    if (isInside(path.resolve(CORPUS_ROOT, '../..'), runsRoot))
      throw new Error(
        'provider-backed run roots must be outside the repository',
      );
  }
  stateDir ??= path.join(os.homedir(), '.local/state/pandamstyle-agentic');
  // Crash recovery runs before anything else (section 4.6).
  const recovered = recoverStale(runsRoot, { stateDir, sweepLabels });
  // Credential sources: policy, then names and modes, before anything runs.
  const credentials = new Map();
  for (const cli of new Set(config.models.map((m) => m.cli))) {
    const c = credentialFromConfig(config, cli, { stateDir, home });
    if (c != null) checkCredentialSource(c, { home });
    credentials.set(cli, c);
  }
  credentialFor ??= (model) => credentials.get(model.cli);
  const loaded = loadCorpus(CORPUS_ROOT);
  const info = corpusInfo(loaded, config.epoch);
  const matrixDir = path.join(runsRoot, matrixId);
  fs.mkdirSync(matrixDir, { recursive: true });
  const matrixRedaction = new RedactionSet();
  const writeRedacted = (file, value) => {
    writeFileAtomic(
      file,
      matrixRedaction.redactText(`${JSON.stringify(value, null, 2)}\n`),
    );
    if (scanFile(file, matrixRedaction)) {
      fs.rmSync(file, { force: true });
      throw Object.assign(
        new Error(`${path.basename(file)} still contained a secret`),
        { code: 'redaction' },
      );
    }
  };
  // Resume (section 1.5): only with the exact same configuration, harness,
  // product build and dependencies; never by overwriting matrix.json.
  const inputs = inputIdentity({ config, grading, installFor, loaded });
  const ident = matrixIdentity(config, identity, inputs);
  const identityDigest = digestJson(ident);
  const matrixFile = path.join(matrixDir, 'matrix.json');
  if (fs.existsSync(matrixFile)) {
    const stored = readJson(matrixFile);
    if (stored.identityDigest !== identityDigest) {
      const differs = Object.keys(ident).filter(
        (k) =>
          digestJson(stored.identity?.[k] ?? null) !== digestJson(ident[k]),
      );
      throw Object.assign(
        new Error(
          `resume refused: matrix ${matrixId} was started with a different ${differs.join(', ') || 'identity'}`,
        ),
        { code: 'resume' },
      );
    }
  } else
    writeRedacted(matrixFile, {
      ...config,
      matrixId,
      identity: ident,
      identityDigest,
      credentialSources: Object.fromEntries(
        [...credentials].map(([cli, c]) => [cli, c?.source ?? null]),
      ),
      startedAt: nowIso(),
    });
  for (const d of ['.private', '.work']) privateDirOf(path.join(matrixDir, d));

  const startedMs = clock.now().getTime();
  const halted = { matrix: null, providers: new Map() };
  for (const [provider, r] of Object.entries(activeRefusals(stateDir))) {
    const reason = `durable refusal: ${r.events.at(-1)?.reason ?? 'unresolved'} (resolve-refusal ${provider})`;
    if (provider === 'docker' && config.kind === 'provider-backed')
      halted.matrix = reason;
    else halted.providers.set(provider, reason);
  }
  const fidelityFailures = new Map();
  const outcomes = [];
  const rateLimited = {};

  // Resume check of every planned repetition before anything runs: a
  // record that cannot be reused refuses the matrix before any mutation.
  for (const taskId of config.tasks)
    for (const model of config.models)
      for (let r = 1; r <= config.repetitions; r += 1)
        repetitionState({
          cellDir: path.join(matrixDir, 'cells', taskId, model.key, `rep-${r}`),
          matrixId,
          taskId,
          model,
          kind: config.kind,
          expectedInstall: inputs.closures[taskId] ?? null,
        });

  for (const taskId of config.tasks) {
    const entry = findTask(loaded, taskId);
    if (entry == null || entry.task.split !== 'development') {
      for (const model of config.models)
        outcomes.push({
          taskId,
          model: model.key,
          status: 'unsupported',
          repetitions: config.repetitions,
          reasons: [`unknown development task ${taskId}`],
        });
      continue;
    }
    const fixture = loaded.fixtures.get(entry.task.workspace.fixture);
    for (const model of config.models) {
      let cellRefused = false;
      for (let r = 1; r <= config.repetitions && !cellRefused; r += 1) {
        const cellDir = path.join(
          matrixDir,
          'cells',
          taskId,
          model.key,
          `rep-${r}`,
        );
        const prior = repetitionState({
          cellDir,
          matrixId,
          taskId,
          model,
          kind: config.kind,
          expectedInstall: inputs.closures[taskId] ?? null,
        });
        if (prior.done) {
          outcomes.push({
            taskId,
            model: model.key,
            repetition: r,
            status: 'resumed',
            attempts: prior.records.length,
          });
          continue;
        }
        if (prior.finalInvalid) {
          outcomes.push({
            taskId,
            model: model.key,
            repetition: r,
            status: 'missing',
            attempts: prior.used,
            contested: prior.contested,
            code: prior.finalInvalid.outcome.code,
            reason: `invalid: ${prior.finalInvalid.outcome.class} ${prior.finalInvalid.outcome.code}`,
          });
          continue;
        }
        let attempt = prior.nextIndex;
        let used = prior.used;
        let contested = prior.contested;
        let done = false;
        while (!done) {
          if (signal?.aborted) {
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: 'cancelled',
            });
            break;
          }
          if (halted.matrix != null || halted.providers.has(model.cli)) {
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason:
                halted.matrix ??
                `provider ${model.cli} halted: ${halted.providers.get(model.cli)}`,
            });
            break;
          }
          const cap = config.schedule?.wallClockCapSeconds;
          if (cap != null && (clock.now().getTime() - startedMs) / 1000 > cap) {
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: 'matrix wall-clock cap',
            });
            break;
          }
          while (!inWindow(clock.now(), config.schedule?.timeWindows))
            await clock.sleep(60 * 1000);
          if (used >= config.maxAttempts) {
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: 'attempts exhausted',
              contested,
            });
            break;
          }
          const attemptDir = path.join(cellDir, `attempt-${attempt}`);
          const ex = executorFor({ model, taskId, repetition: r, attempt });
          const maxToolCalls = maxToolCallsFor(config, entry.task);
          const budgets = {
            timeoutSeconds:
              config.budgets?.timeoutSecondsOverride ??
              entry.task.budget.timeoutSeconds,
            maxToolCalls,
            cliMaxTurns:
              model.cli === 'claude'
                ? cliMaxTurnsFor(config, maxToolCalls)
                : null,
            graceInterruptMs: config.budgets?.graceInterruptMs ?? 15000,
            graceTerminateMs: config.budgets?.graceTerminateMs ?? 15000,
            workspaceBytesCap:
              config.container?.workspaceBytesCap ?? BOUNDS.workspace,
            bounds: { ...BOUNDS, ...bounds },
          };
          const label = `${taskId}--${model.key}--${r}--${attempt}`;
          let out;
          try {
            out = await runAttempt({
              kind: config.kind,
              matrixId,
              cell: { taskId, modelKey: model.key },
              repetition: r,
              attempt,
              modelConfig: model,
              taskEntry: entry,
              fixture,
              corpusInfo: info,
              executor: ex,
              paths: {
                attemptDir,
                privateDir: path.join(matrixDir, '.private', label),
                workRoot: path.join(matrixDir, '.work', label),
              },
              budgets,
              stateDir,
              credential: credentialFor(model),
              identity,
              loadSampler: identity.startLoadSampler?.() ?? null,
              grading,
              effectiveConfigEvidence: effectiveConfigFor(model),
              install: installFor({ model, task: entry.task, taskId }),
              signal,
              contested,
              matrixRedaction,
              projectionFor: (p) =>
                projectionFor({ ...p, config, identity, info, budgets }),
            });
          } catch (error) {
            // A harness failure outside the classified paths (a credential
            // source that vanished, a trusted-tree refusal, a failed install,
            // a container error) is systematic: the matrix halts.
            halted.matrix = `matrix halted: harness ${error.code ?? 'error'}: ${String(error.message).slice(0, 300)}`;
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: halted.matrix,
            });
            break;
          }
          if (out.haltProvider) {
            halted.providers.set(model.cli, out.haltProvider);
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: out.haltProvider,
              ...(out.failure ?? {}),
            });
            break;
          }
          if (out.refused) {
            // Listed once per cell, never failed or dropped (section 5.2).
            outcomes.push({
              taskId,
              model: model.key,
              status: 'unsupported',
              repetitions: config.repetitions,
              reasons: out.refused,
            });
            cellRefused = true;
            break;
          }
          const rec = out.record;
          const detail = rec.classificationDetail;
          if (rec.outcome.code !== 'cancelled') used += 1;
          if (rec.outcome.code === 'model-fidelity') {
            const n = (fidelityFailures.get(model.cli) ?? 0) + 1;
            fidelityFailures.set(model.cli, n);
            if (n >= 3) halted.providers.set(model.cli, 'model-fidelity x3');
          }
          if (detail.haltProvider)
            halted.providers.set(
              model.cli,
              rec.outcome.code === 'completed'
                ? `credential ${rec.credential.export}`
                : rec.outcome.code,
            );
          if (detail.haltMatrix)
            halted.matrix = `matrix halted: ${rec.outcome.code}`;
          if (rec.outcome.code === 'cancelled') {
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              reason: 'cancelled',
              attempts: used,
            });
            break;
          }
          // Section 5.2: a provider rate or usage limit is not retried. It
          // halts that CLI (one account for all its models) for the rest of
          // this run; the record stays, so a resume re-runs this repetition
          // (contested) and every cell the halt left missing.
          if (
            rec.outcome.class === 'infrastructure' &&
            rec.outcome.code === 'rate-limit'
          ) {
            const resetsAt = rateLimitResetIso(rec.provider.rateLimit);
            const reason = `rate-limit (${resetsAt ? `resets at ${resetsAt}` : 'no reset time reported'})`;
            halted.providers.set(model.cli, reason);
            rateLimited[model.cli] = {
              resetsAt,
              taskId,
              model: model.key,
              repetition: r,
              attempt,
            };
            rec.outcome.retry = {
              scheduled: false,
              backoffSeconds: null,
              haltedProvider: 'rate-limit',
            };
            writeRecord(attemptDir, rec, matrixRedaction);
            outcomes.push({
              taskId,
              model: model.key,
              repetition: r,
              status: 'missing',
              attempts: used,
              contested: true,
              code: rec.outcome.code,
              reason: `provider ${model.cli} halted: ${reason}`,
            });
            break;
          }
          if (detail.retry && used < config.maxAttempts) {
            const wait = backoffSeconds({
              attempt: used,
              rateLimit: rec.provider.rateLimit,
              retry: config.retry,
            });
            rec.outcome.retry = { scheduled: true, backoffSeconds: wait };
            writeRecord(attemptDir, rec, matrixRedaction);
            contested = true;
            attempt += 1;
            if (wait > 0) await clock.sleep(wait * 1000);
            continue;
          }
          outcomes.push({
            taskId,
            model: model.key,
            repetition: r,
            status: rec.outcome.valid ? 'done' : 'missing',
            attempts: used,
            contested,
            code: rec.outcome.code,
            ...(rec.outcome.valid
              ? {}
              : {
                  reason: detail.retry
                    ? 'attempts exhausted'
                    : `invalid: ${rec.outcome.class} ${rec.outcome.code}`,
                }),
          });
          done = true;
        }
      }
    }
  }
  // Retained recovery state (unverified cleanup) survives the matrix: it is
  // recovered at the next start; only empty roots are removed.
  removeIfEmpty(path.join(matrixDir, '.private'));
  removeOwned(path.join(matrixDir, '.work'));
  writeRedacted(path.join(matrixDir, 'outcomes.json'), {
    matrixId,
    finishedAt: nowIso(),
    recovered,
    outcomes,
    halted: {
      matrix: halted.matrix,
      providers: Object.fromEntries(halted.providers),
    },
    rateLimited,
  });
  // Returned (and printed by the CLI) through the same redaction.
  return {
    matrixId,
    matrixDir,
    outcomes: JSON.parse(matrixRedaction.redactText(JSON.stringify(outcomes))),
    rateLimited,
  };
}

/** Reset time of a provider rate limit as ISO 8601, or null when unreported. */
export function rateLimitResetIso(rateLimit) {
  const v = rateLimit?.resetsAt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return new Date(v < 1e12 ? v * 1000 : v).toISOString();
}

function removeIfEmpty(dir) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function privateDirOf(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Comparability projection of an attempt (section 1.4). */
export function projectionFor({
  task,
  plan,
  invocation,
  prompt,
  modelConfig,
  install = null,
  config,
  identity,
  info,
  budgets,
  transients = [],
}) {
  const argv = invocation.argv.map((a) => (a === prompt ? '<prompt>' : a));
  const projection = buildProjection({
    task: {
      id: task.name,
      taskDigest: info.taskDigests[task.name] ?? null,
      epoch: info.epoch,
      corpusVersion: info.corpusVersion,
      corpusLockSha256: info.corpusLockSha256,
    },
    harness: {
      runnerTreeDigest: identity.harness.runnerTreeDigest,
      harnessDepsLockSha256: identity.harness.harnessDepsLockSha256,
    },
    prompt: { sha256: sha256(prompt) },
    model: {
      cli: modelConfig.cli,
      cliVersion: modelConfig.cliVersion,
      cliSha256: modelConfig.cliSha256,
      requestedModel: modelConfig.model,
      reasoningEffort: modelConfig.reasoningEffort ?? null,
      normalizedArgv: normalizeArgv(argv, transients),
      nonSecretEnv: normalizeEnv(invocation.env, transients),
      cliConfigSha256: identity.cliConfigSha256?.[modelConfig.cli] ?? null,
    },
    policy: {
      effectiveToolPolicy: modelConfig.toolPolicy,
      capabilityEnforcementMatrixSha256: plan.matrixSha256,
      egressAllowlistSha256: digestJson(config.network?.allow ?? null),
      proxyImageId: config.images?.proxy ?? null,
      networkMode: config.network?.mode ?? null,
    },
    budgets: {
      timeoutSeconds: budgets.timeoutSeconds,
      maxToolCalls: budgets.maxToolCalls,
      cliMaxTurns: budgets.cliMaxTurns,
    },
    containers: {
      agentImageId: config.images?.agent ?? null,
      graderImageId: config.images?.grader ?? null,
      cpus: config.container?.cpus ?? null,
      memoryBytes: config.container?.memoryBytes ?? null,
      pidsLimit: config.container?.pidsLimit ?? null,
      tmpfsBytes: config.container?.tmpfsBytes ?? null,
      workspaceBytesCap: config.container?.workspaceBytesCap ?? null,
    },
    // The closure this cell's workspace was installed from (section 1.4),
    // never the trusted grading closure.
    dependencies: {
      nodeSha256: identity.dependencies?.nodeSha256 ?? null,
      packageManager: identity.dependencies?.packageManager ?? null,
      fixtureClosureNonProductLockSha256: install?.nonProductLockSha256 ?? null,
    },
  });
  return {
    key: comparabilityKey(projection),
    projectionVersion: projection.version,
    projection,
  };
}
