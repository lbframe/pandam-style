/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared helpers for the PandamStyle build tests.
 *
 * `runBuild` spawns a real child process and returns its true exit status,
 * stdout and stderr. No test in this directory may fabricate an exit code: the
 * brief requires the observed status of a real build process.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FIXTURES = path.resolve(__dirname, 'fixtures');
// __dirname is packages/@stylexjs/babel-plugin/__tests__/pandamstyle
const COMPILER_PKG = path.resolve(
  __dirname,
  '../../../../@pandamstyle/compiler',
);
const BUILD_BIN = path.join(COMPILER_PKG, 'bin', 'pms-build.js');

/**
 * The temp root for this PROCESS, created on first use and removed when the
 * process ends.
 *
 * ONE root per process rather than one per call, for an operational reason that
 * cost two benchmark campaigns: a full run of this suite makes thousands of
 * fixture copies, nothing removed them, and the volume filled. A campaign
 * running at the time died with a full disk, which looks exactly like a harness
 * failure and is not one. With one root, a worker that is SIGTERMed without
 * running its exit handler leaks one directory instead of dozens.
 *
 * The per-call subdirectory is what preserves isolation: every `freshCopyOf`
 * still gets its own pristine copy, and two tests cannot see each other's edits.
 */
let processTempRoot = null;

function tempRoot() {
  if (processTempRoot != null) return processTempRoot;
  processTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-fixtures-'));
  const remove = () => {
    try {
      fs.rmSync(processTempRoot, { recursive: true, force: true });
    } catch {
      /* a temp directory that will not delete is not a test failure */
    }
  };
  process.on('exit', remove);
  return processTempRoot;
}

/**
 * Copies the whole fixtures tree to a temp directory and returns the requested
 * project inside it, so shared inputs (the design system definition) and any
 * mutation made by a test stay isolated from the repository.
 */
function freshCopyOf(projectName) {
  const tmp = fs.mkdtempSync(path.join(tempRoot(), 'copy-'));
  fs.cpSync(FIXTURES, tmp, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}generated`),
  });
  // The design system definition requires '@pandamstyle/compiler' the way a
  // real application would. Link it into the temp root so Node resolution
  // behaves as it does in an installed app instead of reaching into the
  // monorepo sources.
  const scope = path.join(tmp, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(COMPILER_PKG, path.join(scope, 'compiler'), 'dir');
  return path.join(tmp, projectName);
}

function runBuild(projectDir, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [BUILD_BIN, '--config', './pandamstyle.config.js', ...extraArgs],
    { cwd: projectDir, encoding: 'utf8', env: { ...process.env } },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    diagnostics: parseDiagnostics(result.stderr ?? ''),
    codes: [
      ...new Set(
        (parseDiagnostics(result.stderr ?? '') ?? []).map((d) => d.code),
      ),
    ],
  };
}

/** Extracts the JSON document the CLI writes on its last stderr line. */
function parseDiagnostics(stderr) {
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('PMS_JSON:')) continue;
    try {
      return JSON.parse(line.slice('PMS_JSON:'.length)).diagnostics ?? [];
    } catch {
      return null;
    }
  }
  return [];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The shared design system definition that sits next to a copied project. */
function sharedDefinitionOf(projectDir) {
  return path.join(path.dirname(projectDir), '_shared', 'design.pms.config.js');
}

module.exports = {
  FIXTURES,
  sharedDefinitionOf,
  COMPILER_PKG,
  BUILD_BIN,
  freshCopyOf,
  runBuild,
  readJson,
};
