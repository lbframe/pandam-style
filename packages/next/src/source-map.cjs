/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const path = require('node:path');
const { decode, encode } = require('@jridgewell/sourcemap-codec');

/** Adjust generated coordinates for single-line compiler import literals.
 * Map coordinates use UTF-16 code units, matching generatedImports offsets.
 * The appended stylesheet import is compiler infrastructure and is unmapped.
 */
function transportSourceMap(input, javascript, edits, root) {
  if (input == null) return null;
  const map = typeof input === 'string' ? JSON.parse(input) : input;
  const lines = decode(map.mappings);
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const located = ordered.map((edit) => {
    const prefix = javascript.slice(0, edit.start);
    const line = prefix.split('\n').length - 1;
    const column = edit.start - prefix.lastIndexOf('\n') - 1;
    if (
      javascript.slice(edit.start, edit.end).includes('\n') ||
      edit.replacement.includes('\n')
    )
      throw new Error('Transport import edits must stay on one line.');
    return { ...edit, line, column };
  });
  const adjusted = lines.map((segments, line) => {
    const lineEdits = located.filter((edit) => edit.line === line);
    return segments.flatMap((segment) => {
      let delta = 0;
      for (const edit of lineEdits) {
        if (
          segment[0] > edit.column &&
          segment[0] < edit.column + edit.end - edit.start
        )
          return [];
        if (segment[0] >= edit.column + edit.end - edit.start)
          delta += edit.replacement.length - (edit.end - edit.start);
      }
      return [[segment[0] + delta, ...segment.slice(1)]];
    });
  });
  // Terminate any mapping on the original last line before synthetic imports.
  const originalLines = javascript.split('\n');
  while (adjusted.length < originalLines.length) adjusted.push([]);
  adjusted.push([[0]]);
  return {
    ...map,
    sourceRoot: undefined,
    sources:
      root == null
        ? map.sources
        : map.sources.map((source) =>
            path.resolve(root, map.sourceRoot ?? '', source),
          ),
    mappings: encode(adjusted),
  };
}

module.exports = { transportSourceMap };
