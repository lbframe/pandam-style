/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AGENT_SESSION_HOOKS } from '../api/project.js';
import {
  AgentCodes,
  AgentError,
  AGENT_PROTOCOL,
  buildEnvelope,
  classifyError,
  own,
  failureDiagnostics,
  internalAgentError,
  OUTCOMES,
  recordInfo,
  RETRY_HINTS,
  STAGES,
} from '../protocol/envelope.js';
import {
  capabilityDenial,
  GRANTS,
  grantsOf,
  mintCapability,
} from './capabilities.js';
import {
  EFFECT_KINDS,
  envelopeSchema,
  REGISTRY,
  schemaFailureReason,
} from './registry.js';
import { stringBytes, validateSchema } from './schema.js';
import { BOUNDS, enumOf, int, obj, str, VIEWS } from './schemas.js';
import { snapshotRequest } from './snapshot.js';
import { pack } from './handlers/pages.js';

/**
 * AG-01.1 host binding: the only way to mint a capability and the only entry
 * point of the agent protocol (D4). `dispatch` never throws: every result,
 * including a host fault, is an envelope.
 */

const REQUEST_FRAME = obj(
  {
    protocol: { const: AGENT_PROTOCOL },
    protocolVersion: int(1, 1024),
    operation: str(BOUNDS.operationName),
    requestId: str(4096),
    view: enumOf(VIEWS),
    maxResponseBytes: int(1),
  },
  ['protocolVersion', 'operation'],
);

const VOCABULARIES = Object.freeze({
  grants: [...GRANTS],
  effects: [...EFFECT_KINDS],
  outcomes: [...OUTCOMES],
  stages: [...STAGES],
  retry: [...RETRY_HINTS],
});

function requestError(reason, context = {}) {
  return new AgentError({
    outcome: 'invalid-input',
    code: AgentCodes.INVALID_REQUEST,
    reason,
    stage: 'request',
    context,
  });
}

function unsupported(reason, capability, context = {}) {
  return new AgentError({
    outcome: 'unsupported-capability',
    code: AgentCodes.OPERATION_UNSUPPORTED,
    reason,
    stage: 'request',
    capability,
    context,
  });
}

function isRequestId(value) {
  return (
    typeof value === 'string' &&
    validateSchema({ type: 'string', format: 'request-id' }, value) == null
  );
}

function checkHostBound(name, value, bound) {
  if (typeof value !== 'string' || stringBytes(value) > bound) {
    throw new TypeError(
      `createAgentBinding() refuses a session whose ${name} exceeds ${bound} serialized bytes.`,
    );
  }
}

/**
 * Binds a `ProjectSession` for agent use. With `initialize: true` the binding
 * initializes the session once and records a failure as a structured bootstrap
 * failure that every later operation returns (§3.7).
 */
export async function createAgentBinding({
  session,
  initialize = false,
  limits = {},
  registry = REGISTRY,
} = {}) {
  const hooks = session?.[AGENT_SESSION_HOOKS];
  if (hooks == null) {
    throw new TypeError(
      'createAgentBinding() requires a ProjectSession created by this compiler.',
    );
  }
  checkHostBound('projectId', session.projectId, BOUNDS.projectId);
  const paths = hooks.paths();
  checkHostBound('rootDir', paths.rootDir, BOUNDS.rootDir);
  checkHostBound('outDir', paths.outDir, BOUNDS.outDir);

  const views = Object.create(null);
  for (const view of VIEWS) {
    const base = registry.views[view];
    const ceiling = limits?.[view]?.maxResponseBytes ?? base.maxResponseBytes;
    if (!Number.isSafeInteger(ceiling) || ceiling < base.floor) {
      throw new TypeError(
        `createAgentBinding() requires a ${view} maxResponseBytes of at least ${base.floor}.`,
      );
    }
    views[view] = Object.freeze({ ...base, maxResponseBytes: ceiling });
  }

  const staticIdentities = Object.freeze({
    projectId: session.projectId,
    sessionId: session.sessionId,
  });
  let disposed = false;
  let bootstrap = null;
  // Closing the session revokes every capability. A bootstrap failure closes
  // the session too, but its cause stays reportable (§3.7).
  const key = Object.freeze({
    revoked: () => disposed || (bootstrap == null && hooks.closed()),
  });
  const envelopeSchemas = new Map();
  const envelopeSchemaOf = (entry) => {
    let schema = envelopeSchemas.get(entry.name);
    if (schema == null) {
      schema = envelopeSchema(
        entry.status === 'implemented'
          ? entry.output
          : {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
        registry.names,
      );
      envelopeSchemas.set(entry.name, schema);
    }
    return schema;
  };

  if (initialize === true) {
    try {
      await session.initialize();
    } catch (error) {
      const classified = classifyError(error, { stage: 'bootstrap' });
      bootstrap = Object.freeze({
        classified: { ...classified, stage: 'bootstrap', diagnostics: [] },
        identities: staticIdentities,
        records: Object.freeze(failureDiagnostics(classified, null)),
      });
    }
  }

  // The fail-safes below replace an envelope with a constant-size
  // `internal-error`; that replacement is itself never re-checked.
  function finish({
    entry,
    requestId,
    view,
    classified,
    handled = {},
    failSafe = true,
  }) {
    const viewLimits = views[view];
    const maxResponseBytes =
      handled.maxResponseBytes ?? viewLimits.maxResponseBytes;
    const limits = {
      maxResponseBytes,
      floor: viewLimits.floor,
      frameMax: viewLimits.frameMax,
    };
    const success = classified.outcome === 'success';
    let diagnostics = handled.diagnostics ?? [];
    let diagnosticsTotal = handled.diagnosticsTotal ?? diagnostics.length;
    const diagnosticsTruncated = handled.diagnosticsTruncated ?? false;
    if (!success && handled.diagnostics == null) {
      diagnostics = failureDiagnostics(classified, null);
      diagnosticsTotal = diagnostics.length;
      // Fail-safe (§3.10): a failure record over the record ceiling is a
      // compiler fault, reported at constant size.
      if (
        failSafe &&
        diagnostics.some(
          (record) => recordInfo(record).bytes > viewLimits.recordCeiling,
        )
      ) {
        return finish({
          entry,
          requestId,
          view,
          classified: classifyError(
            internalAgentError('unbounded-failure-record'),
          ),
          failSafe: false,
        });
      }
    }
    const envelope = buildEnvelope({
      operation: entry?.name ?? null,
      requestId,
      classified,
      identities: handled.identities ?? staticIdentities,
      result: handled.result ?? null,
      diagnostics,
      diagnosticsTotal,
      diagnosticsTruncated,
      references: handled.references ?? [],
      view,
      page: handled.page ?? null,
      withheld: handled.withheld ?? [],
      limits,
    });
    if (!failSafe) return envelope;
    if (
      entry != null &&
      validateSchema(envelopeSchemaOf(entry), envelope) != null
    ) {
      return finish({
        entry,
        requestId,
        view,
        classified: classifyError(
          internalAgentError('output-schema-violation'),
        ),
        failSafe: false,
      });
    }
    if (envelope.limits.responseBytes > maxResponseBytes) {
      return finish({
        entry,
        requestId,
        view,
        classified: classifyError(internalAgentError('response-over-ceiling')),
        failSafe: false,
      });
    }
    return envelope;
  }

  function bootstrapEnvelope(entry, requestId, view, maxResponseBytes) {
    const ctx = {
      viewLimits: views[view],
      budget: { remaining: maxResponseBytes - views[view].frameMax },
    };
    const packed = pack(ctx, {
      records: bootstrap.records,
      offset: 0,
      total: bootstrap.records.length,
      addressOf: (index) => ({ kind: 'bootstrap', index }),
      describe: (record) => ({
        ...(typeof record?.code === 'string' && record.code.length <= 64
          ? { code: record.code }
          : {}),
        ...(['error', 'warning', 'info'].includes(record?.severity)
          ? { severity: record.severity }
          : {}),
      }),
    });
    const references = [];
    const nextIndex = packed.returned + packed.withheld.length;
    if (nextIndex < bootstrap.records.length || packed.withheld.length > 0) {
      references.push({
        operation: 'records.read',
        view,
        input: {
          rev: null,
          address: {
            kind: 'bootstrap',
            index: packed.withheld.length > 0 ? packed.returned : nextIndex,
          },
          page: { offset: 0, limit: 262144 },
        },
      });
    }
    return finish({
      entry,
      requestId,
      view,
      classified: bootstrap.classified,
      handled: {
        maxResponseBytes,
        identities: bootstrap.identities,
        diagnostics: packed.records,
        diagnosticsTotal: bootstrap.records.length,
        diagnosticsTruncated: packed.returned < bootstrap.records.length,
        withheld: packed.withheld,
        references,
      },
    });
  }

  async function dispatchSafely(request, options) {
    let view = 'compact';
    let requestId = null;
    let entry = null;
    try {
      // (1) Envelope shape, on a frozen plain-data snapshot (T7, I6).
      const snapshot = snapshotRequest(request, registry.request);
      if (!snapshot.ok) {
        throw requestError(snapshot.reason, { depth: snapshot.depth });
      }
      const value = snapshot.value;
      if (value == null || typeof value !== 'object' || Array.isArray(value))
        throw requestError(schemaFailureReason('type'), { path: [] });
      if (isRequestId(value.requestId)) requestId = value.requestId;
      if (value.view === 'detail') view = 'detail';
      const { input = {}, ...frame } = value;
      const frameFailure = validateSchema(REQUEST_FRAME, frame);
      if (frameFailure != null) {
        throw requestError(schemaFailureReason(frameFailure.keyword), {
          path: frameFailure.path,
        });
      }
      if (value.requestId !== undefined && requestId == null)
        throw requestError(schemaFailureReason('format'), {
          path: ['requestId'],
        });
      if (input === null || typeof input !== 'object' || Array.isArray(input))
        throw requestError(schemaFailureReason('type'), { path: ['input'] });
      if (value.protocolVersion !== 1)
        throw unsupported('protocol-version', 'protocol-version');

      // (2) The operation exists. (3) It is implemented and has the view.
      entry = own(registry.byName, value.operation) ?? null;
      if (entry == null) {
        throw new AgentError({
          outcome: 'invalid-input',
          code: AgentCodes.UNKNOWN_OPERATION,
          reason: 'unknown-operation',
          stage: 'request',
        });
      }
      if (entry.status === 'planned')
        throw unsupported('planned', `op:${entry.name}`, {
          owner: entry.owner,
        });
      if (!entry.views.includes(view))
        throw unsupported('view', `view:${view}`);

      // (4) The capability, before anything about the payload is revealed.
      const capability = options?.capability;
      if (entry.requires.grant != null) {
        const denial = capabilityDenial(capability, key, entry.requires.grant);
        if (denial != null) {
          throw new AgentError({
            outcome: 'denied-access',
            code: AgentCodes.ACCESS_DENIED,
            reason: denial,
            stage: 'request',
            capability: `grant:${entry.requires.grant}`,
          });
        }
      }

      // (5) The input schema and the response limits.
      const inputFailure = validateSchema(entry.input, input);
      if (inputFailure != null) {
        throw requestError(schemaFailureReason(inputFailure.keyword), {
          path: inputFailure.path,
        });
      }
      const viewLimits = views[view];
      const maxResponseBytes =
        value.maxResponseBytes ?? viewLimits.maxResponseBytes;
      if (maxResponseBytes < viewLimits.floor)
        throw requestError('response-floor');
      if (maxResponseBytes > viewLimits.maxResponseBytes)
        throw requestError('response-ceiling');

      // (6) Preconditions: a failed bootstrap answers for the binding.
      if (
        bootstrap != null &&
        entry.requires.binding === 'session' &&
        !(entry.name === 'records.read' && input.address?.kind === 'bootstrap')
      ) {
        return bootstrapEnvelope(entry, requestId, view, maxResponseBytes);
      }
      const signal = options?.signal;
      const beforeStart =
        entry.cancellation === 'none'
          ? null
          : () => {
              if (signal?.aborted === true) {
                throw new AgentError({
                  outcome: 'cancelled',
                  code: AgentCodes.CANCELLED,
                  reason: 'before-start',
                  stage: 'execution',
                });
              }
            };
      beforeStart?.();

      // (7) Execution, on the same snapshot that was validated.
      const handled = await own(
        registry.handlers,
        entry.name,
      )({
        input,
        view,
        viewLimits,
        registry,
        // Echoed only by a receipt, and only once it passed the format.
        requestId,
        hooks: entry.requires.binding === 'session' ? hooks : null,
        beforeStart,
        budget: { remaining: maxResponseBytes - viewLimits.frameMax },
        binding: { bootstrapFailure: () => bootstrap },
        grants: grantsOf(capability, key),
        limitsOf: (name) => own(views, name),
        vocabularies: VOCABULARIES,
      });
      return finish({
        entry,
        requestId,
        view,
        classified: handled.classified ?? { outcome: 'success' },
        handled: { ...handled, maxResponseBytes },
      });
    } catch (error) {
      return finish({
        entry,
        requestId,
        view,
        classified: classifyError(error),
      });
    }
  }

  return Object.freeze({
    projectId: session.projectId,
    sessionId: session.sessionId,
    mintCapability({ grants } = {}) {
      if (disposed) throw new TypeError('The agent binding is disposed.');
      return mintCapability(key, grants);
    },
    async dispatch(request, options = {}) {
      try {
        return await dispatchSafely(request, options);
      } catch {
        return finish({
          entry: null,
          requestId: null,
          view: 'compact',
          classified: classifyError(internalAgentError('unclassified')),
          failSafe: false,
        });
      }
    },
    dispose() {
      disposed = true;
    },
  });
}
