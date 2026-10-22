/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - numeric facts of token values (CE-02.2 §3.5).
 *
 * A token admitted by its category can still carry a number its property
 * cannot take: a `-4px` spacing token is a valid margin and an invalid
 * padding. At registry build, each base value and each theme's resolved value
 * is tokenized once (CSS Syntax 3, `@csstools/css-tokenizer`) into its numeric
 * facts: null when the value is not a whitespace-separated list of numeric
 * tokens (`calc()`, colors and mixed lists are unchecked until CE-03 typed
 * category grammar), else the list of `{ value, unit }` components with the
 * decoded number, so magnitude, bounds and precision are checkable. A single
 * `nan`/`infinity`/`-infinity` identifier is the non-finite fact.
 *
 * At use, every component, in the base and in every theme, must satisfy the
 * row's `scalar` (policy/descriptors.js): its component count, units, bounds,
 * 4 fraction digits and |v| <= 1e6. The facts are derived data: a WeakMap
 * keyed by the registry, never stored in the registry, the snapshot or a
 * digest (their input values are already in the registry digest payload).
 */

import { tokenize } from '@csstools/css-tokenizer';
import { descriptorOf } from './descriptors';
import { componentReason } from './literals';

/** The fact of a single non-finite identifier (`NaN`, `Infinity`). */
export const NON_FINITE = Object.freeze({ nonFinite: true });
const NON_FINITE_NAMES = new Set(['nan', 'infinity', '-infinity']);

/** The numeric facts of one value text, or null (an unchecked shape). */
export function numericFactsOfValue(text, tokens = null) {
  if (typeof text !== 'string') return null;
  const components = [];
  let nonFinite = false;
  for (const token of tokens ?? tokenize({ css: text })) {
    const [type, , , , data] = token;
    if (type === 'whitespace-token' || type === 'EOF-token') continue;
    if (type === 'number-token') {
      components.push(Object.freeze({ value: data.value, unit: null }));
    } else if (type === 'percentage-token') {
      components.push(Object.freeze({ value: data.value, unit: '%' }));
    } else if (type === 'dimension-token') {
      components.push(
        Object.freeze({ value: data.value, unit: data.unit.toLowerCase() }),
      );
    } else if (
      type === 'ident-token' &&
      NON_FINITE_NAMES.has(String(data.value).toLowerCase())
    ) {
      nonFinite = true;
      components.push(null);
    } else {
      return null;
    }
  }
  if (components.length === 0) return null;
  if (nonFinite) return components.length === 1 ? NON_FINITE : null;
  return Object.freeze(components);
}

// registry -> where its token facts come from and the facts derived so far.
const factsByRegistry = new WeakMap();

/**
 * Records where a registry's numeric facts come from; a token's facts,
 * a frozen list of `{ theme, facts }` (`theme` null for the base value; only
 * the values with facts), are derived on its first use (numericFactsOf), so
 * a rebuild derives them only for the tokens whose use sites are checked
 * again. Called by buildRegistry with `inspect`, its S1 inspector
 * (policy/value-safety.js `authorTextInspector`), whose tokens the facts
 * reuse: a token value is tokenized once, at registry build; without it a
 * text is tokenized here. With `holder` (`{ facts, entries }`, kept by the
 * caller across builds), the facts of a text the previous build derived are
 * reused, and so is a token's entry list when its themes and facts are the
 * same, which keeps the token's use-site verdicts (tokenValueRefusal); the
 * new maps keep only this build's texts and tokens. Facts are frozen and a
 * pure function of the text.
 */
export function recordNumericFacts(registry, inspect = null, holder = null) {
  const record = {
    inspect,
    previousFacts: holder?.facts ?? null,
    previousEntries: holder?.entries ?? null,
    facts: new Map(),
    entries: new Map(),
    themeNames: Object.keys(registry.themes ?? {}).sort(),
  };
  if (holder != null) {
    holder.facts = record.facts;
    holder.entries = record.entries;
  }
  factsByRegistry.set(registry, record);
  return record;
}

function factsOfText(record, text) {
  if (typeof text !== 'string') return numericFactsOfValue(text);
  let facts = record.facts.get(text);
  if (facts !== undefined) return facts;
  facts = record.previousFacts?.get(text);
  if (facts === undefined) {
    const inspected = record.inspect?.(text, 'value') ?? null;
    facts = numericFactsOfValue(
      text,
      inspected?.unsafe == null ? (inspected?.tokens ?? null) : null,
    );
  }
  record.facts.set(text, facts);
  return facts;
}

const NO_FACTS = Object.freeze([]);

/** The numeric facts of one token: `[{ theme, facts }]`, possibly empty. */
export function numericFactsOf(registry, tokenId) {
  // A registry built elsewhere: recorded now, without an inspector.
  const record = factsByRegistry.get(registry) ?? recordNumericFacts(registry);
  let kept = record.entries.get(tokenId);
  if (kept !== undefined) return kept;
  if (!Object.hasOwn(registry.tokens ?? {}, tokenId)) return NO_FACTS;
  const entries = [];
  const base = factsOfText(record, registry.resolvedValues?.[tokenId]);
  if (base != null) entries.push(Object.freeze({ theme: null, facts: base }));
  const themes = registry.themes ?? {};
  for (const theme of record.themeNames) {
    if (!Object.hasOwn(themes[theme], tokenId)) continue;
    const facts = factsOfText(record, themes[theme][tokenId]);
    if (facts != null) entries.push(Object.freeze({ theme, facts }));
  }
  const prior = record.previousEntries?.get(tokenId);
  kept =
    entries.length === 0
      ? NO_FACTS
      : prior != null &&
          prior.length === entries.length &&
          prior.every(
            (e, i) =>
              e.theme === entries[i].theme && e.facts === entries[i].facts,
          )
        ? prior
        : Object.freeze(entries);
  record.entries.set(tokenId, kept);
  return kept;
}

// A verdict is a pure function of the scalar and the token's frozen entry
// list: entries -> scalar -> verdict, shared by the registries that kept the
// same list.
const verdicts = new WeakMap();

function checkFacts(scalar, entries) {
  for (const { theme, facts } of entries) {
    if (facts === NON_FINITE) {
      return { reason: 'non-finite', theme, component: 0 };
    }
    const [min, max] = scalar.count;
    if (facts.length < min || facts.length > max) {
      return {
        reason: 'token-value-out-of-domain',
        theme,
        cause: 'component-count',
        count: facts.length,
      };
    }
    for (let i = 0; i < facts.length; i++) {
      const cause = componentReason(scalar.constraints, facts[i]);
      if (cause != null) {
        return {
          reason:
            cause === 'non-finite' ? 'non-finite' : 'token-value-out-of-domain',
          theme,
          component: i,
          cause,
        };
      }
    }
  }
  return null;
}

/**
 * Why a token's value cannot be used on a property (CE-02.2 §3.5), or null.
 * `{ reason, theme, component?, cause?, count? }`; `reason` is
 * `token-value-out-of-domain` or `non-finite`. Memoised per entry list and
 * scalar, so a rebuild that kept a token's entries reuses its verdicts.
 */
export function tokenValueRefusal(registry, property, tokenId) {
  const scalar = descriptorOf(property)?.scalar ?? null;
  if (scalar == null) return null;
  const entries = numericFactsOf(registry, tokenId);
  let byScalar = verdicts.get(entries);
  if (byScalar == null) {
    byScalar = new Map();
    verdicts.set(entries, byScalar);
  }
  if (byScalar.has(scalar)) return byScalar.get(scalar);
  const verdict = checkFacts(scalar, entries);
  byScalar.set(scalar, verdict);
  return verdict;
}

// properties table -> category -> the token's use contexts: one property per
// distinct scalar among the effective rows that admit the category, in key
// order.
const contextsByTable = new WeakMap();

export function useContextsOf(properties, category) {
  let byCategory = contextsByTable.get(properties);
  if (byCategory == null) {
    byCategory = new Map();
    contextsByTable.set(properties, byCategory);
  }
  let contexts = byCategory.get(category);
  if (contexts === undefined) {
    const seen = new Set();
    contexts = [];
    for (const key of Object.keys(properties.descriptors).sort()) {
      if (!properties.descriptors[key].domain?.tokens?.includes(category)) {
        continue;
      }
      const scalar = descriptorOf(key)?.scalar ?? null;
      if (scalar == null) continue;
      const shape = JSON.stringify(scalar);
      if (seen.has(shape)) continue;
      seen.add(shape);
      contexts.push(key);
    }
    contexts = Object.freeze(contexts);
    byCategory.set(category, contexts);
  }
  return contexts;
}

// use contexts -> entries -> key, both held weakly: a kept entry list keeps
// its key, and a context list (owned by its property table) is released
// with the table, never retained by a permanent entry list (NO_FACTS).
const verdictKeys = new WeakMap();

/**
 * The use-site verdicts of a token (CE-02.2 §3.5), as a compact key: its
 * tokenValueRefusal result for each distinct scalar among the effective
 * properties (`properties`, the snapshot's table) that admit its category;
 * null when no such property has a scalar. Equal keys mean every use site
 * of the token has the same verdict and diagnostic; a Project Service
 * session keys a file's dependency on the token by it, so an edit that
 * changes no verdict revalidates nothing and one that does revalidates the
 * files using the token.
 */
export function tokenUseVerdicts(registry, tokenId, properties) {
  const token = registry.tokens?.[tokenId];
  if (token == null) return null;
  const contexts = useContextsOf(properties, token.category);
  if (contexts.length === 0) return null;
  const entries = numericFactsOf(registry, tokenId);
  let byEntries = verdictKeys.get(contexts);
  if (byEntries == null) {
    byEntries = new WeakMap();
    verdictKeys.set(contexts, byEntries);
  }
  let key = byEntries.get(entries);
  if (key === undefined) {
    key = JSON.stringify(
      contexts.map((property) =>
        tokenValueRefusal(registry, property, tokenId),
      ),
    );
    byEntries.set(entries, key);
  }
  return key;
}

/** The scalar of a property, for diagnostics: `{ constraints, count }`. */
export function scalarOf(property) {
  return descriptorOf(property)?.scalar ?? null;
}
