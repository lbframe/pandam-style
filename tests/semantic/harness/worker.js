/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const fs = require('fs');
const { run } = require('./implementation-adapter');
const { project } = require('./projection');
const { cases } = require('../cases');
const [id, lane, output] = process.argv.slice(2);
const spec = cases.find((c) => c.id === id);
if (!spec) throw new Error('Missing semantic case ' + id);
(async () => {
  const result = (await run(spec, lane)).map((raw) =>
    project(raw, spec.observe),
  );
  fs.writeFileSync(output, JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
