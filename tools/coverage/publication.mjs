/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Publication policy for declarations extracted from private consumer
// stylesheets: a positive allow-list over CSS tokens.
//
// Every value and condition is tokenized with postcss-value-parser. A token
// passes only when it is exactly one of:
//   (a) a CSS keyword or function name from the fixed vocabulary below;
//   (b) a number, or a dimension whose unit is in the fixed unit list;
//   (c) a hash token that is a 3, 4, 6 or 8 digit hex color;
//   (d) an approved identifier from approved-identifiers.v1.json;
//   (e) a keyed redaction placeholder;
//   (f) whitespace, a comma, slash or colon separator, a calc operator or a
//       parenthesized group.
// Nothing is skipped by prefix. Extraction (policeRecord) replaces every
// other token with a keyed placeholder; the validator
// (checkPublishedDeclaration) rejects any published record that still holds
// one. Properties, layers, selector state and ids have exact allow-lists.

import { createRequire } from 'node:module';
import { CSS_COLOR_KEYWORDS } from './css-colors.mjs';
import { PLACEHOLDER_SOURCE, PUBLIC_DIGESTER } from './digest.mjs';

const require = createRequire(import.meta.url);
const valueParser = require('postcss-value-parser');

// (a) CSS keywords: language vocabulary, not consumer identifiers.
export const CSS_KEYWORDS = new Set([
  ...CSS_COLOR_KEYWORDS,
  ...(
    'absolute all alternate antialiased anywhere auto auto-fill auto-fit ' +
    'avoid background background-color balance baseline block bold bolder ' +
    'border-box border-color both bottom box-shadow break-word button ' +
    'center circle clip collapse color column column-reverse contain ' +
    'content-box cover dashed decimal default disc dotted ease ease-in ' +
    'ease-in-out ease-out ellipsis end fit-content fixed flex flex-end ' +
    'flex-start ' +
    'forwards grid hidden horizontal in infinite inherit initial inline ' +
    'inline-block inline-flex inline-grid inset italic justify left light ' +
    'linear list-item manipulation max-content middle min-content mixed ' +
    'monospace multiply no-drag no-repeat none normal not-allowed nowrap ' +
    'optimizelegibility outside over padding-box pixelated pointer pre ' +
    'pre-line pre-wrap pretty progress proximity relative repeat revert ' +
    'right round row row-reverse sans-serif scroll separate serif smooth ' +
    'solid space-around space-between square stable start static sticky ' +
    'stretch strict swap system-ui tabular-nums text text-bottom text-top ' +
    'top transform transparent ui-monospace ui-sans-serif ui-serif ' +
    'underline unset uppercase vertical vertical-rl visible wrap x y'
  ).split(' '),
  // Keywords that share a name with a function: color spaces, filter and
  // transform names used as plain values (font smoothing, transition lists).
  ...(
    'grayscale srgb srgb-linear display-p3 oklab oklch lab lch hsl hwb ' +
    'opacity rotate scale translate'
  ).split(' '),
  // Media and supports query vocabulary.
  ...(
    'and not only or screen print min-width max-width width height ' +
    'min-height max-height prefers-reduced-motion reduce no-preference ' +
    'prefers-contrast more less forced-colors active hover coarse fine ' +
    'prefers-color-scheme dark contain-intrinsic-size orientation ' +
    'landscape portrait'
  ).split(' '),
  // Vendor platform keywords used by preflight stylesheets.
  ...'-apple-system -webkit-appearance -apple-pay-button'.split(' '),
]);

// (a) CSS function names. The empty name is a parenthesized group.
export const CSS_FUNCTIONS = new Set([
  '',
  ...(
    'attr blur brightness calc circle clamp color color-mix conic-gradient ' +
    'contrast counter counters cubic-bezier drop-shadow ellipse env ' +
    'fit-content format grayscale hsl hsla hue-rotate hwb image-set inset ' +
    'invert lab lch light-dark linear-gradient local matrix matrix3d max ' +
    'min minmax oklab oklch opacity path polygon radial-gradient rect ' +
    'repeat repeating-linear-gradient repeating-radial-gradient rgb rgba ' +
    'rotate rotate3d rotatex rotatey rotatez saturate scale scale3d scalex ' +
    'scaley sepia skew skewx skewy steps translate translate3d translatex ' +
    'translatey translatez url var'
  ).split(' '),
]);

// (b) CSS units (Values and Units 4), lower case.
export const CSS_UNITS = new Set(
  (
    '% px cm mm q in pt pc em rem ex rex cap rcap ch rch ic ric lh rlh vw ' +
    'vh vi vb vmin vmax svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin ' +
    'lvmax dvw dvh dvi dvb dvmin dvmax cqw cqh cqi cqb cqmin cqmax deg ' +
    'grad rad turn s ms hz khz dpi dpcm dppx x fr'
  ).split(' '),
);

export const PSEUDO_CLASSES = new Set(
  (
    ':active :checked :default :defined :dir :disabled :empty :enabled ' +
    ':first-child :first-of-type :focus :focus-visible :focus-within ' +
    ':has :host :hover :indeterminate :invalid :is :last-child ' +
    ':last-of-type :link :not :nth-child :nth-last-child :nth-of-type ' +
    ':only-child :optional :placeholder-shown :read-only :read-write ' +
    ':required :root :target :valid :visited :where :-moz-focusring ' +
    ':-moz-ui-invalid'
  ).split(' '),
);

export const PSEUDO_ELEMENTS = new Set(
  (
    '::after ::backdrop ::before ::file-selector-button ::first-letter ' +
    '::first-line ::marker ::placeholder ::selection ' +
    '::-webkit-inner-spin-button ::-webkit-outer-spin-button ' +
    '::-webkit-search-cancel-button ::-webkit-search-decoration'
  ).split(' '),
);

// State attributes: the WAI-ARIA 1.2 states and properties, HTML state
// attributes, and the data-* state names used by component libraries. Each
// is listed individually; no prefix is trusted.
export const STATE_ATTRIBUTES = new Set([
  ...(
    'aria-activedescendant aria-atomic aria-autocomplete aria-busy ' +
    'aria-checked aria-colcount aria-colindex aria-colspan aria-controls ' +
    'aria-current aria-describedby aria-details aria-disabled ' +
    'aria-dropeffect aria-errormessage aria-expanded aria-flowto ' +
    'aria-grabbed aria-haspopup aria-hidden aria-invalid aria-keyshortcuts ' +
    'aria-label aria-labelledby aria-level aria-live aria-modal ' +
    'aria-multiline aria-multiselectable aria-orientation aria-owns ' +
    'aria-placeholder aria-posinset aria-pressed aria-readonly ' +
    'aria-relevant aria-required aria-roledescription aria-rowcount ' +
    'aria-rowindex aria-rowspan aria-selected aria-setsize aria-sort ' +
    'aria-valuemax aria-valuemin aria-valuenow aria-valuetext'
  ).split(' '),
  ...(
    'role hidden disabled readonly required checked selected open dir ' +
    'lang inert type placeholder'
  ).split(' '),
  ...(
    'data-hover data-active data-focus data-focus-visible data-disabled ' +
    'data-invalid data-checked data-selected data-expanded data-pressed ' +
    'data-current data-state data-orientation data-placeholder-shown ' +
    'data-loading data-highlighted'
  ).split(' '),
]);

// @font-face descriptors that are not registry property names.
export const DESCRIPTOR_NAMES = new Set(['font-display']);

const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const KEYED_PLACEHOLDER = /^<redacted:[a-z-]+:hmac-sha256:[0-9a-f]{64}>$/;
const SENTINEL = /^__ce_placeholder_(\d+)__$/;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?([a-z%]*)$/i;
const HEX_COLOR = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const IDENT = /^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/;
const OPERATORS = new Set(['+', '-', '*', '/']);
const DIVIDERS = new Set([',', '/', ':']);
const UNICODE_RANGE = /^u\+[0-9a-f?]{1,6}(-[0-9a-f]{1,6})?$/i;

export function loadApproved(record) {
  return new Map(record.identifiers.map((e) => [e.identifier, e]));
}

const keyword = (word) => CSS_KEYWORDS.has(word.toLowerCase());

// A placeholder sentinel is allowed when its original placeholder is keyed,
// or when keyed placeholders are not required (authored data).
function sentinelProblem(word, placeholders, keyed) {
  const sentinel = SENTINEL.exec(word);
  if (sentinel == null) return 'not a placeholder';
  const original = placeholders[Number(sentinel[1])];
  return !keyed || KEYED_PLACEHOLDER.test(original)
    ? null
    : 'placeholder is not keyed (hmac-sha256)';
}

/** Classifies one word token; null when allowed, otherwise the reason. */
function wordProblem(word, approved, placeholders, keyed) {
  if (SENTINEL.test(word)) return sentinelProblem(word, placeholders, keyed);
  if (OPERATORS.has(word)) return null;
  const number = NUMBER.exec(word);
  if (number != null)
    return number[3] === '' || CSS_UNITS.has(number[3].toLowerCase())
      ? null
      : `unit ${number[3]} is not a CSS unit`;
  if (word.startsWith('#'))
    return HEX_COLOR.test(word) ? null : `hash ${word} is not a hex color`;
  if (IDENT.test(word))
    return keyword(word) || approved.has(word)
      ? null
      : `identifier ${word} is not approved`;
  return `token ${word} is not allowed`;
}

// Classifies one parsed node (children are visited separately).
function nodeProblem(node, approved, placeholders, keyed) {
  switch (node.type) {
    case 'space':
      return null;
    case 'div':
      return DIVIDERS.has(node.value) ? null : `separator ${node.value}`;
    case 'word':
      return wordProblem(node.value, approved, placeholders, keyed);
    case 'string': {
      if (node.value === '') return null;
      const problem = sentinelProblem(node.value, placeholders, keyed);
      return problem === 'not a placeholder'
        ? 'quoted string is not a keyed placeholder'
        : problem;
    }
    case 'function':
      return CSS_FUNCTIONS.has(node.value.toLowerCase())
        ? null
        : `function ${node.value} is not a CSS function`;
    case 'unicode-range':
      return UNICODE_RANGE.test(node.value) ? null : 'unicode range';
    case 'comment':
      return 'comment';
    default:
      return `token type ${node.type}`;
  }
}

// Replaces placeholders with sentinel words so the tokenizer sees each as
// one token.
function withSentinels(text) {
  const placeholders = [];
  const masked = text.replace(PLACEHOLDER, (p) => {
    placeholders.push(p);
    return `__ce_placeholder_${placeholders.length - 1}__`;
  });
  return { masked, placeholders };
}

const restore = (text, placeholders) =>
  text.replace(/__ce_placeholder_(\d+)__/g, (_, i) => placeholders[Number(i)]);

/** Problems of every token of a value or condition; empty when publishable. */
export function tokenProblems(text, approved, { keyed = true } = {}) {
  const problems = [];
  const { masked, placeholders } = withSentinels(text);
  const visit = (nodes) => {
    for (const node of nodes) {
      const problem = nodeProblem(node, approved, placeholders, keyed);
      if (problem) problems.push(problem);
      else if (node.type === 'function') visit(node.nodes ?? []);
    }
  };
  visit(valueParser(masked).nodes);
  return problems;
}

/** Word tokens of a value (placeholders excluded), at any depth. */
export function wordsOf(text) {
  const words = [];
  const { masked } = withSentinels(text);
  valueParser(masked).walk((node) => {
    if (node.type === 'word' && !SENTINEL.test(node.value))
      words.push(node.value);
    if (node.type === 'function' && node.value) words.push(node.value);
  });
  return words;
}

const entry = (kind, text, digester) => ({
  kind,
  digest: `${digester.scheme}:${digester.of(text)}`,
});
const placeholderFor = (kind, text, digester) =>
  `<redacted:${kind}:${digester.scheme}:${digester.of(text)}>`;

/** Rewrites a value so that every disallowed token becomes a placeholder. */
export function policeTokens(text, approved, redactions, digester) {
  const { masked, placeholders } = withSentinels(text);
  const parsed = valueParser(masked);
  const keyed = digester.scheme === 'hmac-sha256';
  const visit = (nodes) => {
    for (const node of nodes) {
      if (nodeProblem(node, approved, placeholders, keyed) == null) {
        if (node.type === 'function') visit(node.nodes ?? []);
        continue;
      }
      const original = restore(valueParser.stringify(node), placeholders);
      redactions.push(entry('token', original, digester));
      placeholders.push(placeholderFor('token', original, digester));
      // A comment can touch a word; pad its placeholder so it stays a token.
      const pad = node.type === 'comment' ? ' ' : '';
      node.type = 'word';
      node.value = `${pad}__ce_placeholder_${placeholders.length - 1}__${pad}`;
      delete node.nodes;
      delete node.quote;
      delete node.before;
      delete node.after;
    }
  };
  visit(parsed.nodes);
  return restore(valueParser.stringify(parsed.nodes), placeholders);
}

const QUERY = /^@(media|supports) (.+)$/;
const singleToken = (text, approved) =>
  IDENT.test(text) && (keyword(text) || approved.has(text));

/** Applies the publication policy to one extracted, value-redacted record. */
export function policeRecord(record, approved, digester = PUBLIC_DIGESTER) {
  const redactions = [...record.redactions];
  let property = record.property;
  if (property.startsWith('--') && !approved.has(property)) {
    redactions.push(entry('identifier', property, digester));
    property = `--${placeholderFor('identifier', property, digester)}`;
  }
  const value = policeTokens(record.value, approved, redactions, digester);
  const context = { ...record.context };
  if (context.layer != null && !singleToken(context.layer, approved)) {
    redactions.push(entry('identifier', context.layer, digester));
    context.layer = placeholderFor('identifier', context.layer, digester);
  }
  if (context.atRules != null) {
    context.atRules = context.atRules.map((rule) => {
      const query = QUERY.exec(rule);
      if (query == null) return rule;
      if (tokenProblems(query[2], approved, { keyed: false }).length === 0)
        return rule;
      redactions.push(entry('at-rule-params', query[2], digester));
      return `@${query[1]} ${placeholderFor('at-rule-params', query[2], digester)}`;
    });
  }
  if (context.state != null) {
    const state = { ...context.state };
    let dropped = state.redactedSelectorParts ?? 0;
    for (const [key, list] of [
      ['pseudoClasses', PSEUDO_CLASSES],
      ['pseudoElements', PSEUDO_ELEMENTS],
    ]) {
      if (state[key] == null) continue;
      const kept = state[key].filter((p) => list.has(p));
      dropped += state[key].length - kept.length;
      if (kept.length > 0) state[key] = kept;
      else delete state[key];
    }
    if (dropped > 0) state.redactedSelectorParts = dropped;
    context.state = state;
  }
  return { ...record, property, value, context, redactions };
}

// ---------------------------------------------------------------------------
// Publication check, used by the corpus validator on every published field.

const NON_ASCII = /[^\x20-\x7e]/;
const EMAIL = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/;
const PATH_LIKE =
  /[\w.-]+\/[\w.-]+\/|\.(css|js|mjs|cjs|jsx|ts|tsx|json|html|png|jpe?g|svg|ttf|woff2?|otf|md)\b/i;
const RECORD_FIELDS = new Set([
  'id',
  'property',
  'value',
  'important',
  'context',
  'denominator',
  'excludedReason',
  'redactions',
  'alpha1',
  'composite',
  'registry',
  'flags',
]);
const CONTEXT_FIELDS = new Set([
  'layer',
  'atRules',
  'keyframes',
  'descriptor',
  'state',
  'nestedRules',
]);
const STATE_FIELDS = new Set([
  'pseudoClasses',
  'pseudoElements',
  'attributes',
  'redactedAttributes',
  'redactedSelectorParts',
]);
const REDACTION_KINDS = new Set([
  'url',
  'string',
  'email',
  'uri',
  'opaque',
  'non-ascii-text',
  'identifier',
  'at-rule-params',
  'token',
]);

/** Scans authored free text for URLs, e-mail addresses, paths and non-ASCII. */
export function textProblems(text, allowed = {}) {
  const problems = [];
  let scrubbed = text;
  const exceptions = [...(allowed.urls ?? []), ...(allowed.paths ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  for (const e of exceptions) scrubbed = scrubbed.split(e).join(' ');
  if (NON_ASCII.test(text)) problems.push('non-ASCII text');
  if (/https?:|\/\//i.test(scrubbed)) problems.push('URL');
  if (EMAIL.test(scrubbed)) problems.push('e-mail address');
  if (PATH_LIKE.test(scrubbed)) problems.push('file path');
  return problems;
}

/**
 * Problems of one published consumer declaration; empty when publishable.
 * `registry` maps registry entry names to entries.
 */
export function checkPublishedDeclaration(d, inputId, approved, registry) {
  const problems = [];
  const bad = (what) => problems.push(`${d.id ?? '?'}: ${what}`);
  for (const key of Object.keys(d))
    if (!RECORD_FIELDS.has(key)) bad(`unexpected field ${key}`);
  if (!new RegExp(`^${inputId}#[0-9]{3,4}$`).test(d.id ?? ''))
    bad('id is not an ordinal of its input');
  const property = d.property ?? '';
  if (property.startsWith('--')) {
    if (!approved.has(property) && !KEYED_PLACEHOLDER.test(property.slice(2)))
      bad(`custom property ${property} is neither approved nor redacted`);
  } else if (!registry.has(property) && !DESCRIPTOR_NAMES.has(property))
    bad(`property ${property} is not a registry or descriptor name`);
  for (const problem of tokenProblems(d.value ?? '', approved))
    bad(`value: ${problem}`);
  const c = d.context ?? {};
  for (const key of Object.keys(c))
    if (!CONTEXT_FIELDS.has(key)) bad(`unexpected context field ${key}`);
  if (
    c.layer != null &&
    !singleToken(c.layer, approved) &&
    !KEYED_PLACEHOLDER.test(c.layer)
  )
    bad(`layer ${c.layer} is not approved`);
  for (const rule of c.atRules ?? []) {
    if (rule === '@font-face' || rule === '@keyframes <keyframes-name>')
      continue;
    const query = QUERY.exec(rule);
    if (query == null) {
      bad(`at-rule ${rule} is not a media or supports condition`);
      continue;
    }
    if (KEYED_PLACEHOLDER.test(query[2])) continue;
    for (const problem of tokenProblems(query[2], approved))
      bad(`at-rule: ${problem}`);
  }
  if (c.keyframes != null && c.keyframes !== true) bad('keyframes flag');
  if (c.descriptor != null && c.descriptor !== 'font-face') bad('descriptor');
  if (c.nestedRules != null && !Number.isInteger(c.nestedRules))
    bad('nestedRules');
  const s = c.state ?? {};
  for (const key of Object.keys(s))
    if (!STATE_FIELDS.has(key)) bad(`unexpected state field ${key}`);
  for (const p of s.pseudoClasses ?? [])
    if (!PSEUDO_CLASSES.has(p)) bad(`pseudo-class ${p} is not allow-listed`);
  for (const p of s.pseudoElements ?? [])
    if (!PSEUDO_ELEMENTS.has(p)) bad(`pseudo-element ${p} is not allow-listed`);
  for (const a of s.attributes ?? [])
    if (!STATE_ATTRIBUTES.has(a)) bad(`attribute ${a} is not allow-listed`);
  for (const key of ['redactedAttributes', 'redactedSelectorParts'])
    if (s[key] != null && !Number.isInteger(s[key])) bad(key);
  for (const r of d.redactions ?? []) {
    if (!REDACTION_KINDS.has(r.kind)) bad(`redaction kind ${r.kind}`);
    if (!/^hmac-sha256:[0-9a-f]{64}$/.test(r.digest ?? ''))
      bad('redaction digest is not keyed (hmac-sha256)');
  }
  const reg = d.registry ?? {};
  if (reg.entry != null) {
    const e = registry.get(reg.entry);
    if (
      e == null ||
      reg.fixtureId !== e.proof.fixtureId ||
      reg.requirement !== e.requirement
    )
      bad('registry binding is not a registry entry');
  }
  const text = JSON.stringify(d);
  if (NON_ASCII.test(text)) bad('record carries non-ASCII text');
  if (/<redacted:[a-z-]+:sha256:/.test(text))
    bad('placeholder digest is not keyed (hmac-sha256)');
  return problems;
}
