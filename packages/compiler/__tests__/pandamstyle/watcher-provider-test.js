/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE B - the filesystem watcher as a dirty-input provider.
 *
 * The watcher is the FALLBACK discovery mechanism. An agent knows which file it
 * wrote; a watcher exists for the environments where that is not true. So the
 * tests here are mostly about the ways a watcher is WRONG, because a provider
 * that is trusted too far is worse than no provider at all:
 *
 *   - a burst of editor writes is one revision, not six;
 *   - an overflow produces NO transaction, so a partial one can never be acted
 *     on, and the session falls back and says so;
 *   - a watch that never started is not a watch;
 *   - PandamStyle's own output never comes back as a source mutation.
 *
 * EVERY case here is driven by injecting events into the journal directly, or by
 * writing a file and flushing. There is no sleep anywhere in this file: a test
 * that waits for a debounce window is a test that is slow when it passes and
 * flaky when the machine is loaded.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.autoMockOff();

const {
  comparePublished,
  loadCompiler,
  measure,
  openExistingProject,
  openProject,
} = require('./session-helpers');

const build = loadCompiler();

const D = { publishVariant: 'session_incremental_publish_css' };

const journal = (options) =>
  build.createChangeJournal({ debounceMs: 0, ...options });

function revise(h, changes = {}) {
  const validation = h.revise(changes);
  if (!validation.ok) {
    throw new Error(
      `revision rejected: ${(validation.diagnostics ?? [])
        .map((d) => d.code)
        .join(', ')}`,
    );
  }
  return validation;
}

// ---------------------------------------------------------------------------
// A. what the journal says
// ---------------------------------------------------------------------------

describe('Spike 4 Phase B: the journal classifies events', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-watch-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a create is reported as an addition', () => {
    const file = path.join(dir, 'new.js');
    fs.writeFileSync(file, 'export const a = 1;\n', 'utf8');
    const j = journal();
    j.record(file, 'rename');
    const transaction = j.flush();
    expect(transaction.added).toEqual([file]);
    expect(transaction.changed).toEqual([]);
    expect(transaction.removed).toEqual([]);
    expect(transaction.mode).toBe('watcher');
  });

  test('a modify is reported as a change', () => {
    const file = path.join(dir, 'page.js');
    fs.writeFileSync(file, 'export const a = 1;\n', 'utf8');
    const j = journal();
    j.seed([file]);
    j.record(file, 'change');
    expect(j.flush().changed).toEqual([file]);
  });

  test('a delete is reported as a removal', () => {
    const file = path.join(dir, 'gone.js');
    fs.writeFileSync(file, 'export const a = 1;\n', 'utf8');
    const j = journal();
    j.seed([file]);
    fs.rmSync(file);
    j.record(file, 'rename');
    expect(j.flush().removed).toEqual([file]);
  });

  test('a create followed by a delete in one burst cancels out', () => {
    // A tool that writes a temporary file and removes it again is the most
    // common editor behaviour there is, and it must not become a revision.
    const file = path.join(dir, 'scratch.tmp');
    fs.writeFileSync(file, 'x', 'utf8');
    const j = journal();
    j.record(file, 'rename');
    fs.rmSync(file);
    j.record(file, 'rename');
    const transaction = j.flush();
    expect(transaction).not.toBeNull();
    // Nothing is there, so the honest answer is a removal, and the session's
    // own "declared but gone" handling makes that a no-op.
    expect([
      ...transaction.added,
      ...transaction.changed,
      ...transaction.removed,
    ]).toEqual([file]);
    expect(transaction.removed).toEqual([file]);
  });

  test('a rename is detected as one rename, not a remove plus an add', () => {
    const from = path.join(dir, 'before.js');
    const to = path.join(dir, 'after.js');
    fs.writeFileSync(from, 'export const same = 1;\n', 'utf8');
    fs.renameSync(from, to);
    const j = journal();
    j.seed([from]);
    // The digest as it was BEFORE the move, which is the whole trick: after a
    // rename the old path no longer exists, so nothing observable at flush time
    // can distinguish a rename from an unrelated delete plus create.
    j.rememberDigest(
      from,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(to, 'utf8'))
        .digest('hex'),
    );
    j.record(from, 'rename');
    j.record(to, 'rename');
    const transaction = j.flush();
    expect(transaction.renamed).toEqual([{ from, to }]);
    expect(transaction.removed).toEqual([]);
    expect(transaction.added).toEqual([]);
  });

  test('two different files in one burst are two different kinds', () => {
    const changed = path.join(dir, 'changed.js');
    const created = path.join(dir, 'created.js');
    fs.writeFileSync(changed, 'a', 'utf8');
    const j = journal();
    j.seed([changed]);
    fs.writeFileSync(changed, 'b', 'utf8');
    fs.writeFileSync(created, 'c', 'utf8');
    j.record(changed, 'change');
    j.record(created, 'rename');
    const transaction = j.flush();
    expect(transaction.changed).toEqual([changed]);
    expect(transaction.added).toEqual([created]);
  });
});

// ---------------------------------------------------------------------------
// B. coalescing
// ---------------------------------------------------------------------------

describe('Spike 4 Phase B: a burst is one revision', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-burst-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an editor save burst is one transaction, not six', () => {
    const file = path.join(dir, 'page.js');
    const j = journal();
    // temp file, rename, rewrite, write again - the shape of a real save.
    const temp = path.join(dir, '.page.js.tmp');
    fs.writeFileSync(temp, 'v1', 'utf8');
    j.record(temp, 'rename');
    fs.writeFileSync(file, 'v2', 'utf8');
    j.record(file, 'rename');
    fs.writeFileSync(file, 'v3', 'utf8');
    j.record(file, 'change');
    fs.rmSync(temp);
    j.record(temp, 'rename');

    const transaction = j.flush();
    const paths = [
      ...transaction.changed,
      ...transaction.added,
      ...transaction.removed,
    ];
    // Four events over two paths produced ONE transaction naming two paths.
    expect(j.stats().events).toBe(4);
    expect(j.stats().coalesced).toBeGreaterThan(0);
    expect(paths).toContain(file);
    expect(paths).toContain(temp);
    expect(j.flush()).toBeNull();
  });

  test('an empty journal produces no revision', () => {
    expect(journal().flush()).toBeNull();
  });

  test('events are never merged across an explicit agent transaction', () => {
    // An agent transaction is a revision the CALLER chose. A watch event that
    // arrives during it is a different change and must become its own revision,
    // or the caller gets a generation that includes a change it never asked
    // about.
    const h = openProject('valid', D);
    revise(h);
    const file = h.src('src/page.js');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(
          "color: token('colors.text.primary')",
          "color: token('colors.text.inverse')",
        ),
      'utf8',
    );
    const before = h.session.current().revisionId;
    h.session.applyAgentChanges({ changed: [file] });
    expect(h.session.validate().ok).toBe(true);
    h.session.compile();
    const afterDeclared = h.session.current().revisionId;
    expect(afterDeclared).toBeGreaterThan(before);

    // The watcher's next transaction is its own revision boundary, so a change
    // the caller never declared is never folded into the caller's revision.
    const seen = measure(() => {
      h.session.applyAgentChanges({
        mode: 'watcher',
        changed: [h.src('src/only-recipe.js')],
      });
      return h.session.validate();
    });
    h.session.compile();
    expect(seen.value.ok).toBe(true);
    expect(h.session.current().revisionId).toBeGreaterThan(afterDeclared);
  });
});

// ---------------------------------------------------------------------------
// C. the watcher can be wrong, and says so
// ---------------------------------------------------------------------------

describe('Spike 4 Phase B: a watcher that cannot be trusted says so', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-resync-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('an overflow produces NO transaction, not a partial one', () => {
    const file = path.join(dir, 'page.js');
    fs.writeFileSync(file, 'v1', 'utf8');
    const j = journal();
    j.record(file, 'change');

    j.requireResync('queue-overflow');

    // A partial transaction is worse than none: a host that acted on it would
    // publish a generation missing whatever the overflow swallowed.
    expect(j.resyncRequired).toBe(true);
    expect(j.resyncReason).toBe('queue-overflow');
    expect(j.flush()).toBeNull();
  });

  test('the bounded journal resyncs before accepting an incomplete burst', () => {
    const first = path.join(dir, 'first.js');
    const second = path.join(dir, 'second.js');
    fs.writeFileSync(first, 'one', 'utf8');
    fs.writeFileSync(second, 'two', 'utf8');
    const j = journal({ maxPending: 1 });
    j.record(first, 'change');
    j.record(second, 'change');

    expect(j.resyncRequired).toBe(true);
    expect(j.resyncReason).toBe('buffer-overflow');
    expect(j.stats().pending).toBe(0);
    expect(j.flush()).toBeNull();
  });

  test('a resync supersedes events already in the journal', () => {
    const file = path.join(dir, 'page.js');
    fs.writeFileSync(file, 'v1', 'utf8');
    const j = journal();
    j.record(file, 'change');
    j.record(file, 'change');
    expect(j.stats().pending).toBeGreaterThan(0);
    j.requireResync('overflow');
    expect(j.stats().pending).toBe(0);
    expect(j.flush()).toBeNull();
  });

  test('an unattributable event forces a resync', () => {
    // A null filename means the backend cannot say which path changed. A session
    // that treated that as "nothing happened" would publish a stale generation.
    const j = journal();
    j.record(null);
    expect(j.resyncRequired).toBe(true);
    expect(j.resyncReason).toBe('unattributable-event');
  });

  test('a resync makes the session fall back to full discovery, and counts it', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = h.src('src/page.js');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(
          "color: token('colors.text.primary')",
          "color: token('colors.text.inverse')",
        ),
      'utf8',
    );
    const provider = {
      journal: { resyncRequired: true, resyncReason: 'queue-overflow' },
      pending: () => null,
      stats: () => ({ events: 3, coalesced: 0, ignored: 0, pending: 0 }),
    };
    const seen = measure(() => h.session.applyWatchedChanges(provider));
    expect(seen.counters.watch_resyncs).toBe(1);
    expect(seen.counters.full_discovery_fallback).toBe(1);
    expect(seen.counters.project_files_scanned).toBeGreaterThan(0);
    // The fallback produced a VALIDATED revision, which is the only claim that
    // matters: a full-discovery fallback that got the answer wrong would be
    // worse than no fallback at all.
    expect(h.session.validate().ok).toBe(true);
    h.session.compile();
    // And the revision is still correct, because the fallback re-derived it.
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a watch that never started is not a watch', () => {
    const provider = build.createFilesystemWatcher({
      roots: [path.join(dir, 'does-not-exist')],
      outDir: path.join(dir, 'out'),
    });
    expect(provider.established).toBe(false);
    expect(provider.startFailures.length).toBe(1);
    // And it says so, rather than presenting an empty journal as "no changes".
    expect(provider.journal.resyncRequired).toBe(true);
    expect(provider.journal.resyncReason).toContain('watch-start-failed');
    provider.close();
  });

  test('a watch that started is established and closes cleanly', () => {
    const provider = build.createFilesystemWatcher({
      roots: [dir],
      outDir: path.join(dir, 'out'),
    });
    expect(provider.established).toBe(true);
    expect(provider.startFailures).toEqual([]);
    provider.close();
    expect(() => provider.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// D. the output loop
// ---------------------------------------------------------------------------

describe('Spike 4 Phase B: the compiler does not watch its own output', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-loop-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('events under the output directory and the generation scratch are ignored', () => {
    const out = path.join(dir, 'generated');
    fs.mkdirSync(out, { recursive: true });
    const scratch = build.generationScratchPaths(out);
    const j = build.createChangeJournal({
      debounceMs: 0,
      exclude: [out, ...scratch],
    });

    // Everything a publication writes.
    for (const file of [
      path.join(out, 'styles.css'),
      path.join(out, 'build-report.json'),
      path.join(out, 'manifest.json'),
      path.join(out, 'js', 'src', 'page.js'),
      scratch[0],
      scratch[2],
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x', 'utf8');
      j.record(file, 'rename');
    }

    expect(j.stats().ignored).toBe(6);
    // Nothing the compiler published is a source mutation. Without this, a
    // session would invalidate the files it just published and republish them
    // forever.
    expect(j.flush()).toBeNull();
  });

  test('a real source beside an ignored output still gets through', () => {
    const out = path.join(dir, 'generated');
    fs.mkdirSync(out, { recursive: true });
    const source = path.join(dir, 'src', 'page.js');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'x', 'utf8');
    const ignored = path.join(out, 'styles.css');
    fs.writeFileSync(ignored, 'x', 'utf8');

    const j = build.createChangeJournal({ debounceMs: 0, exclude: [out] });
    j.seed([source]);
    j.record(source, 'change');
    j.record(ignored, 'rename');

    const transaction = j.flush();
    expect(transaction.changed).toEqual([source]);
    expect(j.stats().ignored).toBe(1);
  });

  test('a project directory named like an output is NOT excluded', () => {
    // The guard is an ownership rule, not a name filter. A project with its own
    // `generated` directory, unrelated to this compiler, must keep compiling.
    const out = path.join(dir, 'compiler-output');
    const projectGenerated = path.join(dir, 'src', 'generated');
    fs.mkdirSync(projectGenerated, { recursive: true });
    const file = path.join(projectGenerated, 'thing.js');
    fs.writeFileSync(file, 'x', 'utf8');

    const j = build.createChangeJournal({ debounceMs: 0, exclude: [out] });
    j.seed([file]);
    j.record(file, 'change');
    expect(j.flush().changed).toEqual([file]);
  });
});

// ---------------------------------------------------------------------------
// E. end to end: a watched revision is a correct revision
// ---------------------------------------------------------------------------

describe('Spike 4 Phase B: a watched revision equals a rebuild', () => {
  test('a watched mutation produces the generation a rebuild produces', () => {
    const h = openProject('valid', D);
    revise(h);

    const file = h.src('src/conditional-props.tsx');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace("gap: token('spacing.sm')", "gap: token('spacing.lg')"),
      'utf8',
    );
    const j = journal();
    j.seed([file]);
    j.record(file, 'change');
    const transaction = j.flush();

    const seen = measure(() => {
      h.session.applyChanges({
        mutation: build.normalizeMutationTransaction({
          ...transaction,
          mode: 'watcher',
        }),
      });
      const validation = h.session.validate();
      if (validation.ok) h.session.compile();
      return validation;
    });
    expect(seen.value.ok).toBe(true);
    expect(seen.counters.dirty_input_mode_watcher).toBe(1);
    expect(seen.counters.dirty_files_read).toBe(1);
    expect(seen.counters.project_files_scanned).toBe(0);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a watched create and a watched delete both behave', () => {
    const h = openProject('valid', D);
    revise(h);

    const created = h.src('src/zz-watched.js');
    fs.writeFileSync(
      created,
      "import { create, token, props } from '../generated/design.pandamstyle';\n" +
        "export const s = props(create({ box: { outlineColor: token('colors.action.primaryHover') } }).box);\n",
      'utf8',
    );
    const j = journal();
    j.record(created, 'rename');
    const addTransaction = j.flush();
    h.session.applyChanges({
      mutation: build.normalizeMutationTransaction({
        ...addTransaction,
        mode: 'watcher',
      }),
    });
    expect(h.session.validate().ok).toBe(true);
    h.session.compile();
    expect(h.published()['js/src/zz-watched.js']).toBeDefined();

    fs.rmSync(created);
    const j2 = journal();
    j2.seed([created]);
    j2.record(created, 'rename');
    const removeTransaction = j2.flush();
    h.session.applyChanges({
      mutation: build.normalizeMutationTransaction({
        ...removeTransaction,
        mode: 'watcher',
      }),
    });
    expect(h.session.validate().ok).toBe(true);
    h.session.compile();
    expect(h.published()['js/src/zz-watched.js']).toBeUndefined();
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('watcher and declared input agree on the same mutation', () => {
    // One project, two provenances, one answer. Both sessions are opened BEFORE
    // the mutation, because a session that discovers the change during its own
    // initial pass has no change left to be told about.
    const watched = openProject('valid', D);
    const declared = openExistingProject(watched.project, D);
    revise(watched);
    revise(declared);
    const file = watched.src('src/page.js');
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, 'utf8')
        .replace(
          "color: token('colors.text.primary')",
          "color: token('colors.text.inverse')",
        ),
      'utf8',
    );
    const j = journal();
    j.seed([file]);
    j.record(file, 'change');
    watched.session.applyChanges({
      mutation: build.normalizeMutationTransaction({
        ...j.flush(),
        mode: 'watcher',
      }),
    });
    expect(watched.session.validate().ok).toBe(true);
    watched.session.compile();
    const watchedGeneration = watched.published();
    watched.session.close();

    declared.session.applyAgentChanges({ changed: [file] });
    expect(declared.session.validate().ok).toBe(true);
    declared.session.compile();
    expect(declared.published()).toEqual(watchedGeneration);
  });
});
