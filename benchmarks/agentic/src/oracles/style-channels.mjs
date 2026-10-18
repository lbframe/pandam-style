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

/** The presentational channel an HTML element or attribute is, or null. */
export function presentationalChannel(tag, attribute = null) {
  const t = tag.toLowerCase();
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
