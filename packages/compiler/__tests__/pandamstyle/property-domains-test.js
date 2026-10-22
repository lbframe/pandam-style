/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-02.1 (#46), project property domains (`propertyDomains`):
 *
 *   - the schema is closed author data: every refused class has its own
 *     PMS_INVALID_PROPERTY_DOMAIN rule, and nothing is partially applied;
 *   - an override is the WHOLE effective domain: every branch it does not
 *     restate is disabled for acceptance, types, manifest and candidates
 *     (enumerated over every row and every subset of its branch kinds);
 *   - mixed, narrowed and unauthorized-consumer fixtures through real page
 *     and recipe source and the Project Service, with generated types checked
 *     by tsc;
 *   - the `property-domains` incremental unit, against the fresh oracle;
 *   - the target-candidate memo recomputes on a domain change and hits on an
 *     unchanged revision.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  differential,
  loadCompiler,
  openProject,
} = require('./session-helpers');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const compiler = loadCompiler();

const CATEGORIES = [
  'colors',
  'spacing',
  'radii',
  'fontFamilies',
  'fontSizes',
  'fontWeights',
  'lineHeights',
  'letterSpacings',
  'shadows',
  'durations',
  'easings',
  'sizes',
];
const TOKENS = Object.fromEntries(
  CATEGORIES.map((category) => [
    category,
    {
      a: { value: '1px', visibility: 'public' },
      p: { value: '2px', visibility: 'private' },
    },
  ]),
);

const build = (propertyDomains, extra = {}) =>
  compiler.buildDesignSystem({
    systemId: 'ce021-domains',
    tokens: TOKENS,
    ...(propertyDomains === undefined ? {} : { propertyDomains }),
    ...extra,
  });

function refusal(propertyDomains, extra = {}) {
  try {
    build(propertyDomains, extra);
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return error.diagnostics;
  }
  return null;
}

function outcome(ds, property, value, role = 'consumer') {
  try {
    compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: { n: { [property]: value } },
      role,
      allowPrivateTokens: role === 'system',
    });
    return null;
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return error.diagnostics.map((d) => [d.code, d.rule]);
  }
}

const admittedRows = compiler
  .descriptorKeys()
  .map((key) => compiler.descriptorOf(key))
  .filter((d) => d.default != null);

// The record a generated declaration gives one PropertyDomains member.
function declarationMember(declarations, member) {
  const start = declarations.indexOf('type PropertyDomains = {');
  const text = declarations.slice(start);
  if (member === 'ranges') {
    return /\n {2}ranges: ([^;]*);/.exec(text)[1];
  }
  const open = text.indexOf(`  ${member}: `);
  let depth = 0;
  for (let i = text.indexOf('{', open); i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(open, i + 1);
  }
  throw new Error(`no ${member} record`);
}

// ---------------------------------------------------------------------------

describe('the propertyDomains schema', () => {
  const CASES = [
    ['malformed', 'a list', ['width']],
    ['malformed', 'a string', 'width'],
    ['malformed', 'a function', () => ({})],
    ['malformed', 'a prototyped object', Object.create({ width: {} })],
    ['malformed', 'a symbol key', { [Symbol('x')]: { values: ['auto'] } }],
    ['malformed', 'a Map', new Map([['width', { values: ['auto'] }]])],
    ['unknown-property', 'a misspelt key', { widht: { values: ['auto'] } }],
    [
      'unknown-property',
      'an own __proto__ key',
      { ['__proto__']: { values: ['x'] } },
    ],
    ['unknown-property', 'constructor', { constructor: { values: ['x'] } }],
    [
      'unknown-property',
      'a recognized, undescribed property',
      { cursor: { values: ['pointer'] } },
    ],
    ['composite-form', 'background', { background: { values: ['red'] } }],
    [
      'platform-extension',
      'WebkitAppRegion',
      { WebkitAppRegion: { values: ['drag'] } },
    ],
    ['malformed-entry', 'a string entry', { width: 'auto' }],
    ['malformed-entry', 'a list entry', { width: ['auto'] }],
    ['malformed-entry', 'a null entry', { width: null }],
    ['malformed-entry', 'a function entry', { width: () => 'auto' }],
    ['unknown-member', 'meta', { width: { values: ['auto'], meta: {} } }],
    [
      'unknown-member',
      'resources',
      { width: { values: ['auto'], resources: ['x'] } },
    ],
    [
      'unknown-member',
      'an own __proto__ member',
      { width: { ['__proto__']: ['auto'] } },
    ],
    ['empty', 'an empty entry', { width: {} }],
    ['malformed-member', 'an empty list', { width: { values: [] } }],
    ['malformed-member', 'a scalar member', { width: { values: 'auto' } }],
    [
      'malformed-member',
      'a text bound',
      { opacity: { range: { min: 0, max: '1' } } },
    ],
    [
      'malformed-member',
      'inverted bounds',
      { opacity: { range: { min: 1, max: 0 } } },
    ],
    [
      'malformed-member',
      'a NaN bound',
      { opacity: { range: { min: NaN, max: 1 } } },
    ],
    [
      'malformed-member',
      'an Infinity bound',
      { flex: { range: { min: 0, max: Infinity } } },
    ],
    [
      'malformed-member',
      'an extra range key',
      { opacity: { range: { min: 0, max: 1, step: 1 } } },
    ],
    [
      'malformed-value',
      'a function value',
      { width: { values: [() => 'auto'] } },
    ],
    ['malformed-value', 'an object value', { width: { values: [{}] } }],
    ['malformed-value', 'NaN', { opacity: { values: [NaN] } }],
    ['malformed-value', 'Infinity', { flexGrow: { values: [Infinity] } }],
    ['malformed-value', 'a boolean', { width: { values: [true] } }],
    ['malformed-value', 'a RegExp', { width: { values: [/auto/] } }],
    ['malformed-value', 'null', { width: { values: [null] } }],
    ['malformed-value', 'a numeric category', { color: { tokens: [1] } }],
    ['duplicate', 'a repeated value', { width: { values: ['auto', 'auto'] } }],
    ['duplicate', '0 and "0"', { margin: { values: [0, '0'] } }],
    ['outside-standard', 'a pixel length', { width: { values: ['18px'] } }],
    [
      'outside-standard',
      'a calc() string',
      { width: { values: ['calc(100% - 1px)'] } },
    ],
    ['outside-standard', 'a wildcard', { width: { values: ['*'] } }],
    [
      'outside-standard',
      'a foreign category',
      { color: { tokens: ['spacing'] } },
    ],
    ['outside-standard', 'a numeric string', { opacity: { values: ['0.5'] } }],
    [
      'outside-standard',
      'a number above the range',
      { opacity: { values: [2] } },
    ],
    [
      'outside-standard',
      'a wider range',
      { opacity: { range: { min: 0, max: 2 } } },
    ],
    [
      'outside-standard',
      'an unbounded range on a bounded row',
      { opacity: { range: { min: 0 } } },
    ],
    [
      'outside-standard',
      'a range on a row without one',
      { width: { range: { min: 0, max: 1 } } },
    ],
    [
      'pattern-conflict',
      'display without grid and inline-flex',
      { display: { values: ['flex', 'none'] } },
    ],
    [
      'pattern-conflict',
      'gap without spacing tokens',
      { gap: { values: ['0'] } },
    ],
    [
      'pattern-conflict',
      'alignItems without stretch',
      { alignItems: { values: ['center'] } },
    ],
  ];

  test.each(CASES.map(([rule, name, input]) => [rule, name, input]))(
    '%s: %s',
    (rule, _, input) => {
      const diagnostics = refusal(input);
      expect(diagnostics).not.toBe(null);
      expect(diagnostics.length).toBeGreaterThan(0);
      for (const d of diagnostics) {
        expect(d).toMatchObject({
          code: 'PMS_INVALID_PROPERTY_DOMAIN',
          phase: 'registry',
          rule: `property-domains.${rule}`,
          repair: { applicable: false, kind: 'edit-design-system-definition' },
        });
      }
    },
  );

  test('a category with no token is refused', () => {
    const diagnostics = refusal(
      { width: { tokens: ['sizes'] } },
      { tokens: { spacing: TOKENS.spacing } },
    );
    expect(diagnostics.map((d) => d.rule)).toEqual([
      'property-domains.empty-category',
    ]);
  });

  test('one refused entry refuses the whole definition', () => {
    const diagnostics = refusal({
      width: { values: ['auto'] },
      height: { values: ['18px'] },
    });
    expect(diagnostics.map((d) => d.rule)).toEqual([
      'property-domains.outside-standard',
    ]);
  });

  test('normalization keeps own data only, sorted and frozen', () => {
    const { propertyDomains, diagnostics } = compiler.normalizePropertyDomains(
      { width: { values: ['auto'] }, display: { values: ['flex'] } },
      { 'sizes.a': { category: 'sizes' } },
    );
    expect(diagnostics).toEqual([]);
    expect(Object.keys(propertyDomains)).toEqual(['display', 'width']);
    expect(Object.isFrozen(propertyDomains.width.values)).toBe(true);
  });
});

describe('registry identity', () => {
  const digestOf = (propertyDomains) =>
    build(propertyDomains).registry.registryDigest;

  test('no propertyDomains, undefined or {} keep the digest', () => {
    const plain = digestOf(undefined);
    expect(digestOf(null)).toBe(plain);
    expect(digestOf({})).toBe(plain);
  });

  test('a declared domain changes the digest; key order does not', () => {
    const plain = digestOf(undefined);
    const a = digestOf({
      width: { values: ['auto'] },
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    });
    const b = digestOf({
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
      width: { values: ['auto'] },
    });
    expect(a).not.toBe(plain);
    expect(b).toBe(a);
  });
});

describe('the effective table', () => {
  test('origins: approved, narrowed, default', () => {
    const ds = build({
      width: { tokens: ['sizes'], values: ['auto', 'min-content'] },
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    });
    const rows = ds.snapshot.properties.descriptors;
    expect(rows.width.origin).toBe('approved');
    expect(rows.display.origin).toBe('narrowed');
    expect(rows.height.origin).toBe('default');
    // Rows without an override are the compiler defaults themselves.
    expect(rows.height).toBe(
      compiler.effectivePropertiesOf(null).descriptors.height,
    );
    expect(ds.snapshot.tooling.manifest.properties.byProperty.width).toEqual({
      values: ['auto', 'min-content'],
      tokens: ['sizes'],
      origin: 'approved',
    });
  });

  test('equal overrides share one table across rebuilds', () => {
    const pd = { width: { values: ['auto'] } };
    expect(build(pd).snapshot.properties).toBe(build(pd).snapshot.properties);
    expect(build(pd).snapshot.properties).not.toBe(
      build(undefined).snapshot.properties,
    );
  });
});

// ---------------------------------------------------------------------------
// Invariant 6: no inherited admission branch, enumerated.

describe('an override disables every branch it does not restate', () => {
  const KINDS = ['values', 'tokens', 'range'];
  const cases = [];
  for (const descriptor of admittedRows) {
    const present = KINDS.filter((kind) =>
      kind === 'range'
        ? descriptor.standard.range != null
        : descriptor.standard[kind].length > 0,
    );
    expect(descriptor.standard.resources).toEqual([]);
    for (let mask = 1; mask < 1 << present.length; mask++) {
      const restated = present.filter((_, i) => mask & (1 << i));
      cases.push([descriptor.key, restated.join('+'), descriptor, restated]);
    }
  }

  test('the matrix covers every admitted row', () => {
    expect(new Set(cases.map(([key]) => key)).size).toBe(102);
    expect(cases.length).toBeGreaterThan(102);
  });

  test.each(cases)('%s restating %s', (key, _, descriptor, restated) => {
    const S = descriptor.standard;
    const D = descriptor.default;
    const override = {};
    if (restated.includes('values')) override.values = [...S.values];
    if (restated.includes('tokens')) override.tokens = [...S.tokens];
    if (restated.includes('range')) override.range = { ...S.range };
    const omitted = ['values', 'tokens', 'range'].filter(
      (kind) => !restated.includes(kind),
    );

    const diagnostics = refusal({ [key]: override });
    if (diagnostics != null) {
      // Only a pattern can make a whole-branch override invalid here: the
      // omitted branch holds something a pattern emits (decision D8).
      expect(diagnostics.map((d) => [d.rule, d.context.property])).toEqual(
        diagnostics.map(() => ['property-domains.pattern-conflict', key]),
      );
      expect(omitted).toContain(diagnostics[0].context.member);
      return;
    }
    const ds = build({ [key]: override });
    const row = ds.snapshot.properties.descriptors[key];
    const manifest = ds.snapshot.tooling.manifest.properties.byProperty[key];
    const repair = compiler.repairDomainOf(ds.snapshot, {
      kind: 'property',
      property: key,
    });
    const declarations = compiler.generateDesignSystemDeclarations(ds.snapshot);
    const quotedKey = `readonly ${JSON.stringify(key)}:`;

    // The restated branches are admitted.
    if (restated.includes('values')) {
      expect(outcome(ds, key, S.values[0])).toBe(null);
    }
    if (restated.includes('tokens')) {
      expect(outcome(ds, key, compiler.token(`${S.tokens[0]}.a`))).toBe(null);
    }
    if (restated.includes('range')) {
      expect(outcome(ds, key, S.range.min)).toBe(null);
    }

    // Every omitted branch, from the standard and from the default domain,
    // is refused and absent from every projection.
    for (const kind of omitted) {
      if (kind === 'values') {
        for (const probe of new Set([...S.values, ...D.values])) {
          expect({ probe, out: outcome(ds, key, probe) }).toMatchObject({
            probe,
            out: [['PMS_FORBIDDEN_VALUE', expect.any(String)]],
          });
        }
        expect(row.domain.values).toEqual([]);
        expect(manifest).not.toHaveProperty('values');
        expect(repair.values).toEqual([]);
        expect(compiler.domainOfCssFor(ds.snapshot.properties)(row.css)).toBe(
          null,
        );
        expect(declarationMember(declarations, 'values')).not.toContain(
          quotedKey,
        );
      }
      if (kind === 'tokens') {
        for (const category of new Set([...S.tokens, ...D.tokens])) {
          expect(outcome(ds, key, compiler.token(`${category}.a`))).toEqual([
            ['PMS_FORBIDDEN_VALUE', 'structural-domain'],
          ]);
        }
        expect(row.domain.tokens).toEqual([]);
        expect(manifest).not.toHaveProperty('tokens');
        expect(repair.tokens).toEqual([]);
        expect(declarationMember(declarations, 'tokens')).not.toContain(
          quotedKey,
        );
      }
      if (kind === 'range') {
        const probes = [S.range, D.range]
          .filter(Boolean)
          .map((r) => r.min + 0.25);
        for (const probe of probes) {
          if (row.domain.values.includes(probe)) continue;
          expect(outcome(ds, key, probe)).toMatchObject([
            ['PMS_FORBIDDEN_VALUE', expect.any(String)],
          ]);
        }
        expect(row.domain.range).toBe(null);
        expect(manifest).not.toHaveProperty('range');
        expect(repair.range).toBe(null);
        expect(declarationMember(declarations, 'ranges')).not.toContain(
          JSON.stringify(key),
        );
      }
    }
  });
});

describe('the four legacy ranges under an override', () => {
  test('opacity values [0, 1] rejects 0.5 and types 0 | 1', () => {
    const ds = build({ opacity: { values: [0, 1] } });
    expect(outcome(ds, 'opacity', 1)).toBe(null);
    expect(outcome(ds, 'opacity', 0)).toBe(null);
    expect(outcome(ds, 'opacity', 0.5)).toEqual([
      ['PMS_FORBIDDEN_VALUE', 'structural-domain'],
    ]);
    const entry = ds.snapshot.tooling.manifest.properties.byProperty.opacity;
    expect(entry).toEqual({ values: [0, 1], origin: 'narrowed' });
    const declarations = compiler.generateDesignSystemDeclarations(ds.snapshot);
    expect(declarationMember(declarations, 'values')).toContain(
      'readonly "opacity": 0 | 1;',
    );
    expect(declarationMember(declarations, 'ranges')).not.toContain(
      '"opacity"',
    );
  });

  test.each([
    ['flex', { range: { min: 0, max: 3 } }, [0, 3, 1.5], [4, -1]],
    ['flexShrink', { range: { min: 0 } }, [0, 1e9], [-1]],
    ['flexGrow', { values: [1] }, [1], [2, 0]],
    ['opacity', { range: { min: 0.25, max: 0.5 } }, [0.25, 0.5], [0, 1]],
  ])('%s %j', (key, override, accepted, refused) => {
    const ds = build({ [key]: override });
    for (const v of accepted) expect(outcome(ds, key, v)).toBe(null);
    for (const v of refused) {
      expect(outcome(ds, key, v)).toEqual([
        ['PMS_FORBIDDEN_VALUE', 'structural-domain'],
      ]);
    }
    const range = ds.snapshot.tooling.manifest.properties.byProperty[key].range;
    expect(JSON.parse(JSON.stringify(range ?? null))).toEqual(
      override.range == null ? null : { ...override.range, legacy: true },
    );
  });
});

// ---------------------------------------------------------------------------
// Fixtures through the Project Service, from real page and recipe source.

const TOKEN = "token('sizes.sm')";
const MIXED = `propertyDomains: {
    width: { tokens: ['sizes'], values: ['auto', 'min-content', '100%'] },
  },`;

function openWith({ domains, recipes = '', page = null, files = {} }) {
  const h = openProject('valid');
  let definition = fs.readFileSync(h.sharedDefinitionPath, 'utf8');
  definition = definition.replace(
    "systemId: 'conformance@0.1',",
    `systemId: 'conformance@0.1',\n  ${domains}`,
  );
  definition = definition.replace(
    '  tokens: {\n',
    "  tokens: {\n    sizes: { sm: { value: '8rem', visibility: 'public' }, hidden: { value: '1rem', visibility: 'private' } },\n",
  );
  if (recipes !== '') {
    definition = definition.replace(
      '  recipes: {\n',
      `  recipes: {\n${recipes}\n`,
    );
  }
  fs.writeFileSync(h.sharedDefinitionPath, definition);
  if (page != null) fs.writeFileSync(h.src('src/ce021.js'), page);
  for (const [file, text] of Object.entries(files)) {
    fs.writeFileSync(h.src(file), text);
  }
  h.session.applyChanges({
    definition: h.reloadDefinition(),
    mutation: undefined,
  });
  return h;
}

const pageOf = (calls) =>
  [
    "import { create, token, patterns } from '../generated/design.pandamstyle';",
    ...calls.map((call, i) => `export const s${i} = ${call};`),
    '',
  ].join('\n');

function outcomesByCall(validation, file, calls) {
  return calls.map((_, i) =>
    validation.diagnostics
      .filter((d) => d.location?.file === file && d.location.line === i + 2)
      .map((d) => [d.code, d.rule, d.context?.origin ?? null]),
  );
}

describe('ce021-mixed-domain', () => {
  const CALLS = [
    `create({ n: { width: ${TOKEN} } })`,
    "create({ n: { width: 'auto' } })",
    "create({ n: { width: 'min-content' } })",
    `create({ n: { width: { base: 'auto', wide: ${TOKEN}, hover: 'min-content' } } })`,
    `create({ n: { _hover: { width: ${TOKEN} } } })`,
    "create({ n: { _wide: { width: 'min-content' } } })",
  ];
  const RECIPE = `    sizer: {
      base: { width: ${TOKEN} },
      variants: { mode: { auto: { width: 'auto' }, min: { width: 'min-content', _hover: { width: ${TOKEN} } } } },
      defaultVariants: { mode: 'auto' },
    },`;
  let h;
  let validation;
  beforeAll(() => {
    h = openWith({ domains: MIXED, recipes: RECIPE, page: pageOf(CALLS) });
    validation = h.session.validate();
    if (validation.ok) h.session.compile();
  });

  test('every context compiles', () => {
    expect(
      validation.diagnostics.filter((d) => d.severity === 'error'),
    ).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test('the CSS holds each admitted form', () => {
    const css = fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
    expect(css).toMatch(/width:var\(--[^)]+\)/);
    expect(css).toContain('width:auto');
    expect(css).toContain('width:min-content');
  });

  test('the generated types admit the same domain, and only it', () => {
    const declarations = fs.readFileSync(
      path.join(h.outDir, 'design.pandamstyle.d.ts'),
      'utf8',
    );
    const outputRoot = path.join(REPO_ROOT, 'out-pandamstyle');
    fs.mkdirSync(outputRoot, { recursive: true });
    const root = fs.mkdtempSync(path.join(outputRoot, 'ce021-mixed-'));
    try {
      fs.writeFileSync(
        path.join(root, 'design.pandamstyle.d.ts'),
        declarations,
      );
      const probe = path.join(root, 'probe.ts');
      fs.writeFileSync(
        probe,
        [
          "import { create, token } from './design.pandamstyle';",
          "create({ a: { width: token('sizes.sm') } });",
          "create({ a: { width: 'auto' } });",
          "create({ a: { width: 'min-content' } });",
          "create({ a: { width: { base: 'auto', wide: token('sizes.sm') } } });",
          '// @ts-expect-error max-content is not approved',
          "create({ a: { width: 'max-content' } });",
          "create({ a: { width: '100%' } });",
          '// @ts-expect-error fit-content is an Alpha 1 default, not restated',
          "create({ a: { width: 'fit-content' } });",
          '// @ts-expect-error spacing tokens are not approved',
          "create({ a: { width: token('spacing.md') } });",
          '// @ts-expect-error no raw width',
          "create({ a: { width: '18px' } });",
          '',
        ].join('\n'),
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
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the incremental session equals the fresh oracle', () => {
    const { findings } = differential(h, 'mixed-domain');
    expect(findings).toEqual([]);
  });
});

describe('ce021-narrowed-domain', () => {
  const NARROWED = `propertyDomains: {
    display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    position: { values: ['relative'] },
  },`;

  test('page values outside the narrowed domain are refused as narrowed', () => {
    const calls = [
      "create({ n: { display: 'block' } })",
      "create({ n: { display: 'inline-flex' } })",
      "create({ n: { position: 'absolute' } })",
      "create({ n: { position: { base: 'relative', wide: 'absolute' } } })",
      'patterns.grid({ columns: 2 })',
    ];
    const h = openWith({ domains: NARROWED, page: pageOf(calls) });
    const validation = h.session.validate();
    expect(outcomesByCall(validation, h.src('src/ce021.js'), calls)).toEqual([
      [['PMS_FORBIDDEN_VALUE', 'structural-domain', 'narrowed']],
      [],
      [['PMS_FORBIDDEN_VALUE', 'structural-domain', 'narrowed']],
      [['PMS_FORBIDDEN_VALUE', 'structural-domain', 'narrowed']],
      [],
    ]);
  });

  test('a recipe outside the narrowed domain refuses the design system', () => {
    const h = openWith({
      domains: NARROWED,
      recipes: "    badge: { base: { position: 'absolute' } },",
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    expect(
      validation.diagnostics.map((d) => [d.code, d.rule, d.context?.origin]),
    ).toContainEqual(['PMS_FORBIDDEN_VALUE', 'structural-domain', 'narrowed']);
  });

  test('narrowing below a pattern refuses the design system', () => {
    const h = openWith({
      domains: "propertyDomains: { display: { values: ['flex', 'none'] } },",
      files: {
        'src/pattern-only.js':
          "import { patterns } from '../generated/design.pandamstyle';\nexport const g = patterns.grid({ columns: 2 });\n",
      },
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    expect(
      validation.diagnostics
        .filter((d) => d.code === 'PMS_INVALID_PROPERTY_DOMAIN')
        .map((d) => [d.rule, d.context.patternId, d.context.value]),
    ).toEqual([
      ['property-domains.pattern-conflict', 'center', 'inline-flex'],
      ['property-domains.pattern-conflict', 'grid', 'grid'],
    ]);
  });
});

describe('ce021-unauthorized consumer', () => {
  const CALLS = [
    "create({ n: { height: 'auto' } })",
    "create({ n: { width: 'calc(100% - 1px)' } })",
    "create({ n: { propertyDomains: { width: { values: ['18px'] } } } })",
    "create({ n: { constructor: 'auto' } })",
    "create({ n: { width: token('sizes.hidden') } })",
    "create({ n: { width: { kind: 'pandamstyle-token-ref', path: 'sizes.sm' } } })",
    "create({ n: { width: '18px' } })",
  ];
  let validation;
  let page;
  beforeAll(() => {
    const h = openWith({ domains: MIXED, page: pageOf(CALLS) });
    page = h.src('src/ce021.js');
    validation = h.session.validate();
  });

  test('every attempt is refused at its call', () => {
    const codes = outcomesByCall(validation, page, CALLS).map((list) =>
      list.map(([code, rule]) => [code, rule]),
    );
    expect(codes).toEqual([
      [['PMS_FORBIDDEN_VALUE', 'structural-domain']],
      [['PMS_FORBIDDEN_VALUE', 'property-domain']],
      [['PMS_UNSUPPORTED_PROPERTY', 'supported-properties.unrecognized']],
      [['PMS_UNSUPPORTED_PROPERTY', 'supported-properties.unrecognized']],
      [['PMS_TOKEN_NOT_PUBLIC', 'visibility.consumer']],
      // An object imitating a token reference is read as a condition map of
      // unknown conditions; that refusal carries no source line (existing
      // behavior), asserted below.
      [],
      [['PMS_FORBIDDEN_VALUE', 'property-domain']],
    ]);
    expect(
      validation.diagnostics
        .filter((d) => d.code === 'PMS_UNKNOWN_CONDITION')
        .map((d) => [d.context.property, d.context.condition])
        .sort(),
    ).toEqual([
      ['width', 'kind'],
      ['width', 'path'],
    ]);
    expect(validation.ok).toBe(false);
  });

  test('no page-role repair offers an author edit', () => {
    for (const d of validation.diagnostics) {
      expect(d.repair?.kind).not.toBe('edit-design-system-definition');
    }
  });
});

// ---------------------------------------------------------------------------
// The `property-domains` incremental unit.

describe('a propertyDomains edit revalidates exactly the dependent files', () => {
  const PATTERN_ONLY =
    "import { patterns } from '../generated/design.pandamstyle';\nexport const g = patterns.stack({ gap: undefined });\n";
  test('create() and pattern-only files recompile; the others keep validity', () => {
    const h = openWith({
      domains: '',
      page: pageOf(["create({ n: { width: 'auto' } })"]),
      files: {
        'src/pattern-only.js':
          "import { patterns } from '../generated/design.pandamstyle';\nexport const g = patterns.stack({ align: 'center' });\n",
      },
    });
    void PATTERN_ONLY;
    let validation = h.session.validate();
    // width: 'auto' is not in the Alpha 1 default.
    expect(
      validation.diagnostics
        .filter((d) => d.location?.file === h.src('src/ce021.js'))
        .map((d) => d.code),
    ).toEqual(['PMS_FORBIDDEN_VALUE']);
    // Make the project valid first, then change only the domains.
    fs.writeFileSync(
      h.src('src/ce021.js'),
      pageOf(["create({ n: { width: '100%' } })"]),
    );
    let step = differential(h, 'valid baseline', {
      definition: h.reloadDefinition(),
      changed: [h.src('src/ce021.js')],
    });
    expect(step.findings).toEqual([]);
    const before = new Map(
      h.session.fileStates().map((f) => [f.file, f.compiledRevision]),
    );

    const definition = fs
      .readFileSync(h.sharedDefinitionPath, 'utf8')
      .replace(
        "systemId: 'conformance@0.1',",
        "systemId: 'conformance@0.1',\n  propertyDomains: { width: { values: ['100%', 'auto'] } },",
      );
    fs.writeFileSync(h.sharedDefinitionPath, definition);
    step = differential(h, 'domain edit', {
      definition: h.reloadDefinition(),
      changed: [],
    });
    expect(step.findings).toEqual([]);
    validation = step.validation;
    expect(validation.ok).toBe(true);
    const after = new Map(
      h.session.fileStates().map((f) => [f.file, f.compiledRevision]),
    );
    const recompiled = [...after.keys()]
      .filter((file) => after.get(file) !== before.get(file))
      .map((file) => path.relative(h.project, file))
      .sort();
    expect(recompiled).toEqual(
      expect.arrayContaining(['src/ce021.js', 'src/pattern-only.js']),
    );
    // A file that compiles no declaration keeps its validity.
    expect(recompiled).not.toContain('src/only-recipe.js');
    expect(recompiled).not.toContain('src/business-data.ts');

    // The newly approved value now compiles, with no stale verdict.
    fs.writeFileSync(
      h.src('src/ce021.js'),
      pageOf(["create({ n: { width: 'auto' } })"]),
    );
    step = differential(h, 'approved value', {
      changed: [h.src('src/ce021.js')],
    });
    expect(step.findings).toEqual([]);
    expect(step.validation.ok).toBe(true);
  });

  test('a previously refused file is revalidated when its value is approved', () => {
    const h = openWith({
      domains: '',
      page: pageOf(["create({ n: { width: 'auto' } })"]),
    });
    expect(h.session.validate().ok).toBe(false);
    const definition = fs.readFileSync(h.sharedDefinitionPath, 'utf8').replace(
      "systemId: 'conformance@0.1',",
      // The override is the whole domain: it restates the fixture's '100%'.
      "systemId: 'conformance@0.1',\n  propertyDomains: { width: { values: ['auto', '100%'] } },",
    );
    fs.writeFileSync(h.sharedDefinitionPath, definition);
    const step = differential(h, 'approve', {
      definition: h.reloadDefinition(),
      changed: [],
    });
    expect(step.findings).toEqual([]);
    expect(step.validation.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Target candidates: recomputed on a domain change, memo hit when unchanged.

describe('target candidates follow the effective table', () => {
  test('the domainOf function changes with the table and only then', () => {
    const a = build({
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    });
    const b = build({
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    });
    const c = build({
      display: { values: ['flex', 'inline-flex', 'grid', 'none', 'block'] },
    });
    const fa = compiler.domainOfCssFor(a.snapshot.properties);
    expect(compiler.domainOfCssFor(b.snapshot.properties)).toBe(fa);
    const fc = compiler.domainOfCssFor(c.snapshot.properties);
    expect(fc).not.toBe(fa);
    expect(fa('display')).toEqual(['flex', 'inline-flex', 'grid', 'none']);
    expect(fc('display')).toContain('block');
    expect(fa.digest).not.toBe(fc.digest);
  });

  test('target evaluation recomputes after a domain change and hits after none', () => {
    const { targets } = compiler;
    const enforced = targets.resolveTargets({
      profiles: ['pandamstyle:default@1'],
    }).record;
    const accumulator = targets.createTargetAccumulator();
    // `display: ruby` is not native on the default profile: its repair lists
    // the admitted display values that are.
    const pages = [
      {
        file: '/app/a.js',
        rules: [['x', { ltr: '.x{display:ruby}', rtl: null }]],
        ruleOrigins: [],
      },
    ];
    const registryOf = (propertyDomains) => ({
      enhancements: [],
      conditions: {},
      conditionOrder: [],
      ...(propertyDomains == null ? {} : { propertyDomains }),
    });
    const evaluate = (propertyDomains) =>
      targets.evaluateProjectTargets({
        resolution: enforced,
        designSystem: { registry: registryOf(propertyDomains), injected: {} },
        designSystemRules: [],
        pages,
        accumulator,
      });
    const candidates = (result) =>
      result.errors
        .filter((d) => d.context.feature === 'value:display/ruby')
        .flatMap((d) => d.candidates.map((c) => c.value ?? c));

    const first = evaluate(null);
    expect(candidates(first)).toEqual([
      'block',
      'flex',
      'grid',
      'inline-block',
      'inline-flex',
      'none',
    ]);
    // The evaluation memo returns its previous result on a hit: the enforced
    // error list is the same array. The facts do not depend on the domains
    // and keep their object throughout (CE-01.1 facts identity).
    // 1. An unchanged revision hits the memo.
    const unchanged = evaluate(null);
    expect(unchanged.errors).toBe(first.errors);
    expect(unchanged.facts).toBe(first.facts);

    // 2. A domain change recomputes: a new result with narrowed candidates.
    const narrowed = {
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    };
    const changed = evaluate(narrowed);
    expect(changed.errors).not.toBe(first.errors);
    expect(changed.facts).toBe(first.facts);
    expect(candidates(changed)).toEqual([
      'flex',
      'grid',
      'inline-flex',
      'none',
    ]);

    // 3. The same domains again, from a new registry object: a hit again.
    const again = evaluate({
      display: { values: ['flex', 'inline-flex', 'grid', 'none'] },
    });
    expect(again.errors).toBe(changed.errors);
    expect(candidates(again)).toEqual(candidates(changed));
  });
});
