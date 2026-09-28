/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - transactional publication of a generation (ARC-14, P0-10).
 *
 * ONE mechanism, shared by the CLI (`buildProject`) and the bundler adapter
 * (`pandamstyle()` in vite.js). Two divergent implementations were exactly how a
 * half-published generation became possible, so there is one here.
 *
 * The contract:
 *
 *   current generation N
 *     -> snapshot N
 *     -> prepare generation N+1 in staging
 *     -> compile every covered source
 *     -> validate coverage
 *     -> generate CSS / module / manifest / report
 *     -> bundler succeeds
 *     -> atomic publish N+1
 *
 * On an error at ANY step:
 *
 *   N stays current
 *   N+1 is discarded
 *   no mix of N and N+1
 *
 * TWO PROPERTIES THAT MAKE IT HOLD, AND THAT WERE BOTH FALSE BEFORE
 *
 * 1. Nothing is written into the output directory until `commit()`.
 *    Everything, including the generated design-system module, goes to a staging
 *    directory. That module is still RESOLVABLE while the pages are compiled,
 *    because it is served from the module overlay in module-graph.js rather than
 *    from disk. Writing it first was the original defect: on a failed build the
 *    module on disk was generation N+1 while the manifest beside it was still N.
 *
 * 2. `commit()` is the last thing that can fail, and it publishes the commit
 *    marker (`manifest.json`) LAST. A reader that trusts the manifest therefore
 *    never sees a payload that is not complete.
 *
 * A bundler is NOT a reliable witness for either. Vite calls `buildEnd` at the
 * end of the build phase, which is BEFORE the output phase, so an error thrown
 * from a later `generateBundle` reaches neither `buildEnd` nor `closeBundle`. A
 * plugin that writes during the build has no callback at which to undo it, which
 * is why property 1 above is the load-bearing one.
 *
 * Crash recovery: a process that dies between the snapshot and the commit leaves
 * a backup directory behind. The next `beginGeneration` restores it before taking
 * a new snapshot, so the good generation is recovered rather than inherited.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      copyTree(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }
  fs.copyFileSync(from, to);
}

/** Every file below `dir`, as paths relative to `dir`. */
function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

function digestOfTree(dir) {
  const files = listFiles(dir).sort();
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return { fileCount: files.length, sha256: hash.digest('hex') };
}

/** The two scratch directories, named deterministically so a crash leaves one. */
function scratchPaths(absOut) {
  const parent = path.dirname(absOut);
  const base = path.basename(absOut);
  return {
    stagingDir: path.join(parent, `.${base}.pms-staging`),
    backupDir: path.join(parent, `.${base}.pms-backup`),
  };
}

/**
 * Opens a generation transaction.
 *
 * The caller MUST finish it exactly once, with `commit()` or `rollback()`;
 * `withGeneration` below does that for the common case.
 */
export function beginGeneration(outDir, options = {}) {
  const {
    // The artifact that certifies "this generation is current". Published last.
    commitMarker = 'manifest.json',
  } = options;

  const absOut = path.resolve(outDir);
  const { stagingDir, backupDir } = scratchPaths(absOut);

  fs.mkdirSync(path.dirname(absOut), { recursive: true });

  // Crash recovery first: a previous run that died between snapshot and commit
  // left the backup behind, and the good generation is in it. Restoring BEFORE
  // the new snapshot is what stops a half-published generation from becoming
  // the baseline of the next one.
  let recovered = false;
  if (fs.existsSync(backupDir) && fs.statSync(backupDir).isDirectory()) {
    rmrf(absOut);
    copyTree(backupDir, absOut);
    recovered = true;
  }

  rmrf(stagingDir);
  rmrf(backupDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  // Snapshot of the current generation. Taken before ANY write, so rollback is
  // a restore rather than a re-derivation.
  const hadOutDir = fs.existsSync(absOut);
  if (hadOutDir) copyTree(absOut, backupDir);
  const previousDigest = hadOutDir ? digestOfTree(absOut) : null;

  const staged = new Map();
  let state = 'open';

  const ensureOpen = () => {
    if (state !== 'open') {
      throw new Error(
        `pandamstyle: generation already ${state}; it cannot be reused.`,
      );
    }
  };

  const api = {
    outDir: absOut,
    stagingDir,
    backupDir,
    commitMarker,
    previousDigest,
    hadPrevious: hadOutDir,
    recoveredFromCrash: recovered,

    /**
     * Stages `content` at `rel`. It is INVISIBLE until commit: nothing in the
     * output directory changes during a generation.
     */
    stage(rel, content) {
      ensureOpen();
      const target = path.join(stagingDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      staged.set(rel, target);
      return target;
    },

    /** Absolute final path of an artifact this generation will publish. */
    finalPath(rel) {
      return path.join(absOut, rel);
    },

    isStaged(rel) {
      return staged.has(rel);
    },

    /**
     * Publishes the staged payload. The commit marker goes LAST, so the marker
     * never precedes the payload it certifies.
     */
    commit() {
      ensureOpen();
      const ordered = [...staged.keys()].sort((a, b) => {
        if (a === commitMarker) return 1;
        if (b === commitMarker) return -1;
        return 0;
      });
      for (const rel of ordered) {
        const target = path.join(absOut, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(staged.get(rel), target);
      }
      staged.clear();
      rmrf(backupDir);
      rmrf(stagingDir);
      state = 'committed';
      return { published: ordered };
    },

    /**
     * Discards the generation. The current generation is restored byte for byte,
     * including a file this generation deleted.
     */
    rollback() {
      if (state !== 'open') return false;
      rmrf(stagingDir);
      rmrf(absOut);
      if (hadOutDir) copyTree(backupDir, absOut);
      rmrf(backupDir);
      state = 'rolled-back';
      return true;
    },

    get state() {
      return state;
    },
  };

  return api;
}

/**
 * Runs `fn(gen)` and publishes its result, or rolls the generation back.
 * The rollback happens on ANY throw, including a PMS_* diagnostic and including
 * a rejected promise.
 */
export function withGeneration(outDir, fn, options = {}) {
  const gen = beginGeneration(outDir, options);
  let value;
  try {
    value = fn(gen);
  } catch (err) {
    gen.rollback();
    throw err;
  }
  if (value != null && typeof value.then === 'function') {
    return value.then(
      (resolved) => {
        gen.commit();
        return resolved;
      },
      (err) => {
        gen.rollback();
        throw err;
      },
    );
  }
  gen.commit();
  return value;
}

/** Digest of a directory tree, used by the tests to prove byte identity. */
export { digestOfTree, listFiles };
