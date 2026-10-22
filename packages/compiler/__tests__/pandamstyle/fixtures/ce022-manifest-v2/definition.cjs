/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One small design system, built by the CE-02.1 compiler (the committed
// fixture) and by the current compiler (the test), for the manifest v2 reader.
module.exports = {
  systemId: 'ce022-manifest-v2',
  conditions: { hover: ':hover' },
  tokens: {
    spacing: { sm: { value: '8px', visibility: 'public' } },
    colors: { text: { value: '#111111', visibility: 'public' } },
  },
};
