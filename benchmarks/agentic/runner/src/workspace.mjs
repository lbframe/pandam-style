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

function excludeMatcher(globs) {
  const m = compileGlobs(globs);
  return (rel, isDir) =>
    m.match(rel) != null || (isDir && m.match(`${rel}/`) != null);
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
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
          exclude: excludeMatcher([...oracleIgnoredGlobs(), ...harnessIgnored]),
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

// Install metadata written by package managers beside the packages
// (section 4.5): an install changes them, a build does not.
const INSTALL_METADATA = new Set([
  '.package-lock.json',
  '.yarn-integrity',
  '.yarn-state.yml',
  '.modules.yaml',
]);
const ROOT_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

/**
 * Role of a path beneath `node_modules` in the package layout: the packages
 * (`<name>`, `@<scope>/<name>`, nested `node_modules` at any depth inside a
 * package), `.bin` links and install metadata. Any other dot-entry of a
 * `node_modules` or scope directory cannot be a package (npm package names
 * never start with a dot), so tool caches (`.vite`, `.vite-temp`, `.cache`,
 * ...) are outside the install identity by construction.
 */
export function installRole(rel) {
  const parts = rel.split('/');
  let i = 0;
  let prefix = '';
  for (;;) {
    const head = parts[i];
    if (head === '.bin')
      return parts.length === i + 1
        ? { role: 'bin-dir' }
        : { role: 'bin', key: parts.slice(0, i + 2).join('/') };
    if (head.startsWith('.'))
      return prefix === '' && parts.length === 1 && INSTALL_METADATA.has(head)
        ? { role: 'metadata', key: head }
        : { role: 'ignored' };
    let rootLen = 1;
    if (head.startsWith('@')) {
      if (parts.length === i + 1) return { role: 'scope' };
      if (parts[i + 1].startsWith('.')) return { role: 'ignored' };
      rootLen = 2;
    }
    const pkg = parts.slice(0, i + rootLen).join('/');
    const inner = parts.slice(i + rootLen);
    const nested = inner.indexOf('node_modules');
    if (nested === -1)
      return inner.length === 0
        ? { role: 'package', key: pkg }
        : { role: 'content', key: pkg, path: inner.join('/') };
    if (nested === inner.length - 1)
      return { role: 'nested-dir', key: pkg, path: inner.join('/') };
    i += rootLen + nested + 1;
    prefix = parts.slice(0, i).join('/');
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value != null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function rootFileState(fd, name) {
  let st;
  try {
    st = fs.lstatSync(safe.at(fd, name));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (st.isSymbolicLink())
    return `symlink:${fs.readlinkSync(safe.at(fd, name))}`;
  if (!st.isFile()) return `special:${st.mode.toString(8)}`;
  return crypto
    .createHash('sha256')
    .update(safe.readFile(fd, name))
    .digest('hex');
}

/**
 * Install identity of the workspace for local-install detection (section
 * 4.5): what an install changes, never what a build writes. Packages with
 * their name, version, lockfile integrity and a digest of their files (a
 * hand-copied or modified package changes it), `.bin` links, the install
 * metadata in `node_modules` and the workspace lockfiles. Taken without
 * following links: a linked `node_modules` or package is recorded by its
 * target. A failed walk is `unreadable:<code>`, which differs from any
 * digest, so it is detected as a change.
 */
export function installState(root, { maxEntries = 500000 } = {}) {
  return withRoot(root, (fd) => {
    const lockfiles = {};
    for (const name of ROOT_LOCKFILES) {
      const v = rootFileState(fd, name);
      if (v != null) lockfiles[name] = v;
    }
    // An absent node_modules and one holding no package (only caches) are
    // the same install.
    const state = {
      nodeModules: 'dir',
      packages: {},
      bins: {},
      metadata: {},
      lockfiles,
    };
    const done = () => ({ ...state, digest: sha256Text(stableJson(state)) });
    let st;
    try {
      st = fs.lstatSync(safe.at(fd, 'node_modules'));
    } catch (error) {
      if (error.code === 'ENOENT') return done();
      throw error;
    }
    if (st.isSymbolicLink()) {
      state.nodeModules = `symlink:${fs.readlinkSync(safe.at(fd, 'node_modules'))}`;
      return done();
    }
    if (!st.isDirectory()) {
      state.nodeModules = `special:${st.mode.toString(8)}`;
      return done();
    }
    state.nodeModules = 'dir';
    const hashes = new Map();
    const pkgOf = (key) => {
      state.packages[key] ??= {
        kind: 'dir',
        name: null,
        version: null,
        integrity: null,
      };
      return state.packages[key];
    };
    try {
      const nm = safe.openDir(fd, 'node_modules');
      try {
        safe.walk(
          nm,
          (rel, e) => {
            const r = installRole(rel);
            const fileHash = () => safe.hashFd(e.fd, { maxBytes: e.size });
            const entry = () =>
              e.type === 'file'
                ? `file:${fileHash()}`
                : e.type === 'symlink'
                  ? `symlink:${e.target}`
                  : e.type;
            if (r.role === 'bin') state.bins[r.key] = entry();
            else if (r.role === 'metadata') {
              if (e.type !== 'file') state.metadata[r.key] = entry();
              else {
                const bytes = safe.readFile(nm, rel);
                state.metadata[r.key] = crypto
                  .createHash('sha256')
                  .update(bytes)
                  .digest('hex');
                if (r.key === '.package-lock.json') state.lock = bytes;
              }
            } else if (r.role === 'package') {
              const p = pkgOf(r.key);
              if (e.type === 'symlink')
                Object.assign(p, { kind: 'symlink', target: e.target });
              else if (e.type !== 'dir')
                Object.assign(p, { kind: e.type, target: entry() });
            } else if (r.role === 'content') {
              if (!hashes.has(r.key))
                hashes.set(r.key, crypto.createHash('sha256'));
              const value = entry();
              hashes.get(r.key).update(`${r.path}\0${value}\n`);
              if (r.path === 'package.json' && e.type === 'file') {
                try {
                  const pj = JSON.parse(
                    safe
                      .readFile(nm, rel, { maxBytes: 1 << 20 })
                      .toString('utf8'),
                  );
                  Object.assign(pkgOf(r.key), {
                    name: typeof pj.name === 'string' ? pj.name : null,
                    version: typeof pj.version === 'string' ? pj.version : null,
                  });
                } catch {
                  // Unparseable: still covered by the content digest.
                }
              }
            }
          },
          {
            maxEntries,
            exclude: (rel) => installRole(rel).role === 'ignored',
          },
        );
      } finally {
        fs.closeSync(nm);
      }
    } catch (error) {
      const code = `unreadable:${error.code ?? 'error'}`;
      return { nodeModules: code, digest: code };
    }
    for (const [key, h] of hashes) pkgOf(key).contentSha256 = h.digest('hex');
    if (state.lock) {
      let entries = {};
      try {
        entries = JSON.parse(state.lock.toString('utf8')).packages ?? {};
      } catch {
        // Unparseable: covered by the metadata digest.
      }
      for (const [key, p] of Object.entries(state.packages))
        p.integrity = entries[`node_modules/${key}`]?.integrity ?? null;
      delete state.lock;
    }
    return done();
  });
}

/** What changed between two install identities, for the breach detail. */
export function describeInstallChange(before, after) {
  if (before?.digest === after?.digest) return null;
  if (before?.packages == null || after?.packages == null)
    return `node_modules ${before?.nodeModules ?? 'absent'} -> ${after?.nodeModules ?? 'absent'}`;
  const label = (k, p) => `${p.name ?? k}${p.version ? `@${p.version}` : ''}`;
  const out = [];
  if (before.nodeModules !== after.nodeModules)
    out.push(`node_modules ${before.nodeModules} -> ${after.nodeModules}`);
  for (const k of Object.keys(after.packages).sort())
    if (!(k in before.packages)) out.push(`+${label(k, after.packages[k])}`);
    else if (stableJson(before.packages[k]) !== stableJson(after.packages[k]))
      out.push(`~${label(k, after.packages[k])}`);
  for (const k of Object.keys(before.packages).sort())
    if (!(k in after.packages)) out.push(`-${label(k, before.packages[k])}`);
  for (const field of ['bins', 'metadata', 'lockfiles'])
    for (const k of new Set([
      ...Object.keys(before[field]),
      ...Object.keys(after[field]),
    ]))
      if (before[field][k] !== after[field][k])
        out.push(`${field === 'lockfiles' ? '' : `${field}:`}${k}`);
  return `installed packages changed: ${out.join(', ')}`.slice(0, 300);
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
      exclude: excludeMatcher(oracleIgnoredGlobs()),
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
