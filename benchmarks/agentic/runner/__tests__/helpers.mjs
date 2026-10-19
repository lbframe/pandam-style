/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared helpers of the runner tests: scenario builders for the fake CLIs and
// an adapter-fixture matrix driver. Nothing here contacts a provider, and no
// test reads or writes the user's real ~/.claude or ~/.codex.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LocalFixtureExecutor } from '../src/executors/local.mjs';
import { harnessIdentity, hostFacts } from '../src/identity.mjs';
import { runMatrix } from '../src/matrix.mjs';
import { buildReport, loadMatrix } from '../src/report.mjs';
import { validate } from '../../src/json-schema.mjs';
import {
  REPO_ROOT,
  RUNNER_ROOT,
  fileSha256,
  readJson,
  sha256,
} from '../src/util.mjs';
import { effectiveConfigFromPromptInput } from '../src/adapters/codex.mjs';

export const FAKE_CLI = path.join(RUNNER_ROOT, 'fixtures/bin/fake-cli.mjs');
export const SCENARIOS = path.join(RUNNER_ROOT, 'fixtures/scenarios');
// Inside the repository so packages resolve from the workspace root, as the
// AG-00.1 oracle-fixture tests do (adapter-fixture grading, labelled).
export const SCRATCH = path.join(REPO_ROOT, '.pms-bench/agentic-runner-tests');

const REAL_HOME_PATHS = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.codex'),
  path.join(os.homedir(), '.claude.json'),
];

/** Refuses any credential path under the user's real CLI homes. */
export function assertSyntheticPath(p) {
  const r = path.resolve(p);
  for (const real of REAL_HOME_PATHS)
    if (r === real || r.startsWith(real + path.sep))
      throw new Error(`tests must never touch ${real}`);
  return p;
}

export function tmpDir(name) {
  const d = path.join(
    SCRATCH,
    `${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function writeScenario(dir, name, scenario) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(scenario, null, 2));
  return file;
}

export function scenarioFile(name) {
  return path.join(SCENARIOS, `${name}.json`);
}

export const CLAUDE_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];

export function claudeInit(overrides = {}) {
  return {
    emit: {
      type: 'system',
      subtype: 'init',
      cwd: '/workspace',
      session_id: '${SESSION}',
      tools: CLAUDE_TOOLS,
      mcp_servers: [],
      model: '${REQUESTED_MODEL}',
      permissionMode: 'bypassPermissions',
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: '2.1.303',
      output_style: 'default',
      agents: [
        'claude',
        'Explore',
        'general-purpose',
        'Plan',
        'statusline-setup',
      ],
      skills: [],
      plugins: [
        { name: 'cc-plugin-agents-md' },
        { name: 'cc-plugin-plugin-authoring' },
      ],
      ...overrides,
    },
  };
}

export function claudeText(
  text,
  { model = '${REQUESTED_MODEL}', id = 'msg_final', usage } = {},
) {
  return {
    emit: {
      type: 'assistant',
      message: {
        id,
        model,
        role: 'assistant',
        content: [{ type: 'text', text }],
        usage: usage ?? {
          input_tokens: 20,
          output_tokens: 30,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: '${SESSION}',
    },
  };
}

export function claudeResult({
  text = 'done',
  isError = false,
  subtype = 'success',
  terminalReason = 'completed',
  numTurns = 3,
  cost = 0.0123,
  modelUsage,
  apiErrorStatus = null,
} = {}) {
  return {
    emit: {
      type: 'result',
      subtype,
      is_error: isError,
      duration_ms: 1234,
      duration_api_ms: 1000,
      num_turns: numTurns,
      result: text,
      stop_reason: 'end_turn',
      total_cost_usd: cost,
      usage: {
        input_tokens: 40,
        output_tokens: 40,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 0,
      },
      modelUsage: modelUsage ?? {
        '${REQUESTED_MODEL}': {
          inputTokens: 40,
          outputTokens: 40,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: cost,
          contextWindow: 200000,
          maxOutputTokens: 32000,
          costBasis: 'list',
        },
      },
      permission_denials: [],
      terminal_reason: terminalReason,
      api_error_status: apiErrorStatus,
      uuid: 'u-result',
      session_id: '${SESSION}',
    },
  };
}

export function codexStart() {
  return [
    {
      emit: {
        type: 'thread.started',
        thread_id: '01a152b3-d7b1-70c1-a530-7c4a7149d89d',
      },
    },
    { emit: { type: 'turn.started' } },
  ];
}

export function codexMessage(text) {
  return {
    emit: {
      type: 'item.completed',
      item: { id: 'item_msg', type: 'agent_message', text },
    },
  };
}

export function codexDone(
  usage = {
    input_tokens: 1000,
    cached_input_tokens: 600,
    output_tokens: 200,
    reasoning_output_tokens: 50,
  },
) {
  return { emit: { type: 'turn.completed', usage } };
}

export function codexFailed(message) {
  return { emit: { type: 'turn.failed', error: { message } } };
}

/** Effective configuration evidence of a Codex run whose overrides took effect. */
export const CODEX_EVIDENCE = effectiveConfigFromPromptInput({
  promptInput: [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: '<skills_instructions>...</skills_instructions>',
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: '<environment_context>...</environment_context>',
        },
      ],
    },
  ],
  strictConfigAccepted: true,
});

export const MODELS = {
  haiku: {
    key: 'claude-haiku',
    cli: 'claude',
    cliVersion: '2.1.303',
    cliSha256: 'f'.repeat(64),
    model: 'claude-haiku-5-5',
    reasoningEffort: null,
    toolPolicy: { web: false, subagents: false },
  },
  sol: {
    key: 'gpt-sol',
    cli: 'codex',
    cliVersion: '0.163.0',
    cliSha256: 'e'.repeat(64),
    model: 'gpt-6.1-sol',
    reasoningEffort: null,
    toolPolicy: { web: false, subagents: false },
  },
};

export function fixtureConfig(overrides = {}) {
  return {
    schema: 'pms-agentic-matrix/v1',
    kind: 'adapter-fixture',
    purpose: 'development',
    epoch: 'alpha1',
    tasks: ['discovery-positive-card-vocabulary'],
    models: [MODELS.haiku],
    repetitions: 1,
    maxAttempts: 3,
    productBuild: { digest: '0'.repeat(64), manifestSha256: '0'.repeat(64) },
    images: { agent: null, grader: null, proxy: null, baseDigest: null },
    container: {},
    network: { mode: 'none-local-fixture', ipv6: false, allow: {} },
    budgets: { graceInterruptMs: 200, graceTerminateMs: 200 },
    retry: { baseSeconds: 0, capSeconds: 0 },
    // Required per provider (section 4.6); fixtures default to no credential.
    credentials: {
      claude: { mode: 'none', source: null },
      codex: { mode: 'none', source: null },
    },
    schedule: {
      order: 'sequential',
      concurrencyPerProvider: 1,
      timeWindows: [],
      wallClockCapSeconds: null,
    },
    ...overrides,
  };
}

let cachedIdentity = null;
export function fixtureIdentity() {
  cachedIdentity ??= {
    harness: harnessIdentity(),
    productBuild: {
      digest: '0'.repeat(64),
      epoch: 'alpha1',
      sourceCommit: '415e05539fcb5d36a78226112b5cf488b200b1aa',
    },
    environment: {
      images: { agent: null, grader: null, proxy: null },
      dockerVersion: null,
      ...hostFacts(),
      cgroup: null,
      isolationSelfTest: null,
    },
  };
  return cachedIdentity;
}

/**
 * Runs an adapter-fixture matrix. `scenarios` maps `<taskId>/<modelKey>` to a
 * list of scenario files, one per attempt (the last one repeats).
 */
export async function runFixture({
  config,
  scenarios,
  credentialFor,
  effectiveConfigFor,
  signal,
  name = 'matrix',
  clock,
  grading,
  stateDir,
  extraEnv,
  installFor,
  bounds,
  matrixId,
  root: givenRoot,
  identity,
}) {
  const root = givenRoot ?? tmpDir(name);
  const out = await runMatrix({
    config,
    runsRoot: root,
    stateDir: stateDir ?? path.join(root, '.state'),
    identity: identity ?? fixtureIdentity(),
    ...(installFor ? { installFor } : {}),
    ...(bounds ? { bounds } : {}),
    ...(matrixId ? { matrixId } : {}),
    grading: grading ?? { mode: 'dev-ancestor', hostCommands: false },
    executorFor: ({ model, taskId, repetition, attempt }) => {
      const list =
        scenarios[`${taskId}/${model.key}#${repetition}`] ??
        scenarios[`${taskId}/${model.key}`] ??
        scenarios['*'];
      const scenario = list[Math.min(attempt, list.length) - 1];
      return new LocalFixtureExecutor({
        fakeBinary: FAKE_CLI,
        scenario,
        extraEnv: extraEnv ?? {},
      });
    },
    effectiveConfigFor:
      effectiveConfigFor ??
      ((m) => (m.cli === 'codex' ? CODEX_EVIDENCE : null)),
    ...(credentialFor ? { credentialFor } : {}),
    signal,
    ...(clock ? { clock } : {}),
  });
  assertDocumentsValid(out.matrixDir);
  return { ...out, root };
}

const SCHEMAS = {};
const schemaOf = (name) =>
  (SCHEMAS[name] ??= readJson(path.join(RUNNER_ROOT, 'schema', name)));

/** F57: every record and report of every fixture run validates. */
export function assertDocumentsValid(matrixDir) {
  const loaded = loadMatrix(matrixDir);
  const errors = [];
  for (const r of loaded.records)
    for (const e of validate(schemaOf('run-record.v1.schema.json'), r))
      errors.push(
        `${r.cell.taskId}/${r.cell.modelKey}/${r.repetition}/${r.attempt}: ${e}`,
      );
  for (const e of validate(
    schemaOf('report.v1.schema.json'),
    buildReport(loaded),
  ))
    errors.push(`report: ${e}`);
  if (errors.length > 0)
    throw new Error(`schema violations:\n${errors.slice(0, 20).join('\n')}`);
}

export function recordsOf(matrixDir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === 'record.json')
        out.push(readJson(path.join(d, e.name)));
    }
  };
  if (fs.existsSync(path.join(matrixDir, 'cells')))
    walk(path.join(matrixDir, 'cells'));
  return out.sort(
    (a, b) => a.repetition - b.repetition || a.attempt - b.attempt,
  );
}

export function goodDiscoveryResponse() {
  return fs.readFileSync(
    path.join(
      REPO_ROOT,
      'benchmarks/agentic/tasks/discovery-positive-card-vocabulary/oracle-fixtures/good/response.md',
    ),
    'utf8',
  );
}

/** A grading stub for fixtures whose subject is not the oracle verdict. */
export function stubEvaluator({
  verdict = 'pass',
  checks = null,
  byPass = null,
} = {}) {
  return (args) => {
    const forPass = byPass?.[args.pass];
    if (forPass?.status && forPass.status !== 'completed') return forPass;
    const v = forPass?.verdict ?? verdict;
    const result = {
      verdict: v,
      checks: forPass?.checks ??
        checks ?? [
          {
            id: 'stub',
            kind: 'response.claims',
            required: true,
            status: v === 'pass' ? 'pass' : 'fail',
            class: 'outcome',
            reason: null,
          },
        ],
    };
    return {
      status: 'completed',
      result,
      resultSha256: sha256(JSON.stringify(result)),
    };
  };
}

export const STUB_GRADING = (opts) => ({
  mode: 'dev-ancestor',
  hostCommands: opts?.hostCommands ?? false,
  evaluate: stubEvaluator(opts),
});

/** Synthetic credential source directory (never the user's real homes). */
export function syntheticCredentialDir(provider, doc) {
  const dir = assertSyntheticPath(tmpDir(`cred-${provider}`));
  const file = provider === 'claude' ? '.credentials.json' : 'auth.json';
  fs.writeFileSync(path.join(dir, file), JSON.stringify(doc), { mode: 0o600 });
  return { dir, file: path.join(dir, file) };
}

export function claudeCredentialDoc({
  access = 'sk-ant-oat01-ACCESS-aaaaaaaaaaaaaaaaaaaaaaaa',
  refresh = 'sk-ant-ort01-REFRESH-bbbbbbbbbbbbbbbbbbbbbb',
  expiresAt = Date.now() + 8 * 3600 * 1000,
} = {}) {
  return {
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      scopes: ['user:inference'],
      subscriptionType: 'team',
    },
  };
}

// Synthetic CE baseline store (two product tarballs, Node, source archive)
// standing in for ~/.local/share/pandamstyle-baselines/alpha1.
export const STORE_COMMIT = '415e05539fcb5d36a78226112b5cf488b200b1aa';
export const STORE_CORPUS = {
  epochs: { alpha1: { product: { commits: [STORE_COMMIT] } } },
};

function tarDir(dir, out, top) {
  const r = spawnSync('tar', ['-czf', out, '-C', dir, top], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A store with two product tarballs, a Node archive and a source archive. */
export function fixtureStore() {
  const root = tmpDir('store');
  const original = path.join(root, 'original');
  const build = path.join(root, 'build');
  for (const d of ['packages/registry', 'node', 'source'])
    fs.mkdirSync(path.join(original, d), { recursive: true });
  const packages = [];
  for (const name of ['core', 'compiler']) {
    const pkg = path.join(build, name, 'package');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: `@pandamstyle/${name}`,
        version: '0.1.0-test',
        main: 'lib/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(pkg, 'lib/index.js'),
      `module.exports = '${name}';\n`,
    );
    const file = `packages/registry/pandamstyle-${name}-0.1.0-test.tgz`;
    tarDir(path.join(build, name), path.join(original, file), 'package');
    packages.push({
      name: `@pandamstyle/${name}`,
      version: '0.1.0-test',
      registry: {
        file,
        sha256: fileSha256(path.join(original, file)),
        integrity: 'sha512-test',
      },
    });
  }
  fs.writeFileSync(
    path.join(original, 'node/node.tar.xz'),
    'node runtime bytes',
  );
  const src = path.join(build, 'src', 'pandamstyle-415e055');
  fs.mkdirSync(path.join(src, 'docs/reference'), { recursive: true });
  fs.writeFileSync(path.join(src, 'docs/agent-guide.md'), '# guide\n');
  fs.writeFileSync(path.join(src, 'docs/reference/api.md'), '# api\n');
  fs.writeFileSync(path.join(src, 'docs/internal.md'), '# not for agents\n');
  tarDir(
    path.join(build, 'src'),
    path.join(original, 'source/src.tar.gz'),
    'pandamstyle-415e055',
  );
  const manifest = {
    epoch: 'alpha1',
    source: {
      commit: STORE_COMMIT,
      tree: 't',
      archive: {
        file: 'source/src.tar.gz',
        sha256: fileSha256(path.join(original, 'source/src.tar.gz')),
      },
    },
    packages,
    node: [
      {
        version: '22.22.0',
        file: 'node/node.tar.xz',
        sha256: fileSha256(path.join(original, 'node/node.tar.xz')),
      },
    ],
    measurementNode: { version: '22.22.0' },
  };
  const manifestPath = path.join(root, 'manifest.v1.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, original, manifestPath, manifest };
}

export function closureFor(store, copy) {
  const dir = path.join(store.root, 'closure');
  fs.mkdirSync(dir, { recursive: true });
  const deps = Object.fromEntries(
    store.manifest.packages.map((p) => [
      p.name,
      `file:${path.join(copy, p.registry.file)}`,
    ]),
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'trusted', version: '1.0.0', dependencies: deps }),
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
