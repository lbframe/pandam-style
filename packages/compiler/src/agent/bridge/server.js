/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import net from 'node:net';
import { AGENT_PROTOCOL } from '../../protocol/envelope.js';
import { createAgentBinding } from '../binding.js';
import { REGISTRY } from '../registry.js';
import { buildDescriptor, nameOf } from './descriptor.js';
import {
  CEILINGS,
  CONNECTION_LIMIT,
  consumeFrames,
  encodeFrame,
  HANDSHAKE_DEADLINE_MS,
  HOSTS,
  LIMIT_CAP,
  parseFrame,
  requestCeiling,
  validFrame,
} from './frames.js';
import { newKey, nonce, proof, sameProof } from './handshake.js';
import {
  anchoringAvailable,
  openRuntimeDir,
  runtimeDirCandidates,
} from './runtime-dir.js';

/**
 * AG-02.1 owner side (§3.4–§3.8, §3.10).
 *
 * The bridge creates its own binding over the host's initialized session, so
 * disposing it never revokes the host's in-process binding. Its only call into
 * the agent layer is `binding.dispatch` (I2). A connection gets one capability,
 * minted here from the host's grants after the handshake; it never leaves this
 * process (I3). The output lease is not touched: the bridge starts after
 * `initialize()` and stops before `session.close()` (I1, I8).
 */

/** Grants a host may give bridge connections (§3.7). */
export const BRIDGE_GRANTS = Object.freeze([
  'consult',
  'publish',
  'mutate-sources',
  'extend-design-system',
  'materialize-audit',
]);

export const START_REFUSALS = Object.freeze([
  'anchoring-unavailable',
  'runtime-dir-overlap',
  'runtime-dir-unsafe',
]);

const unusable = () =>
  Object.assign(new Error('owner bridge: unusable entry'), {
    code: 'runtime-dir-unsafe',
  });

/** Resolves once `socketPath` accepts a connection, which is closed at once. */
function selfConnect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', () => reject(unusable()));
  });
}

const live = new Set();
let exitHandlerInstalled = false;
function removeLiveEntries() {
  for (const owner of live) owner.removeEntries();
}

function checkOptions({ session, host, grants, watchRoots }) {
  if (session == null || typeof session !== 'object')
    throw new TypeError('startOwnerBridge() requires a ProjectSession.');
  if (!HOSTS.includes(host))
    throw new TypeError(`startOwnerBridge() host must be one of ${HOSTS}.`);
  if (
    !Array.isArray(grants) ||
    !grants.includes('consult') ||
    !grants.every((grant) => BRIDGE_GRANTS.includes(grant))
  )
    throw new TypeError(
      'startOwnerBridge() grants must include consult and may add publish, mutate-sources, extend-design-system or materialize-audit; load-config and manage-session belong to the host.',
    );
  if (
    !Array.isArray(watchRoots) ||
    !watchRoots.every(
      (root) => typeof root === 'string' && root.startsWith('/'),
    )
  )
    throw new TypeError('startOwnerBridge() watchRoots are absolute paths.');
}

/**
 * Starts the owner bridge for an initialized session. Returns
 * `{ started: true, name, descriptor, close }`, or `{ started: false, reason }`
 * with a reason of `START_REFUSALS`; the host keeps running without a bridge.
 */
export async function startOwnerBridge({
  session,
  host,
  grants = ['consult'],
  watchRoots = [],
  runtimeDir = null,
  registry = REGISTRY,
} = {}) {
  checkOptions({ session, host, grants, watchRoots });
  if (!anchoringAvailable())
    return { started: false, reason: 'anchoring-unavailable' };

  const binding = await createAgentBinding({
    session,
    initialize: false,
    registry,
  });
  const status = await binding.dispatch(
    { protocolVersion: 1, operation: 'session.status', input: {} },
    { capability: binding.mintCapability({ grants: ['consult'] }) },
  );
  if (status.outcome !== 'success' || status.result?.initialized !== true) {
    binding.dispose();
    throw new TypeError(
      'startOwnerBridge() requires an initialized, open session.',
    );
  }
  const limits = Object.freeze({
    maxRequestBytes: registry.request.maxRequestBytes,
    compact: registry.views.compact.maxResponseBytes,
    detail: registry.views.detail.maxResponseBytes,
  });
  if (Object.values(limits).some((value) => value > LIMIT_CAP)) {
    binding.dispose();
    throw new TypeError(
      `startOwnerBridge() limits exceed the bridge bound ${LIMIT_CAP}.`,
    );
  }

  const { rootDir, outDir } = binding.paths();
  const candidate = runtimeDir ?? runtimeDirCandidates()[0];
  const opened = openRuntimeDir(candidate, {
    create: true,
    protectedRoots: [rootDir, outDir, ...watchRoots],
  });
  if (opened.refused != null) {
    binding.dispose();
    return {
      started: false,
      reason: START_REFUSALS.includes(opened.refused)
        ? opened.refused
        : 'runtime-dir-unsafe',
    };
  }
  const dir = opened.handle;
  const name = nameOf(rootDir, outDir);
  const files = {
    json: `${name}.json`,
    key: `${name}.key`,
    sock: `${name}.sock`,
  };
  const sessionId = binding.sessionId;
  const sockets = new Set();
  // Every accepted socket, refused ones included: `close()` destroys them all,
  // so a refused peer that never closes cannot hold `server.close()` open.
  const accepted = new Set();
  let closing = false;
  let server = null;
  const key = newKey();

  const owner = {
    // Synchronous, for `process` exit: only this owner's own entries.
    removeEntries() {
      for (const file of [files.json, files.key, files.sock]) {
        try {
          dir.remove(file);
        } catch {
          /* best effort at exit */
        }
      }
    },
  };

  function onConnection(socket) {
    if (closing) {
      socket.destroy();
      return;
    }
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    if (sockets.size >= CONNECTION_LIMIT) {
      // A refused peer cannot hold the socket: drain what it sends, and
      // destroy the socket once the refusal is flushed.
      socket.on('error', () => socket.destroy());
      socket.resume();
      socket.end(
        encodeFrame({
          t: 'error',
          seq: null,
          outcome: 'owner-required',
          reason: 'owner-busy',
        }),
        () => socket.destroy(),
      );
      return;
    }
    sockets.add(socket);
    const controller = new AbortController();
    const sn = nonce();
    let state = 'hello';
    let cn = null;
    let nextSeq = 1;
    let capability = null;
    const timer = setTimeout(() => {
      if (state !== 'ready') socket.destroy();
    }, HANDSHAKE_DEADLINE_MS);
    socket.once('close', () => {
      sockets.delete(socket);
      clearTimeout(timer);
      controller.abort();
    });
    socket.on('error', () => socket.destroy());
    const fail = (outcome, reason, seq = null) => {
      if (state === 'closed') return;
      state = 'closed';
      consumer.stop();
      controller.abort();
      // Flushed, then destroyed: a failed peer frees its slot at once.
      socket.end(encodeFrame({ t: 'error', seq, outcome, reason }), () =>
        socket.destroy(),
      );
    };
    const handshakeFailure = () =>
      fail(
        'invalid-input',
        state === 'ready' ? 'malformed-frame' : 'malformed-handshake',
      );

    async function onFrame(body) {
      const frame = parseFrame(body);
      if (state === 'hello') {
        if (
          frame?.t === 'hello' &&
          validFrame('hello', frame) &&
          !frame.bridge.includes(1)
        )
          return fail('unsupported-capability', 'protocol-version');
        if (!validFrame('hello', frame)) return handshakeFailure();
        cn = frame.cn;
        state = 'auth';
        socket.write(
          encodeFrame({
            t: 'challenge',
            bridge: 1,
            sn,
            sessionId,
            proof: proof(key, 'server', name, cn, sn, sessionId),
          }),
        );
        return;
      }
      if (state === 'auth') {
        if (!validFrame('auth', frame)) return handshakeFailure();
        if (
          !sameProof(frame.proof, proof(key, 'client', name, cn, sn, sessionId))
        )
          return fail('denied-access', 'authentication-failed');
        if (binding.revoked()) return fail('owner-required', 'owner-closed');
        capability = binding.mintCapability({ grants });
        const current = await binding.dispatch(
          { protocolVersion: 1, operation: 'session.status', input: {} },
          { capability },
        );
        if (current.outcome !== 'success' || socket.destroyed)
          return fail('owner-required', 'owner-closed');
        const ready = {
          t: 'ready',
          identities: current.identities,
          grants: [...grants],
          limits,
        };
        if (!validFrame('ready', ready))
          return fail('owner-required', 'owner-closed');
        state = 'ready';
        clearTimeout(timer);
        socket.write(encodeFrame(ready));
        return;
      }
      if (state !== 'ready') return;
      const keys =
        frame != null && typeof frame === 'object' ? Object.keys(frame) : [];
      if (
        frame == null ||
        typeof frame !== 'object' ||
        Array.isArray(frame) ||
        keys.length !== 3 ||
        frame.t !== 'request' ||
        frame.seq !== nextSeq ||
        frame.request == null ||
        typeof frame.request !== 'object' ||
        Array.isArray(frame.request)
      )
        return fail('invalid-input', 'malformed-frame');
      const seq = nextSeq;
      nextSeq += 1;
      if (binding.revoked()) return fail('owner-required', 'owner-closed', seq);
      const envelope = await binding.dispatch(frame.request, {
        capability,
        signal: controller.signal,
      });
      if (socket.destroyed || state !== 'ready') return;
      // The session closed while the request waited: the agent meets an owner
      // that is gone, not an authority decision (§3.10).
      if (
        binding.revoked() &&
        envelope.outcome === 'denied-access' &&
        envelope.failure?.reason === 'revoked'
      )
        return fail('owner-required', 'owner-closed', seq);
      if (envelope.protocol !== AGENT_PROTOCOL)
        return fail('owner-required', 'owner-closed', seq);
      socket.write(encodeFrame({ t: 'response', seq, envelope }));
    }

    const consumer = consumeFrames(socket, {
      ceiling: () =>
        state === 'hello'
          ? CEILINGS.hello
          : state === 'auth'
            ? CEILINGS.auth
            : requestCeiling(limits.maxRequestBytes),
      onFrame,
      onViolation: (reason) =>
        reason === 'malformed-frame'
          ? handshakeFailure()
          : fail('invalid-input', reason),
    });
  }

  try {
    for (const file of [files.json, files.key, files.sock]) dir.remove(file);
    dir.write(files.key, key.text);
    dir.recheck();
    server = net.createServer(onConnection);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(dir.path(files.sock), resolve);
    });
    // The bound socket's mode follows the umask: set and verify it (R1).
    dir.secureSocket(files.sock);
    // Before advertising, the owner checks it can use what it created: it
    // reads its key back and connects to its own endpoint.
    if (
      dir.read(files.key, CEILINGS.key).bytes?.toString('latin1') !== key.text
    )
      throw unusable();
    await selfConnect(dir.path(files.sock));
    const descriptorText = JSON.stringify(
      buildDescriptor({
        projectId: binding.projectId,
        sessionId,
        rootDir,
        outDir,
        keyText: key.text,
        host,
      }),
    );
    dir.write(files.json, descriptorText);
    if (
      dir.read(files.json, CEILINGS.descriptor).bytes?.toString('utf8') !==
      descriptorText
    )
      throw unusable();
  } catch (error) {
    if (server != null) await new Promise((resolve) => server.close(resolve));
    owner.removeEntries();
    dir.close();
    binding.dispose();
    return {
      started: false,
      reason:
        error?.code === 'runtime-dir-overlap'
          ? 'runtime-dir-overlap'
          : 'runtime-dir-unsafe',
    };
  }

  live.add(owner);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.on('exit', removeLiveEntries);
  }

  let closePromise = null;
  return Object.freeze({
    started: true,
    name,
    sessionId,
    async close() {
      if (closePromise != null) return closePromise;
      closing = true;
      closePromise = (async () => {
        live.delete(owner);
        dir.remove(files.json);
        dir.remove(files.key);
        for (const socket of accepted) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        dir.remove(files.sock);
        dir.close();
        binding.dispose();
      })();
      return closePromise;
    },
  });
}
