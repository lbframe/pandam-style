/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-03.1 AC1: each supported kind round-trips declared metadata without
 * invented meaning (design note §3.10, §5.1). Also the child-container
 * injectivity (R2, I12), the CE-02.1 §9.2 presence test as amended by #138,
 * and the session behaviour on a metadata-only edit (§3.12).
 */

'use strict';

const {
  compiler,
  attempt,
  baseDefinition,
  canonical,
  clone,
  failures,
  fullMeta,
  sessionResult,
} = require('./metadata-helpers');
const { openProject, makeParseCounter } = require('./session-helpers');

jest.setTimeout(120000);

// One row per supported position (design note §3.2). `place` puts a meta
// value at the position; `stored` reads it back from `registry.semantics`;
// `address` is the view address of the entity.
const POSITIONS = [
  {
    kind: 'system',
    address: { system: true },
    place: (d, m) => (d.meta = m),
    stored: (s) => (Object.hasOwn(s, 'system') ? [s.system] : []),
  },
  {
    kind: 'token',
    address: { token: 'colors.text.primary' },
    place: (d, m) => (d.tokens.colors.text.primary.meta = m),
    stored: (s) => present(s.tokens, 'colors.text.primary'),
  },
  {
    kind: 'theme',
    address: { theme: 'dark' },
    place: (d, m) => (d.themes.dark.meta = m),
    stored: (s) => present(s.themes, 'dark'),
  },
  {
    kind: 'condition',
    address: { condition: 'wide' },
    place: (d, m) => (d.conditions.wide.meta = m),
    stored: (s) => present(s.conditions, 'wide'),
  },
  {
    kind: 'recipe',
    address: { recipe: 'button' },
    place: (d, m) => (d.recipes.button.meta = m),
    stored: (s) => present(s.recipes, 'button'),
  },
  {
    kind: 'slot',
    address: { recipe: 'card', slot: 'label' },
    place: (d, m) => (d.recipes.card.meta = { slots: { label: m } }),
    stored: (s) => present(s.recipes.card?.slots ?? {}, 'label'),
  },
  {
    kind: 'axis',
    address: { recipe: 'button', variant: 'tone' },
    place: (d, m) =>
      (d.recipes.button.meta = { variants: { tone: { meta: m } } }),
    stored: (s) => present(s.recipes.button?.variants?.tone ?? {}, 'meta'),
  },
  {
    kind: 'value',
    address: { recipe: 'button', variant: 'tone', value: 'danger' },
    place: (d, m) =>
      (d.recipes.button.meta = {
        variants: { tone: { values: { danger: m } } },
      }),
    stored: (s) =>
      present(s.recipes.button?.variants?.tone?.values ?? {}, 'danger'),
  },
  {
    kind: 'pattern',
    address: { pattern: 'stack' },
    place: (d, m) => (d.meta = { patterns: { stack: m } }),
    stored: (s) => present(s.system?.patterns ?? {}, 'stack'),
  },
  {
    kind: 'property',
    address: { property: 'width' },
    place: (d, m) => (d.propertyDomains.width.meta = m),
    stored: (s) => present(s.propertyDomains, 'width'),
  },
];

function present(map, key) {
  return Object.hasOwn(map, key) ? [map[key]] : [];
}

const viewEntry = (ds, address, audience = 'author') =>
  compiler
    .semanticsViewOf(ds.snapshot, { audience })
    .entities.find((entry) => canonical(entry.entity) === canonical(address));

describe('AC1: every supported position round-trips its declared metadata', () => {
  test('the position table covers every entity kind the compiler knows', () => {
    expect(POSITIONS.map((p) => p.kind).sort()).toEqual(
      Object.keys(compiler.FIELDS).sort(),
    );
  });

  const STATES = [
    ['absent', undefined],
    ['empty', {}],
    ['full', 'full'],
  ];
  for (const position of POSITIONS) {
    for (const [state, value] of STATES) {
      test(`${position.kind}: ${state}`, () => {
        const definition = baseDefinition();
        const meta = value === 'full' ? fullMeta(position.kind) : value;
        if (meta !== undefined) position.place(definition, clone(meta));
        const { ds, diagnostics } = attempt(definition);
        expect(diagnostics).toBeUndefined();
        const stored = position.stored(ds.registry.semantics);
        const entry = viewEntry(ds, position.address);
        expect(entry).toBeDefined();
        if (meta === undefined) {
          expect(stored).toEqual([]);
          expect(Object.hasOwn(entry, 'meta')).toBe(false);
          return;
        }
        expect(stored).toHaveLength(1);
        expect(canonical(stored[0])).toBe(canonical(meta));
        expect(Object.isFrozen(stored[0])).toBe(true);
        expect(Object.keys(entry.meta).sort()).toEqual(
          Object.keys(meta).sort(),
        );
        expect(canonical(entry.meta)).toBe(canonical(meta));
      });
    }
  }

  test('a definition without metadata has empty side tables and no meta key in any view entry', () => {
    const { ds } = attempt(baseDefinition());
    const s = ds.registry.semantics;
    expect(Object.hasOwn(s, 'system')).toBe(false);
    for (const table of [
      'tokens',
      'themes',
      'conditions',
      'recipes',
      'propertyDomains',
    ]) {
      expect(Object.keys(s[table])).toEqual([]);
      expect(Object.getPrototypeOf(s[table])).toBeNull();
    }
    for (const audience of ['consumer', 'author']) {
      const view = compiler.semanticsViewOf(ds.snapshot, { audience });
      expect(view.entities.length).toBeGreaterThan(0);
      for (const entry of view.entities)
        expect(Object.hasOwn(entry, 'meta')).toBe(false);
    }
  });

  test('text and arrays are stored byte for byte and in author order', () => {
    const definition = baseDefinition();
    const meta = {
      description: 'Ünïcödé text — kept as written, “quoted” too.',
      usage: ['zeta comes first', 'alpha second'],
      terms: ['zeta', 'alpha'],
    };
    definition.tokens.colors.paper.meta = meta;
    const { ds } = attempt(definition);
    const stored = ds.registry.semantics.tokens['colors.paper'];
    expect(stored.description).toBe(meta.description);
    expect(stored.usage).toEqual(meta.usage);
    expect(stored.terms).toEqual(meta.terms);
  });

  test('through a public session revision, metadata validates and no generated byte changes', async () => {
    const plain = await sessionResult(baseDefinition());
    const definition = baseDefinition();
    for (const position of POSITIONS) {
      if (
        position.kind === 'slot' ||
        position.kind === 'axis' ||
        position.kind === 'value' ||
        position.kind === 'pattern'
      )
        continue;
      position.place(definition, clone(fullMeta(position.kind)));
    }
    definition.recipes.card.meta = { slots: { label: fullMeta('slot') } };
    const described = await sessionResult(definition);
    expect(plain.ok).toBe(true);
    expect(described.ok).toBe(true);
    expect(described.diagnostics).toEqual([]);
    expect(Object.keys(described.files)).toEqual(Object.keys(plain.files));
    for (const kind of Object.keys(plain.files))
      expect([kind, described.files[kind]]).toEqual([kind, plain.files[kind]]);
  });
});

// ---------------------------------------------------------------------------
// R2 / I12: absent, empty and populated child containers at every level.

function recipeStates() {
  const states = [];
  const slotOptions = [
    undefined,
    {},
    { label: {} },
    { label: { description: 'Label slot.' } },
  ];
  const axisMetaOptions = [undefined, {}, { description: 'Tone axis.' }];
  const valuesOptions = [undefined, {}, { compact: {} }];
  for (const own of [{}, { description: 'The card.' }])
    for (const slots of slotOptions)
      for (const variants of ['absent', 'empty', 'axis'])
        for (const axisMeta of axisMetaOptions)
          for (const values of valuesOptions) {
            if (
              variants !== 'axis' &&
              (axisMeta !== undefined || values !== undefined)
            )
              continue;
            const meta = { ...own };
            if (slots !== undefined) meta.slots = slots;
            if (variants === 'empty') meta.variants = {};
            if (variants === 'axis') {
              const entry = {};
              if (axisMeta !== undefined) entry.meta = axisMeta;
              if (values !== undefined) entry.values = values;
              meta.variants = { density: entry };
            }
            states.push(meta);
          }
  return states;
}

function rebuildRecipe(view, recipeId) {
  const entries = view.entities.filter((e) => e.entity.recipe === recipeId);
  const recipe = entries.find((e) => Object.keys(e.entity).length === 1);
  if (!Object.hasOwn(recipe, 'meta')) return undefined;
  const out = { ...recipe.meta };
  for (const e of entries) {
    if (!Object.hasOwn(e, 'meta')) continue;
    if (e.entity.slot !== undefined) (out.slots ??= {})[e.entity.slot] = e.meta;
    else if (e.entity.value !== undefined)
      (((out.variants ??= {})[e.entity.variant] ??= {}).values ??= {})[
        e.entity.value
      ] = e.meta;
    else if (e.entity.variant !== undefined)
      ((out.variants ??= {})[e.entity.variant] ??= {}).meta = e.meta;
  }
  return out;
}

describe('R2 / I12: the view is injective on valid states and rebuilds them exactly', () => {
  test('every empty child container is rejected; every valid state round-trips; no two valid states project equally', () => {
    const seen = new Map();
    let valid = 0;
    let rejected = 0;
    for (const meta of recipeStates()) {
      const definition = baseDefinition();
      definition.recipes.card.meta = clone(meta);
      const result = attempt(definition);
      const emptyContainer =
        (meta.slots && Object.keys(meta.slots).length === 0) ||
        (meta.variants && Object.keys(meta.variants).length === 0) ||
        Object.values(meta.variants ?? {}).some(
          (entry) =>
            Object.keys(entry).length === 0 ||
            (entry.values && Object.keys(entry.values).length === 0),
        );
      if (emptyContainer) {
        rejected++;
        expect(result.ds).toBeUndefined();
        for (const d of result.diagnostics) {
          expect(d.rule).toBe('metadata.field-type');
          expect(['empty-map', 'empty-axis-entry']).toContain(d.context.reason);
        }
        continue;
      }
      valid++;
      expect(result.diagnostics).toBeUndefined();
      const view = compiler.semanticsViewOf(result.ds.snapshot, {
        audience: 'author',
      });
      expect(canonical(rebuildRecipe(view, 'card'))).toBe(canonical(meta));
      const projection = canonical(
        view.entities.filter((e) => e.entity.recipe === 'card'),
      );
      expect(seen.has(projection)).toBe(false);
      seen.set(projection, canonical(meta));
    }
    expect(valid).toBeGreaterThan(10);
    expect(rejected).toBeGreaterThan(10);
  });

  test('system patterns: absent, empty (rejected) and populated', () => {
    const empty = baseDefinition();
    empty.meta = { patterns: {} };
    expect(failures(empty).map((d) => [d.rule, d.context.reason])).toEqual([
      ['metadata.field-type', 'empty-map'],
    ]);
    const populated = baseDefinition();
    populated.meta = { patterns: { stack: {} } };
    const { ds } = attempt(populated);
    const view = compiler.semanticsViewOf(ds.snapshot);
    expect(viewEntry(ds, { system: true }, 'consumer').meta).toEqual({});
    expect(
      view.entities.find((e) => e.entity.pattern === 'stack').meta,
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// CE-02.1 §9.2, as amended by #138 (design note §3.1.1).

describe('CE-02.1 §9.2: propertyDomains meta presence, stored outside the domain', () => {
  const variants = {
    absent: undefined,
    empty: {},
    populated: {
      description: 'Widths of layout containers.',
      examples: [{ value: 'auto' }],
    },
  };
  const built = Object.fromEntries(
    Object.entries(variants).map(([name, meta]) => {
      const definition = baseDefinition();
      if (meta !== undefined) definition.propertyDomains.width.meta = meta;
      return [name, attempt(definition)];
    }),
  );

  test('normalizePropertyDomains accepts meta and keeps it out of the normalized entry', () => {
    const { propertyDomains, diagnostics } = compiler.normalizePropertyDomains(
      { width: { values: ['auto'], meta: { description: 'x' } } },
      {},
    );
    expect(diagnostics).toEqual([]);
    expect(Object.hasOwn(propertyDomains.width, 'meta')).toBe(false);
  });

  test('absent and {} stay distinct in registry.semantics.propertyDomains', () => {
    expect(
      Object.hasOwn(
        built.absent.ds.registry.semantics.propertyDomains,
        'width',
      ),
    ).toBe(false);
    expect(built.empty.ds.registry.semantics.propertyDomains.width).toEqual({});
    expect(
      canonical(built.populated.ds.registry.semantics.propertyDomains.width),
    ).toBe(canonical(variants.populated));
  });

  test('no meta in the normalized entry, the effective row or snapshot.properties; digests byte-identical', () => {
    const reference = built.absent.ds.snapshot;
    for (const name of ['empty', 'populated']) {
      const snapshot = built[name].ds.snapshot;
      expect(
        Object.hasOwn(snapshot.registry.propertyDomains.width, 'meta'),
      ).toBe(false);
      expect(JSON.stringify(snapshot.properties)).not.toContain('"meta"');
      for (const row of Object.values(snapshot.properties.descriptors))
        expect(Object.hasOwn(row, 'meta')).toBe(false);
      expect(snapshot.identity.registryDigest).toBe(
        reference.identity.registryDigest,
      );
      expect(snapshot.properties.digest).toBe(reference.properties.digest);
    }
  });
});

// ---------------------------------------------------------------------------

describe('a metadata-only edit (§3.12)', () => {
  test('revalidates no page and changes no generated byte', () => {
    const h = openProject('valid');
    const collector = makeParseCounter();
    const uninstall = h.compiler.installPerfCollector(collector);
    try {
      expect(h.revise({ initial: true }).ok).toBe(true);
      const definition = h.reloadDefinition();
      definition.meta = { description: 'Conformance vocabulary.' };
      definition.tokens.spacing.md.meta = { usage: ['Default gap.'] };
      collector.reset();
      const revision = h.revise({ definition });
      expect(revision.ok).toBe(true);
      expect(collector.events).toEqual([]);
      expect(revision.counters.filesReparsed).toBe(0);
      expect(revision.counters.filesRecompiled).toBe(0);
    } finally {
      uninstall();
      h.session.close();
    }
  });
});
