/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function definition(compiler, options = {}) {
  return {
    systemId: 'phase15-convergence',
    tokens: {
      spacing: {
        sm: { value: '8px', visibility: 'public' },
        md: { value: '16px', visibility: 'public' },
      },
      colors: {
        surface: { value: '#ffffff', visibility: 'public' },
        semanticSurface: {
          ref: 'colors.surface',
          visibility: 'public',
        },
      },
    },
    themes: {
      dark: {
        tokens: {
          colors: {
            surface: { value: '#111111', visibility: 'public' },
            semanticSurface: {
              ref: 'colors.surface',
              visibility: 'public',
            },
          },
        },
      },
      highContrast: {
        extends: 'dark',
        tokens: {
          colors: {
            surface: {
              value: options.highContrastSurface ?? '#000000',
              visibility: 'public',
            },
          },
        },
      },
    },
    conditions: { wide: '@media (min-width: 768px)' },
    recipes: {
      card: {
        slots: ['root', 'header', 'body'],
        base: {
          root: { display: 'flex' },
          header: { color: compiler.token('colors.semanticSurface') },
          body: { padding: compiler.token('spacing.sm') },
        },
        variants: {
          size: {
            sm: { root: { display: 'block' } },
            md: { root: { display: 'grid' } },
          },
          tone: {
            quiet: { header: { opacity: 0.8 } },
            strong: { header: { opacity: 0.9 } },
          },
        },
        defaultVariants: { size: 'sm', tone: 'quiet' },
        compoundVariants: [
          {
            size: ['md'],
            tone: 'strong',
            css: {
              root: { opacity: options.compoundOpacity ?? 0.75 },
              body: { padding: compiler.token('spacing.md') },
            },
          },
        ],
      },
    },
  };
}

const SOURCE = [
  "import { patterns, token, recipes, themes, props } from '../generated/design.pandamstyle';",
  "const layout = patterns.stack({ gap: token('spacing.sm'), align: { base: 'stretch', wide: 'center' } });",
  "const card = recipes.card({ size: 'md', tone: 'strong' });",
  'export const composed = props(themes.highContrast, layout, card.root, card.header, card.body);',
  '',
].join('\n');

function readOutput(outDir) {
  return {
    javascript: fs.readFileSync(path.join(outDir, 'js/src/page.js'), 'utf8'),
    declarations: fs.readFileSync(
      path.join(outDir, 'design.pandamstyle.d.ts'),
      'utf8',
    ),
    manifest: JSON.parse(
      fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
    ),
    css: fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8'),
  };
}

describe('Phase 15 convergence cross-feature semantics', () => {
  test('slot compounds, inherited themes, responsive patterns and generated types compose and update incrementally', () => {
    const compiler = loadCompiler();
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-phase15-convergence-'),
    );
    const src = path.join(project, 'src');
    const outDir = path.join(project, 'generated');
    const page = path.join(src, 'page.js');
    fs.mkdirSync(src, { recursive: true });
    fs.symlinkSync(
      path.join(REPO_ROOT, 'node_modules'),
      path.join(project, 'node_modules'),
      'dir',
    );
    fs.writeFileSync(page, SOURCE);

    const session = compiler.createProjectSession({
      definition: definition(compiler),
      roots: [src],
      outDir,
    });

    try {
      session.initialize();
      expect(session.validate().ok).toBe(true);
      session.compile();
      const initial = readOutput(outDir);

      expect(initial.manifest.capabilities).toEqual({
        slots: true,
        compoundVariants: true,
        patterns: true,
        rawDynamicStyles: false,
      });
      expect(initial.manifest.recipes.card.slots).toEqual([
        'root',
        'header',
        'body',
      ]);
      expect(initial.manifest.recipes.card.compoundVariants).toEqual([
        { when: { size: ['md'], tone: ['strong'] } },
      ]);
      expect(initial.manifest.themeDetails.highContrast.extends).toBe('dark');
      expect(initial.manifest.themeDetails.highContrast.remaps).toEqual({
        'colors.semanticSurface': 'colors.surface',
      });
      expect(initial.manifest.patterns.stack.parameters.gap).toEqual({
        responsive: true,
        category: 'spacing',
        token: true,
      });
      expect(initial.javascript).not.toContain('patterns.stack(');
      expect(initial.javascript).not.toContain('recipes.card(');
      expect(initial.css).toContain('flex-direction:column');
      expect(initial.css).toContain('opacity:.75');
      expect(initial.css).toContain('#000000');

      const typeFixture = path.join(project, 'phase15-types.ts');
      fs.writeFileSync(
        typeFixture,
        [
          "import { manifest, patterns, props, recipes, themes, token, type ThemeParent, type ThemeTokenValue, type ThemeTokenRemap } from './generated/design.pandamstyle';",
          "const parent: ThemeParent<'highContrast'> = 'dark';",
          "const surface: ThemeTokenValue<'highContrast', 'colors.semanticSurface'> = '#000000';",
          "const remap: ThemeTokenRemap<'highContrast', 'colors.semanticSurface'> = 'colors.surface';",
          "const card = recipes.card({ size: 'md', tone: 'strong' });",
          "const responsive = patterns.stack({ gap: token('spacing.sm'), align: { base: 'stretch', wide: 'center' } });",
          'props(card.root, card.header, card.body, responsive, themes.highContrast);',
          "const slot: 'body' = manifest.recipes.card.slots[2];",
          "const size: 'md' = manifest.recipes.card.compoundVariants[0].when.size[0];",
          "const tone: 'strong' = manifest.recipes.card.compoundVariants[0].when.tone[0];",
          'void [parent, surface, remap, slot, size, tone];',
          '// @ts-expect-error Slot names are finite and generated from the recipe.',
          'card.footer;',
          '// @ts-expect-error Pattern values come from bounded domains.',
          'patterns.grid({ columns: 7 });',
          '// @ts-expect-error Responsive keys come from the condition registry.',
          'patterns.grid({ columns: { unknown: 2 } });',
          '// @ts-expect-error Theme names come from the design system.',
          'themes.unknown;',
          '',
        ].join('\n'),
      );
      execFileSync(
        path.join(REPO_ROOT, 'node_modules/.bin/tsc'),
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'node',
          typeFixture,
        ],
        { cwd: project, encoding: 'utf8' },
      );

      const changedSource = SOURCE.replace(
        "patterns.stack({ gap: token('spacing.sm'), align: { base: 'stretch', wide: 'center' } })",
        "patterns.grid({ columns: { base: 2, wide: 3 }, gap: token('spacing.md') })",
      );
      fs.writeFileSync(page, changedSource);
      session.applyChanges({ changed: [page] });
      const sourceValidation = session.validate();
      expect(sourceValidation.ok).toBe(true);
      session.compile();
      const afterPatternEdit = readOutput(outDir);
      expect(afterPatternEdit.css).toContain(
        'grid-template-columns:repeat(3,minmax(0,1fr))',
      );
      expect(afterPatternEdit.css).not.toContain('flex-direction:column');

      session.applyChanges({
        definition: definition(compiler, {
          highContrastSurface: '#090909',
          compoundOpacity: 0.6,
        }),
      });
      const definitionValidation = session.validate();
      expect(definitionValidation.ok).toBe(true);
      expect(definitionValidation.fullFallback).toBe(false);
      session.compile();
      const afterDefinitionEdit = readOutput(outDir);
      expect(afterDefinitionEdit.manifest.registryDigest).not.toBe(
        initial.manifest.registryDigest,
      );
      expect(afterDefinitionEdit.css).toContain('#090909');
      expect(afterDefinitionEdit.css).not.toContain('#000000');
      expect(afterDefinitionEdit.css).toContain('opacity:.6');
      expect(afterDefinitionEdit.css).not.toContain('opacity:.75');
      expect(afterDefinitionEdit.declarations).toContain(
        '"colors.semanticSurface": "#090909"',
      );
      expect(afterDefinitionEdit.declarations).not.toContain(
        '"colors.semanticSurface": "#000000"',
      );
      expect(
        afterDefinitionEdit.manifest.patterns.grid.parameters.columns.values,
      ).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      session.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
