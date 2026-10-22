/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.2 (AC3): the declaration-equivalence normaliser against the
 * supported minifier configurations, generated at test time:
 *   - esbuild with whitespace minification (Vite `build.cssMinify: 'esbuild'`
 *     whitespace path);
 *   - Lightning CSS with `minify: true` and Vite's default `build.cssTarget`.
 * Inputs: the compiler's emitted CSS for the valid fixture and a variant with
 * `:nth-child()`, attribute, `@supports`, `@container`, range-media
 * conditions, a quoted font family and `userSelect`; one input per emittable
 * construct; the review probes. Every output is accepted, except the rewrites
 * listed in BY_DESIGN with their reason; every accepted output that carries
 * the `-webkit-user-select` pair is rejected once that declaration is dropped.
 */

const fs = require('fs');
const path = require('path');
const { openProject } = require('./session-helpers');

const REPO = path.resolve(__dirname, '../../../..');
const { declarationEquivalence } = require(
  path.join(REPO, 'tools/pms/css-equivalence.cjs'),
);
const esbuild = require('esbuild');
const lightningcss = require('lightningcss');
const browserslist = require('browserslist');

// Vite 8.3.1 `build.cssTarget` default, as Lightning CSS targets.
const TARGETS = lightningcss.browserslistToTargets(
  browserslist('chrome 111, edge 111, firefox 114, safari 16.4, ios_saf 16.4'),
);
const MINIFIERS = {
  esbuild: (css) =>
    esbuild.transformSync(css, { loader: 'css', minifyWhitespace: true }).code,
  lightningcss: (css) =>
    lightningcss
      .transform({
        filename: 'styles.css',
        code: Buffer.from(css),
        minify: true,
        targets: TARGETS,
      })
      .code.toString(),
};

const VALUE = 'changes a declared value';
const BY_DESIGN = {
  esbuild: {
    B2: 'merges two identifiers into one (foo/**/bar becomes foobar)',
    B3: 'collapses whitespace inside a custom property value',
    B7: 'merges tokens inside a custom property value',
  },
  lightningcss: {
    dir: 'rewrites :dir() as a :lang() list, which changes its meaning',
    numbers: `${VALUE}: 0px becomes 0 and +1px becomes 1px`,
    rotate: `${VALUE}: rotate(0deg) becomes rotate(0)`,
    flex: `${VALUE}: the flex shorthand is collapsed`,
    'hex upper': `${VALUE}: hex colours are shortened`,
    'hex lower 6': `${VALUE}: hex colours are shortened`,
    rgb: `${VALUE}: rgb() becomes a colour name`,
    rgba: `${VALUE}: rgba() becomes an 8-digit hex colour`,
    shadow: `${VALUE}: rgba() becomes an 8-digit hex colour`,
    'custom prop': `${VALUE}: a colour inside a custom property is shortened`,
    'media and':
      'rewrites min-/max- features as range syntax, which needs range support on every target',
    'container named':
      'rewrites min-/max- features as range syntax, which needs range support on every target',
    keyframes: `${VALUE}: rotate(0deg) becomes rotate(0)`,
    B3: 'collapses whitespace inside a custom property value',
    B4: `${VALUE}: blue becomes #00f`,
    B7: 'merges tokens inside a custom property value',
    'emitted valid fixture': `${VALUE} (hex colours in custom properties) and rewrites min-width as range syntax`,
    'emitted rich fixture': `${VALUE} (hex colours in custom properties) and rewrites min-width as range syntax`,
  },
};

const CONSTRUCTS = [
  ['nth-child An+B', '.x:nth-child(2n + 1){color:red}'],
  ['nth-last-child', '.x:nth-last-child(-n + 3){color:red}'],
  ['nth-of-type odd', '.x:nth-of-type(odd){color:red}'],
  ['nth-last-of-type', '.x:nth-last-of-type(3n - 2){color:red}'],
  ['nth-child of S', '.x:nth-child(2n + 1 of .a, .b){color:red}'],
  ['nth-child even', '.x:nth-child(even){color:red}'],
  ['nth-child 2n', '.x:nth-child(2n){color:red}'],
  ['not list', '.x:not(.a, .b){color:red}'],
  ['is list', '.x:is(.a, .b) .c{color:red}'],
  ['where', '.x:where(.a){color:red}'],
  ['has relative', '.x:has(> .a){color:red}'],
  ['dir', '.x:dir(rtl){color:red}'],
  ['lang', '.x:lang(en){color:red}'],
  ['focus-visible', '.x:focus-visible{outline:2px solid red}'],
  ['before content', '.x::before{content:"a"}'],
  ['after empty', ".x::after{content:''}"],
  ['part', '.x::part(label){color:red}'],
  ['slotted', '::slotted(.a){color:red}'],
  ['placeholder', '.x::placeholder{color:red}'],
  ['attr string', '.x[data-x="a"]{color:red}'],
  ['attr spaced', '.x[data-x="a b"]{color:red}'],
  ['attr i', '.x[data-x="a" i]{color:red}'],
  ['attr s', ".x[data-x='a' s]{color:red}"],
  ['attr ~=', '.x[data-x~="a"]{color:red}'],
  ['attr |=', '[lang|="en"]{color:red}'],
  ['attr ^=', '[href^="https://"]{color:red}'],
  ['attr presence', '.x[data-x]{color:red}'],
  ['html dir', "html[dir='rtl'] .x{color:red}"],
  ['url double', '.x{background-image:url("a.png")}'],
  ['url single space', ".x{background-image:url('a b.png')}"],
  ['url bare', '.x{background-image:url(a.png)}'],
  ['url absolute', '.x{background-image:url("https://example.com/a.png")}'],
  ['string escape', '.x{content:"\\201C"}'],
  ['quotes', '.x{quotes:"«" "»"}'],
  ['font-family list', '.x{font-family:"Helvetica Neue", Arial, sans-serif}'],
  ['font-family single', ".x{font-family:'Segoe UI'}"],
  ['font-family ident', '.x{font-family:system-ui, -apple-system, sans-serif}'],
  ['numbers', '.x{margin:0.5px -0.25rem +1px 0px}'],
  ['line-height', '.x{line-height:1.50}'],
  ['calc', '.x{width:calc(100% - 2px)}'],
  ['opacity', '.x{opacity:.5}'],
  ['rotate', '.x{transform:rotate(0deg)}'],
  ['duration', '.x{transition-duration:0.30s}'],
  ['z-index', '.x{z-index:10}'],
  ['percent', '.x{width:100.0%}'],
  ['flex', '.x{flex:1 1 0%}'],
  ['hex upper', '.x{color:#FFFFFF}'],
  ['hex lower 6', '.x{color:#112233}'],
  ['rgb', '.x{color:rgb(255, 0, 0)}'],
  ['rgba', '.x{color:rgba(0, 0, 0, 0.5)}'],
  ['shadow', '.x{box-shadow:0 1px 2px rgba(0, 0, 0, 0.1)}'],
  ['var fallback', '.x{color:var(--a, red)}'],
  ['custom prop', ':root, .x{--a:16px;--b:#ffffff}'],
  ['important', '.x{color:red !important}'],
  [
    'media and',
    '@media (min-width: 768px) and (max-width: 1023px){.x{color:red}}',
  ],
  [
    'media type',
    '@media screen and (prefers-reduced-motion: reduce){.x{color:red}}',
  ],
  ['media range', '@media (width >= 600px){.x{color:red}}'],
  [
    'media hover',
    '@media (hover: hover) and (pointer: fine){.x:hover{color:red}}',
  ],
  ['media forced', '@media (forced-colors: active){.x{color:red}}'],
  [
    'supports',
    '@supports (display: grid) and (not (display: inline-grid)){.x{color:red}}',
  ],
  ['supports selector', '@supports selector(:has(a)){.x{color:red}}'],
  ['container named', '@container card (min-width: 400px){.x{color:red}}'],
  ['container range', '@container (inline-size > 30em){.x{color:red}}'],
  ['layer statement', '@layer priority1, priority2;'],
  ['layer block', '@layer priority2{.x:hover{color:red}}'],
  ['ladder', '.x:not(#\\#):not(#\\#){display:block}'],
  [
    'user-select pair',
    '.x:not(#\\#){-webkit-user-select:none;user-select:none}',
  ],
  [
    'keyframes',
    '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
  ],
  [
    'property',
    '@property --x { syntax: "<color>"; inherits: true; initial-value: red }',
  ],
  ['B1', '[title] .a{color:red}'],
  ['B1b', '.a:is(:where(.b) .c){color:red}'],
  ['B2', '.a{font-family:foo/**/bar}'],
  ['B3', '.a{--x: a  b}'],
  ['B4', '@layer{.a{color:red!important}}@layer{.a{color:blue!important}}'],
  ['B5', '@media (width: 1px){.a{color: red}}'],
  ['B6', '.a{COLOR:red}'],
  ['B6b', '.\\61{color:red}'],
  ['B7', '.a{--x:foo/**/bar;font-family:var(--x)}'],
  ['B8', '#\\31{color:red}'],
  ['B9', '.a:nth-child(2n + 1){color:red}'],
  ['B10', '.a[data-x="a" i]{color:red}'],
];

function emitted() {
  const plain = openProject('valid');
  plain.full();
  const valid = fs.readFileSync(path.join(plain.outDir, 'styles.css'), 'utf8');
  const h = openProject('valid');
  const definition = fs
    .readFileSync(h.sharedDefinitionPath, 'utf8')
    .replace(
      "reducedMotion: '@media (prefers-reduced-motion: reduce)',",
      `reducedMotion: '@media (prefers-reduced-motion: reduce)',
    odd: ':nth-child(2n + 1)',
    oddRow: ':nth-child(2n + 1 of .row, .item)',
    open: '[data-state="open" i]',
    grid: '@supports (display: grid)',
    card: '@container card (min-width: 400px)',
    range: '@media (width >= 600px) and (hover: hover)',`,
    )
    .replace(
      "base: { value: 'system-ui, sans-serif', visibility: 'public' },",
      "base: { value: '\"Helvetica Neue\", Arial, system-ui, sans-serif', visibility: 'public' },",
    );
  fs.writeFileSync(h.sharedDefinitionPath, definition);
  const page = h.src('src/page.js');
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, 'utf8')
      .replace(
        'padding: { base: SPACING.md, wide: SPACING.lg },',
        "padding: { base: SPACING.md, wide: SPACING.lg, odd: SPACING.md, oddRow: SPACING.lg, open: SPACING.lg, grid: SPACING.md, card: SPACING.lg, range: SPACING.md },\n    userSelect: 'none',",
      ),
  );
  h.reloadDefinition();
  h.full();
  const rich = fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');
  return [
    ['emitted valid fixture', valid],
    ['emitted rich fixture', rich],
  ];
}

const EMITTED = emitted();
const INPUTS = [...EMITTED, ...CONSTRUCTS];
const CASES = INPUTS.flatMap(([name, css]) =>
  Object.keys(MINIFIERS).map((minifier) => [minifier, name, css]),
);

test('the rich fixture emits the constructs it is meant to cover', () => {
  const rich = EMITTED[1][1];
  for (const fragment of [
    ':nth-child(2n + 1)',
    ':nth-child(2n + 1 of .row, .item)',
    '[data-state="open" i]',
    '@supports (display: grid)',
    '@container card (min-width: 400px)',
    '@media (width >= 600px) and (hover: hover)',
    '"Helvetica Neue", Arial, system-ui, sans-serif',
    '-webkit-user-select:none;user-select:none',
  ]) {
    expect({ fragment, emitted: rich.includes(fragment) }).toEqual({
      fragment,
      emitted: true,
    });
  }
});

test('every rejection by design names an input that exists', () => {
  const names = new Set(INPUTS.map(([name]) => name));
  for (const [minifier, entries] of Object.entries(BY_DESIGN)) {
    for (const name of Object.keys(entries)) {
      expect({ minifier, name, exists: names.has(name) }).toEqual({
        minifier,
        name,
        exists: true,
      });
    }
  }
});

test.each(CASES)('%s: %s', (minifier, name, css) => {
  const delivered = MINIFIERS[minifier](css);
  const result = declarationEquivalence(css, delivered);
  const reason = BY_DESIGN[minifier][name];
  if (reason != null) {
    expect({ name, equivalent: result.equivalent }).toEqual({
      name,
      equivalent: false,
    });
    return;
  }
  expect({ name, delivered, difference: result.difference }).toEqual({
    name,
    delivered,
    difference: null,
  });
  // The sibling mutation of the real output: the prefixed pair dropped.
  const pair = /-webkit-user-select\s*:[^;}]*;/;
  if (pair.test(delivered)) {
    expect(
      declarationEquivalence(css, delivered.replace(pair, '')).equivalent,
    ).toBe(false);
  }
});
