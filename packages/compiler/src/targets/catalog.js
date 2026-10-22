/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Feature keys of emitted constructs (`pandamstyle-feature-catalog`, schema 1).
 *
 * There is no global feature list: a key exists for what the project's emitted
 * CSS contains. Each construct maps to one feature key and that key's OWN BCD
 * path(s). A key never borrows its parent's statement: `text-wrap: pretty`
 * is `value:text-wrap/pretty` evaluated on `css.properties.text-wrap.pretty`,
 * not on `css.properties.text-wrap`. A construct without a catalog mapping is
 * `unrecognized`, and its outcome is `unknown`.
 *
 * A value keyword with no BCD subfeature of its own belongs to the property's
 * base grammar: BCD records a keyword separately exactly when its support
 * differs from the property's. Such a keyword adds no key, and the property key
 * covers it. Every BCD keyword subfeature of an emitted property IS extracted
 * as its own key.
 */

import { compatData } from './data';
import { transformOfProperty } from './transforms';
import caveatReviews from './catalog/caveats.v1.json';
import inapplicableReviews from './catalog/inapplicable.v1.json';
import subfeatureReviews from './catalog/subfeatures.v1.json';
import { platformExtensions } from '../design-system/policy/descriptors';

export const CATALOG_KIND = 'pandamstyle-feature-catalog';
export const CATALOG_SCHEMA_VERSION = 1;

// D-BP-05 / LIM-05: obsolete engines' prefixes. Their properties are
// incompatible on every profile; no engine PandamStyle announces runs them.
const OBSOLETE_PREFIXES = ['-ms-', '-o-', '-khtml-'];
const VENDOR_PREFIXES = ['-webkit-', '-moz-'];

// D-BP-03 / LIM-07: platform-scoped extensions, valid only in a profile that
// announces their platform. CSS name -> platform id, read from the property
// descriptors (CE-02.1), the only property authority.
export const PLATFORM_FEATURES = platformExtensions();

// Units with their own BCD statement. Units absent here are unrecognized.
const UNIT_PATHS = Object.freeze({
  ...Object.fromEntries(
    ['cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax'].map((u) => [
      u,
      'css.types.length.container_query_length_units',
    ]),
  ),
  ...Object.fromEntries(
    ['dvh', 'dvw', 'dvi', 'dvb', 'dvmin', 'dvmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_dynamic',
    ]),
  ),
  ...Object.fromEntries(
    ['lvh', 'lvw', 'lvi', 'lvb', 'lvmin', 'lvmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_large',
    ]),
  ),
  ...Object.fromEntries(
    ['svh', 'svw', 'svi', 'svb', 'svmin', 'svmax'].map((u) => [
      u,
      'css.types.length.viewport_percentage_units_small',
    ]),
  ),
  ...Object.fromEntries(
    [
      'cap',
      'ch',
      'em',
      'ex',
      'ic',
      'lh',
      'rcap',
      'rch',
      'rem',
      'rex',
      'ric',
      'rlh',
      'vb',
      'vh',
      'vi',
      'vmax',
      'vmin',
      'vw',
    ].map((u) => [u, `css.types.length.${u}`]),
  ),
  q: 'css.types.length.Q',
  ...Object.fromEntries(
    ['px', 'cm', 'mm', 'in', 'pt', 'pc'].map((u) => [u, 'css.types.length']),
  ),
  ...Object.fromEntries(
    ['deg', 'grad', 'rad', 'turn'].map((u) => [u, `css.types.angle.${u}`]),
  ),
  s: 'css.types.time',
  ms: 'css.types.time',
  fr: 'css.types.flex',
  ...Object.fromEntries(
    ['dpcm', 'dpi', 'dppx', 'x'].map((u) => [u, `css.types.resolution.${u}`]),
  ),
});

// Where a value function is looked up, in order, for an emitting property.
// Type families are only searched for properties whose grammar uses them, so
// `clip: rect()` can never borrow the basic-shape `rect()` statement.
const FUNCTION_FAMILIES = Object.freeze([
  ['css.types.color', null],
  ['css.types.gradient', null],
  ['css.types.image', null],
  [
    'css.types.transform-function',
    ['transform', 'translate', 'rotate', 'scale'],
  ],
  ['css.types.filter-function', ['filter', 'backdrop-filter']],
  [
    'css.types.easing-function',
    [
      'transition',
      'transition-timing-function',
      'animation',
      'animation-timing-function',
    ],
  ],
  ['css.types.basic-shape', ['clip-path', 'shape-outside', 'offset-path', 'd']],
  // Last: a value type of the same name (`css.types.color` for `color()`) is
  // not the function.
  ['css.types', null],
]);
// Functions that belong to a property's or descriptor's own base grammar
// (BCD records no separate statement for them).
const BASE_GRAMMAR_FUNCTIONS = Object.freeze({
  clip: ['rect'],
  '@font-face/src': ['format', 'tech', 'local', 'url'],
});
// Function names whose BCD key differs from the CSS function name.
const FUNCTION_ALIASES = Object.freeze({
  linear: 'css.types.easing-function.linear-function',
  rgba: 'css.types.color.rgb',
  hsla: 'css.types.color.hsl',
});

/** The child of `parent` named `name`, compared case-insensitively. */
function childPath(parent, name) {
  const direct = `${parent}.${name}`;
  if (has(direct)) return direct;
  const child = lowerChildren(parent).get(name.toLowerCase());
  return child == null ? null : `${parent}.${child}`;
}

const lowerIndexes = new WeakMap();

/** Children of `parent` by lowercased name (the first child of each name). */
function lowerChildren(parent) {
  const data = compatData();
  let byParent = lowerIndexes.get(data);
  if (byParent == null) {
    byParent = new Map();
    lowerIndexes.set(data, byParent);
  }
  let children = byParent.get(parent);
  if (children == null) {
    children = new Map();
    for (const child of data.childrenOf(parent)) {
      const lower = child.toLowerCase();
      if (!children.has(lower)) children.set(lower, child);
    }
    byParent.set(parent, children);
  }
  return children;
}

const keywordIndexes = new WeakMap();

/**
 * Prefixed and renamed keywords of a property's BCD node: `keyword ->
 * { path, match }` for each statement naming an alternative name or a prefix,
 * in the order the children and statements are listed (the first wins).
 */
function keywordIndex(base) {
  const data = compatData();
  let byBase = keywordIndexes.get(data);
  if (byBase == null) {
    byBase = new Map();
    keywordIndexes.set(data, byBase);
  }
  let index = byBase.get(base);
  if (index != null) return index;
  index = new Map();
  for (const child of data.childrenOf(base)) {
    const path = `${base}.${child}`;
    // Only an entry recording a name or a prefix can match: the others are
    // skipped without being parsed.
    if (!data.mentions(path, '"n":') && !data.mentions(path, '"x":')) continue;
    for (const statements of Object.values(data.entry(path)?.e ?? {})) {
      for (const statement of statements) {
        if (statement.n != null && !index.has(statement.n)) {
          index.set(statement.n, {
            path,
            match: { alternativeName: statement.n },
          });
        }
        const prefixed = statement.x == null ? null : `${statement.x}${child}`;
        if (prefixed != null && !index.has(prefixed)) {
          index.set(prefixed, { path, match: { prefix: statement.x } });
        }
      }
    }
  }
  byBase.set(base, index);
  return index;
}

function functionPath(property, name) {
  if (Object.hasOwn(FUNCTION_ALIASES, name)) return FUNCTION_ALIASES[name];
  const custom = property === '' || property.startsWith('--');
  if (!custom && !property.startsWith('@')) {
    const own =
      childPath(`css.properties.${property}`, `${name}_function`) ??
      childPath(`css.properties.${property}`, name);
    if (own != null) return own;
  }
  if (property.startsWith('@')) {
    const [atRule, descriptor] = property.slice(1).split('/');
    const own = childPath(`css.at-rules.${atRule}.${descriptor}`, name);
    if (own != null) return own;
  }
  for (const [family, properties] of FUNCTION_FAMILIES) {
    if (properties != null && !custom && !properties.includes(property))
      continue;
    const path = childPath(family, name);
    if (path != null) return path;
  }
  return null;
}

const CONTAINER_QUERY_PATHS = Object.freeze({
  style: 'css.at-rules.container.style_queries_for_custom_properties',
  'scroll-state': 'css.at-rules.container.scroll-state_queries',
  anchored: 'css.at-rules.container.anchor_position_queries',
});

// Combinations with a definite meaning of their own.
export const COMBINATIONS = Object.freeze({
  // `:has()` cannot be nested in `:has()`; pseudo-elements are not allowed
  // inside it. Both are invalid selectors in every engine.
  'selector:has+selector:has': {
    components: ['selector:has'],
    fixed: { state: 'incompatible', reason: 'invalid-combination' },
  },
  'selector:has+pseudo-element': {
    components: ['selector:has'],
    fixed: { state: 'incompatible', reason: 'invalid-combination' },
  },
  // `!important` inside a cascade layer reverses layer precedence. It is
  // native where layers are native, and the restriction is recorded. CE-01.2
  // (D-BP-10) admits no lowering: the `:not(#\#)` ladder does not reverse it.
  'at-rule:layer/block+important': {
    components: ['at-rule:layer/block'],
    restriction: 'important-reverses-layer-order',
  },
});

function has(path) {
  return compatData().has(path);
}

let alternativeNames = null;

/**
 * BCD paths that record `name` as an alternative name (`-moz-osx-font-smoothing`
 * under `font-smooth`, `:-moz-focusring` under `:focus-visible`). Statements
 * are then matched on that exact name, never on the standard one.
 */
function alternativeNamePath(root, name) {
  if (alternativeNames == null) {
    alternativeNames = new Map();
    const data = compatData();
    for (const [path, entry] of data.alternativeNameEntries()) {
      const parts = path.split('.');
      const topLevel =
        (parts[1] === 'properties' || parts[1] === 'selectors') &&
        parts.length === 3;
      if (!topLevel) continue;
      for (const statements of Object.values(entry.e)) {
        for (const statement of statements) {
          if (statement.n == null) continue;
          const key = `${parts[0]}.${parts[1]}|${statement.n}`;
          if (!alternativeNames.has(key)) alternativeNames.set(key, path);
        }
      }
    }
  }
  return alternativeNames.get(`${root}|${name}`) ?? null;
}

function bcd(path, match = null) {
  return { path, match };
}

function record(feature, kind, parent, paths, extra = {}) {
  return Object.freeze({
    feature,
    kind,
    parent,
    bcd: paths,
    recognized: true,
    ...extra,
  });
}

function unrecognized(feature, kind, detail) {
  return Object.freeze({
    feature,
    kind,
    parent: null,
    bcd: [],
    recognized: false,
    detail,
  });
}

function prefixOf(name) {
  return VENDOR_PREFIXES.find((prefix) => name.startsWith(prefix)) ?? null;
}

/** The property feature and the BCD node its value keywords live under. */
function propertyFeature(name) {
  if (name.startsWith('--')) {
    return record(
      'property:custom-property',
      'property',
      null,
      [bcd('css.properties.custom-property')],
      { base: 'css.properties.custom-property' },
    );
  }
  if (Object.hasOwn(PLATFORM_FEATURES, name)) {
    const direct = `css.properties.${name}`;
    const alternative = has(direct)
      ? null
      : alternativeNamePath('css.properties', name);
    return record(
      `platform:${PLATFORM_FEATURES[name]}/${name}`,
      'platform',
      null,
      has(direct)
        ? [bcd(direct)]
        : alternative != null
          ? [bcd(alternative, { alternativeName: name })]
          : [],
      { platform: PLATFORM_FEATURES[name], base: direct },
    );
  }
  if (OBSOLETE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return record(`property:${name}`, 'property', null, [], {
      fixed: { state: 'incompatible', reason: 'obsolete-engine' },
    });
  }
  const direct = `css.properties.${name}`;
  if (has(direct)) {
    return record(`property:${name}`, 'property', null, [bcd(direct)], {
      base: direct,
    });
  }
  const prefix = prefixOf(name);
  if (prefix != null) {
    const base = `css.properties.${name.slice(prefix.length)}`;
    if (has(base)) {
      // The emitted name is the prefixed one: the statements that count are
      // the ones recording exactly that prefix.
      return record(
        `property:${name}`,
        'property',
        null,
        [bcd(base, { prefix })],
        {
          base,
          match: { prefix },
        },
      );
    }
  }
  const alternative = alternativeNamePath('css.properties', name);
  if (alternative != null) {
    return record(
      `property:${name}`,
      'property',
      null,
      [bcd(alternative, { alternativeName: name })],
      { base: alternative, match: { alternativeName: name } },
    );
  }
  return unrecognized(`property:${name}`, 'property', { name });
}

// Properties whose grammar takes a `<color>` besides `color` and `*-color`.
const COLOR_SHORTHANDS = new Set([
  'background',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-block',
  'border-inline',
  'border-block-start',
  'border-block-end',
  'border-inline-start',
  'border-inline-end',
  'outline',
  'column-rule',
  'text-decoration',
  'text-emphasis',
  'box-shadow',
  'text-shadow',
  'caret',
  'fill',
  'stroke',
  '-webkit-text-stroke',
]);
// Functions whose arguments take a `<color>`.
const COLOR_ARGUMENT_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  'contrast-color',
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
  'drop-shadow',
]);
// Functions whose arguments are read in the enclosing property's grammar.
const TRANSPARENT_FUNCTIONS = new Set(['var', 'env', 'attr', 'if']);

/**
 * Whether a keyword in `property` (inside function `fn`, or a custom property
 * of known `grammar`) is read as a `<color>`. A custom property of unknown
 * consumption is an untyped value: no color is inferred.
 */
function takesColor(property, fn, grammar) {
  if (fn != null && !TRANSPARENT_FUNCTIONS.has(fn)) {
    return COLOR_ARGUMENT_FUNCTIONS.has(fn);
  }
  if (property.startsWith('--')) return grammar === 'color';
  return (
    property === 'color' ||
    property.endsWith('-color') ||
    COLOR_SHORTHANDS.has(property)
  );
}

const OVERFLOW_PROPERTIES = new Set([
  'overflow',
  'overflow-x',
  'overflow-y',
  'overflow-block',
  'overflow-inline',
]);
const ANIMATION_RANGE_PROPERTIES = new Set([
  'animation-range',
  'animation-range-start',
  'animation-range-end',
]);
const outsideFunctions = (fn) => fn == null || TRANSPARENT_FUNCTIONS.has(fn);

// Value types whose keywords BCD records one by one (`AccentColor`), each
// with the grammars that consume it: a keyword is the type's only where its
// consumer takes the type.
const KEYWORD_TYPES = Object.freeze([
  ['css.types.color.named-color', takesColor],
  ['css.types.color.system-color', takesColor],
  [
    'css.types.overflow',
    (property, fn) => outsideFunctions(fn) && OVERFLOW_PROPERTIES.has(property),
  ],
  [
    'css.types.text-edge',
    (property, fn) =>
      outsideFunctions(fn) &&
      (property === 'text-box-edge' || property === 'text-box'),
  ],
  [
    'css.types.corner-shape-value',
    (property, fn) =>
      outsideFunctions(fn) && /^corner(-[a-z-]+)?-shape$/.test(property),
  ],
  [
    'css.types.timeline-range-name',
    (property, fn) =>
      outsideFunctions(fn) && ANIMATION_RANGE_PROPERTIES.has(property),
  ],
]);

// Token categories whose values are read as a `<color>` where consumed.
const COLOR_TOKEN_CATEGORIES = new Set(['colors', 'shadows']);
const grammarCache = new WeakMap();

/**
 * Value grammars of a design system's token custom properties, by name:
 * `--x -> 'color'` for tokens of a color-valued category. Other tokens are
 * consumed by properties that take no color (a font family named `Mark` is
 * not the system color).
 */
export function tokenGrammars(varsByToken) {
  if (varsByToken == null) return null;
  let grammars = grammarCache.get(varsByToken);
  if (grammars == null) {
    grammars = new Map();
    for (const [token, reference] of Object.entries(varsByToken)) {
      const name = /var\((--[^),\s]+)/.exec(String(reference))?.[1];
      if (name != null && COLOR_TOKEN_CATEGORIES.has(token.split('.')[0])) {
        grammars.set(name, 'color');
      }
    }
    grammarCache.set(varsByToken, grammars);
  }
  return grammars;
}

function keywordFeature(property, keyword, fn = null, grammar = null) {
  if (property.startsWith('@')) return null;
  const owner = propertyFeature(property);
  if (owner.base == null || owner.feature === 'property:custom-property') {
    return typeKeywordFeature(property, keyword, fn, grammar);
  }
  // CSS keywords are ASCII case-insensitive (`currentColor`).
  const direct = childPath(owner.base, keyword);
  if (direct != null) {
    // The property key already checks the emitted (possibly prefixed or
    // renamed) property name; the keyword key checks the keyword itself.
    return record(`value:${property}/${keyword}`, 'value', owner.feature, [
      bcd(direct),
    ]);
  }
  // A prefixed or renamed keyword (`-webkit-fill-available`) is recorded as
  // an alternative name or prefix on one of the property's keyword entries.
  const named = keywordIndex(owner.base).get(keyword);
  if (named != null) {
    return record(`value:${property}/${keyword}`, 'value', owner.feature, [
      bcd(named.path, named.match),
    ]);
  }
  if (prefixOf(keyword) != null) {
    return unrecognized(`value:${property}/${keyword}`, 'value', {
      property,
      keyword,
    });
  }
  return typeKeywordFeature(property, keyword, fn, grammar);
}

function typeKeywordFeature(property, keyword, fn, grammar) {
  for (const [type, consumes] of KEYWORD_TYPES) {
    if (!consumes(property, fn, grammar)) continue;
    const path = childPath(type, keyword);
    if (path != null) {
      return record(
        `value:${property}/${keyword}`,
        'value',
        property.startsWith('--')
          ? 'property:custom-property'
          : `property:${property}`,
        [bcd(path)],
      );
    }
  }
  return null;
}

function functionFeature(property, name, relative) {
  if ((BASE_GRAMMAR_FUNCTIONS[property] ?? []).includes(name)) return [];
  const path = functionPath(property, name);
  if (path == null) {
    return [unrecognized(`function:${name}`, 'function', { name, property })];
  }
  // A function recorded under one property is a value form of that property;
  // a function of a shared type family keeps one key everywhere.
  const scoped =
    path.startsWith('css.properties.') || path.startsWith('css.at-rules.');
  const key = scoped
    ? `value:${property.replace(/^@/, '@')}/${name}()`
    : `function:${name}`;
  const out = [
    record(
      key,
      scoped ? 'value' : 'function',
      scoped ? `property:${property}` : null,
      [bcd(path)],
    ),
  ];
  if (relative) {
    const relativePath = `${path}.relative_syntax`;
    out.push(
      has(relativePath)
        ? record(`${key}/relative`, 'function', key, [bcd(relativePath)])
        : unrecognized(`${key}/relative`, 'function', { name }),
    );
  }
  return out;
}

function selectorFeature(name, element) {
  const path = `css.selectors.${name}`;
  const feature = `selector:${element ? '::' : ':'}${name}`;
  if (has(path)) return record(feature, 'selector', null, [bcd(path)]);
  const spelled = `${element ? '::' : ':'}${name}`;
  const alternative = alternativeNamePath('css.selectors', spelled);
  return alternative != null
    ? record(feature, 'selector', null, [
        bcd(alternative, { alternativeName: spelled }),
      ])
    : unrecognized(feature, 'selector', { name, element });
}

function atRuleFeature(name, form) {
  if (name === 'layer') {
    return record(`at-rule:layer/${form}`, 'at-rule', null, [
      bcd('css.at-rules.layer'),
    ]);
  }
  const path = `css.at-rules.${name}`;
  return has(path)
    ? record(`at-rule:${name}`, 'at-rule', null, [bcd(path)])
    : unrecognized(`at-rule:${name}`, 'at-rule', { name });
}

function mediaFeature(name) {
  const direct = `css.at-rules.media.${name}`;
  if (has(direct)) {
    return record(`media:${name}`, 'media-feature', 'at-rule:media', [
      bcd(direct),
    ]);
  }
  const stripped = name.replace(/^(min|max)-/, '');
  const base = `css.at-rules.media.${stripped}`;
  if (stripped !== name && has(base)) {
    return record(`media:${stripped}`, 'media-feature', 'at-rule:media', [
      bcd(base),
    ]);
  }
  return unrecognized(`media:${name}`, 'media-feature', { name });
}

// --------------------------------------------------------- syntax forms ---

// Form suffixes whose BCD subfeature name is not derived from the suffix.
const FORM_CHILDREN = Object.freeze({
  animated: 'is_animatable',
  'attr-name-accepts-namespaces': 'attr-name_accepts_namespaces',
  'ident-value': 'IDENT_value',
  'font-width-keyword-values': 'font-width_keyword_values',
  'alt-text-counters': 'alt_text.counters',
});
// Forms recorded on a shared node rather than under the construct's own.
const ABSOLUTE_FORMS = Object.freeze({
  'from-currentcolor': 'css.types.color.from_currentcolor',
  'ratio-number-value': 'css.types.ratio.number_value',
  // anchor() / anchor-size() are recorded per property (`top: anchor()`);
  // their animation and inset/margin support only on the type.
  'anchor-animated': 'css.types.anchor.is_animatable',
  'anchor-size-animated': 'css.types.anchor-size.is_animatable',
  'anchor-size-inset-margin': 'css.types.anchor-size.inset_margin',
  // superellipse() as a corner shape.
  'corner-shape-value': 'css.types.corner-shape-value.superellipse',
});
// Math functions: a constant argument (`pi`) is a `<calc-keyword>`.
const MATH_FUNCTION_PATHS = new Set(
  [
    'calc',
    'min',
    'max',
    'clamp',
    'round',
    'mod',
    'rem',
    'abs',
    'sign',
    'sin',
    'cos',
    'tan',
    'asin',
    'acos',
    'atan',
    'atan2',
    'pow',
    'sqrt',
    'hypot',
    'log',
    'exp',
  ].map((name) => `css.types.${name}`),
);
const CALC_KEYWORDS = Object.freeze({
  e: 'e',
  pi: 'pi',
  infinity: 'infinity',
  '-infinity': 'infinity',
  nan: 'NaN',
});
// Keyword arguments whose BCD subfeature is named after the syntax.
const ARGUMENT_CHILDREN = Object.freeze({
  'css.types.easing-function.steps': {
    'jump-start': 'jump',
    'jump-end': 'jump',
    'jump-none': 'jump',
    'jump-both': 'jump',
  },
  'css.types.color.color': {
    'display-p3-linear': 'colorSpace_parameter_accepts_display-p3-linear_value',
  },
  'css.types.random': { by: 'step' },
  'css.types.ray': {
    at: 'position',
    'closest-side': 'size',
    'closest-corner': 'size',
    'farthest-side': 'size',
    'farthest-corner': 'size',
    sides: 'size',
  },
  'css.selectors.scroll-button': { '*': 'star' },
});

/**
 * The BCD subfeature of `parentPath` that form `suffix` names, or null. A
 * suffix is a keyword (`none`, case-insensitive) or a form name whose BCD key
 * spells its words with underscores (`space-separated-parameters`,
 * `nested-scroll-marker` → `nested_scroll-marker`).
 */
export function subfeaturePath(parentPath, suffix) {
  if (Object.hasOwn(ABSOLUTE_FORMS, suffix)) {
    return has(ABSOLUTE_FORMS[suffix]) ? ABSOLUTE_FORMS[suffix] : null;
  }
  if (suffix.startsWith('range-name-')) {
    // A keyframe selector's timeline range name.
    return childPath(
      'css.types.timeline-range-name',
      suffix.slice('range-name-'.length),
    );
  }
  if (
    MATH_FUNCTION_PATHS.has(parentPath) &&
    Object.hasOwn(CALC_KEYWORDS, suffix)
  ) {
    return childPath('css.types.calc-keyword', CALC_KEYWORDS[suffix]);
  }
  const alias = ARGUMENT_CHILDREN[parentPath]?.[suffix];
  if (alias != null) return childPath(parentPath, alias);
  if (Object.hasOwn(FORM_CHILDREN, suffix)) {
    const path = `${parentPath}.${FORM_CHILDREN[suffix]}`;
    return has(path) ? path : null;
  }
  if (suffix.endsWith('()')) {
    const name = suffix.slice(0, -2);
    return (
      childPath(parentPath, name) ?? childPath(parentPath, `${name}_function`)
    );
  }
  if (suffix.startsWith('in-')) {
    const scoped = childPath(parentPath, suffix.slice(3));
    if (scoped != null) return scoped;
  }
  const first = suffix.indexOf('-');
  const last = suffix.lastIndexOf('-');
  for (const candidate of new Set([
    suffix,
    suffix.replace(/-/g, '_'),
    first === -1
      ? suffix
      : `${suffix.slice(0, first)}_${suffix.slice(first + 1)}`,
    last === -1 ? suffix : `${suffix.slice(0, last)}_${suffix.slice(last + 1)}`,
  ])) {
    const path = childPath(parentPath, candidate);
    if (path != null) return path;
  }
  return null;
}

/** The record of form `suffix` of `parent`, or null (no BCD subfeature). */
function subfeature(parent, suffix) {
  if (parent == null || !parent.recognized || parent.bcd.length !== 1) {
    return null;
  }
  const path = subfeaturePath(parent.bcd[0].path, suffix);
  if (path == null) return null;
  const kind =
    parent.kind === 'property' || parent.kind === 'platform'
      ? 'value'
      : parent.kind;
  return record(`${parent.feature}/${suffix}`, kind, parent.feature, [
    bcd(path),
  ]);
}

export const TRANSFORM_FORM = 'prefix-alias';

/**
 * The record of a base property emitted with its transform-table variant
 * (`property:user-select/prefix-alias`): evaluated on the base's statements,
 * with the variant's statements as the proven transformation (outcome.js).
 */
function transformedPropertyFeature(name) {
  const entry = transformOfProperty(name);
  const base = propertyFeature(name);
  if (entry == null || !base.recognized || base.kind !== 'property') {
    return unrecognized(
      `property:${name}/${TRANSFORM_FORM}`,
      'property',
      'no transform-table entry',
    );
  }
  return record(
    `${base.feature}/${TRANSFORM_FORM}`,
    'property',
    base.feature,
    base.bcd,
    {
      base: base.base,
      transform: Object.freeze({
        id: entry.id,
        kind: entry.kind,
        variant: entry.variant,
        prefix: entry.prefix,
      }),
    },
  );
}

/** The record of the construct a form qualifies. */
function formParent(construct) {
  switch (construct.of) {
    case 'function':
      return (
        functionFeature(construct.property, construct.name, false)[0] ?? null
      );
    case 'property':
      return propertyFeature(construct.name);
    case 'selector':
      return selectorFeature(construct.name, construct.element);
    case 'attribute-selector':
      return featuresOf({ kind: 'attribute-selector' })[0];
    case 'media':
      return mediaFeature(construct.name);
    case 'container':
      return featuresOf({ kind: 'container-query', name: construct.name })[0];
    case 'supports':
      return featuresOf({ kind: 'supports-function', name: construct.name })[0];
    case 'at-rule':
      return atRuleFeature(construct.name, 'block');
    case 'descriptor':
      return (
        featuresOf({
          kind: 'descriptor',
          atRule: construct.atRule,
          name: construct.name,
        })[0] ?? null
      );
    default:
      return null;
  }
}

/** Feature records for one construct (a construct can imply two keys). */
export function featuresOf(construct) {
  switch (construct.kind) {
    case 'form': {
      // A form of a form (`type()/length`) is resolved step by step.
      let feature = formParent(construct);
      for (const part of construct.suffix.split('/')) {
        feature = subfeature(feature, part);
      }
      return feature == null ? [] : [feature];
    }
    case 'property':
      return [
        construct.transform == null
          ? propertyFeature(construct.name)
          : transformedPropertyFeature(construct.name),
      ];
    case 'value-keyword': {
      const feature = keywordFeature(
        construct.property,
        construct.keyword,
        construct.fn ?? null,
        construct.grammar ?? null,
      );
      if (feature == null) return [];
      // An entry of a font stack that a later entry backs up is an
      // author-declared fallback in the value itself.
      return construct.listFallback === true
        ? [{ ...feature, fallback: { kind: 'css-list-fallback' } }]
        : [feature];
    }
    case 'value-multi-keyword': {
      const path = 'css.properties.display.multi-keyword_values';
      return [
        has(path)
          ? record('value:display/multi-keyword', 'value', 'property:display', [
              bcd(path),
            ])
          : unrecognized('value:display/multi-keyword', 'value', {}),
      ];
    }
    case 'global-keyword': {
      const path = `css.types.global_keywords.${construct.keyword}`;
      return [
        has(path)
          ? record(`value:global/${construct.keyword}`, 'value', null, [
              bcd(path),
            ])
          : unrecognized(`value:global/${construct.keyword}`, 'value', {}),
      ];
    }
    case 'alpha-hex-color': {
      const path =
        'css.types.color.rgb_hexadecimal_notation.alpha_hexadecimal_notation';
      return [record('value:color/alpha-hex', 'value', null, [bcd(path)])];
    }
    case 'function':
      return functionFeature(
        construct.property,
        construct.name,
        construct.relative,
      );
    case 'unit': {
      const path = UNIT_PATHS[construct.unit];
      if (path == null) {
        return [
          unrecognized(`unit:${construct.unit}`, 'unit', {
            unit: construct.unit,
          }),
        ];
      }
      return [record(`unit:${construct.unit}`, 'unit', null, [bcd(path)])];
    }
    case 'selector':
      return [selectorFeature(construct.name, construct.element)];
    case 'attribute-selector':
      return [
        record('selector:attribute', 'selector', null, [
          bcd('css.selectors.attribute'),
        ]),
      ];
    case 'at-rule':
      return [atRuleFeature(construct.name, construct.form)];
    case 'media-feature':
      return [mediaFeature(construct.name)];
    case 'media-syntax':
      return [
        record(`media:${construct.name}`, 'media-feature', 'at-rule:media', [
          bcd(`css.at-rules.media.${construct.name}`),
        ]),
      ];
    case 'container-query': {
      const path = CONTAINER_QUERY_PATHS[construct.name];
      return [
        path == null
          ? unrecognized(`at-rule:container/${construct.name}`, 'at-rule', {})
          : record(
              `at-rule:container/${construct.name}`,
              'at-rule',
              'at-rule:container',
              [bcd(path)],
            ),
      ];
    }
    case 'supports-function': {
      const path = `css.at-rules.supports.${construct.name}`;
      return [
        has(path)
          ? record(
              `at-rule:supports/${construct.name}`,
              'at-rule',
              'at-rule:supports',
              [bcd(path)],
            )
          : unrecognized(`at-rule:supports/${construct.name}`, 'at-rule', {}),
      ];
    }
    case 'descriptor': {
      const path = `css.at-rules.${construct.atRule}.${construct.name}`;
      if (has(path)) {
        return [
          record(
            `descriptor:${construct.atRule}/${construct.name}`,
            'descriptor',
            `at-rule:${construct.atRule}`,
            [bcd(path)],
          ),
        ];
      }
      // A descriptor without its own statement is part of the at-rule's base
      // grammar, exactly like a value keyword.
      return has(`css.at-rules.${construct.atRule}`)
        ? []
        : [
            unrecognized(
              `descriptor:${construct.atRule}/${construct.name}`,
              'descriptor',
              {},
            ),
          ];
    }
    case 'marker-property': {
      // Evaluated on the `::marker` statements, scoped to the property: a
      // partial `::marker` review names the properties it accepts.
      const property = construct.property.startsWith('--')
        ? 'custom-property'
        : construct.property;
      return [
        record(
          `combination:selector:::marker+property:${property}`,
          'combination',
          'selector:::marker',
          [bcd('css.selectors.marker')],
          {
            scope: { property },
            components: ['selector:::marker', `property:${property}`],
          },
        ),
      ];
    }
    case 'combination': {
      const definition = COMBINATIONS[construct.key];
      return [
        definition == null
          ? unrecognized(`combination:${construct.key}`, 'combination', {})
          : record(`combination:${construct.key}`, 'combination', null, [], {
              components: definition.components,
              fixed: definition.fixed ?? null,
              restriction: definition.restriction ?? null,
            }),
      ];
    }
    case 'unclassified':
    default:
      return [
        unrecognized(
          `unclassified:${construct.where ?? 'css'}`,
          'unclassified',
          construct,
        ),
      ];
  }
}

// ---------------------------------------------------------------- caveats ---

let caveatIndex = null;

/** Reviewed caveat dispositions, keyed by `path|engine|noteDigest`. */
export function caveatDisposition(path, engine, noteDigest) {
  if (caveatIndex == null) {
    caveatIndex = new Map();
    for (const review of caveatReviews.reviews) {
      for (const reviewedEngine of review.engines) {
        caveatIndex.set(
          `${review.path}|${reviewedEngine}|${review.note}`,
          review,
        );
      }
    }
  }
  return caveatIndex.get(`${path}|${engine}|${noteDigest}`) ?? null;
}

export function caveatCatalog() {
  return caveatReviews;
}

/**
 * Reviewed platform inapplicability: the engine has no mode or input in which
 * the feature could act, so "no effect" is the correct platform behavior.
 * Keyed by feature key or by a `value:<property>/` prefix, and by engine.
 */
export function inapplicability(feature, engine) {
  for (const entry of inapplicableReviews.entries) {
    if (!entry.engines.includes(engine)) continue;
    const matches = entry.features.some((pattern) =>
      pattern.endsWith('/*')
        ? feature.startsWith(pattern.slice(0, -1))
        : feature === pattern,
    );
    if (matches) return entry;
  }
  return null;
}

export function inapplicableCatalog() {
  return inapplicableReviews;
}

// ------------------------------------------------------------ subfeatures ---

export function subfeatureCatalog() {
  return subfeatureReviews;
}

/**
 * The record of a feature key, or null when the key is not a catalog key.
 * Used where a key is authored (enhancement policies) or published (package
 * requirements) instead of extracted from emitted CSS.
 */
export function featureByKey(key) {
  const direct = catalogKey(key);
  if (direct != null || typeof key !== 'string') return direct;
  // A form key: `<parent key>/<suffix>`.
  const cut = key.lastIndexOf('/');
  if (cut <= 0) return null;
  if (
    key.startsWith('property:') &&
    key.slice(cut + 1) === TRANSFORM_FORM &&
    key.indexOf('/') === cut
  ) {
    const form = transformedPropertyFeature(key.slice('property:'.length, cut));
    return form.recognized ? form : null;
  }
  const form = subfeature(featureByKey(key.slice(0, cut)), key.slice(cut + 1));
  return form != null && form.feature === key ? form : null;
}

function catalogKey(key) {
  if (typeof key !== 'string') return null;
  const colon = key.indexOf(':');
  if (colon === -1) return null;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  const recognizedOrNull = (records) => {
    const found = records.find((r) => r.feature === key);
    return found != null && found.recognized ? found : null;
  };
  switch (kind) {
    case 'property':
      return recognizedOrNull([
        propertyFeature(rest === 'custom-property' ? '--x' : rest),
      ]);
    case 'platform': {
      const [, name] = rest.split('/');
      return recognizedOrNull([propertyFeature(name ?? '')]);
    }
    case 'value': {
      const slash = rest.indexOf('/');
      if (slash === -1) return null;
      const property = rest.slice(0, slash);
      const keyword = rest.slice(slash + 1);
      if (property === 'display' && keyword === 'multi-keyword') {
        return recognizedOrNull(
          featuresOf({ kind: 'value-multi-keyword', property }),
        );
      }
      if (property === 'global') {
        return recognizedOrNull(
          featuresOf({ kind: 'global-keyword', keyword }),
        );
      }
      if (property === 'color' && keyword === 'alpha-hex') {
        return recognizedOrNull(featuresOf({ kind: 'alpha-hex-color' }));
      }
      if (keyword.endsWith('()')) {
        return recognizedOrNull(
          functionFeature(property, keyword.slice(0, -2), false),
        );
      }
      // An authored key names a keyword as consumed: a custom property's
      // keyword key is valid for a color-consumed token.
      const record = keywordFeature(
        property,
        keyword,
        null,
        property.startsWith('--') ? 'color' : null,
      );
      return record != null && record.feature === key && record.recognized
        ? record
        : null;
    }
    case 'function': {
      const [name, variant] = rest.split('/');
      return recognizedOrNull(
        functionFeature('', name, variant === 'relative'),
      );
    }
    case 'unit':
      return recognizedOrNull(featuresOf({ kind: 'unit', unit: rest }));
    case 'selector': {
      const element = rest.startsWith('::');
      const name = rest.replace(/^::?/, '');
      if (name === 'attribute' && !element) {
        return recognizedOrNull(featuresOf({ kind: 'attribute-selector' }));
      }
      return recognizedOrNull([selectorFeature(name, element)]);
    }
    case 'at-rule': {
      const [name, sub] = rest.split('/');
      if (name === 'layer')
        return recognizedOrNull([atRuleFeature('layer', sub ?? '')]);
      if (name === 'container' && sub != null) {
        return recognizedOrNull(
          featuresOf({ kind: 'container-query', name: sub }),
        );
      }
      if (name === 'supports' && sub != null) {
        return recognizedOrNull(
          featuresOf({ kind: 'supports-function', name: sub }),
        );
      }
      return sub == null
        ? recognizedOrNull([atRuleFeature(name, 'block')])
        : null;
    }
    case 'media':
      return recognizedOrNull(
        ['range_syntax', 'or_syntax'].includes(rest)
          ? featuresOf({ kind: 'media-syntax', name: rest })
          : [mediaFeature(rest)],
      );
    case 'descriptor': {
      const [atRule, name] = rest.split('/');
      return recognizedOrNull(featuresOf({ kind: 'descriptor', atRule, name }));
    }
    case 'combination': {
      const marker = /^selector:::marker\+property:(.+)$/.exec(rest);
      return recognizedOrNull(
        marker == null
          ? featuresOf({ kind: 'combination', key: rest })
          : featuresOf({ kind: 'marker-property', property: marker[1] }),
      );
    }
    default:
      return null;
  }
}
