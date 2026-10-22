/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the closed grammar subset of property descriptors (CE-02.2).
 *
 * A descriptor's `grammar` is a CSS value definition transcribed from the
 * specification. Policy interprets only a closed subset of it: the top-level
 * alternatives separated by `|`, each one of
 *
 *   keyword  an identifier, such as `auto`
 *   numeric  one of <length> <percentage> <length-percentage> <number>
 *            <integer> <time>, with optional CSS Values 4 range brackets,
 *            such as `<length-percentage [0,∞]>` or `<time [0s,∞]>`
 *   opaque   anything else: juxtaposition, `&&`, `||`, `#`, multipliers,
 *            property references (`<'padding-top'>`), function productions
 *            and other data types
 *
 * An opaque branch admits nothing beyond the descriptor's exact, reviewed
 * values (fail-closed). This module is compiled once, when the descriptor
 * catalog is built; value acceptance never parses grammar.
 */

import { unitsOfType } from '../../targets/units';

export const NUMERIC_TYPES = Object.freeze([
  'length',
  'percentage',
  'length-percentage',
  'number',
  'integer',
  'time',
]);

const KEYWORD = /^[A-Za-z][A-Za-z0-9-]*$/;
const NUMERIC = new RegExp(
  `^<(${NUMERIC_TYPES.join('|')})(?:\\s*\\[\\s*([^,\\]]+?)\\s*,\\s*([^\\]]+?)\\s*\\])?>$`,
);

/** Top-level `|` alternatives; `||` and nested groups are not split. */
function alternatives(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote != null) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" && text[i - 1] === '<') {
      quote = c;
      continue;
    }
    if (c === '[' || c === '(' || c === '<') depth++;
    else if (c === ']' || c === ')' || c === '>') depth--;
    else if (c === '|' && depth === 0) {
      if (text[i + 1] === '|' || text[i - 1] === '|') continue;
      out.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) throw new Error(`unbalanced grammar: ${text}`);
  }
  if (depth !== 0 || quote != null) {
    throw new Error(`unbalanced grammar: ${text}`);
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

const TIME_SCALE = { s: 1, ms: 0.001 };

// A range bound: a number (`0`, `1`, `-∞`, `∞`), or a time (`0s`).
function bound(text, type) {
  if (text === '\u221E' || text === '+\u221E') return null;
  if (text === '-\u221E') return null;
  const match = /^(-?\d+(?:\.\d+)?)(s|ms)?$/.exec(text);
  if (match == null) throw new Error(`unsupported range bound "${text}"`);
  if (type === 'time' && match[2] == null && Number(match[1]) !== 0) {
    throw new Error(`a time bound needs a unit: "${text}"`);
  }
  if (type !== 'time' && match[2] != null) {
    throw new Error(`unexpected unit in bound "${text}"`);
  }
  return Number(match[1]) * (match[2] == null ? 1 : TIME_SCALE[match[2]]);
}

function unitsOf(type) {
  switch (type) {
    case 'length':
      return unitsOfType('length');
    case 'percentage':
      return Object.freeze(['%']);
    case 'length-percentage':
      return Object.freeze([...unitsOfType('length'), '%']);
    case 'time':
      return unitsOfType('time');
    default:
      return Object.freeze([]);
  }
}

/**
 * The constraint of one numeric data type text, such as
 * `<length-percentage [0,∞]>`, or null when the text is not a supported
 * numeric type. Bounds are inclusive, in the type's base unit (seconds for
 * `<time>`); null is unbounded.
 */
export function numericConstraint(text) {
  const match = NUMERIC.exec(text.trim());
  if (match == null) return null;
  const type = match[1];
  const lower = match[2] == null ? null : bound(match[2], type);
  const upper = match[3] == null ? null : bound(match[3], type);
  if (match[2] === '\u221E' || match[2] === '+\u221E') {
    throw new Error(`a lower bound cannot be +\u221E: "${text}"`);
  }
  if (match[3] === '-\u221E') {
    throw new Error(`an upper bound cannot be -\u221E: "${text}"`);
  }
  return Object.freeze({
    type,
    min: lower,
    max: upper,
    units: unitsOf(type),
    integer: type === 'integer',
  });
}

/**
 * The compiled branches of a grammar text: `{ keywords, numeric, opaque }`.
 * `keywords` and `opaque` are the branch texts; `numeric` the constraints.
 * Throws on a grammar text that does not parse (unbalanced, bad range).
 */
export function compileGrammar(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('empty grammar');
  }
  const keywords = [];
  const numeric = [];
  const opaque = [];
  for (const branch of alternatives(text)) {
    if (branch === '') throw new Error(`empty alternative in: ${text}`);
    if (KEYWORD.test(branch)) {
      keywords.push(branch);
      continue;
    }
    const constraint = numericConstraint(branch);
    if (constraint != null) numeric.push(constraint);
    else opaque.push(branch);
  }
  return Object.freeze({
    keywords: Object.freeze(keywords),
    numeric: Object.freeze(numeric),
    opaque: Object.freeze(opaque),
  });
}
