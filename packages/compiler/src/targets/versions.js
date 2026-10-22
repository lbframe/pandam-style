/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Browser version values, exactly as BCD records them.
 *
 * A BCD `version_added` is a release string ("15.4"), a ranged release
 * ("≤18": added at the latest in 18, exact version unknown), "preview",
 * `true` (supported, version unknown), `false` (not supported) or `null`
 * (no data). Each form is kept distinct: collapsing a ranged or unknown value
 * into a number would invent precision the data does not have.
 */

export function parseVersion(value) {
  if (value === false) return { kind: 'false' };
  if (value === true) return { kind: 'true' };
  if (value == null) return { kind: 'null' };
  if (value === 'preview') return { kind: 'preview' };
  if (typeof value !== 'string') return { kind: 'null' };
  // Escaped: one non-Latin-1 character makes V8 hold the whole bundle source
  // as a two-byte string, doubling what the loaded compiler keeps.
  const ranged = value.startsWith('\u2264');
  const text = ranged ? value.slice(1) : value;
  if (!/^\d+(\.\d+)*$/.test(text)) return { kind: 'null' };
  return {
    kind: ranged ? 'ranged' : 'release',
    parts: text.split('.').map(Number),
  };
}

/** Numeric comparison of two dotted release strings or part arrays. */
export function compareVersions(a, b) {
  const pa = Array.isArray(a) ? a : String(a).split('.').map(Number);
  const pb = Array.isArray(b) ? b : String(b).split('.').map(Number);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function isReleaseString(value) {
  return typeof value === 'string' && /^\d+(\.\d+)*$/.test(value);
}
