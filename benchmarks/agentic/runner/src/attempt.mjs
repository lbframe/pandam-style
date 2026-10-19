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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compileGlobs } from '../../src/glob.mjs';
import { copyTree } from '../../src/fs-tree.mjs';
import {
  applyEvent,
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
  decideWriteBack,
  deriveAccessOnly,
  readCredentialFile,
  recoveryState,
} from './credentials.mjs';
import {
  archiveTree,
  deltaDigest,
  nodeModulesDigest,
  oracleIgnoredGlobs,
  replayExactness,
} from './evidence.mjs';
import {
  STREAM_METHOD,
  estimate,
  fromStream,
  harnessObserved,
  unknown,
} from './measured.mjs';
import { RedactionSet, scanAndPurge } from './redact.mjs';
import { createLineSplitter, parseLine } from './stream.mjs';
import {
  assertNoAncestorNodeModules,
  checkTrustedTree,
} from './trusted-tree.mjs';
import {
  CORPUS_ROOT,
  monotonicMs,
  nowIso,
  sha256,
  writeJson,
} from './util.mjs';

export const ADAPTERS = { claude, codex };
export const DOCS_MOUNT = '/opt/pandamstyle-agent-docs';
export const RECORD_SCHEMA = 'pms-agentic-run-record/v1';
const STREAM_BOUND = 64 * 1024 * 1024;
const STDERR_BOUND = 1024 * 1024;

function bounded(text, bound) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= bound) return { text, truncated: false, originalBytes: bytes };
  const half = Math.floor(bound / 8);
  const buf = Buffer.from(text);
  return {
    text: `${buf.subarray(0, half).toString()}\n[pms-runner: truncated ${bytes - 2 * half} bytes]\n${buf.subarray(buf.length - half).toString()}`,
    truncated: true,
    originalBytes: bytes,
  };
}

function makePrivateFile(dir, name) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
}

/** Runs the agent phase and returns the raw material of the record. */
async function agentPhase(ctx) {
  const {
    executor,
    cli,
    adapterInput,
    ws,
    baseline,
    taskEntry,
    fixture,
    budgets,
  } = ctx;
  const adapter = ADAPTERS[cli];
  const harnessIgnored = taskEntry.task.permissions.harnessIgnored ?? [];
  const toolTimes = new Map();
  const deltas = [];
  const eventStatus = {};
  const events = taskEntry.task.workspace.events ?? [];
  for (const e of events) eventStatus[`event:${e.id}`] = 'not-triggered';
  let toolResults = 0;
  let toolCallCount = 0;
  let maxToolCallsHit = false;
  let handle = null;

  const applyTriggered = (e) => {
    if (eventStatus[`event:${e.id}`] !== 'not-triggered') return;
    const r = applyEvent({ taskEntry, fixture, eventId: e.id, dest: ws });
    if (r.applied)
      applyEvent({ taskEntry, fixture, eventId: e.id, dest: baseline });
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
        deltas[call.index] = deltaDigest(ws, harnessIgnored);
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

  const rawFile = makePrivateFile(ctx.privateDir, 'stream.raw');
  const errFile = makePrivateFile(ctx.privateDir, 'stderr.raw');
  let rawBytes = 0;
  const splitter = createLineSplitter((line, opts) => {
    const r = parseLine(line, opts);
    if (r.anomaly) parser.anomaly(r.anomaly);
    else if (r.event) parser.push(r.event);
  });

  const start = monotonicMs();
  handle = executor.start(ctx.startArgs);
  ctx.onStarted?.(handle);
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
  if (ctx.signal)
    ctx.signal.addEventListener('abort', () => ctx.stop('cancelled'), {
      once: true,
    });

  handle.stdout.setEncoding('utf8');
  handle.stdout.on('data', (chunk) => {
    rawBytes += Buffer.byteLength(chunk);
    fs.appendFileSync(rawFile, chunk);
    splitter.push(chunk);
  });
  handle.stderr.on('data', (chunk) => {
    if (fs.statSync(errFile).size < STDERR_BOUND * 4)
      fs.appendFileSync(errFile, chunk);
  });
  const stdoutClosed = new Promise((r) => handle.stdout.on('close', r));
  const exit = await handle.wait();
  await Promise.race([stdoutClosed, new Promise((r) => setTimeout(r, 2000))]);
  splitter.end();
  clearTimeout(timeout);
  for (const t of timers) clearTimeout(t);
  const agentMs = monotonicMs() - start;

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
    handle,
    deltas,
    eventStatus,
    rawFile,
    errFile,
    rawBytes,
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
 * Runs one attempt. Returns `{ record }`, or `{ refused }` for a task the
 * runner must not run (held-out, unsupported features).
 */
export async function runAttempt(opts) {
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
  const heldout = heldoutRefusal({ taskId: taskEntry.name, task });
  if (heldout) return { refused: [heldout] };
  const plan = enforcementPlan(task, fixture.meta);
  if (plan.refusals.length > 0) return { refused: plan.refusals };
  if (kind === 'provider-backed' && !executor.isolated)
    throw new Error('provider-backed attempts require an isolated executor');

  const epoch = corpusInfo.epoch;
  const attemptDir = paths.attemptDir;
  const privateDir = paths.privateDir;
  fs.mkdirSync(attemptDir, { recursive: true });
  const workRoot = paths.workRoot;
  const ws = path.join(workRoot, 'workspace');
  const baseline = path.join(workRoot, 'baseline');
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

  // Prepare: materialize, (install), prepare, scope baseline.
  phase('prepare', () => {
    fs.rmSync(workRoot, { recursive: true, force: true });
    materializeFiles({ taskEntry, fixture, dest: ws });
    if (opts.install) opts.install({ workspace: ws, task });
    prepareWorkspace({ taskEntry, fixture, dest: ws });
    copyTree(ws, baseline, {
      includeEmptyDirs: true,
      exclude: ['node_modules/**', '**/node_modules/**'],
    });
  });
  const nodeModulesBefore = nodeModulesDigest(ws);

  const prompt = buildPrompt({
    corpusRoot: CORPUS_ROOT,
    taskEntry,
    docsPath: DOCS_MOUNT,
  });
  const sessionId = crypto.randomUUID();
  const adapter = ADAPTERS[modelConfig.cli];
  const invocation = adapter.buildInvocation({
    model: modelConfig.model,
    effort: modelConfig.reasoningEffort ?? null,
    prompt,
    cliMaxTurns: budgets.cliMaxTurns,
    sessionId,
    workdir: ws,
  });

  const redaction = new RedactionSet(opts.redactionIdentity ?? {});
  const cred = prepareCredential({ credential, redaction, budgets });
  // Not a task property: the provider is halted, the repetition missing.
  if (cred.mode === 'unavailable')
    return {
      haltProvider: `credential unavailable for access-only mode: ${cred.reason}`,
    };

  const ctx = {
    executor,
    cli: modelConfig.cli,
    adapterInput: { model: modelConfig.model },
    ws,
    baseline,
    taskEntry,
    fixture,
    budgets,
    privateDir,
    signal,
    startArgs: {
      kind,
      cli: modelConfig.cli,
      argv: invocation.argv,
      env: invocation.env,
      stdinText: invocation.promptChannel === 'stdin' ? prompt : null,
      workspace: ws,
      agentHome: path.join(privateDir, 'agent-home'),
      credential: cred.mode === 'none' ? null : cred.delivery,
      mounts: plan.mounts,
    },
  };
  // Non-secret recovery state, written before the CLI starts (section 4.6).
  const stateFile = path.join(privateDir, 'state.json');
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const state = {
    cli: modelConfig.cli,
    agentHome: ctx.startArgs.agentHome,
    container: null,
    hostPath: credential?.hostPath ?? null,
    backupDir: credential?.backupDir ?? null,
    credential:
      cred.mode === 'refresh-capable-copy'
        ? recoveryState(credential.provider, cred.original)
        : null,
  };
  writeJson(stateFile, state);
  ctx.onStarted = (handle) => {
    if (handle.containerName)
      writeJson(stateFile, { ...state, container: handle.containerName });
  };
  const agentStartedAt = nowIso();
  const run = await agentPhase(ctx);
  timestamps.agent = {
    startedAt: agentStartedAt,
    endedAt: nowIso(),
    durationMs: run.agentMs,
  };

  // Teardown (section 4.6): kill everything, export before tmpfs destruction.
  run.handle.killAll();
  let credentialExport = 'not-applicable';
  let haltProvider = false;
  let exportError = null;
  if (cred.mode === 'refresh-capable-copy') {
    const p = PROVIDERS[credential.provider];
    const exported = run.handle.exportCredential(p.containerFile);
    if (exported.bytes != null)
      redaction.addCredentialDocument(exported.bytes.toString('utf8'));
    const decision = decideWriteBack({
      provider: credential.provider,
      original: cred.original,
      exported,
      hostPath: credential.hostPath,
      backupDir: credential.backupDir,
    });
    credentialExport = decision.outcome;
    haltProvider = decision.haltProvider;
    if (decision.outcome === 'failed') exportError = decision.reason;
  }
  // The proxy log leaves with the proxy container: read it first.
  const proxyLog = run.handle.proxyLog?.() ?? null;
  run.handle.destroy();
  redaction.seal();

  const s = run.summary;
  const rawText = fs.readFileSync(run.rawFile, 'utf8');
  const nodeModulesAfter = nodeModulesDigest(ws);

  // Breaches: detect-and-fail capabilities, tool policy, credential leaks.
  const breaches = detectBreaches({
    plan,
    toolCalls: s.toolCalls,
    policyEvents: s.policyEvents,
    nodeModules: { before: nodeModulesBefore, after: nodeModulesAfter },
  });
  const secrets = redaction.list();
  const leakIn = (text) => secrets.some((x) => text.includes(x));
  const finalMessage = s.finalMessage ?? '';
  const wsLeak = (() => {
    const found = [];
    const walk = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (
          e.isFile() &&
          leakIn(fs.readFileSync(path.join(dir, e.name)).toString('latin1'))
        )
          found.push(r);
      }
    };
    if (secrets.length > 0) walk(ws);
    return found;
  })();
  if (
    secrets.length > 0 &&
    (leakIn(rawText) || leakIn(finalMessage) || wsLeak.length > 0)
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
      resourceLimit: run.handle.resourceLimit?.() ?? false,
      harnessError: exportError ? 'credential-export-failed' : null,
    },
    anomalies: s.anomalies,
    configMismatch,
    fidelity: s.fidelity.status,
    breaches,
    rateLimit: s.signals.rateLimit,
  });

  // Oracle inputs (graded copies are taken before any redaction).
  const filesDir = path.join(privateDir, 'oracle-inputs');
  fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  const files = {
    response: path.join(filesDir, 'final-message.txt'),
    transcript: path.join(filesDir, 'transcript.jsonl'),
    observations: path.join(filesDir, 'observations.json'),
  };
  fs.writeFileSync(files.response, finalMessage);
  fs.writeFileSync(
    files.transcript,
    s.transcript.map((e) => JSON.stringify(e)).join('\n') +
      (s.transcript.length ? '\n' : ''),
  );
  fs.writeFileSync(files.observations, JSON.stringify(run.eventStatus));

  // Evidence archives, then grading of exact copies.
  const exclude = oracleIgnoredGlobs();
  const baselineManifest = phase('archive-baseline', () =>
    archiveTree({
      root: baseline,
      dest: path.join(attemptDir, 'evidence/baseline'),
      secrets,
    }),
  );
  const finalManifest = phase('archive-final', () =>
    archiveTree({
      root: ws,
      dest: path.join(attemptDir, 'evidence/final'),
      secrets,
    }),
  );
  let gradingOut = {
    verdict: 'not-graded',
    passes: [{ pass: 'G1', status: 'not-run', verdict: null }],
    result: null,
    gradingMs: 0,
  };
  if (classification.valid) {
    const gradeRoot = path.join(workRoot, 'grading');
    const g = {
      root: gradeRoot,
      baseline: path.join(gradeRoot, 'baseline'),
      workspace: path.join(gradeRoot, 'workspace'),
      files,
    };
    copyTree(baseline, g.baseline, { includeEmptyDirs: true, exclude });
    copyTree(ws, g.workspace, { includeEmptyDirs: true, exclude });
    gradingOut = phase('grading', () =>
      grade({ taskEntry, epoch, grading, kind }, g),
    );
  }
  const verdict = gradingOut.verdict;
  if (verdict === 'error' && classification.valid) {
    classification.class = 'harness';
    classification.code = 'evaluate-error';
    classification.valid = false;
    classification.termination = 'harness';
    classification.retry = false;
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

  // Persist redacted artifacts, then scan.
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
  persist('prompt.md', prompt, STREAM_BOUND);
  persist('stream.jsonl', rawText, STREAM_BOUND);
  persist('stderr.log', fs.readFileSync(run.errFile, 'utf8'), STDERR_BOUND);
  const transcriptArtifact = persist(
    'transcript.jsonl',
    fs.readFileSync(files.transcript, 'utf8'),
    opts.bounds?.stream ?? STREAM_BOUND,
  );
  const messageArtifact = persist(
    'final-message.txt',
    finalMessage,
    opts.bounds?.stream ?? STREAM_BOUND,
  );
  persist(
    'observations.json',
    JSON.stringify(run.eventStatus, null, 2),
    STREAM_BOUND,
  );
  if (proxyLog != null) persist('proxy.jsonl', proxyLog, STDERR_BOUND);
  if (gradingOut.result)
    persist(
      'evaluation.json',
      JSON.stringify(gradingOut.result, null, 2),
      STREAM_BOUND,
    );
  fs.rmSync(privateDir, { recursive: true, force: true });
  const purged = scanAndPurge(attemptDir, redaction);

  const { completeness, affected } = evidenceCompleteness({
    baselineManifest,
    finalManifest,
    graderInputs: [transcriptArtifact, messageArtifact],
    purged,
  });

  const normalizedArgv = invocation.argv.map((a) =>
    a === prompt ? '<prompt>' : a,
  );
  const projectionInput = projectionFor({
    task: taskEntry,
    plan,
    invocation,
    normalizedArgv,
    prompt,
    modelConfig,
  });
  const integrityContested = opts.contested === true;

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
      env: Object.fromEntries(
        Object.entries({
          ...invocation.env,
          ...(cred.mode === 'none'
            ? {}
            : Object.fromEntries(
                Object.keys(cred.delivery.env).map((k) => [k, '<secret>']),
              )),
        }),
      ),
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
      limitFired:
        run.stopping === 'timeout'
          ? 'timeout'
          : run.maxToolCallsHit
            ? 'max-tool-calls'
            : classification.code === 'cli-max-turns'
              ? 'cli-max-turns'
              : null,
    },
    productBuild: identity.productBuild,
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
    environment: identity.environment,
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
      proxy: summarizeProxyLog(proxyLog),
      contested: integrityContested,
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
      export: credentialExport,
      haltProvider,
      source: credential?.source ?? null,
      ...(cred.accessOnlyRefused ? { accessOnlyRefused: true } : {}),
    },
    evidence: {
      completeness,
      replay: replayExactness({ completeness, affectedPaths: affected }).label,
      affectedPaths: affected,
      gradedSetDigest: finalManifest.setDigest,
      purged,
      artifacts: art,
    },
    classificationDetail: {
      haltProvider: classification.haltProvider || haltProvider,
      haltMatrix: classification.haltMatrix,
      retry: classification.retry,
    },
  };
  writeJson(path.join(attemptDir, 'record.json'), record);
  return { record };
}
