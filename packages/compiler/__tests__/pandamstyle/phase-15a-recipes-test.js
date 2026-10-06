/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadCompiler,
  openExistingProject,
  differential,
} = require('./session-helpers');
const { buildDesignSystem } = loadCompiler();
const { toRecipeSpec } = require('../../src/artifacts/javascript/refs');
const { defineRecipeSelector } = require('../../../core/src/index.js');
const { freshCopyOf, sharedDefinitionOf } = require('./pms-helpers');
const recipe = require('./fixtures/phase-15a/recipe.json');

function definition(config = recipe) {
  return { systemId: 'slots-test', recipes: { card: config } };
}

function compare(h, label, changes = {}) {
  const result = differential(h, label, changes);
  expect(result.findings).toEqual([]);
  return result;
}

describe('Phase 15A: recipe compiler domains', () => {
  test('sparse slots compile to complete finite refs; compounds are linear and ordered', () => {
    const ds = buildDesignSystem(definition());
    const spec = toRecipeSpec(ds.recipes.card, ds.registry.systemId);
    expect(spec.slotOrder).toEqual(['root', 'label']);
    expect(spec.compounds.map(({ when }) => when)).toEqual([
      { tone: ['quiet'], size: ['sm', 'md'] },
      { flag: ['false'] },
    ]);
    expect(Object.keys(spec.branches.size.sm)).toEqual(['root', 'label']);
    expect(spec.branches.size.sm.label.entries).toEqual([]);
    expect(
      ds.snapshot.tooling.candidateDomains.recipes.byRecipe.card.slots,
    ).toEqual(['root', 'label']);
    expect(ds.manifest.recipes.card.slots).toEqual(['root', 'label']);
    expect(ds.manifest.recipes.card.compoundVariants).toEqual(
      spec.compounds.map(({ when }) => ({ when })),
    );
    expect(ds.manifest.capabilities).toMatchObject({
      slots: true,
      compoundVariants: true,
    });
    const selector = defineRecipeSelector(spec);
    const defaults = selector();
    expect(ds.props(defaults.root).className).toBe(
      ds.props(selector({ tone: 'quiet', size: 'md' }).root).className,
    );
    const selected = selector({ flag: false });
    expect(selected.root.entries).toEqual([
      ...spec.base.root.entries,
      ...spec.branches.tone.quiet.root.entries,
      ...spec.branches.size.md.root.entries,
      ...spec.branches.flag.false.root.entries,
      ...spec.compounds[0].style.root.entries,
      ...spec.compounds[1].style.root.entries,
    ]);
    expect(selected.label.entries).toEqual([
      ...spec.base.label.entries,
      ...spec.branches.tone.quiet.label.entries,
      ...spec.compounds[1].style.label.entries,
    ]);
    expect(JSON.stringify(spec)).not.toMatch(/"(?:css|\$\$css)"/);
    expect(
      toRecipeSpec(
        buildDesignSystem(definition()).recipes.card,
        ds.registry.systemId,
      ),
    ).toEqual(spec);
    const reordered = structuredClone(recipe);
    reordered.compoundVariants[0] = {
      size: ['md', 'sm'],
      tone: ['quiet'],
      css: reordered.compoundVariants[0].css,
    };
    const equivalent = buildDesignSystem(definition(reordered));
    expect(toRecipeSpec(equivalent.recipes.card, ds.registry.systemId)).toEqual(
      spec,
    );
    expect(equivalent.registry.registryDigest).toBe(ds.registry.registryDigest);
  });
  test('ordinary recipes support compounds without changing their StyleRef result', () => {
    const ds = buildDesignSystem(
      definition({
        base: { display: 'block' },
        variants: { tone: { quiet: { opacity: 0.5 }, loud: { opacity: 1 } } },
        compoundVariants: [{ tone: 'quiet', css: { display: 'flex' } }],
        defaultVariants: { tone: 'quiet' },
      }),
    );
    expect(ds.recipes.card().kind).toBe('pandamstyle-style-ref');
    expect(ds.renderCss()).toContain('display:flex');
  });

  test('a condition definition named __proto__ cannot pollute Object.prototype', () => {
    const existingDisplay = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'display',
    );
    try {
      expect(() =>
        buildDesignSystem({
          systemId: 'condition-prototype-safety',
          conditions: { poison: '__proto__' },
          recipes: {
            card: {
              visibility: 'public',
              base: { _poison: { display: 'block' } },
            },
          },
        }),
      ).toThrow();

      expect(Object.hasOwn(Object.prototype, 'display')).toBe(false);
    } finally {
      if (existingDisplay === undefined) {
        // eslint-disable-next-line no-extend-native -- restore the global if this regression fails.
        delete Object.prototype.display;
      } else {
        // eslint-disable-next-line no-extend-native -- restore the global if this regression fails.
        Object.defineProperty(Object.prototype, 'display', existingDisplay);
      }
    }
  });

  test('slot compounds preserve private token authority and independent condition conflicts', () => {
    const config = structuredClone(recipe);
    config.base.root.color = loadCompiler().token('colors.ink');
    config.compoundVariants[1].css.root._hover = {
      color: loadCompiler().token('colors.paper'),
    };
    const ds = buildDesignSystem({
      ...definition(config),
      tokens: {
        colors: {
          ink: { value: '#112233', visibility: 'private' },
          paper: { value: '#ffffff', visibility: 'private' },
        },
      },
      conditions: { hover: ':hover' },
    });
    const selected = ds.recipes.card({ flag: false });
    const classes = ds.props(selected.root).className.split(' ');
    const colorRules = ds
      .renderCss()
      .split('\n')
      .filter((line) => line.includes('color:var(--'));
    expect(colorRules).toHaveLength(2);
    expect(
      colorRules.every((rule) => classes.includes(rule.match(/\.([\w-]+)/)[1])),
    ).toBe(true);
    expect(ds.renderCss()).toContain(':hover');
    expect(ds.manifest.tokens).toEqual({});
  });
  test('a slot recipe with no variants still returns every explicitly declared slot', () => {
    const ds = buildDesignSystem(
      definition({
        slots: ['root', 'label'],
        base: { root: { display: 'block' } },
      }),
    );
    expect(Object.keys(ds.recipes.card())).toEqual(['root', 'label']);
    expect(ds.recipes.card().label.entries).toEqual([]);
  });
  test('sparse slot names do not inherit declaration objects', () => {
    const ds = buildDesignSystem(
      definition({
        slots: ['root', 'toString'],
        base: { root: { display: 'block' } },
      }),
    );
    expect(ds.recipes.card().toString.entries).toEqual([]);
  });
  test.each([
    ['empty-slots', { ...recipe, slots: [] }, 'PMS_INVALID_RECIPE_SLOT'],
    [
      'sparse-slot-domain',
      { ...recipe, slots: Array(1) },
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'duplicate-slots',
      { ...recipe, slots: ['root', 'root'] },
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'base-slot',
      { ...recipe, base: { absent: {} } },
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'variant-slot',
      {
        ...recipe,
        variants: { tone: { quiet: { absent: {} } } },
        defaultVariants: {},
      },
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'compound-slot',
      { ...recipe, compoundVariants: [{ tone: 'quiet', css: { absent: {} } }] },
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'compound-axis',
      { ...recipe, compoundVariants: [{ absent: 'quiet', css: {} }] },
      'PMS_INVALID_VARIANT_KEY',
    ],
    [
      'compound-value',
      { ...recipe, compoundVariants: [{ tone: 'absent', css: {} }] },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'compound-empty-domain',
      { ...recipe, compoundVariants: [{ tone: [], css: {} }] },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'compound-sparse-domain',
      { ...recipe, compoundVariants: [{ tone: Array(1), css: {} }] },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'compound-null',
      { ...recipe, compoundVariants: [{ tone: null, css: {} }] },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'compound-nonfinite',
      { ...recipe, compoundVariants: [{ tone: Infinity, css: {} }] },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'default-axis',
      { ...recipe, defaultVariants: { absent: 'md' } },
      'PMS_INVALID_VARIANT_KEY',
    ],
    [
      'default-value',
      { ...recipe, defaultVariants: { size: 'absent' } },
      'PMS_INVALID_VARIANT_VALUE',
    ],
    [
      'compound-no-css',
      { ...recipe, compoundVariants: [{ tone: 'quiet' }] },
      'PMS_INVALID_RECIPE',
    ],
    [
      'compound-empty-predicate',
      { ...recipe, compoundVariants: [{ css: {} }] },
      'PMS_INVALID_RECIPE',
    ],
    [
      'ambiguous',
      {
        ...recipe,
        compoundVariants: [
          { tone: 'quiet', size: ['md', 'sm'], css: {} },
          { size: ['sm', 'md'], tone: ['quiet'], css: {} },
        ],
      },
      'PMS_AMBIGUOUS_RECIPE_COMPOUND',
    ],
  ])('%s has a structured author diagnostic', (_label, config, code) => {
    try {
      buildDesignSystem(definition(config));
      throw new Error('expected rejection');
    } catch (error) {
      expect(error.diagnostics[0]).toMatchObject({
        code,
        phase: 'registry',
        source: 'design-system:recipes.card',
        context: { recipeId: 'card' },
        autofix: null,
      });
    }
  });
});

function fixture(
  config = recipe,
  source = 'export const result = props(recipes.card({flag:false}).root);',
) {
  const project = freshCopyOf('valid');
  const sourceDir = path.join(project, 'src');
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(
    sharedDefinitionOf(project),
    `export default ${JSON.stringify(definition(config))};\n`,
  );
  fs.writeFileSync(
    path.join(sourceDir, 'page.js'),
    `import { recipes, props } from '../generated/design.pandamstyle';\n${source}\n`,
  );
  return project;
}

describe('Phase 15A: compiler-visible slots and revisions', () => {
  test.each([
    [
      'literal named slot',
      'export const result = props(recipes.card({flag:false}).root);',
    ],
    [
      'static bracket slot and local alias',
      "const slots = recipes.card({flag:false}); export const result = props(slots['label']);",
    ],
    [
      'runtime bounded selector',
      'export function result(flag) { const slots = recipes.card({flag}); return props(slots.root); }',
    ],
  ])('%s compiles through the real project service', (_label, source) => {
    const h = openExistingProject(fixture(recipe, source), {
      publishVariant: 'session_incremental_publish_css',
    });
    try {
      const result = compare(h, 'initial');
      expect(result.validation.ok).toBe(true);
      const output = fs.readFileSync(
        path.join(h.outDir, 'js/src/page.js'),
        'utf8',
      );
      if (source.includes('{flag}')) expect(output).toMatch(/recipes\.card\(/);
      else expect(output).not.toMatch(/recipes\.card\(/);
    } finally {
      h.session.close();
    }
  });
  test.each([
    [
      'unknown direct slot',
      'export const result = recipes.card().absent;',
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'unknown optional slot',
      'export const result = recipes.card()?.absent;',
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'unknown local slot',
      'const slots = recipes.card(); export const result = props(slots.absent);',
      'PMS_INVALID_RECIPE_SLOT',
    ],
    [
      'dynamic slot',
      'export function result(slot) { return props(recipes.card()[slot]); }',
      'PMS_NON_STATIC_VALUE',
    ],
    [
      'container composition',
      'export const result = props(recipes.card());',
      'PMS_UNVERIFIED_PROPS_SOURCE',
    ],
    [
      'invalid axis',
      "export const result = props(recipes.card({absent:'md'}).root);",
      'PMS_INVALID_VARIANT_KEY',
    ],
    [
      'invalid value',
      "export const result = props(recipes.card({size:'lg'}).root);",
      'PMS_INVALID_VARIANT_VALUE',
    ],
  ])('%s fails at the source boundary', (_label, source, code) => {
    const h = openExistingProject(fixture(recipe, source));
    try {
      const result = h.revise();
      expect(result.ok).toBe(false);
      expect(result.diagnostics.map((d) => d.code)).toContain(code);
      expect(
        result.diagnostics.find((d) => d.code === code).location.file,
      ).toMatch(/src\/page.js$/);
    } finally {
      h.session.close();
    }
  });
  test('compound edit, compound removal and slot removal equal fresh publication without stale CSS', () => {
    const h = openExistingProject(fixture(), {
      publishVariant: 'session_incremental_publish_css',
    });
    const save = (config) => {
      fs.writeFileSync(
        h.definitionPath,
        `export default ${JSON.stringify(definition(config))};\n`,
      );
      return { definition: h.reloadDefinition() };
    };
    try {
      expect(compare(h, 'initial').validation.ok).toBe(true);
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).toContain('display:grid');
      const edited = structuredClone(recipe);
      edited.compoundVariants[1].css.root.display = 'none';
      expect(compare(h, 'compound edited', save(edited)).validation.ok).toBe(
        true,
      );
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).not.toContain('display:grid');
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).toContain('display:none');
      edited.compoundVariants = [];
      expect(compare(h, 'compounds removed', save(edited)).validation.ok).toBe(
        true,
      );
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).not.toContain('display:none');
      edited.slots = ['root'];
      delete edited.base.label;
      delete edited.variants.tone.quiet.label;
      delete edited.variants.tone.loud.label;
      expect(compare(h, 'slot removed', save(edited)).validation.ok).toBe(true);
      expect(
        JSON.parse(
          fs.readFileSync(path.join(h.outDir, 'manifest.json'), 'utf8'),
        ).recipes.card.slots,
      ).toEqual(['root']);
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).not.toContain('position:relative');
    } finally {
      h.session.close();
    }
  });
});

test('Phase 15A: a real Vite host publishes slot and compound runtime artifacts', () => {
  const root = path.resolve(__dirname, '../../../..');
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase15a-vite-'));
  try {
    fs.cpSync(path.join(root, 'examples/pilots/vite-react'), app, {
      recursive: true,
    });
    fs.rmSync(path.join(app, 'node_modules'), { recursive: true, force: true });
    fs.mkdirSync(path.join(app, 'node_modules'));
    for (const dependency of [
      'vite',
      '@vitejs',
      'react',
      'react-dom',
      '@pandamstyle',
    ])
      fs.symlinkSync(
        path.join(root, 'node_modules', dependency),
        path.join(app, 'node_modules', dependency),
        'dir',
      );
    fs.writeFileSync(
      path.join(app, 'design.pandamstyle.config.js'),
      `export default ${JSON.stringify(definition())};\n`,
    );
    fs.writeFileSync(
      path.join(app, 'src/pages/App.jsx'),
      "import { recipes, props } from './bridge.js';\nexport function App({flag=false}={}) { const slots=recipes.card({flag}); return <section {...props(slots.root)}><span {...props(slots.label)}>Slot recipe</span></section>; }\n",
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        'build',
        '--logLevel',
        'error',
      ],
      {
        cwd: app,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      },
    );
    expect({ status: result.status, errors: result.stderr }).toEqual({
      status: 0,
      errors: '',
    });
    const canonical = fs.readFileSync(
      path.join(app, '.pandamstyle/styles.css'),
      'utf8',
    );
    expect(
      fs.readFileSync(path.join(app, 'dist/pandamstyle/styles.css'), 'utf8'),
    ).toBe(canonical);
    expect(canonical).toContain('display:grid');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(app, '.pandamstyle/manifest.json'), 'utf8'),
    );
    expect(manifest.recipes.card.slots).toEqual(['root', 'label']);
    expect(manifest.recipes.card.compoundVariants).toHaveLength(2);
    const generated = fs.readFileSync(
      path.join(app, '.pandamstyle/design.pandamstyle.js'),
      'utf8',
    );
    expect(generated).toContain('"slotOrder"');
    expect(generated).toContain('"compounds"');
    expect(
      fs.readFileSync(
        path.join(app, '.pandamstyle/js/src/pages/App.jsx'),
        'utf8',
      ),
    ).toMatch(/recipes\.card\(/);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
}, 30000);
