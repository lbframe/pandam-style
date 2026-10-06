/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export { token } from '../design-system/tokens/ref.js';
export { patternStyles } from '../design-system/patterns/compile.js';

/** A type-oriented identity helper; loading and validation belong to the CLI. */
export function defineConfig(config) {
  return config;
}
