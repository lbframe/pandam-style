/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Small shared helpers of the AG-00.2 runner: canonical JSON, digests and
// atomic writes. Nothing here reads agent-controlled trees; see evidence.mjs
// for the no-follow walkers.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const CORPUS_ROOT = path.resolve(RUNNER_ROOT, '..');
export const REPO_ROOT = path.resolve(CORPUS_ROOT, '../..');

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Canonical JSON: object keys sorted, no insignificant whitespace, UTF-8.
 * `undefined` members are dropped as JSON.stringify does; non-finite numbers
 * are rejected rather than silently becoming null.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error(`canonicalJson: non-finite number ${value}`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function digestJson(value) {
  return sha256(canonicalJson(value));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Writes through a temporary file in the same directory, then renames. */
export function writeFileAtomic(file, data, { mode = 0o644 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // Directory fsync is not supported everywhere; the rename is still atomic.
  }
}

export function writeJson(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isInside(root, candidate) {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

export function nowIso() {
  return new Date().toISOString();
}

export function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
