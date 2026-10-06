/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * This file is derived from the MIT-licensed StyleX 0.19.1
 * `packages/@stylexjs/babel-plugin/src/shared/utils/default-options.js`.
 * The supported PandamStyle subset is kept deliberately small.
 */

export const defaultOptions = Object.freeze({
  classNamePrefix: 'x',
  debug: false,
  enableFontSizePxToRem: false,
  enableLegacyValueFlipping: false,
  enableLogicalStylesPolyfill: false,
  enableMediaQueryOrder: true,
  enableMinifiedKeys: true,
  propertyValidationMode: 'silent',
  styleResolution: 'property-specificity',
});
