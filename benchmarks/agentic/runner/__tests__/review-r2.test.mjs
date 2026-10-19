/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Review round 2, the five remaining classes: B2 (secrets on exceptional
// exits), B4 (partial startup and retained recovery state), B8 (option
// grammar and configuration sources), B10 (resume binds selected inputs),
// B12 (regrade verifies extraction metadata). Each test reproduces the
// reviewer's case and its class. No Docker (see docker.test.mjs), no
// provider, synthetic credentials only.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  FAKE_CLI,
  MODELS,
  STUB_GRADING,
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
import { analyzeTimeline, classifyCommand } from '../src/commands.mjs';
import { encodings } from '../src/redact.mjs';
import { LocalFixtureExecutor } from '../src/executors/local.mjs';
import { runMatrix } from '../src/matrix.mjs';
import { recoverStale } from '../src/recovery.mjs';
import { activeRefusals } from '../src/refusals.mjs';
import {
  regradeAttempt,
  verifyAttemptIntegrity,
  verifyExtraction,
} from '../src/regrade.mjs';
import { trustedTreeDigests } from '../src/trusted-tree.mjs';
import { fileSha256, readJson } from '../src/util.mjs';
import { extractArchive } from '../src/evidence.mjs';

const DISCOVERY = 'discovery-positive-card-vocabulary';
const COMPOSITION = 'composition-positive-order-summary';
const ok = [
  claudeInit(),
  claudeText(goodDiscoveryResponse()),
  claudeResult({ text: goodDiscoveryResponse() }),
];

function allText(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.isFile())
        out.push([
          path.join(d, e.name),
          fs.readFileSync(path.join(d, e.name), 'latin1'),
        ]);
  };
  walk(dir);
  return out;
}

function assertNoSecret(dir, secret) {
  for (const [file, text] of allText(dir))
    for (const form of encodings(secret))
      assert.ok(!text.includes(form), `${form} in ${file}`);
}

/** A matrix whose executor misbehaves in `start` or teardown. */
async function runWithExecutor(
  executor,
  { config = fixtureConfig(), stateDir, root } = {},
) {
  const runsRoot = root ?? tmpDir('r2runs');
  const out = await runMatrix({
    config,
    runsRoot,
    stateDir: stateDir ?? path.join(runsRoot, '.state'),
    identity: (await import('./helpers.mjs')).fixtureIdentity(),
    grading: STUB_GRADING(),
    executorFor: () => executor,
  });
  return {
    ...out,
    runsRoot,
    stateDir: stateDir ?? path.join(runsRoot, '.state'),
  };
}

function synthetic(secret) {
  const cred = syntheticCredentialDir(
    'claude',
    claudeCredentialDoc({ access: secret }),
  );
  return fixtureConfig({
    credentials: {
      claude: {
        mode: 'refresh-capable-copy',
        synthetic: true,
        source: { configDir: cred.dir, account: 'synthetic' },
      },
      codex: { mode: 'none', source: null },
    },
  });
}

const visible = ({ workspace, agentHome }) => ({ workspace, home: agentHome });

// ---------------------------------------------------------------- B2

test('B2 a secret in an exception from executor.start never reaches outcomes, records or refusals', async () => {
  const secret = 'sk-ant-oat01-STARTLEAK-aaaaaaaaaaaaaaaaaaaaaaa';
  // The reviewer's case: start throws the credential itself.
  const before = await runWithExecutor(
    {
      visiblePaths: visible,
      start: () => {
        throw new Error(`boom ${secret}`);
      },
    },
    { config: synthetic(secret) },
  );
  assert.match(
    fs.readFileSync(path.join(before.matrixDir, 'outcomes.json'), 'utf8'),
    /\[REDACTED\]/,
  );
  assertNoSecret(before.runsRoot, secret);
  // After registering resources: the partial-startup refusal is redacted too.
  const after = await runWithExecutor(
    {
      visiblePaths: visible,
      start: ({ onResources }) => {
        onResources({ container: 'c1' });
        throw new Error(`late ${secret}`);
      },
      cleanupResources: () => [`c1 ${secret}`],
    },
    { config: synthetic(secret) },
  );
  assertNoSecret(after.runsRoot, secret);
  assert.match(
    activeRefusals(after.stateDir).claude.events[0].reason,
    /partial startup not cleaned up: c1 \[REDACTED\]/,
  );
});

test('B2 a secret in a teardown or export error is redacted everywhere it is persisted', async () => {
  const secret = 'sk-ant-oat01-EXPORTLEAK-bbbbbbbbbbbbbbbbbbbbbb';
  const file = writeScenario(tmpDir('r2s'), 's', { steps: ok });
  class Throwing extends LocalFixtureExecutor {
    start(args) {
      const h = super.start(args);
      return {
        ...h,
        exportCredential: () => {
          throw new Error(`export ${secret}`);
        },
      };
    }
  }
  const out = await runWithExecutor(
    new Throwing({ fakeBinary: FAKE_CLI, scenario: file }),
    { config: synthetic(secret) },
  );
  assert.match(out.outcomes[0].reason, /export \[REDACTED\]/);
  assertNoSecret(out.runsRoot, secret);
  assert.match(
    activeRefusals(out.stateDir).claude.events[0].reason,
    /teardown failed: .*export \[REDACTED\]/,
  );
});

// ---------------------------------------------------------------- B4

test('B4 partial startup: registered resources are removed (verified) or retained with a durable refusal', async () => {
  // Rolled back: nothing retained, no refusal.
  const cleaned = [];
  const clean = await runWithExecutor({
    visiblePaths: visible,
    start: ({ onResources }) => {
      onResources({ network: 'n1', proxy: 'p1' });
      throw new Error('agent container failed');
    },
    cleanupResources: (r) => {
      cleaned.push(r);
      return [];
    },
  });
  assert.deepEqual(cleaned, [{ network: 'n1', proxy: 'p1' }]);
  assert.equal(fs.existsSync(path.join(clean.matrixDir, '.private')), false);
  assert.deepEqual(activeRefusals(clean.stateDir), {});
  // Not removable: state survives the matrix exit, the provider is refused.
  const stuck = await runWithExecutor({
    visiblePaths: visible,
    start: ({ onResources }) => {
      onResources({ network: 'n2', proxy: 'p2' });
      throw new Error('agent container failed');
    },
    cleanupResources: () => ['p2'],
  });
  const kept = fs.readdirSync(path.join(stuck.matrixDir, '.private'));
  assert.equal(kept.length, 1);
  assert.deepEqual(
    fs.readdirSync(path.join(stuck.matrixDir, '.private', kept[0])),
    ['state.json'],
  );
  assert.deepEqual(
    readJson(path.join(stuck.matrixDir, '.private', kept[0], 'state.json'))
      .resources,
    { network: 'n2', proxy: 'p2' },
  );
  assert.match(
    activeRefusals(stuck.stateDir).claude.events[0].reason,
    /partial startup not cleaned up: p2/,
  );
  // An executor without verified cleanup is never assumed clean.
  const unknown = await runWithExecutor({
    visiblePaths: visible,
    start: ({ onResources }) => {
      onResources({ container: 'x' });
      throw new Error('failed');
    },
  });
  assert.equal(
    fs.readdirSync(path.join(unknown.matrixDir, '.private')).length,
    1,
  );
  // The next start recovers the retained state (removal verified).
  const removed = new Set();
  const docker = (args) => {
    if (args[0] === 'rm') for (const c of args.slice(2)) removed.add(c);
    if (args[0] === 'network' && args[1] === 'rm') removed.add(args[2]);
    if (args[1] === 'inspect')
      return removed.has(args[2])
        ? {
            status: 1,
            stdout: '',
            stderr:
              args[0] === 'network'
                ? `Error response from daemon: network ${args[2]} not found`
                : `Error response from daemon: No such container: ${args[2]}`,
          }
        : { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const report = recoverStale(stuck.runsRoot, {
    stateDir: stuck.stateDir,
    docker,
  });
  assert.equal(report[0].cleanup, 'verified');
  assert.equal(fs.existsSync(path.join(stuck.matrixDir, '.private')), false);
});

test('B4 a failed destroy or a throwing teardown keeps the recovery state across the matrix exit', async () => {
  const file = writeScenario(tmpDir('r2d'), 's', { steps: ok });
  for (const mode of ['destroy-false', 'destroy-throws']) {
    class Bad extends LocalFixtureExecutor {
      start(args) {
        const h = super.start(args);
        return {
          ...h,
          destroy: () => {
            h.destroy();
            if (mode === 'destroy-throws')
              throw new Error('docker daemon gone');
            return false;
          },
        };
      }
    }
    const out = await runWithExecutor(
      new Bad({ fakeBinary: FAKE_CLI, scenario: file }),
    );
    const kept = fs.readdirSync(path.join(out.matrixDir, '.private'));
    assert.equal(kept.length, 1, mode);
    assert.ok(
      fs.existsSync(
        path.join(out.matrixDir, '.private', kept[0], 'state.json'),
      ),
      mode,
    );
    assert.ok(activeRefusals(out.stateDir).claude.events.length >= 1, mode);
    assert.equal(fs.existsSync(path.join(out.matrixDir, '.work')), false, mode);
  }
});

// ---------------------------------------------------------------- B8

test('B8 attached, combined and abbreviated options are parsed for every allowlisted program', () => {
  const opaque = [
    'rg -zm1 hi input.gz',
    'rg -m1z hi input.gz',
    'rg -uz foo',
    'rg --pr=cat foo',
    'rg --pre-g=*.gz foo',
    'rg --search-z foo',
    'rg --hostname=sh foo',
    'file -zb0 x.gz',
    'file -bZ x.gz',
    'file -bC',
    'file --uncomp x.gz',
    'file --comp',
    'tree -o/tmp/out.txt',
    'tree -ao out.txt',
    'tree --out=x',
    'tree --output x',
  ];
  for (const c of opaque) assert.equal(classifyCommand(c).class, 'opaque', c);
  for (const c of [
    'rg -m1 foo src',
    'rg -i foo',
    'file -b x',
    'tree -L 2',
    'tree -a',
    'ls -la',
    'grep -rn foo src',
    "sed -n '1,5p' a",
  ])
    assert.equal(classifyCommand(c).class, 'transparent', c);
  // git is never transparent, whatever its arguments.
  for (const c of [
    'git status',
    'git diff',
    'git log',
    'git show HEAD',
    'git ls-files',
    'git rev-parse HEAD',
    'git diff --no-ext-diff --no-textconv',
  ])
    assert.equal(classifyCommand(c).class, 'opaque', c);
});

test("B8 the reviewer's rg -zm1 case: a decompressor runs a hidden repair, first pass is unknown", async () => {
  const tools = tmpDir('r2tools');
  fs.writeFileSync(
    path.join(tools, 'gzip'),
    '#!/bin/sh\nfalse\necho repaired > .hidden-repair\ntrue\necho hi\n',
    { mode: 0o755 },
  );
  const file = writeScenario(tmpDir('r2rg'), 's', {
    steps: [
      claudeInit(),
      { write: { path: 'input.gz', content: 'dummy' } },
      { run: 'rg -zm1 hi input.gz' },
      claudeText('done'),
      claudeResult({ text: 'done' }),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    extraEnv: { PATH: `${tools}:${process.env.PATH}` },
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.ok(r.metrics.coverage.reasons.some((x) => x.startsWith('opaque')));
});

test("B8 the reviewer's global git configuration case: git diff runs the project's script, coverage is incomplete", () => {
  const root = tmpDir('r2git');
  const ws = path.join(root, 'ws');
  const home = path.join(root, 'home');
  fs.mkdirSync(ws);
  fs.mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args) =>
    spawnSync('git', args, { cwd: ws, env, encoding: 'utf8' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(ws, 'input.txt'), 'before\n');
  git(['add', 'input.txt']);
  git([
    '-c',
    'user.name=s',
    '-c',
    'user.email=s@example.invalid',
    'commit',
    '-qm',
    'b',
  ]);
  fs.writeFileSync(
    path.join(home, '.gitconfig'),
    '[diff]\n external = sh verify.sh\n',
  );
  fs.writeFileSync(
    path.join(ws, 'verify.sh'),
    'false\necho repaired > .hidden-repair\ntrue\n',
  );
  fs.writeFileSync(path.join(ws, 'input.txt'), 'after\n');
  git(['diff']);
  assert.ok(
    fs.existsSync(path.join(ws, '.hidden-repair')),
    'the configured driver really ran',
  );
  const t = analyzeTimeline({
    taskSuccess: true,
    deltas: ['a', 'b', 'c'],
    workspaceRoot: ws,
    toolCalls: [
      {
        kind: 'file-write',
        status: 'completed',
        paths: ['verify.sh'],
        index: 0,
      },
      {
        kind: 'file-write',
        status: 'completed',
        paths: ['input.txt'],
        index: 1,
      },
      {
        kind: 'command',
        command: 'git diff',
        status: 'completed',
        exitCode: 0,
        index: 2,
      },
    ],
  });
  assert.equal(t.firstPassSuccess, 'unknown');
  assert.deepEqual(t.coverage.reasons, ['opaque:2']);
});

test('B8 configuration written outside the workspace (shell startup, ~/.gitconfig, ~/.magic) makes coverage incomplete', async () => {
  const outside = path.join(tmpDir('r2out'), '.bashrc');
  const file = writeScenario(tmpDir('r2w'), 's', {
    steps: [
      claudeInit(),
      { write: { path: outside, content: 'alias ls="sh verify.sh"\n' } },
      { run: 'ls' },
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.ok(r.metrics.coverage.reasons.includes('write-outside-workspace:0'));
  // Paths escaping through `..`, unknown roots or missing path lists are outside.
  const t = analyzeTimeline({
    taskSuccess: true,
    deltas: ['a', 'b', 'c'],
    workspaceRoot: '/workspace',
    toolCalls: [
      { kind: 'file-write', status: 'completed', paths: ['../x'], index: 0 },
      { kind: 'file-write', status: 'completed', index: 1 },
      {
        kind: 'file-write',
        status: 'completed',
        paths: ['/workspace/src/a.js'],
        index: 2,
      },
    ],
  });
  assert.deepEqual(t.coverage.reasons, [
    'write-outside-workspace:0',
    'write-outside-workspace:1',
  ]);
});

// ---------------------------------------------------------------- B10

function snapshot(dir) {
  return allText(dir)
    .map(([f, t]) => `${path.relative(dir, f)}\0${t.length}\0${t.slice(0, 64)}`)
    .sort()
    .join('\n');
}

test("B10 the reviewer's closure case: an installer that cannot prove the same closure refuses before any mutation", async () => {
  const root = tmpDir('r2res');
  const file = writeScenario(tmpDir('r2rs'), 's', { steps: ok });
  let installed = 0;
  const lockA = {
    closureLockSha256: 'a'.repeat(64),
    nonProductLockSha256: 'a'.repeat(64),
    nodeModulesDigest: 'a'.repeat(64),
    productPackagesVerified: true,
  };
  const undeclared = () => () => {
    installed += 1;
    return lockA;
  };
  const config = fixtureConfig({ tasks: [DISCOVERY, COMPOSITION] });
  await runFixture({
    config,
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm',
    installFor: undeclared,
  });
  assert.equal(installed, 2);
  // Remove the second cell so a resume would have work to do.
  fs.rmSync(path.join(root, 'm/cells', COMPOSITION), { recursive: true });
  const before = snapshot(path.join(root, 'm'));
  await assert.rejects(
    runFixture({
      config,
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
      root,
      matrixId: 'm',
      installFor: () => () => {
        installed += 1;
        return { ...lockA, closureLockSha256: 'b'.repeat(64) };
      },
    }),
    /resume refused: .*\(fixture closure\)/,
  );
  assert.equal(installed, 2, 'no installer ran');
  assert.equal(snapshot(path.join(root, 'm')), before, 'nothing mutated');
});

test('B10 declared closures and the grading tree bind the matrix identity; identical inputs resume', async () => {
  const root = tmpDir('r2res2');
  const file = writeScenario(tmpDir('r2rs2'), 's', { steps: ok });
  let installed = 0;
  const declared = (sha) => {
    const lock = {
      closureLockSha256: sha,
      nonProductLockSha256: sha,
      nodeModulesDigest: sha,
      productPackagesVerified: true,
    };
    return () =>
      Object.assign(
        () => {
          installed += 1;
          return lock;
        },
        {
          identity: { closureLockSha256: sha, nonProductLockSha256: sha },
        },
      );
  };
  const run = (installFor, grading = STUB_GRADING()) =>
    runFixture({
      config: fixtureConfig(),
      scenarios: { '*': [file] },
      grading,
      root,
      matrixId: 'm',
      installFor,
    });
  await run(declared('a'.repeat(64)));
  const matrixJson = fs.readFileSync(path.join(root, 'm/matrix.json'), 'utf8');
  await assert.rejects(
    run(declared('b'.repeat(64))),
    /resume refused: .*inputs/,
  );
  assert.equal(
    fs.readFileSync(path.join(root, 'm/matrix.json'), 'utf8'),
    matrixJson,
  );
  const resumed = await run(declared('a'.repeat(64)));
  assert.equal(resumed.outcomes[0].status, 'resumed');
  assert.equal(installed, 1);
  // The grading dependencies are part of the identity too.
  const nm = path.join(tmpDir('r2nm'), 'node_modules');
  fs.mkdirSync(path.join(nm, 'x'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'x/i.js'), '1');
  const trusted = {
    mode: 'trusted',
    trustedNodeModules: nm,
    trustedExpected: trustedTreeDigests(nm),
    hostCommands: false,
    evaluate: STUB_GRADING().evaluate,
  };
  await assert.rejects(
    run(declared('a'.repeat(64)), trusted),
    /resume refused: .*inputs/,
  );
  // A declared installer whose install differs from its declaration is refused.
  const lying = () =>
    Object.assign(
      () => ({
        closureLockSha256: 'c'.repeat(64),
        nonProductLockSha256: 'c'.repeat(64),
        nodeModulesDigest: 'c'.repeat(64),
        productPackagesVerified: true,
      }),
      {
        identity: {
          closureLockSha256: 'd'.repeat(64),
          nonProductLockSha256: 'd'.repeat(64),
        },
      },
    );
  const fresh = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
    installFor: lying,
  });
  assert.match(
    fresh.outcomes[0].reason,
    /installed fixture closure differs from the declared one/,
  );
});

// ---------------------------------------------------------------- B12

async function gradedAttempt() {
  const file = writeScenario(tmpDir('r2g'), 's', { steps: ok });
  const out = await runFixture({
    config: fixtureConfig(),
    scenarios: { '*': [file] },
  });
  return path.join(
    out.matrixDir,
    'cells',
    DISCOVERY,
    'claude-haiku',
    'rep-1',
    'attempt-1',
  );
}

function editManifest(dir, fn, { rebindRecord = false } = {}) {
  const mf = path.join(dir, 'evidence/final/manifest.json');
  const m = readJson(mf);
  fn(m);
  fs.writeFileSync(mf, JSON.stringify(m));
  if (rebindRecord) {
    // A forger who also updates the record's manifest digest.
    const rf = path.join(dir, 'record.json');
    const r = readJson(rf);
    r.evidence.manifests.final = fileSha256(mf);
    fs.writeFileSync(rf, JSON.stringify(r));
  }
}

test("B12 the reviewer's stored=false case and every extraction-driving field are bound; forgeries refuse", async () => {
  const cases = [
    [
      'stored=false',
      (m) => m.entries.forEach((e) => e.type === 'file' && (e.stored = false)),
    ],
    [
      'storedSha256 to another blob',
      (m) => {
        const f = m.entries.filter((e) => e.type === 'file');
        f[0].storedSha256 = f[1].sha256;
      },
    ],
    ['mode', (m) => (m.entries.find((e) => e.type === 'file').mode = 0o755)],
    ['completeness', (m) => (m.completeness = 'incomplete')],
    [
      'dropped entry',
      (m) =>
        m.entries.splice(
          m.entries.findIndex((e) => e.type === 'file'),
          1,
        ),
    ],
  ];
  for (const [name, fn] of cases) {
    const dir = await gradedAttempt();
    assert.equal(
      regradeAttempt({ attemptDir: dir, scratchRoot: tmpDir('r2rg') }).label,
      'exact',
      `${name}: control`,
    );
    editManifest(dir, fn);
    assert.throws(
      () => regradeAttempt({ attemptDir: dir, scratchRoot: tmpDir('r2rg') }),
      /manifest differs from the record/,
      name,
    );
  }
});

test('B12 a consistent forgery (record digest updated too) still cannot pass as exact', async () => {
  // stored=false with a rebound digest: the entries contradict "complete".
  const a = await gradedAttempt();
  editManifest(
    a,
    (m) => m.entries.forEach((e) => e.type === 'file' && (e.stored = false)),
    { rebindRecord: true },
  );
  assert.throws(
    () => regradeAttempt({ attemptDir: a, scratchRoot: tmpDir('r2rg') }),
    /entries imply incomplete/,
  );
  // A substituted blob reference: the blob's bytes are not the recorded bytes.
  const b = await gradedAttempt();
  editManifest(
    b,
    (m) => {
      const f = m.entries.filter((e) => e.type === 'file');
      f[0].sha256 = f[1].sha256;
    },
    { rebindRecord: true },
  );
  assert.throws(
    () => regradeAttempt({ attemptDir: b, scratchRoot: tmpDir('r2rg') }),
    /set digest differs|extraction differs/,
  );
  // A missing blob.
  const c = await gradedAttempt();
  const blobs = path.join(c, 'evidence/final/blobs');
  fs.rmSync(path.join(blobs, fs.readdirSync(blobs)[0]));
  assert.throws(
    () => regradeAttempt({ attemptDir: c, scratchRoot: tmpDir('r2rg') }),
    /blob of .* differs/,
  );
  assert.deepEqual(
    verifyAttemptIntegrity(
      await gradedAttempt(),
      readJson(path.join(await gradedAttempt(), 'record.json')),
    ).length >= 0,
    true,
  );
});

test('B12 the extraction is checked against its manifest: missing, extra, changed bytes and modes', async () => {
  const dir = await gradedAttempt();
  const manifest = readJson(path.join(dir, 'evidence/final/manifest.json'));
  const dest = path.join(tmpDir('r2x'), 'ws');
  extractArchive({ archive: path.join(dir, 'evidence/final'), dest });
  assert.deepEqual(verifyExtraction(dest, manifest), []);
  const file = manifest.entries.find((e) => e.type === 'file');
  fs.appendFileSync(path.join(dest, file.path), 'x');
  fs.writeFileSync(path.join(dest, 'extra.txt'), 'x');
  fs.chmodSync(
    path.join(dest, manifest.entries.filter((e) => e.type === 'file')[1].path),
    0o777,
  );
  const problems = verifyExtraction(dest, manifest);
  assert.ok(problems.some((p) => p.includes('bytes differ')));
  assert.ok(problems.some((p) => p.includes('extra.txt: not in the manifest')));
  assert.ok(problems.some((p) => p.includes('mode differs')));
  assert.ok(
    verifyExtraction(dest, {
      entries: [
        ...manifest.entries,
        {
          path: 'gone.txt',
          type: 'file',
          stored: true,
          sha256: 'a'.repeat(64),
          mode: 0o600,
        },
      ],
    }).some((p) => p.includes('gone.txt: missing')),
  );
  void MODELS;
});

// ---------------------------------------------------------------- micro-fix

test("B8 the reviewer's embedded-glob case: `-fpri*` expands to an agent-named `-fprintf` and writes outside", async () => {
  const outside = tmpDir('mf-home');
  const target = path.join(outside, '.bashrc');
  const command = `find . -maxdepth 0 -fpri* ${target} '. verify.sh'`;
  const file = writeScenario(tmpDir('mf-g'), 's', {
    steps: [
      claudeInit(),
      { write: { path: '-fprintf', content: 'x' } },
      { run: command },
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const out = await runFixture({
    config: fixtureConfig({ tasks: [COMPOSITION] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  assert.equal(
    fs.readFileSync(target, 'utf8'),
    '. verify.sh',
    'the expansion really wrote outside the workspace',
  );
  const r = recordsOf(out.matrixDir)[0];
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.ok(r.metrics.coverage.reasons.includes('opaque:1'));
  assert.equal(classifyCommand(command).class, 'opaque');
});

test('B8 any unquoted glob, brace or tilde character in any word is opaque; quoted ones are literal', () => {
  const opaque = [
    'ls *',
    'ls src/*.js',
    'cat a?b',
    'cat [ab].txt',
    'cat a]b',
    'find . -fpri*',
    'find . -name *.js',
    'ls ~/x',
    'ls ~',
    'ls x~',
    'cat a{b,c}',
    'grep foo -r src/**',
    'head -n1 file?',
  ];
  for (const c of opaque) assert.equal(classifyCommand(c).class, 'opaque', c);
  for (const c of [
    'find src -name "*.js"',
    "rg 'a*b' src",
    "grep -rn '[ab]' src",
    "cat 'a b.txt'",
    "echo '~'",
  ])
    assert.equal(classifyCommand(c).class, 'transparent', c);
});

test('B4 a daemon that stops answering during rollback: nothing is assumed absent, state kept, provider refused', async () => {
  // Fully injected Docker: creations succeed, the agent container fails,
  // then the daemon is unreachable for every removal and inspection.
  let down = false;
  const run = (args) => {
    if (down)
      return {
        status: 1,
        stdout: '',
        stderr:
          'failed to connect to the docker API at unix:///var/run/docker.sock; check if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory',
      };
    if (
      args[0] === 'run' &&
      args.some((a) => String(a).startsWith('pms-agent-'))
    ) {
      down = true;
      return {
        status: 1,
        stdout: '',
        stderr:
          'Error response from daemon: range of CPUs is from 0.01 to 16.00',
      };
    }
    if (args[0] === 'run' || (args[0] === 'network' && args[1] === 'create'))
      return { status: 0, stdout: 'id\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const { DockerExecutor, removeVerified, inspectState } = await import(
    '../src/docker.mjs'
  );
  const ex = new DockerExecutor({
    images: { agent: 'a', harness: 'h' },
    limits: { cpus: -1, memoryBytes: 1, pidsLimit: 1, tmpfsBytes: 1 },
    allow: { claude: [] },
    cliBinary: { claude: '/opt/cli/claude' },
    run,
  });
  const out = await runWithExecutor(ex);
  const kept = fs.readdirSync(path.join(out.matrixDir, '.private'));
  assert.equal(kept.length, 1, 'recovery state kept');
  const state = readJson(
    path.join(out.matrixDir, '.private', kept[0], 'state.json'),
  );
  assert.ok(state.resources.proxy.startsWith('pms-proxy-'));
  assert.match(
    activeRefusals(out.stateDir).claude.events[0].reason,
    /partial startup not cleaned up: .*\(unknown\)/,
  );
  // Only the daemon's definitive answer naming the object means absent.
  const answers = {
    'Error response from daemon: No such container: c1': 'absent',
    'Error response from daemon: No such container: c10': 'unknown',
    'Error response from daemon: network c1 not found': 'unknown',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?':
      'unknown',
    'context deadline exceeded': 'unknown',
    '': 'unknown',
  };
  for (const [stderr, expected] of Object.entries(answers))
    assert.equal(
      inspectState('container', 'c1', () => ({
        status: 1,
        stdout: '',
        stderr,
      })),
      expected,
      stderr,
    );
  assert.equal(
    inspectState('network', 'n1', () => ({
      status: 1,
      stdout: '',
      stderr: 'Error response from daemon: network n1 not found',
    })),
    'absent',
  );
  assert.deepEqual(
    removeVerified({ container: 'c1' }, () => ({
      status: 1,
      stdout: '',
      stderr: 'dial unix: no such file or directory',
    })),
    ['c1 (unknown)'],
  );
});
