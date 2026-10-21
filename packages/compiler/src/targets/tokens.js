/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * A tokenizer for the CSS the compiler emits.
 *
 * Emitted CSS is plain ASCII: identifiers, numbers, units, hashes, quoted
 * strings without escapes, functions and punctuation. For that subset this
 * produces the tokens `@csstools/css-tokenizer` produces (CSS Syntax 3), in
 * the shape extraction reads: `[type, raw, start, end, data]`, with `data`
 * holding `value` (and `unit`, `type`, `signCharacter` for numbers). Any text
 * outside the subset (an escape, a comment, a non-ASCII character, an
 * unquoted `url(`, CDO/CDC or a string with a newline) returns null, and the
 * caller tokenizes it with `@csstools/css-tokenizer` instead. The fast path
 * therefore never decides what a token is where the full algorithm could
 * differ; a test compares both on every emitted text.
 */

const isDigit = (c) => c >= 48 && c <= 57;
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameStart = (c) => isLetter(c) || c === 95;
const isName = (c) => isNameStart(c) || isDigit(c) || c === 45;
const isWhitespace = (c) =>
  c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

const SIMPLE = Object.freeze({
  40: '(-token',
  41: ')-token',
  91: '[-token',
  93: ']-token',
  123: '{-token',
  125: '}-token',
  44: 'comma-token',
  58: 'colon-token',
  59: 'semicolon-token',
});

/** Whether the three code points at `i` start an identifier (no escapes). */
function startsIdent(css, i) {
  const c = css.charCodeAt(i);
  if (c === 45) {
    const d = css.charCodeAt(i + 1);
    return isNameStart(d) || d === 45;
  }
  return isNameStart(c);
}

/** Whether the three code points at `i` start a number. */
function startsNumber(css, i) {
  const c = css.charCodeAt(i);
  if (c === 43 || c === 45) {
    const d = css.charCodeAt(i + 1);
    return isDigit(d) || (d === 46 && isDigit(css.charCodeAt(i + 2)));
  }
  if (c === 46) return isDigit(css.charCodeAt(i + 1));
  return isDigit(c);
}

function consumeName(css, i) {
  while (i < css.length && isName(css.charCodeAt(i))) i += 1;
  return i;
}

/** Tokens of `css`, or null when it is outside the emitted subset. */
export function tokenizeEmitted(css) {
  const out = [];
  const n = css.length;
  let i = 0;
  while (i < n) {
    const start = i;
    const c = css.charCodeAt(i);
    if (c > 127 || c === 92) return null;
    if (isWhitespace(c)) {
      while (i < n && isWhitespace(css.charCodeAt(i))) i += 1;
      out.push([
        'whitespace-token',
        css.slice(start, i),
        start,
        i - 1,
        undefined,
      ]);
      continue;
    }
    if (c === 47 && css.charCodeAt(i + 1) === 42) return null; // comment
    const simple = SIMPLE[c];
    if (simple !== undefined) {
      i += 1;
      out.push([simple, css[start], start, start, undefined]);
      continue;
    }
    if (c === 34 || c === 39) {
      i += 1;
      while (i < n && css.charCodeAt(i) !== c) {
        const d = css.charCodeAt(i);
        if (d === 92 || d === 10 || d === 13 || d === 12 || d > 127) {
          return null;
        }
        i += 1;
      }
      if (i >= n) return null;
      i += 1;
      out.push([
        'string-token',
        css.slice(start, i),
        start,
        i - 1,
        { value: css.slice(start + 1, i - 1) },
      ]);
      continue;
    }
    if (c === 35) {
      if (i + 1 < n && isName(css.charCodeAt(i + 1))) {
        const end = consumeName(css, i + 1);
        const name = css.slice(i + 1, end);
        i = end;
        out.push([
          'hash-token',
          css.slice(start, i),
          start,
          i - 1,
          { value: name, type: startsIdent(name, 0) ? 'id' : 'unrestricted' },
        ]);
        continue;
      }
      i += 1;
      out.push(['delim-token', '#', start, start, { value: '#' }]);
      continue;
    }
    if (startsNumber(css, i)) {
      let j = i;
      let signCharacter;
      const first = css.charCodeAt(j);
      if (first === 43 || first === 45) {
        signCharacter = css[j];
        j += 1;
      }
      let integer = true;
      while (j < n && isDigit(css.charCodeAt(j))) j += 1;
      if (css.charCodeAt(j) === 46 && isDigit(css.charCodeAt(j + 1))) {
        integer = false;
        j += 2;
        while (j < n && isDigit(css.charCodeAt(j))) j += 1;
      }
      const e = css.charCodeAt(j);
      if (e === 69 || e === 101) {
        const s = css.charCodeAt(j + 1);
        if (isDigit(s)) {
          integer = false;
          j += 2;
          while (j < n && isDigit(css.charCodeAt(j))) j += 1;
        } else if ((s === 43 || s === 45) && isDigit(css.charCodeAt(j + 2))) {
          integer = false;
          j += 3;
          while (j < n && isDigit(css.charCodeAt(j))) j += 1;
        }
      }
      const value = Number(css.slice(i, j));
      const numberType = integer ? 'integer' : 'number';
      if (j < n && startsIdent(css, j)) {
        const end = consumeName(css, j);
        const unit = css.slice(j, end);
        i = end;
        out.push([
          'dimension-token',
          css.slice(start, i),
          start,
          i - 1,
          signCharacter === undefined
            ? { value, type: numberType, unit }
            : { value, signCharacter, type: numberType, unit },
        ]);
        continue;
      }
      if (css.charCodeAt(j) === 37) {
        i = j + 1;
        out.push([
          'percentage-token',
          css.slice(start, i),
          start,
          i - 1,
          signCharacter === undefined ? { value } : { value, signCharacter },
        ]);
        continue;
      }
      i = j;
      out.push([
        'number-token',
        css.slice(start, i),
        start,
        i - 1,
        signCharacter === undefined
          ? { value, type: numberType }
          : { value, signCharacter, type: numberType },
      ]);
      continue;
    }
    if (
      c === 45 &&
      css.charCodeAt(i + 1) === 45 &&
      css.charCodeAt(i + 2) === 62
    ) {
      return null; // CDC
    }
    if (c === 60 && css.startsWith('<!--', i)) return null; // CDO
    if (c === 64) {
      if (startsIdent(css, i + 1)) {
        const end = consumeName(css, i + 1);
        const name = css.slice(i + 1, end);
        i = end;
        out.push([
          'at-keyword-token',
          css.slice(start, i),
          start,
          i - 1,
          { value: name },
        ]);
        continue;
      }
      i += 1;
      out.push(['delim-token', '@', start, start, { value: '@' }]);
      continue;
    }
    if (startsIdent(css, i)) {
      const end = consumeName(css, i);
      const name = css.slice(i, end);
      if (css.charCodeAt(end) === 40) {
        if (name.toLowerCase() === 'url') {
          // Quoted url() is a function token; an unquoted one is a url token
          // with its own rules, left to the full tokenizer.
          let k = end + 1;
          while (k < n && isWhitespace(css.charCodeAt(k))) k += 1;
          const q = css.charCodeAt(k);
          if (q !== 34 && q !== 39) return null;
        }
        i = end + 1;
        out.push([
          'function-token',
          css.slice(start, i),
          start,
          i - 1,
          { value: name },
        ]);
        continue;
      }
      i = end;
      out.push(['ident-token', name, start, i - 1, { value: name }]);
      continue;
    }
    i += 1;
    out.push(['delim-token', css[start], start, start, { value: css[start] }]);
  }
  out.push(['EOF-token', '', -1, -1, undefined]);
  return out;
}
