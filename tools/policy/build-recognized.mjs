/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.1 recognized-property catalog generator.
//
//   node tools/policy/build-recognized.mjs [--check]
//
// Writes packages/compiler/src/design-system/policy/recognized.v1.json from
// the CE-00.1 registry (docs/research/core-evolution-registry.v1.json): one row
// per registry entry, keyed by its authoring key (the `camel` expression of
// tools/coverage/classify.mjs, so `-webkit-app-region` is `WebkitAppRegion`).
//
// Recognition authorizes nothing. The compiler reads this file only to choose
// the rule of a PMS_UNSUPPORTED_PROPERTY diagnostic; admission comes from the
// descriptors in policy/descriptors.js.
//
// The output is compiler-owned generated data: regenerate it, never edit it.
// `--check` regenerates in memory and fails unless the committed file is byte
// identical.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
export const OUT = path.join(
  REPO,
  'packages/compiler/src/design-system/policy/recognized.v1.json',
);
const REGISTRY = 'docs/research/core-evolution-registry.v1.json';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export const camel = (property) =>
  property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function buildRecognized() {
  const text = fs.readFileSync(path.join(REPO, REGISTRY), 'utf8');
  const registry = JSON.parse(text);
  const entries = {};
  for (const entry of registry.entries) {
    const key = camel(entry.name);
    if (Object.hasOwn(entries, key)) {
      throw new Error(
        `${entry.name} and ${entries[key].css} share the authoring key ${key}`,
      );
    }
    entries[key] = {
      css: entry.name,
      disposition: entry.disposition,
      ...(entry.subkind == null ? {} : { subkind: entry.subkind }),
      // A normalized alias names its target as `canonical`; other
      // dispositions name a replacement, when they have one.
      ...((entry.replacement ?? entry.canonical) == null
        ? {}
        : { replacement: entry.replacement ?? entry.canonical }),
    };
  }
  const keys = Object.keys(entries).sort();
  if (keys.length !== registry.entries.length) {
    throw new Error('the registry entries do not map one to one onto keys');
  }
  return {
    kind: 'pandamstyle-recognized-properties',
    schemaVersion: 1,
    source: {
      path: REGISTRY,
      sha256: `sha256:${sha256(text)}`,
      registryVersion: registry.registryVersion,
    },
    count: keys.length,
    entries: Object.fromEntries(keys.map((key) => [key, entries[key]])),
  };
}

export function serializeRecognized(data) {
  return JSON.stringify(data) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = serializeRecognized(buildRecognized());
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (committed !== text) {
      process.stderr.write(
        `recognized catalog differs from a regeneration: committed ${sha256(committed)}, regenerated ${sha256(text)}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`recognized catalog reproduces: ${sha256(text)}\n`);
    }
  } else {
    fs.writeFileSync(OUT, text);
    process.stdout.write(
      `wrote ${path.relative(REPO, OUT)} ${sha256(text)} (${text.length} bytes)\n`,
    );
  }
}
