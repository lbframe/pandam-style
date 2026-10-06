/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  createSupervisor,
  resolveInstalledNext,
} from '../../src/supervisor.js';
import transport from '../../src/transport-client.cjs';
import codec from '../../src/transport-codec.cjs';

const {
  request,
  subscribe,
  readConnection,
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
} = transport;
const { encode, decode } = codec;
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(
  t,
  {
    command = 'dev',
    constructionGate,
    transformResponse,
    transformError,
    closeError,
    events = [],
  } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms-protocol-unit-'));
  await fs.writeFile(
    path.join(root, 'package.json'),
    '{"name":"protocol-unit","private":true}\n',
  );
  let constructions = 0;
  let closes = 0;
  let finishes = 0;
  let factoryContext;
  let ownerOptions;
  const transformed = [];
  const productionBoundaries = [];
  const identity = {
    projectId: `unit-project:${path.basename(root)}`,
    sessionId: randomUUID(),
  };
  const started = deferred();
  const supervisor = await createSupervisor(root, {
    command,
    async createOwner(ownerRoot, options, context) {
      constructions += 1;
      ownerOptions = options;
      factoryContext = context;
      assert.equal(ownerRoot, root);
      started.resolve();
      if (constructionGate != null) await constructionGate.promise;
      return {
        ...identity,
        events,
        registerDescription() {
          return {
            ...identity,
            root,
            command,
            snapshotId: 'compiler-snapshot-unit',
            generationId: 7,
          };
        },
        async synchronize() {
          return { snapshotId: 'compiler-snapshot-unit', generationId: 7 };
        },
        async snapshotStats() {
          return { pins: 1, snapshots: 1 };
        },
        async transform(payload) {
          transformed.push(payload);
          if (transformError != null) throw transformError;
          return (
            transformResponse ?? {
              ...identity,
              snapshotId: payload.snapshotId,
              sourceDigest: payload.sourceDigest,
              javascript: 'compiler bytes',
              generationId: 7,
            }
          );
        },
        async finishProduction() {
          finishes += 1;
          return { ...identity, generationId: 7 };
        },
        async recordProductionBoundary(observation) {
          productionBoundaries.push(observation);
        },
        async close() {
          closes += 1;
          if (closeError != null) throw closeError;
        },
      };
    },
  });
  t.after(async () => {
    await supervisor.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const options = {
    backend: 'turbopack',
    publicationMode: command === 'dev' ? 'semantic-dev' : 'strict',
    definition: { systemId: 'protocol-unit' },
    roots: ['semantic'],
  };
  const registration = { root, command, options, distDir: '.next' };
  const register = (payload = registration) =>
    request(
      supervisor.credentialFile,
      'register',
      payload,
      {},
      { timeoutMs: 5000 },
    );
  return {
    root,
    supervisor,
    identity,
    registration,
    register,
    started,
    transformed,
    productionBoundaries,
    get constructions() {
      return constructions;
    },
    get closes() {
      return closes;
    },
    get finishes() {
      return finishes;
    },
    get context() {
      return factoryContext;
    },
    get options() {
      return ownerOptions;
    },
  };
}

function envelope(
  connection,
  method,
  payload = {},
  identity = {},
  overrides = {},
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    supervisorId: connection.supervisorId,
    authToken: connection.authToken,
    requestId: randomUUID(),
    method,
    ...identity,
    payload: encode(payload),
    ...overrides,
  };
}

/** Real Unix stream used for malformed/hostile peer requests. No mocked sockets. */
function exchangeBytes(
  connection,
  bytes,
  { timeoutMs = 5000, keepOpen = false } = {},
) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connection.socketPath);
    let buffer = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!keepOpen || error) socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error('Unit IPC peer did not respond or close.')),
      timeoutMs,
    );
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(bytes));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        finish(null, {
          response: JSON.parse(buffer.slice(0, end)),
          socket,
          remainder: buffer.slice(end + 1),
        });
      } catch (error) {
        finish(error);
      }
    });
    socket.once('error', () => finish(null, { closed: true }));
    socket.once('close', () => finish(null, { closed: true }));
  });
}

function exchange(connection, message, options) {
  return exchangeBytes(connection, `${JSON.stringify(message)}\n`, options);
}

function nextLine(socket, initial = '') {
  return new Promise((resolve, reject) => {
    let buffer = initial;
    const timer = setTimeout(
      () => finish(new Error('Unit subscription did not receive its event.')),
      5000,
    );
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('close', closed);
      if (error) reject(error);
      else resolve(value);
    };
    const closed = () =>
      finish(new Error('Unit subscription closed before its event.'));
    const data = (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end !== -1) {
        try {
          finish(null, JSON.parse(buffer.slice(0, end)));
        } catch (error) {
          finish(error);
        }
      }
    };
    socket.on('data', data);
    socket.once('close', closed);
    if (buffer.includes('\n')) data('');
  });
}

/** Controlled hostile responder on a real socket for client refusal proofs. */
async function responsePeer(t, f, reply) {
  const socketPath = path.join(f.root, `peer-${randomUUID().slice(0, 8)}.sock`);
  const credentialFile = `${socketPath}.json`;
  const connection = {
    ...readConnection(f.supervisor.credentialFile),
    socketPath,
  };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const incoming = JSON.parse(buffer.slice(0, end));
      const base = {
        protocolVersion: PROTOCOL_VERSION,
        supervisorId: connection.supervisorId,
        requestId: incoming.requestId,
        projectId: incoming.projectId,
        sessionId: incoming.sessionId,
        ok: true,
        data: encode({ revisionId: 1, generationId: 1 }),
      };
      const replies = reply(base, incoming);
      socket.write(
        replies.map((response) => `${JSON.stringify(response)}\n`).join(''),
      );
    });
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.writeFile(credentialFile, JSON.stringify(connection), {
    mode: 0o600,
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return credentialFile;
}

test('concurrent identical registrations construct exactly one owner over real Unix IPC', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { constructionGate: gate });
  const registrations = Array.from({ length: 8 }, () => f.register());
  await f.started.promise;
  assert.equal(f.constructions, 1);
  gate.resolve();
  const results = await Promise.all(registrations);
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(f.constructions, 1);
  assert.equal(results[0].projectId, f.identity.projectId);
  assert.equal(results[0].sessionId, f.identity.sessionId);
  const connection = readConnection(f.supervisor.credentialFile);
  assert.equal(
    (await fs.stat(f.supervisor.credentialFile)).mode & 0o777,
    0o600,
  );
  assert.equal((await fs.stat(connection.socketPath)).mode & 0o777, 0o600);
  assert.equal(
    (await fs.stat(path.dirname(connection.socketPath))).mode & 0o777,
    0o700,
  );
});

test('changed configuration rejects without creating another semantic owner', async (t) => {
  const f = await fixture(t);
  await f.register();
  await assert.rejects(
    f.register({
      ...f.registration,
      options: { ...f.registration.options, roots: ['different-root'] },
    }),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  await assert.rejects(
    f.register({ ...f.registration, distDir: 'different-next-output' }),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  assert.equal(f.constructions, 1);
  assert.deepEqual(
    await f.register(),
    f.supervisor.owner.registerDescription(),
  );
});

test('CLI/config disagreement and mode restrictions reject before owner construction and preserve the registration queue', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { ...f.registration, root: path.dirname(f.root) },
    { ...f.registration, command: 'build' },
    {
      ...f.registration,
      options: { ...f.registration.options, backend: 'webpack' },
    },
    {
      ...f.registration,
      options: { ...f.registration.options, publicationMode: 'strict' },
    },
  ])
    await assert.rejects(f.register(invalid));
  assert.equal(f.constructions, 0);
  await f.register();
  assert.equal(f.constructions, 1);
});

test('Symbol.for token keys and undefined values survive actual option and response transport', async (t) => {
  const tokenKey = Symbol.for('pandamstyle.token-ref');
  const f = await fixture(t);
  const definition = {
    systemId: 'symbol-unit',
    token: { [tokenKey]: 'spacing.md', optional: undefined },
    values: [undefined, null, true, 3],
  };
  await f.register({
    ...f.registration,
    options: { ...f.registration.options, definition },
  });
  assert.deepEqual(f.options.definition, definition);
  assert.equal(
    Reflect.ownKeys(f.options.definition.token).find(
      (key) => typeof key === 'symbol',
    ),
    tokenKey,
  );
  const echo = await request(
    f.supervisor.credentialFile,
    'transform',
    {
      file: 'page.jsx',
      sourceDigest: 'a'.repeat(64),
      snapshotId: 'snapshot-requested',
      token: definition.token,
    },
    f.identity,
  );
  assert.equal(f.transformed[0].token[tokenKey], 'spacing.md');
  assert.equal(echo.snapshotId, 'snapshot-requested');
  assert.equal(echo.sourceDigest, 'a'.repeat(64));
});

test('codec rejects unsupported prototypes, accessors, functions, cycles and unregistered symbols without invoking accessors', () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      calls += 1;
      return 'secret';
    },
  });
  for (const value of [new Date(), () => {}, Symbol('local'), accessor])
    assert.throws(() => encode(value), TypeError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => encode(cyclic), /cyclic/);
  assert.equal(calls, 0);
  const decoded = decode([
    'object',
    [
      [
        ['value', '__proto__'],
        ['value', 'ordinary-own-value'],
      ],
    ],
  ]);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(Object.hasOwn(decoded, '__proto__'), true);
  assert.equal(
    Object.getOwnPropertyDescriptor(decoded, '__proto__').value,
    'ordinary-own-value',
  );
  assert.throws(() => decode(['unsupported-wire-tag', null]), TypeError);
});

test('unsupported protocol versions, retired supervisors and incorrect credentials reject over the socket', async (t) => {
  const f = await fixture(t);
  const connection = readConnection(f.supervisor.credentialFile);
  for (const overrides of [
    { protocolVersion: PROTOCOL_VERSION + 1 },
    { supervisorId: 'retired-supervisor' },
    { authToken: '0'.repeat(connection.authToken.length) },
    { authToken: undefined },
    { requestId: 123 },
  ]) {
    const received = await exchange(
      connection,
      envelope(connection, 'register', f.registration, {}, overrides),
    );
    assert.equal(received.response.ok, false);
    assert.equal(received.response.error.code, 'PMS_TRANSPORT_PROTOCOL');
  }
  assert.equal(f.constructions, 0);
  await f.register();
  assert.equal(f.constructions, 1);
});

test('foreign projects, old sessions and requests before registration reject without a transform', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    request(f.supervisor.credentialFile, 'status', {}, f.identity),
    { code: 'PMS_TRANSPORT_IDENTITY' },
  );
  await f.register();
  for (const identity of [
    { ...f.identity, projectId: 'foreign-project' },
    { ...f.identity, sessionId: 'previous-session-with-equal-revision-1' },
    { projectId: f.identity.projectId },
  ])
    await assert.rejects(
      request(
        f.supervisor.credentialFile,
        'transform',
        { file: 'page.jsx', revisionId: 1 },
        identity,
      ),
      { code: 'PMS_TRANSPORT_IDENTITY' },
    );
  assert.equal(f.transformed.length, 0);
});

test('responses preserve correlation and project/session identity independently from snapshot identity', async (t) => {
  const f = await fixture(t);
  await f.register();
  const connection = readConnection(f.supervisor.credentialFile);
  const packet = envelope(
    connection,
    'transform',
    {
      file: 'page.jsx',
      projectId: 'payload-cannot-override-owner',
      sessionId: 'payload-old-session',
      snapshotId: 'compiler-snapshot-unit',
      sourceDigest: 'b'.repeat(64),
    },
    f.identity,
  );
  const { response } = await exchange(connection, packet);
  assert.equal(response.requestId, packet.requestId);
  assert.equal(response.supervisorId, connection.supervisorId);
  assert.equal(response.protocolVersion, PROTOCOL_VERSION);
  assert.equal(response.projectId, f.identity.projectId);
  assert.equal(response.sessionId, f.identity.sessionId);
  assert.equal(response.ok, true);
  assert.equal(decode(response.data).snapshotId, 'compiler-snapshot-unit');
  assert.equal(f.transformed[0].projectId, f.identity.projectId);
  assert.equal(f.transformed[0].sessionId, f.identity.sessionId);
  assert.deepEqual(
    await request(
      f.supervisor.credentialFile,
      'snapshot-stats',
      {},
      f.identity,
    ),
    { pins: 1, snapshots: 1 },
  );
  assert.equal(
    (await request(f.supervisor.credentialFile, 'synchronize', {}, f.identity))
      .generationId,
    7,
  );
});

test('subscription forwards scoped owner events with the original subscription correlation', async (t) => {
  const f = await fixture(t);
  await f.register();
  const connection = readConnection(f.supervisor.credentialFile);
  const packet = envelope(connection, 'subscribe', {}, f.identity);
  const subscribed = await exchange(connection, packet, { keepOpen: true });
  t.after(() => subscribed.socket.destroy());
  assert.equal(decode(subscribed.response.data).subscribed, true);
  const waiting = nextLine(subscribed.socket, subscribed.remainder);
  const observation = {
    scope: 'semantic-committed',
    ...f.identity,
    revision: { ...f.identity, revisionId: 2 },
    generationId: 8,
    snapshotId: 'accepted-snapshot-2',
  };
  f.context.onEvent(observation);
  const event = await waiting;
  assert.equal(event.requestId, packet.requestId);
  assert.equal(event.projectId, f.identity.projectId);
  assert.equal(event.sessionId, f.identity.sessionId);
  assert.deepEqual(decode(event.data), observation);
});

test('client rejects replies from old sessions, foreign projects and wrong correlations even when counters match', async (t) => {
  const f = await fixture(t);
  await f.register();
  for (const override of [
    { protocolVersion: PROTOCOL_VERSION + 1 },
    { supervisorId: 'retired-supervisor' },
    { requestId: 'another-concurrent-request' },
    { projectId: 'other-project' },
    { sessionId: 'old-session-with-the-same-revision-and-generation-1' },
  ]) {
    const credentials = await responsePeer(t, f, (base) => [
      { ...base, ...override },
    ]);
    await assert.rejects(request(credentials, 'status', {}, f.identity), {
      code: 'PMS_TRANSPORT_IDENTITY',
    });
  }
  const credentials = await responsePeer(t, f, (base) => [base]);
  assert.deepEqual(await request(credentials, 'status', {}, f.identity), {
    revisionId: 1,
    generationId: 1,
  });
});

test('authenticated bootstrap identification refuses before registration and returns the existing exact owner', async (t) => {
  const f = await fixture(t);
  await assert.rejects(request(f.supervisor.credentialFile, 'identify', {}), {
    code: 'PMS_INVALID_REVISION',
  });
  assert.equal(f.constructions, 0);
  const registered = await f.register();
  const identified = await request(f.supervisor.credentialFile, 'identify', {});
  assert.deepEqual(identified, registered);
  assert.equal(identified.projectId, f.identity.projectId);
  assert.equal(identified.sessionId, f.identity.sessionId);
  assert.equal(f.constructions, 1);
});

test('owner error details and failure dependencies survive the real codec transport', async (t) => {
  const failure = new Error('unit definition input failure');
  failure.code = 'PMS_INVALID_DEFINITION';
  const f = await fixture(t, { transformError: failure });
  const tokenKey = Symbol.for('pandamstyle.unit-error-token');
  const details = {
    owner: 'unit-definition-input',
    file: path.join(f.root, 'definition.mjs'),
    digest: 'a'.repeat(64),
    revision: { ...f.identity, revisionId: 2 },
    token: { [tokenKey]: 'colors.ink' },
  };
  const dependencies = [details.file, path.join(f.root, 'shared/styles.js')];
  Object.assign(failure, { details, dependencies });
  await f.register();
  await assert.rejects(
    request(f.supervisor.credentialFile, 'transform', {}, f.identity),
    (error) => {
      assert.equal(error.code, failure.code);
      assert.deepEqual(error.details, details);
      assert.deepEqual(error.dependencies, dependencies);
      assert.equal(error.details.token[tokenKey], 'colors.ink');
      return true;
    },
  );
});

test('client refuses malformed error metadata from a correlated authenticated peer', async (t) => {
  const f = await fixture(t);
  await f.register();
  for (const metadata of [
    ['unsupported-error-metadata-tag', null],
    encode(null),
    encode(false),
    encode([]),
    encode({ details: {}, dependencies: 'not-an-array' }),
    encode({ details: {}, dependencies: [42] }),
    encode({ details: false, dependencies: [] }),
  ]) {
    const credentials = await responsePeer(t, f, (base) => [
      {
        ...base,
        ok: false,
        error: {
          code: 'PMS_INVALID_DEFINITION',
          message: 'unit malformed metadata',
          metadata,
        },
      },
    ]);
    await assert.rejects(request(credentials, 'status', {}, f.identity), {
      code: 'PMS_TRANSPORT_PROTOCOL',
    });
  }
});

test('subscription replays actual initial diagnostics after its acknowledgement without inventing events', async (t) => {
  const events = [];
  const f = await fixture(t, { events });
  events.push(
    {
      type: 'diagnostics',
      ...f.identity,
      result: { ok: true, diagnostics: [] },
    },
    { type: 'semantic-committed', ...f.identity, generationId: 7 },
  );
  await f.register();
  const received = [];
  const replayed = deferred();
  const stop = subscribe(f.supervisor.credentialFile, f.identity, (event) => {
    received.push(event);
    if (received.length === events.length) replayed.resolve();
  });
  t.after(stop);
  await replayed.promise;
  stop();
  assert.deepEqual(received, events);
  assert.equal(f.constructions, 1);
});

test('public subscription client consumes a valid acknowledgement and correlated event on one stream', async (t) => {
  const f = await fixture(t);
  await f.register();
  const observation = {
    scope: 'module-transformed',
    ...f.identity,
    snapshotId: 'immutable-snapshot',
    revisionId: 1,
  };
  const credentials = await responsePeer(t, f, (base) => [
    { ...base, data: encode({ subscribed: true }) },
    { ...base, data: encode(observation) },
  ]);
  const received = deferred();
  const stop = subscribe(credentials, f.identity, (event) =>
    received.resolve(event),
  );
  t.after(stop);
  assert.deepEqual(await received.promise, observation);
  stop();
});

test('unknown methods and malformed envelopes/payloads never reach the owner', async (t) => {
  const f = await fixture(t);
  await f.register();
  const connection = readConnection(f.supervisor.credentialFile);
  for (const method of [
    'unknown-operation',
    'close',
    'finishProduction',
    'finishSuccessfulProduction',
    'constructor',
    '__proto__',
  ])
    await assert.rejects(
      request(f.supervisor.credentialFile, method, {}, f.identity),
      { code: 'PMS_TRANSPORT_PROTOCOL' },
    );
  for (const packet of ['null\n', 'true\n', '[]\n', '{broken-json\n']) {
    const received = await exchangeBytes(connection, packet);
    assert.equal(
      received.closed === true || received.response?.ok === false,
      true,
    );
  }
  const invalidPayload = await exchange(
    connection,
    envelope(connection, 'transform', {}, f.identity, {
      payload: ['unsupported-wire-tag', null],
    }),
  );
  assert.equal(invalidPayload.response.ok, false);
  assert.equal(invalidPayload.response.error.code, 'PMS_TRANSPORT_PROTOCOL');
  assert.equal(f.transformed.length, 0);
  assert.equal(
    (await request(f.supervisor.credentialFile, 'status', {}, f.identity))
      .sessionId,
    f.identity.sessionId,
  );
});

test('payload bounds reject oversized local requests, hostile socket input and oversized replies', async (t) => {
  const f = await fixture(t, {
    transformResponse: { javascript: 'x'.repeat(MAX_MESSAGE_BYTES) },
  });
  await f.register();
  assert.throws(
    () =>
      request(
        f.supervisor.credentialFile,
        'transform',
        { source: 'x'.repeat(MAX_MESSAGE_BYTES) },
        f.identity,
      ),
    { code: 'PMS_TRANSPORT_PROTOCOL' },
  );
  const connection = readConnection(f.supervisor.credentialFile);
  const oversized = await exchangeBytes(
    connection,
    `${'x'.repeat(MAX_MESSAGE_BYTES + 1)}\n`,
  );
  assert.equal(oversized.closed, true);
  assert.equal(f.transformed.length, 0);
  await assert.rejects(
    request(
      f.supervisor.credentialFile,
      'transform',
      { file: 'oversized.jsx' },
      f.identity,
      { timeoutMs: 5000 },
    ),
    { code: 'PMS_COORDINATOR_UNAVAILABLE' },
  );
  assert.equal(f.transformed.length, 1);
  assert.equal(
    (await request(f.supervisor.credentialFile, 'status', {}, f.identity))
      .sessionId,
    f.identity.sessionId,
  );
});

test('clean shutdown closes subscriptions once and removes credentials and the socket directory', async (t) => {
  const f = await fixture(t);
  await f.register();
  const connection = readConnection(f.supervisor.credentialFile);
  const subscribed = await exchange(
    connection,
    envelope(connection, 'subscribe', {}, f.identity),
    { keepOpen: true },
  );
  const disconnected = new Promise((resolve) =>
    subscribed.socket.once('close', resolve),
  );
  await f.supervisor.close();
  await disconnected;
  await f.supervisor.close();
  assert.equal(f.closes, 1);
  await assert.rejects(fs.access(f.supervisor.credentialFile), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.access(path.dirname(connection.socketPath)), {
    code: 'ENOENT',
  });
  assert.throws(() => readConnection(f.supervisor.credentialFile), {
    code: 'PMS_COORDINATOR_UNAVAILABLE',
  });
});

test('shutdown waits for an in-flight registration and releases its eventual owner', async (t) => {
  const gate = deferred();
  const f = await fixture(t, { constructionGate: gate });
  const registration = f.register();
  const rejected = assert.rejects(registration, {
    code: 'PMS_COORDINATOR_UNAVAILABLE',
  });
  await f.started.promise;
  const closed = f.supervisor.close();
  gate.resolve();
  await Promise.all([closed, rejected]);
  assert.equal(f.constructions, 1);
  assert.equal(f.closes, 1);
});

test('shutdown removes credentials and the socket directory when owner close rejects', async (t) => {
  const closeError = new Error('unit owner close failure');
  const f = await fixture(t, { closeError });
  await f.register();
  const connection = readConnection(f.supervisor.credentialFile);
  const subscribed = await exchange(
    connection,
    envelope(connection, 'subscribe', {}, f.identity),
    { keepOpen: true },
  );
  const disconnected = new Promise((resolve) =>
    subscribed.socket.once('close', resolve),
  );
  await assert.rejects(f.supervisor.close(), (error) => error === closeError);
  await disconnected;
  await f.supervisor.close();
  assert.equal(f.closes, 1);
  await assert.rejects(fs.access(f.supervisor.credentialFile), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.access(path.dirname(f.supervisor.credentialFile)), {
    code: 'ENOENT',
  });
  await assert.rejects(fs.access(path.dirname(connection.socketPath)), {
    code: 'ENOENT',
  });
  assert.throws(() => readConnection(f.supervisor.credentialFile), {
    code: 'PMS_COORDINATOR_UNAVAILABLE',
  });
});

test('production boundary requires the supervised strict build and publication waits for successful Next exit', async (t) => {
  const dev = await fixture(t);
  await dev.register();
  await assert.rejects(
    request(
      dev.supervisor.credentialFile,
      'production-complete',
      { projectDir: dev.root },
      dev.identity,
    ),
    { code: 'PMS_TRANSPORT_IDENTITY' },
  );
  await assert.rejects(
    dev.supervisor.finishSuccessfulProduction({ exitCode: 0 }),
    { code: 'PMS_INVALID_REVISION' },
  );
  assert.equal(dev.finishes, 0);
  assert.equal(dev.supervisor.productionBoundaryObserved, false);
  const build = await fixture(t, { command: 'build' });
  await assert.rejects(
    build.register({
      ...build.registration,
      options: {
        ...build.registration.options,
        publicationMode: 'semantic-dev',
      },
    }),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  await build.register();
  await assert.rejects(
    build.supervisor.finishSuccessfulProduction({ exitCode: 0 }),
    { code: 'PMS_INVALID_REVISION' },
  );
  assert.equal(build.finishes, 0);
  assert.equal(build.supervisor.productionBoundaryObserved, false);
  await assert.rejects(
    request(
      build.supervisor.credentialFile,
      'production-complete',
      { projectDir: dev.root },
      build.identity,
    ),
    { code: 'PMS_TRANSPORT_IDENTITY' },
  );
  assert.equal(build.supervisor.productionCompleted, false);
  assert.deepEqual(build.productionBoundaries, []);
  const boundary = await request(
    build.supervisor.credentialFile,
    'production-complete',
    { projectDir: build.root, buildId: 'unit-next-build' },
    build.identity,
  );
  assert.equal(boundary.frameworkBoundaryObserved, true);
  assert.equal(build.supervisor.productionBoundaryObserved, true);
  assert.equal(build.supervisor.productionCompleted, false);
  assert.equal(build.finishes, 0);
  assert.deepEqual(build.productionBoundaries, [
    { projectDir: build.root, buildId: 'unit-next-build' },
  ]);
  for (const exit of [
    { exitCode: 1 },
    { exitCode: 0, signal: 'SIGTERM' },
    { exitCode: null, signal: 'SIGKILL' },
  ]) {
    await assert.rejects(build.supervisor.finishSuccessfulProduction(exit), {
      code: 'PMS_INVALID_REVISION',
    });
    assert.equal(build.finishes, 0);
    assert.equal(build.supervisor.productionCompleted, false);
  }
  const receipt = await build.supervisor.finishSuccessfulProduction({
    exitCode: 0,
  });
  assert.deepEqual(receipt, { ...build.identity, generationId: 7 });
  assert.equal(build.supervisor.productionCompleted, true);
  assert.equal(build.finishes, 1);
});

test('installed Next failure after its public boundary never finishes production during shutdown', async (t) => {
  const build = await fixture(t, { command: 'build' });
  await build.register();
  await request(
    build.supervisor.credentialFile,
    'production-complete',
    { projectDir: build.root },
    build.identity,
  );
  assert.equal(build.supervisor.productionBoundaryObserved, true);
  assert.equal(build.finishes, 0);
  await assert.rejects(
    build.supervisor.finishSuccessfulProduction({ exitCode: 1 }),
    { code: 'PMS_INVALID_REVISION' },
  );
  await build.supervisor.close();
  assert.equal(build.finishes, 0);
  assert.equal(build.supervisor.productionCompleted, false);
  assert.equal(build.closes, 1);
});

test('installed Next resolution uses the consumer public package bin and exact version', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, 'node_modules', 'next');
  await fs.mkdir(path.join(directory, 'public-bin'), { recursive: true });
  const binary = path.join(directory, 'public-bin', 'next.mjs');
  await fs.writeFile(binary, '// UNIT fixture public executable\n');
  const manifest = {
    name: 'next',
    version: '16.3.8',
    bin: { next: './public-bin/next.mjs' },
    exports: { './package.json': './package.json' },
  };
  const manifestFile = path.join(directory, 'package.json');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(await resolveInstalledNext(f.root), {
    binary,
    version: '16.3.8',
    packageDirectory: await fs.realpath(directory),
  });
  await fs.writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, bin: './public-bin/next.mjs' }),
  );
  assert.equal((await resolveInstalledNext(f.root)).binary, binary);
  await fs.writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, version: '16.3.9' }),
  );
  await assert.rejects(resolveInstalledNext(f.root), {
    code: 'PMS_UNSUPPORTED_FEATURE',
  });
  await fs.writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, bin: { next: '../other-global-next.mjs' } }),
  );
  await assert.rejects(resolveInstalledNext(f.root), {
    code: 'PMS_UNSUPPORTED_FEATURE',
  });
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, bin: {} }));
  await assert.rejects(resolveInstalledNext(f.root), {
    code: 'PMS_UNSUPPORTED_FEATURE',
  });
});

test('CLI refuses unsupported command/flag shapes before resolving Next or creating a coordinator', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms-cli-shape-unit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const args of [
    ['start', '--turbopack'],
    ['dev'],
    ['build', '--webpack'],
    ['dev', '--turbopack', '--webpack'],
    ['dev', '--turbo'],
    ['dev', '--turbopack', '--turbo'],
    ['dev', 'other-project', '--turbopack'],
    ['build', 'other-project', '--turbopack'],
    ['dev', '--turbopack', '--', 'other-project'],
    ['build', '--turbopack', '--experimental-build-mode', 'compile'],
  ]) {
    await assert.rejects(
      execute(process.execPath, [cli, ...args], { cwd: root, timeout: 5000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /PMS_UNSUPPORTED_FEATURE/);
        assert.doesNotMatch(
          error.stderr,
          /Cannot find module|ERR_MODULE_NOT_FOUND/,
        );
        return true;
      },
    );
  }
  assert.deepEqual(await fs.readdir(root), []);
});
