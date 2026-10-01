/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * PandamStyle's Babel pass state is local to one invocation. It carries only
 * source identity needed by diagnostics and static evaluation.
 */

export function createPassState(pluginPass) {
  const file = pluginPass?.file ?? null;
  return Object.freeze({
    file,
    filename: file?.opts?.filename ?? pluginPass?.filename ?? 'unknown',
  });
}
