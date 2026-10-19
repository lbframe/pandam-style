/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Review round 1, classes B1-B4 (DESIGN.md sections 4.2, 4.6, 6 and 11.2):
// host handling of agent-controlled paths, redaction scope and private
// working copies, the credential source policy, and crash recovery with
// durable refusals. Each test reproduces the reviewer's case and its class.
// No Docker, no provider, synthetic credentials only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  MODELS,
  STUB_GRADING,
  claudeCredentialDoc,
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  recordsOf,
  runFixture,
  syntheticCredentialDir,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { writeReport } from '../bin/pms-agentic-runner.mjs';
import { runAttempt } from '../src/attempt.mjs';
import {
  checkCredentialSource,
  credentialConfigErrors,
  credentialFromConfig,
  readCredentialFile,
  recoveryState,
} from '../src/credentials.mjs';
import { LocalFixtureExecutor } from '../src/executors/local.mjs';
import { recoverStale } from '../src/recovery.mjs';
import { RedactionSet, scanFile } from '../src/redact.mjs';
import {
  activeRefusals,
  recordRefusal,
  resolveRefusal,
} from '../src/refusals.mjs';
import * as safe from '../src/safefs.mjs';
import {
  applyEventSafe,
  nodeModulesState,
  sampleWorkspace,
  stageWorkspace,
} from '../src/workspace.mjs';
import { CORPUS_ROOT, readJson } from '../src/util.mjs';
import { loadCorpus, findTask } from '../../src/corpus.mjs';

const EVENT_TASK = 'concurrent-edits-failure-same-line-conflict';

function sentinel() {
  const dir = tmpDir('outside');
  const file = path.join(dir, 'sentinel.txt');
  fs.writeFileSync(file, "const field = recipes.field({ size: 'regular' });\n");
  return { dir, file, before: fs.readFileSync(file, 'utf8') };
}

// ---------------------------------------------------------------- B1

test('B1 real corpus event through a workspace link: outside file untouched, event not applied', async () => {
  const s = sentinel();
  const target = 'src/components/TransferForm.tsx';
  const steps = [
    claudeInit(),
    { run: `rm ${target} && ln -s ${s.file} ${target}`, as: 'edit' },
    { run: 'ls', as: 'ls' },
    { run: 'ls src', as: 'ls src' },
    claudeText('done'),
    claudeResult({ text: 'done' }),
  ];
  const file = writeScenario(tmpDir('b1'), 's', { steps });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [EVENT_TASK] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(
    fs.readFileSync(s.file, 'utf8'),
    s.before,
    'the event must not write through the link',
  );
  assert.deepEqual(r.eventErrors, { 'teammate-decision': 'ELOOP' });
  const obs = readJson(
    path.join(
      out.matrixDir,
      'cells',
      EVENT_TASK,
      MODELS.haiku.key,
      'rep-1/attempt-1/observations.json',
    ),
  );
  assert.equal(obs['event:teammate-decision'], 'not-applied');
});

test('B1 every event step kind is confined: write, delete, rename, copy, replace through links and parents', () => {
  const s = sentinel();
  const ws = tmpDir('ws');
  fs.mkdirSync(path.join(ws, 'src'));
  fs.symlinkSync(s.dir, path.join(ws, 'linkdir'));
  fs.symlinkSync(s.file, path.join(ws, 'src/link.txt'));
  const loaded = loadCorpus(CORPUS_ROOT);
  const base = findTask(loaded, EVENT_TASK);
  const entry = (steps) => ({
    ...base,
    task: {
      ...base.task,
      workspace: {
        ...base.task.workspace,
        events: [
          { id: 'e', trigger: { type: 'after-tool-calls', count: 1 }, steps },
        ],
      },
    },
  });
  const source = path.relative(
    base.dir,
    path.join(CORPUS_ROOT, 'tasks', EVENT_TASK, 'task.json'),
  );
  const cases = [
    [{ step: 'write', path: 'linkdir/sentinel.txt', source }],
    [{ step: 'write', path: 'src/link.txt', source }],
    [{ step: 'delete', path: 'linkdir/sentinel.txt' }],
    [{ step: 'rename', path: 'linkdir/sentinel.txt', to: 'stolen.txt' }],
    [{ step: 'copy', path: 'src/link.txt', to: 'copied.txt' }],
    [
      {
        step: 'replace',
        path: 'src/link.txt',
        find: 'regular',
        replace: 'large',
      },
    ],
    [
      {
        step: 'replace',
        path: 'linkdir/sentinel.txt',
        find: 'regular',
        replace: 'large',
      },
    ],
    [{ step: 'write', path: '../escape.txt', source }],
  ];
  for (const steps of cases) {
    assert.throws(
      () => applyEventSafe({ taskEntry: entry(steps), eventId: 'e', root: ws }),
      (e) => ['ELOOP', 'ENOTDIR', 'unsafe-path'].includes(e.code),
      JSON.stringify(steps),
    );
    assert.equal(
      fs.readFileSync(s.file, 'utf8'),
      s.before,
      JSON.stringify(steps),
    );
  }
  assert.ok(!fs.existsSync(path.join(ws, 'copied.txt')));
  // The same steps on real files work.
  fs.writeFileSync(path.join(ws, 'src/real.txt'), 'size: regular');
  assert.deepEqual(
    applyEventSafe({
      taskEntry: entry([
        {
          step: 'replace',
          path: 'src/real.txt',
          find: 'regular',
          replace: 'large',
        },
      ]),
      eventId: 'e',
      root: ws,
    }),
    { applied: true },
  );
  assert.equal(
    fs.readFileSync(path.join(ws, 'src/real.txt'), 'utf8'),
    'size: large',
  );
});

test('B1 directory swaps: an opened directory stays the one opened; a swapped component is never followed', () => {
  const s = sentinel();
  const ws = tmpDir('swap');
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'sub/f.txt'), 'inside');
  const root = safe.openRoot(ws);
  const sub = safe.openDir(root, 'sub');
  // Swap after open: the walk continues in the directory it opened.
  fs.renameSync(path.join(ws, 'sub'), path.join(ws, 'moved'));
  fs.symlinkSync(s.dir, path.join(ws, 'sub'));
  assert.equal(safe.readFile(sub, 'f.txt').toString(), 'inside');
  assert.throws(
    () => safe.readFile(root, 'sub/sentinel.txt'),
    (e) => ['ENOTDIR', 'ELOOP'].includes(e.code),
  );
  assert.throws(
    () => safe.openDir(root, 'sub'),
    (e) => ['ENOTDIR', 'ELOOP'].includes(e.code),
  );
  fs.closeSync(sub);
  fs.closeSync(root);
  // Samples and staging never depend on outside contents.
  const a = sampleWorkspace(ws).digest;
  fs.appendFileSync(s.file, 'changed outside');
  assert.equal(sampleWorkspace(ws).digest, a);
  const staged = stageWorkspace(ws, path.join(tmpDir('stage'), 'out'));
  assert.deepEqual(
    staged.entries.find((e) => e.path === 'sub'),
    {
      path: 'sub',
      type: 'symlink',
      mode: staged.entries.find((e) => e.path === 'sub').mode,
      target: s.dir,
    },
  );
  assert.ok(!staged.entries.some((e) => e.path.startsWith('sub/')));
});

test('B1 root links: node_modules and the workspace root are never followed', () => {
  const s = sentinel();
  const ws = tmpDir('rootlink');
  fs.symlinkSync(s.dir, path.join(ws, 'node_modules'));
  const state = nodeModulesState(ws);
  assert.equal(state, `symlink:${s.dir}`);
  fs.appendFileSync(s.file, 'more');
  assert.equal(nodeModulesState(ws), state, 'outside contents never hashed');
  const linkRoot = path.join(tmpDir('lr'), 'ws');
  fs.symlinkSync(s.dir, linkRoot);
  assert.throws(
    () => safe.openRoot(linkRoot),
    (e) => ['ELOOP', 'ENOTDIR'].includes(e.code),
  );
  assert.equal(sampleWorkspace(linkRoot).digest, null);
});

function attemptOpts({
  executor,
  install,
  credential = null,
  stateDir,
  extra = {},
}) {
  const loaded = loadCorpus(CORPUS_ROOT);
  const taskEntry = findTask(loaded, 'discovery-positive-card-vocabulary');
  const root = tmpDir('att');
  const lock = readJson(path.join(CORPUS_ROOT, 'corpus.lock.json'));
  return {
    root,
    opts: {
      kind: 'adapter-fixture',
      matrixId: 'm',
      cell: { taskId: taskEntry.name, modelKey: MODELS.haiku.key },
      repetition: 1,
      attempt: 1,
      modelConfig: MODELS.haiku,
      taskEntry,
      fixture: loaded.fixtures.get(taskEntry.task.workspace.fixture),
      corpusInfo: {
        epoch: 'alpha1',
        corpusVersion: '1.4.3',
        corpusLockSha256: '0'.repeat(64),
        taskDigests: lock.development,
      },
      executor,
      paths: {
        attemptDir: path.join(root, 'm/cells/a'),
        privateDir: path.join(root, 'm/.private/a'),
        workRoot: path.join(root, 'm/.work/a'),
      },
      budgets: {
        timeoutSeconds: 30,
        maxToolCalls: 30,
        cliMaxTurns: 60,
        graceInterruptMs: 200,
        graceTerminateMs: 200,
        workspaceBytesCap: 1e9,
        bounds: {
          stream: 1 << 20,
          stderr: 1 << 16,
          graderInput: 1 << 20,
          evidence: 1 << 26,
          workspace: 1e9,
        },
      },
      stateDir: stateDir ?? path.join(root, 'state'),
      credential,
      identity: {
        harness: {
          commit: null,
          clean: false,
          runnerTreeDigest: 'r',
          harnessDepsLockSha256: 'h',
          corpusLockSha256: 'c',
        },
        productBuild: { digest: null },
        environment: {},
      },
      grading: STUB_GRADING(),
      install,
      projectionFor: () => ({
        key: 'k',
        projectionVersion: 'v',
        projection: { model: { normalizedArgv: [] } },
      }),
      ...extra,
    },
  };
}

test('B1/B2 teardown and failure paths: working copies removed on every exit, unverified cleanup keeps state and refuses', async () => {
  // An exception before the agent: nothing unredacted survives.
  const failing = attemptOpts({
    executor: new LocalFixtureExecutor({
      fakeBinary: 'unused',
      scenario: 'unused',
    }),
    install: () => {
      throw Object.assign(new Error('synthetic install failure'), {
        code: 'install',
      });
    },
  });
  await assert.rejects(runAttempt(failing.opts), /synthetic install failure/);
  assert.equal(fs.existsSync(failing.opts.paths.workRoot), false);
  assert.equal(fs.existsSync(failing.opts.paths.privateDir), false);
  // A teardown whose cleanup cannot be verified.
  const file = writeScenario(tmpDir('td'), 's', {
    steps: [claudeInit(), claudeText('x'), claudeResult()],
  });
  class Unverified extends LocalFixtureExecutor {
    start(args) {
      const h = super.start(args);
      return {
        ...h,
        destroy: () => {
          h.destroy();
          return false;
        },
      };
    }
  }
  const ex = new Unverified({
    fakeBinary: path.join(CORPUS_ROOT, 'runner/fixtures/bin/fake-cli.mjs'),
    scenario: file,
  });
  const t = attemptOpts({ executor: ex });
  const out = await runAttempt(t.opts);
  assert.equal(out.record.outcome.code, 'container');
  assert.equal(fs.existsSync(t.opts.paths.workRoot), false);
  assert.deepEqual(
    fs.readdirSync(t.opts.paths.privateDir),
    ['state.json'],
    'only the recovery state is kept',
  );
  assert.ok(
    activeRefusals(t.opts.stateDir).claude.events[0].reason.includes(
      'cleanup not verified',
    ),
  );
});

// ---------------------------------------------------------------- B2

test('B2 a secret in a structured stream field is redacted in record.json; working copies are private and removed', async () => {
  const access = 'sk-ant-oat01-ACCESS-aaaaaaaaaaaaaaaaaaaaaaaa';
  const cred = syntheticCredentialDir(
    'claude',
    claudeCredentialDoc({ access }),
  );
  const result = claudeResult({ text: 'done' });
  result.emit.usage = { ...result.emit.usage, extra: access };
  const steps = [
    claudeInit(),
    // Modes of the working directories, seen from inside the run.
    {
      run: 'stat -c %a .. ../.. && echo LEAKED-WS-SECRET > leak-in-ws.txt',
      as: 'stat',
    },
    claudeText('done'),
    result,
  ];
  const file = writeScenario(tmpDir('b2'), 's', { steps });
  const config = fixtureConfig({
    tasks: ['composition-positive-order-summary'],
    credentials: {
      claude: {
        mode: 'access-only',
        synthetic: true,
        source: { configDir: cred.dir, account: 'synthetic' },
      },
      codex: { mode: 'none', source: null },
    },
  });
  const out = await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  const recordText = fs.readFileSync(
    path.join(
      out.matrixDir,
      'cells/composition-positive-order-summary/claude-haiku/rep-1/attempt-1/record.json',
    ),
    'utf8',
  );
  assert.ok(!recordText.includes(access), 'record.json redacted');
  assert.equal(r.metrics.tokens.raw.resultUsage.extra, '[REDACTED]');
  const stream = fs.readFileSync(
    path.join(
      out.matrixDir,
      'cells/composition-positive-order-summary/claude-haiku/rep-1/attempt-1/stream.jsonl',
    ),
    'utf8',
  );
  assert.match(
    stream,
    /700\\n700/,
    'workRoot and .work are 0700 while the agent runs',
  );
  assert.equal(fs.existsSync(path.join(out.matrixDir, '.work')), false);
  assert.equal(fs.existsSync(path.join(out.matrixDir, '.private')), false);
  for (const f of ['matrix.json', 'outcomes.json'])
    assert.equal(
      scanFile(path.join(out.matrixDir, f), new RedactionSet()),
      false,
      f,
    );
});

test('B2 derived reports are redacted and scanned', () => {
  const dir = tmpDir('rep');
  const report = {
    schema: 'pms-agentic-run-report/v1',
    kind: 'adapter-fixture',
    synthetic: true,
    matrixId: 'm',
    productBuild: null,
    trustedTree: null,
    comparabilityKeys: [],
    cells: [],
    perModel: {},
    breaches: [],
    unsupported: [],
    missing: [
      {
        taskId: 't',
        model: 'm',
        repetition: 1,
        status: 'missing',
        reason: `harness error at ${process.env.HOME}/x with Bearer abcdefghijklmnopqrstuvwxyz0123`,
      },
    ],
    infrastructure: {},
    halted: {},
  };
  writeReport(report, {
    json: path.join(dir, 'r.json'),
    markdown: path.join(dir, 'r.md'),
  });
  const text = fs.readFileSync(path.join(dir, 'r.json'), 'utf8');
  assert.ok(!text.includes(process.env.HOME));
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz0123'));
});

test('B2 crash leftovers: unredacted working copies are deleted by recovery', () => {
  const runs = tmpDir('leftover');
  const work = path.join(runs, 'm/.work/a/workspace');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(work, 'secret.txt'),
    'sk-ant-oat01-LEFT-aaaaaaaaaaaaaaaaaaaa',
  );
  fs.mkdirSync(path.join(runs, 'm/.private/a'), { recursive: true });
  fs.writeFileSync(path.join(runs, 'm/.private/a/stream.raw'), 'unredacted');
  recoverStale(runs, { stateDir: path.join(runs, '.state') });
  assert.equal(fs.existsSync(path.join(runs, 'm/.work')), false);
  assert.equal(fs.existsSync(path.join(runs, 'm/.private')), false);
});

test('B2 leak scans read in bounded chunks and find secrets across chunk borders', () => {
  const set = new RedactionSet({
    home: '/nonexistent-home',
    user: 'nobody-user',
  });
  const secret = 'sk-ant-oat01-BORDER-bbbbbbbbbbbbbbbbbbbbbbbb';
  set.addSecret(secret);
  const file = path.join(tmpDir('chunk'), 'big.bin');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.alloc((1 << 20) - 10, 0x41));
  fs.writeSync(fd, secret);
  fs.writeSync(fd, Buffer.alloc(1 << 20, 0x42));
  fs.closeSync(fd);
  assert.equal(scanFile(file, set, { patterns: false }), true);
});

// ---------------------------------------------------------------- B3

function fakeHome() {
  const home = tmpDir('home');
  fs.mkdirSync(path.join(home, '.claude-t3/team-2'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude-t3/team-2/.credentials.json'),
    '{}',
    { mode: 0o600 },
  );
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), '{}', {
    mode: 0o600,
  });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/auth.json'), '{}', { mode: 0o600 });
  return home;
}

const pbConfig = (
  claude,
  codex = {
    mode: 'access-only',
    source: { configDir: '~/.codex', account: 'chatgpt' },
  },
) => ({ kind: 'provider-backed', credentials: { claude, codex } });

test('B3 the claude-team-2 source is the only Claude source; aliases, links and labels are refused before any read', () => {
  const home = fakeHome();
  const team2 = {
    mode: 'access-only',
    source: { configDir: '~/.claude-t3/team-2', account: 'claude-team-2' },
  };
  const ok = credentialFromConfig(pbConfig(team2), 'claude', { home });
  checkCredentialSource(ok, { home });
  // Absolute form of the same directory is the same source.
  checkCredentialSource(
    credentialFromConfig(
      pbConfig({
        ...team2,
        source: {
          ...team2.source,
          configDir: path.join(home, '.claude-t3/team-2'),
        },
      }),
      'claude',
      { home },
    ),
    { home },
  );
  const errs = (claude) =>
    credentialConfigErrors('claude', claude, { kind: 'provider-backed', home });
  assert.ok(
    errs({
      ...team2,
      source: { configDir: '~/.claude', account: 'claude-team-2' },
    }).some((e) => /must be ~\/\.claude-t3\/team-2/.test(e)),
    'the reviewer case: ~/.claude labelled claude-team-2',
  );
  assert.ok(
    errs({
      ...team2,
      source: { configDir: '~/.claude-t3/team-2', account: 'personal' },
    }).some((e) => /account must be claude-team-2/.test(e)),
  );
  assert.ok(
    errs({
      ...team2,
      source: {
        configDir: '~/.claude-t3/team-2/../team-2',
        account: 'claude-team-2',
      },
    }).length === 0,
    'lexical normalization',
  );
  assert.ok(
    errs({
      ...team2,
      source: { configDir: '~/.claude-t3/team-3', account: 'claude-team-2' },
    }).length > 0,
  );
  // Symbolic links anywhere in the path are refused (filesystem check).
  const linkHome = tmpDir('linkhome');
  fs.symlinkSync(
    path.join(home, '.claude-t3'),
    path.join(linkHome, '.claude-t3'),
  );
  assert.throws(
    () =>
      checkCredentialSource(
        credentialFromConfig(pbConfig(team2), 'claude', { home: linkHome }),
        { home: linkHome },
      ),
    (e) => e.code === 'credential-policy',
  );
  const aliasHome = tmpDir('aliashome');
  fs.mkdirSync(path.join(aliasHome, '.claude-t3'));
  fs.symlinkSync(
    path.join(home, '.claude'),
    path.join(aliasHome, '.claude-t3/team-2'),
  );
  assert.throws(
    () =>
      checkCredentialSource(
        credentialFromConfig(pbConfig(team2), 'claude', { home: aliasHome }),
        { home: aliasHome },
      ),
    (e) => e.code === 'credential-policy',
  );
  // Codex: ~/.codex only.
  assert.ok(
    credentialConfigErrors(
      'codex',
      {
        mode: 'access-only',
        source: { configDir: '~/.codex-other', account: 'x' },
      },
      { kind: 'provider-backed', home },
    ).length > 0,
  );
  checkCredentialSource(
    credentialFromConfig(pbConfig(team2), 'codex', { home }),
    { home },
  );
  // Synthetic sources: adapter fixtures only.
  assert.ok(
    credentialConfigErrors(
      'claude',
      { ...team2, synthetic: true },
      { kind: 'provider-backed', home },
    ).some((e) => /adapter-fixture matrices only/.test(e)),
  );
  assert.deepEqual(
    credentialConfigErrors(
      'claude',
      {
        mode: 'access-only',
        synthetic: true,
        source: { configDir: '/tmp/x', account: 's' },
      },
      { kind: 'adapter-fixture', home },
    ),
    [],
  );
});

test('B3 recovery re-checks the policy before writing back', () => {
  const home = fakeHome();
  const cred = syntheticCredentialDir('claude', claudeCredentialDoc());
  const original = readCredentialFile(cred.file);
  const runs = tmpDir('rpol');
  const dir = path.join(runs, 'm/.private/a');
  fs.mkdirSync(path.join(dir, 'home/.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'home/.claude/.credentials.json'),
    JSON.stringify(
      claudeCredentialDoc({
        refresh: 'sk-ant-ort01-NEW-cccccccccccccccccccccccc',
      }),
    ),
  );
  // A non-synthetic state pointing outside the policy (a forged state file).
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      kind: 'provider-backed',
      cli: 'claude',
      provider: 'claude',
      agentHome: path.join(dir, 'home'),
      resources: null,
      synthetic: false,
      hostPath: cred.file,
      backupDir: path.join(runs, 'b'),
      credential: recoveryState('claude', original),
    }),
  );
  const stateDir = path.join(runs, '.state');
  const report = recoverStale(runs, { stateDir });
  assert.equal(report[0].credential, 'not-written');
  assert.deepEqual(fs.readFileSync(cred.file), original.bytes);
  assert.match(
    activeRefusals(stateDir).claude.events[0].reason,
    /source policy/,
  );
  void home;
});

// ---------------------------------------------------------------- B4

// The daemon's definitive answers for an absent object (observed, 29.2.1).
const absentMessage = (kind, name) =>
  kind === 'network'
    ? `Error response from daemon: network ${name} not found`
    : `Error response from daemon: No such container: ${name}`;

function dockerStub({ survivors = [] } = {}) {
  const calls = [];
  const removed = new Set();
  const fn = (args) => {
    calls.push(args);
    if (args[0] === 'rm')
      for (const c of args.slice(2)) if (!survivors.includes(c)) removed.add(c);
    if (
      args[0] === 'network' &&
      args[1] === 'rm' &&
      !survivors.includes(args[2])
    )
      removed.add(args[2]);
    if (
      (args[0] === 'container' || args[0] === 'network') &&
      args[1] === 'inspect'
    )
      return removed.has(args[2])
        ? { status: 1, stdout: '', stderr: absentMessage(args[0], args[2]) }
        : { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'ps' || (args[0] === 'network' && args[1] === 'ls'))
      return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { fn, calls };
}

function accessOnlyState(runs, label = 'a') {
  const dir = path.join(runs, `m/.private/${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      kind: 'provider-backed',
      cli: 'claude',
      provider: 'claude',
      agentHome: '/run/agent',
      resources: {
        network: `net-${label}`,
        proxy: `proxy-${label}`,
        container: `agent-${label}`,
      },
      synthetic: false,
      hostPath: null,
      credential: null,
    }),
  );
}

test('B4 access-only attempts are recovered too: container, proxy and network removed and verified', () => {
  const runs = tmpDir('b4');
  accessOnlyState(runs);
  const d = dockerStub();
  const stateDir = path.join(runs, '.state');
  const report = recoverStale(runs, { stateDir, docker: d.fn });
  assert.equal(report[0].cleanup, 'verified');
  assert.ok(
    d.calls.some((a) => a[0] === 'exec' && a.includes('SIGKILL')),
    'agent processes killed',
  );
  assert.ok(
    d.calls.some(
      (a) => a[0] === 'rm' && a.includes('agent-a') && a.includes('proxy-a'),
    ),
  );
  assert.ok(
    d.calls.some(
      (a) => a[0] === 'network' && a[1] === 'rm' && a[2] === 'net-a',
    ),
  );
  assert.deepEqual(activeRefusals(stateDir), {});
});

test('B4 an unverified cleanup is a durable refusal that halts later matrices until resolved', async () => {
  const runs = tmpDir('b4b');
  accessOnlyState(runs);
  const stateDir = path.join(runs, '.state');
  const report = recoverStale(runs, {
    stateDir,
    docker: dockerStub({ survivors: ['agent-a'] }).fn,
  });
  assert.equal(report[0].cleanup, 'failed');
  assert.match(
    activeRefusals(stateDir).claude.events[0].reason,
    /not removed: agent-a/,
  );
  const file = writeScenario(tmpDir('b4s'), 's', {
    steps: [claudeInit(), claudeText('x'), claudeResult()],
  });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    stateDir,
  });
  assert.equal(recordsOf(out.matrixDir).length, 0);
  assert.match(out.outcomes[0].reason, /durable refusal/);
  assert.deepEqual(resolveRefusal(stateDir, 'claude'), {
    provider: 'claude',
    resolved: true,
  });
  const again = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    stateDir,
  });
  assert.equal(again.outcomes[0].status, 'done');
});

test('B4 a credential export failure during an attempt is a durable refusal', async () => {
  const cred = syntheticCredentialDir('claude', claudeCredentialDoc());
  const stateDir = path.join(tmpDir('b4c'), 'state');
  const config = fixtureConfig({
    credentials: {
      claude: {
        mode: 'refresh-capable-copy',
        synthetic: true,
        source: { configDir: cred.dir, account: 's' },
      },
      codex: { mode: 'none', source: null },
    },
  });
  const file = writeScenario(tmpDir('b4cs'), 's', {
    steps: [
      claudeInit(),
      { tamperCredential: { file: '.credentials.json', kind: 'symlink' } },
      claudeText('x'),
      claudeResult(),
    ],
  });
  await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    stateDir,
  });
  assert.match(
    activeRefusals(stateDir).claude.events[0].reason,
    /credential export failed: symlink/,
  );
  recordRefusal(stateDir, 'claude', { reason: 'second' });
  assert.equal(activeRefusals(stateDir).claude.events.length, 2);
});

test('B4 the local executor registers its process group before use and recovery kills it', () => {
  const runs = tmpDir('b4d');
  const child = spawnSync(
    'sh',
    ['-c', 'setsid sleep 30 > /dev/null 2>&1 & echo $!'],
    { encoding: 'utf8' },
  );
  const pid = Number(child.stdout.trim());
  // `echo $!` can run before the child's setsid(): wait until its own
  // process group exists (as the executor's does before spawn returns),
  // otherwise a group kill finds nothing and the process survives.
  const pgrpOf = () => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    } catch {
      return null;
    }
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 200 && pgrpOf() !== pid; i += 1)
    Atomics.wait(pause, 0, 0, 25);
  assert.equal(pgrpOf(), pid, 'the sleep leads its own process group');
  const dir = path.join(runs, 'm/.private/a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      kind: 'adapter-fixture',
      cli: 'claude',
      provider: 'claude',
      agentHome: dir,
      resources: { pgid: pid },
      synthetic: true,
      credential: null,
    }),
  );
  const report = recoverStale(runs, { stateDir: path.join(runs, '.state') });
  assert.equal(report[0].cleanup, 'verified');
  assert.throws(
    () => process.kill(pid, 0),
    (e) => e.code === 'ESRCH',
  );
});

test('B2 user-name redaction targets home-directory paths, never words or directories equal to the name', () => {
  const set = new RedactionSet({ home: '/home/runner', user: 'runner' });
  const text =
    '/home/runner/x /Users/runner /mnt/home/runner benchmarks/agentic/runner/src agentic-runner-tests pms-runner runner';
  assert.equal(
    set.redactText(text),
    '~/x /Users/<user> /mnt~ benchmarks/agentic/runner/src agentic-runner-tests pms-runner runner',
  );
});
