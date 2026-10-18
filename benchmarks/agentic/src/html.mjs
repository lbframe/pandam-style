/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Small parser for server-rendered React markup. React's static markup is
// well formed: every non-void element is closed, attribute values are quoted
// and text is entity-escaped. Anything else is reported as a parse error
// instead of being guessed.

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const lower = e.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    if (lower.startsWith('#x'))
      return String.fromCodePoint(parseInt(e.slice(2), 16));
    return String.fromCodePoint(parseInt(e.slice(1), 10));
  });
}

export function parseHtml(html) {
  const root = { tag: '#root', attributes: {}, children: [], parent: null };
  let current = root;
  let i = 0;
  while (i < html.length) {
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      if (end === -1)
        throw new Error('Unterminated comment in rendered markup');
      i = end + 3;
    } else if (html.startsWith('</', i)) {
      const end = html.indexOf('>', i);
      const tag = html
        .slice(i + 2, end)
        .trim()
        .toLowerCase();
      if (current.tag !== tag) {
        throw new Error(
          `Mismatched closing tag </${tag}> for <${current.tag}>`,
        );
      }
      current = current.parent;
      i = end + 1;
    } else if (html[i] === '<') {
      const match = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i));
      if (match == null) throw new Error(`Unexpected '<' at ${i}`);
      const tag = match[1].toLowerCase();
      i += match[0].length;
      const attributes = {};
      const attrRe = /^\s+([^\s=/>]+)(?:="([^"]*)")?/;
      let m;
      while ((m = attrRe.exec(html.slice(i))) != null) {
        attributes[m[1]] = m[2] == null ? '' : decode(m[2]);
        i += m[0].length;
      }
      const rest = /^\s*(\/?)>/.exec(html.slice(i));
      if (rest == null) throw new Error(`Malformed start tag <${tag}> at ${i}`);
      i += rest[0].length;
      const element = { tag, attributes, children: [], parent: current };
      current.children.push(element);
      if (!VOID.has(tag) && rest[1] !== '/') current = element;
    } else {
      const end = html.indexOf('<', i);
      const text = html.slice(i, end === -1 ? html.length : end);
      current.children.push({
        tag: '#text',
        text: decode(text),
        parent: current,
      });
      i = end === -1 ? html.length : end;
    }
  }
  if (current !== root) throw new Error(`Unclosed element <${current.tag}>`);
  return root;
}

export function elements(node) {
  const out = [];
  for (const child of node.children ?? []) {
    if (child.tag === '#text') continue;
    out.push(child, ...elements(child));
  }
  return out;
}

export function textContent(node) {
  if (node.tag === '#text') return node.text;
  return (node.children ?? []).map(textContent).join('');
}

export function classList(node) {
  return (node.attributes?.class ?? '').split(/\s+/).filter(Boolean);
}

/**
 * Selector forms: `{ testId }`, `{ tag }` and `{ testIdPrefix }`, optionally
 * combined, plus `within` (another selector resolved first).
 */
export function select(root, selector) {
  let scope = root;
  if (selector.within != null) {
    const outer = select(root, selector.within);
    if (outer.length !== 1) return [];
    scope = outer[0];
  }
  return elements(scope).filter((el) => {
    if (
      selector.testId != null &&
      el.attributes['data-testid'] !== selector.testId
    ) {
      return false;
    }
    if (
      selector.testIdPrefix != null &&
      !(el.attributes['data-testid'] ?? '').startsWith(selector.testIdPrefix)
    ) {
      return false;
    }
    if (selector.tag != null && el.tag !== selector.tag) return false;
    return true;
  });
}
