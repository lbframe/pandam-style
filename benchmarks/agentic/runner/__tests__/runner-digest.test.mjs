/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runner digest scope (DESIGN.md section 1.4): documentation, records and
// test-only material leave the comparability key unchanged; every
// execution-relevant file, and any new file the explicit list does not name,
// changes it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { copyTree } from '../../src/fs-tree.mjs';
import {
  RUNNER_DIGEST_EXCLUDE,
  harnessIdentity,
  runnerTreeDigest,
} from '../src/identity.mjs';
import { RUNNER_ROOT } from '../src/util.mjs';
import { tmpDir } from './helpers.mjs';

function runnerCopy() {
  const dir = path.join(tmpDir('runner-digest'), 'runner');
  copyTree(RUNNER_ROOT, dir, {
    exclude: ['node_modules/**', '**/node_modules/**'],
  });
  return dir;
}

/** Digest of a fresh runner copy after `mutate(copy)`. */
function digestAfter(mutate) {
  const dir = runnerCopy();
  const before = runnerTreeDigest(dir);
  mutate(dir);
  return { before, after: runnerTreeDigest(dir) };
}

const append =
  (rel, text = '\n// changed\n') =>
  (dir) =>
    fs.appendFileSync(path.join(dir, rel), text);
const create =
  (rel, text = 'x\n') =>
  (dir) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
const firstFile = (rel, re) =>
  path.join(
    rel,
    fs.readdirSync(path.join(RUNNER_ROOT, rel)).find((f) => re.test(f)),
  );
const firstSmokeRecord = () => {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (found.length > 0) return;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === 'record.json') found.push(abs);
    }
  };
  walk(path.join(RUNNER_ROOT, 'smoke'));
  return path.relative(RUNNER_ROOT, found[0]);
};

test('the harness identity uses the scoped runner digest', () => {
  assert.equal(harnessIdentity().runnerTreeDigest, runnerTreeDigest());
  // A copy elsewhere digests identically: paths are runner-relative.
  assert.equal(runnerTreeDigest(runnerCopy()), runnerTreeDigest());
});

test('documentation, records and tests do not change the runner digest', () => {
  const unchanged = {
    'DESIGN.md': append('DESIGN.md', '\nedited\n'),
    'new root README.md': create('README.md'),
    'smoke record': append(firstSmokeRecord(), '\n'),
    'smoke report': append('smoke/2026-10-19/report.md', '\nedited\n'),
    'new smoke run': create('smoke/2026-10-20/matrix.json', '{}\n'),
    'existing test': append('__tests__/helpers.mjs'),
    'new test': create('__tests__/new.test.mjs'),
    'fake CLI (test-only)': append('fixtures/bin/fake-cli.mjs'),
    'observed fixture (test-only)': append(
      firstFile('fixtures/observed', /\.json$/),
      '\n',
    ),
    'new observed fixture': create('fixtures/observed/new.json', '{}\n'),
  };
  for (const [name, mutate] of Object.entries(unchanged)) {
    const { before, after } = digestAfter(mutate);
    assert.equal(after, before, name);
  }
});

test('execution-relevant and unlisted files change the runner digest', () => {
  const changed = {
    'src/matrix.mjs': append('src/matrix.mjs'),
    'src/adapters': append(firstFile('src/adapters', /\.mjs$/)),
    'src/executors': append(firstFile('src/executors', /\.mjs$/)),
    bin: append('bin/pms-agentic-runner.mjs'),
    container: append(firstFile('container', /\.mjs$/)),
    schema: append('schema/run-record.v1.schema.json', '\n'),
    'new package.json': create('package.json', '{}\n'),
    'new lock file': create('yarn.lock'),
    'new source file': create('src/new.mjs'),
    'new container file': create('container/new.mjs'),
    'new nested markdown (not a root doc)': create('src/NOTES.md'),
    'new fixtures/bin file': create('fixtures/bin/other-cli.mjs'),
    'new fixtures file': create('fixtures/scenario.json', '{}\n'),
    'new top-level directory': create('lib/x.mjs'),
    'deleted source file': (dir) => fs.rmSync(path.join(dir, 'src/redact.mjs')),
  };
  for (const [name, mutate] of Object.entries(changed)) {
    const { before, after } = digestAfter(mutate);
    assert.notEqual(after, before, name);
  }
});

test('the exclusion list names only documentation, records and test material', () => {
  assert.deepEqual([...RUNNER_DIGEST_EXCLUDE].sort(), [
    '**/node_modules/**',
    '*.md',
    '__tests__/**',
    'fixtures/bin/fake-cli.mjs',
    'fixtures/observed/**',
    'node_modules/**',
    'smoke/**',
  ]);
  assert.ok(Object.isFrozen(RUNNER_DIGEST_EXCLUDE));
});
