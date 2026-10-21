/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - canonical property descriptors (CE-02.1).
 *
 * The only property authority of the compiler. One record per property the
 * compiler describes:
 *
 *   key, css      authoring key (camelCase) and emitted CSS name
 *   aliases       accepted authoring spellings (none yet; CE-02.3)
 *   status        'standard' | 'platform'
 *   platform      CE-01.1 platform id of a platform extension, else null
 *   grammar       CSS value definition, transcribed from the specification.
 *                 Informative here; CE-02.2 validates against it
 *   contexts      applicable contexts; 'element' only until CE-07
 *   standard      the maximum domain a design system may approve
 *   default       the domain admitted without an override: Alpha 1's
 *   form          'longhand' | 'shorthand' | 'rejected-composite'
 *   longhands     CSS longhands a shorthand sets (parity-tested against the
 *                 engine expansion)
 *   family        CE-00.1 registry family
 *   conflicts     derived: shorthand rows whose longhands include this row
 *   direction     { axis: 'inline' | 'block', side: 'start' | 'end' | null }
 *                 | { corner } (logical) | { physical } | null
 *   targetFeature target feature key of the emitted property
 *
 * A domain has four members: `values` (finite literal values; numeric 0 is the
 * same value as '0'), `tokens` (token categories), `resources` (resource
 * kinds, empty until CE-03) and `range`. `range` exists only on the four Alpha
 * 1 rows `opacity`, `flex`, `flexGrow` and `flexShrink`: it is a continuous
 * legacy interval, never a finite domain, and CE-02.2 replaces it. Its `max` is
 * omitted when the interval has no upper bound (`{ min: 0 }`).
 *
 * Platform-extension rows are recognition-only in CE-02.1: they have no
 * domain and every use is rejected.
 *
 * The catalog is a private Map. Only `descriptorOf` and `descriptorKeys` reach
 * it, and only modules under design-system/policy/ import them: every other
 * module reads the effective rows of a design system (policy/domains.js).
 */

import { createHash } from 'crypto';

export const CATALOG_VERSION = 1;

/**
 * The fields of an effective row (the snapshot's `properties.descriptors`)
 * that count toward compilation identity. Policy, types and diagnostics read
 * only these; anything a later change adds to a row (such as AG-03.1 `meta`)
 * is neither read nor hashed.
 */
export const ENFORCED_FIELDS = Object.freeze([
  'key',
  'css',
  'aliases',
  'status',
  'platform',
  'grammar',
  'contexts',
  'domain',
  'origin',
  'form',
  'longhands',
  'family',
  'conflicts',
  'direction',
  'targetFeature',
]);

/** The fields of a catalog row: the effective fields' sources. */
const CATALOG_FIELDS = Object.freeze([
  'key',
  'css',
  'aliases',
  'status',
  'platform',
  'grammar',
  'contexts',
  'standard',
  'default',
  'form',
  'longhands',
  'family',
  'conflicts',
  'direction',
  'targetFeature',
]);

const ELEMENT = Object.freeze(['element']);
const NONE = Object.freeze([]);

const kebab = (key) =>
  key
    .replace(/^(Webkit|Moz)/, (m) => `-${m.toLowerCase()}`)
    .replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

function domain({ values = NONE, tokens = NONE, range = null } = {}) {
  return { values: [...values], tokens: [...tokens], resources: [], range };
}

// Each row: [key, grammar, family, { std, def, form, longhands, direction }].
// `def` is the Alpha 1 domain; `std` adds what a design system may approve.
// Every `def` member is repeated in `std` by `row()`.
const COLOR = (key, grammar, family, extra = {}) => [
  key,
  grammar,
  family,
  {
    def: { tokens: ['colors'] },
    std: { values: ['currentColor', 'transparent'], tokens: ['colors'] },
    ...extra,
  },
];
const SPACING = (key, grammar, family, values, extra = {}) => [
  key,
  grammar,
  family,
  {
    def: { tokens: ['spacing'] },
    std: { values, tokens: ['spacing'] },
    ...extra,
  },
];
const SIZE_KEYWORDS = ['auto', 'min-content', 'max-content', 'fit-content'];
const ALPHA1_SIZES = [
  '1px',
  '16px',
  '20px',
  '24px',
  '28px',
  '32px',
  '36px',
  '40px',
];
const DURATION = (key, grammar) => [
  key,
  grammar,
  key.startsWith('animation') ? 'animations' : 'transitions',
  { def: { tokens: ['durations'] }, std: { tokens: ['durations'] } },
];
const EASING = (key) => [
  key,
  '<easing-function>#',
  key.startsWith('animation') ? 'animations' : 'transitions',
  {
    def: { tokens: ['easings'] },
    std: {
      values: [
        'linear',
        'ease',
        'ease-in',
        'ease-out',
        'ease-in-out',
        'step-start',
        'step-end',
      ],
      tokens: ['easings'],
    },
  },
];
const SET = (key, grammar, family, def, std = [], extra = {}) => [
  key,
  grammar,
  family,
  { def: { values: def }, std: { values: std }, ...extra },
];
// A range with no upper bound omits `max`: the domain stays JSON-safe, with
// no Infinity to serialize as null.
const rangeOf = (min, max) => (max === Infinity ? { min } : { min, max });
const RANGE = (key, grammar, family, min, max, extra = {}) => [
  key,
  grammar,
  family,
  {
    def: { range: rangeOf(min, max) },
    std: { range: rangeOf(min, max) },
    ...extra,
  },
];
const COMPOSITE = (key, grammar, family, longhands) => [
  key,
  grammar,
  family,
  { form: 'rejected-composite', longhands },
];
const PLATFORM = (key, grammar, family, platform) => [
  key,
  grammar,
  family,
  { status: 'platform', platform },
];

const side = (axis, s) => ({ axis, side: s });
const physical = (p) => ({ physical: p });
const corner = (c) => ({ corner: c });
const shorthand = (longhands, direction = null) => ({
  form: 'shorthand',
  longhands,
  direction,
});
const sides = (prefix, suffix = '') =>
  ['top', 'right', 'bottom', 'left'].map((s) => `${prefix}${s}${suffix}`);

const PADDING = "<'padding-top'>";
const MARGIN = "<'margin-top'>";
const INSET = "<'top'>";
const LENGTH_PERCENTAGE_0 = '<length-percentage [0,∞]>';
const RADIUS = '<length-percentage [0,∞]>{1,2}';

const ROWS = [
  // Colors (Alpha 1: token category `colors`).
  COLOR('color', '<color>', 'text-basic'),
  COLOR('backgroundColor', '<color>', 'backgrounds'),
  COLOR('borderColor', '<color>{1,4}', 'borders', {
    ...shorthand(sides('border-', '-color')),
  }),
  COLOR('borderTopColor', '<color>', 'borders', {
    direction: physical('top'),
  }),
  COLOR('borderRightColor', '<color>', 'borders', {
    direction: physical('right'),
  }),
  COLOR('borderBottomColor', '<color>', 'borders', {
    direction: physical('bottom'),
  }),
  COLOR('borderLeftColor', '<color>', 'borders', {
    direction: physical('left'),
  }),
  COLOR('borderInlineColor', "<'border-top-color'>{1,2}", 'borders', {
    ...shorthand(
      ['border-inline-start-color', 'border-inline-end-color'],
      side('inline', null),
    ),
  }),
  COLOR('borderBlockColor', "<'border-top-color'>{1,2}", 'borders', {
    ...shorthand(
      ['border-block-start-color', 'border-block-end-color'],
      side('block', null),
    ),
  }),
  COLOR('outlineColor', 'auto | <color>', 'outlines'),
  COLOR('textDecorationColor', '<color>', 'text-basic'),
  COLOR('caretColor', 'auto | <color>', 'form-controls'),
  COLOR('fill', '<paint>', 'svg-icon-paint'),
  COLOR('stroke', '<paint>', 'svg-icon-paint'),

  // Spacing (Alpha 1: token category `spacing`).
  SPACING('padding', `${PADDING}{1,4}`, 'spacing', ['0'], {
    ...shorthand(sides('padding-')),
  }),
  SPACING('paddingTop', LENGTH_PERCENTAGE_0, 'spacing', ['0'], {
    direction: physical('top'),
  }),
  SPACING('paddingRight', LENGTH_PERCENTAGE_0, 'spacing', ['0'], {
    direction: physical('right'),
  }),
  SPACING('paddingBottom', LENGTH_PERCENTAGE_0, 'spacing', ['0'], {
    direction: physical('bottom'),
  }),
  SPACING('paddingLeft', LENGTH_PERCENTAGE_0, 'spacing', ['0'], {
    direction: physical('left'),
  }),
  SPACING('paddingInline', `${PADDING}{1,2}`, 'spacing', ['0'], {
    ...shorthand(
      ['padding-inline-start', 'padding-inline-end'],
      side('inline', null),
    ),
  }),
  SPACING('paddingInlineStart', PADDING, 'spacing', ['0'], {
    direction: side('inline', 'start'),
  }),
  SPACING('paddingInlineEnd', PADDING, 'spacing', ['0'], {
    direction: side('inline', 'end'),
  }),
  SPACING('paddingBlock', `${PADDING}{1,2}`, 'spacing', ['0'], {
    ...shorthand(
      ['padding-block-start', 'padding-block-end'],
      side('block', null),
    ),
  }),
  SPACING('paddingBlockStart', PADDING, 'spacing', ['0'], {
    direction: side('block', 'start'),
  }),
  SPACING('paddingBlockEnd', PADDING, 'spacing', ['0'], {
    direction: side('block', 'end'),
  }),
  SPACING('margin', `${MARGIN}{1,4}`, 'spacing', ['0', 'auto'], {
    ...shorthand(sides('margin-')),
  }),
  SPACING('marginTop', '<length-percentage> | auto', 'spacing', ['0', 'auto'], {
    direction: physical('top'),
  }),
  SPACING(
    'marginRight',
    '<length-percentage> | auto',
    'spacing',
    ['0', 'auto'],
    { direction: physical('right') },
  ),
  SPACING(
    'marginBottom',
    '<length-percentage> | auto',
    'spacing',
    ['0', 'auto'],
    { direction: physical('bottom') },
  ),
  SPACING(
    'marginLeft',
    '<length-percentage> | auto',
    'spacing',
    ['0', 'auto'],
    { direction: physical('left') },
  ),
  SPACING('marginInlineStart', MARGIN, 'spacing', ['0', 'auto'], {
    direction: side('inline', 'start'),
  }),
  SPACING('marginInlineEnd', MARGIN, 'spacing', ['0', 'auto'], {
    direction: side('inline', 'end'),
  }),
  SPACING('marginBlock', `${MARGIN}{1,2}`, 'spacing', ['0', 'auto'], {
    ...shorthand(
      ['margin-block-start', 'margin-block-end'],
      side('block', null),
    ),
  }),
  SPACING('marginBlockStart', MARGIN, 'spacing', ['0', 'auto'], {
    direction: side('block', 'start'),
  }),
  SPACING('marginBlockEnd', MARGIN, 'spacing', ['0', 'auto'], {
    direction: side('block', 'end'),
  }),
  SPACING('top', 'auto | <length-percentage>', 'position', ['0', 'auto'], {
    direction: physical('top'),
  }),
  SPACING('right', 'auto | <length-percentage>', 'position', ['0', 'auto'], {
    direction: physical('right'),
  }),
  SPACING('bottom', 'auto | <length-percentage>', 'position', ['0', 'auto'], {
    direction: physical('bottom'),
  }),
  SPACING('left', 'auto | <length-percentage>', 'position', ['0', 'auto'], {
    direction: physical('left'),
  }),
  SPACING('insetInlineStart', INSET, 'position', ['0', 'auto'], {
    direction: side('inline', 'start'),
  }),
  SPACING('insetInlineEnd', INSET, 'position', ['0', 'auto'], {
    direction: side('inline', 'end'),
  }),
  SPACING('insetBlockStart', INSET, 'position', ['0', 'auto'], {
    direction: side('block', 'start'),
  }),
  SPACING('insetBlockEnd', INSET, 'position', ['0', 'auto'], {
    direction: side('block', 'end'),
  }),
  SPACING('textUnderlineOffset', 'auto | <length-percentage>', 'text-basic', [
    'auto',
    '0',
  ]),
  SPACING('gap', "<'row-gap'> <'column-gap'>?", 'spacing', ['0', 'normal'], {
    ...shorthand(['row-gap', 'column-gap']),
  }),
  SPACING('rowGap', `normal | ${LENGTH_PERCENTAGE_0}`, 'spacing', [
    '0',
    'normal',
  ]),
  SPACING('columnGap', `normal | ${LENGTH_PERCENTAGE_0}`, 'spacing', [
    '0',
    'normal',
  ]),

  // Radii (Alpha 1: token category `radii`).
  [
    'borderRadius',
    `${LENGTH_PERCENTAGE_0}{1,4} [ / ${LENGTH_PERCENTAGE_0}{1,4} ]?`,
    'borders',
    {
      def: { tokens: ['radii'] },
      std: { values: ['0'], tokens: ['radii'] },
      ...shorthand([
        'border-top-left-radius',
        'border-top-right-radius',
        'border-bottom-right-radius',
        'border-bottom-left-radius',
      ]),
    },
  ],
  ...[
    ['borderTopLeftRadius', physical('top-left')],
    ['borderTopRightRadius', physical('top-right')],
    ['borderBottomLeftRadius', physical('bottom-left')],
    ['borderBottomRightRadius', physical('bottom-right')],
    ['borderStartStartRadius', corner('start-start')],
    ['borderStartEndRadius', corner('start-end')],
    ['borderEndStartRadius', corner('end-start')],
    ['borderEndEndRadius', corner('end-end')],
  ].map(([key, direction]) => [
    key,
    RADIUS,
    'borders',
    {
      def: { tokens: ['radii'] },
      std: { values: ['0'], tokens: ['radii'] },
      direction,
    },
  ]),

  // Typography.
  [
    'fontFamily',
    '[ <family-name> | <generic-family> ]#',
    'text-basic',
    {
      def: { tokens: ['fontFamilies'] },
      std: {
        values: ['serif', 'sans-serif', 'monospace', 'system-ui'],
        tokens: ['fontFamilies'],
      },
    },
  ],
  [
    'fontSize',
    `<absolute-size> | <relative-size> | ${LENGTH_PERCENTAGE_0} | math`,
    'text-basic',
    {
      def: { tokens: ['fontSizes'] },
      std: {
        values: [
          'xx-small',
          'x-small',
          'small',
          'medium',
          'large',
          'x-large',
          'xx-large',
          'smaller',
          'larger',
        ],
        tokens: ['fontSizes'],
      },
    },
  ],
  [
    'fontWeight',
    '<font-weight-absolute> | bolder | lighter',
    'text-basic',
    {
      def: { tokens: ['fontWeights'] },
      std: {
        values: ['normal', 'bold', 'bolder', 'lighter'],
        tokens: ['fontWeights'],
      },
    },
  ],
  [
    'lineHeight',
    `normal | <number [0,∞]> | ${LENGTH_PERCENTAGE_0}`,
    'text-basic',
    {
      def: { tokens: ['lineHeights'] },
      std: { values: ['normal'], tokens: ['lineHeights'] },
    },
  ],
  [
    'letterSpacing',
    'normal | <length-percentage>',
    'text-basic',
    {
      def: { tokens: ['letterSpacings'] },
      std: { values: ['normal'], tokens: ['letterSpacings'] },
    },
  ],

  // Shadows.
  [
    'boxShadow',
    'none | <shadow>#',
    'effects',
    {
      def: { tokens: ['shadows'] },
      std: { values: ['none'], tokens: ['shadows'] },
    },
  ],
  [
    'textShadow',
    'none | <shadow-t>#',
    'text-basic',
    {
      def: { tokens: ['shadows'] },
      std: { values: ['none'], tokens: ['shadows'] },
    },
  ],

  // Motion.
  DURATION('transitionDuration', '<time [0s,∞]>#'),
  DURATION('transitionDelay', '<time>#'),
  EASING('transitionTimingFunction'),
  DURATION('animationDuration', '[ auto | <time [0s,∞]> ]#'),
  DURATION('animationDelay', '<time>#'),
  EASING('animationTimingFunction'),

  // Finite literal sets (Alpha 1 `STRUCTURAL`).
  SET(
    'gridTemplateColumns',
    'none | <track-list> | <auto-track-list> | subgrid <line-name-list>?',
    'grid',
    [1, 2, 3, 4, 5, 6].map((n) => `repeat(${n}, minmax(0, 1fr))`),
    ['none'],
  ),
  SET(
    'display',
    '[ <display-outside> || <display-inside> ] | <display-listitem> | <display-internal> | <display-box> | <display-legacy>',
    'display-box',
    ['flex', 'inline-flex', 'block', 'inline-block', 'grid', 'none'],
    ['inline', 'inline-grid', 'contents', 'flow-root'],
  ),
  SET('flexDirection', 'row | row-reverse | column | column-reverse', 'flex', [
    'row',
    'row-reverse',
    'column',
    'column-reverse',
  ]),
  SET(
    'alignItems',
    'normal | stretch | <baseline-position> | [ <overflow-position>? <self-position> ]',
    'alignment',
    ['flex-start', 'flex-end', 'center', 'baseline', 'stretch'],
    ['normal', 'start', 'end', 'self-start', 'self-end'],
  ),
  SET(
    'justifyContent',
    'normal | <content-distribution> | <overflow-position>? [ <content-position> | left | right ]',
    'alignment',
    ['flex-start', 'flex-end', 'center', 'space-between', 'space-around'],
    ['normal', 'start', 'end', 'space-evenly', 'stretch', 'left', 'right'],
  ),
  SET(
    'boxSizing',
    'content-box | border-box',
    'sizing',
    ['border-box'],
    ['content-box'],
  ),
  SET(
    'width',
    `auto | ${LENGTH_PERCENTAGE_0} | min-content | max-content | fit-content | fit-content(${LENGTH_PERCENTAGE_0})`,
    'sizing',
    ['100%', 'fit-content', ...ALPHA1_SIZES],
    SIZE_KEYWORDS,
    { std: { values: SIZE_KEYWORDS, tokens: ['sizes', 'spacing'] } },
  ),
  SET(
    'height',
    `auto | ${LENGTH_PERCENTAGE_0} | min-content | max-content | fit-content | fit-content(${LENGTH_PERCENTAGE_0})`,
    'sizing',
    [...ALPHA1_SIZES.slice(1), '1px', '100%'],
    SIZE_KEYWORDS,
    { std: { values: SIZE_KEYWORDS, tokens: ['sizes', 'spacing'] } },
  ),
  SET(
    'minWidth',
    `auto | ${LENGTH_PERCENTAGE_0} | min-content | max-content | fit-content | fit-content(${LENGTH_PERCENTAGE_0})`,
    'sizing',
    ['0', ...ALPHA1_SIZES.slice(1), '100%'],
    SIZE_KEYWORDS,
    { std: { values: SIZE_KEYWORDS, tokens: ['sizes', 'spacing'] } },
  ),
  SET(
    'maxWidth',
    `none | ${LENGTH_PERCENTAGE_0} | min-content | max-content | fit-content | fit-content(${LENGTH_PERCENTAGE_0})`,
    'sizing',
    ['100%', '240px', '320px'],
    ['none', 'min-content', 'max-content', 'fit-content'],
    {
      std: {
        values: ['none', 'min-content', 'max-content', 'fit-content'],
        tokens: ['sizes', 'spacing'],
      },
    },
  ),
  SET(
    'position',
    'static | relative | absolute | sticky | fixed',
    'position',
    ['relative', 'absolute'],
    ['static', 'sticky', 'fixed'],
  ),
  SET('inset', `${INSET}{1,4}`, 'position', ['0'], ['auto'], {
    std: { values: ['auto'], tokens: ['spacing'] },
    ...shorthand(['top', 'right', 'bottom', 'left']),
  }),
  SET(
    'overflow',
    "<'overflow-block'>{1,2}",
    'overflow-scroll',
    ['hidden'],
    ['visible', 'clip', 'scroll', 'auto'],
    shorthand(['overflow-x', 'overflow-y']),
  ),
  SET(
    'clipPath',
    '<clip-source> | [ <basic-shape> || <geometry-box> ] | none',
    'clipping',
    ['inset(50%)'],
    ['none'],
  ),
  SET(
    'userSelect',
    'auto | text | none | contain | all',
    'interaction',
    ['none'],
    ['auto', 'text', 'all'],
  ),
  SET(
    'whiteSpace',
    "normal | pre | pre-wrap | pre-line | <'white-space-collapse'> || <'text-wrap-mode'>",
    'text-basic',
    ['nowrap'],
    ['normal', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  ),
  SET(
    'backgroundClip',
    '<bg-clip>#',
    'backgrounds',
    ['padding-box'],
    ['border-box', 'content-box', 'text'],
  ),
  SET(
    'borderWidth',
    '<line-width>{1,4}',
    'borders',
    ['1px'],
    ['0', 'thin', 'medium', 'thick'],
    shorthand(sides('border-', '-width')),
  ),
  SET(
    'borderStyle',
    '<line-style>{1,4}',
    'borders',
    ['solid'],
    [
      'none',
      'hidden',
      'dotted',
      'dashed',
      'double',
      'groove',
      'ridge',
      'inset',
      'outset',
    ],
    shorthand(sides('border-', '-style')),
  ),
  SET(
    'pointerEvents',
    'auto | bounding-box | visiblePainted | visibleFill | visibleStroke | visible | painted | fill | stroke | all | none',
    'interaction',
    ['none'],
    ['auto'],
  ),
  SET(
    'filter',
    'none | <filter-value-list>',
    'effects',
    ['grayscale(1)'],
    ['none'],
  ),
  SET(
    'transform',
    'none | <transform-list>',
    'transforms',
    ['translateY(1px)'],
    ['none'],
  ),
  SET(
    'textAlign',
    'start | end | left | right | center | justify | match-parent',
    'text-basic',
    ['left', 'start'],
    ['end', 'right', 'center', 'justify', 'match-parent'],
  ),
  SET(
    'textDecorationLine',
    'none | [ underline || overline || line-through || blink ] | spelling-error | grammar-error',
    'text-basic',
    ['underline'],
    ['none', 'overline', 'line-through'],
  ),
  SET(
    'animationName',
    '[ none | <keyframes-name> ]#',
    'keyframes',
    ['spin', 'pulse'],
    ['none'],
  ),
  SET('animationIterationCount', 'infinite | <number [0,∞]>', 'animations', [
    'infinite',
  ]),
  SET(
    'alignSelf',
    'auto | normal | stretch | <baseline-position> | <overflow-position>? <self-position>',
    'alignment',
    ['flex-start'],
    [
      'auto',
      'normal',
      'stretch',
      'baseline',
      'center',
      'flex-end',
      'start',
      'end',
    ],
  ),
  SET(
    'transitionProperty',
    'none | <single-transition-property>#',
    'transitions',
    ['all'],
    ['none'],
  ),
  SET('marginInline', `${MARGIN}{1,2}`, 'spacing', ['auto'], ['0'], {
    std: { values: ['0'], tokens: ['spacing'] },
    ...shorthand(
      ['margin-inline-start', 'margin-inline-end'],
      side('inline', null),
    ),
  }),

  // Legacy continuous ranges (Alpha 1 `STRUCTURAL_NUMBER_RANGES`).
  RANGE('opacity', '<number> | <percentage>', 'effects', 0, 1),
  RANGE(
    'flex',
    "none | [ <'flex-grow'> <'flex-shrink'>? || <'flex-basis'> ]",
    'flex',
    0,
    Infinity,
    shorthand(['flex-grow', 'flex-shrink', 'flex-basis']),
  ),
  RANGE('flexGrow', '<number [0,∞]>', 'flex', 0, Infinity),
  RANGE('flexShrink', '<number [0,∞]>', 'flex', 0, Infinity),

  // Composite forms, refused (Alpha 1 `COMPOSITE_FORMS`).
  COMPOSITE('background', '<bg-layer>#? , <final-bg-layer>', 'backgrounds', [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip',
  ]),
  COMPOSITE('border', '<line-width> || <line-style> || <color>', 'borders', [
    'border-width',
    'border-style',
    'border-color',
  ]),
  COMPOSITE(
    'font',
    "[ [ <'font-style'> || <font-variant-css2> || <'font-weight'> || <font-width-css3> ]? <'font-size'> [ / <'line-height'> ]? <'font-family'># ] | <system-family-name>",
    'text-basic',
    [
      'font-style',
      'font-variant',
      'font-weight',
      'font-stretch',
      'font-size',
      'line-height',
      'font-family',
    ],
  ),
  COMPOSITE('animation', '<single-animation>#', 'animations', [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ]),
  COMPOSITE('transition', '<single-transition>#', 'transitions', [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
  ]),

  // Platform extensions: recognition-only (CE-01.1 D-BP-03 platform ids).
  PLATFORM('WebkitAppRegion', 'drag | no-drag', 'interaction', 'electron'),
  PLATFORM(
    'WebkitUserDrag',
    'auto | element | none',
    'interaction',
    'electron',
  ),
  PLATFORM(
    'WebkitFontSmoothing',
    'auto | none | antialiased | subpixel-antialiased',
    'font-rendering',
    'electron',
  ),
];

const union = (a, b) => [...new Set([...a, ...b])];

function row([key, grammar, family, spec]) {
  const css = kebab(key);
  const status = spec.status ?? 'standard';
  const form = spec.form ?? 'longhand';
  const admitted = status === 'standard' && form !== 'rejected-composite';
  const def = admitted ? domain(spec.def) : null;
  const std = admitted
    ? domain({
        values: union(def.values, spec.std?.values ?? NONE),
        tokens: union(def.tokens, spec.std?.tokens ?? NONE),
        range: spec.std?.range ?? def.range,
      })
    : null;
  return {
    key,
    css,
    aliases: NONE,
    status,
    platform: spec.platform ?? null,
    grammar,
    contexts: ELEMENT,
    standard: std,
    default: def,
    form,
    longhands: spec.longhands ?? null,
    family,
    conflicts: NONE,
    direction: spec.direction ?? null,
    targetFeature:
      status === 'platform'
        ? `platform:${spec.platform}/${css}`
        : `property:${css}`,
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const CATALOG = (() => {
  const rows = ROWS.map(row);
  const byCss = new Map(rows.map((r) => [r.css, r.key]));
  // `conflicts` is derived from `longhands`: the shorthand rows that set this
  // row's property. Never authored separately.
  const conflicts = new Map();
  for (const r of rows) {
    if (r.form !== 'shorthand') continue;
    for (const longhand of r.longhands) {
      const key = byCss.get(longhand);
      if (key == null) continue;
      if (!conflicts.has(key)) conflicts.set(key, []);
      conflicts.get(key).push(r.key);
    }
  }
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.key)) throw new Error(`duplicate descriptor ${r.key}`);
    if (conflicts.has(r.key)) r.conflicts = conflicts.get(r.key).sort();
    map.set(r.key, deepFreeze(r));
  }
  return map;
})();
const KEYS = Object.freeze([...CATALOG.keys()]);

/** The descriptor of an authoring key, or null. Policy-internal. */
export function descriptorOf(key) {
  return typeof key === 'string' ? (CATALOG.get(key) ?? null) : null;
}

/** Every described authoring key, in catalog order. Policy-internal. */
export function descriptorKeys() {
  return KEYS;
}

let platformExtensionsMemo = null;

/**
 * CSS name -> CE-01.1 platform id of each platform-extension row. The target
 * catalog scopes these properties to profiles that announce the platform.
 */
export function platformExtensions() {
  if (platformExtensionsMemo == null) {
    const out = Object.create(null);
    for (const r of CATALOG.values())
      if (r.status === 'platform') out[r.css] = r.platform;
    platformExtensionsMemo = Object.freeze(out);
  }
  return platformExtensionsMemo;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** sha256 digest over the named fields of rows, in the given row order. */
export function digestOfRows(rows, fields) {
  const text = canonicalJson(
    rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]]))),
  );
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

let catalogDigestMemo = null;

/** Digest of the compiler-owned catalog (every row, every catalog field). */
export function catalogDigest() {
  if (catalogDigestMemo == null) {
    catalogDigestMemo = digestOfRows([...CATALOG.values()], CATALOG_FIELDS);
  }
  return catalogDigestMemo;
}
