/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Confined filesystem access to agent-controlled trees (DESIGN.md sections
// 4.2 and 11.2). Every path is resolved beneath an open directory handle, one
// component at a time: each component is opened through
// `/proc/self/fd/<dir fd>/<name>`, which the kernel resolves from that exact
// directory (not by re-walking a path name), with O_NOFOLLOW. A component
// replaced by a symbolic link fails with ELOOP; a directory renamed or
// swapped after it was opened keeps being the directory that was opened; a
// file replaced by a FIFO or device is refused by fstat before any read, and
// opened O_NONBLOCK so it never blocks. Linux only, like the runner.
//
// Nothing here follows a link inside an agent-controlled tree, and nothing
// reads beyond the caller's bounds.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const O = fs.constants;
const DIR_FLAGS = O.O_RDONLY | O.O_DIRECTORY | O.O_NOFOLLOW;
const READ_FLAGS = O.O_RDONLY | O.O_NOFOLLOW | O.O_NONBLOCK;

export function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Path of `name` inside the directory open as `fd` (or the directory itself). */
export function at(fd, name = '') {
  return name === '' ? `/proc/self/fd/${fd}` : `/proc/self/fd/${fd}/${name}`;
}

function components(rel) {
  const parts = String(rel)
    .split('/')
    .filter((p) => p !== '' && p !== '.');
  for (const p of parts)
    if (p === '..' || p.includes('\0'))
      throw coded('unsafe-path', `unsafe path component in ${rel}`);
  if (String(rel).startsWith('/'))
    throw coded('unsafe-path', `absolute path ${rel}`);
  return parts;
}

/** Opens a tree root; the root itself must be a real directory. */
export function openRoot(root) {
  return fs.openSync(root, DIR_FLAGS);
}

/**
 * Opens the directory `rel` beneath `dirFd`, never following a link; with
 * `create`, missing directories are created (mode 0700 by default).
 */
export function openDir(dirFd, rel, { create = false, mode = 0o700 } = {}) {
  // Duplicate of an open directory: the magic link itself is followed (it is
  // that exact directory); every component below is opened O_NOFOLLOW.
  let fd = fs.openSync(at(dirFd), O.O_RDONLY | O.O_DIRECTORY);
  for (const name of components(rel)) {
    let next;
    try {
      next = fs.openSync(at(fd, name), DIR_FLAGS);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) {
        fs.closeSync(fd);
        throw error;
      }
      fs.mkdirSync(at(fd, name), { mode });
      next = fs.openSync(at(fd, name), DIR_FLAGS);
    }
    fs.closeSync(fd);
    fd = next;
  }
  return fd;
}

function withParent(dirFd, rel, fn, opts) {
  const parts = components(rel);
  if (parts.length === 0) throw coded('unsafe-path', 'empty path');
  const parent = openDir(dirFd, parts.slice(0, -1).join('/'), opts);
  try {
    return fn(parent, parts.at(-1));
  } finally {
    fs.closeSync(parent);
  }
}

/** Reads a regular file beneath `dirFd`, at most `maxBytes` (else throws). */
export function readFile(dirFd, rel, { maxBytes = 64 * 1024 * 1024 } = {}) {
  return withParent(dirFd, rel, (parent, name) =>
    readFileAt(parent, name, maxBytes),
  );
}

function readFileAt(parent, name, maxBytes) {
  const fd = fs.openSync(at(parent, name), READ_FLAGS);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile())
      throw coded('not-regular', `${name} is not a regular file`);
    if (st.size > maxBytes)
      throw coded('oversize', `${name} exceeds ${maxBytes} bytes`);
    const chunks = [];
    let total = 0;
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes)
        throw coded('oversize', `${name} grew beyond ${maxBytes} bytes`);
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes a regular file beneath `dirFd`, creating parent directories. An
 * existing link, FIFO or other non-regular file at the target is refused.
 */
export function writeFile(dirFd, rel, data, { mode = 0o644 } = {}) {
  withParent(
    dirFd,
    rel,
    (parent, name) => {
      const fd = fs.openSync(
        at(parent, name),
        O.O_WRONLY | O.O_CREAT | O.O_NOFOLLOW | O.O_NONBLOCK,
        mode,
      );
      try {
        if (!fs.fstatSync(fd).isFile())
          throw coded('not-regular', `${rel} is not a regular file`);
        fs.ftruncateSync(fd, 0);
        fs.writeSync(fd, data);
      } finally {
        fs.closeSync(fd);
      }
    },
    { create: true, mode: 0o755 },
  );
}

/** Removes `rel` (recursively for directories) without following links. */
export function remove(dirFd, rel) {
  withParent(dirFd, rel, (parent, name) => removeAt(parent, name));
}

function removeAt(parent, name) {
  let st;
  try {
    st = fs.lstatSync(at(parent, name));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(at(parent, name));
    return;
  }
  const fd = fs.openSync(at(parent, name), DIR_FLAGS);
  try {
    for (const child of fs.readdirSync(at(fd))) removeAt(fd, child);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmdirSync(at(parent, name));
}

/** rename(2) between two paths beneath `dirFd`; final components are not followed. */
export function rename(dirFd, from, to) {
  withParent(dirFd, from, (pa, a) =>
    withParent(dirFd, to, (pb, b) => fs.renameSync(at(pa, a), at(pb, b)), {
      create: true,
      mode: 0o755,
    }),
  );
}

/**
 * Walks the tree beneath `rootFd` in sorted order. `visit(rel, entry)` gets
 * `{ type: 'dir'|'file'|'symlink'|'special', mode, size, target?, fd? }`;
 * for files `fd` is an open, fstat-checked regular-file descriptor valid only
 * during the call. `exclude(rel, isDir)` prunes. Bounds: `maxEntries`.
 */
export function walk(
  rootFd,
  visit,
  { exclude = () => false, maxEntries = 1_000_000 } = {},
) {
  let entries = 0;
  const rec = (dirFd, rel) => {
    for (const name of fs.readdirSync(at(dirFd)).sort()) {
      entries += 1;
      if (entries > maxEntries)
        throw coded('too-many-entries', `more than ${maxEntries} entries`);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(at(dirFd, name));
      if (st.isDirectory()) {
        if (exclude(childRel, true)) continue;
        const fd = fs.openSync(at(dirFd, name), DIR_FLAGS);
        try {
          visit(childRel, { type: 'dir', mode: st.mode & 0o777 });
          rec(fd, childRel);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        if (exclude(childRel, false)) continue;
        if (st.isSymbolicLink())
          visit(childRel, {
            type: 'symlink',
            mode: st.mode & 0o777,
            target: fs.readlinkSync(at(dirFd, name)),
          });
        else if (st.isFile()) {
          const fd = fs.openSync(at(dirFd, name), READ_FLAGS);
          try {
            const fst = fs.fstatSync(fd);
            if (!fst.isFile())
              throw coded(
                'swapped',
                `${childRel} changed type during the walk`,
              );
            visit(childRel, {
              type: 'file',
              mode: fst.mode & 0o777,
              size: fst.size,
              fd,
            });
          } finally {
            fs.closeSync(fd);
          }
        } else visit(childRel, { type: 'special', mode: st.mode & 0o777 });
      }
    }
  };
  rec(rootFd, '');
  return entries;
}

/** Streams an open file descriptor through `onChunk`, bounded by `maxBytes`. */
export function readChunks(fd, onChunk, { maxBytes = Infinity } = {}) {
  const buf = Buffer.alloc(1 << 16);
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) return total;
    total += n;
    if (total > maxBytes)
      throw coded('oversize', `more than ${maxBytes} bytes`);
    onChunk(buf.subarray(0, n));
  }
}

export function hashFd(fd, opts) {
  const h = crypto.createHash('sha256');
  readChunks(fd, (c) => h.update(c), opts);
  return h.digest('hex');
}

/**
 * Copies the tree beneath `rootFd` into the runner-private `dest` (mode
 * 0700 directories, 0600 files): regular files by content, links as links
 * with their target text, special files as metadata only. Stops copying file
 * contents beyond `maxBytes` (the result says so). Returns the entry list.
 */
export function stageTree(
  rootFd,
  dest,
  { exclude = () => false, maxBytes = Infinity, maxEntries } = {},
) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const entries = [];
  let bytes = 0;
  let overflow = false;
  walk(
    rootFd,
    (rel, e) => {
      const target = path.join(dest, rel);
      const entry = { path: rel, type: e.type, mode: e.mode };
      if (e.type === 'dir') fs.mkdirSync(target, { mode: 0o700 });
      else if (e.type === 'symlink') {
        entry.target = e.target;
        fs.symlinkSync(e.target, target);
      } else if (e.type === 'file') {
        entry.size = e.size;
        if (overflow || bytes + e.size > maxBytes) {
          overflow = true;
          entry.staged = false;
        } else {
          const out = fs.openSync(target, 'wx', 0o600);
          try {
            bytes += readChunks(e.fd, (c) => fs.writeSync(out, c), {
              maxBytes: maxBytes - bytes,
            });
          } finally {
            fs.closeSync(out);
          }
          entry.staged = true;
        }
      }
      entries.push(entry);
    },
    { exclude, ...(maxEntries ? { maxEntries } : {}) },
  );
  return { entries, bytes, overflow };
}

/** Recursively removes a runner-owned directory; never throws for ENOENT. */
export function removeOwned(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    // A directory made unreadable inside a tree is made writable and retried.
    if (error.code !== 'EACCES') throw error;
    chmodOwned(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function chmodOwned(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return;
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) chmodOwned(path.join(dir, name));
  } catch {
    // Best effort: the retry reports what remains.
  }
}
