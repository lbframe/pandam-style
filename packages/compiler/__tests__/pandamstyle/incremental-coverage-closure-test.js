/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE D1 - the persistent coverage graph.
 *
 * The claim under test, in the order the phase depends on it:
 *
 *   1. a local style-only edit updates the affected graph region and NO OTHER -
 *      which is the whole performance claim, and the only one that can be
 *      measured as "one node examined, no walk performed";
 *   2. every graph mutation is correct: an addition, a deletion, a rename, an
 *      import change, a re-export change, a resolution that appears and a
 *      resolution that goes away;
 *   3. multi-parent reachability is right, which is the one thing a
 *      delete-the-subtree implementation gets wrong;
 *   4. and the incremental closure equals a FRESH closure - set, origins,
 *      canonical order, unresolved edges, external requests and relay edges -
 *      after a trace that does all of the above in one session.
 *
 * (1) and (2)-(4) are asserted separately on purpose. A graph that is fast
 * because it skips the work it should have done passes (1) and fails (4), and a
 * graph that is correct because it re-walks everything passes (4) and fails (1).
 * Neither number means anything without the other.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.autoMockOff();

const { openProject } = require('./session-helpers');

/** Writes a file into the copied project, creating directories as needed. */
function write(project, relative, content) {
  const abs = path.join(project, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function read(project, relative) {
  return fs.readFileSync(path.join(project, relative), 'utf8');
}

/**
 * Writes a file and DECLARES it, in one call.
 *
 * Under `verified-explicit` an undeclared write is invisible to the session -
 * that is the whole contract, and it is why this helper exists: a test that
 * writes a file and forgets to name it would measure a no-op and call it a
 * fast path.
 */
function edit(harness, relative, content) {
  write(harness.project, relative, content);
  return harness.src(relative);
}

function counters(harness) {
  return harness.session.stats().counters;
}

/**
 * One revision, declared the way an AI agent declares one.
 *
 * The fixture harness's own `revise()` submits an UNDECLARED transaction,
 * which is the `full-discovery` route and is therefore entitled to re-derive
 * the whole project on every revision. Every claim this file makes is about the
 * other route - the one where the host performed the write and is saying so -
 * so every revision here goes through `applyAgentChanges`, and a fast path that
 * only exists under `full-discovery` would be caught rather than measured.
 */
function revise(harness, mutation = {}) {
  harness.session.applyAgentChanges({
    changed: [],
    added: [],
    removed: [],
    renamed: [],
    ...mutation,
  });
  const validation = harness.session.validate();
  if (validation.ok) harness.session.compile();
  return validation;
}

/**
 * A module that reaches no design system and declares no style.
 *
 * The coverage graph does not care what a covered file contains, and a plain
 * module keeps these tests about the GRAPH: a file that also declared styles
 * would be recompiled on every revision and its compilation cost would sit
 * between a counter and the assertion about the counter.
 */
const PLAIN = (body) => `${body}\n`;

describe('Spike 4 Phase D1: the persistent coverage graph', () => {
  let h;
  beforeEach(() => {
    h = openProject('valid');
  });

  // ---------------------------------------------------------------- shape ---

  test('the first revision builds the graph and is not counted as a fallback', () => {
    const v = revise(h);
    expect(v.ok).toBe(true);
    const graph = h.session.coverageGraph();
    // The generated design-system module is reachable through a page's import,
    // so the graph holds every covered file plus that one.
    expect(graph.coveredNodes).toBe(graph.nodes);
    expect(graph.forwardEdges).toBeGreaterThan(0);
    expect(graph.reverseEdges).toBeGreaterThan(0);
    expect(graph.supportEntries).toBeGreaterThan(0);
    // A cold build is the REFERENCE. Calling it a fallback would make the
    // counter lie about the one revision nothing is compared against.
    expect(v.counters.fullFallback).toBe(0);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('a style-only edit examines one node and walks none of them', () => {
    revise(h);
    const page = h.src('src/page.tsx');
    const before = h.session.coverageGraph();

    const changed = edit(
      h,
      'src/page.tsx',
      read(h.project, 'src/page.tsx').replace(
        "gap: token('spacing.md')",
        "gap: token('spacing.lg')",
      ),
    );
    const v = revise(h, { changed: [changed] });

    expect(v.ok).toBe(true);
    const c = counters(h);
    // ONE file's edges were re-derived. Everything else was not even looked at.
    expect(c.closure_nodes_examined).toBe(1);
    expect(c.closure_edges_recomputed).toBe(0);
    expect(c.closure_reachability_updates).toBe(0);
    // And nothing in the graph moved, so no node entered, left or was pruned.
    expect(c.closure_nodes_entering_coverage).toBe(0);
    expect(c.closure_nodes_leaving_coverage).toBe(0);
    expect(c.closure_nodes_pruned).toBe(0);
    // The ordering layer was NOT re-derived. A canonical traversal here would
    // be a project-sized walk, and this is the assertion that says it did not
    // happen even though the revision was valid.
    expect(c.closure_full_walk ?? 0).toBe(0);
    const after = h.session.coverageGraph();
    expect(after.nodes).toBe(before.nodes);
    expect(after.forwardEdges).toBe(before.forwardEdges);
    expect(after.reverseEdges).toBe(before.reverseEdges);
    expect(after.coveredNodes).toBe(before.coveredNodes);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
    void page;
  });

  test('five style-only edits keep the fast path', () => {
    revise(h);
    for (const name of ['page.js', 'page.ts', 'renamed.js', 'only-recipe.js']) {
      const relative = `src/${name}`;
      const text = read(h.project, relative);
      const changed = edit(h, relative, `${text}\n// touched\n`);
      const v = revise(h, { changed: [changed] });
      expect(v.ok).toBe(true);
      const c = counters(h);
      expect(c.closure_nodes_examined).toBe(1);
      expect(c.closure_full_walk ?? 0).toBe(0);
      expect(h.session.verifyCoverageGraph().ok).toBe(true);
    }
  });

  test('a declared file whose bytes are unchanged changes no edge', () => {
    revise(h);
    const before = h.session.coverageGraph();
    const relative = 'src/page.tsx';
    const v = revise(h, { changed: [h.src(relative)] });
    expect(v.ok).toBe(true);
    expect(v.counters.dirtyFilesUnchanged).toBe(1);
    const c = counters(h);
    // The file WAS read and hashed - that is what proved the bytes were
    // identical - and its edges were therefore never even derived. The set the
    // graph examines is the set of files whose bytes CHANGED, and an unchanged
    // file is not in it.
    expect(c.closure_nodes_examined).toBe(0);
    expect(c.closure_full_walk ?? 0).toBe(0);
    expect(h.session.coverageGraph().forwardEdges).toBe(before.forwardEdges);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // -------------------------------------------------------------- addition ---

  test('a module added under a root enters coverage and shifts the order', () => {
    revise(h);
    const before = h.session.coverageGraph();
    const added = edit(h, 'src/added.ts', PLAIN('export const added = 1;'));
    const v = revise(h, { added: [added] });

    expect(v.ok).toBe(true);
    const c = counters(h);
    expect(c.closure_nodes_entering_coverage).toBe(1);
    // Adding a root file changes the canonical order, and the ordering layer
    // says so rather than pretending it did not.
    expect(c.closure_full_walk).toBe(1);
    expect(h.session.coverageGraph().coveredNodes).toBe(
      before.coveredNodes + 1,
    );
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('a module added outside every root stays uncovered until something imports it', () => {
    revise(h);
    const outside = write(
      h.project,
      'shared/late.ts',
      PLAIN('export const late = 1;'),
    );
    expect(fs.existsSync(outside)).toBe(true);

    let v = revise(h, { added: [outside] });
    expect(v.ok).toBe(true);
    // Nothing is under a declared root and nothing imports it, so it is not
    // covered - and the node the examination created for it is pruned again,
    // which is what keeps the graph the size of the CURRENT project.
    // `coveredFileCount` counts the generated design-system module too, and in
    // this fixture it is a covered file that the analysis RELABELS rather than
    // one it adds, so the two numbers are equal here. What the test is really
    // asserting is that the outside module is in neither.
    expect(v.counters.coveredFileCount).toBe(
      h.session.coverageGraph().coveredNodes,
    );
    // The node the examination created for a module nothing reaches is not in
    // the graph afterwards: the graph is the size of the CURRENT project, not of
    // everything the session has been told about.
    expect(h.session.coverageOrder().some(([file]) => file === outside)).toBe(
      false,
    );

    // Now an existing page imports it.
    const importer = edit(
      h,
      'src/late-importer.ts',
      PLAIN(
        "import { late } from '../shared/late';\nexport const used = late;",
      ),
    );
    v = revise(h, { added: [importer] });
    expect(v.ok).toBe(true);
    // Two nodes: the importer under the root, and the module it names, which is
    // outside every root and covered only because something reached it.
    expect(counters(h).closure_nodes_entering_coverage).toBe(2);
    // The importer was re-derived, and so was the module it named - which the
    // previous revision pruned, so there was no node to reuse. Both are in the
    // AFFECTED REGION and neither is in the rest of the project.
    expect(counters(h).closure_nodes_examined).toBeLessThanOrEqual(2);
    expect(h.session.coverageOrder().some(([file]) => file === outside)).toBe(
      true,
    );
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // -------------------------------------------------------------- deletion ---

  test('a deleted module leaves coverage and every index with it', () => {
    revise(h);
    const victim = h.src('src/conditional-props.tsx');
    const before = h.session.coverageGraph();

    fs.rmSync(victim);
    const v = revise(h, { removed: [victim] });

    expect(v.ok).toBe(true);
    const c = counters(h);
    expect(c.closure_nodes_leaving_coverage).toBe(1);
    expect(c.closure_nodes_pruned).toBe(1);
    const after = h.session.coverageGraph();
    expect(after.nodes).toBe(before.nodes - 1);
    expect(after.coveredNodes).toBe(before.coveredNodes - 1);
    // No index entry survives the node: this is the assertion that a stale
    // forward or reverse edge would be caught by.
    expect(after.forwardEdges).toBeLessThan(before.forwardEdges);
    expect(after.reverseEdges).toBeLessThan(before.reverseEdges);
    expect(after.supportEntries).toBeLessThan(before.supportEntries);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // --------------------------------------------------------- reachability ---

  /**
   * `entry -> left -> base` and `entry -> right -> base`, with the three
   * shared/right/base modules OUTSIDE the declared root so that they are covered
   * only by being reached. `base` therefore has two covered parents, and losing
   * one of them must not lose it.
   */
  /**
   * The shared half of a diamond, written OUTSIDE the declared root so that the
   * three shared modules are covered only by being reached.
   *
   * The fixture is applied in two revisions. The first creates the modules
   * nothing imports; the second adds the entry file, and THAT revision is the
   * one this test is about: three nodes reached by a subtree walk from a single
   * new edge, with no whole-project rebuild to pay for the discovery.
   */
  function diamondShared() {
    return [
      edit(h, 'shared/base.ts', PLAIN('export const shared = 1;')),
      edit(h, 'shared/left.ts', PLAIN("export { shared } from './base';")),
      edit(h, 'shared/right.ts', PLAIN("export { shared } from './base';")),
    ];
  }

  function diamondEntry() {
    return edit(
      h,
      'src/entry.ts',
      PLAIN(
        "import { shared as l } from '../shared/left';\n" +
          "import { shared as r } from '../shared/right';\n" +
          'export const both = l + r;\n',
      ),
    );
  }

  test('a diamond covers the shared module through both parents', () => {
    revise(h);
    const shared = diamondShared();
    expect(revise(h, { added: shared }).ok).toBe(true);
    // The shared modules exist and NOTHING reaches them: they are outside every
    // root, so the covered set does not contain them and the graph does not
    // either.
    expect(
      h.session
        .coverageOrder()
        .some(([file]) => file === h.src('shared/base.ts')),
    ).toBe(false);
    const before = h.session.coverageGraph();

    const entry = diamondEntry();
    const v = revise(h, { added: [entry] });
    expect(v.ok).toBe(true);
    const c = counters(h);
    // The entry file under the root, and the three modules it reaches outside
    // every root: four nodes reached from a single new edge, and nothing else in
    // the project looked at.
    expect(c.closure_nodes_entering_coverage).toBe(4);
    // Four nodes - the entry and the three it reached - and no more, on a
    // project that has a dozen covered files and a module graph behind them.
    expect(c.closure_nodes_examined).toBe(4);
    expect(c.closure_reachability_updates).toBeGreaterThanOrEqual(3);
    // The subtree walk found three nodes and the project grew by three.
    expect(h.session.coverageGraph().coveredNodes).toBe(
      before.coveredNodes + 4,
    );
    expect(h.session.coverageGraph().coveredNodes).toBe(
      h.session.coverageGraph().nodes,
    );
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('losing one parent of a diamond does not lose the shared module', () => {
    revise(h);
    // `shared/x` is OUTSIDE every root, so the only thing that can cover it is
    // an edge from something that is. Two pages point at it, which is the
    // diamond; deleting one of them is what a delete-the-subtree
    // implementation gets wrong.
    const shared = edit(h, 'shared/x.ts', PLAIN('export const x = 1;'));
    expect(revise(h, { added: [shared] }).ok).toBe(true);
    const first = edit(
      h,
      'src/e1.ts',
      PLAIN("import { x } from '../shared/x';\nexport const a = x;"),
    );
    const second = edit(
      h,
      'src/e2.ts',
      PLAIN("import { x } from '../shared/x';\nexport const b = x;"),
    );
    expect(revise(h, { added: [first, second] }).ok).toBe(true);
    const covered = h.session.coverageGraph().coveredNodes;

    fs.rmSync(first);
    const v = revise(h, { removed: [first] });
    expect(v.ok).toBe(true);
    // ONE node left - the page. `shared/x` did not, because `src/e2.ts` is
    // still a covered parent of it.
    expect(counters(h).closure_nodes_leaving_coverage).toBe(1);
    expect(h.session.coverageGraph().coveredNodes).toBe(covered - 1);
    expect(
      h.session.coverageOrder().some(([file]) => file === h.src('shared/x.ts')),
    ).toBe(true);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);

    // Now the last parent goes, and `shared/x` leaves coverage with every index
    // entry it owned.
    fs.rmSync(second);
    expect(revise(h, { removed: [second] }).ok).toBe(true);
    expect(counters(h).closure_nodes_leaving_coverage).toBe(1);
    expect(counters(h).closure_nodes_pruned).toBe(1);
    const after = h.session.coverageGraph();
    expect(after.coveredNodes).toBe(covered - 2);
    expect(after.nodes).toBe(covered - 2);
    expect(
      h.session.coverageOrder().some(([file]) => file === h.src('shared/x.ts')),
    ).toBe(false);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('a deleted import target leaves positive coverage and becomes a negative dependency', () => {
    revise(h);
    const added = [
      edit(h, 'src/gone-soon.ts', PLAIN('export const gone = 1;')),
      edit(
        h,
        'src/holder.ts',
        PLAIN("import { gone } from './gone-soon';\nexport const g = gone;"),
      ),
    ];
    expect(revise(h, { added }).ok).toBe(true);
    const before = h.session.coverageGraph();

    // The file is gone and something still imports it. The positive target edge
    // leaves coverage, while the unresolved request remains indexed at its
    // importer so a later file creation can repair it incrementally.
    fs.rmSync(h.src('src/gone-soon.ts'));
    const v = revise(h, { removed: [h.src('src/gone-soon.ts')] });

    expect(v.ok).toBe(false);
    const gap = v.diagnostics.find((d) => d.code === 'PMS_COVERAGE_GAP');
    expect(gap).toBeDefined();
    expect(gap.message).toContain('gone-soon');
    expect(h.session.coverageGraph().coveredNodes).toBe(
      before.coveredNodes - 1,
    );
    expect(
      h.session
        .coverageOrder()
        .some(([file]) => file === h.src('src/gone-soon.ts')),
    ).toBe(false);
    // `holder` remains covered and owns the negative dependency.
    expect(
      h.session
        .coverageOrder()
        .some(([file]) => file === h.src('src/holder.ts')),
    ).toBe(true);
  });

  test('a second path added later keeps a module covered after the first is gone', () => {
    revise(h);
    const base = edit(
      h,
      'src/shared-base.ts',
      PLAIN('export const shared = 1;'),
    );
    const first = edit(
      h,
      'src/first.ts',
      PLAIN(
        "import { shared } from './shared-base';\nexport const a = shared;",
      ),
    );
    // `shared-base` is covered by being a ROOT here, so the interesting part is
    // what happens to the EDGE when the parent goes: the target is released,
    // re-derived, and brought back by a second importer in the same session.
    expect(revise(h, { added: [base, first] }).ok).toBe(true);
    const covered = h.session.coverageGraph().coveredNodes;

    fs.rmSync(first);
    expect(revise(h, { removed: [first] }).ok).toBe(true);
    expect(h.session.coverageGraph().coveredNodes).toBe(covered - 1);

    const alt = edit(
      h,
      'src/alt-entry.ts',
      PLAIN(
        "import { shared } from './shared-base';\nexport const s2 = shared;",
      ),
    );
    const v = revise(h, { added: [alt] });
    expect(v.ok).toBe(true);
    expect(counters(h).closure_nodes_entering_coverage).toBe(1);
    expect(h.session.coverageGraph().coveredNodes).toBe(covered);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // ----------------------------------------------------------- resolution ---

  test('an unresolved import becomes resolvable and its target enters coverage', () => {
    revise(h);
    const waiting = edit(
      h,
      'src/waiting.ts',
      PLAIN("import { later } from './later';\nexport const l = later;"),
    );
    let v = revise(h, { added: [waiting] });
    expect(v.ok).toBe(false);
    expect(v.diagnostics.map((d) => d.code)).toContain('PMS_COVERAGE_GAP');
    expect(counters(h).closure_nodes_entering_coverage).toBe(1);

    // The module appears and NOTHING else changed, so the closure grows by
    // exactly the node the new edge named, and the negative resolution that
    // was repaired is re-probed rather than assumed.
    const later = edit(h, 'src/later.ts', PLAIN('export const later = 1;'));
    v = revise(h, { added: [later] });
    expect(v.ok).toBe(true);
    expect(counters(h).closure_nodes_entering_coverage).toBe(1);
    expect(counters(h).closure_nodes_examined).toBeLessThanOrEqual(2);
    expect(counters(h).negative_resolutions_invalidated).toBe(1);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('repairing a broken import does not rebuild the project to do it', () => {
    revise(h);
    const waiting = edit(
      h,
      'src/waiting-outside.ts',
      PLAIN(
        "import { later } from '../shared/later-outside';\nexport const l = later;\n",
      ),
    );
    expect(revise(h, { added: [waiting] }).ok).toBe(false);

    // The repair is the NARROWEST thing an agent can do: create the one file
    // the import named, and declare it. The module is outside every declared
    // root, which used to be enough to condemn the revision to a whole-project
    // rebuild - so the cost of fixing a broken import was the project.
    const later = write(
      h.project,
      'shared/later-outside.ts',
      PLAIN('export const later = 1;'),
    );
    const v = revise(h, { added: [later] });

    expect(v.ok).toBe(true);
    const c = counters(h);
    expect(c.closure_full_fallback ?? 0).toBe(0);
    expect(c.closure_nodes_entering_coverage).toBe(1);
    // One declaration, one file that imports it, and the negative resolution
    // that has to be re-probed. Not one visit to the rest of the project.
    expect(c.closure_nodes_examined).toBeLessThanOrEqual(3);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // ----------------------------------------------------------- mutations ---

  test('a rename moves the node and publishes the new path', () => {
    revise(h);
    const before = h.session.coverageGraph();
    const from = h.src('src/conditional-props.tsx');
    const to = h.src('src/conditional-props-moved.tsx');
    fs.renameSync(from, to);
    const v = revise(h, { renamed: [{ from, to }] });

    expect(v.ok).toBe(true);
    expect(counters(h).closure_nodes_leaving_coverage).toBe(1);
    expect(counters(h).closure_nodes_entering_coverage).toBe(1);
    const after = h.session.coverageGraph();
    expect(after.nodes).toBe(before.nodes);
    expect(after.coveredNodes).toBe(before.coveredNodes);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('an import change retargets an edge and nothing else', () => {
    revise(h);
    const helper = edit(h, 'src/target-one.ts', PLAIN('export const one = 1;'));
    expect(revise(h, { added: [helper] }).ok).toBe(true);

    const importer = edit(
      h,
      'src/retargeting.ts',
      PLAIN("import { one } from './target-one';\nexport const v = one;"),
    );
    expect(revise(h, { added: [importer] }).ok).toBe(true);

    // Now the SAME importer points somewhere else. One edge is removed and one
    // is added, the resolution of the file that made it moved, and nothing else
    // in the project was examined.
    const retargeted = edit(
      h,
      'src/retargeting.ts',
      PLAIN("import { one } from './page';\nexport const v = one;"),
    );
    const v = revise(h, { changed: [retargeted] });
    expect(v.ok).toBe(true);
    const c = counters(h);
    expect(c.closure_nodes_examined).toBe(1);
    expect(c.closure_edges_recomputed).toBe(2);
    expect(c.closure_nodes_entering_coverage).toBe(0);
    expect(c.closure_nodes_leaving_coverage).toBe(0);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('a re-export change does not move the closure and does not need to', () => {
    revise(h);
    // A re-export edit changes the RELAY CONTRACT, not the module's edges: the
    // file still imports the same module for the same request. So the closure
    // is untouched, and the design-system view is where the change lands.
    const changed = edit(
      h,
      'src/barrel.js',
      `${read(h.project, 'src/barrel.js')}\nexport const marker = 1;\n`,
    );
    const v = revise(h, { changed: [changed] });
    expect(v.ok).toBe(true);
    expect(counters(h).closure_nodes_examined).toBe(1);
    expect(counters(h).closure_edges_recomputed).toBe(0);
    expect(counters(h).closure_full_walk ?? 0).toBe(0);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // ------------------------------------------------------------ fallbacks ---

  test('changing the roots is a named full fallback, not a silent rebuild', () => {
    revise(h);
    const added = edit(
      h,
      'shared/under-the-new-root.ts',
      PLAIN('export const n = 1;'),
    );
    // Declared roots are AUTHORITATIVE. Changing them is a configuration change
    // the caller states, and the session answers it with a counted rebuild
    // rather than with a delta it cannot justify.
    h.setBuildOption('roots', [h.src('src'), path.join(h.project, 'shared')]);
    h.session.applyChanges({
      config: { roots: [h.src('src'), path.join(h.project, 'shared')] },
      mutation: {
        changed: [],
        added,
        removed: [],
        renamed: [],
        mode: 'verified-explicit',
      },
    });
    const v = h.session.validate();
    if (v.ok) h.session.compile();

    expect(v.ok).toBe(true);
    expect(v.counters.fullFallback).toBe(1);
    expect(v.counters.fullFallbackReason).toBe('roots');
    expect(counters(h).closure_full_fallback).toBe(1);
    // The module that moved under the newly declared root is now covered.
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
    expect(
      h.session
        .fileStates()
        .some((f) => f.file.endsWith('under-the-new-root.ts')),
    ).toBe(true);
  });

  test('a design-system change does not need to rebuild the coverage graph', () => {
    revise(h);
    const graphBefore = h.session.coverageGraph();
    const definitionPath = h.definitionPath;
    const definitionBefore = fs.readFileSync(definitionPath, 'utf8');
    const after = definitionBefore.replace(
      /md: \{ value: '16px'/,
      "md: { value: '18px'",
    );
    expect(after).not.toBe(definitionBefore);
    fs.writeFileSync(definitionPath, after, 'utf8');
    // Submitted the way an agent submits it: the definition AND the mutation
    // set, in one transaction. A definition change with no mutation set falls
    // back to full discovery by contract, which would answer a different
    // question than the one this test asks.
    h.session.applyChanges({
      definition: h.reloadDefinition(),
      mutation: {
        changed: [],
        added: [],
        removed: [],
        renamed: [],
        mode: 'verified-explicit',
      },
    });
    const v = h.session.validate();

    expect(v.ok).toBe(true);
    expect(v.counters.fullFallback).toBe(0);
    // A semantic definition change now follows the semantic dependency index;
    // the project coverage graph remains authoritative and is not replaced by
    // a compilation-scope fallback.
    const c = counters(h);
    expect(c.closure_full_fallback ?? 0).toBe(0);
    expect(h.session.coverageGraph().forwardEdges).toBe(
      graphBefore.forwardEdges,
    );
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  test('full discovery re-derives the root membership instead of trusting the cache', () => {
    revise(h);
    // A file that appeared without being declared is invisible to an explicit
    // mutation set and visible to a walk. Under full discovery it must be
    // found: a cached root list answering without being asked is how a project
    // quietly stops compiling a file somebody just created.
    write(h.project, 'src/unseen.ts', PLAIN('export const unseen = 1;'));
    const v = h.revise();

    expect(v.ok).toBe(true);
    expect(v.counters.coveredFileCount).toBeGreaterThan(0);
    expect(
      h.session.fileStates().some((f) => f.file.endsWith('unseen.ts')),
    ).toBe(true);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });

  // ---------------------------------------------------------------- oracle ---

  test('after a mixed trace the incremental closure equals a fresh closure', () => {
    // One session, every kind of mutation this phase is about, and not one of
    // them hidden from the compiler: an addition outside every root, an
    // addition that reaches it, a style-only edit, a deletion, and a re-export.
    revise(h);
    expect(revise(h, { added: diamondShared() }).ok).toBe(true);
    expect(revise(h, { added: [diamondEntry()] }).ok).toBe(true);

    const touched = edit(
      h,
      'src/page.tsx',
      `${read(h.project, 'src/page.tsx')}\n// a\n`,
    );
    expect(revise(h, { changed: [touched] }).ok).toBe(true);

    const later = edit(
      h,
      'src/added-later.ts',
      PLAIN('export const later = 1;'),
    );
    expect(revise(h, { added: [later] }).ok).toBe(true);

    fs.rmSync(h.src('src/conditional-props.tsx'));
    expect(
      revise(h, { removed: [h.src('src/conditional-props.tsx')] }).ok,
    ).toBe(true);

    const reExported = edit(
      h,
      'src/re-exported.ts',
      PLAIN("export { shared } from '../shared/right';"),
    );
    expect(revise(h, { added: [reExported] }).ok).toBe(true);

    // The closure, the origins, the canonical order, the unresolved edges, the
    // external requests and the relay edges, against a fresh computation from
    // the module summaries with no reuse of the incremental structure.
    const audit = h.session.verifyCoverageGraph();
    expect(audit.differences).toEqual([]);
    expect(audit.ok).toBe(true);

    // And the oracle that matters: the same bytes, rebuilt from scratch, agree
    // with the session about WHICH files are covered and in WHAT order.
    const full = h.full();
    expect(h.session.coverageOrder().map(([file]) => file)).toEqual(
      full.coverage.map((entry) => path.resolve(h.project, entry.file)),
    );
  });

  test('the canonical order equals a fresh traversal order, and is not incidental', () => {
    revise(h);
    const before = [...h.session.coverageOrder()].map(([file]) => file);
    const added = edit(h, 'src/aaa-ordered.ts', PLAIN('export const a = 1;'));
    expect(revise(h, { added: [added] }).ok).toBe(true);
    const after = [...h.session.coverageOrder()].map(([file]) => file);

    // The order genuinely moved - otherwise the equality below proves nothing
    // about whether the graph could have kept the stale one.
    expect(after.length).toBe(before.length + 1);
    expect(after).not.toEqual(before);
    expect(after.indexOf(h.src('src/aaa-ordered.ts'))).toBeGreaterThan(-1);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
  });
});
