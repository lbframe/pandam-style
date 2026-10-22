/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import { Codes } from '../protocol/diagnostics.js';
import {
  AgentCodes,
  AgentError,
  classifyError,
  own,
} from '../protocol/envelope.js';
import { createDispatchCore } from './dispatch.js';
import { connectOwner } from './bridge/client.js';
import { capabilityDenial, mintCapability } from './capabilities.js';
import { REGISTRY } from './registry.js';
import { validateSchema } from './schema.js';
import { snapshotRequest } from './snapshot.js';

/**
 * AG-02.1 workspace binding (§3.9): the sessionless counterpart of
 * `createAgentBinding`, held by the agent's own tooling. It shares the
 * dispatch core of the host binding. Operations of the workspace itself run
 * locally; once a subject is attached, every other request is forwarded
 * unvalidated (apart from its frame bound) and the owner's envelope is
 * returned unchanged (§3.8). Without an owner, a session-bound operation is
 * `owner-required`. Nothing here can open a session (I9).
 */

/** Operations a workspace always answers itself. */
const LOCAL_OPERATIONS = Object.freeze([
  'session.attach',
  'discover',
  'session.open',
]);

const ownerRequired = (reason) =>
  new AgentError({
    outcome: 'owner-required',
    code: AgentCodes.OWNER_REQUIRED,
    reason,
    stage: 'request',
  });

export function createWorkspaceBinding({
  projectDir,
  runtimeDir = null,
  env = process.env,
  tmpdir,
  registry = REGISTRY,
} = {}) {
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir))
    throw new TypeError(
      'createWorkspaceBinding() requires an absolute projectDir.',
    );
  let disposed = false;
  let connection = null;
  const previousSessions = new Set();
  const key = Object.freeze({ revoked: () => disposed });

  const workspace = Object.freeze({
    async attach(input) {
      const next = await connectOwner({
        projectDir,
        projectId: input.projectId ?? null,
        outDir: input.outDir ?? null,
        protocolVersions: input.protocolVersions,
        runtimeDir,
        env,
        tmpdir,
      });
      const previous = connection;
      let previousSessionId = null;
      if (previous != null) {
        previous.close();
        if (previous.sessionId !== next.sessionId) {
          previousSessions.add(previous.sessionId);
          previousSessionId = previous.sessionId;
        }
      }
      previousSessions.delete(next.sessionId);
      connection = next;
      return {
        identities: next.identities,
        result: {
          identities: next.identities,
          granted: [...next.grants],
          previousSessionId,
        },
      };
    },
  });

  const core = createDispatchCore({
    registry,
    caller: 'createWorkspaceBinding()',
    staticIdentities: Object.freeze({}),
    key,
    kind: 'workspace',
    beforeExecute(entry) {
      if (entry.requires.binding !== 'session') return;
      throw ownerRequired(connection == null ? 'owner-absent' : 'owner-closed');
    },
    workspace,
  });

  function local(entry, value, classified) {
    const view = value.view === 'detail' ? 'detail' : 'compact';
    const requestId =
      typeof value.requestId === 'string' &&
      validateSchema(
        { type: 'string', format: 'request-id' },
        value.requestId,
      ) == null
        ? value.requestId
        : null;
    return core.finish({ entry, requestId, view, classified });
  }

  async function forward(request, options) {
    const snapshot = snapshotRequest(request, {
      ...registry.request,
      maxRequestBytes: connection.limits.maxRequestBytes,
    });
    const value = snapshot.ok ? snapshot.value : null;
    if (
      value == null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      LOCAL_OPERATIONS.includes(value.operation)
    )
      return null;
    const entry = own(registry.byName, value.operation) ?? null;
    const denial = capabilityDenial(options?.capability, key, 'consult');
    if (denial != null)
      return local(
        entry,
        value,
        classifyError(
          new AgentError({
            outcome: 'denied-access',
            code: AgentCodes.ACCESS_DENIED,
            reason: denial,
            stage: 'request',
            capability: 'grant:consult',
          }),
        ),
      );
    if (options?.signal?.aborted === true)
      return local(
        entry,
        value,
        classifyError(
          new AgentError({
            outcome: 'cancelled',
            code: AgentCodes.CANCELLED,
            reason: 'before-start',
            stage: 'execution',
          }),
        ),
      );
    // A revision of a session that a reconnect replaced (§3.9).
    const bound = value.input?.rev ?? value.input?.baseRevision;
    if (
      bound != null &&
      typeof bound === 'object' &&
      previousSessions.has(bound.sessionId)
    )
      return local(
        entry,
        value,
        classifyError(
          new AgentError({
            outcome: 'stale-revision',
            code: Codes.STALE_REVISION,
            reason: 'session-changed',
            stage: 'request',
          }),
        ),
      );
    const answer = await connection.request(value, {
      view: value.view === 'detail' ? 'detail' : 'compact',
    });
    return answer.envelope ?? local(entry, value, classifyError(answer.error));
  }

  return Object.freeze({
    projectDir,
    mintCapability({ grants } = {}) {
      if (disposed) throw new TypeError('The workspace binding is disposed.');
      return mintCapability(key, grants);
    },
    async dispatch(request, options = {}) {
      if (connection != null && !connection.closed()) {
        const forwarded = await forward(request, options);
        if (forwarded != null) return forwarded;
      }
      return core.dispatch(request, options);
    },
    /** The attached owner's session, or `null`. */
    subject: () =>
      connection == null
        ? null
        : { sessionId: connection.sessionId, closed: connection.closed() },
    dispose() {
      disposed = true;
      connection?.close();
    },
  });
}
