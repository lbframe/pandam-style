/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function createNextBrowserProfile(outputDir, runId = randomUUID()) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error('NEXT_BROWSER_PROFILE_RUN_ID_INVALID');
  }
  const root = path.resolve(outputDir);
  const userDataDir = path.join(root, `.next-browser-profile-${runId}`);
  await fs.mkdir(userDataDir, { recursive: false });

  return {
    runId,
    userDataDir,
    async cleanup() {
      await fs.rm(userDataDir, { recursive: true, force: true });
      let removed = false;
      try {
        await fs.access(userDataDir);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        removed = true;
      }
      return { userDataDirRemoved: removed };
    },
  };
}

async function launchWithNextBrowserProfile(launcher, profile, options = {}) {
  if (!profile || typeof profile.userDataDir !== 'string') {
    throw new Error('NEXT_BROWSER_PROFILE_REQUIRED');
  }
  if (!launcher || typeof launcher.launch !== 'function') {
    throw new Error('NEXT_BROWSER_LAUNCHER_REQUIRED');
  }
  return launcher.launch({ ...options, userDataDir: profile.userDataDir });
}

module.exports = { createNextBrowserProfile, launchWithNextBrowserProfile };
