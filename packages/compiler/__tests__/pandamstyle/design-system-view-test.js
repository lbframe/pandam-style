/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE D2 - the incremental design-system view.
 *
 * WHAT A DESIGN-SYSTEM VIEW IS, AND WHY IT IS SEPARATE FROM THE COVERAGE GRAPH
 *
 * The plugin asks, for every static import declaration, whether the request
 * reaches the generated design system and with which export map. That answer -
 * not the target's content - is what decides whether `create`, `props` and
 * `token` are recognized. So the view is a digest of those answers plus the
 * chain of files that produced them.
 *
 * It is therefore a function of a MUCH narrower graph than the coverage
 * closure: a file's own import declarations, the modules its relay walk
 * descends, the generated design system, and the relay depth. Nothing else can
 * move it. That is what this file tests - the invalidation rules implied by
 * that statement, and the property the whole thing rests on:
 *
 *   incremental views (revision N) == fresh views (revision N)
 *
 * for the digest, the relay chain, the recognized design-system module, and
 * therefore for the compiler's binding recognition, its diagnostics and its
 * output.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.autoMockOff();

const { openProject } = require('./session-helpers');

const BARREL = 'src/barrel.js';

function write(project, relative, content) {
  const abs = path.join(project, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function edit(harness, relative, content) {
  write(harness.project, relative, content);
  return harness.src(relative);
}

/** One revision, declared the way an AI agent declares one. */
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

function viewOf(harness, relative) {
  const file = harness.src(relative);
  const rows = harness.session.fileStates();
  return rows.find((f) => f.file === file) ?? null;
}

describe('Spike 4 Phase D2: the incremental design-system view', () => {
  let h;
  beforeEach(() => {
    h = openProject('valid');
  });

  // --------------------------------------------------------------- memo ---

  test('the first revision derives a view for every covered file', () => {
    const v = revise(h);
    expect(v.ok).toBe(true);
    const c = counters(h);
    expect(c.dsv_files_examined).toBeGreaterThan(0);
    expect(c.dsv_files_recomputed).toBe(c.dsv_files_examined);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
    // The relay answer is walked ONCE, not once per consumer: ten pages reach
    // the design system through one barrel and there is one answer.
    expect(c.dsv_relay_walks ?? 0).toBeGreaterThan(0);
    expect(c.dsv_relay_walks ?? 0).toBeLessThan(c.dsv_files_examined);
  });

  test('a style-only edit recomputes nothing at all', () => {
    revise(h);
    const before = viewOf(h, 'src/page.tsx');

    const changed = edit(
      h,
      'src/page.tsx',
      fs
        .readFileSync(h.src('src/page.tsx'), 'utf8')
        .replace("gap: token('spacing.md')", "gap: token('spacing.lg')"),
    );
    const v = revise(h, { changed: [changed] });

    expect(v.ok).toBe(true);
    const c = counters(h);
    // ONE file was a candidate - the one the agent touched - and its memo key
    // was unchanged, so nothing was recomputed. That is the whole of D2's
    // performance claim and it is a count of zero.
    expect(c.dsv_files_examined).toBe(1);
    expect(c.dsv_files_recomputed).toBe(0);
    expect(c.dsv_files_reused).toBe(1);
    expect(c.dsv_consumers_invalidated).toBe(0);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
    // And the file's own validity key - which includes its view digest - is
    // unchanged, which is the observable consequence of that.
    expect(viewOf(h, 'src/page.tsx').validity.designSystemViewDigest).toBe(
      before.validity.designSystemViewDigest,
    );
  });

  test('a style-only edit to one page recomputes no OTHER page either', () => {
    revise(h);
    const changed = edit(
      h,
      'src/page.js',
      `${fs.readFileSync(h.src('src/page.js'), 'utf8')}\n// touched\n`,
    );
    const v = revise(h, { changed: [changed] });
    expect(v.ok).toBe(true);
    expect(counters(h).dsv_files_recomputed).toBe(0);
    expect(v.counters.filesRecompiled).toBe(1);
    expect(v.counters.reverseDependentsInvalidated).toBe(0);
  });

  test('full discovery does not treat every rebuilt coverage node as a DSV candidate', () => {
    revise(h);
    const definitionPath = h.definitionPath;
    const before = fs.readFileSync(definitionPath, 'utf8');
    const after = before.replace(/md: \{ value: '16px'/, "md: { value: '18px'");
    expect(after).not.toBe(before);
    fs.writeFileSync(definitionPath, after, 'utf8');

    h.session.applyChanges({
      definition: h.reloadDefinition(),
      mutation: {
        changed: [],
        added: [],
        removed: [],
        renamed: [],
        mode: 'full-discovery',
      },
    });
    const v = h.session.validate();
    if (v.ok) h.session.compile();

    expect(v.ok).toBe(true);
    expect(v.agentResult.incremental.fullDiscovery).toBe(true);
    expect(counters(h).dsv_files_examined).toBeLessThan(
      v.counters.coveredFileCount,
    );
    expect(counters(h).dsv_files_recomputed).toBe(0);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a compiler fallback still re-derives every cleared DSV', () => {
    revise(h);
    h.setBuildOption('useCSSLayers', true);
    h.session.applyChanges({
      config: { useCSSLayers: true },
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
    expect(v.counters.fullFallbackReason).toBe('compiler-configuration');
    expect(counters(h).dsv_files_examined).toBeGreaterThan(1);
    expect(counters(h).dsv_files_recomputed).toBe(
      counters(h).dsv_files_examined,
    );
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a declared file whose bytes did not change recomputes nothing', () => {
    revise(h);
    const v = revise(h, { changed: [h.src('src/page.tsx')] });
    expect(v.ok).toBe(true);
    expect(v.counters.dirtyFilesUnchanged).toBe(1);
    expect(counters(h).dsv_files_recomputed).toBe(0);
  });

  // -------------------------------------------------------------- relay ---

  test('a comment-only edit to the relay invalidates nothing', () => {
    revise(h);
    const before = viewOf(h, 'src/renamed.js');
    const changed = edit(
      h,
      BARREL,
      fs
        .readFileSync(h.src(BARREL), 'utf8')
        .replace('/** Intermediate', '/** Intermediate relay'),
    );
    const v = revise(h, { changed: [changed] });
    expect(v.ok).toBe(true);
    expect(v.counters.reverseDependentsInvalidated).toBe(0);
    expect(viewOf(h, 'src/renamed.js').validity.designSystemViewDigest).toBe(
      before.validity.designSystemViewDigest,
    );
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a relay-contract change invalidates exactly the consumers of that relay', () => {
    revise(h);
    // A relay whose forwarding set is a STAR forwards every export of the
    // design system, and that set is part of every consumer's view.
    const star = edit(
      h,
      'src/star-barrel.js',
      "export * from '../generated/design.pandamstyle';\n",
    );
    const consumer = edit(
      h,
      'src/star-consumer.js',
      "import { create, token, props, themes } from './star-barrel';\n" +
        "export const s = create({ a: { padding: token('spacing.md') } });\n" +
        'export const p = props(themes.light, s.a);\n',
    );
    expect(revise(h, { added: [star, consumer] }).ok).toBe(true);
    const before = viewOf(h, 'src/star-consumer.js');
    expect(before.validity.designSystemViewDigest).not.toBeNull();

    // Turn the star into a named list. The names the page actually uses still
    // arrive, but the forwarding SET changed, and that set is what the view is a
    // digest of - so this is the change that has to reach the consumer.
    const narrowed = edit(
      h,
      'src/star-barrel.js',
      "export { create, token, props, themes } from '../generated/design.pandamstyle';\n",
    );
    const v = revise(h, { changed: [narrowed] });
    expect(v.ok).toBe(true);
    expect(v.counters.reverseDependentsInvalidated).toBeGreaterThanOrEqual(1);
    expect(
      viewOf(h, 'src/star-consumer.js').validity.designSystemViewDigest,
    ).not.toBe(before.validity.designSystemViewDigest);
    // And only the consumers of THAT relay: a page that reaches the design
    // system directly was not invalidated.
    const direct = viewOf(h, 'src/page.tsx');
    expect(direct.validity.designSystemViewDigest).not.toBeNull();
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a NAMED re-export list changes the view and invalidates its consumer', () => {
    // Converted from the Phase D debt pin: a named list now represents actual
    // forwarding. Historical defect and rationale remain recorded in DEBT.md.
    revise(h);
    const consumer = edit(
      h,
      'src/named-consumer.js',
      "import { create, token, props, themes } from './barrel';\n" +
        "export const s = create({ a: { padding: token('spacing.md') } });\n" +
        'export const p = props(themes.light, s.a);\n',
    );
    expect(revise(h, { added: [consumer] }).ok).toBe(true);
    const before = viewOf(h, 'src/named-consumer.js');

    const changed = edit(
      h,
      BARREL,
      fs
        .readFileSync(h.src(BARREL), 'utf8')
        .replace('  props,\n', '  props,\n  manifest,\n'),
    );
    const v = revise(h, { changed: [changed] });
    expect(v.ok).toBe(true);
    expect(v.counters.reverseDependentsInvalidated).toBeGreaterThanOrEqual(1);
    expect(
      viewOf(h, 'src/named-consumer.js').validity.designSystemViewDigest,
    ).not.toBe(before.validity.designSystemViewDigest);
    expect(counters(h).dsv_files_recomputed).toBeGreaterThanOrEqual(1);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('breaking the relay invalidates the files that consumed it', () => {
    write(h.project, 'src/plain.js', 'export const nothing = 1;\n');
    const consumer = edit(
      h,
      'src/relay-consumer.js',
      "import { create, token, props, themes } from './barrel';\n" +
        "export const s = create({ a: { padding: token('spacing.md') } });\n" +
        'export const p = props(themes.light, s.a);\n',
    );
    expect(revise(h, { added: [consumer] }).ok).toBe(true);
    const before = viewOf(h, 'src/relay-consumer.js');

    const changed = edit(
      h,
      BARREL,
      fs
        .readFileSync(h.src(BARREL), 'utf8')
        .replace(
          "} from '../generated/design.pandamstyle';",
          "} from './plain';",
        ),
    );
    const v = revise(h, { changed: [changed] });

    expect(v.counters.reverseDependentsInvalidated).toBeGreaterThanOrEqual(1);
    expect(
      viewOf(h, 'src/relay-consumer.js').validity.designSystemViewDigest,
    ).not.toBe(before.validity.designSystemViewDigest);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a namespace re-export is still followed', () => {
    revise(h);
    const added = write(
      h.project,
      'src/namespace-relay.js',
      "export * as everything from '../generated/design.pandamstyle';\n",
    );
    let v = revise(h, { added: [added] });
    expect(v.ok).toBe(true);

    const consumer = edit(
      h,
      'src/namespace-consumer.js',
      "import { everything } from './namespace-relay';\n" +
        "export const s = everything.create({ a: { padding: everything.token('spacing.md') } });\n",
    );
    v = revise(h, { added: [consumer] });
    expect(v.ok).toBe(true);
    expect(
      viewOf(h, 'src/namespace-consumer.js').validity.designSystemViewDigest,
    ).not.toBeNull();
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('an export-star relay is still followed, and its renames are still renames', () => {
    revise(h);
    const relay = edit(
      h,
      'src/star-relay.js',
      "export * from '../generated/design.pandamstyle';\n",
    );
    expect(revise(h, { added: [relay] }).ok).toBe(true);

    const consumer = edit(
      h,
      'src/star-consumer.js',
      "import { create, token, props, themes } from './star-relay';\n" +
        "export const s = create({ a: { padding: token('spacing.md') } });\n" +
        'export const p = props(themes.light, s.a);\n',
    );
    const v = revise(h, { added: [consumer] });
    expect(v.ok).toBe(true);
    expect(
      viewOf(h, 'src/star-consumer.js').validity.designSystemViewDigest,
    ).not.toBeNull();
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);

    // Taking the relay away must take the recognition with it.
    fs.rmSync(relay);
    const broken = revise(h, { removed: [relay] });
    expect(broken.ok).toBe(false);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a deleted relay is repaired by its file reappearing', () => {
    revise(h);
    const before = viewOf(h, 'src/renamed.js');
    expect(before.validity.designSystemViewDigest).not.toBeNull();
    const barrelBytes = fs.readFileSync(h.src(BARREL), 'utf8');

    // The relay goes. Its consumers lose their bindings, the revision is
    // refused, and every view is still exactly the view a fresh computation
    // produces.
    fs.rmSync(h.src(BARREL));
    const broken = revise(h, { removed: [h.src(BARREL)] });
    expect(broken.ok).toBe(false);
    expect(broken.diagnostics.map((d) => d.code)).toContain('PMS_COVERAGE_GAP');

    // It comes back, and the recognition returns with it.
    const restored = edit(h, BARREL, barrelBytes);
    const repaired = revise(h, { added: [restored] });
    expect(repaired.ok).toBe(true);
    expect(
      viewOf(h, 'src/renamed.js').validity.designSystemViewDigest,
    ).not.toBeNull();
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a relay that STOPS reaching the design system, and starts again', () => {
    revise(h);
    const before = viewOf(h, 'src/renamed.js');
    expect(before.validity.designSystemViewDigest).not.toBeNull();
    const barrelBytes = fs.readFileSync(h.src(BARREL), 'utf8');

    // The barrel KEEPS RESOLVING. It simply stops being a relay: it is still
    // the file the pages import, and it no longer reaches the generated design
    // system. This is the case the deleted-relay test above cannot reach, and it
    // is the one that broke: an answer that is `null` has no chain, and a cache
    // that versions the chain has nothing to invalidate - so the `null` was
    // still the answer one revision later, after the relay came back.
    const broken = edit(h, BARREL, 'export const nothing = 1;\n');
    expect(revise(h, { changed: [broken] }).ok).toBe(true);
    expect(
      viewOf(h, 'src/renamed.js').validity.designSystemViewDigest,
    ).not.toBe(before.validity.designSystemViewDigest);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);

    // And it comes back. The recognition has to come back with it, and the
    // digest has to be the one it was before the interruption rather than
    // merely a non-null one.
    const restored = edit(h, BARREL, barrelBytes);
    expect(revise(h, { changed: [restored] }).ok).toBe(true);
    expect(viewOf(h, 'src/renamed.js').validity.designSystemViewDigest).toBe(
      before.validity.designSystemViewDigest,
    );
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a module that ENTERS coverage through an import gets a view', () => {
    revise(h);

    // The new module is never declared. It arrives because a declared page
    // imports it, and the coverage closure is what puts it inside the covered
    // set - which is precisely why nothing in the design-system view refresh
    // was looking at it.
    write(h.project, 'src/late.js', 'export const late = 1;\n');
    const importer = edit(
      h,
      'src/late-consumer.js',
      "import { late } from './late';\nexport const l = late;\n",
    );
    expect(revise(h, { added: [importer] }).ok).toBe(true);

    // A file with no imports has an EMPTY view, not an absent one. The digest of
    // nothing is the hash of nothing, and a host comparing the incremental
    // state against a fresh one has to be able to tell "this file's view is
    // empty" from "this file has no view at all".
    const late = viewOf(h, 'src/late.js');
    expect(late).not.toBeNull();
    expect(late.validity.designSystemViewDigest).not.toBeNull();
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('a relay depth budget is part of the view', () => {
    h.setBuildOption('engineOptions', { maxRelayDepth: 1 });
    revise(h);
    const shallow = viewOf(h, 'src/renamed.js');
    expect(shallow.validity.designSystemViewDigest).not.toBeNull();

    // A chain of relays longer than the budget reaches nothing, so the view of
    // a page behind it changes - and the memo key has to notice that the budget
    // changed, not only that the chain did.
    h.setBuildOption('engineOptions', { maxRelayDepth: 16 });
    h.session.applyChanges({
      config: { engineOptions: { maxRelayDepth: 16 } },
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
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  // ------------------------------------------------- semantic update ---

  test('a design-system value change does not rebuild helper binding views', () => {
    revise(h);
    const definitionPath = h.definitionPath;
    const before = fs.readFileSync(definitionPath, 'utf8');
    const after = before.replace(/md: \{ value: '16px'/, "md: { value: '18px'");
    expect(after).not.toBe(before);
    fs.writeFileSync(definitionPath, after, 'utf8');

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
    if (v.ok) h.session.compile();

    expect(v.ok).toBe(true);
    expect(v.counters.fullFallback).toBe(0);
    expect(v.counters.fullFallbackReason).toBeNull();
    const c = counters(h);
    expect(c.dsv_full_fallback ?? 0).toBe(0);
    expect(v.counters.designSystemViewsRecomputed).toBe(0);
    expect(v.counters.filesRecompiled).toBe(0);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  test('the relay cache survives a value-only design-system rebuild', () => {
    revise(h);
    const size = h.session.stats().dsViewRelayAnswerCount;
    expect(size).toBeGreaterThan(0);

    const definitionPath = h.definitionPath;
    const before = fs.readFileSync(definitionPath, 'utf8');
    fs.writeFileSync(
      definitionPath,
      before.replace(/md: \{ value: '16px'/, "md: { value: '18px'"),
      'utf8',
    );
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
    h.session.validate();

    // The binding surface and relay graph are unchanged, so their answers stay
    // valid while the separate token CSS/data nodes move.
    const sizeAfter = h.session.stats().dsViewRelayAnswerCount;
    expect(sizeAfter).toBe(size);
    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
  });

  // -------------------------------------------------------------- oracle ---

  test('after a mixed trace the incremental views equal fresh views', () => {
    revise(h);
    expect(revise(h).ok).toBe(true);

    const touched = edit(
      h,
      'src/page.tsx',
      `${fs.readFileSync(h.src('src/page.tsx'), 'utf8')}\n// touched\n`,
    );
    expect(revise(h, { changed: [touched] }).ok).toBe(true);

    const relay = edit(
      h,
      BARREL,
      `${fs.readFileSync(h.src(BARREL), 'utf8')}\nexport const marker = 1;\n`,
    );
    expect(revise(h, { changed: [relay] }).ok).toBe(true);

    const consumer = edit(
      h,
      'src/mixed-consumer.js',
      "import { create, token, props, themes } from './barrel';\n" +
        "export const s = create({ a: { padding: token('spacing.sm') } });\n" +
        'export const p = props(themes.dark, s.a);\n',
    );
    expect(revise(h, { added: [consumer] }).ok).toBe(true);

    fs.rmSync(consumer);
    expect(revise(h, { removed: [consumer] }).ok).toBe(true);

    expect(h.session.verifyDesignSystemViews().differences).toEqual([]);
    expect(h.session.verifyCoverageGraph().differences).toEqual([]);
  });
});
