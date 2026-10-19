/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Parts of the isolation design that run without Docker (DESIGN.md sections
// 4.3, 4.4 and 2.4): the CONNECT-only proxy and its accounting, the
// channel-audit summary, the live workspace-delta digest and the Docker argv
// builders. The container behavior itself is the isolation self-test's
// (section 9.3, `pms-agentic-runner selftest`, local only).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tmpDir } from './helpers.mjs';
import { createProxy } from '../container/connect-proxy.mjs';
import { summarizeProxyLog } from '../src/attempt.mjs';
import {
  agentRunArgs,
  execArgs,
  graderRunArgs,
  networkCreateArgs,
  summarizeAudits,
} from '../src/docker.mjs';
import { deltaDigest } from '../src/evidence.mjs';

const listen = (server) =>
  new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r(server.address().port)),
  );

function request(port, text) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(text));
    let data = '';
    s.on('data', (c) => {
      data += c;
      if (data.includes('\r\n\r\n')) {
        s.write('ping');
        setTimeout(() => {
          s.destroy();
          resolve(data);
        }, 100);
      }
    });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
  });
}

test('proxy: CONNECT to allowlisted targets only, everything logged', async () => {
  const upstream = net.createServer((c) => c.on('data', () => c.write('pong')));
  const upPort = await listen(upstream);
  const log = [];
  const proxy = createProxy({
    allow: [`localhost:${upPort}`],
    log: (e) => log.push(e),
    connect: (opts, cb) =>
      net.connect({ host: '127.0.0.1', port: opts.port }, cb),
  });
  const port = await listen(proxy);
  try {
    assert.match(
      await request(
        port,
        `CONNECT localhost:${upPort} HTTP/1.1\r\nHost: x\r\n\r\n`,
      ),
      /^HTTP\/1\.1 200/,
    );
    assert.match(
      await request(port, 'CONNECT example.com:443 HTTP/1.1\r\n\r\n'),
      /^HTTP\/1\.1 403/,
    );
    assert.match(
      await request(port, 'GET http://example.com/ HTTP/1.1\r\n\r\n'),
      /^HTTP\/1\.1 403/,
    );
    assert.match(
      await request(port, `CONNECT localhost:${upPort + 1} HTTP/1.1\r\n\r\n`),
      /^HTTP\/1\.1 403/,
    );
    // An allowed tunnel is logged when it closes.
    for (let i = 0; i < 100 && log.length < 4; i += 1)
      await new Promise((r) => setTimeout(r, 50));
    const decisions = log.map((e) => [e.target, e.decision]);
    assert.deepEqual(decisions.filter(([, d]) => d === 'denied').length, 3);
    assert.ok(
      decisions.some(
        ([t, d]) => t === `localhost:${upPort}` && d === 'allowed',
      ),
    );
    const summary = summarizeProxyLog(
      log.map((e) => JSON.stringify(e)).join('\n'),
    );
    assert.equal(summary.connections, 4);
    assert.equal(summary.denied, 3);
    assert.ok(summary.bytesUp >= 4);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy accounting: no proxy is null; an unparseable line makes counts unknown', () => {
  assert.equal(summarizeProxyLog(null), null);
  const s = summarizeProxyLog(
    '{"target":"a:443","decision":"allowed","up":1,"down":2}\nnot json\n',
  );
  assert.equal(s.connections, null);
  assert.equal(s.unparseableLines, 1);
});

test('channel audit: a sample without the CLI or a count is unknown, never clean', () => {
  assert.deepEqual(summarizeAudits([]), {
    samples: 0,
    cliNonDumpable: null,
    foreignStreamHolders: null,
    controlSocketConnections: null,
  });
  const s = summarizeAudits([
    { cliFound: false, cliNonDumpable: null, foreignStreamHolders: 0 },
  ]);
  assert.equal(s.cliNonDumpable, null);
  assert.equal(
    summarizeAudits([
      { cliFound: true, cliNonDumpable: true, foreignStreamHolders: 0 },
      { cliFound: true, cliNonDumpable: false, foreignStreamHolders: 1 },
    ]).cliNonDumpable,
    false,
  );
  assert.equal(
    summarizeAudits([{ cliFound: true, cliNonDumpable: true }])
      .foreignStreamHolders,
    null,
  );
});

test('live delta digest: links not followed, FIFOs not opened, bounded, changes visible', () => {
  const root = tmpDir('delta');
  fs.writeFileSync(path.join(root, 'a.txt'), '1');
  const d1 = deltaDigest(root);
  assert.match(d1, /^[0-9a-f]{64}$/);
  spawnSync('mkfifo', [path.join(root, 'pipe')]);
  fs.symlinkSync('/etc/passwd', path.join(root, 'link'));
  const t0 = Date.now();
  const d2 = deltaDigest(root);
  assert.ok(Date.now() - t0 < 2000, 'a FIFO never blocks the digest');
  assert.notEqual(d2, d1);
  fs.writeFileSync(path.join(root, 'a.txt'), '2');
  assert.notEqual(deltaDigest(root), d2);
  assert.equal(deltaDigest(root, [], { maxEntries: 1 }), null);
  assert.equal(deltaDigest(root, [], { maxBytes: 0 }), null);
  assert.equal(deltaDigest(path.join(root, 'missing')), null);
});

test('docker argv: isolated internal network, hardening, read-only mounts, credential-free grader', () => {
  assert.deepEqual(networkCreateArgs('n').slice(0, 5), [
    'network',
    'create',
    '--internal',
    '-o',
    'com.docker.network.bridge.gateway_mode_ipv4=isolated',
  ]);
  assert.ok(!networkCreateArgs('n').includes('--ipv6'));
  const ws = tmpDir('ws');
  fs.mkdirSync(path.join(ws, '.git'));
  fs.writeFileSync(path.join(ws, 'def.js'), '');
  const a = agentRunArgs({
    name: 'a',
    network: 'n',
    image: 'i',
    limits: { tmpfsBytes: 1, cpus: 1, memoryBytes: 1, pidsLimit: 1 },
    mounts: {
      workspaceReadOnly: true,
      gitReadOnly: true,
      readOnlyPaths: ['def.js'],
    },
    workspace: ws,
    uid: 1234,
  });
  for (const flag of [
    '--cap-drop',
    'ALL',
    'no-new-privileges',
    '--read-only',
    '--init',
  ])
    assert.ok(a.includes(flag), flag);
  assert.ok(a.includes(`${ws}:/workspace:ro`));
  assert.ok(a.includes(`${path.join(ws, '.git')}:/workspace/.git:ro`));
  assert.ok(a.includes(`${path.join(ws, 'def.js')}:/workspace/def.js:ro`));
  assert.ok(
    !a.some((x) => /^-e$|^--env/.test(x)),
    'no credential in container configuration',
  );
  const g = graderRunArgs({
    image: 'g',
    harnessDir: '/h',
    trustedDir: '/t',
    baselineDir: '/b',
    finalDir: '/f',
    inputsDir: '/i',
    tmpfsBytes: 1,
    evaluateArgs: ['t'],
  });
  for (const m of [
    '/h:/harness:ro',
    '/t:/trusted:ro',
    '/b:/baseline:ro',
    '/f:/final:ro',
    '/i:/inputs:ro',
  ])
    assert.ok(g.includes(m), m);
  assert.deepEqual(
    g.slice(g.indexOf('--network'), g.indexOf('--network') + 2),
    ['--network', 'none'],
  );
  const e = execArgs({
    container: 'c',
    uid: 5,
    env: { HOME: '/run/agent' },
    command: ['x'],
  });
  assert.deepEqual(e.slice(0, 5), ['exec', '-u', '5:5', '-w', '/workspace']);
});
