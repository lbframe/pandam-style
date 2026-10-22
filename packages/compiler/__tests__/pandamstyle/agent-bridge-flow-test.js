/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 fix-round class R3: flow control is enforced where frames are
 * consumed, never assumed from transport back-pressure (I14, §3.6). At most
 * one frame per connection is handled at a time, any byte beyond it is
 * `pipelined-request`, and at most one frame is retained. Both sides.
 */

'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const {
  cleanup,
  compiler,
  entryPath,
  frames,
  handshake,
  onCleanup,
  openHost,
  openWorkspace,
  rawAuthenticated,
  rawClient,
  readDescriptorFile,
  readKeyFile,
  makeRuntimeDir,
} = require('./agent-bridge-support');

jest.setTimeout(120000);
afterEach(cleanup);

const statusFrame = (seq) => ({
  t: 'request',
  seq,
  request: { protocolVersion: 1, operation: 'session.status', input: {} },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A host whose bridge sees the session through instrumented hooks: every
 * `session.status` step is counted while it runs, and can be delayed.
 */
async function instrumentedHost() {
  const host = await openHost({ bridge: false });
  const hooks = host.session[compiler.AGENT_SESSION_HOOKS];
  const counter = { active: 0, maxActive: 0, calls: 0, delay: 0 };
  const wrapped = Object.create(host.session);
  Object.defineProperty(wrapped, compiler.AGENT_SESSION_HOOKS, {
    value: Object.freeze({
      ...hooks,
      status: async (beforeStart) => {
        counter.calls += 1;
        counter.active += 1;
        counter.maxActive = Math.max(counter.maxActive, counter.active);
        try {
          await sleep(counter.delay);
          return await hooks.status(beforeStart);
        } finally {
          counter.active -= 1;
        }
      },
    }),
  });
  host.bridge = await compiler.startOwnerBridge({
    session: wrapped,
    host: 'test',
    runtimeDir: host.runtimeDir,
  });
  return { host, counter };
}

describe('AG-02.1 R3: the owner consumes one frame at a time', () => {
  for (const count of [2, 50]) {
    test(`${count} request frames in one write: at most one dispatched, pipelined-request, closed`, async () => {
      const { host, counter } = await instrumentedHost();
      const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
      // The handshake itself dispatched one `session.status`.
      const baseline = counter.calls;
      counter.maxActive = 0;
      counter.delay = 50;
      raw.client.write(
        Buffer.concat(
          Array.from({ length: count }, (_, index) =>
            frames.encodeFrame(statusFrame(index + 1)),
          ),
        ),
      );
      expect(await raw.client.closed).toBe(true);
      await sleep(200);
      expect(counter.calls - baseline).toBe(0);
      expect(counter.maxActive).toBeLessThanOrEqual(1);
      expect(raw.client.frames.slice(2)).toEqual([
        {
          t: 'error',
          seq: null,
          outcome: 'invalid-input',
          reason: 'pipelined-request',
        },
      ]);
    });
  }

  test('a frame arriving while a delayed dispatch runs: one dispatch, pipelined-request', async () => {
    const { host, counter } = await instrumentedHost();
    const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    const baseline = counter.calls;
    counter.maxActive = 0;
    counter.delay = 500;
    raw.client.send(statusFrame(1));
    await sleep(100);
    raw.client.send(statusFrame(2));
    expect(await raw.client.closed).toBe(true);
    await sleep(600);
    expect(counter.calls - baseline).toBe(1);
    expect(counter.maxActive).toBe(1);
    expect(raw.client.frames.slice(2).map((frame) => frame.reason)).toEqual([
      'pipelined-request',
    ]);
  });

  test('one frame delivered a byte at a time is served', async () => {
    const { host } = await instrumentedHost();
    const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    for (const byte of frames.encodeFrame(statusFrame(1))) {
      raw.client.write(Buffer.from([byte]));
      await sleep(1);
    }
    const response = await raw.client.next(3);
    expect(response.t).toBe('response');
    expect(response.seq).toBe(1);
    expect(response.envelope.outcome).toBe('success');
  });

  test('the handshake refuses bytes beyond its current frame', async () => {
    const host = await openHost();
    const client = rawClient(
      entryPath(host.runtimeDir, host.bridge.name, 'sock'),
    );
    await client.connected;
    client.write(
      Buffer.concat([
        frames.encodeFrame({ t: 'hello', bridge: [1], cn: handshake.nonce() }),
        frames.encodeFrame({ t: 'auth', proof: handshake.nonce() }),
      ]),
    );
    expect(await client.next(1)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'invalid-input',
      reason: 'pipelined-request',
    });
    expect(await client.closed).toBe(true);
  });

  test('a small header followed by a large write retains at most one frame', async () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    const violations = [];
    const handled = [];
    const ceiling = frames.requestCeiling(65536);
    const consumer = frames.consumeFrames(socket, {
      ceiling: () => ceiling,
      onFrame: (body) => handled.push(body.length),
      onViolation: (reason) => violations.push(reason),
    });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(10);
    socket.emit('data', Buffer.concat([header, Buffer.alloc(1024 * 1024, 32)]));
    expect(violations).toEqual(['pipelined-request']);
    expect(handled).toEqual([]);
    expect(consumer.stats.maxRetained).toBeLessThanOrEqual(4 + ceiling);

    // A frame at the ceiling, in many chunks, is retained once, then handled.
    const second = new EventEmitter();
    second.destroyed = false;
    const sizes = [];
    const consumer2 = frames.consumeFrames(second, {
      ceiling: () => ceiling,
      onFrame: (body) => sizes.push(body.length),
      onViolation: (reason) => violations.push(reason),
    });
    const frame = Buffer.alloc(4 + ceiling, 32);
    frame.writeUInt32BE(ceiling, 0);
    for (let offset = 0; offset < frame.length; offset += 4096)
      second.emit('data', frame.subarray(offset, offset + 4096));
    await sleep(10);
    expect(sizes).toEqual([ceiling]);
    expect(consumer2.stats.maxRetained).toBe(4 + ceiling);
  });

  test('a large write after a small header, over the socket, is pipelined-request', async () => {
    const host = await openHost();
    const raw = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(10);
    raw.client.write(Buffer.concat([header, Buffer.alloc(1024 * 1024, 32)]));
    expect((await raw.client.next(3)).reason).toBe('pipelined-request');
  });
});

describe('AG-02.1 R3: the client consumes one frame at a time', () => {
  /** An owner stand-in that answers each request with `reply(frame)`. */
  async function scriptedOwner(reply) {
    const runtimeDir = makeRuntimeDir();
    const host = await openHost({ runtimeDir });
    const { name } = host.bridge;
    const descriptor = readDescriptorFile(runtimeDir, name);
    const key = readKeyFile(runtimeDir, name);
    await host.bridge.close();
    host.bridge = null;
    fs.writeFileSync(entryPath(runtimeDir, name, 'key'), key.text, {
      mode: 0o600,
    });
    fs.writeFileSync(
      entryPath(runtimeDir, name, 'json'),
      JSON.stringify(descriptor),
      {
        mode: 0o600,
      },
    );
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let state = 'hello';
      let cn;
      const sn = handshake.nonce();
      socket.on('error', () => {});
      socket.on('data', async (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (
          buffer.length >= 4 &&
          buffer.length >= 4 + buffer.readUInt32BE(0)
        ) {
          const frame = JSON.parse(
            buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString('utf8'),
          );
          buffer = buffer.subarray(4 + buffer.readUInt32BE(0));
          if (state === 'hello') {
            cn = frame.cn;
            state = 'auth';
            socket.write(
              frames.encodeFrame({
                t: 'challenge',
                bridge: 1,
                sn,
                sessionId: descriptor.sessionId,
                proof: handshake.proof(
                  key,
                  'server',
                  name,
                  cn,
                  sn,
                  descriptor.sessionId,
                ),
              }),
            );
          } else if (state === 'auth') {
            state = 'ready';
            socket.write(
              frames.encodeFrame({
                t: 'ready',
                identities: { sessionId: descriptor.sessionId },
                grants: ['consult'],
                limits: {
                  maxRequestBytes: 65536,
                  compact: 262144,
                  detail: 2097152,
                },
              }),
            );
          } else await reply(frame, socket);
        }
      });
    });
    await new Promise((resolve) =>
      server.listen(entryPath(runtimeDir, name, 'sock'), resolve),
    );
    onCleanup(() => new Promise((resolve) => server.close(resolve)));
    return host;
  }
  const envelope = {
    protocol: 'pandamstyle-agent',
    protocolVersion: 1,
    outcome: 'success',
  };

  test('an owner sending two frames for one request is owner-protocol-error', async () => {
    const host = await scriptedOwner((frame, socket) =>
      socket.write(
        Buffer.concat([
          frames.encodeFrame({ t: 'response', seq: frame.seq, envelope }),
          frames.encodeFrame({ t: 'response', seq: frame.seq, envelope }),
        ]),
      ),
    );
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    const response = await remote.dispatch('session.status', {});
    expect([response.outcome, response.failure?.reason]).toEqual([
      'internal-error',
      'owner-protocol-error',
    ]);
  });

  test('a response delivered a byte at a time is delivered; an unrequested one is refused', async () => {
    const host = await scriptedOwner(async (frame, socket) => {
      for (const byte of frames.encodeFrame({
        t: 'response',
        seq: frame.seq,
        envelope,
      })) {
        socket.write(Buffer.from([byte]));
        await sleep(1);
      }
      await sleep(20);
      socket.write(
        frames.encodeFrame({ t: 'response', seq: frame.seq + 1, envelope }),
      );
    });
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    const first = await remote.dispatch('session.status', {});
    expect(first).toEqual(envelope);
    await sleep(100);
    const after = await remote.dispatch('session.status', {});
    expect([after.outcome, after.failure?.reason]).toEqual([
      'owner-required',
      'owner-closed',
    ]);
  });

  test('a response for another sequence number is owner-protocol-error', async () => {
    const host = await scriptedOwner((frame, socket) =>
      socket.write(
        frames.encodeFrame({ t: 'response', seq: frame.seq + 5, envelope }),
      ),
    );
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    const response = await remote.dispatch('session.status', {});
    expect([response.outcome, response.failure?.reason]).toEqual([
      'internal-error',
      'owner-protocol-error',
    ]);
  });

  // Fix round 2, class R3: every owner frame is matched to the pending
  // request; anything else ends the connection, and the next call fails
  // structurally.
  const errorFrame = (seq, reason = 'owner-closed') => ({
    t: 'error',
    seq,
    outcome: 'owner-required',
    reason,
  });
  const responseFrame = (seq) => ({ t: 'response', seq, envelope });
  const correlationCases = {
    'an error for another sequence number': {
      reply: (frame) => [errorFrame(frame.seq + 5)],
      first: ['internal-error', 'owner-protocol-error'],
    },
    'a connection-wide error after the handshake': {
      reply: () => [errorFrame(null)],
      first: ['internal-error', 'owner-protocol-error'],
    },
    'a correlated error, which ends the connection': {
      reply: (frame) => [errorFrame(frame.seq)],
      first: ['owner-required', 'owner-closed'],
    },
    'a duplicate error, spaced': {
      reply: (frame) => [errorFrame(frame.seq), 'pause', errorFrame(frame.seq)],
      first: ['owner-required', 'owner-closed'],
    },
    // Two frames in one chunk meet the one-frame-at-a-time rule first.
    'a duplicate error, coalesced': {
      reply: (frame) => [[errorFrame(frame.seq), errorFrame(frame.seq)]],
      first: ['internal-error', 'owner-protocol-error'],
    },
    'an unsolicited error after a response': {
      reply: (frame) => [
        responseFrame(frame.seq),
        'pause',
        errorFrame(frame.seq),
      ],
      first: ['success', undefined],
    },
    'a response for another sequence number': {
      reply: (frame) => [responseFrame(frame.seq + 5)],
      first: ['internal-error', 'owner-protocol-error'],
    },
    'a duplicate response': {
      reply: (frame) => [
        responseFrame(frame.seq),
        'pause',
        responseFrame(frame.seq),
      ],
      first: ['success', undefined],
    },
  };
  for (const [label, { reply, first }] of Object.entries(correlationCases)) {
    test(`${label}: the connection is closed and the next call fails structurally`, async () => {
      let serverClosed = false;
      const host = await scriptedOwner(async (frame, socket) => {
        socket.once('close', () => (serverClosed = true));
        for (const item of reply(frame)) {
          if (item === 'pause') await sleep(30);
          else if (Array.isArray(item))
            socket.write(
              Buffer.concat(item.map((one) => frames.encodeFrame(one))),
            );
          else socket.write(frames.encodeFrame(item));
        }
      });
      const remote = openWorkspace(host);
      expect((await remote.attach()).outcome).toBe('success');
      const answer = await remote.dispatch('session.status', {});
      expect([answer.outcome, answer.failure?.reason]).toEqual(first);
      await sleep(100);
      expect(serverClosed).toBe(true);
      expect(remote.workspace.subject().closed).toBe(true);
      const next = await remote.dispatch('session.status', {});
      expect([next.outcome, next.failure?.reason]).toEqual([
        'owner-required',
        'owner-closed',
      ]);
    });
  }

  test('concurrent calls on one workspace are queued, one request in flight', async () => {
    let active = 0;
    let maxActive = 0;
    const host = await scriptedOwner(async (frame, socket) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(30);
      active -= 1;
      socket.write(
        frames.encodeFrame({ t: 'response', seq: frame.seq, envelope }),
      );
    });
    const remote = openWorkspace(host);
    expect((await remote.attach()).outcome).toBe('success');
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => remote.dispatch('session.status', {})),
    );
    expect(answers.every((answer) => answer.outcome === 'success')).toBe(true);
    expect(maxActive).toBe(1);
  });
});
