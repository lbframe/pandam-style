/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createHash } from 'node:crypto';
import { Codes, diagnostic } from './diagnostics.js';
import { protocolDiagnostic } from './diagnostics-result-v1.js';

/**
 * AG-01.1 agent response envelope.
 *
 * One function, `classify()`, decides every outcome; handlers return values or
 * throw and never set one. Outcomes are computed from complete results before
 * any list is projected (I5). Nothing on the session or compile path imports
 * this module (I8).
 */

export const AGENT_PROTOCOL = 'pandamstyle-agent';
export const AGENT_PROTOCOL_VERSION = 1;

export const OUTCOMES = Object.freeze([
  'success',
  'invalid-input',
  'constraint-violation',
  'unsupported-capability',
  'denied-access',
  'stale-revision',
  'cancelled',
  'internal-error',
]);

export const STAGES = Object.freeze(['request', 'bootstrap', 'execution']);
export const RETRY_HINTS = Object.freeze([
  'never',
  'after-refresh',
  'same-request',
]);

/** Envelope codes. `PMS_INVALID_DEFINITION` lives in `Codes`. */
export const AgentCodes = Object.freeze({
  INVALID_REQUEST: 'PMS_INVALID_REQUEST',
  UNKNOWN_OPERATION: 'PMS_UNKNOWN_OPERATION',
  OPERATION_UNSUPPORTED: 'PMS_OPERATION_UNSUPPORTED',
  ACCESS_DENIED: 'PMS_ACCESS_DENIED',
  CANCELLED: 'PMS_CANCELLED',
  INTERNAL: 'PMS_INTERNAL',
});

/** `PMS_INVALID_REVISION` reasons and the outcome each one means (§1.3). */
export const INVALID_REVISION_OUTCOMES = Object.freeze({
  'malformed-identity': 'invalid-input',
  'foreign-identity': 'invalid-input',
  'foreign-ticket': 'invalid-input',
  'uncovered-source': 'invalid-input',
  'not-initialized': 'invalid-input',
  'already-initialized': 'invalid-input',
  'not-validated': 'invalid-input',
  'revision-invalid': 'constraint-violation',
  'no-publishable-candidate': 'constraint-violation',
  'outside-root-retention': 'constraint-violation',
  'design-system-unavailable': 'constraint-violation',
  'snapshot-disabled': 'unsupported-capability',
  'output-owned': 'denied-access',
  'no-css-artifact': 'internal-error',
  'no-generated-artifacts': 'internal-error',
});

/** The precondition each lifecycle reason reports as unmet. */
const PRECONDITION_OF_REASON = Object.freeze({
  'not-initialized': 'session-initialized',
  'not-validated': 'revision-validated',
  'design-system-unavailable': 'design-system-current',
});

const RETRY_OF_OUTCOME = Object.freeze({
  'invalid-input': 'never',
  'constraint-violation': 'after-refresh',
  'unsupported-capability': 'never',
  'denied-access': 'never',
  'stale-revision': 'after-refresh',
  cancelled: 'same-request',
  'internal-error': 'never',
});

const COMPILER_FAULT_CODES = new Set([
  'PMS_SESSION_INTERNAL',
  Codes.ABI_MISMATCH,
  Codes.GENERATED_ARTIFACT_MISMATCH,
]);

const STANDARD_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
]);

/**
 * A failure decided by the agent layer itself. `reason` is a closed id; no
 * field ever carries request text.
 */
export class AgentError extends Error {
  constructor({
    outcome,
    code,
    reason,
    stage = 'request',
    capability = null,
    precondition = null,
    context = {},
  }) {
    super(`${code}: ${reason}`);
    this.name = 'AgentError';
    this.outcome = outcome;
    this.code = code;
    this.reason = reason;
    this.stage = stage;
    this.capability = capability;
    this.precondition = precondition;
    this.context = context;
  }
}

const AGENT_ERROR_MESSAGES = Object.freeze({
  [AgentCodes.INVALID_REQUEST]:
    'The request does not match its schema or limits.',
  [AgentCodes.UNKNOWN_OPERATION]: 'The request names no registered operation.',
  [AgentCodes.OPERATION_UNSUPPORTED]:
    'The operation, view, protocol version or feature is not available.',
  [AgentCodes.ACCESS_DENIED]:
    'The presented capability does not authorize this operation.',
  [AgentCodes.CANCELLED]: 'The request was cancelled before it started.',
  [AgentCodes.INTERNAL]: 'Internal compiler error.',
});

function agentDiagnostic(error) {
  return diagnostic({
    code: error.code,
    phase: 'agent',
    rule: `agent.${error.outcome}`,
    message: AGENT_ERROR_MESSAGES[error.code],
    context: { reason: error.reason, ...error.context },
  });
}

function internal(reason, errorName = 'Error') {
  return new AgentError({
    outcome: 'internal-error',
    code: AgentCodes.INTERNAL,
    reason,
    stage: 'execution',
    context: { errorClass: errorName },
  });
}

/**
 * The outcome of a thrown value. Lifecycle codes are split by their closed
 * `context.reason`, never by message text.
 */
export function classifyError(error, { stage = 'execution' } = {}) {
  if (error instanceof AgentError) {
    return {
      outcome: error.outcome,
      stage: error.stage,
      reason: error.reason,
      precondition: error.precondition,
      capability: error.capability,
      diagnostics: [agentDiagnostic(error)],
    };
  }
  const diagnostics = Array.isArray(error?.diagnostics)
    ? error.diagnostics
    : null;
  if (error instanceof Error && diagnostics != null && diagnostics.length > 0) {
    const first = diagnostics[0];
    const reason = first?.context?.reason ?? null;
    const base = { stage, precondition: null, capability: null, diagnostics };
    switch (first?.code) {
      case Codes.INVALID_REVISION: {
        const outcome = INVALID_REVISION_OUTCOMES[reason];
        if (outcome == null) break;
        return {
          ...base,
          outcome,
          reason,
          stage:
            reason === 'design-system-unavailable' || stage === 'bootstrap'
              ? 'bootstrap'
              : stage,
          precondition: PRECONDITION_OF_REASON[reason] ?? null,
          capability:
            reason === 'snapshot-disabled'
              ? 'feature:accepted-snapshots'
              : null,
        };
      }
      case Codes.STALE_REVISION:
      case Codes.SUPERSEDED_REVISION:
        return {
          ...base,
          outcome: 'stale-revision',
          reason: reason ?? 'revision-mismatch',
        };
      case Codes.SESSION_CLOSED:
        return { ...base, outcome: 'stale-revision', reason: 'session-closed' };
      default:
        if (COMPILER_FAULT_CODES.has(first?.code)) {
          return {
            ...base,
            outcome: 'internal-error',
            reason: 'compiler-fault',
          };
        }
        if (diagnostics.some((entry) => entry?.severity === 'error')) {
          return {
            ...base,
            outcome: 'constraint-violation',
            reason: 'validation-errors',
          };
        }
    }
  }
  const name = STANDARD_ERROR_NAMES.has(error?.name) ? error.name : 'Error';
  return classifyError(internal('unclassified', name));
}

/**
 * The outcome of a verdict document (`check`). Severity decides, never code
 * family, and an `ok: false` verdict is never `success` (§3.6).
 */
export function classifyVerdict(document, identities) {
  if (document.ok === true) return { outcome: 'success' };
  const bootstrap = identities.designSystem == null;
  const errors = document.diagnostics.some(
    (entry) => entry?.severity === 'error',
  );
  // A compiler fault reported inside the verdict is still a fault, not a
  // property of the project.
  if (
    document.diagnostics.some((entry) => COMPILER_FAULT_CODES.has(entry?.code))
  ) {
    return {
      outcome: 'internal-error',
      stage: bootstrap ? 'bootstrap' : 'execution',
      reason: 'compiler-fault',
      precondition: null,
      capability: null,
      diagnostics: [],
    };
  }
  return {
    outcome: 'constraint-violation',
    stage: bootstrap ? 'bootstrap' : 'execution',
    reason: bootstrap
      ? 'design-system-unavailable'
      : errors
        ? 'validation-errors'
        : 'incomplete-validation',
    precondition: null,
    capability: null,
    diagnostics: [],
  };
}

export function failureOf(classified) {
  if (classified.outcome === 'success') return null;
  return {
    stage: classified.stage,
    reason: classified.reason,
    precondition: classified.precondition ?? null,
    capability: classified.capability ?? null,
    retry: RETRY_OF_OUTCOME[classified.outcome],
  };
}

/**
 * The canonical serialization of a record: JSON with every non-ASCII character
 * escaped. Byte and character offsets coincide, so a chunk never splits a
 * character, and parsing it gives the record back.
 */
export function canonicalJson(value) {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function recordInfo(value) {
  const text = canonicalJson(value);
  return {
    text,
    bytes: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/**
 * Packs a contiguous prefix of `records` (starting at `offset`) under the
 * record ceiling and the byte budget. A page stops before a withheld record;
 * when the first record is withheld, the page holds none and one `withheld`
 * entry, so every page with `offset < total` advances by at least one index.
 */
export function packRecords({
  records,
  offset,
  total,
  ceiling,
  budget,
  addressOf,
  describe = () => ({}),
}) {
  const packed = [];
  const withheld = [];
  let used = 0;
  for (let index = 0; index < records.length; index += 1) {
    const info = recordInfo(records[index]);
    if (info.bytes > ceiling) {
      if (packed.length === 0) {
        withheld.push({
          address: addressOf(offset + index),
          ...describe(records[index]),
          bytes: info.bytes,
          sha256: info.sha256,
        });
      }
      break;
    }
    const cost = info.bytes + (packed.length > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    packed.push(records[index]);
  }
  const next = offset + packed.length + withheld.length;
  return {
    records: packed,
    withheld,
    returned: packed.length,
    nextOffset: next < total ? next : null,
    truncated: next < total,
    used,
  };
}

/** A failure's diagnostics as v1 protocol records. */
export function failureDiagnostics(classified, revision) {
  return (classified.diagnostics ?? []).map((entry) =>
    protocolDiagnostic(entry, revision ?? null),
  );
}

function presentIdentities(identities) {
  const out = {};
  if (identities == null) return out;
  for (const key of [
    'projectId',
    'sessionId',
    'revision',
    'designSystem',
    'lastValidDesignSystem',
  ]) {
    if (identities[key] != null) out[key] = identities[key];
  }
  return out;
}

/**
 * Assembles an envelope and states its own size. `responseBytes` is part of
 * the bytes it measures, so it is settled by iteration (at most a few steps,
 * as only its digit count can change).
 */
export function buildEnvelope({
  operation = null,
  requestId = null,
  classified,
  identities = null,
  result = null,
  diagnostics = [],
  diagnosticsTotal = diagnostics.length,
  diagnosticsTruncated = false,
  references = [],
  view,
  page = null,
  withheld = [],
  limits,
}) {
  const envelope = {
    protocol: AGENT_PROTOCOL,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    ...(operation == null ? {} : { operation }),
    ...(requestId == null ? {} : { requestId }),
    outcome: classified.outcome,
    identities: presentIdentities(identities),
    result,
    diagnostics,
    diagnosticsTotal,
    diagnosticsTruncated,
    failure: failureOf(classified),
    references,
    view,
    page,
    withheld,
    limits: {
      maxResponseBytes: limits.maxResponseBytes,
      responseBytes: 0,
      floor: limits.floor,
      frameMax: limits.frameMax,
    },
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (bytes === envelope.limits.responseBytes) break;
    envelope.limits.responseBytes = bytes;
  }
  return envelope;
}

export { internal as internalAgentError };
