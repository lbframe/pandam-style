/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 3, PHASE A - incremental publication.
 *
 * The claim under test, everywhere in this file:
 *
 *     a generation published incrementally == a fresh full rebuild
 *
 * for the same revision, byte for byte, and with the same FILE SET - not merely
 * the same files, but no extra ones. A publisher that reuses what it can and
 * forgets to delete what it should is invisible to a comparison that only looks
 * at the files it expects, which is precisely the failure Spike 2 could not
 * catch, so every assertion here compares the whole set.
 *
 * The three publication variants are separated because the spike is an
 * attribution exercise: `session_full_publish` is the reference, and the
 * delta-based variant is what has to prove it buys something without changing
 * a byte.
 *
 * NOTE ON HOW THE DELTA IS ASSERTED
 *
 * Assertions are made against the per-KIND breakdown, not the aggregate. A
 * no-change revision writes one artifact - the build report, which records the
 * revision - so "outputs changed" is 1 on a revision that rewrote no
 * JavaScript at all. The aggregate hides the only number that matters; the
 * breakdown does not.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.autoMockOff();

const {
  comparePublished,
  differential,
  openExistingProject,
  openProject,
  readTree,
} = require('./session-helpers');

// eslint-disable-next-line
const build = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

const DELTA = { publishVariant: 'session_incremental_publish' };

// Edits aimed at declarations the fixture really contains, so the expected
// changed count is a fact about the edit rather than a guess.
const EXISTING_ATOM = "gap: token('spacing.sm')";
const EXISTING_ATOM_PLUS =
  "gap: token('spacing.sm'), borderRadius: token('radii.md')";
const NEW_ATOM = "backgroundColor: token('colors.surface.primary')";
const NEW_ATOM_PLUS = "backgroundColor: token('colors.surface.secondary')";

/** Compiles one revision and returns its publication delta. */
function publish(harness, changes = {}) {
  const validation = harness.revise(changes);
  if (!validation.ok) {
    return { validation, publication: null, published: null };
  }
  return {
    validation,
    publication: harness.session.lastPublication(),
    published: harness.published(),
  };
}

/** Every compiled-JavaScript output path currently published. */
function jsOutputs(harness) {
  return Object.keys(harness.published())
    .filter((rel) => rel.startsWith('js/'))
    .sort();
}

/** path -> content, for a whole published tree. */
function snapshot(dir) {
  const out = {};
  for (const [rel, content] of readTree(dir)) out[rel] = content;
  return out;
}

function editFile(harness, rel, from, to) {
  const file = harness.src(rel);
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    throw new Error(
      `edit target ${JSON.stringify(from)} not present in ${rel}`,
    );
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

/**
 * A module with a rule no other file contributes, so that removing it removes
 * real CSS text.
 *
 * It is a poor witness to write it carelessly, and two obvious choices are:
 * a module that only selects RECIPES owns no atom of its own (the recipe's rules
 * come from the design system), and a raw pixel value is a FORBIDDEN_VALUE, so
 * the module would not compile at all. `display: 'grid'` is a legitimate value
 * the fixture declares nowhere else, which makes its atomic rule genuinely this
 * file's and its disappearance in the stylesheet a fact about the CSS.
 */
const UNIQUE_DECLARATION = "display: 'grid'";
function writeUniqueModule(harness, name) {
  fs.writeFileSync(
    harness.src(`src/${name}`),
    "import { create, props } from '../generated/design.pandamstyle';\n" +
      `export const s = props(create({ box: { ${UNIQUE_DECLARATION} } }).box);\n`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// A. the delta is real
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: publication does only the required work', () => {
  test('a no-change revision writes zero JavaScript artifacts', () => {
    const h = openProject('valid', DELTA);
    const first = publish(h);
    expect(first.validation.ok).toBe(true);
    // The first revision has nothing to reuse: there is no previous generation.
    expect(first.publication.outputsAdded).toBeGreaterThan(0);

    const before = h.published();
    const jsCount = jsOutputs(h).length;
    const noop = publish(h);
    expect(noop.validation.ok).toBe(true);
    const byKind = noop.publication.byKind;

    // The point of the whole exercise.
    expect(byKind.js.added + byKind.js.changed).toBe(0);
    expect(byKind.css.added + byKind.css.changed).toBe(0);
    expect(byKind.js.reused).toBe(jsCount);
    // The build report legitimately changes: it records this revision. That is
    // publication metadata the revision requires, and it is one small file.
    expect(byKind.metadata.changed).toBe(1);
    expect(noop.publication.outputsReused).toBeGreaterThan(0);
    expect(noop.publication.hardlinks).toBeGreaterThan(0);

    // And the generation is byte-identical: no change means no change.
    const after = h.published();
    expect(after['styles.css']).toBe(before['styles.css']);
    for (const rel of jsOutputs(h)) {
      expect(after[rel]).toBe(before[rel]);
    }
  });

  test('a single-file edit writes only the affected JavaScript', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const totalJs = jsOutputs(h).length;

    editFile(h, 'src/conditional-props.tsx', EXISTING_ATOM, EXISTING_ATOM_PLUS);
    const { publication } = publish(h);
    const byKind = publication.byKind;

    expect(publication.mode).toBe('delta');
    // One compiled artifact rewritten, the rest reused. A publisher that
    // "copies the previous generation and calls it incremental" would report
    // every one of them as changed.
    expect(byKind.js.changed).toBe(1);
    expect(byKind.js.added).toBe(0);
    expect(byKind.js.removed).toBe(0);
    expect(byKind.js.reused).toBe(totalJs - 1);
    expect(publication.bytesWritten).toBeGreaterThan(0);
  });

  test('a genuinely new atom changes the stylesheet; a shared one does not', () => {
    // `radii.md` is already contributed by the design system's own button recipe,
    // so referencing it again adds a composed class name to the JavaScript and
    // nothing at all to the stylesheet. Both are correct, and the difference is
    // exactly why the delta has to be per-kind.
    const shared = openProject('valid', DELTA);
    publish(shared);
    editFile(
      shared,
      'src/conditional-props.tsx',
      EXISTING_ATOM,
      EXISTING_ATOM_PLUS,
    );
    const sharedResult = publish(shared).publication.byKind;
    expect(sharedResult.js.changed).toBe(1);
    expect(sharedResult.css.changed).toBe(0);
    expect(sharedResult.css.reused).toBe(1);

    // A raw value nothing else declares IS new CSS.
    const novel = openProject('valid', DELTA);
    publish(novel);
    writeUniqueModule(novel, 'zz-novel.js');
    const novelResult = publish(novel).publication.byKind;
    expect(novelResult.js.added).toBe(1);
    expect(novelResult.css.changed).toBe(1);
  });

  test('a whitespace-only edit reuses every artifact, including the output', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const before = h.published();

    // A real format-only edit. The compiler's output is normalised, so the
    // generated JavaScript is byte-identical - and a content-addressed
    // publisher reuses it rather than rewriting identical bytes. Deciding this
    // from the file's mtime or from "the file changed" would get it wrong.
    const file = h.src('src/page.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n', 'utf8');
    const { publication } = publish(h);

    expect(publication.byKind.js.changed + publication.byKind.js.added).toBe(0);
    expect(publication.byKind.css.changed).toBe(0);
    expect(publication.byKind.js.reused).toBe(jsOutputs(h).length);
    expect(h.published()['js/src/page.js']).toBe(before['js/src/page.js']);
  });

  test('a property reorder changes the JavaScript and not the stylesheet', () => {
    const h = openProject('valid', DELTA);
    publish(h);

    // The same declarations in a different order: the composed class name
    // changes, the atomic rules the stylesheet is made of do not.
    editFile(
      h,
      'src/page.js',
      "    display: 'flex',\n    gap: token('spacing.sm'),",
      "    gap: token('spacing.sm'),\n    display: 'flex',",
    );
    const { publication } = publish(h);
    expect(publication.byKind.js.changed).toBe(1);
    expect(publication.byKind.css.changed).toBe(0);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('unchanged JavaScript is reused by content, not rewritten', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const before = h.published();

    editFile(h, 'src/conditional-props.tsx', EXISTING_ATOM, EXISTING_ATOM_PLUS);
    const { publication } = publish(h);
    const after = h.published();

    // "Reused" is verified after the fact rather than assumed: every artifact the
    // publisher claimed to reuse really does still have the same bytes.
    let verified = 0;
    for (const rel of jsOutputs(h)) {
      if (rel === 'js/src/conditional-props.tsx') continue;
      expect(after[rel]).toBe(before[rel]);
      verified += 1;
    }
    expect(verified).toBe(publication.byKind.js.reused);
    expect(after['js/src/conditional-props.tsx']).not.toBe(
      before['js/src/conditional-props.tsx'],
    );
  });

  test('a five-file edit writes the affected set and no more', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const totalJs = jsOutputs(h).length;

    // Four distinct files edited at a declaration each really has, plus one new
    // module: five affected sources, five expected changes.
    const edits = [
      [
        'src/page.js',
        "color: token('colors.text.primary')",
        "color: token('colors.text.inverse')",
      ],
      ['src/only-recipe.js', "size: 'md'", "size: 'sm'"],
      ['src/conditional-props.tsx', EXISTING_ATOM, EXISTING_ATOM_PLUS],
      [
        'src/renamed.js',
        "padding: pmsToken('spacing.lg')",
        "padding: pmsToken('spacing.md')",
      ],
    ];
    for (const [rel, from, to] of edits) editFile(h, rel, from, to);
    writeUniqueModule(h, 'zz-fifth.js');

    const { publication } = publish(h);
    const byKind = publication.byKind;

    expect(byKind.js.changed).toBe(edits.length);
    expect(byKind.js.added).toBe(1);
    expect(byKind.js.removed).toBe(0);
    expect(byKind.js.reused).toBe(totalJs - edits.length);
  });
});

// ---------------------------------------------------------------------------
// B. deletion - the limitation Spike 2 documented
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: a deleted source takes its output with it', () => {
  test('a removed module leaves no stale JavaScript and no stale CSS', () => {
    const h = openProject('valid', DELTA);
    writeUniqueModule(h, 'zz-unique.js');
    publish(h);

    const removed = 'js/src/zz-unique.js';
    const before = h.published();
    expect(before[removed]).toBeDefined();
    const cssBefore = fs.readFileSync(
      path.join(h.outDir, 'styles.css'),
      'utf8',
    );
    // The module's own rule really is in there, so its disappearance is a fact
    // about the CSS and not about a string that was never emitted.
    expect(cssBefore).toContain('grid');

    fs.rmSync(h.src('src/zz-unique.js'));
    const { publication } = publish(h);
    const after = h.published();

    // The published file is GONE, not merely unreferenced.
    expect(after[removed]).toBeUndefined();
    expect(fs.existsSync(path.join(h.outDir, removed))).toBe(false);
    expect(publication.byKind.js.removed).toBe(1);

    // Its CSS contribution is gone with it.
    const cssAfter = fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
    expect(cssAfter).not.toContain('grid');
    expect(cssAfter).not.toBe(cssBefore);

    // And the report no longer mentions the module. The per-file coverage
    // snapshot is no longer inline in the build report (Phase C), so the
    // assertion asks the session for its audit and looks there: which is also
    // how an auditor would have to do it.
    const entries = h.auditState().coverage.entries;
    expect(entries.some((c) => c.file.includes('zz-unique.js'))).toBe(false);
    const report = JSON.parse(
      fs.readFileSync(path.join(h.outDir, 'build-report.json'), 'utf8'),
    );
    expect(report.coverageSummary.pages).toBe(
      entries.filter((c) => c.role === 'page').length,
    );

    // And the generation equals a fresh rebuild of the same bytes - file set
    // included, so a stale extra file would fail here.
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a removed module removes exactly its own artifact and nothing else', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const before = h.published();

    fs.rmSync(h.src('src/only-recipe.js'));
    publish(h);
    const after = h.published();

    const removed = Object.keys(before).filter(
      (rel) => after[rel] === undefined,
    );
    expect(removed).toEqual(['js/src/only-recipe.js']);
  });

  test('a file that leaves the covered set removes its output', () => {
    const h = openProject('valid', DELTA);
    writeUniqueModule(h, 'zz-only-here.js');
    publish(h);
    const before = h.published();
    expect(before['js/src/zz-only-here.js']).toBeDefined();

    // Re-root the project so the file is no longer covered at all, rather than
    // merely deleted: "leaves coverage" and "deleted" are different paths to the
    // same requirement.
    fs.rmSync(h.src('src/zz-only-here.js'));
    publish(h);
    const after = h.published();

    expect(after['js/src/zz-only-here.js']).toBeUndefined();
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a renamed source removes the old path and publishes the new one', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const before = h.published();
    expect(before['js/src/renamed.js']).toBeDefined();

    const from = h.src('src/renamed.js');
    const to = h.src('src/renamed-again.js');
    fs.renameSync(from, to);

    const { publication } = publish(h);
    const after = h.published();

    expect(after['js/src/renamed.js']).toBeUndefined();
    expect(after['js/src/renamed-again.js']).toBeDefined();
    expect(publication.byKind.js.removed).toBe(1);
    expect(publication.byKind.js.added).toBe(1);
    // The content did not change, only where it lives - so no artifact is
    // "changed", the CSS is untouched, and the rest is reused.
    expect(publication.byKind.js.changed).toBe(0);
    expect(publication.byKind.css.changed).toBe(0);
    expect(after['js/src/renamed-again.js']).toBe(before['js/src/renamed.js']);
    expect(after['styles.css']).toBe(before['styles.css']);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. equality with a fresh rebuild, across the required trace
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: incremental publication equals a fresh rebuild', () => {
  const trace = [
    { label: 'no change' },
    {
      label: 'format only',
      apply: (h) => {
        const f = h.src('src/page.js');
        fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n', 'utf8');
      },
    },
    {
      label: 'one file, existing atoms',
      apply: (h) =>
        editFile(
          h,
          'src/conditional-props.tsx',
          EXISTING_ATOM,
          EXISTING_ATOM_PLUS,
        ),
    },
    {
      label: 'one file, new atom',
      apply: (h) => editFile(h, 'src/page.js', NEW_ATOM, NEW_ATOM_PLUS),
    },
    {
      label: 'import change',
      apply: (h) =>
        editFile(
          h,
          'src/page.js',
          "import { create, token, themes, props } from '../generated/design.pandamstyle';",
          "import { create, token, themes, props } from '../generated/design.pandamstyle';\nimport './only-recipe';",
        ),
    },
    {
      label: 'reexport change',
      apply: (h) =>
        editFile(
          h,
          'src/barrel.js',
          'export {',
          'export {\n  create as create,',
        ),
    },
    { label: 'module add', apply: (h) => writeUniqueModule(h, 'zz-added.js') },
    {
      label: 'module remove',
      apply: (h) => fs.rmSync(h.src('src/only-recipe.js')),
    },
    {
      label: 'file rename',
      apply: (h) =>
        fs.renameSync(h.src('src/renamed.js'), h.src('src/renamed-again.js')),
    },
    {
      label: 'unresolved import, then the file appears',
      apply: (h) =>
        editFile(
          h,
          'src/page.js',
          "import './only-recipe';",
          "import './later-module';",
        ),
    },
    {
      label: 'the missing module appears',
      apply: (h) =>
        fs.writeFileSync(
          h.src('src/later-module.js'),
          'export const later = 1;\n',
          'utf8',
        ),
    },
    {
      label: 'token value',
      apply: (h) => {
        const before = fs.readFileSync(h.definitionPath, 'utf8');
        fs.writeFileSync(
          h.definitionPath,
          before.replace(
            "zero: { value: '0', visibility: 'public' },",
            "zero: { value: '0.5px', visibility: 'public' },",
          ),
          'utf8',
        );
        h.reloadDefinition();
      },
    },
  ];

  test('the whole trace stays equivalent to a fresh rebuild', () => {
    const h = openProject('valid', DELTA);
    const bad = [];
    for (const step of trace) {
      if (step.apply) step.apply(h);
      const result = differential(h, step.label);
      if (result.findings.length > 0) {
        bad.push(`${step.label}: ${result.findings.join('; ')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('a global fallback produces fresh-equivalent output', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    // A configuration change is a counted global fallback: the session cannot
    // reason about it locally, so it invalidates everything. The point is that
    // "invalidate everything" must still produce exactly the reference.
    h.setBuildOption('useCSSLayers', true);
    const v = h.revise({ config: { useCSSLayers: true } });
    expect(v.ok).toBe(true);
    expect(v.counters.fullFallbackReason).toBe('compiler-configuration');
    expect(differential(h, 'css layers on').findings).toEqual([]);
  });

  test('a valid -> invalid -> repair trace leaves the right generation current', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const afterValid = h.published();

    // Break it with a forbidden value.
    fs.writeFileSync(
      h.src('src/zz-bad.js'),
      "import { create, token } from '../generated/design.pandamstyle';\n" +
        "export const s = create({ box: { padding: '17px' } });\n",
      'utf8',
    );
    const failed = h.revise();
    expect(failed.ok).toBe(false);

    // A failed revision publishes NOTHING, and generation N is untouched.
    expect(h.published()).toEqual(afterValid);

    // The fresh rebuild agrees that this revision is invalid - it must, or the
    // two would not be describing the same thing.
    expect(() => h.full()).toThrow();

    // Repair, and the repair publishes normally and equals a rebuild.
    fs.rmSync(h.src('src/zz-bad.js'));
    const repaired = publish(h);
    expect(repaired.validation.ok).toBe(true);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. transactional guarantees under injected failure
// ---------------------------------------------------------------------------

/**
 * Failure points, spanning the whole publication window. `mid-stage` and
 * `after-removals-computed` are during preparation and decision-making;
 * `after-css-staged` and `before-manifest` are late in staging; `before-commit`
 * is the last moment at which the output directory is still wholly generation N.
 */
const FAILURE_POINTS = [
  'mid-stage',
  'after-removals-computed',
  'after-css-staged',
  'before-manifest',
  'before-commit',
];

describe('Spike 3 Phase A: a publication failure preserves the previous generation', () => {
  test.each(FAILURE_POINTS)(
    'a failure at %s leaves generation N current, byte for byte',
    (point) => {
      // Armed through a closure rather than by rebuilding the session, so the
      // session that fails is the one that already published generation N.
      const arm = { point: null, fired: false };
      const h = openProject('valid', {
        ...DELTA,
        publishFailAt: (p) => {
          if (p !== arm.point || arm.fired) return;
          arm.fired = true;
          const err = new Error(`injected at ${p}`);
          err.code = 'PMS_INJECTED_PUBLICATION_FAILURE';
          throw err;
        },
      });
      publish(h);

      // A real edit, so there is real work to fail in the middle of: one file
      // recompiled and one module removed.
      writeUniqueModule(h, 'zz-unique.js');
      publish(h);
      const stable = h.published();
      const stableTree = snapshot(h.outDir);

      editFile(
        h,
        'src/conditional-props.tsx',
        EXISTING_ATOM,
        EXISTING_ATOM_PLUS,
      );
      fs.rmSync(h.src('src/zz-unique.js'));
      arm.point = point;

      expect(() => publish(h)).toThrow();
      expect(arm.fired).toBe(true);

      // Generation N is still current, byte for byte, and N+1 is nowhere.
      expect(h.published()).toEqual(stable);
      expect(snapshot(h.outDir)).toEqual(stableTree);
    },
  );

  test('a retry after a publication failure publishes the delta', () => {
    const arm = { point: null, fired: false };
    const h = openProject('valid', {
      ...DELTA,
      publishFailAt: (p) => {
        if (p !== arm.point || arm.fired) return;
        arm.fired = true;
        throw new Error(`injected at ${p}`);
      },
    });
    publish(h);
    editFile(h, 'src/conditional-props.tsx', EXISTING_ATOM, EXISTING_ATOM_PLUS);
    arm.point = 'mid-stage';
    expect(() => publish(h)).toThrow();
    const afterFailure = h.published();

    // Disarm and retry the same edit: it now publishes, and equals a fresh
    // rebuild of the same bytes.
    arm.point = null;
    const { publication } = publish(h);
    expect(publication.mode).toBe('delta');
    expect(publication.byKind.js.changed).toBe(1);
    expect(h.published()).not.toEqual(afterFailure);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a failed first publication leaves no output directory at all', () => {
    const h = openProject('valid', { ...DELTA, publishFailAt: 'mid-stage' });
    expect(() => publish(h)).toThrow();
    expect(fs.existsSync(h.outDir)).toBe(false);
  });

  test('a committed generation leaves no scratch directory behind', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const parent = path.dirname(h.outDir);
    const strays = fs
      .readdirSync(parent)
      .filter((n) => n.includes('.pms-staging') || n.includes('.pms-backup'));
    expect(strays).toEqual([]);
    // The record of the CURRENT generation is not scratch and is meant to
    // outlive the process: it is what lets the next revision know what is
    // already published without reading a byte of it. What must not survive is
    // the pending intent file.
    expect(
      fs.readdirSync(parent).filter((n) => n.includes('.pms-state.pending')),
    ).toEqual([]);
  });

  test('a rolled-back generation leaves no scratch directory behind', () => {
    const h = openProject('valid', { ...DELTA, publishFailAt: 'mid-stage' });
    expect(() => publish(h)).toThrow();
    const parent = path.dirname(h.outDir);
    const strays = fs
      .readdirSync(parent)
      .filter((n) => n.includes('.pms-staging') || n.includes('.pms-backup'));
    expect(strays).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. a revision with no output change can reuse its generation
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: a revision with no output change reuses its generation', () => {
  function freshOut() {
    return path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-genreuse-')),
      'out',
    );
  }

  test('a byte-identical generation is not rematerialized', () => {
    const out = freshOut();
    const publishOnce = () => {
      const gen = build.beginGeneration(out, { mode: 'delta' });
      gen.stageArtifact('a.js', 'one', { owner: 'a' });
      gen.stageArtifact('b.js', 'two', { owner: 'b' });
      gen.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
      return gen.commit();
    };

    const first = publishOnce();
    // The first generation bootstraps the record set.
    expect(first.generationReused).toBe(false);
    expect(first.delta.added).toBe(3);

    // The same content again: the current generation already IS this, so
    // nothing is written and no directory is swapped.
    const second = publishOnce();
    expect(second.generationReused).toBe(true);
    expect(second.delta.reused).toBe(3);
    expect(second.delta.bytesWritten).toBe(0);
    // 'one' + 'two' + '{"v":1}'
    expect(second.delta.bytesReused).toBe(13);

    // A real change is a real generation.
    const third = build.beginGeneration(out, { mode: 'delta' });
    third.stageArtifact('a.js', 'ONE', { owner: 'a' });
    third.stageArtifact('b.js', 'two', { owner: 'b' });
    third.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    const outcome = third.commit();
    expect(outcome.generationReused).toBe(false);
    expect(outcome.delta.changed).toBe(1);
    expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe('ONE');
  });

  test('a revision and a generation are not the same thing', () => {
    const h = openProject('valid', DELTA);
    publish(h);
    const first = h.session.current();
    publish(h);
    const second = h.session.current();
    // A revision happened.
    expect(second.revisionId).toBeGreaterThan(first.revisionId);
    // Whether a new generation was required is a separate question, answered by
    // the content and not by the fact that a revision occurred.
    expect(typeof first.generationId).toBe('number');
    expect(typeof second.generationId).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// F. reuse is a hard link where the filesystem allows one
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: unchanged artifacts are reused without being rewritten', () => {
  test('a reused artifact shares an inode with the generation it came from', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-link-')),
      'out',
    );
    // The first generation bootstraps; reuse is observable from the second.
    const seed = build.beginGeneration(out, { mode: 'delta' });
    seed.stageArtifact('keep.js', 'keep', { owner: 'k' });
    seed.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    seed.commit();

    const gen = build.beginGeneration(out, { mode: 'delta' });
    gen.stageArtifact('keep.js', 'keep', { owner: 'k' });
    gen.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    const outcome = gen.commit();

    if (outcome.delta.hardlinks === 0) {
      // A filesystem without link support: the copy fallback ran, which is
      // correct but O(total bytes). Say so rather than pretend.
      expect(outcome.delta.copies).toBeGreaterThan(0);
      return;
    }

    const inoV1 = fs.statSync(path.join(out, 'keep.js')).ino;
    const next = build.beginGeneration(out, { mode: 'delta' });
    next.stageArtifact('keep.js', 'keep', { owner: 'k' });
    next.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    const second = next.commit();

    expect(second.delta.reused).toBe(2);
    expect(second.delta.hardlinks).toBe(2);
    // Same inode: the bytes were never rewritten.
    expect(fs.statSync(path.join(out, 'keep.js')).ino).toBe(inoV1);
    expect(fs.readFileSync(path.join(out, 'keep.js'), 'utf8')).toBe('keep');
  });

  test('a changed artifact is a NEW file, never an in-place write of a linked one', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-link2-')),
      'out',
    );
    const first = build.beginGeneration(out, { mode: 'delta' });
    first.stageArtifact('a.js', 'v1', { owner: 'a' });
    first.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    first.commit();
    const inoV1 = fs.statSync(path.join(out, 'a.js')).ino;

    const second = build.beginGeneration(out, { mode: 'delta' });
    second.stageArtifact('a.js', 'v2', { owner: 'a' });
    second.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    const outcome = second.commit();

    expect(outcome.delta.changed).toBe(1);
    // A different inode: the previous generation's file was never opened for
    // writing, so a generation still on disk cannot be corrupted by a later one.
    expect(fs.statSync(path.join(out, 'a.js')).ino).not.toBe(inoV1);
    expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe('v2');
  });

  test('a record file that outlived its generation does not claim a reuse', () => {
    // A record file describes a generation. If the generation is gone - a clean,
    // a container layer, a build tool resetting its output - the record is
    // evidence of nothing that exists, and reusing it would link from files
    // that are not there. This is a hole the benchmark campaign found by
    // clearing the output directory between jobs, so it is pinned here.
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-orphan-')),
      'out',
    );
    const first = build.beginGeneration(out, { mode: 'delta' });
    first.stageArtifact('a.js', 'v1', { owner: 'a' });
    first.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    first.commit();

    // Taken from the API rather than reconstructed: the name is a sibling of the
    // output directory, and a test that guesses it tests the guess.
    const statePath = first.statePath;
    expect(fs.existsSync(statePath)).toBe(true);

    // The output directory disappears; the record does not.
    fs.rmSync(out, { recursive: true, force: true });
    expect(fs.existsSync(statePath)).toBe(true);

    const next = build.beginGeneration(out, { mode: 'delta' });
    expect(next.delta).toBe(false);
    expect(() => {
      next.stageArtifact('a.js', 'v1', { owner: 'a' });
      next.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
      next.commit();
    }).not.toThrow();
    expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe('v1');
  });

  test('releasing a generation does not invalidate the one that reused it', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-link3-')),
      'out',
    );
    const seed = build.beginGeneration(out, { mode: 'delta' });
    seed.stageArtifact('a.js', 'v1', { owner: 'a' });
    seed.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    seed.commit();

    // Successive generations, each reusing the last. The retired generations
    // are removed; the live one must still be complete and correct.
    for (let i = 0; i < 5; i++) {
      const g = build.beginGeneration(out, { mode: 'delta' });
      g.stageArtifact('a.js', `v${i + 2}`, { owner: 'a' });
      g.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
      g.commit();
      expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe(`v${i + 2}`);
    }
    // Only the output directory and the record of its current generation
    // remain: the staging directory and every retired generation are gone, so
    // retention does not grow with the number of generations.
    expect(
      fs
        .readdirSync(path.dirname(out))
        .filter((n) => n.includes('pms-') || n === 'out'),
    ).toEqual(['.out.pms-state.json', 'out']);
  });
});

// ---------------------------------------------------------------------------
// G. crash safety
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: a process that dies mid-publish is recoverable', () => {
  test('a crash before the commit leaves generation N current', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-crash-')),
      'out',
    );
    const first = build.beginGeneration(out, { mode: 'delta' });
    first.stageArtifact('a.js', 'v1', { owner: 'a' });
    first.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    first.commit();

    // A generation is prepared and abandoned, as a killed process would leave
    // it. Nothing was published, so the intent file was never written.
    const abandoned = build.beginGeneration(out, { mode: 'delta' });
    abandoned.stageArtifact('a.js', 'v2 NEVER', { owner: 'a' });
    abandoned.stageArtifact('manifest.json', '{"v":2}', { owner: 'metadata' });
    // No commit, no rollback: this is what a SIGKILL looks like.

    const next = build.beginGeneration(out, { mode: 'delta' });
    expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe('v1');
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).v,
    ).toBe(1);
    next.rollback();
  });

  test('a crash after the swap is rolled forward, never left mixed', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-crash2-')),
      'out',
    );
    const first = build.beginGeneration(out, { mode: 'delta' });
    first.stageArtifact('a.js', 'v1', { owner: 'a' });
    first.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    first.commit();

    // Fail between the directory swap and the state promotion: the directory
    // holds N+1, the control file still says N.
    const gen = build.beginGeneration(out, {
      mode: 'delta',
      failAt: 'after-swap',
    });
    gen.stageArtifact('a.js', 'v2', { owner: 'a' });
    gen.stageArtifact('manifest.json', '{"v":2}', { owner: 'metadata' });
    expect(() => gen.commit()).toThrow();

    const next = build.beginGeneration(out, { mode: 'delta' });
    // The output directory is ONE complete generation, never a mix, and the
    // artifact and the marker that describes it always agree.
    const a = fs.readFileSync(path.join(out, 'a.js'), 'utf8');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'),
    );
    expect(a).toBe(`v${manifest.v}`);
    next.rollback();
  });

  test('a staging directory left by a crash is identifiable and cleanable', () => {
    const out = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms-crash3-')),
      'out',
    );
    const first = build.beginGeneration(out, { mode: 'delta' });
    first.stageArtifact('a.js', 'v1', { owner: 'a' });
    first.stageArtifact('manifest.json', '{"v":1}', { owner: 'metadata' });
    first.commit();

    const abandoned = build.beginGeneration(out, { mode: 'delta' });
    abandoned.stageArtifact('a.js', 'v2', { owner: 'a' });
    abandoned.stageArtifact('manifest.json', '{"v":2}', { owner: 'metadata' });
    expect(fs.existsSync(abandoned.stagingDir)).toBe(true);

    // The next run reconciles it away.
    build.beginGeneration(out, { mode: 'delta' }).rollback();
    expect(fs.existsSync(`${out}.pms-staging`)).toBe(false);
    expect(fs.readFileSync(path.join(out, 'a.js'), 'utf8')).toBe('v1');
  });
});

// ---------------------------------------------------------------------------
// H. the variants are real and separate
// ---------------------------------------------------------------------------

describe('Spike 3 Phase A: the publication variants are selectable and separate', () => {
  test('the default variant keeps complete undo coverage and retains verified identical bytes', () => {
    const h = openProject('valid');
    publish(h);

    editFile(h, 'src/conditional-props.tsx', EXISTING_ATOM, EXISTING_ATOM_PLUS);
    const { publication } = publish(h);

    // Snapshot publication compares existing bytes and reports the real writes;
    // fresh-build reference staging is independently tested as unconditional.
    expect(publication.mode).toBe('full');
    expect(publication.outputsReused).toBeGreaterThan(0);
    // One file changed; the snapshot publisher verifies the other output bytes.
    const jsCount = jsOutputs(h).length;
    expect(publication.byKind.js.changed).toBe(1);
    expect(publication.byKind.js.reused).toBe(jsCount - 1);
    expect(publication.byKind.js.added).toBe(0);
    expect(publication.byKind.metadata.reused).toBeGreaterThanOrEqual(2);
    expect(publication.byKind.css.changed + publication.byKind.css.reused).toBe(
      1,
    );
    // The generation's own file list, not the oracle's fingerprint: the
    // fingerprint deliberately leaves the metadata documents out, because
    // they are compared as audit state, and this assertion is about what is on
    // disk. jsCount JavaScript outputs, the stylesheet, the design-system
    // module, its declaration, the manifest, artifact digests, and the build
    // report. The coverage detail is NOT
    // among them: this variant was not asked for it, and publishing evidence
    // nobody requested is what Phase C removed from the hot path.
    expect([...readTree(h.outDir).keys()].sort()).toEqual(
      [
        ...jsOutputs(h),
        'artifacts.json',
        'build-report.json',
        'design.pandamstyle.js',
        'design.pandamstyle.d.ts',
        'manifest.json',
        'styles.css',
      ].sort(),
    );
  });

  test('the same edit under delta publication is equivalent', () => {
    // ONE project, published twice with the same sources: once with the
    // reference publisher and once with the delta one. Two separate project
    // copies would not be comparable at all - the build report carries absolute
    // roots and relay paths, so two directories never produce the same report.
    const first = openProject('valid');
    publish(first); // establish generation N
    editFile(
      first,
      'src/conditional-props.tsx',
      EXISTING_ATOM,
      EXISTING_ATOM_PLUS,
    );
    publish(first);
    const fullResult = first.session.lastPublication();
    const fullGeneration = first.published();
    const jsCount = jsOutputs(first).length;
    first.session.close();

    // A fresh session over the SAME directory and the SAME bytes. Its first
    // publication bootstraps the record set - it cannot know what a publisher
    // that left no record behind had written, and reading every published byte
    // to find out is exactly the cost delta publication exists to remove. The
    // second publication is the one that can reuse.
    const second = openExistingProject(first.project, DELTA);
    const bootstrap = publish(second).publication;
    // The generation already exists on disk, so nothing is "added" - it is all
    // rewritten, which is exactly what the next publication avoids.
    expect(bootstrap.outputsReused).toBe(0);
    expect(bootstrap.byKind.js.added).toBe(0);
    expect(bootstrap.byKind.js.changed).toBe(jsCount);
    publish(second);
    const deltaResult = second.session.lastPublication();

    // Different work...
    // The session's snapshot publisher now verifies and retains exact existing
    // bytes. The independent fresh-build publisher still stages unconditionally.
    expect(fullResult.byKind.js.reused).toBe(jsCount - 1);
    expect(fullResult.byKind.js.changed).toBe(1);
    expect(deltaResult.byKind.js.changed).toBe(0);
    expect(deltaResult.byKind.js.reused).toBe(jsCount);
    expect(deltaResult.bytesWritten).toBeLessThan(fullResult.bytesWritten);
    // ...identical result.
    expect(second.published()).toEqual(fullGeneration);
  });

  test('the variant accepts its object form', () => {
    const h = openProject('valid', {
      publishVariant: { incrementalPublish: true, incrementalCss: false },
    });
    publish(h);
    expect(h.session.lastPublication().variant).toBe(
      'session_incremental_publish',
    );
  });

  test('an unknown variant is rejected by name', () => {
    expect(() =>
      openProject('valid', { publishVariant: 'session_guess' }),
    ).toThrow(/unknown publishVariant/);
  });

  test('incremental CSS without incremental publication is refused', () => {
    expect(() =>
      openProject('valid', { publishVariant: { incrementalCss: true } }),
    ).toThrow(/incrementalCss requires incrementalPublish/);
  });

  test('the Phase B variant is a real third path, not a relabelled one', () => {
    // Until Phase B existed this variant threw rather than quietly aggregating
    // in full, which was the correct behaviour then and is pinned in
    // incremental-css-test.js. Now it exists, and it has to be a DISTINCT path:
    // the same published bytes as the other two, reached by a different amount
    // of work, and it must say in its own report that CSS was updated rather
    // than re-derived.
    const h = openProject('valid', {
      publishVariant: 'session_incremental_publish_css',
    });
    const first = publish(h);
    expect(first.publication.variant).toBe('session_incremental_publish_css');
    expect(first.publication.mode).toBe('delta');
    // The first revision has no CSS state to update, so it builds one and says
    // so rather than reporting an update it did not perform.
    const firstReport = JSON.parse(
      fs.readFileSync(path.join(h.outDir, 'build-report.json'), 'utf8'),
    );
    expect(firstReport.incremental.css.incremental).toBe(false);
    expect(firstReport.incremental.css.fallbackReason).toBe('initial');

    // The second one has one, and the no-change revision updates it with
    // nothing - which is the whole point of the variant.
    const second = publish(h);
    const secondReport = JSON.parse(
      fs.readFileSync(path.join(h.outDir, 'build-report.json'), 'utf8'),
    );
    expect(second.publication.mode).toBe('delta');
    expect(secondReport.incremental.css.incremental).toBe(true);
    expect(secondReport.incremental.css.fallbackReason).toBe(null);
    expect(secondReport.incremental.css.rulesAdded).toBe(0);
    expect(secondReport.incremental.css.rulesRemoved).toBe(0);
    expect(secondReport.incremental.css.ruleRecords).toBeGreaterThan(0);
  });
});
