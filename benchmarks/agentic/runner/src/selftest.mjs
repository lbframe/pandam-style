/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation self-test (DESIGN.md sections 4.3 and 9.3). Local, Docker, no
// credentials, no model calls. It takes the run configuration it will
// vouch for: its agent, harness (proxy) and grader images, its per-provider
// egress allowlists and container limits, and runs every probe with those
// images and the runner's own container argv builders. Its result is bound
// to `selftestBinding(config, facts)`, the same function provider-backed
// preflight calls, so a result for another configuration, image, allowlist,
// mechanism, Docker version, kernel or host address set is never accepted.
// Every check has a control probe that must observe the opposite outcome.
// Results expire after 24 hours. Images are never built or re-tagged here.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HARNESS_DIR,
  NODE,
  agentRunArgs,
  auditRunArgs,
  docker,
  execArgs,
  graderRunArgs,
  hostAddresses,
  networkCreateArgs,
  proxyRunArgs,
} from './docker.mjs';
import { digestJson, nowIso, writeJson } from './util.mjs';

export const SELFTEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SELFTEST_SCHEMA = 'pms-agentic-selftest/v2';

/** Digest of the container mechanisms the runner applies (argv builders). */
export function mechanismsDigest() {
  const limits = { tmpfsBytes: 1, cpus: 1, memoryBytes: 1, pidsLimit: 1 };
  return digestJson({
    network: networkCreateArgs('<network>'),
    proxy: proxyRunArgs({
      name: '<proxy>',
      network: '<network>',
      image: '<image>',
      allow: ['<allow>'],
    }),
    agent: agentRunArgs({
      name: '<agent>',
      network: '<network>',
      image: '<image>',
      limits,
      mounts: {
        workspaceReadOnly: true,
        gitReadOnly: false,
        readOnlyPaths: [],
      },
      workspace: '/nonexistent-workspace',
      uid: 0,
    }),
    grader: graderRunArgs({
      image: '<image>',
      harnessDir: '<h>',
      trustedDir: '<t>',
      baselineDir: '<b>',
      finalDir: '<f>',
      inputsDir: '<i>',
      tmpfsBytes: 1,
      evaluateArgs: [],
    }).map((a) => a.replace(/^\d+:\d+$/, '<uid>')),
    audit: auditRunArgs({
      container: '<agent>',
      image: '<image>',
      cliName: '<cli>',
      uid: 0,
    }),
  });
}

export function currentFacts() {
  return {
    dockerVersion: docker([
      'version',
      '--format',
      '{{.Server.Version}}',
    ]).stdout.trim(),
    kernel: os.release(),
    hostAddresses: hostAddresses(),
  };
}

/** The binding a self-test result vouches for; preflight computes the same. */
export function selftestBinding(config, facts) {
  return {
    schema: SELFTEST_SCHEMA,
    images: {
      agent: config.images?.agent ?? null,
      harness: config.images?.proxy ?? null,
      grader: config.images?.grader ?? null,
    },
    allow: config.network?.allow ?? null,
    networkMode: config.network?.mode ?? null,
    container: config.container ?? null,
    mechanisms: mechanismsDigest(),
    dockerVersion: facts.dockerVersion,
    kernel: facts.kernel,
    hostAddresses: facts.hostAddresses,
  };
}

function bridgeGateways() {
  const ids = docker(['network', 'ls', '-q', '--filter', 'driver=bridge'])
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  const out = new Set();
  for (const id of ids) {
    const r = docker([
      'network',
      'inspect',
      '-f',
      '{{range .IPAM.Config}}{{.Gateway}} {{end}}',
      id,
    ]);
    for (const g of r.stdout.trim().split(/\s+/))
      if (/^\d+\.\d+\.\d+\.\d+$/.test(g)) out.add(g);
  }
  return [...out];
}

function json(r) {
  try {
    return JSON.parse(r.stdout.trim().split('\n').at(-1));
  } catch {
    return { error: (r.stderr || r.stdout).slice(-500) };
  }
}

/**
 * Runs the self-test for `config` (images must exist locally). Returns the
 * result and writes it under `stateDir` as `selftest-<binding digest>.json`.
 */
export async function runSelfTest({ stateDir, config }) {
  for (const k of ['agent', 'proxy', 'grader'])
    if (!config.images?.[k])
      throw new Error(
        `self-test: config.images.${k} is required (build the images first)`,
      );
  const facts = currentFacts();
  const binding = selftestBinding(config, facts);
  const agentImage = config.images.agent;
  const harness = config.images.proxy;
  const grader = config.images.grader;
  const checks = [];
  const skipped = [];
  // A check passes only on an actual observation: a missing value (probe
  // crashed, output unparseable) always fails.
  const check = (id, ok, observed, expected) =>
    checks.push({
      id,
      pass: observed !== undefined && observed !== null && ok === true,
      observed: observed ?? null,
      expected,
    });
  // Only a routing or timeout failure is an isolation observation; a probe
  // error such as EINVAL or ECONNREFUSED (host reached, port closed) is not.
  const unreachable = (v) =>
    ['ENETUNREACH', 'EHOSTUNREACH', 'TIMEOUT', 'ETIMEDOUT'].includes(v);
  const id = Math.random().toString(36).slice(2, 8);
  const names = {
    netA: `pms-st-a-${id}`,
    netB: `pms-st-b-${id}`,
    egress: `pms-st-e-${id}`,
    agent: `pms-st-agent-${id}`,
    peer: `pms-st-peer-${id}`,
    ag: `pms-st-ag-${id}`,
  };
  const proxies = [];
  const server = http.createServer((q, s) => s.end('host'));
  await new Promise((r) => server.listen(0, '::', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-selftest-'));
  const limits = {
    tmpfsBytes: 64 * 1024 * 1024,
    cpus: 1,
    memoryBytes: 512 * 1024 * 1024,
    pidsLimit: 64,
    ...(config.container ?? {}),
  };
  try {
    // Network (section 4.3), with the runner's own network argv.
    for (const n of [names.netA, names.netB])
      docker(networkCreateArgs(n, 'selftest'));
    docker([
      'network',
      'create',
      '--label',
      'pms-agentic=selftest',
      names.egress,
    ]);
    docker([
      'run',
      '-d',
      '--name',
      names.peer,
      '--label',
      'pms-agentic=selftest',
      '--network',
      names.netB,
      '--user',
      '20001:20001',
      '--cap-drop',
      'ALL',
      '--read-only',
      harness,
      NODE,
      '-e',
      "require('net').createServer(s=>s.end('x')).listen(4000)",
    ]);
    const peerIp = docker([
      'inspect',
      '-f',
      `{{(index .NetworkSettings.Networks "${names.netB}").IPAddress}}`,
      names.peer,
    ]).stdout.trim();
    const addresses = [
      ...new Set([...facts.hostAddresses, ...bridgeGateways()]),
    ];
    // IPv6 link-local addresses need an interface scope and are not on the
    // attempt's link; they are recorded as skipped, not as passed.
    const linkLocal = addresses.filter((a) => /^fe80:/i.test(a));
    const hostTargets = addresses
      .filter((a) => !linkLocal.includes(a))
      .map((a) => (a.includes(':') ? `[${a}]:${port}` : `${a}:${port}`));
    skipped.push(
      ...linkLocal.map((a) => ({
        id: `net.host [${a}]`,
        reason: 'IPv6 link-local: needs a scope, not on the attempt link',
      })),
    );
    // One proxy per provider allowlist, as attempts run them.
    for (const [cli, allow] of Object.entries(config.network.allow)) {
      const name = `pms-st-proxy-${cli}-${id}`;
      proxies.push(name);
      docker(
        proxyRunArgs({ name, network: names.netA, image: harness, allow }),
      );
      docker(['network', 'connect', names.egress, name]);
    }
    const connect = [];
    for (const [cli, allow] of Object.entries(config.network.allow)) {
      const proxy = `pms-st-proxy-${cli}-${id}:3128`;
      connect.push({ proxy, target: 'not-allowlisted.invalid:443' });
      if (allow.length > 0) connect.push({ proxy, target: allow[0] });
    }
    const spec = {
      tcp: [
        ...hostTargets,
        '1.1.1.1:443',
        '8.8.8.8:53',
        `${peerIp}:4000`,
        ...proxies.map((p) => `${p}:3128`),
      ],
      dns: ['example.com', 'api.anthropic.com'],
      connect,
    };
    const net = json(
      docker([
        'run',
        '--rm',
        '--network',
        names.netA,
        '--user',
        '20001:20001',
        '--cap-drop',
        'ALL',
        '--read-only',
        agentImage,
        NODE,
        `${HARNESS_DIR}/probe-net.mjs`,
        JSON.stringify(spec),
      ]),
    );
    check(
      'net.probe-output',
      net.error === undefined,
      net.error ?? 'parsed',
      'parsed',
    );
    for (const t of hostTargets)
      check(
        `net.host ${t}`,
        unreachable(net.tcp?.[t]),
        net.tcp?.[t],
        'ENETUNREACH or timeout',
      );
    for (const t of ['1.1.1.1:443', '8.8.8.8:53'])
      check(
        `net.external ${t}`,
        unreachable(net.tcp?.[t]),
        net.tcp?.[t],
        'ENETUNREACH or timeout',
      );
    check(
      'net.other-attempt',
      unreachable(net.tcp?.[`${peerIp}:4000`]),
      net.tcp?.[`${peerIp}:4000`],
      'ENETUNREACH or timeout',
    );
    check(
      'net.dns.external',
      typeof net.dns?.['example.com'] === 'string' &&
        !/^\d/.test(net.dns['example.com']),
      net.dns?.['example.com'],
      'no resolution',
    );
    for (const p of proxies)
      check(
        `net.proxy.reachable ${p}`,
        net.tcp?.[`${p}:3128`] === 'CONNECTED',
        net.tcp?.[`${p}:3128`],
        'CONNECTED',
      );
    for (const [cli, allow] of Object.entries(config.network.allow)) {
      const proxy = `pms-st-proxy-${cli}-${id}`;
      const denied =
        net.connect?.[`${proxy}:3128->not-allowlisted.invalid:443`];
      check(
        `net.proxy.denies ${cli}`,
        /403/.test(String(denied)),
        denied,
        '403',
      );
      // The allowlisted decision is read from the proxy's own log; whether
      // the upstream answers is not part of the isolation property.
      const log = docker(['logs', proxy])
        .stdout.trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        });
      if (allow.length > 0) {
        const entry = log.find((e) => e?.target === allow[0]);
        check(
          `net.proxy.allows ${cli} ${allow[0]}`,
          entry?.decision === 'allowed',
          entry?.decision,
          'allowed',
        );
      }
    }
    // Controls: the probe sees a peer on its own network, and the host
    // service is listening, so the unreachability checks above can fail.
    const peerControl = json(
      docker([
        'run',
        '--rm',
        '--network',
        names.netB,
        '--user',
        '20001:20001',
        agentImage,
        NODE,
        `${HARNESS_DIR}/probe-net.mjs`,
        JSON.stringify({ tcp: [`${peerIp}:4000`] }),
      ]),
    );
    check(
      'control.net.same-network-peer-reachable',
      peerControl.tcp?.[`${peerIp}:4000`] === 'CONNECTED',
      peerControl.tcp?.[`${peerIp}:4000`],
      'CONNECTED',
    );
    const hostControl = json(
      docker([
        'run',
        '--rm',
        '--network',
        'host',
        '--user',
        '20001:20001',
        agentImage,
        NODE,
        `${HARNESS_DIR}/probe-net.mjs`,
        JSON.stringify({ tcp: [`127.0.0.1:${port}`] }),
      ]),
    );
    check(
      'control.net.host-service-listening',
      hostControl.tcp?.[`127.0.0.1:${port}`] === 'CONNECTED',
      hostControl.tcp?.[`127.0.0.1:${port}`],
      'CONNECTED',
    );

    // Process (section 4.4): the agent image's execute-only Node.
    const proc = json(
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '20001:20001',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,mode=1777',
        agentImage,
        NODE,
        `${HARNESS_DIR}/probe-proc.mjs`,
        NODE,
      ]),
    );
    check(
      'proc.probe-output',
      proc.error === undefined,
      proc.error ?? 'parsed',
      'parsed',
    );
    for (const k of ['fd1Write', 'environ', 'fdList', 'mem'])
      check(`proc.execute-only.${k}`, proc[k] === 'EACCES', proc[k], 'EACCES');
    check(
      'proc.signal-allowed (documented residual)',
      proc.signal === 'allowed',
      proc.signal,
      'allowed',
    );
    const readable = json(
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        '--entrypoint',
        'sh',
        agentImage,
        '-c',
        `cp ${NODE} /tmp/node && chmod 0755 /tmp/node && exec setpriv --reuid=20001 --regid=20001 --clear-groups /tmp/node ${HARNESS_DIR}/probe-proc.mjs /tmp/node`,
      ]),
    );
    check(
      'control.proc.readable-binary-exposes-fd',
      readable.fd1Write === 'allowed',
      readable.fd1Write,
      'allowed',
    );
    const cliModes = json(
      docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '0:0',
        agentImage,
        NODE,
        `${HARNESS_DIR}/probe-fs.mjs`,
        JSON.stringify({ modes: ['/opt/cli/claude', '/opt/cli/codex', NODE] }),
      ]),
    );
    if (config.kind === 'provider-backed')
      for (const p of ['/opt/cli/claude', '/opt/cli/codex'])
        check(
          `cli.execute-only ${p}`,
          cliModes.modes?.[p] === '711:0',
          cliModes.modes?.[p],
          '711:0',
        );
    else
      skipped.push({
        id: 'cli.execute-only',
        reason: `adapter-fixture images carry fake CLIs (${JSON.stringify(cliModes.modes ?? null)})`,
      });
    check(
      'node.execute-only',
      cliModes.modes?.[NODE] === '711:0',
      cliModes.modes?.[NODE],
      '711:0',
    );

    // Filesystem, privileges, limits and PID 1 (sections 4.2, 4.5, 4.6),
    // with the runner's agent argv and the configured limits.
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'def.js'), 'export default {};\n');
    fs.writeFileSync(path.join(ws, 'src.js'), '1;\n');
    docker(networkCreateArgs(names.ag, 'selftest'));
    docker(
      agentRunArgs({
        name: names.agent,
        network: names.ag,
        image: agentImage,
        limits,
        workspace: ws,
        mounts: {
          workspaceReadOnly: false,
          gitReadOnly: true,
          readOnlyPaths: ['def.js'],
        },
      }),
    );
    const fsr = json(
      docker(
        execArgs({
          container: names.agent,
          command: [
            NODE,
            `${HARNESS_DIR}/probe-fs.mjs`,
            JSON.stringify({
              write: [
                '/workspace/src.js',
                '/workspace/def.js',
                '/workspace/.git/HEAD',
                '/etc/x',
              ],
              rename: [['/workspace/tmp.js', '/workspace/def.js']],
              remove: ['/workspace/def.js'],
              exists: ['/node_modules'],
            }),
          ],
        }),
      ),
    );
    check(
      'fs.workspace-writable',
      fsr.write?.['/workspace/src.js'] === 'allowed',
      fsr.write?.['/workspace/src.js'],
      'allowed (control)',
    );
    check(
      'fs.definition-read-only',
      fsr.write?.['/workspace/def.js'] === 'EROFS',
      fsr.write?.['/workspace/def.js'],
      'EROFS',
    );
    check(
      'fs.definition-rename',
      fsr.rename?.['/workspace/def.js'] === 'EBUSY',
      fsr.rename?.['/workspace/def.js'],
      'EBUSY',
    );
    check(
      'fs.definition-remove',
      fsr.remove?.['/workspace/def.js'] === 'EBUSY',
      fsr.remove?.['/workspace/def.js'],
      'EBUSY',
    );
    check(
      'fs.git-read-only',
      fsr.write?.['/workspace/.git/HEAD'] === 'EROFS',
      fsr.write?.['/workspace/.git/HEAD'],
      'EROFS',
    );
    check(
      'fs.root-read-only',
      fsr.write?.['/etc/x'] === 'EROFS',
      fsr.write?.['/etc/x'],
      'EROFS',
    );
    check(
      'priv.non-root',
      Number.isInteger(fsr.uid) && fsr.uid !== 0,
      fsr.uid,
      'non-zero uid',
    );
    check(
      'priv.no-capabilities',
      /^0+$/.test(String(fsr.capEff)),
      fsr.capEff,
      '0',
    );
    check('priv.no-new-privs', fsr.noNewPrivs === '1', fsr.noNewPrivs, '1');
    docker(
      execArgs({
        container: names.agent,
        command: [NODE, `${HARNESS_DIR}/signal-cli.mjs`, 'SIGKILL', 'all'],
      }),
    );
    const alive = docker([
      'inspect',
      '-f',
      '{{.State.Running}}',
      names.agent,
    ]).stdout.trim();
    check('pid1.survives-agent-kill-all', alive === 'true', alive, 'true');
    // More processes than the configured limit must be refused.
    const over = limits.pidsLimit + 64;
    const fork = docker(
      execArgs({
        container: names.agent,
        command: [
          NODE,
          '-e',
          `const {spawn}=require('child_process');let n=0,e=null;for(let i=0;i<${over};i++){try{spawn('sleep',['5']).on('error',x=>{e=x.code});n++}catch(x){e=x.code;break}}setTimeout(()=>console.log(JSON.stringify({n,e})),1500)`,
        ],
      }),
    );
    check(
      'limits.pids',
      /EAGAIN|ENOMEM|EMFILE/.test(fork.stdout + fork.stderr),
      (fork.stdout + fork.stderr).slice(-200),
      'spawn refused at the pids limit',
    );

    // Grader image: no node_modules above /scratch, harness and inputs
    // read-only, as the runner's grader argv mounts them.
    const g = graderRunArgs({
      image: grader,
      harnessDir: tmp,
      trustedDir: tmp,
      baselineDir: tmp,
      finalDir: tmp,
      inputsDir: tmp,
      tmpfsBytes: 64 * 1024 * 1024,
      evaluateArgs: [],
    });
    const gi = g.indexOf(grader);
    const gfs = json(
      docker([
        ...g.slice(0, gi + 1),
        NODE,
        `${HARNESS_DIR}/probe-fs.mjs`,
        JSON.stringify({
          write: ['/harness/x', '/trusted/x', '/final/x', '/scratch/x'],
          exists: ['/node_modules', '/scratch/node_modules'],
        }),
      ]),
    );
    check(
      'grader.no-ancestor-node_modules',
      gfs.exists?.['/node_modules'] === false &&
        gfs.exists?.['/scratch/node_modules'] === false,
      gfs.exists,
      'false',
    );
    for (const p of ['/harness/x', '/trusted/x', '/final/x'])
      check(
        `grader.read-only ${p}`,
        gfs.write?.[p] === 'EROFS',
        gfs.write?.[p],
        'EROFS',
      );
    check(
      'control.grader.scratch-writable',
      gfs.write?.['/scratch/x'] === 'allowed',
      gfs.write?.['/scratch/x'],
      'allowed',
    );
  } finally {
    server.close();
    docker(['rm', '-f', ...proxies, names.agent, names.peer]);
    for (const n of [names.netA, names.netB, names.ag, names.egress])
      docker(['network', 'rm', n]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const result = {
    schema: SELFTEST_SCHEMA,
    at: nowIso(),
    passed: checks.length > 0 && checks.every((c) => c.pass),
    checks,
    skipped,
    binding,
    bindingDigest: digestJson(binding),
  };
  if (stateDir)
    writeJson(
      path.join(stateDir, `selftest-${result.bindingDigest}.json`),
      result,
    );
  return result;
}

/**
 * Preflight: a passing, fresh self-test for exactly this configuration and
 * host (the same binding function as the self-test).
 */
export function requireValidSelfTest({
  stateDir,
  config,
  facts = currentFacts(),
  now = Date.now(),
}) {
  const binding = selftestBinding(config, facts);
  const digest = digestJson(binding);
  const file = path.join(stateDir, `selftest-${digest}.json`);
  if (!fs.existsSync(file))
    throw Object.assign(
      new Error(
        `no isolation self-test for this configuration and host (binding ${digest}); run: pms-agentic-runner selftest --matrix <matrix.json>`,
      ),
      { code: 'selftest' },
    );
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (r.bindingDigest !== digest || digestJson(r.binding) !== digest)
    throw Object.assign(
      new Error('the self-test result does not match its binding'),
      { code: 'selftest' },
    );
  if (!r.passed)
    throw Object.assign(
      new Error('the isolation self-test for this binding failed'),
      { code: 'selftest' },
    );
  if (now - Date.parse(r.at) > SELFTEST_MAX_AGE_MS)
    throw Object.assign(
      new Error('the isolation self-test is older than 24 hours'),
      { code: 'selftest' },
    );
  return r;
}

export function hasDocker() {
  return spawnSync('docker', ['version'], { encoding: 'utf8' }).status === 0;
}
