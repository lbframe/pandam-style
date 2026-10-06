/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - token reference (ARC-06: IR TokenRef).
 *
 * Two deliberately separate marks:
 *
 * 1. `TOKEN_REF` (`Symbol.for`) - the *author* mark. Produced by `token(path)`
 *    and used by design-system definitions (tokens, recipes). A page file must
 *    not be able to obtain it: the `pandamstyle/token` subpath is a private
 *    path refused to consumption (PMS_FORBIDDEN_IMPORT).
 *
 * 2. `COMPILER_TOKEN_REF` (`Symbol`, module-local) - the *compiler* mark. The
 *    compiler stamps the reference itself, and only when it recognized a
 *    `token(...)` call whose binding and module are the generated design
 *    system. A page object imitating the internal shape
 *    (`{ [Symbol.for('pandamstyle.tokenRef')]: 'colors.blue.500' }`) therefore
 *    carries no proof and is treated as a raw value.
 */

const TOKEN_REF = Symbol.for('pandamstyle.tokenRef');
const COMPILER_TOKEN_REF = Symbol('pandamstyle.compilerTokenRef');

export function token(path) {
  if (typeof path !== 'string' || path === '') {
    throw new Error('token(path) expects a full path, e.g. spacing.md');
  }
  return Object.freeze({ [TOKEN_REF]: path });
}

export function isTokenRef(value) {
  return (
    value !== null && typeof value === 'object' && TOKEN_REF in value === true
  );
}

export function tokenRefPath(value) {
  return value[TOKEN_REF];
}

/**
 * Stamps a compiler-trusted TokenRef. Reserved for the compilation pipeline:
 * the only way a page obtains proof.
 */
export function mintTokenRef(path) {
  if (typeof path !== 'string' || path === '') {
    throw new Error('mintTokenRef expects a non-empty token path.');
  }
  return Object.freeze({ [COMPILER_TOKEN_REF]: path });
}

export function isCompilerTokenRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    COMPILER_TOKEN_REF in value === true
  );
}

export function compilerTokenRefPath(value) {
  return value[COMPILER_TOKEN_REF];
}

/**
 * Extracts a token path for the expected trust level.
 *
 * `refKind: 'compiler'` accepts ONLY the compiler mark: that is the mode used
 * for every compiled page. `'author'` additionally accepts the `token()` mark
 * and is used only for the design system itself. The default is `compiler`:
 * failing closed is the default.
 */
export function tokenPathOf(value, refKind = 'compiler') {
  if (value === null || typeof value !== 'object') return null;
  if (refKind === 'author') {
    if (TOKEN_REF in value) return value[TOKEN_REF];
  }
  if (COMPILER_TOKEN_REF in value) return value[COMPILER_TOKEN_REF];
  return null;
}
