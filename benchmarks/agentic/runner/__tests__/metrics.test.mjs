/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Repairs, first-pass success and compiler attribution (F24-F27, F58), and
// the class-level checks of DESIGN.md section 9.2: no zero default in the
// accounting modules, a property test over mutated usage, and the
// classifier's independence from verdicts and free text.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  MODELS,
  STUB_GRADING,
  claudeInit,
  claudeResult,
  claudeText,
  codexStart,
  fixtureConfig,
  recordsOf,
  runFixture,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import * as claude from '../src/adapters/claude.mjs';
import * as codex from '../src/adapters/codex.mjs';
import { classify, classifyCodexMessage } from '../src/classify.mjs';
import { analyzeTimeline, classifyCommand } from '../src/commands.mjs';
import { RUNNER_ROOT } from '../src/util.mjs';

// A writable task: repairs need workspace writes.
const WRITE_TASK = 'composition-positive-order-summary';

async function run(
  steps,
  { model = MODELS.haiku, task = WRITE_TASK, verdict = 'pass' } = {},
) {
  const dir = tmpDir('metrics');
  const file = writeScenario(dir, 's', { steps });
  const out = await runFixture({
    config: fixtureConfig({ models: [model], tasks: [task] }),
    scenarios: { '*': [file] },
    grading: STUB_GRADING({ verdict }),
  });
  return recordsOf(out.matrixDir)[0];
}

const end = [claudeText('done'), claudeResult({ text: 'done' })];

test('F24 a shell-mediated write between a failed and a passing build is a repair', async () => {
  const r = await run([
    claudeInit(),
    { fakeRun: { command: 'npm run build', exitCode: 1, output: 'error' } },
    { run: "sed -i 's/$/ /' README.md" },
    { fakeRun: { command: 'npm run build', exitCode: 0 } },
    ...end,
  ]);
  assert.equal(r.metrics.repairCycles.value, 1);
  assert.equal(r.metrics.repairCycles.lowerBound, 1);
  assert.equal(
    r.metrics.repairCycles.method,
    'cli-stream-unattested+transcript-heuristic/v1',
  );
  assert.equal(r.metrics.firstPassSuccess, false);
});

test('F25 compound commands are opaque: first pass unknown', async () => {
  for (const command of [
    'npm run build || true',
    'npm run build && npm test',
  ]) {
    const r = await run([
      claudeInit(),
      { fakeRun: { command, exitCode: 0 } },
      ...end,
    ]);
    assert.equal(r.metrics.coverage.complete, false, command);
    assert.equal(r.metrics.firstPassSuccess, 'unknown', command);
  }
});

test('F26 a missing exit status or an interrupted item makes coverage incomplete', async () => {
  const noExit = [
    ...codexStart(),
    {
      emit: {
        type: 'item.started',
        item: {
          id: 'a',
          type: 'command_execution',
          command: 'ls',
          status: 'in_progress',
        },
      },
    },
    {
      emit: {
        type: 'item.completed',
        item: {
          id: 'a',
          type: 'command_execution',
          command: 'ls',
          aggregated_output: '',
          status: 'mystery',
        },
      },
    },
    {
      emit: {
        type: 'item.started',
        item: {
          id: 'b',
          type: 'command_execution',
          command: 'cat README.md',
          status: 'in_progress',
        },
      },
    },
    {
      emit: {
        type: 'item.completed',
        item: { id: 'm', type: 'agent_message', text: 'done' },
      },
    },
    {
      emit: {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      },
    },
  ];
  const r = await run(noExit, { model: MODELS.sol });
  assert.equal(r.metrics.coverage.complete, false);
  assert.ok(
    r.metrics.coverage.reasons.some((x) => x.startsWith('unknown-status')),
  );
  assert.ok(r.metrics.coverage.reasons.some((x) => x.startsWith('unfinished')));
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
});

test('F27 a custom verification script is opaque; compiler time unattributed', async () => {
  const r = await run([
    claudeInit(),
    { fakeRun: { command: './check.sh', exitCode: 0 } },
    {
      fakeRun: { command: 'node_modules/.bin/pandamstyle build', exitCode: 0 },
    },
    ...end,
  ]);
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.equal(
    r.metrics.compilerCost.agentAttributedCommands.status,
    'unknown',
  );
  assert.equal(r.metrics.compilerCost.agentVerifyCommands.value, 1);
});

test('F58 fail -> repair -> pass inside `npm run verify` exiting 0: no repair seen, first pass unknown', async () => {
  const script = [
    "node -e \"process.exit(require('fs').existsSync('.fixed') ? 0 : 1)\" || true",
    'touch .fixed',
    'echo "/* repaired */" >> README.md',
    "node -e \"process.exit(require('fs').existsSync('.fixed') ? 0 : 1)\"",
  ].join('\n');
  const r = await run([
    claudeInit(),
    { write: { path: '.verify.sh', content: `${script}\n` } },
    { run: 'sh .verify.sh', as: 'npm run verify' },
    ...end,
  ]);
  assert.equal(r.metrics.repairCycles.value, 0);
  assert.equal(r.metrics.repairCycles.lowerBound, 0);
  assert.equal(r.outcome.taskSuccess, true);
  assert.equal(r.metrics.firstPassSuccess, 'unknown');
  assert.ok(r.metrics.coverage.reasons.some((x) => x.startsWith('opaque')));
});

test('first pass true needs success, no repair and complete coverage', async () => {
  const r = await run(
    [claudeInit(), { run: 'ls' }, { run: 'git status' }, ...end],
    { task: 'discovery-positive-card-vocabulary' },
  );
  assert.equal(r.metrics.firstPassSuccess, true);
  const failed = await run([claudeInit(), { run: 'ls' }, ...end], {
    task: 'discovery-positive-card-vocabulary',
    verdict: 'fail',
  });
  assert.equal(failed.metrics.firstPassSuccess, false);
});

test('command table: closed allowlist, everything else opaque', () => {
  const transparent = [
    'ls -la',
    'cat src/a.js',
    'grep -rn foo src',
    'find src -name "*.js"',
    'sed -n 1,10p a',
    'git diff',
    'git log --oneline',
    'echo hi',
    'rg foo',
  ];
  const opaque = [
    'npm run build',
    'npm test',
    'yarn build',
    'npx tsc',
    'pnpm dlx x',
    'yarn dlx x',
    'make',
    'sh x.sh',
    './x',
    'node a.js',
    'pandamstyle build',
    'find . -exec rm {} ;',
    'find . -delete',
    "sed -i 's/a/b/' f",
    'rg --pre=cat x',
    'git commit -m x',
    'ls; rm -rf x',
    'cat a > b',
    'echo $(id)',
    'ls | wc',
    '/bin/ls',
    'git diff --output=x',
  ];
  for (const c of transparent)
    assert.equal(classifyCommand(c).class, 'transparent', c);
  for (const c of opaque) assert.equal(classifyCommand(c).class, 'opaque', c);
  assert.equal(classifyCommand('npm run build').verify, true);
  assert.equal(classifyCommand('npx pandamstyle build').verify, true);
});

test('analyzeTimeline: output written by a failing check is not a repair', () => {
  const calls = [
    {
      kind: 'command',
      command: 'npm run build',
      status: 'failed',
      exitCode: 1,
    },
    {
      kind: 'command',
      command: 'npm run build',
      status: 'completed',
      exitCode: 0,
    },
  ];
  const t = analyzeTimeline({
    toolCalls: calls,
    deltas: ['a', 'b'],
    taskSuccess: true,
  });
  assert.equal(t.repairCycles.value, 0);
});

// Section 9.2: unknown-as-zero lint over the accounting modules.
const ACCOUNTING = [
  'src/adapters/claude.mjs',
  'src/adapters/codex.mjs',
  'src/measured.mjs',
  'src/commands.mjs',
  'src/report.mjs',
];

test('class: no zero default in the accounting modules (lint)', () => {
  const zeroDefault = /(\?\?|\|\|)\s*0(?![.\dxX])/;
  for (const rel of ACCOUNTING) {
    const lines = fs
      .readFileSync(path.join(RUNNER_ROOT, rel), 'utf8')
      .split('\n');
    lines.forEach((line, i) => {
      if (line.trim().startsWith('//')) return;
      assert.doesNotMatch(line, zeroDefault, `${rel}:${i + 1}: ${line.trim()}`);
    });
  }
});

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function feed(adapter, events, requestedModel) {
  const p = adapter.createParser({ requestedModel });
  for (const e of events) p.push(e);
  return p.finish();
}

test('class: removing or zeroing usage fields never yields a value without its provenance (property)', () => {
  const rand = prng(42);
  const codexFields = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
  ];
  const claudeFields = [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'thinkingTokens',
  ];
  for (let i = 0; i < 300; i += 1) {
    const usage = {
      input_tokens: 500,
      cached_input_tokens: 200,
      cache_write_input_tokens: 10,
      output_tokens: 90,
      reasoning_output_tokens: 30,
    };
    for (const f of codexFields) {
      const x = rand();
      if (x < 0.3) delete usage[f];
      else if (x < 0.6) usage[f] = 0;
    }
    const s = feed(
      codex,
      [
        { type: 'thread.started', thread_id: 't' },
        { type: 'turn.started' },
        { type: 'turn.completed', usage },
      ],
      'gpt-6.1-sol',
    );
    const t = s.tokens.normalized.total;
    const allZero = codexFields.every(
      (f) => usage[f] === 0 || usage[f] === undefined,
    );
    for (const [k, m] of Object.entries(t)) {
      assert.notEqual(m.status, 'observed', k);
      if (allZero)
        assert.equal(m.status, 'unknown', `${k} with all-zero usage`);
      if (m.status !== 'unknown')
        assert.equal(m.method, 'cli-stream-unattested', k);
    }
    for (const [k, f] of [
      ['inputCacheRead', 'cached_input_tokens'],
      ['inputCacheWrite', 'cache_write_input_tokens'],
      ['outputReasoning', 'reasoning_output_tokens'],
    ])
      if (!(usage[f] > 0))
        assert.equal(t[k].status, 'unknown', `${k} from ${usage[f]}`);
    for (const [k, f] of [
      ['inputTotal', 'input_tokens'],
      ['outputTotal', 'output_tokens'],
    ])
      if (typeof usage[f] !== 'number') assert.equal(t[k].status, 'unknown', k);

    const entry = {
      inputTokens: 40,
      outputTokens: 40,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 5,
      thinkingTokens: 9,
      costBasis: 'list',
    };
    for (const f of claudeFields) {
      const x = rand();
      if (x < 0.3) delete entry[f];
      else if (x < 0.5) entry[f] = 0;
    }
    const isError = rand() < 0.3;
    const synthetic = rand() < 0.3;
    const events = [
      {
        type: 'system',
        subtype: 'init',
        tools: claude.ALLOWED_TOOLS,
        model: 'm',
      },
      {
        type: 'assistant',
        message: {
          id: 'a',
          model: synthetic ? '<synthetic>' : 'm',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
      },
      {
        type: 'result',
        is_error: isError,
        num_turns: 1,
        total_cost_usd: 0,
        modelUsage: { m: entry },
      },
    ];
    const c = feed(claude, events, 'm');
    for (const [k, m] of Object.entries(c.tokens.normalized.total)) {
      assert.notEqual(m.status, 'observed', k);
      if (synthetic)
        assert.equal(m.status, 'unknown', `${k} with only synthetic messages`);
      if (isError && m.status !== 'unknown')
        assert.notEqual(m.value, 0, `${k}: zero on an error result`);
    }
    if (isError)
      assert.equal(c.cost.status, 'unknown', 'zero cost on an error result');
    if (typeof entry.inputTokens !== 'number')
      assert.equal(c.tokens.normalized.total.inputTotal.status, 'unknown');
  }
});

test('class: the classifier takes no verdict, workspace or free text (except the pinned Codex table)', () => {
  const base = {
    cli: 'claude',
    terminal: { kind: 'result', isError: false },
    exit: { code: 0, signal: null },
    harness: {},
    anomalies: [],
    configMismatch: false,
    fidelity: 'faithful',
    breaches: [],
  };
  const a = classify(base);
  // Extra inputs are ignored by construction.
  const b = classify({
    ...base,
    verdict: 'fail',
    workspace: '/x',
    finalMessage: 'rate_limit',
    toolOutput: 'overloaded',
  });
  assert.deepEqual(a, b);
  // Randomized text never matches a pinned pattern by accident.
  const rand = prng(7);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz :.,-/0123456789';
  for (let i = 0; i < 2000; i += 1) {
    let text = '';
    const n = 1 + Math.floor(rand() * 60);
    for (let j = 0; j < n; j += 1)
      text += alphabet[Math.floor(rand() * alphabet.length)];
    assert.equal(classifyCodexMessage(text).class, 'unclassified', text);
  }
  // Only anchored pinned strings classify.
  assert.equal(
    classifyCodexMessage('note: You’ve hit your usage limit').class,
    'unclassified',
  );
  assert.equal(
    classifyCodexMessage('You’ve hit your usage limit.').code,
    'rate-limit',
  );
});
