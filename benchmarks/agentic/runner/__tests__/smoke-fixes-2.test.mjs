/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Findings of the first smoke run (DESIGN.md sections 2.2, 4.6 and 11):
// a rejected access-only login falls back to the declared refresh-capable
// copy or refuses only its provider, and the Claude usage cross-check
// compares only the per-message fields that are final. Synthetic
// credentials only; the usage fixture is the observed stream's shape. The
// channel audit misidentified the CLI (section 4.4).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MODELS,
  STUB_GRADING,
  claudeInit,
  claudeResult,
  claudeText,
  codexCredentialDoc,
  codexDone,
  codexMessage,
  codexStart,
  fixtureConfig,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  syntheticCredentialDir,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { LAUNCHER, auditProcesses } from '../container/channel-audit.mjs';
import { activeRefusals } from '../src/refusals.mjs';
import { RUNNER_ROOT, readJson } from '../src/util.mjs';

function codexConfig({ fallback, models = [MODELS.sol] }) {
  const cred = syntheticCredentialDir('codex', codexCredentialDoc());
  return {
    cred,
    config: fixtureConfig({
      models,
      credentials: {
        claude: { mode: 'none', source: null },
        codex: {
          mode: 'access-only',
          ...(fallback ? { fallback: 'refresh-capable-copy' } : {}),
          synthetic: true,
          source: { configDir: cred.dir, account: 'synthetic-chatgpt' },
        },
      },
    }),
  };
}

const codexSteps = (check) => [
  ...codexStart(),
  { run: check, as: 'ls' },
  codexMessage(goodDiscoveryResponse()),
  codexDone(),
];

test('a rejected access-only login falls back to the declared refresh-capable copy (the observed Codex case)', async () => {
  const { cred, config } = codexConfig({ fallback: true });
  const before = fs.readFileSync(cred.file);
  const file = writeScenario(tmpDir('sf2'), 's', {
    loginRejects: true,
    steps: codexSteps('test -e "$CODEX_HOME/auth.json"'),
  });
  const out = await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.outcome.code, 'completed');
  assert.equal(r.credential.mode, 'refresh-capable-copy');
  assert.equal(r.credential.accessOnlyRefused, true);
  assert.match(
    r.credential.accessOnlyLoginError,
    /agent identity JWT payload is not valid JSON/,
  );
  assert.equal(
    r.credential.export,
    'unchanged',
    'mode B teardown exported and compared',
  );
  const stream = fs.readFileSync(
    path.join(
      out.matrixDir,
      'cells/discovery-positive-card-vocabulary/gpt-sol/rep-1/attempt-1/stream.jsonl',
    ),
    'utf8',
  );
  assert.match(stream, /"exit_code":0/, 'the copied auth.json was delivered');
  assert.deepEqual(fs.readFileSync(cred.file), before);
  assert.deepEqual(activeRefusals(path.join(out.root, '.state')), {});
});

test('without a declared fallback the provider is refused durably and the other providers go on', async () => {
  const { config } = codexConfig({
    fallback: false,
    models: [MODELS.sol, MODELS.haiku],
  });
  const codexFile = writeScenario(tmpDir('sf2'), 'c', {
    loginRejects: true,
    steps: codexSteps('ls'),
  });
  const claudeFile = writeScenario(tmpDir('sf2'), 'h', {
    steps: [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const out = await runFixture({
    config,
    scenarios: {
      'discovery-positive-card-vocabulary/gpt-sol': [codexFile],
      'discovery-positive-card-vocabulary/claude-haiku': [claudeFile],
    },
    grading: STUB_GRADING(),
  });
  const [sol, haiku] = out.outcomes;
  assert.equal(sol.status, 'missing');
  assert.equal(sol.class, 'infrastructure');
  assert.equal(sol.code, 'credential-login');
  assert.match(
    sol.reason,
    /access-only login rejected and no fallback declared/,
  );
  assert.equal(haiku.status, 'done', 'the matrix was not halted');
  const outcomes = readJson(path.join(out.matrixDir, 'outcomes.json'));
  assert.equal(outcomes.halted.matrix, null);
  assert.match(outcomes.halted.providers.codex, /no fallback declared/);
  assert.match(
    activeRefusals(path.join(out.root, '.state')).codex.events[0].reason,
    /agent identity JWT/,
  );
  assert.equal(recordsOf(out.matrixDir).length, 1);
});

test('an accepted access-only login runs in access-only mode', async () => {
  const { config } = codexConfig({ fallback: true });
  const file = writeScenario(tmpDir('sf2'), 's', {
    steps: codexSteps(
      'test -e "$CODEX_HOME/access-login.marker" && test ! -e "$CODEX_HOME/auth.json"',
    ),
  });
  const out = await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.credential.mode, 'access-only');
  assert.equal(r.credential.accessOnlyRefused, undefined);
  assert.equal(r.outcome.code, 'completed');
});

test('the observed Claude usage shape: no spurious discrepancy; totals as observed', async () => {
  const fixture = readJson(
    path.join(RUNNER_ROOT, 'fixtures/observed/claude-2.1.303-haiku-usage.json'),
  );
  const file = writeScenario(tmpDir('sf2'), 'obs', { steps: fixture.steps });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.metrics.tokens.discrepancy, null);
  const t = r.metrics.tokens.normalized.total;
  assert.deepEqual(
    [
      t.inputUncached.value,
      t.inputCacheRead.value,
      t.inputCacheWrite.value,
      t.inputTotal.value,
      t.outputTotal.value,
      t.outputReasoning.value,
    ],
    [10, 51573, 12452, 64035, 3299, 1334],
  );
  assert.equal(r.metrics.cost.value, 0.00465663);
  // Deduplicated: 14 assistant events, 5 messages.
  assert.equal(
    fixture.steps.filter((s) => s.emit.type === 'assistant').length,
    14,
  );
  assert.equal(
    new Set(
      fixture.steps
        .filter((s) => s.emit.type === 'assistant')
        .map((s) => s.emit.message.id),
    ).size,
    5,
  );
});

test('a genuine input or cache mismatch is still reported, a missing counter is not-computable', async () => {
  const msg = (id, usage) => ({
    emit: {
      type: 'assistant',
      message: {
        id,
        model: '${REQUESTED_MODEL}',
        role: 'assistant',
        content: [{ type: 'text', text: 'x' }],
        usage,
      },
      parent_tool_use_id: null,
      session_id: '${SESSION}',
    },
  });
  const mu = {
    '${REQUESTED_MODEL}': {
      inputTokens: 10,
      outputTokens: 999,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 5,
      costUSD: 0.1,
      costBasis: 'list',
    },
  };
  const run = async (usage) => {
    const file = writeScenario(tmpDir('sf2'), 'm', {
      steps: [claudeInit(), msg('a', usage), claudeResult({ modelUsage: mu })],
    });
    const out = await runFixture({
      config: fixtureConfig(),
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
    });
    return recordsOf(out.matrixDir)[0].metrics.tokens.discrepancy;
  };
  assert.equal(
    await run({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 5,
      output_tokens: 3,
    }),
    null,
    'output snapshot ignored',
  );
  assert.deepEqual(
    await run({
      input_tokens: 10,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 5,
      output_tokens: 3,
    }),
    {
      status: 'disagreement',
      fields: { cacheReadInputTokens: { messages: 90, modelUsage: 100 } },
    },
  );
  assert.equal(
    (await run({ input_tokens: 10, output_tokens: 3 })).status,
    'not-computable',
  );
});

// Process table observed in the agent image during an offline Claude Code
// 2.1.303 run (no network, synthetic token): pid 25 is the launcher, pid 37
// the CLI, which holds the stream pipe on fd 1 and a duplicate on fd 5.
const pipe = 'pipe:[85494842]';
const OBSERVED = [
  {
    pid: 1,
    ppid: 0,
    ruid: 10001,
    cmdline: ['/opt/node/bin/node', '-e', 'x'],
    restrictedOwner: 0,
    fds: { 1: 'pipe:[85493036]' },
  },
  {
    pid: 25,
    ppid: 0,
    ruid: 10001,
    cmdline: [
      '/opt/node/bin/node',
      LAUNCHER,
      '--env-file',
      '/run/agent/.cred-env',
      '--',
      '/opt/cli/claude',
      '-p',
    ],
    restrictedOwner: 0,
    fds: { 0: 'pipe:[85494841]', 1: pipe, 2: 'pipe:[85494843]' },
  },
  {
    pid: 37,
    ppid: 25,
    ruid: 10001,
    cmdline: ['/opt/cli/claude', '-p'],
    restrictedOwner: 0,
    fds: {
      0: 'pipe:[85494841]',
      1: pipe,
      2: 'pipe:[85494843]',
      5: pipe,
      6: 'pipe:[85494843]',
    },
  },
];

test('channel audit: the observed table is a non-dumpable CLI with no foreign holder', () => {
  // Before: the launcher (whose argv names /opt/cli/claude) was taken for
  // the CLI, `/proc/<pid>` (always the task's euid) for its dumpability, and
  // the CLI's own two descriptors for foreign holders: false and 2 per
  // sample, as in the smoke run.
  assert.deepEqual(auditProcesses(OBSERVED, 10001), {
    samples: 1,
    cliFound: true,
    cliNonDumpable: true,
    foreignStreamHolders: 0,
    controlSocketConnections: null,
  });
});

test('channel audit: a dumpable CLI, a tool child holding the stream and a spoofed launcher are all seen', () => {
  const dumpable = OBSERVED.map((p) =>
    p.pid === 37 ? { ...p, restrictedOwner: 10001 } : p,
  );
  assert.equal(auditProcesses(dumpable, 10001).cliNonDumpable, false);
  const child = {
    pid: 50,
    ppid: 37,
    ruid: 10001,
    cmdline: ['/bin/sh', '-c', 'x'],
    restrictedOwner: 10001,
    fds: { 1: pipe, 7: pipe },
  };
  // An agent process naming itself after the launcher is not excluded.
  const spoof = {
    pid: 51,
    ppid: 37,
    ruid: 10001,
    cmdline: ['/opt/node/bin/node', LAUNCHER],
    restrictedOwner: 0,
    fds: { 3: pipe },
  };
  assert.equal(
    auditProcesses([...OBSERVED, child, spoof], 10001).foreignStreamHolders,
    2,
  );
  // Without the launcher started by docker exec (parent 0) there is no CLI.
  assert.deepEqual(
    auditProcesses(
      OBSERVED.map((p) => (p.pid === 25 ? { ...p, ppid: 1 } : p)),
      10001,
    ),
    {
      samples: 1,
      cliFound: false,
      cliNonDumpable: null,
      foreignStreamHolders: null,
      controlSocketConnections: null,
    },
  );
  // An unreadable owner or descriptor table is unknown, never clean.
  const unknown = OBSERVED.map((p) =>
    p.pid === 37 ? { ...p, restrictedOwner: null, fds: {} } : p,
  );
  assert.deepEqual(
    [
      auditProcesses(unknown, 10001).cliNonDumpable,
      auditProcesses(unknown, 10001).foreignStreamHolders,
    ],
    [null, null],
  );
});
