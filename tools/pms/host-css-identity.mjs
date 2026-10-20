/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.2 (AC3, CE-01.2-T3): byte identity of a host's final CSS asset with
// the compiler's canonical `styles.css`.
//
// The canonical identity is the compiler's `styles.css` bytes; target facts
// attach only to them. A host whose production CSS asset is not
// byte-identical is either a recorded known non-canonical host mode with its
// owning issue, or a failure.
//
//   hostCssIdentity({ host, mode, canonical, assets: [{ file, content }] })
//
// `assets` are the CSS assets the host delivers for the stylesheet: the ones
// its HTML or entry loads, not only a copy it also writes.
//
// The qualification scripts record the result in their reports
// (`cssIdentity`). The CLI checks recorded results:
//
//   node tools/pms/host-css-identity.mjs <report.json>...

import crypto from 'node:crypto';
import fs from 'node:fs';

export const CSS_IDENTITY_KIND = 'pandamstyle-host-css-identity';

/**
 * Host modes known to rewrite the canonical bytes, with their owner. A host
 * mode listed here is reported, not repaired, by CE-01.2.
 */
export const KNOWN_NON_CANONICAL = Object.freeze({
  'next:webpack-production': Object.freeze({
    task: 'CE-13.1',
    issue: 78,
    observed:
      'Next 16.3.8 (webpack production) imports styles.css from the root layout into its CSS pipeline and emits a minified .next/static/css asset: the identity header comment, whitespace and final semicolons are removed and selector lists are reordered. In the CE-01.2 observation rule order and declarations, including the transform pair, were unchanged.',
  }),
});

const sha256 = (text) =>
  `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

/** The identity record of one host mode's final CSS assets. */
export function hostCssIdentity({ host, mode, canonical, assets }) {
  if (typeof canonical !== 'string' || canonical.length === 0) {
    throw new Error(`${host}: no canonical styles.css to compare`);
  }
  const rows = assets.map(({ file, content }) => ({
    file,
    sha256: sha256(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    identical: content === canonical,
  }));
  // Every asset that delivers the PandamStyle stylesheet must be the
  // canonical member: one rewritten delivered asset makes the mode
  // non-canonical, even if an untouched copy is emitted next to it.
  const identical = rows.length > 0 && rows.every((row) => row.identical);
  const known = KNOWN_NON_CANONICAL[`${host}:${mode}`] ?? null;
  return {
    kind: CSS_IDENTITY_KIND,
    schemaVersion: 1,
    host,
    mode,
    canonical: {
      sha256: sha256(canonical),
      bytes: Buffer.byteLength(canonical, 'utf8'),
    },
    assets: rows,
    status: identical
      ? 'canonical'
      : known != null
        ? 'known-non-canonical'
        : 'non-canonical',
    ...(identical || known == null ? {} : { owner: known }),
  };
}

/** Problems of a recorded identity; an empty list means it passes. */
export function cssIdentityProblems(record) {
  if (record == null || record.kind !== CSS_IDENTITY_KIND) {
    return ['no css identity record'];
  }
  if (record.assets.length === 0) return [`${record.host}: no CSS asset`];
  if (record.status === 'canonical') return [];
  if (record.status === 'known-non-canonical') return [];
  return [
    `${record.host} ${record.mode}: the final CSS asset differs from the canonical styles.css (${record.canonical.sha256})`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = [];
  for (const file of process.argv.slice(2)) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8')).cssIdentity;
    const found = cssIdentityProblems(record);
    problems.push(...found);
    process.stdout.write(
      `${record?.host ?? file} ${record?.mode ?? ''}: ${record?.status ?? 'missing'}` +
        (record?.owner == null
          ? ''
          : ` (owner ${record.owner.task}, #${record.owner.issue})`) +
        '\n',
    );
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exitCode = 1;
  }
}
