/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 3, PHASE B - incremental CSS aggregation.
 *
 * The claim under test:
 *
 *     incremental_css(revision R) == fresh_full_aggregation(revision R)
 *
 * BYTE FOR BYTE, including the cascade order. Not "equivalent cascade",
 * not "the same rules in a different order" - the same bytes as the aggregator
 * produces for the whole project, because a stylesheet's order is what decides
 * which declaration wins and reordering it is a behaviour change.
 *
 * That is checked against the REAL full aggregator on every revision, through
 * the differential helper, which also compares the generation's whole file set.
 * An incremental aggregator that is fast because it drops or duplicates a rule
 * is the failure mode this file exists to make impossible.
 *
 * The properties that make it correct rather than lucky:
 *
 *   - a rule shared by two files survives the deletion of one of them, and
 *     disappears only when its LAST owner leaves;
 *   - a new rule is placed where the aggregator's own comparator says it goes,
 *     never appended, and edits that arrive in an order unrelated to the
 *     project's traversal order still produce the fresh-rebuild order;
 *   - anything the session cannot reason about locally falls back to a full
 *     rebuild, visibly and with a reason, and the fallback output is still
 *     fresh-equivalent.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.autoMockOff();

const {
  comparePublished,
  differential,
  openExistingProject,
  openProject,
} = require('./session-helpers');

const CSS = { publishVariant: 'session_incremental_publish_css' };
/** The reference: same session, same compilation, CSS aggregated in full. */
const FULL_CSS = { publishVariant: 'session_incremental_publish' };

function revise(h, changes = {}) {
  const validation = h.revise(changes);
  if (!validation.ok) {
    throw new Error(
      `revision ${validation.revisionId} was rejected: ${(
        validation.diagnostics ?? []
      )
        .map((d) => d.code)
        .join(', ')}`,
    );
  }
  return validation;
}

const css = (h) => fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
const cssReport = (h) =>
  JSON.parse(fs.readFileSync(path.join(h.outDir, 'build-report.json'), 'utf8'))
    .incremental.css;

function editFile(h, rel, from, to) {
  const file = h.src(rel);
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    throw new Error(
      `edit target ${JSON.stringify(from)} not present in ${rel}`,
    );
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
}

/** A module contributing one declaration, given verbatim. */
function writeModule(h, name, declaration) {
  fs.writeFileSync(
    h.src(`src/${name}`),
    "import { create, token, props } from '../generated/design.pandamstyle';\n" +
      `export const s = props(create({ box: { ${declaration} } }).box);\n`,
    'utf8',
  );
}

/**
 * The owners of the rule `file` contributed, by class name.
 *
 * Every ownership test in this file asserts its OWN PREMISE through this
 * before it asserts its conclusion. A test that says "a shared atom survives"
 * while the atom it picked turns out to be owned by the design system and four
 * other files proves nothing - and that is not hypothetical: the design system's
 * injected map is a mutable accumulator, and until this layer stopped mistaking
 * it for a fixed set, `display: grid` looked exclusively owned by the module
 * that declared it and was in fact owned by the design system too.
 */
function ownersOf(h, file) {
  const { ownership } = h.session.cssState();
  const key = Object.keys(ownership).find((k) => k.endsWith(file));
  if (key === undefined) throw new Error(`${file} owns no rules`);
  const className = ownership[key][0];
  return Object.keys(ownership).filter((k) => ownership[k].includes(className));
}

const ownerName = (k) =>
  k.includes('design-system') ? 'DESIGN-SYSTEM' : k.split('/').pop();

/** `display: grid` is ALSO a design-system rule, so it is not a good witness. */
const SOLE_OWNED = "outlineColor: token('colors.action.primaryHover')";

// ---------------------------------------------------------------------------
// A. equality with the full aggregator
// ---------------------------------------------------------------------------

describe('Spike 3 Phase B: incremental CSS equals a full aggregation', () => {
  const trace = [
    { label: 'no change' },
    {
      label: 'a file that already had these atoms',
      apply: (h) =>
        editFile(
          h,
          'src/conditional-props.tsx',
          "gap: token('spacing.sm')",
          "gap: token('spacing.lg')",
        ),
    },
    {
      label: 'a token swap',
      apply: (h) =>
        editFile(
          h,
          'src/page.js',
          "color: token('colors.text.primary')",
          "color: token('colors.text.inverse')",
        ),
    },
    {
      label: 'a new module with a new rule',
      apply: (h) => writeModule(h, 'zz-a.js', SOLE_OWNED),
    },
    {
      label: 'a second new module',
      apply: (h) =>
        writeModule(
          h,
          'zz-b.js',
          "outlineColor: token('colors.surface.primary')",
        ),
    },
    {
      label: 'removing the first of them',
      apply: (h) => fs.rmSync(h.src('src/zz-a.js')),
    },
    {
      label: 'removing the second',
      apply: (h) => fs.rmSync(h.src('src/zz-b.js')),
    },
    {
      label: 'back to where it started',
      apply: (h) =>
        editFile(
          h,
          'src/conditional-props.tsx',
          "gap: token('spacing.lg')",
          "gap: token('spacing.sm')",
        ),
    },
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
      label: 'a design-system change (semantic-unit update)',
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
        // The reloaded definition has to reach the REVISION, not just the next
        // full rebuild. `applyChanges` with no definition tells the session
        // nothing changed, and the differential would then be comparing a
        // session that kept the old design system against a rebuild that used
        // the new one - a difference in the test, not in the compiler.
        return { definition: h.reloadDefinition() };
      },
    },
  ];

  test('the whole trace produces the same bytes as a full aggregation', () => {
    const h = openProject('valid', CSS);
    const bad = [];
    for (const step of trace) {
      const changes = step.apply ? step.apply(h) : undefined;
      const result = differential(h, step.label, changes);
      if (result.findings.length > 0)
        bad.push(`${step.label}: ${result.findings.join('; ')}`);
    }
    expect(bad).toEqual([]);
  });

  test('a no-change revision reuses the previous stylesheet byte for byte', () => {
    const h = openProject('valid', CSS);
    revise(h);
    const first = css(h);
    revise(h);
    expect(css(h)).toBe(first);
    // Nothing was re-derived, and the group texts were not rebuilt.
    const report = cssReport(h);
    expect(report.incremental).toBe(true);
    expect(report.fallbackReason).toBe(null);
    expect(report.rulesAdded).toBe(0);
    expect(report.rulesRemoved).toBe(0);
  });

  test('a one-file edit touches only that file rule contributions', () => {
    const h = openProject('valid', CSS);
    revise(h);
    editFile(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    revise(h);
    const report = cssReport(h);
    expect(report.incremental).toBe(true);
    // The delta is a small CONSTANT, not a fraction of the project: the composed
    // rule goes, the atom for the new token arrives, and whatever else that file
    // recomputed. Everything else in the project was neither re-ordered nor
    // re-serialised, which is the property that has to hold at 10,000 files too.
    expect(report.rulesAdded + report.rulesRemoved).toBeLessThanOrEqual(4);
    expect(report.ruleRecords).toBeGreaterThan(20);
    expect(report.ownerCount).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// B. ownership and reference counting - the property that makes it incremental
// ---------------------------------------------------------------------------

describe('Spike 3 Phase B: a rule belongs to its owners', () => {
  test('a shared atom survives the deletion of one owner', () => {
    // Two files contribute the SAME atomic rule, and nothing else does.
    const h = openProject('valid', CSS);
    writeModule(h, 'zz-shared-a.js', SOLE_OWNED);
    writeModule(h, 'zz-shared-b.js', SOLE_OWNED);
    revise(h);

    // The premise, checked before the conclusion: exactly those two files own it.
    const owners = ownersOf(h, 'zz-shared-a.js').map(ownerName);
    expect(owners.sort()).toEqual(['zz-shared-a.js', 'zz-shared-b.js']);
    const records = cssReport(h).ruleRecords;

    fs.rmSync(h.src('src/zz-shared-a.js'));
    revise(h);
    // The rule is STILL there: its other owner has it. A stylesheet that dropped
    // it would be wrong in a way no amount of speed makes acceptable.
    expect(ownersOf(h, 'zz-shared-b.js').map(ownerName)).toEqual([
      'zz-shared-b.js',
    ]);
    expect(cssReport(h).rulesRemoved).toBe(0);
    expect(cssReport(h).ruleRecords).toBe(records);
    expect(comparePublished(h).findings).toEqual([]);

    // Now the LAST owner goes, and only then does the rule go.
    fs.rmSync(h.src('src/zz-shared-b.js'));
    revise(h);
    expect(cssReport(h).rulesRemoved).toBe(1);
    expect(cssReport(h).ruleRecords).toBe(records - 1);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a rule owned only by a deleted file disappears with it', () => {
    const h = openProject('valid', CSS);
    writeModule(h, 'zz-solo.js', SOLE_OWNED);
    revise(h);
    expect(ownersOf(h, 'zz-solo.js').map(ownerName)).toEqual(['zz-solo.js']);
    const before = cssReport(h).ruleRecords;

    fs.rmSync(h.src('src/zz-solo.js'));
    revise(h);
    expect(cssReport(h).ruleRecords).toBe(before - 1);
    expect(cssReport(h).rulesRemoved).toBe(1);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. ordering is semantic
// ---------------------------------------------------------------------------

describe('Spike 3 Phase B: cascade order is preserved, not appended to', () => {
  test('edits in an order unrelated to the traversal order still match', () => {
    // The failure this catches: a new rule appended at the end. Each step here
    // removes and re-adds rules, so an append-only aggregator drifts further
    // from the fresh order at every step, while a correctly ordered one does
    // not move at all.
    const h = openProject('valid', CSS);
    revise(h);
    const start = css(h);

    const order = [
      ['zz-1.js', SOLE_OWNED],
      ['zz-2.js', "outlineColor: token('colors.surface.primary')"],
      ['zz-3.js', "borderTopColor: token('colors.text.inverse')"],
    ];
    for (const [name, decl] of order) {
      writeModule(h, name, decl);
      revise(h);
      expect(comparePublished(h).findings).toEqual([]);
    }
    expect(css(h)).not.toBe(start);

    // Remove them in a DIFFERENT order than they were added.
    for (const [name] of [...order].reverse()) {
      fs.rmSync(h.src(`src/${name}`));
      revise(h);
      expect(comparePublished(h).findings).toEqual([]);
    }
    // And the stylesheet is back where it started: order was maintained, not
    // accumulated.
    expect(css(h)).toBe(start);
  });

  test('rules for the same property are ordered by the aggregator, not by age', () => {
    // One property, several rules that compete in the cascade: a base value and
    // a `wide` condition, which the design system compiles to a media query. Two
    // modules declare it; whichever is added last, they must come out in the
    // aggregator's order.
    const h = openProject('valid', CSS);
    revise(h);
    writeModule(
      h,
      'zz-wide.js',
      "paddingTop: token('spacing.sm'), _wide: { paddingTop: token('spacing.lg') }",
    );
    revise(h);
    writeModule(
      h,
      'zz-narrow.js',
      "paddingTop: token('spacing.xs'), _wide: { paddingTop: token('spacing.md') }",
    );
    revise(h);
    expect(comparePublished(h).findings).toEqual([]);

    // Both the base rules and their media-query counterparts are present, in the
    // order the aggregator put them, not in the order the files were added.
    const text = css(h);
    expect(text).toContain('@media (min-width: 768px)');
    expect(comparePublished(h).findings).toEqual([]);

    // Remove one and the other is untouched.
    fs.rmSync(h.src('src/zz-wide.js'));
    revise(h);
    expect(css(h)).toContain('@media (min-width: 768px)');
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a condition and a theme interaction keep their order across an edit', () => {
    const h = openProject('valid', CSS);
    revise(h);
    editFile(
      h,
      'src/conditional-props.tsx',
      "color: token('colors.action.primary')",
      "color: token('colors.text.inverse')",
    );
    revise(h);
    expect(comparePublished(h).findings).toEqual([]);
    editFile(h, 'src/page.tsx', 'themes.light', 'themes.dark');
    revise(h);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. the fallback is visible and correct
// ---------------------------------------------------------------------------

describe('Phase 16B: design-system CSS ownership updates incrementally', () => {
  test('a design-system change updates only its changed CSS owner rules', () => {
    const h = openProject('valid', CSS);
    revise(h);
    revise(h);
    expect(cssReport(h).incremental).toBe(true);

    const before = fs.readFileSync(h.definitionPath, 'utf8');
    fs.writeFileSync(
      h.definitionPath,
      before.replace(
        "zero: { value: '0', visibility: 'public' },",
        "zero: { value: '0.5px', visibility: 'public' },",
      ),
      'utf8',
    );
    // The reloaded definition has to reach the REVISION. Reloading it only for
    // the next full rebuild would compare a session that kept the old design
    // system against a rebuild that used the new one.
    revise(h, { definition: h.reloadDefinition() });

    const report = cssReport(h);
    expect(report.incremental).toBe(true);
    expect(report.fallbackReason).toBeNull();
    expect(report.rulesAdded).toBeGreaterThan(0);
    expect(report.rulesAdded).toBeLessThan(report.ruleRecords);
    // The incremental output is still exactly the reference.
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a configuration change is a fallback too', () => {
    const h = openProject('valid', CSS);
    revise(h);
    h.setBuildOption('useCSSLayers', true);
    revise(h, { config: { useCSSLayers: true } });
    expect(cssReport(h).incremental).toBe(false);
    expect(cssReport(h).fallbackReason).toBe('compiler-configuration');
    expect(differential(h, 'css layers on').findings).toEqual([]);
  });

  test('the global CSS change reports a delta rather than a project rebuild', () => {
    const h = openProject('valid', CSS);
    revise(h);
    revise(h);
    const incremental = cssReport(h);
    const before = fs.readFileSync(h.definitionPath, 'utf8');
    fs.writeFileSync(
      h.definitionPath,
      before.replace(
        "zero: { value: '0', visibility: 'public' },",
        "zero: { value: '0.5px', visibility: 'public' },",
      ),
      'utf8',
    );
    revise(h, { definition: h.reloadDefinition() });
    const changed = cssReport(h);
    // The counters name the changed design-system atoms while every file-owned
    // rule remains in the authoritative CSS state.
    expect(changed.incremental).toBe(true);
    expect(changed.rulesAdded).toBeGreaterThan(0);
    expect(changed.rulesAdded).toBeLessThan(changed.ruleRecords);
    expect(incremental.rulesAdded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E. the two CSS paths agree with each other on the same project
// ---------------------------------------------------------------------------

describe('Spike 3 Phase B: the incremental stylesheet equals the full one', () => {
  test('over a run of mixed edits, both paths publish identical bytes', () => {
    // ONE project, two sessions over the same bytes - `openProject` would copy
    // the pristine fixture a second time and the two would not be comparable.
    const incremental = openProject('valid', CSS);
    revise(incremental);
    const steps = [
      (h) =>
        editFile(
          h,
          'src/conditional-props.tsx',
          "gap: token('spacing.sm')",
          "gap: token('spacing.lg')",
        ),
      (h) => writeModule(h, 'zz-m.js', SOLE_OWNED),
      (h) => fs.rmSync(h.src('src/zz-m.js')),
      (h) =>
        editFile(
          h,
          'src/page.js',
          "color: token('colors.text.primary')",
          "color: token('colors.text.inverse')",
        ),
      (h) => fs.rmSync(h.src('src/only-recipe.js')),
      (h) =>
        fs.renameSync(h.src('src/renamed.js'), h.src('src/renamed-again.js')),
    ];
    for (const step of steps) step(incremental);
    revise(incremental);
    incremental.session.close();

    const full = openExistingProject(incremental.project, FULL_CSS);
    revise(full);
    expect(full.published()).toEqual(incremental.published());
  });
});
