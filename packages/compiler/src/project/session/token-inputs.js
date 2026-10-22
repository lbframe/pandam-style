/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { tokenUseVerdicts } from '../../design-system/policy/numeric-facts';
// Benchmark-only measurement hook: the tokens whose input was recomputed.
import { count } from '../../observability/metrics';

/**
 * The session's file input of every token (CE-02.2): `token:<id>` ->
 * `digest({ category, visibility, variable, verdicts })`.
 *
 * A source transform emits a variable reference and validates category,
 * visibility and existence; since CE-02.2 the token's numeric value decides
 * each use site's verdict, so the verdicts are part of the key (never the
 * value itself: an edit that changes no verdict revalidates nothing). A
 * refusal's `candidates` (the other tokens' verdicts) need no key: a file
 * with diagnostics is compiled again at every revision.
 *
 * `memo` is the previous call's: a token whose inputs (variable, resolved
 * base value and value in every theme, against the same property table and
 * theme list) are all identical (`===`) keeps its previous digest, so an
 * edit recomputes only the tokens it touched; the category is part of the
 * token id. Returns `{ inputs, memo }`; `inputs` equals what a call without
 * a memo returns.
 */
export function tokenFileInputs(designSystem, memo, digest) {
  const registry = designSystem.registry;
  const properties = designSystem.snapshot.properties;
  const themes = registry.themes ?? {};
  const themeNames = Object.keys(themes).sort();
  const previous =
    memo != null &&
    memo.properties === properties &&
    memo.themeNames.length === themeNames.length &&
    memo.themeNames.every((theme, i) => theme === themeNames[i])
      ? memo.byToken
      : null;
  const byToken = new Map();
  const inputs = new Map();
  for (const [tokenId, token] of Object.entries(registry.tokens)) {
    const variable = designSystem.varsByToken[tokenId] ?? null;
    const value = registry.resolvedValues[tokenId];
    const prior = previous?.get(tokenId);
    // Compared in place, no allocation when the token did not change; a
    // theme's entry is its value for the token, or null.
    let same =
      prior !== undefined &&
      prior.visibility === token.visibility &&
      prior.variable === variable &&
      prior.value === value;
    for (let i = 0; same && i < themeNames.length; i++) {
      const forTheme = themes[themeNames[i]];
      const v = Object.hasOwn(forTheme, tokenId) ? forTheme[tokenId] : null;
      same = v === prior.themed[i];
    }
    let record = prior;
    if (!same) {
      count('token_inputs_recomputed');
      record = {
        visibility: token.visibility,
        variable,
        value,
        themed: themeNames.map((theme) =>
          Object.hasOwn(themes[theme], tokenId) ? themes[theme][tokenId] : null,
        ),
        digest: digest({
          category: token.category,
          visibility: token.visibility,
          variable,
          verdicts: tokenUseVerdicts(registry, tokenId, properties),
        }),
      };
    }
    byToken.set(tokenId, record);
    inputs.set(tokenId, record.digest);
  }
  return { inputs, memo: { properties, themeNames, byToken } };
}
