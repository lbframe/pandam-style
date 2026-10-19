/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Construct extraction from EMITTED CSS.
 *
 * Browser claims attach to the CSS the compiler actually emits, so this reads
 * rule text, never authoring syntax. It returns finite constructs (a property,
 * a value keyword, a function, a unit, a selector, an at-rule and its query
 * kinds, a descriptor, a known combination) that `catalog.js` maps to feature
 * keys. Anything it cannot classify becomes an `unclassified` construct, which
 * the outcome function reports as `unknown`, never as native.
 */

import { tokenize } from '@csstools/css-tokenizer';

const GLOBAL_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

// At-rules whose block holds rules, declarations or keyframes.
const RULE_BLOCK_AT_RULES = new Set([
  'media',
  'supports',
  'container',
  'layer',
  'scope',
  'starting-style',
  'document',
]);
const DECLARATION_BLOCK_AT_RULES = new Set([
  'property',
  'font-face',
  'counter-style',
  'page',
  'position-try',
  'view-transition',
  'font-palette-values',
  'font-feature-values',
]);

const type = (token) => token[0];
const value = (token) => token[4]?.value;
const isWs = (token) =>
  type(token) === 'whitespace-token' || type(token) === 'comment';
const OPEN = new Set(['(-token', '[-token', '{-token', 'function-token']);
const CLOSE = new Set([')-token', ']-token', '}-token']);

/** Index of the token closing the block opened at `open`. */
function matching(tokens, open) {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (OPEN.has(type(tokens[i]))) depth += 1;
    else if (CLOSE.has(type(tokens[i]))) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** Splits `[start, end)` at top-level tokens of the given type. */
function splitTop(tokens, start, end, separator) {
  const parts = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (OPEN.has(t)) depth += 1;
    else if (CLOSE.has(t)) depth -= 1;
    else if (depth === 0 && t === separator) {
      parts.push([from, i]);
      from = i + 1;
    }
  }
  parts.push([from, end]);
  return parts;
}

function trimRange(tokens, [start, end]) {
  let s = start;
  let e = end;
  while (s < e && isWs(tokens[s])) s += 1;
  while (e > s && isWs(tokens[e - 1])) e -= 1;
  return [s, e];
}

function text(tokens, start, end) {
  return tokens
    .slice(start, end)
    .map((t) => t[1])
    .join('')
    .trim();
}

class Collector {
  constructor(dedupe = true) {
    this.items = [];
    this.keys = new Set();
    this.dedupe = dedupe;
  }
  add(construct, context) {
    const key = JSON.stringify(construct);
    if (this.dedupe && this.keys.has(key)) return;
    this.keys.add(key);
    this.items.push({ construct, context });
  }
}

// ---------------------------------------------------------------- values ----

// Properties whose comma-separated value is a fallback chain: an engine that
// does not know an entry uses the next one.
const FALLBACK_LIST_PROPERTIES = new Set(['font-family']);

function analyseValue(tokens, start, end, property, out, context) {
  const topIdents = [];
  // In a fallback chain, every entry but the last is backed up by a later one.
  const lastEntryStart = FALLBACK_LIST_PROPERTIES.has(property)
    ? splitTop(tokens, start, end, 'comma-token').at(-1)[0]
    : start;
  let depth = 0;
  const functionStack = [];
  for (let i = start; i < end; i += 1) {
    const token = tokens[i];
    const t = type(token);
    if (t === 'function-token') {
      const name = String(value(token)).toLowerCase();
      // Relative color syntax: the first argument of a color function is
      // the `from` keyword.
      let j = i + 1;
      while (j < end && isWs(tokens[j])) j += 1;
      const relative =
        j < end &&
        type(tokens[j]) === 'ident-token' &&
        String(value(tokens[j])).toLowerCase() === 'from';
      out.add({ kind: 'function', property, name, relative }, context);
      functionStack.push(name);
      depth += 1;
      continue;
    }
    if (t === '(-token' || t === '[-token') {
      depth += 1;
      functionStack.push(null);
      continue;
    }
    if (t === ')-token' || t === ']-token') {
      depth -= 1;
      functionStack.pop();
      continue;
    }
    if (t === 'ident-token') {
      const ident = String(value(token)).toLowerCase();
      if (depth === 0) topIdents.push(ident);
      if (GLOBAL_KEYWORDS.has(ident) && depth === 0) {
        out.add({ kind: 'global-keyword', keyword: ident }, context);
      } else if (ident !== 'from') {
        out.add(
          i < lastEntryStart
            ? {
                kind: 'value-keyword',
                property,
                keyword: ident,
                listFallback: true,
              }
            : { kind: 'value-keyword', property, keyword: ident },
          context,
        );
      }
      continue;
    }
    if (t === 'dimension-token') {
      out.add(
        { kind: 'unit', unit: String(token[4].unit).toLowerCase() },
        context,
      );
      continue;
    }
    if (t === 'hash-token' && depth === 0) {
      const hex = String(value(token));
      if (/^[0-9a-f]+$/i.test(hex) && (hex.length === 4 || hex.length === 8)) {
        out.add({ kind: 'alpha-hex-color' }, context);
      }
      continue;
    }
    if (
      t === 'url-token' ||
      t === 'string-token' ||
      t === 'number-token' ||
      t === 'percentage-token' ||
      t === 'comma-token' ||
      t === 'delim-token' ||
      t === 'hash-token' ||
      isWs(token)
    ) {
      continue;
    }
    out.add({ kind: 'unclassified', where: 'value', token: t }, context);
  }
  if (
    property === 'display' &&
    topIdents.filter((ident) => !GLOBAL_KEYWORDS.has(ident)).length >= 2
  ) {
    out.add({ kind: 'value-multi-keyword', property }, context);
  }
}

function analyseDeclarations(tokens, start, end, out, context, descriptorOf) {
  for (const range of splitTop(tokens, start, end, 'semicolon-token')) {
    const [s, e] = trimRange(tokens, range);
    if (s >= e) continue;
    if (type(tokens[s]) !== 'ident-token') {
      out.add({ kind: 'unclassified', where: 'declaration' }, context);
      continue;
    }
    let colon = s + 1;
    while (colon < e && isWs(tokens[colon])) colon += 1;
    if (colon >= e || type(tokens[colon]) !== 'colon-token') {
      out.add({ kind: 'unclassified', where: 'declaration' }, context);
      continue;
    }
    const rawName = String(value(tokens[s]));
    const name = rawName.startsWith('--') ? rawName : rawName.toLowerCase();
    let valueEnd = e;
    let important = false;
    // `! important` at the end of the value.
    let k = e - 1;
    while (k > colon && isWs(tokens[k])) k -= 1;
    if (
      k > colon &&
      type(tokens[k]) === 'ident-token' &&
      String(value(tokens[k])).toLowerCase() === 'important'
    ) {
      let bang = k - 1;
      while (bang > colon && isWs(tokens[bang])) bang -= 1;
      if (type(tokens[bang]) === 'delim-token' && value(tokens[bang]) === '!') {
        important = true;
        valueEnd = bang;
      }
    }
    const declarationContext = {
      ...context,
      property: name,
      value: text(tokens, colon + 1, valueEnd),
      important,
    };
    if (descriptorOf != null) {
      out.add(
        { kind: 'descriptor', atRule: descriptorOf, name },
        declarationContext,
      );
      // Descriptor values still use functions and units (`src: url() format()`
      // is covered by the at-rule; `initial-value` can hold any value).
      analyseValue(
        tokens,
        colon + 1,
        valueEnd,
        `@${descriptorOf}/${name}`,
        out,
        declarationContext,
      );
      continue;
    }
    out.add({ kind: 'property', name }, declarationContext);
    // Engines that implement `::marker` partially apply only some properties
    // inside it, so each declared property is its own combination.
    if (/::marker\b/i.test(context.selector ?? '')) {
      out.add({ kind: 'marker-property', property: name }, declarationContext);
    }
    analyseValue(tokens, colon + 1, valueEnd, name, out, declarationContext);
    if (important && (context.atRules ?? []).some((a) => a.name === 'layer')) {
      out.add(
        { kind: 'combination', key: 'at-rule:layer/block+important' },
        declarationContext,
      );
    }
  }
}

// ------------------------------------------------------------- selectors ----

function analyseSelector(tokens, start, end, out, context, enclosing = []) {
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (t === '[-token') {
      out.add({ kind: 'attribute-selector' }, context);
      i = matching(tokens, i);
      continue;
    }
    if (t !== 'colon-token') continue;
    const element = type(tokens[i + 1]) === 'colon-token';
    const at = element ? i + 2 : i + 1;
    const token = tokens[at];
    if (token == null) break;
    if (type(token) === 'ident-token' || type(token) === 'function-token') {
      const name = String(value(token)).toLowerCase();
      out.add({ kind: 'selector', name, element }, context);
      if (enclosing.includes('has') && name === 'has') {
        out.add(
          { kind: 'combination', key: 'selector:has+selector:has' },
          context,
        );
      }
      if (enclosing.includes('has') && element) {
        out.add(
          { kind: 'combination', key: 'selector:has+pseudo-element' },
          context,
        );
      }
      if (type(token) === 'function-token') {
        const close = matching(tokens, at);
        // Functional pseudo-classes taking a selector list.
        if (
          [
            'has',
            'is',
            'where',
            'not',
            'host',
            'host-context',
            'slotted',
            'part',
            'nth-child',
            'nth-last-child',
          ].includes(name)
        ) {
          analyseSelector(tokens, at + 1, close, out, context, [
            ...enclosing,
            name,
          ]);
        }
        i = close;
      } else {
        i = at;
      }
      continue;
    }
    out.add({ kind: 'unclassified', where: 'selector' }, context);
  }
}

// -------------------------------------------------------------- at-rules ----

function analyseMediaQuery(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (
      t === 'ident-token' &&
      String(value(tokens[i])).toLowerCase() === 'or'
    ) {
      out.add({ kind: 'media-syntax', name: 'or_syntax' }, context);
    }
    if (t === 'function-token') {
      out.add({ kind: 'unclassified', where: 'media-query' }, context);
      i = matching(tokens, i);
      continue;
    }
    if (t !== '(-token') continue;
    const close = matching(tokens, i);
    const inner = trimRange(tokens, [i + 1, close]);
    const nestedParen = tokens
      .slice(inner[0], inner[1])
      .some((token) => type(token) === '(-token');
    if (nestedParen) {
      analyseMediaQuery(tokens, inner[0], inner[1], out, context);
      i = close;
      continue;
    }
    let range = false;
    for (let j = inner[0]; j < inner[1]; j += 1) {
      const token = tokens[j];
      if (
        type(token) === 'delim-token' &&
        ['<', '>', '='].includes(value(token))
      ) {
        range = true;
      } else if (type(token) === 'ident-token') {
        const name = String(value(token)).toLowerCase();
        const previous = tokens[j - 1];
        const isValue =
          j > inner[0] &&
          !(type(previous) === 'delim-token' || isWs(previous)) &&
          type(previous) === 'colon-token';
        const afterColon = tokens
          .slice(inner[0], j)
          .some((x) => type(x) === 'colon-token');
        if (!isValue && !afterColon) {
          out.add({ kind: 'media-feature', name }, context);
        }
      } else if (type(token) === 'dimension-token') {
        out.add(
          { kind: 'unit', unit: String(token[4].unit).toLowerCase() },
          context,
        );
      }
    }
    if (range) out.add({ kind: 'media-syntax', name: 'range_syntax' }, context);
    i = close;
  }
}

function analyseContainerQuery(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    const t = type(tokens[i]);
    if (t === 'function-token') {
      const name = String(value(tokens[i])).toLowerCase();
      out.add({ kind: 'container-query', name }, context);
      i = matching(tokens, i);
      continue;
    }
    if (t === 'dimension-token') {
      out.add(
        { kind: 'unit', unit: String(tokens[i][4].unit).toLowerCase() },
        context,
      );
    }
  }
}

function analyseSupports(tokens, start, end, out, context) {
  for (let i = start; i < end; i += 1) {
    if (type(tokens[i]) !== 'function-token') continue;
    const name = String(value(tokens[i])).toLowerCase();
    out.add({ kind: 'supports-function', name }, context);
    i = matching(tokens, i);
  }
}

function analyseRules(tokens, start, end, out, context) {
  let i = start;
  while (i < end) {
    while (
      i < end &&
      (isWs(tokens[i]) || type(tokens[i]) === 'semicolon-token')
    ) {
      i += 1;
    }
    if (i >= end) break;
    // Prelude up to `{` or `;` at depth 0.
    let j = i;
    let depth = 0;
    while (j < end) {
      const t = type(tokens[j]);
      if (depth === 0 && (t === '{-token' || t === 'semicolon-token')) break;
      if (t === '(-token' || t === '[-token' || t === 'function-token') {
        depth += 1;
      } else if (t === ')-token' || t === ']-token') depth -= 1;
      j += 1;
    }
    const isAt = type(tokens[i]) === 'at-keyword-token';
    if (j >= end || type(tokens[j]) === 'semicolon-token') {
      if (isAt) {
        const name = String(value(tokens[i])).toLowerCase();
        out.add({ kind: 'at-rule', name, form: 'statement' }, context);
      } else {
        out.add({ kind: 'unclassified', where: 'rule' }, context);
      }
      i = j + 1;
      continue;
    }
    const close = matching(tokens, j);
    if (isAt) {
      const name = String(value(tokens[i])).toLowerCase();
      const prelude = text(tokens, i + 1, j);
      const atContext = {
        ...context,
        atRules: [...(context.atRules ?? []), { name, prelude }],
      };
      out.add({ kind: 'at-rule', name, form: 'block' }, atContext);
      if (name === 'media') analyseMediaQuery(tokens, i + 1, j, out, atContext);
      else if (name === 'container') {
        analyseContainerQuery(tokens, i + 1, j, out, atContext);
      } else if (name === 'supports') {
        analyseSupports(tokens, i + 1, j, out, atContext);
      } else if (name === 'scope') {
        analyseSelector(tokens, i + 1, j, out, atContext);
      }
      if (RULE_BLOCK_AT_RULES.has(name)) {
        analyseRules(tokens, j + 1, close, out, atContext);
      } else if (name === 'keyframes' || name.endsWith('-keyframes')) {
        // Keyframe selectors are percentages or `from`/`to`; the
        // declarations inside are ordinary property declarations.
        let k = j + 1;
        while (k < close) {
          while (k < close && type(tokens[k]) !== '{-token') k += 1;
          if (k >= close) break;
          const frameClose = matching(tokens, k);
          analyseDeclarations(tokens, k + 1, frameClose, out, atContext, null);
          k = frameClose + 1;
        }
      } else if (DECLARATION_BLOCK_AT_RULES.has(name)) {
        const descriptorOf = name === 'position-try' ? null : name;
        analyseDeclarations(tokens, j + 1, close, out, atContext, descriptorOf);
      } else {
        out.add({ kind: 'unclassified', where: 'at-rule-block' }, atContext);
      }
    } else {
      const selector = text(tokens, i, j);
      const ruleContext = { ...context, selector };
      analyseSelector(tokens, i, j, out, ruleContext);
      analyseDeclarations(tokens, j + 1, close, out, ruleContext, null);
    }
    i = close + 1;
  }
}

/**
 * Constructs of one emitted CSS text (one engine rule, or a whole sheet).
 * Each item is `{ construct, context }`; duplicates within the text collapse
 * unless `dedupe` is false (attribution tooling wants every occurrence).
 */
export function extractConstructs(cssText, { dedupe = true } = {}) {
  const out = new Collector(dedupe);
  const tokens = tokenize({ css: String(cssText) }).filter(
    (token) => type(token) !== 'EOF-token',
  );
  analyseRules(tokens, 0, tokens.length, out, { atRules: [] });
  return out.items;
}
