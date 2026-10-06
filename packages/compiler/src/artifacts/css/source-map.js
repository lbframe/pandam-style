/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const alphabet =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value) {
  let number = value < 0 ? -value * 2 + 1 : value * 2;
  let result = '';
  do {
    const digit = number % 32;
    number = Math.floor(number / 32);
    result += alphabet[digit + (number > 0 ? 32 : 0)];
  } while (number > 0);
  return result;
}

/** Map extracted selectors to their enclosing authored create() call.
 * Config-generated CSS and synthetic wrappers deliberately remain unmapped.
 * Sources/content come from the exact compiled source map, including overlays.
 */
export function cssSourceMap(css, contributions) {
  const sources = [];
  const sourcesContent = [];
  const origins = new Map();
  for (const contribution of contributions) {
    if (!contribution?.sourceMap || !contribution.ruleOrigins?.length) continue;
    const map = JSON.parse(contribution.sourceMap);
    const sourceIndex = sources.length;
    sources.push(map.sources[0]);
    sourcesContent.push(map.sourcesContent[0]);
    for (const origin of contribution.ruleOrigins) {
      // Deduplicated rules can have multiple authors. The first covered owner
      // is a real origin; we do not claim an arbitrary declaration coordinate.
      if (!origins.has(origin.className))
        origins.set(origin.className, { ...origin, sourceIndex });
    }
  }
  let source = 0;
  let line = 0;
  let column = 0;
  const mappings = css
    .split('\n')
    .map((text) => {
      let generatedColumn = 0;
      const segments = [];
      const selectors = /\.([a-zA-Z_][\w-]*)/g;
      for (const match of text.matchAll(selectors)) {
        const origin = origins.get(match[1]);
        if (origin == null) continue;
        segments.push(
          [
            match.index - generatedColumn,
            origin.sourceIndex - source,
            origin.line - 1 - line,
            origin.column - column,
          ]
            .map(vlq)
            .join(''),
        );
        generatedColumn = match.index;
        source = origin.sourceIndex;
        line = origin.line - 1;
        column = origin.column;
        segments.push(vlq(match[0].length));
        generatedColumn += match[0].length;
      }
      return segments.join(',');
    })
    .join(';');
  return JSON.stringify({
    version: 3,
    file: 'styles.css',
    sources,
    sourcesContent,
    names: [],
    mappings,
  });
}
