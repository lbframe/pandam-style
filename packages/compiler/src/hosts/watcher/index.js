/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - FILESYSTEM WATCHER AS A DIRTY-INPUT PROVIDER (Spike 4, Phase B).
 *
 * WHAT THIS IS FOR
 *
 * The watcher is the FALLBACK discovery mechanism, not the canonical architecture
 * for an AI agent. An agent knows which file it wrote because it just wrote it;
 * a watcher exists for the environments where that is not true - an editor, a
 * `git checkout`, another tool, a process the agent did not drive.
 *
 * So the watcher is treated as what it is: a good LISTENER and a poor PROOF. It
 * is trusted exactly as far as `verified-explicit` is trusted and no further,
 * and every way it can be wrong ends in the same place - a full-discovery
 * fallback, counted and named.
 *
 * THE FOUR WAYS A WATCHER IS WRONG, AND WHAT HAPPENS
 *
 *   overflow / event loss    the kernel dropped events. The journal is not
 *                            trustworthy and cannot say what it missed, so it
 *                            says so: `resyncRequired`.
 *   the watch failed to start a watch that was never established is not a
 *                            watch, and pretending otherwise would make a
 *                            session silently publish stale generations.
 *   the backend resynced     the backend says its own view was rebuilt. Same
 *                            answer: resync.
 *   the process restarted    the journal is gone. A cold initialisation
 *                            performs a full discovery, and the watcher does not
 *                            pretend it can reconstruct what happened while it
 *                            was not running.
 *
 * COALESCING
 *
 * Editors and agent tools write in bursts: a temporary file, a rename, a
 * rewrite, a chmod, a second save, all inside a few milliseconds. Each of those
 * is a separate event and none of them is a revision. Events are therefore
 * folded into one transaction per flush, and a flush is either a debounce window
 * expiring or an explicit `flush()`.
 *
 * The window is deliberately NOT how correctness is decided - it is how many
 * revisions are produced. `flush()` is exposed so a test can drive the journal
 * without sleeping, and a host that wants one revision per write can flush on
 * its own cadence.
 *
 * A burst is never merged ACROSS an explicit agent transaction boundary. An
 * agent transaction is a revision the caller chose; folding an unrelated watch
 * event into it would publish a generation that includes a change the caller
 * never asked about.
 *
 * THE OUTPUT LOOP, AND WHY IT IS AN OWNERSHIP RULE
 *
 * PandamStyle writes a generation on every publication. A watcher that saw its
 * own output would invalidate the files it just published and republish them
 * forever. The guard is an explicit set of excluded PATHS - the output directory
 * and the transaction's scratch siblings - and not a string filter on names,
 * because a project can legitimately contain a directory called `generated` that
 * has nothing to do with this compiler's output.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Event kinds the journal understands. */
const KINDS = Object.freeze({
  CREATED: 'create',
  MODIFIED: 'modify',
  DELETED: 'delete',
  RENAMED: 'rename',
});

/** The scratch siblings a transaction creates next to the output directory. */
export function generationScratchPaths(outDir) {
  const abs = path.resolve(outDir);
  const parent = path.dirname(abs);
  const base = path.basename(abs);
  return [
    path.join(parent, `.${base}.pms-staging`),
    path.join(parent, `.${base}.pms-backup`),
    path.join(parent, `.${base}.pms-state.json`),
    path.join(parent, `.${base}.pms-state.pending.json`),
  ];
}

/**
 * A journal of filesystem events, folded into mutation transactions.
 *
 * It is deliberately usable with no watch attached: `record()` can be called
 * directly, which is how the tests drive every coalescing and overflow case
 * without a timer, a sleep, or a real filesystem race.
 */
export function createChangeJournal({
  debounceMs = 50,
  maxPending = 10000,
  exclude = [],
  known: initiallyKnown = null,
  digests = null,
} = {}) {
  /** path -> { kind, at } for events seen since the last flush. */
  const pending = new Map();
  /**
   * What the journal believes is already on disk.
   *
   * This is what separates a CREATE from a MODIFY, and it is the one piece of
   * state a bare filesystem event cannot carry: `fs.watch` reports "something
   * happened at this path" and never "that path is new". A host seeds the set
   * from its project listing; the journal then maintains it across bursts, so
   * each burst is classified against what came before it rather than against a
   * filesystem snapshot taken inside the burst.
   */
  const known = initiallyKnown == null ? new Set() : new Set(initiallyKnown);
  /**
   * Content digests for paths the journal believes are on disk, supplied by a
   * host that already has them - a compiler session does, for every file it has
   * ever read.
   *
   * This is what makes rename detection exact for free. Comparing the content of
   * a moved file is impossible once it has moved: the old path is gone, which is
   * the entire reason a rename is hard to recognise. A digest captured BEFORE
   * the move is the only evidence that survives it, and the host that already
   * paid to hash every file is holding exactly that.
   */
  const knownDigests = new Map(digests ?? []);
  /** The transaction the next flush will produce. */
  const stats = {
    events: 0,
    coalesced: 0,
    ignored: 0,
    overflows: 0,
    flushes: 0,
  };
  let resyncRequired = false;
  let resyncReason = null;
  let timer = null;
  let onFlush = null;
  let onResync = null;
  let closed = false;
  const pendingLimit =
    Number.isInteger(maxPending) && maxPending >= 0 ? maxPending : 10000;

  const excluded = exclude.filter(Boolean).map((p) => path.resolve(p));

  const isExcluded = (file) => {
    for (const dir of excluded) {
      if (file === dir) return true;
      if (file.startsWith(dir + path.sep)) return true;
    }
    return false;
  };

  const note = (name, eventType) => {
    if (closed || resyncRequired) {
      stats.ignored += 1;
      return;
    }
    // `fs.watch` reports a path RELATIVE to the watched directory, and a null
    // name when the platform cannot say. A null name is an event we cannot
    // attribute, and an unattributable event is exactly the case a resync exists
    // for.
    if (typeof name !== 'string' || name === '') {
      // A null or empty name means the backend cannot say which path. An
      // event nobody can attribute is precisely the case a resync exists for.
      requireResync('unattributable-event');
      return;
    }
    const file = path.resolve(name);
    if (isExcluded(file)) {
      stats.ignored += 1;
      return;
    }
    stats.events += 1;
    const existing = pending.get(file);
    if (existing !== undefined) {
      // Two events for one path in one burst. The LATER, more specific kind
      // wins: a create followed by a modify is a create that was written to, and
      // a create followed by a delete is a burst that cancelled out.
      stats.coalesced += 1;
      pending.set(file, {
        kind: mergeKinds(existing.kind, classify(file, eventType)),
        at: existing.at,
      });
      return;
    }
    if (pending.size >= pendingLimit) {
      requireResync('buffer-overflow');
      return;
    }
    pending.set(file, { kind: classify(file, eventType), at: Date.now() });
  };

  /**
   * Which kind a path is, from what the backend said AND what is there now.
   *
   * `fs.watch` distinguishes two event types and both of them matter. `change`
   * is a file that was rewritten, so it is a modification whether or not the
   * journal had heard of it. `rename` is the backend admitting it does not know
   * what moved, and the only way to tell a creation from a rename is to ask
   * whether the path was already known.
   *
   * Existence is asked once per path per burst, not once per event, which is why
   * a six-event save does not stat the same file six times.
   */
  const classify = (file, eventType) => {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (stat == null) return KINDS.DELETED;
    if (eventType === 'rename' && !known.has(file)) return KINDS.CREATED;
    if (stat.isFile()) return KINDS.MODIFIED;
    return KINDS.CREATED;
  };

  function mergeKinds(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    if (a === b) return a;
    // A burst that both created and deleted a path ends in a deletion: there is
    // nothing there, and reporting a change to a file that does not exist would
    // make the session look for content that cannot be read.
    if (a === KINDS.CREATED && b === KINDS.DELETED) return KINDS.DELETED;
    if (a === KINDS.DELETED && b === KINDS.CREATED) return KINDS.CREATED;
    return b;
  }

  function requireResync(reason) {
    if (!resyncRequired) {
      resyncRequired = true;
      resyncReason = reason;
      stats.overflows += 1;
    }
    // A resync supersedes everything the journal was holding: the journal cannot
    // say what it missed, so what it did see is not a complete picture and must
    // not be presented as one.
    pending.clear();
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onResync != null) onResync(resyncReason);
  }

  const journal = {
    KINDS,

    /**
     * Feeds one raw event, exactly as `fs.watch` reports it: a path and an
     * event type of `'rename'` or `'change'`.
     */
    record(name, eventType = 'change') {
      note(name, eventType);
    },

    /** Feeds a burst, as an editor or a tool produces one. */
    recordAll(names, eventType = 'change') {
      for (const n of names) note(n, eventType);
    },

    /** Tells the journal what is already on disk, before the first event. */
    seed(paths) {
      for (const p of paths) known.add(path.resolve(p));
    },

    /** Records the digest of a path the journal already knows about. */
    rememberDigest(file, digest) {
      if (file == null || digest == null) return;
      knownDigests.set(path.resolve(file), digest);
    },

    /**
     * Folds the burst into one transaction and returns it, or null when there is
     * nothing to say.
     *
     * A resync takes precedence: the transaction is `null` and
     * `resyncRequired` is true, because a partial transaction is worse than an
     * absent one - a host that acted on it would publish a generation missing
     * whatever the overflow swallowed.
     */
    flush() {
      if (closed) return null;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (resyncRequired) return null;
      if (pending.size === 0) return null;
      stats.flushes += 1;

      const changed = [];
      const added = [];
      const removed = [];
      // Existence is decided once, here, for the whole burst.
      for (const [file, entry] of pending) {
        const kind = entry.kind;
        if (kind === KINDS.DELETED) removed.push(file);
        else if (kind === KINDS.CREATED) added.push(file);
        else changed.push(file);
      }
      pending.clear();

      // A rename, where the backend lets us see one, is a deletion and a
      // creation that share their content. Pairing them is not a guess about
      // identity: two paths with the same content digest ARE the same file
      // moved, and a rename that is not detected degrades to the correct
      // remove-plus-add, which is what the session does internally anyway.
      const renamed = [];
      if (added.length > 0 && removed.length > 0) {
        for (const from of [...removed]) {
          const fromDigest = knownDigests.get(from);
          if (fromDigest == null) continue;
          const match = added.find((to) => digestOf(to) === fromDigest);
          if (match === undefined) continue;
          removed.splice(removed.indexOf(from), 1);
          added.splice(added.indexOf(match), 1);
          renamed.push({ from, to: match });
        }
      }

      // What is on disk has changed, and the next burst is classified against
      // that. Without this, a file added in one burst would still look new in
      // the next one, and every subsequent save of it would be reported as an
      // addition.
      for (const file of added) {
        known.add(file);
        knownDigests.set(file, digestOf(file));
      }
      for (const file of changed) known.add(file);
      for (const file of removed) {
        known.delete(file);
        knownDigests.delete(file);
      }
      for (const { from, to } of renamed) {
        known.delete(from);
        known.add(to);
        knownDigests.set(to, knownDigests.get(from));
        knownDigests.delete(from);
      }

      return {
        mode: 'watcher',
        changed,
        added,
        removed,
        renamed,
        forceFullDiscovery: false,
        stats: { ...stats },
      };
    },

    /** Arms a debounce window, if one is configured. */
    arm() {
      if (closed || resyncRequired || debounceMs <= 0 || timer != null) return;
      timer = setTimeout(() => {
        timer = null;
        const transaction = journal.flush();
        if (transaction != null && onFlush != null) onFlush(transaction);
      }, debounceMs);
      if (typeof timer.unref === 'function') timer.unref();
    },

    /** The journal overflowed, or a watch failed, and cannot be trusted. */
    get resyncRequired() {
      return resyncRequired;
    },
    get resyncReason() {
      return resyncReason;
    },

    /** Declares the journal untrustworthy, for an overflow the backend reported. */
    requireResync(reason) {
      requireResync(reason);
    },

    /** A host that wants a transaction per flush instead of per window. */
    onFlush(fn) {
      onFlush = fn;
    },

    onResync(fn) {
      onResync = fn;
      if (resyncRequired && onResync != null) onResync(resyncReason);
    },

    stats() {
      return { ...stats, pending: pending.size, resyncRequired };
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      pending.clear();
      known.clear();
      knownDigests.clear();
      onFlush = null;
      onResync = null;
    },
  };

  return journal;
}

/**
 * A content digest, read once and only for the handful of paths in a burst that
 * could be the far side of a move.
 */
function digestOf(file) {
  try {
    return crypto
      .createHash('sha256')
      .update(fs.readFileSync(file))
      .digest('hex');
  } catch {
    return null;
  }
}

/**
 * A provider backed by a real recursive filesystem watch.
 *
 * `fs.watch` is used rather than a watch library so the compiler gains no new
 * dependency for a facility the platform already has, and so a failure here is
 * a failure the caller can see rather than a native module that cannot start.
 */
export function createFilesystemWatcher({
  roots,
  outDir,
  debounceMs = 50,
  maxPending = 10000,
  known = null,
  digests = null,
  onFlush = null,
  onResync = null,
} = {}) {
  const rootList = (roots ?? []).map((r) => path.resolve(r));
  const journal = createChangeJournal({
    debounceMs,
    maxPending,
    known,
    digests,
    exclude: [outDir, ...generationScratchPaths(outDir)].filter(Boolean),
  });
  const watchers = [];
  const startFailures = [];
  let closed = false;
  let resyncNotified = false;

  const closeWatchers = () => {
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        /* already closed */
      }
    }
    watchers.length = 0;
  };

  const notifyResync = (reason) => {
    closeWatchers();
    if (resyncNotified) return;
    resyncNotified = true;
    if (onResync != null) onResync(reason ?? journal.resyncReason);
  };
  journal.onFlush(onFlush);
  journal.onResync(notifyResync);
  const signalResync = (reason) => journal.requireResync(reason);

  for (const root of rootList) {
    try {
      const watcher = fs.watch(
        root,
        { recursive: true, persistent: false },
        (eventType, name) => {
          journal.record(
            name == null ? name : path.resolve(root, String(name)),
            eventType,
          );
          journal.arm();
        },
      );
      watcher.on('error', (err) => {
        // An error on a watch is the backend saying it can no longer see
        // everything. That is an overflow, whatever the message says.
        signalResync(`watch-error:${err?.code ?? 'unknown'}`);
      });
      watchers.push(watcher);
    } catch (err) {
      startFailures.push({ root, code: err?.code ?? String(err) });
      break;
    }
  }

  const provider = {
    name: 'filesystem-watcher',
    mode: 'watcher',
    journal,
    /** A watch that never started is not a watch. */
    get established() {
      return (
        !closed && watchers.length > 0 && watchers.length === rootList.length
      );
    },
    startFailures: Object.freeze(
      startFailures.map((failure) => Object.freeze({ ...failure })),
    ),
    /** The transaction to submit, or null when there is nothing or a resync. */
    pending() {
      if (closed) return null;
      return journal.flush();
    },
    close() {
      if (closed) return;
      closed = true;
      closeWatchers();
      journal.close();
    },
    stats() {
      return journal.stats();
    },
  };

  if (startFailures.length > 0) {
    // Recorded rather than thrown: a host that can fall back wants to know WHY
    // it is falling back, and a host that cannot will find out on the first
    // revision it takes through the fallback path.
    signalResync(`watch-start-failed:${startFailures[0].code}`);
  }

  return provider;
}
