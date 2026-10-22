/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import crypto from 'node:crypto';

/**
 * AG-02.1 handshake proofs (§3.5). Both nonces and the session identity enter
 * both proofs; the role label separates them, so neither a captured proof nor
 * the owner's own proof reflected back authenticates another connection. The
 * key never leaves this module except as proofs (I4).
 */

const LABEL = 'pandamstyle-owner-bridge/1';

export function newKey() {
  const bytes = crypto.randomBytes(32);
  return { bytes, text: bytes.toString('base64') };
}

export const nonce = () => crypto.randomBytes(32).toString('base64');

export function proof(key, role, name, cn, sn, sessionId) {
  return crypto
    .createHmac('sha256', key.bytes)
    .update(`${LABEL}|${role}|${name}|${cn}|${sn}|${sessionId}`)
    .digest('base64');
}

export function sameProof(supplied, expected) {
  if (typeof supplied !== 'string' || supplied.length !== expected.length)
    return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
