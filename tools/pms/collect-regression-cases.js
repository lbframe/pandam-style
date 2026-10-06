#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Collects the regression-case table for the consolidation batch.
 *
 * Every row is produced by SPAWNING the real build CLI, and every column is
 * read back from what that process actually did: its real exit status, the
 * diagnostic codes it printed, and the digest of the artifacts left on disk.
 * Nothing here is asserted from a fixture's name or from this file's own
 * expectations, so the table cannot drift from reality.
 *
 * Usage: node tools/pms/collect-regression-cases.js <out.json>
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const TESTS = path.join(REPO_ROOT, 'packages/compiler/__tests__/pandamstyle');
const FIXTURES = path.join(TESTS, 'fixtures');
const BUILD_BIN = path.join(REPO_ROOT, 'packages/compiler/bin/pms-build.js');

/** criterion -> fixture, grouped by the batch criterion it demonstrates. */
const CASES = [
  // BC-1  props() admits no raw CSS
  [
    'BC-1',
    'neg-props-raw-object',
    'PMS_UNVERIFIED_PROPS_SOURCE',
    'object literal: padding, color, multi-property',
  ],
  [
    'BC-1',
    'neg-props-raw-reference',
    'PMS_UNVERIFIED_PROPS_SOURCE',
    'arbitrary local object, and a spread of it',
  ],
  // BC-2  provenance is bound to a real Babel binding
  [
    'BC-2',
    'neg-props-shadowing',
    'PMS_UNVERIFIED_JSX_SPREAD',
    'parameter shadowing a module-level props() result',
  ],
  [
    'BC-2',
    'neg-props-reassigned',
    'PMS_UNVERIFIED_JSX_SPREAD',
    'props() result then reassigned',
  ],
  [
    'BC-2',
    'neg-props-mutated',
    'PMS_UNVERIFIED_PROVENANCE',
    'member written to after the value was proven',
  ],
  [
    'BC-2',
    'neg-props-escaped',
    'PMS_UNVERIFIED_PROVENANCE',
    'value passed to an unknown call and to Object.assign',
  ],
  [
    'BC-2',
    'neg-helper-shadowed',
    'PMS_UNVERIFIED_JSX_SPREAD',
    'alias of the helper, and a nested shadow of it',
  ],
  // BC-3  the coverage graph is the real local module graph
  [
    'BC-3',
    'neg-relay-reexport-star',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'module outside every root, via `export *`',
  ],
  [
    'BC-3',
    'neg-relay-reexport-named',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'module outside every root, via a named re-export',
  ],
  [
    'BC-3',
    'neg-relay-barrel-chain',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'two barrels deep, both outside every root',
  ],
  [
    'BC-3',
    'neg-stylesheet-via-relay',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'unapproved stylesheet reached only through a relay',
  ],
  [
    'BC-3',
    'neg-dynamic-import',
    'PMS_COVERAGE_GAP',
    'dynamic request that is not a static string',
  ],
  [
    'BC-3',
    'neg-dynamic-import-local',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'literal dynamic import: a normal local edge, analysed',
  ],
  [
    'BC-3',
    'neg-unresolved-import',
    'PMS_COVERAGE_GAP',
    'local import that resolves to nothing',
  ],
  // BC-6  authority is a build concern
  [
    'BC-6',
    'neg-reserved-authority',
    'PMS_ROLE_VIOLATION',
    'reserved __pms* field in ordinary data',
  ],
  [
    'BC-6',
    'neg-role-violation',
    'PMS_ROLE_VIOLATION',
    'authority field inside a recognized PandamStyle call',
  ],
  // Pre-existing cases, kept so the table shows no regression
  [
    'AC-011',
    'neg-forbidden-value',
    'PMS_FORBIDDEN_VALUE',
    'raw 17px, forged var(), forged ref, alias, computed key, spread',
  ],
  [
    'AC-012',
    'neg-unknown-token',
    'PMS_UNKNOWN_TOKEN',
    'token absent from the registry',
  ],
  [
    'AC-020',
    'neg-private-token',
    'PMS_TOKEN_NOT_PUBLIC',
    'private primitive from a consumer page',
  ],
  [
    'AC-015',
    'neg-composite-form',
    'PMS_UNSUPPORTED_PROPERTY_FORM',
    'composite border shorthand',
  ],
  [
    'AC-051',
    'neg-forbidden-import',
    'PMS_FORBIDDEN_IMPORT',
    'engine entries and the atoms path',
  ],
  [
    'AC-054',
    'neg-style-channel',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    'inline style attribute and local stylesheet',
  ],
  [
    'AC-054',
    'neg-jsx-spread',
    'PMS_UNVERIFIED_JSX_SPREAD',
    'JSX spread not provably free of style/className',
  ],
  [
    'AC-039',
    'neg-invalid-variant',
    'PMS_INVALID_VARIANT_VALUE',
    'literal invalid variant refused at build',
  ],
  [
    'AC-023',
    'neg-non-static',
    'PMS_NON_STATIC_VALUE',
    'a local helper named token gains no trust',
  ],
  [
    'AC-017',
    'neg-forbidden-value-ts',
    'PMS_FORBIDDEN_VALUE',
    'same error in TSX, no tsc involved',
  ],
];

const POSITIVE = ['valid'];

function freshCopyOf(projectName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-regress-'));
  fs.cpSync(FIXTURES, tmp, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}generated`),
  });
  const scope = path.join(tmp, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(
    path.join(REPO_ROOT, 'packages/compiler'),
    path.join(scope, 'compiler'),
    'dir',
  );
  return path.join(tmp, projectName);
}

function runBuild(projectDir) {
  const result = spawnSync(
    process.execPath,
    [BUILD_BIN, '--config', './pandamstyle.config.js'],
    { cwd: projectDir, encoding: 'utf8', env: { ...process.env } },
  );
  const stderr = result.stderr ?? '';
  let diagnostics = [];
  for (const line of stderr.split('\n')) {
    if (!line.startsWith('PMS_JSON:')) continue;
    try {
      diagnostics =
        JSON.parse(line.slice('PMS_JSON:'.length)).diagnostics ?? [];
    } catch {
      diagnostics = [];
    }
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr,
    codes: [...new Set(diagnostics.map((d) => d.code))],
  };
}

function digestTree(dir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  const walk = (cur, rel) => {
    if (!fs.existsSync(cur)) return;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isFile()) files.push(key);
    }
  };
  walk(dir, '');
  files.sort();
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return { fileCount: files.length, sha256: hash.digest('hex') };
}

const rows = [];
for (const [criterion, fixture, expectedCode, what] of CASES) {
  const project = freshCopyOf(fixture);
  let result;
  try {
    result = runBuild(project);
  } finally {
    fs.rmSync(path.dirname(project), { recursive: true, force: true });
  }
  const generation = digestTree(path.join(project, 'generated'));
  rows.push({
    criterion,
    fixture,
    what,
    observedExitCode: result.status,
    observedCodes: result.codes,
    expectedCode,
    expectedCodeObserved: result.codes.includes(expectedCode),
    publishedManifest: fs.existsSync(
      path.join(project, 'generated/manifest.json'),
    ),
    internalError: result.stderr.includes('unexpected build error'),
    publishedFileCount: generation.fileCount,
  });
  process.stderr.write(
    `${fixture}: exit=${result.status} codes=${result.codes.join(',')}\n`,
  );
}

const positives = [];
for (const fixture of POSITIVE) {
  const project = freshCopyOf(fixture);
  let result;
  try {
    result = runBuild(project);
  } finally {
    fs.rmSync(path.dirname(project), { recursive: true, force: true });
  }
  positives.push({
    fixture,
    observedExitCode: result.status,
    observedCodes: result.codes,
    stderrHasDiagnostic: result.stderr.includes('PMS_JSON:'),
    stdout: result.stdout.trim(),
  });
  process.stderr.write(`${fixture}: exit=${result.status}\n`);
}

const out = process.argv[2];
fs.writeFileSync(
  out,
  JSON.stringify(
    {
      documentKind: 'pandamstyle-regression-cases',
      note:
        'Every row was produced by spawning the real build CLI. ' +
        'observedExitCode and observedCodes are read back from the process.',
      negatives: rows,
      positives,
    },
    null,
    2,
  ) + '\n',
);
process.stderr.write(`written ${out}\n`);
