/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Runs every oracle fixture: each known-good solution must reach its expected
// verdict and each known-bad solution must be rejected by the expected checks.
// Requires the built compiler (`yarn build`); fixtures materialize under the
// gitignored .pms-bench/ so workspace packages resolve.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CORPUS_ROOT, heldoutPaths, loadCorpus } from '../src/corpus.mjs';
import { validate } from '../src/json-schema.mjs';
import {
  listOracleFixtures,
  runOracleFixture,
} from '../src/oracle-fixtures.mjs';

const REPO = path.resolve(CORPUS_ROOT, '../..');
const SCRATCH = path.join(REPO, '.pms-bench/agentic-test');
const resultSchema = JSON.parse(
  fs.readFileSync(
    path.join(CORPUS_ROOT, 'schema/evaluation-result.schema.json'),
    'utf8',
  ),
);
const compilerBuilt = fs.existsSync(
  path.join(REPO, 'packages/compiler/lib/index.mjs'),
);

const plaintext = heldoutPaths().plaintextTasks;
const loaded = loadCorpus(CORPUS_ROOT, {
  heldoutTasksDir: fs.existsSync(plaintext) ? plaintext : null,
});

test('the compiler is built', () => {
  assert.ok(
    compilerBuilt,
    'packages/compiler/lib is missing: run `yarn build` first',
  );
});

for (const entry of loaded.development) {
  for (const fixture of listOracleFixtures(entry)) {
    test(
      `oracle fixture ${entry.name}/${fixture.name}`,
      { skip: !compilerBuilt && 'compiler not built' },
      async () => {
        fs.mkdirSync(SCRATCH, { recursive: true });
        const r = await runOracleFixture({
          loaded,
          taskEntry: entry,
          fixture,
          scratchRoot: SCRATCH,
        });
        assert.deepEqual(validate(resultSchema, r.result), []);
        assert.deepEqual(r.mismatches, []);
      },
    );
  }
}

test('every development task with an application outcome has a known-good oracle fixture', () => {
  for (const entry of loaded.development) {
    const kind = entry.task.expectations.alpha1.intendedOutcome.kind;
    const good = listOracleFixtures(entry).filter(
      (f) =>
        f.spec.expectedVerdict === 'pass' ||
        f.spec.expectedVerdict === 'unmeasured',
    );
    assert.ok(
      good.length > 0,
      `${entry.name} (${kind}) has no known-good fixture`,
    );
  }
});

test(
  'held-out oracle fixtures (only where plaintext is staged locally)',
  {
    skip:
      loaded.heldout.length === 0 &&
      'held-out plaintext not present (expected in CI)',
  },
  async () => {
    fs.mkdirSync(SCRATCH, { recursive: true });
    for (const entry of loaded.heldout) {
      for (const fixture of listOracleFixtures(entry)) {
        const r = await runOracleFixture({
          loaded,
          taskEntry: entry,
          fixture,
          scratchRoot: SCRATCH,
        });
        assert.deepEqual(r.mismatches, [], `${entry.name}/${fixture.name}`);
      }
    }
  },
);
