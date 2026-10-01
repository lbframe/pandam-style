/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - consumer runtime.
 *
 * TEMPORARY PHASE 2 INTEGRATION SEAM: this small bridge remains only so the
 * Phase 3 branch can qualify against the parallel core branch's base. After
 * reconciliation, generated modules import `@pandamstyle/core` directly and
 * this file plus the compiler `/runtime` subpath are removed.
 *
 * ARC-02 / architecture section 3: this module MUST NOT import the config
 * loader, the full registry, the CSS validator, Babel, or the generation
 * modules. Its only dependency is `recipe-select`, itself reduced to
 * `diagnostics` (import-free). It contains no CSS object interpreter: it only
 * handles already-compiled references and a finite selection.
 *
 * Selection helpers never inject a new stylesheet: the CSS was extracted
 * statically at build time.
 */

import { selectRecipeRefs } from './recipe-select.js';

export { selectRecipeRefs };
export {
  PmsError,
  Codes,
  formatDiagnostic,
} from '../../../compiler/src/protocol/diagnostics.js';

/**
 * Builds a recipe selector bound to its finite data.
 * `spec` is produced by the build: base, precompiled branches, axis order and
 * defaults. No combinatorial expansion happens at runtime.
 */
export function defineRecipeSelector(spec) {
  return function recipeSelector(props) {
    return selectRecipeRefs(spec, props);
  };
}

/** Utility re-export: composition is done by the fork runtime only. */
export function composeRefs(refs) {
  return refs;
}
