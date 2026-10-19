/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Codex 0.163.0 adapter (DESIGN.md sections 2.2, 3.2-3.6). Event shapes come
// from rust-v0.163.0 (exec/src/exec_events.rs,
// exec/src/event_processor_with_jsonl_output.rs) and the offline observation
// in Appendix A (P4).

import { fromStream, unknown } from '../measured.mjs';

export const CLI = 'codex';

/** argv and environment of `codex exec` (section 3.2). */
export function buildInvocation({
  model,
  effort = null,
  workdir = '/workspace',
  lastMessagePath = '/run/agent/last-message.txt',
  binary = 'codex',
}) {
  const argv = [
    binary,
    'exec',
    '-',
    '--json',
    '--strict-config',
    '--ephemeral',
    '--ignore-rules',
    '-m',
    model,
  ];
  if (effort != null) argv.push('-c', `model_reasoning_effort="${effort}"`);
  argv.push(
    '-c',
    'web_search="disabled"',
    '-c',
    'agents.enabled=false',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-C',
    workdir,
    '-o',
    lastMessagePath,
  );
  return { argv, env: {}, promptChannel: 'stdin' };
}

const REROUTE = /^model rerouted: (.+?) -> (.+?) \((.*)\)$/s;
const RECONNECT = /^Reconnecting\.\.\. \d+\/\d+/;

export function createParser({ requestedModel, hooks = {} }) {
  const state = {
    sessionId: null,
    started: false,
    toolCalls: [],
    byItemId: new Map(),
    transcript: [],
    lastAgentMessage: null,
    terminal: null,
    terminalCount: 0,
    eventsAfterTerminal: 0,
    usage: null,
    anomalies: [],
    reconnects: 0,
    errorEvents: [],
    warnings: [],
    reroutes: [],
    policyEvents: [],
    outputBytes: 0,
  };

  function callFor(item, kind) {
    let call = state.byItemId.get(item.id);
    if (call == null) {
      call = {
        id: item.id ?? null,
        tool: item.type,
        kind,
        command: kind === 'command' ? String(item.command ?? '') : null,
        paths:
          kind === 'file-write' && Array.isArray(item.changes)
            ? item.changes.map((c) => String(c?.path ?? ''))
            : [],
        status: 'in-progress',
        exitCode: null,
        outputBytes: 0,
        completed: false,
      };
      call.index = state.toolCalls.length;
      state.toolCalls.push(call);
      if (item.id != null) state.byItemId.set(item.id, call);
      if (kind === 'command')
        state.transcript.push({ type: 'command', command: call.command });
      else if (kind === 'file-write')
        for (const p of call.paths)
          state.transcript.push({ type: 'file-write', path: p });
      else state.transcript.push({ type: 'tool', tool: item.type });
      hooks.onToolCall?.(call);
      if (kind === 'web')
        state.policyEvents.push({ kind: 'web-tool-use', detail: item.type });
      if (kind === 'subagent')
        state.policyEvents.push({
          kind: 'subagent-tool-use',
          detail: String(item.tool ?? item.type),
        });
    }
    return call;
  }

  function onItem(event, completed) {
    const item = event.item ?? {};
    switch (item.type) {
      case 'command_execution': {
        const call = callFor(item, 'command');
        if (completed) {
          call.completed = true;
          call.status = ['completed', 'failed', 'declined'].includes(
            item.status,
          )
            ? item.status
            : 'unknown';
          call.exitCode = Number.isInteger(item.exit_code)
            ? item.exit_code
            : null;
          call.outputBytes = Buffer.byteLength(
            String(item.aggregated_output ?? ''),
          );
          state.outputBytes += call.outputBytes;
          hooks.onToolResult?.(call);
        }
        break;
      }
      case 'file_change': {
        const call = callFor(item, 'file-write');
        if (completed) {
          call.completed = true;
          call.status = item.status === 'completed' ? 'completed' : 'failed';
          hooks.onToolResult?.(call);
          if (call.status === 'completed')
            for (const p of call.paths) hooks.onFileWrite?.(p);
        }
        break;
      }
      case 'mcp_tool_call':
      case 'web_search':
      case 'collab_tool_call': {
        const kind =
          item.type === 'web_search'
            ? 'web'
            : item.type === 'collab_tool_call'
              ? 'subagent'
              : 'mcp';
        const call = callFor(item, kind);
        if (completed) {
          call.completed = true;
          call.status =
            item.status === 'failed'
              ? 'failed'
              : item.status === 'completed' || kind === 'web'
                ? 'completed'
                : 'unknown';
          hooks.onToolResult?.(call);
        }
        break;
      }
      case 'agent_message':
        if (completed && typeof item.text === 'string')
          state.lastAgentMessage = item.text;
        break;
      case 'error': {
        if (!completed) break;
        const message = String(item.message ?? '');
        const m = REROUTE.exec(message);
        if (m != null)
          state.reroutes.push({ from: m[1], to: m[2], reason: m[3] });
        else state.warnings.push(message);
        break;
      }
      default:
        break;
    }
  }

  return {
    state,
    push(event) {
      if (state.terminal != null) {
        state.eventsAfterTerminal += 1;
        if (event.type === 'turn.completed' || event.type === 'turn.failed')
          state.terminalCount += 1;
        // Usage is a cumulative snapshot: the last one is the total, never a
        // sum (section 2.2). The duplicate terminal stays an anomaly.
        if (event.type === 'turn.completed') state.usage = event.usage ?? null;
        return;
      }
      if (state.sessionId == null && event.type !== 'thread.started')
        state.anomalies.push('event-before-init');
      switch (event.type) {
        case 'thread.started':
          if (state.sessionId != null) state.anomalies.push('duplicate-init');
          else state.sessionId = String(event.thread_id ?? '');
          break;
        case 'turn.started':
          state.started = true;
          break;
        case 'item.started':
        case 'item.updated':
          onItem(event, false);
          break;
        case 'item.completed':
          onItem(event, true);
          break;
        case 'error': {
          const message = String(event.message ?? '');
          if (RECONNECT.test(message)) state.reconnects += 1;
          state.errorEvents.push(message);
          break;
        }
        case 'turn.completed':
          state.terminal = { kind: 'turn.completed', message: null };
          state.terminalCount += 1;
          state.usage = event.usage ?? null;
          break;
        case 'turn.failed':
          state.terminal = {
            kind: 'turn.failed',
            message: String(event.error?.message ?? ''),
          };
          state.terminalCount += 1;
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

function codexTokens(usage) {
  const src = (f) => `codex.turn.completed.usage.${f}`;
  const fields = [
    'input_tokens',
    'cached_input_tokens',
    'cache_write_input_tokens',
    'output_tokens',
    'reasoning_output_tokens',
  ];
  const allZero =
    usage == null ||
    fields.every((f) => usage[f] === 0 || usage[f] === undefined);
  // Usage::default() when no usage notification arrived: all zeros mean
  // "not reported", never zero tokens (section 2.2).
  const total = (f) =>
    allZero || typeof usage[f] !== 'number'
      ? unknown(src(f), 'tokens')
      : fromStream(usage[f], src(f), 'tokens');
  // Detail counters default to 0 when the provider omits them.
  const detail = (f) =>
    allZero || typeof usage[f] !== 'number' || usage[f] === 0
      ? unknown(src(f), 'tokens', 'zero not established')
      : fromStream(usage[f], src(f), 'tokens');
  const inputTotal = total('input_tokens');
  const inputCacheRead = detail('cached_input_tokens');
  const outputTotal = total('output_tokens');
  const inputUncached =
    inputTotal.status !== 'unknown' && inputCacheRead.status !== 'unknown'
      ? {
          ...inputTotal,
          value: inputTotal.value - inputCacheRead.value,
          source: 'codex.input_tokens-cached_input_tokens',
        }
      : unknown('codex.input_tokens-cached_input_tokens', 'tokens');
  return {
    inputUncached,
    inputCacheRead,
    inputCacheWrite: detail('cache_write_input_tokens'),
    // OpenAI input includes cached input; output includes reasoning.
    inputTotal,
    outputTotal,
    outputReasoning: detail('reasoning_output_tokens'),
  };
}

function summarize(state, requestedModel) {
  const anomalies = [...state.anomalies];
  if (state.sessionId == null) anomalies.push('missing-init');
  if (state.terminalCount > 1) anomalies.push('duplicate-terminal');
  if (state.eventsAfterTerminal > 0) anomalies.push('events-after-terminal');
  const unfinished = state.toolCalls.filter((c) => !c.completed);
  for (const c of unfinished) c.status = 'unfinished';

  const total = codexTokens(
    state.terminal?.kind === 'turn.completed' ? state.usage : null,
  );
  return {
    cli: CLI,
    sessionId: state.sessionId,
    toolCalls: state.toolCalls,
    transcript: state.transcript,
    finalMessage: state.lastAgentMessage,
    terminal: state.terminal
      ? {
          kind: state.terminal.kind,
          isError: state.terminal.kind === 'turn.failed',
          subtype: null,
          terminalReason: null,
          apiErrorStatus: null,
          errorEnum: null,
          message: state.terminal.message,
        }
      : null,
    signals: {
      apiRetries: 0,
      rateLimit: null,
      reconnects: state.reconnects,
      reroutes: state.reroutes,
      fallbacks: [],
      compactions: 0,
      warnings: state.warnings,
      lastErrorEvent: state.errorEvents.at(-1) ?? null,
    },
    fidelity: {
      status: state.reroutes.length > 0 ? 'violated' : 'no-reroute-surfaced',
      requested: requestedModel,
      servedModels: 'unknown',
      auxiliaryModels: [],
    },
    tokens: {
      raw: { usage: state.usage },
      normalized: { total, perModel: {} },
      discrepancy: null,
    },
    // The exec JSONL contract has no cost field.
    cost: unknown('codex (no cost field)', 'usd'),
    agentSteps: unknown('codex (no step count)', 'api-round-trips'),
    durations: {
      cliDurationMs: unknown('codex (no duration)', 'ms'),
      cliApiDurationMs: unknown('codex (no duration)', 'ms'),
    },
    toolOutputBytes: state.outputBytes,
    permissionDenials: 0,
    policyEvents: state.policyEvents,
    effectiveConfig: null,
    anomalies,
  };
}

/**
 * Effective configuration evidence for Codex (section 3.3): the model-visible
 * input rendered by `codex debug prompt-input` with the same overrides (no
 * model call), plus the strict-config acceptance of the overrides. Web search
 * has configuration evidence only; it stays detect-and-fail (Q12).
 */
export function effectiveConfigFromPromptInput({
  promptInput,
  strictConfigAccepted,
}) {
  const texts = Array.isArray(promptInput)
    ? promptInput.flatMap((m) =>
        Array.isArray(m?.content)
          ? m.content.map((c) => String(c?.text ?? ''))
          : [],
      )
    : null;
  const multiAgent =
    texts == null
      ? null
      : texts.some(
          (t) =>
            t.includes('<multi_agent_role>') ||
            t.includes('<multi_agent_mode>'),
        );
  return {
    source: 'codex.debug.prompt-input',
    tools: null,
    subagents:
      multiAgent == null
        ? 'unknown'
        : multiAgent
          ? 'enabled'
          : 'disabled-evidenced',
    web: strictConfigAccepted ? 'disabled-configured' : 'unknown',
    builtins: [],
    effort: null,
    model: null,
    matchesRequest: multiAgent === false && strictConfigAccepted === true,
  };
}
