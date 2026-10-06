/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { finishProduction } from './state.js';
import transport from './transport-client.cjs';

export const name = 'pandamstyle';

// Documented production boundary; the supervised Turbopack command also
// requires the installed Next process to exit successfully before committing.
export async function onBuildComplete(context) {
  if (process.env.PMS_NEXT_COORDINATOR_FILE) {
    const file = process.env.PMS_NEXT_COORDINATOR_FILE;
    const description = await transport.request(file, 'identify');
    await transport.request(
      file,
      'production-complete',
      { projectDir: context.projectDir, buildId: context.buildId ?? null },
      { projectId: description.projectId, sessionId: description.sessionId },
    );
    return;
  }
  await finishProduction(context.projectDir);
}
