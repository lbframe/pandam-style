/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 AC2: unauthorized, stale, malformed, oversized and
 * incompatible-protocol requests fail structurally. Forged descriptors and
 * keys, a spy endpoint, guessed, replayed and reflected proofs,
 * self-assigned authority, grants, versions, and a class-level frame fuzzer
 * (design note §2, §3.4–§3.7, §5.1).
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  cleanup,
  compiler,
  entryPath,
  expectDeclared,
  frames,
  handshake,
  makeRuntimeDir,
  onCleanup,
  openHost,
  openWorkspace,
  rawAuthenticated,
  rawClient,
  readDescriptorFile,
} = require('./agent-bridge-support');

jest.setTimeout(120000);
afterEach(cleanup);

const failureOf = (envelope) => [envelope.outcome, envelope.failure?.reason];

function rewriteDescriptor(host, edit) {
  const file = entryPath(host.runtimeDir, host.bridge.name, 'json');
  const value = readDescriptorFile(host.runtimeDir, host.bridge.name);
  fs.writeFileSync(file, JSON.stringify(edit(value) ?? value));
}

function forgeKey(host) {
  const key = handshake.newKey();
  fs.writeFileSync(
    entryPath(host.runtimeDir, host.bridge.name, 'key'),
    key.text,
  );
  return key;
}

describe('AG-02.1 forged discovery data (AC2, A2–A4)', () => {
  test('a forged descriptor with a matching forged key meets an owner that proves the real key: endpoint-unauthenticated', async () => {
    const host = await openHost();
    const key = forgeKey(host);
    rewriteDescriptor(host, (value) => ({
      ...value,
      keyId: compiler.bridgeDescriptor.keyIdOf(key.text),
    }));
    const remote = openWorkspace(host);
    const attach = await remote.attach();
    expect(failureOf(attach)).toEqual([
      'denied-access',
      'endpoint-unauthenticated',
    ]);
    expectDeclared(attach);
  });

  test('a spy endpoint without the key receives only the hello: the client never sends a proof first', async () => {
    const runtimeDir = makeRuntimeDir();
    const host = await openHost({ runtimeDir });
    const { name } = host.bridge;
    const descriptor = readDescriptorFile(runtimeDir, name);
    const key = fs.readFileSync(entryPath(runtimeDir, name, 'key'));
    await host.bridge.close();
    host.bridge = null;
    // The spy takes the derived endpoint and answers with a guessed proof.
    fs.writeFileSync(
      entryPath(runtimeDir, name, 'json'),
      JSON.stringify(descriptor),
      { mode: 0o600 },
    );
    fs.writeFileSync(entryPath(runtimeDir, name, 'key'), key, { mode: 0o600 });
    const received = [];
    const spy = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk);
        socket.write(
          frames.encodeFrame({
            t: 'challenge',
            bridge: 1,
            sn: handshake.nonce(),
            sessionId: descriptor.sessionId,
            proof: handshake.nonce(),
          }),
        );
      });
    });
    await new Promise((resolve) =>
      spy.listen(entryPath(runtimeDir, name, 'sock'), resolve),
    );
    onCleanup(() => new Promise((resolve) => spy.close(resolve)));
    const remote = openWorkspace(host);
    const attach = await remote.attach();
    expect(failureOf(attach)).toEqual([
      'denied-access',
      'endpoint-unauthenticated',
    ]);
    const bytes = Buffer.concat(received);
    const hello = JSON.parse(bytes.subarray(4).toString('utf8'));
    expect(bytes.length).toBe(4 + bytes.readUInt32BE(0));
    expect(Object.keys(hello).sort()).toEqual(['bridge', 'cn', 't']);
    // Nothing derived from the key reached the spy.
    expect(bytes.toString('latin1').includes(key.toString('latin1'))).toBe(
      false,
    );
  });

  test('descriptors naming another endpoint or project, oversized, extended, linked or special are descriptor-invalid', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    const { runtimeDir } = host;
    const { name } = host.bridge;
    const file = entryPath(runtimeDir, name, 'json');
    const original = fs.readFileSync(file);
    const cases = {
      'endpoint redirect': (value) => ({ ...value, endpoint: '../spy.sock' }),
      'endpoint of another name': (value) => ({
        ...value,
        endpoint: 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb.sock',
      }),
      'rootDir of another project': (value) => ({
        ...value,
        rootDir: `${value.rootDir}-other`,
      }),
      'an authority field': (value) => ({ ...value, grants: ['publish'] }),
      'projectId over its bound': (value) => ({
        ...value,
        projectId: 'p'.repeat(1025),
      }),
      'bad keyId': (value) => ({ ...value, keyId: 'Z'.repeat(16) }),
    };
    for (const [label, edit] of Object.entries(cases)) {
      fs.writeFileSync(file, JSON.stringify(edit(JSON.parse(original))));
      const attach = await remote.attach();
      expect([label, ...failureOf(attach)]).toEqual([
        label,
        'owner-required',
        'descriptor-invalid',
      ]);
      expectDeclared(attach);
    }
    // One byte over the derived ceiling.
    fs.writeFileSync(
      file,
      ' '.repeat(compiler.bridgeFrames.CEILINGS.descriptor + 1),
    );
    expect(failureOf(await remote.attach())).toEqual([
      'owner-required',
      'descriptor-invalid',
    ]);
    // A symlink (refused by O_NOFOLLOW) and a FIFO (not a regular file).
    fs.rmSync(file);
    const elsewhere = path.join(path.dirname(runtimeDir), 'elsewhere.json');
    fs.writeFileSync(elsewhere, original);
    fs.symlinkSync(elsewhere, file);
    expect(failureOf(await remote.attach())).toEqual([
      'owner-required',
      'descriptor-invalid',
    ]);
    fs.rmSync(file);
    execFileSync('mkfifo', ['-m', '600', file]);
    const fifo = await remote.attach();
    expect(failureOf(fifo)).toEqual(['owner-required', 'descriptor-invalid']);
    fs.rmSync(file);
    fs.writeFileSync(file, original, { mode: 0o600 });
    expect((await remote.attach()).outcome).toBe('success');
  });

  test('a replaced key is descriptor-stale; a missing key is owner-unreachable', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    forgeKey(host);
    const stale = await remote.attach();
    expect(failureOf(stale)).toEqual(['stale-revision', 'descriptor-stale']);
    expectDeclared(stale);
    fs.rmSync(entryPath(host.runtimeDir, host.bridge.name, 'key'));
    const missing = await remote.attach();
    expect(failureOf(missing)).toEqual(['owner-required', 'owner-unreachable']);
    expectDeclared(missing);
  });
});

describe('AG-02.1 handshake proofs (AC2, A4–A6)', () => {
  test('a guessed proof, a replayed auth and a reflected owner proof are refused', async () => {
    const host = await openHost();
    const { runtimeDir } = host;
    const { name } = host.bridge;
    const sock = entryPath(runtimeDir, name, 'sock');

    const guessed = rawClient(sock);
    await guessed.connected;
    guessed.send({ t: 'hello', bridge: [1], cn: handshake.nonce() });
    await guessed.next(1);
    guessed.send({ t: 'auth', proof: handshake.nonce() });
    expect(await guessed.next(2)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'denied-access',
      reason: 'authentication-failed',
    });
    expect(await guessed.closed).toBe(true);

    // An honest handshake, captured, then replayed on a new connection.
    const honest = await rawAuthenticated(runtimeDir, name);
    expect(honest.ready.t).toBe('ready');
    const key = { bytes: honest.key.bytes };
    const captured = handshake.proof(
      key,
      'client',
      name,
      honest.cn,
      honest.challenge.sn,
      honest.challenge.sessionId,
    );
    const replay = rawClient(sock);
    await replay.connected;
    replay.send({ t: 'hello', bridge: [1], cn: honest.cn });
    const second = await replay.next(1);
    expect(second.sn).not.toBe(honest.challenge.sn);
    replay.send({ t: 'auth', proof: captured });
    expect((await replay.next(2)).reason).toBe('authentication-failed');

    // The owner's own proof reflected back as the client's.
    const reflect = rawClient(sock);
    await reflect.connected;
    reflect.send({ t: 'hello', bridge: [1], cn: handshake.nonce() });
    const challenge = await reflect.next(1);
    reflect.send({ t: 'auth', proof: challenge.proof });
    expect((await reflect.next(2)).reason).toBe('authentication-failed');
  });

  test('frames before or outside the handshake, and self-assigned fields, are malformed-handshake and close', async () => {
    const host = await openHost();
    const sock = entryPath(host.runtimeDir, host.bridge.name, 'sock');
    const attempts = {
      'request before hello': [
        {
          t: 'request',
          seq: 1,
          request: { protocolVersion: 1, operation: 'check' },
        },
      ],
      'hello with grants': [
        { t: 'hello', bridge: [1], cn: handshake.nonce(), grants: ['publish'] },
      ],
      'auth with a role': [
        { t: 'hello', bridge: [1], cn: handshake.nonce() },
        { t: 'auth', proof: handshake.nonce(), role: 'host' },
      ],
      'not JSON': ['not json'],
    };
    for (const [label, sequence] of Object.entries(attempts)) {
      const client = rawClient(sock);
      await client.connected;
      for (const [index, frame] of sequence.entries()) {
        if (typeof frame === 'string') {
          const body = Buffer.from(frame);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(body.length);
          client.write(Buffer.concat([header, body]));
        } else client.send(frame);
        if (index < sequence.length - 1) await client.next(index + 1);
      }
      const last = await client.next(sequence.length);
      expect([label, last]).toEqual([
        label,
        {
          t: 'error',
          seq: null,
          outcome: 'invalid-input',
          // `auth` is at its derived ceiling: any added field is oversized
          // before it can be parsed (R1).
          reason:
            label === 'auth with a role'
              ? 'request-too-large'
              : 'malformed-handshake',
        },
      ]);
      expect(await client.closed).toBe(true);
    }
  });
});

describe('AG-02.1 authority and requests over the bridge (AC2, A5)', () => {
  test('authority-shaped request fields are invalid-input; a wrapper field closes the connection', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    const attached = await remote.attach();
    const rev = attached.identities.revision;
    for (const [label, input, extra] of [
      ['capability in input', { rev, capability: 'admin' }, {}],
      ['grants in the request', { rev }, { grants: ['publish'] }],
      ['role in the request', { rev }, { role: 'host' }],
    ]) {
      const response = await remote.dispatch('check', input, extra);
      expect([label, response.outcome]).toEqual([label, 'invalid-input']);
      expectDeclared(response, 'check');
    }
    // The connection kept serving after each structural refusal.
    expect((await remote.dispatch('check', { rev })).outcome).toBe('success');

    const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    raw.client.send({
      t: 'request',
      seq: 1,
      grants: ['publish'],
      request: { protocolVersion: 1, operation: 'session.status', input: {} },
    });
    expect(await raw.client.next(3)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'invalid-input',
      reason: 'malformed-frame',
    });
    expect(await raw.client.closed).toBe(true);
  });

  test('a consult bridge refuses grants it was not given; a host-given grant is honoured', async () => {
    const consult = await openHost();
    const remote = openWorkspace(consult);
    const attached = await remote.attach();
    expect(attached.result.granted).toEqual(['consult']);
    const rev = attached.identities.revision;
    await consult.session.compile(rev);
    const denied = await remote.dispatch('audit.materialize', {
      rev,
      expectedGenerationId: 1,
    });
    expect(failureOf(denied)).toEqual(['denied-access', 'missing-grant']);
    expect(denied.failure.capability).toBe('grant:materialize-audit');
    expectDeclared(denied);
    // The workspace's own capability cannot widen what the owner minted.
    const wide = remote.workspace.mintCapability({
      grants: ['consult', 'materialize-audit', 'publish'],
    });
    const stillDenied = await remote.dispatch(
      'audit.materialize',
      { rev, expectedGenerationId: 1 },
      {},
      { capability: wide },
    );
    expect(failureOf(stillDenied)).toEqual(['denied-access', 'missing-grant']);

    const granted = await openHost({
      bridgeOptions: { grants: ['consult', 'materialize-audit'] },
    });
    const writer = openWorkspace(granted);
    const writerAttach = await writer.attach();
    expect(writerAttach.result.granted).toEqual([
      'consult',
      'materialize-audit',
    ]);
    const writerRev = writerAttach.identities.revision;
    await granted.session.compile(writerRev);
    const materialized = await writer.dispatch('audit.materialize', {
      rev: writerRev,
      expectedGenerationId: 1,
    });
    expect(materialized.outcome).not.toBe('denied-access');
  });

  test('no common bridge or protocol version is unsupported, structurally', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    const requested = await remote.attach({ protocolVersions: [2] });
    expect(failureOf(requested)).toEqual([
      'unsupported-capability',
      'protocol-version',
    ]);
    expectDeclared(requested);
    rewriteDescriptor(host, (value) => ({ ...value, bridgeVersions: [2] }));
    const advertised = await remote.attach();
    expect(failureOf(advertised)).toEqual([
      'unsupported-capability',
      'protocol-version',
    ]);
    const raw = rawClient(entryPath(host.runtimeDir, host.bridge.name, 'sock'));
    await raw.connected;
    raw.send({ t: 'hello', bridge: [2], cn: handshake.nonce() });
    expect(await raw.next(1)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'unsupported-capability',
      reason: 'protocol-version',
    });
    // An envelope protocol version the owner does not speak is answered by
    // the owner's dispatch, on a live connection.
    rewriteDescriptor(host, (value) => ({ ...value, bridgeVersions: [1] }));
    expect((await remote.attach()).outcome).toBe('success');
    const envelope = await remote.workspace.dispatch(
      { protocolVersion: 2, operation: 'session.status', input: {} },
      { capability: remote.capability },
    );
    expect(failureOf(envelope)).toEqual([
      'unsupported-capability',
      'protocol-version',
    ]);
  });
});

describe('AG-02.1 sequence and connection bounds (AC2, A14, A16)', () => {
  test('a request out of sequence is malformed-frame and closes', async () => {
    const host = await openHost();
    const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    raw.client.send({
      t: 'request',
      seq: 2,
      request: { protocolVersion: 1, operation: 'session.status', input: {} },
    });
    expect(await raw.client.next(3)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'invalid-input',
      reason: 'malformed-frame',
    });
    expect(await raw.client.closed).toBe(true);
  });

  test('connections over the limit are refused owner-busy; the limit frees with closes', async () => {
    const host = await openHost();
    const sock = entryPath(host.runtimeDir, host.bridge.name, 'sock');
    const held = [];
    for (let index = 0; index < 32; index += 1) {
      const client = rawClient(sock);
      await client.connected;
      held.push(client);
    }
    // A refused peer that never closes is closed by the owner.
    const lingering = rawClient(sock);
    await lingering.connected;
    expect(await lingering.next(1)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'owner-required',
      reason: 'owner-busy',
    });
    expect(await lingering.closed).toBe(true);
    const remote = openWorkspace(host);
    const busy = await remote.attach();
    expect(failureOf(busy)).toEqual(['owner-required', 'owner-busy']);
    expectDeclared(busy);
    for (const client of held) client.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await remote.attach()).outcome).toBe('success');
  });
});

describe('AG-02.1 class-level frame fuzzing (AC2)', () => {
  test('random frames, before and after the handshake, only ever yield closed structured errors', async () => {
    const host = await openHost();
    const { runtimeDir } = host;
    const { name } = host.bridge;
    const sock = entryPath(runtimeDir, name, 'sock');
    const fds = () => fs.readdirSync('/proc/self/fd').length;
    const baseline = fds();
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const valid = [
      { t: 'hello', bridge: [1], cn: handshake.nonce() },
      { t: 'auth', proof: handshake.nonce() },
      {
        t: 'request',
        seq: 1,
        request: { protocolVersion: 1, operation: 'session.status', input: {} },
      },
    ];
    const mutate = (bytes) => {
      const choice = Math.floor(random() * 6);
      const copy = Buffer.from(bytes);
      if (choice === 0)
        return copy.subarray(0, Math.floor(random() * copy.length));
      if (choice === 1) {
        for (let i = 0; i < 4; i += 1)
          copy[Math.floor(random() * copy.length)] = Math.floor(random() * 256);
        return copy;
      }
      if (choice === 2) {
        copy.writeUInt32BE(Math.floor(random() * 0xffffffff), 0);
        return copy;
      }
      if (choice === 3) return Buffer.concat([copy, copy]);
      if (choice === 4)
        return crypto.randomBytes(1 + Math.floor(random() * 64));
      return copy;
    };
    const outcomes = new Set();
    for (let round = 0; round < 120; round += 1) {
      const authenticated = random() < 0.5;
      const client = authenticated
        ? (await rawAuthenticated(runtimeDir, name)).client
        : rawClient(sock);
      await client.connected;
      const before = client.frames.length;
      const frame = valid[Math.floor(random() * valid.length)];
      client.write(mutate(frames.encodeFrame(frame)));
      await Promise.race([
        client.next(before + 1),
        new Promise((resolve) => setTimeout(resolve, 150)),
      ]);
      for (const received of client.frames.slice(before)) {
        if (received.t === 'error') {
          expect(frames.validFrame('error', received)).toBe(true);
          outcomes.add(`${received.outcome}/${received.reason}`);
        } else {
          expect(['challenge', 'response', 'ready']).toContain(received.t);
        }
      }
      client.socket.destroy();
    }
    // The owner still serves an honest client, and no descriptor leaked.
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    remote.workspace.dispose();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fds()).toBeLessThanOrEqual(baseline + 2);
    expect(outcomes.size).toBeGreaterThan(1);
    for (const outcome of outcomes)
      expect([
        'invalid-input/malformed-handshake',
        'invalid-input/malformed-frame',
        'invalid-input/request-too-large',
        'invalid-input/pipelined-request',
        'denied-access/authentication-failed',
        'unsupported-capability/protocol-version',
      ]).toContain(outcome);
  });
});
