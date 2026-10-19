/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Failure taxonomy (DESIGN.md section 5.1). `classify` is a pure function of
// structured CLI fields, exit status, harness timers and harness errors. It
// never receives the grading verdict, the workspace, or model/tool text; the
// only free text it reads is a Codex terminal error message, matched against
// a table built from the pinned rust-v0.163.0 error display strings.

export const CODEX_ERROR_TABLE_VERSION = 'codex-errors/v1';

// Ordered: the first match wins. Sources: codex-rs/protocol/src/error.rs
// (CodexErrorDetails display strings and UsageLimitReachedError, rust-v0.163.0).
const CODEX_PATTERNS = [
  ['infrastructure', 'rate-limit', /^You’ve hit your usage limit/],
  ['infrastructure', 'rate-limit', /^rate limit exceeded:/],
  ['infrastructure', 'rate-limit', /^Your workspace is out of credits/],
  ['infrastructure', 'rate-limit', /^You hit your spend cap/],
  ['infrastructure', 'rate-limit', /^Quota exceeded\./],
  ['infrastructure', 'rate-limit', /^exceeded retry limit, last status: 429/],
  ['infrastructure', 'capacity', /^Selected model is at capacity/],
  ['infrastructure', 'capacity', /^Flex capacity unavailable/],
  ['infrastructure', 'capacity', /^We’re currently experiencing high demand/],
  [
    'infrastructure',
    'capacity',
    /^exceeded retry limit, last status: 5(03|29)/,
  ],
  [
    'infrastructure',
    'provider-error',
    /^exceeded retry limit, last status: 5\d\d/,
  ],
  ['infrastructure', 'provider-error', /^unexpected status 5\d\d/],
  ['infrastructure', 'auth', /^unexpected status 40[13]/],
  ['infrastructure', 'auth', /^To use Codex with your ChatGPT plan/],
  ['unclassified', 'content-filter', /reason: content_filter/],
  [
    'infrastructure',
    'provider-error',
    /^stream disconnected before completion:/,
  ],
  [
    'infrastructure',
    'provider-error',
    /^Error while reading the server response/,
  ],
  ['infrastructure', 'provider-error', /^Connection failed:/],
  ['infrastructure', 'provider-error', /^request timed out/],
  [
    'agent',
    'context-exhausted',
    /^Codex ran out of room in the model's context window/,
  ],
  ['harness', 'config-integrity', /^unexpected status 404/],
  ['harness', 'config-integrity', /^Missing environment variable/],
];

const CLAUDE_ERROR_ENUM = {
  rate_limit: ['infrastructure', 'rate-limit'],
  overloaded: ['infrastructure', 'capacity'],
  server_error: ['infrastructure', 'provider-error'],
  authentication_failed: ['infrastructure', 'auth'],
  oauth_org_not_allowed: ['infrastructure', 'auth'],
  account_on_hold: ['infrastructure', 'auth'],
  verification_required: ['infrastructure', 'auth'],
  billing_error: ['infrastructure', 'auth'],
  cloud_credential_error: ['infrastructure', 'auth'],
  invalid_request: ['harness', 'config-integrity'],
  model_not_found: ['harness', 'config-integrity'],
  max_output_tokens: ['agent', 'max-output-tokens'],
  unknown: ['unclassified', 'claude-unknown-error'],
};

const CLAUDE_TERMINAL_REASON = {
  max_turns: ['agent', 'cli-max-turns'],
  prompt_too_long: ['agent', 'context-exhausted'],
  budget_exhausted: ['harness', 'config-integrity'],
};

// Harness codes that stop the whole matrix (section 5.1).
const SYSTEMATIC = new Set([
  'drift',
  'config-integrity',
  'redaction',
  'trusted-tree',
  'credential-export-failed',
  'adapter-stream',
]);

const TERMINATION = {
  agent: {
    completed: 'completed',
    'budget-timeout': 'budget-timeout',
    'budget-max-tool-calls': 'budget-max-tool-calls',
    'cli-max-turns': 'cli-max-turns',
    'context-exhausted': 'context-exhausted',
    'max-output-tokens': 'context-exhausted',
  },
};

export function classifyCodexMessage(message) {
  const text = String(message ?? '').trim();
  for (const [cls, code, re] of CODEX_PATTERNS)
    if (re.test(text)) return { class: cls, code };
  return { class: 'unclassified', code: 'codex-unmatched-error' };
}

function result(cls, code, extra = {}) {
  const termination =
    cls === 'agent'
      ? (TERMINATION.agent[code] ?? 'completed')
      : cls === 'agent-resource'
        ? 'resource-limit'
        : cls === 'agent-abnormal'
          ? 'abnormal-exit'
          : cls;
  const valid = !['infrastructure', 'unclassified', 'harness'].includes(cls);
  return {
    class: cls,
    code,
    termination,
    valid,
    retry: cls === 'infrastructure' && code !== 'auth',
    haltProvider: cls === 'infrastructure' && code === 'auth',
    haltMatrix: cls === 'harness' && SYSTEMATIC.has(code),
    ...extra,
  };
}

/**
 * @param {object} input
 * @param {'claude'|'codex'} input.cli
 * @param {object|null} input.terminal adapter terminal summary
 * @param {{code:number|null, signal:string|null}} input.exit
 * @param {object} input.harness { cancelled, timedOut, maxToolCallsHit,
 *   resourceLimit, harnessError, signalled }
 * @param {string[]} input.anomalies stream integrity anomalies
 * @param {boolean} input.configMismatch effective configuration contradicts the request
 * @param {string} input.fidelity primary-model fidelity status
 * @param {object[]} input.breaches policy breaches (tool policy, capability, credential leak)
 */
export function classify(input) {
  const h = input.harness ?? {};
  if (h.cancelled) return result('harness', 'cancelled');
  if (h.harnessError) return result('harness', h.harnessError);
  if ((input.anomalies ?? []).length > 0)
    return result('harness', 'adapter-stream', {
      detail: input.anomalies.join(','),
    });
  if (input.configMismatch) return result('harness', 'config-integrity');
  if (input.fidelity === 'violated') return result('harness', 'model-fidelity');
  const breaches = input.breaches ?? [];
  if (breaches.some((b) => b.kind === 'credential-leak'))
    return result('policy', 'credential-leak');
  if (breaches.length > 0)
    return result(
      'policy',
      breaches.some(
        (b) => b.kind.startsWith('web') || b.kind.startsWith('subagent'),
      )
        ? 'tool-policy-breach'
        : 'capability-breach',
    );
  if (h.timedOut) return result('agent', 'budget-timeout');
  if (h.maxToolCallsHit) return result('agent', 'budget-max-tool-calls');
  if (h.resourceLimit) return result('agent-resource', 'resource-limit');

  const t = input.terminal;
  if (t == null) {
    // No terminal event: the CLI died or was killed by something other than
    // the harness. Never retried (section 4.4: agent code can kill the CLI).
    return result('agent-abnormal', 'abnormal-exit');
  }
  if (input.cli === 'claude') {
    if (!t.isError) return result('agent', 'completed');
    if (t.subtype === 'error_max_turns')
      return result('agent', 'cli-max-turns');
    if (t.subtype === 'error_max_budget_usd')
      return result('harness', 'config-integrity');
    if (t.errorEnum != null && CLAUDE_ERROR_ENUM[t.errorEnum] != null) {
      const [cls, code] = CLAUDE_ERROR_ENUM[t.errorEnum];
      return result(cls, code);
    }
    if (t.terminalReason != null && CLAUDE_TERMINAL_REASON[t.terminalReason]) {
      const [cls, code] = CLAUDE_TERMINAL_REASON[t.terminalReason];
      return result(cls, code);
    }
    if (input.rateLimit?.status === 'rejected')
      return result('infrastructure', 'rate-limit');
    return result('unclassified', 'claude-unclassified-error', {
      detail: `${t.terminalReason ?? 'no terminal_reason'}`,
    });
  }
  if (t.kind === 'turn.completed') return result('agent', 'completed');
  const m = classifyCodexMessage(t.message);
  return result(m.class, m.code);
}
