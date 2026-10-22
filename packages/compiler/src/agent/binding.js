/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AGENT_SESSION_HOOKS } from '../api/project.js';
import { classifyError, failureDiagnostics } from '../protocol/envelope.js';
import { mintCapability } from './capabilities.js';
import { createDispatchCore } from './dispatch.js';
import { REGISTRY } from './registry.js';
import { stringBytes } from './schema.js';
import { BOUNDS } from './schemas.js';

/**
 * AG-01.1 host binding: the only way to mint a capability on a session, and
 * its entry point to the agent protocol (D4). Its dispatch path is the shared
 * core of `dispatch.js` (AG-02.1 §3.9).
 */

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
  const core = createDispatchCore({
    registry,
    limits,
    caller: 'createAgentBinding()',
    staticIdentities,
    key,
    kind: 'host',
    hooks,
    bootstrapOf: () => bootstrap,
  });

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

  return Object.freeze({
    projectId: session.projectId,
    sessionId: session.sessionId,
    mintCapability({ grants } = {}) {
      if (disposed) throw new TypeError('The agent binding is disposed.');
      return mintCapability(key, grants);
    },
    dispatch: core.dispatch,
    dispose() {
      disposed = true;
    },
    // AG-02.1: what the owner bridge needs from its own binding. The paths are
    // the session's canonical ones; `revoked()` is the capability state.
    paths: () => ({ rootDir: paths.rootDir, outDir: paths.outDir }),
    revoked: () => key.revoked(),
  });
}
