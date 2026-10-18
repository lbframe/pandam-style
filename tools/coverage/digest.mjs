/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Redaction digests. Authored corpus data uses plain SHA-256. Consumer data
// uses HMAC-SHA256 with a private key kept outside the repository, so a short
// or guessable removed value (a font name, a relative asset path) cannot be
// recovered by hashing candidates. Only the key's fingerprint is published.

import crypto from 'node:crypto';

export function makeDigester(key = null) {
  if (key == null) {
    return {
      scheme: 'sha256',
      of: (text) => crypto.createHash('sha256').update(text).digest('hex'),
    };
  }
  if (key.length < 32)
    throw new Error('the redaction key needs 32 bytes or more');
  return {
    scheme: 'hmac-sha256',
    keyFingerprint: crypto.createHash('sha256').update(key).digest('hex'),
    of: (text) => crypto.createHmac('sha256', key).update(text).digest('hex'),
  };
}

export const PUBLIC_DIGESTER = makeDigester(null);

// Matches one placeholder of either scheme.
export const PLACEHOLDER_SOURCE =
  '<redacted:[a-z-]+:(?:hmac-)?sha256:[0-9a-f]{64}>';
