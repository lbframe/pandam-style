/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { transportSourceMap } from '../../src/source-map.cjs';
const require = createRequire(import.meta.url);
const { encode, decode } = require('@jridgewell/sourcemap-codec');

test('transport maps adjust multiple import edits, UTF16 columns and leave injected CSS unmapped', () => {
  const code =
    'const label = "🧪"; import "a"; import "b"; throw new Error("marker");';
  const first = code.indexOf('"a"');
  const second = code.indexOf('"b"');
  const marker = code.indexOf('throw');
  const map = {
    version: 3,
    sources: ['src/page.tsx'],
    sourcesContent: ['original source'],
    names: [],
    mappings: encode([
      [
        [0, 0, 0, 0],
        [first, 0, 1, 2],
        [first + 1, 0, 1, 3],
        [second, 0, 2, 2],
        [marker, 0, 3, 2],
      ],
    ]),
  };
  const edits = [
    { start: second, end: second + 3, replacement: '"long-snapshot-b"' },
    { start: first, end: first + 3, replacement: '"snapshot-a"' },
  ];
  const result = transportSourceMap(JSON.stringify(map), code, edits, '/app');
  const mappings = decode(result.mappings);
  assert.deepEqual(result.sources, ['/app/src/page.tsx']);
  assert.deepEqual(result.sourcesContent, map.sourcesContent);
  assert.equal(mappings[0].length, 4);
  assert.equal(mappings[0][2][0], second + edits[1].replacement.length - 3);
  assert.deepEqual(mappings[0][3], [
    marker +
      edits.reduce((total, edit) => total + edit.replacement.length - 3, 0),
    0,
    3,
    2,
  ]);
  assert.deepEqual(mappings[1], [[0]]);
  assert.equal(transportSourceMap(null, code, edits, '/app'), null);
});
