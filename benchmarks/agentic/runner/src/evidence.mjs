/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Evidence archives (DESIGN.md section 6). The oracle-relevant set is every
// path except the oracles' own ALWAYS_IGNORED globs, read from the locked
// harness source (never duplicated here). Archives never follow links and
// never read special files; links are stored with their target text.
// Re-grading is `exact` only when the stored set equals the graded set.

import fs from 'node:fs';
import path from 'node:path';
import { compileGlobs } from '../../src/glob.mjs';
import { toPosix } from '../../src/fs-tree.mjs';
import { CORPUS_ROOT, sha256, writeJson } from './util.mjs';

export const EVIDENCE_VERSION = 'pms-agentic-evidence/v1';
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

let cachedIgnored = null;

/** ALWAYS_IGNORED of the locked oracles (src/oracles/evaluate.mjs). */
export function oracleIgnoredGlobs() {
  if (cachedIgnored != null) return cachedIgnored;
  const text = fs.readFileSync(
    path.join(CORPUS_ROOT, 'src/oracles/evaluate.mjs'),
    'utf8',
  );
  const m = /const ALWAYS_IGNORED = (\[[^\]]*\]);/.exec(text);
  if (m == null)
    throw new Error('evaluate.mjs no longer declares ALWAYS_IGNORED');
  cachedIgnored = JSON.parse(m[1].replace(/'/g, '"'));
  return cachedIgnored;
}

function walk(root, excluded, visit) {
  function rec(rel) {
    const abs = rel === '' ? root : path.join(root, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (excluded.match(childRel) != null) continue;
      const st = fs.lstatSync(path.join(root, childRel));
      if (st.isDirectory()) {
        if (excluded.match(`${childRel}/`) != null) continue;
        visit(childRel, st, 'dir');
        rec(childRel);
      } else if (st.isSymbolicLink()) visit(childRel, st, 'symlink');
      else if (st.isFile()) visit(childRel, st, 'file');
      else visit(childRel, st, 'special');
    }
  }
  rec('');
}

/**
 * Archives `root` into `dest` (manifest.json + blobs/). `secrets` are byte
 * strings to redact from stored blobs; a redaction changes the stored bytes,
 * so the evidence becomes `redacted`.
 */
export function archiveTree({
  root,
  dest,
  exclude = oracleIgnoredGlobs(),
  maxBytes = DEFAULT_MAX_BYTES,
  secrets = [],
  extraEntries = [],
}) {
  const excluded = compileGlobs(exclude);
  const entries = [];
  const affected = [];
  let bytes = 0;
  let overflow = false;
  fs.mkdirSync(path.join(dest, 'blobs'), { recursive: true });
  walk(root, excluded, (rel, st, type) => {
    const entry = { path: rel, type, mode: st.mode & 0o777 };
    if (type === 'symlink')
      entry.target = fs.readlinkSync(path.join(root, rel));
    if (type === 'file') {
      entry.size = st.size;
      bytes += st.size;
      if (bytes > maxBytes) {
        overflow = true;
        entry.stored = false;
      } else {
        let data = fs.readFileSync(path.join(root, rel));
        entry.sha256 = sha256(data);
        const redacted = redactBytes(data, secrets);
        if (redacted !== data) {
          affected.push(rel);
          data = redacted;
          entry.storedSha256 = sha256(data);
        }
        const blob = entry.storedSha256 ?? entry.sha256;
        const blobPath = path.join(dest, 'blobs', blob);
        if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, data);
        entry.stored = true;
      }
    }
    entries.push(entry);
  });
  // Entries of the original tree a staging copy does not reproduce: special
  // files (metadata only) and files beyond the staging bound (unstored).
  for (const e of extraEntries) {
    if (e.type === 'special')
      entries.push({ path: e.path, type: 'special', mode: e.mode });
    else if (e.type === 'file') {
      entries.push({
        path: e.path,
        type: 'file',
        mode: e.mode,
        size: e.size,
        stored: false,
      });
      overflow = true;
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const completeness = overflow
    ? 'incomplete'
    : affected.length > 0
      ? 'redacted'
      : 'complete';
  const manifest = {
    version: EVIDENCE_VERSION,
    exclude,
    entries,
    bytes,
    maxBytes,
    completeness,
    affectedPaths: affected,
    setDigest: setDigest(entries),
  };
  writeJson(path.join(dest, 'manifest.json'), manifest);
  return manifest;
}

function redactBytes(data, secrets) {
  let out = data;
  for (const s of secrets) {
    const needle = Buffer.from(s);
    if (needle.length === 0) continue;
    let idx = out.indexOf(needle);
    if (idx === -1) continue;
    if (out === data) out = Buffer.from(data);
    while (idx !== -1) {
      out.fill(0x2a, idx, idx + needle.length);
      idx = out.indexOf(needle, idx + needle.length);
    }
  }
  return out;
}

/** Digest of the graded content: paths, types, link targets and bytes. */
export function setDigest(entries) {
  return sha256(
    entries
      .map((e) =>
        e.type === 'file'
          ? `${e.path}\0file\0${e.sha256 ?? 'unstored'}\n`
          : e.type === 'symlink'
            ? `${e.path}\0symlink\0${e.target}\n`
            : `${e.path}\0${e.type}\n`,
      )
      .join(''),
  );
}

/**
 * Extracts an archive into `dest` (which must not exist or be empty).
 * Links are recreated as links; special files are not recreated.
 */
export function extractArchive({ archive, dest }) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8'),
  );
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length > 0)
    throw new Error(`refusing to extract into non-empty ${dest}`);
  for (const e of manifest.entries) {
    const abs = path.join(dest, e.path);
    if (!path.resolve(abs).startsWith(path.resolve(dest) + path.sep))
      throw new Error(`archive path escapes: ${e.path}`);
    if (e.type === 'dir') fs.mkdirSync(abs, { recursive: true });
    else if (e.type === 'symlink') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(e.target, abs);
    } else if (e.type === 'file' && e.stored) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(
        path.join(archive, 'blobs', e.storedSha256 ?? e.sha256),
        abs,
      );
      fs.chmodSync(abs, e.mode);
    }
  }
  return manifest;
}

/** Replay exactness (section 6.3). */
export function replayExactness(manifest) {
  return manifest.completeness === 'complete'
    ? { exact: true, label: 'exact' }
    : {
        exact: false,
        label: 'non-exact',
        reason: manifest.completeness,
        affectedPaths: manifest.affectedPaths,
      };
}

// The live-workspace operations (delta samples, node_modules state,
// staging) are in workspace.mjs, confined beneath a directory handle.

export { toPosix };
