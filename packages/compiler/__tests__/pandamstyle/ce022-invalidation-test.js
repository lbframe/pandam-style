/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2: incremental validity equals a full rebuild for every registry fact
 * CE-02.1 and CE-02.2 made able to change a file's validity.
 *
 * Each case edits the design-system definition (or, for raw keys, a source
 * file) so one fact flips, valid -> invalid -> valid, through one Project
 * Service session; after every edit the session's verdict, diagnostics
 * (code, rule, location, message, context) and published artifacts must equal
 * a fresh `buildProject` of the same state. The facts:
 *
 *   - a token's use-site verdicts (its numeric facts against each scalar
 *     that admits its category): base value, theme value, reference;
 *   - the candidates of a use-site refusal, filtered by the other tokens'
 *     verdicts (a file with diagnostics is compiled again at every
 *     revision; this case fails if that ever stops);
 *   - the effective property domains (`propertyDomains`);
 *   - condition definitions: S1 (a registry refusal), an edited and a
 *     removed definition a file uses;
 *   - S1 on raw condition-block keys: a function of the source text alone,
 *     flipped by a source edit.
 */

const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const vm = require('vm');
const {
  openProject,
  fingerprint,
  loadCompiler,
  measure,
} = require('./session-helpers');

const VERIFIED = {
  changed: [],
  added: [],
  removed: [],
  renamed: [],
  mode: 'verified-explicit',
};

function normalize(root, diagnostics) {
  return diagnostics
    .map((d) =>
      JSON.stringify({
        code: d.code,
        rule: d.rule ?? null,
        file:
          d.location?.file == null
            ? null
            : path.relative(root, d.location.file),
        line: d.location?.line ?? null,
        column: d.location?.column ?? null,
        message: d.message,
        context: d.context ?? null,
      }),
    )
    .sort();
}

/** The project's source files, relative path -> text. */
function sourcesOf(h) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(h.project, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(h.src('src'));
  return out;
}

/**
 * Applies one change to the session, and builds the same state from scratch
 * in a separate copy of the project (so the reference never touches the
 * session's inputs or output); returns the session's outcome and every
 * disagreement with the full build.
 */
function step(h, changes, definition) {
  h.session.applyChanges(changes);
  const validation = h.session.validate();
  if (validation.ok) h.session.compile();
  const incremental = {
    ok: validation.ok,
    diagnostics: normalize(
      h.project,
      validation.diagnostics.filter((d) => d.severity !== 'info'),
    ),
    published: validation.ok ? fingerprint(h.outDir) : null,
  };
  const reference = openProject('valid');
  fs.rmSync(reference.src('src'), { recursive: true, force: true });
  for (const [file, text] of Object.entries(sourcesOf(h))) {
    fs.mkdirSync(path.dirname(reference.src(file)), { recursive: true });
    fs.writeFileSync(reference.src(file), text);
  }
  let full;
  try {
    reference.full({ definition });
    full = {
      ok: true,
      diagnostics: [],
      published: fingerprint(reference.outDir),
    };
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    full = {
      ok: false,
      diagnostics: normalize(
        reference.project,
        error.diagnostics.filter((d) => d.severity !== 'info'),
      ),
      published: null,
    };
  }
  const mismatches = [];
  if (incremental.ok !== full.ok) {
    mismatches.push({
      verdict: { incremental: incremental.ok, full: full.ok },
    });
  }
  if (
    JSON.stringify(incremental.diagnostics) !== JSON.stringify(full.diagnostics)
  ) {
    mismatches.push({
      diagnostics: {
        incremental: incremental.diagnostics,
        full: full.diagnostics,
      },
    });
  }
  if (
    incremental.published != null &&
    full.published != null &&
    JSON.stringify(incremental.published) !== JSON.stringify(full.published)
  ) {
    mismatches.push({ published: 'differs' });
  }
  return {
    ok: incremental.ok,
    diagnostics: incremental.diagnostics,
    mismatches,
  };
}

// Copies plain objects and arrays; token markers are frozen and shared, as
// the CE-00.3 harness does (tools/baselines/sample.mjs), so an edit changes
// only what it names.
const clone = (value) => {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clone(v)]),
    );
  }
  return value;
};

/** A definition edited by `edit(copy)`; the original is never mutated. */
const edited = (definition, edit) => {
  const copy = clone(definition);
  edit(copy);
  return copy;
};

const SOURCES = {
  'src/ce022-top.js': "paddingTop: token('spacing.xl')",
  'src/ce022-bottom.js': "paddingBottom: token('spacing.lg')",
  'src/ce022-opacity.js': 'opacity: 0.5',
};

function project() {
  const h = openProject('valid');
  for (const [file, declaration] of Object.entries(SOURCES)) {
    fs.writeFileSync(
      h.src(file),
      [
        "import { create, token } from '../generated/design.pandamstyle';",
        `export const s = create({ n: { ${declaration} } });`,
        '',
      ].join('\n'),
    );
  }
  const definition = h.reloadDefinition();
  const first = step(
    h,
    { definition, mutation: { ...VERIFIED, mode: 'full-discovery' } },
    definition,
  );
  expect(first).toEqual({ ok: true, diagnostics: [], mismatches: [] });
  return { h, definition };
}

/** Runs `definitions` in order; each must match the full build. */
function flips(h, definitions) {
  return definitions.map((definition) => {
    const result = step(h, { definition, mutation: VERIFIED }, definition);
    return {
      ok: result.ok,
      rules: [
        ...new Set(result.diagnostics.map((d) => JSON.parse(d).rule)),
      ].sort(),
      mismatches: result.mismatches,
    };
  });
}

const OK = { ok: true, rules: [], mismatches: [] };
const REFUSED = {
  ok: false,
  rules: ['category-strict'],
  mismatches: [],
};

describe('CE-02.2 incremental validity equals a full rebuild', () => {
  test('a token value flips its use-site verdict, both ways', () => {
    const { h, definition } = project();
    const negative = edited(definition, (d) => {
      d.tokens.spacing.xl.value = '-32px';
    });
    const unitless = edited(definition, (d) => {
      d.tokens.spacing.xl.value = '32';
    });
    expect(
      flips(h, [negative, definition, unitless, negative, definition]),
    ).toEqual([REFUSED, OK, REFUSED, REFUSED, OK]);
  });

  test('a rebuild recomputes the input of the edited token only', () => {
    const { h, definition } = project();
    const wider = edited(definition, (d) => {
      d.tokens.spacing.xl.value = '40px';
    });
    const { counters } = measure(() => {
      h.session.applyChanges({ definition: wider, mutation: VERIFIED });
      h.session.validate();
    });
    expect(counters.token_inputs_recomputed).toBe(1);
  });

  test('an edit that flips no verdict revalidates nothing; a flip, its users', () => {
    const { h, definition } = project();
    const revision = (next) => {
      h.session.applyChanges({ definition: next, mutation: VERIFIED });
      const { semanticFilesInvalidated, filesCompiled } =
        h.session.validate().counters;
      return [semanticFilesInvalidated, filesCompiled];
    };
    // spacing.xl: src/page.js (padding) and src/ce022-top.js (paddingTop).
    const wider = edited(definition, (d) => {
      d.tokens.spacing.xl.value = '40px';
    });
    expect(revision(wider)).toEqual([0, 0]);
    expect(revision(definition)).toEqual([0, 0]);
    const negative = edited(definition, (d) => {
      d.tokens.spacing.xl.value = '-32px';
    });
    expect(revision(negative)).toEqual([2, 2]);
    expect(revision(definition)).toEqual([2, 2]);
  });

  test('a theme value flips the verdict, both ways', () => {
    const { h, definition } = project();
    const themed = edited(definition, (d) => {
      d.themes.dark.tokens.spacing = { xl: { value: '-1px' } };
    });
    expect(flips(h, [themed, definition, themed])).toEqual([
      REFUSED,
      OK,
      REFUSED,
    ]);
  });

  test('a theme added and removed flips the verdict, both ways', () => {
    const { h, definition } = project();
    const added = edited(definition, (d) => {
      d.themes.contrast = { tokens: { spacing: { xl: { value: '-2px' } } } };
    });
    expect(flips(h, [added, definition, added, definition])).toEqual([
      REFUSED,
      OK,
      REFUSED,
      OK,
    ]);
  });

  test('a token visibility flips its users, both ways', () => {
    const { h, definition } = project();
    const hidden = edited(definition, (d) => {
      d.tokens.spacing.xl.visibility = 'private';
    });
    const flipped = flips(h, [hidden, definition, hidden, definition]);
    expect(flipped.map((f) => [f.ok, f.mismatches])).toEqual([
      [false, []],
      [true, []],
      [false, []],
      [true, []],
    ]);
    expect(flipped[0].rules).toEqual(['visibility.consumer']);
  });

  test('a reference flips the verdict through its target, both ways', () => {
    const { h, definition } = project();
    const base = edited(definition, (d) => {
      d.tokens.spacing.neg = { value: '4px', visibility: 'public' };
      d.tokens.spacing.xl = { ref: 'spacing.neg', visibility: 'public' };
    });
    const target = edited(base, (d) => {
      d.tokens.spacing.neg.value = '-4px';
    });
    expect(flips(h, [base, target, base])).toEqual([OK, REFUSED, OK]);
  });

  test('another token flips the candidates of a refusal, both ways', () => {
    const { h, definition } = project();
    const lg = edited(definition, (d) => {
      d.tokens.spacing.lg.value = '-24px';
    });
    const both = edited(lg, (d) => {
      d.tokens.spacing.xl.value = '-32px';
    });
    // The bottom file's refusal lists xl, then not, then again.
    expect(flips(h, [lg, both, lg])).toEqual([REFUSED, REFUSED, REFUSED]);
  });

  test('an effective property domain flips a literal, both ways', () => {
    const { h, definition } = project();
    const narrowed = edited(definition, (d) => {
      d.propertyDomains = { opacity: { values: [0, 0.25, 1] } };
    });
    const widened = edited(definition, (d) => {
      d.propertyDomains = { opacity: { values: [0, 0.5, 1] } };
    });
    const flipped = flips(h, [narrowed, widened, narrowed, definition]);
    expect(flipped.map((f) => [f.ok, f.mismatches])).toEqual([
      [false, []],
      [true, []],
      [false, []],
      [true, []],
    ]);
  });

  test('S1 on a condition definition, both ways', () => {
    const { h, definition } = project();
    const unsafe = edited(definition, (d) => {
      d.conditions.hover = ':hover}body{display:none';
    });
    const flipped = flips(h, [unsafe, definition, unsafe, definition]);
    expect(flipped.map((f) => [f.ok, f.mismatches])).toEqual([
      [false, []],
      [true, []],
      [false, []],
      [true, []],
    ]);
    expect(flipped[0].rules).toEqual(['value-safety.breakout']);
  });

  test('a condition definition a file uses: edited, removed, restored', () => {
    const { h, definition } = project();
    // src/page.js uses `wide` in a responsive value.
    const edited900 = edited(definition, (d) => {
      d.conditions.wide = '@media (min-width: 900px)';
    });
    const removed = edited(definition, (d) => {
      delete d.conditions.wide;
    });
    const flipped = flips(h, [edited900, removed, definition, removed]);
    expect(flipped.map((f) => [f.ok, f.mismatches])).toEqual([
      [true, []],
      [false, []],
      [true, []],
      [false, []],
    ]);
  });

  test('S1 on a raw condition key depends on the source alone', () => {
    const { h, definition } = project();
    const file = h.src('src/ce022-raw.js');
    const write = (key) =>
      fs.writeFileSync(
        file,
        [
          "import { create, token } from '../generated/design.pandamstyle';",
          `export const s = create({ n: { ${JSON.stringify(key)}: { color: token('colors.text.primary') } } });`,
          '',
        ].join('\n'),
      );
    const results = [];
    for (const [key, change] of [
      [':hover}body{display:none}/*', 'added'],
      ['[dir=rtl] &', 'changed'],
      [':hover}body{display:none}/*', 'changed'],
    ]) {
      write(key);
      const result = step(
        h,
        {
          definition,
          mutation: { ...VERIFIED, [change]: [file] },
        },
        definition,
      );
      results.push([result.ok, result.mismatches]);
    }
    expect(results).toEqual([
      [false, []],
      [true, []],
      [false, []],
    ]);
  });
});

describe('the token file inputs memo', () => {
  test('equals a computation without it after every kind of edit', () => {
    const compiler = loadCompiler();
    const digest = (value) => JSON.stringify(value);
    const base = {
      systemId: 'ce022-memo',
      tokens: {
        spacing: {
          a: { value: '4px', visibility: 'public' },
          n: { value: '-8px', visibility: 'public' },
        },
        colors: { c: { value: '#fff', visibility: 'public' } },
      },
      themes: { dark: { tokens: { spacing: { a: { value: '6px' } } } } },
    };
    // Each step edits the base once; the tokens whose input it changes.
    const steps = [
      [(d) => (d.tokens.spacing.a.value = '-4px'), ['spacing.a']],
      [(d) => (d.themes.dark.tokens.spacing.a.value = '-6px'), ['spacing.a']],
      // The same value under another theme name: a verdict names its theme.
      [
        (d) => {
          d.themes = {
            night: { tokens: { spacing: { a: { value: '-6px' } } } },
          };
        },
        ['spacing.a'],
      ],
      [
        (d) => {
          d.themes.contrast = { tokens: { spacing: { a: { value: '-1px' } } } };
        },
        ['spacing.a'],
      ],
      [(d) => (d.tokens.spacing.a.visibility = 'private'), ['spacing.a']],
      [
        (d) => (d.systemId = 'ce022-memo-renamed'),
        ['spacing.a', 'spacing.n', 'colors.c'],
      ],
      [
        (d) => {
          d.propertyDomains = { columnGap: { values: ['0'] } };
        },
        ['spacing.n'],
      ],
    ];
    const baseInputs = compiler.tokenFileInputs(
      compiler.buildDesignSystem(base),
      null,
      digest,
    ).inputs;
    let memo = null;
    const sequence = [base, ...steps.map(([edit]) => edited(base, edit)), base];
    const changed = sequence.map((definition) => {
      const ds = compiler.buildDesignSystem(definition);
      const memoised = compiler.tokenFileInputs(ds, memo, digest);
      const fresh = compiler.tokenFileInputs(ds, null, digest);
      expect([...memoised.inputs]).toEqual([...fresh.inputs]);
      memo = memoised.memo;
      return [...fresh.inputs.keys()].filter(
        (id) => fresh.inputs.get(id) !== baseInputs.get(id),
      );
    });
    expect(changed).toEqual([[], ...steps.map(([, ids]) => ids), []]);
  });
});

describe('the verdict keys', () => {
  test('retain nothing of a design system that is gone', async () => {
    const compiler = loadCompiler();
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    // The 0.05 opacity grid: 64 distinct override domains.
    const grid = Array.from({ length: 21 }, (_, k) =>
      Number((k * 0.05).toFixed(2)),
    );
    const N = 64;
    const alive = (() => {
      const refs = [];
      for (let i = 1; i <= N; i++) {
        const ds = compiler.buildDesignSystem({
          systemId: `ce022-retention-${i}`,
          tokens: {
            // An unchecked numeric shape: its entry list is the shared empty
            // one, which must not hold the contexts it was checked against.
            spacing: { c: { value: 'calc(1px + 1px)', visibility: 'public' } },
          },
          propertyDomains: {
            opacity: {
              values: [
                0,
                1,
                ...grid.filter((_, k) => k > 0 && k < 20 && (i >> (k - 1)) & 1),
              ],
            },
          },
        });
        const { properties } = ds.snapshot;
        compiler.tokenUseVerdicts(ds.registry, 'spacing.c', properties);
        refs.push(new WeakRef(compiler.useContextsOf(properties, 'spacing')));
      }
      return refs;
    })();
    // A WeakRef target is kept to the end of the job that created it.
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    const retained = alive.filter((ref) => ref.deref() !== undefined).length;
    // At most the property tables the bounded override cache keeps (16).
    expect(retained).toBeLessThanOrEqual(16);
  });
});
