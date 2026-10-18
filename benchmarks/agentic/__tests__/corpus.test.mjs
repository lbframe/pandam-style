/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Corpus contract tests. Run: node --test benchmarks/agentic/__tests__/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  CORPUS_ROOT,
  findTask,
  loadCorpus,
  loadSchemas,
  validateCorpus,
} from '../src/corpus.mjs';
import { computeStyle, evaluateMedia, parseCss } from '../src/css-cascade.mjs';
import { globToRegExp, matchesAny } from '../src/glob.mjs';
import { guard, verify } from '../src/heldout.mjs';
import { parseHtml, select, textContent } from '../src/html.mjs';
import { validate, validateSchemaKeywords } from '../src/json-schema.mjs';
import { buildPrompt, materializeTask } from '../src/materialize.mjs';
import { evaluateTask } from '../src/oracles/evaluate.mjs';
import { extractReport } from '../src/oracles/report.mjs';

const loaded = loadCorpus();
const clone = (v) => JSON.parse(JSON.stringify(v));

function withTask(id, mutate) {
  const copy = {
    ...loaded,
    development: loaded.development.map((t) =>
      t.name === id ? { ...t, task: mutate(clone(t.task)) } : t,
    ),
  };
  return validateCorpus(copy, { checkLock: false }).errors.filter((e) =>
    e.includes(id),
  );
}

test('the committed corpus validates (schemas, semantics, coverage, lock, held-out manifest)', () => {
  const { errors, summary } = validateCorpus(loaded);
  assert.deepEqual(errors, []);
  assert.equal(summary.referenceEpoch, 'alpha1');
  for (const cls of [
    'expressible',
    'missing-product-capability',
    'missing-project-vocabulary',
  ]) {
    assert.ok(summary.classifications[cls] > 0, cls);
  }
});

test('every schema only uses keywords the validator implements', () => {
  for (const [name, schema] of Object.entries(loadSchemas()))
    assert.deepEqual(validateSchemaKeywords(schema), [], name);
});

test('the schema validator rejects malformed documents', () => {
  const schema = loadSchemas().task;
  const task = clone(
    findTask(loaded, 'composition-positive-order-summary').task,
  );
  assert.deepEqual(validate(schema, task), []);
  task.expectations.alpha1.checks[0].kind = 'scope.anything';
  task.environment.host = 'parcel';
  delete task.permissions;
  const errors = validate(schema, task);
  assert.ok(
    errors.some((e) => e.includes('missing required property permissions')),
  );
  assert.ok(errors.some((e) => e.includes('parcel')));
  assert.ok(errors.some((e) => e.includes('scope.anything')));
});

test('epochs: unknown epoch keys and a missing reference epoch are rejected', () => {
  const unknown = withTask('themes-positive-dark-mode', (t) => ({
    ...t,
    expectations: { ...t.expectations, core2: t.expectations.alpha1 },
  }));
  assert.ok(
    unknown.some((e) => e.includes('unknown epoch core2')),
    unknown.join('\n'),
  );
  const missing = withTask('themes-positive-dark-mode', (t) => ({
    ...t,
    expectations: { core2: t.expectations.alpha1 },
  }));
  assert.ok(
    missing.some((e) =>
      e.includes('no expectation for reference epoch alpha1'),
    ),
    missing.join('\n'),
  );
});

test('epochs: a task without an expectation for the requested epoch is not evaluable', async () => {
  const entry = findTask(loaded, 'discovery-positive-card-vocabulary');
  const result = await evaluateTask({
    task: entry.task,
    fixture: loaded.fixtures.get(entry.task.workspace.fixture).meta,
    epoch: 'future-epoch',
    baselineDir: os.tmpdir(),
    workspaceDir: os.tmpdir(),
  });
  assert.equal(result.verdict, 'not-evaluable');
  assert.equal(result.epoch, 'future-epoch');
  assert.deepEqual(result.checks, []);
});

test('compilation alone cannot satisfy an application task', () => {
  const errors = withTask('composition-positive-order-summary', (t) => {
    t.expectations.alpha1.checks = t.expectations.alpha1.checks.filter(
      (c) => c.class !== 'rendered' && c.class !== 'behavioral',
    );
    return t;
  });
  assert.ok(
    errors.some((e) => e.includes('compilation alone cannot satisfy')),
    errors.join('\n'),
  );
});

test('unmeasurable visual fidelity can never be required', () => {
  const errors = withTask('composition-positive-order-summary', (t) => {
    t.expectations.alpha1.checks.find(
      (c) => c.kind === 'visual.fidelity',
    ).required = true;
    return t;
  });
  assert.ok(
    errors.some((e) => e.includes('visual.fidelity is unmeasured')),
    errors.join('\n'),
  );
});

test('file restrictions must be independently checkable on every task', () => {
  const errors = withTask('variants-positive-remove-button', (t) => {
    t.expectations.alpha1.checks = t.expectations.alpha1.checks.filter(
      (c) => c.kind !== 'scope.diff',
    );
    return t;
  });
  assert.ok(
    errors.some((e) => e.includes('required scope.diff')),
    errors.join('\n'),
  );
});

test('classification and intended outcome must agree', () => {
  const capability = withTask('composition-failure-sticky-banner', (t) => {
    t.expectations.alpha1.intendedOutcome.kind = 'application-success';
    return t;
  });
  assert.ok(
    capability.some((e) =>
      e.includes(
        'missing-product-capability tasks must expect capability-gap-diagnosis',
      ),
    ),
    capability.join('\n'),
  );
  const vocabulary = withTask('themes-failure-sepia-reading', (t) => {
    t.capabilities.granted.push('design-system.edit');
    return t;
  });
  assert.ok(
    vocabulary.some((e) => e.includes('must not grant design-system.edit')),
    vocabulary.join('\n'),
  );
});

test('a stale lock is reported', () => {
  const copy = {
    ...loaded,
    corpus: { ...loaded.corpus, corpusVersion: '9.9.9' },
  };
  const { errors } = validateCorpus(copy);
  assert.ok(
    errors.some((e) => e.startsWith('corpus.lock.json is stale')),
    errors.join('\n'),
  );
});

test('glob matching for permitted writes', () => {
  assert.ok(matchesAny(['src/**'], 'src/a/b.jsx'));
  assert.ok(matchesAny(['src/**/*.jsx'], 'src/b.jsx'));
  assert.ok(!matchesAny(['src/*.jsx'], 'src/a/b.jsx'));
  assert.ok(
    matchesAny(
      ['..pandamstyle.pms-state.json'],
      '..pandamstyle.pms-state.json',
    ),
  );
  assert.ok(matchesAny(['{a,b}/x'], 'b/x'));
  assert.throws(() => globToRegExp('../x'));
  assert.throws(() => globToRegExp('/abs'));
});

test('static cascade: specificity boosters, order, media, states and variables', () => {
  const rules = parseCss(
    ':root, .t{--c:#111;--d:var(--c)}.dark.dark{--c:#eee}' +
      '.a:not(#\\#){color:red}.b:not(#\\#):not(#\\#){color:blue}.c:not(#\\#){color:var(--d)}' +
      '@media (min-width: 768px){.m.m:not(#\\#){padding:4px}}' +
      '.h:is(:hover, [data-hover]):not(#\\#){color:green}.x .y{color:pink}',
  );
  const root = { tag: 'html', classes: [], attributes: {}, isRoot: true };
  const el = (classes, attributes = {}) => ({
    tag: 'div',
    classes,
    attributes,
  });
  assert.equal(
    computeStyle(rules, [root, el(['a', 'b'])]).properties.color.declared,
    'blue',
  );
  assert.equal(
    computeStyle(rules, [root, el(['c'])]).properties.color.resolved,
    '#111',
  );
  assert.equal(
    computeStyle(rules, [root, el(['dark']), el(['c'])]).properties.color
      .resolved,
    '#eee',
  );
  assert.equal(
    computeStyle(rules, [root, el(['m'])], { viewportWidth: 767 }).properties
      .padding,
    undefined,
  );
  assert.equal(
    computeStyle(rules, [root, el(['m'])], { viewportWidth: 768 }).properties
      .padding.declared,
    '4px',
  );
  assert.equal(
    computeStyle(rules, [root, el(['h'])]).properties.color,
    undefined,
  );
  assert.equal(
    computeStyle(rules, [root, el(['h'])], { states: ['hover'] }).properties
      .color.declared,
    'green',
  );
  assert.equal(
    computeStyle(rules, [root, el(['h'], { 'data-hover': '' })]).properties
      .color.declared,
    'green',
  );
  assert.equal(
    computeStyle(rules, [root, el(['y'])]).unmeasuredProperties.color,
    'combinator',
  );
  assert.equal(evaluateMedia('(orientation: portrait)', {}), null);
});

test('server markup parsing and selection', () => {
  const tree = parseHtml(
    '<div data-testid="a" class="x y"><span>Hi &amp; <!-- -->bye</span><br/><input disabled=""/></div>',
  );
  const [div] = select(tree, { testId: 'a' });
  assert.equal(textContent(div), 'Hi & bye');
  assert.equal(
    select(tree, { tag: 'input', within: { testId: 'a' } })[0].attributes
      .disabled,
    '',
  );
  assert.throws(() => parseHtml('<div><span></div>'));
});

test('report extraction takes the last valid block and rejects malformed reports', () => {
  const block = (o) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
  const good = {
    schema: 'pms-eval-report/v1',
    outcome: 'completed',
    summary: '',
    changedFiles: [],
    checks: [],
    gaps: [],
    answers: {},
  };
  assert.equal(
    extractReport(`${block({ ...good, outcome: 'blocked' })}\n${block(good)}`)
      .report.outcome,
    'completed',
  );
  assert.match(
    extractReport(block({ ...good, outcome: 'done' })).error,
    /does not match schema/,
  );
  assert.match(extractReport('no block').error, /no pms-eval-report/);
  assert.match(extractReport(null).error, /no final response/);
});

test('materialized workspaces contain only the fixture project and task inputs', () => {
  const entry = findTask(loaded, 'repair-positive-unknown-tokens');
  const dest = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-agentic-materialize-'),
  );
  materializeTask({
    taskEntry: entry,
    fixture: loaded.fixtures.get(entry.task.workspace.fixture),
    dest: path.join(dest, 'ws'),
  });
  const files = spawnSync('git', ['ls-files'], {
    cwd: path.join(dest, 'ws'),
    encoding: 'utf8',
  }).stdout.split('\n');
  assert.ok(files.includes('src/components/PromoBanner.jsx'));
  for (const f of files)
    assert.ok(
      !/oracle-fixtures|task\.json|fixture\.json|prompt\.md/.test(f),
      f,
    );
  assert.match(
    fs.readFileSync(
      path.join(dest, 'ws/src/components/PromoBanner.jsx'),
      'utf8',
    ),
    /colors\.surface\.subtle/,
  );
  fs.rmSync(dest, { recursive: true, force: true });
  const prompt = buildPrompt({
    corpusRoot: CORPUS_ROOT,
    taskEntry: entry,
    docsPath: '/mnt/pms-docs',
  });
  assert.match(prompt, /pms-eval-report\/v1/);
  assert.match(prompt, /\/mnt\/pms-docs/);
});

test('held-out plaintext is never tracked and the manifest is internally consistent', () => {
  assert.deepEqual(guard(CORPUS_ROOT).problems, []);
  assert.deepEqual(verify(CORPUS_ROOT).problems, []);
  const allowed = new Set([
    'MANIFEST.json',
    'ACCESS-POLICY.md',
    'heldout.tar.gpg',
  ]);
  const tracked = spawnSync('git', ['ls-files', '--', 'heldout'], {
    cwd: CORPUS_ROOT,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean);
  for (const f of tracked)
    assert.ok(
      allowed.has(path.relative('heldout', f)),
      `unexpected tracked held-out file ${f}`,
    );
});

test('the guard fails when held-out plaintext is tracked or not ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-agentic-guard-'));
  const git = (...args) =>
    spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(root, 'heldout/.plaintext/tasks/leak'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(
    path.join(root, 'heldout/.plaintext/tasks/leak/task.json'),
    '{}',
  );
  fs.writeFileSync(
    path.join(root, 'heldout/MANIFEST.json'),
    JSON.stringify({ tasks: [] }),
  );
  git('add', '-f', 'heldout/.plaintext/tasks/leak/task.json');
  const problems = guard(root).problems.join('\n');
  assert.match(problems, /tracked held-out plaintext/);
  assert.match(problems, /is not gitignored/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no corpus input on disk is excluded by an ignore rule', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (abs.startsWith(path.join(CORPUS_ROOT, 'heldout', '.'))) continue;
      if (entry.isDirectory()) walk(abs);
      else files.push(path.relative(CORPUS_ROOT, abs));
    }
  };
  walk(CORPUS_ROOT);
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    cwd: CORPUS_ROOT,
    input: files.join('\n'),
    encoding: 'utf8',
  });
  assert.deepEqual(
    r.stdout.split('\n').filter(Boolean),
    [],
    'ignored corpus inputs would be missing from a clean checkout',
  );
});
