/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared helpers for the AG-02.1 owner-bridge suites. Every runtime directory
 * is a fresh `mkdtemp` under the system temporary directory, passed explicitly,
 * so no test touches the user's real runtime directory; `cleanup()` removes
 * them and stops every owner and process a test started.
 */

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { compiler, hashTree } = require('./agent-helpers');
const { openProject } = require('./session-helpers');

const {
  bridgeFrames: frames,
  bridgeDescriptor: descriptorModule,
  bridgeHandshake: handshake,
} = compiler;

const cleanups = [];

function onCleanup(fn) {
  cleanups.push(fn);
}

async function cleanup() {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()();
    } catch {
      /* best effort */
    }
  }
}

/** A runtime directory path whose parent is a fresh private temp dir. */
function makeRuntimeDir() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-bridge-'));
  onCleanup(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, 'pandamstyle');
}

/** A host: a fixture copy, an initialized session and its owner bridge. */
async function openHost(options = {}) {
  const fixture = options.reuse ?? openProject(options.fixture ?? 'valid');
  if (options.prepare != null) {
    options.prepare(fixture);
    fixture.reloadDefinition();
  }
  const runtimeDir = options.runtimeDir ?? makeRuntimeDir();
  const session = fixture.openPublicSession(options.sessionOptions ?? {});
  await session.initialize();
  const bridge =
    options.bridge === false
      ? null
      : await compiler.startOwnerBridge({
          session,
          host: 'test',
          runtimeDir,
          ...(options.bridgeOptions ?? {}),
        });
  let closed = false;
  const host = {
    fixture,
    session,
    bridge,
    runtimeDir,
    project: fixture.project,
    async close() {
      if (closed) return;
      closed = true;
      // The current bridge: a test may restart it on the same session.
      await host.bridge?.close?.();
      await session.close();
    },
  };
  onCleanup(() => host.close());
  return host;
}

/** A workspace binding over the host's project and runtime directory. */
function openWorkspace(host, options = {}) {
  const workspace = compiler.createWorkspaceBinding({
    projectDir: options.projectDir ?? host.project,
    runtimeDir: options.runtimeDir ?? host.runtimeDir,
  });
  onCleanup(() => workspace.dispose());
  const capability = workspace.mintCapability({ grants: ['consult'] });
  const dispatch = (operation, input, extra = {}, dispatchOptions = {}) =>
    workspace.dispatch(
      {
        protocolVersion: 1,
        operation,
        ...(input === undefined ? {} : { input }),
        ...extra,
      },
      { capability, ...dispatchOptions },
    );
  return {
    workspace,
    capability,
    dispatch,
    attach: (input = {}) =>
      dispatch('session.attach', { protocolVersions: [1], ...input }),
  };
}

const entryPath = (runtimeDir, name, ext) =>
  path.join(runtimeDir, `${name}.${ext}`);

function readDescriptorFile(runtimeDir, name) {
  return JSON.parse(
    fs.readFileSync(entryPath(runtimeDir, name, 'json'), 'utf8'),
  );
}

function readKeyFile(runtimeDir, name) {
  const text = fs.readFileSync(entryPath(runtimeDir, name, 'key'), 'latin1');
  return { text, bytes: Buffer.from(text, 'base64') };
}

/**
 * A raw socket client: sends frames or bytes, collects every frame the owner
 * returns, and reports when the owner closes the connection.
 */
function rawClient(socketPath) {
  const socket = net.createConnection(socketPath);
  onCleanup(() => socket.destroy());
  const received = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  let closed = false;
  const isClosedNow = () => closed;
  const closedPromise = new Promise((resolve) =>
    socket.once('close', () => {
      closed = true;
      resolve(true);
      for (const waiter of waiters.splice(0)) waiter();
    }),
  );
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      received.push(
        JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')),
      );
      buffer = buffer.subarray(4 + length);
      for (const waiter of waiters.splice(0)) waiter();
    }
  });
  const connected = new Promise((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('error', (error) => resolve(error.code));
  });
  return {
    socket,
    frames: received,
    connected,
    closed: closedPromise,
    isClosed: () => closed,
    send: (value) => socket.write(frames.encodeFrame(value)),
    write: (bytes) => socket.write(bytes),
    /** Resolves once `count` frames arrived, or the connection closed. */
    async next(count = received.length + 1) {
      // `closed` and `received` change in the socket's event handlers.
      while (received.length < count && !isClosedNow())
        await new Promise((resolve) => waiters.push(resolve));
      return received[count - 1];
    },
  };
}

/**
 * Authenticates a raw client with the real key, as a compliant client would,
 * and returns it in the `ready` state with the frames it saw.
 */
async function rawAuthenticated(runtimeDir, name) {
  const key = readKeyFile(runtimeDir, name);
  const client = rawClient(entryPath(runtimeDir, name, 'sock'));
  await client.connected;
  const cn = handshake.nonce();
  client.send({ t: 'hello', bridge: [1], cn });
  const challenge = await client.next(1);
  client.send({
    t: 'auth',
    proof: handshake.proof(
      key,
      'client',
      name,
      cn,
      challenge.sn,
      challenge.sessionId,
    ),
  });
  const ready = await client.next(2);
  return { client, key, cn, challenge, ready };
}

/** Starts a child-process owner; resolves with its first JSON line. */
function startChildOwner(project, runtimeDir, mode = 'bridge') {
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'agent-bridge-owner.cjs'), project, runtimeDir, mode],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  onCleanup(() => {
    if (child.exitCode == null && child.signalCode == null)
      child.kill('SIGKILL');
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return new Promise((resolve, reject) => {
    let text = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdout.on('data', (chunk) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end >= 0)
        resolve({ child, exited, ...JSON.parse(text.slice(0, end)) });
    });
    child.once('exit', (code) => {
      if (text.indexOf('\n') < 0)
        reject(new Error(`child owner exited ${code}: ${stderr}`));
    });
  });
}

/** Linux abstract socket names currently listening for an output lease. */
function leaseNames(outDir) {
  const name = `@pandamstyle-output-${crypto
    .createHash('sha256')
    .update(outDir)
    .digest('hex')}`;
  return fs
    .readFileSync('/proc/net/unix', 'utf8')
    .split('\n')
    .filter((line) => line.trim().endsWith(name)).length;
}

/** The (outcome, code, reason) of an envelope is one its entry declares. */
function expectDeclared(envelope, operation = envelope.operation) {
  const entry = compiler.REGISTRY.byName[operation];
  const triple = {
    outcome: envelope.outcome,
    code: envelope.diagnostics[0]?.code ?? null,
    reason: envelope.failure?.reason ?? null,
  };
  const declared = entry.errors.some(
    (error) =>
      error.outcome === triple.outcome &&
      (error.code === triple.code || error.code === null) &&
      error.reasons.includes(triple.reason),
  );
  if (!declared)
    throw new Error(
      `${operation}: undeclared ${JSON.stringify(triple)} (AC2, AG-01.1 rule 5)`,
    );
  return triple;
}

module.exports = {
  cleanup,
  compiler,
  descriptorModule,
  entryPath,
  expectDeclared,
  frames,
  handshake,
  hashTree,
  leaseNames,
  makeRuntimeDir,
  onCleanup,
  openHost,
  openWorkspace,
  rawAuthenticated,
  rawClient,
  readDescriptorFile,
  readKeyFile,
  startChildOwner,
};
