/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the fresh-rebuild child process for the Phase C oracle.
 *
 * WHY A SEPARATE FILE AND A SEPARATE PROCESS
 *
 * The oracle's third reference is a full rebuild of the bytes on disk, and it
 * has to be a fresh one. In the same process it would share the module
 * registry, the compiler's in-process caches, the module-graph cache and the
 * design system the session just built - so it would not be a rebuild at all,
 * it would be a second opinion from the same memory, and the question the
 * oracle exists to answer is whether that memory is sound.
 *
 * Running it as a child is also what makes a divergence diagnosable: the child
 * prints a JSON document and exits 0, so a failure to run is a failure to run
 * rather than a silent "equal".
 *
 * It prints ONE json document on stdout. Nothing else goes there: a stray log
 * line would make the document unparseable and the oracle would report "the
 * rebuild failed" for a reason that has nothing to do with the compiler.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPILER_PKG = path.join(
  REPO_ROOT,
  'packages',
  '@pandamstyle',
  'compiler',
);

const projectDir = process.argv[2];
if (projectDir == null) {
  process.stderr.write('phase-c-rebuild: a project directory is required\n');
  process.exit(2);
}
process.chdir(projectDir);

const compiler = require(path.join(COMPILER_PKG, 'lib', 'index.js'));
const config = require(path.join(projectDir, 'pandamstyle.config.js'));
const definitionPath = path.resolve(
  path.dirname(path.join(projectDir, 'pandamstyle.config.js')),
  config.definition,
);
const resolveRoot = (r) => (path.isAbsolute(r) ? r : path.join(projectDir, r));
const outDir = path.resolve(resolveRoot(config.outDir));

let verdict = { ok: true, error: null };
let diagnostics = [];
try {
  compiler.buildProject({
    // eslint-disable-next-line
    definition: require(definitionPath),
    roots: (config.roots ?? []).map(resolveRoot),
    outDir,
    runtimeModule: config.runtimeModule,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
  });
} catch (err) {
  verdict = {
    ok: false,
    error: String(err?.message ?? err).slice(0, 1000),
  };
  diagnostics = (err?.diagnostics ?? []).map((d) => ({
    code: d.code,
    severity: d.severity,
    phase: d.phase,
    rule: d.rule,
    source: d.source,
    location: d.location,
    context: d.context,
  }));
}

// `writeSync`, not `write`: an asynchronous write followed by `process.exit(0)`
// is the documented way to truncate your own output.
fs.writeSync(1, JSON.stringify({ verdict, diagnostics }));
