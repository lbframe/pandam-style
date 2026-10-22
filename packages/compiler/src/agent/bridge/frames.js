/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { OUTCOMES } from '../../protocol/envelope.js';
import { GRANTS } from '../capabilities.js';
import { maxJsonBytes, validateSchema } from '../schema.js';
import {
  arr,
  BOUNDS,
  enumOf,
  IDENTITIES_OUTPUT,
  int,
  MAX_SAFE,
  nullable,
  obj,
  str,
} from '../schemas.js';

/**
 * AG-02.1 bridge frames (§3.5, §3.6).
 *
 * A frame is a 4-byte big-endian length and that many bytes of UTF-8 JSON.
 * Every frame type has a closed schema built from the AG-01.1 fragments and
 * source bounds, and every ceiling is `maxJsonBytes` of that schema (R1). No
 * size in this module is a free constant: a wrapper that carries a payload with
 * its own bound is measured with the payload as `null`, then that bound is
 * added. The policies below (deadline, connections) are not message sizes.
 */

export const BRIDGE_VERSION = 1;
/** Bridge version 1 bound on the limits an owner may announce. */
export const LIMIT_CAP = 16777216;
export const HANDSHAKE_DEADLINE_MS = 2000;
/** The client's wait for a handshake; a silent endpoint is unreachable. */
export const CLIENT_HANDSHAKE_TIMEOUT_MS = 5000;
export const CONNECTION_LIMIT = 32;

export const HOSTS = Object.freeze([
  'vite',
  'rsbuild',
  'next-webpack',
  'next-turbopack',
  'test',
]);

/** The reasons an owner may put in an error frame. */
export const OWNER_FRAME_REASONS = Object.freeze([
  'malformed-handshake',
  'malformed-frame',
  'request-too-large',
  'pipelined-request',
  'protocol-version',
  'authentication-failed',
  'owner-busy',
  'owner-closed',
]);

/** Source bounds of descriptor fields that no AG-01.1 bound covers. */
export const DESCRIPTOR_BOUNDS = Object.freeze({
  compilerVersion: 64,
  // `Date.prototype.toISOString()` for years 0000-9999.
  createdAt: 24,
  // Linux `pid_max` cannot exceed 2^22.
  pid: 4194304,
  // `<16 hex>-<16 hex>.sock`.
  endpoint: 38,
  keyId: 16,
  // 32 key bytes in base64.
  key: 44,
});

const BASE64_32 = { type: 'string', minLength: 44, maxLength: 44 };
const UUID = { type: 'string', format: 'uuid' };
const VERSIONS = arr(int(1, 1024), 16);
const fixed = (length) => ({
  type: 'string',
  minLength: length,
  maxLength: length,
});

export const FRAME_SCHEMAS = Object.freeze({
  hello: obj({ t: { const: 'hello' }, bridge: VERSIONS, cn: BASE64_32 }),
  challenge: obj({
    t: { const: 'challenge' },
    bridge: int(1, 1024),
    sn: BASE64_32,
    sessionId: UUID,
    proof: BASE64_32,
  }),
  auth: obj({ t: { const: 'auth' }, proof: BASE64_32 }),
  ready: obj({
    t: { const: 'ready' },
    identities: IDENTITIES_OUTPUT,
    grants: arr(enumOf(GRANTS), GRANTS.length),
    limits: obj({
      maxRequestBytes: int(1, LIMIT_CAP),
      compact: int(1, LIMIT_CAP),
      detail: int(1, LIMIT_CAP),
    }),
  }),
  error: obj({
    t: { const: 'error' },
    seq: nullable(int(1, MAX_SAFE)),
    outcome: enumOf(OUTCOMES.filter((outcome) => outcome !== 'success')),
    reason: enumOf(OWNER_FRAME_REASONS),
  }),
  descriptor: obj({
    format: { const: 'pandamstyle-owner-descriptor' },
    formatVersion: { const: 1 },
    bridgeVersions: VERSIONS,
    protocolVersions: VERSIONS,
    projectId: str(BOUNDS.projectId),
    sessionId: UUID,
    rootDir: str(BOUNDS.rootDir),
    outDir: str(BOUNDS.outDir),
    endpoint: fixed(DESCRIPTOR_BOUNDS.endpoint),
    keyId: fixed(DESCRIPTOR_BOUNDS.keyId),
    owner: obj({
      kind: { const: 'attached' },
      host: enumOf(HOSTS),
      pid: int(1, DESCRIPTOR_BOUNDS.pid),
    }),
    compilerVersion: nullable(str(DESCRIPTOR_BOUNDS.compilerVersion)),
    createdAt: fixed(DESCRIPTOR_BOUNDS.createdAt),
  }),
});

const wrapper = (t, key) =>
  maxJsonBytes(
    obj({ t: { const: t }, seq: int(1, MAX_SAFE), [key]: { type: 'null' } }),
  ) - 4;

function derive() {
  const ceilings = {
    hello: maxJsonBytes(FRAME_SCHEMAS.hello),
    challenge: maxJsonBytes(FRAME_SCHEMAS.challenge),
    auth: maxJsonBytes(FRAME_SCHEMAS.auth),
    ready: maxJsonBytes(FRAME_SCHEMAS.ready),
    error: maxJsonBytes(FRAME_SCHEMAS.error),
    descriptor: maxJsonBytes(FRAME_SCHEMAS.descriptor),
    key: DESCRIPTOR_BOUNDS.key,
    requestWrapper: wrapper('request', 'request'),
    responseWrapper: wrapper('response', 'envelope'),
  };
  for (const [name, value] of Object.entries(ceilings)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new TypeError(`pandamstyle owner bridge: ${name} has no ceiling`);
  }
  return Object.freeze(ceilings);
}

/** Computed once, at module load (I13). */
export const CEILINGS = derive();

export const requestCeiling = (maxRequestBytes) =>
  CEILINGS.requestWrapper + maxRequestBytes;
export const responseCeiling = (maxResponseBytes) =>
  CEILINGS.responseWrapper + maxResponseBytes;

export function validFrame(name, value) {
  return validateSchema(FRAME_SCHEMAS[name], value) == null;
}

export function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * Consumes a socket's frames one at a time (R3, I14). While a frame is being
 * handled, any byte is `pipelined-request`. Otherwise only the bytes the
 * current frame still needs are copied out of a chunk, so at most
 * `4 + ceiling()` bytes are retained; a chunk holding more than the current
 * frame is `pipelined-request`, a header over the ceiling `request-too-large`.
 * The connection accepts bytes again only after `onFrame` settled.
 */
export function consumeFrames(socket, { ceiling, onFrame, onViolation }) {
  let buffer = Buffer.alloc(0);
  let length = -1;
  let busy = false;
  let stopped = false;
  const stats = { maxRetained: 0 };
  const violate = (reason) => {
    if (stopped) return;
    stopped = true;
    buffer = Buffer.alloc(0);
    onViolation(reason);
  };
  socket.on('data', (chunk) => {
    if (stopped || socket.destroyed) return;
    if (busy) return violate('pipelined-request');
    let offset = 0;
    if (length < 0) {
      const take = Math.min(4 - buffer.length, chunk.length);
      buffer = Buffer.concat([buffer, chunk.subarray(0, take)]);
      offset = take;
      if (buffer.length < 4) return;
      length = buffer.readUInt32BE(0);
      if (length > ceiling()) return violate('request-too-large');
    }
    const need = 4 + length - buffer.length;
    if (chunk.length - offset > need) return violate('pipelined-request');
    buffer = Buffer.concat([buffer, chunk.subarray(offset)]);
    stats.maxRetained = Math.max(stats.maxRetained, buffer.length);
    if (buffer.length < 4 + length) return;
    const body = buffer.subarray(4);
    buffer = Buffer.alloc(0);
    length = -1;
    busy = true;
    Promise.resolve()
      .then(() => onFrame(body))
      .catch(() => violate('malformed-frame'))
      .finally(() => {
        busy = false;
      });
  });
  return {
    stats,
    stop() {
      stopped = true;
    },
  };
}

/** Parses a frame body; `undefined` when it is not JSON. */
export function parseFrame(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}
