/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * AG-02.1 runtime directory (§3.3).
 *
 * Every operation is anchored on a directory descriptor through
 * `/proc/self/fd/<fd>/<name>` with a single component (I7). Placement is
 * verified, never assumed (R2): the parent's real path is checked against the
 * protected trees before anything is created, the directory's own real path
 * after it is opened, and again before each later creation (I11).
 */

const C = fs.constants;
/**
 * Linux `O_PATH`, which Node does not name: a descriptor that pins an inode
 * without needing read permission on it. `fchmod` refuses such a descriptor
 * (`EBADF`); its `/proc/self/fd/<fd>` link reaches the pinned inode itself, and
 * a pinned symlink refuses `chmod` (`ENOTSUP`).
 */
const O_PATH = 0o10000000;

/** The modes the bridge creates, set explicitly and verified (umask-proof). */
export const MODES = Object.freeze({
  directory: 0o700,
  file: 0o600,
  socket: 0o600,
});
const permissions = (stat) => stat.mode & 0o777;

/**
 * Sets `mode` on the inode `pin` holds and verifies it, never by path. `kind`
 * is checked first, so the pinned object is the one the caller created.
 */
function enforceMode(pin, kind, mode) {
  const before = fs.fstatSync(pin);
  if (!before[kind]() || before.uid !== process.getuid()) return false;
  if (permissions(before) !== mode) fs.chmodSync(`/proc/self/fd/${pin}`, mode);
  return permissions(fs.fstatSync(pin)) === mode;
}
const ENTRY_NAME =
  /^[0-9a-f]{16}-[0-9a-f]{16}\.(?:json|key|sock)(?:\.[0-9a-f]{12}\.tmp)?$/;

export function anchoringAvailable() {
  return process.platform === 'linux';
}

/** The owner uses the first candidate; the client checks them in order. */
export function runtimeDirCandidates({
  env = process.env,
  tmpdir = os.tmpdir(),
  uid = process.getuid?.() ?? null,
} = {}) {
  const candidates = [];
  const xdg = env.XDG_RUNTIME_DIR;
  if (typeof xdg === 'string' && path.isAbsolute(xdg))
    candidates.push(path.join(xdg, 'pandamstyle'));
  if (uid != null) candidates.push(path.join(tmpdir, `pandamstyle-${uid}`));
  return candidates;
}

const anchored = (fd, name) => `/proc/self/fd/${fd}/${name}`;

function checkName(name) {
  if (typeof name !== 'string' || !ENTRY_NAME.test(name))
    throw new TypeError('owner bridge: not a runtime directory entry name');
}

/** `realpath`, or the nearest existing ancestor's plus the missing suffix. */
export function canonicalPath(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cursor), ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR')
        return path.resolve(value);
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(value);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** A tree is inside `root` when it is `root` or below it, at a `/` boundary. */
export function isInside(root, real) {
  if (real === root) return true;
  return real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function placementOf(fd, protectedRoots) {
  let real;
  try {
    real = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return 'anchoring-unavailable';
  }
  for (const root of protectedRoots) {
    if (isInside(canonicalPath(root), real)) return 'runtime-dir-overlap';
  }
  return null;
}

function anchorHolds(fd) {
  try {
    const held = fs.fstatSync(fd);
    const named = fs.statSync(`/proc/self/fd/${fd}`);
    return (
      held.isDirectory() && held.dev === named.dev && held.ino === named.ino
    );
  } catch {
    return false;
  }
}

/**
 * Opens (and, for the owner, creates) the runtime directory. Returns
 * `{ handle }` or `{ refused }`, with `refused` one of `anchoring-unavailable`,
 * `runtime-dir-overlap`, `runtime-dir-unsafe` or `runtime-dir-missing`.
 */
export function openRuntimeDir(dir, { create = false, protectedRoots = [] }) {
  if (!anchoringAvailable()) return { refused: 'anchoring-unavailable' };
  if (typeof dir !== 'string' || !path.isAbsolute(dir))
    return { refused: 'runtime-dir-unsafe' };
  let parent;
  try {
    // Following links here is intended: the check uses where the parent is.
    parent = fs.openSync(path.dirname(dir), C.O_RDONLY | C.O_DIRECTORY);
  } catch (error) {
    return {
      refused:
        error?.code === 'ENOENT' ? 'runtime-dir-missing' : 'runtime-dir-unsafe',
    };
  }
  let fd = null;
  try {
    if (!anchorHolds(parent)) return { refused: 'anchoring-unavailable' };
    // Nothing is created before the parent's placement is known (R2).
    const parentPlacement = placementOf(parent, protectedRoots);
    if (parentPlacement != null) return { refused: parentPlacement };
    const leaf = path.basename(dir);
    if (create) {
      try {
        fs.mkdirSync(anchored(parent, leaf), { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') return { refused: 'runtime-dir-unsafe' };
      }
    }
    // Pinned without read permission, so a restrictive umask cannot hide it.
    let pin;
    try {
      pin = fs.openSync(
        anchored(parent, leaf),
        O_PATH | C.O_DIRECTORY | C.O_NOFOLLOW,
      );
    } catch (error) {
      return {
        refused:
          error?.code === 'ENOENT'
            ? 'runtime-dir-missing'
            : 'runtime-dir-unsafe',
      };
    }
    try {
      const stat = fs.fstatSync(pin);
      // Group or other bits were granted by someone: never tightened silently.
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0
      )
        return { refused: 'runtime-dir-unsafe' };
      // The owner sets the directory's mode; a client only verifies it (R1).
      if (
        create
          ? !enforceMode(pin, 'isDirectory', MODES.directory)
          : permissions(stat) !== MODES.directory
      )
        return { refused: 'runtime-dir-unsafe' };
      fd = fs.openSync(`/proc/self/fd/${pin}`, C.O_RDONLY | C.O_DIRECTORY);
      if (fs.fstatSync(fd).ino !== stat.ino)
        return { refused: 'runtime-dir-unsafe' };
    } catch {
      return { refused: 'runtime-dir-unsafe' };
    } finally {
      fs.closeSync(pin);
    }
    if (!anchorHolds(fd)) return { refused: 'anchoring-unavailable' };
    const placement = placementOf(fd, protectedRoots);
    if (placement != null) return { refused: placement };
    const handle = createHandle(fd, protectedRoots);
    fd = null;
    return { handle };
  } finally {
    fs.closeSync(parent);
    if (fd != null) fs.closeSync(fd);
  }
}

function createHandle(fd, protectedRoots) {
  let closed = false;
  const recheck = () => {
    const placement = placementOf(fd, protectedRoots);
    if (placement != null)
      throw Object.assign(new Error(`owner bridge: ${placement}`), {
        code: placement,
      });
  };
  return Object.freeze({
    fd,
    path: (name) => {
      checkName(name);
      return anchored(fd, name);
    },
    recheck,
    /** Temporary file, `O_EXCL | O_NOFOLLOW`, `0600`, fsync, then rename. */
    write(name, data) {
      checkName(name);
      recheck();
      const temporary = `${name}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const file = fs.openSync(
        anchored(fd, temporary),
        C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW,
        MODES.file,
      );
      try {
        try {
          // The create mode is masked by the umask: set it, then verify (R1).
          fs.fchmodSync(file, MODES.file);
          if (permissions(fs.fstatSync(file)) !== MODES.file)
            throw Object.assign(new Error('owner bridge: file mode'), {
              code: 'runtime-dir-unsafe',
            });
          let written = 0;
          const bytes = Buffer.from(data);
          while (written < bytes.length)
            written += fs.writeSync(file, bytes, written);
          fs.fsyncSync(file);
        } finally {
          fs.closeSync(file);
        }
        fs.renameSync(anchored(fd, temporary), anchored(fd, name));
      } catch (error) {
        fs.rmSync(anchored(fd, temporary), { force: true });
        throw error;
      }
    },
    /** A regular file owned by the user, at most `max` bytes, or `null`. */
    read(name, max) {
      checkName(name);
      let file;
      try {
        file = fs.openSync(
          anchored(fd, name),
          C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK,
        );
      } catch (error) {
        return { missing: error?.code === 'ENOENT', bytes: null };
      }
      try {
        const stat = fs.fstatSync(file);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid() ||
          permissions(stat) !== MODES.file ||
          stat.size > max
        )
          return { missing: false, bytes: null };
        const buffer = Buffer.alloc(max + 1);
        let read = 0;
        for (;;) {
          const count = fs.readSync(file, buffer, read, max + 1 - read, null);
          if (count === 0) break;
          read += count;
          if (read > max) return { missing: false, bytes: null };
        }
        return { missing: false, bytes: buffer.subarray(0, read) };
      } finally {
        fs.closeSync(file);
      }
    },
    /** Sets and verifies the socket's mode once it is bound (R1). */
    secureSocket(name) {
      checkName(name);
      const pin = fs.openSync(anchored(fd, name), O_PATH | C.O_NOFOLLOW);
      try {
        if (!enforceMode(pin, 'isSocket', MODES.socket))
          throw Object.assign(new Error('owner bridge: socket mode'), {
            code: 'runtime-dir-unsafe',
          });
      } finally {
        fs.closeSync(pin);
      }
    },
    remove(name) {
      checkName(name);
      try {
        fs.unlinkSync(anchored(fd, name));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
    /** Streams the directory; keeps only the names `keep` accepts. */
    list(keep) {
      const names = [];
      const dir = fs.opendirSync(`/proc/self/fd/${fd}`);
      try {
        for (let entry = dir.readSync(); entry != null; entry = dir.readSync())
          if (keep(entry.name)) names.push(entry.name);
      } finally {
        dir.closeSync();
      }
      return names;
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(fd);
    },
  });
}
