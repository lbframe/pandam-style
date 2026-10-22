/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) PR A: finite numeric domains on the consumer side.
 *
 *   - a refused literal carries its reason (null-value, css-wide-keyword,
 *     non-finite, non-canonical, number-not-length, precision,
 *     not-in-domain) and, when it is merely misspelt, the in-domain spelling
 *     first among the admitted values;
 *   - the outcome and reason are the same in every authoring context and for
 *     both roles;
 *   - approved author literals (lengths, CSS-wide keywords) are admitted and
 *     typed exactly;
 *   - generated types and compiler acceptance agree on every probe of every
 *     admitted row (tsc with @ts-expect-error on each refused probe).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const compiler = loadCompiler();
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const TOKENS = {
  sizes: { sm: { value: '8rem', visibility: 'public' } },
  spacing: { sm: { value: '8px', visibility: 'public' } },
};
const build = (propertyDomains) =>
  compiler.buildDesignSystem({
    systemId: 'ce022-numeric',
    conditions: { hover: ':hover', wide: '@media (min-width: 40rem)' },
    tokens: TOKENS,
    ...(propertyDomains == null ? {} : { propertyDomains }),
  });

function refusalsOf(ds, namespaces, role = 'consumer') {
  try {
    compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces,
      role,
      allowPrivateTokens: role === 'system',
    });
    return [];
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return error.diagnostics;
  }
}

const one = (ds, property, value) =>
  refusalsOf(ds, { n: { [property]: value } });

describe('the reason of a refused literal', () => {
  const ds = build();
  test.each([
    ['width', null, 'null-value', undefined],
    ['width', undefined, 'null-value', undefined],
    ['width', 'inherit', 'css-wide-keyword', undefined],
    ['width', 'REVERT-LAYER', 'css-wide-keyword', undefined],
    ['opacity', NaN, 'non-finite', undefined],
    ['flexGrow', Infinity, 'non-finite', undefined],
    ['width', ' 100%', 'non-canonical', '100%'],
    ['width', 'FIT-CONTENT', 'non-canonical', 'fit-content'],
    ['width', '16PX', 'non-canonical', '16px'],
    ['width', '16.0px', 'non-canonical', '16px'],
    ['minWidth', '0px', 'non-canonical', '0'],
    ['opacity', '0.5', 'non-canonical', 0.5],
    ['display', 'Flex', 'non-canonical', 'flex'],
    ['width', 16, 'number-not-length', undefined],
    ['height', 20, 'number-not-length', undefined],
    ['opacity', 0.33333, 'precision', undefined],
    ['opacity', 0.33, 'not-in-domain', undefined],
    ['flexGrow', 1.5, 'not-in-domain', undefined],
    ['flex', 1e308, 'not-in-domain', undefined],
    ['flex', 13, 'not-in-domain', undefined],
    ['width', '18px', 'not-in-domain', undefined],
    ['width', 'calc(100% - 1px)', 'not-in-domain', undefined],
    ['display', 'table', 'not-in-domain', undefined],
  ])('%s = %j: %s', (property, value, reason, canonical) => {
    const [d, ...rest] = one(ds, property, value);
    expect(rest).toEqual([]);
    expect(d.code).toBe('PMS_FORBIDDEN_VALUE');
    expect(d.context.reason).toBe(reason);
    if (canonical === undefined) {
      expect(d.context).not.toHaveProperty('canonical');
    } else {
      expect(d.context.canonical).toBe(canonical);
      // The in-domain spelling is the first admitted value: the repair.
      expect(d.context.admitted[0]).toBe(canonical);
      expect(one(ds, property, canonical)).toEqual([]);
    }
  });

  test('a token-only row reports the reason of a raw literal too', () => {
    const [d] = one(ds, 'color', 'red');
    expect(d.rule).toBe('category-strict');
    expect(d.context.reason).toBe('not-in-domain');
  });
});

describe('the same outcome and reason in every context and role', () => {
  const ds = build();
  const PROBES = [
    0.33,
    0.33333,
    '0.5',
    16,
    '16PX',
    'inherit',
    null,
    NaN,
    1e308,
    -1,
    0,
    '0',
    'x',
  ];
  const contexts = (property, value) => [
    ['base', { n: { [property]: value } }],
    ['condition map', { n: { [property]: { base: value } } }],
    ['condition map entry', { n: { [property]: { hover: value } } }],
    ['named block', { n: { _hover: { [property]: value } } }],
    ['engine block', { n: { ':hover': { [property]: value } } }],
    ['at-rule entry', { n: { [property]: { wide: value } } }],
  ];
  const ROWS = [
    'opacity',
    'flex',
    'flexGrow',
    'width',
    'minWidth',
    'display',
    'paddingTop',
    'marginTop',
  ];
  test.each(ROWS.map((r) => [r]))('%s', (property) => {
    for (const value of PROBES) {
      const reference = one(ds, property, value).map((d) => [
        d.code,
        d.rule,
        d.context.reason ?? null,
      ]);
      for (const role of ['consumer', 'system']) {
        for (const [where, namespaces] of contexts(property, value)) {
          // A `null` inside a condition map is skipped by condition
          // dispatch as in Alpha 1; the base form is the reference.
          if (value == null && where !== 'base') continue;
          const got = refusalsOf(ds, namespaces, role).map((d) => [
            d.code,
            d.rule,
            d.context.reason ?? null,
          ]);
          expect({ property, value, where, role, got }).toEqual({
            property,
            value,
            where,
            role,
            got: reference,
          });
        }
      }
    }
  });
});

describe('approved author literals', () => {
  const ds = build({
    width: {
      tokens: ['sizes'],
      values: ['18px', '46ch', '62ch', 'auto', 'inherit', 0],
    },
    opacity: { values: [0, 0.33, 1] },
    flexGrow: { values: [0, 1, 1.5] },
    marginTop: { tokens: ['spacing'], values: ['-4px', 'auto'] },
  });

  test.each([
    ['width', '18px'],
    ['width', '46ch'],
    ['width', 'inherit'],
    ['width', 0],
    ['width', '0'],
    ['opacity', 0.33],
    ['flexGrow', 1.5],
    ['marginTop', '-4px'],
  ])('%s = %j is admitted', (property, value) => {
    expect(one(ds, property, value)).toEqual([]);
  });

  test.each([
    ['width', '100%', 'not-in-domain'],
    ['width', 'initial', 'css-wide-keyword'],
    ['opacity', 0.5, 'not-in-domain'],
    ['marginTop', '-4.0px', 'non-canonical'],
  ])('%s = %j is refused (%s)', (property, value, reason) => {
    const [d] = one(ds, property, value);
    expect(d.context).toMatchObject({ reason, origin: 'approved' });
  });

  test('the approved literal reaches CSS as written', () => {
    const out = compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: { n: { width: '46ch', opacity: 0.33, flexGrow: 1.5 } },
      role: 'consumer',
    });
    const css = compiler.renderCss(out.injected);
    expect(css).toContain('width:46ch');
    expect(css).toMatch(/opacity:\.33[;}]/);
    expect(css).toMatch(/flex-grow:1\.5[;}]/);
  });

  test('the manifest and repair domain list the approved literals', () => {
    const entry = ds.snapshot.tooling.manifest.properties.byProperty.width;
    expect(entry).toEqual({
      values: ['18px', '46ch', '62ch', 'auto', 'inherit', '0'],
      tokens: ['sizes'],
      origin: 'approved',
    });
  });
});

// ---------------------------------------------------------------------------
// Generated types agree with compiler acceptance on every probe.

describe('generated types agree with the compiler', () => {
  const tsLiteral = (value) => {
    if (value === null) return 'null';
    if (Object.is(value, -0)) return '-0';
    if (typeof value === 'number') {
      return Number.isNaN(value) ? 'NaN' : String(value);
    }
    return JSON.stringify(value);
  };
  const GENERIC = [
    'x',
    '',
    '18px',
    '18.0px',
    ' 100%',
    '100%',
    'AUTO',
    'auto',
    'none',
    'inherit',
    'revert-layer',
    16,
    0,
    -0,
    '0',
    '0px',
    0.33,
    0.333333,
    0.5,
    '0.5',
    1,
    1.5,
    2,
    13,
    -1,
    1e308,
    NaN,
    null,
  ];

  test.each([
    ['without overrides', undefined],
    [
      'with approved literals',
      {
        width: { values: ['18px', 'inherit', 0, 'auto'] },
        opacity: { values: [0, 0.33, 1] },
        flexGrow: { values: [0, 1.5] },
        display: { values: ['flex', 'inline-flex', 'grid', 'none', 'inherit'] },
      },
    ],
  ])('%s', (_, propertyDomains) => {
    const ds = build(propertyDomains);
    const rows = Object.values(ds.snapshot.properties.descriptors).filter(
      (row) => row.domain != null,
    );
    const lines = [];
    let accepted = 0;
    let refused = 0;
    for (const row of rows) {
      const probes = new Set([...row.domain.values, ...GENERIC]);
      for (const value of probes) {
        const ok = one(ds, row.key, value).length === 0;
        if (ok) accepted += 1;
        else refused += 1;
        if (!ok) lines.push('// @ts-expect-error refused by the compiler');
        lines.push(`create({ a: { ${row.key}: ${tsLiteral(value)} } });`);
      }
    }
    expect(accepted).toBeGreaterThan(rows.length);
    expect(refused).toBeGreaterThan(rows.length);
    expect(
      typecheck(compiler.generateDesignSystemDeclarations(ds.snapshot), lines),
    ).toBe('');
  });
});

function typecheck(declarations, lines) {
  const outputRoot = path.join(REPO_ROOT, 'out-pandamstyle');
  fs.mkdirSync(outputRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(outputRoot, 'ce022-types-'));
  try {
    fs.writeFileSync(path.join(root, 'design.pandamstyle.d.ts'), declarations);
    const probe = path.join(root, 'probe.ts');
    fs.writeFileSync(
      probe,
      ["import { create } from './design.pandamstyle';", ...lines, ''].join(
        '\n',
      ),
    );
    const result = spawnSync(
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
        probe,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return `${result.stdout}${result.stderr}`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
