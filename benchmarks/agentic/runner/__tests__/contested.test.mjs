/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A repetition's `contested` status (DESIGN.md section 5.3) has one
// derivation, from its attempt history. outcomes.json, a resume scan and the
// report must agree on it before and after a resume (`runFixture` asserts
// that after every fixture run, `assertContestedAgrees`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  STUB_GRADING,
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  goodDiscoveryResponse,
  runFixture,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { repetitionContested } from '../src/contested.mjs';
import { buildReport, loadMatrix } from '../src/report.mjs';

const DISCOVERY = 'discovery-positive-card-vocabulary';
const CLASSES = [
  'agent',
  'agent-resource',
  'agent-abnormal',
  'infrastructure',
  'unclassified',
  'harness',
];

test('contested = an infrastructure attempt or a crash in the history, over every small history', () => {
  const rec = (cls) => ({ outcome: { class: cls } });
  // Every history of up to 3 attempts over every class, with 0-2 crashes.
  const histories = [[]];
  for (let n = 1; n <= 3; n += 1)
    for (const h of histories.filter((x) => x.length === n - 1))
      for (const c of CLASSES) histories.push([...h, c]);
  for (const h of histories)
    for (const crashed of [0, 1, 2]) {
      const got = repetitionContested({ records: h.map(rec), crashed });
      assert.equal(
        got,
        crashed > 0 || h.includes('infrastructure'),
        `${h.join(',')} +${crashed} crashed`,
      );
      // Monotone in the history: appending an attempt never clears it.
      if (got)
        for (const c of CLASSES)
          assert.equal(
            repetitionContested({ records: [...h, c].map(rec), crashed }),
            true,
          );
    }
});

test('a cancelled attempt does not make its repetition contested, before or after resume', async () => {
  const root = tmpDir('contested-cancel');
  const hang = writeScenario(tmpDir('contested-hang'), 'h', {
    steps: [claudeInit(), { waitForever: true }],
  });
  const ok = writeScenario(tmpDir('contested-ok'), 'o', {
    steps: [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 2500);
  const first = await runFixture({
    config: fixtureConfig({ maxAttempts: 3 }),
    scenarios: { '*': [hang] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm-cancel',
    signal: ac.signal,
  });
  assert.equal(first.outcomes[0].reason, 'cancelled');
  assert.equal(first.outcomes[0].contested, false);
  const second = await runFixture({
    config: fixtureConfig({ maxAttempts: 3 }),
    scenarios: { '*': [ok] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm-cancel',
  });
  assert.equal(second.outcomes[0].status, 'done');
  assert.equal(second.outcomes[0].contested, false);
  const rep = buildReport(loadMatrix(second.matrixDir)).cells[0].repetitions[0];
  assert.equal(rep.attempts.length, 2, 'cancelled + completed');
  assert.equal(rep.contested, false);
});

test('an attempt directory without a record is contested in the report too', async () => {
  const root = tmpDir('contested-crash');
  const ok = writeScenario(tmpDir('contested-ok2'), 'o', {
    steps: [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  });
  const config = fixtureConfig({ maxAttempts: 3 });
  const first = await runFixture({
    config,
    scenarios: { '*': [ok] },
    grading: STUB_GRADING(),
    root,
    matrixId: 'm-crash',
  });
  // A later crashed attempt (a directory without a record).
  const out = loadMatrix(first.matrixDir);
  assert.equal(out.crashed.length, 0);
  fs.mkdirSync(
    path.join(
      first.matrixDir,
      'cells',
      DISCOVERY,
      'claude-haiku',
      'rep-1',
      'attempt-9',
    ),
    { recursive: true },
  );
  const report = buildReport(loadMatrix(first.matrixDir));
  assert.equal(report.cells[0].repetitions[0].contested, true);
});
