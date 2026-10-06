/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Node loader transport only; this module never becomes application code.
module.exports = function pandamStyleLoader(source) {
  const callback = this.async();
  const options = this.getOptions();
  import('./state.js')
    .then(({ transportSource }) =>
      transportSource({
        ...options,
        file: this.resourcePath,
        source: String(source),
        withSourceMap: true,
        addDependency: (file) => this.addDependency(file),
        addContextDependency: (file) => this.addContextDependency(file),
      }),
    )
    .then(
      ({ code, map }) => callback(null, code, map),
      (error) => {
        if (error.code === 'PMS_STALE_REVISION') this.cacheable(false);
        callback(error);
      },
    );
};
