/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { comparePublished, openProject } = require('./session-helpers');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function updateDefinition(h, update) {
  const before = read(h.definitionPath);
  const after = update(before);
  if (after === before) throw new Error('definition edit did not change bytes');
  write(h.definitionPath, after);
  const validation = h.revise({ definition: h.reloadDefinition() });
  expect(validation.ok).toBe(true);
  expect(validation.counters.fullFallback).toBe(0);
  const equivalence = comparePublished(h);
  if (equivalence.findings.length > 0)
    throw new Error(
      JSON.stringify({
        counters: validation.counters,
        findings: equivalence.findings,
      }),
    );
  return validation;
}

function replaceOnce(source, before, after) {
  if (!source.includes(before))
    throw new Error(`test anchor is missing: ${JSON.stringify(before)}`);
  return source.replace(before, after);
}

describe('Phase 16B semantic-unit invalidation', () => {
  let h;

  beforeEach(() => {
    h = openProject('valid');
  });
  afterEach(() => h.session.close());

  test('token values update generated outputs without recompiling source consumers', () => {
    const initial = h.revise({ initial: true });
    expect(initial.ok).toBe(true);

    const patternA = h.src('src/pattern-a.js');
    const patternB = h.src('src/pattern-b.js');
    write(
      patternA,
      "import { patterns, token, props } from '../generated/design.pandamstyle';\n" +
        "export const layout = props(patterns.stack({ gap: token('spacing.md') }));\n",
    );
    write(
      patternB,
      "import { patterns, token, props } from '../generated/design.pandamstyle';\n" +
        "export const layout = props(patterns.stack({ gap: token('spacing.md'), align: 'center' }));\n",
    );
    const added = h.revise({ addedFiles: [patternA, patternB] });
    expect(added.ok).toBe(true);
    expect(comparePublished(h).findings).toEqual([]);

    const cases = [
      ['unused token', "zero: { value: '0'", "zero: { value: '1px'"],
      ['locally used token', "lg: { value: '24px'", "lg: { value: '28px'"],
      ['widely used token', "md: { value: '16px'", "md: { value: '20px'"],
      [
        'semantic alias target',
        "'50': { value: '#f8fafc'",
        "'50': { value: '#f1f5f9'",
      ],
      [
        'token used by recipes',
        "base: { value: 'system-ui, sans-serif'",
        "base: { value: 'Arial, sans-serif'",
      ],
    ];

    for (const [label, before, after] of cases) {
      const cssBefore = read(path.join(h.outDir, 'styles.css'));
      const revision = updateDefinition(h, (source) =>
        replaceOnce(source, before, after),
      );
      expect(revision.counters.filesRecompiled).toBe(0);
      expect(revision.counters.designSystemViewsRecomputed).toBeLessThan(10);
      expect(revision.counters.semanticEntitiesChanged).toBeGreaterThan(0);
      // The generated manifest's registry digest is part of its public type
      // contract, so registry changes regenerate declarations even when their
      // literal unions stay the same.
      expect(revision.counters.generatedTypesRegenerated).toBe(1);
      expect(read(path.join(h.outDir, 'styles.css'))).not.toBe(cssBefore);
      expect(label).toBeTruthy();
    }

    const declarationsPath = path.join(h.outDir, 'design.pandamstyle.d.ts');
    const declarationsBefore = read(declarationsPath);
    const cssBeforePatternEdit = read(path.join(h.outDir, 'styles.css'));
    write(
      patternA,
      replaceOnce(
        read(patternA),
        "gap: token('spacing.md') }",
        "gap: token('spacing.md'), align: 'center' }",
      ),
    );
    const patternEdit = h.revise({ changed: [patternA] });
    expect(patternEdit.ok).toBe(true);
    expect(patternEdit.counters.filesRecompiled).toBe(1);
    expect(patternEdit.counters.designSystemViewsRecomputed).toBe(0);
    expect(patternEdit.counters.generatedTypesRegenerated).toBe(0);
    expect(read(declarationsPath)).toBe(declarationsBefore);
    expect(read(path.join(h.outDir, 'styles.css'))).not.toBe(
      cssBeforePatternEdit,
    );
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('theme inheritance and override changes invalidate only their theme users', () => {
    expect(h.revise({ initial: true }).ok).toBe(true);
    const inheritedConsumer = h.src('src/high-contrast-consumer.js');
    write(
      inheritedConsumer,
      "import { props, themes } from '../generated/design.pandamstyle';\n" +
        'export const surface = props(themes.highContrast);\n',
    );
    const source = read(h.definitionPath);
    const withInheritedTheme = replaceOnce(
      source,
      '  themes: {\n    light:',
      "  themes: {\n    highContrast: { extends: 'dark', tokens: {} },\n    light:",
    );
    write(h.definitionPath, withInheritedTheme);
    const recovered = h.revise({
      definition: h.reloadDefinition(),
      addedFiles: [inheritedConsumer],
    });
    expect(recovered.ok).toBe(true);
    expect(comparePublished(h).findings).toEqual([]);

    const changed = updateDefinition(h, (text) =>
      replaceOnce(
        text,
        "surface: { primary: { ref: 'colors.gray.800' } },",
        "surface: { primary: { ref: 'colors.gray.100' } },",
      ),
    );
    expect(changed.counters.semanticFilesInvalidated).toBeGreaterThan(0);
    expect(changed.counters.semanticFilesInvalidated).toBeLessThan(
      changed.counters.coveredFileCount,
    );
    expect(changed.counters.filesRecompiled).toBeGreaterThan(0);
    expect(changed.counters.filesRecompiled).toBeLessThan(6);

    const overrideAdded = updateDefinition(h, (text) =>
      replaceOnce(
        text,
        '    light: { tokens: {} },',
        "    light: { tokens: { colors: { surface: { primary: { ref: 'colors.gray.800' } } } } },",
      ),
    );
    expect(overrideAdded.counters.semanticFilesInvalidated).toBeGreaterThan(0);
    expect(overrideAdded.counters.filesRecompiled).toBeLessThan(8);

    const overrideRemoved = updateDefinition(h, (text) =>
      replaceOnce(
        text,
        "    light: { tokens: { colors: { surface: { primary: { ref: 'colors.gray.800' } } } } },",
        '    light: { tokens: {} },',
      ),
    );
    expect(overrideRemoved.counters.semanticFilesInvalidated).toBeGreaterThan(
      0,
    );
    expect(overrideRemoved.counters.filesRecompiled).toBeLessThan(8);
  });

  test('slot recipe and compound changes affect recipe consumers; rename and removal retire edges', () => {
    expect(h.revise({ initial: true }).ok).toBe(true);
    const cardDefinition = [
      '    card: {',
      "      slots: ['root', 'label'],",
      "      base: { root: { display: 'flex' }, label: { fontWeight: token('fontWeights.normal') } },",
      '      variants: { tone: { quiet: { root: { opacity: 0.75 } }, loud: { root: { opacity: 1 } } } },',
      "      defaultVariants: { tone: 'quiet' },",
      "      compoundVariants: [{ tone: 'loud', css: { root: { color: token('colors.text.inverse') } } }],",
      '    },',
    ].join('\n');
    const cardFile = h.src('src/card-consumer.js');
    write(
      cardFile,
      "import { recipes, props } from '../generated/design.pandamstyle';\n" +
        "const slots = recipes.card({ tone: 'loud' });\n" +
        'export const root = props(slots.root);\n' +
        'export const label = props(slots.label);\n',
    );
    const withCard = h.revise({
      definition: (() => {
        const source = read(h.definitionPath);
        write(
          h.definitionPath,
          replaceOnce(
            source,
            '  recipes: {\n    button:',
            `  recipes: {\n${cardDefinition}\n    button:`,
          ),
        );
        return h.reloadDefinition();
      })(),
      addedFiles: [cardFile],
    });
    expect(withCard.ok).toBe(true);
    expect(comparePublished(h).findings).toEqual([]);
    const edgesWithCard = h.session.stats().semanticDependencyEdgeCount;

    const compound = updateDefinition(h, (text) =>
      replaceOnce(
        text,
        "tone: 'loud', css: { root: { color: token('colors.text.inverse') } }",
        "tone: 'loud', css: { root: { color: token('colors.text.primary') } }",
      ),
    );
    expect(compound.counters.filesRecompiled).toBe(1);
    expect(compound.counters.semanticFilesInvalidated).toBe(1);

    const button = updateDefinition(h, (text) =>
      replaceOnce(text, "display: 'inline-flex',", "display: 'flex',"),
    );
    expect(button.counters.filesRecompiled).toBe(3);
    expect(button.counters.semanticFilesInvalidated).toBe(3);

    const renamedSource = read(cardFile).replaceAll(
      'recipes.card',
      'recipes.panel',
    );
    write(cardFile, renamedSource);
    const renamed = h.revise({
      definition: (() => {
        const text = read(h.definitionPath);
        write(
          h.definitionPath,
          replaceOnce(
            text,
            '  recipes: {\n    card: {',
            '  recipes: {\n    panel: {',
          ),
        );
        return h.reloadDefinition();
      })(),
    });
    expect({ ok: renamed.ok, diagnostics: renamed.diagnostics }).toEqual({
      ok: true,
      diagnostics: [],
    });
    expect(renamed.counters.filesRecompiled).toBe(1);
    expect(comparePublished(h).findings).toEqual([]);

    fs.rmSync(cardFile);
    const removed = h.revise({
      definition: (() => {
        const text = read(h.definitionPath);
        const start = text.indexOf('    panel: {');
        const end = text.indexOf('    button: {', start);
        if (start < 0 || end < 0) throw new Error('renamed recipe is missing');
        write(h.definitionPath, text.slice(0, start) + text.slice(end));
        return h.reloadDefinition();
      })(),
      removedFiles: [cardFile],
    });
    expect(removed.ok).toBe(true);
    expect(comparePublished(h).findings).toEqual([]);
    expect(h.session.stats().semanticDependencyEdgeCount).toBeLessThan(
      edgesWithCard,
    );
  });
});
