/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Matrix planning and execution (DESIGN.md sections 1.1, 5.2, 5.3 and Q8).
// Repetition indices are fixed when planned. Only infrastructure failures
// start a new attempt; every repetition that consumed such a retry is
// contested. Refused tasks are recorded as `unsupported / not run`.

import fs from 'node:fs';
import path from 'node:path';
import { loadCorpus, findTask } from '../../src/corpus.mjs';
import { runAttempt } from './attempt.mjs';
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
import {
  CORPUS_ROOT,
  digestJson,
  isInside,
  nowIso,
  readJson,
  sha256,
  writeJson,
} from './util.mjs';

export const MATRIX_SCHEMA = 'pms-agentic-matrix/v1';

export function validateMatrixConfig(config) {
  const errors = [];
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
  signal = null,
  clock = {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  matrixId = `m-${new Date().toISOString().replace(/[:.]/g, '-')}`,
}) {
  const errors = validateMatrixConfig(config);
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
  // Credential sources are resolved and checked (names and modes only)
  // before anything runs; a missing source refuses the matrix.
  const credentials = new Map();
  for (const cli of new Set(config.models.map((m) => m.cli))) {
    const c = credentialFromConfig(config, cli, {
      stateDir: stateDir ?? undefined,
    });
    if (c != null) checkCredentialSource(c);
    credentials.set(cli, c);
  }
  credentialFor ??= (model) => credentials.get(model.cli);
  const loaded = loadCorpus(CORPUS_ROOT);
  const info = corpusInfo(loaded, config.epoch);
  const matrixDir = path.join(runsRoot, matrixId);
  fs.mkdirSync(matrixDir, { recursive: true });
  writeJson(path.join(matrixDir, 'matrix.json'), {
    ...config,
    matrixId,
    configDigest: digestJson(config),
    credentialSources: Object.fromEntries(
      [...credentials].map(([cli, c]) => [cli, c?.source ?? null]),
    ),
    startedAt: nowIso(),
  });

  const startedMs = clock.now().getTime();
  const halted = { matrix: null, providers: new Map() };
  const fidelityFailures = new Map();
  const outcomes = [];

  for (const taskId of config.tasks) {
    const entry = findTask(loaded, taskId);
    if (entry == null || entry.task.split !== 'development') {
      outcomes.push({
        taskId,
        status: 'unsupported',
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
        const prior = fs.existsSync(cellDir)
          ? fs
              .readdirSync(cellDir)
              .filter((d) => d.startsWith('attempt-'))
              .sort()
          : [];
        const priorRecords = prior
          .map((d) => path.join(cellDir, d, 'record.json'))
          .filter((f) => fs.existsSync(f))
          .map(readJson);
        if (priorRecords.some((x) => x.outcome.valid)) {
          outcomes.push({
            taskId,
            model: model.key,
            repetition: r,
            status: 'resumed',
            attempts: priorRecords.length,
          });
          continue;
        }
        let attempt = priorRecords.length + 1;
        let contested = priorRecords.some(
          (x) => x.outcome.class === 'infrastructure',
        );
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
          if (attempt > config.maxAttempts) {
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
          };
          const loadSampler = identity.startLoadSampler?.();
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
                privateDir: path.join(
                  matrixDir,
                  '.private',
                  `${taskId}--${model.key}--${r}--${attempt}`,
                ),
                workRoot: path.join(
                  matrixDir,
                  '.work',
                  `${taskId}--${model.key}--${r}--${attempt}`,
                ),
              },
              budgets,
              credential: credentialFor(model),
              identity: {
                ...identity,
                environment: {
                  ...identity.environment,
                  load: loadSampler?.stop() ?? {
                    samples: 0,
                    min: null,
                    max: null,
                    median: null,
                  },
                },
              },
              grading,
              effectiveConfigEvidence: effectiveConfigFor(model),
              install: installFor({ model, task: entry.task }),
              signal,
              contested,
              projectionFor: (p) =>
                projectionFor({
                  ...p,
                  config,
                  identity,
                  info,
                  budgets,
                  workRoot: path.join(matrixDir, '.work'),
                }),
            });
          } catch (error) {
            // A harness failure outside the classified paths (a credential
            // source that vanished, a trusted-tree refusal, a container
            // error) is systematic: the matrix halts, nothing is retried.
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
          if (rec.outcome.code === 'model-fidelity') {
            const n = (fidelityFailures.get(model.cli) ?? 0) + 1;
            fidelityFailures.set(model.cli, n);
            if (n >= 3) halted.providers.set(model.cli, 'model-fidelity x3');
          }
          if (detail.haltProvider)
            halted.providers.set(model.cli, rec.outcome.code);
          if (detail.haltMatrix)
            halted.matrix = `matrix halted: ${rec.outcome.code}`;
          if (detail.retry && attempt < config.maxAttempts) {
            const wait = backoffSeconds({
              attempt,
              rateLimit: rec.provider.rateLimit,
              retry: config.retry,
            });
            rec.outcome.retry = { scheduled: true, backoffSeconds: wait };
            writeJson(path.join(attemptDir, 'record.json'), rec);
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
            attempts: attempt,
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
  fs.rmSync(path.join(matrixDir, '.private'), { recursive: true, force: true });
  writeJson(path.join(matrixDir, 'outcomes.json'), {
    matrixId,
    finishedAt: nowIso(),
    outcomes,
    halted: {
      matrix: halted.matrix,
      providers: Object.fromEntries(halted.providers),
    },
  });
  return { matrixId, matrixDir, outcomes };
}

/** Comparability projection of an attempt (section 1.4). */
export function projectionFor({
  task,
  plan,
  invocation,
  prompt,
  modelConfig,
  config,
  identity,
  info,
  budgets,
  workRoot,
}) {
  const transients = [workRoot];
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
    dependencies: identity.dependencies ?? {
      nodeSha256: null,
      packageManager: null,
      fixtureClosureNonProductLockSha256: null,
    },
  });
  return {
    key: comparabilityKey(projection),
    projectionVersion: projection.version,
    projection,
  };
}
