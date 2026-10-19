/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Adapter fixtures F1-F20, F22, F23, F28, F29 and F36-F38 (DESIGN.md section
// 9.1). Fake `claude` / `codex` executables replay synthetic streams through
// the real matrix, parsing, classification, accounting and record code. No
// provider is contacted.

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
  codexDone,
  codexFailed,
  codexMessage,
  codexStart,
  fixtureConfig,
  goodDiscoveryResponse,
  recordsOf,
  runFixture,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { checkMeasured } from '../src/measured.mjs';
import { buildReport, loadMatrix } from '../src/report.mjs';

const TASK = 'discovery-positive-card-vocabulary';

/** Runs one cell with one scenario per attempt; returns records and outcomes. */
async function run(
  attempts,
  { model = MODELS.haiku, config = {}, grading = STUB_GRADING(), ...rest } = {},
) {
  const dir = tmpDir('scenarios');
  const files = attempts.map((a, i) =>
    writeScenario(dir, `attempt-${i + 1}`, Array.isArray(a) ? { steps: a } : a),
  );
  const out = await runFixture({
    config: fixtureConfig({ models: [model], ...config }),
    scenarios: { '*': files },
    grading,
    ...rest,
  });
  lastMatrixDir = out.matrixDir;
  return { ...out, records: recordsOf(out.matrixDir) };
}

let lastMatrixDir = null;
function findRecordFile(r) {
  return path.join(
    lastMatrixDir,
    'cells',
    r.cell.taskId,
    r.cell.modelKey,
    `rep-${r.repetition}`,
    `attempt-${r.attempt}`,
    'record.json',
  );
}

function allMeasured(record) {
  const out = [];
  const visit = (v, at) => {
    if (v == null || typeof v !== 'object') return;
    if (typeof v.status === 'string' && 'value' in v && 'source' in v)
      out.push([at, v]);
    else for (const [k, x] of Object.entries(v)) visit(x, `${at}.${k}`);
  };
  visit(record.metrics, 'metrics');
  return out;
}

function assertMeasuredRules(record) {
  for (const [at, m] of allMeasured(record)) {
    assert.deepEqual(checkMeasured(m, at), []);
    // Section 0.4: nothing stream-derived is ever observed.
    if (m.integrity === 'cli-unattested')
      assert.notEqual(m.status, 'observed', at);
  }
}

const claudeOk = (extra = []) => [
  claudeInit(),
  { run: 'ls' },
  ...extra,
  claudeText(goodDiscoveryResponse()),
  claudeResult({ text: goodDiscoveryResponse() }),
];

test('F1 Claude success: parsing, transcript, tool counts, estimates', async () => {
  const { records } = await run([claudeOk()], { grading: undefined });
  const [r] = records;
  assert.equal(r.outcome.code, 'completed');
  assert.equal(r.grading.verdict, 'pass');
  assert.equal(r.outcome.taskSuccess, true);
  assert.equal(r.metrics.toolCalls.total.value, 1);
  assert.equal(r.metrics.toolCalls.command.value, 1);
  assert.equal(r.metrics.toolCalls.total.status, 'estimate');
  assert.equal(r.metrics.cost.status, 'estimate');
  assert.equal(
    r.metrics.cost.method,
    'cli-stream-unattested+claude-cli-api-equivalent',
  );
  assert.equal(r.metrics.tokens.normalized.total.inputTotal.value, 140);
  assert.equal(
    r.metrics.tokens.normalized.total.inputTotal.method,
    'cli-stream-unattested',
  );
  assert.equal(r.metrics.elapsed.agentPhaseMs.status, 'observed');
  assert.equal(r.metrics.elapsed.agentPhaseMs.integrity, 'harness');
  assert.equal(r.integrity.stream, 'cli-unattested');
  const transcript = fs.readFileSync(
    path.join(path.dirname(findRecordFile(r)), 'transcript.jsonl'),
    'utf8',
  );
  assert.match(transcript, /"command":"ls"/);
  assertMeasuredRules(r);
});

const codexOk = (usage) => [
  ...codexStart(),
  { run: 'ls' },
  codexMessage(goodDiscoveryResponse()),
  codexDone(usage),
];

test('F2 Codex success with non-zero usage: tokens estimated, cost unknown', async () => {
  const { records } = await run([codexOk()], {
    model: MODELS.sol,
    grading: undefined,
  });
  const [r] = records;
  assert.equal(r.outcome.code, 'completed');
  assert.equal(r.grading.verdict, 'pass');
  const t = r.metrics.tokens.normalized.total;
  assert.equal(t.inputTotal.value, 1000);
  assert.equal(t.inputCacheRead.value, 600);
  assert.equal(t.inputUncached.value, 400);
  assert.equal(t.outputReasoning.value, 50);
  assert.equal(r.metrics.cost.status, 'unknown');
  assert.equal(r.metrics.agentSteps.status, 'unknown');
  assert.equal(r.provider.primaryModelFidelity, 'no-reroute-surfaced');
  assertMeasuredRules(r);
});

test('F3 Codex all-zero usage is unknown, never 0 (AC2)', async () => {
  const zero = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  const { records } = await run([codexOk(zero)], { model: MODELS.sol });
  for (const [k, m] of Object.entries(
    records[0].metrics.tokens.normalized.total,
  )) {
    assert.equal(m.status, 'unknown', k);
    assert.equal(m.value, null, k);
  }
});

test('F4 Codex zero detail counters are unknown, totals estimated', async () => {
  const { records } = await run(
    [
      codexOk({
        input_tokens: 900,
        cached_input_tokens: 0,
        output_tokens: 120,
        reasoning_output_tokens: 0,
      }),
    ],
    { model: MODELS.sol },
  );
  const t = records[0].metrics.tokens.normalized.total;
  assert.equal(t.inputTotal.status, 'estimate');
  assert.equal(t.outputTotal.value, 120);
  assert.equal(t.inputCacheRead.status, 'unknown');
  assert.equal(t.outputReasoning.status, 'unknown');
  assert.equal(t.inputUncached.status, 'unknown');
});

test('F5 Codex cumulative usage snapshots: the last one, never a sum', async () => {
  const steps = [
    ...codexStart(),
    codexMessage(goodDiscoveryResponse()),
    codexDone({
      input_tokens: 100,
      cached_input_tokens: 10,
      output_tokens: 10,
      reasoning_output_tokens: 1,
    }),
    codexDone({
      input_tokens: 300,
      cached_input_tokens: 30,
      output_tokens: 30,
      reasoning_output_tokens: 3,
    }),
  ];
  const { records } = await run([steps], { model: MODELS.sol });
  const r = records[0];
  assert.equal(r.metrics.tokens.normalized.total.inputTotal.value, 300);
  assert.equal(r.metrics.tokens.normalized.total.outputTotal.value, 30);
  // Two terminal events remain a stream anomaly (F20): the attempt is invalid.
  assert.equal(r.outcome.code, 'adapter-stream');
  assert.equal(r.outcome.valid, false);
});

const authFailure = [
  claudeInit({ model: '${REQUESTED_MODEL}' }),
  {
    emit: {
      type: 'assistant',
      message: {
        id: 'synthetic',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Not logged in' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: '${SESSION}',
      error: 'authentication_failed',
    },
  },
  claudeResult({
    isError: true,
    subtype: 'success',
    terminalReason: 'api_error',
    cost: 0,
    modelUsage: {},
    numTurns: 1,
  }),
];

test('F6 + F12 Claude observed auth-failure shape: everything unknown, provider halted', async () => {
  const { records, outcomes } = await run(
    [{ steps: authFailure, exitCode: 1 }],
    { config: { tasks: [TASK, 'composition-positive-order-summary'] } },
  );
  const r = records[0];
  for (const m of Object.values(r.metrics.tokens.normalized.total))
    assert.equal(m.status, 'unknown');
  assert.equal(r.metrics.cost.status, 'unknown');
  assert.equal(r.metrics.agentSteps.status, 'unknown');
  assert.equal(r.outcome.class, 'infrastructure');
  assert.equal(r.outcome.code, 'auth');
  assert.equal(r.outcome.retry.scheduled, false);
  assert.equal(records.length, 1, 'auth is not retried and halts the provider');
  assert.equal(outcomes[1].status, 'missing');
  assert.match(outcomes[1].reason, /halted: auth/);
});

test('F12 Codex auth message', async () => {
  const { records } = await run(
    [
      [
        ...codexStart(),
        codexFailed('unexpected status 401 Unauthorized: token expired'),
      ],
    ],
    { model: MODELS.sol },
  );
  assert.equal(records[0].outcome.code, 'auth');
  assert.equal(records.length, 1);
});

test('F7 Claude duplicate assistant events per message.id; discrepancy recorded', async () => {
  const dup = claudeText('partial', {
    id: 'msg_a',
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  const steps = [
    claudeInit(),
    dup,
    dup,
    claudeText(goodDiscoveryResponse(), {
      id: 'msg_b',
      usage: {
        input_tokens: 5,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }),
    claudeResult({ text: goodDiscoveryResponse() }),
  ];
  const { records } = await run([steps]);
  const d = records[0].metrics.tokens.discrepancy;
  // De-duplicated by message.id: 7 + 5, not 7 + 7 + 5.
  assert.equal(d.status, 'disagreement');
  assert.equal(d.messagesInput, 12);
  assert.equal(d.modelUsageInput, 40);
});

test('F8 Claude cache and thinking counters: additive input, reasoning subset', async () => {
  const mu = {
    '${REQUESTED_MODEL}': {
      inputTokens: 10,
      outputTokens: 200,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 50,
      thinkingTokens: 80,
      costUSD: 0.1,
      costBasis: 'list',
    },
  };
  const steps = [
    claudeInit(),
    claudeText(goodDiscoveryResponse(), {
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      },
    }),
    claudeResult({ text: goodDiscoveryResponse(), modelUsage: mu, cost: 0.1 }),
  ];
  const { records } = await run([steps]);
  const t = records[0].metrics.tokens.normalized.total;
  assert.equal(t.inputUncached.value, 10);
  assert.equal(t.inputCacheRead.value, 1000);
  assert.equal(t.inputCacheWrite.value, 50);
  assert.equal(t.inputTotal.value, 1060);
  assert.equal(t.outputTotal.value, 200);
  assert.equal(t.outputReasoning.value, 80);
  assert.ok(t.outputReasoning.value <= t.outputTotal.value);
});

test('F9 costBasis unknown makes cost unknown', async () => {
  const mu = {
    '${REQUESTED_MODEL}': {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.5,
      costBasis: 'unknown',
    },
  };
  const { records } = await run([
    [
      claudeInit(),
      claudeText('x'),
      claudeResult({ modelUsage: mu, cost: 0.5 }),
    ],
  ]);
  assert.equal(records[0].metrics.cost.status, 'unknown');
  assert.equal(records[0].metrics.cost.reason, 'costBasis unknown');
});

const rateLimited = (resetsAt) => [
  claudeInit(),
  {
    emit: {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt,
        rateLimitType: 'five_hour',
      },
      session_id: '${SESSION}',
    },
  },
  {
    emit: {
      type: 'assistant',
      message: {
        id: 'syn',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'limit' }],
      },
      parent_tool_use_id: null,
      session_id: '${SESSION}',
      error: 'rate_limit',
    },
  },
  claudeResult({
    isError: true,
    terminalReason: 'api_error',
    modelUsage: {},
    cost: 0,
  }),
];

test('F10 Claude rate limit: infrastructure, backoff from resetsAt, retry contested (F22 rule)', async () => {
  const sleeps = [];
  const clock = { now: () => new Date(), sleep: async (ms) => sleeps.push(ms) };
  const resetsAt = Math.floor(Date.now() / 1000) + 120;
  const { records, matrixDir } = await run(
    [{ steps: rateLimited(resetsAt), exitCode: 1 }, claudeOk()],
    { clock, config: { retry: { baseSeconds: 60, capSeconds: 1800 } } },
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].outcome.code, 'rate-limit');
  assert.equal(records[0].outcome.retry.scheduled, true);
  assert.ok(
    records[0].outcome.retry.backoffSeconds > 100 &&
      records[0].outcome.retry.backoffSeconds <= 121,
  );
  assert.equal(sleeps.length, 1);
  assert.equal(records[1].integrity.contested, true);
  const cell = buildReport(loadMatrix(matrixDir)).cells[0];
  assert.equal(cell.success.pointEstimate, 1);
  assert.equal(cell.success.lowerBound, 0);
  assert.equal(cell.success.contested, 1);
});

test('F10 Codex usage-limit message', async () => {
  const { records } = await run(
    [
      [
        ...codexStart(),
        codexFailed(
          'You’ve hit your usage limit. Upgrade to Pro or try again later.',
        ),
      ],
      codexOk(),
    ],
    { model: MODELS.sol },
  );
  assert.equal(records[0].outcome.code, 'rate-limit');
  assert.equal(records[1].outcome.code, 'completed');
  assert.equal(records[1].integrity.contested, true);
});

test('F11 capacity for both CLIs', async () => {
  const overloaded = [
    claudeInit(),
    {
      emit: {
        type: 'assistant',
        message: {
          id: 's',
          model: '<synthetic>',
          role: 'assistant',
          content: [],
        },
        parent_tool_use_id: null,
        session_id: '${SESSION}',
        error: 'overloaded',
      },
    },
    claudeResult({
      isError: true,
      terminalReason: 'api_error',
      modelUsage: {},
    }),
  ];
  const a = await run([overloaded, claudeOk()]);
  assert.equal(a.records[0].outcome.code, 'capacity');
  const b = await run(
    [
      [
        ...codexStart(),
        codexFailed(
          'Selected model is at capacity. Please try a different model.',
        ),
      ],
      codexOk(),
    ],
    { model: MODELS.sol },
  );
  assert.equal(b.records[0].outcome.code, 'capacity');
});

test('F13 Codex reconnect notices are noise, not terminal', async () => {
  const steps = [
    ...codexStart(),
    {
      emit: {
        type: 'error',
        message: 'Reconnecting... 1/5 (stream disconnected before completion)',
      },
    },
    {
      emit: {
        type: 'error',
        message: 'Reconnecting... 2/5 (stream disconnected before completion)',
      },
    },
    codexMessage(goodDiscoveryResponse()),
    codexDone(),
  ];
  const { records } = await run([steps], { model: MODELS.sol });
  assert.equal(records[0].outcome.code, 'completed');
  assert.equal(records[0].provider.reconnects, 2);
});

test('F14 unclassified terminal errors: not retried, counted in the bound', async () => {
  const codexUnmatched = await run(
    [[...codexStart(), codexFailed('something nobody has seen before')]],
    { model: MODELS.sol },
  );
  assert.equal(codexUnmatched.records[0].outcome.class, 'unclassified');
  assert.equal(codexUnmatched.records.length, 1);
  const claudeUnknown = await run([
    [
      claudeInit(),
      {
        emit: {
          type: 'assistant',
          message: {
            id: 's',
            model: '<synthetic>',
            role: 'assistant',
            content: [],
          },
          parent_tool_use_id: null,
          session_id: '${SESSION}',
          error: 'unknown',
        },
      },
      claudeResult({
        isError: true,
        terminalReason: 'api_error',
        modelUsage: {},
      }),
    ],
  ]);
  assert.equal(claudeUnknown.records[0].outcome.class, 'unclassified');
  const reason = await run([
    [
      claudeInit(),
      claudeText('x'),
      claudeResult({ isError: true, terminalReason: 'brand_new_reason' }),
    ],
  ]);
  assert.equal(reason.records[0].outcome.class, 'unclassified');
  const cell = buildReport(loadMatrix(reason.matrixDir)).cells[0];
  assert.equal(cell.valid, 0);
  assert.equal(cell.success.lowerBound, 0);
});

test('F15 Codex reroute item is a model-fidelity violation', async () => {
  const steps = [
    ...codexStart(),
    {
      emit: {
        type: 'item.completed',
        item: {
          id: 'e1',
          type: 'error',
          message: 'model rerouted: gpt-6.1-sol -> gpt-6.1-mini (capacity)',
        },
      },
    },
    codexMessage('x'),
    codexDone(),
  ];
  const { records } = await run([steps], { model: MODELS.sol });
  assert.equal(records[0].outcome.code, 'model-fidelity');
  assert.equal(records[0].outcome.valid, false);
  assert.deepEqual(records[0].provider.reroutes, [
    'gpt-6.1-sol -> gpt-6.1-mini',
  ]);
});

test('F16 Claude fallback event or a different main-loop model', async () => {
  const fallback = await run([
    [
      claudeInit(),
      {
        emit: {
          type: 'system',
          subtype: 'model_refusal_fallback',
          original_model: 'claude-haiku-5-5',
          fallback_model: 'claude-sonnet-5-5',
          session_id: '${SESSION}',
        },
      },
      claudeText('x'),
      claudeResult(),
    ],
  ]);
  assert.equal(fallback.records[0].outcome.code, 'model-fidelity');
  const other = await run([
    [
      claudeInit(),
      claudeText('x', { model: 'claude-opus-5-5' }),
      claudeResult(),
    ],
  ]);
  assert.equal(other.records[0].outcome.code, 'model-fidelity');
});

test('F16 three fidelity violations halt the provider', async () => {
  const bad = [
    claudeInit(),
    claudeText('x', { model: 'claude-opus-5-5' }),
    claudeResult(),
  ];
  const { outcomes } = await run([bad], {
    config: {
      tasks: [TASK, 'composition-positive-order-summary'],
      repetitions: 2,
    },
  });
  assert.equal(outcomes.filter((o) => o.code === 'model-fidelity').length, 3);
  assert.match(outcomes.at(-1).reason, /model-fidelity x3/);
});

test('F17 auxiliary model usage is reported, not a violation', async () => {
  const mu = {
    '${REQUESTED_MODEL}': {
      inputTokens: 40,
      outputTokens: 40,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
      costUSD: 0.01,
      costBasis: 'list',
    },
    'claude-haiku-4-5': {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0.001,
      costBasis: 'list',
    },
  };
  const { records } = await run([
    [
      claudeInit(),
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse(), modelUsage: mu }),
    ],
  ]);
  const r = records[0];
  assert.equal(r.provider.primaryModelFidelity, 'faithful');
  assert.deepEqual(r.provider.auxiliaryModels, ['claude-haiku-4-5']);
  assert.equal(r.outcome.code, 'completed');
});

test('F18 Claude init.tools with WebSearch is config-integrity', async () => {
  const { records } = await run([
    [
      claudeInit({
        tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'WebSearch'],
      }),
      claudeText('x'),
      claudeResult(),
    ],
  ]);
  assert.equal(records[0].outcome.code, 'config-integrity');
  assert.equal(records[0].modelConfig.effectiveConfig.web, 'enabled');
});

test('F18 + F36 Codex web_search and collab items are tool-policy breaches', async () => {
  for (const item of [
    { id: 'w', type: 'web_search', query: 'pandamstyle docs' },
    {
      id: 'c',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      status: 'completed',
    },
  ]) {
    const steps = [
      ...codexStart(),
      { emit: { type: 'item.started', item } },
      { emit: { type: 'item.completed', item } },
      codexMessage(goodDiscoveryResponse()),
      codexDone(),
    ];
    const { records, matrixDir } = await run([steps], { model: MODELS.sol });
    assert.equal(records[0].outcome.class, 'policy');
    assert.equal(records[0].outcome.code, 'tool-policy-breach');
    assert.equal(records[0].outcome.taskSuccess, false);
    assert.equal(buildReport(loadMatrix(matrixDir)).breaches.length, 1);
  }
});

test('F36 Claude web and subagent tool use', async () => {
  for (const name of ['WebFetch', 'Agent']) {
    const steps = [
      claudeInit(),
      {
        emit: {
          type: 'assistant',
          message: {
            id: `m${name}`,
            model: '${REQUESTED_MODEL}',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name, input: {} }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          session_id: '${SESSION}',
        },
      },
      {
        emit: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                is_error: true,
                content: 'denied',
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: '${SESSION}',
        },
      },
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ];
    const { records } = await run([steps]);
    assert.equal(records[0].outcome.code, 'tool-policy-breach', name);
    assert.equal(records[0].outcome.taskSuccess, false);
  }
});

test('F19 interrupted Codex turn: harness timeout vs abnormal exit', async () => {
  const hang = {
    steps: [
      ...codexStart(),
      {
        emit: {
          type: 'item.started',
          item: {
            id: 'x',
            type: 'command_execution',
            command: 'sleep 100',
            status: 'in_progress',
          },
        },
      },
      { waitForever: true },
    ],
  };
  const timed = await run([hang], {
    model: MODELS.sol,
    config: {
      budgets: {
        timeoutSecondsOverride: 1,
        graceInterruptMs: 200,
        graceTerminateMs: 200,
      },
    },
  });
  assert.equal(timed.records[0].outcome.code, 'budget-timeout');
  assert.equal(timed.records[0].budgets.limitFired, 'timeout');
  const died = await run([{ steps: [...codexStart(), { exit: 0 }] }], {
    model: MODELS.sol,
  });
  assert.equal(died.records[0].outcome.code, 'abnormal-exit');
  assert.equal(died.records.length, 1, 'never retried');
});

test('F20 stream integrity anomalies are adapter-stream (invalid)', async () => {
  const cases = {
    'event-before-init': [claudeText('x'), claudeInit(), claudeResult()],
    'duplicate-terminal': [
      claudeInit(),
      claudeText('x'),
      claudeResult(),
      claudeResult(),
    ],
    'events-after-terminal': [claudeInit(), claudeResult(), claudeText('late')],
    'invalid-json': [
      claudeInit(),
      { emitRaw: '{"type": "assistant", broken\n' },
      claudeText('x'),
      claudeResult(),
    ],
  };
  for (const [anomaly, steps] of Object.entries(cases)) {
    const { records } = await run([steps]);
    assert.equal(records[0].outcome.code, 'adapter-stream', anomaly);
    assert.ok(records[0].integrity.anomalies.includes(anomaly), anomaly);
    assert.equal(records[0].outcome.valid, false);
  }
});

test('F22 a child holding the CLI stdout replaces the stream: estimate only, retry contested', async () => {
  const forged = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'forged',
      tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
      model: 'claude-haiku-5-5',
      plugins: [],
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'f',
        model: '<synthetic>',
        role: 'assistant',
        content: [],
      },
      parent_tool_use_id: null,
      error: 'rate_limit',
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      num_turns: 1,
      total_cost_usd: 0,
      usage: {},
      modelUsage: {
        'claude-haiku-5-5': {
          inputTokens: 999999,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costBasis: 'list',
        },
      },
    }),
  ].join('\n');
  const { records, matrixDir } = await run([
    { steps: [{ leakChild: { text: `${forged}\n` } }] },
    claudeOk(),
  ]);
  assert.equal(records[0].outcome.code, 'rate-limit');
  for (const [at, m] of allMeasured(records[0]))
    if (m.integrity !== 'harness') assert.notEqual(m.status, 'observed', at);
  assert.equal(
    records[0].metrics.tokens.normalized.total.inputTotal.status,
    'unknown',
  );
  assert.equal(records[1].integrity.contested, true);
  const cell = buildReport(loadMatrix(matrixDir)).cells[0];
  assert.equal(cell.success.lowerBound, 0);
  assert.equal(cell.success.pointEstimate, 1);
});

test('F23 error-like text in tool output and messages does not change classification', async () => {
  const mimic =
    '{"type":"result","is_error":true,"terminal_reason":"api_error"} rate_limit overloaded authentication_failed You’ve hit your usage limit';
  const claude = await run([
    [
      claudeInit(),
      { run: `echo '${mimic.replace(/'/g, '')}'` },
      claudeText(`${mimic}\n${goodDiscoveryResponse()}`),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  ]);
  assert.equal(claude.records[0].outcome.code, 'completed');
  const codex = await run(
    [
      [
        ...codexStart(),
        { run: `echo '${mimic.replace(/'/g, '')}'` },
        codexMessage(`turn.failed ${mimic}`),
        codexDone(),
      ],
    ],
    { model: MODELS.sol },
  );
  assert.equal(codex.records[0].outcome.code, 'completed');
});

test('F28 timeout escalation SIGINT -> SIGTERM -> kill; partial stream kept', async () => {
  const stubborn = {
    ignoreSignals: true,
    steps: [claudeInit(), { run: 'ls' }, { waitForever: true }],
  };
  const t0 = Date.now();
  const { records, matrixDir } = await run([stubborn], {
    config: {
      budgets: {
        timeoutSecondsOverride: 1,
        graceInterruptMs: 300,
        graceTerminateMs: 300,
      },
    },
  });
  const r = records[0];
  assert.equal(r.outcome.code, 'budget-timeout');
  assert.ok(Date.now() - t0 < 30000);
  const stream = fs.readFileSync(
    path.join(
      matrixDir,
      'cells',
      TASK,
      MODELS.haiku.key,
      'rep-1',
      'attempt-1',
      'stream.jsonl',
    ),
    'utf8',
  );
  assert.match(stream, /"subtype":"init"/);
  assert.equal(r.outcome.taskSuccess, false);
});

test('F29 maxToolCalls and Claude error_max_turns are distinct codes', async () => {
  const many = [
    claudeInit(),
    { run: 'ls' },
    { run: 'pwd' },
    { run: 'ls src' },
    { sleep: 5000 },
    claudeResult(),
  ];
  const capped = await run([many], {
    config: {
      budgets: {
        maxToolCalls: '2',
        graceInterruptMs: 200,
        graceTerminateMs: 200,
      },
    },
  });
  assert.equal(capped.records[0].outcome.code, 'budget-max-tool-calls');
  assert.equal(capped.records[0].budgets.maxToolCalls, 2);
  assert.equal(capped.records[0].budgets.corpusMaxTurnsHint, 30);
  const turns = await run([
    [
      claudeInit(),
      claudeText('x'),
      claudeResult({
        isError: true,
        subtype: 'error_max_turns',
        terminalReason: 'max_turns',
      }),
    ],
  ]);
  assert.equal(turns.records[0].outcome.code, 'cli-max-turns');
  assert.equal(turns.records[0].budgets.cliMaxTurns, 60);
});

test('F37 host.build in a read-only task is detect-and-fail', async () => {
  const { records } = await run([
    [
      claudeInit(),
      { fakeRun: { command: 'npx vite build --outDir /tmp/out', exitCode: 0 } },
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  ]);
  assert.equal(records[0].outcome.class, 'policy');
  assert.ok(records[0].outcome.breaches.some((b) => b.kind === 'host-build'));
  assert.equal(records[0].outcome.taskSuccess, false);
});

test('F37 a dev server is detect-and-fail', async () => {
  const { records } = await run([
    [
      claudeInit(),
      { fakeRun: { command: 'npm run dev', exitCode: 0 } },
      claudeText('x'),
      claudeResult(),
    ],
  ]);
  assert.ok(records[0].outcome.breaches.some((b) => b.kind === 'dev-server'));
});

test('F38 a local install is detected through the node_modules digest', async () => {
  const { records } = await run([
    [
      claudeInit(),
      {
        run: 'mkdir -p node_modules/left-pad && echo 1 > node_modules/left-pad/index.js',
        as: 'cp -r /tmp/cache/left-pad node_modules/',
      },
      claudeText(goodDiscoveryResponse()),
      claudeResult({ text: goodDiscoveryResponse() }),
    ],
  ]);
  const b = records[0].outcome.breaches.find((x) => x.kind === 'local-install');
  assert.equal(b.source, 'filesystem');
  assert.equal(records[0].outcome.taskSuccess, false);
});
