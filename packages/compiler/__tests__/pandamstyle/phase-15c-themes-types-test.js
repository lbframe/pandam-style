/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const PATTERN_CATALOG = {
  box: {
    patternId: 'box',
    parameters: {
      padding: { responsive: true, category: 'spacing', token: true },
      paddingBlock: { responsive: true, category: 'spacing', token: true },
      paddingInline: { responsive: true, category: 'spacing', token: true },
    },
  },
  center: {
    patternId: 'center',
    parameters: { inline: { responsive: false, values: [false, true] } },
  },
  grid: {
    patternId: 'grid',
    parameters: {
      align: {
        responsive: true,
        values: ['start', 'end', 'center', 'stretch', 'baseline'],
      },
      columns: { responsive: true, values: [1, 2, 3, 4, 5, 6] },
      gap: { responsive: true, category: 'spacing', token: true },
    },
  },
  inline: {
    patternId: 'inline',
    parameters: {
      align: {
        responsive: true,
        values: ['start', 'end', 'center', 'stretch', 'baseline'],
      },
      gap: { responsive: true, category: 'spacing', token: true },
      justify: {
        responsive: true,
        values: ['start', 'end', 'center', 'between', 'around'],
      },
    },
  },
  stack: {
    patternId: 'stack',
    parameters: {
      align: {
        responsive: true,
        values: ['start', 'end', 'center', 'stretch', 'baseline'],
      },
      gap: { responsive: true, category: 'spacing', token: true },
      justify: {
        responsive: true,
        values: ['start', 'end', 'center', 'between', 'around'],
      },
    },
  },
};

function definition(themeOrder = ['dark', 'highContrast'], options = {}) {
  const themes = {
    dark: {
      tokens: {
        colors: {
          baseSurface: { value: '#070707', visibility: 'public' },
          darkSurface: { value: '#020202', visibility: 'public' },
          semanticSurface: { ref: 'colors.darkSurface', visibility: 'public' },
          text: { value: '#eeeeee', visibility: 'public' },
          semanticText: { ref: 'colors.text', visibility: 'public' },
          privateTint: { value: '#010203', visibility: 'private' },
        },
      },
    },
    highContrast: {
      extends: 'dark',
      tokens: {
        colors: {
          darkSurface: {
            value: options.highContrastSurface ?? '#000000',
            visibility: 'public',
          },
        },
      },
    },
  };
  const orderedThemes = Object.fromEntries(
    themeOrder.map((themeName) => [themeName, themes[themeName]]),
  );
  return {
    systemId: 'phase15-theme-graph',
    tokens: {
      spacing: {
        sm: { value: '8px', visibility: 'public' },
      },
      colors: {
        baseSurface: { value: '#ffffff', visibility: 'public' },
        darkSurface: { value: '#111111', visibility: 'public' },
        text: { value: '#202020', visibility: 'public' },
        semanticSurface: {
          ref: 'colors.baseSurface',
          visibility: 'public',
        },
        semanticText: { ref: 'colors.text', visibility: 'public' },
        privateTint: { value: '#aabbcc', visibility: 'private' },
      },
    },
    themes: orderedThemes,
    conditions: {
      hover: ':hover',
      wide: '@media (min-width: 768px)',
    },
    recipes: {},
  };
}

function captureError(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected PandamStyle theme validation to fail');
}

describe('Phase 15 advanced theme graph and generated types', () => {
  test('inherits token overrides and resolves inherited semantic remaps in child scope', () => {
    const compiler = loadCompiler();
    const system = compiler.buildDesignSystem(definition());
    const { snapshot } = system;

    expect(snapshot.registry.themeParents).toEqual({
      dark: 'base',
      highContrast: 'dark',
    });
    expect(snapshot.registry.themes.dark['colors.semanticSurface']).toBe(
      '#020202',
    );
    expect(snapshot.registry.themes.highContrast['colors.darkSurface']).toBe(
      '#000000',
    );
    expect(
      snapshot.registry.themes.highContrast['colors.semanticSurface'],
    ).toBe('#000000');
    expect(snapshot.tooling.manifest.themeDetails.highContrast).toEqual({
      extends: 'dark',
      declaredOverrides: ['colors.darkSurface'],
      overrides: [
        'colors.baseSurface',
        'colors.darkSurface',
        'colors.semanticSurface',
        'colors.semanticText',
        'colors.text',
      ],
      remaps: {
        'colors.semanticSurface': 'colors.darkSurface',
        'colors.semanticText': 'colors.text',
      },
    });
    expect(system.renderCss()).toContain('#000000');
    expect(system.props(system.themes.highContrast).className).toContain(
      system.themeClasses.highContrast.split(' ')[0],
    );

    const generated = compiler.generateDesignSystemDeclarations(snapshot);
    expect(generated).toContain(
      'export type ThemeTokenValue<Name extends ThemeName, Path extends PublicTokenPath>',
    );
    expect(generated).toContain('"colors.semanticSurface": "#000000"');
    expect(generated).toContain(
      '"colors.semanticSurface": "colors.darkSurface"',
    );
    expect(generated).not.toContain('colors.privateTint');
  });

  test('rejects unknown parents, inheritance cycles, and cross-category remaps with source context', () => {
    const compiler = loadCompiler();

    const unknownParent = definition();
    unknownParent.themes.future = { extends: 'missing', tokens: {} };
    const unknownError = captureError(() =>
      compiler.buildDesignSystem(unknownParent),
    );
    expect(unknownError.diagnostics[0]).toMatchObject({
      code: 'PMS_UNKNOWN_THEME',
      phase: 'registry',
      source: 'themes.future',
      rule: 'theme.validation',
      context: { themeName: 'future', parent: 'missing' },
    });

    const cycle = definition();
    cycle.themes.dark.extends = 'highContrast';
    const cycleError = captureError(() => compiler.buildDesignSystem(cycle));
    expect(cycleError.diagnostics[0]).toMatchObject({
      code: 'PMS_THEME_CYCLE',
      context: {
        cycle: ['dark', 'highContrast', 'dark'],
      },
    });

    const wrongCategory = definition();
    wrongCategory.tokens.spacing = {
      compact: { value: '4px', visibility: 'public' },
    };
    wrongCategory.themes.dark.tokens.spacing = {
      compact: { ref: 'colors.text', visibility: 'public' },
    };
    const categoryError = captureError(() =>
      compiler.buildDesignSystem(wrongCategory),
    );
    expect(categoryError.diagnostics[0]).toMatchObject({
      code: 'PMS_INVALID_TOKEN_CATEGORY',
      context: {
        themeName: 'dark',
        tokenId: 'spacing.compact',
        ref: 'colors.text',
        expected: 'spacing',
        actual: 'colors',
      },
    });

    const missingOverrideRef = definition();
    missingOverrideRef.themes.dark.tokens.colors.darkSurface = {
      ref: 'colors.absent',
      visibility: 'public',
    };
    const missingRefError = captureError(() =>
      compiler.buildDesignSystem(missingOverrideRef),
    );
    expect(missingRefError.diagnostics[0]).toMatchObject({
      code: 'PMS_UNKNOWN_TOKEN',
      source: 'themes.dark',
      rule: 'theme.validation',
      context: {
        themeName: 'dark',
        tokenId: 'colors.darkSurface',
        missingRef: 'colors.absent',
      },
    });

    const tokenCycle = definition();
    tokenCycle.themes.dark.tokens.colors.semanticSurface = {
      ref: 'colors.semanticText',
      visibility: 'public',
    };
    tokenCycle.themes.dark.tokens.colors.semanticText = {
      ref: 'colors.semanticSurface',
      visibility: 'public',
    };
    const tokenCycleError = captureError(() =>
      compiler.buildDesignSystem(tokenCycle),
    );
    expect(tokenCycleError.diagnostics[0]).toMatchObject({
      code: 'PMS_THEME_TOKEN_CYCLE',
      source: 'themes.dark',
      rule: 'theme.validation',
      context: {
        themeName: 'dark',
        tokenId: expect.stringMatching(/^colors\./),
        cycle: expect.arrayContaining([
          expect.stringMatching(/^dark\/colors\./),
        ]),
      },
    });
  });

  test('theme output and generated declarations are stable when theme definitions are reordered', () => {
    const compiler = loadCompiler();
    const first = compiler.buildDesignSystem(definition());
    const second = compiler.buildDesignSystem(
      definition(['highContrast', 'dark']),
    );

    expect(second.snapshot.identity.registryDigest).toBe(
      first.snapshot.identity.registryDigest,
    );
    expect(second.themeClasses).toEqual(first.themeClasses);
    expect(second.renderCss()).toBe(first.renderCss());
    expect(compiler.generateDesignSystemDeclarations(second.snapshot)).toBe(
      compiler.generateDesignSystemDeclarations(first.snapshot),
    );
  });

  test('theme inheritance edits refresh all generated artifacts incrementally', () => {
    const compiler = loadCompiler();
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-phase15-theme-incremental-'),
    );
    const src = path.join(project, 'src');
    const outDir = path.join(project, 'generated');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'page.js'),
      [
        "import { create, token, themes, props } from '../generated/design.pandamstyle';",
        "const styles = create({ surface: { color: token('colors.semanticSurface') } });",
        'export const view = props(themes.highContrast, styles.surface);',
        '',
      ].join('\n'),
    );
    const session = compiler.createProjectSession({
      definition: definition(),
      roots: [src],
      outDir,
    });

    try {
      session.initialize();
      expect(session.validate().ok).toBe(true);
      session.compile();
      const first = {
        manifest: JSON.parse(
          fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
        ),
        declarations: fs.readFileSync(
          path.join(outDir, 'design.pandamstyle.d.ts'),
          'utf8',
        ),
        css: fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8'),
      };

      session.applyChanges({
        definition: definition(['dark', 'highContrast'], {
          highContrastSurface: '#090909',
        }),
      });
      const validation = session.validate();
      expect(validation.ok).toBe(true);
      expect(validation.fullFallback).toBe(false);
      // This source consumes highContrast and its compiled ref changes. No
      // unrelated source file is present in the project.
      expect(validation.counters.filesRecompiled).toBe(1);
      expect(validation.counters.designSystemViewsRecomputed).toBeLessThan(10);
      expect(validation.counters.generatedTypesRegenerated).toBe(1);
      session.compile();

      const next = {
        manifest: JSON.parse(
          fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
        ),
        declarations: fs.readFileSync(
          path.join(outDir, 'design.pandamstyle.d.ts'),
          'utf8',
        ),
        css: fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8'),
      };
      expect(next.manifest.registryDigest).not.toBe(
        first.manifest.registryDigest,
      );
      expect(next.manifest.themeDetails.highContrast.overrides).toContain(
        'colors.semanticSurface',
      );
      expect(next.manifest.tokens['colors.semanticSurface']).toBeDefined();
      expect(next.declarations).toContain(
        '"colors.semanticSurface": "#090909"',
      );
      expect(next.declarations).not.toContain(
        '"colors.semanticSurface": "#000000"',
      );
      expect(next.declarations).not.toContain('colors.privateTint');
      expect(next.css).toContain('#090909');
      expect(next.css).not.toContain('#000000');
    } finally {
      session.close();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });

  test('generated theme-dependent types accept inherited values and reject unknown themes and private tokens', () => {
    const compiler = loadCompiler();
    const system = compiler.buildDesignSystem(definition());
    const declarations = compiler.generateDesignSystemDeclarations(
      system.snapshot,
    );
    const outputRoot = path.join(REPO_ROOT, 'out-pandamstyle');
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, 'phase15-theme-types-'));
    const declarationPath = path.join(root, 'design.pandamstyle.d.ts');
    const positivePath = path.join(root, 'positive.ts');
    const negativePath = path.join(root, 'negative.ts');
    const tsc = path.join(REPO_ROOT, 'node_modules/.bin/tsc');
    const options = [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'node',
    ];

    try {
      fs.writeFileSync(declarationPath, declarations);
      fs.writeFileSync(
        positivePath,
        [
          "import { manifest, themes, type ThemeName, type ThemeParent, type ThemeOverrideTokenPath, type ThemeTokenValue, type ThemeTokenRemap } from './design.pandamstyle';",
          "const name: ThemeName = 'highContrast';",
          "const parent: ThemeParent<'highContrast'> = 'dark';",
          "const value: ThemeTokenValue<'highContrast', 'colors.semanticSurface'> = '#000000';",
          "const remap: ThemeTokenRemap<'highContrast', 'colors.semanticSurface'> = 'colors.darkSurface';",
          "const changedPath: ThemeOverrideTokenPath<'highContrast'> = 'colors.semanticSurface';",
          "const manifestParent: 'dark' = manifest.themeDetails.highContrast.extends;",
          'const scopedTheme = themes.highContrast;',
          'void [name, parent, value, remap, changedPath, manifestParent, scopedTheme];',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(
        negativePath,
        [
          "import { themes, type ThemeTokenValue, type ThemeTokenRemap } from './design.pandamstyle';",
          'const unknown = themes.missing;',
          "const wrongValue: ThemeTokenValue<'highContrast', 'colors.semanticSurface'> = '#ffffff';",
          "const wrongRemap: ThemeTokenRemap<'highContrast', 'colors.semanticSurface'> = 'colors.text';",
          "type PrivateValue = ThemeTokenValue<'highContrast', 'colors.privateTint'>;",
          'void [unknown, wrongValue, wrongRemap];',
          '',
        ].join('\n'),
      );
      execFileSync(tsc, [...options, positivePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      const negative = spawnSync(tsc, [...options, negativePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      const output = `${negative.stdout ?? ''}${negative.stderr ?? ''}`;
      expect(negative.status).not.toBe(0);
      expect(output).toContain('negative.ts(2,24)');
      expect(output).toContain('negative.ts(3,7)');
      expect(output).toContain('negative.ts(4,7)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('generated declarations type slots, compounds, themes and responsive patterns together', () => {
    const compiler = loadCompiler();
    const snapshot = JSON.parse(
      JSON.stringify(compiler.buildDesignSystem(definition()).snapshot),
    );
    snapshot.capabilities.slots = true;
    snapshot.capabilities.compoundVariants = true;
    snapshot.capabilities.patterns = true;
    snapshot.tooling.manifest.capabilities = { ...snapshot.capabilities };
    snapshot.tooling.manifest.patterns = PATTERN_CATALOG;
    snapshot.tooling.manifest.recipes.card = {
      axisOrder: ['size'],
      axes: { size: ['sm', 'md'] },
      defaults: { size: 'sm' },
      slots: ['root', 'label'],
      compoundVariants: [{ when: { size: ['md'] } }],
    };
    snapshot.tooling.candidateDomains.recipes.ids = ['card'];
    snapshot.tooling.candidateDomains.recipes.byRecipe = {
      card: {
        axes: ['size'],
        values: { size: ['sm', 'md'] },
        slots: ['root', 'label'],
      },
    };
    snapshot.vocabulary.publicRecipeIds = ['card'];

    const declarations = compiler.generateDesignSystemDeclarations(snapshot);
    const outputRoot = path.join(REPO_ROOT, 'out-pandamstyle');
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, 'phase15-cross-types-'));
    const declarationPath = path.join(root, 'design.pandamstyle.d.ts');
    const fixturePath = path.join(root, 'phase15-types.ts');
    const tsc = path.join(REPO_ROOT, 'node_modules/.bin/tsc');

    try {
      fs.writeFileSync(declarationPath, declarations);
      fs.writeFileSync(
        fixturePath,
        [
          "import { manifest, patterns, props, recipes, themes, token, type PatternName, type ThemeParent, type ThemeTokenValue } from './design.pandamstyle';",
          "const pattern: PatternName = 'grid';",
          "const parent: ThemeParent<'highContrast'> = 'dark';",
          "const value: ThemeTokenValue<'highContrast', 'colors.semanticSurface'> = '#000000';",
          "const card = recipes.card({ size: 'md' });",
          "const layout = patterns.grid({ columns: { base: 1, wide: 3 }, gap: token('spacing.sm') });",
          'props(card.root, card.label, layout, themes.highContrast);',
          "const slot: 'label' = manifest.recipes.card.slots[1];",
          "const compound: 'md' = manifest.recipes.card.compoundVariants[0].when.size[0];",
          "const category: 'spacing' = manifest.patterns.grid.parameters.gap.category;",
          'void [pattern, parent, value, slot, compound, category];',
          '// @ts-expect-error Slot recipe selectors expose only declared slots.',
          'card.body;',
          '// @ts-expect-error Patterns reject values outside their finite domains.',
          'patterns.grid({ columns: 7 });',
          '// @ts-expect-error Spacing parameters require spacing tokens.',
          "patterns.stack({ gap: token('colors.text') });",
          '// @ts-expect-error Responsive maps use only registered conditions.',
          'patterns.grid({ columns: { unknownCondition: 2 } });',
          '// @ts-expect-error Theme names are generated from the design system.',
          'themes.missing;',
          '',
        ].join('\n'),
      );
      const typecheck = spawnSync(
        tsc,
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
          fixturePath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      const typecheckOutput = `${typecheck.stdout ?? ''}${typecheck.stderr ?? ''}`;
      if (typecheck.status !== 0) {
        throw new Error(typecheckOutput);
      }

      const configFixturePath = path.join(root, 'config-pattern-types.ts');
      fs.writeFileSync(
        configFixturePath,
        [
          "import { patternStyles, token } from '@pandamstyle/compiler/config';",
          "const gap = token('spacing.sm');",
          "patternStyles('stack', { gap, align: { wide: 'start' }, justify: 'between' });",
          "patternStyles('grid', { columns: { base: 1, wide: 3 }, gap });",
          "patternStyles('center', { inline: true });",
          '// @ts-expect-error Grid column counts are bounded.',
          "patternStyles('grid', { columns: 7 });",
          '// @ts-expect-error Pattern spacing accepts spacing token refs only.',
          "patternStyles('box', { padding: token('colors.text') });",
          '// @ts-expect-error Center inline takes a scalar boolean.',
          "patternStyles('center', { inline: { base: true } });",
          '// @ts-expect-error Pattern identifiers come from the finite catalog.',
          "patternStyles('masonry', {});",
          '',
        ].join('\n'),
      );
      const configTypecheck = spawnSync(
        tsc,
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'bundler',
          configFixturePath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
      const configTypecheckOutput = `${configTypecheck.stdout ?? ''}${configTypecheck.stderr ?? ''}`;
      if (configTypecheck.status !== 0) {
        throw new Error(configTypecheckOutput);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
