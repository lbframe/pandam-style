/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Construct extraction from EMITTED CSS.
 *
 * Browser claims attach to the CSS the compiler actually emits, so this reads
 * rule text, never authoring syntax. It returns finite constructs (a property,
 * a value keyword, a function, a unit, a selector, an at-rule and its query
 * kinds, a descriptor, a known combination) that `catalog.js` maps to feature
 * keys. Anything it cannot classify becomes an `unclassified` construct, which
 * the outcome function reports as `unknown`, never as native.
 */

import { tokenize } from '@csstools/css-tokenizer';

import { tokenizeEmitted } from './tokens';

const GLOBAL_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

// At-rules whose block holds rules, declarations or keyframes.
const RULE_BLOCK_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'starting-style',
  'document',
]);
const DECLARATION_BLOCK_AT_RULES = new Set([
  'property',
  'font-face',
  'counter-style',
  'page',
  'position-try',
  'view-transition',
  'font-palette-values',
  'font-feature-values',
]);

const type = (token) => token[0];
const value = (token) => token[4]?.value;
const isWs = (token) =>
  type(token) === 'whitespace-token' || type(token) === 'comment';
const OPEN = new Set(['(-token', '[-token', '{-token', 'function-token']);
const CLOSE = new Set([')-token', ']-token', '}-token']);

/** Index of the token closing the block opened at `open`. */
function matching(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (OPEN.has(type(tokens[i]))) depth += 1;
    else if (CLOSE.has(type(tokens[i]))) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** Splits `[start, end)` at top-level tokens of the given type. */
function splitTop(tokens, start, end, separator) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (OPEN.has(t)) depth += 1;
    else if (CLOSE.has(t)) depth -= 1;
    else if (depth === 0 && t === separator) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

function trimRange(tokens, [start, end]) {
  let s = start;
  let e = end;
  while (s < e && isWs(tokens[s])) s += 1;
  while (e > s && isWs(tokens[e - 1])) e -= 1;
  return [s, e];
}

// The text being extracted. Tokens cover it contiguously, so the raw text of
// a token range is the source between the first token's start and the last
// token's end.
let source = '';

function text(tokens, start, end) {
  if (start >= end) return '';
  return source.slice(tokens[start][2], tokens[end - 1][3] + 1).trim();
}

// eslint-disable-next-line no-control-regex
const SEPARATOR = /[\u0001-\u0003]/;
const hasSeparator = (text) => SEPARATOR.test(text);

/**
 * A key equal for two constructs exactly when their JSON is: the fields in
 * insertion order with their primitive values (constructs hold only strings,
 * booleans and numbers). Anything else, or a string holding a separator,
 * falls back to JSON.
 */
export function constructKey(construct) {
  let key = '';
  for (const field in construct) {
    const value = construct[field];
    if (value === undefined) continue;
    if (
      (value !== null && typeof value === 'object') ||
      (typeof value === 'string' && hasSeparator(value)) ||
      hasSeparator(field)
    ) {
      return `\u0003${JSON.stringify(construct)}`;
    }
    key += `${field}\u0001${typeof value}\u0001${value}\u0002`;
  }
  return key;
}

class Collector {
  constructor(dedupe = true) {
    this.items = [];
    this.keys = new Set();
    this.dedupe = dedupe;
  }
  add(construct, context) {
    const key = constructKey(construct);
    if (this.dedupe && this.keys.has(key)) return;
    this.keys.add(key);
    this.items.push({ construct, context });
  }
}

// ---------------------------------------------------------- syntax forms ----
//
// A syntax form is a way of writing a construct that BCD records as its own
// subfeature: `rgb(1 2 3)` is `css.types.color.rgb.space_separated_parameters`,
// `:nth-child(2 of .x)` is `css.selectors.nth-child.of_syntax`, `overflow:
// hidden auto` is `css.properties.overflow.multiple_keywords`. Each is
// extracted as `{ kind: 'form', of, ..., suffix }` next to the construct it
// qualifies; the catalog resolves the suffix against that construct's own BCD
// node, so a form whose node records no such subfeature adds nothing.

const lower = (token) => String(value(token)).toLowerCase();
const isIdent = (token, name) =>
  token != null && type(token) === 'ident-token' && lower(token) === name;
const isDelim = (token, char) =>
  token != null && type(token) === 'delim-token' && value(token) === char;

// Channel positions per color function that a `<number>`/`<percentage>` mix
// is read on (hue and alpha excluded).
const COLOR_CHANNELS = Object.freeze({
  rgb: [0, 1, 2],
  rgba: [0, 1, 2],
  hsl: [1, 2],
  hsla: [1, 2],
  hwb: [1, 2],
  lab: [0, 1, 2],
  lch: [0, 1],
  oklab: [0, 1, 2],
  oklch: [0, 1],
  color: [1, 2, 3],
});
const COLOR_VALUE_FUNCTIONS = new Set([
  ...Object.keys(COLOR_CHANNELS),
  'color-mix',
  'light-dark',
  'contrast-color',
  'var',
  'attr',
  'env',
]);
const GRADIENTS = new Set([
  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
  'repeating-linear-gradient',
  'repeating-radial-gradient',
  'repeating-conic-gradient',
]);
const MATH_FUNCTIONS = new Set([
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
]);
const IMAGE_FUNCTIONS = new Set([
  'url',
  'image',
  'image-set',
  'cross-fade',
  'element',
  ...GRADIENTS,
]);
// Words of a gradient's first argument (direction, shape, size, position,
// interpolation); a first argument made only of these and lengths is not a
// color stop.
const GRADIENT_WORDS = new Set([
  'to',
  'at',
  'in',
  'from',
  'circle',
  'ellipse',
  'closest-side',
  'closest-corner',
  'farthest-side',
  'farthest-corner',
  'left',
  'right',
  'top',
  'bottom',
  'center',
  'longer',
  'shorter',
  'increasing',
  'decreasing',
  'hue',
  'srgb',
  'srgb-linear',
  'display-p3',
  'display-p3-linear',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'lab',
  'oklab',
  'xyz',
  'xyz-d50',
  'xyz-d65',
  'hsl',
  'hwb',
  'lch',
  'oklch',
]);
const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);
const TRANSFORM_3D = new Set([
  'matrix3d',
  'translate3d',
  'translatez',
  'scale3d',
  'scalez',
  'rotate3d',
  'rotatex',
  'rotatey',
  'perspective',
]);
const BASIC_SHAPES = new Set([
  'inset',
  'circle',
  'ellipse',
  'polygon',
  'path',
  'shape',
  'rect',
  'xywh',
]);
// Properties BCD records separately when set on a pseudo-element.
const PSEUDO_ELEMENT_PROPERTIES = Object.freeze({
  selection: {
    'text-decoration': 'text-decoration',
    'text-decoration-line': 'text-decoration',
    'text-decoration-color': 'text-decoration',
    'text-decoration-style': 'text-decoration',
    'text-decoration-thickness': 'text-decoration',
  },
  marker: {
    'counter-increment': 'counter-support',
    'counter-reset': 'counter-support',
    'counter-set': 'counter-support',
    quotes: 'quotes-support',
  },
});
const ANIMATED_PSEUDO_ELEMENTS = new Set(['before', 'after', 'marker']);
const CORNER_RADII = new Set([
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
]);
const ALIGNMENT_PROPERTIES = new Set([
  'align-content',
  'align-items',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
]);
const DECORATION_LINES = new Set([
  'none',
  'underline',
  'overline',
  'line-through',
  'blink',
  'spelling-error',
  'grammar-error',
]);
const DECORATION_THICKNESS = new Set(['auto', 'from-font']);
const LEGACY_WHITE_SPACE = new Set([
  'normal',
  'pre',
  'nowrap',
  'pre-wrap',
  'pre-line',
  'break-spaces',
]);
const FONT_WIDTHS = new Set([
  'ultra-condensed',
  'extra-condensed',
  'condensed',
  'semi-condensed',
  'semi-expanded',
  'expanded',
  'extra-expanded',
  'ultra-expanded',
]);
// `@font-face` `format()` hints and `tech()` keywords naming a font format
// BCD records under the at-rule.
const FONT_FORMATS = Object.freeze({
  woff: 'woff',
  woff2: 'woff-2',
  svg: 'svg-fonts',
});
const FONT_TECHNOLOGIES = Object.freeze({
  'color-colrv0': 'opentype-colrv0',
  'color-colrv1': 'opentype-colrv1',
  'color-svg': 'opentype-svg',
  'color-sbix': 'opentype-sbix',
  'color-cbdt': 'opentype-cbdt-cblc',
});

// The functions and properties some form is read on; the others are skipped
// without looking at their arguments or value.
const FORM_FUNCTIONS = new Set([
  ...Object.keys(COLOR_CHANNELS),
  'color-mix',
  'light-dark',
  'attr',
  ...GRADIENTS,
  ...MATH_FUNCTIONS,
]);
const FORM_PROPERTIES = new Set([
  'overflow',
  'text-overflow',
  'border-radius',
  'content',
  'cursor',
  'font-size',
  'z-index',
  'transform',
  'box-shadow',
  'background',
  'background-image',
  'mask-image',
  'clip-path',
  'text-decoration',
  'white-space',
  'font',
  'transition-property',
  'transition',
  ...ALIGNMENT_PROPERTIES,
  ...CORNER_RADII,
]);

/** Top-level components of `[start, end)`: single tokens or whole blocks. */
function components(tokens, start, end) {
  const out = [];
  for (let i = start; i < end; i += 1) {
    if (isWs(tokens[i])) continue;
    if (OPEN.has(type(tokens[i]))) {
      const close = Math.min(matching(tokens, i), end - 1);
      out.push([i, close + 1]);
      i = close;
      continue;
    }
    out.push([i, i + 1]);
  }
  return out;
}

/** Whether `[start, end)` holds a top-level token of type `separator`. */
function hasTopLevel(tokens, start, end, separator) {
  let depth = 0;
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (OPEN.has(t)) depth += 1;
    else if (CLOSE.has(t)) depth -= 1;
    else if (depth === 0 && t === separator) return true;
  }
  return false;
}

/** Non-empty top-level comma items of `[start, end)`, trimmed. */
function commaItems(tokens, start, end) {
  return splitTop(tokens, start, end, 'comma-token')
    .map((range) => trimRange(tokens, range))
    .filter(([s, e]) => s < e);
}

const single = (tokens, [s, e]) => (e - s === 1 ? tokens[s] : null);
const functionName = (tokens, [s]) =>
  type(tokens[s]) === 'function-token' ? lower(tokens[s]) : null;

function isColorComponent(tokens, part) {
  const token = single(tokens, part);
  if (token == null) {
    const name = functionName(tokens, part);
    return name != null && COLOR_VALUE_FUNCTIONS.has(name);
  }
  if (type(token) === 'hash-token') return true;
  return type(token) === 'ident-token' && !GRADIENT_WORDS.has(lower(token));
}

function isLengthLike(tokens, part) {
  const token = single(tokens, part);
  if (token == null) {
    const name = functionName(tokens, part);
    return name != null && MATH_FUNCTIONS.has(name);
  }
  return (
    type(token) === 'dimension-token' ||
    type(token) === 'percentage-token' ||
    (type(token) === 'number-token' && token[4].value === 0)
  );
}

/** Syntax forms of the arguments `[start, end)` of function `name`. */
function functionForms(name, tokens, start, end) {
  const forms = [];
  if (!FORM_FUNCTIONS.has(name)) return forms;
  const items = commaItems(tokens, start, end);
  const parts = components(tokens, start, end);
  if (Object.hasOwn(COLOR_CHANNELS, name)) {
    if (parts.length > 0 && isIdent(tokens[parts[0][0]], 'from')) {
      if (
        parts[1] != null &&
        isIdent(single(tokens, parts[1]), 'currentcolor')
      ) {
        forms.push('from-currentcolor');
      }
      return forms;
    }
    const comma = items.length > 1;
    const slash = parts.findIndex((part) => isDelim(single(tokens, part), '/'));
    const list = comma
      ? items.map(([s, e]) => components(tokens, s, e)[0])
      : parts.slice(0, slash === -1 ? parts.length : slash);
    const legacy =
      name === 'rgb' || name === 'rgba' || name === 'hsl' || name === 'hsla';
    if (legacy && !comma && list.length >= 3) {
      forms.push('space-separated-parameters');
    }
    if (
      (name === 'rgb' || name === 'hsl') &&
      (items.length === 4 || slash !== -1)
    ) {
      forms.push('alpha-parameter');
    }
    const channels = COLOR_CHANNELS[name]
      .map((index) =>
        list[index] == null ? null : single(tokens, list[index]),
      )
      .filter((token) => token != null);
    if (
      (name === 'rgb' || name === 'rgba') &&
      channels.some(
        (token) => type(token) === 'number-token' && token[4].type === 'number',
      )
    ) {
      forms.push('float-values');
    }
    if (
      channels.some((token) => type(token) === 'number-token') &&
      channels.some((token) => type(token) === 'percentage-token')
    ) {
      forms.push('mixed-type-parameters');
    }
    return forms;
  }
  if (name === 'color-mix') {
    const colors = items.filter(([s]) => !isIdent(tokens[s], 'in'));
    if (colors.length !== 2) forms.push('variadic-color-arguments');
    return forms;
  }
  if (name === 'light-dark') {
    if (
      parts.some(
        (part) =>
          IMAGE_FUNCTIONS.has(functionName(tokens, part)) ||
          type(tokens[part[0]]) === 'url-token',
      )
    ) {
      forms.push('image-value');
    }
    return forms;
  }
  if (GRADIENTS.has(name)) {
    let stops = items;
    if (items.length > 0) {
      const first = components(tokens, items[0][0], items[0][1]);
      if (!first.some((part) => isColorComponent(tokens, part))) {
        stops = items.slice(1);
        const words = first
          .map((part) => single(tokens, part))
          .filter((token) => token != null && type(token) === 'ident-token')
          .map(lower);
        if (words.includes('in')) forms.push('interpolation-color-space');
        if (words.some((word) => HUE_METHODS.has(word))) {
          forms.push('hue-interpolation-method');
        }
        const only = first.length === 1 ? single(tokens, first[0]) : null;
        if (
          only != null &&
          type(only) === 'number-token' &&
          only[4].value === 0 &&
          name.endsWith('linear-gradient')
        ) {
          forms.push('unitless-0-angle');
        }
      }
    }
    let colorStops = 0;
    for (const [s, e] of stops) {
      const stop = components(tokens, s, e);
      const colors = stop.filter((part) => isColorComponent(tokens, part));
      if (colors.length === 0) {
        if (stop.length === 1) forms.push('interpolation-hints');
        continue;
      }
      colorStops += 1;
      if (stop.filter((part) => isLengthLike(tokens, part)).length >= 2) {
        forms.push('doubleposition');
      }
    }
    if (colorStops === 1) forms.push('single-color-stop');
    return forms;
  }
  if (name === 'attr') {
    if (items.length > 1) forms.push('fallback');
    return forms;
  }
  if (MATH_FUNCTIONS.has(name)) {
    for (let i = start; i < end; i += 1) {
      if (!isDelim(tokens[i], '/')) continue;
      let j = i + 1;
      while (j < end && isWs(tokens[j])) j += 1;
      const t = j < end ? type(tokens[j]) : null;
      if (t === 'dimension-token' || t === 'percentage-token') {
        forms.push('typed-division-produces-unitless-number');
        break;
      }
    }
    if (name === 'mod' || name === 'rem' || name === 'round') {
      const leaves = tokens.slice(start, end).map(type);
      if (
        leaves.includes('percentage-token') &&
        (leaves.includes('dimension-token') || leaves.includes('number-token'))
      ) {
        forms.push('mixed-type-parameters');
      }
    }
  }
  return forms;
}

/**
 * Syntax forms of the whole value `[start, end)` of `property`, added to
 * `out`. A form naming another property (`transition: display 1s`) is that
 * property's.
 */
function valueForms(property, tokens, start, end, out, context) {
  if (!FORM_PROPERTIES.has(property)) return;
  const parts = components(tokens, start, end);
  const items = commaItems(tokens, start, end);
  const idents = parts
    .map((part) => single(tokens, part))
    .filter((token) => token != null && type(token) === 'ident-token')
    .map(lower);
  const slash = parts.findIndex((part) => isDelim(single(tokens, part), '/'));
  const add = (suffix, name = property) =>
    out.add({ kind: 'form', of: 'property', name, suffix }, context);
  const leaves = tokens.slice(start, end);
  switch (property) {
    case 'overflow':
      if (parts.length >= 2) add('multiple-keywords');
      break;
    case 'text-overflow':
      if (parts.length === 2) add('two-value-syntax');
      break;
    case 'border-radius':
      if (slash !== -1) add('elliptical-borders');
      if ((slash === -1 ? parts.length : slash) > 2)
        add('4-values-for-4-corners');
      break;
    case 'content':
      if (slash !== -1) {
        add('alt-text');
        if (
          parts
            .slice(slash + 1)
            .some((part) =>
              ['counter', 'counters'].includes(functionName(tokens, part)),
            )
        ) {
          add('alt-text-counters');
        }
      }
      break;
    case 'cursor':
      for (const [s, e] of items) {
        const item = components(tokens, s, e);
        const url =
          functionName(tokens, item[0]) === 'url' ||
          type(tokens[item[0][0]]) === 'url-token';
        if (url && item.length > 1) add('url-positioning-syntax');
      }
      break;
    case 'font-size':
      if (
        leaves.some(
          (token) =>
            type(token) === 'dimension-token' &&
            String(token[4].unit).toLowerCase() === 'rem',
        )
      ) {
        add('rem-values');
      }
      break;
    case 'z-index':
      if (
        leaves.some(
          (token) => type(token) === 'number-token' && token[4].value < 0,
        )
      ) {
        add('negative-values');
      }
      break;
    case 'transform':
      if (
        leaves.some(
          (token) =>
            type(token) === 'function-token' && TRANSFORM_3D.has(lower(token)),
        )
      ) {
        add('3d');
      }
      break;
    case 'box-shadow':
      if (items.length > 1) add('multiple-shadows');
      if (
        items.some(
          ([s, e]) =>
            components(tokens, s, e).filter((part) =>
              isLengthLike(tokens, part),
            ).length >= 4,
        )
      ) {
        add('spread-radius');
      }
      break;
    case 'background':
    case 'background-image':
      if (items.length > 1) add('multiple-backgrounds');
      break;
    case 'mask-image':
      if (items.length > 1) add('multiple-mask-images');
      break;
    case 'clip-path':
      if (parts.some((part) => BASIC_SHAPES.has(functionName(tokens, part)))) {
        add('basic-shape');
      }
      break;
    case 'text-decoration': {
      let colorOrStyle = false;
      let thickness = false;
      for (const part of parts) {
        const token = single(tokens, part);
        if (token != null && type(token) === 'ident-token') {
          const word = lower(token);
          if (DECORATION_LINES.has(word)) continue;
          if (DECORATION_THICKNESS.has(word)) thickness = true;
          else colorOrStyle = true;
        } else if (isLengthLike(tokens, part)) thickness = true;
        else colorOrStyle = true;
      }
      if (colorOrStyle) add('includes-color-and-style');
      if (thickness) add('includes-thickness');
      break;
    }
    case 'white-space':
      if (
        parts.length > 1 ||
        idents.some((word) => !LEGACY_WHITE_SPACE.has(word))
      ) {
        add('shorthand-values');
      }
      break;
    case 'font':
      if (idents.some((word) => FONT_WIDTHS.has(word))) {
        add('font-width-keyword-values');
      }
      break;
    case 'transition-property':
    case 'transition':
      if (property === 'transition-property' && idents.length > 0) {
        add('ident-value');
      }
      // A transitioned property is animated.
      for (const word of idents) add('animated', word);
      break;
    default:
      break;
  }
  if (ALIGNMENT_PROPERTIES.has(property)) {
    for (let k = 0; k + 1 < parts.length; k += 1) {
      const word = single(tokens, parts[k]);
      if (
        (isIdent(word, 'first') || isIdent(word, 'last')) &&
        isIdent(single(tokens, parts[k + 1]), 'baseline')
      ) {
        add(`${lower(word)}-baseline`);
      }
    }
  }
  if (CORNER_RADII.has(property) && parts.length === 2)
    add('elliptical-corners');
}

/** Pseudo-elements a rule's selector names (`::before`). */
function pseudoElementsOf(selector) {
  if (selector == null || !selector.includes('::')) return [];
  return [...selector.toLowerCase().matchAll(/::([a-z-]+)/g)].map((m) => m[1]);
}

/**
 * Forms of a declaration in a pseudo-element's rule: properties BCD records
 * per pseudo-element (`::selection { text-decoration }`), animations of
 * generated content, and `::backdrop` values that rely on inheriting from the
 * originating element.
 */
function pseudoElementForms(
  elements,
  property,
  tokens,
  start,
  end,
  out,
  context,
) {
  for (const element of elements) {
    const add = (suffix) =>
      out.add(
        { kind: 'form', of: 'selector', name: element, element: true, suffix },
        context,
      );
    const scoped = PSEUDO_ELEMENT_PROPERTIES[element]?.[property];
    if (scoped != null) add(scoped);
    if (
      ANIMATED_PSEUDO_ELEMENTS.has(element) &&
      (property.startsWith('transition') || property.startsWith('animation'))
    ) {
      add('animation-and-transition-support');
    }
    if (
      element === 'backdrop' &&
      tokens
        .slice(start, end)
        .some(
          (token) =>
            (type(token) === 'function-token' && lower(token) === 'var') ||
            isIdent(token, 'inherit'),
        )
    ) {
      add('inherit-from-originating-element');
    }
  }
}

/** Forms of an `@font-face` `src` value: format and technology hints. */
function fontSourceForms(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    if (type(tokens[i]) !== 'function-token') continue;
    const name = lower(tokens[i]);
    if (name !== 'format' && name !== 'tech') continue;
    const close = matching(tokens, i);
    for (const part of components(tokens, i + 1, close)) {
      const token = single(tokens, part);
      if (token == null) continue;
      const keyword = type(token) === 'ident-token';
      const hint = String(value(token) ?? '').toLowerCase();
      if (type(token) !== 'ident-token' && type(token) !== 'string-token')
        continue;
      if (keyword) {
        out.add(
          {
            kind: 'form',
            of: 'descriptor',
            atRule: 'font-face',
            name: 'src',
            suffix: `${name}-keyword`,
          },
          context,
        );
      }
      if (name === 'format' && hint.endsWith('-variations')) {
        out.add(
          {
            kind: 'form',
            of: 'descriptor',
            atRule: 'font-face',
            name: 'src',
            suffix: 'format-variations',
          },
          context,
        );
      }
      const format =
        name === 'format'
          ? FONT_FORMATS[hint.replace(/-variations$/, '')]
          : FONT_TECHNOLOGIES[hint];
      if (format != null) {
        out.add(
          { kind: 'form', of: 'at-rule', name: 'font-face', suffix: format },
          context,
        );
      }
    }
    i = close;
  }
}

// ---------------------------------------------------------------- values ----

// Properties whose comma-separated value is a fallback chain: an engine that
// does not know an entry uses the next one.
const FALLBACK_LIST_PROPERTIES = new Set(['font-family']);

function analyseValue(tokens, start, end, property, out, context) {
  const topIdents = [];
  // In a fallback chain, every entry but the last is backed up by a later one.
  const lastEntryStart = FALLBACK_LIST_PROPERTIES.has(property)
    ? splitTop(tokens, start, end, 'comma-token').at(-1)[0]
    : start;
  let depth = 0;
  const functionStack = [];
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    const t = type(token);
    if (t === 'function-token') {
      const name = String(value(token)).toLowerCase();
      // Relative color syntax: the first argument of a color function is
      // the `from` keyword.
      let j = i + 1;
      while (j < end && isWs(tokens[j])) j += 1;
      const relative =
        j < end &&
        type(tokens[j]) === 'ident-token' &&
        String(value(tokens[j])).toLowerCase() === 'from';
      out.add({ kind: 'function', property, name, relative }, context);
      const outer =
        functionStack.length === 0
          ? null
          : functionStack[functionStack.length - 1];
      if (outer != null && name !== 'var') {
        // A function inside another one: a subfeature of the outer function
        // (`if(style())`, `attr(type())`), or of `calc()` (nested, in a color
        // component, in a gradient color stop).
        out.add(
          {
            kind: 'form',
            of: 'function',
            property,
            name: outer,
            suffix: `${name}()`,
          },
          context,
        );
        if (name === 'calc') {
          const where = MATH_FUNCTIONS.has(outer)
            ? 'nested'
            : Object.hasOwn(COLOR_CHANNELS, outer)
              ? 'color-component'
              : GRADIENTS.has(outer)
                ? 'gradient-color-stops'
                : null;
          if (where != null) {
            out.add(
              {
                kind: 'form',
                of: 'function',
                property,
                name: 'calc',
                suffix: where,
              },
              context,
            );
          }
        }
      }
      const close = FORM_FUNCTIONS.has(name) ? matching(tokens, i) : end;
      for (const suffix of functionForms(
        name,
        tokens,
        i + 1,
        Math.min(close, end),
      )) {
        out.add(
          { kind: 'form', of: 'function', property, name, suffix },
          context,
        );
      }
      if (name === 'path') {
        // BCD records `path()` per property (`clip-path`, `offset-path`, `d`).
        out.add(
          {
            kind: 'form',
            of: 'function',
            property,
            name,
            suffix: `in-${property}`,
          },
          context,
        );
      }
      functionStack.push(name);
      depth += 1;
      continue;
    }
    if (t === '(-token' || t === '[-token') {
      depth += 1;
      functionStack.push(null);
      continue;
    }
    if (t === ')-token' || t === ']-token') {
      depth -= 1;
      functionStack.pop();
      continue;
    }
    if (t === 'ident-token') {
      const ident = String(value(token)).toLowerCase();
      if (depth === 0) topIdents.push(ident);
      const enclosing =
        functionStack.length === 0
          ? null
          : functionStack[functionStack.length - 1];
      if (enclosing != null && enclosing !== 'var') {
        // A keyword argument of a function (`perspective(none)`,
        // `env(safe-area-inset-top)`, `linear-gradient(to …)`).
        out.add(
          {
            kind: 'form',
            of: 'function',
            property,
            name: enclosing,
            suffix: ident.startsWith('--') ? 'dashed-ident' : ident,
          },
          context,
        );
      }
      if (GLOBAL_KEYWORDS.has(ident) && depth === 0) {
        out.add({ kind: 'global-keyword', keyword: ident }, context);
      } else if (ident !== 'from') {
        out.add(
          i < lastEntryStart
            ? {
                kind: 'value-keyword',
                property,
                keyword: ident,
                listFallback: true,
              }
            : { kind: 'value-keyword', property, keyword: ident },
          context,
        );
      }
      continue;
    }
    if (t === 'dimension-token') {
      out.add(
        { kind: 'unit', unit: String(token[4].unit).toLowerCase() },
        context,
      );
      continue;
    }
    if (t === 'hash-token' && depth === 0) {
      const hex = String(value(token));
      if (/^[0-9a-f]+$/i.test(hex) && (hex.length === 4 || hex.length === 8)) {
        out.add({ kind: 'alpha-hex-color' }, context);
      }
      continue;
    }
    if (
      t === 'url-token' ||
      t === 'string-token' ||
      t === 'number-token' ||
      t === 'percentage-token' ||
      t === 'comma-token' ||
      t === 'delim-token' ||
      t === 'hash-token' ||
      isWs(token)
    ) {
      continue;
    }
    out.add({ kind: 'unclassified', where: 'value', token: t }, context);
  }
  if (
    property === 'display' &&
    topIdents.filter((ident) => !GLOBAL_KEYWORDS.has(ident)).length >= 2
  ) {
    out.add({ kind: 'value-multi-keyword', property }, context);
  }
  if (property === '@font-face/src') {
    fontSourceForms(tokens, start, end, out, context);
  } else if (!property.startsWith('@') && !property.startsWith('--')) {
    valueForms(property, tokens, start, end, out, context);
  }
}

function analyseDeclarations(tokens, start, end, out, context, descriptorOf) {
  // Per block: the pseudo-elements its rule styles and its keyframes rule.
  const elements = pseudoElementsOf(context.selector);
  const keyframes = (context.atRules ?? []).find(
    (a) => a.name === 'keyframes' || a.name.endsWith('-keyframes'),
  );
  for (const range of splitTop(tokens, start, end, 'semicolon-token')) {
    const [s, e] = trimRange(tokens, range);
    if (s >= e) continue;
    if (descriptorOf === 'page' && type(tokens[s]) === 'at-keyword-token') {
      // A page-margin box (`@top-left { … }`) holds ordinary declarations.
      out.add(
        {
          kind: 'form',
          of: 'at-rule',
          name: 'page',
          suffix: `at-${lower(tokens[s])}`,
        },
        context,
      );
      let open = s + 1;
      while (open < e && type(tokens[open]) !== '{-token') open += 1;
      if (open < e) {
        analyseDeclarations(
          tokens,
          open + 1,
          matching(tokens, open),
          out,
          context,
          null,
        );
      }
      continue;
    }
    if (type(tokens[s]) !== 'ident-token') {
      out.add({ kind: 'unclassified', where: 'declaration' }, context);
      continue;
    }
    let colon = s + 1;
    while (colon < e && isWs(tokens[colon])) colon += 1;
    if (colon >= e || type(tokens[colon]) !== 'colon-token') {
      out.add({ kind: 'unclassified', where: 'declaration' }, context);
      continue;
    }
    const rawName = String(value(tokens[s]));
    const name = rawName.startsWith('--') ? rawName : rawName.toLowerCase();
    let valueEnd = e;
    let important = false;
    // `! important` at the end of the value.
    let k = e - 1;
    while (k > colon && isWs(tokens[k])) k -= 1;
    if (
      k > colon &&
      type(tokens[k]) === 'ident-token' &&
      String(value(tokens[k])).toLowerCase() === 'important'
    ) {
      let bang = k - 1;
      while (bang > colon && isWs(tokens[bang])) bang -= 1;
      if (type(tokens[bang]) === 'delim-token' && value(tokens[bang]) === '!') {
        important = true;
        valueEnd = bang;
      }
    }
    const declarationContext = {
      ...context,
      property: name,
      value: text(tokens, colon + 1, valueEnd),
      important,
    };
    if (descriptorOf != null) {
      out.add(
        { kind: 'descriptor', atRule: descriptorOf, name },
        declarationContext,
      );
      // A keyword value of a descriptor (`size: landscape`).
      for (const part of components(tokens, colon + 1, valueEnd)) {
        const token = single(tokens, part);
        if (token != null && type(token) === 'ident-token') {
          out.add(
            {
              kind: 'form',
              of: 'descriptor',
              atRule: descriptorOf,
              name,
              suffix: lower(token),
            },
            declarationContext,
          );
        }
      }
      // Descriptor values still use functions and units (`src: url() format()`
      // is covered by the at-rule; `initial-value` can hold any value).
      analyseValue(
        tokens,
        colon + 1,
        valueEnd,
        `@${descriptorOf}/${name}`,
        out,
        declarationContext,
      );
      continue;
    }
    out.add({ kind: 'property', name }, declarationContext);
    if (elements.length > 0) {
      pseudoElementForms(
        elements,
        name,
        tokens,
        colon + 1,
        valueEnd,
        out,
        declarationContext,
      );
    }
    if (keyframes != null) {
      // A property set in keyframes is animated; `!important` there is
      // ignored by the engines that implement the rule.
      out.add(
        { kind: 'form', of: 'property', name, suffix: 'animated' },
        declarationContext,
      );
      if (important) {
        out.add(
          {
            kind: 'form',
            of: 'at-rule',
            name: keyframes.name,
            suffix: 'ignore-important-declarations',
          },
          declarationContext,
        );
      }
    }
    // Engines that implement `::marker` partially apply only some properties
    // inside it, so each declared property is its own combination.
    if (/::marker\b/i.test(context.selector ?? '')) {
      out.add({ kind: 'marker-property', property: name }, declarationContext);
    }
    analyseValue(tokens, colon + 1, valueEnd, name, out, declarationContext);
    if (important && (context.atRules ?? []).some((a) => a.name === 'layer')) {
      out.add(
        { kind: 'combination', key: 'at-rule:layer/block+important' },
        declarationContext,
      );
    }
  }
}

// ------------------------------------------------------------- selectors ----

// Functional pseudo-classes and pseudo-elements taking a selector list.
const SELECTOR_LIST_PSEUDOS = new Set([
  'has',
  'is',
  'where',
  'not',
  'host',
  'host-context',
  'slotted',
  'part',
  'nth-child',
  'nth-last-child',
]);

function analyseSelector(tokens, start, end, out, context, enclosing = []) {
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (t === '[-token') {
      out.add({ kind: 'attribute-selector' }, context);
      const close = matching(tokens, i);
      // `[a=b i]` / `[a=b s]`: a case modifier after the value.
      const parts = components(tokens, i + 1, close);
      const last = parts.length >= 3 ? single(tokens, parts.at(-1)) : null;
      const hasValue = parts.some((part) => isDelim(single(tokens, part), '='));
      if (hasValue && (isIdent(last, 'i') || isIdent(last, 's'))) {
        out.add(
          {
            kind: 'form',
            of: 'attribute-selector',
            suffix: isIdent(last, 'i')
              ? 'case-insensitive-modifier'
              : 'case-sensitive-modifier',
          },
          context,
        );
      }
      i = close;
      continue;
    }
    if (t !== 'colon-token') continue;
    const element = type(tokens[i + 1]) === 'colon-token';
    const at = element ? i + 2 : i + 1;
    const token = tokens[at];
    if (token == null) break;
    if (type(token) === 'ident-token' || type(token) === 'function-token') {
      const name = String(value(token)).toLowerCase();
      out.add({ kind: 'selector', name, element }, context);
      const form = (suffix) =>
        out.add(
          { kind: 'form', of: 'selector', name, element, suffix },
          context,
        );
      // A pseudo-element of a pseudo-element (`::before::marker`).
      if (
        element &&
        type(token) === 'ident-token' &&
        type(tokens[at + 1]) === 'colon-token' &&
        type(tokens[at + 2]) === 'colon-token' &&
        type(tokens[at + 3]) === 'ident-token'
      ) {
        form(`nested-${lower(tokens[at + 3])}`);
      }
      if (type(token) === 'function-token') {
        const close = matching(tokens, at);
        if (name === 'not') {
          if (hasTopLevel(tokens, at + 1, close, 'comma-token')) {
            form('selector-list');
          }
        } else if (name === 'nth-child' || name === 'nth-last-child') {
          if (
            components(tokens, at + 1, close).some((part) =>
              isIdent(single(tokens, part), 'of'),
            )
          ) {
            form('of-syntax');
          }
        } else if (!SELECTOR_LIST_PSEUDOS.has(name)) {
          const args = components(tokens, at + 1, close);
          if (name === 'lang') {
            if (hasTopLevel(tokens, at + 1, close, 'comma-token')) {
              form('argument-list');
            }
            if (
              tokens
                .slice(at + 1, close)
                .some(
                  (x) =>
                    isDelim(x, '*') ||
                    (type(x) === 'string-token' &&
                      String(value(x)).includes('*')),
                )
            ) {
              form('wildcards');
            }
          }
          if (name === 'cue' && element && args.length > 0) {
            form('selector-argument');
          }
          // Keyword arguments (`::scroll-button(up)`).
          for (const part of args) {
            const arg = single(tokens, part);
            if (arg != null && type(arg) === 'ident-token') form(lower(arg));
            else if (isDelim(arg, '*')) form('*');
          }
        }
      }
      if (enclosing.includes('has') && name === 'has') {
        out.add(
          { kind: 'combination', key: 'selector:has+selector:has' },
          context,
        );
      }
      if (enclosing.includes('has') && element) {
        out.add(
          { kind: 'combination', key: 'selector:has+pseudo-element' },
          context,
        );
      }
      if (type(token) === 'function-token') {
        const close = matching(tokens, at);
        // Functional pseudo-classes taking a selector list.
        if (SELECTOR_LIST_PSEUDOS.has(name)) {
          analyseSelector(tokens, at + 1, close, out, context, [
            ...enclosing,
            name,
          ]);
        }
        i = close;
      } else {
        i = at;
      }
      continue;
    }
    out.add({ kind: 'unclassified', where: 'selector' }, context);
  }
}

// -------------------------------------------------------------- at-rules ----

function analyseMediaQuery(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (
      t === 'ident-token' &&
      String(value(tokens[i])).toLowerCase() === 'or'
    ) {
      out.add({ kind: 'media-syntax', name: 'or_syntax' }, context);
    }
    if (t === 'function-token') {
      out.add({ kind: 'unclassified', where: 'media-query' }, context);
      i = matching(tokens, i);
      continue;
    }
    if (t !== '(-token') continue;
    const close = matching(tokens, i);
    const inner = trimRange(tokens, [i + 1, close]);
    const nestedParen = tokens
      .slice(inner[0], inner[1])
      .some((token) => type(token) === '(-token');
    if (nestedParen) {
      analyseMediaQuery(tokens, inner[0], inner[1], out, context);
      i = close;
      continue;
    }
    let range = false;
    let feature = null;
    out.add({ kind: 'media-syntax', name: 'media_features' }, context);
    for (let j = inner[0]; j < inner[1]; j += 1) {
      const token = tokens[j];
      if (type(token) === 'function-token') {
        // A computed value (`calc()`) in a media feature.
        out.add({ kind: 'media-syntax', name: 'media_query_values' }, context);
        j = matching(tokens, j);
        continue;
      }
      if (
        type(token) === 'delim-token' &&
        ['<', '>', '='].includes(value(token))
      ) {
        range = true;
      } else if (type(token) === 'ident-token') {
        const name = String(value(token)).toLowerCase();
        const previous = tokens[j - 1];
        const isValue =
          j > inner[0] &&
          !(type(previous) === 'delim-token' || isWs(previous)) &&
          type(previous) === 'colon-token';
        const afterColon = tokens
          .slice(inner[0], j)
          .some((x) => type(x) === 'colon-token');
        if (!isValue && !afterColon) {
          out.add({ kind: 'media-feature', name }, context);
          feature ??= name;
        } else if (feature != null) {
          // A keyword value of the feature (`display-mode: standalone`).
          const base = feature.replace(/^(min|max)-/, '');
          out.add(
            { kind: 'form', of: 'media', name: base, suffix: name },
            context,
          );
        }
      } else if (type(token) === 'dimension-token') {
        out.add(
          { kind: 'unit', unit: String(token[4].unit).toLowerCase() },
          context,
        );
      }
    }
    if (range) out.add({ kind: 'media-syntax', name: 'range_syntax' }, context);
    i = close;
  }
}

function analyseContainerQuery(tokens, start, end, out, context) {
  const prelude = components(tokens, start, end);
  if (
    prelude.length === 1 &&
    type(tokens[prelude[0][0]]) === 'ident-token' &&
    !isIdent(tokens[prelude[0][0]], 'not')
  ) {
    // A name-only query: the `<container-query>` is optional.
    out.add(
      {
        kind: 'form',
        of: 'at-rule',
        name: 'container',
        suffix: 'container-query-optional',
      },
      context,
    );
  }
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (t === 'function-token') {
      const name = String(value(tokens[i])).toLowerCase();
      out.add({ kind: 'container-query', name }, context);
      const close = matching(tokens, i);
      for (let j = i + 1; j < close; j += 1) {
        const token = tokens[j];
        if (['<', '>', '='].some((char) => isDelim(token, char))) {
          out.add(
            { kind: 'form', of: 'container', name, suffix: 'range-syntax' },
            context,
          );
        }
        if (type(token) !== 'ident-token') continue;
        let k = j + 1;
        while (k < close && isWs(tokens[k])) k += 1;
        // A queried feature (`scroll-state(stuck: top)`).
        if (type(tokens[k]) === 'colon-token' || k >= close) {
          out.add(
            { kind: 'form', of: 'container', name, suffix: lower(token) },
            context,
          );
        }
      }
      i = close;
      continue;
    }
    if (t === 'dimension-token') {
      out.add(
        { kind: 'unit', unit: String(tokens[i][4].unit).toLowerCase() },
        context,
      );
    }
  }
}

function analyseSupports(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    if (type(tokens[i]) !== 'function-token') continue;
    const name = String(value(tokens[i])).toLowerCase();
    out.add({ kind: 'supports-function', name }, context);
    const close = matching(tokens, i);
    for (const part of components(tokens, i + 1, close)) {
      const arg = single(tokens, part);
      // `named-feature(x)`: the named feature is its own subfeature.
      if (arg != null && type(arg) === 'ident-token') {
        out.add(
          { kind: 'form', of: 'supports', name, suffix: lower(arg) },
          context,
        );
      }
    }
    i = close;
  }
}

function analyseRules(tokens, start, end, out, context) {
  let i = start;
  while (i < end) {
    while (
      i < end &&
      (isWs(tokens[i]) || type(tokens[i]) === 'semicolon-token')
    ) {
      i += 1;
    }
    if (i >= end) break;
    // Prelude up to `{` or `;` at depth 0.
    let j = i;
    let depth = 0;
    while (j < end) {
      const t = type(tokens[j]);
      if (depth === 0 && (t === '{-token' || t === 'semicolon-token')) break;
      if (t === '(-token' || t === '[-token' || t === 'function-token') {
        depth += 1;
      } else if (t === ')-token' || t === ']-token') depth -= 1;
      j += 1;
    }
    const isAt = type(tokens[i]) === 'at-keyword-token';
    if (j >= end || type(tokens[j]) === 'semicolon-token') {
      if (isAt) {
        const name = String(value(tokens[i])).toLowerCase();
        out.add({ kind: 'at-rule', name, form: 'statement' }, context);
        if (name === 'import') {
          // `layer`/`layer()` and `supports()` import conditions.
          for (const part of components(tokens, i + 1, Math.min(j, end))) {
            const word =
              functionName(tokens, part) ??
              (type(tokens[part[0]]) === 'ident-token'
                ? lower(tokens[part[0]])
                : null);
            if (word === 'layer' || word === 'supports') {
              out.add(
                { kind: 'form', of: 'at-rule', name, suffix: word },
                context,
              );
            }
          }
        }
      } else {
        out.add({ kind: 'unclassified', where: 'rule' }, context);
      }
      i = j + 1;
      continue;
    }
    const close = matching(tokens, j);
    if (isAt) {
      const name = String(value(tokens[i])).toLowerCase();
      const prelude = text(tokens, i + 1, j);
      const atContext = {
        ...context,
        atRules: [...(context.atRules ?? []), { name, prelude }],
      };
      out.add({ kind: 'at-rule', name, form: 'block' }, atContext);
      if (name === 'media') analyseMediaQuery(tokens, i + 1, j, out, atContext);
      else if (name === 'container') {
        analyseContainerQuery(tokens, i + 1, j, out, atContext);
      } else if (name === 'supports') {
        analyseSupports(tokens, i + 1, j, out, atContext);
      } else if (name === 'scope') {
        analyseSelector(tokens, i + 1, j, out, atContext);
      }
      if (RULE_BLOCK_AT_RULES.has(name)) {
        analyseRules(tokens, j + 1, close, out, atContext);
      } else if (name === 'keyframes' || name.endsWith('-keyframes')) {
        // Keyframe selectors are percentages or `from`/`to`; the
        // declarations inside are ordinary property declarations.
        let k = j + 1;
        while (k < close) {
          const selectorStart = k;
          while (k < close && type(tokens[k]) !== '{-token') k += 1;
          if (k >= close) break;
          // A timeline range name (`entry 0%`) instead of `from`/`to`.
          if (
            tokens
              .slice(selectorStart, k)
              .some(
                (token) =>
                  type(token) === 'ident-token' &&
                  !['from', 'to'].includes(lower(token)),
              )
          ) {
            out.add(
              {
                kind: 'form',
                of: 'at-rule',
                name,
                suffix: 'named-range-keyframes',
              },
              atContext,
            );
          }
          const frameClose = matching(tokens, k);
          analyseDeclarations(tokens, k + 1, frameClose, out, atContext, null);
          k = frameClose + 1;
        }
      } else if (DECLARATION_BLOCK_AT_RULES.has(name)) {
        const descriptorOf = name === 'position-try' ? null : name;
        analyseDeclarations(tokens, j + 1, close, out, atContext, descriptorOf);
      } else {
        out.add({ kind: 'unclassified', where: 'at-rule-block' }, atContext);
      }
    } else {
      const selector = text(tokens, i, j);
      const ruleContext = { ...context, selector };
      analyseSelector(tokens, i, j, out, ruleContext);
      analyseDeclarations(tokens, j + 1, close, out, ruleContext, null);
    }
    i = close + 1;
  }
}

/**
 * Constructs of one emitted CSS text (one engine rule, or a whole sheet).
 * Each item is `{ construct, context }`; duplicates within the text collapse
 * unless `dedupe` is false (attribution tooling wants every occurrence).
 */
export function extractConstructs(cssText, { dedupe = true } = {}) {
  const out = new Collector(dedupe);
  const css = String(cssText);
  source = css;
  // The emitted subset tokenizes on the fast path; anything else, exactly.
  const tokens = (tokenizeEmitted(css) ?? tokenize({ css })).filter(
    (token) => type(token) !== 'EOF-token',
  );
  analyseRules(tokens, 0, tokens.length, out, { atRules: [] });
  return out.items;
}
