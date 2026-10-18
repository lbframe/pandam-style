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

// The finite set of placeholder kinds. A placeholder of any other kind is
// not a placeholder: masking, extraction and validation all use this list.
export const PLACEHOLDER_KINDS = Object.freeze([
  'url',
  'string',
  'email',
  'uri',
  'opaque',
  'non-ascii-text',
  'identifier',
  'at-rule',
  'at-rule-params',
  'params',
  'property',
  'token',
]);

// Matches one placeholder of either scheme.
export const PLACEHOLDER_SOURCE = `<redacted:(?:${PLACEHOLDER_KINDS.join('|')}):(?:hmac-)?sha256:[0-9a-f]{64}>`;

// A keyed (consumer) placeholder, matched as a whole string.
export const KEYED_PLACEHOLDER = new RegExp(
  `^<redacted:(?:${PLACEHOLDER_KINDS.join('|')}):hmac-sha256:[0-9a-f]{64}>$`,
);
