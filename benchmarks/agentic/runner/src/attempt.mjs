/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One attempt of one repetition of one task x model cell (DESIGN.md section
// 4.7). The executor decides where the CLI runs: the local fixture executor
// (adapter fixtures, no isolation) or the Docker executor (isolated roles).
// Nothing here makes a provider call; the CLI the executor starts does.
//
// Privacy and confinement (sections 4.6, 6 and 11.2): working copies live in
// runner-private directories (0700) that are removed on every exit path;
// the agent's workspace is only touched through workspace.mjs (confined,
// bounded); grading and archives read a private staging copy; every
// persisted artifact, including the record, is redacted and then scanned.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compileGlobs } from '../../src/glob.mjs';
import { copyTree } from '../../src/fs-tree.mjs';
import {
  buildPrompt,
  materializeFiles,
  prepareWorkspace,
} from '../../src/materialize.mjs';
import * as claude from './adapters/claude.mjs';
import * as codex from './adapters/codex.mjs';
import {
  detectBreaches,
  enforcementPlan,
  heldoutRefusal,
} from './capabilities.mjs';
import { classify } from './classify.mjs';
import { analyzeTimeline } from './commands.mjs';
import {
  PROVIDERS,
  checkSourcePolicy,
  decideWriteBack,
  deriveAccessOnly,
  readCredentialFile,
  recoveryState,
} from './credentials.mjs';
import { archiveTree, replayExactness } from './evidence.mjs';
import {
  STREAM_METHOD,
  estimate,
  fromStream,
  harnessObserved,
  unknown,
} from './measured.mjs';
import { RedactionSet, scanAndPurge } from './redact.mjs';
import { recordRefusal } from './refusals.mjs';
import { removeOwned } from './safefs.mjs';
import { createBoundedSink, createLineSplitter, parseLine } from './stream.mjs';
import {
  assertNoAncestorNodeModules,
  checkTrustedTree,
} from './trusted-tree.mjs';
import {
  CORPUS_ROOT,
  fileSha256,
  monotonicMs,
  nowIso,
  sha256,
  writeFileAtomic,
} from './util.mjs';
import {
  applyEventSafe,
  nodeModulesState,
  pathLeaks,
  sampleWorkspace,
  stageWorkspace,
  treeLeaks,
} from './workspace.mjs';

export const ADAPTERS = { claude, codex };
export const DOCS_MOUNT = '/opt/pandamstyle-agent-docs';
export const RECORD_SCHEMA = 'pms-agentic-run-record/v1';
export const BOUNDS = {
  // Raw stream storage: head and tail kept, line-aligned (section 6.4).
  stream: 64 * 1024 * 1024,
  stderr: 1024 * 1024,
  // Grader inputs derived from the stream (transcript, final message).
  graderInput: 64 * 1024 * 1024,
  // Oracle-relevant set staged for grading and archives (section 6.2).
  evidence: 64 * 1024 * 1024,
  // Whole workspace, dependencies included (section 4.10).
  workspace: 4 * 1024 * 1024 * 1024,
};

function bounded(text, bound) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= bound) return { text, truncated: false, originalBytes: bytes };
  // Line-aligned head and tail, so no partial line (or secret) is stored.
  const buf = Buffer.from(text);
  const half = Math.floor(bound / 2);
  const headCut = buf.subarray(0, half).lastIndexOf(0x0a);
  const head = headCut === -1 ? Buffer.alloc(0) : buf.subarray(0, headCut + 1);
  const tailRaw = buf.subarray(buf.length - half);
  const tailCut = tailRaw.indexOf(0x0a);
  const tail = tailCut === -1 ? Buffer.alloc(0) : tailRaw.subarray(tailCut + 1);
  return {
    text: `${head.toString()}[pms-runner: ${bytes - head.length - tail.length} bytes not stored]\n${tail.toString()}`,
    truncated: true,
    originalBytes: bytes,
  };
}

/** Staged entries the staging copy does not contain (section 6.1). */
function unreproduced(staged) {
  return staged.entries.filter(
    (e) => e.type === 'special' || (e.type === 'file' && e.staged === false),
  );
}

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Runs the agent phase and returns the raw material of the record. */
async function agentPhase(ctx) {
  const { executor, cli, adapterInput, ws, baseline, taskEntry, budgets } = ctx;
  const adapter = ADAPTERS[cli];
  const harnessIgnored = taskEntry.task.permissions.harnessIgnored ?? [];
  const toolTimes = new Map();
  const deltas = [];
  const eventStatus = {};
  const eventErrors = {};
  const events = taskEntry.task.workspace.events ?? [];
  for (const e of events) eventStatus[`event:${e.id}`] = 'not-triggered';
  let toolResults = 0;
  let toolCallCount = 0;
  let maxToolCallsHit = false;
  let workspaceOverCap = false;
  let peakWorkspaceBytes = null;

  // Events are applied beneath the workspace root without following links
  // (section 4.2); a refused target leaves the event not applied.
  const applyTriggered = (e) => {
    if (eventStatus[`event:${e.id}`] !== 'not-triggered') return;
    let r;
    try {
      r = applyEventSafe({ taskEntry, eventId: e.id, root: ws });
    } catch (error) {
      r = { applied: false, reason: error.code ?? 'error' };
      eventErrors[e.id] = r.reason;
    }
    if (r.applied) applyEventSafe({ taskEntry, eventId: e.id, root: baseline });
    eventStatus[`event:${e.id}`] = r.applied ? 'applied' : 'not-applied';
  };

  const parser = adapter.createParser({
    requestedModel: adapterInput.model,
    hooks: {
      onToolCall(call) {
        toolCallCount += 1;
        toolTimes.set(call, { start: monotonicMs(), end: null });
        if (toolCallCount > budgets.maxToolCalls && !maxToolCallsHit) {
          maxToolCallsHit = true;
          ctx.stop('max-tool-calls');
        }
      },
      onToolResult(call) {
        toolResults += 1;
        const t = toolTimes.get(call);
        if (t) t.end = monotonicMs();
        const sample = sampleWorkspace(ws, {
          harnessIgnored,
          capBytes: budgets.workspaceBytesCap,
        });
        deltas[call.index] = sample.digest;
        if (sample.bytes != null)
          peakWorkspaceBytes = Math.max(peakWorkspaceBytes ?? 0, sample.bytes);
        if (sample.overCap && !workspaceOverCap) {
          workspaceOverCap = true;
          ctx.stop('resource-limit');
        }
        for (const e of events)
          if (
            e.trigger.type === 'after-tool-calls' &&
            toolResults >= e.trigger.count
          )
            applyTriggered(e);
      },
      onFileWrite(rel) {
        for (const e of events)
          if (
            e.trigger.type === 'after-file-write' &&
            compileGlobs([e.trigger.glob]).match(rel) != null
          )
            applyTriggered(e);
      },
    },
  });

  const rawSink = createBoundedSink(path.join(ctx.privateDir, 'stream.raw'), {
    headBytes: Math.floor(budgets.bounds.stream / 2),
    tailBytes: Math.floor(budgets.bounds.stream / 2),
  });
  const errSink = createBoundedSink(path.join(ctx.privateDir, 'stderr.raw'), {
    headBytes: Math.floor(budgets.bounds.stderr / 2),
    tailBytes: Math.floor(budgets.bounds.stderr / 2),
  });
  const splitter = createLineSplitter(
    (line, opts) => {
      const r = parseLine(line, opts);
      if (r.anomaly) parser.anomaly(r.anomaly);
      else if (r.event) parser.push(r.event);
    },
    { onAnomaly: (a) => parser.anomaly(a) },
  );

  const start = monotonicMs();
  const handle = executor.start(ctx.startArgs);
  ctx.handle = handle;
  let stopping = null;
  const timers = [];
  ctx.stop = (reason) => {
    if (stopping != null) return;
    stopping = reason;
    handle.interrupt();
    timers.push(setTimeout(() => handle.terminate(), budgets.graceInterruptMs));
    timers.push(
      setTimeout(
        () => handle.killAll(),
        budgets.graceInterruptMs + budgets.graceTerminateMs,
      ),
    );
  };
  const timeout = setTimeout(
    () => ctx.stop('timeout'),
    budgets.timeoutSeconds * 1000,
  );
  for (const e of events)
    if (e.trigger.type === 'after-seconds')
      timers.push(
        setTimeout(() => applyTriggered(e), e.trigger.seconds * 1000),
      );
  const onAbort = () => ctx.stop('cancelled');
  if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

  handle.stdout.on('data', (chunk) => {
    rawSink.write(chunk);
    splitter.push(chunk.toString('utf8'));
  });
  handle.stderr.on('data', (chunk) => errSink.write(chunk));
  const stdoutClosed = new Promise((r) => handle.stdout.on('close', r));
  const exit = await handle.wait();
  await Promise.race([stdoutClosed, new Promise((r) => setTimeout(r, 2000))]);
  splitter.end();
  clearTimeout(timeout);
  for (const t of timers) clearTimeout(t);
  if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
  const agentMs = monotonicMs() - start;
  const stream = rawSink.finish();
  const stderr = errSink.finish();

  const summary = parser.finish();
  let toolWallMs = 0;
  let toolWallKnown = true;
  for (const [, t] of toolTimes) {
    if (t.end == null) toolWallKnown = false;
    else toolWallMs += t.end - t.start;
  }
  return {
    summary,
    exit,
    stopping,
    maxToolCallsHit,
    workspaceOverCap,
    peakWorkspaceBytes,
    handle,
    deltas,
    eventStatus,
    eventErrors,
    rawFile: path.join(ctx.privateDir, 'stream.raw'),
    errFile: path.join(ctx.privateDir, 'stderr.raw'),
    stream,
    stderr,
    agentMs,
    toolWall: toolWallKnown
      ? estimate(
          toolWallMs,
          'harness receive times of stream tool events',
          `${STREAM_METHOD}+harness-receive-time`,
          'ms',
          { integrity: 'cli-unattested' },
        )
      : unknown(
          'harness tool call/result receive times',
          'ms',
          'unfinished tool call',
        ),
  };
}

function prepareCredential({ credential, redaction, budgets }) {
  if (credential == null || credential.mode === 'none') return { mode: 'none' };
  // Section 4.6: the source policy is checked before anything is read.
  checkSourcePolicy(credential);
  const p = PROVIDERS[credential.provider];
  const original = readCredentialFile(credential.hostPath);
  redaction.addCredentialDocument(original.bytes.toString('utf8'));
  if (credential.mode === 'access-only') {
    const minLifetimeMs =
      budgets.timeoutSeconds * 1000 + (credential.marginMs ?? 10 * 60 * 1000);
    const derived = deriveAccessOnly(credential.provider, original.bytes, {
      now: credential.now ?? Date.now(),
      minLifetimeMs,
    });
    if (derived.mode === 'access-only') {
      for (const s of derived.secrets) redaction.addSecret(s);
      const d = derived.delivery;
      return {
        mode: 'access-only',
        original,
        delivery:
          d.kind === 'env'
            ? { env: { [d.name]: d.value }, files: [] }
            : { env: {}, files: [], login: { args: d.args, stdin: d.value } },
      };
    }
    if (credential.fallback !== 'refresh-capable-copy')
      return { mode: 'unavailable', reason: derived.reason };
  }
  return {
    mode: 'refresh-capable-copy',
    original,
    delivery: {
      env: {},
      files: [{ rel: p.containerFile, bytes: original.bytes }],
    },
    accessOnlyRefused: credential.mode === 'access-only',
  };
}

/**
 * Teardown (section 4.6): every agent process killed, the credential
 * exported before the tmpfs is destroyed (mode B), the proxy log read, then
 * the containers and network removed and their removal verified. Runs on
 * every exit path; a failure is a durable refusal for the provider.
 */
function teardown(ctx) {
  // Once only: a later call reports the first outcome or rethrows its error.
  if (ctx.tornDown || ctx.handle == null) {
    if (ctx.teardownError) throw ctx.teardownError;
    return ctx.teardownResult;
  }
  ctx.tornDown = true;
  try {
    return teardownOnce(ctx);
  } catch (error) {
    ctx.teardownError = error;
    throw error;
  }
}

function teardownOnce(ctx) {
  const { handle, cred, credential, redaction } = ctx;
  const out = {
    export: 'not-applicable',
    haltProvider: false,
    exportError: null,
    proxyLog: null,
    cleanup: 'verified',
  };
  try {
    handle.killAll();
    if (cred?.mode === 'refresh-capable-copy') {
      const exported = handle.exportCredential(
        PROVIDERS[credential.provider].containerFile,
      );
      if (exported.bytes != null) {
        if (!redaction.sealed)
          redaction.addCredentialDocument(exported.bytes.toString('utf8'));
        // Also on late teardown (exceptional exits): the matrix set learns it.
        else
          redaction.parent?.addCredentialDocument(
            exported.bytes.toString('utf8'),
          );
      }
      const decision = decideWriteBack({
        provider: credential.provider,
        original: cred.original,
        exported,
        hostPath: credential.hostPath,
        backupDir: credential.backupDir,
      });
      out.export = decision.outcome;
      out.haltProvider = decision.haltProvider;
      if (decision.outcome === 'failed') out.exportError = decision.reason;
    }
    out.proxyLog = handle.proxyLog?.() ?? null;
  } finally {
    const removed = handle.destroy();
    if (removed === false) out.cleanup = 'failed';
  }
  if (out.haltProvider || out.cleanup === 'failed')
    recordRefusal(ctx.stateDir, credential?.provider ?? ctx.cli, {
      redaction: ctx.redaction,
      reason:
        out.cleanup === 'failed'
          ? 'container cleanup not verified'
          : `credential export ${out.export}${out.exportError ? `: ${out.exportError}` : ''}`,
      attempt: ctx.attemptLabel,
    });
  ctx.teardownResult = out;
  return out;
}

function runEvaluate({
  taskId,
  epoch,
  baselineDir,
  workspaceDir,
  files,
  scratch,
  trusted,
  hostCommands,
  harnessRoot,
}) {
  fs.mkdirSync(scratch, { recursive: true });
  const args = [
    path.join(harnessRoot, 'bin/pms-agentic.mjs'),
    'evaluate',
    taskId,
    '--baseline',
    baselineDir,
    '--workspace',
    workspaceDir,
    '--response',
    files.response,
    '--transcript',
    files.transcript,
    '--observations',
    files.observations,
    '--epoch',
    epoch,
    '--scratch',
    scratch,
  ];
  if (trusted != null) args.push('--trusted-node-modules', trusted);
  if (hostCommands) args.push('--host-commands');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  if (r.status !== 0)
    return {
      status: 'harness-error',
      error: (r.stderr || r.error?.message || '').slice(-2000),
    };
  try {
    return {
      status: 'completed',
      result: JSON.parse(r.stdout),
      resultSha256: sha256(r.stdout),
    };
  } catch {
    return { status: 'harness-error', error: 'unparseable evaluate output' };
  }
}

/**
 * Egress accounting from the proxy log (sections 4.3 and 4.10): one JSON
 * line per CONNECT. No proxy (local fixture executor) is null, never zero
 * connections; an unparseable line makes the counts unknown.
 */
export function summarizeProxyLog(text) {
  if (text == null) return null;
  const hosts = {};
  let denied = 0;
  let up = 0;
  let down = 0;
  let unparseable = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      unparseable += 1;
      continue;
    }
    if (
      typeof e?.target !== 'string' ||
      !Number.isFinite(e.up) ||
      !Number.isFinite(e.down)
    ) {
      unparseable += 1;
      continue;
    }
    hosts[e.target] = e.target in hosts ? hosts[e.target] + 1 : 1;
    if (e.decision !== 'allowed') denied += 1;
    up += e.up;
    down += e.down;
  }
  const known = unparseable === 0;
  return {
    connections: known ? Object.values(hosts).reduce((a, b) => a + b, 0) : null,
    denied: known ? denied : null,
    bytesUp: known ? up : null,
    bytesDown: known ? down : null,
    targets: hosts,
    unparseableLines: unparseable,
  };
}

/**
 * Evidence completeness (sections 6.2-6.4): `incomplete` when an archive is
 * over its bound, a grader input (transcript, final message) was truncated
 * or an artifact was purged by the leak scan; `redacted` when stored bytes
 * differ from graded bytes; otherwise `complete`.
 */
export function evidenceCompleteness({
  baselineManifest,
  finalManifest,
  graderInputs,
  purged,
}) {
  const affected = [...finalManifest.affectedPaths];
  for (const a of graderInputs)
    if (a.redacted || a.truncated) affected.push(a.file);
  let completeness = 'complete';
  if (
    finalManifest.completeness === 'incomplete' ||
    baselineManifest.completeness === 'incomplete' ||
    graderInputs.some((a) => a.truncated) ||
    purged.length > 0
  )
    completeness = 'incomplete';
  else if (affected.length > 0 || baselineManifest.completeness === 'redacted')
    completeness = 'redacted';
  return { completeness, affected };
}

/** Two-pass grading (section 4.2). */
export function grade(ctx, gradingInputs) {
  const { taskEntry, epoch, grading } = ctx;
  const passes = [];
  const harnessRoot = grading.harnessRoot ?? CORPUS_ROOT;
  const t0 = monotonicMs();
  const run = (pass, hostCommands) => {
    const scratch = path.join(gradingInputs.root, `scratch-${pass}`);
    if (grading.mode === 'trusted') {
      checkTrustedTree({
        nodeModules: grading.trustedNodeModules,
        expected: grading.trustedExpected,
      });
      // In a grader container the scratch root is /scratch in an image with no
      // node_modules above it (asserted by the self-test); locally, check it.
      if (grading.evaluate == null)
        assertNoAncestorNodeModules(path.join(scratch, 'x'));
    } else if (ctx.kind === 'provider-backed') {
      const e = new Error(
        'provider-backed grading requires the trusted tree (invariant G)',
      );
      e.code = 'trusted-tree';
      throw e;
    }
    if (grading.evaluate != null)
      return grading.evaluate({
        pass,
        hostCommands,
        taskId: taskEntry.name,
        epoch,
        baselineDir: gradingInputs.baseline,
        workspaceDir: gradingInputs.workspace,
        inputsDir: path.dirname(gradingInputs.files.response),
        trustedNodeModules: grading.trustedNodeModules,
      });
    return runEvaluate({
      taskId: taskEntry.name,
      epoch,
      baselineDir: gradingInputs.baseline,
      workspaceDir: gradingInputs.workspace,
      files: gradingInputs.files,
      scratch,
      trusted: grading.mode === 'trusted' ? grading.trustedNodeModules : null,
      hostCommands,
      harnessRoot,
    });
  };
  const g1 = run('G1', false);
  passes.push({
    pass: 'G1',
    status: g1.status,
    verdict: g1.result?.verdict ?? null,
    ...(g1.resultSha256 ? { resultSha256: g1.resultSha256 } : {}),
  });
  let final = g1.result ?? null;
  const expectation = taskEntry.task.expectations?.[epoch];
  const hasHostBuild = (expectation?.checks ?? []).some(
    (c) => c.kind === 'host.build',
  );
  if (g1.status === 'completed' && hasHostBuild) {
    if (!grading.hostCommands) {
      passes.push({ pass: 'G2', status: 'not-run', verdict: null });
    } else {
      const g2 = run('G2', true);
      if (g2.status !== 'completed') {
        passes.push({
          pass: 'G2',
          status: 'aborted-by-agent-code',
          verdict: null,
        });
        final = {
          ...g1.result,
          verdict: g1.result.verdict === 'pass' ? 'fail' : g1.result.verdict,
          hostBuild: 'aborted-by-agent-code',
        };
      } else {
        const nonHost = (r) =>
          JSON.stringify(
            r.checks
              .filter((c) => c.kind !== 'host.build')
              .map((c) => [c.id, c.status]),
          );
        if (nonHost(g1.result) !== nonHost(g2.result)) {
          passes.push({
            pass: 'G2',
            status: 'inconsistent',
            verdict: g2.result.verdict,
            resultSha256: g2.resultSha256,
          });
          final = {
            ...g1.result,
            verdict: g1.result.verdict === 'pass' ? 'fail' : g1.result.verdict,
            hostBuild: 'inconsistent',
          };
        } else {
          passes.push({
            pass: 'G2',
            status: 'completed',
            verdict: g2.result.verdict,
            resultSha256: g2.resultSha256,
          });
          final = g2.result;
        }
      }
    }
  }
  return {
    verdict: g1.status === 'completed' ? final.verdict : 'error',
    passes,
    result: final,
    error: g1.status === 'completed' ? null : g1.error,
    gradingMs: monotonicMs() - t0,
  };
}

function vocabularyCompliance(result) {
  if (result == null) return 'not-graded';
  const kinds = new Set([
    'static.forbidden',
    'definition.diff',
    'generated.consistent',
  ]);
  const relevant = result.checks.filter(
    (c) => c.required && (kinds.has(c.kind) || c.kind === 'render.styles'),
  );
  if (relevant.some((c) => c.status === 'fail' || c.status === 'blocked'))
    return 'fail';
  if (relevant.length > 0 && relevant.every((c) => c.status === 'pass'))
    return 'pass';
  return 'unmeasured';
}

/**
 * Runs one attempt. Returns `{ record }`, `{ refused }` for a task the
 * runner must not run (held-out, unsupported features) or `{ haltProvider }`
 * when the provider's credential is unusable. Working copies are removed on
 * every exit path, including exceptions.
 */
export async function runAttempt(opts) {
  const task = opts.taskEntry.task;
  const heldout = heldoutRefusal({ taskId: opts.taskEntry.name, task });
  if (heldout) return { refused: [heldout] };
  const plan = enforcementPlan(task, opts.fixture.meta);
  if (plan.refusals.length > 0) return { refused: plan.refusals };
  if (opts.kind === 'provider-backed' && !opts.executor.isolated)
    throw new Error('provider-backed attempts require an isolated executor');

  fs.mkdirSync(opts.paths.attemptDir, { recursive: true });
  privateDir(path.dirname(opts.paths.privateDir));
  privateDir(opts.paths.privateDir);
  privateDir(path.dirname(opts.paths.workRoot));
  privateDir(opts.paths.workRoot);
  const ctx = {
    tornDown: false,
    handle: null,
    stateDir: opts.stateDir,
    cli: opts.modelConfig.cli,
    attemptLabel: path.relative(
      path.dirname(path.dirname(opts.paths.workRoot)),
      opts.paths.attemptDir,
    ),
  };
  let keepState = false;
  try {
    return await attemptBody(opts, plan, ctx);
  } finally {
    opts.loadSampler?.stop();
    // Exceptions included: tear down what was started, then remove every
    // unredacted working copy. The recovery state is kept only when the
    // teardown could not be verified.
    try {
      if (ctx.handle != null) keepState = teardown(ctx).cleanup === 'failed';
      else if (ctx.state?.resources != null) {
        // Startup failed after registering resources (no handle): remove
        // them, verified, whatever the executor already rolled back.
        const remaining = opts.executor.cleanupResources?.(
          ctx.state.resources,
        ) ?? ['resources of an executor without cleanup'];
        if (remaining.length > 0) {
          keepState = true;
          recordRefusal(opts.stateDir, ctx.provider ?? ctx.cli, {
            reason: `partial startup not cleaned up: ${remaining.join(', ')}`,
            attempt: ctx.attemptLabel,
            redaction: ctx.redaction,
          });
        }
      }
    } catch (error) {
      keepState = true;
      recordRefusal(opts.stateDir, ctx.provider ?? ctx.cli, {
        reason: `teardown failed: ${error.code ?? ''} ${error.message}`,
        attempt: ctx.attemptLabel,
        redaction: ctx.redaction,
      });
    }
    removeOwned(opts.paths.workRoot);
    if (keepState) {
      for (const name of fs.existsSync(opts.paths.privateDir)
        ? fs.readdirSync(opts.paths.privateDir)
        : [])
        if (name !== 'state.json')
          removeOwned(path.join(opts.paths.privateDir, name));
    } else removeOwned(opts.paths.privateDir);
  }
}

async function attemptBody(opts, plan, ctx) {
  const {
    kind,
    matrixId,
    cell,
    repetition,
    attempt,
    modelConfig,
    taskEntry,
    fixture,
    corpusInfo,
    executor,
    paths,
    budgets,
    credential = null,
    identity,
    grading,
    effectiveConfigEvidence = null,
    signal = null,
    projectionFor,
  } = opts;
  const task = taskEntry.task;
  const epoch = corpusInfo.epoch;
  const attemptDir = paths.attemptDir;
  const priv = paths.privateDir;
  const ws = path.join(paths.workRoot, 'workspace');
  const baseline = path.join(paths.workRoot, 'baseline');
  const timestamps = {};
  const phase = (name, fn) => {
    const startedAt = nowIso();
    const t = monotonicMs();
    const out = fn();
    timestamps[name] = {
      startedAt,
      endedAt: nowIso(),
      durationMs: monotonicMs() - t,
    };
    return out;
  };

  // Prepare (no agent code exists yet): materialize, install and verify the
  // fixture closure, prepare, scope baseline.
  let install = null;
  phase('prepare', () => {
    materializeFiles({ taskEntry, fixture, dest: ws });
    if (opts.install) {
      install = opts.install({ workspace: ws, task });
      // The consumed closure must be the declared (matrix-identity) one.
      const declared = opts.install.identity;
      if (
        declared != null &&
        (install?.closureLockSha256 !== declared.closureLockSha256 ||
          install?.nonProductLockSha256 !== declared.nonProductLockSha256)
      )
        throw Object.assign(
          new Error('installed fixture closure differs from the declared one'),
          { code: 'install' },
        );
    }
    prepareWorkspace({ taskEntry, fixture, dest: ws });
    copyTree(ws, baseline, {
      includeEmptyDirs: true,
      exclude: ['node_modules/**', '**/node_modules/**'],
    });
  });
  const nodeModulesBefore = nodeModulesState(ws);

  const prompt = buildPrompt({
    corpusRoot: CORPUS_ROOT,
    taskEntry,
    docsPath: DOCS_MOUNT,
  });
  const sessionId = crypto.randomUUID();
  const adapter = ADAPTERS[modelConfig.cli];
  const agentHome = path.join(priv, 'agent-home');
  // Paths as the CLI sees them (section 3.2): /workspace and /run/agent in a
  // container, the host paths for the local fixture executor.
  const visible = executor.visiblePaths({ workspace: ws, agentHome });
  const invocation = adapter.buildInvocation({
    model: modelConfig.model,
    effort: modelConfig.reasoningEffort ?? null,
    prompt,
    cliMaxTurns: budgets.cliMaxTurns,
    sessionId,
    workdir: visible.workspace,
    lastMessagePath: `${visible.home}/last-message.txt`,
  });

  // Every secret reaches the matrix's set as soon as it is known, before
  // any path (exception, refusal, outcome) can persist text.
  const redaction = new RedactionSet({
    ...(opts.redactionIdentity ?? {}),
    parent: opts.matrixRedaction ?? null,
  });
  ctx.redaction = redaction;
  ctx.credential = credential;
  const cred = prepareCredential({ credential, redaction, budgets });
  ctx.cred = cred;
  // Not a task property: the provider is halted, the repetition missing.
  if (cred.mode === 'unavailable')
    return {
      haltProvider: `credential unavailable for access-only mode: ${cred.reason}`,
    };

  // Non-secret recovery state, written before any container or process
  // exists and updated with every resource name before it is created.
  const stateFile = path.join(priv, 'state.json');
  const state = {
    kind,
    cli: modelConfig.cli,
    provider: credential?.provider ?? modelConfig.cli,
    attempt: ctx.attemptLabel,
    agentHome,
    resources: null,
    hostPath: credential?.hostPath ?? null,
    synthetic: credential?.synthetic === true,
    backupDir: credential?.backupDir ?? null,
    credential:
      cred.mode === 'refresh-capable-copy'
        ? recoveryState(credential.provider, cred.original)
        : null,
  };
  ctx.state = state;
  ctx.provider = state.provider;
  const saveState = () =>
    writeFileAtomic(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  saveState();
  const actx = {
    executor,
    cli: modelConfig.cli,
    adapterInput: { model: modelConfig.model },
    ws,
    baseline,
    taskEntry,
    budgets,
    privateDir: priv,
    signal,
    startArgs: {
      kind,
      cli: modelConfig.cli,
      argv: invocation.argv,
      env: invocation.env,
      stdinText: invocation.promptChannel === 'stdin' ? prompt : null,
      workspace: ws,
      agentHome,
      credential: cred.mode === 'none' ? null : cred.delivery,
      mounts: plan.mounts,
      onResources: (resources) => {
        state.resources = { ...(state.resources ?? {}), ...resources };
        saveState();
      },
    },
  };
  const agentStartedAt = nowIso();
  let run;
  try {
    run = await agentPhase(actx);
  } finally {
    ctx.handle = actx.handle ?? null;
  }
  timestamps.agent = {
    startedAt: agentStartedAt,
    endedAt: nowIso(),
    durationMs: run.agentMs,
  };

  const down = teardown(ctx);
  redaction.seal();
  const s = run.summary;
  const secrets = redaction.list();

  // Staging: the only copies of the agent's tree that grading and archives
  // read, taken without following links, after every agent process is gone.
  const staged = phase('stage', () => ({
    final: stageWorkspace(ws, path.join(priv, 'staged/final'), {
      maxBytes: budgets.bounds.evidence,
    }),
    baseline: stageWorkspace(baseline, path.join(priv, 'staged/baseline'), {
      maxBytes: budgets.bounds.evidence,
    }),
  }));
  const nodeModulesAfter = nodeModulesState(ws);
  removeOwned(paths.workRoot);

  // Breaches: detect-and-fail capabilities, tool policy, credential leaks.
  const breaches = detectBreaches({
    plan,
    toolCalls: s.toolCalls,
    policyEvents: s.policyEvents,
    nodeModules: { before: nodeModulesBefore, after: nodeModulesAfter },
  });
  const finalMessage = s.finalMessage ?? '';
  const wsLeak = treeLeaks(path.join(priv, 'staged/final'), secrets);
  const streamLeak =
    pathLeaks(run.rawFile, secrets) || pathLeaks(run.errFile, secrets);
  if (
    secrets.length > 0 &&
    (streamLeak ||
      secrets.some((x) => finalMessage.includes(x)) ||
      wsLeak.length > 0)
  )
    breaches.push({
      kind: 'credential-leak',
      source: 'redaction',
      enforcement: 'detected',
      detail:
        wsLeak.length > 0
          ? `workspace: ${wsLeak.join(',')}`
          : 'stream or final message',
    });

  const effective =
    modelConfig.cli === 'claude' ? s.effectiveConfig : effectiveConfigEvidence;
  const configMismatch = effective == null || effective.matchesRequest !== true;
  const classification = classify({
    cli: modelConfig.cli,
    terminal: s.terminal,
    exit: run.exit,
    harness: {
      cancelled: run.stopping === 'cancelled',
      timedOut: run.stopping === 'timeout',
      maxToolCallsHit: run.maxToolCallsHit,
      resourceLimit:
        run.workspaceOverCap || (run.handle.resourceLimit?.() ?? false),
      harnessError: down.exportError
        ? 'credential-export-failed'
        : down.cleanup === 'failed'
          ? 'container'
          : null,
    },
    anomalies: s.anomalies,
    configMismatch,
    fidelity: s.fidelity.status,
    breaches,
    rateLimit: s.signals.rateLimit,
  });

  // Oracle inputs (graded copies are taken before any redaction).
  const filesDir = privateDir(path.join(priv, 'oracle-inputs'));
  const files = {
    response: path.join(filesDir, 'final-message.txt'),
    transcript: path.join(filesDir, 'transcript.jsonl'),
    observations: path.join(filesDir, 'observations.json'),
  };
  const transcriptText =
    s.transcript.map((e) => JSON.stringify(e)).join('\n') +
    (s.transcript.length ? '\n' : '');
  fs.writeFileSync(files.response, finalMessage, { mode: 0o600 });
  fs.writeFileSync(files.transcript, transcriptText, { mode: 0o600 });
  fs.writeFileSync(files.observations, JSON.stringify(run.eventStatus), {
    mode: 0o600,
  });

  // Evidence archives of the staged copies, then grading of the same bytes.
  const baselineManifest = phase('archive-baseline', () =>
    archiveTree({
      root: path.join(priv, 'staged/baseline'),
      dest: path.join(attemptDir, 'evidence/baseline'),
      secrets,
      maxBytes: budgets.bounds.evidence,
      extraEntries: unreproduced(staged.baseline),
    }),
  );
  const finalManifest = phase('archive-final', () =>
    archiveTree({
      root: path.join(priv, 'staged/final'),
      dest: path.join(attemptDir, 'evidence/final'),
      secrets,
      maxBytes: budgets.bounds.evidence,
      extraEntries: unreproduced(staged.final),
    }),
  );
  const stagedComplete = !staged.final.overflow && !staged.baseline.overflow;
  let gradingOut = {
    verdict: 'not-graded',
    passes: [{ pass: 'G1', status: 'not-run', verdict: null }],
    result: null,
    gradingMs: 0,
  };
  if (classification.valid && stagedComplete) {
    const g = {
      root: privateDir(path.join(priv, 'grading')),
      baseline: path.join(priv, 'staged/baseline'),
      workspace: path.join(priv, 'staged/final'),
      files,
    };
    gradingOut = phase('grading', () =>
      grade({ taskEntry, epoch, grading, kind }, g),
    );
  }
  const verdict = gradingOut.verdict;
  if (classification.valid && (verdict === 'error' || !stagedComplete)) {
    Object.assign(classification, {
      class: 'harness',
      code: stagedComplete ? 'evaluate-error' : 'evidence-bound',
      valid: false,
      termination: 'harness',
      retry: false,
    });
  }
  const taskSuccess =
    gradingOut.result == null
      ? null
      : verdict === 'pass' &&
        classification.termination === 'completed' &&
        classification.class === 'agent';

  const timeline = analyzeTimeline({
    toolCalls: s.toolCalls,
    deltas: s.toolCalls.map((_, i) => run.deltas[i] ?? null),
    taskSuccess,
    workspaceRoot: visible.workspace,
  });
  const countKinds = [
    'command',
    'file-write',
    'file-read',
    'search',
    'web',
    'subagent',
    'mcp',
    'other',
  ];
  const toolCalls = {
    total: fromStream(
      s.toolCalls.length,
      `${modelConfig.cli}.stream tool calls`,
      'calls',
    ),
  };
  for (const k of countKinds)
    toolCalls[k] = fromStream(
      s.toolCalls.filter((c) => c.kind === k).length,
      `${modelConfig.cli}.stream tool calls`,
      'calls',
    );

  const scopeCheck = gradingOut.result?.checks?.find(
    (c) => c.kind === 'scope.diff',
  );
  const visual = gradingOut.result?.checks?.find(
    (c) => c.kind === 'visual.fidelity',
  );
  const realized =
    scopeCheck?.status === 'fail'
      ? String(scopeCheck.reason ?? '')
          .split('; ')
          .filter(Boolean)
      : [];
  const prevented = s.toolCalls
    .filter(
      (c) =>
        c.kind === 'file-write' &&
        c.status === 'failed' &&
        (plan.mounts.workspaceReadOnly ||
          c.paths.some((p) => plan.mounts.readOnlyPaths.includes(p))),
    )
    .map((c) => `write denied: ${c.paths.join(',')}`);

  // Persist redacted artifacts, then the redacted record, then scan all.
  const art = [];
  const persist = (name, text, bound) => {
    const red = redaction.redactText(text);
    const b = bounded(red, bound);
    fs.writeFileSync(path.join(attemptDir, name), b.text);
    const entry = {
      file: name,
      sha256: sha256(b.text),
      bytes: Buffer.byteLength(b.text),
      truncated: b.truncated,
      originalBytes: b.originalBytes,
      redacted: red !== text,
    };
    art.push(entry);
    return entry;
  };
  persist('prompt.md', prompt, budgets.bounds.graderInput);
  const streamArtifact = persist(
    'stream.jsonl',
    fs.readFileSync(run.rawFile, 'utf8'),
    budgets.bounds.stream + 4096,
  );
  streamArtifact.truncated = streamArtifact.truncated || run.stream.truncated;
  streamArtifact.originalBytes = run.stream.bytes;
  const stderrArtifact = persist(
    'stderr.log',
    fs.readFileSync(run.errFile, 'utf8'),
    budgets.bounds.stderr + 4096,
  );
  stderrArtifact.truncated = stderrArtifact.truncated || run.stderr.truncated;
  stderrArtifact.originalBytes = run.stderr.bytes;
  const transcriptArtifact = persist(
    'transcript.jsonl',
    transcriptText,
    budgets.bounds.graderInput,
  );
  const messageArtifact = persist(
    'final-message.txt',
    finalMessage,
    budgets.bounds.graderInput,
  );
  persist(
    'observations.json',
    JSON.stringify(run.eventStatus, null, 2),
    budgets.bounds.graderInput,
  );
  if (down.proxyLog != null)
    persist('proxy.jsonl', down.proxyLog, budgets.bounds.stderr);
  if (gradingOut.result)
    persist(
      'evaluation.json',
      JSON.stringify(gradingOut.result, null, 2),
      budgets.bounds.graderInput,
    );

  const { completeness, affected } = evidenceCompleteness({
    baselineManifest,
    finalManifest,
    graderInputs: [transcriptArtifact, messageArtifact, streamArtifact],
    purged: [],
  });

  const projectionInput = projectionFor({
    task: taskEntry,
    plan,
    invocation,
    prompt,
    modelConfig,
    install,
    transients: [paths.workRoot, paths.privateDir],
  });
  const record = {
    schema: RECORD_SCHEMA,
    kind,
    matrixId,
    cell,
    repetition,
    attempt,
    comparability: projectionInput,
    task: {
      id: taskEntry.name,
      split: 'development',
      workflow: task.workflow,
      caseType: task.caseType,
      epoch,
      corpusVersion: corpusInfo.corpusVersion,
      corpusLockSha256: corpusInfo.corpusLockSha256,
      taskDigest: corpusInfo.taskDigests[taskEntry.name] ?? null,
    },
    harness: identity.harness,
    prompt: {
      file: 'prompt.md',
      sha256: sha256(prompt),
      docsPath: DOCS_MOUNT,
      channel: invocation.promptChannel,
    },
    modelConfig: {
      requestedModel: modelConfig.model,
      reasoningEffort: {
        requested: modelConfig.reasoningEffort ?? null,
        effective: effective?.effort ?? null,
      },
      rawArgv: invocation.argv.map((a) =>
        a === prompt ? '<prompt: prompt.md>' : a,
      ),
      normalizedArgv: projectionInput.projection.model.normalizedArgv,
      env: {
        ...invocation.env,
        ...(cred.mode === 'none'
          ? {}
          : Object.fromEntries(
              Object.keys(cred.delivery.env).map((k) => [k, '<secret>']),
            )),
      },
      configFiles: [],
      effectiveConfig: effective ?? {
        source: 'none',
        tools: null,
        subagents: 'unknown',
        web: 'unknown',
        builtins: [],
        matchesRequest: false,
      },
    },
    cli: {
      name: modelConfig.cli,
      version: modelConfig.cliVersion,
      sha256: modelConfig.cliSha256,
      executeOnly: executor.isolated === true,
    },
    provider: {
      sessionId: s.sessionId,
      primaryModelFidelity: s.fidelity.status,
      servedModels: s.fidelity.servedModels,
      auxiliaryModels: s.fidelity.auxiliaryModels,
      reroutes: s.signals.reroutes.map((r) => `${r.from} -> ${r.to}`),
      apiRetries: s.signals.apiRetries,
      reconnects: s.signals.reconnects,
      rateLimit: s.signals.rateLimit,
    },
    budgets: {
      corpusTimeoutSeconds: task.budget.timeoutSeconds,
      corpusMaxTurnsHint: task.budget.maxTurns,
      timeoutSeconds: budgets.timeoutSeconds,
      maxToolCalls: budgets.maxToolCalls,
      cliMaxTurns: budgets.cliMaxTurns ?? null,
      workspaceBytesCap: budgets.workspaceBytesCap,
      limitFired:
        run.stopping === 'timeout'
          ? 'timeout'
          : run.maxToolCallsHit
            ? 'max-tool-calls'
            : run.workspaceOverCap
              ? 'workspace-bytes'
              : classification.code === 'cli-max-turns'
                ? 'cli-max-turns'
                : null,
    },
    productBuild: identity.productBuild,
    install,
    trustedTree:
      grading.mode === 'trusted'
        ? {
            mode: 'trusted',
            digest: grading.trustedExpected.digest,
            pandamstyleDigest: grading.trustedExpected.pandamstyleDigest,
            matchesProductTarballs: true,
            checkedBeforeGrading: true,
          }
        : {
            mode: 'ancestor-fallback-dev',
            digest: null,
            pandamstyleDigest: null,
            matchesProductTarballs: false,
            checkedBeforeGrading: false,
          },
    // Load sampled over the attempt itself (stopped here, after grading).
    environment: {
      ...identity.environment,
      load: opts.loadSampler?.stop() ??
        identity.environment.load ?? {
          samples: 0,
          min: null,
          max: null,
          median: null,
        },
    },
    integrity: {
      stream: 'cli-unattested',
      // No audit (local fixture executor): unknown, never clean.
      channelAudit: run.handle.channelAudit?.() ?? {
        samples: 0,
        cliNonDumpable: null,
        foreignStreamHolders: null,
        controlSocketConnections: null,
      },
      anomalies: s.anomalies,
      proxy: summarizeProxyLog(down.proxyLog),
      contested: opts.contested === true,
    },
    timestamps,
    outcome: {
      termination: classification.termination,
      class: classification.class,
      code: classification.code,
      valid: classification.valid,
      retry: { scheduled: false, backoffSeconds: null },
      taskSuccess,
      breaches,
    },
    grading: {
      verdict,
      passes: gradingOut.passes,
      failingRequiredChecks: (gradingOut.result?.checks ?? [])
        .filter((c) => c.required && c.status !== 'pass')
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          class: c.class,
          status: c.status,
          reason: c.reason == null ? null : String(c.reason).slice(0, 500),
        })),
      ...(gradingOut.error ? { error: gradingOut.error.slice(0, 2000) } : {}),
    },
    metrics: {
      toolCalls,
      agentSteps: s.agentSteps,
      repairCycles: timeline.repairCycles,
      firstPassSuccess: timeline.firstPassSuccess,
      coverage: timeline.coverage,
      tokens: {
        raw: s.tokens.raw,
        normalized: s.tokens.normalized,
        discrepancy: s.tokens.discrepancy,
      },
      cost: s.cost,
      elapsed: {
        agentPhaseMs: harnessObserved(
          run.agentMs,
          'harness monotonic clock',
          'ms',
        ),
        cliDurationMs: s.durations.cliDurationMs,
        cliApiDurationMs: s.durations.cliApiDurationMs,
      },
      toolCost: {
        outputBytes: fromStream(
          s.toolOutputBytes,
          `${modelConfig.cli}.stream tool output`,
          'bytes',
        ),
        wallMs: run.toolWall,
        containerCpuUsec:
          run.handle.cgroup?.()?.cpuUsageUsec ??
          unknown('cgroup', 'usec', 'no container'),
      },
      compilerCost: {
        agentVerifyCommands: timeline.compiler.verifyCommands,
        agentAttributedCommands: timeline.compiler.attributedCommands,
        harnessPrepareMs: harnessObserved(
          timestamps.prepare.durationMs,
          'harness monotonic clock',
          'ms',
        ),
        harnessGradingMs: harnessObserved(
          gradingOut.gradingMs,
          'harness monotonic clock',
          'ms',
        ),
      },
      peakWorkspaceBytes:
        run.peakWorkspaceBytes == null
          ? unknown('workspace samples', 'bytes', 'no sample')
          : harnessObserved(
              run.peakWorkspaceBytes,
              'confined workspace samples',
              'bytes',
            ),
      visualFidelity:
        visual?.status === 'pass'
          ? 'pass'
          : visual?.status === 'fail'
            ? 'fail'
            : 'unmeasured',
      vocabularyCompliance: vocabularyCompliance(gradingOut.result),
      scopeViolations: {
        realized,
        prevented,
        detected: breaches.map((b) => `${b.kind}: ${b.detail ?? ''}`.trim()),
      },
    },
    credential: {
      mode: cred.mode,
      export: down.export,
      haltProvider: down.haltProvider,
      source: credential?.source ?? null,
      ...(cred.accessOnlyRefused ? { accessOnlyRefused: true } : {}),
    },
    evidence: {
      completeness,
      replay: replayExactness({ completeness, affectedPaths: affected }).label,
      affectedPaths: affected,
      gradedSetDigest: finalManifest.setDigest,
      baselineSetDigest: baselineManifest.setDigest,
      // Manifest bytes, binding every extraction-driving field (section 6.3).
      manifests: {
        final: fileSha256(
          path.join(attemptDir, 'evidence/final/manifest.json'),
        ),
        baseline: fileSha256(
          path.join(attemptDir, 'evidence/baseline/manifest.json'),
        ),
      },
      stagedBytes: {
        final: staged.final.bytes,
        baseline: staged.baseline.bytes,
      },
      purged: [],
      artifacts: art,
    },
    eventErrors: run.eventErrors,
    classificationDetail: {
      haltProvider: classification.haltProvider || down.haltProvider,
      haltMatrix: classification.haltMatrix,
      retry: classification.retry,
    },
  };
  writeRecord(attemptDir, record, redaction);
  return { record };
}

/**
 * Writes the record through the redaction set, then scans every persisted
 * file of the attempt; a purged artifact makes the evidence incomplete and
 * the record is rewritten (redacted again) to say so.
 */
export function writeRecord(attemptDir, record, redaction) {
  const write = (r) => {
    const text = redaction.redactText(`${JSON.stringify(r, null, 2)}\n`);
    writeFileAtomic(path.join(attemptDir, 'record.json'), text);
    return text;
  };
  write(record);
  const purged = scanAndPurge(attemptDir, redaction).filter(
    (f) => f !== 'record.json',
  );
  if (purged.length > 0) {
    record.evidence.purged = purged;
    record.evidence.completeness = 'incomplete';
    record.evidence.replay = 'non-exact';
    write(record);
    scanAndPurge(attemptDir, redaction);
  }
  if (!fs.existsSync(path.join(attemptDir, 'record.json')))
    throw Object.assign(
      new Error('record still contained a secret after redaction'),
      { code: 'redaction' },
    );
}
