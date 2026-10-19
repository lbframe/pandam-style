/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC2: a construct is never reported native from its parent's
 * statement when BCD records the way it is written as a subfeature.
 *
 * The guard is derived from the bundled data. Every BCD subfeature of a path
 * an emitted construct is evaluated on, and every `css.types.*` path a value
 * can reach, is either extracted as its own feature key (executed here on
 * example CSS), native on every engine at the minimum floor (decision O13,
 * derived from the data), or reviewed (`not-css-syntax`,
 * `base-form-unaffected`). A path added by a data update fails until it is
 * classified.
 */

const fs = require('fs');
const path = require('path');
const { loadCompiler, openProject } = require('./session-helpers');

const REPO = path.resolve(__dirname, '../../../..');
const TARGETS_SRC = path.join(REPO, 'packages/compiler/src/targets');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const { targets } = loadCompiler();
const DATA = readJson(path.join(TARGETS_SRC, 'data/compat-data.v1.json'));
const REVIEWS = readJson(path.join(TARGETS_SRC, 'catalog/subfeatures.v1.json'));

// Example CSS for every construct family the extractor maps. Pseudo-class
// spellings are generated only for pseudo-classes and pseudo-elements, and
// function spellings only for functions: these are the BCD selector keys that
// are simple selectors or combinators, and the value types under a function
// family that are not functions.
const NOT_PSEUDO = new Set([
  'attribute',
  'class',
  'id',
  'type',
  'universal',
  'child',
  'descendant',
  'next-sibling',
  'subsequent-sibling',
  'list',
  'nesting',
  'column',
  'namespace',
]);
const NOT_FUNCTION = new Set(['named-color', 'system-color']);
// The `css.types.<name>` nodes, split by BCD's description: a function is
// called (`abs()`), a value type is not (`<number>`). A node in neither list
// fails the guard until it is classified.
const FUNCTION_TYPES = new Set(
  (
    '-moz-image-rect abs acos anchor anchor-size asin atan atan2 attr calc ' +
    'calc-size clamp cos counter counters dynamic-range-limit-mix env exp ' +
    'hypot if log max min mod param pow progress random random-item ray rem ' +
    'round sibling-count sibling-index sign sin sqrt superellipse tan type ' +
    'url var'
  ).split(' '),
);
const VALUE_TYPES = new Set(
  (
    'angle angle-percentage basic-shape blend-mode calc-keyword color ' +
    'corner-shape-value dashed-function dimension easing-function ' +
    'filter-function flex global_keywords gradient image integer length ' +
    'length-percentage line-style line-width number overflow percentage ' +
    'position ratio resolution shape string text-edge time ' +
    'timeline-range-name transform-function'
  ).split(' '),
);
// Value types whose keywords the catalog reads where a property takes them.
const TYPE_KEYWORD_PROPERTY = {
  'color.named-color': 'color',
  'color.system-color': 'color',
  overflow: 'overflow-block',
  'text-edge': 'text-box-edge',
  'corner-shape-value': 'corner-shape',
  'timeline-range-name': 'animation-range',
};
const IDENT = /^-?[A-Za-z][A-Za-z0-9-]*$/;
const UNITS = (
  'px cm mm in pt pc q em rem ex rex ch rch cap rcap ic ric lh rlh vw vh vi ' +
  'vb vmin vmax svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin lvmax dvw ' +
  'dvh dvi dvb dvmin dvmax cqw cqh cqi cqb cqmin cqmax deg grad rad turn s ' +
  'ms dpi dpcm dppx x fr'
).split(' ');
const FAMILY_PROPERTY = {
  color: 'color',
  gradient: 'background-image',
  image: 'background-image',
  'transform-function': 'transform',
  'filter-function': 'filter',
  'easing-function': 'transition-timing-function',
  'basic-shape': 'clip-path',
};
const ENV = [
  'keyboard-inset-bottom',
  'keyboard-inset-height',
  'keyboard-inset-left',
  'keyboard-inset-right',
  'keyboard-inset-top',
  'keyboard-inset-width',
  'preferred-text-scale',
  'safe-area-inset-bottom',
  'safe-area-inset-left',
  'safe-area-inset-right',
  'safe-area-inset-top',
  'titlebar-area-height',
  'titlebar-area-width',
  'titlebar-area-x',
  'titlebar-area-y',
  'viewport-segment-bottom',
  'viewport-segment-height',
  'viewport-segment-left',
  'viewport-segment-right',
  'viewport-segment-top',
  'viewport-segment-width',
];
const PAGE_MARGINS = [
  'bottom-center',
  'bottom-left',
  'bottom-left-corner',
  'bottom-right',
  'bottom-right-corner',
  'left-bottom',
  'left-middle',
  'left-top',
  'right-bottom',
  'right-middle',
  'right-top',
  'top-center',
  'top-left',
  'top-left-corner',
  'top-right',
  'top-right-corner',
];
// One example per syntax form the extractor maps.
const FORMS = [
  '.x:nth-child(2 of .y){color:red}',
  '.x:nth-last-child(2 of .y){color:red}',
  '.x{overflow:hidden auto}',
  '.x{text-overflow:clip ellipsis}',
  '.x{color:rgb(1 2 3 / .5)}',
  '.x{color:rgb(1, 2, 3, .5)}',
  '.x{color:rgb(1.5, 2, 3)}',
  '.x{color:rgb(1 20% 3)}',
  '.x{color:hsl(1 2% 3%)}',
  '.x{color:hsl(1, 2%, 3%, .5)}',
  '.x{color:hsl(1 2% 3)}',
  '.x{color:hwb(1 2% 3)}',
  '.x{color:lab(50% 4 5)}',
  '.x{color:lch(50% 4 5)}',
  '.x{color:oklab(50% .1 .1)}',
  '.x{color:oklch(50% .1 5)}',
  '.x{color:color(display-p3-linear 1 0 0)}',
  '.x{color:color(srgb 1 50% 0)}',
  '.x{color:rgb(from currentcolor r g b)}',
  ...[
    'rgb(from red r g b)',
    'hsl(from red h s l)',
    'hwb(from red h w b)',
    'lab(from red l a b)',
    'lch(from red l c h)',
    'oklab(from red l a b)',
    'oklch(from red l c h)',
    'color(from red srgb r g b)',
  ].map((v) => `.x{color:${v}}`),
  '.x{color:color-mix(in srgb, red, blue, green)}',
  '.x{background-image:light-dark(url(a.png), url(b.png))}',
  '.x{background-image:linear-gradient(0, red, 10%, blue 20% 30%)}',
  '.x{background-image:linear-gradient(in oklch longer hue, red)}',
  '.x{background-image:linear-gradient(to right, red, blue)}',
  '.x{background-image:radial-gradient(at top, red, 10%, blue 1% 2%)}',
  '.x{background-image:radial-gradient(in oklch longer hue, red)}',
  '.x{background-image:conic-gradient(in oklch longer hue, red, blue 1% 2%)}',
  '.x{background-image:conic-gradient(red)}',
  '.x{background-image:repeating-linear-gradient(0, red, 10%, blue 1% 2%)}',
  '.x{background-image:repeating-linear-gradient(to right, red)}',
  '.x{background-image:repeating-linear-gradient(in oklch longer hue, red)}',
  '.x{background-image:repeating-radial-gradient(at top, red, 10%, blue 1% 2%)}',
  '.x{background-image:repeating-radial-gradient(in oklch longer hue, red)}',
  '.x{background-image:repeating-conic-gradient(in oklch longer hue, red)}',
  '.x{background-image:linear-gradient(red calc(1% + 1px), blue)}',
  '.x{width:calc(calc(1px + 2px) * 2)}',
  '.x{color:rgb(calc(1 + 2) 2 3)}',
  '.x{width:calc(1px / 1px * 1px)}',
  '.x{width:calc(sign(1px / 1px) * 1px)}',
  '.x{width:mod(10%, 1px)}',
  '.x{width:rem(10%, 1px)}',
  '.x{width:round(10%, 1px)}',
  '.x{transition-timing-function:steps(2, jump-end)}',
  '.x{transform:perspective(none)}',
  '.x{transform:translateZ(1px)}',
  '.x{transform:rotateX(1deg)}',
  '.x{clip-path:circle(closest-corner)}',
  '.x{clip-path:circle(farthest-corner)}',
  '.x{clip-path:ellipse(closest-corner)}',
  '.x{clip-path:ellipse(farthest-corner)}',
  '.x{clip-path:polygon(round 1px, 0 0)}',
  '.x{offset-path:path("M0 0")}',
  '.x{clip-path:shape(from 0 0, line to 1px 1px)}',
  '.x{offset-path:ray(45deg closest-side at 0 0)}',
  '.x{width:progress(1px, 0px, 2px no-clamp)}',
  '.x{width:random(--a element-shared by 1px, 1px, 2px)}',
  '.x{width:attr(data-x type(<length>), 1px)}',
  '.x{content:attr(data-x raw-string)}',
  '.x{width:if(style(--x: 1): 1px)}',
  ...ENV.map((name) => `.x{width:env(${name})}`),
  '.x{border-radius:1px 2px 3px 4px / 1px}',
  '.x{border-top-left-radius:1px 2px}',
  '.x{border-top-right-radius:1px 2px}',
  '.x{border-bottom-left-radius:1px 2px}',
  '.x{border-bottom-right-radius:1px 2px}',
  '.x{content:"a" / "b" counter(c)}',
  '.x{cursor:url(a.png) 1 2, auto}',
  '.x{font-size:1rem}',
  '.x{z-index:-1}',
  '.x{box-shadow:1px 1px 1px 1px red, 0 0 red}',
  '.x{background:url(a.png), url(b.png)}',
  '.x{background-image:url(a.png), url(b.png)}',
  '.x{mask-image:url(a.png), url(b.png)}',
  '.x{clip-path:circle(1px)}',
  '.x{text-decoration:underline dotted red 2px}',
  '.x{white-space:preserve nowrap}',
  '.x{font:condensed 1px a}',
  '.x{transition-property:opacity}',
  '.x{transition:display 1s, tab-size 1s, width 1s, clip-path 1s}',
  '@keyframes k{from{display:none!important}}',
  '@keyframes k{entry 0%{color:red}}',
  ...['align-content', 'align-items', 'align-self'].flatMap((p) => [
    `.x{${p}:first baseline}`,
    `.x{${p}:last baseline}`,
  ]),
  '.x{display:block flex}',
  '.x{color:currentColor;border-color:currentcolor}',
  ...[
    'rebeccapurple',
    'transparent',
    'AccentColor',
    'AccentColorText',
    'ButtonBorder',
    'Mark',
    'MarkText',
  ].map((c) => `.x{color:${c}}`),
  '.x[a=b i]{color:red}',
  '.x[a=b s]{color:red}',
  '.x::before::marker{color:red}',
  '.x::after::marker{color:red}',
  '.x::column::scroll-marker{color:red}',
  '.x:not(.a, .b){color:red}',
  '.x:lang(en, fr){color:red}',
  '.x:lang("*-Latn"){color:red}',
  '.x::cue(.a){color:red}',
  ...[
    'block-end',
    'block-start',
    'down',
    'inline-end',
    'inline-start',
    'left',
    'right',
    'up',
    '*',
  ].map((d) => `.x::scroll-button(${d}){color:red}`),
  '.x::selection{text-decoration:underline}',
  '.x::marker{counter-increment:a;quotes:none}',
  '.x::before{transition:color 1s}',
  '.x::after{animation:a 1s}',
  '.x::marker{transition:color 1s}',
  '.x::backdrop{background:var(--a)}',
  '.x{width:attr(data-x, 1px)}',
  '@media (a) or (b){.x{color:red}}',
  '@media (width > 1px){.x{color:red}}',
  '@media (min-width: calc(1px + 1em)){.x{color:red}}',
  ...[
    'display-mode: standalone',
    'display-mode: browser',
    'display-mode: fullscreen',
    'display-mode: minimal-ui',
    'display-mode: picture-in-picture',
    'display-mode: window-controls-overlay',
    'color-gamut: p3',
    'color-gamut: rec2020',
    'color-gamut: srgb',
    'prefers-color-scheme: no-preference',
  ].map((q) => `@media (${q}){.x{color:red}}`),
  ...[
    'scroll-state(stuck: top)',
    'scroll-state(snapped: x)',
    'scroll-state(scrollable: top)',
    'scroll-state(scrolled: top)',
    'style(--x > 1)',
    'anchored(fallback: x)',
    'name',
  ].map((q) => `@container ${q}{.x{color:red}}`),
  '@supports named-feature(anchor-position-follows-transforms){.x{color:red}}',
  '@supports named-feature(single-axis-scroll-container){.x{color:red}}',
  '@import url(a.css) layer(x) supports(display: grid);',
  ...['landscape', 'portrait', 'jis-b4', 'jis-b5'].map(
    (size) => `@page{size:${size}}`,
  ),
  ...PAGE_MARGINS.map((box) => `@page{@${box}{content:"x"}}`),
  '@font-face{src:url(a) format(woff2) tech(color-colrv1)}',
  '@font-face{src:url(a) format("woff")}',
  '@font-face{src:url(a) format("svg")}',
  '@font-face{src:url(a) format("woff2-variations")}',
  ...['color-colrv0', 'color-svg', 'color-sbix', 'color-cbdt'].map(
    (tech) => `@font-face{src:url(a) tech(${tech})}`,
  ),
  '.x{width:attr(ns|data-x)}',
  '@function --f(){result:1px}',
  '@container anchored(fallback: --a){.x{color:red}}',
  '.x{width:if(style(--x > 1): 1px)}',
  '.x{d:path("M0 0")}',
  '@keyframes k{from{top:anchor(--a top);left:anchor-size(width)}}',
  '.x{margin-top:anchor-size(width)}',
  '.x{aspect-ratio:1.5}',
  '.x{corner-shape:superellipse(2)}',
  '@keyframes k{scroll 0%{color:red}}',
];

/** Example CSS for every family, generated from the bundled paths. */
function examples() {
  const out = [...FORMS];
  for (const unit of UNITS) out.push(`.x{width:1${unit}}`);
  for (const key of Object.keys(DATA.paths)) {
    const [, top, a, b] = key.split('.');
    const depth = key.split('.').length;
    if (top === 'properties') {
      out.push(`.x{${a}:inherit}`);
      if (b != null && IDENT.test(b))
        out.push(`.x{${a}:${b}}`, `.x{${a}:${b}(1px)}`);
      if (b != null && b.endsWith('_function')) {
        out.push(`.x{${a}:${b.slice(0, -9)}(1px)}`);
      }
    } else if (top === 'selectors' && a === 'attribute') {
      out.push('.x[a]{color:red}');
    } else if (top === 'selectors' && IDENT.test(a) && !NOT_PSEUDO.has(a)) {
      for (const s of [`:${a}`, `::${a}`, `:${a}(.y)`, `::${a}(.y)`]) {
        out.push(`.x${s}{color:red}`);
      }
    } else if (top === 'at-rules' && depth === 3) {
      out.push(
        `@${a} x{.x{color:red}}`,
        `@${a}{.x{color:red}}`,
        `@${a} (min-width:1px){.x{color:red}}`,
        `@${a} x;`,
      );
    } else if (top === 'at-rules' && depth === 4 && IDENT.test(b)) {
      out.push(
        `@media (${b}){.x{color:red}}`,
        `@media (${b}:1){.x{color:red}}`,
        `@supports ${b}(x){.x{color:red}}`,
        `@${a}{${b}:x}`,
        `@${a} x{${b}:x}`,
      );
    } else if (top === 'types') {
      const leaf = key.split('.').at(-1);
      const typeNode = key.split('.').slice(2, -1).join('.');
      // A custom property reads functions on their type node; a property may
      // record its own (`width: anchor-size()`).
      if (depth === 3 && FUNCTION_TYPES.has(a)) {
        out.push(`.x{width:${a}(1px)}`, `.x{--x:${a}(1px)}`);
      }
      if (
        depth >= 4 &&
        Object.hasOwn(FAMILY_PROPERTY, a) &&
        IDENT.test(b) &&
        !NOT_FUNCTION.has(b)
      ) {
        out.push(`.x{${FAMILY_PROPERTY[a]}:${b}(1px)}`, `.x{--x:${b}(1px)}`);
      }
      if (Object.hasOwn(TYPE_KEYWORD_PROPERTY, typeNode)) {
        out.push(`.x{${TYPE_KEYWORD_PROPERTY[typeNode]}:${leaf}}`);
      }
      if (typeNode === 'calc-keyword')
        out.push(`.x{width:calc(${leaf} * 1px)}`);
      if (typeNode === 'global_keywords') out.push(`.x{color:${leaf}}`);
      if (typeNode === 'attr.type_function') {
        out.push(`.x{width:attr(data-x type(<${leaf}>))}`);
      }
      if (typeNode === 'url')
        out.push(`.x{background-image:url("a" ${leaf}(x))}`);
    }
  }
  return out;
}

/** A profile at the minimum floor (decision O13): every engine at its floor. */
const MINIMUM = (() => {
  const names = {
    chrome: 'chrome',
    chrome_android: 'and_chr',
    edge: 'edge',
    firefox: 'firefox',
    firefox_android: 'and_ff',
    safari: 'safari',
    safari_ios: 'ios_saf',
    webview_android: 'android',
  };
  const query = Object.entries(names)
    .map(
      ([engine, name]) => `${name} >= ${targets.MINIMUM_FLOOR.engines[engine]}`,
    )
    .join(', ');
  return targets.resolveTargets({
    profiles: ['project:minimum'],
    define: { minimum: { query } },
  }).record;
})();

/** Whether the data marks `bcdPath` native on every engine at the floor. */
function belowFloor(bcdPath) {
  const record = Object.freeze({
    feature: `probe:${bcdPath}`,
    kind: 'value',
    parent: null,
    bcd: [{ path: bcdPath, match: null }],
    recognized: true,
  });
  return targets.profileOutcomes(record, MINIMUM)[0].state === 'native';
}

/** Every BCD path some example construct is evaluated on. */
function reachedPaths() {
  const reached = new Set();
  for (const css of examples()) {
    for (const { record } of targets.featuresOfCss(css)) {
      for (const { path: p } of record.bcd) reached.add(p);
    }
  }
  return reached;
}

const parentOf = (p) => p.slice(0, p.lastIndexOf('.'));
const reviewed = new Map(
  REVIEWS.reviews.flatMap((review) =>
    review.paths.map((p) => [p, review.disposition]),
  ),
);

describe('every subfeature of an evaluated path is classified', () => {
  const reached = reachedPaths();
  // Subfeatures of evaluated paths, and every css.types path a value can
  // reach (all but the value-type nodes themselves).
  const universe = [
    ...new Set([
      ...Object.keys(DATA.paths).filter((p) => reached.has(parentOf(p))),
      ...Object.keys(DATA.paths).filter(
        (p) =>
          p.startsWith('css.types.') &&
          !(p.split('.').length === 3 && VALUE_TYPES.has(p.split('.')[2])),
      ),
    ]),
  ].filter((p) => !reached.has(p));
  const subfeatures = universe.filter((p) => !belowFloor(p));

  test('every css.types node is classified as a function or a value type', () => {
    const nodes = Object.keys(DATA.paths)
      .filter((p) => /^css\.types\.[^.]+$/.test(p))
      .map((p) => p.split('.')[2]);
    expect(
      nodes.filter((n) => FUNCTION_TYPES.has(n) === VALUE_TYPES.has(n)),
    ).toEqual([]);
    expect(
      [...FUNCTION_TYPES, ...VALUE_TYPES].filter((n) => !nodes.includes(n)),
    ).toEqual([]);
  });

  test('the minimum-floor profile resolves every engine at its floor', () => {
    expect(
      Object.fromEntries(
        MINIMUM.profiles[0].engines.map((e) => [e.engine, e.floor]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(targets.MINIMUM_FLOOR.engines).filter(
          ([engine]) => engine !== 'electron',
        ),
      ),
    );
  });

  test('reviewed catalog shape', () => {
    expect(REVIEWS).toMatchObject({
      kind: 'pandamstyle-subfeature-reviews',
      schemaVersion: 1,
      compatData: { bcdVersion: '8.1.6' },
    });
    const all = REVIEWS.reviews.flatMap((review) => review.paths);
    expect(new Set(all).size).toBe(all.length);
    for (const review of REVIEWS.reviews) {
      expect(['not-css-syntax', 'base-form-unaffected']).toContain(
        review.disposition,
      );
      expect(review.rationale.length).toBeGreaterThan(40);
      expect(review.paths.length).toBeGreaterThan(0);
    }
  });

  test('each unmapped subfeature above the floor is reviewed, and each review is of one', () => {
    // A subfeature that no example reaches, that the floor does not make
    // native and that no review lists is reported native from its parent:
    // the class this guard exists for.
    expect(subfeatures.filter((p) => !reviewed.has(p))).toEqual([]);
    // A review of a path that is mapped, native at the floor, absent or not
    // in the universe is stale.
    expect(
      [...reviewed.keys()].filter((p) => !subfeatures.includes(p)),
    ).toEqual([]);
  });

  test('a construct is evaluated on its own statement, never its parent', () => {
    // No outcome borrows a parent's statement: the fail-closed rule that
    // made a parent unknown for any of its uses is gone.
    expect(targets.REASONS).not.toContain('unresolved-subfeature');
  });
});

/** A one-engine project profile from a Browserslist query. */
const TYPE_FUNCTION_TYPES = [
  'angle',
  'color',
  'custom-ident',
  'ident',
  'image',
  'integer',
  'length',
  'length-percentage',
  'number',
  'percentage',
  'resolution',
  'string',
  'time',
  'transform-function',
];
const profile = (query) =>
  targets.resolveTargets({
    profiles: ['project:t'],
    define: { t: { query } },
  }).record;
const outcomeOf = (feature, resolution) =>
  targets.profileOutcomes(targets.featureByKey(feature), resolution)[0];

describe('a syntax form is evaluated on its own statement, not its parent', () => {
  // [css, form key, parent key, query at or above the minimum floor where the
  // parent is native and the form is not]. Reviewed false acceptances first.
  test.each([
    [
      '.x:nth-child(2 of .y){color:red}',
      'selector::nth-child/of-syntax',
      'selector::nth-child',
      'chrome 105',
    ],
    [
      '.x:nth-last-child(2 of .y){color:red}',
      'selector::nth-last-child/of-syntax',
      'selector::nth-last-child',
      'chrome 105',
    ],
    [
      '.x{color:color(display-p3-linear 1 0 0)}',
      'function:color/display-p3-linear',
      'function:color',
      'chrome 120',
    ],
    [
      '.x{width:calc(1px / 1px * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
    ],
    [
      '.x{width:calc(1px / (1px) * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
    ],
    [
      '.x{width:calc(1px / calc(1px) * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
    ],
    [
      '.x{width:calc(1px / (2px * 3) * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
    ],
    [
      '.x{width:calc(1px / min(1px, 2px) * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
    ],
    [
      '.x{color:rgb(1 20% 3)}',
      'function:rgb/mixed-type-parameters',
      'function:rgb',
      'chrome 100',
    ],
    [
      '.x{color:color-mix(in srgb, red, blue, green)}',
      'function:color-mix/variadic-color-arguments',
      'function:color-mix',
      'chrome 120',
    ],
    [
      '.x{color:rgb(from currentcolor r g b)}',
      'function:rgb/from-currentcolor',
      'function:rgb',
      'chrome 125',
    ],
    [
      '.x{background-image:linear-gradient(in oklch, red, blue)}',
      'function:linear-gradient/interpolation-color-space',
      'function:linear-gradient',
      'chrome 100',
    ],
    [
      '.x{color:AccentColor}',
      'value:color/accentcolor',
      'property:color',
      'safari 15.4',
    ],
    [
      '.x::before::marker{color:red}',
      'selector:::before/nested-marker',
      'selector:::before',
      'chrome 120',
    ],
    [
      '.x[a=b s]{color:red}',
      'selector:attribute/case-sensitive-modifier',
      'selector:attribute',
      'chrome 120',
    ],
    [
      '.x{display:none;transition:display 1s}',
      'property:display/animated',
      'property:display',
      'chrome 110',
    ],
    [
      '@media (min-width: calc(1px + 1em)){.x{color:red}}',
      'media:media_query_values',
      'at-rule:media',
      'safari 15.4',
    ],
    [
      '@media (display-mode: picture-in-picture){.x{color:red}}',
      'media:display-mode/picture-in-picture',
      'media:display-mode',
      'chrome 120',
    ],
    [
      '@page{@top-left{content:"x"}}',
      'at-rule:page/at-top-left',
      'at-rule:page',
      'chrome 120',
    ],
    [
      '@import url(a.css) supports(display: grid);',
      'at-rule:import/supports',
      'at-rule:import',
      'chrome 120',
    ],
  ])('%s', (css, form, parent, query) => {
    const features = targets.featuresOfCss(css).map((e) => e.record.feature);
    expect(features).toEqual(expect.arrayContaining([form, parent]));
    const record = targets.featureByKey(form);
    expect(record.parent).toBe(parent);
    expect(record.bcd).toHaveLength(1);
    const resolution = profile(query);
    expect(outcomeOf(parent, resolution).state).toBe('native');
    expect(['incompatible', 'unknown']).toContain(
      outcomeOf(form, resolution).state,
    );
  });

  test('a unitless compound denominator is not typed division', () => {
    for (const value of [
      'calc(1px / (2 * 3))',
      'calc(1px / calc(2))',
      'calc(1px / 2)',
      'calc(1px / pi)',
      'calc(100% / var(--n))',
    ]) {
      const forms = targets
        .featuresOfCss(`.x{width:${value}}`)
        .map((e) => e.record.feature)
        .filter((feature) => feature.includes('typed-division'));
      expect({ value, forms }).toEqual({ value, forms: [] });
    }
    // A division inside sign() is sign()'s own subfeature.
    expect(
      targets
        .featuresOfCss('.x{width:calc(1px * sign(1px / 1px))}')
        .map((e) => e.record.feature)
        .filter((feature) => feature.includes('typed-division')),
    ).toEqual(['function:sign/typed-division-produces-unitless-number']);
  });

  test('the base forms add no subfeature key', () => {
    for (const css of [
      '.x:nth-child(2n){color:red}',
      '.x{overflow:hidden}',
      '.x{color:rgb(1, 2, 3)}',
      '.x{color:rgba(1, 2, 3, .5)}',
      '.x{color:hsl(1, 2%, 3%)}',
      '.x{color:color(display-p3 1 0 0)}',
      '.x{color:color-mix(in srgb, red, blue)}',
      '.x{background-image:linear-gradient(red, blue)}',
      '.x{border-radius:1px}',
      '.x{text-decoration:underline}',
      '.x{white-space:nowrap}',
    ]) {
      const forms = targets
        .featuresOfCss(css)
        .map((e) => e.record.feature)
        .filter(
          (feature) =>
            feature.split('/').length > 2 || /\/[a-z-]+-/.test(feature),
        );
      expect({ css, forms }).toEqual({ css, forms: [] });
    }
  });

  test('every extracted key resolves back to its record', () => {
    for (const css of examples()) {
      for (const { record } of targets.featuresOfCss(css)) {
        if (!record.recognized || record.fallback != null) continue;
        if (record.kind === 'combination') continue;
        const byKey = targets.featureByKey(record.feature);
        expect({ key: record.feature, bcd: byKey?.bcd }).toEqual({
          key: record.feature,
          bcd: record.bcd,
        });
      }
    }
  });
});

// Every subfeature that had been fail-closed is extracted now. Base form next
// to variant: [base css, base key, variant css, variant key, query]. The base
// is native at the query, the variant is not.
const BASE_AND_VARIANT = [
  [
    '.x{width:attr(data-x)}',
    'function:attr',
    '.x{width:attr(ns|data-x)}',
    'function:attr/attr-name-accepts-namespaces',
    'firefox 150',
  ],
  [
    '.x{width:attr(data-x)}',
    'function:attr',
    '.x{width:attr(data-x, 1px)}',
    'function:attr/declaration-value',
    'chrome 130',
  ],
  ...TYPE_FUNCTION_TYPES.map((name) => [
    '.x{width:attr(data-x)}',
    'function:attr',
    `.x{width:attr(data-x type(<${name}>))}`,
    `function:attr/type()/${name}`,
    'chrome 130',
  ]),
  [
    '.x{width:if(style(--x: 1): 1px)}',
    'function:if/style()',
    '.x{width:if(style(--x > 1): 1px)}',
    'function:if/style()/range-syntax',
    'chrome 140',
  ],
  [
    '.x{offset-path:path("M0 0")}',
    'function:path',
    '.x{d:path("M0 0")}',
    'function:path/in-d',
    'safari 18.2',
  ],
  [
    '.x{top:anchor(--a top)}',
    'value:top/anchor()',
    '@keyframes k{from{top:anchor(--a top)}}',
    'value:top/anchor()/anchor-animated',
    'firefox 147',
  ],
  [
    '.x{top:anchor(--a top)}',
    'value:top/anchor()',
    '.x{top:anchor(--a top);transition:top 1s}',
    'value:top/anchor()/anchor-animated',
    'firefox 147',
  ],
  [
    '.x{width:anchor-size(width)}',
    'value:width/anchor-size()',
    '@keyframes k{from{top:anchor-size(width)}}',
    'value:top/anchor-size()/anchor-size-animated',
    'firefox 147',
  ],
  [
    '.x{width:anchor-size(width)}',
    'value:width/anchor-size()',
    '.x{margin-top:anchor-size(width)}',
    'value:margin-top/anchor-size()/anchor-size-inset-margin',
    'chrome 130',
  ],
];

describe('former fail-closed subfeatures: base form native, variant not', () => {
  test.each(BASE_AND_VARIANT)(
    '%s / %s',
    (baseCss, baseKey, variantCss, variantKey, query) => {
      const resolution = profile(query);
      const base = targets.featuresOfCss(baseCss).map((e) => e.record.feature);
      expect(base).toContain(baseKey);
      expect(base).not.toContain(variantKey);
      expect(outcomeOf(baseKey, resolution).state).toBe('native');
      const variant = targets
        .featuresOfCss(variantCss)
        .map((e) => e.record.feature);
      expect(variant).toContain(variantKey);
      expect(['incompatible', 'unknown']).toContain(
        outcomeOf(variantKey, resolution).state,
      );
    },
  );

  test('a variant whose data equals its construct is extracted on its own path', () => {
    // `@function` `result` and `anchored(fallback: …)` any value record the
    // same support as their construct on every engine: no profile separates
    // them, so each is mapped to its own statement and agrees with it.
    for (const [css, parentKey, key, bcdPath] of [
      [
        '@function --f(){result:1px}',
        'at-rule:function',
        'at-rule:function/result',
        'css.at-rules.function.result',
      ],
      [
        '@container anchored(fallback: --a){.x{color:red}}',
        'at-rule:container/anchored/fallback',
        'at-rule:container/anchored/fallback/any-value',
        'css.at-rules.container.anchor_position_queries.fallback.any_value',
      ],
    ]) {
      const records = targets.featuresOfCss(css).map((e) => e.record);
      const record = records.find((r) => r.feature === key);
      expect(record.bcd).toEqual([{ path: bcdPath, match: null }]);
      for (const query of ['chrome 120', 'chrome 150', 'safari 26.2']) {
        expect(outcomeOf(key, profile(query)).state).toBe(
          outcomeOf(parentKey, profile(query)).state,
        );
      }
    }
  });
});

describe('the minimum floor makes old syntax native by construction', () => {
  test('a query below the floor is refused, and these forms are native at it', () => {
    for (const query of ['safari 9.1', 'chrome 26', 'chrome 20']) {
      let error = null;
      try {
        profile(query);
      } catch (e) {
        error = e;
      }
      expect(error.diagnostics.map((d) => d.rule)).toContain(
        'targets.below-minimum',
      );
    }
    for (const bcdPath of [
      // R2.1: scientific notation (Safari 10.1).
      'css.types.number.scientific_notation',
      'css.types.calc.number_values',
      'css.properties.content.content_replacement',
      'css.selectors.is.forgiving_selector_list',
      'css.selectors.where.forgiving_selector_list',
      'css.properties.overflow.multiple_keywords',
      'css.types.color.rgb.space_separated_parameters',
      'css.types.color.hsl.space_separated_parameters',
      'css.types.easing-function.steps.jump',
    ]) {
      expect([bcdPath, belowFloor(bcdPath)]).toEqual([bcdPath, true]);
    }
  });

  test("the reviewer's base forms are native at their profiles", () => {
    for (const [css, query] of [
      ['.x{content:attr(title)}', 'chrome 120, safari 18.2'],
      ['.x{font-family:attr(data-font)}', 'chrome 152'],
      ['.x{width:calc(100% - 1px)}', 'chrome 100'],
      ['.x::before{content:"hello"}', 'chrome 100'],
      ['.x{line-height:1e-1}', 'safari 15.4'],
    ]) {
      const resolution = profile(query);
      for (const { record } of targets.featuresOfCss(css)) {
        expect([
          css,
          record.feature,
          targets.profileOutcomes(record, resolution)[0].state,
        ]).toEqual([css, record.feature, 'native']);
      }
    }
  });
});

describe('keywords are read in their consuming grammar', () => {
  const keywordKeys = (css, grammars) =>
    targets
      .featuresOfCss(css, grammars)
      .map((e) => e.record.feature)
      .filter((feature) =>
        /\/(mark|marktext|accentcolor|accentcolortext|overlay|bevel|cap)$/.test(
          feature,
        ),
      );

  test('a color keyword is a system color only where a color is taken', () => {
    for (const keyword of [
      'Mark',
      'MarkText',
      'AccentColor',
      'AccentColorText',
    ]) {
      const k = keyword.toLowerCase();
      expect(keywordKeys(`.x{color:${keyword}}`)).toEqual([`value:color/${k}`]);
      expect(keywordKeys(`.x{border:1px solid ${keyword}}`)).toEqual([
        `value:border/${k}`,
      ]);
      expect(
        keywordKeys(`.x{background-image:linear-gradient(${keyword}, red)}`),
      ).toEqual([`value:background-image/${k}`]);
      for (const property of ['font-family', 'grid-area', 'animation-name']) {
        expect(keywordKeys(`.x{${property}:${keyword}}`)).toEqual([]);
      }
      // A custom property: its token category decides, and an unknown
      // consumer infers nothing.
      expect(keywordKeys(`.x{--a:${keyword}}`)).toEqual([]);
      expect(
        keywordKeys(`.x{--a:${keyword}}`, new Map([['--a', 'color']])),
      ).toEqual([`value:--a/${k}`]);
    }
  });

  test('every type keyword family is scoped to its consumers', () => {
    expect(keywordKeys('.x{overflow:overlay}')).toEqual([
      'value:overflow/overlay',
    ]);
    expect(keywordKeys('.x{width:overlay}')).toEqual([]);
    expect(keywordKeys('.x{corner-shape:bevel}')).toEqual([
      'value:corner-shape/bevel',
    ]);
    expect(keywordKeys('.x{grid-area:bevel}')).toEqual([]);
    expect(keywordKeys('.x{text-box-edge:cap}')).toEqual([
      'value:text-box-edge/cap',
    ]);
    expect(keywordKeys('.x{font-family:cap}')).toEqual([]);
  });

  test('design-system tokens: a color token is read as a color, a font family is not', () => {
    const ds =
      targets &&
      loadCompiler().buildDesignSystem({
        systemId: 'grammar@1',
        tokens: {
          colors: { c: { value: 'Mark', visibility: 'public' } },
          shadows: { s: { value: '0 0 1px Mark', visibility: 'public' } },
          fontFamilies: { f: { value: 'Mark', visibility: 'public' } },
        },
        recipes: {
          r: { base: { fontFamily: loadCompiler().token('fontFamilies.f') } },
        },
      });
    const evaluation = targets.evaluateProjectTargets({
      resolution: targets.resolveTargets(null).record,
      designSystem: ds,
      designSystemRules: [],
      pages: [],
    });
    const marks = evaluation.facts.features
      .map((f) => f.feature)
      .filter((feature) => feature.endsWith('/mark'));
    const vars = ds.varsByToken;
    const name = (token) => /var\((--[^)]+)\)/.exec(vars[token])[1];
    expect(marks.sort()).toEqual(
      [
        `value:${name('colors.c')}/mark`,
        `value:${name('shadows.s')}/mark`,
      ].sort(),
    );
  });
});

describe('enhancement policies cover the forms of their construct', () => {
  test('a policy on a construct applies to its forms only', () => {
    const resolution = profile('chrome 110');
    const evaluate = (enhancements) =>
      targets.evaluateTargets({
        resolution,
        sources: [
          {
            owner: { role: 'design-system', file: null, label: 'ds' },
            css: '.x{width:calc(1px / 1px * 1px);display:inline flex}',
          },
        ],
        enhancements,
      });
    const failing = (result) => result.errors.map((d) => d.context.feature);
    const form = 'function:calc/typed-division-produces-unitless-number';
    expect(failing(evaluate([]))).toEqual(expect.arrayContaining([form]));
    const covered = evaluate([
      { feature: 'function:calc', fallback: { kind: 'degrade' } },
      { feature: 'property:display', fallback: { kind: 'degrade' } },
    ]);
    expect(failing(covered)).not.toContain(form);
    // `value:display/…` keys are keyword values, not forms of the property.
    expect(failing(covered)).toEqual(
      expect.arrayContaining(['value:display/multi-keyword']),
    );
  });
});

describe('end to end: a public color token', () => {
  test('color(display-p3-linear …) is refused where only color() is native', () => {
    const h = openProject('valid');
    const definition = fs
      .readFileSync(h.sharedDefinitionPath, 'utf8')
      .replace(
        "'500': { value: '#2563eb', visibility: 'private' }",
        "'500': { value: 'color(display-p3-linear 0.1 0.2 0.9)', visibility: 'private' }",
      );
    expect(definition).toContain('display-p3-linear');
    fs.writeFileSync(h.sharedDefinitionPath, definition);
    const config = {
      profiles: ['project:c'],
      define: { c: { query: 'chrome 120' } },
    };
    h.setBuildOption('targets', config);
    h.session.applyChanges({
      definition: h.reloadDefinition(),
      config: { targets: config },
      mutation: undefined,
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    const features = validation.diagnostics.map((d) => d.context.feature);
    expect(features).toContain('function:color/display-p3-linear');
    expect(features).not.toContain('function:color');
  });
});
