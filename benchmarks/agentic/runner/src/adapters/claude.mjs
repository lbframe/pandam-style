/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Claude Code 2.1.303 adapter (DESIGN.md sections 2.2, 3.2-3.6). Event shapes
// come from the Agent SDK 0.3.303 typings (claudeCodeVersion 2.1.303) and the
// offline observation recorded in Appendix A (P3).

import { fromStream, sumMeasured, unknown } from '../measured.mjs';

export const CLI = 'claude';

const SYNTHETIC_MODEL = '<synthetic>';
export const ALLOWED_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
export const DENIED_TOOLS = ['WebFetch', 'WebSearch', 'Agent'];

/** argv and environment of `claude -p` (section 3.2). Secrets never appear. */
export function buildInvocation({
  model,
  effort = null,
  prompt,
  cliMaxTurns,
  sessionId,
  binary = 'claude',
}) {
  const argv = [
    binary,
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
  ];
  // Q3: the smoke run passes no effort flag; the baseline pins the value.
  if (effort != null) argv.push('--effort', effort);
  argv.push(
    '--tools',
    ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    DENIED_TOOLS.join(','),
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--no-session-persistence',
  );
  if (cliMaxTurns != null) argv.push('--max-turns', String(cliMaxTurns));
  argv.push('--session-id', sessionId);
  return {
    argv,
    env: {
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1',
    },
    promptChannel: 'argv',
  };
}

function toolKind(name) {
  if (name === 'Bash') return 'command';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name))
    return 'file-write';
  if (name === 'Read') return 'file-read';
  if (name === 'Glob' || name === 'Grep') return 'search';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web';
  if (name === 'Agent' || name === 'Task') return 'subagent';
  if (name.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
    .join('');
}

/**
 * Incremental parser. `hooks.onToolResult(call)` and `hooks.onFileWrite(path)`
 * let the attempt apply corpus events while the agent runs.
 */
export function createParser({ requestedModel, hooks = {} }) {
  const state = {
    init: null,
    sessionId: null,
    toolCalls: [],
    byToolUseId: new Map(),
    transcript: [],
    lastAssistantText: null,
    result: null,
    resultCount: 0,
    eventsAfterTerminal: 0,
    anomalies: [],
    assistantErrors: [],
    apiRetries: 0,
    rateLimit: null,
    fallbacks: [],
    servedMain: new Set(),
    realMessages: 0,
    messageUsage: new Map(),
    usageFieldPresence: {
      cache_read_input_tokens: true,
      cache_creation_input_tokens: true,
    },
    webRequests: 0,
    policyEvents: [],
    compactions: 0,
    outputBytes: 0,
  };

  function addCall(call) {
    call.index = state.toolCalls.length;
    state.toolCalls.push(call);
    if (call.id != null) state.byToolUseId.set(call.id, call);
    if (call.kind === 'command')
      state.transcript.push({ type: 'command', command: call.command ?? '' });
    else if (call.kind === 'file-write')
      for (const p of call.paths)
        state.transcript.push({ type: 'file-write', path: p });
    else state.transcript.push({ type: 'tool', tool: call.tool });
    hooks.onToolCall?.(call);
    if (call.kind === 'web')
      state.policyEvents.push({ kind: 'web-tool-use', detail: call.tool });
    if (call.kind === 'subagent')
      state.policyEvents.push({ kind: 'subagent-tool-use', detail: call.tool });
  }

  function onAssistant(e) {
    const msg = e.message ?? {};
    if (e.error != null)
      state.assistantErrors.push({
        error: e.error,
        synthetic: msg.model === SYNTHETIC_MODEL,
      });
    const synthetic = msg.model === SYNTHETIC_MODEL;
    const mainLoop = e.parent_tool_use_id == null;
    if (!synthetic && mainLoop) {
      state.realMessages += 1;
      if (typeof msg.model === 'string') state.servedMain.add(msg.model);
      if (msg.id != null && msg.usage != null) {
        // Several events can carry the same API message: keep one usage.
        state.messageUsage.set(msg.id, { model: msg.model, usage: msg.usage });
        for (const k of Object.keys(state.usageFieldPresence))
          if (typeof msg.usage[k] !== 'number')
            state.usageFieldPresence[k] = false;
      }
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (text !== '' && !synthetic) state.lastAssistantText = text;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const name = String(block.name ?? '');
        const kind = toolKind(name);
        const input = block.input ?? {};
        addCall({
          id: block.id ?? null,
          tool: name,
          kind,
          command: kind === 'command' ? String(input.command ?? '') : null,
          paths:
            kind === 'file-write' && typeof input.file_path === 'string'
              ? [input.file_path]
              : [],
          status: 'in-progress',
          exitCode: null,
          outputBytes: 0,
        });
      } else if (
        block?.type === 'server_tool_use' ||
        block?.type === 'web_search_tool_result'
      ) {
        state.policyEvents.push({
          kind: 'web-server-tool',
          detail: String(block.name ?? block.type),
        });
      }
    }
  }

  function onUser(e) {
    const content = Array.isArray(e.message?.content) ? e.message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const call = state.byToolUseId.get(block.tool_use_id);
      if (call == null) {
        state.anomalies.push('tool-result-without-call');
        continue;
      }
      // The SDK's only typed failure flag; an exit code is not structured.
      if (typeof block.is_error === 'boolean')
        call.status = block.is_error ? 'failed' : 'completed';
      else call.status = 'unknown';
      call.outputBytes = Buffer.byteLength(textOf(block.content));
      state.outputBytes += call.outputBytes;
      hooks.onToolResult?.(call);
      if (call.kind === 'file-write' && call.status === 'completed')
        for (const p of call.paths) hooks.onFileWrite?.(p);
    }
  }

  return {
    state,
    push(event) {
      if (state.result != null) {
        state.eventsAfterTerminal += 1;
        if (event.type === 'result') state.resultCount += 1;
        return;
      }
      switch (event.type) {
        case 'system':
          if (event.subtype === 'init') {
            if (state.init != null) state.anomalies.push('duplicate-init');
            else state.init = event;
            state.sessionId = event.session_id ?? state.sessionId;
          } else if (state.init == null) {
            state.anomalies.push('event-before-init');
          }
          if (event.subtype === 'api_retry') state.apiRetries += 1;
          if (event.subtype === 'model_refusal_fallback')
            state.fallbacks.push({
              from: event.original_model ?? null,
              to: event.fallback_model ?? null,
            });
          if (event.subtype === 'compact_boundary') state.compactions += 1;
          break;
        case 'assistant':
          if (state.init == null) state.anomalies.push('event-before-init');
          onAssistant(event);
          break;
        case 'user':
          if (state.init == null) state.anomalies.push('event-before-init');
          onUser(event);
          break;
        case 'rate_limit_event':
          state.rateLimit = event.rate_limit_info ?? null;
          break;
        case 'result':
          state.result = event;
          state.resultCount += 1;
          break;
        default:
          break;
      }
    },
    anomaly(kind) {
      state.anomalies.push(kind);
    },
    finish() {
      return summarize(state, requestedModel);
    },
  };
}

function modelTokens(entry, zeroIsUnknown, presence, source) {
  const pick = (value, field, isDetail, detailPresent) => {
    if (typeof value !== 'number') return unknown(source(field), 'tokens');
    if (value === 0 && (zeroIsUnknown || (isDetail && !detailPresent)))
      return unknown(source(field), 'tokens', 'zero not established');
    return fromStream(value, source(field), 'tokens');
  };
  const inputUncached = pick(entry.inputTokens, 'inputTokens', false, true);
  const inputCacheRead = pick(
    entry.cacheReadInputTokens,
    'cacheReadInputTokens',
    true,
    presence.cache_read_input_tokens,
  );
  const inputCacheWrite = pick(
    entry.cacheCreationInputTokens,
    'cacheCreationInputTokens',
    true,
    presence.cache_creation_input_tokens,
  );
  return {
    inputUncached,
    inputCacheRead,
    inputCacheWrite,
    // Anthropic input fields are additive (section 2.2).
    inputTotal: sumMeasured(
      [inputUncached, inputCacheRead, inputCacheWrite],
      source('input*'),
      'tokens',
    ),
    outputTotal: pick(entry.outputTokens, 'outputTokens', false, true),
    // Thinking tokens are a subset of output; absent or zero is unknown.
    outputReasoning:
      typeof entry.thinkingTokens === 'number' && entry.thinkingTokens > 0
        ? fromStream(entry.thinkingTokens, source('thinkingTokens'), 'tokens')
        : unknown(source('thinkingTokens'), 'tokens'),
  };
}

function summarize(state, requestedModel) {
  const r = state.result;
  const anomalies = [...state.anomalies];
  if (state.init == null) anomalies.push('missing-init');
  if (state.resultCount > 1) anomalies.push('duplicate-terminal');
  if (state.eventsAfterTerminal > 0) anomalies.push('events-after-terminal');

  const isError = r?.is_error === true;
  const modelUsage =
    r?.modelUsage != null && typeof r.modelUsage === 'object'
      ? r.modelUsage
      : {};
  const usable = Object.keys(modelUsage).length > 0 && state.realMessages > 0;

  const perModel = {};
  for (const [model, entry] of Object.entries(modelUsage)) {
    perModel[model] = usable
      ? modelTokens(
          entry ?? {},
          isError,
          state.usageFieldPresence,
          (f) => `claude.result.modelUsage[${model}].${f}`,
        )
      : modelTokens(
          {},
          true,
          state.usageFieldPresence,
          (f) => `claude.result.modelUsage[${model}].${f}`,
        );
  }
  const fields = [
    'inputUncached',
    'inputCacheRead',
    'inputCacheWrite',
    'inputTotal',
    'outputTotal',
    'outputReasoning',
  ];
  const total = {};
  for (const f of fields) {
    const parts = Object.values(perModel).map((m) => m[f]);
    total[f] =
      parts.length === 0 || !usable
        ? unknown(`claude.result.modelUsage[*].${f}`, 'tokens')
        : sumMeasured(parts, `claude.result.modelUsage[*].${f}`, 'tokens');
  }

  // Cross-check of the main-loop messages against modelUsage[requested]
  // (section 2.2), on the fields that are final per message: input, cache
  // read and cache write (observed in the smoke run: equal in every event of
  // a message and summing exactly to modelUsage). Per-message output counts
  // are early streaming snapshots (35 vs 3299 final), so output is never
  // compared. A message without one of these counters makes the check
  // impossible; it is never read as 0.
  let discrepancy = null;
  if (
    usable &&
    modelUsage[requestedModel] != null &&
    state.messageUsage.size > 0
  ) {
    const fields = [
      ['input_tokens', 'inputTokens'],
      ['cache_read_input_tokens', 'cacheReadInputTokens'],
      ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
    ];
    const sums = Object.fromEntries(fields.map(([m]) => [m, 0]));
    let complete = true;
    for (const { model, usage } of state.messageUsage.values()) {
      if (model !== requestedModel) continue;
      for (const [m] of fields) {
        if (typeof usage[m] !== 'number') complete = false;
        else sums[m] += usage[m];
      }
    }
    const mu = modelUsage[requestedModel];
    if (!complete || fields.some(([, u]) => typeof mu[u] !== 'number'))
      discrepancy = {
        status: 'not-computable',
        reason: 'a message or modelUsage lacks an input or cache counter',
      };
    else {
      const differing = fields.filter(([m, u]) => sums[m] !== mu[u]);
      if (differing.length > 0)
        discrepancy = {
          status: 'disagreement',
          fields: Object.fromEntries(
            differing.map(([m, u]) => [
              u,
              { messages: sums[m], modelUsage: mu[u] },
            ]),
          ),
        };
    }
  }

  // Cost: an estimate of the CLI; unknown on default zeros or unknown basis.
  const bases = Object.values(modelUsage).map((m) => m?.costBasis ?? 'list');
  let cost;
  if (!usable || typeof r?.total_cost_usd !== 'number')
    cost = unknown('claude.result.total_cost_usd', 'usd');
  else if (bases.includes('unknown'))
    cost = unknown('claude.result.total_cost_usd', 'usd', 'costBasis unknown');
  else if (r.total_cost_usd === 0 && isError)
    cost = unknown('claude.result.total_cost_usd', 'usd', 'error default');
  else
    cost = fromStream(
      r.total_cost_usd,
      'claude.result.total_cost_usd',
      'usd',
      'claude-cli-api-equivalent',
    );

  // Primary-model fidelity (section 3.6).
  const servedMain = [...state.servedMain];
  const auxiliaryModels = Object.keys(modelUsage).filter(
    (m) => m !== requestedModel,
  );
  let fidelity = 'faithful';
  if (state.init == null) fidelity = 'unknown';
  else if (
    state.init.model !== requestedModel ||
    servedMain.some((m) => m !== requestedModel) ||
    state.fallbacks.length > 0
  )
    fidelity = 'violated';
  else if (state.realMessages === 0) fidelity = 'unknown';

  const tools = Array.isArray(state.init?.tools) ? state.init.tools : null;
  const effectiveConfig = {
    source: 'claude.system.init',
    tools,
    subagents:
      tools == null
        ? 'unknown'
        : tools.includes('Agent') || tools.includes('Task')
          ? 'enabled'
          : 'disabled-evidenced',
    web:
      tools == null
        ? 'unknown'
        : tools.some((t) => t === 'WebSearch' || t === 'WebFetch')
          ? 'enabled'
          : 'disabled-evidenced',
    builtins: (state.init?.plugins ?? []).map((p) => p?.name ?? String(p)),
    effort: state.init?.effort ?? null,
    model: state.init?.model ?? null,
    matchesRequest:
      tools != null &&
      ALLOWED_TOOLS.every((t) => tools.includes(t)) &&
      tools.every((t) => ALLOWED_TOOLS.includes(t)) &&
      state.init?.model === requestedModel,
  };

  // Web usage reported in usage counters is a policy event too.
  for (const entry of Object.values(modelUsage))
    if (
      typeof entry?.webSearchRequests === 'number' &&
      entry.webSearchRequests > 0
    )
      state.policyEvents.push({
        kind: 'web-server-tool',
        detail: 'modelUsage.webSearchRequests',
      });

  const lastError = state.assistantErrors.at(-1)?.error ?? null;
  return {
    cli: CLI,
    sessionId: state.sessionId,
    toolCalls: state.toolCalls,
    transcript: state.transcript,
    finalMessage:
      typeof r?.result === 'string' && r.result !== ''
        ? r.result
        : state.lastAssistantText,
    terminal: r
      ? {
          kind: 'result',
          isError,
          subtype: r.subtype ?? null,
          terminalReason: r.terminal_reason ?? null,
          apiErrorStatus: r.api_error_status ?? null,
          errorEnum: lastError,
          message: null,
        }
      : null,
    signals: {
      apiRetries: state.apiRetries,
      rateLimit: state.rateLimit,
      reconnects: 0,
      reroutes: [],
      fallbacks: state.fallbacks,
      compactions: state.compactions,
    },
    fidelity: {
      status: fidelity,
      requested: requestedModel,
      servedModels: servedMain,
      auxiliaryModels,
    },
    tokens: {
      raw: {
        resultUsage: r?.usage ?? null,
        modelUsage: r?.modelUsage ?? null,
        mainLoopMessages: state.messageUsage.size,
      },
      normalized: { total, perModel },
      discrepancy,
    },
    cost,
    agentSteps:
      typeof r?.num_turns === 'number' && usable
        ? fromStream(r.num_turns, 'claude.result.num_turns', 'api-round-trips')
        : unknown('claude.result.num_turns', 'api-round-trips'),
    durations: {
      cliDurationMs:
        typeof r?.duration_ms === 'number' && usable
          ? fromStream(r.duration_ms, 'claude.result.duration_ms', 'ms')
          : unknown('claude.result.duration_ms', 'ms'),
      cliApiDurationMs:
        typeof r?.duration_api_ms === 'number' && usable
          ? fromStream(r.duration_api_ms, 'claude.result.duration_api_ms', 'ms')
          : unknown('claude.result.duration_api_ms', 'ms'),
    },
    toolOutputBytes: state.outputBytes,
    permissionDenials: Array.isArray(r?.permission_denials)
      ? r.permission_denials.length
      : 0,
    policyEvents: state.policyEvents,
    effectiveConfig,
    anomalies,
  };
}
