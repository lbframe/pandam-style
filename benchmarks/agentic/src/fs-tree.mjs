/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compileGlobs } from './glob.mjs';

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Lists regular files below `root` as sorted POSIX relative paths. Symbolic
 * links are reported (never followed) so a workspace cannot smuggle content
 * from outside its root into a digest or a diff.
 */
export function listFiles(root, { exclude = [] } = {}) {
  const excluded = compileGlobs(exclude);
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (excluded.match(rel) != null) continue;
      if (entry.isDirectory()) {
        if (excluded.match(`${rel}/`) != null) continue;
        walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(rel);
      }
    }
  }
  walk(root);
  return out.sort();
}

export function fileDigest(abs) {
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(abs)}`;
  return sha256(fs.readFileSync(abs));
}

/** Map of relative path to content digest. */
export function snapshotTree(root, options) {
  const files = {};
  for (const rel of listFiles(root, options)) {
    files[rel] = fileDigest(path.join(root, rel));
  }
  return files;
}

/**
 * Canonical digest of a directory: SHA-256 over sorted `path\0sha256\n`
 * lines. It depends only on relative paths and bytes, never on timestamps,
 * permissions or the absolute location of the tree.
 */
export function treeDigest(root, options) {
  const files = snapshotTree(root, options);
  const lines = Object.keys(files)
    .sort()
    .map((rel) => `${rel}\0${files[rel]}\n`)
    .join('');
  return sha256(lines);
}

export function diffSnapshots(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [rel, digest] of Object.entries(after)) {
    if (!Object.hasOwn(before, rel)) added.push(rel);
    else if (before[rel] !== digest) modified.push(rel);
  }
  for (const rel of Object.keys(before)) {
    if (!Object.hasOwn(after, rel)) deleted.push(rel);
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
  };
}

function listDirs(root, exclude) {
  const excluded = compileGlobs(exclude);
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, abs));
      if (excluded.match(rel) != null || excluded.match(`${rel}/`) != null)
        continue;
      out.push(rel);
      walk(abs);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out;
}

export function copyTree(
  src,
  dest,
  { exclude = [], includeEmptyDirs = false, skipSymlinks = false } = {},
) {
  if (includeEmptyDirs) {
    for (const rel of listDirs(src, exclude))
      fs.mkdirSync(path.join(dest, rel), { recursive: true });
  }
  for (const rel of listFiles(src, { exclude })) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    const stat = fs.lstatSync(from);
    // Oracle scratch copies never follow agent-created links out of the tree.
    if (stat.isSymbolicLink() && skipSymlinks) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
