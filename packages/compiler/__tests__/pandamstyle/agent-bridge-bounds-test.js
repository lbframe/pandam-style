/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 fix-round class R1: every frame and message ceiling is derived from
 * the closed schema of what it carries (I13). Each bound is exercised at its
 * maximum valid content and one byte above, in both directions, and the
 * descriptor at its full documented schema (review follow-up R2-F1).
 */

'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  cleanup,
  compiler,
  entryPath,
  expectDeclared,
  frames,
  handshake,
  onCleanup,
  openHost,
  openWorkspace,
  rawAuthenticated,
  rawClient,
  readDescriptorFile,
  readKeyFile,
} = require('./agent-bridge-support');
const { openExistingProject, openProject } = require('./session-helpers');

jest.setTimeout(120000);
afterEach(cleanup);

const { CEILINGS, FRAME_SCHEMAS, LIMIT_CAP, DESCRIPTOR_BOUNDS } = frames;
const {
  GRANTS,
  maxJsonBytes,
  snapshotRequest,
  DEFAULT_REQUEST_LIMITS,
  bridgeDescriptor,
} = compiler;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const failureOf = (envelope) => [envelope.outcome, envelope.failure?.reason];

/** A frame of exactly `size` bytes: the JSON of `value` padded with spaces. */
function paddedFrame(value, size) {
  const text = JSON.stringify(value);
  const body = Buffer.from(text + ' '.repeat(size - Buffer.byteLength(text)));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** A string whose JSON serialization (quotes excluded) is `bytes` long. */
const escaped = (bytes) => '"'.repeat(bytes / 2);

/**
 * An owner stand-in at a real bridge's endpoint, holding its real key: it
 * completes the handshake honestly, then sends what the test scripts.
 */
async function fakeOwner(host, script) {
  const { runtimeDir } = host;
  const { name } = host.bridge;
  const descriptor = readDescriptorFile(runtimeDir, name);
  const key = readKeyFile(runtimeDir, name);
  const keyText = key.text;
  await host.bridge.close();
  host.bridge = null;
  fs.writeFileSync(entryPath(runtimeDir, name, 'key'), keyText, {
    mode: 0o600,
  });
  fs.writeFileSync(
    entryPath(runtimeDir, name, 'json'),
    JSON.stringify(descriptor),
    { mode: 0o600 },
  );
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let state = 'hello';
    let cn = null;
    const sn = handshake.nonce();
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
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
          socket.write(script.ready(descriptor));
        } else socket.write(script.response(frame));
      }
    });
  });
  await new Promise((resolve) =>
    server.listen(entryPath(runtimeDir, name, 'sock'), resolve),
  );
  onCleanup(() => new Promise((resolve) => server.close(resolve)));
  return descriptor;
}

/** The largest `ready` the schema admits, for `sessionId`. */
function maximalReady(sessionId) {
  const revision = {
    projectId: 'p'.repeat(1024),
    sessionId,
    revisionId: MAX_SAFE,
  };
  const longestGrant = [...GRANTS].sort((a, b) => b.length - a.length)[0];
  return {
    t: 'ready',
    identities: {
      projectId: 'p'.repeat(1024),
      sessionId,
      revision,
      designSystem: {
        systemId: 's'.repeat(768),
        registryDigest: 'f'.repeat(64),
      },
      lastValidDesignSystem: {
        systemId: 's'.repeat(768),
        registryDigest: 'f'.repeat(64),
        derivedFromRevision: revision,
      },
    },
    grants: GRANTS.map(() => longestGrant),
    limits: {
      maxRequestBytes: LIMIT_CAP,
      compact: LIMIT_CAP,
      detail: LIMIT_CAP,
    },
  };
}

describe('AG-02.1 R1: ceilings are derived from schemas (I13)', () => {
  test('every frame type has a ceiling equal to maxJsonBytes of its schema', () => {
    for (const name of [
      'hello',
      'challenge',
      'auth',
      'ready',
      'error',
      'descriptor',
    ])
      expect([name, CEILINGS[name]]).toEqual([
        name,
        maxJsonBytes(FRAME_SCHEMAS[name]),
      ]);
    expect(Object.keys(FRAME_SCHEMAS).sort()).toEqual(
      ['auth', 'challenge', 'descriptor', 'error', 'hello', 'ready'].sort(),
    );
    // Wrappers: the payload measured as null, then its own bound added.
    const wrapper = (t, key) =>
      maxJsonBytes({
        type: 'object',
        properties: {
          t: { const: t },
          seq: { type: 'integer', minimum: 1, maximum: MAX_SAFE },
          [key]: { type: 'null' },
        },
        required: ['t', 'seq', key],
        additionalProperties: false,
      }) - 4;
    expect(CEILINGS.requestWrapper).toBe(wrapper('request', 'request'));
    expect(CEILINGS.responseWrapper).toBe(wrapper('response', 'envelope'));
    expect(CEILINGS.key).toBe(
      Buffer.from('x'.repeat(32)).toString('base64').length,
    );
    // `ready` carries the envelope's own identities schema.
    expect(FRAME_SCHEMAS.ready.properties.identities).toEqual(
      compiler.envelopeSchema(
        {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        compiler.REGISTRY.names,
      ).properties.identities,
    );
  });

  test('R2-F1: the descriptor schema covers every documented field, and its maximum content fits exactly', () => {
    const sample = bridgeDescriptor.buildDescriptor({
      projectId: 'p',
      sessionId: '00000000-0000-4000-8000-000000000000',
      rootDir: '/r',
      outDir: '/r/o',
      keyText: handshake.newKey().text,
      host: 'test',
    });
    const schema = FRAME_SCHEMAS.descriptor;
    expect(Object.keys(sample).sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    expect([...schema.required].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
    for (const field of ['compilerVersion', 'createdAt'])
      expect(schema.properties).toHaveProperty(field);
    const longestHost = [...frames.HOSTS].sort(
      (a, b) => b.length - a.length,
    )[0];
    const maximal = {
      ...sample,
      bridgeVersions: Array(16).fill(1024),
      protocolVersions: Array(16).fill(1024),
      projectId: escaped(1024),
      rootDir: 'r'.repeat(4096),
      outDir: 'o'.repeat(4096),
      owner: {
        kind: 'attached',
        host: longestHost,
        pid: DESCRIPTOR_BOUNDS.pid,
      },
      compilerVersion: 'v'.repeat(DESCRIPTOR_BOUNDS.compilerVersion),
    };
    expect(frames.validFrame('descriptor', maximal)).toBe(true);
    expect(bytesOf(maximal)).toBe(CEILINGS.descriptor);
    expect(
      frames.validFrame('descriptor', {
        ...maximal,
        compilerVersion: 'v'.repeat(65),
      }),
    ).toBe(false);
  });

  test('the largest ready, error and handshake frames fit their ceilings exactly', () => {
    const sessionId = '00000000-0000-4000-8000-000000000000';
    const ready = maximalReady(sessionId);
    expect(frames.validFrame('ready', ready)).toBe(true);
    expect(bytesOf(ready)).toBe(CEILINGS.ready);
    const longest = (values) =>
      [...values].sort((a, b) => b.length - a.length)[0];
    const error = {
      t: 'error',
      seq: MAX_SAFE,
      outcome: longest(
        compiler.bridgeFrames.FRAME_SCHEMAS.error.properties.outcome.enum,
      ),
      reason: longest(frames.OWNER_FRAME_REASONS),
    };
    expect(frames.validFrame('error', error)).toBe(true);
    expect(bytesOf(error)).toBe(CEILINGS.error);
    const hello = {
      t: 'hello',
      bridge: Array(16).fill(1024),
      cn: handshake.nonce(),
    };
    expect(bytesOf(hello)).toBe(CEILINGS.hello);
    expect(bytesOf({ t: 'auth', proof: handshake.nonce() })).toBe(
      CEILINGS.auth,
    );
    const challenge = {
      t: 'challenge',
      bridge: 1024,
      sn: handshake.nonce(),
      sessionId,
      proof: handshake.nonce(),
    };
    expect(bytesOf(challenge)).toBe(CEILINGS.challenge);
  });
});

describe('AG-02.1 R1: maximum content attaches, one byte above is refused', () => {
  test('R2-F1: a real near-PATH_MAX root, a 1 024-byte escaped projectId and a 64-byte version attach', async () => {
    // A copy of the fixture tree under a ~4 000-byte real root.
    const source = openProject('valid');
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-bridge-deep-'));
    onCleanup(() => fs.rmSync(top, { recursive: true, force: true }));
    let deep = top;
    while (deep.length < 3900) {
      deep = path.join(deep, 'd'.repeat(Math.min(200, 3950 - deep.length)));
      fs.mkdirSync(deep);
    }
    fs.cpSync(path.dirname(source.project), deep, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const project = path.join(deep, 'valid');
    const fixture = openExistingProject(project);
    // The session's own state files (`.<outDir>.pms-state.pending.json.tmp`)
    // must stay under PATH_MAX.
    const longOut = path.join(project, 'o'.repeat(4050 - project.length - 1));
    const host = await openHost({
      reuse: fixture,
      sessionOptions: { projectId: escaped(1024), outDir: longOut },
    });
    expect(host.bridge.started).toBe(true);
    const { runtimeDir } = host;
    const { name } = host.bridge;
    const descriptor = readDescriptorFile(runtimeDir, name);
    expect(descriptor.rootDir.length).toBeGreaterThan(3900);
    expect(descriptor.outDir.length).toBeGreaterThan(4040);
    // The bundle under test cannot read its own manifest version; the
    // documented maximum is written in place, as an owner of another build
    // would write it.
    const full = { ...descriptor, compilerVersion: 'v'.repeat(64) };
    fs.writeFileSync(entryPath(runtimeDir, name, 'json'), JSON.stringify(full));
    expect(bytesOf(full)).toBeLessThanOrEqual(CEILINGS.descriptor);
    expect(bytesOf(full)).toBeGreaterThan(8192);
    const remote = openWorkspace(host);
    const attached = await remote.attach();
    expect(attached.outcome).toBe('success');
    expect(attached.identities.projectId).toBe(escaped(1024));
    // The request reached the owner's session: the same verdict as an
    // in-process dispatch on that session.
    const rev = attached.identities.revision;
    const remoteCheck = await remote.dispatch('check', { rev });
    const local = await compiler.createAgentBinding({ session: host.session });
    const localCheck = await local.dispatch(
      { protocolVersion: 1, operation: 'check', input: { rev } },
      { capability: local.mintCapability({ grants: ['consult'] }) },
    );
    expect(remoteCheck.outcome).toBe(localCheck.outcome);
    expect(remoteCheck.result).toEqual(localCheck.result);
    // One byte over the derived descriptor ceiling is refused.
    fs.writeFileSync(
      entryPath(runtimeDir, name, 'json'),
      JSON.stringify(full) +
        ' '.repeat(CEILINGS.descriptor + 1 - bytesOf(full)),
    );
    expect(failureOf(await remote.attach())).toEqual([
      'owner-required',
      'descriptor-invalid',
    ]);
  });

  test('ready: a real session at the maximum projectId; a stand-in at exactly the ceiling; one byte above', async () => {
    const real = await openHost({
      sessionOptions: { projectId: escaped(1024) },
    });
    const raw = await rawAuthenticated(real.runtimeDir, real.bridge.name);
    expect(raw.ready.t).toBe('ready');
    expect(bytesOf(raw.ready)).toBeGreaterThan(1024);
    expect(bytesOf(raw.ready)).toBeLessThanOrEqual(CEILINGS.ready);

    for (const extra of [0, 1]) {
      const host = await openHost();
      await fakeOwner(host, {
        ready: (descriptor) =>
          paddedFrame(
            maximalReady(descriptor.sessionId),
            CEILINGS.ready + extra,
          ),
        response: () => Buffer.alloc(0),
      });
      const remote = openWorkspace(host);
      const attached = await remote.attach();
      if (extra === 0) expect(attached.outcome).toBe('success');
      else {
        expect(failureOf(attached)).toEqual([
          'internal-error',
          'owner-protocol-error',
        ]);
        expectDeclared(attached);
      }
    }
  });

  test('response: a frame at the announced ceiling is delivered; one byte above is owner-protocol-error', async () => {
    const compact = compiler.REGISTRY.views.compact.maxResponseBytes;
    for (const extra of [0, 1]) {
      const host = await openHost();
      await fakeOwner(host, {
        ready: (descriptor) =>
          frames.encodeFrame({
            t: 'ready',
            identities: { sessionId: descriptor.sessionId },
            grants: ['consult'],
            limits: { maxRequestBytes: 65536, compact, detail: compact },
          }),
        response: (frame) => {
          const envelope = { protocol: 'pandamstyle-agent', pad: '' };
          const wrapper = { t: 'response', seq: frame.seq, envelope };
          const size = frames.responseCeiling(compact) + extra;
          envelope.pad = 'z'.repeat(size - bytesOf(wrapper));
          return frames.encodeFrame(wrapper);
        },
      });
      const remote = openWorkspace(host);
      expect((await remote.attach()).outcome).toBe('success');
      const response = await remote.dispatch('session.status', {});
      if (extra === 0) expect(response.pad.length).toBeGreaterThan(0);
      else
        expect(failureOf(response)).toEqual([
          'internal-error',
          'owner-protocol-error',
        ]);
    }
  });

  test('request: exactly maxRequestBytes reaches the owner; one byte above is refused, both ways', async () => {
    const host = await openHost();
    const remote = openWorkspace(host);
    await remote.attach();
    // A request whose snapshot is exactly `target` bytes, measured without
    // the limit so a size above it can be built too.
    const measure = (value) =>
      snapshotRequest(value, {
        ...DEFAULT_REQUEST_LIMITS,
        maxRequestBytes: Number.MAX_SAFE_INTEGER,
      }).bytes;
    const sized = (target) => {
      const request = {
        protocolVersion: 1,
        operation: 'session.status',
        input: {},
        filler: [],
      };
      // Each string costs its length, two quotes and, after the first, a comma.
      const cost = (length) => length + 2 + (request.filler.length > 0 ? 1 : 0);
      while (target - measure(request) > cost(4094) + cost(0))
        request.filler.push('a'.repeat(4094));
      request.filler.push('a'.repeat(target - measure(request) - cost(0)));
      return request;
    };
    const max = DEFAULT_REQUEST_LIMITS.maxRequestBytes;
    const atMax = sized(max);
    expect(snapshotRequest(atMax).bytes).toBe(max);
    const reached = await remote.workspace.dispatch(atMax, {
      capability: remote.capability,
    });
    // The owner's dispatch answered (an unknown field), not a frame bound.
    expect(failureOf(reached)).toEqual([
      'invalid-input',
      'schema-additional-properties',
    ]);
    const over = sized(max + 1);
    const refused = await remote.workspace.dispatch(over, {
      capability: remote.capability,
    });
    expect(failureOf(refused)).toEqual(['invalid-input', 'request-too-large']);
    expectDeclared(refused, 'session.status');

    // Raw: a request frame at the derived ceiling is read, one above is not.
    const ceiling = frames.requestCeiling(max);
    const atCeiling = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    atCeiling.client.write(
      paddedFrame(
        { t: 'request', seq: 1, request: { protocolVersion: 1 } },
        ceiling,
      ),
    );
    expect((await atCeiling.client.next(3)).t).toBe('response');
    const above = await rawAuthenticated(host.runtimeDir, host.bridge.name);
    above.client.write(
      paddedFrame(
        { t: 'request', seq: 1, request: { protocolVersion: 1 } },
        ceiling + 1,
      ),
    );
    expect(await above.client.next(3)).toEqual({
      t: 'error',
      seq: null,
      outcome: 'invalid-input',
      reason: 'request-too-large',
    });
  });

  test('handshake frames: at the ceiling they are read, one byte above they are refused', async () => {
    const host = await openHost();
    const sock = entryPath(host.runtimeDir, host.bridge.name, 'sock');
    // The largest hello names no version 1: read, then answered structurally.
    const largest = rawClient(sock);
    await largest.connected;
    largest.write(
      paddedFrame(
        { t: 'hello', bridge: Array(16).fill(1024), cn: handshake.nonce() },
        CEILINGS.hello,
      ),
    );
    expect((await largest.next(1)).reason).toBe('protocol-version');
    const over = rawClient(sock);
    await over.connected;
    over.write(
      paddedFrame(
        { t: 'hello', bridge: [1], cn: handshake.nonce() },
        CEILINGS.hello + 1,
      ),
    );
    expect((await over.next(1)).reason).toBe('request-too-large');
    // auth at its ceiling reaches the proof check; one byte above does not.
    for (const [size, reason] of [
      [CEILINGS.auth, 'authentication-failed'],
      [CEILINGS.auth + 1, 'request-too-large'],
    ]) {
      const client = rawClient(sock);
      await client.connected;
      client.send({ t: 'hello', bridge: [1], cn: handshake.nonce() });
      await client.next(1);
      client.write(paddedFrame({ t: 'auth', proof: handshake.nonce() }, size));
      expect((await client.next(2)).reason).toBe(reason);
    }
  });
});
