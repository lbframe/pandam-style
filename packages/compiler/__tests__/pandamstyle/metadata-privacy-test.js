/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-03.1 AC3: private values and entities do not reach consumer views
 * (design note §3.7.1, §3.9.1, §3.10, §5.1). Sentinels through the view and
 * the generated artifacts; the private-name rule over every free and literal
 * string position (R1); audience-safe diagnostics through the SDK, formatted
 * output and the AG-01.1 `check` and `records.read` operations (R5).
 */

'use strict';

const {
  compiler,
  T,
  attempt,
  baseDefinition,
  failures,
  fullMeta,
  sessionResult,
} = require('./metadata-helpers');
const {
  definitionWith,
  openAgentProject,
  readRecord,
} = require('./agent-helpers');
const { openProject } = require('./session-helpers');

jest.setTimeout(300000);

const SENTINEL = 'Zqsentinelzq';
// Every author name a private entity of the fixture has.
const PRIVATE_NAMES = [
  'colors.ink',
  'zzsecret',
  'hiddenPanel',
  'inner',
  'mood',
  'calm',
];

function privateFixture() {
  const definition = baseDefinition();
  definition.recipes.hiddenPanel = {
    visibility: 'private',
    base: { color: T('colors.ink') },
  };
  definition.tokens.colors.ink.meta = {
    description: `Raw ink ${SENTINEL}.`,
    terms: ['ink'],
  };
  definition.recipes.zzsecret.meta = {
    description: `Internal ${SENTINEL} recipe.`,
    slots: { inner: { usage: [`Inner ${SENTINEL} slot.`] } },
    variants: {
      mood: {
        meta: { description: `Mood ${SENTINEL}.` },
        values: { calm: { description: `Calm ${SENTINEL}.` } },
      },
    },
  };
  definition.tokens.colors.paper.meta = fullMeta('token');
  definition.recipes.button.meta = fullMeta('recipe');
  return definition;
}

describe('AC3: private entities and their metadata stay out of consumer outputs', () => {
  test('the consumer view lists no private entity, name or metadata; the author view lists them', () => {
    const { ds } = attempt(privateFixture());
    const consumer = JSON.stringify(
      compiler.semanticsViewOf(ds.snapshot, { audience: 'consumer' }),
    );
    for (const name of [SENTINEL, ...PRIVATE_NAMES])
      expect(consumer).not.toContain(name);
    expect(consumer).toContain('The token entity, described.');
    const author = JSON.stringify(
      compiler.semanticsViewOf(ds.snapshot, { audience: 'author' }),
    );
    expect(author).toContain(SENTINEL);
    expect(author).toContain('"visibility":"private"');
  });

  test('the five generated artifacts and the manifest carry no metadata at all', async () => {
    const { files, ok } = await sessionResult(privateFixture());
    expect(ok).toBe(true);
    const text = Object.values(files).join('\n');
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('The token entity, described.');
    for (const name of ['zzsecret', 'hiddenPanel'])
      expect(text).not.toContain(name);
  });

  test('public metadata cannot reference or exemplify a private entity; private metadata may reference public', () => {
    const diagnostics = failures(
      (() => {
        const d = privateFixture();
        d.tokens.colors.paper.meta = {
          relations: [
            {
              relation: 'related',
              target: { recipe: 'zzsecret', variant: 'mood' },
            },
          ],
          deprecated: { replacement: { token: 'colors.ink' } },
        };
        d.conditions.wide.meta = {
          examples: [{ property: 'color', value: { token: 'colors.ink' } }],
        };
        return d;
      })(),
    );
    expect(diagnostics.map((d) => d.rule)).toEqual([
      'metadata.private-reference',
      'metadata.private-reference',
    ]);
    const ok = privateFixture();
    ok.tokens.colors.ink.meta = {
      relations: [{ relation: 'related', target: { token: 'colors.paper' } }],
    };
    expect(attempt(ok).diagnostics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R1: every free (a) and literal (c) string position, every variant.

// Each places `text` at one string position of a consumer-visible entity.
const FREE_POSITIONS = {
  description: (d, text) =>
    (d.tokens.colors.paper.meta = { description: text }),
  usage: (d, text) => (d.tokens.colors.paper.meta = { usage: [text] }),
  restrictions: (d, text) => (d.themes.dark.meta = { restrictions: [text] }),
  'deprecated.reason': (d, text) =>
    (d.conditions.wide.meta = { deprecated: { reason: text } }),
  'component module': (d, text) =>
    (d.recipes.button.meta = {
      relations: [
        {
          relation: 'implemented-by',
          target: {
            component: {
              module: `src/${text.replace(/[^A-Za-z0-9.-]+/g, '-')}/x.tsx`,
              export: 'X',
            },
          },
        },
      ],
    }),
  'system description': (d, text) => (d.meta = { description: text }),
  'pattern usage': (d, text) =>
    (d.meta = { patterns: { stack: { usage: [text] } } }),
  'slot description': (d, text) =>
    (d.recipes.card.meta = { slots: { label: { description: text } } }),
  'value description': (d, text) =>
    (d.recipes.button.meta = {
      variants: { tone: { values: { danger: { description: text } } } },
    }),
  'property description': (d, text) =>
    (d.propertyDomains.width.meta = { description: text }),
};
const IDENTIFIER_POSITIONS = {
  semanticRole: (d, id) => (d.tokens.colors.paper.meta = { semanticRole: id }),
  terms: (d, id) => (d.tokens.colors.paper.meta = { terms: [id] }),
  'component export': (d, id) =>
    (d.recipes.button.meta = {
      relations: [
        {
          relation: 'implemented-by',
          target: { component: { module: 'src/x.tsx', export: id } },
        },
      ],
    }),
};
const LITERAL_POSITIONS = {
  'condition example value': (d, text) =>
    (d.conditions.wide.meta = {
      examples: [{ property: 'color', value: text }],
    }),
  'property example value': (d, text) =>
    (d.propertyDomains.width.meta = { examples: [{ value: text }] }),
  'pattern parameter': (d, text) =>
    (d.meta = {
      patterns: { stack: { examples: [{ parameters: { align: text } }] } },
    }),
  'pattern responsive parameter': (d, text) =>
    (d.meta = {
      patterns: {
        stack: { examples: [{ parameters: { align: { wide: text } } }] },
      },
    }),
};

const NAMING = [
  ['exact token id', 'Use colors.ink here'],
  ['trailing punctuation', 'Use colors.ink.'],
  ['other separators', 'Colors/Ink is reserved'],
  ['other case', 'COLORS_INK'],
  ['exact recipe id', 'Wraps zzsecret'],
  ['camelCase split', 'the hidden panel style'],
];
const NOT_NAMING = [
  ['letter extension', 'colors.inkwell and zzsecretive'],
  ['partial path', 'ink is a word'],
];

function privateIdentifierRules(place, text) {
  const definition = privateFixture();
  place(definition, text);
  const result = attempt(definition);
  return (result.diagnostics ?? []).map((d) => [
    d.rule,
    d.context.privateKind ?? null,
  ]);
}

describe('R1: no published string names a private token or recipe', () => {
  for (const [position, place] of Object.entries({
    ...FREE_POSITIONS,
    ...LITERAL_POSITIONS,
  })) {
    for (const [variant, text] of NAMING) {
      test(`${position}: ${variant} is rejected`, () => {
        const rules = privateIdentifierRules(place, text);
        expect(
          rules.filter(([rule]) => rule === 'metadata.private-identifier')
            .length,
        ).toBe(1);
      });
    }
    for (const [variant, text] of NOT_NAMING) {
      test(`${position}: ${variant} is accepted by the name rule`, () => {
        const rules = privateIdentifierRules(place, text);
        expect(
          rules.filter(([rule]) => rule === 'metadata.private-identifier'),
        ).toEqual([]);
      });
    }
  }
  for (const [position, place] of Object.entries(IDENTIFIER_POSITIONS)) {
    test(`${position}: a private recipe id is rejected`, () => {
      expect(privateIdentifierRules(place, 'zzsecret')).toEqual([
        ['metadata.private-identifier', 'recipe'],
      ]);
    });
  }

  test('the diagnostic names the kind, never the private id or the text', () => {
    const definition = privateFixture();
    FREE_POSITIONS.description(definition, `Use colors.ink ${SENTINEL}`);
    const [d] = failures(definition);
    expect(d.context).toEqual({
      entity: { token: 'colors.paper' },
      field: ['description'],
      privateKind: 'token',
    });
    expect(JSON.stringify(d)).not.toContain('ink');
    expect(JSON.stringify(d)).not.toContain(SENTINEL);
  });

  test('a vocabulary (b) name equal to a private id is not name-matched', () => {
    const definition = privateFixture();
    definition.recipes.card.slots.push('zzsecret');
    definition.recipes.card.base.zzsecret = {};
    definition.recipes.card.meta = {
      slots: { zzsecret: { description: 'A public slot.' } },
      examples: [{ slot: 'zzsecret' }],
    };
    expect(attempt(definition).diagnostics).toBeUndefined();
  });

  test('every string position the schema allows is classified (fail closed otherwise)', () => {
    const everything = {
      description: 'd',
      usage: ['u'],
      restrictions: ['r'],
      terms: ['t'],
      semanticRole: 'role',
      relations: [
        {
          relation: 'related',
          target: { recipe: 'card', variant: 'density', value: 'compact' },
        },
        {
          relation: 'implemented-by',
          target: { component: { module: 'src/a.tsx', export: 'A' } },
        },
      ],
      deprecated: {
        reason: 'old',
        replacement: { recipe: 'card', slot: 'root' },
      },
      examples: [
        { property: 'color', condition: 'wide' },
        { property: 'color', value: { token: 'colors.paper' } },
        { value: 'auto' },
        {
          parameters: {
            align: 'center',
            gap: { token: 'spacing.sm' },
            justify: { wide: 'end' },
          },
        },
        { select: { tone: 'danger' }, slot: 'root' },
      ],
    };
    const strings = [];
    const walk = (value, path) => {
      if (typeof value === 'string') strings.push(path);
      else if (Array.isArray(value))
        value.forEach((v, i) => walk(v, [...path, i]));
      else if (value && typeof value === 'object')
        for (const k of Object.keys(value)) walk(value[k], [...path, k]);
    };
    walk(everything, []);
    expect(strings.length).toBeGreaterThan(20);
    for (const path of strings)
      expect([path, compiler.stringClassOf(path)]).not.toEqual([path, null]);
    // Every field of every kind is in `everything`.
    const covered = new Set(Object.keys(everything));
    for (const fields of Object.values(compiler.FIELDS))
      for (const field of fields)
        if (!['slots', 'variants', 'patterns'].includes(field))
          expect(covered.has(field)).toBe(true);
    expect(compiler.stringClassOf(['invented'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R5: audience-safe diagnostics on every consumer path.

// Every rule that can fire on a private entity, each on a private token,
// private recipe and that recipe's slot, axis and value.
function privateFailures(definition) {
  const colors = definition.tokens.colors;
  colors.ink.meta = {
    visibility: 'x',
    usage: [],
    description: `bad\n${SENTINEL}`,
  };
  colors.secret2 = {
    value: '#000',
    visibility: 'private',
    meta: { deprecated: { replacement: { token: 'colors.secret2' } } },
  };
  colors.secret3 = {
    value: '#000',
    visibility: 'private',
    meta: {
      relations: [
        { relation: 'related', target: { token: 'colors.secret3' } },
        { relation: 'related', target: { theme: SENTINEL } },
      ],
    },
  };
  colors.secret4 = {
    value: '#000',
    visibility: 'private',
    // eslint-disable-next-line no-sparse-arrays
    meta: { usage: [, SENTINEL] },
  }; // eslint-disable-line no-sparse-arrays
  definition.recipes.zzsecret.meta = {
    relations: [{ relation: 'implemented-by', target: { recipe: 'card' } }],
    deprecated: { replacement: { theme: 'dark' } },
    slots: { inner: { description: ` ${SENTINEL}` } },
    variants: {
      mood: {
        meta: { terms: ['Bad Term'] },
        values: { calm: { [SENTINEL]: 1 } },
      },
    },
  };
  definition.recipes.hiddenPanel = {
    visibility: 'private',
    base: {},
    meta: { slots: { ghost: {} } },
  };
  return definition;
}

function expectSafe(serialized) {
  for (const name of [
    SENTINEL,
    ...PRIVATE_NAMES,
    'secret2',
    'secret3',
    'secret4',
    'ghost',
  ])
    expect([name, serialized.includes(name)]).toEqual([name, false]);
}

describe('R5: metadata diagnostics never show a private identity', () => {
  test('safe form at the source: ordinals, index fields, constant source, generic messages', () => {
    const definition = privateFailures(baseDefinition());
    const diagnostics = failures(definition);
    expect(diagnostics.length).toBeGreaterThanOrEqual(9);
    expectSafe(JSON.stringify(diagnostics));
    expectSafe(diagnostics.map((d) => compiler.formatDiagnostic(d)).join('\n'));
    const kinds = new Set();
    for (const d of diagnostics) {
      expect(d.code).toBe('PMS_INVALID_METADATA');
      expect(d.source).toBe('design-system');
      const entity = d.context.entity;
      expect(entity).toMatchObject({ visibility: 'private' });
      expect(Object.keys(entity).sort()).toEqual([
        'kind',
        'ordinal',
        'visibility',
      ]);
      kinds.add(entity.kind);
      // The author maps it back from the definition.
      const address = compiler.resolvePrivateEntity(definition, entity);
      expect(address).not.toBeNull();
    }
    expect([...kinds].sort()).toEqual([
      'axis',
      'recipe',
      'slot',
      'token',
      'value',
    ]);
    const rules = new Set(diagnostics.map((d) => d.rule));
    for (const rule of [
      'metadata.unknown-field',
      'metadata.field-type',
      'metadata.text',
      'metadata.unknown-child',
      'metadata.malformed',
      'metadata.self-reference',
      'metadata.unknown-reference',
      'metadata.reference-kind',
      'metadata.replacement-kind',
      'metadata.replacement-cycle',
    ])
      expect([rule, rules.has(rule)]).toEqual([rule, true]);
  });

  test('resolvePrivateEntity follows the documented canonical order', () => {
    const definition = privateFailures(baseDefinition());
    const order = compiler.privateEntityOrder(definition);
    const tokens = [...order]
      .filter(([, v]) => v.kind === 'token')
      .map(([k]) => JSON.parse(k).token);
    expect(tokens).toEqual([
      'colors.ink',
      'colors.secret2',
      'colors.secret3',
      'colors.secret4',
    ]);
    expect(
      compiler.resolvePrivateEntity(definition, {
        kind: 'token',
        visibility: 'private',
        ordinal: 2,
      }),
    ).toEqual({ token: 'colors.secret3' });
    expect(
      compiler.resolvePrivateEntity(definition, {
        kind: 'token',
        visibility: 'private',
        ordinal: 9,
      }),
    ).toBeNull();
  });

  test('invalid private metadata through a private example: the cause is constant, the entity is safe', () => {
    const definition = baseDefinition();
    definition.tokens.colors.ink.meta = { examples: [{ property: 'width' }] };
    const [d] = failures(definition);
    expect(d.rule).toBe('metadata.invalid-example');
    expect(d.context.entity).toEqual({
      kind: 'token',
      visibility: 'private',
      ordinal: 0,
    });
    expectSafe(JSON.stringify(d));
  });

  test('through the SDK validate(), the AG-01.1 check listing and the records.read full record', async () => {
    const project = await openAgentProject('valid', {
      definition: (() => {
        const fixture = openProject('valid');
        return definitionWith(fixture, (definition) => {
          definition.tokens.colors.ink = {
            value: '#172033',
            visibility: 'private',
          };
          definition.recipes = { ...(definition.recipes ?? {}) };
          definition.recipes.zzsecret = {
            visibility: 'private',
            slots: ['inner'],
            base: { inner: {} },
            variants: { mood: { calm: {} } },
          };
          privateFailures(definition);
        });
      })(),
    });
    try {
      const rev = await project.revision();
      const sdk = await project.session.validate(rev);
      expect(sdk.ok).toBe(false);
      expect(
        sdk.diagnostics.some((d) => d.code === 'PMS_INVALID_METADATA'),
      ).toBe(true);
      expectSafe(JSON.stringify(sdk));

      const listing = await project.dispatch(
        'check',
        { rev },
        { view: 'detail' },
      );
      expect(listing.outcome).toBe('constraint-violation');
      expect(listing.failure.stage).toBe('bootstrap');
      expectSafe(JSON.stringify(listing));
      const total = listing.result.document.diagnosticsTotal;
      expect(total).toBeGreaterThanOrEqual(9);
      for (let index = 0; index < total; index++) {
        const record = await readRecord(
          project.dispatch,
          rev,
          { kind: 'diagnostic', index },
          262144,
        );
        expectSafe(record.text);
        expect(JSON.parse(record.text).code).toBe('PMS_INVALID_METADATA');
      }
    } finally {
      await project.close();
    }
  });
});
