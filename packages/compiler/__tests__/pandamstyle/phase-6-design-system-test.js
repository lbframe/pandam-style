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
const crypto = require('crypto');
const { parse } = require('@babel/parser');
const babelTraverse = require('@babel/traverse');
const { execFileSync, spawnSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const traverse = babelTraverse.default ?? babelTraverse;

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function definition(options = {}) {
  const spacing = {
    sm: { value: '8px', visibility: 'public' },
    ...(options.includeMd === false
      ? {}
      : { md: { value: '16px', visibility: 'public' } }),
    ...(options.includeExtra === true
      ? { extra: { value: '32px', visibility: 'public' } }
      : {}),
    ...(options.includeMedium === true
      ? { medium: { value: '16px', visibility: 'public' } }
      : {}),
  };
  const variants = {
    size: {
      sm: { padding: loadCompiler().token('spacing.sm') },
      md: { padding: loadCompiler().token('spacing.sm') },
      ...(options.includeLg === true
        ? { lg: { padding: loadCompiler().token('spacing.sm') } }
        : {}),
    },
    enabled: {
      true: { opacity: 1 },
      false: { opacity: 0.5 },
    },
    ...(options.includeTone === true
      ? {
          tone: {
            quiet: { color: loadCompiler().token('colors.accent') },
          },
        }
      : {}),
  };
  const defaultVariants = { size: 'sm', enabled: false };
  if (options.includeTone === true) defaultVariants.tone = 'quiet';

  return {
    systemId: 'phase6-ui',
    tokens: {
      spacing,
      colors: {
        surface: { value: '#ffffff', visibility: 'public' },
        accent: { value: '#2455cc', visibility: 'public' },
        brand: {
          ref: options.brandRef ?? 'colors.surface',
          visibility: 'public',
        },
        secret: { value: '#aabbcc', visibility: 'private' },
      },
      ...(options.extraCategory === true
        ? { radii: { extra: { value: '4px', visibility: 'public' } } }
        : {}),
    },
    themes: {
      dark: {
        tokens: {
          colors: {
            surface: {
              value: options.darkSurface ?? '#111111',
              visibility: 'public',
            },
          },
        },
      },
    },
    conditions: {
      hover: options.hover ?? ':hover',
      wide: '@media (min-width: 768px)',
    },
    recipes: {
      button: {
        visibility: 'public',
        base: {
          color: { hover: loadCompiler().token('colors.brand') },
        },
        variants,
        defaultVariants,
      },
      secretRecipe: {
        visibility: options.secretPublic === true ? 'public' : 'private',
        base: { display: 'block' },
        variants: { level: { low: { opacity: 0.5 } } },
        defaultVariants: { level: 'low' },
      },
    },
  };
}

function sourceArtifacts(outDir) {
  return {
    javascript: fs.readFileSync(
      path.join(outDir, 'design.pandamstyle.js'),
      'utf8',
    ),
    declarations: fs.readFileSync(
      path.join(outDir, 'design.pandamstyle.d.ts'),
      'utf8',
    ),
    manifestText: fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
    manifest: JSON.parse(
      fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
    ),
    artifactSetText: fs.readFileSync(
      path.join(outDir, 'artifacts.json'),
      'utf8',
    ),
    artifactSet: JSON.parse(
      fs.readFileSync(path.join(outDir, 'artifacts.json'), 'utf8'),
    ),
    css: fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8'),
  };
}

function assertArtifactIdentity(outDir) {
  const artifacts = sourceArtifacts(outDir);
  const markerMatch = artifacts.javascript.match(
    /export const __pandamstyle = (\{[\s\S]*?\n\});/,
  );
  expect(markerMatch).not.toBeNull();
  const marker = JSON.parse(markerMatch[1]);
  for (const key of [
    'abiVersion',
    'compilerContractVersion',
    'manifestSchemaVersion',
  ]) {
    expect(artifacts.artifactSet[key]).toBe(artifacts.manifest[key]);
  }
  expect(marker.designSystem.systemId).toBe(artifacts.manifest.systemId);
  expect(marker.designSystem.registryDigest).toBe(
    artifacts.manifest.registryDigest,
  );
  expect(marker.abiVersion).toBe(artifacts.manifest.abiVersion);
  expect(marker.compilerContractVersion).toBe(
    artifacts.manifest.compilerContractVersion,
  );
  expect(marker.manifestSchemaVersion).toBe(
    artifacts.manifest.manifestSchemaVersion,
  );
  expect(artifacts.artifactSet.artifactSetDigest).toMatch(/^[0-9a-f]{64}$/);
  for (const record of Object.values(artifacts.artifactSet.artifacts)) {
    const content = fs.readFileSync(path.join(outDir, record.file), 'utf8');
    expect(Buffer.byteLength(content, 'utf8')).toBe(record.bytes);
    expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(
      record.sha256,
    );
  }
  expect(artifacts.css.startsWith('/* pandamstyle-design-system ')).toBe(true);
  return artifacts;
}

function sampleSet(systemId) {
  const compiler = loadCompiler();
  const ds = compiler.buildDesignSystem({
    systemId,
    tokens: { spacing: { sm: { value: '8px', visibility: 'public' } } },
    themes: {},
    conditions: { hover: ':hover' },
    recipes: {
      button: {
        visibility: 'public',
        variants: { size: { sm: { padding: compiler.token('spacing.sm') } } },
        defaultVariants: { size: 'sm' },
      },
    },
  });
  const designModule = compiler.generateDesignSystemModule({
    designSystem: ds,
  });
  const declarations = compiler.generateDesignSystemDeclarations(ds.snapshot);
  const manifest = `${JSON.stringify(ds.snapshot.tooling.manifest, null, 2)}\n`;
  const css = compiler.withDesignSystemCssIdentity(
    ds.renderCss(),
    ds.snapshot.identity,
  );
  return compiler.createArtifactSet(ds.snapshot, {
    designModuleFile: 'design.js',
    declarationsFile: 'design.d.ts',
    designModule,
    declarations,
    manifest,
    css,
  });
}

describe('Phase 6 canonical design-system projections', () => {
  test('recipe IDs stay inert string keys in generated JavaScript', () => {
    const compiler = loadCompiler();
    const maliciousId =
      'x = (globalThis.__pmsRecipeCodegenProbe = true, 1), __pmsRecipe_y';
    const input = definition();
    input.recipes = {
      [maliciousId]: {
        visibility: 'public',
        base: { display: 'block' },
      },
    };
    const designSystem = compiler.buildDesignSystem(input);
    const generated = compiler.generateDesignSystemModule({ designSystem });
    const ast = parse(generated, { sourceType: 'module' });
    const identifierNames = [];
    let hostileIdIsAStringKey = false;
    let hostileIdIsAComputedKey = false;

    traverse(ast, {
      Identifier(nodePath) {
        identifierNames.push(nodePath.node.name);
      },
      StringLiteral(nodePath) {
        if (nodePath.node.value === maliciousId) hostileIdIsAStringKey = true;
      },
      ObjectProperty(nodePath) {
        const { computed, key } = nodePath.node;
        if (
          computed === true &&
          key.type === 'StringLiteral' &&
          key.value === maliciousId
        ) {
          hostileIdIsAComputedKey = true;
        }
      },
    });

    expect(hostileIdIsAStringKey).toBe(true);
    expect(identifierNames).not.toContain('globalThis');
    expect(identifierNames).not.toContain('__pmsRecipe_y');
    expect(identifierNames.some((name) => /^__pmsRecipe_\d+$/.test(name))).toBe(
      true,
    );
    expect(hostileIdIsAComputedKey).toBe(true);
  });

  test('the immutable snapshot owns identity, public vocabulary, ordering and qualified Phase 15 capabilities', () => {
    const compiler = loadCompiler();
    const ds = compiler.buildDesignSystem(definition());
    const snapshot = ds.snapshot;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.registry.tokens)).toBe(true);
    expect(snapshot.identity).toEqual({
      systemId: 'phase6-ui',
      registryDigest: ds.registry.registryDigest,
      abiVersion: 1,
      compilerContractVersion: 'pms-0.1',
      manifestSchemaVersion: 1,
    });
    expect(snapshot.capabilities).toEqual({
      slots: true,
      compoundVariants: true,
      patterns: true,
      rawDynamicStyles: false,
    });
    expect(snapshot.vocabulary.publicTokenPaths).toContain('colors.brand');
    expect(snapshot.vocabulary.publicTokenPaths).not.toContain('colors.secret');
    expect(snapshot.vocabulary.semanticTokens).toContainEqual(
      expect.objectContaining({
        tokenId: 'colors.brand',
        kind: 'alias',
        ref: 'colors.surface',
      }),
    );
    expect(snapshot.vocabulary.conditions).toEqual([
      { name: 'hover', definition: ':hover', kind: 'selector' },
      {
        name: 'wide',
        definition: '@media (min-width: 768px)',
        kind: 'at-rule',
      },
    ]);
    expect(snapshot.tooling.manifest.tokens['colors.brand']).toEqual({
      category: 'colors',
    });
    expect(snapshot.tooling.manifest.semanticTokens['colors.brand']).toEqual({
      category: 'colors',
      kind: 'alias',
      ref: 'colors.surface',
    });
    expect(snapshot.tooling.manifest.tokens['colors.secret']).toBeUndefined();
    expect(snapshot.tooling.manifest.recipes.secretRecipe).toBeUndefined();
    const consumerProjection = [
      compiler.generateDesignSystemModule({ designSystem: ds }),
      compiler.generateDesignSystemDeclarations(snapshot),
      JSON.stringify(snapshot.tooling.manifest),
      ds.renderCss(),
    ].join('\n');
    expect(consumerProjection).not.toContain('colors.secret');
    expect(consumerProjection).not.toContain('secretRecipe');
    expect(
      compiler.repairDomainOf(snapshot, { kind: 'token', category: 'colors' }),
    ).toEqual(snapshot.tooling.candidateDomains.tokens.byCategory.colors);

    const orderedThemes = definition();
    orderedThemes.themes = {
      dark: orderedThemes.themes.dark,
      light: {
        tokens: {
          colors: {
            accent: { value: '#eeeeee', visibility: 'public' },
          },
        },
      },
    };
    const reversedThemes = definition();
    reversedThemes.themes = {
      light: orderedThemes.themes.light,
      dark: reversedThemes.themes.dark,
    };
    const orderedSystem = compiler.buildDesignSystem(orderedThemes);
    const reversedSystem = compiler.buildDesignSystem(reversedThemes);
    const orderedSnapshot = orderedSystem.snapshot;
    const reversedSnapshot = reversedSystem.snapshot;
    expect(reversedSnapshot.identity).toEqual(orderedSnapshot.identity);
    expect(reversedSystem.renderCss()).toBe(orderedSystem.renderCss());
    expect(orderedSnapshot.vocabulary.themes).toEqual([
      'base',
      'dark',
      'light',
    ]);

    const privateAliasSystem = compiler.buildDesignSystem(
      definition({ brandRef: 'colors.secret' }),
    );
    expect(
      privateAliasSystem.snapshot.tooling.manifest.semanticTokens[
        'colors.brand'
      ],
    ).toEqual({ category: 'colors', kind: 'alias' });
    expect(
      JSON.stringify(privateAliasSystem.snapshot.tooling.manifest),
    ).not.toContain('colors.secret');
  });

  test('artifact metadata authenticates sibling projections and rejects mixed sets', () => {
    const compiler = loadCompiler();
    const setA = sampleSet('coherence-a');
    const setB = sampleSet('coherence-b');

    expect(compiler.validateArtifactSet(setA.metadata, setA.contents)).toBe(
      true,
    );
    expect(() =>
      compiler.validateArtifactSet(setA.metadata, {
        ...setA.contents,
        declarations: setB.contents.declarations,
      }),
    ).toThrow(/artifact set mismatch/i);
    expect(() =>
      compiler.validateArtifactSet(setA.metadata, {
        ...setA.contents,
        manifest: setB.contents.manifest,
      }),
    ).toThrow(/artifact set mismatch/i);
    expect(() =>
      compiler.validateArtifactSet(setA.metadata, {
        ...setA.contents,
        css: setB.contents.css,
      }),
    ).toThrow(/artifact set mismatch/i);
    expect(() =>
      compiler.createArtifactSet(
        compiler.buildDesignSystem({
          systemId: 'coherence-a',
          tokens: { spacing: { sm: { value: '8px', visibility: 'public' } } },
          conditions: { hover: ':hover' },
          themes: {},
          recipes: {
            button: {
              variants: {
                size: { sm: { padding: compiler.token('spacing.sm') } },
              },
              defaultVariants: { size: 'sm' },
            },
          },
        }).snapshot,
        {
          designModuleFile: 'design.js',
          declarationsFile: 'design.d.ts',
          designModule: setB.contents.designModule,
          declarations: setA.contents.declarations,
          manifest: setA.contents.manifest,
          css: setA.contents.css,
        },
      ),
    ).toThrow(/identity marker differs/i);
    expect(() =>
      compiler.validateArtifactSet(
        { ...setA.metadata, artifactSetDigest: '0'.repeat(64) },
        setA.contents,
      ),
    ).toThrow(/artifact-set digest is invalid/i);
  });

  test('generated TypeScript declarations accept only finite public domains', () => {
    const compiler = loadCompiler();
    const durationsNs = {};
    const counts = {};
    const collector = {
      addDuration(name, value) {
        durationsNs[name] = (durationsNs[name] ?? 0) + value;
      },
      addCount(name, value) {
        counts[name] = (counts[name] ?? 0) + value;
      },
      addParse() {},
      sampleMemory() {},
    };
    const stopCollecting = compiler.installPerfCollector(collector);
    const generationStart = process.hrtime.bigint();
    let designSystem;
    let snapshot;
    let declaration;
    let generationReport;
    try {
      designSystem = compiler.buildDesignSystem(definition());
      snapshot = designSystem.snapshot;
      const designModule = compiler.phase('ds_module_codegen_ms', () =>
        compiler.generateDesignSystemModule({ designSystem }),
      );
      declaration = compiler.phase('ds_types_codegen_ms', () =>
        compiler.generateDesignSystemDeclarations(snapshot),
      );
      const manifestText = compiler.phase(
        'ds_manifest_codegen_ms',
        () => `${JSON.stringify(snapshot.tooling.manifest, null, 2)}\n`,
      );
      const css = compiler.withDesignSystemCssIdentity(
        designSystem.renderCss(),
        snapshot.identity,
      );
      const artifacts = compiler.phase('ds_artifact_set_ms', () =>
        compiler.createArtifactSet(snapshot, {
          designModuleFile: 'design.pandamstyle.js',
          declarationsFile: 'design.pandamstyle.d.ts',
          designModule,
          declarations: declaration,
          manifest: manifestText,
          css,
        }),
      );
      generationReport = {
        documentKind: 'pandamstyle-phase-6-projection-performance',
        designSystemBuildCount: counts.design_system_builds ?? 0,
        generationElapsedMs:
          Number(process.hrtime.bigint() - generationStart) / 1e6,
        phaseDurationsMs: Object.fromEntries(
          Object.entries(durationsNs).map(([name, value]) => [
            name,
            value / 1e6,
          ]),
        ),
        artifactBytes: Object.fromEntries(
          Object.entries(artifacts.metadata.artifacts).map(([name, record]) => [
            name,
            record.bytes,
          ]),
        ),
        artifactSetDigest: artifacts.metadata.artifactSetDigest,
        tokenPathCount: snapshot.vocabulary.publicTokenPaths.length,
        publicRecipeCount: snapshot.vocabulary.publicRecipeIds.length,
        memoryBytes: process.memoryUsage().heapUsed,
      };
    } finally {
      stopCollecting();
    }
    expect(generationReport.designSystemBuildCount).toBe(1);
    for (const metric of [
      'ds_build_registry_ms',
      'ds_snapshot_build_ms',
      'ds_module_codegen_ms',
      'ds_types_codegen_ms',
      'ds_manifest_codegen_ms',
      'ds_artifact_set_ms',
    ]) {
      expect(generationReport.phaseDurationsMs[metric]).toEqual(
        expect.any(Number),
      );
    }
    const outputRoot = path.join(REPO_ROOT, 'out-pandamstyle');
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, 'phase6-types-'));
    const tsc = path.join(REPO_ROOT, 'node_modules/.bin/tsc');
    const modulePath = path.join(root, 'design.pandamstyle.d.ts');
    const positivePath = path.join(root, 'positive.ts');
    const negativePath = path.join(root, 'negative.ts');
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
    fs.writeFileSync(modulePath, declaration);
    fs.writeFileSync(
      positivePath,
      [
        "import { create, token, recipes, themes, manifest, __pandamstyle, type PublicTokenPath, type ColorsTokenPath, type ThemeName, type PmsConditionName } from './design.pandamstyle';",
        "const path: PublicTokenPath = 'spacing.md';",
        "const color: ColorsTokenPath = 'colors.brand';",
        "const theme: ThemeName = 'dark';",
        "const condition: PmsConditionName = 'hover';",
        "const styles = create({ box: { display: 'flex', padding: token('spacing.sm'), color: { base: token('colors.brand'), hover: token('colors.accent') } } });",
        "const selected = recipes.button({ size: 'sm', enabled: false });",
        'const themeRef = themes.dark;',
        "const aliasKind: 'alias' = manifest.semanticTokens['colors.brand'].kind;",
        "const conditionKind: 'selector' | 'at-rule' = manifest.conditions[0].kind;",
        "const defaultSize: 'sm' = recipes.button.defaultVariants.size;",
        'const abiVersion: 1 = __pandamstyle.abiVersion;',
        'const markerDigest: string = __pandamstyle.designSystem.registryDigest;',
        'void [path, color, theme, condition, styles, selected, themeRef, aliasKind, conditionKind, defaultSize, abiVersion, markerDigest];',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      negativePath,
      [
        "import { create, token, recipes, themes, type ColorsTokenPath } from './design.pandamstyle';",
        "token('spacing.unknown');",
        "token('colors.secret');",
        "create({ box: { padding: token('colors.brand') } });",
        'const unknownTheme = themes.missing;',
        "recipes.button({ size: 'unknown' });",
        "recipes.button({ unknown: 'sm' });",
        "recipes.button({ enabled: 'true' });",
        "recipes.secretRecipe({ level: 'low' });",
        "create({ box: { color: { unlisted: token('colors.brand') } } });",
        "const wrongCategory: ColorsTokenPath = 'spacing.sm';",
        "const wrongDefault: 'md' = recipes.button.defaultVariants.size;",
        '',
      ].join('\n'),
    );

    try {
      const positiveStart = process.hrtime.bigint();
      execFileSync(tsc, [...options, positivePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      const positiveMs = Number(process.hrtime.bigint() - positiveStart) / 1e6;

      const negativeStart = process.hrtime.bigint();
      const negative = spawnSync(tsc, [...options, negativePath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      const negativeMs = Number(process.hrtime.bigint() - negativeStart) / 1e6;
      const errors =
        `${negative.stdout ?? ''}${negative.stderr ?? ''}`.match(
          /error TS\d+/g,
        ) ?? [];
      const negativeDiagnostics = `${negative.stdout ?? ''}${negative.stderr ?? ''}`;
      const invalidLines = [
        ...negativeDiagnostics.matchAll(/negative\.ts\((\d+),\d+\)/g),
      ]
        .map((match) => Number(match[1]))
        .filter((line, index, lines) => lines.indexOf(line) === index)
        .sort((a, b) => a - b);
      expect(negative.status).not.toBe(0);
      expect(errors.length).toBeGreaterThanOrEqual(11);
      expect(invalidLines).toEqual(
        Array.from({ length: 11 }, (_, index) => index + 2),
      );
      expect(declaration).not.toContain('colors.secret');
      expect(declaration).not.toContain('secretRecipe');
      expect(declaration).not.toContain('slotRecipes');
      expect(declaration).toContain('export declare const patterns');
      expect(declaration).toContain('export type PatternName =');
      expect(declaration).toContain('readonly slots: readonly [];');
      expect(declaration).toContain('readonly compoundVariants: readonly [];');

      const report = {
        documentKind: 'pandamstyle-phase-6-typescript-qualification',
        positive: { status: 'passed', elapsedMs: positiveMs },
        negative: {
          status: 'rejected-invalid-vocabulary',
          diagnosticCount: errors.length,
          invalidLines,
          elapsedMs: negativeMs,
        },
        declarationBytes: Buffer.byteLength(declaration, 'utf8'),
        tokenLiterals: snapshot.vocabulary.publicTokenPaths.length,
        recipeDomainLiterals: Object.values(
          snapshot.tooling.candidateDomains.recipes.byRecipe,
        ).reduce(
          (count, recipe) =>
            count +
            Object.values(recipe.values).reduce(
              (sum, values) => sum + values.length,
              0,
            ),
          0,
        ),
        memoryBytes: process.memoryUsage().heapUsed,
      };
      if (process.env.PMS_OUT_DIR != null) {
        fs.mkdirSync(process.env.PMS_OUT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(process.env.PMS_OUT_DIR, 'phase-6-projections.json'),
          `${JSON.stringify(generationReport, null, 2)}\n`,
        );
        fs.writeFileSync(
          path.join(process.env.PMS_OUT_DIR, 'phase-6-typescript.json'),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('design-system revisions refresh JS, CSS, declarations, manifest, candidates and repairs together', () => {
    const compiler = loadCompiler();
    const durationsNs = {};
    const counts = {};
    const collector = {
      addDuration(name, value) {
        durationsNs[name] = (durationsNs[name] ?? 0) + value;
      },
      addCount(name, value) {
        counts[name] = (counts[name] ?? 0) + value;
      },
      addParse() {},
      sampleMemory() {},
    };
    const stopCollecting = compiler.installPerfCollector(collector);
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-phase6-revisions-'),
    );
    const src = path.join(project, 'src');
    const outDir = path.join(project, 'generated');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(
      path.join(src, 'page.js'),
      [
        "import { create, token, recipes, props } from '../generated/design.pandamstyle';",
        "const styles = create({ box: { padding: token('spacing.sm') } });",
        'export const view = props(styles.box);',
        "export const button = recipes.button({ size: 'sm' });",
        '',
      ].join('\n'),
    );
    const session = compiler.createProjectSession({
      definition: definition(),
      roots: [src],
      outDir,
    });
    const revisions = [
      { label: 'initial', options: {} },
      { label: 'token-added', options: { includeExtra: true } },
      {
        label: 'token-removed',
        options: { includeMd: false, includeExtra: true },
      },
      {
        label: 'token-renamed',
        options: { includeMd: false, includeMedium: true, includeExtra: true },
      },
      {
        label: 'token-category-changed',
        options: { includeMd: false, includeMedium: true, extraCategory: true },
      },
      {
        label: 'semantic-alias-retargeted',
        options: {
          includeMd: false,
          includeMedium: true,
          extraCategory: true,
          brandRef: 'colors.accent',
        },
      },
      {
        label: 'theme-override-changed',
        options: {
          includeMd: false,
          includeMedium: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
        },
      },
      {
        label: 'condition-definition-changed',
        options: {
          includeMd: false,
          includeMedium: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
        },
      },
      {
        label: 'recipe-axis-added',
        options: {
          includeMd: false,
          includeMedium: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
          includeTone: true,
        },
      },
      {
        label: 'recipe-axis-removed',
        options: {
          includeMd: false,
          includeMedium: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
        },
      },
      {
        label: 'recipe-domain-changed',
        options: {
          includeMd: false,
          includeMedium: true,
          includeExtra: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
          includeLg: true,
        },
      },
      {
        label: 'private-recipe-made-public',
        options: {
          includeMd: false,
          includeMedium: true,
          includeExtra: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
          includeLg: true,
          secretPublic: true,
        },
      },
      {
        label: 'recipe-made-private',
        options: {
          includeMd: false,
          includeMedium: true,
          includeExtra: true,
          extraCategory: true,
          brandRef: 'colors.accent',
          darkSurface: '#000000',
          hover: ':is(:hover, [data-hover])',
          includeLg: true,
        },
      },
    ];

    const mutationObservations = [];
    let fullFallbackCount = 0;
    try {
      session.initialize();
      let previousDigest = null;
      for (const revision of revisions) {
        let applyElapsedMs = null;
        if (revision.label !== 'initial') {
          const applyStart = process.hrtime.bigint();
          session.applyChanges({ definition: definition(revision.options) });
          applyElapsedMs = Number(process.hrtime.bigint() - applyStart) / 1e6;
        }
        const validation = session.validate();
        expect({ label: revision.label, ok: validation.ok }).toEqual({
          label: revision.label,
          ok: true,
        });
        if (revision.label !== 'initial') {
          expect(validation.fullFallback).toBe(false);
          fullFallbackCount += validation.fullFallback ? 1 : 0;
        }
        session.compile();
        const artifacts = assertArtifactIdentity(outDir);
        const {
          manifest,
          manifestText,
          declarations,
          javascript,
          artifactSet,
          css,
        } = artifacts;
        expect(manifest.systemId).toBe('phase6-ui');
        if (previousDigest != null) {
          expect(manifest.registryDigest).not.toBe(previousDigest);
        }
        previousDigest = manifest.registryDigest;
        expect(declarations).toContain(
          `registryDigest: ${JSON.stringify(manifest.registryDigest)}`,
        );
        expect(css).toContain(manifest.registryDigest);
        expect(artifactSet.artifactSetDigest).toBeTruthy();

        const spacingCandidates = session.candidateTokens({
          category: 'spacing',
        }).tokens;
        expect(
          session._repairDomain({ kind: 'token', category: 'spacing' }),
        ).toEqual(spacingCandidates);
        expect(spacingCandidates).not.toContain('colors.secret');
        if (revision.label === 'token-added') {
          expect(spacingCandidates).toContain('spacing.extra');
          expect(declarations).toContain('"spacing.extra"');
        }
        if (revision.label === 'token-removed') {
          expect(spacingCandidates).not.toContain('spacing.md');
          expect(declarations).not.toContain('"spacing.md"');
        }
        if (revision.label === 'token-renamed') {
          expect(spacingCandidates).toContain('spacing.medium');
          expect(spacingCandidates).not.toContain('spacing.md');
        }
        if (revision.label === 'token-category-changed') {
          expect(spacingCandidates).not.toContain('spacing.extra');
          expect(
            session.candidateTokens({ category: 'radii' }).tokens,
          ).toContain('radii.extra');
        }
        if (revision.label === 'semantic-alias-retargeted') {
          expect(manifest.semanticTokens['colors.brand'].ref).toBe(
            'colors.accent',
          );
        }
        if (revision.label === 'recipe-axis-added') {
          expect(manifest.recipes.button.axisOrder).toEqual([
            'size',
            'enabled',
            'tone',
          ]);
          expect(declarations).toContain('readonly "tone"?: "quiet";');
        }
        if (revision.label === 'recipe-axis-removed') {
          expect(manifest.recipes.button.axisOrder).toEqual([
            'size',
            'enabled',
          ]);
          expect(declarations).not.toContain('readonly "tone"?: "quiet";');
        }
        if (revision.label === 'recipe-domain-changed') {
          expect(manifest.recipes.button.axes.size).toContain('lg');
          expect(declarations).toContain('"lg"');
        }
        if (revision.label === 'private-recipe-made-public') {
          expect(Object.keys(manifest.recipes)).toContain('secretRecipe');
          expect(javascript).toContain('secretRecipe');
          expect(declarations).toContain('secretRecipe');
        }
        if (revision.label === 'recipe-made-private') {
          expect(manifest.recipes.secretRecipe).toBeUndefined();
          expect(javascript).not.toContain('secretRecipe');
          expect(declarations).not.toContain('secretRecipe');
        }
        expect(manifest.tokens['colors.secret']).toBeUndefined();
        expect(javascript).not.toContain('colors.secret');
        expect(declarations).not.toContain('colors.secret');
        expect(css).not.toContain('colors.secret');
        if (revision.label !== 'private-recipe-made-public') {
          expect(manifestText).not.toContain('secretRecipe');
          if (revision.label === 'recipe-made-private') {
            expect(javascript).not.toContain('secretRecipe');
            expect(declarations).not.toContain('secretRecipe');
          }
        }
        mutationObservations.push({
          revision: revision.label,
          applyElapsedMs,
          fullFallback: validation.fullFallback,
          fullFallbackReason: validation.fullFallbackReason,
          artifactSetBytes: Object.values(artifactSet.artifacts).reduce(
            (sum, record) => sum + record.bytes,
            0,
          ),
        });
      }
      expect(fullFallbackCount).toBe(0);
      expect(counts.design_system_builds).toBe(revisions.length);
      expect(counts.full_fallback ?? 0).toBe(0);
      if (process.env.PMS_OUT_DIR != null) {
        fs.mkdirSync(process.env.PMS_OUT_DIR, { recursive: true });
        const report = {
          documentKind:
            'pandamstyle-phase-6-design-system-mutation-performance',
          revisionCount: revisions.length,
          designSystemBuildCount: counts.design_system_builds,
          globalFallbackCount: counts.full_fallback ?? 0,
          phaseDurationsMs: Object.fromEntries(
            Object.entries(durationsNs).map(([name, value]) => [
              name,
              value / 1e6,
            ]),
          ),
          revisions: mutationObservations,
          artifactSetBytesLastRevision:
            mutationObservations.at(-1)?.artifactSetBytes ?? 0,
          memoryBytes: process.memoryUsage().heapUsed,
        };
        fs.writeFileSync(
          path.join(process.env.PMS_OUT_DIR, 'phase-6-mutations.json'),
          `${JSON.stringify(report, null, 2)}\n`,
        );
      }
    } finally {
      session.close();
      stopCollecting();
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});
