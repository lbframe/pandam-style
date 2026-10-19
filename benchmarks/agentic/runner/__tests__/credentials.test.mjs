/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Credentials (DESIGN.md section 4.6): the required per-provider source, mode
// A (access-only), mode B export with compare-and-swap (F44-F50), crash
// recovery and credential leaks (F31). Only synthetic credential files under
// .pms-bench/ are used; no test reads or writes ~/.claude or ~/.codex.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MODELS,
  STUB_GRADING,
  assertSyntheticPath,
  claudeCredentialDoc,
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  syntheticCredentialDir,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import {
  credentialConfigErrors,
  credentialFromConfig,
  readCredentialFile,
  recoveryState,
  tildePath,
} from '../src/credentials.mjs';
import { validateMatrixConfig } from '../src/matrix.mjs';
import { recoverStale } from '../src/recovery.mjs';
import { RedactionSet, encodings } from '../src/redact.mjs';
import { sha256 } from '../src/util.mjs';

const TEAM2 = {
  mode: 'refresh-capable-copy',
  source: {
    configDir: '/home/someone/.claude-t3/team-2',
    account: 'claude-team-2',
  },
};
const ok = [
  claudeText(goodDiscoveryResponse()),
  claudeResult({ text: goodDiscoveryResponse() }),
];
const NEW_REFRESH = 'sk-ant-ort01-ROTATED-cccccccccccccccccccccccc';

async function runWith({
  steps,
  mode = 'refresh-capable-copy',
  fallback,
  doc = claudeCredentialDoc(),
  task,
  extraEnv,
  signal,
  exitCode,
}) {
  const cred = syntheticCredentialDir('claude', doc);
  const config = fixtureConfig({
    models: [MODELS.haiku],
    ...(task ? { tasks: [task] } : {}),
    credentials: {
      claude: {
        mode,
        ...(fallback ? { fallback } : {}),
        synthetic: true,
        source: { configDir: cred.dir, account: 'synthetic-team' },
      },
      codex: { mode: 'none', source: null },
    },
  });
  const file = writeScenario(tmpDir('cred-scn'), 's', {
    steps,
    ...(exitCode != null ? { exitCode } : {}),
  });
  const before = fs.readFileSync(cred.file);
  const out = await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    extraEnv: { PMS_FAKE_HOST_CREDENTIAL: cred.file, ...extraEnv },
    signal,
  });
  return {
    ...out,
    cred,
    before,
    records: recordsOf(out.matrixDir),
    backups: path.join(out.root, '.state/credential-backups/claude'),
  };
}

const refresh = {
  refreshCredential: {
    file: '.credentials.json',
    path: ['claudeAiOauth', 'refreshToken'],
    value: NEW_REFRESH,
  },
};

test('source: required per provider, no default directory', () => {
  const base = fixtureConfig({
    kind: 'provider-backed',
    authorization: 'orchestrator-go',
    budgets: {},
  });
  const noEntry = validateMatrixConfig({
    ...base,
    credentials: { codex: { mode: 'none', source: null } },
  });
  assert.ok(noEntry.some((e) => /credentials\.claude is required/.test(e)));
  assert.ok(
    noEntry.every((e) => !e.includes(path.join(os.homedir(), '.claude'))),
  );
  const noSource = validateMatrixConfig({
    ...base,
    credentials: {
      claude: { mode: 'access-only' },
      codex: { mode: 'none', source: null },
    },
  });
  assert.ok(noSource.some((e) => /source is required/.test(e)));
  const none = credentialConfigErrors(
    'claude',
    { mode: 'none', source: null },
    { kind: 'provider-backed' },
  );
  assert.ok(none.some((e) => /need a credential/.test(e)));
  const relative = credentialConfigErrors(
    'claude',
    { mode: 'access-only', source: { configDir: '.claude', account: 'x' } },
    { kind: 'adapter-fixture' },
  );
  assert.ok(relative.some((e) => /absolute/.test(e)));
  assert.throws(
    () =>
      credentialFromConfig(
        { kind: 'adapter-fixture', credentials: {} },
        'claude',
      ),
    /no default/,
  );
});

test('source: the claude-team-2 config dir resolves to its .credentials.json and is recorded with ~', () => {
  const home = '/home/someone';
  const c = credentialFromConfig(
    {
      kind: 'provider-backed',
      credentials: {
        claude: {
          ...TEAM2,
          source: {
            configDir: '~/.claude-t3/team-2',
            account: 'claude-team-2',
          },
        },
      },
    },
    'claude',
    { home, stateDir: '/state' },
  );
  assert.equal(c.hostPath, '/home/someone/.claude-t3/team-2/.credentials.json');
  assert.deepEqual(c.source, {
    configDir: '~/.claude-t3/team-2',
    file: '.credentials.json',
    account: 'claude-team-2',
  });
  assert.equal(c.backupDir, '/state/credential-backups/claude');
  const x = credentialFromConfig(
    {
      kind: 'provider-backed',
      credentials: {
        codex: {
          mode: 'access-only',
          source: { configDir: '~/.codex', account: 'chatgpt' },
        },
      },
    },
    'codex',
    { home },
  );
  assert.equal(x.hostPath, '/home/someone/.codex/auth.json');
  assert.equal(tildePath('/home/someone/a', home), '~/a');
});

test('source: a missing credential file refuses the matrix before any attempt', async () => {
  const dir = tmpDir('cred-missing');
  const config = fixtureConfig({
    credentials: {
      claude: {
        mode: 'refresh-capable-copy',
        synthetic: true,
        source: { configDir: dir, account: 'synthetic' },
      },
      codex: { mode: 'none', source: null },
    },
  });
  const file = writeScenario(tmpDir('scn'), 's', {
    steps: [claudeInit(), ...ok],
  });
  await assert.rejects(
    runFixture({ config, scenarios: { '*': [file] }, grading: STUB_GRADING() }),
    (e) => e.code === 'credential-source',
  );
});

test('F44 mode B: refreshed token, valid shape, host unchanged -> replaced atomically, backup kept', async () => {
  const r = await runWith({ steps: [claudeInit(), refresh, ...ok] });
  const rec = r.records[0];
  assert.equal(rec.credential.mode, 'refresh-capable-copy');
  assert.equal(rec.credential.export, 'host-replaced');
  assert.deepEqual(rec.credential.source, {
    configDir: tildePath(r.cred.dir),
    file: '.credentials.json',
    account: 'synthetic-team',
    synthetic: true,
  });
  const now = JSON.parse(fs.readFileSync(r.cred.file, 'utf8'));
  assert.equal(now.claudeAiOauth.refreshToken, NEW_REFRESH);
  assert.equal(fs.statSync(r.cred.file).mode & 0o777, 0o600);
  const backups = fs.readdirSync(r.backups);
  assert.equal(backups.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(r.backups, backups[0])), r.before);
  assert.equal(
    fs.statSync(path.join(r.backups, backups[0])).mode & 0o777,
    0o600,
  );
  // Matrix-level record of the source, without contents.
  const matrix = JSON.parse(
    fs.readFileSync(path.join(r.matrixDir, 'matrix.json'), 'utf8'),
  );
  assert.equal(matrix.credentialSources.claude.account, 'synthetic-team');
  assert.ok(
    !fs
      .readFileSync(path.join(r.matrixDir, 'matrix.json'), 'utf8')
      .includes('sk-ant-'),
  );
});

test('F45 mode B: no refresh -> host untouched', async () => {
  const r = await runWith({ steps: [claudeInit(), ...ok] });
  assert.equal(r.records[0].credential.export, 'unchanged');
  assert.deepEqual(fs.readFileSync(r.cred.file), r.before);
  assert.equal(fs.existsSync(r.backups), false);
});

test('F46 every export failure leaves the host untouched and halts the provider', async () => {
  for (const kind of [
    'symlink',
    'fifo',
    'oversize',
    'invalid-json',
    'shape',
    'missing',
  ]) {
    const r = await runWith({
      steps: [
        claudeInit(),
        refresh,
        { tamperCredential: { file: '.credentials.json', kind } },
        ...ok,
      ],
      task: undefined,
    });
    const rec = r.records[0];
    assert.equal(rec.credential.export, 'failed', kind);
    assert.equal(rec.credential.haltProvider, true, kind);
    assert.equal(rec.outcome.code, 'credential-export-failed', kind);
    assert.deepEqual(fs.readFileSync(r.cred.file), r.before, kind);
  }
});

test('F47 host file changed during the attempt: no overwrite, conflict, halt', async () => {
  const userRefresh = JSON.stringify(
    claudeCredentialDoc({
      refresh: 'sk-ant-ort01-USER-dddddddddddddddddddddddd',
    }),
  );
  const r = await runWith({
    steps: [claudeInit(), { touchHostCredential: userRefresh }, refresh, ...ok],
    task: 'discovery-positive-card-vocabulary',
  });
  const rec = r.records[0];
  assert.equal(rec.credential.export, 'conflict-not-written');
  assert.equal(rec.credential.haltProvider, true);
  assert.equal(fs.readFileSync(r.cred.file, 'utf8'), userRefresh);
});

test('F48 cancellation during the agent phase still exports, then cleans up', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const r = await runWith({
    steps: [claudeInit(), refresh, { waitForever: true }],
    signal: ac.signal,
  });
  const rec = r.records[0];
  assert.equal(rec.outcome.code, 'cancelled');
  assert.equal(rec.credential.export, 'host-replaced');
  assert.equal(
    JSON.parse(fs.readFileSync(r.cred.file, 'utf8')).claudeAiOauth.refreshToken,
    NEW_REFRESH,
  );
  assert.equal(fs.existsSync(path.join(r.matrixDir, '.private')), false);
});

test('F49 crash with a live attempt: recovery exports, writes back and cleans at the next start', () => {
  const cred = syntheticCredentialDir('claude', claudeCredentialDoc());
  const original = readCredentialFile(cred.file);
  const runs = tmpDir('recovery');
  const attempt = path.join(runs, 'm-1/.private/task--model--1--1');
  const agentHome = path.join(attempt, 'agent-home');
  fs.mkdirSync(path.join(agentHome, '.claude'), { recursive: true });
  const refreshed = claudeCredentialDoc({ refresh: NEW_REFRESH });
  fs.writeFileSync(
    path.join(agentHome, '.claude/.credentials.json'),
    JSON.stringify(refreshed),
  );
  fs.writeFileSync(path.join(attempt, 'stream.raw'), 'unredacted');
  fs.writeFileSync(
    path.join(attempt, 'state.json'),
    JSON.stringify({
      kind: 'adapter-fixture',
      cli: 'claude',
      provider: 'claude',
      agentHome,
      resources: null,
      synthetic: true,
      hostPath: assertSyntheticPath(cred.file),
      backupDir: path.join(runs, 'backups'),
      credential: recoveryState('claude', original),
    }),
  );
  const report = recoverStale(runs, { stateDir: path.join(runs, '.state') });
  assert.deepEqual(
    report.map((x) => x.credential),
    ['host-replaced'],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(cred.file, 'utf8')).claudeAiOauth.refreshToken,
    NEW_REFRESH,
  );
  assert.equal(fs.existsSync(attempt), false, 'private files deleted');
});

test('F50 a refreshed token printed before the export is never persisted unredacted', async () => {
  const r = await runWith({
    steps: [
      claudeInit(),
      refresh,
      { printCredential: { file: '.credentials.json' } },
      ...ok,
    ],
  });
  const rec = r.records[0];
  assert.equal(rec.outcome.code, 'credential-leak');
  const dir = path.join(
    r.matrixDir,
    'cells',
    rec.cell.taskId,
    rec.cell.modelKey,
    'rep-1',
    'attempt-1',
  );
  const all = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(d, e.name));
      else all.push(fs.readFileSync(path.join(d, e.name), 'latin1'));
  };
  walk(r.matrixDir);
  for (const secret of [
    NEW_REFRESH,
    'sk-ant-ort01-REFRESH-bbbbbbbbbbbbbbbbbbbbbb',
    'sk-ant-oat01-ACCESS-aaaaaaaaaaaaaaaaaaaaaaaa',
  ])
    for (const form of encodings(secret))
      assert.ok(
        all.every((t) => !t.includes(form)),
        `${form} persisted`,
      );
  assert.match(
    fs.readFileSync(path.join(dir, 'stream.jsonl'), 'utf8'),
    /\[REDACTED\]/,
  );
});

test('F31 a secret inside an oracle-relevant file: redacted evidence, non-exact replay, credential-leak', async () => {
  const r = await runWith({
    steps: [
      claudeInit(),
      {
        run: 'cp "$CLAUDE_CONFIG_DIR/.credentials.json" src/leak.json',
        as: 'cp creds src/leak.json',
      },
      ...ok,
    ],
    task: 'composition-positive-order-summary',
  });
  const rec = r.records[0];
  assert.equal(rec.outcome.code, 'credential-leak');
  assert.equal(rec.evidence.completeness, 'redacted');
  assert.equal(rec.evidence.replay, 'non-exact');
  assert.ok(rec.evidence.affectedPaths.includes('src/leak.json'));
});

test('mode A: access token only in the environment, no refresh token in the agent home', async () => {
  const check =
    'test ! -e "$CLAUDE_CONFIG_DIR/.credentials.json" && test -n "$CLAUDE_CODE_OAUTH_TOKEN"';
  const r = await runWith({
    mode: 'access-only',
    steps: [claudeInit(), { run: check, as: 'ls' }, ...ok],
    task: 'discovery-positive-card-vocabulary',
  });
  const rec = r.records[0];
  assert.equal(rec.credential.mode, 'access-only');
  assert.equal(rec.credential.export, 'not-applicable');
  assert.equal(rec.modelConfig.env.CLAUDE_CODE_OAUTH_TOKEN, '<secret>');
  const stream = fs.readFileSync(
    path.join(
      r.matrixDir,
      'cells',
      rec.cell.taskId,
      rec.cell.modelKey,
      'rep-1/attempt-1/stream.jsonl',
    ),
    'utf8',
  );
  assert.match(stream, /"is_error":false/);
  assert.deepEqual(fs.readFileSync(r.cred.file), r.before);
});

test('mode A with too short a lifetime: mode B only if declared, otherwise the provider halts', async () => {
  const doc = claudeCredentialDoc({ expiresAt: Date.now() + 60 * 1000 });
  const fallback = await runWith({
    mode: 'access-only',
    fallback: 'refresh-capable-copy',
    doc,
    steps: [claudeInit(), ...ok],
  });
  assert.equal(fallback.records[0].credential.mode, 'refresh-capable-copy');
  assert.equal(fallback.records[0].credential.accessOnlyRefused, true);
  const halted = await runWith({
    mode: 'access-only',
    doc,
    steps: [claudeInit(), ...ok],
  });
  assert.equal(halted.records.length, 0);
  assert.match(halted.outcomes[0].reason, /lifetime below the attempt budget/);
});

test('class: redaction covers every channel and encoding', () => {
  const set = new RedactionSet({ home: '/home/someone', user: 'someone' });
  set.addCredentialDocument(JSON.stringify(claudeCredentialDoc()));
  set.seal();
  assert.throws(() => set.addSecret('late-secret-value-123'), /sealed/);
  const secret = 'sk-ant-oat01-ACCESS-aaaaaaaaaaaaaaaaaaaaaaaa';
  for (const form of encodings(secret)) {
    const text = `prefix ${form} suffix /home/someone/x by someone`;
    const red = set.redactText(text);
    assert.ok(!red.includes(form), form);
    assert.ok(!red.includes('/home/someone'));
    assert.ok(set.scanText(red).length === 0, red);
  }
  // Token patterns not in the set are redacted too.
  assert.ok(
    !set
      .redactText('Bearer abcdefghijklmnopqrstuvwxyz')
      .includes('abcdefghijklmnop'),
  );
  assert.equal(
    sha256(set.redactText('nothing secret here')),
    sha256('nothing secret here'),
  );
});
