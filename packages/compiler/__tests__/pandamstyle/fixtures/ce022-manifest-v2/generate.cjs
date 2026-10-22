/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Generates the CE-02.1 artifact set the CE-02.2 manifest v2 reader test
// reads (manifest-v2-reader-test.js):
//
//   node generate.cjs <compiler-inspection.cjs> <source commit> > ce021-artifact-set.json
//
// <compiler-inspection.cjs> is the built inspection bundle of a CE-02.1
// checkout (`yarn build` at the commit named). The definition is
// `definition.cjs`, shared with the test, so both sets describe one system.

const path = require('path');

const [bundle, commit] = process.argv.slice(2);
if (bundle == null || commit == null) {
  process.stderr.write('usage: generate.cjs <compiler-inspection.cjs> <commit>\n');
  process.exit(2);
}
// eslint-disable-next-line
const compiler = require(path.resolve(bundle));
const definition = require('./definition.cjs');

const ds = compiler.buildDesignSystem(definition);
const set = compiler.createArtifactSet(ds.snapshot, {
  designModuleFile: 'design.pandamstyle.js',
  declarationsFile: 'design.pandamstyle.d.ts',
  designModule: compiler.generateDesignSystemModule({ designSystem: ds }),
  declarations: compiler.generateDesignSystemDeclarations(ds.snapshot),
  manifest: `${JSON.stringify(ds.snapshot.tooling.manifest, null, 2)}\n`,
  css: compiler.withDesignSystemCssIdentity(
    ds.renderCss(),
    ds.snapshot.identity,
  ),
});
process.stdout.write(
  `${JSON.stringify(
    {
      provenance: {
        generatedBy:
          'packages/compiler/__tests__/pandamstyle/fixtures/ce022-manifest-v2/generate.cjs',
        sourceCommit: commit,
      },
      metadata: set.metadata,
      contents: set.contents,
    },
    null,
    2,
  )}\n`,
);
