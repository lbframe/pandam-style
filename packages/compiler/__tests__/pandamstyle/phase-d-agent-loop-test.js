/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE D - the agent loop, end to end.
 *
 * Phases D1 and D2 are each proved against a fresh recomputation of their own
 * output. This file is about what a CALLER sees, and the list is the one a
 * compiler change can break without any of the internal oracles noticing:
 *
 *   1. the incremental graph and the incremental views together still produce
 *      the generation a fresh rebuild produces, byte for byte;
 *   2. the agent result is still BOUND TO ITS REVISION - the Phase C contract
 *      that lets an agent trust the object it is holding;
 *   3. the diagnostics are unchanged, including the invalid -> repair loop, which
 *      is the whole reason the agent exists;
 *   4. the compact metadata is unchanged in SIZE and in shape, because Phase C's
 *      claim was that the agent's result does not carry the project;
 *   5. one transaction naming one, five and twenty files is one revision;
 *   6. and a thousand revisions of churn leave the graph and the indexes the
 *      size of the CURRENT project.
 *
 * (6) is the one that cannot be asserted by a single revision, and it is the one
 * a leak in D1 or D2 would hide behind: both keep CURRENT state deliberately -
 * no node history, no relay-answer history beyond the current import structure -
 * and "deliberately" is only a design intention until a thousand revisions have
 * been counted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.autoMockOff();

const { differential, openProject } = require('./session-helpers');

function read(project, relative) {
  return fs.readFileSync(path.join(project, relative), 'utf8');
}

function edit(harness, relative, content) {
  const abs = path.join(harness.project, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return harness.src(relative);
}

/** One agent transaction, as an AI agent submits one. */
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

function counters(harness) {
  return harness.session.stats().counters;
}

/** A page of the shape the fixture already uses, with one token swapped. */
function styleVariant(project, relative) {
  return fs
    .readFileSync(path.join(project, relative), 'utf8')
    .replace("token('spacing.md')", "token('spacing.lg')");
}

describe('Spike 4 Phase D: the agent loop', () => {
  let h;
  beforeEach(() => {
    h = openProject('valid');
  });

  // --------------------------------------------------------------- oracle ---

  test('a mixed agent trace publishes exactly what a fresh rebuild publishes', () => {
    revise(h);

    const touched = edit(
      h,
      'src/page.tsx',
      `${read(h.project, 'src/page.tsx')}\n// a\n`,
    );
    expect(revise(h, { changed: [touched] }).ok).toBe(true);

    const added = edit(h, 'src/agent-added.ts', 'export const added = 1;\n');
    expect(revise(h, { added: [added] }).ok).toBe(true);

    fs.rmSync(h.src('src/conditional-props.tsx'));
    expect(
      revise(h, { removed: [h.src('src/conditional-props.tsx')] }).ok,
    ).toBe(true);

    const from = h.src('src/renamed.js');
    const to = h.src('src/renamed-moved.js');
    fs.renameSync(from, to);
    expect(revise(h, { renamed: [{ from, to }] }).ok).toBe(true);

    // The internal oracles, both of which are slow and are therefore not on the
    // hot path.
    expect(h.session.verifyCoverageGraph().differences).toEqual([]);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);

    // And the one that costs a second compiler: the same bytes, rebuilt from
    // scratch, agree about the artifacts a reader loads.
    const published = h.published();
    h.full();
    expect(h.published()).toEqual(published);
  });

  test('the whole trace stays fresh-build equivalent at every revision', () => {
    expect(revise(h).ok).toBe(true);
    const findings = [
      differential(h, 'style edit', {
        changed: [
          edit(h, 'src/page.tsx', styleVariant(h.project, 'src/page.tsx')),
        ],
      }),
      differential(h, 'module add', {
        added: [edit(h, 'src/diff-added.ts', 'export const d = 1;\n')],
      }),
      differential(h, 'module remove', {
        removed: (() => {
          const victim = h.src('src/business-data.ts');
          fs.rmSync(victim);
          return [victim];
        })(),
      }),
      differential(h, 'relay change', {
        changed: [
          edit(
            h,
            'src/barrel.js',
            `${read(h.project, 'src/barrel.js')}\nexport const marker = 1;\n`,
          ),
        ],
      }),
    ].flatMap((r) => r.findings);
    expect(findings).toEqual([]);
  });

  // ------------------------------------------------------- result binding ---

  test('the agent result is still bound to its revision', () => {
    revise(h);
    const first = h.session.agentResult();
    expect(first.revisionId).toBe(h.session.stats().revisionId);

    expect(() =>
      h.session.agentResult({ revisionId: first.revisionId - 1 }),
    ).toThrow(/revision/i);
    expect(
      h.session.agentResult({ revisionId: first.revisionId }).revisionId,
    ).toBe(first.revisionId);

    // A second revision retires the first, and the refusal is the safety
    // property rather than a convenience.
    const changed = edit(
      h,
      'src/page.js',
      `${read(h.project, 'src/page.js')}\n// b\n`,
    );
    revise(h, { changed: [changed] });
    expect(() =>
      h.session.agentResult({ revisionId: first.revisionId }),
    ).toThrow(/revision/i);
    expect(h.session.agentResult().revisionId).toBe(first.revisionId + 1);
  });

  test('the compact agent result carries counts, not the project', () => {
    revise(h);
    const changed = edit(
      h,
      'src/page.js',
      `${read(h.project, 'src/page.js')}\n// b\n`,
    );
    revise(h, { changed: [changed] });

    const serialized = h.session.serializeAgentResult();
    const document = JSON.parse(serialized.text ?? serialized.json ?? '{}');

    // The claim Phase C made and Phase D must not break: the result carries the
    // AFFECTED set and a COUNT for the project, never the project's per-file
    // array. Asserted structurally rather than by a byte count - a byte bound
    // could be satisfied by a smaller array, and the property is about WHICH
    // files are named, not how many bytes they cost.
    const coveredFiles = h.session.coverageOrder().length;
    const affected = document.coverage.affectedEntries.map((e) => e.file);
    expect(document.coverage.projectEntries).toBe(coveredFiles);
    expect(typeof document.coverage.projectEntries).toBe('number');
    expect(document.coverage.affectedCount).toBe(1);
    expect(affected).toEqual([h.src('src/page.js')]);
    // Strictly fewer files named than files in the project, and the count is
    // the only thing that scales with it.
    expect(affected.length).toBeLessThan(coveredFiles);
    expect(serialized.bytes).toBeLessThan(4096);
  });

  // ---------------------------------------------------------- diagnostics ---

  test('the diagnostics of an invalid revision are unchanged by the graph', () => {
    revise(h);
    const before = h.full();

    // The violation the fixture's own negative corpus uses: a category property
    // given a raw number. The original bytes are kept so the repair is the exact
    // inverse rather than a second independent edit.
    const pristine = read(h.project, 'src/page.tsx');
    const victim = edit(
      h,
      'src/page.tsx',
      pristine.replace("gap: token('spacing.md')", 'gap: 17,'),
    );
    const broken = revise(h, { changed: [victim] });
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    for (const d of broken.diagnostics) {
      expect(typeof d.code).toBe('string');
      expect(typeof d.message).toBe('string');
      expect(d.location.file).toBe(h.src('src/page.tsx'));
      expect(d.location.role).toBe('page');
    }

    // The repair is the exact inverse, and it is clean.
    const repaired = revise(h, {
      changed: [edit(h, 'src/page.tsx', pristine)],
    });
    expect(repaired.ok).toBe(true);
    expect(repaired.diagnostics).toEqual([]);
    expect(h.full().ok ?? true).toBe(true);
    expect(before.ok ?? true).toBe(true);
  });

  // -------------------------------------------------------- transactions ---

  test.each([1, 5, 20])('%i files in one transaction is one revision', (n) => {
    revise(h);
    const names = [];
    for (let i = 0; i < n; i += 1) {
      const relative = `src/batch-${i}.js`;
      names.push(
        edit(
          h,
          relative,
          "import { create, token, props, themes } from '../generated/design.pandamstyle';\n" +
            `export const s${i} = create({ a: { padding: token('spacing.md') } });\n` +
            `export const p${i} = props(themes.light, s${i}.a);\n`,
        ),
      );
    }
    const revisionBefore = h.session.stats().revisionId;
    const v = revise(h, { added: names });

    expect(v.ok).toBe(true);
    expect(h.session.stats().revisionId).toBe(revisionBefore + 1);
    expect(v.counters.dirtyFilesDeclared).toBe(n);
    // And the graph saw exactly those files: the transaction's declared set is
    // the whole of the work.
    expect(counters(h).closure_nodes_examined).toBe(n);
    expect(h.session.verifyCoverageGraph().ok).toBe(true);
    expect(h.session.verifyDesignSystemViews().ok).toBe(true);
  });

  // ------------------------------------------------------------ long run ---

  test('a thousand revisions leave the graph and the indexes structurally bounded', () => {
    revise(h);
    const churn = [
      'src/churn-a.js',
      'src/churn-b.js',
      'src/churn-c.js',
      'src/churn-d.js',
    ];
    for (const relative of churn) {
      edit(h, relative, 'export const v = 1;\n');
    }
    expect(revise(h, { added: churn.map((r) => h.src(r)) }).ok).toBe(true);

    const sample = [];
    const record = (i) => {
      const graph = h.session.coverageGraph();
      const stats = h.session.stats();
      sample.push({
        revision: i,
        nodes: graph.nodes,
        covered: graph.coveredNodes,
        forward: graph.forwardEdges,
        reverse: graph.reverseEdges,
        support: graph.supportEntries,
        fileStates: stats.fileStateCount,
        dsConsumers: stats.dsConsumerModuleCount,
        dsImportConsumers: stats.dsImportConsumerModuleCount,
        relayAnswers: stats.dsViewRelayAnswerCount,
        relayHops: stats.dsViewRelayHopCount,
        rss: stats.rssBytes,
      });
    };

    const TOTAL = 1000;
    for (let i = 0; i < TOTAL; i += 1) {
      const phase = i % 10;
      if (phase === 0) {
        // A style-only edit.
        const changed = edit(
          h,
          'src/page.tsx',
          `${read(h.project, 'src/page.tsx')}\n// ${i}\n`,
        );
        revise(h, { changed: [changed] });
      } else if (phase === 3) {
        // An add and a remove in one transaction.
        const added = edit(h, `src/tmp-${i}.js`, 'export const t = 1;\n');
        revise(h, { added: [added] });
        const victim = h.src(`src/tmp-${i}.js`);
        fs.rmSync(victim);
        revise(h, { removed: [victim] });
      } else if (phase === 5) {
        // A rename.
        const from = h.src('src/churn-a.js');
        const to = h.src(`src/churn-a-${i}.js`);
        fs.renameSync(from, to);
        revise(h, { renamed: [{ from, to }] });
        const back = h.src(`src/churn-a-${i}.js`);
        const home = h.src('src/churn-a.js');
        fs.renameSync(back, home);
        revise(h, { renamed: [{ from: back, to: home }] });
      } else if (phase === 7) {
        // A relay mutation.
        const changed = edit(
          h,
          'src/barrel.js',
          `${read(h.project, 'src/barrel.js')}\n// ${i}\n`,
        );
        revise(h, { changed: [changed] });
      } else if (phase === 9) {
        // A no-change revision: declared, hashed, and identical.
        revise(h, { changed: [h.src('src/page.tsx')] });
      } else {
        const changed = edit(
          h,
          churn[phase % churn.length],
          `${read(h.project, churn[phase % churn.length])}\n// ${i}\n`,
        );
        revise(h, { changed: [changed] });
      }
      if (i % 100 === 0) record(i);
    }
    record(TOTAL);

    expect(sample.length).toBeGreaterThanOrEqual(10);
    // The graph is bounded by the CURRENT project. Every file the churn added
    // and removed is gone from it, and every index entry that named one went
    // with it - which is what "no per-revision structural growth" means.
    const last = sample[sample.length - 1];
    const first = sample[0];
    for (const key of [
      'nodes',
      'covered',
      'forward',
      'reverse',
      'support',
      'fileStates',
      'dsConsumers',
      'dsImportConsumers',
      'relayAnswers',
      'relayHops',
    ]) {
      expect(last[key]).toBeLessThanOrEqual(first[key]);
    }
    // And the session as a whole is consistent at the end.
    expect(h.session.verifyCoverageGraph().differences).toEqual([]);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(
      'LONG-SESSION',
      JSON.stringify({ first, last, samples: sample.length }),
    );
  });
});
