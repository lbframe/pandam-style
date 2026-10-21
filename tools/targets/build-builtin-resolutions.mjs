/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.1 built-in profile resolutions.
//
//   node tools/targets/build-builtin-resolutions.mjs [--check]
//
// Resolves every built-in profile query with the pinned Browserslist and the
// fixed options, and writes the lists with the identities (version and
// digest) of the data packages that produced them. At run time a list is used
// only when the loaded packages have exactly these identities, so built-in
// profiles do not load Browserslist; anything else resolves live. `--check`
// re-derives the file and requires byte identity. Run after `yarn build`.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
export const OUT = path.join(
  REPO,
  'packages/compiler/src/targets/profiles/builtin-resolutions.v1.json',
);
const require = createRequire(import.meta.url);

export function builtinResolutions() {
  const { targets } = require(
    path.join(REPO, '.pms-test-support/compiler-inspection.cjs'),
  );
  const { packages, pinned } = targets.dataPackages();
  if (!pinned) {
    throw new Error('the loaded data packages are not the exact pins');
  }
  const profiles = {};
  for (const ref of targets.BUILTIN_PROFILE_REFS) {
    const { query } = targets.BUILTIN_PROFILES[ref];
    profiles[ref] = { query, browsers: targets.liveBrowsers(query) };
  }
  return {
    kind: 'pandamstyle-builtin-resolutions',
    schemaVersion: 1,
    generatedBy: 'tools/targets/build-builtin-resolutions.mjs',
    browserslistOptions: {
      ...targets.BROWSERSLIST_OPTIONS,
      stats: 'fixed-empty',
    },
    data: packages,
    profiles,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = JSON.stringify(builtinResolutions(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (committed !== text) {
      process.stderr.write(
        `${path.relative(REPO, OUT)} does not re-derive from the pinned Browserslist\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write('built-in resolutions re-derive byte for byte\n');
    }
  } else {
    fs.writeFileSync(OUT, text);
    process.stdout.write(`wrote ${path.relative(REPO, OUT)}\n`);
  }
}
