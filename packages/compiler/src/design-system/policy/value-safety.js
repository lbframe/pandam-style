/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - S1, the one safety predicate of author text (CE-02.2 §4.2).
 *
 * Every author-supplied text that can reach emitted CSS goes through
 * `unsafeValueClass(text, kind)` before it does: token and theme values,
 * condition definitions, condition-block keys of style objects and
 * `propertyDomains` literals. `kind` is `value` or `condition`. The text is
 * always tokenized whole (CSS Syntax 3, `@csstools/css-tokenizer`); there is
 * no precheck and no fast path. A text is safe only when:
 *
 *   1. it has no raw `\`, `;`, `{` or `}`, strings included: an escape could
 *      re-spell a forbidden character or name, and the CE-01.2 transform
 *      stage finds declaration ends by raw `;`/`}`;
 *   2. the tokenizer reports no parse error, and blocks and functions
 *      balance;
 *   3. every token is of a closed set of types (comments, CDO/CDC, `!`,
 *      at-keywords outside conditions, url tokens are not);
 *   4. every function, at every depth, is in APPROVED_FUNCTIONS, compared
 *      ASCII case-insensitively on the decoded name; a vendor alias or a
 *      Unicode lookalike is not folded to a listed name;
 *   5. a JS number is finite with |v| <= 1e6.
 *
 * It returns null for a safe text, else `{ reason, offset, function? }`.
 * Selector and token-category grammar are not checked here (CE-07, CE-03).
 */

import { tokenize, ParseError } from '@csstools/css-tokenizer';
import { MAGNITUDE } from './literals';

/**
 * The functions author text may call, frozen by scanning every existing
 * fixture, workload and corpus token and condition (CE-02.2 PR B). A
 * reference construct (`url`, `src`, `image`, `image-set`, `element`,
 * `cross-fade`, `paint`, `attr`, `var`, `env`, `if`, `expression`) is never
 * listed: it reads resources, the DOM, unowned custom properties or the
 * environment.
 */
export const APPROVED_FUNCTIONS = Object.freeze({
  value: Object.freeze([
    'blur',
    'calc',
    'clamp',
    'color',
    'color-mix',
    'cubic-bezier',
    'grayscale',
    'hsl',
    'hsla',
    'hwb',
    'inset',
    'lab',
    'lch',
    'light-dark',
    'linear',
    'max',
    'min',
    'minmax',
    'oklab',
    'oklch',
    'repeat',
    'rgb',
    'rgba',
    'rotate',
    'scale',
    'steps',
    'translate',
    'translatex',
    'translatey',
  ]),
  condition: Object.freeze([
    'dir',
    'has',
    'is',
    'lang',
    'not',
    'nth-child',
    'nth-last-child',
    'nth-last-of-type',
    'nth-of-type',
    'scroll-state',
    'selector',
    'where',
  ]),
});

const VALUE_DELIMS = new Set(['/', '+', '-', '*', '.', '%']);
const CONDITION_DELIMS = new Set([
  ...VALUE_DELIMS,
  '&',
  '>',
  '~',
  '=',
  '^',
  '$',
  '|',
]);
const VALUE_TYPES = new Set([
  'ident-token',
  'function-token',
  'number-token',
  'percentage-token',
  'dimension-token',
  'hash-token',
  'string-token',
  'whitespace-token',
  'comma-token',
  '(-token',
  ')-token',
  '[-token',
  ']-token',
  'delim-token',
  'EOF-token',
]);
const CONDITION_TYPES = new Set([
  ...VALUE_TYPES,
  'at-keyword-token',
  'colon-token',
]);
const OPEN = { '(-token': ')-token', '[-token': ']-token' };

// ASCII lower case only: a non-ASCII letter keeps its identity, so a
// lookalike never matches a listed name.
const asciiLower = (text) =>
  text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

const fail = (reason, offset, extra = {}) => ({ reason, offset, ...extra });

/** The canonical text of an author input: a JS number as `String(v)`. */
export function authorText(input) {
  if (typeof input === 'string') return input;
  if (typeof input === 'number') return String(input);
  return null;
}

/**
 * S1 on one author text: `{ text, tokens, unsafe }`. The complete text is
 * tokenized exactly once, before any verdict, accepted or refused (a JS
 * number from its canonical text, `String(v)`); every check runs on that
 * tokenization or after it. `tokens` is null only for an input that is
 * neither a string nor a number. Callers that also read the tokens (the
 * numeric facts of token values) reuse them instead of tokenizing again.
 */
export function inspectAuthorText(input, kind = 'value') {
  const text = authorText(input);
  if (text == null) {
    return { text: null, tokens: null, unsafe: fail('token-kind', 0) };
  }
  const errors = [];
  let tokens = null;
  try {
    tokens = tokenize(
      { css: text },
      { onParseError: (error) => errors.push(error) },
    );
  } catch (error) {
    return { text, tokens: null, unsafe: fail('tokenizer-error', 0) };
  }
  return { text, tokens, unsafe: verdict(input, text, tokens, errors, kind) };
}

/**
 * S1 through a memo of results by kind and text, for a definition rebuilt
 * again and again (a Project Service session rebuilds its design system on
 * every definition edit). `holder` is the caller's `{ texts }`: the inspector
 * returns the previous build's result for a text it already inspected, so an
 * unchanged text is not tokenized again, and records in a new map only the
 * texts this build inspects, so a text that changed (or disappeared) leaves
 * the memo, which stays the size of one definition. A result is a pure
 * function of its key; its tokens are shared and never mutated. Without a
 * holder, the memo still inspects each distinct text of one build once.
 */
export function authorTextInspector(holder = null) {
  const previous = holder?.texts ?? null;
  // Keyed by the input itself, one map per kind: a Map keeps a number and
  // its text apart (`1e7` and `'10000000'` differ in S1).
  const texts = { value: new Map(), condition: new Map() };
  if (holder != null) holder.texts = texts;
  return (input, kind = 'value') => {
    if (typeof input !== 'string' && typeof input !== 'number') {
      return inspectAuthorText(input, kind);
    }
    const current = texts[kind];
    let inspected = current.get(input);
    if (inspected === undefined) {
      inspected = previous?.[kind].get(input) ?? inspectAuthorText(input, kind);
      current.set(input, inspected);
      // A safe number's text is safe with the same tokens; the registry
      // stores token values as text and finds them under it.
      if (typeof input === 'number' && inspected.unsafe == null) {
        current.set(inspected.text, inspected);
      }
    }
    return inspected;
  };
}

/** Why an author text is unsafe, or null (see the module comment). */
export function unsafeValueClass(input, kind = 'value') {
  return inspectAuthorText(input, kind).unsafe;
}

function verdict(input, text, tokens, errors, kind) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || Math.abs(input) > MAGNITUDE) {
      return fail('non-finite', 0);
    }
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') return fail('escape', i);
    if (c === ';' || c === '{' || c === '}') return fail('breakout', i);
  }
  if (errors.length > 0) {
    const first = errors[0];
    return fail(
      'tokenizer-error',
      first instanceof ParseError ? (first.sourceStart ?? 0) : 0,
    );
  }
  const types = kind === 'condition' ? CONDITION_TYPES : VALUE_TYPES;
  const delims = kind === 'condition' ? CONDITION_DELIMS : VALUE_DELIMS;
  const approved = APPROVED_FUNCTIONS[kind];
  const stack = [];
  for (const token of tokens) {
    const [type, raw, start, , data] = token;
    if (type === 'comment') return fail('comment', start);
    if (type === 'CDO-token' || type === 'CDC-token') {
      return fail('token-kind', start);
    }
    if (type === 'url-token' || type === 'bad-url-token') {
      return fail('url-token', start);
    }
    if (type === 'bad-string-token') return fail('tokenizer-error', start);
    if (type === 'delim-token') {
      if (data.value === '!') return fail('important', start);
      if (!delims.has(data.value)) return fail('token-kind', start);
      continue;
    }
    if (!types.has(type)) return fail('token-kind', start);
    if (type === 'function-token') {
      const name = asciiLower(String(data.value));
      if (!approved.includes(name)) {
        return fail('function-not-approved', start, { function: raw });
      }
      stack.push(')-token');
    } else if (Object.hasOwn(OPEN, type)) {
      stack.push(OPEN[type]);
    } else if (type === ')-token' || type === ']-token') {
      if (stack.pop() !== type) return fail('unbalanced', start);
    }
  }
  if (stack.length > 0) return fail('unbalanced', text.length);
  return null;
}
