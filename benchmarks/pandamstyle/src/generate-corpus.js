/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle benchmark corpus generator.
 *
 * DETERMINISM CONTRACT
 *
 * Given identical (components, tokens, recipes, seed, fanout), two generations
 * produce BYTE-IDENTICAL source files and a byte-identical manifest. The only
 * excluded metadata is the environment block, which records what produced the
 * corpus and is not part of the corpus.
 *
 * How that is achieved, and what would break it:
 *
 *  - Randomness comes from a SplitMix64 PRNG seeded only by the `seed`
 *    parameter. `Math.random` and `Date.now` are never called.
 *  - Iteration order is always the numeric order of a generated index, never the
 *    insertion order of a `Set`/`Map` iteration that could depend on a hash.
 *  - No absolute path, hostname, PID, timestamp or locale-dependent formatting
 *    reaches a generated file. The manifest's `environment` block is the single
 *    documented exclusion.
 *  - Object key order in the generated design system is the declaration order,
 *    because `registryDigest` canonicalizes keys anyway and a stable order keeps
 *    the emitted CSS stable.
 *
 * WHAT IS GENERATED
 *
 * A real PandamStyle project, not a pile of repeated files:
 *
 *   design/design.pms.config.js   the design system definition (tokens, themes,
 *                                 conditions, recipes) - NOT a covered root
 *   design/bridge/index.ts        a barrel re-exporting the generated module,
 *                                 so pages reach the design system through a
 *                                 relay rather than directly
 *   src/alias/*.ts                token alias modules (`const SPACE.md = ...`)
 *   src/components/*.tsx          the components: create(), props(), recipes,
 *                                 themes, conditions, TS wrappers
 *   src/valid-invalid/            one negative trace, isolated in its own root
 *
 * `src/valid-invalid` is a SEPARATE declared root. A negative trace that lived
 * inside the main root would make every positive build fail, so the positive
 * and the negative corpora are distinct inputs driven by distinct scenarios.
 *
 * The `invalid` directory is never a root of the positive project, and the
 * positive project never contains a forbidden channel.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENERATOR_VERSION = 'pms-corpus/1.0.0';
const MANIFEST_NAME = 'corpus-manifest.json';

/**
 * SplitMix64. Small, fast, fully specified integer math: the same seed gives
 * the same stream on every platform and every Node version, which `Math.random`
 * explicitly does not promise.
 */
function splitmix32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    t = t ^ (t >>> 15);
    return t >>> 0;
  };
}

function makeRng(seed) {
  const next = splitmix32(seed);
  return {
    next,
    int(maxExclusive) {
      return next() % maxExclusive;
    },
    pick(arr) {
      return arr[next() % arr.length];
    },
  };
}

const TOKEN_CATEGORIES = [
  { name: 'spacing', kind: 'primitive', values: px },
  { name: 'colors', kind: 'both', values: hex },
  { name: 'radii', kind: 'primitive', values: px },
  { name: 'fontSizes', kind: 'primitive', values: px },
  { name: 'fontWeights', kind: 'primitive', values: weights },
  { name: 'lineHeights', kind: 'primitive', values: unitless },
  { name: 'fontFamilies', kind: 'primitive', values: fontStacks },
  { name: 'shadows', kind: 'primitive', values: shadows },
  { name: 'durations', kind: 'primitive', values: ms },
  { name: 'easings', kind: 'primitive', values: keywords },
];

function px(i) {
  return `${(i % 12) * 2 + 2}px`;
}
function hex(i) {
  const v = (i * 37) % 256;
  return `#${v.toString(16).padStart(2, '0')}${(255 - v)
    .toString(16)
    .padStart(2, '0')}aa`;
}
function weights(i) {
  return String([400, 500, 600, 700, 800][i % 5]);
}
function unitless(i) {
  return String([1.2, 1.4, 1.5, 1.6, 1.75][i % 5]);
}
function fontStacks(i) {
  return ['system-ui, sans-serif', 'Georgia, serif', 'ui-monospace, monospace'][
    i % 3
  ];
}
function shadows(i) {
  return `0 ${1 + (i % 4)}px ${2 + (i % 6)}px rgba(11,17,32,0.${10 + (i % 9)})`;
}
function ms(i) {
  return `${80 + (i % 12) * 20}ms`;
}
function keywords(i) {
  return ['ease-in-out', 'linear', 'ease-out', 'cubic-bezier(0.2,0,0,1)'][
    i % 4
  ];
}

const SCALES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'];
const HUES = ['base', 'primary', 'secondary', 'muted', 'accent', 'danger'];
const TONE_VARIANTS = ['primary', 'secondary', 'danger'];
const CONDITION_NAMES = [
  'hover',
  'focus',
  'active',
  'disabled',
  'wide',
  'tall',
  'compact',
  'dark',
];

/**
 * A component SHAPE. Each shape is a distinct, realistic source construct; a
 * corpus of 10,000 components is a repetition of 12 shapes, not a repetition
 * of one, so every transform path in the compiler is exercised at scale.
 */
const COMPONENT_SHAPES = [
  'plain',
  'themed',
  'recipe-static',
  'recipe-props',
  'aliased',
  'conditional',
  'composition',
  'barrel',
  'ts-wrapper',
  'multi-namespace',
  'condition-block',
  'wide',
];

/**
 * Builds the design system definition.
 *
 * `tokenCount` is the TOTAL number of tokens across all categories, split by
 * the category weights below, with the remainder going to the first category.
 * Colors additionally receive semantic aliases that `ref` a primitive in the
 * same category, which is what makes them semantic rather than primitive.
 */
function buildDefinition({ tokenCount, recipeCount, seed, systemId }) {
  const rng = makeRng(seed);
  const categories = {};
  const perCategory = Math.max(
    1,
    Math.floor(tokenCount / TOKEN_CATEGORIES.length),
  );
  let assigned = 0;
  const budget = TOKEN_CATEGORIES.map((c, i) => {
    const n =
      i === TOKEN_CATEGORIES.length - 1
        ? tokenCount - assigned
        : Math.min(perCategory, tokenCount - assigned);
    assigned += n;
    return n;
  });

  TOKEN_CATEGORIES.forEach((cat, ci) => {
    const n = Math.max(1, budget[ci]);
    const node = {};
    const names = cat.name === 'colors' ? HUES : SCALES;
    const cycles = Math.ceil(n / names.length);
    for (let i = 0; i < n; i++) {
      const base = names[i % names.length];
      const key =
        cycles > 1 ? `${base}${i < names.length ? '' : cycles}` : base;
      const value = cat.values(rng.int(97) + i);
      // Every fourth primitive is private: a consumer page that selects it must
      // be refused, so the corpus exercises the visibility rule at scale.
      const visibility = i % 4 === 3 ? 'private' : 'public';
      if (node[key] !== undefined) continue;
      node[key] = { value, visibility };
    }
    categories[cat.name] = node;
  });

  // Semantic layer: public aliases that `ref` a primitive of the SAME category,
  // which is what makes them semantic rather than primitive.
  //
  // The primitives are NOT replaced: they move under `colors.primitive.*` and
  // the semantic names sit beside them. Dropping them would make the generated
  // recipes' own references unresolvable, and a ref that does not resolve is a
  // hard registry error, not a warning.
  const primitiveColors = categories.colors;
  const semantic = {};
  for (const [key, value] of Object.entries(primitiveColors)) {
    if (key.startsWith('primitive.')) continue;
    semantic[`primitive.${key}`] = value;
    semantic[`text.${key}`] = {
      ref: `colors.primitive.${key}`,
      visibility: 'public',
    };
    semantic[`surface.${key}`] = {
      ref: `colors.primitive.${key}`,
      visibility: 'public',
    };
  }
  categories.colors = semantic;

  // A guaranteed-public fallback for every category a style can target, so a
  // generated component never fails to compile for a reason unrelated to the
  // scenario under test.
  for (const cat of TOKEN_CATEGORIES) {
    const first = Object.keys(categories[cat.name] ?? {})[0];
    if (first == null) continue;
    const existing = categories[cat.name][first];
    if (existing.visibility === 'private') existing.visibility = 'public';
  }

  const conditions = {};
  for (let i = 0; i < CONDITION_NAMES.length; i++) {
    const name = CONDITION_NAMES[i];
    if (i % 3 === 0) {
      conditions[name] = `:is(:${name}, [data-${name}])`;
    } else if (i % 3 === 1) {
      conditions[name] = `@media (min-width: ${600 + i * 40}px)`;
    } else {
      conditions[name] = `[data-${name}="true"]`;
    }
  }

  // Every recipe property value is resolved against the categories that were
  // actually generated, so a recipe can never reference a token that does not
  // exist: an unresolvable reference is a hard PMS_UNKNOWN_TOKEN, and a corpus
  // that cannot compile measures nothing.
  const available = (cat) => Object.keys(categories[cat] ?? {});

  // A stable, seed-derived offset so the dark theme rotates across generations
  // without ever depending on iteration order.
  const i0 = (n) => seed % n;
  const recipes = {};
  for (let i = 0; i < recipeCount; i++) {
    const id = `recipe${String(i).padStart(3, '0')}`;
    const tone = TONE_VARIANTS[i % TONE_VARIANTS.length];
    // A deterministic, per-recipe rotation through the available keys: every
    // recipe references real tokens, and different recipes reference different
    // ones, so the recipe corpus exercises the registry rather than one path.
    const key = (cat, n) => {
      const keys = available(cat);
      return `${cat}.${keys[(i + n) % keys.length]}`;
    };
    const recipesDef = {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: key('radii', 0),
        padding: key('spacing', 0),
        fontFamily: key('fontFamilies', 0),
        fontWeight: key('fontWeights', 0),
      },
      variants: {
        tone: {
          primary: {
            backgroundColor: key('colors', 0),
            color: key('colors', 1),
            _hover: { backgroundColor: key('colors', 2) },
          },
          secondary: {
            backgroundColor: key('colors', 3),
            color: key('colors', 4),
          },
          danger: {
            backgroundColor: key('colors', 5),
            color: key('colors', 6),
          },
        },
        size: {
          sm: { fontSize: key('fontSizes', 0), padding: key('spacing', 1) },
          md: { fontSize: key('fontSizes', 1), padding: key('spacing', 2) },
          lg: { fontSize: key('fontSizes', 2), padding: key('spacing', 3) },
        },
        emphasis: {
          low: { fontWeight: key('fontWeights', 1) },
          high: { fontWeight: key('fontWeights', 2) },
        },
      },
      defaultVariants: { tone, size: 'md', emphasis: 'low' },
    };
    recipes[id] = recipesDef;
  }

  // The dark theme overrides two semantic color tokens with a real color path.
  // An override that matches no token is PMS_UNKNOWN_TOKEN, so the two keys are
  // taken from the generated semantic layer rather than hardcoded.
  const semanticColorKeys = available('colors').filter(
    (k) => k.startsWith('surface.') || k.startsWith('text.'),
  );
  const surfaceKey = semanticColorKeys.find((k) => k.startsWith('surface.'));
  const textKey = semanticColorKeys.find((k) => k.startsWith('text.'));
  const primitiveColorKeys = available('colors').filter((k) =>
    k.startsWith('primitive.'),
  );
  const darkOverrides = {};
  if (surfaceKey != null && primitiveColorKeys.length > 0) {
    darkOverrides[surfaceKey] = {
      ref: `colors.${
        primitiveColorKeys[
          (i0(primitiveColorKeys.length) + 1) % primitiveColorKeys.length
        ]
      }`,
    };
  }
  if (textKey != null && primitiveColorKeys.length > 1) {
    darkOverrides[textKey] = {
      ref: `colors.${
        primitiveColorKeys[
          (i0(primitiveColorKeys.length) + 2) % primitiveColorKeys.length
        ]
      }`,
    };
  }
  const themes = {
    light: { tokens: {} },
    dark: {
      tokens:
        Object.keys(darkOverrides).length > 0 ? { colors: darkOverrides } : {},
    },
  };

  return {
    systemId,
    tokens: categories,
    themes,
    conditions,
    recipes,
    __corpus: {
      tokenCount,
      recipeCount,
      seed,
      generatorVersion: GENERATOR_VERSION,
      // The token() marks below are resolved by the config loader below, which
      // rewrites these path strings into real author TokenRefs.
    },
  };
}

/**
 * Renders the definition as a loadable ESM-ish module the CLI can `require`.
 *
 * The values above are PATH STRINGS, not TokenRefs: the registry reads a token
 * reference through the `ref` field, and a style property needs a real
 * `token()` mark. So the emitted config calls `token()` for every property
 * value, exactly as a hand-written design system would.
 */
function renderDefinitionModule(definition) {
  const lines = [
    '/**',
    ' * GENERATED CORPUS - PandamStyle Spike 1 benchmark fixture.',
    ` * ${definition.systemId} - ${definition.tokens ? Object.keys(definition.tokens).length : 0} token categories, ${Object.keys(definition.recipes).length} recipes.`,
    ' * Deterministic from (components, tokens, recipes, seed, fanout).',
    ' */',
    "import { token } from '@pandamstyle/compiler/config';",
    '',
    'const t = (p) => token(p);',
    '',
    `export const systemId = ${JSON.stringify(definition.systemId)};`,
    '',
    'export const tokens = {',
  ];

  for (const cat of Object.keys(definition.tokens)) {
    lines.push(`  ${JSON.stringify(cat)}: {`);
    const node = definition.tokens[cat];
    for (const key of Object.keys(node)) {
      const entry = node[key];
      if (entry.ref != null) {
        // A `ref` is a PATH STRING, not a token() mark: the registry resolves
        // it as a key into its own flat token table, before any style property
        // is ever compiled. `token()` belongs on a style property value.
        lines.push(
          `    ${JSON.stringify(key)}: { ref: ${JSON.stringify(entry.ref)}, visibility: ${JSON.stringify(entry.visibility)} },`,
        );
      } else {
        lines.push(
          `    ${JSON.stringify(key)}: { value: ${JSON.stringify(entry.value)}, visibility: ${JSON.stringify(entry.visibility)} },`,
        );
      }
    }
    lines.push('  },');
  }
  lines.push('};', '');

  lines.push('export const conditions = {');
  for (const name of Object.keys(definition.conditions)) {
    lines.push(
      `  ${JSON.stringify(name)}: ${JSON.stringify(definition.conditions[name])},`,
    );
  }
  lines.push('};', '');

  // A style property needs a TokenRef, so every recipe property value is
  // emitted as `t('<category>.<path>')` and the string keys are turned into
  // their real token paths below.
  lines.push('export const recipes = {');
  for (const id of Object.keys(definition.recipes)) {
    const r = definition.recipes[id];
    lines.push(`  ${JSON.stringify(id)}: {`);
    lines.push('    base: {');
    lines.push(renderStyleObject(definition, r.base, '      '));
    lines.push('    },');
    lines.push('    variants: {');
    for (const axis of Object.keys(r.variants)) {
      lines.push(`      ${JSON.stringify(axis)}: {`);
      for (const value of Object.keys(r.variants[axis])) {
        lines.push(`        ${JSON.stringify(value)}: {`);
        lines.push(
          renderStyleObject(definition, r.variants[axis][value], '          '),
        );
        lines.push('        },');
      }
      lines.push('      },');
    }
    lines.push('    },');
    lines.push(`    defaultVariants: ${JSON.stringify(r.defaultVariants)},`);
    lines.push('  },');
  }
  lines.push('};', '');

  lines.push('export const themes = {');
  for (const name of Object.keys(definition.themes)) {
    const t2 = definition.themes[name];
    if (Object.keys(t2.tokens ?? {}).length === 0) {
      lines.push(`  ${JSON.stringify(name)}: { tokens: {} },`);
      continue;
    }
    lines.push(`  ${JSON.stringify(name)}: { tokens: { colors: {`);
    for (const k of Object.keys(t2.tokens.colors)) {
      lines.push(
        `      ${JSON.stringify(k)}: { ref: ${JSON.stringify(t2.tokens.colors[k].ref)} },`,
      );
    }
    lines.push('    } } },');
  }
  lines.push('};', '');

  lines.push(
    'export default { systemId, tokens, themes, conditions, recipes };',
    '',
  );
  return lines.join('\n');
}

/**
 * Recipe property values are written as `<category>.<key>`; resolve them to the
 * real path inside the generated token tree, which is `<category>.<key>` for
 * primitive categories and `colors.<key>` for the semantic color layer.
 */
/**
 * A recipe property value is already a full `<category>.<key>` path: the recipe
 * builder resolved it against the generated categories before the module was
 * rendered. This is the identity pass-through that names the invariant, so a
 * future call site that passes a bare key is visibly wrong rather than silently
 * emitting an unresolvable token.
 */
function tokenPathFor(definition, raw) {
  if (typeof raw !== 'string') return raw;
  const dot = raw.indexOf('.');
  if (dot <= 0) return raw;
  const cat = raw.slice(0, dot);
  const node = definition.tokens[cat];
  if (node == null || node[raw.slice(dot + 1)] == null) {
    throw new Error(
      `corpus generator bug: token path "${raw}" is not in category "${cat}"`,
    );
  }
  return raw;
}

/**
 * Property kinds, matching packages/compiler/src/design-system/policy/properties.js.
 *
 * A structural property (`display`, `alignItems`, ...) admits a FINITE literal
 * domain; a category property (`padding`, `color`, ...) admits a token of one
 * category and nothing else. Emitting `token()` for a structural property is a
 * PMS_FORBIDDEN_VALUE, and emitting a literal for a category property is too -
 * so the generator has to know which is which, and the knowledge is stated here
 * rather than guessed from the property name.
 */
const STRUCTURAL_PROPS = new Set([
  'display',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'boxSizing',
  'width',
  'marginInline',
]);
const STRUCTURAL_NUMBERS = new Set([
  'opacity',
  'flex',
  'flexGrow',
  'flexShrink',
]);
const STRUCTURAL_SAMPLE = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  boxSizing: 'border-box',
  width: '100%',
  marginInline: 'auto',
  opacity: 1,
  flex: 1,
  flexGrow: 0,
  flexShrink: 1,
};

/** Renders a whole style declaration object. */
function renderStyleObject(definition, obj, indent) {
  return Object.keys(obj)
    .map((prop) => renderProperty(definition, prop, obj[prop], indent))
    .join('\n');
}

/** Renders one style property value the way the policy admits it. */
function renderProperty(definition, prop, value, indent) {
  if (STRUCTURAL_PROPS.has(prop)) {
    return `${indent}${JSON.stringify(prop)}: ${JSON.stringify(STRUCTURAL_SAMPLE[prop])},`;
  }
  if (STRUCTURAL_NUMBERS.has(prop)) {
    return `${indent}${JSON.stringify(prop)}: ${STRUCTURAL_SAMPLE[prop]},`;
  }
  if (value != null && typeof value === 'object') {
    const inner = Object.keys(value)
      .map((k) => renderProperty(definition, k, value[k], `${indent}  `))
      .join('\n');
    return `${indent}${JSON.stringify(prop)}: {\n${inner}\n${indent}},`;
  }
  return `${indent}${JSON.stringify(prop)}: t(${JSON.stringify(tokenPathFor(definition, value))}),`;
}

const HEADER =
  '/**\n' +
  ' * GENERATED CORPUS - PandamStyle Spike 1 benchmark fixture.\n' +
  ' * Do not edit: regenerating with the same parameters reproduces this file\n' +
  ' * byte for byte.\n' +
  ' */\n';

function componentSource(spec) {
  const {
    index,
    shape,
    tokens,
    recipes,
    conditions,
    themeNames,
    relImportDepth,
  } = spec;
  const L = [];
  L.push(HEADER.trim());
  L.push('');

  // The components live in <root>/src/components, the barrel in <root>/bridge
  // and the generated module in <root>/.pandamstyle, so both live two levels up.
  const dsImportPath =
    relImportDepth > 0
      ? '../../bridge'
      : '../../.pandamstyle/design.pandamstyle.js';
  L.push('import {');
  L.push('  create,');
  L.push('  token,');
  L.push('  recipes,');
  L.push('  themes,');
  L.push('  props,');
  L.push(`} from '${dsImportPath}';`);
  L.push('');

  // `tokens` is the per-category KEY list; a token() call needs the full
  // `<category>.<key>` path, so every reference goes through this.
  const pickPath = (category, salt) => {
    const keys = tokens[category];
    return `${category}.${keys[(index + salt) % keys.length]}`;
  };
  const pick = (arr, salt) => arr[(index + salt) % arr.length];

  // LOCAL token constants.
  //
  // A `const X = token('...')` in the same file and a bare `X` inside
  // `create({...})` is the P0 identifier-folding path in evaluate-usage.js, and
  // it is supported. A token imported ACROSS files is not: the fork evaluator
  // resolves local constants only, so a cross-file alias is correctly refused
  // with PMS_NON_STATIC_VALUE rather than being laundered. The corpus therefore
  // folds through local constants, and the cross-file case is left to the
  // negative root rather than smuggled into the positive one.
  const localAliases = [];
  if (shape === 'aliased' || index % 4 === 0) {
    const a0 = `LOCAL_SPACE_${index}`;
    const a1 = `LOCAL_INK_${index}`;
    L.push(`const ${a0} = token('${pickPath('spacing', index % 3)}');`);
    L.push(`const ${a1} = token('${pickPath('colors', index % 5)}');`);
    L.push('');
    localAliases.push(a0, a1);
  }

  if (shape === 'barrel') {
    // A re-export of a local helper: the module graph must follow it and the
    // compiler must not treat the relay as a design system.
    L.push(
      `export { helper${(index % 4) + 1} as helper${index} } from '../alias/alias${index % 4}.ts';`,
    );
    L.push('');
  }

  const cond = pick(conditions, 0);
  const cond2 = pick(conditions, 3);
  const recipeId = pick(recipes, 1);
  const themeName = pick(themeNames, 2);

  const styleLines = [];

  if (shape === 'condition-block') {
    styleLines.push('  block: {');
    styleLines.push(`    padding: token('${pickPath('spacing', 2)}'),`);
    styleLines.push(`    color: token('${pickPath('colors', 1)}'),`);
    styleLines.push(`    _${cond}: {`);
    styleLines.push(`      padding: token('${pickPath('spacing', 5)}'),`);
    styleLines.push('    },');
    styleLines.push(`    _${cond2}: {`);
    styleLines.push(`      color: token('${pickPath('colors', 6)}'),`);
    styleLines.push('    },');
    styleLines.push('  },');
  } else if (shape === 'multi-namespace') {
    for (const ns of ['root', 'body', 'footer', 'header']) {
      styleLines.push(`  ${ns}: {`);
      styleLines.push(`    padding: token('${pickPath('spacing', 2)}'),`);
      styleLines.push(`    color: token('${pickPath('colors', 1)}'),`);
      styleLines.push('  },');
    }
  } else if (shape === 'wide') {
    styleLines.push('  panel: {');
    for (const prop of [
      'padding',
      'marginTop',
      'marginBottom',
      'paddingLeft',
      'paddingRight',
    ]) {
      styleLines.push(`    ${prop}: token('${pickPath('spacing', 3)}'),`);
    }
    for (const prop of ['color', 'backgroundColor', 'borderColor']) {
      styleLines.push(`    ${prop}: token('${pickPath('colors', 4)}'),`);
    }
    styleLines.push(`    borderRadius: token('${pickPath('radii', 0)}'),`);
    styleLines.push(`    fontSize: token('${pickPath('fontSizes', 1)}'),`);
    styleLines.push(`    lineHeight: token('${pickPath('lineHeights', 2)}'),`);
    styleLines.push(`    boxShadow: token('${pickPath('shadows', 1)}'),`);
    styleLines.push('    _hover: {');
    styleLines.push('      opacity: 0.9,');
    styleLines.push('    },');
    styleLines.push('  },');
  } else if (shape === 'themed') {
    styleLines.push('  root: {');
    styleLines.push(`    backgroundColor: token('${pickPath('colors', 7)}'),`);
    styleLines.push(`    color: token('${pickPath('colors', 8)}'),`);
    styleLines.push(`    padding: token('${pickPath('spacing', 9)}'),`);
    styleLines.push('  },');
  } else if (shape === 'conditional') {
    // Two namespaces, because the conditional composition below needs a
    // PROVEN one: `cond ? null : null` has no provenance on either branch, and
    // the compiler correctly refuses to admit it. The admitted form is the
    // idiomatic one: a guarded namespace.
    styleLines.push('  root: {');
    styleLines.push(`    padding: token('${pickPath('spacing', 4)}'),`);
    styleLines.push('  },');
    styleLines.push('  active: {');
    styleLines.push(`    backgroundColor: token('${pickPath('colors', 5)}'),`);
    styleLines.push(`    _${cond}: {`);
    styleLines.push(`      color: token('${pickPath('colors', 6)}'),`);
    styleLines.push('    },');
    styleLines.push('  },');
  } else if (shape === 'aliased' || localAliases.length > 0) {
    // Uses the local constants declared above; a bare identifier that folds
    // through a binding, which is the path this shape exists to exercise.
    styleLines.push('  root: {');
    styleLines.push(`    padding: ${localAliases[0]},`);
    styleLines.push(`    color: ${localAliases[1]},`);
    styleLines.push('  },');
  } else {
    styleLines.push('  root: {');
    styleLines.push(`    padding: token('${pickPath('spacing', 2)}'),`);
    styleLines.push(`    color: token('${pickPath('colors', 1)}'),`);
    styleLines.push('  },');
    styleLines.push('  label: {');
    styleLines.push(`    fontSize: token('${pickPath('fontSizes', 2)}'),`);
    styleLines.push(`    fontWeight: token('${pickPath('fontWeights', 3)}'),`);
    styleLines.push('  },');
  }

  L.push('const styles = create({');
  L.push(...styleLines);
  L.push('});');
  L.push('');

  const useTheme = shape === 'themed' || shape === 'composition';
  const useRecipe =
    shape === 'recipe-static' ||
    shape === 'recipe-props' ||
    shape === 'composition' ||
    index % 5 === 0;

  // TS wrapper: a typed props interface on a component, so the corpus contains
  // real TypeScript that pass 2 has to strip.
  L.push('export type ComponentProps = {');
  L.push('  label: string;');
  L.push('  active?: boolean;');
  L.push('  tone?: string;');
  L.push('};');
  L.push('');

  L.push(
    `export function Component${index}({ label, active = false, tone }: ComponentProps) {`,
  );
  if (shape === 'recipe-props') {
    // A selection that depends on a prop is folded to the bounded runtime
    // guard rather than a static branch list, which is the other recipe path.
    L.push(`  const cls = props(styles.root, recipes.${recipeId}({ tone }));`);
  } else if (useRecipe) {
    L.push(
      `  const cls = props(styles.root, recipes.${recipeId}({ tone: 'primary', size: 'md' }));`,
    );
  } else if (useTheme) {
    L.push(`  const cls = props(themes.${themeName}, styles.root);`);
  } else if (shape === 'conditional') {
    // A guarded composition: the right side of `&&` is what must carry
    // provenance, and it does.
    L.push('  const cls = props(styles.root, active && styles.active);');
  } else {
    L.push('  const cls = props(styles.root, styles.label);');
  }
  L.push('  return (');
  L.push('    <div {...cls}>');
  L.push('      <span>{label}</span>');
  L.push('    </div>');
  L.push('  );');
  L.push('}');
  L.push('');
  L.push(`export default Component${index};`);
  L.push('');
  return L.join('\n');
}

function aliasModuleSource(index, tokens) {
  const L = [HEADER.trim(), ''];
  // <root>/src/alias -> <root>/.pandamstyle is two levels up. A wrong depth
  // here is a PMS_COVERAGE_GAP, which is how this was found.
  L.push("import { token } from '../../.pandamstyle/design.pandamstyle.js';");
  L.push('');
  const spacing = tokens.spacing;
  const colors = tokens.colors;
  L.push(
    `export const SPACE_${index} = token(${JSON.stringify(`spacing.${spacing[index % spacing.length]}`)});`,
  );
  L.push(
    `export const INK_${index} = token(${JSON.stringify(`colors.${colors[index % colors.length]}`)});`,
  );
  L.push(`export const helper${index} = (v) => v;`);
  L.push('');
  return L.join('\n');
}

/** Alias identifiers a component may import, per alias module. */
const ALIAS_EXPORTS = [
  ['SPACE_0', 'INK_0'],
  ['SPACE_1', 'INK_1'],
  ['SPACE_2', 'INK_2'],
  ['SPACE_3', 'INK_3'],
];

function negativeSource(kind, privatePaths) {
  const L = [HEADER.trim(), ''];
  // <root>/src/invalid -> <root>/.pandamstyle is TWO levels up. A negative
  // trace that cannot resolve its design system would fail with a coverage gap
  // instead of the policy code under test, which would be a false pass.
  L.push(
    "import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';",
  );
  L.push('');
  switch (kind) {
    case 'forbidden-value':
      L.push('const styles = create({');
      L.push('  root: {');
      // 17px is not a token: PMS_FORBIDDEN_VALUE, and no autofix.
      L.push("    padding: '17px',");
      L.push('  },');
      L.push('});');
      break;
    case 'forbidden-channel':
      L.push('export function Bad() {');
      L.push('  return <div style={{ padding: 8 }} />;');
      L.push('}');
      break;
    case 'non-static':
      L.push('export function Bad({ v }) {');
      L.push('  const styles = create({ root: { padding: v } });');
      L.push('  return <div {...props(styles.root)}>{v}</div>;');
      L.push('}');
      break;
    case 'private-token': {
      // A REAL private token of this corpus, so the refusal is a policy verdict
      // and not an unknown-token accident.
      const priv = privatePaths.spacing;
      const path =
        priv.length > 0
          ? `spacing.${priv[0]}`
          : Object.keys(privatePaths)[0] != null
            ? `${Object.keys(privatePaths)[0]}.${privatePaths[Object.keys(privatePaths)[0]][0]}`
            : 'spacing.md';
      L.push('const styles = create({');
      L.push('  root: {');
      L.push(`    padding: token('${path}'),`);
      L.push('  },');
      L.push('});');
      L.push('export function P() {');
      L.push('  return <div {...props(styles.root)} />;');
      L.push('}');
      break;
    }
    default:
      L.push('export const ok = 1;');
  }
  L.push('');
  return L.join('\n');
}

const NEGATIVE_KINDS = [
  'forbidden-value',
  'forbidden-channel',
  'non-static',
  'private-token',
];

/**
 * The token path lists a component generator draws from, derived from the
 * DEFINITION so a component can never reference a token that does not exist.
 *
 * PUBLIC and PRIVATE are kept apart on purpose. A component is generated once
 * and then compiled thousands of times; a single private reference would make
 * every positive build fail with PMS_TOKEN_NOT_PUBLIC, and a corpus that cannot
 * compile measures nothing. The private paths are not discarded: the isolated
 * negative root uses one, which is how the visibility rule stays covered at
 * scale.
 */
function publicPaths(definition) {
  const pub = {};
  const priv = {};
  for (const cat of Object.keys(definition.tokens)) {
    pub[cat] = [];
    priv[cat] = [];
    for (const key of Object.keys(definition.tokens[cat])) {
      const entry = definition.tokens[cat][key];
      if (entry.visibility === 'private') priv[cat].push(key);
      else pub[cat].push(key);
    }
  }
  return { public: pub, private: priv };
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeFileDeterministic(root, rel, content, files) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = Buffer.from(content, 'utf8');
  fs.writeFileSync(abs, buf);
  files.push({
    path: rel,
    bytes: buf.length,
    sha256: sha256(buf),
  });
}

/**
 * Generates a corpus.
 *
 * @param {object} options
 * @param {number} options.components  how many page components
 * @param {number} options.tokens     how many tokens in the design system
 * @param {number} options.recipes    how many recipes in the design system
 * @param {number} options.seed       the only source of randomness
 * @param {number} options.fanout     extra local modules per component (0..N)
 * @param {string} options.outDir     destination
 * @param {boolean} [options.negative] also emit the isolated negative root
 * @returns {object} the manifest
 */
function generate(options) {
  const {
    components,
    tokens: tokenCount,
    recipes: recipeCount,
    seed,
    fanout = 0,
    outDir,
    negative = false,
    generatorCommit = null,
  } = options;

  if (!Number.isInteger(components) || components < 1) {
    throw new Error(`components must be a positive integer, got ${components}`);
  }
  if (!Number.isInteger(tokenCount) || tokenCount < 1) {
    throw new Error(`tokens must be a positive integer, got ${tokenCount}`);
  }
  if (!Number.isInteger(recipeCount) || recipeCount < 0) {
    throw new Error(
      `recipes must be a non-negative integer, got ${recipeCount}`,
    );
  }
  if (!Number.isInteger(seed)) {
    throw new Error(`seed must be an integer, got ${seed}`);
  }

  const root = path.resolve(outDir);
  // Only the paths this generator writes are cleared. The harness installs a
  // `node_modules/@pandamstyle/compiler` symlink into the corpus root so a
  // generated design system resolves `@pandamstyle/compiler` the way an
  // installed application does; wiping the whole root would destroy it on every
  // regeneration and make the corpus depend on generation order.
  for (const owned of [
    'design',
    'bridge',
    'src',
    '.pandamstyle',
    '.pandamstyle-negative',
    MANIFEST_NAME,
  ]) {
    fs.rmSync(path.join(root, owned), { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });

  const name = `c${components}-t${tokenCount}-r${recipeCount}-s${seed}-f${fanout}`;
  const systemId = `corpus-${name}@0.1`;
  const definition = buildDefinition({
    tokenCount,
    recipeCount,
    seed,
    systemId,
  });

  const files = [];

  // 1. The design system definition. NOT a covered root: it is an input, and it
  //    must never be analysed as a page.
  writeFileDeterministic(
    root,
    'design/design.pms.config.js',
    renderDefinitionModule(definition),
    files,
  );

  // 2. The barrel. Pages reach the design system through it, so the compiler's
  //    relay walk is on the hot path of every single component.
  const bridge = [
    HEADER.trim(),
    '',
    '/**',
    ' * Relay barrel. Pages import the design system through here, never',
    ' * directly, so the re-export walk is exercised by every component.',
    ' */',
    'export {',
    '  __pandamstyle,',
    '  create,',
    '  token,',
    '  recipes,',
    '  themes,',
    '  props,',
    '  manifest,',
    "} from '../.pandamstyle/design.pandamstyle.js';",
    '',
  ];
  writeFileDeterministic(root, 'bridge/index.ts', bridge.join('\n'), files);

  // 3. Alias modules.
  const paths = publicPaths(definition);
  for (let i = 0; i < ALIAS_EXPORTS.length; i++) {
    writeFileDeterministic(
      root,
      `src/alias/alias${i}.ts`,
      aliasModuleSource(i, paths.public),
      files,
    );
  }

  // 4. Fanout helpers: extra local modules per component, so the module graph
  //    has a measured fanout instead of a flat list.
  if (fanout > 0) {
    for (let i = 0; i < fanout; i++) {
      writeFileDeterministic(
        root,
        `src/fanout/fan${i}.ts`,
        [
          HEADER.trim(),
          '',
          `export const fan${i}Label = 'fan-${i}';`,
          `export function fan${i}(x: number): number { return x + ${i}; }`,
          '',
        ].join('\n'),
        files,
      );
    }
  }

  // 5. The components.
  const recipeIds = Object.keys(definition.recipes);
  const themeNames = ['light', 'dark'];
  const conditionNames = Object.keys(definition.conditions);
  let styleSiteCount = 0;
  let recipeCallCount = 0;
  let tokenRefCount = 0;
  let maxRelayDepth = 0;

  for (let i = 0; i < components; i++) {
    const shape = COMPONENT_SHAPES[i % COMPONENT_SHAPES.length];
    // Every third component reaches the design system through the barrel; the
    // rest import it directly. Both paths are in the corpus because they are
    // different compiler paths (relay walk vs direct marker read).
    const relImportDepth = i % 3 === 0 ? 1 : 0;
    if (relImportDepth > maxRelayDepth) maxRelayDepth = relImportDepth;
    const src = componentSource({
      index: i,
      shape,
      tokens: paths.public,
      recipes: recipeIds.length > 0 ? recipeIds : ['none'],
      conditions: conditionNames,
      themeNames,
      relImportDepth,
    });
    writeFileDeterministic(
      root,
      `src/components/Component${i}.tsx`,
      src,
      files,
    );

    styleSiteCount += (src.match(/^\s+[a-zA-Z]+: /gm) ?? []).length;
    tokenRefCount += (src.match(/token\('/g) ?? []).length;
    recipeCallCount += (src.match(/recipes\./g) ?? []).length;
  }

  // 6. The build config. It names the covered roots, so the positive project
  //    NEVER covers the definition or the barrel.
  const config = [
    '/**',
    ' * GENERATED CORPUS - PandamStyle Spike 1 benchmark fixture.',
    ' */',
    "const path = require('path');",
    '',
    'module.exports = {',
    "  definition: './design/design.pms.config.js',",
    "  roots: ['./src/components'],",
    "  outDir: './.pandamstyle',",
    "  runtimeModule: '@pandamstyle/compiler/runtime',",
    '  useCSSLayers: false,',
    '  engineOptions: {},',
    '};',
    '',
  ];
  writeFileDeterministic(
    root,
    'pandamstyle.config.js',
    config.join('\n'),
    files,
  );

  // 7. The isolated negative root. It has its OWN config, because a forbidden
  //    channel inside the positive root would make every positive build fail.
  if (negative) {
    for (const kind of NEGATIVE_KINDS) {
      writeFileDeterministic(
        root,
        `src/invalid/${kind}.tsx`,
        negativeSource(kind, paths.private),
        files,
      );
    }
    const negConfig = [
      '/**',
      ' * GENERATED CORPUS - PandamStyle Spike 1 benchmark fixture.',
      ' */',
      'module.exports = {',
      "  definition: './design/design.pms.config.js',",
      // A FILE root, not a directory: a directory root would cover every
      // negative trace at once, and the point is one policy verdict per trace.
      `  roots: ['./src/invalid/${NEGATIVE_KINDS[0]}.tsx'],`,
      "  outDir: './.pandamstyle',",
      "  runtimeModule: '@pandamstyle/compiler/runtime',",
      '};',
      '',
    ];
    writeFileDeterministic(
      root,
      'pandamstyle.negative.config.js',
      negConfig.join('\n'),
      files,
    );
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const designSystemFile = files.find((f) =>
    f.path.startsWith('design/design.pms.config.js'),
  );

  // The corpus content hash: every generated file, path and content, in path
  // order. Two generations with the same parameters MUST agree on this.
  const contentHash = sha256(
    Buffer.from(
      files.map((f) => `${f.path}\u0000${f.sha256}\n`).join(''),
      'utf8',
    ),
  );

  const manifest = {
    documentKind: 'pandamstyle-benchmark-corpus-manifest',
    schemaVersion: 1,
    generator: {
      version: GENERATOR_VERSION,
      commit: generatorCommit,
    },
    parameters: {
      components,
      tokens: tokenCount,
      recipes: recipeCount,
      seed,
      fanout,
    },
    name,
    // The corpus identity. A run is only comparable to another run when this
    // matches, and it is what a re-generation is checked against.
    contentHash,
    designSystemHash: designSystemFile.sha256,
    counts: {
      sourceFiles: files.length,
      componentFiles: components,
      aliasModules: ALIAS_EXPORTS.length,
      fanoutModules: fanout,
      bridgeModules: 1,
      definitionModules: 1,
      invalidTraces: negative ? NEGATIVE_KINDS.length : 0,
      styleSites: styleSiteCount,
      tokenReferences: tokenRefCount,
      recipeCalls: recipeCallCount,
      conditions: conditionNames.length,
      themes: themeNames.length,
      recipeDefinitions: recipeIds.length,
      tokenCategories: Object.keys(paths).length,
      tokenPaths: Object.values(paths.public).reduce((a, b) => a + b.length, 0),
      privateTokenPaths: Object.values(paths.private).reduce(
        (a, b) => a + b.length,
        0,
      ),
    },
    // The graph shape the generator actually produced, as declared intent. The
    // MEASURED graph is recorded by the harness after a real build; this is the
    // expected shape, kept separate so a generator bug is visible.
    expectedGraph: {
      rootDepth: 1,
      // A barrel hop when a component imports through it.
      maxRelayDepth,
      fanout,
      shapes: COMPONENT_SHAPES,
      shapeDistribution: COMPONENT_SHAPES.length,
    },
    expectedState: {
      // The positive project compiles and publishes.
      positive: 'ok',
      // Each negative trace is expected to FAIL with its own PMS code. The
      // exact codes are asserted by the negative scenarios, not by the
      // generator, so a policy change cannot silently move the goalposts here.
      negative: negative ? 'fail-closed' : 'not-run',
    },
    files,
  };

  fs.writeFileSync(
    path.join(root, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

module.exports = {
  generate,
  GENERATOR_VERSION,
  MANIFEST_NAME,
  COMPONENT_SHAPES,
  NEGATIVE_KINDS,
  buildDefinition,
  renderDefinitionModule,
  splitmix32,
};
