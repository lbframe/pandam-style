/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Evidence and replay (F30-F33, DESIGN.md section 6) and the comparability
// key (F34-F35, section 1.4; the mutation table is generated from the
// projection definition, section 9.2).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  MODELS,
  STUB_GRADING,
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  recordsOf,
  runFixture,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { evidenceCompleteness } from '../src/attempt.mjs';
import {
  PROJECTION_FIELDS,
  buildProjection,
  comparabilityKey,
  compareRecords,
  diffProjections,
  normalizeArgv,
} from '../src/comparability.mjs';
import {
  archiveTree,
  extractArchive,
  oracleIgnoredGlobs,
  replayExactness,
} from '../src/evidence.mjs';
import { regradeAttempt } from '../src/regrade.mjs';
import { readJson } from '../src/util.mjs';

const WRITE_TASK = 'composition-positive-order-summary';

async function run(steps, { grading, repetitions = 1 } = {}) {
  const file = writeScenario(tmpDir('ev'), 's', { steps });
  const out = await runFixture({
    config: fixtureConfig({
      models: [MODELS.haiku],
      tasks: [WRITE_TASK],
      repetitions,
    }),
    scenarios: { '*': [file] },
    ...(grading ? { grading } : {}),
  });
  return { ...out, records: recordsOf(out.matrixDir) };
}

const attemptDir = (matrixDir, r) =>
  path.join(
    matrixDir,
    'cells',
    r.cell.taskId,
    r.cell.modelKey,
    `rep-${r.repetition}`,
    `attempt-${r.attempt}`,
  );

test('F30 round trip: modified generated file + added symlink -> archive -> re-grade gives identical statuses', async () => {
  // Generated output is harness-ignored but oracle-relevant (generated.consistent).
  const mutate =
    'mkdir -p .pandamstyle && echo "/* edited */" > .pandamstyle/styles.css && ln -s ../README.md src/link.js';
  const { records, matrixDir } = await run([
    claudeInit(),
    { run: mutate, as: 'edit files' },
    claudeText('done'),
    claudeResult({ text: 'done' }),
  ]);
  const r = records[0];
  assert.equal(r.grading.passes[0].status, 'completed');
  assert.equal(r.evidence.completeness, 'complete');
  const manifest = readJson(
    path.join(attemptDir(matrixDir, r), 'evidence/final/manifest.json'),
  );
  const link = manifest.entries.find((e) => e.path === 'src/link.js');
  assert.deepEqual([link.type, link.target], ['symlink', '../README.md']);
  assert.equal(
    manifest.entries.find((e) => e.path === '.pandamstyle/styles.css').type,
    'file',
  );
  const re = regradeAttempt({
    attemptDir: attemptDir(matrixDir, r),
    scratchRoot: tmpDir('regrade'),
  });
  assert.equal(re.label, 'exact');
  assert.equal(re.identical, true, JSON.stringify(re.checks));
  assert.equal(re.verdict, r.grading.verdict);
});

test('F32 an archive over its bound is incomplete; replay non-exact', () => {
  const root = tmpDir('big');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(root, 'b.txt'), 'y'.repeat(5000));
  const m = archiveTree({
    root,
    dest: path.join(tmpDir('arch'), 'out'),
    maxBytes: 6000,
  });
  assert.equal(m.completeness, 'incomplete');
  assert.equal(replayExactness(m).label, 'non-exact');
  assert.equal(m.entries.filter((e) => e.stored === false).length, 1);
});

test('F32 a truncated transcript or final message makes the evidence incomplete', () => {
  const ok = { completeness: 'complete', affectedPaths: [] };
  const art = (file, extra = {}) => ({
    file,
    truncated: false,
    redacted: false,
    ...extra,
  });
  assert.equal(
    evidenceCompleteness({
      baselineManifest: ok,
      finalManifest: ok,
      graderInputs: [art('transcript.jsonl'), art('final-message.txt')],
      purged: [],
    }).completeness,
    'complete',
  );
  const t = evidenceCompleteness({
    baselineManifest: ok,
    finalManifest: ok,
    graderInputs: [
      art('transcript.jsonl', { truncated: true }),
      art('final-message.txt'),
    ],
    purged: [],
  });
  assert.equal(t.completeness, 'incomplete');
  assert.deepEqual(t.affected, ['transcript.jsonl']);
  assert.equal(
    evidenceCompleteness({
      baselineManifest: ok,
      finalManifest: ok,
      graderInputs: [art('final-message.txt', { redacted: true })],
      purged: [],
    }).completeness,
    'redacted',
  );
  assert.equal(
    evidenceCompleteness({
      baselineManifest: ok,
      finalManifest: ok,
      graderInputs: [],
      purged: ['stream.jsonl'],
    }).completeness,
    'incomplete',
  );
});

test('F33 FIFO, hard link and dangling link: metadata only, no hang, graded normally', async () => {
  const make =
    'mkfifo src/pipe && ln README.md src/hard.md && ln -s ../nowhere src/dangling';
  const t0 = Date.now();
  const { records, matrixDir } = await run(
    [
      claudeInit(),
      { run: make, as: 'make files' },
      claudeText('done'),
      claudeResult({ text: 'done' }),
    ],
    { grading: STUB_GRADING() },
  );
  assert.ok(Date.now() - t0 < 60000);
  const manifest = readJson(
    path.join(
      attemptDir(matrixDir, records[0]),
      'evidence/final/manifest.json',
    ),
  );
  const byPath = Object.fromEntries(manifest.entries.map((e) => [e.path, e]));
  assert.equal(byPath['src/pipe'].type, 'special');
  assert.equal(byPath['src/pipe'].sha256, undefined);
  assert.equal(byPath['src/hard.md'].type, 'file');
  assert.equal(byPath['src/dangling'].type, 'symlink');
  assert.equal(byPath['src/dangling'].target, '../nowhere');
  const out = path.join(tmpDir('x'), 'w');
  extractArchive({
    archive: path.join(attemptDir(matrixDir, records[0]), 'evidence/final'),
    dest: out,
  });
  assert.equal(fs.existsSync(path.join(out, 'src/pipe')), false);
  assert.equal(
    fs.lstatSync(path.join(out, 'src/dangling')).isSymbolicLink(),
    true,
  );
});

test('evidence: the oracle-relevant set is the locked ALWAYS_IGNORED complement', () => {
  const globs = oracleIgnoredGlobs();
  assert.ok(globs.includes('node_modules/**'));
  assert.ok(globs.includes('.git/**'));
  assert.ok(!globs.some((g) => g.includes('.pandamstyle')));
  const root = tmpDir('set');
  fs.mkdirSync(path.join(root, '.pandamstyle'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.pandamstyle/state.json'), '{}');
  fs.writeFileSync(path.join(root, 'node_modules/x/i.js'), '1');
  const m = archiveTree({ root, dest: path.join(tmpDir('arch'), 'o') });
  assert.ok(m.entries.some((e) => e.path === '.pandamstyle/state.json'));
  assert.ok(!m.entries.some((e) => e.path.startsWith('node_modules')));
});

test('evidence: an archive path escaping the destination is refused', () => {
  const archive = tmpDir('evil');
  fs.mkdirSync(path.join(archive, 'blobs'));
  fs.writeFileSync(
    path.join(archive, 'manifest.json'),
    JSON.stringify({ entries: [{ path: '../escape', type: 'dir' }] }),
  );
  assert.throws(
    () => extractArchive({ archive, dest: path.join(tmpDir('d'), 'x') }),
    /escapes/,
  );
});

test('F34 attempts differing only in session, attempt dir, timestamps, load or commit have equal keys', async () => {
  const { records } = await run(
    [claudeInit(), claudeText('done'), claudeResult({ text: 'done' })],
    { grading: STUB_GRADING(), repetitions: 2 },
  );
  assert.equal(records.length, 2);
  assert.notEqual(records[0].provider.sessionId, records[1].provider.sessionId);
  assert.equal(records[0].comparability.key, records[1].comparability.key);
  assert.ok(
    records[0].comparability.projection.model.normalizedArgv.includes(
      '<session>',
    ),
  );
  const other = structuredClone(records[1]);
  other.harness.commit = 'f'.repeat(40);
  other.environment.load = { samples: 9, min: 7, max: 9, median: 8 };
  const cmp = compareRecords(records[0], other);
  assert.equal(cmp.comparable, true);
  assert.equal(
    normalizeArgv(
      [
        '--session-id',
        '01a152b3-d7b1-70c1-a530-7c4a7149d89d',
        '/runs/m/attempt-2/x',
      ],
      ['/runs/m/attempt-2'],
    ).join(' '),
    '--session-id <session> <attempt>/x',
  );
});

function sampleInput() {
  const input = {};
  for (const [group, fields] of Object.entries(PROJECTION_FIELDS)) {
    input[group] = {};
    for (const f of fields) input[group][f] = `${group}.${f}`;
  }
  return input;
}

test('F35 one mutation per projection field (generated from the definition) changes the key and names the field', () => {
  const base = buildProjection(sampleInput());
  const key = comparabilityKey(base);
  let n = 0;
  for (const [group, fields] of Object.entries(PROJECTION_FIELDS))
    for (const f of fields) {
      const input = sampleInput();
      input[group][f] = `${input[group][f]}-mutated`;
      const p = buildProjection(input);
      assert.notEqual(comparabilityKey(p), key, `${group}.${f}`);
      assert.deepEqual(diffProjections(base, p), [`${group}.${f}`]);
      n += 1;
    }
  assert.equal(n, Object.values(PROJECTION_FIELDS).flat().length);
  const missing = sampleInput();
  delete missing.budgets.cliMaxTurns;
  assert.throws(() => buildProjection(missing), /budgets\.cliMaxTurns/);
});

test('F35 a product-only change keeps the key; compare reports it, and refuses other differences', () => {
  const p = buildProjection(sampleInput());
  const rec = (product, projection = p) => ({
    kind: 'provider-backed',
    comparability: { key: comparabilityKey(projection), projection },
    productBuild: { digest: product },
    task: { id: 't' },
    cell: { modelKey: 'm' },
    repetition: 1,
    attempt: 1,
    grading: { verdict: 'pass' },
    outcome: { taskSuccess: true },
    metrics: { toolCalls: { total: null } },
  });
  const same = compareRecords(rec('a'.repeat(64)), rec('b'.repeat(64)));
  assert.equal(same.comparable, true);
  assert.equal(same.productDiffers, true);
  const changed = sampleInput();
  changed.budgets.timeoutSeconds = 1;
  const diff = compareRecords(rec('a'), rec('a', buildProjection(changed)));
  assert.equal(diff.comparable, false);
  assert.deepEqual(diff.differences, ['budgets.timeoutSeconds']);
  assert.equal(
    compareRecords(rec('a'), { ...rec('a'), kind: 'adapter-fixture' })
      .comparable,
    false,
  );
});

test('determinism: two archives of the same tree have the same set digest', () => {
  const root = tmpDir('det');
  fs.writeFileSync(path.join(root, 'a'), '1');
  spawnSync('ln', ['-s', 'a', path.join(root, 'b')]);
  const a = archiveTree({ root, dest: path.join(tmpDir('d1'), 'o') });
  const b = archiveTree({ root, dest: path.join(tmpDir('d2'), 'o') });
  assert.equal(a.setDigest, b.setDigest);
});
