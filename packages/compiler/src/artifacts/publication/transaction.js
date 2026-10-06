/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Transactional publication of a compiler generation.
 *
 * The project service prepares generated files in a staging directory and
 * validates coverage and metadata before publication. The output directory is
 * not mutated during preparation, so a failed build leaves the current
 * generation available to readers.
 *
 * Full publication uses a snapshot for rollback. Delta publication may reuse
 * unchanged files, but does not modify the current generation in place. Commit
 * swaps complete directories and publishes the manifest last as the generation
 * marker.
 *
 * State files outside the output directory track the current artifact set and
 * the prepared transaction. The pending state file records commit intent so a
 * later session can recover an interrupted publication. Removed artifacts are
 * determined from the previous and prepared state records.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import { validateArtifactSet } from '../metadata/artifact-set';
import { Codes, PmsError, diagnostic } from '../../protocol/diagnostics';
import { sameRevisionIdentity } from '../../protocol/identities';
import * as path from 'path';
// Optional performance instrumentation hooks.
import { perfCollector, perfNow } from '../../observability/metrics';

/** Bumped when the on-disk record shape changes incompatibly. */
const STATE_VERSION = 1;

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyTree(from, to, entry = null) {
  // readdir already supplies the type. Follow symlinks as the prior stat-based
  // copier did, but do not stat every ordinary file a second time.
  const stat =
    entry != null && !entry.isSymbolicLink() ? entry : fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      copyTree(path.join(from, entry.name), path.join(to, entry.name), entry);
    }
    return;
  }
  fs.copyFileSync(from, to);
}

/** Every file below `dir`, as paths relative to `dir`. */
function listFiles(dir, base = dir, out = [], shape = null) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (shape != null) throw err;
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      shape?.directories.add(path.relative(base, full));
      listFiles(full, base, out, shape);
    } else if (entry.isFile()) out.push(path.relative(base, full));
    else if (shape != null) shape.regular = false;
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
  const tmp = `${target}.tmp`;
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

function safeRelativeTransactionPath(value) {
  const isWindows = process.platform === 'win32';
  if (
    typeof value !== 'string' ||
    value === '' ||
    value.includes('\0') ||
    path.isAbsolute(value) ||
    (isWindows && path.win32.isAbsolute(value))
  ) {
    return false;
  }
  const parts = value.split(/[\\/]/);
  return (
    parts.length > 0 &&
    parts.every((part) => {
      // Win32 trims spaces and dots in special components. Check common
      // trimming orders for traversal aliases without rejecting POSIX names.
      const trimmedSpaces = part.replace(/ +$/g, '');
      const trimmedDotsAndSpaces = part
        .replace(/\.+$/g, '')
        .replace(/ +$/g, '');
      const win32TraversalAlias =
        isWindows &&
        (trimmedSpaces === '.' ||
          trimmedSpaces === '..' ||
          trimmedDotsAndSpaces === '.' ||
          trimmedDotsAndSpaces === '..' ||
          /^\.\.[. ]*$/.test(part));
      return (
        part !== '' &&
        part !== '.' &&
        part !== '..' &&
        !win32TraversalAlias &&
        (!isWindows || !/^[a-z]:/i.test(part))
      );
    })
  );
}

function assertSafeTransactionPath(
  root,
  relative,
  { includeLeaf = false, requireLeaf = false } = {},
) {
  const parts = relative.split(/[\\/]/);
  let current = root;
  const limit = includeLeaf ? parts.length : parts.length - 1;
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        if (requireLeaf) {
          throw new Error(
            'pandamstyle: invalid publication transaction journal',
          );
        }
        return;
      }
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 && !stat.isDirectory()) ||
      (includeLeaf && index === parts.length - 1 && !stat.isFile())
    ) {
      throw new Error('pandamstyle: invalid publication transaction journal');
    }
  }
}

function assertSafeUndoTransaction(absOut, paths, transaction) {
  if (
    typeof transaction.hadOutDir !== 'boolean' ||
    !Array.isArray(transaction.newFiles) ||
    !Array.isArray(transaction.newDirectories) ||
    !Array.isArray(transaction.backupFiles) ||
    [
      ...transaction.newFiles,
      ...transaction.newDirectories,
      ...transaction.backupFiles,
    ].some((relative) => !safeRelativeTransactionPath(relative))
  ) {
    throw new Error('pandamstyle: invalid publication transaction journal');
  }

  if (transaction.hadOutDir) {
    let outputStat;
    try {
      outputStat = fs.lstatSync(absOut);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (
      outputStat == null ||
      outputStat.isSymbolicLink() ||
      !outputStat.isDirectory()
    ) {
      throw new Error('pandamstyle: invalid publication transaction journal');
    }
  }

  for (const relative of transaction.newFiles) {
    assertSafeTransactionPath(absOut, relative);
  }
  for (const relative of transaction.newDirectories) {
    assertSafeTransactionPath(absOut, relative);
  }

  if (transaction.backupFiles.length > 0) {
    let backupStat;
    try {
      backupStat = fs.lstatSync(paths.backupDir);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (
      backupStat != null &&
      (backupStat.isSymbolicLink() || !backupStat.isDirectory())
    ) {
      throw new Error('pandamstyle: invalid publication transaction journal');
    }
  }
  for (const relative of transaction.backupFiles) {
    assertSafeTransactionPath(absOut, relative);
    assertSafeTransactionPath(paths.backupDir, relative, {
      includeLeaf: true,
      requireLeaf: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Reuse unchanged artifacts.
//
// Reuse is `link()`, not `copyFileSync`, to avoid writing unchanged artifacts.
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

// A full publication has one authoritative disk phase until scratch is gone.
// Backup existence alone cannot distinguish partial backup from partial cleanup.
function restoreFullTransaction(absOut, paths, transaction) {
  perfCollector()?.addCount('publication_restore_transactions', 1);
  if (transaction.strategy === 'snapshot') {
    if (transaction.hadOutDir) {
      // Build the complete restoration before removing any live bytes. Keep the
      // immutable backup until restoration AND cleanup have succeeded.
      rmrf(paths.stagingDir);
      copyTree(paths.backupDir, paths.stagingDir);
      rmrf(absOut);
      fs.renameSync(paths.stagingDir, absOut);
    } else {
      rmrf(absOut);
    }
    if (transaction.restoreState) {
      if (transaction.previousState == null) rmrf(paths.statePath);
      else writeJsonAtomic(paths.statePath, transaction.previousState);
    }
    return;
  }
  assertSafeUndoTransaction(absOut, paths, transaction);
  if (!transaction.hadOutDir) {
    rmrf(absOut);
    return;
  }
  rmrf(paths.stagingDir);
  for (const rel of transaction.newFiles) {
    fs.rmSync(path.join(absOut, rel), { force: true });
  }
  // Retract additions' empty directories before restoring a file at the same
  // path. Retained directories are never removed by undo.
  for (const rel of transaction.newDirectories) {
    try {
      fs.rmdirSync(path.join(absOut, rel));
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY') throw err;
    }
  }
  for (const rel of transaction.backupFiles) {
    const tmp = path.join(paths.stagingDir, rel);
    const target = path.join(absOut, rel);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(paths.backupDir, rel), tmp);
    fs.renameSync(tmp, target);
    perfCollector()?.addCount('publication_restore_copies', 1);
    perfCollector()?.addCount('publication_restore_renames', 1);
  }
}

function cleanupFullTransaction(paths) {
  rmrf(paths.backupDir);
  rmrf(paths.stagingDir);
  rmrf(`${paths.pendingStatePath}.tmp`);
  // The journal is removed LAST: interrupted cleanup cannot trigger undo from
  // a backup that has already been partly released.
  rmrf(paths.pendingStatePath);
}

function reconcileInterruptedGeneration(absOut, paths = scratchPaths(absOut)) {
  let recovered = false;
  // An unreadable/malformed intent must stop recovery, never masquerade as no
  // intent and cause a partial backup to replace the live generation.
  const pending = fs.existsSync(paths.pendingStatePath)
    ? JSON.parse(fs.readFileSync(paths.pendingStatePath, 'utf8'))
    : null;
  const hasOut = isDir(absOut);
  const hasBackup = isDir(paths.backupDir);
  const hasStaging = isDir(paths.stagingDir);

  if (pending?.transaction != null) {
    const transaction = pending.transaction;
    if (
      transaction.version !== 1 ||
      !['snapshot', 'undo'].includes(transaction.strategy) ||
      !['backing-up', 'ready', 'committed', 'rolled-back'].includes(
        transaction.phase,
      )
    )
      throw new Error('pandamstyle: invalid publication transaction journal');
    if (transaction.phase === 'ready') {
      restoreFullTransaction(absOut, paths, transaction);
      writeJsonAtomic(paths.pendingStatePath, {
        transaction: { ...transaction, phase: 'rolled-back' },
      });
    }
    cleanupFullTransaction(paths);
    perfCollector()?.addCount('publication_recovery_transactions', 1);
    recovered = true;
  } else if (pending != null) {
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
    writeJsonAtomic(paths.statePath, pending);
    rmrf(paths.backupDir);
    rmrf(paths.pendingStatePath);
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

  rmrf(`${paths.pendingStatePath}.tmp`);
  rmrf(`${paths.statePath}.tmp`);

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
 * Read-only accepted-byte handoff owned by the canonical publisher. Bind every
 * requested member, including metadata bytes, to the actual durable receipt.
 * This performs no crash recovery, publication, or semantic reconstruction.
 */
export function readPublishedGenerationMembers(outDir, receipt, memberFiles) {
  const absOut = path.resolve(outDir);
  const { statePath } = scratchPaths(absOut);
  const mismatch = (reason, file = null) => {
    throw new PmsError([
      diagnostic({
        code: Codes.GENERATED_ARTIFACT_MISMATCH,
        phase: 'artifacts',
        rule: 'publication.accepted-member',
        message: `Accepted canonical publication mismatch: ${reason}.`,
        context: { reason, file },
      }),
    ]);
  };
  let stateText;
  let state;
  try {
    stateText = fs.readFileSync(statePath, 'utf8');
    state = JSON.parse(stateText);
  } catch {
    mismatch('durable publication records are missing');
  }
  if (
    state?.version !== STATE_VERSION ||
    state.files == null ||
    state.generationId !== receipt?.generationId ||
    state.artifactDigest !== receipt?.artifactDigest ||
    artifactDigestOf(state.files) !== receipt?.artifactDigest ||
    !sameRevisionIdentity(
      state.artifactRevisionIdentity,
      receipt?.artifactRevision,
    ) ||
    !sameRevisionIdentity(
      state.associationRevisionIdentity,
      receipt?.associationRevision,
    )
  ) {
    mismatch('receipt differs from durable publication records');
  }
  const members = memberFiles.map((file) => {
    if (
      typeof file !== 'string' ||
      file === '' ||
      file.includes('\\') ||
      path.posix.isAbsolute(file) ||
      file
        .split('/')
        .some((part) => part === '.' || part === '..' || part === '')
    )
      mismatch('unsafe canonical member path', file);
    const record = state.files[file];
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(absOut, file));
    } catch {
      mismatch('canonical member is missing', file);
    }
    const content = bytes.toString('utf8');
    if (
      record == null ||
      record.size !== bytes.length ||
      record.digest !== sha256Of(bytes) ||
      !Buffer.from(content, 'utf8').equals(bytes)
    )
      mismatch(
        'canonical member bytes differ from durable publication records',
        file,
      );
    return Object.freeze({ file, content });
  });
  if (fs.readFileSync(statePath, 'utf8') !== stateText)
    mismatch('durable publication changed during snapshot read');
  return Object.freeze(members);
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
    // 'full'  - stage a complete artifact set for every revision.
    // 'delta' - reuse the previous generation's unchanged artifacts by link.
    mode = 'full',
    // Identity of the generation being built, recorded in the state file so a
    // later process can tell "revision N" from "generation N".
    generationId = null,
    revisionId = null,
    revisionIdentity = null,
    candidateDigest = null,
    // Session publication can retain exact existing bytes without trusting a
    // prior digest record. Fresh full builds keep unconditional staging.
    skipIdentical = false,
    // Internal session capability. General callers keep the complete
    // opening snapshot, including protection against unrelated external writes.
    incrementalBackup = false,
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

  // `publish_ms` covers the transaction from opening through cleanup. The
  // sub-phase measurements are nested within it and must not be added to it.
  const openStart = perfNow();
  // `publish_io_ms` measures transaction-owned work. `publish_ms` also includes
  // work performed by the caller inside the transaction callback.
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
  if (!hadOutDir) {
    // A first-build rollback owns only a root that was absent when it opened.
    // Reject an existing file or dangling link before recording that absence;
    // otherwise undo could remove unrelated bytes after mkdir/rename fails.
    let existingRoot = null;
    try {
      existingRoot = fs.lstatSync(absOut);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (existingRoot != null) {
      throw new Error('pandamstyle: output path exists and is not a directory');
    }
  }
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
  const shape = { regular: true, directories: new Set() };
  if (hadOutDir && incrementalBackup && fs.lstatSync(absOut).isSymbolicLink())
    shape.regular = false;
  const previousSet = hadOutDir
    ? deltaActive
      ? new Set(Object.keys(previousRecords))
      : new Set(listFiles(absOut, absOut, [], shape))
    : new Set();
  const undoActive = incrementalBackup && !requestedDelta && shape.regular;
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
  let transaction = null;
  const setTransactionPhase = (phase) => {
    const next = { ...transaction, phase };
    writeJsonAtomic(pendingStatePath, { transaction: next });
    transaction = next;
  };

  // Full mode snapshots the current generation before touching anything, so
  // rollback and crash recovery can restore it.
  //
  // Delta mode takes none. It renames the current generation into the backup
  // directory at commit time instead, which is O(1) and cannot lose a byte -
  // which is precisely the O(total) work this mode exists to remove.
  if (!deltaActive && !undoActive) {
    transaction = {
      version: 1,
      id: `${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
      strategy: 'snapshot',
      hadOutDir,
      restoreState: requestedDelta,
      previousState: requestedDelta ? previousState : null,
    };
    maybeFail('before-backup');
    setTransactionPhase('backing-up');
    rmrf(backupDir);
    // A partial snapshot must never look like a recoverable backup. Reuse the
    // uncommitted staging namespace, which recovery discards without intent,
    // and promote it to backup only after every copy succeeds.
    rmrf(stagingDir);
    try {
      if (hadOutDir) {
        copyTree(absOut, stagingDir);
        fs.renameSync(stagingDir, backupDir);
      }
      setTransactionPhase('ready');
      maybeFail('after-backup');
    } catch (err) {
      // If backup completed, ordinary recovery can restore it. Otherwise live
      // output is untouched and backing-up recovery discards partial scratch.
      reconcileInterruptedGeneration(absOut);
      throw err;
    }
  }

  const staged = new Map();
  const retained = new Map();
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
  const repairedRetained = new Map();

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

  const matchesPublishedBytes = (rel, content) => {
    try {
      const bytes =
        typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      return fs.readFileSync(path.join(absOut, rel)).equals(bytes);
    } catch {
      // Missing, unreadable, or changed output must be staged normally.
      return false;
    }
  };

  const refreshRetained = () => {
    for (const [rel, { content, size, kind }] of retained) {
      if (matchesPublishedBytes(rel, content)) continue;
      // Undo must restore the accepted original bytes, rather than the later
      // externally corrupted/deleted version discovered by this recheck.
      repairedRetained.set(rel, content);
      writeStaged(rel, content);
      retained.delete(rel);
      delta.reused--;
      delta.bytesReused -= size;
      delta.byKind[kind].reused--;
      delta.byKind[kind].bytesReused -= size;
      delta.changed++;
      delta.bytesWritten += size;
      delta.byKind[kind].changed++;
      delta.byKind[kind].bytesWritten += size;
      addCount('output_files_reused', -1);
      addCount('output_bytes_reused', -size);
      addCount('output_files_changed', 1);
      addCount('output_bytes_written', size);
      addCount('write_calls', 1);
      addCount('written_bytes', size);
    }
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
     * Fresh full builds write unconditionally. A session may opt into exact
     * byte comparison: identical members stay in place, independently of the
     * session's contribution digests. The publisher selects its rollback source.
     */
    stage(rel, content, meta = {}) {
      ensureOpen();
      markIoStart();
      const start = perfNow();
      const { size, kind, digest } = registerRecord(rel, content, meta);
      if (
        skipIdentical &&
        !requestedDelta &&
        hadOutDir &&
        matchesPublishedBytes(rel, content)
      ) {
        staged.set(rel, path.join(absOut, rel));
        retained.set(rel, {
          content: typeof content === 'string' ? content : Buffer.from(content),
          size,
          kind,
        });
        delta.reused++;
        delta.bytesReused += size;
        delta.byKind[kind].reused++;
        delta.byKind[kind].bytesReused += size;
        addCount('output_files_reused', 1);
        addCount('output_bytes_reused', size);
        addDuration('publish_materialize_ms', start);
        maybeFail(`after-stage:${rel}`);
        return { rel, reused: true, size, digest };
      }
      writeStaged(rel, content);

      // A member not retained writes unconditionally and records actual work,
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
      maybeFail(`after-stage:${rel}`);
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
        let linked = false;
        try {
          linkStaged(rel);
          linked = true;
        } catch (err) {
          // The durable record may outlive a deleted output member. Repair it
          // from authoritative compiler bytes, without adding existence probes
          // to the normal reuse path. Other filesystem failures still abort.
          if (err.code !== 'ENOENT') throw err;
        }
        if (linked) {
          delta.reused += 1;
          delta.bytesReused += previous.size ?? record.size;
          delta.byKind[record.kind].reused += 1;
          delta.byKind[record.kind].bytesReused += previous.size ?? record.size;
          addCount('output_files_reused', 1);
          addCount('output_bytes_reused', previous.size ?? record.size);
          addDuration('publish_materialize_ms', start);
          markIoEnd();
          maybeFail(`after-stage:${rel}`);
          return { rel, reused: true, size: record.size };
        }
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
      maybeFail(`after-stage:${rel}`);
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
      staged.delete(rel);
      retained.delete(rel);
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
      // Repair members deleted or modified after preparation before validating
      // canonical metadata. Reuse never means trusting stale on-disk bytes.
      refreshRetained();
      // Check actual staged canonical members before durable commit intent.
      // Both service and independent oracle use this single publisher.
      if (staged.has('artifacts.json')) {
        const metadata = JSON.parse(
          fs.readFileSync(staged.get('artifacts.json'), 'utf8'),
        );
        const contents = {};
        for (const [name, record] of Object.entries(metadata.artifacts ?? {})) {
          const file = staged.get(record.file);
          contents[name] = file == null ? null : fs.readFileSync(file, 'utf8');
        }
        validateArtifactSet(metadata, contents);
        if (
          sha256Of(fs.readFileSync(staged.get('artifacts.json'), 'utf8')) !==
          records['artifacts.json'].digest
        ) {
          throw new Error(
            'pandamstyle: staged artifact metadata changed after preparation',
          );
        }
      }

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
      if (outSwapped) {
        // Preserve a durable rollback intent before retracting an installed
        // delta root. Copies on this exceptional path keep the retired root
        // intact if restoration itself is interrupted or denied by the OS.
        transaction = {
          version: 1,
          id: `${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
          strategy: 'snapshot',
          hadOutDir,
          restoreState: true,
          previousState,
        };
        setTransactionPhase('ready');
        outSwapped = false;
      }
      if (transaction != null) {
        if (transaction.phase === 'ready') {
          restoreFullTransaction(
            absOut,
            {
              stagingDir,
              backupDir,
              pendingStatePath,
              statePath,
            },
            transaction,
          );
          setTransactionPhase('rolled-back');
        }
        cleanupFullTransaction({ stagingDir, backupDir, pendingStatePath });
        staged.clear();
        retained.clear();
        state = 'rolled-back';
        closeAggregate();
        return true;
      }
      if (undoActive) {
        // No journal means no publication mutation has been allowed yet.
        rmrf(stagingDir);
        staged.clear();
        retained.clear();
        state = 'rolled-back';
        closeAggregate();
        return true;
      }
      // Delta preparation has not retired any root yet. Its pending intent and
      // staging can be discarded without touching the current generation.
      rmrf(stagingDir);
      rmrf(pendingStatePath);
      rmrf(backupDir);
      staged.clear();
      retained.clear();
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
    maybeFail('before-commit');
    if (undoActive) prepareUndo(ordered, removed);
    maybeFail('after-css-staged');
    const commitDirs = new Set();
    // Obsolete members must be gone before the manifest certifies the new set.
    // An actual removal failure is a publication failure, not "already gone".
    for (const rel of removed) {
      maybeFail(`before-remove:${rel}`);
      fs.rmSync(path.join(absOut, rel), { force: true });
      maybeFail(`after-remove:${rel}`);
    }
    for (const rel of ordered) {
      if (rel === commitMarker) {
        maybeFail('before-manifest');
        maybeFail('before-commit-marker');
      }
      if (retained.has(rel)) continue;
      const target = path.join(absOut, rel);
      const dir = path.dirname(target);
      if (!commitDirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        commitDirs.add(dir);
      }
      fs.renameSync(staged.get(rel), target);
      addCount('publication_live_renames', 1);
      maybeFail(`after-publish:${rel}`);
    }
    maybeFail('after-manifest');

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

    // The journal remains until release is complete. A post-commit cleanup
    // error cannot turn an accepted generation into a rollback of released data.
    setTransactionPhase('committed');
    state = 'committed';
    const cleanupStart = perfNow();
    try {
      maybeFail('before-cleanup');
      cleanupFullTransaction({ stagingDir, backupDir, pendingStatePath });
    } catch {
      addCount('publication_cleanup_deferred', 1);
    }
    staged.clear();
    retained.clear();
    addDuration('publish_cleanup_ms', cleanupStart);
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

  function prepareUndo(ordered, removed) {
    const start = perfNow();
    maybeFail('before-backup');
    const dirty = ordered.filter((rel) => !retained.has(rel));
    // Full publication cannot rename a file over an existing directory. Refuse
    // that unsupported replacement before removing any of its old children;
    // the live tree then stays whole without needing undo of directory shape.
    if (dirty.some((rel) => shape.directories.has(rel))) {
      throw new Error('pandamstyle: artifact replaces an output directory');
    }
    const backupFiles = [
      ...new Set([...dirty.filter((rel) => previousSet.has(rel)), ...removed]),
    ].sort((a, b) => (a === commitMarker ? 1 : b === commitMarker ? -1 : 0));
    const directories = new Set();
    for (const rel of dirty) {
      let dir = path.dirname(rel);
      while (dir !== '.') {
        if (!shape.directories.has(dir)) directories.add(dir);
        dir = path.dirname(dir);
      }
    }
    transaction = {
      version: 1,
      id: `${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
      strategy: 'undo',
      hadOutDir,
      backupFiles,
      newFiles: dirty.filter((rel) => !previousSet.has(rel)),
      newDirectories: [...directories].sort((a, b) => b.length - a.length),
    };
    setTransactionPhase('backing-up');
    fs.mkdirSync(backupDir, { recursive: true });
    const dirs = new Set();
    for (const rel of backupFiles) {
      const target = path.join(backupDir, rel);
      const dir = path.dirname(target);
      if (!dirs.has(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        dirs.add(dir);
      }
      maybeFail(`before-backup:${rel}`);
      let size;
      if (repairedRetained.has(rel)) {
        const content = repairedRetained.get(rel);
        fs.writeFileSync(target, content);
        size = byteLengthOf(content);
      } else {
        const source = path.join(absOut, rel);
        size = fs.statSync(source).size;
        fs.copyFileSync(source, target);
        addCount('publication_backup_copies', 1);
      }
      addCount('publication_backup_files', 1);
      addCount('publication_backup_bytes', size);
      maybeFail(`after-backup:${rel}`);
    }
    // This atomic phase change is the only permission to mutate live output.
    setTransactionPhase('ready');
    addDuration('publish_backup_ms', start);
    maybeFail('after-backup');
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
    if (
      delta.added === 0 &&
      delta.changed === 0 &&
      isByteIdenticalGeneration() &&
      !forceNewGeneration
    ) {
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
      state = 'committed';
      try {
        rmrf(stagingDir);
      } catch {
        addCount('publication_cleanup_deferred', 1);
      }
      staged.clear();
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
    // Keep the intent until backup release succeeds, so restart can still
    // distinguish installed N+1 from an uncommitted full snapshot.
    writeJsonAtomic(statePath, readJsonIfPresent(pendingStatePath));
    addDuration('publish_metadata_ms', promoteStart);
    addDuration('publish_commit_ms', commitStart);
    closeAggregate();

    // 5. Release N.
    const cleanupStart = perfNow();
    state = 'committed';
    try {
      maybeFail('before-cleanup');
      rmrf(backupDir);
      rmrf(pendingStatePath);
    } catch {
      addCount('publication_cleanup_deferred', 1);
    }
    staged.clear();
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
    return Promise.resolve(value)
      .then((resolved) => {
        gen.commit();
        return resolved;
      })
      .catch((err) => {
        gen.rollback();
        throw err;
      });
  }
  try {
    gen.commit();
  } catch (err) {
    gen.rollback();
    throw err;
  }
  return value;
}

/** Digest of a directory tree, used by the tests to prove byte identity. */
export { digestOfTree, listFiles };
