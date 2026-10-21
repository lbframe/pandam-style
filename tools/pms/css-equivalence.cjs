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
//   - a token is compared by its type and decoded value, so escapes and quote
//     style do not matter (`.\61` is `.a`); identifiers stay case-sensitive,
//     only property and at-rule names are ASCII-lowercased;
//   - whitespace is a significant token everywhere, and is dropped only at
//     the grammar positions listed in `insignificant`; a comment separates
//     tokens and is otherwise ignored, so it can never merge two tokens;
//   - a custom property value is compared verbatim after the leading and
//     trailing whitespace trim the specification performs.

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

/** The comparison key of one token: its type and decoded value. */
function keyOf(token) {
  const [type, raw, , , data] = token;
  switch (type) {
    case WS:
      return 'ws';
    case 'ident-token':
    case 'function-token':
    case 'at-keyword-token':
    case 'string-token':
    case 'url-token':
    case 'delim-token':
    case 'percentage-token':
      return JSON.stringify([type, data.value]);
    case 'hash-token':
      return JSON.stringify([type, data.value]);
    case 'number-token':
      return JSON.stringify([
        type,
        data.value,
        data.type,
        data.signCharacter ?? '',
      ]);
    case 'dimension-token':
      return JSON.stringify([
        type,
        data.value,
        data.type,
        data.signCharacter ?? '',
        data.unit,
      ]);
    case 'bad-string-token':
    case 'bad-url-token':
    case 'unicode-range-token':
      return JSON.stringify([type, raw]);
    default:
      // Punctuation and block tokens: the type is the token.
      return type;
  }
}

/**
 * Whether the whitespace token at `i` of `tokens` (already collapsed and
 * trimmed) is insignificant. The allow-list, by grammar position:
 *   - next to a comma (selector lists, value lists, at-rule preludes);
 *   - next to a `>`, `+` or `~` combinator (`context: 'selector'` only);
 *   - right after `(` or a function name, or right before `)`;
 *   - next to the colon of a `(feature: value)` condition (`featureColon`).
 * The edges of a value, selector or prelude are trimmed by `componentKeys`;
 * `{`, `}` and `;` delimit components and never reach this list.
 */
function insignificant(tokens, i, context) {
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
  const keys = [];
  for (let i = 0; i < run.length; i += 1) {
    if (isWs(run[i]) && insignificant(run, i, context)) continue;
    keys.push(keyOf(run[i]));
  }
  return keys;
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
  return [
    custom ? rawName : asciiLower(rawName),
    custom
      ? verbatim(tokens, colon + 1, valueEnd)
      : componentKeys(tokens, colon + 1, valueEnd, 'value'),
    important,
  ];
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
function rulesOf(tokens, start, end) {
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
          ? { rules: rulesOf(tokens, j + 1, close) }
          : { declarations: declarationsOf(tokens, j + 1, close) },
      });
    } else {
      out.push({
        rule: splitTop(tokens, i, j, 'comma-token')
          .map(([s, e]) =>
            JSON.stringify(componentKeys(tokens, s, e, 'selector')),
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
