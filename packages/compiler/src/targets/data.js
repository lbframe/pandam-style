/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The pinned compat data, loaded once and only when a target is evaluated.
 *
 * The bytes are compiler-owned generated data
 * (`tools/targets/build-compat-data.mjs`): the BCD 8.1.6 statements CE-00.1
 * pins, restricted to what the compiler can emit, and bundled with the
 * compiler. The digest is taken over the exact bytes, so every resolution
 * record names the data it was computed from.
 */

import crypto from 'crypto';
// Resolved by the compiler build: the generated JSON travels as one shared
// asset next to the bundles and this import returns its text.
import compatDataText from 'pandamstyle:compat-data';

let cache = null;

function indexChildren(paths) {
  const children = new Map();
  for (const key of Object.keys(paths)) {
    const cut = key.lastIndexOf('.');
    if (cut === -1) continue;
    const parent = key.slice(0, cut);
    const name = key.slice(cut + 1);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(name);
  }
  return children;
}

function load(text) {
  const raw = JSON.parse(text);
  if (
    raw.kind !== 'pandamstyle-compat-data' ||
    raw.schemaVersion !== 1 ||
    raw.paths == null
  ) {
    throw new Error('pandamstyle: the bundled compat data is not schema 1.');
  }
  const children = indexChildren(raw.paths);
  return Object.freeze({
    sources: raw.sources,
    paths: raw.paths,
    digest:
      'sha256:' + crypto.createHash('sha256').update(text).digest('hex'),
    has: (bcdPath) => Object.hasOwn(raw.paths, bcdPath),
    entry: (bcdPath) => raw.paths[bcdPath] ?? null,
    childrenOf: (bcdPath) => children.get(bcdPath) ?? [],
  });
}

/** The bundled data. */
export function compatData() {
  if (cache == null) cache = load(compatDataText());
  return cache;
}

/** Test seam: the same loader over other bytes, never installed globally. */
export function compatDataFromText(text) {
  return load(text);
}
