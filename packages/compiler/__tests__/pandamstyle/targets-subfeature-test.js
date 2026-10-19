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
 * The guard is derived from the bundled data: every BCD subfeature of a path
 * an emitted construct is evaluated on is either extracted as its own feature
 * key (executed here on example CSS), reviewed as not expressible in CSS text,
 * or fail-closed. A subfeature added by a data update fails until classified.
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
    } else if (
      top === 'types' &&
      depth >= 4 &&
      Object.hasOwn(FAMILY_PROPERTY, a) &&
      IDENT.test(b) &&
      !NOT_FUNCTION.has(b)
    ) {
      out.push(`.x{${FAMILY_PROPERTY[a]}:${b}(1px)}`);
    }
  }
  return out;
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
  const subfeatures = Object.keys(DATA.paths).filter(
    (p) => !reached.has(p) && reached.has(parentOf(p)),
  );

  test('reviewed catalog shape', () => {
    expect(REVIEWS).toMatchObject({
      kind: 'pandamstyle-subfeature-reviews',
      schemaVersion: 1,
      compatData: { bcdVersion: '8.1.6' },
    });
    const all = REVIEWS.reviews.flatMap((review) => review.paths);
    expect(new Set(all).size).toBe(all.length);
    for (const review of REVIEWS.reviews) {
      expect(['not-css-syntax', 'fail-closed']).toContain(review.disposition);
      expect(review.rationale.length).toBeGreaterThan(40);
      expect(review.paths.length).toBeGreaterThan(0);
    }
  });

  test('each unmapped subfeature is reviewed, and each review is of one', () => {
    // A subfeature that no example reaches and no review lists is reported
    // native from its parent: the class this guard exists for.
    expect(subfeatures.filter((p) => !reviewed.has(p))).toEqual([]);
    // A review of a path that is mapped, absent or not a subfeature is stale.
    expect(
      [...reviewed.keys()].filter((p) => !subfeatures.includes(p)),
    ).toEqual([]);
  });

  test('a fail-closed review is applied to its parent path', () => {
    for (const [p, disposition] of reviewed) {
      expect(targets.failClosedSubfeatures(parentOf(p)).includes(p)).toBe(
        disposition === 'fail-closed',
      );
    }
  });
});

/** A one-engine project profile from a Browserslist query. */
const profile = (query) =>
  targets.resolveTargets({
    profiles: ['project:t'],
    define: { t: { query } },
  }).record;
const outcomeOf = (feature, resolution) =>
  targets.profileOutcomes(targets.featureByKey(feature), resolution)[0];

describe('a syntax form is evaluated on its own statement, not its parent', () => {
  // [css, form key, parent key, query where the parent is native and the
  // form is not]. The first four are the reviewed false acceptances.
  test.each([
    [
      '.x:nth-child(2 of .y){color:red}',
      'selector::nth-child/of-syntax',
      'selector::nth-child',
      'chrome 100',
    ],
    [
      '.x:nth-last-child(2 of .y){color:red}',
      'selector::nth-last-child/of-syntax',
      'selector::nth-last-child',
      'chrome 100',
    ],
    [
      '.x{overflow:hidden auto}',
      'property:overflow/multiple-keywords',
      'property:overflow',
      'chrome 60',
    ],
    [
      '.x{color:rgb(1 2 3 / .5)}',
      'function:rgb/space-separated-parameters',
      'function:rgb',
      'chrome 60',
    ],
    [
      '.x{color:hsl(1 2% 3% / .5)}',
      'function:hsl/space-separated-parameters',
      'function:hsl',
      'chrome 60',
    ],
    [
      '.x{color:color(display-p3-linear 1 0 0)}',
      'function:color/display-p3-linear',
      'function:color',
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
      '.x{transition-timing-function:steps(2, jump-end)}',
      'function:steps/jump-end',
      'function:steps',
      'chrome 70',
    ],
    [
      '.x{width:calc(1px / 1px * 1px)}',
      'function:calc/typed-division-produces-unitless-number',
      'function:calc',
      'chrome 120',
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
      'safari 15',
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
      'firefox 60',
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
      'chrome 60',
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
    expect(
      record.bcd[0].path.startsWith(`${parentOf(record.bcd[0].path)}.`),
    ).toBe(true);
    const resolution = profile(query);
    expect(outcomeOf(parent, resolution).state).toBe('native');
    expect(['incompatible', 'unknown']).toContain(
      outcomeOf(form, resolution).state,
    );
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

describe('fail-closed subfeatures', () => {
  test('the construct is unknown where the subfeature is not native, native elsewhere', () => {
    // `content` is native from Chrome 1; its content-replacement form, which
    // the extractor does not detect, from Chrome 28.
    expect(targets.failClosedSubfeatures('css.properties.content')).toContain(
      'css.properties.content.content_replacement',
    );
    const before = outcomeOf('property:content', profile('chrome 20'));
    expect(before).toMatchObject({
      state: 'unknown',
      engines: [
        expect.objectContaining({
          state: 'unknown',
          reason: 'unresolved-subfeature',
          path: 'css.properties.content.content_replacement',
        }),
      ],
    });
    expect(outcomeOf('property:content', profile('chrome 40')).state).toBe(
      'native',
    );
  });
});

describe('enhancement policies cover the forms of their construct', () => {
  test('a policy on a construct applies to its forms only', () => {
    const resolution = profile('chrome 60');
    const evaluate = (enhancements) =>
      targets.evaluateTargets({
        resolution,
        sources: [
          {
            owner: { role: 'design-system', file: null, label: 'ds' },
            css: '.x{overflow:hidden auto;display:inline flex}',
          },
        ],
        enhancements,
      });
    const failing = (result) => result.errors.map((d) => d.context.feature);
    expect(failing(evaluate([]))).toEqual(
      expect.arrayContaining(['property:overflow/multiple-keywords']),
    );
    const covered = evaluate([
      { feature: 'property:overflow', fallback: { kind: 'degrade' } },
      { feature: 'property:display', fallback: { kind: 'degrade' } },
    ]);
    expect(failing(covered)).not.toContain(
      'property:overflow/multiple-keywords',
    );
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
