/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Credential-free Docker integration tests (review round 1, B5-B7): the real
// containers of an attempt with the fake CLI image: the isolation self-test
// of a run configuration accepted by preflight, the Codex `-C` path and the
// CLI's working directory inside the agent container, and a grading round
// trip in the grader container reading the runner-private staging. No
// credential, no provider: the fake CLI never leaves the container.
//
// Opt-in (images are built, containers started): PMS_RUNNER_DOCKER_TESTS=1
// `yarn bench:agentic:runner:docker-test`. Needs Docker 28 or later (isolated
// gateway mode) and the pinned node base image.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MODELS,
  claudeInit,
  claudeResult,
  claudeText,
  codexDone,
  codexMessage,
  codexStart,
  fixtureConfig,
  fixtureIdentity,
  goodDiscoveryResponse,
  recordsOf,
  tmpDir,
  writeScenario,
  assertDocumentsValid,
} from './helpers.mjs';
import { DockerExecutor, containerEvaluator, docker } from '../src/docker.mjs';
import { buildFixtureAgentImage, buildHarnessImage } from '../src/images.mjs';
import { runMatrix } from '../src/matrix.mjs';
import { requireValidSelfTest, runSelfTest } from '../src/selftest.mjs';
import { trustedTreeDigests } from '../src/trusted-tree.mjs';
import { REPO_ROOT, readJson } from '../src/util.mjs';

const ENABLED = process.env.PMS_RUNNER_DOCKER_TESTS === '1';
const DISCOVERY = 'discovery-positive-card-vocabulary';

let images = null;
function fixtureImages() {
  if (images) return images;
  const harness = buildHarnessImage({ tag: 'pms-agentic-test-harness:local' });
  const agent = buildFixtureAgentImage({
    tag: 'pms-agentic-test-agent:local',
    harnessTag: 'pms-agentic-test-harness:local',
  });
  images = { agent, proxy: harness, grader: harness, baseDigest: null };
  return images;
}

function dockerConfig(over = {}) {
  return fixtureConfig({
    images: fixtureImages(),
    network: {
      mode: 'per-attempt-internal-isolated-gateway',
      ipv6: false,
      allow: { claude: ['example.org:443'], codex: ['example.org:443'] },
    },
    container: {
      cpus: 1,
      memoryBytes: 1024 * 1024 * 1024,
      pidsLimit: 256,
      tmpfsBytes: 128 * 1024 * 1024,
      workspaceBytesCap: 512 * 1024 * 1024,
    },
    ...over,
  });
}

/**
 * Test-only trusted tree: the built workspace packages and their dependency
 * closure, dereferenced (the repository links them), as a self-contained
 * node_modules the grader mounts read-only. Provider-backed runs use the
 * verified product tarballs instead (section 4.8).
 */
function devTrustedTree() {
  const dest = path.join(tmpDir('trusted'), 'node_modules');
  const rootNm = path.join(REPO_ROOT, 'node_modules');
  const seen = new Set();
  const queue = ['@pandamstyle/compiler', '@pandamstyle/core'];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = fs.realpathSync(path.join(rootNm, name));
    const pkg = readJson(path.join(src, 'package.json'));
    fs.cpSync(src, path.join(dest, name), {
      recursive: true,
      dereference: true,
      filter: (p) => !p.slice(src.length).startsWith('/node_modules/.cache'),
    });
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push(d);
  }
  return dest;
}

test(
  'B5 the self-test of a run configuration is the evidence preflight accepts',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const stateDir = tmpDir('selftest-state');
    const config = dockerConfig();
    const result = await runSelfTest({ stateDir, config });
    assert.equal(
      result.passed,
      true,
      JSON.stringify(result.checks.filter((c) => !c.pass)),
    );
    assert.ok(
      result.checks.some(
        (c) => c.id === 'net.proxy.allows claude example.org:443' && c.pass,
      ),
    );
    assert.ok(
      result.checks.some((c) => c.id === 'grader.read-only /final/x' && c.pass),
    );
    assert.equal(
      requireValidSelfTest({ stateDir, config }).bindingDigest,
      result.bindingDigest,
    );
    assert.throws(
      () =>
        requireValidSelfTest({
          stateDir,
          config: dockerConfig({
            network: {
              ...config.network,
              allow: { claude: ['other.example:443'] },
            },
          }),
        }),
      /no isolation self-test/,
    );
  },
);

async function dockerAttempt({ model, steps, grade = true }) {
  const scenario = writeScenario(tmpDir('dscn'), 's', { steps });
  const config = dockerConfig({ models: [model] });
  const trusted = grade ? devTrustedTree() : null;
  const executor = new DockerExecutor({
    images: { agent: config.images.agent, harness: config.images.proxy },
    limits: config.container,
    allow: config.network.allow,
    cliBinary: { claude: '/opt/cli/claude', codex: '/opt/cli/codex' },
    fixtureScenario: scenario,
    auditIntervalMs: 2000,
  });
  const root = tmpDir('docker-runs');
  const out = await runMatrix({
    config,
    runsRoot: root,
    stateDir: path.join(root, '.state'),
    identity: fixtureIdentity(),
    executorFor: () => executor,
    effectiveConfigFor: (m) =>
      m.cli === 'codex'
        ? {
            source: 'fixture',
            tools: null,
            subagents: 'disabled-evidenced',
            web: 'disabled-configured',
            builtins: [],
            effort: null,
            model: null,
            matchesRequest: true,
          }
        : null,
    grading: grade
      ? {
          mode: 'trusted',
          trustedNodeModules: trusted,
          trustedExpected: trustedTreeDigests(trusted),
          hostCommands: false,
          evaluate: containerEvaluator({
            image: config.images.grader,
            harnessDir: REPO_ROOT,
          }),
        }
      : {
          mode: 'dev-ancestor',
          hostCommands: false,
          evaluate: () => ({
            status: 'completed',
            result: { verdict: 'pass', checks: [] },
            resultSha256: '0'.repeat(64),
          }),
        },
  });
  assertDocumentsValid(out.matrixDir);
  return { out, record: recordsOf(out.matrixDir)[0] };
}

test(
  'B6 + B7 Codex in the agent container: -C /workspace, cwd /workspace, graded in the grader container',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { out, record } = await dockerAttempt({
      model: MODELS.sol,
      // Long enough for channel-audit samples (the first one at 1 s).
      steps: [
        ...codexStart(),
        { run: 'pwd && id -u' },
        { sleep: 2500 },
        codexMessage(goodDiscoveryResponse()),
        codexDone(),
      ],
    });
    const argv = record.modelConfig.rawArgv;
    assert.equal(argv[argv.indexOf('-C') + 1], '/workspace');
    assert.equal(argv[argv.indexOf('-o') + 1], '/run/agent/last-message.txt');
    const stream = fs.readFileSync(
      path.join(
        out.matrixDir,
        'cells',
        DISCOVERY,
        'gpt-sol',
        'rep-1/attempt-1/stream.jsonl',
      ),
      'utf8',
    );
    assert.match(
      stream,
      /"aggregated_output":"\/workspace\\n\d+\\n"/,
      'the command ran in /workspace inside the container',
    );
    assert.equal(record.outcome.code, 'completed');
    // B7: the grader (container, runner UID) read the private staging.
    assert.deepEqual(
      record.grading.passes.map((p) => [p.pass, p.status]),
      [['G1', 'completed']],
    );
    assert.equal(
      record.grading.verdict,
      'pass',
      JSON.stringify(record.grading.failingRequiredChecks),
    );
    assert.equal(record.trustedTree.mode, 'trusted');
    assert.equal(record.integrity.proxy.connections, 0);
    assert.ok(record.integrity.channelAudit.samples >= 1);
    assert.ok(
      Number.isInteger(record.integrity.channelAudit.foreignStreamHolders),
    );
    // Nothing left behind: containers, networks, working copies.
    assert.equal(
      docker([
        'ps',
        '-aq',
        '--filter',
        'label=pms-agentic=agent',
      ]).stdout.trim(),
      '',
    );
    assert.equal(fs.existsSync(path.join(out.matrixDir, '.work')), false);
  },
);

test(
  'B6 Claude in the agent container: the read-only workspace denies writes',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { record } = await dockerAttempt({
      model: MODELS.haiku,
      grade: false,
      steps: [
        claudeInit(),
        { run: 'pwd' },
        { write: { path: 'x.txt', content: 'x' } },
        claudeText('done'),
        claudeResult({ text: 'done' }),
      ],
    });
    assert.equal(record.outcome.code, 'completed');
    assert.deepEqual(record.metrics.scopeViolations.prevented, [
      'write denied: x.txt',
    ]);
  },
);

// Review round 2, B4: partial startup over real Docker. A failure injected
// after each resource-creation step (and the reviewer's invalid CPU limit)
// must leave nothing behind; a cleanup that cannot be verified keeps the
// recovery state, refuses the provider durably, and the next start recovers.

function startFailureExecutor({
  failStep = null,
  failRemoval = false,
  limits,
} = {}) {
  const config = dockerConfig();
  const scenario = writeScenario(tmpDir('b4scn'), 's', {
    steps: [claudeInit(), claudeResult()],
  });
  let creations = 0;
  const run = (args, opts) => {
    const creating =
      (args[0] === 'network' &&
        (args[1] === 'create' || args[1] === 'connect') &&
        !args.includes('pms-agentic-egress=1')) ||
      (args[0] === 'run' && args[1] === '-d');
    if (creating) {
      creations += 1;
      if (creations === failStep)
        return {
          status: 1,
          stdout: '',
          stderr: `injected failure at creation step ${failStep}`,
        };
    }
    if (
      failRemoval &&
      (args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'))
    )
      return { status: 1, stdout: '', stderr: 'injected removal failure' };
    return docker(args, opts);
  };
  const resources = [];
  const ex = new DockerExecutor({
    images: { agent: config.images.agent, harness: config.images.proxy },
    limits: limits ?? config.container,
    allow: config.network.allow,
    cliBinary: { claude: '/opt/cli/claude', codex: '/opt/cli/codex' },
    fixtureScenario: scenario,
    run,
  });
  const start = ex.start.bind(ex);
  ex.start = (args) =>
    start({
      ...args,
      onResources: (r) => {
        resources.push(r);
        args.onResources(r);
      },
    });
  return { ex, resources, config };
}

const exists = (r) => ({
  container: docker(['container', 'inspect', r.container]).status === 0,
  proxy: docker(['container', 'inspect', r.proxy]).status === 0,
  network: docker(['network', 'inspect', r.network]).status === 0,
});

async function runStartFailure(opts) {
  const { ex, resources, config } = startFailureExecutor(opts);
  const root = tmpDir('b4runs');
  const stateDir = path.join(root, '.state');
  const out = await runMatrix({
    config,
    runsRoot: root,
    stateDir,
    identity: fixtureIdentity(),
    executorFor: () => ex,
    grading: { mode: 'dev-ancestor', hostCommands: false },
  });
  return { out, resources, root, stateDir };
}

test(
  'B4 partial startup over real Docker: a failure after each creation step leaves nothing behind',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { activeRefusals } = await import('../src/refusals.mjs');
    for (const failStep of [1, 2, 3, 4]) {
      const { out, resources, stateDir } = await runStartFailure({ failStep });
      assert.match(
        out.outcomes[0].reason,
        new RegExp(`injected failure at creation step ${failStep}`),
      );
      assert.deepEqual(
        exists(resources[0]),
        { container: false, proxy: false, network: false },
        `step ${failStep}`,
      );
      assert.equal(
        fs.existsSync(path.join(out.matrixDir, '.private')),
        false,
        `step ${failStep}`,
      );
      assert.deepEqual(activeRefusals(stateDir), {}, `step ${failStep}`);
    }
    // The reviewer's case: an invalid CPU limit makes the agent container fail.
    const cpu = await runStartFailure({
      limits: { ...dockerConfig().container, cpus: -1 },
    });
    assert.match(cpu.out.outcomes[0].reason, /agent container/);
    assert.deepEqual(exists(cpu.resources[0]), {
      container: false,
      proxy: false,
      network: false,
    });
  },
);

test(
  'B4 an unverifiable cleanup over real Docker is retained, refused and recovered at the next start',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { activeRefusals } = await import('../src/refusals.mjs');
    const { recoverStale } = await import('../src/recovery.mjs');
    const { out, resources, root, stateDir } = await runStartFailure({
      failStep: 4,
      failRemoval: true,
    });
    try {
      assert.equal(
        exists(resources[0]).proxy,
        true,
        'the injected removal failure left the proxy',
      );
      const kept = fs.readdirSync(path.join(out.matrixDir, '.private'));
      assert.equal(kept.length, 1);
      assert.match(
        activeRefusals(stateDir).claude.events[0].reason,
        /partial startup not cleaned up/,
      );
      const report = recoverStale(root, { stateDir });
      assert.equal(report[0].cleanup, 'verified');
      assert.deepEqual(exists(resources[0]), {
        container: false,
        proxy: false,
        network: false,
      });
      assert.equal(fs.existsSync(path.join(out.matrixDir, '.private')), false);
    } finally {
      docker(['rm', '-f', resources[0].proxy, resources[0].container]);
      docker(['network', 'rm', resources[0].network]);
    }
  },
);

test(
  "B4 the reviewer's daemon-outage case over real Docker: kept, refused, then recovered when the daemon answers",
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { activeRefusals } = await import('../src/refusals.mjs');
    const { recoverStale } = await import('../src/recovery.mjs');
    const config = dockerConfig();
    const scenario = writeScenario(tmpDir('b4dscn'), 's', { steps: [] });
    let down = false;
    const run = (args, opts) => {
      if (down)
        return {
          status: 1,
          stdout: '',
          stderr:
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        };
      const r = docker(args, opts);
      if (
        args[0] === 'run' &&
        args.some((a) => String(a).startsWith('pms-agent-')) &&
        r.status !== 0
      )
        down = true;
      return r;
    };
    const resources = [];
    const ex = new DockerExecutor({
      images: { agent: config.images.agent, harness: config.images.proxy },
      limits: { ...config.container, cpus: -1 },
      allow: config.network.allow,
      cliBinary: { claude: '/opt/cli/claude' },
      fixtureScenario: scenario,
      run,
    });
    const start = ex.start.bind(ex);
    ex.start = (args) =>
      start({
        ...args,
        onResources: (r) => {
          resources.push(r);
          args.onResources(r);
        },
      });
    const root = tmpDir('b4druns');
    const stateDir = path.join(root, '.state');
    try {
      const out = await runMatrix({
        config,
        runsRoot: root,
        stateDir,
        identity: fixtureIdentity(),
        executorFor: () => ex,
        grading: { mode: 'dev-ancestor', hostCommands: false },
      });
      assert.deepEqual(
        exists(resources[0]),
        { container: false, proxy: true, network: true },
        'the outage left the proxy and network alive',
      );
      assert.equal(
        fs.readdirSync(path.join(out.matrixDir, '.private')).length,
        1,
        'recovery state kept',
      );
      assert.match(
        activeRefusals(stateDir).claude.events[0].reason,
        /\(unknown\)/,
      );
      const report = recoverStale(root, { stateDir });
      assert.equal(report[0].cleanup, 'verified');
      assert.deepEqual(exists(resources[0]), {
        container: false,
        proxy: false,
        network: false,
      });
    } finally {
      docker(['rm', '-f', resources[0].proxy, resources[0].container]);
      docker(['network', 'rm', resources[0].network]);
    }
  },
);
