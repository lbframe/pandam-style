/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.2 S2: re-reading emitted CSS (value-safety-test.js and
// tools/policy/value-safety-scan.mjs).

'use strict';

const { tokenize } = require('@csstools/css-tokenizer');

/**
 * Parses CSS text into `[{ prelude: [...], declarations: [[property, value
 * tokens]] }]`, nested at-rules flattened with their prelude path. Strict:
 * it throws unless it consumes the whole input as balanced rules, so a
 * tokenizer error, a stray `}`, an unclosed `{`, an unbalanced bracket or
 * trailing text is an error, never a silently dropped rule. A prelude keeps
 * every token's text exactly (quoted strings included); only whitespace
 * tokens are written as one space.
 */
function readCss(css) {
  const errors = [];
  const tokens = tokenize(
    { css },
    { onParseError: (e) => errors.push(e) },
  ).filter((t) => t[0] !== 'EOF-token');
  if (errors.length > 0) throw new Error(`tokenizer error in ${css}`);
  const rules = [];
  const text = (list) =>
    list
      .map((t) => (t[0] === 'whitespace-token' ? ' ' : t[1]))
      .join('')
      .trim();
  function block(start, path) {
    let i = start;
    let prelude = [];
    while (i < tokens.length) {
      const [type] = tokens[i];
      if (type === '}-token') {
        if (path.length === 0) throw new Error(`stray } at token ${i}`);
        if (text(prelude) !== '') {
          throw new Error(`text before } in ${path.join(' ')}`);
        }
        return i + 1;
      }
      if (type === '{-token') {
        const head = text(prelude);
        const first = prelude.find((t) => t[0] !== 'whitespace-token');
        if (first?.[0] === 'at-keyword-token') {
          i = block(i + 1, [...path, head]);
        } else {
          i = declarations(i + 1, [...path, head]);
        }
        prelude = [];
        continue;
      }
      prelude.push(tokens[i]);
      i += 1;
    }
    if (path.length > 0) throw new Error('unbalanced block');
    if (text(prelude) !== '') throw new Error(`trailing text ${text(prelude)}`);
    return i;
  }
  function declarations(start, path) {
    const declared = [];
    let current = [];
    const open = [];
    let i = start;
    const flush = () => {
      const kept = current.filter((t) => t[0] !== 'whitespace-token');
      if (kept.length === 0) return;
      if (kept[0][0] !== 'ident-token' || kept[1]?.[0] !== 'colon-token') {
        throw new Error(`not a declaration: ${text(current)}`);
      }
      const colon = current.indexOf(kept[1]);
      declared.push([kept[0][1], valueForm(current.slice(colon + 1))]);
    };
    for (; i < tokens.length; i++) {
      const [type] = tokens[i];
      if (type === '(-token' || type === 'function-token') open.push(')-token');
      if (type === '[-token') open.push(']-token');
      if (type === ')-token' || type === ']-token') {
        if (open.pop() !== type) {
          throw new Error('unbalanced bracket in declarations');
        }
      }
      const depth = open.length;
      if (depth > 0 && type === '}-token') {
        throw new Error('} inside a bracket in declarations');
      }
      if (depth === 0 && type === 'semicolon-token') {
        flush();
        current = [];
        continue;
      }
      if (depth === 0 && type === '}-token') {
        flush();
        rules.push({ prelude: path, declarations: declared });
        return i + 1;
      }
      if (type === '{-token') throw new Error('a block inside declarations');
      current.push(tokens[i]);
    }
    throw new Error('unbalanced declarations');
  }
  const end = block(0, []);
  if (end !== tokens.length) throw new Error('input not fully consumed');
  return rules;
}

/** A comparable form of value tokens: type and decoded value. */
const valueForm = (list) =>
  list
    .filter((t) => t[0] !== 'whitespace-token')
    .map((t) => [t[0], t[4]?.value ?? t[1], t[4]?.unit ?? null]);

module.exports = { readCss, valueForm };
