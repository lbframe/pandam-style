/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - transactional publication of a generation (ARC-14, P0-10).
 *
 * ONE private mechanism, called by the canonical Project Service. The CLI is a
 * service consumer; framework qualification seams do not own publication.
 * Divergent implementations were exactly how a half-published generation
 * became possible, so there is one here.
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
 * ---------------------------------------------------------------------------
 * SPIKE 3 - INCREMENTAL PUBLICATION
 * ---------------------------------------------------------------------------
 *
 * Spike 2 established that the session can recompile one file in a 10,000-file
 * project, and then measured publication at 2,141ms - 53% of the revision - to
 * rewrite 10,002 artifacts that were almost all byte-identical to the ones
 * already on disk. The reason was structural, and it was in this file:
 *
 *   - `beginGeneration` COPIES the entire output directory (`copyTree`) so that
 *     rollback can restore it, and separately READS every published byte to
 *     compute a tree digest. Two full passes over every artifact, neither of
 *     them needed, and `previousDigest` had no production reader at all.
 *   - `commit()` renamed a freshly written file over every artifact in turn.
 *
 * Both are O(total published bytes) for a revision that changed O(1) of them.
 *
 * This file now supports two publication strategies, and they are SEPARATE on
 * purpose, because the whole point of Spike 3 is to attribute the win:
 *
 *   mode 'full'  the Spike 2 behaviour, retained unchanged as the reference
 *                implementation. Every artifact is written on every revision.
 *                It is also what a caller gets when it does not opt in, so no
 *                existing caller changes behaviour.
 *
 *   mode 'delta' a generation is built in the staging directory by REUSING the
 *                previous generation's file for every unchanged artifact -
 *                `link()`ed, never copied, never written - and by writing only
 *                the changed ones. The previous generation is then retired by
 *                RENAME, not by copy: `outDir` becomes `backupDir` and
 *                `stagingDir` becomes `outDir`.
 *
 * WHY THE RENAME AND NOT A PER-FILE RENAME
 *
 * Mutating the current generation in place is forbidden, and correctly so: a
 * reader can see it. A directory swap is the smallest portable primitive that
 * leaves the current generation immutable for the whole of the preparation phase
 * and makes rollback a rename rather than a full restore.
 *
 * IT COSTS O(total) - one `link()` per unchanged artifact, ~11.6us each on this
 * machine, ~116ms for 10,000 files. That is the honest residue of the design
 * and it is reported as such, not hidden. The bytes written, which is what
 * actually dominated, drop to O(changed). Removing the last O(total) term would
 * mean indirection through a symlink or a pointer file, which this implementation
 * deliberately does not do: it would change the published artifact's on-disk
 * shape, and a portable "generation directory + pointer" is exactly the kind of
 * claim this file will not make beyond what it guarantees.
 *
 * THE STATE FILE IS WHAT MAKES `removed` KNOWABLE
 *
 * A deleted source must take its published output with it. The previous code
 * could not do that: `commit()` had no deletion step, so a deleted module left
 * its compiled JavaScript on disk forever. Deletion is derived from a record of
 * what the previous generation contained, so the answer is a set difference
 * rather than a directory walk:
 *
 *   .<out>.pms-state.json          the CURRENT generation's records
 *   .<out>.pms-state.pending.json  a fully prepared generation, mid-publish
 *
 * `removed` is `previous generation's records - this generation's records`. A
 * stale file therefore cannot survive merely because an older generation
 * happened to contain it, and the published file set is a function of the
 * revision, not of the history that led to it.
 *
 * Records live OUTSIDE the output directory, deliberately: the output directory's
 * file set is compared against a fresh rebuild's, and a control file inside it
 * would be a difference from the reference on every single revision.
 *
 * CRASH SAFETY
 *
 * The commit is three renames and a promote:
 *
 *   1. write the pending state file       (the generation is now durable+complete)
 *   2. rename(outDir, backupDir)          (retire N - O(1))
 *   3. rename(stagingDir, outDir)         (install N+1 - O(1))
 *   4. rename(pending, state)             (N+1 becomes current)
 *   5. rm -rf backupDir                   (N is released)
 *
 * The pending file is the commit intent. A process that dies at any point is
 * reconciled by the next `beginGeneration`:
 *
 *   pending present, staging present -> roll FORWARD. The generation was fully
 *       prepared and validated before step 1, so completing it is correct, and it
 *       is cheaper than discarding the work.
 *   pending present, staging gone     -> steps 2-3 completed; promote the state.
 *   pending absent                    -> publication never began; discard staging.
 *
 * `outDir` therefore always contains exactly one complete, self-consistent
 * generation, and generation N+1 is never observable as current unless it
 * committed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
// Benchmark-only measurement hooks (Spike 1).
import { perfCollector, perfNow } from '../../observability/metrics';

/** Bumped when the on-disk record shape changes incompatibly. */
const STATE_VERSION = 1;

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

function sha256Of(content) {
  return crypto
    .createHash('sha256')
    .update(
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    )
    .digest('hex');
}

function byteLengthOf(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (content == null) return 0;
  return content.length;
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isRevisionIdentity(value) {
  return (
    value != null &&
    typeof value.projectId === 'string' &&
    typeof value.sessionId === 'string' &&
    Number.isSafeInteger(value.revisionId) &&
    value.revisionId >= 0
  );
}

function artifactDigestOf(records = {}) {
  const hash = crypto.createHash('sha256');
  for (const rel of Object.keys(records).sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(records[rel]?.digest ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Written-and-renamed, so a reader never sees a half-written control file. */
function writeJsonAtomic(target, value) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hard links (Spike 3)
//
// Reuse is `link()`, not `copyFileSync`: on the same filesystem a link costs
// ~11.6us and a copy of a typical compiled artifact costs ~180us, and it keeps
// the disk cost of a generation to the artifacts that actually changed.
//
// It is an ACCELERATION, never a requirement. Anything that cannot link - a
// filesystem without link support, an `EMLINK` link-count ceiling, a policy that
// forbids it - falls back to a copy, which is correct but O(total bytes). The
// capability is probed once per process against the real staging directory, not
// assumed, and the fallback is counted separately so a run on such a filesystem
// reports itself honestly.
// ---------------------------------------------------------------------------

let hardlinkSupport = null;

function hardlinksAvailable(dir) {
  if (hardlinkSupport !== null) return hardlinkSupport;
  const probe = path.join(dir, `.pms-link-probe-${process.pid}`);
  const target = `${probe}.b`;
  try {
    fs.writeFileSync(probe, 'probe', 'utf8');
    fs.linkSync(probe, target);
    hardlinkSupport = true;
  } catch {
    hardlinkSupport = false;
  } finally {
    try {
      fs.rmSync(probe, { force: true });
      fs.rmSync(target, { force: true });
    } catch {
      /* the probe is scratch; a failure to clean it is not a build failure */
    }
  }
  return hardlinkSupport;
}

/** The scratch paths and control files, named deterministically. */
function scratchPaths(absOut) {
  const parent = path.dirname(absOut);
  const base = path.basename(absOut);
  return {
    stagingDir: path.join(parent, `.${base}.pms-staging`),
    backupDir: path.join(parent, `.${base}.pms-backup`),
    statePath: path.join(parent, `.${base}.pms-state.json`),
    pendingStatePath: path.join(parent, `.${base}.pms-state.pending.json`),
  };
}

function reconcileInterruptedGeneration(absOut, paths = scratchPaths(absOut)) {
  let recovered = false;
  const pending = readJsonIfPresent(paths.pendingStatePath);
  const hasOut = isDir(absOut);
  const hasBackup = isDir(paths.backupDir);
  const hasStaging = isDir(paths.stagingDir);

  if (pending != null) {
    // The intent marker is written only after validation and staging complete,
    // so recovery rolls this generation forward rather than inventing a
    // rollback result that was never committed by its owner.
    if (hasStaging) {
      if (hasOut) {
        rmrf(paths.backupDir);
        fs.renameSync(absOut, paths.backupDir);
      }
      fs.renameSync(paths.stagingDir, absOut);
    }
    if (fs.existsSync(paths.pendingStatePath)) {
      fs.renameSync(paths.pendingStatePath, paths.statePath);
    }
    rmrf(paths.backupDir);
    recovered = true;
  } else if (hasBackup) {
    // No durable intent means publication had not started. Restore the prior
    // committed generation byte for byte.
    rmrf(absOut);
    copyTree(paths.backupDir, absOut);
    rmrf(paths.backupDir);
    recovered = true;
  } else if (hasStaging) {
    rmrf(paths.stagingDir);
  }

  return { recovered, state: readJsonIfPresent(paths.statePath) };
}

/**
 * Reconciles a prior interrupted publication and returns its durable identity.
 * This is used during cold Project Service initialization; it never restores
 * compiler caches or treats an old session as a current revision.
 */
export function recoverPublishedGeneration(outDir) {
  const absOut = path.resolve(outDir);
  const paths = scratchPaths(absOut);
  const { state } = reconcileInterruptedGeneration(absOut, paths);
  if (
    !isDir(absOut) ||
    state?.version !== STATE_VERSION ||
    state?.files == null ||
    state.files['manifest.json'] == null
  ) {
    return null;
  }

  const manifest = readJsonIfPresent(path.join(absOut, 'manifest.json'));
  const designSystem =
    manifest?.systemId == null || manifest?.registryDigest == null
      ? null
      : Object.freeze({
          systemId: manifest.systemId,
          registryDigest: manifest.registryDigest,
        });
  const artifactRevision = isRevisionIdentity(state.artifactRevisionIdentity)
    ? Object.freeze({ ...state.artifactRevisionIdentity })
    : null;
  const associationRevision = isRevisionIdentity(
    state.associationRevisionIdentity,
  )
    ? Object.freeze({ ...state.associationRevisionIdentity })
    : null;

  return Object.freeze({
    generationId: Number.isSafeInteger(state.generationId)
      ? state.generationId
      : null,
    artifactRevision,
    associationRevision,
    artifactDigest:
      typeof state.artifactDigest === 'string'
        ? state.artifactDigest
        : artifactDigestOf(state.files),
    candidateDigest:
      typeof state.candidateDigest === 'string' ? state.candidateDigest : null,
    designSystem,
  });
}

/**
 * The publication delta.
 *
 * Broken down by KIND as well as in total, because the aggregate hides the only
 * number that matters on a no-change revision: a project of 10,000 files whose
 * single changed artifact is the build report has written no JavaScript at all,
 * and "1 output changed" does not say that.
 */
const OUTPUT_KINDS = ['js', 'css', 'types', 'metadata', 'other'];

function emptyKind() {
  return {
    added: 0,
    changed: 0,
    reused: 0,
    removed: 0,
    bytesWritten: 0,
    bytesReused: 0,
    bytesDeleted: 0,
  };
}

function emptyDelta() {
  const byKind = {};
  for (const kind of OUTPUT_KINDS) byKind[kind] = emptyKind();
  return {
    added: 0,
    changed: 0,
    reused: 0,
    removed: 0,
    bytesWritten: 0,
    bytesReused: 0,
    bytesDeleted: 0,
    hardlinks: 0,
    copies: 0,
    byKind,
  };
}

function kindOf(meta) {
  return typeof meta.kind === 'string' ? meta.kind : 'other';
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
    // 'full'  - write every artifact on every revision (Spike 2 behaviour).
    // 'delta' - reuse the previous generation's unchanged artifacts by link.
    mode = 'full',
    // Identity of the generation being built, recorded in the state file so a
    // later process can tell "revision N" from "generation N".
    generationId = null,
    revisionId = null,
    revisionIdentity = null,
    candidateDigest = null,
    // Test seam. A point name, or a `(point) => void` that may throw. See
    // `maybeFail` below. Never set in a production path.
    failAt = null,
  } = options;

  const absOut = path.resolve(outDir);
  const { stagingDir, backupDir, statePath, pendingStatePath } =
    scratchPaths(absOut);

  const collector = perfCollector();
  const addCount = (name, n) => {
    if (collector != null && n != null) collector.addCount(name, n);
  };
  const addDuration = (name, startNs) => {
    if (collector != null) collector.addDuration(name, perfNow() - startNs);
  };

  // The transaction opens here, and `publish_ms` is the whole of it: prepare,
  // materialize, commit, cleanup. The sub-phases overlap it and are not to be
  // summed against it - they exist to say WHERE the aggregate went, which is
  // the question Spike 2 could not answer because its aggregate excluded the
  // snapshot entirely.
  const openStart = perfNow();
  // Two aggregates, because they answer different questions and only one of them
  // is comparable with the Spike 2 series.
  //
  //   publish_ms     the whole transaction: everything from opening it to the
  //                  commit. It includes whatever the CALLER does inside the
  //                  callback, and the session generates the stylesheet there,
  //                  so a variant that aggregates CSS in full carries that cost
  //                  inside this number.
  //   publish_io_ms  the transaction's own work: prepare, materialize, metadata,
  //                  commit, cleanup. The caller's work is excluded, and this is
  //                  the number comparable with Spike 2's `publish_ms`, which
  //                  measured staging and commit only.
  let ioStart = null;
  let ioNs = 0;
  const closeAggregate = () => {
    const now = perfNow();
    addDuration('publish_ms', openStart);
    if (ioStart != null) {
      ioNs += now - ioStart;
      ioStart = null;
    }
    if (ioNs > 0) collectorDuration('publish_io_ms', ioNs);
  };
  const collectorDuration = (name, ns) => {
    const c = perfCollector();
    if (c != null) c.addDuration(name, ns);
  };
  const markIoEnd = () => {
    if (ioStart == null) return;
    ioNs += perfNow() - ioStart;
    ioStart = null;
  };
  // An I/O segment is OPEN only while the transaction is doing its own work.
  // Between two artifacts the caller is running - compiling, aggregating CSS -
  // and that time is deliberately not this number's.
  const markIoStart = () => {
    ioStart = perfNow();
  };
  const prepareStart = perfNow();
  ioStart = prepareStart;

  fs.mkdirSync(path.dirname(absOut), { recursive: true });

  const delta = emptyDelta();
  const requestedDelta = mode === 'delta';
  // ---- crash reconciliation -------------------------------------------------
  //
  // Done before anything is prepared, and before the previous generation is read,
  // so a process that died mid-publish is resolved rather than inherited.
  const recovery = reconcileInterruptedGeneration(absOut, {
    stagingDir,
    backupDir,
    statePath,
    pendingStatePath,
  });
  const recovered = recovery.recovered;
  // The reconciliation above is real work this transaction did, so it counts
  // towards the I/O aggregate; the segment that follows it is the caller's.
  markIoEnd();

  // ---- the previous generation ---------------------------------------------
  const hadOutDir = isDir(absOut);
  // A state sidecar describes the output tree beside it. If that tree has been
  // removed, the sidecar alone is not evidence of a committed generation.
  const previousState = hadOutDir ? recovery.state : null;
  const previousRecords =
    previousState != null &&
    previousState.version === STATE_VERSION &&
    previousState.files != null
      ? previousState.files
      : null;
  const previousGenerationId = Number.isSafeInteger(previousState?.generationId)
    ? previousState.generationId
    : null;
  const sameCandidate =
    typeof candidateDigest === 'string' &&
    candidateDigest === previousState?.candidateDigest;
  const activeGenerationId =
    typeof generationId === 'number' && previousGenerationId != null
      ? Math.max(generationId, previousGenerationId + (sameCandidate ? 0 : 1))
      : generationId;
  const forceNewGeneration =
    revisionIdentity != null &&
    previousState != null &&
    (previousGenerationId == null ||
      !isRevisionIdentity(previousState?.artifactRevisionIdentity));

  // Delta publication needs the previous generation to EXIST, and to know what
  // each of its artifacts hashed to. Without the state file it would have to
  // read every published byte to find out, which is the O(total) cost this mode
  // exists to remove - so the FIRST delta publication over a generation it did
  // not write is a full one. It writes the state file, so the next revision is a
  // real one.
  //
  // `hadOutDir` is part of this condition and is not a redundancy. A record
  // file that outlives its generation - which is exactly what happens when
  // something clears the output directory between builds, whether that is a
  // clean, a container layer, or a build tool resetting its output - describes a
  // generation that is not there. Reusing it would mean linking from files that
  // do not exist, and the record file is not evidence that they do.
  const deltaActive = requestedDelta && hadOutDir && previousRecords != null;

  // `removed` is a set difference against the previous generation's records. In
  // full mode there is no state file, so the previous file set is read from the
  // directory instead - a readdir, which costs one syscall per directory rather
  // than one read per artifact.
  const previousSet = hadOutDir
    ? deltaActive
      ? new Set(Object.keys(previousRecords))
      : new Set(listFiles(absOut))
    : new Set();

  // Full mode takes a full COPY of the current generation before touching
  // anything, so its rollback and its crash recovery are a restore. That is the
  // Spike 2 behaviour, kept exactly: it is the reference implementation, and
  // changing its cost would change the number Spike 3 is measured against.
  //
  // Delta mode takes none. It renames the current generation into the backup
  // directory at commit time instead, which is O(1) and cannot lose a byte -
  // which is precisely the O(total) work this mode exists to remove.
  if (hadOutDir && !deltaActive) {
    rmrf(backupDir);
    copyTree(absOut, backupDir);
  }

  const staged = new Map();
  /** rel -> { digest, size, owner, generationId } for THIS generation. */
  const records = {};
  let generationArtifactDigest = null;
  const getGenerationArtifactDigest = () => {
    if (generationArtifactDigest == null) {
      generationArtifactDigest = artifactDigestOf(records);
    }
    return generationArtifactDigest;
  };

  rmrf(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });

  addDuration('publish_prepare_ms', prepareStart);

  let state = 'open';
  let outSwapped = false;

  const ensureOpen = () => {
    if (state !== 'open') {
      throw new Error(
        `pandamstyle: generation already ${state}; it cannot be reused.`,
      );
    }
  };

  const maybeFail = (point) => {
    if (failAt == null) return;
    if (typeof failAt === 'function') failAt(point);
    else if (failAt === point) {
      const err = new Error(
        `pandamstyle: injected publication failure at ${point}`,
      );
      err.code = 'PMS_INJECTED_PUBLICATION_FAILURE';
      throw err;
    }
  };

  const registerRecord = (rel, content, meta) => {
    const digest = meta.digest ?? sha256Of(content);
    const size = meta.size ?? byteLengthOf(content);
    const kind = kindOf(meta);
    records[rel] = {
      digest,
      size,
      owner: meta.owner ?? null,
      kind,
      generationId: meta.generationId ?? activeGenerationId,
    };
    return { digest, size, kind };
  };

  let writesSeen = 0;

  // `mkdir -p` once per directory rather than once per artifact. At 10,000
  // artifacts that is 10,000 syscalls that all do the same nothing after the
  // first one, and it was a measurable share of the reuse pass. The set is
  // bounded by the generation's directory count, not its artifact count, so it
  // does not grow with the thing this mode is trying to stop scaling.
  const madeDirs = new Set();
  const ensureDir = (rel) => {
    const dir = path.posix.dirname(rel.split(path.sep).join('/'));
    if (dir === '.' || madeDirs.has(dir)) return;
    madeDirs.add(dir);
    fs.mkdirSync(path.join(stagingDir, dir), { recursive: true });
  };

  const writeStaged = (rel, content) => {
    maybeFail('before-first-write');
    ensureDir(rel);
    const target = path.join(stagingDir, rel);
    fs.writeFileSync(target, content, 'utf8');
    staged.set(rel, target);
    writesSeen += 1;
    if (writesSeen === 2) {
      // Part way through the changed artifacts, not at either edge.
      maybeFail('mid-stage');
    }
    return target;
  };

  /**
   * Puts the previous generation's file at `rel` into staging without touching
   * its bytes. The file in the PREVIOUS generation is never opened for writing,
   * so the inode it shares is immutable for as long as either generation exists.
   */
  const linkStaged = (rel) => {
    const source = path.join(absOut, rel);
    ensureDir(rel);
    const target = path.join(stagingDir, rel);
    try {
      if (hardlinksAvailable(stagingDir)) {
        fs.linkSync(source, target);
        delta.hardlinks += 1;
        addCount('publication_hardlinks', 1);
      } else {
        fs.copyFileSync(source, target);
        delta.copies += 1;
        addCount('publication_copies', 1);
      }
    } catch (err) {
      // A link that fails for a reason other than "links unsupported here" -
      // ENOENT, EMLINK, a read-only source - must not lose the artifact.
      // Copying is always correct.
      try {
        fs.copyFileSync(source, target);
        delta.copies += 1;
        addCount('publication_copies', 1);
      } catch {
        throw err;
      }
    }
    staged.set(rel, target);
  };

  const api = {
    outDir: absOut,
    stagingDir,
    backupDir,
    statePath,
    commitMarker,
    /**
     * Digest of the previous generation's TREE.
     *
     * Computed on access, not eagerly. It used to be computed on every
     * `beginGeneration` - a full read of every published byte - and no
     * production caller ever read the result. Anything that genuinely needs it
     * (a test proving byte identity) still can; nothing pays for it otherwise.
     */
    get previousDigest() {
      return hadOutDir ? digestOfTree(absOut) : null;
    },
    hadPrevious: hadOutDir,
    recoveredFromCrash: recovered,
    /** Whether artifacts are being reused rather than rewritten. */
    delta: deltaActive,

    /**
     * Stages `content` at `rel`. It is INVISIBLE until commit: nothing in the
     * output directory changes during a generation.
     *
     * This is an unconditional write. `stageArtifact` below is the one that
     * reuses; the distinction is deliberate so the reference path stays literally
     * "write everything, every time".
     */
    stage(rel, content, meta = {}) {
      ensureOpen();
      markIoStart();
      const start = perfNow();
      const { size, kind, digest } = registerRecord(rel, content, meta);
      writeStaged(rel, content);

      // Full mode writes unconditionally, but it still knows what it did, and
      // reporting that is what makes it a MEASURABLE baseline rather than an
      // unmeasured one. The classification is from the content digest and the
      // previous file set, not from a guess.
      const isNew = !previousSet.has(rel);
      delta.bytesWritten += size;
      delta.byKind[kind].bytesWritten += size;
      if (isNew) {
        delta.added += 1;
        delta.byKind[kind].added += 1;
        addCount('output_files_added', 1);
      } else {
        delta.changed += 1;
        delta.byKind[kind].changed += 1;
        addCount('output_files_changed', 1);
      }
      addCount('output_bytes_written', size);
      addCount('write_calls', 1);
      addCount('written_bytes', size);
      addDuration('publish_materialize_ms', start);
      return { rel, reused: false, size, digest };
    },

    /**
     * Stages `rel` with the LEAST work that makes this generation correct.
     *
     * If the previous generation published this path with this same content
     * digest, the published file is already correct: it is linked into staging
     * and no byte is written. Otherwise it is written.
     *
     * `meta.digest` lets a caller that already knows the content hash - the
     * session hashes each file once, when it compiles it, and keeps the digest
     * with the contribution - avoid a second pass over the same bytes. Without
     * it the digest is computed here, which is still O(changed) but hashes the
     * same content twice over a session's lifetime.
     */
    stageArtifact(rel, content, meta = {}) {
      ensureOpen();
      markIoStart();
      const start = perfNow();
      const record = registerRecord(rel, content, meta);
      const previous = deltaActive ? previousRecords[rel] : null;
      const isNew = !previousSet.has(rel);

      if (previous != null && previous.digest === record.digest) {
        linkStaged(rel);
        delta.reused += 1;
        delta.bytesReused += previous.size ?? record.size;
        delta.byKind[record.kind].reused += 1;
        delta.byKind[record.kind].bytesReused += previous.size ?? record.size;
        addCount('output_files_reused', 1);
        addCount('output_bytes_reused', previous.size ?? record.size);
        addDuration('publish_materialize_ms', start);
        markIoEnd();
        return { rel, reused: true, size: record.size };
      }

      writeStaged(rel, content);
      delta.bytesWritten += record.size;
      delta.byKind[record.kind].bytesWritten += record.size;
      if (isNew) {
        delta.added += 1;
        delta.byKind[record.kind].added += 1;
        addCount('output_files_added', 1);
      } else {
        delta.changed += 1;
        delta.byKind[record.kind].changed += 1;
        addCount('output_files_changed', 1);
      }
      addCount('output_bytes_written', record.size);
      addCount('write_calls', 1);
      addCount('written_bytes', record.size);
      addDuration('publish_materialize_ms', start);
      markIoEnd();
      return { rel, reused: false, size: record.size };
    },

    /**
     * Explicitly drops `rel` from this generation. Not needed for the common
     * case - a path absent from both the records and this generation is removed
     * automatically - but an owner-driven removal is expressible directly.
     */
    reclaim(rel) {
      ensureOpen();
      delete records[rel];
    },

    /** Absolute final path of an artifact this generation will publish. */
    finalPath(rel) {
      return path.join(absOut, rel);
    },

    isStaged(rel) {
      return staged.has(rel);
    },

    /** The previous generation's records. Empty in full mode. */
    previousRecords() {
      return previousRecords ?? {};
    },

    /** This generation's records, as the state file will write them. */
    records() {
      return records;
    },

    /**
     * Publishes the staged payload.
     *
     * Full mode renames each staged artifact into the output directory, commit
     * marker last, and deletes whatever the previous generation left behind that
     * this one did not claim. Delta mode swaps the whole directory, so removals
     * are implicit and rollback is a rename.
     */
    commit() {
      ensureOpen();

      // `removed` first: it is a set difference over records, and the caller is
      // entitled to know what is about to disappear before it does.
      const removed = [];
      let bytesDeleted = 0;
      for (const rel of previousSet) {
        if (records[rel] === undefined) {
          removed.push(rel);
          const size = deltaActive ? (previousRecords[rel]?.size ?? 0) : 0;
          bytesDeleted += size;
          const kind =
            deltaActive && previousRecords[rel]?.kind != null
              ? previousRecords[rel].kind
              : 'other';
          delta.byKind[kind].removed += 1;
          delta.byKind[kind].bytesDeleted += size;
        }
      }
      delta.removed = removed.length;
      delta.bytesDeleted = bytesDeleted;
      addCount('output_files_removed', removed.length);
      addCount('output_bytes_deleted', bytesDeleted);

      markIoEnd();
      markIoStart();
      maybeFail('after-removals-computed');

      if (deltaActive) {
        return commitDelta(removed);
      }
      return commitFull(removed);
    },

    /**
     * Discards the generation. The current generation is restored byte for byte,
     * including a file this generation deleted.
     */
    rollback() {
      if (state !== 'open') return false;
      rmrf(stagingDir);
      if (outSwapped) {
        // The swap already retired the old generation into backupDir. Put it
        // back. Two renames, and the staged generation is discarded wholesale.
        try {
          fs.renameSync(absOut, stagingDir);
        } catch {
          /* nothing was installed; nothing to retract */
        }
        if (isDir(backupDir)) {
          try {
            fs.renameSync(backupDir, absOut);
          } catch {
            /* the backup is still on disk and recoverable */
          }
        }
      } else if (hadOutDir && isDir(backupDir)) {
        // Full mode holds a full copy of the current generation, so a rollback
        // is a restore: the output directory is replaced wholesale, including a
        // file something else deleted from it mid-generation.
        rmrf(absOut);
        copyTree(backupDir, absOut);
      }
      rmrf(stagingDir);
      rmrf(pendingStatePath);
      rmrf(backupDir);
      staged.clear();
      state = 'rolled-back';
      closeAggregate();
      return true;
    },

    get state() {
      return state;
    },
  };

  function orderedForCommit() {
    return [...staged.keys()].sort((a, b) => {
      if (a === commitMarker) return 1;
      if (b === commitMarker) return -1;
      return 0;
    });
  }

  function commitFull(removed) {
    const commitStart = perfNow();
    const ordered = orderedForCommit();
    for (const rel of ordered) {
      const target = path.join(absOut, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staged.get(rel), target);
    }
    staged.clear();

    // A deleted source must take its published output with it. This step did
    // not exist before Spike 3, which is why a removed module left its compiled
    // JavaScript on disk forever.
    for (const rel of removed) {
      const target = path.join(absOut, rel);
      try {
        fs.rmSync(target, { force: true });
      } catch {
        /* already gone; removal is idempotent */
      }
    }

    // A session that asked for delta publication but had no previous records
    // (its first generation, or one it did not write) publishes in full HERE and
    // then records what it published, so the NEXT generation is a real delta
    // one. Bootstrapping the record set is a one-time O(total) cost, paid once,
    // and it is the only way to avoid reading every published byte on every
    // revision to find out what they were.
    if (requestedDelta) {
      const metaStart = perfNow();
      writeJsonAtomic(statePath, {
        version: STATE_VERSION,
        generationId: activeGenerationId,
        revisionId,
        artifactRevisionIdentity: isRevisionIdentity(revisionIdentity)
          ? revisionIdentity
          : null,
        associationRevisionIdentity: isRevisionIdentity(revisionIdentity)
          ? revisionIdentity
          : null,
        artifactDigest: getGenerationArtifactDigest(),
        candidateDigest:
          typeof candidateDigest === 'string' ? candidateDigest : null,
        files: records,
      });
      addDuration('publish_metadata_ms', metaStart);
    }

    const cleanupStart = perfNow();
    rmrf(backupDir);
    rmrf(stagingDir);
    addDuration('publish_cleanup_ms', cleanupStart);
    state = 'committed';
    addDuration('publish_commit_ms', commitStart);
    closeAggregate();
    addCount('generation_materialized', 1);
    const outcome = {
      published: ordered,
      delta: { ...delta },
      removed,
      mode: 'full',
      generationReused: false,
      generationId: activeGenerationId,
      artifactRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      associationRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      artifactDigest: getGenerationArtifactDigest(),
      candidateDigest:
        typeof candidateDigest === 'string' ? candidateDigest : null,
    };
    if (typeof api.onCommitted === 'function') api.onCommitted(outcome);
    return outcome;
  }

  function commitDelta(removed) {
    // Nothing is written into the output directory until here. Everything above
    // this line is invisible; the current generation is still intact and
    // immutable.
    maybeFail('before-commit');

    const commitStart = perfNow();

    // A generation whose records are IDENTICAL to the current one is not
    // published at all: the current generation already IS that content, and
    // re-installing it would rewrite every artifact for no semantic change. The
    // revision is still recorded - a revision and a generation are not the same
    // thing, and a revision is not required to force a new generation.
    if (isByteIdenticalGeneration() && !forceNewGeneration) {
      const metaStart = perfNow();
      const artifactRevisionIdentity = isRevisionIdentity(
        previousState?.artifactRevisionIdentity,
      )
        ? previousState.artifactRevisionIdentity
        : null;
      const associationRevisionIdentity = isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : isRevisionIdentity(previousState?.associationRevisionIdentity)
          ? previousState.associationRevisionIdentity
          : null;
      const artifactDigest = getGenerationArtifactDigest();
      writeJsonAtomic(statePath, {
        ...(previousState ?? {}),
        version: STATE_VERSION,
        generationId: previousState?.generationId ?? null,
        revisionId,
        artifactRevisionIdentity,
        associationRevisionIdentity,
        artifactDigest,
        candidateDigest:
          typeof candidateDigest === 'string'
            ? candidateDigest
            : (previousState?.candidateDigest ?? null),
        files: records,
      });
      rmrf(stagingDir);
      staged.clear();
      state = 'committed';
      addDuration('publish_metadata_ms', metaStart);
      addDuration('publish_cleanup_ms', perfNow());
      closeAggregate();
      addCount('generation_reused', 1);
      return finishCommit({
        published: [],
        delta: { ...delta },
        removed,
        mode: 'delta',
        generationReused: true,
        generationId: previousGenerationId,
        artifactRevisionIdentity,
        associationRevisionIdentity,
        artifactDigest,
        candidateDigest:
          typeof candidateDigest === 'string'
            ? candidateDigest
            : (previousState?.candidateDigest ?? null),
      });
    }

    // 1. The generation is complete and its intent is now durable.
    const metaStart = perfNow();
    writeJsonAtomic(pendingStatePath, {
      version: STATE_VERSION,
      generationId: activeGenerationId,
      revisionId,
      artifactRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      associationRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      artifactDigest: getGenerationArtifactDigest(),
      candidateDigest:
        typeof candidateDigest === 'string' ? candidateDigest : null,
      files: records,
    });
    rmrf(backupDir);
    addDuration('publish_metadata_ms', metaStart);

    maybeFail('after-css-staged');
    maybeFail('before-manifest');

    // 2-3. Retire N, install N+1. Two renames. The previous generation stays
    // whole and untouched until step 5, which is what makes rollback a rename
    // instead of a restore.
    if (hadOutDir) {
      fs.renameSync(absOut, backupDir);
    }
    outSwapped = true;
    fs.renameSync(stagingDir, absOut);

    maybeFail('after-swap');
    maybeFail('before-commit-marker');

    // 4. N+1 becomes current.
    const promoteStart = perfNow();
    fs.renameSync(pendingStatePath, statePath);
    addDuration('publish_metadata_ms', promoteStart);
    addDuration('publish_commit_ms', commitStart);
    closeAggregate();

    // 5. Release N.
    const cleanupStart = perfNow();
    rmrf(backupDir);
    staged.clear();
    state = 'committed';
    addDuration('publish_cleanup_ms', cleanupStart);
    addCount('generation_materialized', 1);
    // The whole generation is published, so the published set is every record -
    // not just the ones that were written.
    return finishCommit({
      published: Object.keys(records).sort((a, b) => {
        if (a === commitMarker) return 1;
        if (b === commitMarker) return -1;
        return 0;
      }),
      delta: { ...delta },
      removed,
      mode: 'delta',
      generationReused: false,
      generationId: activeGenerationId,
      artifactRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      associationRevisionIdentity: isRevisionIdentity(revisionIdentity)
        ? revisionIdentity
        : null,
      artifactDigest: getGenerationArtifactDigest(),
      candidateDigest:
        typeof candidateDigest === 'string' ? candidateDigest : null,
    });
  }

  function finishCommit(outcome) {
    if (typeof api.onCommitted === 'function') api.onCommitted(outcome);
    return outcome;
  }

  /**
   * Is this generation byte-for-byte the one already published?
   *
   * Compared over the RECORDS, not the bytes: a record that was published and is
   * being re-published unchanged is, by construction, the same file. Re-reading
   * the output directory to find that out would be the O(total) read this mode
   * exists to avoid.
   */
  function isByteIdenticalGeneration() {
    if (!hadOutDir) return false;
    const previousKeys = Object.keys(previousRecords);
    const currentKeys = Object.keys(records);
    if (previousKeys.length !== currentKeys.length) return false;
    for (const rel of currentKeys) {
      const before = previousRecords[rel];
      if (before === undefined) return false;
      if (before.digest !== records[rel].digest) return false;
    }
    return true;
  }

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
