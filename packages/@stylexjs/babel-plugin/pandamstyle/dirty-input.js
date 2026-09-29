/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - WHERE A REVISION'S MUTATIONS COME FROM (Spike 4, Phase A/B).
 *
 * THE PROBLEM
 *
 * A revision used to be discovered by walking the project: every declared root
 * was re-listed, every file the session had ever seen was re-read and
 * re-hashed, and every resolution key the session had ever formed was re-probed.
 * That is O(project) per revision, and at 10,000 files it was 112ms of a 739ms
 * edit - spent rediscovering facts the caller already knew.
 *
 * An AI agent knows exactly which paths it just wrote. It is the party that
 * performed the mutation, so it is the only party that can be authoritative
 * about WHICH paths changed. Making the compiler walk 10,000 files to be told
 * "one" is the waste this module removes.
 *
 * THE TRUST MODEL, STATED
 *
 * Mutation information is a HINT about which paths changed. It is never
 * authority over what a file contains:
 *
 *   verified-explicit  The host performed the write and reports the mutation
 *                      from the same operation. The session reads and hashes
 *                      exactly the declared paths and trusts the SET, not the
 *                      bytes. This is the agent path and the fastest one.
 *
 *   watcher            Mutation information came from a filesystem watcher.
 *                      A watcher is a good LISTENER and a poor PROOF: it can
 *                      overflow, miss events, and lose its watch on a
 *                      directory that disappears. It is trusted as a hint
 *                      exactly like the explicit case, but the session records
 *                      that its completeness came from a source that can fail.
 *
 *   full-discovery     Nothing is claimed. The session re-derives the mutation
 *                      set from the filesystem, which is always correct and
 *                      always O(project). This is the default, the escape
 *                      hatch, and the reference every other mode is proved
 *                      against.
 *
 * WHAT NO MODE IS ALLOWED TO DO
 *
 * Skip the read. A declared path is still READ and CONTENT-HASHED. The claim
 * "I changed this path" narrows WHERE to look; it never supplies WHAT is there.
 * mtime is not a substitute and is not used anywhere in this path.
 *
 * Trust a partial set silently. If the session's own invariants show that the
 * declared set cannot explain the state it is looking at, it falls back to full
 * discovery and says so. A wrong-but-fast revision is the failure mode that
 * matters, because it publishes a generation that a fresh rebuild would not.
 *
 * THE INCOMPLETE-SET CONTRACT
 *
 * In `verified-explicit` mode, an incomplete mutation set is a CALLER
 * VIOLATION. The session cannot detect it, because a file the host did not
 * declare and did not write is indistinguishable from a file that did not
 * change - and proving otherwise requires the walk this mode exists to avoid.
 * This is stated here, tested at the integration seam, and recoverable:
 *
 *   - `session.verifyMutationSet()` performs a full-discovery audit on demand
 *     and reports a discrepancy.
 *   - `auditInterval` performs it automatically every N revisions for a host
 *     that wants a standing check.
 *   - `forceFullDiscovery` forces it for the next revision.
 *
 * The alternative - verifying completeness on every revision - is the walk.
 */

/**
 * The three provenance modes, in decreasing order of how much the caller is
 * trusted and increasing order of how much the session has to check itself.
 */
export const DIRTY_INPUT_MODES = Object.freeze([
  'verified-explicit',
  'watcher',
  'full-discovery',
]);

/** Default. Nothing is claimed, so everything is re-derived. */
export const DEFAULT_DIRTY_INPUT_MODE = 'full-discovery';

/**
 * Normalises whatever a host called the mutation fields into one shape.
 *
 * Deliberately forgiving about naming and strict about content: a host may say
 * `changed` or `changedFiles` or `dirty`, because integrating an agent is not
 * a configuration-file exercise. What it may not do is smuggle in a path that is
 * not a string, because everything downstream is a path.
 */
export function normalizeMutationTransaction(input) {
  if (input == null) {
    return {
      mode: DEFAULT_DIRTY_INPUT_MODE,
      changed: [],
      added: [],
      removed: [],
      renamed: [],
      forceFullDiscovery: false,
    };
  }
  if (typeof input !== 'object') {
    throw new Error(
      'pandamstyle: a mutation transaction must be an object with changed/added/removed/renamed arrays.',
    );
  }

  const pick = (...names) => {
    for (const name of names) {
      if (input[name] !== undefined) return input[name];
    }
    return undefined;
  };

  const paths = (value, field) => {
    if (value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => {
      if (typeof entry === 'string') return entry;
      // A host that already has a record may pass it; only its path is read.
      if (
        entry != null &&
        typeof entry === 'object' &&
        typeof entry.path === 'string'
      ) {
        return entry.path;
      }
      throw new Error(
        `pandamstyle: mutation.${field} must contain paths, or records with a "path". Received ${JSON.stringify(entry)}.`,
      );
    });
  };

  const renamedRaw = pick('renamed') ?? [];
  const renamed = (Array.isArray(renamedRaw) ? renamedRaw : [renamedRaw]).map(
    (entry) => {
      if (
        entry == null ||
        typeof entry !== 'object' ||
        typeof entry.from !== 'string' ||
        typeof entry.to !== 'string'
      ) {
        throw new Error(
          'pandamstyle: mutation.renamed entries must be { from, to }.',
        );
      }
      return { from: entry.from, to: entry.to };
    },
  );

  const mode =
    pick('mode') ?? pick('dirtyInputMode') ?? DEFAULT_DIRTY_INPUT_MODE;
  if (!DIRTY_INPUT_MODES.includes(mode)) {
    throw new Error(
      `pandamstyle: unknown dirty input mode ${JSON.stringify(mode)}; expected one of ${DIRTY_INPUT_MODES.join(', ')}.`,
    );
  }

  return {
    mode,
    changed: paths(pick('changed', 'changedFiles', 'dirty'), 'changed'),
    added: paths(pick('added', 'addedFiles', 'created'), 'added'),
    removed: paths(pick('removed', 'removedFiles', 'deleted'), 'removed'),
    renamed,
    // The escape hatch is honoured in EVERY mode, including full-discovery,
    // because a host that cannot prove its own mutation set needs a way to say
    // so without changing how it is configured.
    forceFullDiscovery: pick('forceFullDiscovery') === true,
    auditInterval: Number.isInteger(pick('auditInterval'))
      ? pick('auditInterval')
      : null,
  };
}

/**
 * The set of paths a transaction touches, in a form the session can act on.
 *
 * A rename is expanded into its two endpoints HERE, deliberately. The
 * implementation of a rename is "remove the old path, add the new one" - the old
 * file's state must go and the new file must be read - but the TRANSACTION
 * keeps the pair together so a host can be told what actually happened, and so
 * a future provider that can report "renamed" natively has somewhere to put it.
 */
export function touchedPaths(transaction) {
  const out = new Set();
  for (const p of transaction.changed) out.add(p);
  for (const p of transaction.added) out.add(p);
  for (const p of transaction.removed) out.add(p);
  for (const { from, to } of transaction.renamed) {
    out.add(from);
    out.add(to);
  }
  return out;
}

/**
 * The set of paths whose EXISTENCE may have changed, which is a different and
 * smaller question than the set of paths whose CONTENT may have changed.
 *
 * A negative resolution answer is a function of existence, not content, so this
 * is the set a reverse candidate index has to be consulted for. A file that was
 * edited in place is in `changed` and not here, and that is correct: its
 * existence did not move.
 */
export function existenceChangedPaths(transaction) {
  const out = new Set();
  for (const p of transaction.added) out.add(p);
  for (const p of transaction.removed) out.add(p);
  for (const { from, to } of transaction.renamed) {
    out.add(from);
    out.add(to);
  }
  return out;
}

/**
 * A provider that already knows the mutation set: the host performed the write
 * and is telling the session about it in the same operation.
 */
export function explicitAgentProvider(transaction) {
  const normalized = normalizeMutationTransaction(transaction);
  return {
    name: 'explicit-agent',
    mode: 'verified-explicit',
    transaction: normalized,
  };
}

/**
 * A provider that knows nothing, which is the reference every other mode is
 * measured against.
 */
export function fullScanProvider() {
  return {
    name: 'full-scan',
    mode: 'full-discovery',
    transaction: normalizeMutationTransaction(null),
  };
}

/**
 * The provider a session is using, from its configuration.
 *
 * `provider` is an object a host may pass directly (so it can plug in the
 * watcher from Phase B without this module knowing what a watcher is), or the
 * name of a mode.
 */
export function resolveProvider(input) {
  if (
    input != null &&
    typeof input === 'object' &&
    typeof input.mode === 'string' &&
    input.name !== undefined
  ) {
    // An already-resolved provider.
    return input;
  }
  if (
    input != null &&
    typeof input === 'object' &&
    typeof input.transaction === 'object'
  ) {
    return {
      name: 'custom',
      mode: input.mode ?? 'verified-explicit',
      transaction: input.transaction,
    };
  }
  if (typeof input === 'string') {
    const transaction = normalizeMutationTransaction({ mode: input });
    return transaction.mode === 'full-discovery'
      ? fullScanProvider()
      : { name: 'explicit-agent', mode: transaction.mode, transaction };
  }
  return fullScanProvider();
}
