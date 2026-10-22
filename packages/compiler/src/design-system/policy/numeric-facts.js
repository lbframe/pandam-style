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

const factsByRegistry = new WeakMap();

/**
 * Records the numeric facts of a registry's token values: tokenId ->
 * frozen list of `{ theme, facts }` (`theme` null for the base value), only
 * the values with facts. Called by buildRegistry with `tokensByText`, the
 * tokens S1 (policy/value-safety.js) already produced for each token text,
 * so a value is tokenized once; a text absent from it is tokenized here.
 */
export function recordNumericFacts(registry, tokensByText = null) {
  const table = new Map();
  const themes = registry.themes ?? {};
  const themeNames = Object.keys(themes).sort();
  for (const tokenId of Object.keys(registry.tokens ?? {})) {
    const entries = [];
    const value = registry.resolvedValues?.[tokenId];
    const base = numericFactsOfValue(value, tokensByText?.get(value) ?? null);
    if (base != null) entries.push(Object.freeze({ theme: null, facts: base }));
    for (const theme of themeNames) {
      if (!Object.hasOwn(themes[theme], tokenId)) continue;
      const themed = themes[theme][tokenId];
      const facts = numericFactsOfValue(
        themed,
        tokensByText?.get(themed) ?? null,
      );
      if (facts != null) entries.push(Object.freeze({ theme, facts }));
    }
    if (entries.length > 0) table.set(tokenId, Object.freeze(entries));
  }
  factsByRegistry.set(registry, table);
  return table;
}

/** The recorded facts of a registry (recorded now for one built elsewhere). */
function factsOf(registry) {
  return factsByRegistry.get(registry) ?? recordNumericFacts(registry);
}

/** The numeric facts of one token: `[{ theme, facts }]`, possibly empty. */
export function numericFactsOf(registry, tokenId) {
  return factsOf(registry).get(tokenId) ?? [];
}

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
 * `token-value-out-of-domain` or `non-finite`. Memoised per registry.
 */
export function tokenValueRefusal(registry, property, tokenId) {
  const scalar = descriptorOf(property)?.scalar ?? null;
  if (scalar == null) return null;
  let byScalar = verdicts.get(registry);
  if (byScalar == null) {
    byScalar = new Map();
    verdicts.set(registry, byScalar);
  }
  let byToken = byScalar.get(scalar);
  if (byToken == null) {
    byToken = new Map();
    byScalar.set(scalar, byToken);
  }
  if (byToken.has(tokenId)) return byToken.get(tokenId);
  const verdict = checkFacts(scalar, numericFactsOf(registry, tokenId));
  byToken.set(tokenId, verdict);
  return verdict;
}

/** The scalar of a property, for diagnostics: `{ constraints, count }`. */
export function scalarOf(property) {
  return descriptorOf(property)?.scalar ?? null;
}
