/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Docker roles of an attempt (DESIGN.md sections 4.2, 4.3 and 4.6): a
// per-attempt internal network with the isolated gateway mode and no IPv6, a
// per-attempt CONNECT proxy, the agent container (harness-UID supervisor,
// CLI and tools started by `docker exec` as the agent UID), credential
// delivery and export through exec streams, the channel-audit sidecar and
// credential-free grader containers. The argv builders are pure functions.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sha256 } from './util.mjs';

export const HARNESS_UID = 20001;
// The agent runs as the runner's own host UID so the bind-mounted workspace
// is writable without CAP_CHOWN (implementation finding, DESIGN.md 11.2).
export const agentUid = () => process.getuid();
// Graders run as the same UID, so they can read the runner-private (0700)
// staging they get as read-only mounts; nothing else of the host is
// mounted, and no agent process exists any more when they run (11.2).
export const graderUid = () => process.getuid();

export const NODE = '/opt/node/bin/node';
export const HARNESS_DIR = '/opt/harness';
export const DOCS_MOUNT = '/opt/pandamstyle-agent-docs';

export function networkCreateArgs(name, label = 'attempt') {
  return [
    'network',
    'create',
    '--internal',
    '-o',
    'com.docker.network.bridge.gateway_mode_ipv4=isolated',
    '--label',
    `pms-agentic=${label}`,
    name,
  ];
}

const hardening = (uid) => [
  '--user',
  `${uid}:${uid}`,
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--read-only',
];

export function proxyRunArgs({ name, network, image, allow, port = 3128 }) {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'pms-agentic=proxy',
    '--network',
    network,
    ...hardening(HARNESS_UID),
    '--memory',
    '256m',
    '--pids-limit',
    '64',
    image,
    NODE,
    `${HARNESS_DIR}/connect-proxy.mjs`,
    '--port',
    String(port),
    '--allow',
    allow.join(','),
  ];
}

export function agentRunArgs({
  name,
  network,
  image,
  limits,
  mounts,
  workspace,
  docsDir = null,
  uid = agentUid(),
}) {
  const args = [
    'run',
    '-d',
    '--init',
    '--name',
    name,
    '--label',
    'pms-agentic=agent',
    '--network',
    network,
    ...hardening(HARNESS_UID),
    '--tmpfs',
    `/tmp:rw,exec,size=${limits.tmpfsBytes},mode=1777`,
    '--tmpfs',
    `/run/agent:rw,exec,size=${limits.tmpfsBytes},uid=${uid},gid=${uid},mode=0700`,
    '--cpus',
    String(limits.cpus),
    '--memory',
    String(limits.memoryBytes),
    '--memory-swap',
    String(limits.memoryBytes),
    '--pids-limit',
    String(limits.pidsLimit),
    '--ulimit',
    'nofile=4096:4096',
    '-v',
    `${workspace}:/workspace${mounts.workspaceReadOnly ? ':ro' : ''}`,
  ];
  if (mounts.gitReadOnly && fs.existsSync(path.join(workspace, '.git')))
    args.push('-v', `${path.join(workspace, '.git')}:/workspace/.git:ro`);
  for (const rel of mounts.readOnlyPaths ?? [])
    if (fs.existsSync(path.join(workspace, rel)))
      args.push('-v', `${path.join(workspace, rel)}:/workspace/${rel}:ro`);
  if (docsDir != null) args.push('-v', `${docsDir}:${DOCS_MOUNT}:ro`);
  args.push(image, NODE, `${HARNESS_DIR}/supervisor.mjs`);
  return args;
}

export function execArgs({
  container,
  uid = agentUid(),
  env = {},
  workdir = '/workspace',
  interactive = false,
  command,
}) {
  const args = ['exec'];
  if (interactive) args.push('-i');
  args.push('-u', `${uid}:${uid}`, '-w', workdir);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(container, ...command);
  return args;
}

export function graderRunArgs({
  image,
  harnessDir,
  trustedDir,
  baselineDir,
  finalDir,
  inputsDir,
  tmpfsBytes,
  evaluateArgs,
}) {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    ...hardening(graderUid()),
    '--tmpfs',
    `/scratch:rw,exec,size=${tmpfsBytes},mode=1777`,
    '--tmpfs',
    '/tmp:rw,exec,size=268435456,mode=1777',
    '-v',
    `${harnessDir}:/harness:ro`,
    '-v',
    `${trustedDir}:/trusted:ro`,
    '-v',
    `${baselineDir}:/baseline:ro`,
    '-v',
    `${finalDir}:/final:ro`,
    '-v',
    `${inputsDir}:/inputs:ro`,
    image,
    NODE,
    '/harness/benchmarks/agentic/bin/pms-agentic.mjs',
    'evaluate',
    ...evaluateArgs,
  ];
}

export function auditRunArgs({ container, image, cliName, uid = agentUid() }) {
  return [
    'run',
    '--rm',
    '--pid',
    `container:${container}`,
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'SYS_PTRACE',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--user',
    '0:0',
    image,
    NODE,
    `${HARNESS_DIR}/channel-audit.mjs`,
    String(uid),
    cliName,
  ];
}

export function docker(args, opts = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function must(r, what) {
  if (r.status !== 0)
    throw Object.assign(new Error(`${what}: ${r.stderr}`), {
      code: 'container',
    });
  return r.stdout.trim();
}

/** cgroup v2 counters of a container (systemd driver path), or null. */
export function readCgroup(containerId) {
  const dir = `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`;
  try {
    const cpu = /usage_usec (\d+)/.exec(
      fs.readFileSync(path.join(dir, 'cpu.stat'), 'utf8'),
    );
    const mem = fs.readFileSync(path.join(dir, 'memory.peak'), 'utf8').trim();
    const pids = fs.readFileSync(path.join(dir, 'pids.peak'), 'utf8').trim();
    return {
      cpuUsageUsec: Number(cpu?.[1]),
      memoryPeakBytes: Number(mem),
      pidsPeak: Number(pids),
    };
  } catch {
    return null;
  }
}

/**
 * Docker executor. `images` = { agent, harness }; `cliBinary` maps the CLI
 * name to its path in the agent image.
 */
export class DockerExecutor {
  constructor({
    images,
    limits,
    allow,
    docsDir = null,
    egressNetwork = 'pms-agentic-egress',
    cliBinary,
    auditIntervalMs = 10000,
    fixtureScenario = null,
    run = null,
  }) {
    this.name = 'docker';
    this.isolated = true;
    this.images = images;
    this.limits = limits;
    this.allow = allow;
    this.docsDir = docsDir;
    this.egressNetwork = egressNetwork;
    this.cliBinary = cliBinary;
    this.auditIntervalMs = auditIntervalMs;
    // Adapter fixtures only: the fake CLI's scenario, mounted read-only.
    this.fixtureScenario = fixtureScenario;
    // Injectable for tests (failure injection over real Docker calls).
    this.run = run ?? docker;
  }

  /** Paths as the CLI sees them inside the agent container (section 3.2). */
  visiblePaths() {
    return { workspace: '/workspace', home: '/run/agent' };
  }

  /**
   * Starts an attempt's containers and the CLI. Every resource name is
   * recorded (`onResources`) before anything is created; if any later step
   * fails, everything already created is removed and the removal verified
   * before the error propagates (`error.cleanupRemaining` lists what could
   * not be removed).
   */
  start(args) {
    if (this.fixtureScenario != null && args.kind !== 'adapter-fixture')
      throw new Error(
        'a fixture scenario is only allowed in adapter-fixture attempts',
      );
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const resources = {
      network: `pms-att-${id}`,
      proxy: `pms-proxy-${id}`,
      container: `pms-agent-${id}`,
    };
    (args.onResources ?? (() => {}))(resources);
    try {
      return this.startResources(args, resources);
    } catch (error) {
      error.cleanupRemaining = removeVerified(resources, this.run);
      throw error;
    }
  }

  /** Verified removal of an attempt's resources (partial startup, recovery). */
  cleanupResources(resources) {
    return removeVerified(resources, this.run);
  }

  startResources(
    { cli, argv, env, stdinText, workspace, credential, mounts },
    resources,
  ) {
    const run = this.run;
    const { network, proxy } = resources;
    const agent = resources.container;
    if (run(['network', 'inspect', this.egressNetwork]).status !== 0)
      must(
        run([
          'network',
          'create',
          '--label',
          'pms-agentic-egress=1',
          this.egressNetwork,
        ]),
        'egress network',
      );
    must(run(networkCreateArgs(network)), 'attempt network');
    must(
      run(
        proxyRunArgs({
          name: proxy,
          network,
          image: this.images.harness,
          allow: this.allow[cli] ?? [],
        }),
      ),
      'proxy',
    );
    must(
      run(['network', 'connect', this.egressNetwork, proxy]),
      'proxy egress',
    );
    const runArgs = agentRunArgs({
      name: agent,
      network,
      image: this.images.agent,
      limits: this.limits,
      mounts,
      workspace,
      docsDir: this.docsDir,
    });
    if (this.fixtureScenario != null)
      runArgs.splice(
        runArgs.indexOf(this.images.agent),
        0,
        '-v',
        `${this.fixtureScenario}:/opt/fixture/scenario.json:ro`,
      );
    const containerId = must(run(runArgs), 'agent container');
    const home = '/run/agent';
    const cliEnv = {
      HOME: home,
      ...(cli === 'claude'
        ? { CLAUDE_CONFIG_DIR: `${home}/.claude` }
        : { CODEX_HOME: home }),
      HTTPS_PROXY: `http://${proxy}:3128`,
      HTTP_PROXY: `http://${proxy}:3128`,
      PATH: '/opt/node/bin:/opt/cli:/usr/local/bin:/usr/bin:/bin',
      ...(this.fixtureScenario != null
        ? {
            PMS_FAKE_SCENARIO: '/opt/fixture/scenario.json',
            PMS_FAKE_CLI: cli,
            PMS_FAKE_CREDENTIAL_DIR:
              cli === 'claude' ? `${home}/.claude` : home,
          }
        : {}),
      ...env,
    };
    // Credential delivery on the exec stdin, into the tmpfs.
    for (const f of credential?.files ?? []) {
      must(
        run(
          execArgs({
            container: agent,
            interactive: true,
            command: [NODE, `${HARNESS_DIR}/deliver.mjs`, `${home}/${f.rel}`],
          }),
          { input: f.bytes },
        ),
        'credential delivery',
      );
    }
    const runCli = [NODE, `${HARNESS_DIR}/run-cli.mjs`];
    if (credential && Object.keys(credential.env ?? {}).length > 0) {
      must(
        run(
          execArgs({
            container: agent,
            interactive: true,
            command: [NODE, `${HARNESS_DIR}/deliver.mjs`, `${home}/.cred-env`],
          }),
          { input: JSON.stringify(credential.env) },
        ),
        'credential env delivery',
      );
      runCli.push('--env-file', `${home}/.cred-env`);
    }
    if (credential?.login) {
      must(
        run(
          execArgs({
            container: agent,
            interactive: true,
            env: cliEnv,
            command: [this.cliBinary[cli], ...credential.login.args],
          }),
          { input: credential.login.stdin },
        ),
        'access-only login',
      );
    }
    const binary = this.cliBinary[cli];
    const child = spawn(
      'docker',
      execArgs({
        container: agent,
        interactive: true,
        env: cliEnv,
        command: [...runCli, '--', binary, ...argv.slice(1)],
      }),
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // A CLI may exit before reading its prompt: EPIPE is not a runner error.
    child.stdin.on('error', () => {});
    if (stdinText != null) child.stdin.end(stdinText);
    else child.stdin.end();
    const exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => resolve({ code, signal })),
    );
    const audits = [];
    const audit = () => {
      const r = run(
        auditRunArgs({
          container: agent,
          image: this.images.harness,
          cliName: path.basename(binary),
        }),
      );
      if (r.status === 0) {
        try {
          audits.push(JSON.parse(r.stdout.trim().split('\n').at(-1)));
        } catch {
          // Malformed audit output is recorded as no sample.
        }
      }
    };
    const auditTimer = setInterval(audit, this.auditIntervalMs);
    const firstAudit = setTimeout(audit, 1000);
    const signalCli = (sig) =>
      run(
        execArgs({
          container: agent,
          command: [
            NODE,
            `${HARNESS_DIR}/signal-cli.mjs`,
            sig,
            'cli',
            path.basename(binary),
          ],
        }),
      );
    let cgroup = null;
    return {
      containerName: agent,
      stdout: child.stdout,
      stderr: child.stderr,
      wait: () => exited,
      interrupt: () => signalCli('SIGINT'),
      terminate: () => signalCli('SIGTERM'),
      killAll: () => {
        clearInterval(auditTimer);
        clearTimeout(firstAudit);
        cgroup ??= readCgroup(containerId);
        run(
          execArgs({
            container: agent,
            command: [NODE, `${HARNESS_DIR}/signal-cli.mjs`, 'SIGKILL', 'all'],
          }),
        );
      },
      exportCredential: (rel) => {
        const r = run(
          execArgs({
            container: agent,
            command: [
              NODE,
              `${HARNESS_DIR}/export-credential.mjs`,
              `${home}/${rel}`,
            ],
          }),
        );
        if (r.status !== 0)
          return { error: (r.stderr || 'export-failed').trim().slice(0, 40) };
        return { bytes: Buffer.from(r.stdout.trim(), 'base64') };
      },
      // Removes the agent container, the proxy and the network; returns
      // whether their removal was verified.
      destroy: () => {
        clearInterval(auditTimer);
        clearTimeout(firstAudit);
        const remaining = removeVerified(resources, run);
        return remaining.length === 0;
      },
      cgroup: () =>
        cgroup == null
          ? null
          : {
              cpuUsageUsec: Number.isFinite(cgroup.cpuUsageUsec)
                ? {
                    status: 'observed',
                    value: cgroup.cpuUsageUsec,
                    source: 'cgroup cpu.stat',
                    integrity: 'harness',
                    method: null,
                    unit: 'usec',
                  }
                : {
                    status: 'unknown',
                    value: null,
                    source: 'cgroup cpu.stat',
                    integrity: null,
                    method: null,
                    unit: 'usec',
                  },
            },
      resourceLimit: () => {
        const r = run(['inspect', '-f', '{{.State.OOMKilled}}', agent]);
        return r.stdout.trim() === 'true';
      },
      channelAudit: () => summarizeAudits(audits),
      proxyLog: () => {
        const r = run(['logs', proxy]);
        return r.status === 0 ? r.stdout : null;
      },
    };
  }
}

/** Removes containers and a network, then lists what still exists. */
function escapeRe(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * State of one Docker object from an inspection: `present`, `absent` only on
 * the daemon's definitive answer naming that object ("No such container:
 * <name>", "network <name> not found", "No such object: <name>"), otherwise
 * `unknown` (daemon unreachable, timeout, any other error).
 */
export function inspectState(kind, name, run = docker) {
  const r = run([kind, 'inspect', name]);
  if (r.status === 0) return 'present';
  const err = `${r.stderr ?? ''}${r.stdout ?? ''}`;
  const n = escapeRe(name);
  const absent =
    kind === 'container'
      ? new RegExp(`No such (container|object): ${n}(\\s|$)`)
      : new RegExp(
          `(network ${n} not found|No such (network|object): ${n}(\\s|$))`,
        );
  return absent.test(err) ? 'absent' : 'unknown';
}

/**
 * Removes containers and a network, then lists what is not provably gone:
 * an object still present, or one whose absence the daemon did not confirm
 * (`<name> (unknown)`). Callers treat any entry as an unverified cleanup.
 */
export function removeVerified(resources, run = docker) {
  const containers = [resources.container, resources.proxy].filter(Boolean);
  if (containers.length > 0) run(['rm', '-f', ...containers]);
  if (resources.network) run(['network', 'rm', resources.network]);
  const remaining = [];
  for (const [kind, name] of [
    ...containers.map((c) => ['container', c]),
    ...(resources.network ? [['network', resources.network]] : []),
  ]) {
    const state = inspectState(kind, name, run);
    if (state === 'present') remaining.push(name);
    else if (state === 'unknown') remaining.push(`${name} (unknown)`);
  }
  return remaining;
}

let dockerAvailable = null;
export function hasDockerSync() {
  dockerAvailable ??=
    spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      encoding: 'utf8',
    }).status === 0;
  return dockerAvailable;
}

/**
 * Summary of the channel-audit samples (section 4.4). A sample that did not
 * see the CLI or lacks a count makes the summary unknown (null), never clean.
 */
export function summarizeAudits(audits) {
  const seen = audits.filter((a) => a.cliFound === true);
  const counts = audits.map((a) => a.foreignStreamHolders);
  return {
    samples: audits.length,
    cliNonDumpable:
      seen.length === 0 ? null : seen.every((a) => a.cliNonDumpable === true),
    foreignStreamHolders:
      audits.length > 0 && counts.every(Number.isInteger)
        ? counts.reduce((n, x) => n + x, 0)
        : null,
    controlSocketConnections: null,
  };
}

/**
 * Containers and networks of attempts (labels `pms-agentic=agent|proxy|
 * attempt`), for the crash-recovery sweep. The self-test uses its own label.
 */
export function staleResources(run = docker) {
  const list = (args) => run(args).stdout.trim().split('\n').filter(Boolean);
  const containers = [
    ...list(['ps', '-aq', '--filter', 'label=pms-agentic=agent']),
    ...list(['ps', '-aq', '--filter', 'label=pms-agentic=proxy']),
  ];
  const networks = list([
    'network',
    'ls',
    '-q',
    '--filter',
    'label=pms-agentic=attempt',
  ]);
  return { containers, networks };
}

export function hostAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal)
    .map((a) => a.address)
    .sort();
}

/**
 * Grading inside a credential-free grader container (section 4.2): G1
 * without host commands, G2 with them. The result leaves only through the
 * container's stdout.
 */
export function containerEvaluator({
  image,
  harnessDir,
  tmpfsBytes = 2 * 1024 * 1024 * 1024,
}) {
  return ({
    hostCommands,
    taskId,
    epoch,
    baselineDir,
    workspaceDir,
    inputsDir,
    trustedNodeModules,
  }) => {
    const evaluateArgs = [
      taskId,
      '--baseline',
      '/baseline',
      '--workspace',
      '/final',
      '--response',
      '/inputs/final-message.txt',
      '--transcript',
      '/inputs/transcript.jsonl',
      '--observations',
      '/inputs/observations.json',
      '--epoch',
      epoch,
      '--scratch',
      '/scratch',
      '--trusted-node-modules',
      '/trusted/node_modules',
    ];
    if (hostCommands) evaluateArgs.push('--host-commands');
    const r = docker(
      graderRunArgs({
        image,
        harnessDir,
        trustedDir: path.dirname(trustedNodeModules),
        baselineDir,
        finalDir: workspaceDir,
        inputsDir,
        tmpfsBytes,
        evaluateArgs,
      }),
      { timeout: 20 * 60 * 1000 },
    );
    if (r.status !== 0)
      return { status: 'harness-error', error: (r.stderr || '').slice(-2000) };
    try {
      return {
        status: 'completed',
        result: JSON.parse(r.stdout),
        resultSha256: sha256(r.stdout),
      };
    } catch {
      return { status: 'harness-error', error: 'unparseable evaluate output' };
    }
  };
}

/** CLI identity inside an image: `--version` and the binary's sha256. */
export function observeCliIdentity({ image, binary }) {
  const version = docker([
    'run',
    '--rm',
    '--network',
    'none',
    image,
    binary,
    '--version',
  ]);
  const digest = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0:0',
    image,
    NODE,
    '-e',
    `const c=require('crypto');console.log(c.createHash('sha256').update(require('fs').readFileSync(${JSON.stringify(binary)})).digest('hex'))`,
  ]);
  return { version: version.stdout.trim(), sha256: digest.stdout.trim() };
}

/** Refuses a matrix whose CLI differs from the pinned identity (section 3.7). */
export function checkCliIdentity({ expected, observed }) {
  const problems = [];
  if (!observed.version.includes(expected.cliVersion))
    problems.push(`version ${observed.version} is not ${expected.cliVersion}`);
  if (observed.sha256 !== expected.cliSha256)
    problems.push('binary sha256 differs');
  if (problems.length > 0) {
    const e = new Error(
      `CLI drift for ${expected.cli}: ${problems.join('; ')}`,
    );
    e.code = 'drift';
    throw e;
  }
  return true;
}
