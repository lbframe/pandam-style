/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Publication policy for declarations extracted from private consumer
// stylesheets. Only CSS language vocabulary and explicitly approved consumer
// identifiers may appear in clear; every other identifier is replaced by a
// digest placeholder at extraction, and checkPublishedDeclaration() rejects
// any published record that still carries one. The same rules apply to every
// field: property, value, layer, at-rule parameters and selector state.

import { CSS_COLOR_KEYWORDS } from './css-colors.mjs';
import { PLACEHOLDER_SOURCE, PUBLIC_DIGESTER } from './digest.mjs';

// CSS keywords, function names, units-free media features and generic font
// families that appear in measured or authored stylesheets. Language
// vocabulary, not consumer identifiers.
export const CSS_VOCABULARY = new Set([
  ...CSS_COLOR_KEYWORDS,
  ...(
    'absolute all alternate antialiased anywhere auto auto-fill auto-fit ' +
    'avoid background background-color balance baseline block bold bolder ' +
    'border-box border-color both bottom box-shadow break-word button calc ' +
    'center circle clip collapse color color-mix column column-reverse ' +
    'contain content-box cover cubic-bezier dashed decimal default disc ' +
    'dotted ease ease-in ease-in-out ease-out ellipsis end fit-content fixed ' +
    'flex flex-end flex-start format forwards grayscale grid hidden ' +
    'horizontal in infinite inherit initial inline inline-block inline-flex ' +
    'inline-grid inset italic justify left light linear linear-gradient ' +
    'list-item manipulation max max-content middle min min-content minmax ' +
    'mixed monospace multiply no-drag no-repeat none normal not-allowed ' +
    'nowrap oklab oklch optimizelegibility outside over padding-box ' +
    'pixelated pointer pre pre-line pre-wrap pretty progress proximity ' +
    'radial-gradient rect relative repeat revert rgba right rotate round ' +
    'row row-reverse sans-serif scale scroll separate serif smooth solid ' +
    'space-around space-between square stable start static sticky stretch ' +
    'strict swap system-ui tabular-nums text text-bottom text-top top ' +
    'transform translate translatex translatey translatez transparent ' +
    'ui-monospace ui-sans-serif ui-serif underline unset uppercase url var ' +
    'vertical vertical-rl visible wrap x y'
  ).split(' '),
  // Media and supports query vocabulary.
  ...(
    'and not only or screen print all-media min-width max-width width ' +
    'height min-height max-height prefers-reduced-motion reduce ' +
    'no-preference prefers-contrast more less forced-colors active hover ' +
    'pointer coarse fine prefers-color-scheme dark contain-intrinsic-size ' +
    'orientation landscape portrait'
  ).split(' '),
  // Vendor platform keywords used by preflight stylesheets.
  ...'-apple-system -webkit-appearance -apple-pay-button'.split(' '),
]);

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

export const STATE_ATTRIBUTE =
  /^(aria-[a-z]+|role|hidden|disabled|readonly|required|checked|selected|open|dir|lang|inert|type|placeholder|data-(hover|active|focus|focus-visible|disabled|invalid|checked|selected|expanded|pressed|current|state|orientation|placeholder-shown|loading|highlighted))$/;

const PLACEHOLDER = new RegExp(PLACEHOLDER_SOURCE, 'g');
const HEX = '[0-9a-f]{64}';
// Consumer placeholders must be keyed; plain SHA-256 is for authored data.
const CONSUMER_PLACEHOLDER = /<redacted:[a-z-]+:hmac-sha256:[0-9a-f]{64}>/g;
// Identifiers: not preceded by a word character, `#`, `.` or `-` (so units,
// hex colors and decimals are not identifiers).
const IDENTIFIER = /(?<![\w#.-])-{0,2}[A-Za-z_][\w-]*/g;

export function identifiersOf(text) {
  return [...text.replace(PLACEHOLDER, ' ').matchAll(IDENTIFIER)].map(
    (m) => m[0],
  );
}

export function loadApproved(record) {
  return new Map(record.identifiers.map((e) => [e.identifier, e]));
}

const known = (identifier, approved) =>
  CSS_VOCABULARY.has(identifier.toLowerCase()) || approved.has(identifier);

const placeholderFor = (identifier, digester) =>
  `<redacted:identifier:${digester.scheme}:${digester.of(identifier)}>`;
const entry = (kind, text, digester) => ({
  kind,
  digest: `${digester.scheme}:${digester.of(text)}`,
});

function redactText(text, approved, redactions, digester) {
  return text
    .replace(PLACEHOLDER, (p) => `\u0000${p}\u0000`)
    .split('\u0000')
    .map((part) =>
      part.startsWith('<redacted:')
        ? part
        : part.replace(IDENTIFIER, (identifier) => {
            if (known(identifier, approved)) return identifier;
            redactions.push(entry('identifier', identifier, digester));
            return placeholderFor(identifier, digester);
          }),
    )
    .join('');
}

const QUERY = /^@(media|supports) (.+)$/;

/** Applies the identifier policy to one extracted, value-redacted record. */
export function applyIdentifierPolicy(
  record,
  approved,
  digester = PUBLIC_DIGESTER,
) {
  const redactions = [...record.redactions];
  const property =
    record.property.startsWith('--') && !approved.has(record.property)
      ? `--${placeholderFor(record.property, digester)}`
      : record.property;
  if (property !== record.property)
    redactions.push(entry('identifier', record.property, digester));
  const value = redactText(record.value, approved, redactions, digester);
  const context = { ...record.context };
  if (context.layer != null && !known(context.layer, approved)) {
    redactions.push(entry('identifier', context.layer, digester));
    context.layer = placeholderFor(context.layer, digester);
  }
  if (context.atRules != null) {
    context.atRules = context.atRules.map((rule) => {
      const query = QUERY.exec(rule);
      if (query == null) return rule;
      const clean = identifiersOf(query[2]).every((i) => known(i, approved));
      if (clean && !/[:/@'"]{2}|https?:|url\(/i.test(query[2])) return rule;
      redactions.push(entry('at-rule-params', query[2], digester));
      return `@${query[1]} <redacted:at-rule-params:${digester.scheme}:${digester.of(query[2])}>`;
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

/** Scans free text for URLs, e-mail addresses, paths and non-ASCII. */
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

/** Problems of one published consumer declaration; empty when publishable. */
export function checkPublishedDeclaration(d, inputId, approved) {
  const problems = [];
  const bad = (what) => problems.push(`${d.id ?? '?'}: ${what}`);
  for (const key of Object.keys(d))
    if (!RECORD_FIELDS.has(key)) bad(`unexpected field ${key}`);
  if (!new RegExp(`^${inputId}#[0-9]{3,4}$`).test(d.id ?? ''))
    bad('id is not an ordinal of its input');
  const property = d.property ?? '';
  if (property.startsWith('--')) {
    if (
      !approved.has(property) &&
      !new RegExp(`^--<redacted:identifier:hmac-sha256:${HEX}>$`).test(property)
    )
      bad(`custom property ${property} is neither approved nor redacted`);
  } else if (!/^-?[a-z][a-z-]*$/.test(property))
    bad('property is not a CSS name');
  const value = d.value ?? '';
  for (const problem of textProblems(value)) bad(`value carries ${problem}`);
  const scrubbed = value
    .replace(new RegExp(`url\\(<redacted:url:hmac-sha256:${HEX}>\\)`, 'g'), '')
    .replace(new RegExp(`"<redacted:[a-z-]+:hmac-sha256:${HEX}>"`, 'g'), '')
    .replace(CONSUMER_PLACEHOLDER, '')
    .replace(/""|''/g, '');
  if (/["'<>@\\]|url\(/.test(scrubbed)) bad('value carries unredacted text');
  for (const i of identifiersOf(value))
    if (!known(i, approved)) bad(`value identifier ${i} is not approved`);
  const c = d.context ?? {};
  for (const key of Object.keys(c))
    if (!CONTEXT_FIELDS.has(key)) bad(`unexpected context field ${key}`);
  if (
    c.layer != null &&
    !known(c.layer, approved) &&
    !new RegExp(`^<redacted:identifier:hmac-sha256:${HEX}>$`).test(c.layer)
  )
    bad(`layer ${c.layer} is not approved`);
  for (const rule of c.atRules ?? []) {
    const query = QUERY.exec(rule);
    if (rule === '@font-face' || rule === '@keyframes <keyframes-name>')
      continue;
    if (query == null) {
      bad(`at-rule ${rule} is not a media or supports condition`);
      continue;
    }
    if (
      new RegExp(`^<redacted:at-rule-params:hmac-sha256:${HEX}>$`).test(
        query[2],
      )
    )
      continue;
    if (textProblems(query[2]).length || /[@'"]/.test(query[2]))
      bad('at-rule parameters carry unredacted text');
    for (const i of identifiersOf(query[2]))
      if (!known(i, approved)) bad(`at-rule identifier ${i} is not approved`);
  }
  const s = c.state ?? {};
  for (const key of Object.keys(s))
    if (!STATE_FIELDS.has(key)) bad(`unexpected state field ${key}`);
  for (const p of s.pseudoClasses ?? [])
    if (!PSEUDO_CLASSES.has(p)) bad(`pseudo-class ${p} is not allow-listed`);
  for (const p of s.pseudoElements ?? [])
    if (!PSEUDO_ELEMENTS.has(p)) bad(`pseudo-element ${p} is not allow-listed`);
  for (const a of s.attributes ?? [])
    if (!STATE_ATTRIBUTE.test(a)) bad(`attribute ${a} is not allow-listed`);
  const text = JSON.stringify(d);
  if (NON_ASCII.test(text)) bad('record carries non-ASCII text');
  if (/<redacted:[a-z-]+:sha256:/.test(text))
    bad('placeholder digest is not keyed (hmac-sha256)');
  for (const r of d.redactions ?? [])
    if (!/^hmac-sha256:[0-9a-f]{64}$/.test(r.digest ?? ''))
      bad('redaction digest is not keyed (hmac-sha256)');
  return problems;
}
