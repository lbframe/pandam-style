/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Defects found while preparing the authorized smoke run (no model call):
// a fixture workspace installs only the @pandamstyle/* packages it declares,
// and Codex 0.163.0's `debug prompt-input` takes neither --strict-config nor
// -m (DESIGN.md sections 3.3, 4.7 and 11).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { STORE_CORPUS, fixtureStore, tmpDir } from './helpers.mjs';
import { codexPromptInputArgs } from '../src/provider.mjs';
import { bindProductBuild, copyStore } from '../src/store.mjs';
import {
  installFixtureClosure,
  verifyProductPackages,
} from '../src/trusted-tree.mjs';

function closure(store, copy, names) {
  const dir = path.join(tmpDir('closure'), 'c');
  fs.mkdirSync(dir);
  const deps = Object.fromEntries(
    store.manifest.packages
      .filter((p) => names.includes(p.name))
      .map((p) => [p.name, `file:${path.join(copy, p.registry.file)}`]),
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      devDependencies: deps,
    }),
  );
  const r = spawnSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

test('a fixture installs only the product packages it declares; those are verified, unknown ones refused', () => {
  const store = fixtureStore();
  const copy = path.join(store.root, 'copy');
  copyStore({ original: store.original, dest: copy });
  const { binding } = bindProductBuild({
    storeCopy: copy,
    originalStore: store.original,
    manifestPath: store.manifestPath,
    corpus: STORE_CORPUS,
    extractDocs: false,
  });
  // The smoke run's case: the binding has more packages than the fixture uses.
  const dir = closure(store, copy, ['@pandamstyle/core']);
  const ws = path.join(tmpDir('ws'), 'w');
  fs.mkdirSync(ws);
  assert.equal(
    installFixtureClosure({
      closureDir: dir,
      workspace: ws,
      binding,
      storeCopy: copy,
    }).productPackagesVerified,
    true,
  );
  const nm = path.join(ws, 'node_modules');
  // A declared package that is missing is still refused.
  assert.deepEqual(
    verifyProductPackages({
      nodeModules: nm,
      binding,
      storeCopy: copy,
      required: ['@pandamstyle/core', '@pandamstyle/compiler'],
    }),
    ['@pandamstyle/compiler: not installed'],
  );
  // Without `required` (the trusted tree) every product package is required.
  assert.deepEqual(
    verifyProductPackages({ nodeModules: nm, binding, storeCopy: copy }),
    ['@pandamstyle/compiler: not installed'],
  );
  // An installed package outside the product build, or a changed file, refuses.
  fs.mkdirSync(path.join(nm, '@pandamstyle/rogue'));
  fs.appendFileSync(
    path.join(nm, '@pandamstyle/core/lib/index.js'),
    '// changed\n',
  );
  const problems = verifyProductPackages({
    nodeModules: nm,
    binding,
    storeCopy: copy,
    required: ['@pandamstyle/core'],
  });
  assert.ok(
    problems.includes(
      '@pandamstyle/rogue: installed but not in the product build',
    ),
  );
  assert.ok(problems.includes('@pandamstyle/core: lib/index.js differs'));
  assert.ok(
    verifyProductPackages({
      nodeModules: nm,
      binding,
      storeCopy: copy,
      required: ['@pandamstyle/unknown'],
    }).includes('@pandamstyle/unknown: required but not in the product build'),
  );
});

test('Codex evidence: debug prompt-input with the attempt overrides and the model as -c, no --strict-config or -m', () => {
  const args = codexPromptInputArgs({
    model: 'gpt-6.1-sol',
    reasoningEffort: null,
  });
  assert.deepEqual(args, [
    'debug',
    'prompt-input',
    '-c',
    'model="gpt-6.1-sol"',
    '-c',
    'web_search="disabled"',
    '-c',
    'agents.enabled=false',
  ]);
  assert.ok(
    codexPromptInputArgs({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'low',
    }).includes('model_reasoning_effort="low"'),
  );
});
