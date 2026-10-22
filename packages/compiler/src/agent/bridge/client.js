/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import net from 'node:net';
import path from 'node:path';
import { Codes } from '../../protocol/diagnostics.js';
import {
  AgentCodes,
  AgentError,
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
} from '../../protocol/envelope.js';
import { REGISTRY } from '../registry.js';
import { stringBytes } from '../schema.js';
import {
  keyIdOf,
  readDescriptor,
  readKey,
  rootPrefixOf,
} from './descriptor.js';
import {
  BRIDGE_VERSION,
  CEILINGS,
  CLIENT_HANDSHAKE_TIMEOUT_MS,
  consumeFrames,
  encodeFrame,
  parseFrame,
  requestCeiling,
  responseCeiling,
  validFrame,
} from './frames.js';
import { nonce, proof, sameProof } from './handshake.js';
import {
  anchoringAvailable,
  canonicalPath,
  openRuntimeDir,
  runtimeDirCandidates,
} from './runtime-dir.js';

/**
 * AG-02.1 client side (§3.4, §3.5, §3.9). The client never connects to a path
 * taken from a descriptor: it derives `N.sock` (I6). It sends a proof only
 * after the endpoint proved the key (I5). This module imports no session code
 * and no lease: a failed attach cannot create a writer (I9).
 */

const DESCRIPTOR_NAME = /^[0-9a-f]{16}-[0-9a-f]{16}\.json$/;

/** What this client offers and accepts in a negotiation (R2). */
const OFFERED_BRIDGE_VERSIONS = Object.freeze([BRIDGE_VERSION]);
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([AGENT_PROTOCOL_VERSION]);
/** The largest limits this client accepts from an owner: its own. */
const CLIENT_CAPS = Object.freeze({
  maxRequestBytes: REGISTRY.request.maxRequestBytes,
  compact: REGISTRY.views.compact.maxResponseBytes,
  detail: REGISTRY.views.detail.maxResponseBytes,
});

const staleDescriptor = () =>
  new AgentError({
    outcome: 'stale-revision',
    code: Codes.STALE_REVISION,
    reason: 'descriptor-stale',
    stage: 'execution',
  });

const ownerRequired = (reason, context = {}) =>
  new AgentError({
    outcome: 'owner-required',
    code: AgentCodes.OWNER_REQUIRED,
    reason,
    stage: 'execution',
    context,
  });

const protocolError = () =>
  new AgentError({
    outcome: 'internal-error',
    code: AgentCodes.INTERNAL,
    reason: 'owner-protocol-error',
    stage: 'execution',
  });

const unsupported = (reason, capability) =>
  new AgentError({
    outcome: 'unsupported-capability',
    code: AgentCodes.OPERATION_UNSUPPORTED,
    reason,
    stage: 'execution',
    capability,
  });

/** An owner's error frame, as the outcome the agent meets. */
function ownerFrameError(frame) {
  switch (frame.reason) {
    case 'owner-busy':
    case 'owner-closed':
      return ownerRequired(frame.reason);
    case 'authentication-failed':
      return new AgentError({
        outcome: 'denied-access',
        code: AgentCodes.ACCESS_DENIED,
        reason: 'authentication-failed',
        stage: 'execution',
      });
    case 'protocol-version':
      return unsupported('protocol-version', 'protocol-version');
    default:
      // A compliant client never sends a malformed or pipelined frame.
      return protocolError();
  }
}

function ancestors(dir) {
  const out = [dir];
  for (let cursor = dir; path.dirname(cursor) !== cursor; ) {
    cursor = path.dirname(cursor);
    out.push(cursor);
  }
  return out;
}

/**
 * Finds the advertised owners of `projectDir` (§3.9 steps 1–2). Returns the
 * runtime directory handle holding them and the candidates, or throws.
 */
function findOwners({
  projectDir,
  projectId,
  outDir,
  runtimeDir,
  env,
  tmpdir,
}) {
  if (!anchoringAvailable())
    throw unsupported('anchoring-unavailable', 'feature:owner-bridge');
  const project = canonicalPath(projectDir);
  const prefixes = ancestors(project).map(rootPrefixOf);
  const wantedOutDir =
    outDir == null ? null : canonicalPath(path.resolve(project, outDir));
  let unusable = false;
  for (const candidate of runtimeDir == null
    ? runtimeDirCandidates({ env, tmpdir })
    : [runtimeDir]) {
    const opened = openRuntimeDir(candidate, {
      create: false,
      protectedRoots: [project],
    });
    if (opened.refused === 'anchoring-unavailable')
      throw unsupported('anchoring-unavailable', 'feature:owner-bridge');
    if (opened.refused === 'runtime-dir-missing') continue;
    if (opened.refused != null) {
      unusable = true;
      continue;
    }
    const handle = opened.handle;
    const names = handle.list(
      (entry) =>
        DESCRIPTOR_NAME.test(entry) &&
        prefixes.some((prefix) => entry.startsWith(prefix)),
    );
    if (names.length === 0) {
      handle.close();
      continue;
    }
    const valid = [];
    let invalid = 0;
    for (const file of names) {
      const name = file.slice(0, -'.json'.length);
      const read = readDescriptor(handle, name);
      if (read.descriptor == null) {
        if (read.problem === 'descriptor-invalid') invalid += 1;
        continue;
      }
      const d = read.descriptor;
      if (projectId != null && d.projectId !== projectId) continue;
      if (wantedOutDir != null && d.outDir !== wantedOutDir) continue;
      valid.push({ name, descriptor: d });
    }
    if (valid.length === 0) {
      handle.close();
      throw ownerRequired(invalid > 0 ? 'descriptor-invalid' : 'owner-absent');
    }
    if (valid.length > 1) {
      handle.close();
      throw new AgentError({
        outcome: 'invalid-input',
        code: AgentCodes.INVALID_REQUEST,
        reason: 'owner-ambiguous',
        stage: 'execution',
        context: {
          total: valid.length,
          // Unverified descriptor data, bounded: choose one with `outDir`.
          outDirs: valid
            .slice(0, 8)
            .map(({ descriptor }) => path.relative(project, descriptor.outDir))
            .filter((value) => stringBytes(value) <= 256),
        },
      });
    }
    return { handle, ...valid[0] };
  }
  throw ownerRequired(unusable ? 'runtime-dir-unusable' : 'owner-absent');
}

/**
 * Connects to the owner of `projectDir` and authenticates both sides. Returns
 * a connection; throws an `AgentError` with the outcome of §3.12.
 */
export async function connectOwner({
  projectDir,
  projectId = null,
  outDir = null,
  protocolVersions = [1],
  runtimeDir = null,
  env = process.env,
  tmpdir,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const found = findOwners({
      projectDir,
      projectId,
      outDir,
      runtimeDir,
      env,
      tmpdir,
    });
    const { handle, name, descriptor } = found;
    // The agent protocol versions both sides may use: requested, advertised
    // and spoken by this client. Every response is checked against them.
    const agreed = SUPPORTED_PROTOCOL_VERSIONS.filter(
      (version) =>
        protocolVersions.includes(version) &&
        descriptor.protocolVersions.includes(version),
    );
    if (
      !descriptor.bridgeVersions.some((version) =>
        OFFERED_BRIDGE_VERSIONS.includes(version),
      ) ||
      agreed.length === 0
    ) {
      handle.close();
      throw unsupported('protocol-version', 'protocol-version');
    }
    const key = readKey(handle, name);
    const stale = key == null || keyIdOf(key.text) !== descriptor.keyId;
    if (stale) {
      handle.close();
      // An owner restarting between its key and its descriptor: re-read once.
      if (attempt === 0) continue;
      if (key == null) throw ownerRequired('owner-unreachable');
      throw staleDescriptor();
    }
    return handshake({ handle, name, descriptor, key, agreed });
  }
}

/**
 * `null` when every value the owner selected or announced in `ready` is one
 * this client offered or accepts, else the error to report (R2).
 */
function readyProblem(frame, descriptor) {
  for (const field of Object.keys(CLIENT_CAPS))
    if (frame.limits[field] > CLIENT_CAPS[field])
      return unsupported('limits', 'limits');
  const { identities } = frame;
  const sessions = [
    identities.sessionId,
    identities.revision?.sessionId,
    identities.lastValidDesignSystem?.derivedFromRevision?.sessionId,
  ];
  const projects = [
    identities.projectId,
    identities.revision?.projectId,
    identities.lastValidDesignSystem?.derivedFromRevision?.projectId,
  ];
  if (
    sessions.some((id) => id != null && id !== descriptor.sessionId) ||
    projects.some((id) => id != null && id !== descriptor.projectId)
  )
    return staleDescriptor();
  return null;
}

function handshake({ handle, name, descriptor, key, agreed }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(handle.path(`${name}.sock`));
    const cn = nonce();
    let state = 'challenge';
    let settled = false;
    let connection = null;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handle.close();
      if (error != null) {
        socket.destroy();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(
      () => settle(ownerRequired('owner-unreachable')),
      CLIENT_HANDSHAKE_TIMEOUT_MS,
    );
    socket.once('connect', () =>
      socket.write(encodeFrame({ t: 'hello', bridge: [BRIDGE_VERSION], cn })),
    );
    socket.once('error', (error) =>
      settle(
        ['ECONNREFUSED', 'ENOENT'].includes(error?.code)
          ? ownerRequired('owner-unreachable')
          : ownerRequired('owner-closed'),
      ),
    );
    socket.once('close', () => {
      settle(ownerRequired('owner-closed'));
      connection?.lost();
    });

    consumeFrames(socket, {
      ceiling: () =>
        Math.max(
          CEILINGS.error,
          state === 'challenge'
            ? CEILINGS.challenge
            : state === 'ready'
              ? CEILINGS.ready
              : (connection?.ceiling() ?? CEILINGS.error),
        ),
      onViolation: () => {
        const error = protocolError();
        if (connection != null) connection.fail(error);
        settle(error);
        socket.destroy();
      },
      onFrame(body) {
        const frame = parseFrame(body);
        if (frame?.t === 'error' && validFrame('error', frame)) {
          const error = ownerFrameError(frame);
          if (connection != null) connection.fail(error);
          settle(error);
          return;
        }
        if (state === 'challenge') {
          // A bridge version this client did not offer: refused before any
          // proof is sent (R2).
          if (
            validFrame('challenge', frame) &&
            !OFFERED_BRIDGE_VERSIONS.includes(frame.bridge)
          ) {
            settle(unsupported('protocol-version', 'protocol-version'));
            return;
          }
          if (
            !validFrame('challenge', frame) ||
            frame.sessionId !== descriptor.sessionId ||
            !sameProof(
              frame.proof,
              proof(key, 'server', name, cn, frame.sn, frame.sessionId),
            )
          ) {
            settle(
              new AgentError({
                outcome: 'denied-access',
                code: AgentCodes.ACCESS_DENIED,
                reason: 'endpoint-unauthenticated',
                stage: 'execution',
              }),
            );
            return;
          }
          state = 'ready';
          socket.write(
            encodeFrame({
              t: 'auth',
              proof: proof(key, 'client', name, cn, frame.sn, frame.sessionId),
            }),
          );
          return;
        }
        if (state === 'ready') {
          if (!validFrame('ready', frame)) {
            settle(protocolError());
            return;
          }
          const problem = readyProblem(frame, descriptor);
          if (problem != null) {
            settle(problem);
            return;
          }
          state = 'open';
          connection = createConnection({
            socket,
            descriptor,
            ready: frame,
            agreed,
          });
          settle(null, connection.api);
          return;
        }
        const received = connection?.receive(frame) ?? 'invalid';
        if (received !== 'delivered') {
          connection?.fail(
            received === 'protocol-version'
              ? unsupported('protocol-version', 'protocol-version')
              : protocolError(),
          );
          socket.destroy();
        }
      },
    });
  });
}

function createConnection({ socket, descriptor, ready, agreed }) {
  let seq = 0;
  let pending = null;
  let closed = false;
  let tail = Promise.resolve();
  const limits = ready.limits;
  const fail = (error) => {
    const current = pending;
    pending = null;
    current?.resolve({ error });
  };
  const send = (request, view) =>
    new Promise((resolve) => {
      if (closed || socket.destroyed) {
        resolve({ error: ownerRequired('owner-closed') });
        return;
      }
      const frame = encodeFrame({ t: 'request', seq: seq + 1, request });
      // The owner's announced bound; an oversized request stays local.
      if (frame.length - 4 > requestCeiling(limits.maxRequestBytes)) {
        resolve({
          error: new AgentError({
            outcome: 'invalid-input',
            code: AgentCodes.INVALID_REQUEST,
            reason: 'request-too-large',
            stage: 'request',
          }),
        });
        return;
      }
      seq += 1;
      pending = { seq, view, resolve };
      socket.write(frame);
    });
  const api = Object.freeze({
    name: descriptor.endpoint.slice(0, -'.sock'.length),
    sessionId: descriptor.sessionId,
    identities: ready.identities,
    grants: ready.grants,
    limits,
    closed: () => closed || socket.destroyed,
    /** One request at a time; concurrent calls queue (§3.6). */
    request(request, { view = 'compact' } = {}) {
      const result = tail.then(() => send(request, view));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    close() {
      closed = true;
      socket.destroy();
    },
  });
  return {
    api,
    ceiling: () =>
      pending == null
        ? CEILINGS.error
        : responseCeiling(
            pending.view === 'detail' ? limits.detail : limits.compact,
          ),
    /**
     * `delivered` for a response to the pending request in an agreed
     * protocol version, `protocol-version` for one in a version that was not
     * agreed (R2), `invalid` for anything else.
     */
    receive(frame) {
      if (
        pending == null ||
        frame == null ||
        typeof frame !== 'object' ||
        frame.t !== 'response' ||
        frame.seq !== pending.seq ||
        frame.envelope?.protocol !== AGENT_PROTOCOL
      )
        return 'invalid';
      if (!agreed.includes(frame.envelope.protocolVersion))
        return 'protocol-version';
      const current = pending;
      pending = null;
      current.resolve({ envelope: frame.envelope });
      return 'delivered';
    },
    fail,
    lost() {
      closed = true;
      fail(ownerRequired('owner-closed'));
    },
  };
}
