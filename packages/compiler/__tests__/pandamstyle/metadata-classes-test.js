/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-03.1 fix round 1 (review of PR #153): one class-level block per finding.
 *
 * - B1 author-keyed maps copied with assignment (prototype setters, dropped keys);
 * - B2 identity of compound addresses not canonical;
 * - B3 prototype-bearing lookups on author-keyed maps;
 * - B4 metadata traversal not aligned with the compiler's collection shapes;
 * - B5 unguarded reflective operations on author objects;
 * - B6 a size bound computed with another serializer than the one that emits.
 *
 * Plus the CE owner's public-API boundary between `definition.shape` and
 * `PMS_INVALID_PROPERTY_DOMAIN`.
 */

'use strict';

const {
  compiler,
  attempt,
  baseDefinition,
  canonical,
  failures,
  sessionResult,
} = require('./metadata-helpers');

jest.setTimeout(120000);

const rules = (diagnostics) => (diagnostics ?? []).map((d) => d.rule);
const publicBuild = (definition) =>
  attempt(compiler.snapshotDefinition(definition));
const UNUSUAL = ['__proto__', 'constructor', 'prototype'];
const withKey = (key, value) =>
  JSON.parse(
    JSON.stringify({ [`K${key}`]: value }).replace(
      `"K${key}"`,
      JSON.stringify(key),
    ),
  );

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
const reorder = (address, order) =>
  Object.fromEntries(order.map((key) => [key, address[key]]));

// ---------------------------------------------------------------------------

describe('B1: author keys are created as own properties, never assigned', () => {
  for (const key of UNUSUAL) {
    test(`a pattern parameter named ${key} carrying a private token is refused (public ingress)`, () => {
      const d = baseDefinition();
      d.meta = {
        patterns: {
          stack: {
            examples: [{ parameters: withKey(key, { token: 'colors.ink' }) }],
          },
        },
      };
      const { diagnostics } = publicBuild(d);
      expect(rules(diagnostics)).toEqual(['metadata.invalid-example']);
      expect(JSON.stringify(diagnostics)).not.toContain('colors.ink');
    });

    test(`a responsive condition named ${key} in a pattern parameter is refused`, () => {
      const d = baseDefinition();
      d.meta = {
        patterns: {
          stack: {
            examples: [
              { parameters: { gap: withKey(key, { token: 'spacing.sm' }) } },
            ],
          },
        },
      };
      expect(rules(publicBuild(d).diagnostics)).toEqual([
        'metadata.invalid-example',
      ]);
    });

    test(`a select axis named ${key} is refused`, () => {
      const d = baseDefinition();
      d.recipes.button.meta = {
        examples: [{ select: withKey(key, 'danger') }],
      };
      expect(rules(publicBuild(d).diagnostics)).toEqual([
        'metadata.invalid-example',
      ]);
    });

    test(`a meta field named ${key} is an unknown field, not dropped`, () => {
      const d = baseDefinition();
      d.tokens.colors.paper.meta = withKey(key, { description: 'x' });
      expect(rules(publicBuild(d).diagnostics)).toEqual([
        'metadata.unknown-field',
      ]);
    });

    test(`an address with an extra ${key} field is a reference-shape error`, () => {
      const d = baseDefinition();
      d.tokens.colors.paper.meta = {
        relations: [
          {
            relation: 'related',
            target: { token: 'spacing.sm', ...withKey(key, 'colors.ink') },
          },
        ],
      };
      const { diagnostics } = publicBuild(d);
      expect(diagnostics.map((x) => [x.rule, x.context.reason])).toEqual([
        ['metadata.field-type', 'reference-shape'],
      ]);
    });
  }

  test('a variant value named __proto__ keeps its own metadata through storage and the view', () => {
    const d = baseDefinition();
    d.recipes.button.variants.tone = withKey('__proto__', {});
    d.recipes.button.variants.tone.ok = {};
    d.recipes.button.meta = {
      variants: {
        tone: { values: withKey('__proto__', { description: 'Proto value.' }) },
      },
    };
    const { ds } = publicBuild(d);
    const stored = ds.registry.semantics.recipes.button.variants.tone.values;
    expect(Object.getOwnPropertyNames(stored)).toEqual(['__proto__']);
    const view = compiler.semanticsViewOf(ds.snapshot);
    const entry = view.entities.find((e) => e.entity.value === '__proto__');
    expect(entry.meta).toEqual({ description: 'Proto value.' });
    expect(
      view.entities.find((e) => e.entity.value === 'ok').meta,
    ).toBeUndefined();
  });

  test('through a public session, the private token in a __proto__ parameter fails validation', async () => {
    const d = baseDefinition();
    d.meta = {
      patterns: {
        stack: {
          examples: [
            { parameters: withKey('__proto__', { token: 'colors.ink' }) },
          ],
        },
      },
    };
    const { ok, diagnostics } = await sessionResult(d);
    expect(ok).toBe(false);
    expect(diagnostics.map((x) => x.rule)).toEqual([
      'metadata.invalid-example',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('B2: compound addresses have one canonical identity', () => {
  const COMPOUND = {
    slot: { recipe: 'card', slot: 'label' },
    axis: { recipe: 'button', variant: 'tone' },
    value: { recipe: 'button', variant: 'tone', value: 'danger' },
  };
  const place = (d, kind, meta) => {
    if (kind === 'slot') d.recipes.card.meta = { slots: { label: meta } };
    if (kind === 'axis')
      d.recipes.button.meta = { variants: { tone: { meta } } };
    if (kind === 'value')
      d.recipes.button.meta = {
        variants: { tone: { values: { danger: meta } } },
      };
  };

  for (const [kind, address] of Object.entries(COMPOUND)) {
    for (const order of permutations(Object.keys(address))) {
      const target = reorder(address, order);
      const label = `${kind} [${order.join(',')}]`;

      test(`${label}: self-reference is found`, () => {
        const d = baseDefinition();
        place(d, kind, { relations: [{ relation: 'related', target }] });
        expect(rules(failures(d))).toEqual(['metadata.self-reference']);
      });

      test(`${label}: self-replacement is a cycle of length 1`, () => {
        const d = baseDefinition();
        place(d, kind, { deprecated: { replacement: target } });
        const [x] = failures(d);
        expect([x.rule, x.context.cycleLength]).toEqual([
          'metadata.replacement-cycle',
          1,
        ]);
        expect(Object.keys(x.context.entity)).toEqual(Object.keys(address));
      });

      test(`${label}: duplicate relations are found whatever the field order`, () => {
        const d = baseDefinition();
        d.tokens.spacing.sm.meta = {
          relations: [
            { relation: 'related', target: address },
            { relation: 'related', target },
          ],
        };
        expect(failures(d).map((x) => x.context.reason)).toEqual(['duplicate']);
      });
    }
  }

  test('value replacement cycle with reordered fields, also through a public session', async () => {
    const d = baseDefinition();
    d.recipes.button.meta = {
      variants: {
        tone: {
          values: {
            neutral: {
              deprecated: {
                replacement: {
                  value: 'danger',
                  variant: 'tone',
                  recipe: 'button',
                },
              },
            },
            danger: {
              deprecated: {
                replacement: {
                  variant: 'tone',
                  recipe: 'button',
                  value: 'neutral',
                },
              },
            },
          },
        },
      },
    };
    const [x] = failures(d);
    expect([x.rule, x.context.cycleLength]).toEqual([
      'metadata.replacement-cycle',
      2,
    ]);
    const { ok, diagnostics } = await sessionResult(d);
    expect(ok).toBe(false);
    expect(diagnostics.map((y) => y.rule)).toEqual([
      'metadata.replacement-cycle',
    ]);
  });

  test('component targets: module/export order does not change identity', () => {
    const d = baseDefinition();
    d.recipes.button.meta = {
      relations: [
        {
          relation: 'implemented-by',
          target: { component: { module: 'src/a.tsx', export: 'A' } },
        },
        {
          relation: 'implemented-by',
          target: { component: { export: 'A', module: 'src/a.tsx' } },
        },
      ],
    };
    expect(failures(d).map((x) => x.context.reason)).toEqual(['duplicate']);
  });

  test('canonicalAddress orders fields one way for every permutation', () => {
    for (const address of Object.values(COMPOUND))
      for (const order of permutations(Object.keys(address)))
        expect(
          JSON.stringify(compiler.canonicalAddress(reorder(address, order))),
        ).toBe(JSON.stringify(address));
  });
});

// ---------------------------------------------------------------------------

describe('B3: no lookup on an author-keyed map inherits from Object.prototype', () => {
  const PROTO_NAMES = [
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    '__proto__',
    'isPrototypeOf',
  ];

  test('variant values named like Object.prototype members: partial metadata stays partial', () => {
    for (const name of PROTO_NAMES) {
      const d = baseDefinition();
      d.recipes.button.variants.tone = withKey(name, {});
      d.recipes.button.variants.tone.ok = {};
      d.recipes.button.meta = {
        variants: { tone: { values: { ok: { description: 'Okay.' } } } },
      };
      const { ds, diagnostics } = publicBuild(d);
      expect([name, diagnostics]).toEqual([name, undefined]);
      for (const audience of ['consumer', 'author']) {
        const entities = compiler.semanticsViewOf(ds.snapshot, {
          audience,
        }).entities;
        const entry = entities.find((e) => e.entity.value === name);
        expect([name, audience, Object.hasOwn(entry, 'meta')]).toEqual([
          name,
          audience,
          false,
        ]);
      }
    }
  });

  test('slots and axes named like Object.prototype members (the recipe validator admits these)', () => {
    for (const name of [
      'toString',
      'hasOwnProperty',
      'valueOf',
      'isPrototypeOf',
    ]) {
      const d = baseDefinition();
      d.recipes.card.slots = [name, 'label'];
      d.recipes.card.base = {};
      d.recipes.card.variants = { [name]: { a: {} }, density: { compact: {} } };
      d.recipes.card.meta = {
        slots: { label: { description: 'Label.' } },
        variants: {
          density: {
            meta: { description: 'Density.' },
            values: { compact: {} },
          },
        },
      };
      const { ds, diagnostics } = publicBuild(d);
      expect([name, diagnostics]).toEqual([name, undefined]);
      const entities = compiler.semanticsViewOf(ds.snapshot, {
        audience: 'author',
      }).entities;
      for (const entity of [
        { recipe: 'card', slot: name },
        { recipe: 'card', variant: name },
        { recipe: 'card', variant: name, value: 'a' },
      ]) {
        const entry = entities.find(
          (e) => canonical(e.entity) === canonical(entity),
        );
        expect([name, entity, Object.hasOwn(entry, 'meta')]).toEqual([
          name,
          entity,
          false,
        ]);
      }
    }
  });

  test('themes, conditions and tokens named like Object.prototype members', () => {
    const d = baseDefinition();
    d.themes.toString = { tokens: {} };
    d.themes.dark.meta = { description: 'Dark.' };
    d.conditions.constructor = { atRule: '@media (min-width: 10rem)' };
    d.conditions.wide.meta = { description: 'Wide.' };
    d.tokens.colors.valueOf = { value: '#000' };
    d.tokens.colors.paper.meta = { description: 'Paper.' };
    const { ds, diagnostics } = publicBuild(d);
    expect(diagnostics).toBeUndefined();
    const entities = compiler.semanticsViewOf(ds.snapshot).entities;
    for (const entity of [
      { theme: 'toString' },
      { condition: 'constructor' },
      { token: 'colors.valueOf' },
    ]) {
      const entry = entities.find(
        (e) => canonical(e.entity) === canonical(entity),
      );
      expect([entity, Object.hasOwn(entry, 'meta')]).toEqual([entity, false]);
    }
  });
});

// ---------------------------------------------------------------------------

describe('B4: metadata is read in every collection shape the compiler accepts', () => {
  const SHAPES = {
    'array token group': (d, meta) => {
      d.tokens.spacing.scale = [{ value: '4px', meta }];
      return { token: 'spacing.scale.0' };
    },
    'nested array token group': (d, meta) => {
      d.tokens.spacing.ramp = [[{ value: '2px' }, { value: '4px', meta }]];
      return { token: 'spacing.ramp.0.1' };
    },
    'array token category': (d, meta) => {
      d.tokens.sizes = [{ value: '10px', meta }];
      return { token: 'sizes.0' };
    },
    'array of recipes': (d, meta) => {
      d.recipes = [{ base: {}, meta }];
      return { recipe: '0' };
    },
    'array of themes': (d, meta) => {
      d.themes = [{ tokens: {}, meta }];
      return { theme: '0' };
    },
    'array of conditions': (d, meta) => {
      d.conditions = [{ atRule: '@media (min-width: 50rem)', meta }];
      return { condition: '0' };
    },
  };

  for (const [shape, place] of Object.entries(SHAPES)) {
    test(`${shape}: round-trips through the public ingress and the view`, () => {
      const d = baseDefinition();
      const address = place(d, { description: `Declared in an ${shape}.` });
      const { ds, diagnostics } = publicBuild(d);
      expect(diagnostics).toBeUndefined();
      const entry = compiler
        .semanticsViewOf(ds.snapshot, { audience: 'author' })
        .entities.find((e) => canonical(e.entity) === canonical(address));
      expect(entry.meta).toEqual({ description: `Declared in an ${shape}.` });
    });

    test(`${shape}: invalid metadata is reported, not ignored`, () => {
      const d = baseDefinition();
      place(d, {
        relations: [{ relation: 'related', target: { token: 'not.a.token' } }],
      });
      expect(rules(publicBuild(d).diagnostics)).toEqual([
        'metadata.unknown-reference',
      ]);
    });
  }

  test('a `meta` key on an array token group (internal path) is an unsupported position', () => {
    const d = baseDefinition();
    const group = [{ value: '4px' }];
    group.meta = { description: 'group' };
    d.tokens.spacing.scale = group;
    const diagnostics = failures(d);
    expect(diagnostics.map((x) => [x.rule, x.context.reason])).toEqual([
      ['metadata.unsupported-position', 'token-group'],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('B5: every reflective operation on author objects is guarded', () => {
  const SENTINEL = 'AUTHOR SENTINEL';
  const boom = () => {
    throw new Error(SENTINEL);
  };
  const revoked = () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };
  const revokedFn = () => {
    const { proxy, revoke } = Proxy.revocable(function Object() {}, {});
    revoke();
    return proxy;
  };
  const HOSTILE = {
    'getPrototypeOf throws': () => new Proxy({}, { getPrototypeOf: boom }),
    'prototype chain throws': () =>
      new Proxy(
        {},
        { getPrototypeOf: () => new Proxy({}, { getPrototypeOf: boom }) },
      ),
    'ownKeys throws': () => new Proxy({}, { ownKeys: boom }),
    'ownKeys reports a key without a descriptor': () =>
      new Proxy(
        {},
        {
          ownKeys: () => ['missing'],
          getOwnPropertyDescriptor: () => undefined,
        },
      ),
    'getOwnPropertyDescriptor throws': () =>
      new Proxy({ a: 1 }, { getOwnPropertyDescriptor: boom }),
    'a revoked proxy': revoked,
    'a revoked proxy array element': () => [revoked()],
    'prototype whose constructor descriptor throws': () =>
      Object.create(
        new Proxy(Object.create(null), {
          getOwnPropertyDescriptor: boom,
          getPrototypeOf: () => null,
        }),
      ),
    'prototype whose constructor is a revoked function proxy': () => {
      const proto = Object.create(null);
      const fn = revokedFn();
      Object.defineProperty(proto, 'constructor', { value: fn });
      return Object.create(proto);
    },
  };
  const PATHS = {
    snapshotDefinition: (d) => compiler.snapshotDefinition(d),
    createProjectSession: (d) =>
      compiler.createPublicProjectSession({
        rootDir: require('os').tmpdir(),
        roots: [],
        definition: d,
      }),
  };

  for (const [label, make] of Object.entries(HOSTILE)) {
    for (const [pathName, run] of Object.entries(PATHS)) {
      test(`${label} via ${pathName}: structured definition.shape without author text`, () => {
        const d = baseDefinition();
        d.meta = make();
        let error = null;
        try {
          run(d);
        } catch (thrown) {
          error = thrown;
        }
        expect(error).toBeInstanceOf(compiler.PmsError);
        expect(error.diagnostics.map((x) => [x.code, x.rule])).toEqual([
          ['PMS_INVALID_DEFINITION', 'definition.shape'],
        ]);
        expect(['unreadable', 'prototype']).toContain(
          error.diagnostics[0].context.reason,
        );
        expect(JSON.stringify(error.diagnostics) + error.message).not.toContain(
          SENTINEL,
        );
      });
    }
  }

  test('applyChanges paths translate the same way', async () => {
    const root = require('fs').mkdtempSync(
      require('path').join(require('os').tmpdir(), 'pms-b5-'),
    );
    const session = compiler.createPublicProjectSession({
      rootDir: root,
      roots: [],
      definition: baseDefinition(),
    });
    const init = await session.initialize();
    try {
      for (const make of Object.values(HOSTILE)) {
        for (const extra of [
          { definition: 'd' },
          { config: { definition: 'd' } },
        ]) {
          const d = baseDefinition();
          d.meta = make();
          const tx = {
            baseRevision: init.revision,
            mode: 'verified-explicit',
            changed: [],
            added: [],
            removed: [],
            renamed: [],
          };
          if (extra.definition) tx.definition = d;
          else tx.config = { definition: d };
          let error = null;
          try {
            await session.applyChanges(tx);
          } catch (thrown) {
            error = thrown;
          }
          expect(error?.diagnostics?.[0]?.rule).toBe('definition.shape');
          expect(error.message).not.toContain(SENTINEL);
        }
      }
    } finally {
      await session.close();
    }
  });

  test('a config whose `definition` descriptor read throws is unreadable', () => {
    const config = new Proxy({ roots: [] }, { getOwnPropertyDescriptor: boom });
    let error = null;
    try {
      compiler.ownDefinitionOf(config);
    } catch (thrown) {
      error = thrown;
    }
    expect(error.diagnostics[0].context).toEqual({
      field: [],
      reason: 'unreadable',
    });
    expect(error.message).not.toContain(SENTINEL);
  });

  test('internal path: a hostile meta is metadata.malformed (unreadable), never a raw error', () => {
    for (const make of Object.values(HOSTILE)) {
      const d = baseDefinition();
      d.tokens.colors.paper.meta = make();
      const diagnostics = failures(d);
      expect(diagnostics.map((x) => [x.rule, x.context.reason])).toEqual([
        [
          'metadata.malformed',
          expect.stringMatching(/^(unreadable|prototype)$/),
        ],
      ]);
      expect(JSON.stringify(diagnostics)).not.toContain(SENTINEL);
    }
  });
});

// ---------------------------------------------------------------------------

describe('B6: the size bound counts exactly the bytes the protocol serializer emits', () => {
  // Built from code units so the source stays ASCII (formatters would
  // otherwise turn escapes into the characters themselves).
  const u = (...codes) => String.fromCharCode(...codes);
  const CLASSES = {
    ascii: 'plain text',
    quotes: 'say "hi" \\ there',
    control: `a${u(0x01)}b${u(0x1f)}c`,
    shortEscapes: `a${u(0x0a)}b${u(0x09)}c${u(0x0d)}d${u(0x08)}e${u(0x0c)}f`,
    del: `a${u(0x7f)}b`,
    latin1: `caf${u(0xe9, 0x80, 0xff)}`,
    lineSeparator: `a${u(0x2028)}b${u(0x2029)}c`,
    bmp: u(0x4e2d, 0x6587, 0xffff),
    nonBmp: `smile ${u(0xd83d, 0xde00)}`,
    loneSurrogate: `a${u(0xd800)}b${u(0xdc00)}c`,
  };

  test('canonicalSize equals Buffer.byteLength(canonicalJson(value)) for every character class', () => {
    for (const [label, text] of Object.entries(CLASSES)) {
      for (const value of [
        text,
        { description: text },
        { relations: [{ relation: 'related', target: { token: text } }] },
        [text, { [text]: text }],
      ]) {
        expect([label, compiler.canonicalSize(value)]).toEqual([
          label,
          Buffer.byteLength(compiler.canonicalJson(value)),
        ]);
      }
    }
  });

  // A token name of `n` units of `char`, referenced from one relation, sized so
  // that the entity's own meta is exactly `bytes` in the protocol serialization.
  function sizedByReference(char, bytes) {
    const probe = (n) => ({
      relations: [
        {
          relation: 'related',
          target: { token: `spacing.${'a'}${char.repeat(n)}` },
        },
      ],
    });
    const per =
      compiler.canonicalSize(probe(1)) - compiler.canonicalSize(probe(0));
    const base = compiler.canonicalSize(probe(0));
    const n = Math.floor((bytes - base) / per);
    let meta = probe(n);
    // Pad with ASCII in the token name to land exactly on `bytes`.
    const pad = bytes - compiler.canonicalSize(meta);
    const name = `a${'b'.repeat(pad)}${char.repeat(n)}`;
    meta = {
      relations: [
        { relation: 'related', target: { token: `spacing.${name}` } },
      ],
    };
    expect(compiler.canonicalSize(meta)).toBe(bytes);
    expect(Buffer.byteLength(compiler.canonicalJson(meta))).toBe(bytes);
    return { meta, name };
  }

  for (const [label, char] of Object.entries({
    del: u(0x7f),
    control: u(0x01),
    latin1: u(0xe9),
    bmp: u(0x4e2d),
    nonBmp: u(0xd83d, 0xde00),
  })) {
    test(`cap boundary through a reference name of ${label} characters: 4096 accepted, 4097 refused`, () => {
      for (const [bytes, accepted] of [
        [4096, true],
        [4097, false],
      ]) {
        const { meta, name } = sizedByReference(char, bytes);
        const d = baseDefinition();
        d.tokens.spacing[name] = { value: '4px' };
        d.tokens.spacing.sm.meta = meta;
        const result = attempt(d);
        if (accepted) expect(result.diagnostics).toBeUndefined();
        else
          expect(
            result.diagnostics.map((x) => [x.rule, x.context.bytes]),
          ).toEqual([['metadata.too-large', 4097]]);
      }
    });
  }

  test('cap boundary through text fields with escaped characters', () => {
    // 85 x U+00E9 is 170 UTF-8 bytes (under the 256-byte text cap) but 510
    // protocol bytes: text fields count toward the entity cap in protocol bytes.
    const line = u(0xe9).repeat(85);
    const meta = {
      usage: Array.from({ length: 7 }, () => line),
      description: '',
    };
    const base = compiler.canonicalSize({ ...meta, description: 'x' }) - 1;
    expect(base).toBeGreaterThan(4096 - 512);
    for (const [bytes, accepted] of [
      [4096, true],
      [4097, false],
    ]) {
      const filler = bytes - base;
      const candidate = { ...meta, description: 'd'.repeat(filler) };
      expect(Buffer.byteLength(compiler.canonicalJson(candidate))).toBe(bytes);
      const d = baseDefinition();
      d.tokens.colors.paper.meta = candidate;
      const result = attempt(d);
      if (accepted) expect(result.diagnostics).toBeUndefined();
      else expect(rules(result.diagnostics)).toEqual(['metadata.too-large']);
    }
  });
});

// ---------------------------------------------------------------------------

describe('CE owner: definition.shape and PMS_INVALID_PROPERTY_DOMAIN never compete', () => {
  const PLAIN_MALFORMED = [
    ['a string instead of the map', 'width', 'property-domains.malformed'],
    ['a string entry', { width: 'auto' }, 'property-domains.malformed-entry'],
    [
      'a number instead of the values array',
      { width: { values: 4 } },
      'property-domains.malformed-member',
    ],
    [
      'an unknown member',
      { width: { values: ['auto'], step: 1 } },
      'property-domains.unknown-member',
    ],
  ];
  const NOT_PLAIN = [
    ['a function', () => ({})],
    ['a Map', new Map([['width', { values: ['auto'] }]])],
    ['a prototyped object', Object.create({ width: { values: ['auto'] } })],
    [
      'a symbol key',
      Object.assign({ width: { values: ['auto'] } }, { [Symbol('x')]: 1 }),
    ],
    [
      'an accessor entry',
      Object.defineProperty({}, 'width', {
        enumerable: true,
        get: () => ({ values: ['auto'] }),
      }),
    ],
  ];

  for (const [label, propertyDomains, rule] of PLAIN_MALFORMED) {
    test(`plain-data malformed (${label}) -> PMS_INVALID_PROPERTY_DOMAIN ${rule}, through the public API`, async () => {
      const d = baseDefinition();
      d.propertyDomains = propertyDomains;
      expect(() => compiler.snapshotDefinition(d)).not.toThrow();
      const { ok, diagnostics } = await sessionResult(d);
      expect(ok).toBe(false);
      expect(diagnostics.map((x) => [x.code, x.rule])).toEqual([
        ['PMS_INVALID_PROPERTY_DOMAIN', rule],
      ]);
    });
  }

  for (const [label, propertyDomains] of NOT_PLAIN) {
    test(`not plain data (${label}) -> PMS_INVALID_DEFINITION definition.shape at ingress, never a domain code`, () => {
      const d = baseDefinition();
      d.propertyDomains = propertyDomains;
      let error = null;
      try {
        compiler.createPublicProjectSession({
          rootDir: require('os').tmpdir(),
          roots: [],
          definition: d,
        });
      } catch (thrown) {
        error = thrown;
      }
      expect(error.diagnostics.map((x) => [x.code, x.rule])).toEqual([
        ['PMS_INVALID_DEFINITION', 'definition.shape'],
      ]);
    });
  }

  test('meta keeps both digests byte-identical', () => {
    const plain = attempt(baseDefinition()).ds;
    const d = baseDefinition();
    d.propertyDomains.width.meta = { description: 'Widths.' };
    const described = attempt(d).ds;
    expect(described.snapshot.identity.registryDigest).toBe(
      plain.snapshot.identity.registryDigest,
    );
    expect(described.snapshot.properties.digest).toBe(
      plain.snapshot.properties.digest,
    );
  });
});

// ---------------------------------------------------------------------------
// AG-03.1 perf: a definition without `meta` costs no semantics walk, and an
// unchanged `meta` is reused across an unrelated edit; results are unchanged.

describe('perf: skip without meta, reuse unchanged meta', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function counter() {
    const counts = {};
    return {
      counts,
      addDuration() {},
      addParse() {},
      sampleMemory() {},
      reset() {},
      snapshot() {
        return {};
      },
      addCount(name, n = 1) {
        counts[name] = (counts[name] ?? 0) + n;
      },
    };
  }

  async function withSession(definition, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-perf-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.js'), 'export const a = 1;\n');
    const session = compiler.createPublicProjectSession({
      rootDir: root,
      roots: [path.join(root, 'src')],
      outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pms-perf-out-')),
      definition,
    });
    const collector = counter();
    const uninstall = compiler.installPerfCollector(collector);
    try {
      const init = await session.initialize();
      let revision = (await session.validate(init.revision)).revision;
      const edit = async (next) => {
        const applied = await session.applyChanges({
          baseRevision: revision,
          mode: 'verified-explicit',
          changed: [],
          added: [],
          removed: [],
          renamed: [],
          definition: next,
        });
        const checked = await session.validate(applied.revision);
        revision = checked.revision;
        return checked;
      };
      await run({ counts: collector.counts, edit });
    } finally {
      uninstall();
      await session.close();
    }
  }

  test('a definition without meta never enters the semantics walk, across edits', async () => {
    await withSession(baseDefinition(), async ({ counts, edit }) => {
      for (const value of ['#fefefe', '#ffffff']) {
        const d = baseDefinition();
        d.tokens.colors.paper.value = value;
        expect((await edit(d)).ok).toBe(true);
      }
      expect(counts.semantics_collect ?? 0).toBe(0);
      expect(counts.semantics_builds ?? 0).toBe(0);
      expect(counts.semantics_skipped).toBeGreaterThanOrEqual(3);
    });
  });

  test('unchanged meta is reused across a token-value edit; changed meta is rebuilt and validated', async () => {
    const withMeta = (description, value = '#ffffff') => {
      const d = baseDefinition();
      d.tokens.colors.paper.value = value;
      d.tokens.colors.paper.meta = { description };
      d.recipes.button.meta = {
        relations: [{ relation: 'related', target: { recipe: 'card' } }],
      };
      return d;
    };
    await withSession(withMeta('Paper.'), async ({ counts, edit }) => {
      const builds0 = counts.semantics_builds ?? 0;
      expect(builds0).toBeGreaterThanOrEqual(1);
      // An unrelated token-value edit: the metadata inputs are unchanged.
      expect((await edit(withMeta('Paper.', '#fefefe'))).ok).toBe(true);
      expect(counts.semantics_builds ?? 0).toBe(builds0);
      expect(counts.semantics_memo_hits).toBeGreaterThanOrEqual(1);
      // A metadata edit is rebuilt and validated.
      expect((await edit(withMeta('Paper, edited.', '#fefefe'))).ok).toBe(true);
      expect(counts.semantics_builds).toBe(builds0 + 1);
      // An invalid edit is reported on the revision that introduces it ...
      const invalid = await edit(withMeta('', '#fefefe'));
      expect(invalid.ok).toBe(false);
      expect(invalid.diagnostics.map((x) => x.rule)).toEqual(['metadata.text']);
      // ... and on a later unrelated edit too, from the reused result.
      const later = await edit(withMeta('', '#ffffff'));
      expect(later.ok).toBe(false);
      expect(later.diagnostics.map((x) => x.rule)).toEqual(['metadata.text']);
    });
  });

  test('unchanged meta is re-validated when the vocabulary it names changes', async () => {
    const make = (withCard) => {
      const d = baseDefinition();
      if (!withCard) delete d.recipes.card;
      d.recipes.button.meta = {
        relations: [{ relation: 'related', target: { recipe: 'card' } }],
      };
      return d;
    };
    await withSession(make(true), async ({ edit }) => {
      const removed = await edit(make(false));
      expect(removed.ok).toBe(false);
      expect(removed.diagnostics.map((x) => x.rule)).toEqual([
        'metadata.unknown-reference',
      ]);
      expect((await edit(make(true))).ok).toBe(true);
    });
  });

  test('the reuse key is injective: values JSON would not distinguish are never reused for each other', () => {
    const first = baseDefinition();
    first.tokens.colors.paper.meta = {
      relations: [
        { relation: 'related', target: compiler.token('spacing.sm') },
      ],
    };
    const second = baseDefinition();
    second.tokens.colors.paper.meta = {
      relations: [{ relation: 'related', target: {} }],
    };
    const a = publicBuild(first).diagnostics;
    const b = publicBuild(second).diagnostics;
    expect(a.map((x) => x.rule)).toEqual(['metadata.malformed']);
    expect(b.map((x) => [x.rule, x.context.reason])).toEqual([
      ['metadata.field-type', 'reference-shape'],
    ]);
    // And the reverse order.
    expect(publicBuild(second).diagnostics.map((x) => x.rule)).toEqual([
      'metadata.field-type',
    ]);
    expect(publicBuild(first).diagnostics.map((x) => x.rule)).toEqual([
      'metadata.malformed',
    ]);
  });

  test('reused diagnostics are fresh objects each time', () => {
    const d = baseDefinition();
    d.tokens.colors.paper.meta = { description: '' };
    const runs = [1, 2, 3].map(() => publicBuild(d).diagnostics);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    // The second and third builds are both reuses: neither shares objects.
    expect(runs[2][0]).not.toBe(runs[1][0]);
    expect(runs[1][0]).not.toBe(runs[0][0]);
  });
});
