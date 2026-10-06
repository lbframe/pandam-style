/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle: the incremental PROJECT SESSION (Spike 2, Phase A).
 *
 * Every test here has the same shape of claim: an incremental revision is
 * compared against a FRESH FULL REBUILD of the same bytes, and the published
 * generation - the bytes a reader would load - must be identical. A session
 * that is fast because it is wrong is the failure mode this file exists to
 * make impossible.
 *
 * The traces are LONG and SEQUENTIAL, not isolated one-shot fixtures. A session
 * that is correct on revision 1 and wrong on revision 40 after a removal, a
 * repair and a fallback has learned nothing useful, and that is the shape the
 * agent edit loop actually has.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');

const {
  comparePublished,
  differential,
  makeParseCounter,
  openProject,
} = require('./session-helpers');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
function replaceIn(file, before, after) {
  const original = read(file);
  if (!original.includes(before)) {
    throw new Error(
      `test precondition failed: ${file} does not contain ${JSON.stringify(
        before,
      )}`,
    );
  }
  return write(file, original.replace(before, after));
}

const PAGE = 'src/page.tsx';
const BARREL = 'src/barrel.js';

describe('project session: reuse is decided by content, not by path', () => {
  let h;

  beforeAll(() => {
    h = openProject('valid');
  });
  afterAll(() => h.session.close());

  test('revision 1 analyses the whole covered set', () => {
    const v = h.revise({ initial: true });
    expect(v.ok).toBe(true);
    expect(v.revisionId).toBe(1);
    expect(v.counters.filesRecompiled).toBeGreaterThan(1);
    expect(v.counters.filesReused).toBe(0);
  });

  test('a no-change revision recompiles nothing and reuses everything', () => {
    const v = h.revise();
    expect(v.ok).toBe(true);
    expect(v.counters.filesChanged).toBe(0);
    expect(v.counters.filesRecompiled).toBe(0);
    expect(v.counters.filesReused).toBeGreaterThan(1);
  });

  test('a changed file is recompiled and the others are not', () => {
    const before = h.revise().counters;
    expect(before.filesRecompiled).toBe(0);
    replaceIn(
      h.src(PAGE),
      "gap: token('spacing.md'),",
      "gap: token('spacing.lg'),",
    );
    const v = h.revise();
    expect(v.ok).toBe(true);
    expect(v.counters.filesChanged).toBe(1);
    expect(v.counters.filesRecompiled).toBe(1);
    expect(v.counters.reverseDependentsInvalidated).toBe(0);
  });

  test('the validity key is not the path and not a timestamp', () => {
    const key = h.session.validityOf(h.src(PAGE));
    expect(key).not.toBeNull();
    expect(Object.keys(key).sort()).toEqual([
      'compilerContractVersion',
      'designSystemViewDigest',
      'engineOptionsDigest',
      'projectSemanticEpoch',
      'resolutionDigest',
      'role',
      'semanticUnitsDigest',
      'sourceHash',
      'useCSSLayers',
    ]);
    expect(key.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toHaveProperty('path');
    expect(key).not.toHaveProperty('mtime');
  });
});

describe('project session: a no-change revision performs zero real parses', () => {
  let h;
  let collector;
  let uninstall;

  beforeAll(() => {
    h = openProject('valid');
    collector = makeParseCounter();
    uninstall = h.compiler.installPerfCollector(collector);
  });
  afterAll(() => {
    uninstall();
    h.session.close();
  });

  test('the first revision parses, the second does not', () => {
    collector.reset();
    h.revise({ initial: true });
    const cold = collector.events.length;
    expect(cold).toBeGreaterThan(0);

    collector.reset();
    const v = h.revise();
    expect(v.ok).toBe(true);
    // A no-op that re-ran Babel on every file would be a no-op only in name.
    expect(collector.events).toEqual([]);
    expect(v.counters.filesReparsed).toBe(0);
    expect(v.counters.filesRecompiled).toBe(0);
  });
});

describe('project session: Babel pass 2 lowers the pass 1 AST without parsing again', () => {
  let h;
  let collector;
  let uninstall;

  beforeAll(() => {
    h = openProject('valid');
    collector = makeParseCounter();
    uninstall = h.compiler.installPerfCollector(collector);
  });
  afterAll(() => {
    uninstall();
    h.session.close();
  });

  test('a changed page has one module-graph parse and one authored Babel parse', () => {
    expect(h.revise({ initial: true }).ok).toBe(true);
    collector.reset();
    const file = h.src(PAGE);
    replaceIn(file, "gap: token('spacing.md')", "gap: token('spacing.lg')");

    const revision = h.revise({ changedFiles: [file] });

    expect(revision.ok).toBe(true);
    const fileParses = collector.events.filter((event) => event.file === file);
    expect(
      fileParses
        .filter((event) => event.pipeline.startsWith('babel:'))
        .map((event) => event.pipeline),
    ).toEqual(['babel:pass1']);
    expect(
      fileParses.filter((event) => event.pipeline === 'module-graph'),
    ).toHaveLength(1);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

describe('project session: an invalid revision, a repair, and the module graph', () => {
  let h;
  const trace = [];

  beforeAll(() => {
    h = openProject('valid');
  });
  afterAll(() => h.session.close());

  const step = (label, changes) => {
    const r = differential(h, label, changes);
    trace.push(
      `${label}: rev=${r.revisionId} ok=${r.validation.ok} ` +
        `changed=${r.validation.counters.filesChanged} ` +
        `reparsed=${r.validation.counters.filesReparsed} ` +
        `recompiled=${r.validation.counters.filesRecompiled} ` +
        `reused=${r.validation.counters.filesReused} ` +
        `revdep=${r.validation.counters.reverseDependentsInvalidated} ` +
        `negres=${r.validation.counters.negativeResolutionsInvalidated} ` +
        `fallback=${r.validation.counters.fullFallbackReason ?? '-'} ` +
        `=> ${r.findings.length === 0 ? 'equivalent' : r.findings.join('; ')}`,
    );
    return r;
  };

  test('the whole revision trace stays equivalent to a fresh rebuild', () => {
    // valid
    step('valid', { initial: true });
    // no change at all
    step('no change');
    // a local style change with an unchanged module interface
    replaceIn(
      h.src(PAGE),
      "gap: token('spacing.md'),",
      "gap: token('spacing.lg'),",
    );
    step('style change');
    // a re-export change on the relay module
    replaceIn(h.src(BARREL), '  props,\n', '  props,\n  manifest,\n');
    step('re-export change');
    // a forbidden value: the revision must be refused
    replaceIn(h.src(PAGE), "gap: token('spacing.lg'),", "gap: '11px',");
    const invalid = step('forbidden value');
    expect(invalid.validation.ok).toBe(false);
    expect(invalid.validation.diagnostics.map((d) => d.code)).toContain(
      'PMS_FORBIDDEN_VALUE',
    );
    // the repair, in the same session, with no restart
    replaceIn(h.src(PAGE), "gap: '11px',", "gap: token('spacing.md'),");
    const repaired = step('repair');
    expect(repaired.validation.ok).toBe(true);
    // a newly covered file
    const added = h.src('src/added.tsx');
    write(
      added,
      "import { create, token, props } from '../generated/design.pandamstyle';\n" +
        "const s = create({ r: { padding: token('spacing.md') } });\n" +
        'export const Added = () => <div {...props(s.r)} />;\n',
    );
    const add = step('module add', { addedFiles: [added] });
    expect(add.validation.counters.filesRecompiled).toBe(1);
    // a file rename: the old name disappears, the new one appears
    const renamed = h.src('src/renamed-moved.tsx');
    fs.renameSync(added, renamed);
    step('file rename', { addedFiles: [renamed], removedFiles: [added] });
    // a module that leaves the covered set entirely
    fs.rmSync(renamed, { force: true });
    step('module remove', { removedFiles: [renamed] });
    // a negative resolution, and then its target appearing
    replaceIn(
      h.src(PAGE),
      'import { create, token, recipes, themes, props }',
      "import { later } from './later-module';\n" +
        'import { create, token, recipes, themes, props }',
    );
    const unresolved = step('unresolved import');
    expect(unresolved.validation.ok).toBe(false);
    const later = h.src('src/later-module.ts');
    write(later, "export const later = 'present';\n");
    const repaired2 = step('the missing module appears', {
      addedFiles: [later],
    });
    expect(repaired2.validation.ok).toBe(true);
    expect(repaired2.validation.counters.negativeResolutionsInvalidated).toBe(
      1,
    );

    expect(trace).toEqual(
      expect.arrayContaining([expect.stringContaining('=> equivalent')]),
    );
    expect(
      trace.filter((t) => t.includes('=>') && !t.includes('equivalent')),
    ).toEqual([]);
  });
});

describe('project session: reverse dependencies and stale state', () => {
  let h;

  beforeAll(() => {
    h = openProject('valid');
    h.revise({ initial: true });
  });
  afterAll(() => h.session.close());

  test('a style-only edit to a relay invalidates nothing but the relay', () => {
    // Make the barrel a real relay for a page, so the propagation is observable.
    replaceIn(
      h.src('src/only-recipe.js'),
      "from '../generated/design.pandamstyle'",
      "from './barrel'",
    );
    const relayConsumer = h.src('src/only-recipe.js');
    let v = h.revise();
    expect(v.ok).toBe(true);
    expect(v.counters.filesRecompiled).toBe(1);
    const afterJoin = h.session.validityOf(relayConsumer);
    expect(afterJoin.designSystemViewDigest).not.toBeNull();

    // A comment-only edit to the relay changes nothing a consumer relies on:
    // the consumer is reused, and its design-system view is byte-identical.
    replaceIn(h.src(BARREL), '/** Intermediate', '/** Intermediate relay');
    v = h.revise();
    expect(v.counters.filesRecompiled).toBe(1);
    expect(v.counters.reverseDependentsInvalidated).toBe(0);
    expect(h.session.validityOf(relayConsumer).designSystemViewDigest).toBe(
      afterJoin.designSystemViewDigest,
    );
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('breaking the relay invalidates the files that consumed it', () => {
    const relayConsumer = h.src('src/only-recipe.js');
    const before = h.session.validityOf(relayConsumer);
    expect(before.designSystemViewDigest).not.toBeNull();

    // The barrel stops reaching the design system. Every file that reached it
    // THROUGH the barrel loses its PandamStyle bindings, and the session has to
    // know that without being told which files those are.
    write(h.src('src/plain.js'), 'export const nothing = 1;\n');
    replaceIn(
      h.src(BARREL),
      "} from '../generated/design.pandamstyle';",
      "} from './plain';",
    );
    const v = h.revise();
    expect(v.counters.reverseDependentsInvalidated).toBeGreaterThanOrEqual(1);
    expect(h.session.validityOf(relayConsumer).designSystemViewDigest).not.toBe(
      before.designSystemViewDigest,
    );
    // Whatever the verdict is, it is the verdict a fresh full rebuild of the
    // same bytes reaches, and the published bytes are the same.
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a deleted file leaves no stale rule and no stale diagnostic', () => {
    const victim = h.src('src/conditional-props.tsx');
    const withVictim = read(h.outDir + '/styles.css');
    expect(withVictim.length).toBeGreaterThan(0);
    fs.rmSync(victim, { force: true });
    const v = differential(h, 'module delete');
    expect(v.findings).toEqual([]);
    expect(v.validation.counters.filesRemoved).toBe(1);
    expect(v.validation.counters.filesRecompiled).toBe(0);
    const without = read(h.outDir + '/styles.css');
    expect(without.length).toBeLessThan(withVictim.length);
    const report = JSON.parse(read(path.join(h.outDir, 'build-report.json')));
    // The coverage snapshot is a separate document now (Phase C), so the
    // assertion asks for it. What it is really checking is unchanged: the
    // deleted file is not in the project's coverage.
    const entries = h.auditState().coverage.entries;
    expect(entries.some((c) => c.file.endsWith('conditional-props.tsx'))).toBe(
      false,
    );
    expect(report.coverageSummary.entries).toBe(entries.length);
    expect(report.coveredFileCount).toBe(entries.length);
  });

  test('a design-system value change invalidates semantic consumers only', () => {
    const v0 = h.revise();
    expect(v0.counters.fullFallback).toBe(0);

    // The session decides on the definition's CONTENT, not on object identity:
    // a build tool re-requires its configuration module on every revision, so
    // identity would make every revision a full fallback. The test therefore
    // changes the BYTES and asserts that the change - and only a real change -
    // is what triggers it.
    const definitionPath = h.definitionPath;
    const before = read(definitionPath);
    const after = before.replace(/md: \{ value: '16px'/, "md: { value: '18px'");
    expect(after).not.toBe(before);
    write(definitionPath, after);
    h.reloadDefinition();
    const v = h.revise({ definition: h.reloadDefinition() });
    expect(v.ok).toBe(true);
    expect(v.counters.fullFallback).toBe(0);
    expect(v.counters.fullFallbackReason).toBeNull();
    expect(v.counters.designSystemViewsRecomputed).toBeLessThan(10);
    expect(v.counters.filesRecompiled).toBe(0);
    expect(v.counters.semanticEntitiesChanged).toBeGreaterThan(0);
    expect(v.counters.generatedTypesRegenerated).toBe(1);
    expect(differential(h, 'after semantic-unit update').findings).toEqual([]);

    // The SAME design system, re-read from its bytes, is not a change. Every
    // real driver re-loads its configuration module on every revision, so a
    // session that keyed on identity would be a full rebuild wearing a
    // session's name.
    const same = h.revise({ definition: h.reloadDefinition() });
    expect(same.ok).toBe(true);
    expect(same.counters.fullFallback).toBe(0);
    expect(same.counters.filesRecompiled).toBe(0);
    expect(differential(h, 'unchanged design system').findings).toEqual([]);
  });

  test('a build-configuration change is a full fallback too', () => {
    h.setBuildOption('useCSSLayers', true);
    const v = h.revise({ config: { useCSSLayers: true } });
    expect(v.ok).toBe(true);
    expect(v.counters.fullFallbackReason).toBe('compiler-configuration');
    expect(v.counters.generatedTypesRegenerated).toBe(0);
    expect(v.counters.generatedTypesReused).toBe(1);
    expect(differential(h, 'css layers on').findings).toEqual([]);
    h.setBuildOption('useCSSLayers', false);
    const back = h.revise({ config: { useCSSLayers: false } });
    expect(back.ok).toBe(true);
    expect(back.counters.fullFallbackReason).toBe('compiler-configuration');
    expect(back.counters.generatedTypesRegenerated).toBe(0);
    expect(back.counters.generatedTypesReused).toBe(1);
    expect(differential(h, 'css layers off').findings).toEqual([]);
  });
});

describe('project session: publication is transactional across revisions', () => {
  let h;

  beforeAll(() => {
    h = openProject('valid');
    h.revise({ initial: true });
  });
  afterAll(() => h.session.close());

  test('a failed revision keeps the last published generation current', () => {
    const generationBefore = h.published();
    const digestBefore = h.session.current();
    expect(digestBefore).not.toBeNull();

    replaceIn(h.src(PAGE), "gap: token('spacing.md'),", "gap: '13px',");
    h.session.applyChanges();
    const v = h.session.validate();
    expect(v.ok).toBe(false);
    expect(v.diagnostics.map((d) => d.code)).toContain('PMS_FORBIDDEN_VALUE');
    expect(() => h.session.compile()).toThrow();

    // The published tree is byte for byte the previous generation, and the
    // session still names the previous generation as current.
    expect(h.published()).toEqual(generationBefore);
    expect(h.session.current()).toEqual(digestBefore);

    // A repair publishes normally, without restarting the session.
    replaceIn(h.src(PAGE), "gap: '13px',", "gap: token('spacing.md'),");
    const repaired = h.revise();
    expect(repaired.ok).toBe(true);
    expect(h.session.current().revisionId).toBe(repaired.revisionId);
    expect(differential(h, 'after repair').findings).toEqual([]);
  });
});

describe('project session: every result carries its revision', () => {
  let h;

  beforeAll(() => {
    h = openProject('valid');
  });
  afterAll(() => h.session.close());

  test('revision ids increase and are reported on the generation', () => {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const v = h.revise();
      seen.push(v.revisionId);
      const report = JSON.parse(read(path.join(h.outDir, 'build-report.json')));
      expect(report.incremental.revisionId).toBe(v.revisionId);
      expect(report.incremental.generationId).toBe(i + 1);
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(h.session.current()).toEqual({
      revisionId: 4,
      generationId: 4,
      registryDigest: expect.any(String),
    });
  });

  test('a result from an older revision is never presented as current', () => {
    const stale = h.revise();
    expect(stale.revisionId).toBe(5);
    replaceIn(h.src(PAGE), 'spacing.md', 'spacing.lg');
    const next = h.revise();
    expect(next.revisionId).toBe(6);
    expect(h.session.current().revisionId).toBe(6);
    const report = JSON.parse(read(path.join(h.outDir, 'build-report.json')));
    expect(report.incremental.revisionId).toBe(6);
  });
});

describe('project session: memory stays bounded over a long session', () => {
  test('a thousand revisions do not grow the session without bound', () => {
    const h = openProject('valid');
    const page = h.src(PAGE);
    const original = read(page);
    const samples = [];
    const scratch = h.src('src/scratch.tsx');
    const scratchSource =
      "import { create, token, props } from '../generated/design.pandamstyle';\n" +
      "const s = create({ r: { padding: token('spacing.md') } });\n" +
      'export const Scratch = () => <div {...props(s.r)} />;\n';
    let published = 0;

    for (let i = 0; i < 1000; i++) {
      const kind = i % 10;
      if (kind === 3) {
        // an invalid revision
        write(
          page,
          original.replace("gap: token('spacing.md'),", "gap: '3px',"),
        );
      } else if (kind === 4) {
        // its repair
        write(page, original);
      } else if (kind === 5) {
        // a churned module
        fs.rmSync(scratch, { force: true });
      } else if (kind === 6) {
        write(scratch, scratchSource);
      } else {
        // a local edit that is reverted, so the file always ends valid
        write(page, original.replace("'spacing.md'", "'spacing.lg'"));
        if (kind === 7) write(page, original);
      }
      h.session.applyChanges();
      const validation = h.session.validate();
      // A real agent loop publishes; a session that never publishes is not
      // holding a generation, and the memory question is about the session
      // that does. Every tenth revision is published, which is enough to
      // exercise the transactional snapshot and restore on every path.
      if (validation.ok && i % 10 === 9) {
        h.session.compile();
        published += 1;
      }
      if (i % 100 === 0 || i === 999) {
        if (global.gc) global.gc();
        samples.push({ revision: i + 1, published, ...h.session.stats() });
      }
    }
    const first = samples[1];
    const last = samples[samples.length - 1];
    expect(published).toBeGreaterThan(50);
    // The session must not retain a revision per revision: file states track
    // the CURRENT covered set, so the churned module is gone again.
    expect(last.fileStateCount).toBeLessThanOrEqual(first.fileStateCount + 1);
    expect(last.resolutionKeyCount).toBeLessThanOrEqual(
      first.resolutionKeyCount + 4,
    );
    // Every revision that was prepared and not published is accounted for,
    // never silently dropped and never merged into the next one.
    expect(last.supersededRevisions).toBe(1000 - published);
    // The STRUCTURAL counts above are the leak test: they are the things a
    // session retains per covered file and per resolution key, so a session
    // that grew with the revision count would move them. Heap is checked too,
    // but only as a loose guard - the test runner does not expose `gc`, so
    // `heapUsedBytes` here is uncollected garbage as much as retained state.
    // The long-session benchmark records the real memory trace with a forced
    // collection between samples.
    expect(last.heapUsedBytes).toBeLessThan(
      first.heapUsedBytes + 256 * 1024 * 1024,
    );
    h.session.close();
  }, 600000);
});
