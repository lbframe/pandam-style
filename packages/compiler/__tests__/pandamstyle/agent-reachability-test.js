/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 §5.3 (a): the agent layer stays off the session and compile path
 * (I8). The published entries reach exactly the committed allowlist of `src/`
 * modules, and no module matching a forbidden glob.
 *
 * The data file is the review surface: adding an entry or a forbidden glob is
 * a data change. Regenerate the allowlist only with
 * `PMS_UPDATE_REACHABILITY=1`, and review its diff.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { matchesGlob, reachableSourceModules } = require('./reachability');

jest.setTimeout(300000);

const DATA = path.join(__dirname, 'reachability.v1.json');

describe('AG-01.1 reachability of the published entries (§5.3 a, I8)', () => {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const reached = reachableSourceModules(Object.keys(data.entries));

  test('the data file is well formed', () => {
    expect(data.schemaVersion).toBe(1);
    expect(Object.keys(data.entries).length).toBeGreaterThan(0);
    expect(data.forbidden).toEqual(
      expect.arrayContaining(['src/agent/**', 'src/protocol/envelope.js']),
    );
  });

  test('no entry reaches a forbidden module', () => {
    for (const [entry, modules] of Object.entries(reached)) {
      const forbidden = modules.filter((file) =>
        data.forbidden.some((glob) => matchesGlob(file, glob)),
      );
      expect({ entry, forbidden }).toEqual({ entry, forbidden: [] });
    }
  });

  test('each entry reaches exactly its committed allowlist', () => {
    if (process.env.PMS_UPDATE_REACHABILITY === '1') {
      fs.writeFileSync(
        DATA,
        `${JSON.stringify({ ...data, entries: reached }, null, 2)}\n`,
      );
    }
    for (const [entry, allowlist] of Object.entries(data.entries))
      expect({ entry, modules: reached[entry] }).toEqual({
        entry,
        modules: allowlist,
      });
  });

  test('the glob matcher', () => {
    expect(matchesGlob('src/agent/registry.js', 'src/agent/**')).toBe(true);
    expect(matchesGlob('src/agentx.js', 'src/agent/**')).toBe(false);
    expect(
      matchesGlob('src/protocol/envelope.js', 'src/protocol/envelope.js'),
    ).toBe(true);
  });
});
