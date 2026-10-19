/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-00.3 measurement workloads. Every workload is materialized from frozen
// inputs only: Git objects at a pinned commit, a committed derivation record,
// or a seeded generator. Its content digest is the identity of every number
// measured against it, and `materialize()` refuses a digest that differs from
// the frozen workload record.
//
// A materialized project contains `design.mjs` (the definition module),
// `src/**` and `package.json`. The harness links `node_modules` to the epoch
// closure being measured, so one project runs unchanged against any epoch.

import fs from 'node:fs';
import path from 'node:path';
import {
  gitBlob,
  gitFiles,
  mulberry32,
  readJson,
  sha256,
  BENCH,
} from './lib.mjs';

export const WORKLOADS_FILE = path.join(BENCH, 'workloads.v1.json');

export const PACKAGE_JSON = `${JSON.stringify(
  { private: true, type: 'module' },
  null,
  2,
)}\n`;

// The generated design-system module, relative to the project root.
export const OUT_DIR = 'generated';
export const DESIGN_MODULE = 'design.pandamstyle.js';

// ------------------------------------------------------------ project digest

export function projectDigest(files) {
  const lines = Object.keys(files)
    .sort()
    .map((file) => `${file} ${sha256(files[file])}`);
  return sha256(lines.join('\n'));
}

// ---------------------------------------------------- Alpha 1 fixture inputs

// The compiler's own valid fixture, read from the baseline commit.
function alpha1ValidFixture({ commit }) {
  const base = 'packages/compiler/__tests__/pandamstyle/fixtures';
  const files = {
    'package.json': PACKAGE_JSON,
    'design.mjs': gitBlob(
      commit,
      `${base}/_shared/design.pms.config.mjs`,
    ).toString('utf8'),
  };
  for (const file of gitFiles(commit, `${base}/valid/src`))
    files[file.slice(`${base}/valid/`.length)] = gitBlob(commit, file).toString(
      'utf8',
    );
  return files;
}

// The Vite React pilot application, read from the baseline commit. It keeps
// its own Vite configuration so the same project serves the host build.
function alpha1Pilot({ commit }) {
  const base = 'examples/pilots/vite-react';
  const files = { 'package.json': PACKAGE_JSON };
  for (const file of gitFiles(commit, base)) {
    const rel = file.slice(base.length + 1);
    if (
      rel === 'package.json' ||
      rel === 'agentdoc.yaml' ||
      rel === 'README.md'
    )
      continue;
    files[rel === 'design.pandamstyle.config.js' ? 'design.mjs' : rel] =
      gitBlob(commit, file).toString('utf8');
  }
  // The pilot configuration names its definition file; point it at design.mjs.
  files['vite.config.js'] = files['vite.config.js'].replace(
    "definition: './design.pandamstyle.config.js'",
    "definition: './design.mjs'",
  );
  return files;
}

// --------------------------------------------------- CE-00.2 corpus workload

// Builds a project from the committed derivation record: each included
// CE-00.2 corpus declaration becomes one declaration of a create() namespace.
// Category values become public tokens of the policy category; structural
// values stay literal. Selector and at-rule contexts are flattened: this is a
// compile-cost workload, not a fidelity claim.
function ceCorpus({ record }) {
  const derivation = readJson(path.join(BENCH, record));
  const tokens = {};
  for (const [category, entries] of Object.entries(derivation.tokens)) {
    tokens[category] = {};
    for (const [name, value] of Object.entries(entries))
      tokens[category][name] = { value, visibility: 'public' };
  }
  const definition = {
    systemId: 'ce-corpus@1',
    tokens,
    themes: { light: { tokens: {} } },
    conditions: {},
    recipes: {},
  };
  const files = {
    'package.json': PACKAGE_JSON,
    'design.mjs': `// Derived from ${record}; do not edit.\nexport default ${JSON.stringify(definition, null, 2)};\n`,
  };
  for (const sheet of derivation.stylesheets) {
    const lines = [
      `// ${sheet.fixtureId}: ${sheet.declarations.length} included declarations.`,
      `import { create, token, props } from '../${OUT_DIR}/design.pandamstyle';`,
      '',
      'const styles = create({',
    ];
    const namespaces = [];
    let current = null;
    for (const declaration of sheet.declarations) {
      if (current == null || current.properties.has(declaration.property)) {
        current = {
          name: `n${namespaces.length}`,
          properties: new Set(),
          lines: [],
        };
        namespaces.push(current);
      }
      current.properties.add(declaration.property);
      const value =
        declaration.token != null
          ? `token(${JSON.stringify(declaration.token)})`
          : JSON.stringify(declaration.literal);
      current.lines.push(
        `    ${declaration.property}: ${value}, // ${declaration.id}`,
      );
    }
    for (const namespace of namespaces)
      lines.push(`  ${namespace.name}: {`, ...namespace.lines, '  },');
    lines.push('});', '');
    lines.push(
      `export const all = [${namespaces.map((n) => `props(styles.${n.name})`).join(', ')}];`,
      '',
    );
    files[`src/${sheet.slug}.jsx`] = lines.join('\n');
  }
  return files;
}

// --------------------------------------------------------- synthetic corpora

const SPACING = (i) => `${(i + 1) * 2}px`;
const hex = (random) =>
  `#${Math.floor(random() * 0xffffff)
    .toString(16)
    .padStart(6, '0')}`;

// Skewed pick: low indices are chosen more often, as shared atoms are in real
// applications.
function skewed(random, n) {
  return Math.min(n - 1, Math.floor(Math.pow(random(), 2) * n));
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

// Token budget split across the Alpha 1 categories; every category gets at
// least one token so every category-bound property is usable.
function tokenPlan(total) {
  const weights = {
    spacing: 0.24,
    radii: 0.04,
    palette: 0.24,
    semantic: 0.24,
    fontSizes: 0.06,
    fontWeights: 0.02,
    lineHeights: 0.03,
    letterSpacings: 0.02,
    shadows: 0.04,
    durations: 0.03,
    easings: 0.04,
  };
  return Object.fromEntries(
    Object.entries(weights).map(([k, w]) => [
      k,
      Math.max(1, Math.round(total * w)),
    ]),
  );
}

const STRUCTURAL = [
  ['display', ['flex', 'inline-flex', 'block', 'grid', 'inline-block']],
  ['flexDirection', ['row', 'column']],
  ['alignItems', ['flex-start', 'center', 'stretch', 'baseline']],
  ['justifyContent', ['flex-start', 'center', 'space-between']],
  ['position', ['relative', 'absolute']],
  ['overflow', ['hidden']],
  ['whiteSpace', ['nowrap']],
  ['width', ['100%', 'fit-content', '24px', '32px']],
  ['height', ['24px', '32px', '40px', '100%']],
  ['maxWidth', ['100%', '240px', '320px']],
  ['borderWidth', ['1px']],
  ['borderStyle', ['solid']],
  ['textAlign', ['left', 'start']],
];
const NUMERIC = [
  ['opacity', [0.4, 0.6, 0.8, 1]],
  ['flexGrow', [0, 1, 2]],
  ['flexShrink', [0, 1]],
];

function syntheticDefinition(params, random) {
  const plan = tokenPlan(params.tokens);
  const tokens = {
    spacing: {},
    radii: {},
    colors: { p: {}, s: {} },
    fontFamilies: {
      body: { value: 'system-ui, sans-serif', visibility: 'public' },
      mono: { value: 'ui-monospace, monospace', visibility: 'public' },
    },
    fontSizes: {},
    fontWeights: {},
    lineHeights: {},
    letterSpacings: {},
    shadows: {},
    durations: {},
    easings: {},
  };
  for (let i = 0; i < plan.spacing; i++)
    tokens.spacing[`s${i}`] = { value: SPACING(i), visibility: 'public' };
  for (let i = 0; i < plan.radii; i++)
    tokens.radii[`r${i}`] = { value: `${i + 1}px`, visibility: 'public' };
  for (let i = 0; i < plan.palette; i++)
    tokens.colors.p[`c${i}`] = { value: hex(random), visibility: 'private' };
  for (let i = 0; i < plan.semantic; i++)
    tokens.colors.s[`c${i}`] = {
      ref: `colors.p.c${skewed(random, plan.palette)}`,
      visibility: 'public',
    };
  for (let i = 0; i < plan.fontSizes; i++)
    tokens.fontSizes[`f${i}`] = { value: `${10 + i}px`, visibility: 'public' };
  for (let i = 0; i < plan.fontWeights; i++)
    tokens.fontWeights[`w${i}`] = {
      value: String(100 * ((i % 9) + 1)),
      visibility: 'public',
    };
  for (let i = 0; i < plan.lineHeights; i++)
    tokens.lineHeights[`l${i}`] = {
      value: (1 + i * 0.05).toFixed(2),
      visibility: 'public',
    };
  for (let i = 0; i < plan.letterSpacings; i++)
    tokens.letterSpacings[`t${i}`] = {
      value: `${(i * 0.01).toFixed(2)}em`,
      visibility: 'public',
    };
  for (let i = 0; i < plan.shadows; i++)
    tokens.shadows[`h${i}`] = {
      value: `0 ${i + 1}px ${2 * (i + 1)}px rgba(0, 0, 0, 0.${(i % 8) + 1})`,
      visibility: 'public',
    };
  for (let i = 0; i < plan.durations; i++)
    tokens.durations[`d${i}`] = {
      value: `${50 * (i + 1)}ms`,
      visibility: 'public',
    };
  const curves = ['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear'];
  for (let i = 0; i < plan.easings; i++)
    tokens.easings[`e${i}`] = {
      value:
        i < curves.length ? curves[i] : `cubic-bezier(0.${i % 10}, 0, 0.2, 1)`,
      visibility: 'public',
    };

  const dark = { colors: { s: {} } };
  for (let i = 0; i < plan.semantic; i += 5)
    dark.colors.s[`c${i}`] = { ref: `colors.p.c${(i * 7 + 3) % plan.palette}` };

  const ref = (category, prefix, n) => ({
    __token: `${category}.${prefix}${skewed(random, n)}`,
  });
  const spacingRef = () => ref('spacing', 's', plan.spacing);
  const colorRef = () => ref('colors.s', 'c', plan.semantic);
  const recipes = {};
  for (let r = 0; r < params.recipes; r++) {
    const toneCount = 2 + (r % 3);
    const sizeCount = 2 + (r % 2);
    const tone = {};
    for (let t = 0; t < toneCount; t++)
      tone[`t${t}`] = {
        color: colorRef(),
        backgroundColor: colorRef(),
        _hover: { backgroundColor: colorRef() },
      };
    const size = {};
    for (let s = 0; s < sizeCount; s++)
      size[`z${s}`] = {
        padding: spacingRef(),
        fontSize: ref('fontSizes', 'f', plan.fontSizes),
        borderRadius: ref('radii', 'r', plan.radii),
      };
    const variants = { tone, size };
    if (r % 4 === 0)
      variants.emphasis = {
        quiet: { opacity: 0.8 },
        loud: { fontWeight: ref('fontWeights', 'w', plan.fontWeights) },
      };
    const compoundVariants =
      r % 2 === 0
        ? [
            {
              tone: 't0',
              size: ['z0', 'z1'],
              css: { boxShadow: ref('shadows', 'h', plan.shadows) },
            },
          ]
        : [];
    recipes[`rec${r}`] = {
      base: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: spacingRef(),
        fontFamily: { __token: 'fontFamilies.body' },
        transitionDuration: ref('durations', 'd', plan.durations),
        transitionTimingFunction: ref('easings', 'e', plan.easings),
      },
      variants,
      defaultVariants: { tone: 't0', size: 'z0' },
      ...(compoundVariants.length > 0 ? { compoundVariants } : {}),
    };
  }
  return {
    definition: {
      systemId: `synthetic-${params.id}@1`,
      tokens,
      themes: { light: { tokens: {} }, dark: { tokens: dark } },
      conditions: {
        hover: ':is(:hover, [data-hover])',
        focus: ':is(:focus-visible, [data-focus])',
        disabled: ':is(:disabled, [aria-disabled="true"])',
        wide: '@media (min-width: 768px)',
        reducedMotion: '@media (prefers-reduced-motion: reduce)',
      },
      recipes,
    },
    plan,
  };
}

// Serializes a definition, turning { __token } markers into token() calls.
function definitionModule(definition, header) {
  const body = JSON.stringify(definition, null, 2).replace(
    /\{\s*"__token":\s*("[^"]+")\s*\}/g,
    'token($1)',
  );
  return `${header}\nimport { token } from '@pandamstyle/compiler/config';\n\nexport default ${body};\n`;
}

function syntheticComponent(i, params, plan, random) {
  const s = () => `token('spacing.s${skewed(random, plan.spacing)}')`;
  const c = () => `token('colors.s.c${skewed(random, plan.semantic)}')`;
  const declarations = () => {
    const out = [];
    const used = new Set();
    const add = (property, value) => {
      if (used.has(property)) return;
      used.add(property);
      out.push(`    ${property}: ${value},`);
    };
    const count = 3 + Math.floor(random() * 5);
    while (out.length < count) {
      const roll = random();
      if (roll < 0.25)
        add(
          pick(random, [
            'padding',
            'gap',
            'margin',
            'paddingInline',
            'paddingBlock',
            'rowGap',
          ]),
          s(),
        );
      else if (roll < 0.45)
        add(
          pick(random, [
            'color',
            'backgroundColor',
            'borderColor',
            'outlineColor',
          ]),
          c(),
        );
      else if (roll < 0.55)
        add('borderRadius', `token('radii.r${skewed(random, plan.radii)}')`);
      else if (roll < 0.62)
        add(
          'fontSize',
          `token('fontSizes.f${skewed(random, plan.fontSizes)}')`,
        );
      else if (roll < 0.66)
        add(
          'lineHeight',
          `token('lineHeights.l${skewed(random, plan.lineHeights)}')`,
        );
      else if (roll < 0.7) add('padding', `{ base: ${s()}, wide: ${s()} }`);
      else if (roll < 0.74) add('color', `{ base: ${c()}, hover: ${c()} }`);
      else if (roll < 0.92) {
        const [property, values] = pick(random, STRUCTURAL);
        add(property, `'${pick(random, values)}'`);
      } else {
        const [property, values] = pick(random, NUMERIC);
        add(property, String(pick(random, values)));
      }
    }
    return out;
  };
  const recipe = `rec${skewed(random, params.recipes)}`;
  const dynamicRecipe = `rec${(i * 31) % params.recipes}`;
  const tsx = i % 4 === 0;
  const name = `C${String(i).padStart(5, '0')}`;
  const lines = [
    `import { create, token, props, recipes, patterns, themes } from '../../${OUT_DIR}/design.pandamstyle';`,
    '',
    'const styles = create({',
    '  root: {',
    ...declarations(),
    '  },',
    '  label: {',
    ...declarations(),
    '  },',
    '  active: {',
    `    backgroundColor: token('colors.s.c${i % plan.semantic}'),`,
    '  },',
    '});',
    '',
    `const layout = patterns.stack({ gap: ${s()}, align: 'center' });`,
    `const action = recipes.${recipe}({ tone: 't0', size: 'z1' });`,
    '',
    tsx
      ? `export function ${name}({ active, tone }: { active?: boolean; tone?: 't0' | 't1' }) {`
      : `export function ${name}({ active, tone }) {`,
    '  return (',
    `    <section {...props(${i % 3 === 0 ? 'themes.dark, ' : ''}styles.root, layout)}>`,
    `      <span {...props(styles.label, active && styles.active)}>${name}</span>`,
    '      <button {...props(action)}>a</button>',
    `      <button {...props(recipes.${dynamicRecipe}({ tone }))}>b</button>`,
    '    </section>',
    '  );',
    '}',
    '',
  ];
  return {
    file: `src/components/${name}.${tsx ? 'tsx' : 'jsx'}`,
    text: lines.join('\n'),
  };
}

function synthetic(params) {
  const random = mulberry32(params.seed);
  const { definition, plan } = syntheticDefinition(params, random);
  const files = {
    'package.json': PACKAGE_JSON,
    'design.mjs': definitionModule(
      definition,
      `// Synthetic workload ${params.id} (generator v1, seed ${params.seed}); generated, do not edit.`,
    ),
  };
  for (let i = 0; i < params.components; i++) {
    const component = syntheticComponent(i, params, plan, random);
    files[component.file] = component.text;
  }
  return files;
}

// ----------------------------------------------------------------- registry

const BUILDERS = {
  'alpha1-valid-fixture': alpha1ValidFixture,
  'alpha1-pilot': alpha1Pilot,
  'ce-corpus': ceCorpus,
  synthetic,
};

export function buildFiles(workload) {
  const builder = BUILDERS[workload.source.kind];
  if (builder == null)
    throw new Error(`unknown workload source ${workload.source.kind}`);
  return builder(workload.source);
}

export function loadWorkloads(file = WORKLOADS_FILE) {
  return readJson(file);
}

export function findWorkload(id, record = loadWorkloads()) {
  const workload = record.workloads.find((w) => w.id === id);
  if (workload == null) throw new Error(`unknown workload ${id}`);
  return workload;
}

// Writes the project into `dir` (which must not exist) and checks its digest
// against the frozen record unless `allowUnfrozen` is set.
export function materialize(workload, dir, { allowUnfrozen = false } = {}) {
  const files = buildFiles(workload);
  const digest = projectDigest(files);
  if (!allowUnfrozen && digest !== workload.contentSha256)
    throw new Error(
      `workload ${workload.id} materializes to ${digest}, not the frozen ${workload.contentSha256}`,
    );
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return {
    digest,
    files: Object.keys(files).length,
    bytes: Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0),
  };
}

// CLI: node tools/baselines/workloads.mjs digest [<id> ...]
//      node tools/baselines/workloads.mjs materialize <id> <dir>
if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const record = loadWorkloads();
  if (command === 'digest') {
    const ids = rest.length > 0 ? rest : record.workloads.map((w) => w.id);
    for (const id of ids) {
      const workload = findWorkload(id, record);
      const files = buildFiles(workload);
      const digest = projectDigest(files);
      const bytes = Object.values(files).reduce(
        (n, t) => n + Buffer.byteLength(t),
        0,
      );
      const status = digest === workload.contentSha256 ? 'frozen' : 'DIFFERS';
      console.log(
        `${id} ${digest} files=${Object.keys(files).length} bytes=${bytes} ${status}`,
      );
    }
  } else if (command === 'materialize') {
    const [id, dir] = rest;
    console.log(
      JSON.stringify(materialize(findWorkload(id, record), path.resolve(dir))),
    );
  } else {
    console.error(
      'usage: workloads.mjs digest [ids...] | materialize <id> <dir>',
    );
    process.exitCode = 2;
  }
}
