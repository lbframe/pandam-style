/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation self-test (DESIGN.md sections 4.3 and 9.3). Local, Docker, no
// credentials, no model calls. Every check has a control probe that must
// observe the opposite outcome, so the test proves it can fail. The result is
// bound to the Docker version, network options, image ids, proxy allowlist,
// kernel and host address set, and expires after 24 hours.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  HARNESS_DIR,
  NODE,
  agentRunArgs,
  docker,
  execArgs,
  hostAddresses,
  networkCreateArgs,
  proxyRunArgs,
} from './docker.mjs';
import { buildHarnessImage } from './images.mjs';
import { digestJson, nowIso, writeJson } from './util.mjs';

export const SELFTEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function selftestBinding({ images, allow }) {
  const v = docker([
    'version',
    '--format',
    '{{.Server.Version}}',
  ]).stdout.trim();
  return {
    dockerVersion: v,
    networkOptions: networkCreateArgs('<name>'),
    images,
    allow,
    kernel: os.release(),
    hostAddresses: hostAddresses(),
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

/** Runs the self-test; returns the result (also written under stateDir). */
export async function runSelfTest({
  stateDir,
  allow = { probe: ['example.invalid:443'] },
}) {
  const harness = buildHarnessImage({ tag: 'pms-agentic-selftest:local' });
  const images = { harness };
  const binding = selftestBinding({ images, allow });
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
  // error such as EINVAL (malformed target) or ECONNREFUSED (host reached,
  // port closed) is not.
  const unreachable = (v) =>
    ['ENETUNREACH', 'EHOSTUNREACH', 'TIMEOUT', 'ETIMEDOUT'].includes(v);
  const id = Math.random().toString(36).slice(2, 8);
  const names = {
    netA: `pms-st-a-${id}`,
    netB: `pms-st-b-${id}`,
    egress: `pms-st-e-${id}`,
    proxy: `pms-st-proxy-${id}`,
    agent: `pms-st-agent-${id}`,
    peer: `pms-st-peer-${id}`,
  };
  const server = http.createServer((q, s) => s.end('host'));
  await new Promise((r) => server.listen(0, '::', r));
  const port = server.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-selftest-'));
  try {
    // Network (section 4.3).
    for (const n of [names.netA, names.netB]) docker(networkCreateArgs(n));
    docker([
      'network',
      'create',
      '--label',
      'pms-agentic=selftest',
      names.egress,
    ]);
    docker(
      proxyRunArgs({
        name: names.proxy,
        network: names.netA,
        image: harness,
        allow: allow.probe,
      }),
    );
    docker(['network', 'connect', names.egress, names.proxy]);
    docker([
      'run',
      '-d',
      '--name',
      names.peer,
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
    // IPv6 link-local addresses need an interface scope and are not on the
    // attempt's link; they are recorded as skipped, not as passed.
    const addresses = [...new Set([...hostAddresses(), ...bridgeGateways()])];
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
    const spec = {
      tcp: [
        ...hostTargets,
        '1.1.1.1:443',
        '8.8.8.8:53',
        `${peerIp}:4000`,
        `${names.proxy}:3128`,
      ],
      dns: ['example.com', 'api.anthropic.com'],
      connect: [
        { proxy: `${names.proxy}:3128`, target: 'example.com:443' },
        { proxy: `${names.proxy}:3128`, target: allow.probe[0] },
      ],
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
        harness,
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
        'not CONNECTED',
      );
    check(
      'net.external 1.1.1.1:443',
      unreachable(net.tcp?.['1.1.1.1:443']),
      net.tcp?.['1.1.1.1:443'],
      'not CONNECTED',
    );
    check(
      'net.external 8.8.8.8:53',
      unreachable(net.tcp?.['8.8.8.8:53']),
      net.tcp?.['8.8.8.8:53'],
      'not CONNECTED',
    );
    check(
      'net.other-attempt',
      unreachable(net.tcp?.[`${peerIp}:4000`]),
      net.tcp?.[`${peerIp}:4000`],
      'not CONNECTED',
    );
    check(
      'net.dns.external',
      typeof net.dns?.['example.com'] === 'string' &&
        !/^\d/.test(net.dns['example.com']),
      net.dns?.['example.com'],
      'no resolution',
    );
    check(
      'net.proxy.reachable',
      net.tcp?.[`${names.proxy}:3128`] === 'CONNECTED',
      net.tcp?.[`${names.proxy}:3128`],
      'CONNECTED',
    );
    check(
      'net.proxy.denies',
      /403/.test(String(net.connect?.[`${names.proxy}:3128->example.com:443`])),
      net.connect?.[`${names.proxy}:3128->example.com:443`],
      '403',
    );
    // Controls: the probe detects a reachable peer on its own network, and
    // the host service is listening (seen from the host network namespace),
    // so the unreachability checks above can fail. A host firewall that
    // already drops bridge traffic does not make these controls pass.
    const peerControl = json(
      docker([
        'run',
        '--rm',
        '--network',
        names.netB,
        '--user',
        '20001:20001',
        harness,
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
        harness,
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

    // Process (section 4.4).
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
        harness,
        NODE,
        `${HARNESS_DIR}/probe-proc.mjs`,
        NODE,
      ]),
    );
    for (const k of ['fd1Write', 'environ', 'fdList', 'mem'])
      check(`proc.execute-only.${k}`, proc[k] === 'EACCES', proc[k], 'EACCES');
    check(
      'proc.probe-output',
      proc.error === undefined,
      proc.error ?? 'parsed',
      'parsed',
    );
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
        harness,
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

    // Filesystem, privileges and PID 1 (sections 4.2, 4.5, 4.6).
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'def.js'), 'export default {};\n');
    fs.writeFileSync(path.join(ws, 'src.js'), '1;\n');
    fs.chmodSync(ws, 0o777);
    for (const f of ['def.js', 'src.js']) fs.chmodSync(path.join(ws, f), 0o666);
    fs.chmodSync(path.join(ws, '.git'), 0o777);
    const limits = {
      tmpfsBytes: 64 * 1024 * 1024,
      cpus: 1,
      memoryBytes: 256 * 1024 * 1024,
      pidsLimit: 64,
    };
    docker([
      'network',
      'create',
      '--internal',
      '-o',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      `${names.netA}-ag`,
    ]);
    docker(
      agentRunArgs({
        name: names.agent,
        network: `${names.netA}-ag`,
        image: harness,
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
              exists: ['/node_modules', '/scratch/node_modules'],
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
    check('priv.non-root', fsr.uid !== 0, fsr.uid, 'non-zero uid');
    check(
      'priv.no-capabilities',
      /^0+$/.test(String(fsr.capEff)),
      fsr.capEff,
      '0',
    );
    check('priv.no-new-privs', fsr.noNewPrivs === '1', fsr.noNewPrivs, '1');
    check(
      'grader.no-ancestor-node_modules',
      fsr.exists?.['/node_modules'] === false,
      fsr.exists,
      'false',
    );
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
    const fork = docker(
      execArgs({
        container: names.agent,
        command: [
          NODE,
          '-e',
          "const {spawn}=require('child_process');let n=0,e=null;for(let i=0;i<200;i++){try{spawn('sleep',['5']).on('error',x=>{e=x.code});n++}catch(x){e=x.code;break}}setTimeout(()=>console.log(JSON.stringify({n,e})),1500)",
        ],
      }),
    );
    check(
      'limits.pids',
      /EAGAIN|ENOMEM|EMFILE/.test(fork.stdout + fork.stderr),
      (fork.stdout + fork.stderr).slice(-200),
      'spawn refused at the pids limit',
    );
  } finally {
    server.close();
    docker(['rm', '-f', names.proxy, names.agent, names.peer]);
    for (const n of [names.netA, names.netB, `${names.netA}-ag`, names.egress])
      docker(['network', 'rm', n]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const result = {
    schema: 'pms-agentic-selftest/v1',
    at: nowIso(),
    passed: checks.every((c) => c.pass),
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

/** Provider-backed matrices refuse to start without a valid self-test. */
export function requireValidSelfTest({ stateDir, binding, now = Date.now() }) {
  const digest = digestJson(binding);
  const file = path.join(stateDir, `selftest-${digest}.json`);
  if (!fs.existsSync(file))
    throw new Error(`no isolation self-test for binding ${digest}`);
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!r.passed)
    throw new Error('the isolation self-test for this binding failed');
  if (now - Date.parse(r.at) > SELFTEST_MAX_AGE_MS)
    throw new Error('the isolation self-test is older than 24 hours');
  return r;
}

export function hasDocker() {
  return spawnSync('docker', ['version'], { encoding: 'utf8' }).status === 0;
}
