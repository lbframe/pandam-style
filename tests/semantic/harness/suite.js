/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const { cases } = require('../cases');
const { runCase } = require('./run-case');
function suite(area) {
  describe('Semantic oracle: ' + area, () => {
    for (const spec of cases.filter((c) => c.area === area)) {
      test(spec.id + ' — ' + spec.title, () => {
        runCase(spec);
      });
    }
  });
}
module.exports = { suite };
