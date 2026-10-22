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
//
// Concurrent runs share one Docker daemon (CI jobs on the self-hosted
// runner). With the containerd image store, `docker build -t <tag>` deletes
// the image the tag pointed to, and every rebuild yields a new image id, so a
// fixed tag lets another run delete the images this run uses by id. Every
// image tag and Docker name the suite creates is therefore unique to the run,
// the run removes only its own tags (never forced, never a prune), and each
// assertion on leftovers is scoped to the run's own resources. The runner
// also enumerates daemon-wide state (the self-test lists every network, then
// inspects them), so the suite holds a daemon-wide lock for all of its Docker
// work (docker-lock.mjs): concurrent suites queue, bounded by LOCK_WAIT_MS,
// and a suite that loses the lock stops its Docker work and fails.
// Concurrency check (separate checkouts or one):
//   for i in 1 2 3; do (sleep $((i * 30 - 30)); \
//     yarn bench:agentic:runner:docker-test) & done; wait

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MODELS,
  claudeInit,
  claudeResult,
  claudeText,
  codexCredentialDoc,
  codexDone,
  codexMessage,
  codexStart,
  fixtureConfig,
  fixtureIdentity,
  goodDiscoveryResponse,
  recordsOf,
  syntheticCredentialDir,
  tmpDir,
  writeScenario,
  assertDocumentsValid,
} from './helpers.mjs';
import {
  acquireDockerLock,
  assertDockerLockHeld,
  releaseDockerLock,
} from './docker-lock.mjs';
import { DockerExecutor, containerEvaluator, docker } from '../src/docker.mjs';
import {
  IMAGE_PATH,
  buildFixtureAgentImage,
  buildHarnessImage,
} from '../src/images.mjs';
import { runMatrix } from '../src/matrix.mjs';
import { requireValidSelfTest, runSelfTest } from '../src/selftest.mjs';
import { trustedTreeDigests } from '../src/trusted-tree.mjs';
import { REPO_ROOT, readJson } from '../src/util.mjs';

const ENABLED = process.env.PMS_RUNNER_DOCKER_TESTS === '1';
const DISCOVERY = 'discovery-positive-card-vocabulary';

const RUN_ID = `${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Tags of one run's fixture images (`runId` names the run). */
const tagsOf = (runId) => ({
  harness: `pms-agentic-test-harness:${runId}`,
  agent: `pms-agentic-test-agent:${runId}`,
});

// Every tag this run may create, registered before its build starts.
const ownTags = new Set();

/**
 * Untags a run's own images; Docker deletes an image when its last tag goes
 * and refuses while a container uses it (no force, no prune). A tag whose
 * build never produced it is already gone.
 */
function removeTags(tags) {
  for (const tag of tags) {
    const r = docker(['image', 'rm', tag]);
    if (r.status === 0 || /No such image/.test(r.stderr)) ownTags.delete(tag);
    else process.stderr.write(`image cleanup: ${tag}: ${r.stderr.trim()}\n`);
  }
}

/** Builds a run's fixture images; a partial build removes what it tagged. */
function buildFixtureImages(
  tags,
  { buildAgent = buildFixtureAgentImage } = {},
) {
  const all = [tags.agent, tags.harness];
  for (const tag of all) ownTags.add(tag);
  try {
    const harness = buildHarnessImage({ tag: tags.harness });
    const agent = buildAgent({ tag: tags.agent, harnessTag: tags.harness });
    return { agent, proxy: harness, grader: harness, baseDigest: null };
  } catch (error) {
    removeTags(all);
    throw error;
  }
}

let lock = null;
before(async () => {
  if (ENABLED) lock = await acquireDockerLock({ owner: RUN_ID });
});

// No Docker work without the lock: each test and the image build start only
// while this run still holds it.
beforeEach(() => {
  if (lock) assertDockerLockHeld(lock);
});

after(() => {
  // The run's own tags only: removed whether or not the lock is still held.
  removeTags([...ownTags]);
  if (lock && !releaseDockerLock(lock))
    throw new Error(
      `lost the docker lock ${lock.name} before release: another suite may have run concurrently`,
    );
});

let images = null;
function fixtureImages() {
  if (!images && lock) assertDockerLockHeld(lock);
  images ??= buildFixtureImages(tagsOf(RUN_ID));
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
    // Docker churn between the self-test and preflight (a new bridge and a
    // container's veth, then their removal) keeps the binding: only stable
    // routable host addresses are bound (no timing assumption).
    const churn = `pms-st-churn-${RUN_ID}`;
    try {
      assert.equal(
        docker(['network', 'create', '--label', 'pms-agentic=selftest', churn])
          .status,
        0,
      );
      assert.equal(
        docker([
          'run',
          '-d',
          '--name',
          churn,
          '--network',
          churn,
          config.images.proxy,
          '/opt/node/bin/node',
          '-e',
          'setInterval(() => {}, 1e9)',
        ]).status,
        0,
      );
      assert.equal(
        requireValidSelfTest({ stateDir, config }).bindingDigest,
        result.bindingDigest,
      );
    } finally {
      docker(['rm', '-f', churn]);
      docker(['network', 'rm', churn]);
    }
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

const exists = (r) => ({
  container: docker(['container', 'inspect', r.container]).status === 0,
  proxy: docker(['container', 'inspect', r.proxy]).status === 0,
  network: docker(['network', 'inspect', r.network]).status === 0,
});

/** Records the Docker resources of every attempt `ex` starts. */
function recordResources(ex) {
  const resources = [];
  const start = ex.start.bind(ex);
  ex.start = (args) =>
    start({
      ...args,
      onResources: (r) => {
        resources.push(r);
        args.onResources(r);
      },
    });
  return resources;
}

async function dockerAttempt({
  model,
  steps,
  grade = true,
  credentials,
  scenario: extra = {},
}) {
  const scenario = writeScenario(tmpDir('dscn'), 's', { steps, ...extra });
  const config = dockerConfig({
    models: [model],
    ...(credentials ? { credentials } : {}),
  });
  const trusted = grade ? devTrustedTree() : null;
  const executor = new DockerExecutor({
    images: { agent: config.images.agent, harness: config.images.proxy },
    limits: config.container,
    allow: config.network.allow,
    cliBinary: { claude: '/opt/cli/claude', codex: '/opt/cli/codex' },
    fixtureScenario: scenario,
    auditIntervalMs: 2000,
  });
  const resources = recordResources(executor);
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
  return { out, record: recordsOf(out.matrixDir)[0], resources };
}

test(
  'B6 + B7 Codex in the agent container: -C /workspace, cwd /workspace, graded in the grader container',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { out, record, resources } = await dockerAttempt({
      model: MODELS.sol,
      // Alive across several channel-audit samples (at 1 s, then every
      // 2 s), whatever the start-up latency of `docker exec` and the sidecar.
      steps: [
        ...codexStart(),
        { run: 'pwd && id -u' },
        { sleep: 6000 },
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
    // Section 4.4: the execute-only CLI is non-dumpable and nothing else
    // holds its stream (the launcher is not taken for the CLI).
    assert.ok(record.integrity.channelAudit.samples >= 1);
    assert.equal(record.integrity.channelAudit.cliNonDumpable, true);
    assert.equal(record.integrity.channelAudit.foreignStreamHolders, 0);
    // Nothing left behind: containers, networks, working copies. Scoped to
    // this attempt: a concurrent run's containers carry the same labels.
    assert.equal(resources.length, 1);
    assert.deepEqual(exists(resources[0]), {
      container: false,
      proxy: false,
      network: false,
    });
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
  const ex = new DockerExecutor({
    images: { agent: config.images.agent, harness: config.images.proxy },
    limits: limits ?? config.container,
    allow: config.network.allow,
    cliBinary: { claude: '/opt/cli/claude', codex: '/opt/cli/codex' },
    fixtureScenario: scenario,
    run,
  });
  return { ex, resources: recordResources(ex), config };
}

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
    const ex = new DockerExecutor({
      images: { agent: config.images.agent, harness: config.images.proxy },
      limits: { ...config.container, cpus: -1 },
      allow: config.network.allow,
      cliBinary: { claude: '/opt/cli/claude' },
      fixtureScenario: scenario,
      run,
    });
    const resources = recordResources(ex);
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

test(
  'channel audit in the agent container: a tool child holding the stream is a foreign holder',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const { record } = await dockerAttempt({
      model: MODELS.sol,
      steps: [
        ...codexStart(),
        { holdStream: 6000 },
        codexMessage(goodDiscoveryResponse()),
        codexDone(),
      ],
    });
    assert.equal(record.integrity.channelAudit.cliNonDumpable, true);
    assert.ok(record.integrity.channelAudit.foreignStreamHolders >= 1);
  },
);

test(
  'a rejected Codex access-only login in the agent container falls back to the declared copy',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const cred = syntheticCredentialDir('codex', codexCredentialDoc());
    const before = fs.readFileSync(cred.file);
    const { record } = await dockerAttempt({
      model: MODELS.sol,
      grade: false,
      scenario: { loginRejects: true },
      credentials: {
        claude: { mode: 'none', source: null },
        codex: {
          mode: 'access-only',
          fallback: 'refresh-capable-copy',
          synthetic: true,
          source: { configDir: cred.dir, account: 'synthetic-chatgpt' },
        },
      },
      steps: [
        ...codexStart(),
        { run: 'test -e "$CODEX_HOME/auth.json"' },
        codexMessage(goodDiscoveryResponse()),
        codexDone(),
      ],
    });
    // The rejected start left nothing behind and the attempt ran in mode B.
    assert.equal(record.outcome.code, 'completed');
    assert.equal(record.credential.mode, 'refresh-capable-copy');
    assert.equal(record.credential.accessOnlyRefused, true);
    assert.match(record.credential.accessOnlyLoginError, /not valid JSON/);
    assert.equal(record.credential.export, 'unchanged');
    assert.deepEqual(fs.readFileSync(cred.file), before);
  },
);

test(
  "both CLIs' tool shells see the image PATH: login and non-login bash and sh find node, npm and npx",
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  () => {
    const { agent } = fixtureImages();
    // Codex runs `bash -lc`; Claude's tool shell inherits the exec PATH.
    for (const shell of [
      ['/bin/bash', '-lc'],
      ['/bin/sh', '-lc'],
      ['/bin/bash', '-c'],
      ['/bin/sh', '-c'],
    ]) {
      const r = docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--user',
        '10001:10001',
        '-e',
        'HOME=/tmp',
        agent,
        ...shell,
        // One name per `command -v` (dash takes a single one).
        'for c in node npm npx; do command -v "$c" || exit 1; done && npm --version >/dev/null && printf "PATH=%s" "$PATH"',
      ]);
      const label = shell.join(' ');
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.deepEqual(
        r.stdout.trim().split('\n'),
        [
          '/opt/node/bin/node',
          '/opt/node/bin/npm',
          '/opt/node/bin/npx',
          `PATH=${IMAGE_PATH}`,
        ],
        label,
      );
    }
  },
);

test(
  "a concurrent run's image build leaves this run's images: tags are unique per run",
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  () => {
    const own = fixtureImages();
    const peerTags = tagsOf(`${RUN_ID}-peer`);
    assert.notDeepEqual(peerTags, tagsOf(RUN_ID));
    try {
      // Another run's suite builds its fixture images on the same daemon.
      buildFixtureImages(peerTags);
      for (const id of new Set([own.agent, own.proxy])) {
        const r = docker([
          'run',
          '--rm',
          '--network',
          'none',
          id,
          '/opt/node/bin/node',
          '-e',
          '',
        ]);
        assert.equal(r.status, 0, `${id}: ${r.stderr}`);
      }
    } finally {
      removeTags([peerTags.agent, peerTags.harness]);
    }
    // The peer's cleanup removed only the peer's tags.
    for (const id of new Set([own.agent, own.proxy]))
      assert.equal(docker(['image', 'inspect', id]).status, 0, id);
  },
);

test(
  'a partial fixture build removes the tags it created',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  () => {
    const tags = tagsOf(`${RUN_ID}-partial`);
    assert.throws(
      () =>
        buildFixtureImages(tags, {
          buildAgent: () => {
            // The harness image exists, tagged, when the agent build fails.
            assert.equal(docker(['image', 'inspect', tags.harness]).status, 0);
            assert.ok(ownTags.has(tags.harness) && ownTags.has(tags.agent));
            throw new Error('injected agent build failure');
          },
        }),
      /injected agent build failure/,
    );
    assert.notEqual(docker(['image', 'inspect', tags.harness]).status, 0);
    assert.notEqual(docker(['image', 'inspect', tags.agent]).status, 0);
    assert.equal(ownTags.has(tags.harness) || ownTags.has(tags.agent), false);
  },
);

const LOCK_MODULE = new URL('./docker-lock.mjs', import.meta.url).href;

/** A separate holder process of lock `name`; resolves once it holds it. */
function spawnHolder(name, owner, { detached = false } = {}) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { acquireDockerLock } from ${JSON.stringify(LOCK_MODULE)};
const l = await acquireDockerLock({ owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}, pollMs: 200 });
console.log(JSON.stringify({ id: l.id, cli: l.child.pid }));
setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], detached },
  );
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      out += b;
      if (out.includes('\n')) resolve({ child, ...JSON.parse(out) });
    });
    child.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
  });
}

const lockName = (suffix) => `pms-agentic-docker-test-lock-${RUN_ID}-${suffix}`;

test(
  'the daemon-wide lock: a live holder blocked in synchronous work keeps it (no lease to outlive)',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const name = lockName('live');
    const a = await acquireDockerLock({ owner: 'a', name });
    try {
      // This process is blocked (as in a long `docker build`): it renews
      // nothing while another suite tries for longer than the old lease.
      const b = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { acquireDockerLock } from ${JSON.stringify(LOCK_MODULE)};
try { await acquireDockerLock({ owner: 'b', name: ${JSON.stringify(name)}, waitMs: 8000, pollMs: 200 }); console.log('ACQUIRED'); }
catch (e) { console.log(e.message); }`,
        ],
        { encoding: 'utf8' },
      );
      assert.match(b.stdout, /still held by a after 8000 ms/, b.stderr);
      assertDockerLockHeld(a);
    } finally {
      assert.equal(releaseDockerLock(a), true);
    }
    assert.notEqual(docker(['container', 'inspect', name]).status, 0);
  },
);

test(
  'the daemon-wide lock: an abandoned holder is reclaimed in bounded time, then racing acquirers take turns',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    // SIGKILL of the holder alone (its docker client sees the pipe close) and
    // of its whole process group (the client dies with it).
    for (const group of [false, true]) {
      const name = lockName(group ? 'group' : 'holder');
      const holder = await spawnHolder(name, 'killed', { detached: group });
      const locks = [];
      try {
        assert.equal(
          docker([
            'container',
            'inspect',
            '-f',
            '{{.State.Running}}',
            holder.id,
          ]).stdout.trim(),
          'true',
        );
        process.kill(group ? -holder.child.pid : holder.child.pid, 'SIGKILL');
        const killedAt = Date.now();
        const order = [];
        let reclaimedMs = null;
        const compete = async (owner) => {
          const l = await acquireDockerLock({
            owner,
            name,
            waitMs: 60000,
            pollMs: 200,
          });
          locks.push(l);
          reclaimedMs ??= Date.now() - killedAt;
          order.push(`acquire ${owner}`);
          assertDockerLockHeld(l);
          assert.equal(
            docker([
              'container',
              'inspect',
              '-f',
              '{{.Id}}',
              name,
            ]).stdout.trim(),
            l.id,
          );
          await delay(500);
          order.push(`release ${owner}`);
          assert.equal(releaseDockerLock(l), true);
        };
        const results = await Promise.allSettled([compete('b'), compete('c')]);
        for (const r of results) if (r.status === 'rejected') throw r.reason;
        assert.deepEqual(
          order.map((o) => o.split(' ')[0]),
          ['acquire', 'release', 'acquire', 'release'],
        );
        assert.ok(reclaimedMs < 60000, `reclaimed after ${reclaimedMs} ms`);
        assert.notEqual(
          docker(['container', 'inspect', holder.id]).status,
          0,
          'the abandoned lock container is gone',
        );
      } finally {
        try {
          process.kill(group ? -holder.child.pid : holder.child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        for (const l of locks) releaseDockerLock(l);
      }
    }
  },
);

test(
  'the daemon-wide lock: a holder that lost it stops with a clear error and cannot release another holder',
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const name = lockName('lost');
    const a = await acquireDockerLock({ owner: 'a', name });
    let b = null;
    try {
      assertDockerLockHeld(a);
      // Lost under a live holder (removed by someone else).
      docker(['rm', '-f', a.id]);
      assert.throws(() => assertDockerLockHeld(a), /lost the docker lock/);
      b = await acquireDockerLock({
        owner: 'b',
        name,
        waitMs: 30000,
        pollMs: 200,
      });
      assert.throws(() => assertDockerLockHeld(a), /lost the docker lock/);
      assert.equal(releaseDockerLock(a), false);
      assertDockerLockHeld(b);
      assert.equal(
        docker([
          'container',
          'inspect',
          '-f',
          '{{.HostConfig.NetworkMode}}',
          b.id,
        ]).stdout.trim(),
        'none',
      );
    } finally {
      if (b) assert.equal(releaseDockerLock(b), true);
    }
    assert.notEqual(docker(['container', 'inspect', name]).status, 0);
  },
);

test(
  "the daemon-wide lock: concurrent refused acquirers all name the holder; any other failure reports docker's error",
  { skip: !ENABLED && 'set PMS_RUNNER_DOCKER_TESTS=1' },
  async () => {
    const name = lockName('refused');
    const a = await acquireDockerLock({ owner: 'a', name });
    try {
      // Many failed `docker run` clients at once (as racing suites): each
      // refusal is read in full, never as an empty error.
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () =>
          acquireDockerLock({ owner: 'x', name, waitMs: 0 }),
        ),
      );
      for (const r of results) {
        assert.equal(r.status, 'rejected');
        assert.match(
          r.reason.message,
          /still held by a after 0 ms \(last attempt: docker run exited with code \d+: .*Conflict/s,
        );
      }
      assertDockerLockHeld(a);
    } finally {
      assert.equal(releaseDockerLock(a), true);
    }
    // A failure that is not a held lock surfaces docker's own output.
    await assert.rejects(
      acquireDockerLock({ owner: 'x', name: 'bad name!', waitMs: 0 }),
      /docker lock bad name!: docker run exited with code \d+: .*Invalid container name/s,
    );
  },
);
