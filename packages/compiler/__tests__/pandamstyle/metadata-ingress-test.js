/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-03.1 definition ingress (design note §3.8.0, findings R3 and R2-1): no
 * author-supplied behaviour runs after a public definition ingress (I6).
 * Every `definition.shape` reason through every public path; accepted
 * controls; the repository regression check (P10).
 */

'use strict';

const vm = require('vm');
const {
  compiler,
  T,
  baseDefinition,
  openSession,
  tempProject,
} = require('./metadata-helpers');
const { repositoryDefinitions } = require('./metadata-repository');

jest.setTimeout(120000);

const counter = { calls: 0 };
const hit = () => {
  counter.calls++;
};
/** A function that records its call, then returns `value`. */
const counting =
  (value) =>
  (...args) => {
    hit();
    return typeof value === 'function' ? value(...args) : value;
  };

// Each returns a definition carrying one hostile shape, its expected reason
// and the expected `field` (author-named segments as `{ index }`).
const HOSTILE = {
  'own getter on a nested meta field': () => {
    const d = baseDefinition();
    const meta = {};
    Object.defineProperty(meta, 'description', {
      enumerable: true,
      get: counting('x'),
    });
    d.tokens.colors.paper.meta = meta;
    return [
      d,
      'accessor',
      ['tokens', { index: 1 }, { index: 1 }, 'meta', { index: 0 }],
    ];
  },
  'own getter on meta itself': () => {
    const d = baseDefinition();
    Object.defineProperty(d.tokens.colors.paper, 'meta', {
      enumerable: true,
      get: counting({}),
    });
    return [d, 'accessor', ['tokens', { index: 1 }, { index: 1 }, 'meta']];
  },
  'own getter on a token value': () => {
    const d = baseDefinition();
    d.tokens.colors.paper = {};
    Object.defineProperty(d.tokens.colors.paper, 'value', {
      enumerable: true,
      get: counting('#fff'),
    });
    return [
      d,
      'accessor',
      ['tokens', { index: 1 }, { index: 1 }, { index: 0 }],
    ];
  },
  'own getter on a recipe key': () => {
    const d = baseDefinition();
    Object.defineProperty(d.recipes.button, 'base', {
      enumerable: true,
      get: counting({}),
    });
    return [d, 'accessor', ['recipes', { index: 0 }, 'base']];
  },
  'inherited getter (token value)': () => {
    const d = baseDefinition();
    d.tokens.colors.paper = Object.create(
      Object.create(Object.prototype, {
        value: { get: counting('#fff') },
      }),
    );
    return [d, 'prototype', ['tokens', { index: 1 }, { index: 1 }]];
  },
  'inherited toJSON getter (meta)': () => {
    const d = baseDefinition();
    d.meta = Object.create(
      Object.create(Object.prototype, {
        toJSON: { get: counting(() => ({})) },
      }),
    );
    return [d, 'prototype', ['meta']];
  },
  'own toJSON method': () => {
    const d = baseDefinition();
    d.meta = { toJSON: counting({}) };
    return [d, 'function', ['meta', { index: 0 }]];
  },
  'own valueOf and toString methods': () => {
    const d = baseDefinition();
    d.tokens.colors.paper.value = {
      valueOf: counting(1),
      toString: counting('#fff'),
    };
    return [
      d,
      'function',
      ['tokens', { index: 1 }, { index: 1 }, { index: 0 }, { index: 0 }],
    ];
  },
  'own Symbol.toPrimitive': () => {
    const d = baseDefinition();
    d.tokens.colors.paper.value = {
      [Symbol.toPrimitive]: counting('#fff'),
    };
    return [
      d,
      'symbol-key',
      ['tokens', { index: 1 }, { index: 1 }, { index: 0 }],
    ];
  },
  'inherited Symbol.toPrimitive': () => {
    const d = baseDefinition();
    d.tokens.colors.paper.value = Object.create({
      [Symbol.toPrimitive]: counting('#fff'),
    });
    return [
      d,
      'prototype',
      ['tokens', { index: 1 }, { index: 1 }, { index: 0 }],
    ];
  },
  'class instance': () => {
    class Leaf {
      get value() {
        hit();
        return '#fff';
      }
    }
    const d = baseDefinition();
    d.tokens.colors.paper = new Leaf();
    return [d, 'prototype', ['tokens', { index: 1 }, { index: 1 }]];
  },
  'Date value': () => {
    const d = baseDefinition();
    d.meta = { when: new Date(0) };
    return [d, 'prototype', ['meta', { index: 0 }]];
  },
  'Map value': () => {
    const d = baseDefinition();
    d.extra = new Map();
    return [d, 'prototype', [{ index: 6 }]];
  },
  'function value': () => {
    const d = baseDefinition();
    d.tokens.colors.paper.value = counting('#fff');
    return [
      d,
      'function',
      ['tokens', { index: 1 }, { index: 1 }, { index: 0 }],
    ];
  },
  'non-enumerable key': () => {
    const d = baseDefinition();
    Object.defineProperty(d.themes.dark, 'tokens', {
      enumerable: false,
      value: {},
    });
    return [d, 'non-enumerable', ['themes', { index: 0 }, 'tokens']];
  },
  'array with an extra key': () => {
    const d = baseDefinition();
    d.recipes.card.slots.extra = 'x';
    return [d, 'array-shape', ['recipes', { index: 1 }, 'slots']];
  },
  'malformed token mark': () => {
    const d = baseDefinition();
    d.recipes.button.base.color = { [Symbol.for('pandamstyle.tokenRef')]: 42 };
    return [d, 'token-mark', ['recipes', { index: 0 }, 'base', { index: 0 }]];
  },
  'Proxy whose trap throws': () => {
    const d = baseDefinition();
    d.tokens.colors.paper = new Proxy(
      {},
      {
        ownKeys: () => {
          hit();
          throw new Error('trap');
        },
      },
    );
    return [d, 'unreadable', ['tokens', { index: 1 }, { index: 1 }]];
  },
};

const PATHS = {
  createProjectSession: (definition) => openSession(definition),
  'applyChanges({ definition })': async (definition) => {
    const session = openSession(baseDefinition());
    const init = await session.initialize();
    try {
      return await session.applyChanges(
        mutation(init.revision, { definition }),
      );
    } finally {
      await session.close();
    }
  },
  'applyChanges({ config: { definition } })': async (definition) => {
    const session = openSession(baseDefinition());
    const init = await session.initialize();
    try {
      return await session.applyChanges(
        mutation(init.revision, { config: { definition } }),
      );
    } finally {
      await session.close();
    }
  },
};

function mutation(baseRevision, extra) {
  return {
    baseRevision,
    mode: 'verified-explicit',
    changed: [],
    added: [],
    removed: [],
    renamed: [],
    ...extra,
  };
}

describe('every definition.shape reason through every public ingress path', () => {
  for (const [shape, make] of Object.entries(HOSTILE)) {
    for (const [pathName, run] of Object.entries(PATHS)) {
      test(`${shape} via ${pathName}`, async () => {
        const [definition, reason, field] = make();
        counter.calls = 0;
        let error = null;
        try {
          await run(definition);
        } catch (thrown) {
          error = thrown;
        }
        expect(error).toBeInstanceOf(compiler.PmsError);
        expect(error.diagnostics).toHaveLength(1);
        const [d] = error.diagnostics;
        expect(d).toMatchObject({
          code: 'PMS_INVALID_DEFINITION',
          phase: 'design-system',
          rule: 'definition.shape',
          context: { reason, field },
        });
        // No author code ran: zero calls, the throwing Proxy trap aside.
        expect(counter.calls).toBe(shape.startsWith('Proxy') ? 1 : 0);
        expect(JSON.stringify(d)).not.toMatch(/paper|button|card|dark/);
      });
    }
  }

  test('a getter on the container property `definition` itself is refused without being run', () => {
    counter.calls = 0;
    const config = { rootDir: tempProject(), roots: [] };
    Object.defineProperty(config, 'definition', {
      enumerable: true,
      get: counting(baseDefinition()),
    });
    expect(() => compiler.createPublicProjectSession(config)).toThrow(
      compiler.PmsError,
    );
    expect(counter.calls).toBe(0);
  });
});

describe("accepted shapes copy into plain data with this realm's prototypes", () => {
  const plainEverywhere = (value) => {
    if (value === null || typeof value !== 'object') return true;
    if (compiler.tokenPathOf(value, 'author') != null)
      return Object.isFrozen(value);
    const proto = Object.getPrototypeOf(value);
    if (
      Array.isArray(value)
        ? proto !== Array.prototype
        : proto !== Object.prototype
    )
      return false;
    return Object.values(value).every(plainEverywhere);
  };

  test('token() marks, cross-realm objects and arrays, holes and own __proto__ keys', () => {
    const d = baseDefinition();
    d.recipes.button.base.color = T('colors.text.primary');
    d.tokens.realm = vm.runInNewContext(
      '({ a: { value: "1px" }, b: { value: "2px" } })',
    );
    d.meta = JSON.parse('{"__proto__": {"polluted": true}}');
    d.recipes.card.slots = vm.runInNewContext('["root", "label"]');
    const holes = [];
    holes[2] = 'x';
    d.extraList = holes;
    const copy = compiler.snapshotDefinition(d);
    expect(plainEverywhere(copy)).toBe(true);
    expect(compiler.tokenPathOf(copy.recipes.button.base.color, 'author')).toBe(
      'colors.text.primary',
    );
    expect(Object.hasOwn(copy.meta, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy.meta)).toBe(Object.prototype);
    expect({}.polluted).toBeUndefined();
    expect(copy.extraList.length).toBe(3);
    expect(0 in copy.extraList).toBe(false);
  });

  test('a Proxy is read only through descriptor-level traps, once, during the copy', () => {
    let reads = 0;
    let gets = 0;
    const proxy = new Proxy(
      { value: '#fff' },
      {
        get: (target, key) => {
          gets++;
          return target[key];
        },
        getOwnPropertyDescriptor: () => {
          reads++;
          return {
            value: reads === 1 ? '#aaa' : '#bbb',
            enumerable: true,
            configurable: true,
            writable: true,
          };
        },
      },
    );
    const d = baseDefinition();
    d.tokens.colors.paper = proxy;
    const copy = compiler.snapshotDefinition(d);
    expect(copy.tokens.colors.paper.value).toBe('#aaa');
    expect(reads).toBe(1);
    expect(gets).toBe(0);
    JSON.stringify(copy);
    compiler.buildDesignSystem(copy);
    expect([reads, gets]).toEqual([1, 0]);
  });

  test('sparse arrays keep their existing recipe diagnostics', () => {
    const d = baseDefinition();
    d.recipes.card.slots = Array(1); // eslint-disable-line no-sparse-arrays
    let error = null;
    try {
      compiler.buildDesignSystem(compiler.snapshotDefinition(d));
    } catch (thrown) {
      error = thrown;
    }
    expect(error.diagnostics[0].code).toBe('PMS_INVALID_RECIPE_SLOT');
  });
});

describe('R2-1 repository regression: no existing definition is rejected', () => {
  test('every standalone repository definition passes snapshotDefinition unchanged in meaning', () => {
    const definitions = repositoryDefinitions();
    expect(definitions.length).toBeGreaterThanOrEqual(26);
    for (const { file, definition } of definitions) {
      let copy;
      expect(
        () => (copy = compiler.snapshotDefinition(definition)),
      ).not.toThrow();
      expect([file, JSON.stringify(copy)]).toEqual([
        file,
        JSON.stringify(definition),
      ]);
    }
  });
});
