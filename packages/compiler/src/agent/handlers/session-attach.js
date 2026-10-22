/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { AgentCodes, AgentError } from '../../protocol/envelope.js';

/**
 * `session.attach` (AG-02.1 §3.9). Only a workspace binding serves it; the
 * dispatch core refuses it on a host binding before this runs.
 */
export async function sessionAttach(ctx) {
  if (ctx.workspace == null)
    throw new AgentError({
      outcome: 'unsupported-capability',
      code: AgentCodes.OPERATION_UNSUPPORTED,
      reason: 'binding',
      stage: 'request',
      capability: 'binding:workspace',
    });
  ctx.beforeStart?.();
  return ctx.workspace.attach(ctx.input);
}
