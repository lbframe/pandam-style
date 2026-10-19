/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Review round 1, classes B5 (binding unit part), B8-B13: the self-test
// binding preflight accepts, the closed command grammar, planned report
// denominators, resume identity, per-cell fixture closures, regrade
// exactness, and incremental bounds. Each test reproduces the reviewer's
// case and its class. No Docker, no provider.

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
  closureFor,
  codexDone,
  codexFailed,
  codexMessage,
  codexStart,
  fixtureConfig,
  fixtureIdentity,
  fixtureStore,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  tmpDir,
  writeScenario,
  STORE_CORPUS,
} from './helpers.mjs';
import { classifyCommand } from '../src/commands.mjs';
import { validateMatrixConfig } from '../src/matrix.mjs';
import { regradeAttempt } from '../src/regrade.mjs';
import { buildReport, loadMatrix } from '../src/report.mjs';
import { requireValidSelfTest, selftestBinding } from '../src/selftest.mjs';
import { bindProductBuild, copyStore } from '../src/store.mjs';
import { createBoundedSink, createLineSplitter } from '../src/stream.mjs';
import {
  installFixtureClosure,
  nonProductLockDigest,
} from '../src/trusted-tree.mjs';
import { digestJson, readJson, writeJson } from '../src/util.mjs';

const DISCOVERY = 'discovery-positive-card-vocabulary';
const COMPOSITION = 'composition-positive-order-summary';
const okSteps = [
  claudeInit(),
  claudeText(goodDiscoveryResponse()),
  claudeResult({ text: goodDiscoveryResponse() }),
];
const attemptPath = (matrixDir, t, m, rep = 1, att = 1) =>
  path.join(matrixDir, 'cells', t, m, `rep-${rep}`, `attempt-${att}`);

// ---------------------------------------------------------------- B5

const facts = {
  dockerVersion: '29.2.1',
  kernel: '6.8.0',
  hostAddresses: ['10.0.0.2'],
};
const pbConfig = (over = {}) => ({
  kind: 'provider-backed',
  images: {
    agent: 'sha256:a',
    proxy: 'sha256:p',
    grader: 'sha256:g',
    baseDigest: null,
  },
  network: {
    mode: 'per-attempt-internal-isolated-gateway',
    ipv6: false,
    allow: { claude: ['api.anthropic.com:443'], codex: ['chatgpt.com:443'] },
  },
  container: {
    cpus: 2,
    memoryBytes: 4e9,
    pidsLimit: 512,
    tmpfsBytes: 1e9,
    workspaceBytesCap: 4e9,
  },
  ...over,
});

test('B5 preflight accepts the self-test of exactly its configuration and rejects any other', () => {
  const stateDir = tmpDir('st');
  const config = pbConfig();
  const binding = selftestBinding(config, facts);
  writeJson(path.join(stateDir, `selftest-${digestJson(binding)}.json`), {
    at: new Date().toISOString(),
    passed: true,
    binding,
    bindingDigest: digestJson(binding),
    checks: [],
  });
  assert.equal(requireValidSelfTest({ stateDir, config, facts }).passed, true);
  // The reviewer's case: a probe allowlist does not vouch for provider allowlists.
  for (const other of [
    pbConfig({
      network: { ...config.network, allow: { probe: ['example.invalid:443'] } },
    }),
    pbConfig({
      network: {
        ...config.network,
        allow: { ...config.network.allow, claude: ['evil.example:443'] },
      },
    }),
    pbConfig({ images: { ...config.images, agent: 'sha256:other' } }),
    pbConfig({ images: { ...config.images, grader: 'sha256:other' } }),
    pbConfig({ container: { ...config.container, memoryBytes: 1 } }),
  ])
    assert.throws(
      () => requireValidSelfTest({ stateDir, config: other, facts }),
      /no isolation self-test/,
    );
  assert.throws(
    () =>
      requireValidSelfTest({
        stateDir,
        config,
        facts: { ...facts, kernel: 'other' },
      }),
    /no isolation self-test/,
  );
  assert.throws(
    () =>
      requireValidSelfTest({
        stateDir,
        config,
        facts,
        now: Date.now() + 25 * 3600 * 1000,
      }),
    /older than 24 hours/,
  );
  const failed = pbConfig({ container: { ...config.container, cpus: 1 } });
  const fb = selftestBinding(failed, facts);
  writeJson(path.join(stateDir, `selftest-${digestJson(fb)}.json`), {
    at: new Date().toISOString(),
    passed: false,
    binding: fb,
    bindingDigest: digestJson(fb),
    checks: [],
  });
  assert.throws(
    () => requireValidSelfTest({ stateDir, config: failed, facts }),
    /failed/,
  );
});

// ---------------------------------------------------------------- B8

test('B8 every code-executing, script-loading or writing form is opaque (class fixtures)', () => {
  const opaque = [
    "sed -n '1e sh verify.sh' input.txt",
    "sed -n '1w out.txt' input.txt",
    "sed -n 's/a/b/e' input.txt",
    'sed -n -f script.sed input.txt',
    "sed -n '1p;1e id' input.txt",
    "sed -n '1p'e input.txt",
    'awk \'BEGIN{system("sh verify.sh")}\'',
    'find . -exec sh verify.sh {} +',
    'find . -execdir sh x ;',
    'find . -fprint out.txt',
    'find . -delete',
    'git -c alias.st=!sh status',
    'git -c core.fsmonitor=sh status',
    'git diff --ext-diff',
    'git log --textconv',
    'git show --output=x',
    'git --exec-path=/x status',
    'env FOO=1 ls',
    'xargs sh',
    'timeout 5 sh verify.sh',
    'nice ls',
    'nohup ls',
    'node -e 1',
    'rg --pre sh foo',
    'rg --pre=sh foo',
    'rg -z foo',
    'rg -uz foo',
    'rg --hostname-bin=sh foo',
    'file -z x.gz',
    'file -C',
    'tree -o out.txt',
    'tree -ofile',
    'rg foo *',
    'ls *',
    'cat ?',
    'sed -n 1p -i',
  ];
  for (const c of opaque) assert.equal(classifyCommand(c).class, 'opaque', c);
  for (const c of ['git status', 'git diff', 'git log --oneline'])
    assert.equal(classifyCommand(c).class, 'opaque', c);
  // Conservative: any `$`, even single-quoted, is shell syntax here.
  assert.equal(classifyCommand("sed -n '$p' a.txt").class, 'opaque');
  for (const c of [
    "sed -n '1,20p' a.txt",
    'rg foo src/*.js',
    'grep -rn foo src',
    'find src -name "*.js"',
    "cat 'a b.txt'",
  ])
    assert.equal(classifyCommand(c).class, 'transparent', c);
});

test("B8 the reviewer's sed '1e' case: the script really runs fail -> repair -> pass, first pass is unknown", async () => {
  const script = [
    "node -e \"process.exit(require('fs').existsSync('.fixed') ? 0 : 1)\" || true",
    'touch .fixed',
    'echo "/* repaired */" >> README.md',
  ].join('\n');
  const steps = [
    claudeInit(),
    { write: { path: 'verify.sh', content: `${script}\n` } },
    { write: { path: 'input.txt', content: 'x\n' } },
    { run: "sed -n '1e sh verify.sh' input.txt" },
    claudeText('done'),
    claudeResult({ text: 'done' }),
  ];
  const file = writeScenario(tmpDir('b8'), 's', { steps });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  const manifest = readJson(
    path.join(
      attemptPath(out.matrixDir, COMPOSITION, 'claude-haiku'),
      'evidence/final/manifest.json',
    ),
  );
  assert.ok(
    manifest.entries.some((e) => e.path === '.fixed'),
    'the script ran',
  );
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.equal(r.metrics.coverage.complete, false);
});

// ---------------------------------------------------------------- B9

test('B9 the report is seeded from the planned matrix: a cell without records stays in every denominator', async () => {
  const file = writeScenario(tmpDir('b9'), 's', { steps: okSteps });
  const failing = 'discovery-failure-warning-token';
  const out = await runFixture({
    config: fixtureConfig({ tasks: [DISCOVERY, failing] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    // The reviewer's case: a harness failure before the agent starts.
    installFor: ({ taskId }) =>
      taskId === failing
        ? () => {
            throw Object.assign(new Error('synthetic halt before agent'), {
              code: 'install',
            });
          }
        : null,
  });
  const report = buildReport(loadMatrix(out.matrixDir));
  assert.equal(report.cells.length, 2);
  const missingCell = report.cells.find((c) => c.taskId === failing);
  assert.equal(missingCell.valid, 0);
  assert.equal(missingCell.missing, 1);
  assert.match(
    missingCell.repetitions[0].reason,
    /synthetic halt before agent/,
  );
  const pm = report.perModel['claude-haiku'];
  assert.equal(pm.nPlanned, 2);
  assert.equal(pm.lowerBoundK, 1);
  assert.equal(pm.lowerBound, 0.5);
  assert.equal(pm.nMissing, 1);
  assert.equal(pm.byWorkflow.discovery.nPlanned, 2);
});

test('B9 planned repetitions without records and unsupported cells are explicit', async () => {
  const file = writeScenario(tmpDir('b9b'), 's', { steps: okSteps });
  const out = await runFixture({
    config: fixtureConfig({
      tasks: [DISCOVERY, 'installation-positive-vite'],
      models: [MODELS.haiku, MODELS.sol],
      repetitions: 2,
    }),
    scenarios: {
      '*': [file],
      [`${DISCOVERY}/gpt-sol`]: [
        writeScenario(tmpDir('b9c'), 'c', {
          steps: [
            ...codexStart(),
            codexFailed('Selected model is at capacity.'),
          ],
        }),
      ],
    },
    grading: STUB_GRADING(),
    clock: { now: () => new Date(), sleep: async () => {} },
  });
  const report = buildReport(loadMatrix(out.matrixDir));
  assert.equal(report.cells.length, 4);
  const unsupported = report.cells.filter(
    (c) => c.taskId === 'installation-positive-vite',
  );
  for (const c of unsupported) {
    assert.equal(c.unsupported, 2);
    assert.equal(c.missing, 0);
    assert.equal(c.success.lowerBound, null);
  }
  const capped = report.cells.find(
    (c) => c.taskId === DISCOVERY && c.modelKey === 'gpt-sol',
  );
  assert.equal(capped.missing, 2);
  assert.equal(capped.success.lowerBound, 0);
  assert.equal(report.perModel['gpt-sol'].nPlanned, 4);
  assert.equal(report.perModel['gpt-sol'].nUnsupported, 2);
  assert.equal(report.perModel['gpt-sol'].lowerBound, 0);
});

// ---------------------------------------------------------------- B10

test('B10 resume refuses a changed configuration and never overwrites matrix.json', async () => {
  const file = writeScenario(tmpDir('b10'), 's', { steps: okSteps });
  const root = tmpDir('b10root');
  const first = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'resume-me',
  });
  const before = fs.readFileSync(
    path.join(first.matrixDir, 'matrix.json'),
    'utf8',
  );
  // The reviewer's case: same matrix id, Haiku replaced by Sonnet.
  const sonnet = { ...MODELS.haiku, model: 'claude-sonnet-5-5' };
  await assert.rejects(
    runFixture({
      config: fixtureConfig({ models: [sonnet] }),
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
      root,
      matrixId: 'resume-me',
    }),
    /resume refused: .*configDigest/,
  );
  assert.equal(
    fs.readFileSync(path.join(first.matrixDir, 'matrix.json'), 'utf8'),
    before,
  );
  // A different harness or product identity is refused too.
  const otherIdentity = {
    ...fixtureIdentity(),
    productBuild: { digest: 'f'.repeat(64) },
  };
  await assert.rejects(
    runFixture({
      config: fixtureConfig(),
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
      root,
      matrixId: 'resume-me',
      identity: otherIdentity,
    }),
    /resume refused: .*productBuild/,
  );
  // The same configuration resumes without new attempts.
  const again = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'resume-me',
  });
  assert.equal(again.outcomes[0].status, 'resumed');
});

test('B10 a record of another model under a resumed cell is refused; duplicate keys are invalid', async () => {
  const file = writeScenario(tmpDir('b10b'), 's', { steps: okSteps });
  const root = tmpDir('b10broot');
  const first = await runFixture({
    config: fixtureConfig({ maxAttempts: 2 }),
    scenarios: {
      '*': [
        writeScenario(tmpDir('b10c'), 'c', {
          steps: [
            claudeInit(),
            {
              emit: {
                type: 'assistant',
                message: {
                  id: 's',
                  model: '<synthetic>',
                  role: 'assistant',
                  content: [],
                },
                parent_tool_use_id: null,
                error: 'overloaded',
              },
            },
            claudeResult({
              isError: true,
              terminalReason: 'api_error',
              modelUsage: {},
            }),
          ],
        }),
        file,
      ],
    },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm2',
    clock: { now: () => new Date(), sleep: async () => {} },
  });
  const rec = path.join(
    attemptPath(first.matrixDir, DISCOVERY, 'claude-haiku', 1, 2),
    'record.json',
  );
  const r = readJson(rec);
  fs.rmSync(rec);
  fs.writeFileSync(
    rec,
    JSON.stringify({
      ...r,
      modelConfig: { ...r.modelConfig, requestedModel: 'claude-sonnet-5-5' },
    }),
  );
  await assert.rejects(
    runFixture({
      config: fixtureConfig({ maxAttempts: 2 }),
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
      root,
      matrixId: 'm2',
    }),
    /resume refused: .*\(model\)/,
  );
  assert.ok(
    validateMatrixConfig(
      fixtureConfig({ models: [MODELS.haiku, MODELS.haiku] }),
    ).some((e) => /duplicate model key claude-haiku/.test(e)),
  );
});

test('B10 retry state survives restarts: a crashed or cancelled attempt never resets the budget, retries stay contested', async () => {
  const root = tmpDir('b10d');
  const limited = writeScenario(tmpDir('b10e'), 'l', {
    steps: [
      claudeInit(),
      {
        emit: {
          type: 'assistant',
          message: {
            id: 's',
            model: '<synthetic>',
            role: 'assistant',
            content: [],
          },
          parent_tool_use_id: null,
          error: 'overloaded',
        },
      },
      claudeResult({
        isError: true,
        terminalReason: 'api_error',
        modelUsage: {},
      }),
    ],
  });
  const hang = writeScenario(tmpDir('b10f'), 'h', {
    steps: [claudeInit(), { waitForever: true }],
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2500);
  const first = await runFixture({
    config: fixtureConfig({ maxAttempts: 3 }),
    scenarios: { '*': [limited, hang] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm3',
    signal: ac.signal,
    clock: { now: () => new Date(), sleep: async () => {} },
  });
  assert.equal(first.outcomes[0].reason, 'cancelled');
  // A crash leaves an attempt directory without a record.
  fs.mkdirSync(attemptPath(first.matrixDir, DISCOVERY, 'claude-haiku', 1, 3), {
    recursive: true,
  });
  const ok = writeScenario(tmpDir('b10g'), 'o', { steps: okSteps });
  const second = await runFixture({
    config: fixtureConfig({ maxAttempts: 3 }),
    scenarios: { '*': [ok] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm3',
  });
  const records = recordsOf(second.matrixDir);
  assert.deepEqual(
    records.map((x) => [x.attempt, x.outcome.code]),
    [
      [1, 'capacity'],
      [2, 'cancelled'],
      [4, 'completed'],
    ],
  );
  assert.equal(records.at(-1).integrity.contested, true);
  assert.equal(
    second.outcomes[0].attempts,
    3,
    'capacity + crash + success; the cancelled attempt does not count',
  );
  // A third start finds nothing left to do; a non-retryable invalid final stays missing.
  const third = await runFixture({
    config: fixtureConfig({ maxAttempts: 3 }),
    scenarios: { '*': [ok] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm3',
  });
  assert.equal(third.outcomes[0].status, 'resumed');
});

// ---------------------------------------------------------------- B11

test('B11 the consumed fixture closure is installed, verified and attributed to its cell', async () => {
  const store = fixtureStore();
  const copy = path.join(store.root, 'copy');
  copyStore({ original: store.original, dest: copy });
  const { binding } = bindProductBuild({
    storeCopy: copy,
    originalStore: store.original,
    manifestPath: store.manifestPath,
    corpus: STORE_CORPUS,
    extractDocs: false,
  });
  const closure = closureFor(store, copy);
  const file = writeScenario(tmpDir('b11'), 's', {
    steps: [
      claudeInit(),
      { run: 'ls node_modules/@pandamstyle', as: 'ls' },
      claudeText('x'),
      claudeResult(),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    installFor:
      () =>
      ({ workspace }) =>
        installFixtureClosure({
          closureDir: closure,
          workspace,
          binding,
          storeCopy: copy,
        }),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.install.productPackagesVerified, true);
  assert.equal(
    r.install.nonProductLockSha256,
    nonProductLockDigest(path.join(closure, 'package-lock.json')),
  );
  assert.equal(
    r.comparability.projection.dependencies.fixtureClosureNonProductLockSha256,
    r.install.nonProductLockSha256,
  );
  const stream = fs.readFileSync(
    path.join(
      attemptPath(out.matrixDir, COMPOSITION, 'claude-haiku'),
      'stream.jsonl',
    ),
    'utf8',
  );
  assert.match(stream, /compiler\\ncore/, 'installed before the agent started');
  // A tarball differing from the binding refuses before the agent starts.
  fs.appendFileSync(
    path.join(copy, store.manifest.packages[1].registry.file),
    'x',
  );
  const bad = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    installFor:
      () =>
      ({ workspace }) =>
        installFixtureClosure({
          closureDir: closure,
          workspace,
          binding,
          storeCopy: copy,
        }),
  });
  assert.equal(recordsOf(bad.matrixDir).length, 0);
  assert.match(bad.outcomes[0].reason, /harness install/);
});

// ---------------------------------------------------------------- B12

async function gradedAttempt() {
  const file = writeScenario(tmpDir('b12'), 's', { steps: okSteps });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
  });
  return attemptPath(out.matrixDir, DISCOVERY, 'claude-haiku');
}

test('B12 regrade is exact only with matching identities and intact artifacts', async () => {
  const dir = await gradedAttempt();
  const scratch = tmpDir('rg');
  const exact = regradeAttempt({ attemptDir: dir, scratchRoot: scratch });
  assert.equal(exact.label, 'exact');
  assert.equal(exact.identical, true);
  // The reviewer's case: wrong harness identity recorded.
  const current = fixtureIdentity().harness;
  const other = regradeAttempt({
    attemptDir: dir,
    scratchRoot: scratch,
    currentHarness: { ...current, runnerTreeDigest: 'different' },
  });
  assert.equal(other.label, 'non-exact');
  assert.deepEqual(other.reasons, ['harness.runnerTreeDigest']);
  // Tampered artifact or evidence blob: refused.
  const msg = path.join(dir, 'final-message.txt');
  const original = fs.readFileSync(msg);
  fs.appendFileSync(msg, 'tampered');
  assert.throws(
    () => regradeAttempt({ attemptDir: dir, scratchRoot: scratch }),
    /final-message.txt sha256 differs/,
  );
  fs.writeFileSync(msg, original);
  const blobs = path.join(dir, 'evidence/final/blobs');
  const blob = path.join(blobs, fs.readdirSync(blobs)[0]);
  fs.appendFileSync(blob, 'x');
  assert.throws(
    () => regradeAttempt({ attemptDir: dir, scratchRoot: scratch }),
    /blob of .* differs/,
  );
});

test('B12 provider records never fall back to ancestors; trusted records need the matching tree', async () => {
  const dir = await gradedAttempt();
  const rec = readJson(path.join(dir, 'record.json'));
  fs.writeFileSync(
    path.join(dir, 'record.json'),
    JSON.stringify({ ...rec, kind: 'provider-backed' }),
  );
  assert.throws(
    () => regradeAttempt({ attemptDir: dir, scratchRoot: tmpDir('rg2') }),
    /provider-backed record graded without the trusted tree/,
  );
  fs.writeFileSync(
    path.join(dir, 'record.json'),
    JSON.stringify({
      ...rec,
      trustedTree: {
        mode: 'trusted',
        digest: 'a'.repeat(64),
        pandamstyleDigest: 'b'.repeat(64),
      },
    }),
  );
  assert.throws(
    () => regradeAttempt({ attemptDir: dir, scratchRoot: tmpDir('rg3') }),
    /--trusted-node-modules is required/,
  );
  const nm = path.join(tmpDir('nm'), 'node_modules');
  fs.mkdirSync(nm);
  assert.throws(
    () =>
      regradeAttempt({
        attemptDir: dir,
        scratchRoot: tmpDir('rg4'),
        trustedNodeModules: nm,
      }),
    (e) => e.code === 'trusted-tree',
  );
});

// ---------------------------------------------------------------- B13

test('B13 the line splitter never buffers more than its cap', () => {
  const lines = [];
  const anomalies = [];
  const s = createLineSplitter((l) => lines.push(l), {
    maxLine: 1024,
    onAnomaly: (a) => anomalies.push(a),
  });
  for (let i = 0; i < 100; i += 1) s.push('x'.repeat(1000));
  s.push('\n{"type":"ok"}\n');
  s.end();
  assert.deepEqual(anomalies, ['line-too-long']);
  assert.deepEqual(lines, ['{"type":"ok"}']);
});

test('B13 raw storage is capped while streaming, line-aligned, with a marker', () => {
  const file = path.join(tmpDir('sink'), 'raw');
  const sink = createBoundedSink(file, { headBytes: 1000, tailBytes: 1000 });
  for (let i = 0; i < 5000; i += 1) sink.write(`line ${i} ${'y'.repeat(20)}\n`);
  const r = sink.finish();
  assert.equal(r.truncated, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(text) < 2200);
  assert.match(text, /\[pms-runner: \d+ bytes not stored\]/);
  for (const l of text.split('\n').filter(Boolean))
    assert.match(l, /^(line \d+ y{20}|\[pms-runner: \d+ bytes not stored\])$/);
});

test('B13 oversized streams and workspaces end as explicit incomplete evidence or resource-limit', async () => {
  const big = [
    claudeInit(),
    ...Array.from({ length: 60 }, (_, i) =>
      claudeText(`${'z'.repeat(4000)} ${i}`, { id: `m${i}` }),
    ),
    claudeText('done', { id: 'last' }),
    claudeResult({ text: 'done' }),
  ];
  const file = writeScenario(tmpDir('b13'), 's', { steps: big });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    bounds: { stream: 64 * 1024 },
  });
  const r = recordsOf(out.matrixDir)[0];
  const stream = r.evidence.artifacts.find((a) => a.file === 'stream.jsonl');
  assert.equal(stream.truncated, true);
  assert.ok(stream.bytes < 70 * 1024);
  assert.equal(r.evidence.completeness, 'incomplete');
  assert.equal(r.evidence.replay, 'non-exact');
  // Line beyond the parser's cap: an anomaly, never a crash.
  const hugeLine = writeScenario(tmpDir('b13b'), 's', {
    steps: [
      claudeInit(),
      { emitRaw: `${'q'.repeat(9 * 1024 * 1024)}\n` },
      claudeResult(),
    ],
  });
  const out2 = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [hugeLine] },
    grading: STUB_GRADING(),
  });
  assert.ok(
    recordsOf(out2.matrixDir)[0].integrity.anomalies.includes('line-too-long'),
  );
  // Workspace cap: the agent is stopped as resource-limit.
  const grow = writeScenario(tmpDir('b13c'), 's', {
    steps: [
      claudeInit(),
      { run: 'head -c 300000 /dev/zero > big.bin', as: 'make' },
      { sleep: 3000 },
      claudeResult(),
    ],
  });
  const out3 = await runFixture({
    config: fixtureConfig({
      tasks: [COMPOSITION],
      container: { workspaceBytesCap: 200000 },
      budgets: { graceInterruptMs: 200, graceTerminateMs: 200 },
    }),
    scenarios: { '*': [grow] },
    grading: STUB_GRADING(),
  });
  const r3 = recordsOf(out3.matrixDir)[0];
  assert.equal(r3.outcome.code, 'resource-limit');
  assert.equal(r3.budgets.limitFired, 'workspace-bytes');
  assert.equal(r3.outcome.taskSuccess, false);
});

test('B13 staged evidence over its bound is incomplete and never graded', async () => {
  const grow = writeScenario(tmpDir('b13d'), 's', {
    steps: [
      claudeInit(),
      { run: 'head -c 300000 /dev/zero > src/big.bin', as: 'make' },
      claudeText('x'),
      claudeResult(),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [grow] },
    grading: STUB_GRADING(),
    bounds: { evidence: 100000 },
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.outcome.code, 'evidence-bound');
  assert.equal(r.grading.verdict, 'not-graded');
  assert.equal(r.evidence.completeness, 'incomplete');
});

test('codex sanity with the new paths', async () => {
  const file = writeScenario(tmpDir('cx'), 's', {
    steps: [
      ...codexStart(),
      { run: 'pwd' },
      codexMessage(goodDiscoveryResponse()),
      codexDone(),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig({ models: [MODELS.sol] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.outcome.code, 'completed');
  const argv = r.modelConfig.rawArgv;
  assert.equal(argv[argv.indexOf('-C') + 1].endsWith('/workspace'), true);
});
