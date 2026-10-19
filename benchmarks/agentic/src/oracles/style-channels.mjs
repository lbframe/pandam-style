/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Legacy presentational HTML: elements and attributes that style content
// outside PandamStyle. They are a forbidden style channel, like `style`
// attributes and style sheets (`<style>`, style sheet `<link>`s), in source
// (static rules), in the committed DOM (evaluator) and anywhere in the
// document (sandbox).
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

// A <link> is a style channel when it can bring a style sheet into the
// document: a `rel` with the `stylesheet` token (`alternate stylesheet`
// included) or the obsolete `import` token (an HTML import carries its own
// style sheets), or a fetch typed as a style sheet (`as="style"`: preloads,
// prefetches and the onload swap to `rel="stylesheet"`). Other links
// (canonical, icon, manifest, alternate, preconnect, image, font and script
// preloads, modulepreload) name or fetch a resource that applies no style.
export const STYLE_LINK = { rel: ['stylesheet', 'import'], as: ['style'] };

/**
 * The style channel a <link> is, or null. `get(name)` returns the value of
 * the lowercase attribute `name`, or null when it is absent. Tokens and the
 * destination are ASCII case-insensitive.
 */
export function styleSheetLink(get) {
  const rel = ('' + (get('rel') ?? '')).toLowerCase().split(/[\t\n\f\r ]+/);
  if (rel.some((token) => STYLE_LINK.rel.includes(token)))
    return 'style sheet <link> (rel)';
  if (STYLE_LINK.as.includes(('' + (get('as') ?? '')).trim().toLowerCase()))
    return 'style sheet <link> (as="style")';
  return null;
}

export const STYLE_CHANNELS = {
  elements: PRESENTATIONAL_ELEMENTS,
  attributes: PRESENTATIONAL_ATTRIBUTES,
  dimensioned: DIMENSIONED_ELEMENTS,
  links: STYLE_LINK,
};
