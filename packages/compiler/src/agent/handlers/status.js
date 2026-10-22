/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** `session.status`: the binding is the subject of the request. */
export async function sessionStatus(ctx) {
  const { identities, value } = await ctx.hooks.status(ctx.beforeStart);
  return {
    identities,
    result: {
      initialized: value.initialized,
      generationId: value.generationId,
    },
  };
}
