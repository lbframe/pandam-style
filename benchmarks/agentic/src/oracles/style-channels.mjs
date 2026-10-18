/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Legacy presentational HTML: elements and attributes that style content
// outside PandamStyle. They are a forbidden style channel, like `style`
// attributes and style sheets, in source (static rules), in the committed
// DOM (evaluator) and anywhere in the document (sandbox).
//
// Inside SVG, attributes are SVG's own; SVG content is not measured.
// Custom elements (names with a hyphen) define their own attributes; their
// attributes are not compared (`unmeasured`), never presentational.

export const PRESENTATIONAL_ELEMENTS = [
  'basefont',
  'big',
  'blink',
  'center',
  'font',
  'marquee',
  'nobr',
  'spacer',
  'strike',
  'tt',
];

export const PRESENTATIONAL_ATTRIBUTES = [
  'align',
  'alink',
  'background',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'clear',
  'color',
  'face',
  'frame',
  'hspace',
  'link',
  'marginheight',
  'marginwidth',
  'noshade',
  'nowrap',
  'rules',
  'text',
  'valign',
  'vlink',
  'vspace',
];

// `width`/`height` size only replaced elements legitimately; elsewhere
// (tables, cells, rules, divs) they are presentational. `size` styles <hr>.
export const DIMENSIONED_ELEMENTS = [
  'canvas',
  'embed',
  'iframe',
  'img',
  'input',
  'object',
  'source',
  'svg',
  'video',
];

// Element names that are provably HTML wherever they appear in source. Names
// SVG shares (`a`, `script`, `style`, `title`) and every SVG name (`path`,
// `g`, `text`, ...) are not in it: a JSX element rendered by a child component
// may land inside an <svg>, so static rules check attributes only on these;
// the committed-DOM checks know the namespace.
export const HTML_ELEMENTS = new Set(
  (
    'abbr address area article aside audio b bdi bdo blockquote body br ' +
    'button canvas caption cite code col colgroup data datalist dd del ' +
    'details dfn dialog div dl dt em embed fieldset figcaption figure footer ' +
    'form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins ' +
    'kbd label legend li main map mark menu meter nav noscript object ol ' +
    'optgroup option output p picture pre progress q rp rt ruby s samp ' +
    'search section select slot small source span strong sub summary sup ' +
    'table tbody td template textarea tfoot th thead time tr track u ul var ' +
    'video wbr basefont big blink center font marquee nobr spacer strike tt'
  ).split(' '),
);

/** The presentational channel an HTML element or attribute is, or null. */
export function presentationalChannel(tag, attribute = null) {
  const t = tag.toLowerCase();
  if (t.includes('-')) return null;
  if (attribute == null)
    return PRESENTATIONAL_ELEMENTS.includes(t)
      ? `presentational <${t}> element`
      : null;
  const a = attribute.toLowerCase();
  if (
    PRESENTATIONAL_ATTRIBUTES.includes(a) ||
    (a === 'size' && t === 'hr') ||
    ((a === 'width' || a === 'height') && !DIMENSIONED_ELEMENTS.includes(t))
  )
    return `presentational ${a} attribute on <${t}>`;
  return null;
}

export const STYLE_CHANNELS = {
  elements: PRESENTATIONAL_ELEMENTS,
  attributes: PRESENTATIONAL_ATTRIBUTES,
  dimensioned: DIMENSIONED_ELEMENTS,
};
