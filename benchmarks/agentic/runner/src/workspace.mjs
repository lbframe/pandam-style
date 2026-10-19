/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Host operations on the agent's workspace (DESIGN.md sections 2.4, 4.2, 4.5,
// 6 and 11.2). The workspace is agent-controlled from the moment the agent
// starts, so every operation goes through safefs: corpus events, delta
// samples, the node_modules state, size sampling, the post-run staging copy
// that grading and archives read, and leak scans. None follows a link inside
// the workspace, none blocks on a special file, all are bounded.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compileGlobs } from '../../src/glob.mjs';
import { oracleIgnoredGlobs } from './evidence.mjs';
import * as safe from './safefs.mjs';

function excluder(globs) {
  const m = compileGlobs(globs);
  return (rel, isDir) =>
    m.match(rel) != null || (isDir && m.match(`${rel}/`) != null);
}

function withRoot(root, fn) {
  const fd = safe.openRoot(root);
  try {
    return fn(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Applies a corpus event's steps beneath the workspace root (the steps of
 * src/materialize.mjs applySteps, confined). Sources are corpus files.
 * `compile` steps are refused before any attempt (capabilities.mjs).
 */
export function applyEventSafe({ taskEntry, eventId, root }) {
  const event = (taskEntry.task.workspace.events ?? []).find(
    (e) => e.id === eventId,
  );
  if (event == null) throw new Error(`Unknown event ${eventId}`);
  return withRoot(root, (fd) => {
    for (const s of event.steps) {
      if (s.step === 'delete') safe.remove(fd, s.path);
      else if (s.step === 'write')
        safe.writeFile(
          fd,
          s.path,
          fs.readFileSync(path.join(taskEntry.dir, s.source)),
        );
      else if (s.step === 'rename') safe.rename(fd, s.path, s.to);
      else if (s.step === 'copy')
        safe.writeFile(fd, s.to, safe.readFile(fd, s.path));
      else if (s.step === 'replace') {
        const text = safe.readFile(fd, s.path).toString('utf8');
        if (!text.includes(s.find))
          return { applied: false, reason: `${s.path}: find text not present` };
        safe.writeFile(fd, s.path, text.split(s.find).join(s.replace));
      } else
        throw new Error(
          `event step ${s.step} is not supported while the agent runs`,
        );
    }
    return { applied: true };
  });
}

/**
 * One workspace sample after a tool result: the delta digest of the
 * oracle-relevant set (minus harness-ignored output) and the total size of
 * the whole tree (dependencies included), both bounded. A failed sample has
 * `digest: null` (coverage incomplete); a tree over `capBytes` is reported
 * so the runner stops the agent (`resource-limit`).
 */
export function sampleWorkspace(
  root,
  {
    harnessIgnored = [],
    capBytes = Infinity,
    maxEntries = 500000,
    maxDigestBytes = 512 * 1024 * 1024,
  } = {},
) {
  const out = { digest: null, bytes: null, overCap: false, error: null };
  try {
    withRoot(root, (fd) => {
      let bytes = 0;
      safe.walk(
        fd,
        (rel, e) => {
          if (e.type === 'file') bytes += e.size;
          if (bytes > capBytes)
            throw safe.coded('over-cap', 'workspace over its byte cap');
        },
        { maxEntries },
      );
      out.bytes = bytes;
      const hash = crypto.createHash('sha256');
      let read = 0;
      safe.walk(
        fd,
        (rel, e) => {
          if (e.type === 'dir') hash.update(`${rel}\0dir\n`);
          else if (e.type === 'symlink')
            hash.update(`${rel}\0symlink\0${e.target}\n`);
          else if (e.type === 'special') hash.update(`${rel}\0special\n`);
          else {
            read += e.size;
            if (read > maxDigestBytes)
              throw safe.coded('oversize', 'delta sample too large');
            hash.update(
              `${rel}\0file\0${safe.hashFd(e.fd, { maxBytes: e.size })}\n`,
            );
          }
        },
        {
          exclude: excluder([...oracleIgnoredGlobs(), ...harnessIgnored]),
          maxEntries,
        },
      );
      out.digest = hash.digest('hex');
    });
  } catch (error) {
    out.error = error.code ?? 'error';
    if (error.code === 'over-cap') out.overCap = true;
  }
  return out;
}

/**
 * State of `node_modules` for local-install detection (section 4.5): null
 * when absent, `symlink:<target>` when the root is a link (never followed),
 * otherwise the confined tree digest. A failed walk is `unreadable:<code>`,
 * which differs from any digest, so it is detected as a change.
 */
export function nodeModulesState(root, { maxEntries = 500000 } = {}) {
  return withRoot(root, (fd) => {
    let st;
    try {
      st = fs.lstatSync(safe.at(fd, 'node_modules'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (st.isSymbolicLink())
      return `symlink:${fs.readlinkSync(safe.at(fd, 'node_modules'))}`;
    if (!st.isDirectory()) return `special:${st.mode.toString(8)}`;
    try {
      const nm = safe.openDir(fd, 'node_modules');
      try {
        const hash = crypto.createHash('sha256');
        safe.walk(
          nm,
          (rel, e) => {
            if (e.type === 'file')
              hash.update(
                `${rel}\0file\0${safe.hashFd(e.fd, { maxBytes: e.size })}\n`,
              );
            else hash.update(`${rel}\0${e.type}\0${e.target ?? ''}\n`);
          },
          { maxEntries },
        );
        return hash.digest('hex');
      } finally {
        fs.closeSync(nm);
      }
    } catch (error) {
      return `unreadable:${error.code ?? 'error'}`;
    }
  });
}

/**
 * Copies the oracle-relevant set of the workspace into a runner-private
 * staging directory, the only copy grading and archives read (section 6).
 */
export function stageWorkspace(
  root,
  dest,
  { maxBytes = 64 * 1024 * 1024 } = {},
) {
  return withRoot(root, (fd) =>
    safe.stageTree(fd, dest, {
      exclude: excluder(oracleIgnoredGlobs()),
      maxBytes,
    }),
  );
}

/**
 * Streams a file, reporting whether any needle occurs; memory is bounded by
 * the chunk size plus the longest needle (matches across chunk borders are
 * found through an overlap).
 */
export function fileContainsAny(fd, needles, { maxBytes = Infinity } = {}) {
  const list = needles.map((n) => Buffer.from(n)).filter((b) => b.length > 0);
  if (list.length === 0) return false;
  const overlap = Math.max(...list.map((b) => b.length)) - 1;
  let tail = Buffer.alloc(0);
  let found = false;
  safe.readChunks(
    fd,
    (chunk) => {
      if (found) return;
      const window = Buffer.concat([tail, chunk]);
      if (list.some((b) => window.includes(b))) found = true;
      tail = window.subarray(Math.max(0, window.length - overlap));
    },
    { maxBytes },
  );
  return found;
}

/** Paths of the staged (runner-private) tree whose bytes contain a secret. */
export function treeLeaks(dir, secrets) {
  if (secrets.length === 0 || !fs.existsSync(dir)) return [];
  const found = [];
  withRoot(dir, (fd) =>
    safe.walk(fd, (rel, e) => {
      if (e.type === 'file' && fileContainsAny(e.fd, secrets)) found.push(rel);
    }),
  );
  return found;
}

/** Whether a runner-written file contains a secret (chunked). */
export function pathLeaks(file, secrets) {
  if (secrets.length === 0 || !fs.existsSync(file)) return false;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return fileContainsAny(fd, secrets);
  } finally {
    fs.closeSync(fd);
  }
}
