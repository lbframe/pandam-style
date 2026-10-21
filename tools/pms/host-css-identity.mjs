/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.2 (AC3, CE-01.2-T3): a host's delivered CSS against the compiler's
// canonical `styles.css`.
//
// The canonical bytes are the only input of the canonical digests and of the
// source map. A host's delivered CSS must be declaration-equivalent to them
// (css-equivalence.cjs): minification passes, a host that drops, adds,
// merges, reorders or rewrites declarations fails. The host's own source maps
// are the host's concern.
//
//   hostCssIdentity({ host, mode, canonical, assets: [{ file, content }] })
//
// `assets` are the CSS assets the host delivers for the stylesheet (the ones
// its HTML or entry loads), compared together in load order. The
// qualification scripts record the result in their reports (`cssIdentity`);
// the CLI checks recorded results:
//
//   node tools/pms/host-css-identity.mjs <report.json>...

import crypto from 'node:crypto';
import fs from 'node:fs';
import cssEquivalence from './css-equivalence.cjs';

export const CSS_IDENTITY_KIND = 'pandamstyle-host-css-identity';

const sha256 = (text) =>
  `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

/** The identity record of one host mode's delivered CSS. */
export function hostCssIdentity({ host, mode, canonical, assets }) {
  if (typeof canonical !== 'string' || canonical.length === 0) {
    throw new Error(`${host}: no canonical styles.css to compare`);
  }
  const rows = assets.map(({ file, content }) => ({
    file,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, 'utf8'),
  }));
  const delivered = assets.map(({ content }) => content).join('\n');
  const identical = assets.length === 1 && assets[0].content === canonical;
  const equivalence =
    assets.length === 0
      ? { equivalent: false, rules: null, difference: 'no delivered CSS asset' }
      : cssEquivalence.declarationEquivalence(canonical, delivered);
  // Mutation guard on the real delivered CSS: without its first
  // `-webkit-user-select` declaration it must be rejected.
  let mutation = null;
  const pair = /-webkit-user-select\s*:[^;}]*;/;
  if (equivalence.equivalent && pair.test(delivered)) {
    mutation = {
      dropped: '-webkit-user-select',
      rejected: !cssEquivalence.declarationEquivalence(
        canonical,
        delivered.replace(pair, ''),
      ).equivalent,
    };
  }
  return {
    kind: CSS_IDENTITY_KIND,
    schemaVersion: 2,
    host,
    mode,
    canonical: {
      sha256: sha256(canonical),
      bytes: Buffer.byteLength(canonical, 'utf8'),
    },
    assets: rows,
    rules: equivalence.rules,
    status: identical
      ? 'canonical'
      : equivalence.equivalent
        ? 'declaration-equivalent'
        : 'non-equivalent',
    mutation,
    ...(equivalence.equivalent ? {} : { difference: equivalence.difference }),
  };
}

/** Problems of a recorded identity; an empty list means it passes. */
export function cssIdentityProblems(record) {
  if (record == null || record.kind !== CSS_IDENTITY_KIND) {
    return ['no css identity record'];
  }
  if (record.mutation != null && record.mutation.rejected !== true) {
    return [
      `${record.host} ${record.mode}: dropping ${record.mutation.dropped} from the delivered CSS was not rejected`,
    ];
  }
  if (
    record.status === 'canonical' ||
    record.status === 'declaration-equivalent'
  ) {
    return [];
  }
  return [
    `${record.host} ${record.mode}: the delivered CSS is not declaration-equivalent to the canonical styles.css (${record.canonical.sha256}): ${JSON.stringify(record.difference)}`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = [];
  for (const file of process.argv.slice(2)) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')).cssIdentity;
    problems.push(...cssIdentityProblems(record));
    process.stdout.write(
      `${record?.host ?? file} ${record?.mode ?? ''}: ${record?.status ?? 'missing'}\n`,
    );
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  }
}
