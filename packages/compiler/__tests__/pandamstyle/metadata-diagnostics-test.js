/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-03.1 AC2: invalid references, replacement cycles and invalid examples
 * have structured diagnostics (design note §3.4-§3.9, §5.1). Every rule, every
 * target kind; bounded context with closed keys; every error reported.
 */

'use strict';

const {
  compiler,
  T,
  attempt,
  baseDefinition,
  failures,
} = require('./metadata-helpers');

const CONTEXT_KEYS = new Set([
  'entity',
  'field',
  'reason',
  'bytes',
  'limit',
  'expectedKind',
  'actualKind',
  'privateKind',
  'cycleLength',
  'cycle',
  'cause',
]);

function expectShape(d) {
  expect(d.code).toBe('PMS_INVALID_METADATA');
  expect(d.severity).toBe('error');
  expect(d.phase).toBe('registry');
  expect(d.source).toBe('design-system');
  expect(d.rule.startsWith('metadata.')).toBe(true);
  for (const key of Object.keys(d.context))
    expect(CONTEXT_KEYS.has(key)).toBe(true);
  for (const segment of d.context.field) {
    if (typeof segment === 'object')
      expect(Object.keys(segment)).toEqual(['index']);
    else expect(['string', 'number']).toContain(typeof segment);
  }
  expect(d.repair).toMatchObject({
    kind: 'edit-design-system-definition',
    applicable: false,
  });
}

function only(edit) {
  const definition = baseDefinition();
  edit(definition);
  const diagnostics = failures(definition);
  diagnostics.forEach(expectShape);
  return diagnostics;
}

const one = (edit) => {
  const diagnostics = only(edit);
  expect(diagnostics).toHaveLength(1);
  return diagnostics[0];
};

describe('schema rules', () => {
  test.each([
    ['symbol key', (m) => (m[Symbol('x')] = 1), 'symbol-key'],
    ['function', (m) => (m.description = () => 'x'), 'function'],
    ['prototype', (m) => (m.usage = Object.create({ x: 1 })), 'prototype'],
    ['cycle', (m) => (m.self = m), 'cycle'],
    ['hole', (m) => (m.usage = [, 'x']), 'hole'], // eslint-disable-line no-sparse-arrays
    [
      'accessor',
      (m) =>
        Object.defineProperty(m, 'description', {
          enumerable: true,
          get: () => 'x',
        }),
      'accessor',
    ],
    [
      'depth',
      (m) => {
        let node = m;
        for (let i = 0; i < 13; i++) node = node.deep = {};
      },
      'depth',
    ],
  ])('metadata.malformed: %s', (_label, edit, reason) => {
    const meta = {};
    edit(meta);
    const d = one((def) => (def.tokens.colors.paper.meta = meta));
    expect(d.rule).toBe('metadata.malformed');
    expect(d.context.reason).toBe(reason);
    expect(d.context.entity).toEqual({ token: 'colors.paper' });
  });

  test('metadata.unsupported-position: token group, category, theme override group and leaf', () => {
    const diagnostics = only((def) => {
      def.tokens.colors.meta = { value: '#fff' };
      def.tokens.meta = { a: { value: '1px' } };
      def.themes.dark.tokens = {
        colors: { meta: {}, paper: { value: '#eee', meta: {} } },
      };
    });
    expect(
      diagnostics.map((d) => [d.rule, d.context.reason, d.context.entity]),
    ).toEqual([
      ['metadata.unsupported-position', 'token-group', null],
      ['metadata.unsupported-position', 'token-category', null],
      ['metadata.unsupported-position', 'token-group', null],
      ['metadata.unsupported-position', 'theme-override-leaf', null],
    ]);
    // Never a path segment any more: no token named colors.meta was created.
    expect(diagnostics[0].context.field).toEqual([
      'tokens',
      { index: 1 },
      'meta',
    ]);
  });

  test('variant values and slots named meta stay vocabulary', () => {
    const definition = baseDefinition();
    definition.recipes.button.variants.tone.meta = {};
    definition.recipes.card.slots.push('meta');
    definition.recipes.card.base.meta = {};
    const { ds } = attempt(definition);
    expect(ds.snapshot.vocabulary.recipes.button.axes.tone).toContain('meta');
    expect(ds.snapshot.vocabulary.recipes.card.slots).toContain('meta');
  });

  test('metadata.unknown-field: authority-shaped and misspelled fields, shown by index', () => {
    const diagnostics = only((def) => {
      def.tokens.colors.paper.meta = {
        visibility: 'public',
        descripton: 'x',
        grants: ['all'],
      };
    });
    expect(diagnostics.map((d) => [d.rule, d.context.field])).toEqual([
      ['metadata.unknown-field', [{ index: 0 }]],
      ['metadata.unknown-field', [{ index: 1 }]],
      ['metadata.unknown-field', [{ index: 2 }]],
    ]);
  });

  test.each([
    ['not-object', 'x', []],
    ['empty-array', { usage: [] }, ['usage']],
    [
      'too-many',
      { usage: Array.from({ length: 9 }, (_, i) => `use ${i}`) },
      ['usage'],
    ],
    ['identifier', { semanticRole: 'Primary Role' }, ['semanticRole']],
    ['duplicate', { terms: ['a', 'a'] }, ['terms']],
    [
      'enum',
      { relations: [{ relation: 'owns', target: { token: 'colors.paper' } }] },
      ['relations', 0, 'relation'],
    ],
    [
      'reference-shape',
      {
        relations: [
          {
            relation: 'related',
            target: { token: 'colors.paper', theme: 'dark' },
          },
        ],
      },
      ['relations', 0, 'target'],
    ],
    [
      'example-shape',
      { examples: [{ property: 'color', extra: 1 }] },
      ['examples', 0],
    ],
  ])('metadata.field-type: %s', (reason, meta, field) => {
    const d = one((def) => (def.tokens.spacing.sm.meta = meta));
    expect([d.rule, d.context.reason, d.context.field]).toEqual([
      'metadata.field-type',
      reason,
      field,
    ]);
  });

  test.each([
    ['not-string', 42],
    ['empty', ''],
    ['too-long', 'x'.repeat(513)],
    ['ill-formed', 'a\ud800b'],
    ['control-character', 'line\nbreak'],
    ['invisible-character', 'abc‮def'],
    ['invisible-character', 'zero​width'],
    ['surrounding-space', ' padded'],
    ['not-nfc', 'café'],
  ])('metadata.text: %s', (reason, description) => {
    const d = one((def) => (def.themes.dark.meta = { description }));
    expect([d.rule, d.context.reason, d.context.field]).toEqual([
      'metadata.text',
      reason,
      ['description'],
    ]);
    if (reason === 'too-long')
      expect(d.context).toMatchObject({ bytes: 513, limit: 512 });
  });

  test('metadata.too-large and metadata.total-too-large', () => {
    const big = {
      description: 'd'.repeat(512),
      usage: Array.from({ length: 8 }, () => 'u'.repeat(256)),
      restrictions: Array.from({ length: 8 }, () => 'r'.repeat(256)),
    };
    const d = one((def) => (def.tokens.colors.paper.meta = big));
    expect(d.rule).toBe('metadata.too-large');
    expect(d.context.limit).toBe(4096);
    expect(d.context.bytes).toBe(compiler.canonicalSize(big));

    const definition = baseDefinition();
    const fits = {
      description: 'd'.repeat(512),
      usage: Array.from({ length: 8 }, () => 'u'.repeat(256)),
      restrictions: Array.from({ length: 4 }, () => 'r'.repeat(256)),
    };
    expect(compiler.canonicalSize(fits)).toBeLessThanOrEqual(4096);
    definition.tokens.many = {};
    for (let i = 0; i < 300; i++)
      definition.tokens.many[`t${i}`] = { value: '1px', meta: fits };
    const total = failures(definition);
    expect(total.map((x) => x.rule)).toEqual(['metadata.total-too-large']);
    expect(total[0].context).toMatchObject({
      entity: null,
      limit: 1024 * 1024,
    });
  });

  test('metadata.unknown-child: undeclared slot, axis, value and pattern, by index', () => {
    const diagnostics = only((def) => {
      def.recipes.card.meta = {
        slots: { ghost: {} },
        variants: { ghost: { meta: {} }, density: { values: { ghost: {} } } },
      };
      def.meta = { patterns: { ghost: {} } };
    });
    expect(
      diagnostics.map((d) => [d.rule, d.context.entity, d.context.field]),
    ).toEqual([
      ['metadata.unknown-child', { system: true }, ['patterns', { index: 0 }]],
      ['metadata.unknown-child', { recipe: 'card' }, ['slots', { index: 0 }]],
      [
        'metadata.unknown-child',
        { recipe: 'card' },
        ['variants', { index: 0 }],
      ],
      [
        'metadata.unknown-child',
        { recipe: 'card' },
        ['variants', { index: 1 }, 'values', { index: 0 }],
      ],
    ]);
  });
});

describe('reference rules (§3.4)', () => {
  test.each([
    ['token', { token: 'colors.nope' }],
    ['theme', { theme: 'nope' }],
    ['condition', { condition: 'nope' }],
    ['recipe', { recipe: 'nope' }],
    ['slot', { recipe: 'card', slot: 'nope' }],
    ['axis', { recipe: 'button', variant: 'nope' }],
    ['value', { recipe: 'button', variant: 'tone', value: 'nope' }],
    ['pattern', { pattern: 'nope' }],
    ['property', { property: 'height' }],
  ])('metadata.unknown-reference: %s', (_kind, target) => {
    const d = one(
      (def) =>
        (def.tokens.colors.paper.meta = {
          relations: [{ relation: 'related', target }],
        }),
    );
    expect([d.rule, d.context.field]).toEqual([
      'metadata.unknown-reference',
      ['relations', 0, 'target'],
    ]);
    expect(JSON.stringify(d)).not.toContain('nope');
  });

  test('metadata.private-reference and metadata.self-reference; private sources may reference anything', () => {
    const diagnostics = only((def) => {
      def.tokens.colors.paper.meta = {
        relations: [
          { relation: 'related', target: { token: 'colors.ink' } },
          {
            relation: 'pairs-with',
            target: { recipe: 'zzsecret', slot: 'inner' },
          },
          { relation: 'alternative', target: { token: 'colors.paper' } },
        ],
      };
      def.tokens.colors.ink.meta = {
        relations: [{ relation: 'related', target: { token: 'colors.paper' } }],
      };
      def.recipes.zzsecret.meta = {
        relations: [{ relation: 'related', target: { token: 'colors.ink' } }],
      };
    });
    expect(diagnostics.map((d) => [d.rule, d.context.field])).toEqual([
      ['metadata.private-reference', ['relations', 0, 'target']],
      ['metadata.private-reference', ['relations', 1, 'target']],
      ['metadata.self-reference', ['relations', 2, 'target']],
    ]);
  });

  const component = (module, name = 'Button') => ({
    component: { module, export: name },
  });

  test('metadata.reference-kind: component module and export grammar', () => {
    const diagnostics = only((def) => {
      def.recipes.button.meta = {
        relations: [
          { relation: 'implemented-by', target: component('/abs/Button.tsx') },
          {
            relation: 'implemented-by',
            target: component('src/../Button.tsx'),
          },
          {
            relation: 'implemented-by',
            target: component('https://x/Button.js'),
          },
          { relation: 'implemented-by', target: component('src\\Button.tsx') },
          { relation: 'implemented-by', target: component('src//Button.tsx') },
          {
            relation: 'implemented-by',
            target: component('src/ui/Button.tsx', 'not-an-id'),
          },
          {
            relation: 'implemented-by',
            target: component('src/ui/Button.tsx', 'default'),
          },
        ],
      };
    });
    expect(
      diagnostics.map((d) => [d.rule, d.context.reason, d.context.field]),
    ).toEqual([
      [
        'metadata.reference-kind',
        'component-module',
        ['relations', 0, 'target', 'component', 'module'],
      ],
      [
        'metadata.reference-kind',
        'component-module',
        ['relations', 1, 'target', 'component', 'module'],
      ],
      [
        'metadata.reference-kind',
        'component-module',
        ['relations', 2, 'target', 'component', 'module'],
      ],
      [
        'metadata.reference-kind',
        'component-module',
        ['relations', 3, 'target', 'component', 'module'],
      ],
      [
        'metadata.reference-kind',
        'component-module',
        ['relations', 4, 'target', 'component', 'module'],
      ],
      [
        'metadata.reference-kind',
        'component-export',
        ['relations', 5, 'target', 'component', 'export'],
      ],
    ]);
  });

  test('metadata.reference-kind: implemented-by takes exactly a component, and a component only implemented-by', () => {
    const diagnostics = only((def) => {
      def.recipes.button.meta = {
        relations: [
          { relation: 'implemented-by', target: { recipe: 'card' } },
          { relation: 'related', target: component('src/ui/Button.tsx') },
          {
            relation: 'implemented-by',
            target: component('src/ui/Button.tsx', 'default'),
          },
        ],
      };
    });
    expect(
      diagnostics.map((d) => [d.rule, d.context.reason, d.context.field]),
    ).toEqual([
      [
        'metadata.reference-kind',
        'implemented-by-target',
        ['relations', 0, 'target'],
      ],
      [
        'metadata.reference-kind',
        'component-relation',
        ['relations', 1, 'target'],
      ],
    ]);
  });

  test('an entity with a schema error gets no reference check (no cascade)', () => {
    const diagnostics = only((def) => {
      def.recipes.button.meta = {
        description: '',
        relations: [{ relation: 'related', target: { recipe: 'nope' } }],
      };
    });
    expect(diagnostics.map((d) => d.rule)).toEqual(['metadata.text']);
  });
});

describe('replacement rules (§3.5)', () => {
  const deprecate = (replacement) => ({ deprecated: { replacement } });

  test('metadata.replacement-kind: kind, token category and scope', () => {
    const diagnostics = only((def) => {
      def.tokens.colors.paper.meta = deprecate({ theme: 'dark' });
      def.tokens.spacing.sm.meta = deprecate({ token: 'colors.paper' });
      def.recipes.button.meta = {
        variants: {
          tone: {
            values: {
              danger: deprecate({
                recipe: 'button',
                variant: 'size',
                value: 'md',
              }),
            },
          },
        },
      };
      def.recipes.card.meta = {
        slots: {
          label: deprecate({ component: { module: 'a/b.js', export: 'B' } }),
        },
      };
    });
    const rows = diagnostics.map((d) => [
      d.rule,
      d.context.expectedKind,
      d.context.actualKind,
      d.context.reason ?? null,
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['metadata.replacement-kind', 'token', 'theme', null],
        ['metadata.replacement-kind', 'token', 'token', 'category'],
        ['metadata.replacement-kind', 'value', 'value', 'scope'],
        ['metadata.replacement-kind', 'slot', 'component', null],
      ]),
    );
    expect(rows).toHaveLength(4);
  });

  test('a chain that ends at a deprecated entity is valid; views keep only declared edges', () => {
    const definition = baseDefinition();
    definition.tokens.colors.text.muted.meta = deprecate({
      token: 'colors.text.primary',
    });
    definition.tokens.colors.text.primary.meta = { deprecated: {} };
    const { ds } = attempt(definition);
    const view = compiler.semanticsViewOf(ds.snapshot);
    const muted = view.entities.find(
      (e) => e.entity.token === 'colors.text.muted',
    );
    expect(muted.meta).toEqual(deprecate({ token: 'colors.text.primary' }));
  });

  test.each([1, 2, 3])(
    'metadata.replacement-cycle of length %d: one diagnostic on the smallest address',
    (length) => {
      const diagnostics = only((def) => {
        def.tokens.loop = {};
        for (let i = 0; i < length; i++)
          def.tokens.loop[`t${i}`] = { value: '1px' };
        for (let i = 0; i < length; i++)
          def.tokens.loop[`t${i}`].meta = deprecate({
            token: `loop.t${(i + 1) % length}`,
          });
      });
      expect(diagnostics).toHaveLength(1);
      const [d] = diagnostics;
      expect(d.rule).toBe('metadata.replacement-cycle');
      expect(d.context.entity).toEqual({ token: 'loop.t0' });
      expect(d.context.cycleLength).toBe(length);
      expect(d.context.cycle).toEqual(
        Array.from({ length }, (_, i) => ({ token: `loop.t${i}` })),
      );
    },
  );

  test('a 10,000-entity cycle: no stack overflow, one diagnostic, 16 addresses', () => {
    const definition = baseDefinition();
    definition.tokens.chain = {};
    const n = 10000;
    const id = (i) => `c${String(i).padStart(5, '0')}`;
    for (let i = 0; i < n; i++)
      definition.tokens.chain[id(i)] = {
        value: '1px',
        meta: deprecate({ token: `chain.${id((i + 1) % n)}` }),
      };
    const diagnostics = failures(definition);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].context.cycleLength).toBe(n);
    expect(diagnostics[0].context.cycle).toHaveLength(16);
  });

  test('two disjoint cycles: two diagnostics', () => {
    const diagnostics = only((def) => {
      def.themes.dark.meta = deprecate({ theme: 'contrast' });
      def.themes.contrast.meta = deprecate({ theme: 'dark' });
      def.conditions.wide.meta = deprecate({ condition: 'wide' });
    });
    expect(diagnostics.map((d) => [d.rule, d.context.cycleLength])).toEqual([
      ['metadata.replacement-cycle', 1],
      ['metadata.replacement-cycle', 2],
    ]);
  });
});

describe('examples, verified by compilation (§3.6)', () => {
  test('accepted examples of every kind compile and add nothing to the generation', () => {
    const plain = attempt(baseDefinition()).ds;
    const definition = baseDefinition();
    definition.tokens.spacing.sm.meta = {
      examples: [
        { property: 'paddingInline' },
        { property: 'gap', condition: 'wide' },
      ],
    };
    definition.tokens.colors.ink.meta = { examples: [{ property: 'color' }] };
    definition.conditions.wide.meta = {
      examples: [
        { property: 'color', value: { token: 'colors.text.primary' } },
      ],
    };
    definition.propertyDomains.width.meta = { examples: [{ value: 'auto' }] };
    definition.recipes.button.meta = {
      examples: [{}, { select: { tone: 'danger', size: 'md' } }],
    };
    definition.recipes.card.meta = { examples: [{ slot: 'label' }] };
    definition.meta = {
      patterns: {
        stack: {
          examples: [
            { parameters: { gap: { token: 'spacing.sm' }, align: 'center' } },
            {
              parameters: {
                gap: {
                  base: { token: 'spacing.sm' },
                  wide: { token: 'spacing.md' },
                },
              },
            },
          ],
        },
      },
    };
    const { ds, diagnostics } = attempt(definition);
    expect(diagnostics).toBeUndefined();
    expect(ds.renderCss()).toBe(plain.renderCss());
    expect(Object.keys(ds.snapshot.compiled.cssRules)).toEqual(
      Object.keys(plain.snapshot.compiled.cssRules),
    );
  });

  test.each([
    [
      'forbidden property',
      (def) =>
        (def.tokens.spacing.sm.meta = {
          examples: [{ property: 'background' }],
        }),
      { token: 'spacing.sm' },
    ],
    [
      'wrong category',
      (def) =>
        (def.tokens.spacing.sm.meta = { examples: [{ property: 'color' }] }),
      { token: 'spacing.sm' },
    ],
    [
      'private token in a public example',
      (def) =>
        (def.conditions.wide.meta = {
          examples: [{ property: 'color', value: { token: 'colors.ink' } }],
        }),
      { condition: 'wide' },
    ],
    [
      'unknown condition',
      (def) =>
        (def.tokens.spacing.sm.meta = {
          examples: [{ property: 'gap', condition: 'nope' }],
        }),
      { token: 'spacing.sm' },
    ],
    [
      'invalid variant value',
      (def) =>
        (def.recipes.button.meta = {
          examples: [{ select: { tone: 'nope' } }],
        }),
      { recipe: 'button' },
    ],
    [
      'unknown slot',
      (def) => (def.recipes.card.meta = { examples: [{ slot: 'nope' }] }),
      { recipe: 'card' },
    ],
    [
      'invalid pattern parameter',
      (def) =>
        (def.meta = {
          patterns: { grid: { examples: [{ parameters: { columns: 9 } }] } },
        }),
      { pattern: 'grid' },
    ],
    [
      'outside a property domain',
      (def) =>
        (def.propertyDomains.width.meta = {
          examples: [{ value: 'fit-content' }],
        }),
      { property: 'width' },
    ],
  ])('metadata.invalid-example: %s', (_label, edit, entity) => {
    const d = one(edit);
    expect(d.rule).toBe('metadata.invalid-example');
    expect(d.context.entity).toEqual(entity);
    expect(d.context.field).toEqual(['examples', 0]);
    expect(Object.keys(d.context.cause).sort()).toEqual(['code', 'rule']);
    expect(d.context.cause.code).toMatch(/^PMS_/);
    expect(JSON.stringify(d)).not.toContain('nope');
  });

  test('a private token example compiles in the system role', () => {
    const definition = baseDefinition();
    definition.tokens.colors.ink.meta = { examples: [{ property: 'color' }] };
    expect(attempt(definition).diagnostics).toBeUndefined();
  });
});

test('every error is reported in one pass, across entities and rules', () => {
  const diagnostics = only((def) => {
    def.tokens.colors.paper.meta = { description: '', terms: ['Bad'] };
    def.themes.dark.meta = {
      relations: [{ relation: 'related', target: { theme: 'nope' } }],
    };
    def.recipes.button.meta = { slots: {} };
    def.recipes.button.base = { color: T('colors.text.primary') };
  });
  expect(diagnostics.map((d) => d.rule).sort()).toEqual([
    'metadata.field-type',
    'metadata.field-type',
    'metadata.text',
    'metadata.unknown-reference',
  ]);
});

// ---------------------------------------------------------------------------
// §5.3: every cap at its limit and at limit + 1; diagnostics never echo values.

describe('caps (§3.3, §3.8.2): limit accepted, limit + 1 refused', () => {
  const caps = compiler.META_CAPS;
  const comp = (module, name) => ({
    relations: [
      {
        relation: 'implemented-by',
        target: { component: { module, export: name } },
      },
    ],
  });
  const CASES = [
    [
      'description bytes',
      (n) => ({ description: 'd'.repeat(n) }),
      caps.description,
      'metadata.text',
    ],
    [
      'usage item bytes',
      (n) => ({ usage: ['u'.repeat(n)] }),
      caps.listText,
      'metadata.text',
    ],
    [
      'restrictions items',
      (n) => ({ restrictions: Array.from({ length: n }, (_, i) => `r${i}`) }),
      caps.listItems,
      'metadata.field-type',
    ],
    [
      'terms items',
      (n) => ({ terms: Array.from({ length: n }, (_, i) => `t${i}`) }),
      caps.terms,
      'metadata.field-type',
    ],
    [
      'term bytes',
      (n) => ({ terms: ['t'.repeat(n)] }),
      caps.termBytes,
      'metadata.field-type',
    ],
    [
      'semanticRole bytes',
      (n) => ({ semanticRole: 'r'.repeat(n) }),
      caps.semanticRole,
      'metadata.field-type',
    ],
    [
      'relations items',
      (n) => ({
        relations: Array.from({ length: n }, (_, i) => ({
          relation: 'implemented-by',
          target: { component: { module: `src/m${i}.js`, export: 'M' } },
        })),
      }),
      caps.relations,
      'metadata.field-type',
    ],
    [
      'examples items',
      (n) => ({
        examples: Array.from({ length: n }, () => ({
          property: 'paddingInline',
        })),
      }),
      caps.examples,
      'metadata.field-type',
    ],
    [
      'deprecated reason bytes',
      (n) => ({ deprecated: { reason: 'r'.repeat(n) } }),
      caps.reason,
      'metadata.text',
    ],
    [
      'component module bytes',
      (n) => comp(`src/${'m'.repeat(n - 7)}.js`, 'M'),
      caps.componentModule,
      'metadata.text',
    ],
    [
      'component export bytes',
      (n) => comp('src/m.js', 'E'.repeat(n)),
      caps.componentExport,
      'metadata.reference-kind',
    ],
  ];
  test.each(CASES)('%s', (_label, make, limit, rule) => {
    const at = baseDefinition();
    at.tokens.spacing.sm.meta = make(limit);
    expect(attempt(at).diagnostics).toBeUndefined();
    const over = baseDefinition();
    over.tokens.spacing.sm.meta = make(limit + 1);
    const diagnostics = failures(over);
    expect(diagnostics.map((d) => d.rule)).toEqual([rule]);
  });

  // A meta whose canonical size is exactly `bytes`.
  function sized(bytes) {
    const meta = {
      usage: Array.from({ length: 8 }, () => 'u'.repeat(256)),
      restrictions: Array.from({ length: 6 }, () => 'r'.repeat(256)),
      description: '',
    };
    const base = compiler.canonicalSize({ ...meta, description: 'x' }) - 1;
    meta.description = 'd'.repeat(bytes - base);
    expect(compiler.canonicalSize(meta)).toBe(bytes);
    return meta;
  }

  test('entity size: 4096 accepted, 4097 refused', () => {
    const at = baseDefinition();
    at.tokens.colors.paper.meta = sized(caps.entityBytes);
    expect(attempt(at).diagnostics).toBeUndefined();
    const over = baseDefinition();
    over.tokens.colors.paper.meta = sized(caps.entityBytes + 1);
    expect(failures(over).map((d) => [d.rule, d.context.bytes])).toEqual([
      ['metadata.too-large', 4097],
    ]);
  });

  test('total size: exactly 1 MiB accepted; one more (empty) meta refused', () => {
    const fill = () => {
      const d = baseDefinition();
      d.tokens.bulk = {};
      for (let i = 0; i < 256; i++)
        d.tokens.bulk[`t${String(i).padStart(3, '0')}`] = {
          value: '1px',
          meta: sized(4096),
        };
      return d;
    };
    expect(256 * 4096).toBe(caps.totalBytes);
    expect(attempt(fill()).diagnostics).toBeUndefined();
    const over = fill();
    over.tokens.colors.paper.meta = {}; // canonical size 2
    expect(
      failures(over).map((d) => [d.rule, d.context.bytes, d.context.limit]),
    ).toEqual([
      ['metadata.total-too-large', caps.totalBytes + 2, caps.totalBytes],
    ]);
  });
});

test('no metadata diagnostic echoes a value: 4 KiB sentinels stay out, records stay small', () => {
  const sentinel = `Q${'x'.repeat(4096)}Q`;
  const definition = baseDefinition();
  definition.tokens.colors.paper.meta = {
    description: sentinel,
    usage: [sentinel],
    terms: [sentinel],
    semanticRole: sentinel,
    [sentinel]: 1,
  };
  definition.themes.dark.meta = {
    relations: [{ relation: 'related', target: { theme: sentinel } }],
  };
  definition.conditions.wide.meta = { deprecated: { reason: sentinel } };
  definition.recipes.button.meta = { slots: { [sentinel]: {} } };
  const diagnostics = failures(definition);
  expect(diagnostics.length).toBeGreaterThanOrEqual(7);
  for (const d of diagnostics) {
    const text = JSON.stringify(d);
    expect(text).not.toContain('xxxx');
    expect(text.length).toBeLessThan(1024);
  }
});
