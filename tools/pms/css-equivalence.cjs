/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// CE-01.2 (AC3): declaration equivalence of a host's delivered CSS with the
// canonical `styles.css`.
//
// Two stylesheets are declaration-equivalent when they have the same rules in
// the same order and, per rule:
//   - the same block structure and at-rule conditions (blocks are never
//     merged or flattened);
//   - the same selector set (the order inside one selector list may differ);
//   - the same declarations, in the same order, with the same values,
//     including every vendor-prefixed pair.
//
// The comparison is over CSS Syntax Level 3 tokens (`@csstools/css-tokenizer`,
// a compiler runtime dependency), never over re-spelled text:
//   - a token is compared by its full identity (`keyOf`): type, every flag
//     the tokenizer records and decoded value, so escapes and quote style do
//     not matter (`.\61` is `.a`) but `#\31` is not `#1`; identifiers stay
//     case-sensitive, only property and at-rule names are ASCII-lowercased;
//   - whitespace is a significant token everywhere, and is dropped only at
//     the grammar positions listed in `insignificant`; a comment separates
//     tokens and is otherwise ignored, so it can never merge two tokens, in
//     custom properties too;
//   - a custom property value keeps every token and its exact whitespace,
//     after the leading and trailing trim the specification performs;
//   - micro-syntaxes minifiers rewrite are parsed as their specifications
//     define them (`canonicalize`, `familyKeys`): An+B, attribute selectors,
//     `url()`, one-colon CSS 2 pseudo-elements, `font-family` names and
//     keyframe selectors.

const { tokenize } = require('@csstools/css-tokenizer');

const WS = 'whitespace-token';
const COMBINATORS = new Set(['>', '+', '~']);

function isWs(token) {
  return token[0] === WS;
}

// Tokens without comments. A comment only separates tokens (CSS Syntax 3):
// `foo<comment>bar` stays two identifiers and `1<comment>px` a number and an
// identifier, so comparing token sequences never lets a comment merge its
// neighbours, and `.a<comment>.b` stays the compound `.a.b`, never `.a .b`.
function tokensOf(css) {
  return tokenize({ css }).filter(
    (token) => token[0] !== 'EOF-token' && token[0] !== 'comment',
  );
}

const OPEN = {
  '{-token': '}-token',
  '(-token': ')-token',
  '[-token': ']-token',
};
const isOpen = (token) =>
  Object.hasOwn(OPEN, token[0]) || token[0] === 'function-token';
const closeOf = (token) =>
  token[0] === 'function-token' ? ')-token' : OPEN[token[0]];

/** Index of the token closing the block opened at `start`. */
function matching(tokens, start) {
  const stack = [closeOf(tokens[start])];
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (isOpen(tokens[i])) stack.push(closeOf(tokens[i]));
    else if (tokens[i][0] === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error('unbalanced CSS block');
}

/** Top-level ranges of `[start, end)` split at tokens of `type`. */
function splitTop(tokens, start, end, type) {
  const parts = [];
  let from = start;
  for (let i = start; i < end; i += 1) {
    if (isOpen(tokens[i])) {
      i = matching(tokens, i);
      continue;
    }
    if (tokens[i][0] === type) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

/**
 * The comparison key of one token: its type, every flag the tokenizer records
 * and its decoded value (CSS Syntax 3 token types, all listed):
 *   ident, function, at-keyword, string, url, delim: decoded value;
 *   hash: decoded value and id/unrestricted type (`#\31` is not `#1`);
 *   number: value, integer/number type, sign;
 *   percentage: value, sign;
 *   dimension: value, integer/number type, sign, decoded unit;
 *   unicode-range: its range (only when ranges are tokenized);
 *   bad-string, bad-url: raw text (never equal to a valid token);
 *   whitespace: one key (exact text in custom properties);
 *   colon, comma, semicolon, CDO, CDC and the six brackets: the type.
 * Comments are dropped as token boundaries (`tokensOf`), EOF never reaches it.
 * Canonical micro-syntax tokens (`canonicalize`) key their parsed form.
 */
function keyOf(token) {
  const [type, raw, , , data] = token;
  switch (type) {
    case WS:
      return 'ws';
    case 'ident-token':
    case 'function-token':
    case 'at-keyword-token':
    case 'string-token':
    case 'delim-token':
      return JSON.stringify([type, data.value]);
    case 'url-token':
    case 'canonical-url':
      return JSON.stringify(['url', data.value]);
    case 'hash-token':
      return JSON.stringify([type, data.value, data.type]);
    case 'number-token':
      return JSON.stringify([
        type,
        data.value,
        data.type,
        data.signCharacter ?? '',
      ]);
    case 'percentage-token':
      return JSON.stringify([type, data.value, data.signCharacter ?? '']);
    case 'dimension-token':
      return JSON.stringify([
        type,
        data.value,
        data.type,
        data.signCharacter ?? '',
        data.unit,
      ]);
    case 'unicode-range-token':
      return JSON.stringify([type, data.startOfRange, data.endOfRange]);
    case 'canonical-nth':
    case 'canonical-attribute':
      return JSON.stringify([type, data]);
    case 'bad-string-token':
    case 'bad-url-token':
      return JSON.stringify([type, raw]);
    default:
      // Punctuation and block tokens: the type is the token.
      return type;
  }
}

// -------------------------------------------------- canonical micro-syntax --
//
// Equivalent spellings that minifiers produce are canonicalised by the
// specification's own parsing, never by text: An+B (CSS Syntax 3 §6.2), an
// attribute selector's value (Selectors 4 §6), and `url()` (CSS Values 4).
// A form that does not parse is left as tokens and compared strictly.

const NTH = new Set([
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
]);
const NTH_OF = new Set(['nth-child', 'nth-last-child']);
const lowerOf = (token) => String(token?.[4]?.value ?? '').toLowerCase();
const isInteger = (token) =>
  token?.[0] === 'number-token' && token[4].type === 'integer';
const signed = (token) => isInteger(token) && token[4].signCharacter != null;
const signless = (token) => isInteger(token) && token[4].signCharacter == null;

/** `[a, b]` of an An+B token list (whitespace included), or null. */
function anPlusB(list) {
  const t = list.filter((token) => !isWs(token));
  // `+n…`: the `+` must directly precede the identifier.
  let plus = false;
  if (t[0]?.[0] === 'delim-token' && t[0][4].value === '+') {
    if (isWs(list[list.indexOf(t[0]) + 1] ?? [])) return null;
    plus = true;
    t.shift();
  }
  const first = t[0];
  if (first == null) return null;
  const rest = t.slice(1);
  /** b from what follows an `An` with an implicit or explicit b. */
  const tail = (a, dashed) => {
    if (dashed) {
      // `n-` then a signless integer.
      return rest.length === 1 && signless(rest[0])
        ? [a, -rest[0][4].value]
        : null;
    }
    if (rest.length === 0) return [a, 0];
    if (rest.length === 1 && signed(rest[0])) return [a, rest[0][4].value];
    if (
      rest.length === 2 &&
      rest[0][0] === 'delim-token' &&
      (rest[0][4].value === '+' || rest[0][4].value === '-') &&
      signless(rest[1])
    ) {
      return [
        a,
        rest[0][4].value === '-' ? -rest[1][4].value : rest[1][4].value,
      ];
    }
    return null;
  };
  if (first[0] === 'ident-token' && !plus && rest.length === 0) {
    if (lowerOf(first) === 'odd') return [2, 1];
    if (lowerOf(first) === 'even') return [2, 0];
  }
  if (!plus && isInteger(first) && rest.length === 0)
    return [0, first[4].value];
  if (!plus && first[0] === 'dimension-token' && first[4].type === 'integer') {
    const unit = first[4].unit.toLowerCase();
    if (unit === 'n') return tail(first[4].value, false);
    if (unit === 'n-') return tail(first[4].value, true);
    const m = /^n-(\d+)$/.exec(unit);
    if (m != null && rest.length === 0) return [first[4].value, -Number(m[1])];
    return null;
  }
  if (first[0] === 'ident-token') {
    const name = lowerOf(first);
    let a = 1;
    let body = name;
    if (name.startsWith('-')) {
      if (plus) return null;
      a = -1;
      body = name.slice(1);
    }
    if (body === 'n') return tail(a, false);
    if (body === 'n-') return tail(a, true);
    const m = /^n-(\d+)$/.exec(body);
    if (m != null && rest.length === 0) return [a, -Number(m[1])];
  }
  return null;
}

/** The parsed attribute selector `[…]` contents, or null. */
function attributeOf(list) {
  // Whitespace is allowed between the parts, not inside the matcher.
  const t = [];
  for (let i = 0; i < list.length; i += 1) {
    if (!isWs(list[i])) t.push([list[i], isWs(list[i - 1] ?? [])]);
  }
  let k = 0;
  let namespace = null;
  const isDelim = (entry, value) =>
    entry?.[0][0] === 'delim-token' && entry[0][4].value === value;
  // No whitespace around the namespace `|` (Selectors 4 §6.6).
  const tight = (...entries) =>
    entries.every((entry) => entry != null && !entry[1]);
  if (isDelim(t[k], '*') && isDelim(t[k + 1], '|')) {
    if (!tight(t[k + 1], t[k + 2])) return null;
    namespace = '*';
    k += 2;
  } else if (isDelim(t[k], '|')) {
    if (!tight(t[k + 1])) return null;
    namespace = '';
    k += 1;
  } else if (
    t[k]?.[0][0] === 'ident-token' &&
    isDelim(t[k + 1], '|') &&
    !isDelim(t[k + 2], '=')
  ) {
    if (!tight(t[k + 1], t[k + 2])) return null;
    namespace = t[k][0][4].value;
    k += 2;
  }
  if (t[k]?.[0][0] !== 'ident-token') return null;
  const name = t[k][0][4].value;
  k += 1;
  if (k === t.length) return { namespace, name, matcher: null };
  let matcher = '=';
  if (
    t[k][0][0] === 'delim-token' &&
    ['~', '|', '^', '$', '*'].includes(t[k][0][4].value) &&
    isDelim(t[k + 1], '=') &&
    !t[k + 1][1]
  ) {
    matcher = `${t[k][0][4].value}=`;
    k += 2;
  } else if (isDelim(t[k], '=')) {
    k += 1;
  } else {
    return null;
  }
  const value = t[k]?.[0];
  if (value?.[0] !== 'string-token' && value?.[0] !== 'ident-token')
    return null;
  k += 1;
  let modifier = null;
  if (k < t.length) {
    const m = lowerOf(t[k][0]);
    if (t[k][0][0] !== 'ident-token' || (m !== 'i' && m !== 's') || !t[k][1]) {
      return null;
    }
    modifier = m;
    k += 1;
  }
  if (k !== t.length) return null;
  return { namespace, name, matcher, value: value[4].value, modifier };
}

const synthetic = (type, data) => [type, '', -1, -1, data];
const LEGACY_PSEUDO_ELEMENTS = new Set([
  'before',
  'after',
  'first-line',
  'first-letter',
]);

/**
 * `run` with each parsable micro-syntax replaced by one canonical token:
 * `url("x")` (any case of `url`) and the url token are one URL; in
 * selectors, an attribute selector and the An+B of the `:nth-*()` pseudo-
 * classes (with a structured `of S`).
 */
function canonicalize(run, context) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < run.length; i += 1) {
    const token = run[i];
    if (token[0] === 'function-token' || token[0] === '(-token') depth += 1;
    else if (token[0] === ')-token') depth -= 1;
    // Selectors 4 §3.6.3: the CSS 2 pseudo-elements keep their one-colon form,
    // at the top level of a selector only (neither form is valid inside
    // `:is()` or `:not()`).
    if (
      context === 'selector' &&
      depth === 0 &&
      token[0] === 'colon-token' &&
      run[i - 1]?.[0] !== 'colon-token' &&
      run[i + 1]?.[0] === 'ident-token' &&
      LEGACY_PSEUDO_ELEMENTS.has(lowerOf(run[i + 1]))
    ) {
      out.push(token, token);
      continue;
    }
    // CSS Animations 1 §3: a keyframe selector `from` is 0% and `to` is 100%.
    if (
      context === 'keyframe-selector' &&
      run.length === 1 &&
      token[0] === 'ident-token'
    ) {
      const name = lowerOf(token);
      if (name === 'from' || name === 'to') {
        out.push(
          synthetic('percentage-token', { value: name === 'from' ? 0 : 100 }),
        );
        continue;
      }
    }
    if (token[0] === 'function-token' && lowerOf(token) === 'url') {
      const close = matching(run, i);
      const inner = run.slice(i + 1, close).filter((t) => !isWs(t));
      if (inner.length === 1 && inner[0][0] === 'string-token') {
        out.push(synthetic('canonical-url', { value: inner[0][4].value }));
        i = close;
        depth -= 1;
        continue;
      }
    }
    if (context === 'selector' && token[0] === '[-token') {
      const close = matching(run, i);
      const attribute = attributeOf(run.slice(i + 1, close));
      if (attribute != null) {
        out.push(synthetic('canonical-attribute', attribute));
        i = close;
        continue;
      }
    }
    if (
      context === 'selector' &&
      token[0] === 'function-token' &&
      NTH.has(lowerOf(token))
    ) {
      const close = matching(run, i);
      const inner = run.slice(i + 1, close);
      let ofAt = -1;
      if (NTH_OF.has(lowerOf(token))) {
        ofAt = inner.findIndex(
          (t, k) => k > 0 && t[0] === 'ident-token' && lowerOf(t) === 'of',
        );
      }
      const ab = anPlusB(ofAt === -1 ? inner : inner.slice(0, ofAt));
      const of =
        ofAt === -1
          ? null
          : splitTop(inner, ofAt + 1, inner.length, 'comma-token').map(
              ([s, e]) => componentKeys(inner, s, e, 'selector'),
            );
      // `of S` needs a selector in every list entry.
      if (ab != null && (of == null || of.every((keys) => keys.length > 0))) {
        out.push(
          synthetic('canonical-nth', {
            name: lowerOf(token),
            a: ab[0],
            b: ab[1],
            of:
              of == null ? null : of.map((keys) => JSON.stringify(keys)).sort(),
          }),
        );
        i = close;
        depth -= 1;
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

/**
 * Whether the whitespace token at `i` of `tokens` (already collapsed and
 * trimmed) is insignificant. The allow-list, by grammar position:
 *   - next to a comma (selector lists, value lists, at-rule preludes);
 *   - next to a `>`, `+` or `~` combinator (`context: 'selector'` only);
 *   - right after `(` or a function name, or right before `)`;
 *   - next to the colon of a `(feature: value)` condition (`featureColon`);
 *   - in an at-rule prelude, after `)` and around a range operator
 *     (`width >= 1px`), never between `>`/`<` and `=`.
 * The edges of a value, selector or prelude are trimmed by `componentKeys`;
 * `{`, `}` and `;` delimit components and never reach this list.
 */
function insignificant(tokens, i, context, inFunction) {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  if (prev[0] === 'comma-token' || next[0] === 'comma-token') return true;
  if (
    context === 'selector' &&
    ((prev[0] === 'delim-token' && COMBINATORS.has(prev[4].value)) ||
      (next[0] === 'delim-token' && COMBINATORS.has(next[4].value)))
  ) {
    return true;
  }
  if (prev[0] === '(-token' || prev[0] === 'function-token') return true;
  if (next[0] === ')-token') return true;
  if (featureColon(tokens, i - 1) || featureColon(tokens, i + 1)) return true;
  if (context === 'prelude' && !inFunction[i]) {
    // Outside function arguments (inside `selector(…)`, whitespace after `)`
    // is a descendant combinator).
    // `(a)and (b)`: after `)` nothing can merge with what follows.
    if (prev[0] === ')-token') return true;
    // Around a range operator (`width >= 1px`), never inside `>=`.
    const op = (token, values) =>
      token[0] === 'delim-token' && values.includes(token[4].value);
    if (op(prev, ['<', '>', '=']) && !op(next, ['='])) return true;
    if (op(next, ['<', '>', '=']) && !op(prev, ['<', '>'])) return true;
  }
  return false;
}

/**
 * Whether `tokens[c]` is the colon of a `(feature: value)` condition: after an
 * identifier that directly follows `(` (whitespace aside). A pseudo-class
 * colon inside `:is(...)` never is: `:is(.a :hover)` is not `:is(.a:hover)`.
 */
function featureColon(tokens, c) {
  if (tokens[c]?.[0] !== 'colon-token') return false;
  let k = c - 1;
  while (k >= 0 && isWs(tokens[k])) k -= 1;
  if (tokens[k]?.[0] !== 'ident-token') return false;
  k -= 1;
  while (k >= 0 && isWs(tokens[k])) k -= 1;
  return tokens[k]?.[0] === '(-token';
}

/** The key sequence of `[start, end)` in a `selector`, `value` or `prelude`. */
function componentKeys(tokens, start, end, context) {
  // Collapse whitespace runs into one token, then trim.
  const run = [];
  for (let i = start; i < end; i += 1) {
    if (isWs(tokens[i]) && run.length > 0 && isWs(run[run.length - 1]))
      continue;
    run.push(tokens[i]);
  }
  while (run.length > 0 && isWs(run[0])) run.shift();
  while (run.length > 0 && isWs(run[run.length - 1])) run.pop();
  const canonical = canonicalize(run, context);
  // Whether each position is inside a function's arguments.
  const inFunction = [];
  const openers = [];
  for (const token of canonical) {
    if (token[0] === ')-token') openers.pop();
    inFunction.push(openers.includes('function-token'));
    if (token[0] === 'function-token' || token[0] === '(-token') {
      openers.push(token[0]);
    }
  }
  const keys = [];
  for (let i = 0; i < canonical.length; i += 1) {
    if (
      isWs(canonical[i]) &&
      insignificant(canonical, i, context, inFunction)
    ) {
      continue;
    }
    keys.push(keyOf(canonical[i]));
  }
  return keys;
}

/**
 * A custom property value as tokens with their full identity (comments stay
 * token boundaries), whitespace kept exactly, after the trim the
 * specification performs (CSS Variables 1 §2).
 */
function customKeys(tokens, start, end) {
  let s = start;
  let e = end;
  while (s < e && isWs(tokens[s])) s += 1;
  while (e > s && isWs(tokens[e - 1])) e -= 1;
  return tokens
    .slice(s, e)
    .map((token) =>
      isWs(token) ? JSON.stringify(['ws', token[1]]) : keyOf(token),
    );
}

/** The trimmed source text of `[start, end)` (custom property values). */
function verbatim(tokens, start, end) {
  let s = start;
  let e = end;
  while (s < e && isWs(tokens[s])) s += 1;
  while (e > s && isWs(tokens[e - 1])) e -= 1;
  return tokens
    .slice(s, e)
    .map((token) => token[1])
    .join('');
}

const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** `[name, value, important]` of the declaration `[start, end)`, or null. */
function declarationOf(tokens, start, end) {
  let s = start;
  while (s < end && isWs(tokens[s])) s += 1;
  if (s >= end) return null;
  if (tokens[s][0] !== 'ident-token') {
    throw new Error(`not a declaration: ${verbatim(tokens, start, end)}`);
  }
  let colon = s + 1;
  while (colon < end && isWs(tokens[colon])) colon += 1;
  if (colon >= end || tokens[colon][0] !== 'colon-token') {
    throw new Error(`not a declaration: ${verbatim(tokens, start, end)}`);
  }
  const rawName = tokens[s][4].value;
  const custom = rawName.startsWith('--');
  // `! important` at the end of the value.
  let valueEnd = end;
  let important = false;
  let k = end - 1;
  while (k > colon && isWs(tokens[k])) k -= 1;
  if (
    k > colon &&
    tokens[k][0] === 'ident-token' &&
    asciiLower(tokens[k][4].value) === 'important'
  ) {
    let bang = k - 1;
    while (bang > colon && isWs(tokens[bang])) bang -= 1;
    if (tokens[bang][0] === 'delim-token' && tokens[bang][4].value === '!') {
      important = true;
      valueEnd = bang;
    }
  }
  const name = custom ? rawName : asciiLower(rawName);
  return [
    name,
    custom
      ? customKeys(tokens, colon + 1, valueEnd)
      : name === 'font-family'
        ? familyKeys(tokens, colon + 1, valueEnd)
        : componentKeys(tokens, colon + 1, valueEnd, 'value'),
    important,
  ];
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'cursive',
  'fantasy',
  'monospace',
  'system-ui',
  'emoji',
  'math',
  'fangsong',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
]);
const CSS_WIDE_AND_DEFAULT = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);
const reservedFamilyIdent = (name) =>
  GENERIC_FAMILIES.has(name) ||
  CSS_WIDE_AND_DEFAULT.has(name) ||
  name.startsWith('ui-');

/**
 * A `font-family` list (CSS Fonts 4 §2.1): a family name is a string, or a
 * sequence of identifiers naming the family of those identifiers joined by
 * single spaces, valid only when none of them is a generic family (`ui-*`
 * included), a CSS-wide keyword or `default`. A lone generic family is a
 * keyword, never the family of that name (`"serif"` is not `serif`). Any
 * other entry, an invalid sequence included, is compared as tokens.
 */
function familyKeys(tokens, start, end) {
  return splitTop(tokens, start, end, 'comma-token').map(([s, e]) => {
    const parts = tokens.slice(s, e).filter((token) => !isWs(token));
    if (parts.length === 1 && parts[0][0] === 'string-token') {
      return JSON.stringify(['family', parts[0][4].value]);
    }
    if (
      parts.length > 0 &&
      parts.every((token) => token[0] === 'ident-token')
    ) {
      if (parts.length === 1 && GENERIC_FAMILIES.has(lowerOf(parts[0]))) {
        return JSON.stringify(['generic', lowerOf(parts[0])]);
      }
      if (!parts.some((token) => reservedFamilyIdent(lowerOf(token)))) {
        return JSON.stringify([
          'family',
          parts.map((token) => token[4].value).join(' '),
        ]);
      }
    }
    return JSON.stringify(componentKeys(tokens, s, e, 'value'));
  });
}

function declarationsOf(tokens, start, end) {
  const out = [];
  for (const [s, e] of splitTop(tokens, start, end, 'semicolon-token')) {
    const declaration = declarationOf(tokens, s, e);
    if (declaration != null) out.push(declaration);
  }
  return out;
}

/** Whether a block's content `[start, end)` holds rules (or declarations). */
function holdsRules(tokens, start, end) {
  for (let i = start; i < end; i += 1) {
    if (tokens[i][0] === '{-token') return true;
    if (isOpen(tokens[i])) i = matching(tokens, i);
  }
  return false;
}

/**
 * The rules of `[start, end)` as a tree, in order:
 *   { rule: [selector keys...] (sorted), declarations }
 *   { at: name, prelude: keys, block: null | { rules } | { declarations } }
 */
function rulesOf(tokens, start, end, keyframes = false) {
  const out = [];
  let i = start;
  while (i < end) {
    while (i < end && isWs(tokens[i])) i += 1;
    if (i >= end) break;
    let j = i;
    while (
      j < end &&
      tokens[j][0] !== '{-token' &&
      tokens[j][0] !== 'semicolon-token'
    ) {
      if (isOpen(tokens[j])) j = matching(tokens, j);
      j += 1;
    }
    const atRule = tokens[i][0] === 'at-keyword-token';
    if (j >= end || tokens[j][0] === 'semicolon-token') {
      if (!atRule) throw new Error('a declaration outside a rule');
      out.push({
        at: asciiLower(tokens[i][4].value),
        prelude: componentKeys(tokens, i + 1, j, 'prelude'),
        block: null,
      });
      i = j + 1;
      continue;
    }
    const close = matching(tokens, j);
    if (atRule) {
      out.push({
        at: asciiLower(tokens[i][4].value),
        prelude: componentKeys(tokens, i + 1, j, 'prelude'),
        block: holdsRules(tokens, j + 1, close)
          ? {
              rules: rulesOf(
                tokens,
                j + 1,
                close,
                asciiLower(tokens[i][4].value).endsWith('keyframes'),
              ),
            }
          : { declarations: declarationsOf(tokens, j + 1, close) },
      });
    } else {
      out.push({
        rule: splitTop(tokens, i, j, 'comma-token')
          .map(([s, e]) =>
            JSON.stringify(
              componentKeys(
                tokens,
                s,
                e,
                keyframes ? 'keyframe-selector' : 'selector',
              ),
            ),
          )
          .sort(),
        declarations: declarationsOf(tokens, j + 1, close),
      });
    }
    i = close + 1;
  }
  return out;
}

/** The normal form of a stylesheet: its rule tree, in order. */
function normalizeCss(css) {
  const tokens = tokensOf(css);
  return rulesOf(tokens, 0, tokens.length);
}

/**
 * Number of leaf rules in a tree: style rules, statement at-rules and at-rules
 * with declarations. A block at-rule counts through the rules it holds.
 */
function countRules(rules) {
  return rules.reduce(
    (n, rule) => n + (rule.block?.rules ? countRules(rule.block.rules) : 1),
    0,
  );
}

/** The path and both sides of the first difference of two trees, or null. */
function firstDifference(a, b, path = []) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? null;
    const y = b[index] ?? null;
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    if (
      x?.block?.rules &&
      y?.block?.rules &&
      x.at === y.at &&
      JSON.stringify(x.prelude) === JSON.stringify(y.prelude)
    ) {
      return firstDifference(x.block.rules, y.block.rules, [...path, index]);
    }
    const where = [...path, index];
    return { index: where[0], path: where, canonical: x, delivered: y };
  }
  return null;
}

/**
 * `{ equivalent, rules, difference }`: `rules` counts both trees, and
 * `difference` names the first differing node (its index path and both
 * forms), or null.
 */
function declarationEquivalence(canonical, delivered) {
  const a = normalizeCss(canonical);
  const b = normalizeCss(delivered);
  const difference = firstDifference(a, b);
  return {
    equivalent: difference == null,
    rules: { canonical: countRules(a), delivered: countRules(b) },
    difference,
  };
}

module.exports = { declarationEquivalence, normalizeCss };
