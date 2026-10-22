/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 test owner in its own process: initializes a session on a fixture
 * copy (acquiring the output lease), starts the owner bridge, prints one JSON
 * line and stays alive. SIGTERM stops the bridge, then closes the session;
 * SIGKILL leaves whatever a crash leaves. Not a test suite.
 */

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const compiler = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

(async () => {
  const [project, runtimeDir, bridgeMode = 'bridge'] = process.argv.slice(2);
  const config = require(path.join(project, 'pandamstyle.config.js'));
  const session = compiler.createPublicProjectSession({
    projectId: project,
    rootDir: project,
    definition: (
      await import(pathToFileURL(path.resolve(project, config.definition)).href)
    ).default,
    roots: (config.roots ?? []).map((root) => path.resolve(project, root)),
    outDir: path.resolve(project, config.outDir),
    designSystemFile: config.designSystemFile,
  });
  try {
    await session.initialize();
  } catch (error) {
    print({
      owner: false,
      reason: error?.diagnostics?.[0]?.context?.reason ?? 'error',
    });
    process.exit(0);
  }
  const bridge =
    bridgeMode === 'bridge'
      ? await compiler.startOwnerBridge({ session, host: 'test', runtimeDir })
      : { started: false, reason: 'not-requested' };
  print({
    owner: true,
    started: bridge.started,
    reason: bridge.reason ?? null,
    sessionId: session.sessionId,
    name: bridge.name ?? null,
    pid: process.pid,
  });
  process.on('SIGTERM', async () => {
    await bridge.close?.();
    await session.close();
    process.exit(0);
  });
  // Exit without closing: only the bridge's exit handler cleans up.
  process.on('SIGUSR2', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
})();
