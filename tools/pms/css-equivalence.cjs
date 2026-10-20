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
//   - the same at-rule conditions;
//   - the same selector set (the order inside one selector list may differ);
//   - the same declarations, in the same order, with the same values,
//     including every vendor-prefixed pair.
// Whitespace, comments and final semicolons may differ, so minification
// passes. Dropping, adding, merging, reordering or rewriting a declaration is
// a host redefining the CSS, and fails.
//
// Built on `@csstools/css-tokenizer` (CSS Syntax Level 3 tokens), a runtime
// dependency of the compiler and so present wherever a host qualification
// runs. The block structure is read from tokens, never from a regex.

const { tokenize } = require('@csstools/css-tokenizer');

// Tokens next to which whitespace carries no meaning, per context.
const SELECTOR_TIGHT = new Set(['>', '+', '~', ',', '(', ')', '[', ']', '=']);
const VALUE_TIGHT = new Set(['(', ')', ',', ':', '/', '[', ']', '!']);

function tokensOf(css) {
  return tokenize({ css }).filter(
    (token) => token[0] !== 'comment' && token[0] !== 'EOF-token',
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
 * Canonical text of `[start, end)`: whitespace dropped at the edges and next
 * to `tight` punctuation, any other run collapsed to one space.
 */
function textOf(tokens, start, end, tight) {
  const raw = (token) => token[1];
  const isWs = (token) => token[0] === 'whitespace-token';
  const pieces = [];
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    if (isWs(token)) {
      const prev = pieces.length === 0 ? null : pieces[pieces.length - 1];
      let next = i + 1;
      while (next < end && isWs(tokens[next])) next += 1;
      if (prev == null || next >= end) continue;
      const after = raw(tokens[next]);
      // Never before an opener: `a (b)` is not `a(b)`, `a [x]` is not `a[x]`.
      const nextTight =
        (tight.has(after) && after !== '(' && after !== '[') ||
        tokens[next][0] === ')-token' ||
        after === '!';
      const prevTight = tight.has(prev) || prev.endsWith('(');
      if (!nextTight && !prevTight) pieces.push(' ');
      i = next - 1;
      continue;
    }
    pieces.push(raw(token));
  }
  return pieces.join('');
}

/** `[start, end)` of a block's content holds rules (true) or declarations. */
function holdsRules(tokens, start, end) {
  for (let i = start; i < end; i += 1) {
    if (tokens[i][0] === '{-token') return true;
    if (isOpen(tokens[i])) i = matching(tokens, i);
  }
  return false;
}

function declarationsOf(tokens, start, end) {
  const out = [];
  for (const [s, e] of splitTop(tokens, start, end, 'semicolon-token')) {
    const text = textOf(tokens, s, e, VALUE_TIGHT);
    if (text !== '') out.push(text);
  }
  return out;
}

/**
 * Flattened rules of `[start, end)`, each `{ at, selectors, declarations }`:
 * `at` the chain of at-rule conditions, `selectors` the sorted selector set
 * (null for an at-rule with declarations or a statement).
 */
function rulesOf(tokens, start, end, at, out) {
  let i = start;
  while (i < end) {
    while (i < end && tokens[i][0] === 'whitespace-token') i += 1;
    if (i >= end) break;
    // Prelude up to `{` (a block) or `;` (an at-rule statement).
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
        at: [...at, textOf(tokens, i, j, VALUE_TIGHT)],
        selectors: null,
        declarations: [],
      });
      i = j + 1;
      continue;
    }
    const close = matching(tokens, j);
    if (atRule) {
      const condition = textOf(tokens, i, j, VALUE_TIGHT);
      if (holdsRules(tokens, j + 1, close)) {
        rulesOf(tokens, j + 1, close, [...at, condition], out);
      } else {
        out.push({
          at: [...at, condition],
          selectors: null,
          declarations: declarationsOf(tokens, j + 1, close),
        });
      }
    } else {
      const selectors = splitTop(tokens, i, j, 'comma-token')
        .map(([s, e]) => textOf(tokens, s, e, SELECTOR_TIGHT))
        .sort();
      out.push({
        at,
        selectors,
        declarations: declarationsOf(tokens, j + 1, close),
      });
    }
    i = close + 1;
  }
  return out;
}

/** The normal form of a stylesheet: its flattened rules, in order. */
function normalizeCss(css) {
  const tokens = tokensOf(css);
  return rulesOf(tokens, 0, tokens.length, [], []);
}

const key = (rule) => JSON.stringify(rule);

/**
 * `{ equivalent, rules, difference }`: `difference` names the first rule
 * that differs (index, canonical and delivered forms), or null.
 */
function declarationEquivalence(canonical, delivered) {
  const a = normalizeCss(canonical);
  const b = normalizeCss(delivered);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (
      a[index] == null ||
      b[index] == null ||
      key(a[index]) !== key(b[index])
    ) {
      return {
        equivalent: false,
        rules: { canonical: a.length, delivered: b.length },
        difference: {
          index,
          canonical: a[index] ?? null,
          delivered: b[index] ?? null,
        },
      };
    }
  }
  return {
    equivalent: true,
    rules: { canonical: a.length, delivered: b.length },
    difference: null,
  };
}

module.exports = { declarationEquivalence, normalizeCss };
