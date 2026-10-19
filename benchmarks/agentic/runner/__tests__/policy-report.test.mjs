/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Refusals (F39, F54), two-pass grading (F40, F43), the report (F56), schema
// validation of every record, configuration and report (F57), the
// command-line entry and the provider-backed preflight (no provider call:
// every refusal fires before a CLI could start).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CODEX_EVIDENCE,
  MODELS,
  STUB_GRADING,
  claudeInit,
  claudeResult,
  claudeText,
  codexDone,
  codexFailed,
  codexMessage,
  codexStart,
  fixtureConfig,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { validate } from '../../src/json-schema.mjs';
import { grade } from '../src/attempt.mjs';
import {
  enforcementPlan,
  heldoutRefusal,
  taskRefusals,
} from '../src/capabilities.mjs';
import { validateMatrixConfig } from '../src/matrix.mjs';
import { providerPreflight } from '../src/provider.mjs';
import { buildReport, loadMatrix, renderMarkdown } from '../src/report.mjs';
import { CORPUS_ROOT, RUNNER_ROOT, readJson } from '../src/util.mjs';
import { main } from '../bin/pms-agentic-runner.mjs';

const schema = (n) => readJson(path.join(RUNNER_ROOT, 'schema', n));
const HELDOUT = readJson(
  path.join(CORPUS_ROOT, 'heldout/MANIFEST.json'),
).tasks.map((t) => t.id);

test('F54 every held-out id, --heldout-dir and any purpose variable are refused', async () => {
  assert.equal(HELDOUT.length, 16);
  process.env.PMS_HELDOUT_PURPOSE = 'final-qualification';
  process.env.PMS_HELDOUT_PASSPHRASE_FILE = '/nonexistent';
  try {
    for (const id of HELDOUT) {
      assert.match(heldoutRefusal({ taskId: id }), /refused/);
      assert.ok(
        validateMatrixConfig(fixtureConfig({ tasks: [id] })).some((e) =>
          e.includes(id),
        ),
      );
    }
    assert.match(
      heldoutRefusal({ taskId: 'x', task: { split: 'heldout' } }),
      /heldout/,
    );
    await assert.rejects(
      main(['report', '/tmp', '--heldout-dir', '/x']),
      /--heldout-dir is refused/,
    );
    await assert.rejects(
      main(['run', 'm.json', '--heldout-dir=/x']),
      /--heldout-dir is refused/,
    );
  } finally {
    delete process.env.PMS_HELDOUT_PURPOSE;
    delete process.env.PMS_HELDOUT_PASSPHRASE_FILE;
  }
  // The runner has no unseal path and never reads the passphrase variables.
  for (const dir of ['src', 'bin', 'container'])
    for (const f of fs.readdirSync(path.join(RUNNER_ROOT, dir), {
      recursive: true,
    }))
      if (String(f).endsWith('.mjs')) {
        const text = fs.readFileSync(
          path.join(RUNNER_ROOT, dir, String(f)),
          'utf8',
        );
        assert.doesNotMatch(
          text,
          /PMS_HELDOUT|heldout\.tar|unseal/,
          `${dir}/${f}`,
        );
      }
});

test('F39 package-registry, services, browser and compile-event tasks are refused, not failed', async () => {
  const file = writeScenario(tmpDir('f39'), 's', {
    steps: [claudeInit(), claudeText('x'), claudeResult()],
  });
  const out = await runFixture({
    config: fixtureConfig({ tasks: ['installation-positive-vite'] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING(),
  });
  assert.equal(recordsOf(out.matrixDir).length, 0);
  assert.equal(out.outcomes[0].status, 'unsupported');
  assert.match(out.outcomes[0].reasons[0], /local mirror/);
  const base = {
    environment: { network: 'none', browser: false },
    workspace: { services: [], events: [] },
  };
  assert.deepEqual(taskRefusals(base), []);
  assert.match(
    taskRefusals({
      ...base,
      workspace: { services: [{ id: 'db' }], events: [] },
    })[0],
    /services/,
  );
  assert.match(
    taskRefusals({
      ...base,
      environment: { network: 'none', browser: true },
    })[0],
    /browser/,
  );
  assert.match(
    taskRefusals({
      ...base,
      workspace: { events: [{ id: 'e', steps: [{ step: 'compile' }] }] },
    })[0],
    /compile step/,
  );
});

test('capability matrix: withheld capabilities are prevented, detect-and-fail or refused (Q12)', () => {
  const task = readJson(
    path.join(
      CORPUS_ROOT,
      'tasks/discovery-positive-card-vocabulary/task.json',
    ),
  );
  const plan = enforcementPlan(task, {
    project: { definition: 'pandamstyle/system.js' },
  });
  const cls = Object.fromEntries(
    plan.matrix.map((r) => [r.capability, r.class]),
  );
  assert.equal(cls['workspace.write'], 'prevent');
  assert.equal(cls['git.write'], 'prevent');
  assert.equal(cls['host.build'], 'detect-and-fail');
  assert.equal(cls['host.dev-server'], 'detect-and-fail');
  assert.equal(cls['package.install'], 'prevent+detect-and-fail');
  assert.equal(cls['web-tools'], 'prevent+detect-and-fail');
  assert.equal(plan.mounts.workspaceReadOnly, true);
  assert.deepEqual(plan.mounts.readOnlyPaths, ['pandamstyle/system.js']);
});

const hostBuildEntry = {
  name: 'synthetic-host-build',
  task: {
    expectations: {
      alpha1: {
        checks: [
          { id: 'build', kind: 'host.build' },
          { id: 'scope', kind: 'scope.diff' },
        ],
      },
    },
  },
};
const checks = (build, scope) => [
  { id: 'build', kind: 'host.build', required: true, status: build },
  { id: 'scope', kind: 'scope.diff', required: true, status: scope },
];
function twoPass(byPass) {
  const root = tmpDir('g2');
  return grade(
    {
      kind: 'adapter-fixture',
      epoch: 'alpha1',
      taskEntry: hostBuildEntry,
      grading: {
        mode: 'dev-ancestor',
        hostCommands: true,
        evaluate: STUB_GRADING({ byPass }).evaluate,
      },
    },
    {
      root,
      baseline: root,
      workspace: root,
      files: { response: path.join(root, 'r') },
    },
  );
}

test('F40 a G2 build that kills or breaks the grader: aborted-by-agent-code, never pass', () => {
  const g = twoPass({
    G1: { verdict: 'pass', checks: checks('not-run', 'pass') },
    G2: { status: 'harness-error', error: 'killed' },
  });
  assert.equal(g.verdict, 'fail');
  assert.equal(g.result.hostBuild, 'aborted-by-agent-code');
  assert.deepEqual(
    g.passes.map((p) => [p.pass, p.status]),
    [
      ['G1', 'completed'],
      ['G2', 'aborted-by-agent-code'],
    ],
  );
});

test('F43 G1/G2 disagreement on a non-host check: not pass, flagged', () => {
  const g = twoPass({
    G1: { verdict: 'pass', checks: checks('not-run', 'pass') },
    G2: { verdict: 'pass', checks: checks('pass', 'fail') },
  });
  assert.equal(g.verdict, 'fail');
  assert.equal(g.passes[1].status, 'inconsistent');
  const ok = twoPass({
    G1: { verdict: 'pass', checks: checks('not-run', 'pass') },
    G2: { verdict: 'pass', checks: checks('pass', 'pass') },
  });
  assert.equal(ok.verdict, 'pass');
  assert.equal(ok.passes[1].status, 'completed');
});

const DISCOVERY = 'discovery-positive-card-vocabulary';
const COMPOSITION = 'composition-positive-order-summary';

async function mixedMatrix() {
  const dir = tmpDir('f56');
  const w = (name, steps, extra = {}) =>
    writeScenario(dir, name, { steps, ...extra });
  const success = w('success', [
    claudeInit(),
    { run: 'ls' },
    claudeText(goodDiscoveryResponse()),
    claudeResult({ text: goodDiscoveryResponse() }),
  ]);
  const unknownTokens = w('unknown', [
    claudeInit(),
    claudeText(goodDiscoveryResponse()),
    claudeResult({ text: goodDiscoveryResponse(), modelUsage: {} }),
  ]);
  const failing = w('failing', [
    claudeInit(),
    { fakeRun: { command: 'npm run build', exitCode: 1 } },
    claudeText('gave up'),
    claudeResult({ text: 'gave up' }),
  ]);
  const limited = w('limited', [
    ...codexStart(),
    codexFailed('You’ve hit your usage limit.'),
  ]);
  const codexOk = w('codex-ok', [
    ...codexStart(),
    codexMessage(goodDiscoveryResponse()),
    codexDone(),
  ]);
  const config = fixtureConfig({
    tasks: [DISCOVERY, COMPOSITION, 'installation-positive-vite'],
    models: [MODELS.haiku, MODELS.sol],
    repetitions: 2,
  });
  const out = await runFixture({
    config,
    scenarios: {
      [`${DISCOVERY}/claude-haiku`]: [success],
      [`${DISCOVERY}/claude-haiku#2`]: [unknownTokens],
      [`${COMPOSITION}/claude-haiku`]: [failing],
      [`${DISCOVERY}/gpt-sol`]: [limited, codexOk],
      [`${COMPOSITION}/gpt-sol`]: [limited],
      '*': [success],
    },
    grading: STUB_GRADING({ verdict: 'pass' }),
    clock: { now: () => new Date(), sleep: async () => {} },
  });
  return { config, out };
}

test('F56 + F57 report over mixed records: values, unknowns, missing, unsupported, contested, breaches; all documents valid', async () => {
  const { config, out } = await mixedMatrix();
  const loaded = loadMatrix(out.matrixDir);
  const report = buildReport(loaded);
  assert.equal(report.synthetic, true);
  const cell = (t, m) =>
    report.cells.find((c) => c.taskId === t && c.modelKey === m);
  const a = cell(DISCOVERY, 'claude-haiku');
  assert.equal(a.success.k, 2);
  assert.deepEqual(a.metrics.inputTokens.values, [140, null]);
  assert.equal(a.metrics.inputTokens.unknown, 1);
  assert.equal(a.metrics.inputTokens.median, 140);
  // Every value is listed per repetition; unknowns are null and counted.
  const b = cell(COMPOSITION, 'claude-haiku');
  assert.equal(b.firstPass.false + b.firstPass.unknown, 2);
  const c = cell(DISCOVERY, 'gpt-sol');
  assert.equal(c.success.pointEstimate, 1);
  assert.equal(c.success.lowerBound, 0);
  assert.equal(c.success.contested, 2);
  const d = cell(COMPOSITION, 'gpt-sol');
  assert.equal(d.valid, 0);
  assert.equal(d.missing, 2);
  assert.equal(
    report.missing.filter((m) => m.reason === 'attempts exhausted').length,
    2,
  );
  assert.equal(report.unsupported.length, 2);
  assert.ok(report.infrastructure.codex['rate-limit'] >= 6);
  assert.ok(
    report.breaches.length === 0 ||
      report.breaches.every(
        (x) =>
          x.breaches.length > 0 ||
          x.anomalies.length > 0 ||
          x.realizedScope.length > 0 ||
          x.vocabulary === 'fail',
      ),
  );
  assert.equal(report.perModel['gpt-sol'].lowerBoundK, 0);
  const md = renderMarkdown(report);
  assert.match(md, /Synthetic/);
  assert.match(md, /Unsupported \/ not run/);
  // F57: every document validates against its v1 schema.
  assert.deepEqual(validate(schema('run-config.v1.schema.json'), config), []);
  assert.deepEqual(validate(schema('report.v1.schema.json'), report), []);
  const recordSchema = schema('run-record.v1.schema.json');
  for (const r of loaded.records)
    assert.deepEqual(
      validate(recordSchema, r),
      [],
      `${r.cell.taskId}/${r.cell.modelKey}/${r.repetition}/${r.attempt}`,
    );
  assert.ok(loaded.records.length >= 10);
});

test('report refuses to aggregate different kinds', () => {
  const r = (kind) => ({
    kind,
    cell: { taskId: 't', modelKey: 'm' },
    repetition: 1,
    attempt: 1,
  });
  assert.throws(
    () =>
      buildReport({
        matrix: { repetitions: 1 },
        outcomes: { outcomes: [] },
        records: [r('adapter-fixture'), r('provider-backed')],
      }),
    /different kinds/,
  );
});

test('CLI: validate-config, run an adapter-fixture matrix file, report and compare', async () => {
  const dir = tmpDir('cli');
  const scenario = writeScenario(dir, 'ok', {
    steps: [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const codexScenario = writeScenario(dir, 'codex', {
    steps: [
      ...codexStart(),
      codexMessage(goodDiscoveryResponse()),
      codexDone(),
    ],
  });
  const matrixFile = path.join(dir, 'matrix.json');
  const config = fixtureConfig({
    models: [MODELS.haiku, MODELS.sol],
    repetitions: 2,
    budgets: {},
    adapterFixtures: {
      [`${DISCOVERY}/claude-haiku`]: [path.basename(scenario)],
      [`${DISCOVERY}/gpt-sol`]: [path.basename(codexScenario)],
    },
    adapterEffectiveConfig: {
      codex: {
        promptInput: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '<skills_instructions/>' }],
          },
        ],
        strictConfigAccepted: true,
      },
    },
  });
  fs.writeFileSync(matrixFile, JSON.stringify(config));
  assert.deepEqual(await main(['validate-config', matrixFile]), {
    ok: true,
    errors: [],
  });
  const runsRoot = path.join(dir, 'runs');
  const out = await main([
    'run',
    matrixFile,
    '--runs-root',
    runsRoot,
    '--state-dir',
    path.join(dir, 'state'),
    '--matrix-id',
    'cli-test',
  ]);
  assert.deepEqual(
    out.outcomes.map((o) => o.status),
    ['done', 'done', 'done', 'done'],
  );
  const report = await main(['report', out.matrixDir]);
  assert.equal(report.cells.length, 2);
  assert.ok(fs.existsSync(path.join(out.matrixDir, 'report.md')));
  const recs = recordsOf(out.matrixDir);
  const files = recs.map((r) =>
    path.join(
      out.matrixDir,
      'cells',
      r.cell.taskId,
      r.cell.modelKey,
      `rep-${r.repetition}`,
      `attempt-${r.attempt}`,
      'record.json',
    ),
  );
  const haiku = files.filter((f) => f.includes('claude-haiku'));
  const same = await main(['compare', haiku[0], haiku[1]]);
  assert.equal(same.comparable, true, JSON.stringify(same.differences));
  const cross = await main([
    'compare',
    files[0],
    files.find((f) => f.includes('gpt-sol')),
  ]);
  assert.equal(cross.comparable, false);
  assert.ok(cross.differences.includes('model.cli'));
  // Codex evidence ran through the real evidence code.
  const codexRecord = recs.find((r) => r.cli.name === 'codex');
  assert.equal(
    codexRecord.modelConfig.effectiveConfig.subagents,
    'disabled-evidenced',
  );
  assert.equal(
    codexRecord.modelConfig.effectiveConfig.web,
    'disabled-configured',
  );
});

test('CLI: run roots inside the repository must be under .pms-bench; schema errors are reported', async () => {
  const dir = tmpDir('cli2');
  const matrixFile = path.join(dir, 'matrix.json');
  fs.writeFileSync(
    matrixFile,
    JSON.stringify(fixtureConfig({ adapterFixtures: { '*': ['x.json'] } })),
  );
  await assert.rejects(
    main(['run', matrixFile, '--runs-root', path.join(RUNNER_ROOT, 'runs')]),
    /\.pms-bench/,
  );
  fs.writeFileSync(
    matrixFile,
    JSON.stringify({
      ...fixtureConfig(),
      credentials: { claude: 'access-only' },
    }),
  );
  const v = await main(['validate-config', matrixFile]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith('schema:')));
});

test('provider-backed preflight: authorization, CI, clean checkout, setup and credential source', async () => {
  const pb = fixtureConfig({
    kind: 'provider-backed',
    budgets: {},
    network: {
      mode: 'per-attempt-internal-isolated-gateway',
      ipv6: false,
      allow: { claude: ['api.anthropic.com:443'] },
    },
    credentials: {
      claude: {
        mode: 'access-only',
        fallback: 'refresh-capable-copy',
        source: { configDir: '~/.claude-t3/team-2', account: 'claude-team-2' },
      },
      codex: {
        mode: 'access-only',
        source: { configDir: '~/.codex', account: 'chatgpt' },
      },
    },
  });
  const identity = (clean) => ({ harness: { clean } });
  // B11: every runnable task's fixture needs a closure (package.json and
  // package-lock.json).
  const closureDir = tmpDir('closure');
  for (const f of ['package.json', 'package-lock.json'])
    fs.writeFileSync(path.join(closureDir, f), '{}');
  const discoveryFixture = readJson(
    path.join(
      CORPUS_ROOT,
      'tasks/discovery-positive-card-vocabulary/task.json',
    ),
  ).workspace.fixture;
  const setup = {
    schema: 'pms-agentic-provider-setup/v1',
    storeCopy: '/x',
    manifest: '/m',
    trustedClosure: '/c',
    closures: { [discoveryFixture]: { dir: closureDir } },
  };
  const ci = process.env.CI;
  delete process.env.CI;
  try {
    assert.throws(
      () => providerPreflight({ config: pb, identity: identity(true), setup }),
      /authorization "orchestrator-go"/,
    );
    const authorized = { ...pb, authorization: 'orchestrator-go' };
    assert.deepEqual(
      validate(schema('run-config.v1.schema.json'), authorized),
      [],
    );
    providerPreflight({ config: authorized, identity: identity(true), setup });
    assert.throws(
      () =>
        providerPreflight({
          config: authorized,
          identity: identity(true),
          setup: { ...setup, closures: {} },
        }),
      /setup\.closures\..* is required by discovery-positive-card-vocabulary/,
    );
    // A refused task (installation: no local mirror) needs no closure.
    providerPreflight({
      config: {
        ...authorized,
        tasks: [
          'discovery-positive-card-vocabulary',
          'installation-positive-vite',
        ],
      },
      identity: identity(true),
      setup,
    });
    // B3: the team-2 rule is enforced for provider-backed matrices.
    assert.throws(
      () =>
        providerPreflight({
          config: {
            ...authorized,
            credentials: {
              ...authorized.credentials,
              claude: {
                mode: 'access-only',
                source: { configDir: '~/.claude', account: 'claude-team-2' },
              },
            },
          },
          identity: identity(true),
          setup,
        }),
      /must be ~\/\.claude-t3\/team-2/,
    );
    assert.throws(
      () =>
        providerPreflight({
          config: {
            ...authorized,
            credentials: {
              ...authorized.credentials,
              claude: { ...authorized.credentials.claude, synthetic: true },
            },
          },
          identity: identity(true),
          setup,
        }),
      /synthetic is allowed in adapter-fixture matrices only/,
    );
    assert.throws(
      () =>
        providerPreflight({
          config: authorized,
          identity: identity(false),
          setup,
        }),
      /dirty checkout/,
    );
    assert.throws(
      () =>
        providerPreflight({
          config: authorized,
          identity: identity(true),
          setup: {},
        }),
      /setup schema/,
    );
    assert.throws(
      () =>
        providerPreflight({
          config: {
            ...authorized,
            credentials: { codex: authorized.credentials.codex },
          },
          identity: identity(true),
          setup,
        }),
      /credentials\.claude is required/,
    );
    assert.throws(
      () =>
        providerPreflight({
          config: { ...authorized, budgets: { timeoutSecondsOverride: 1 } },
          identity: identity(true),
          setup,
        }),
      /timeoutSecondsOverride/,
    );
    process.env.CI = 'true';
    assert.throws(
      () =>
        providerPreflight({
          config: authorized,
          identity: identity(true),
          setup,
        }),
      /never started in CI/,
    );
    // Fixture-only inputs are refused in a provider-backed matrix file.
    assert.ok(
      validate(schema('run-config.v1.schema.json'), {
        ...authorized,
        adapterFixtures: { '*': ['x'] },
      }).length > 0,
    );
  } finally {
    if (ci === undefined) delete process.env.CI;
    else process.env.CI = ci;
  }
  // The Codex evidence used by the fixtures matches the request.
  assert.equal(CODEX_EVIDENCE.matchesRequest, true);
});
