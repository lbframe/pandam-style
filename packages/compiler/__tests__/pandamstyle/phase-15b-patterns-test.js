/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  loadCompiler,
  openProject,
  differential,
} = require('./session-helpers');
const { freshCopyOf, runBuild } = require('./pms-helpers');

jest.autoMockOff();

const SOURCE = `import { patterns, token, props, recipes, themes } from '../generated/design.pandamstyle';
export const layout = patterns.grid({columns: {base: 2, wide: 4}, gap: token('spacing.md')});
export const column = patterns.stack({gap: {base: token('spacing.sm'), wide: token('spacing.md')}, align: {base: 'stretch', hover: 'center'}});
export const row = patterns.inline({justify: 'between'});
export const centered = patterns.center({inline: true});
export const box = patterns.box({padding: token('spacing.md'), paddingInline: {wide: token('spacing.lg')}});
export const rootProps = props(layout, recipes.button(), themes.dark);
`;

function buildSource(source = SOURCE) {
  const project = freshCopyOf('valid');
  fs.writeFileSync(path.join(project, 'src/patterns.ts'), source);
  const result = runBuild(project);
  return {
    project,
    result,
    css:
      result.status === 0
        ? fs.readFileSync(path.join(project, 'generated/styles.css'), 'utf8')
        : '',
    code:
      result.status === 0
        ? fs.readFileSync(
            path.join(project, 'generated/js/src/patterns.ts'),
            'utf8',
          )
        : '',
  };
}

describe('Phase 15B constrained pattern semantics', () => {
  test('the five layouts lower into policy declarations with fixed defaults', () => {
    const { createPatternIR, token } = loadCompiler();
    expect(createPatternIR('stack').declarations).toEqual({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      justifyContent: 'flex-start',
    });
    expect(
      createPatternIR('inline', { align: 'end', justify: 'between' })
        .declarations,
    ).toEqual({
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
    });
    expect(createPatternIR('center', { inline: true }).declarations).toEqual({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    expect(
      createPatternIR('grid', { columns: 6 }).declarations.gridTemplateColumns,
    ).toBe('repeat(6, minmax(0, 1fr))');
    const padding = token('spacing.md');
    expect(createPatternIR('box', { padding }).declarations).toEqual({
      boxSizing: 'border-box',
      padding,
    });
    expect(
      createPatternIR('inline', { align: { wide: 'start' } }).declarations
        .alignItems,
    ).toEqual({ base: 'center', wide: 'flex-start' });
    expect(
      createPatternIR('grid', { columns: { wide: 3 } }).declarations
        .gridTemplateColumns,
    ).toEqual({
      base: 'repeat(1, minmax(0, 1fr))',
      wide: 'repeat(3, minmax(0, 1fr))',
    });
  });

  test('real TS extraction emits deterministic atomic CSS and runtime refs composed with recipes/themes', () => {
    const first = buildSource();
    if (first.result.status !== 0) throw new Error(first.result.stderr);
    expect(first.result.status).toBe(0);
    expect(first.css).toContain(
      'grid-template-columns:repeat(2,minmax(0,1fr))',
    );
    expect(first.css).toContain(
      'grid-template-columns:repeat(4,minmax(0,1fr))',
    );
    expect(first.css).toContain('@media (min-width: 768px)');
    expect(first.css).toContain('gap:var(--');
    expect(first.code).toContain('pandamstyle-style-ref');
    expect(first.code).not.toContain('patterns.grid(');
    expect(first.code).not.toMatch(/patterns\.(stack|inline|center|box)\(/);
    expect(first.css).toContain('flex-direction:column');
    expect(first.css).toContain('flex-direction:row');
    expect(first.css).toContain('display:inline-flex');
    expect(first.css).toContain('justify-content:space-between');
    expect(first.css).toContain('box-sizing:border-box');
    expect(first.code).not.toContain('token(');
    expect(first.code).toContain('@pandamstyle/core');
    const again = runBuild(first.project);
    expect(again.status).toBe(0);
    expect(
      fs.readFileSync(path.join(first.project, 'generated/styles.css'), 'utf8'),
    ).toBe(first.css);
  });

  test('renamed, namespace, const aliases and static token constants keep authenticated helper identity', () => {
    const { result, code, css } =
      buildSource(`import * as design from '../generated/design.pandamstyle';
const layouts = design.patterns;
const stack = layouts.stack;
const gap = design.token('spacing.sm');
const parameters = {gap, align: {base: 'start', wide: 'center'}} as const;
export const layout = stack(parameters);
export const composed = design.props(layout, design.patterns.center({inline: true}));`);
    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    expect(css).toContain('flex-direction:column');
    expect(css).toContain('display:inline-flex');
    expect(code).not.toContain('stack(parameters)');
  });

  test('author helper composes recipe declarations through the same engine and tokens', () => {
    const c = loadCompiler();
    const gap = c.token('spacing.md');
    const ds = c.buildDesignSystem({
      systemId: 'pattern-recipe',
      tokens: { spacing: { md: { value: '16px', visibility: 'public' } } },
      recipes: {
        panel: {
          visibility: 'public',
          base: c.patternStyles('stack', { gap }),
          variants: {
            align: { center: c.patternStyles('stack', { align: 'center' }) },
          },
        },
      },
    });
    expect(ds.renderCss()).toContain('flex-direction:column');
    expect(ds.renderCss()).toContain('gap:var(--');
    expect(
      ds.props(ds.recipes.panel({ align: 'center' })).className,
    ).toBeTruthy();
  });

  test('pattern spacing uses the existing themed variable identities', () => {
    const c = loadCompiler();
    const ds = c.buildDesignSystem({
      systemId: 'pattern-spacing-theme',
      tokens: { spacing: { md: { value: '16px', visibility: 'public' } } },
      themes: { compact: { tokens: { spacing: { md: { value: '8px' } } } } },
    });
    const ref = ds.create({
      layout: c.patternStyles('stack', { gap: c.token('spacing.md') }),
    }).compiled.layout;
    const attributes = ds.props(ref, ds.themes.compact);
    expect(attributes.className).toBeTruthy();
    const variable = ds.varsByToken['spacing.md'];
    expect(ds.renderCss()).toContain(`gap:${variable}`);
    expect(ds.renderCss()).toContain(':16px;');
    expect(ds.renderCss()).toContain(':8px;');
  });

  test('patterns have one canonical manifest/repair vocabulary and runtime stubs fail loudly', () => {
    const c = loadCompiler();
    const ds = c.buildDesignSystem({ systemId: 'pattern-catalog' });
    expect(ds.manifest.capabilities.patterns).toBe(true);
    expect(Object.keys(ds.manifest.patterns)).toEqual(c.PATTERN_IDS);
    expect(ds.manifest.patterns.grid.parameters.columns.values).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(ds.manifest.patterns.stack.parameters.gap).toEqual({
      responsive: true,
      category: 'spacing',
      token: true,
    });
    expect(
      c.repairDomainOf(ds.snapshot, { kind: 'pattern', patternId: 'grid' }),
    ).toBe(ds.manifest.patterns.grid);
    const module = c.generateDesignSystemModule({ designSystem: ds });
    expect(module).toContain('PMS_UNCOMPILED_PATTERN');
    const stubs = module.slice(module.indexOf('export const patterns'));
    expect(stubs).not.toContain('gridTemplateColumns');
    class SelectionError extends Error {
      constructor({ message, code }) {
        super(message);
        this.code = code;
      }
    }
    const runtime = vm.runInNewContext(
      `${stubs.replace('export const', 'const')} patterns;`,
      { PmsSelectionError: SelectionError },
    );
    expect(() => runtime.grid({ columns: 2 })).toThrow('must be transformed');
  });

  test('grid policy admits precisely the six owned forms and rejects arbitrary templates', () => {
    const c = loadCompiler();
    const ds = c.buildDesignSystem({ systemId: 'finite-grid' });
    for (let columns = 1; columns <= 6; columns++) {
      expect(
        ds.create({ grid: c.patternStyles('grid', { columns }) }).compiled.grid,
      ).toBeDefined();
    }
    expect(() =>
      ds.create({ grid: { gridTemplateColumns: '1fr 2fr' } }),
    ).toThrow('PMS_FORBIDDEN_VALUE');
  });
});

describe('Phase 15B actionable pattern diagnostics', () => {
  test.each([
    ['patterns.masonry({})', 'PMS_UNKNOWN_PATTERN'],
    [
      "patterns.stack({color: token('colors.text.primary')})",
      'PMS_INVALID_PATTERN_PARAMETER',
    ],
    ["patterns.stack({gap: '17px'})", 'PMS_INVALID_PATTERN_PARAMETER'],
    [
      "patterns.stack({gap: token('colors.text.primary')})",
      'PMS_INVALID_TOKEN_CATEGORY',
    ],
    ["patterns.stack({gap: token('spacing.missing')})", 'PMS_UNKNOWN_TOKEN'],
    ['patterns.grid({columns: 7})', 'PMS_INVALID_PATTERN_PARAMETER'],
    ['patterns.grid({columns: 1.5})', 'PMS_INVALID_PATTERN_PARAMETER'],
    [
      "patterns.grid({columns: 'repeat(2, 1fr)'})",
      'PMS_INVALID_PATTERN_PARAMETER',
    ],
    ["patterns.stack({align: 'middle'})", 'PMS_INVALID_PATTERN_PARAMETER'],
    [
      "patterns.stack({gap: {unknown: token('spacing.sm')}})",
      'PMS_UNKNOWN_CONDITION',
    ],
    ['patterns.stack({align: {}})', 'PMS_INVALID_PATTERN_PARAMETER'],
    [
      "patterns.stack({align: {base: 'start', default: 'center'}})",
      'PMS_INVALID_PATTERN_PARAMETER',
    ],
    [
      'patterns.center({inline: {base: true}})',
      'PMS_INVALID_PATTERN_PARAMETER',
    ],
    ['patterns.stack({}, {})', 'PMS_INVALID_PATTERN_PARAMETER'],
    ['patterns.stack(null)', 'PMS_INVALID_PATTERN_PARAMETER'],
    ['patterns.grid({columns: count})', 'PMS_NON_STATIC_VALUE'],
    ['patterns[count]({})', 'PMS_NON_STATIC_VALUE'],
  ])('%s fails with %s and a source location', (expression, code) => {
    const { result } =
      buildSource(`import {patterns, token} from '../generated/design.pandamstyle';
export function layout(count) { return ${expression}; }`);
    expect(result.status).toBe(1);
    expect(result.codes).toContain(code);
    const diagnostic = result.diagnostics.find((d) => d.code === code);
    expect(diagnostic.location.file).toMatch(/patterns.ts$/);
    expect(diagnostic.location.line).toBe(2);
    expect(diagnostic.message.length).toBeGreaterThan(30);
  });

  test('shadowed helpers cannot obtain composition provenance', () => {
    const { result } =
      buildSource(`import {patterns, props} from '../generated/design.pandamstyle';
function layout(patterns) { return props(patterns.stack({})); }`);
    expect(result.codes).toContain('PMS_UNVERIFIED_PROPS_SOURCE');
  });

  test.each([
    'parameters.columns = 4;',
    'delete parameters.columns;',
    'Object.assign(parameters, {columns: 4});',
    'const alias = parameters; alias.columns = 4;',
    'mutate(parameters);',
  ])('mutable parameter records are rejected: %s', (mutation) => {
    const { result } =
      buildSource(`import {patterns} from '../generated/design.pandamstyle';
const parameters = {columns: 2}; ${mutation}
export const layout = patterns.grid(parameters);`);
    expect(result.codes).toContain('PMS_NON_STATIC_VALUE');
  });

  test('new diagnostic codes provide structured repair targets', () => {
    const { result } =
      buildSource(`import {patterns} from '../generated/design.pandamstyle';
export const layout = patterns.grid({columns: 9});`);
    const diag = result.diagnostics.find(
      (d) => d.code === 'PMS_INVALID_PATTERN_PARAMETER',
    );
    expect(diag.repair.kind).toBe('use-pattern-parameter-domain');
    expect(diag.repair.applicable).toBe(true);
    expect(diag.repair.target).toEqual({
      patternId: 'grid',
      parameter: 'columns',
    });
    expect(diag.expected.domain).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('private spacing tokens are rejected in consumer patterns', () => {
    const h = openProject('valid');
    try {
      fs.writeFileSync(
        h.definitionPath,
        fs
          .readFileSync(h.definitionPath, 'utf8')
          .replace(
            "md: { value: '16px', visibility: 'public' }",
            "md: { value: '16px', visibility: 'private' }",
          ),
      );
      fs.writeFileSync(
        h.src('src/patterns.ts'),
        "import {patterns, token} from '../generated/design.pandamstyle'; export const layout = patterns.stack({gap: token('spacing.md')});",
      );
      const validation = h.revise({ definition: h.reloadDefinition() });
      expect(validation.ok).toBe(false);
      expect(validation.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'PMS_TOKEN_NOT_PUBLIC',
          context: expect.objectContaining({ tokenId: 'spacing.md' }),
        }),
      );
    } finally {
      h.session.close();
    }
  });

  test('cyclic constants are rejected with a static-input diagnostic', () => {
    const { result } =
      buildSource(`import {patterns} from '../generated/design.pandamstyle';
const a = b; const b = a; export const layout = patterns.grid(a);`);
    expect(result.codes).toContain('PMS_NON_STATIC_VALUE');
    expect(result.stderr).not.toContain('Maximum call stack');
  });
});

describe('Phase 15B incremental invalidation', () => {
  test('pattern edits, diagnostics, repair and removal equal fresh aggregation', () => {
    const h = openProject('valid', {
      publishVariant: 'session_incremental_publish_css',
    });
    const file = h.src('src/patterns.ts');
    const source = (columns) =>
      `import {patterns} from '../generated/design.pandamstyle'; export const layout = patterns.grid({columns: ${columns}});`;
    try {
      fs.writeFileSync(file, source(6));
      let step = differential(h, 'add pattern', { added: [file] });
      expect(step.findings).toEqual([]);
      expect(step.validation.ok).toBe(true);
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).toContain('repeat(6,minmax(0,1fr))');
      fs.writeFileSync(file, source(5));
      step = differential(h, 'edit pattern', { changed: [file] });
      expect(step.findings).toEqual([]);
      const css = fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
      expect(css).toContain('repeat(5,minmax(0,1fr))');
      expect(css).not.toContain('repeat(6,minmax(0,1fr))');
      fs.writeFileSync(file, source(9));
      step = differential(h, 'invalid pattern', { changed: [file] });
      expect(step.findings).toEqual([]);
      expect(step.validation.ok).toBe(false);
      fs.writeFileSync(file, source(4));
      step = differential(h, 'repair pattern', { changed: [file] });
      expect(step.findings).toEqual([]);
      expect(step.validation.ok).toBe(true);
      fs.unlinkSync(file);
      step = differential(h, 'remove pattern', { deleted: [file] });
      expect(step.findings).toEqual([]);
      expect(
        fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8'),
      ).not.toContain('repeat(4,minmax(0,1fr))');
    } finally {
      h.session.close();
    }
  });
});
