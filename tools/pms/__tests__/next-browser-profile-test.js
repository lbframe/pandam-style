/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const {
  createNextBrowserProfile,
  launchWithNextBrowserProfile,
} = require('../next-browser-profile');

test('concurrent Next qualification runs receive isolated disposable profiles', async () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-next-browser-profile-test-'),
  );
  let profiles = [];
  try {
    profiles = await Promise.all([
      createNextBrowserProfile(output),
      createNextBrowserProfile(output),
    ]);
    expect(profiles[0].runId).not.toBe(profiles[1].runId);
    expect(profiles[0].userDataDir).not.toBe(profiles[1].userDataDir);
    for (const profile of profiles) {
      expect(path.dirname(profile.userDataDir)).toBe(output);
      expect(fs.statSync(profile.userDataDir).isDirectory()).toBe(true);
    }
  } finally {
    const cleanups = await Promise.all(
      profiles.map((profile) => profile.cleanup()),
    );
    expect(cleanups.every((result) => result.userDataDirRemoved)).toBe(true);
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('Chromium launch receives its allocated profile path', async () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-next-browser-launch-test-'),
  );
  let profile;
  try {
    profile = await createNextBrowserProfile(output);
    let received;
    const browser = { id: 'browser' };
    const launched = await launchWithNextBrowserProfile(
      {
        async launch(options) {
          received = options;
          return browser;
        },
      },
      profile,
      { headless: true, userDataDir: path.join(output, 'wrong-profile') },
    );
    expect(launched).toBe(browser);
    expect(received.userDataDir).toBe(profile.userDataDir);
    expect(received.headless).toBe(true);
  } finally {
    if (profile) {
      const cleanup = await profile.cleanup();
      expect(cleanup.userDataDirRemoved).toBe(true);
    }
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('BrowserProbe passes and removes its isolated Chromium profile', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-next-browser-probe-test-'),
  );
  const output = path.join(root, 'output');
  const fakePuppeteer = path.join(root, 'node_modules/puppeteer-core');
  const capturedOptions = path.join(root, 'launch-options.json');
  const exercise = path.join(root, 'exercise.mjs');
  const browserProbeModule = pathToFileURL(
    path.resolve(__dirname, '../qualify-next-semantic-dev.mjs'),
  ).href;
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(fakePuppeteer, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
  fs.writeFileSync(
    path.join(fakePuppeteer, 'package.json'),
    '{"name":"puppeteer-core","main":"index.js"}\n',
  );
  fs.writeFileSync(
    path.join(fakePuppeteer, 'index.js'),
    [
      "const fs = require('node:fs');",
      'const page = {',
      '  evaluateOnNewDocument: async () => {},',
      '  on: () => {},',
      '  bringToFront: async () => {},',
      '  goto: async () => {},',
      '  url: () => "http://127.0.0.1:54321/",',
      '};',
      'module.exports = {',
      '  async launch(options) {',
      '    fs.writeFileSync(process.env.PMS_CAPTURE_OPTIONS, JSON.stringify(options));',
      '    return {',
      '      process: () => ({ pid: 1234 }),',
      '      once: () => {},',
      '      version: async () => "Chrome/test",',
      '      newPage: async () => page,',
      '      close: async () => {},',
      '    };',
      '  },',
      '};',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    exercise,
    [
      `import { BrowserProbe } from ${JSON.stringify(browserProbeModule)};`,
      'const run = { root: process.argv[2], output: process.argv[3], report: {} };',
      'const probe = new BrowserProbe(run, "http://127.0.0.1:54321");',
      'await probe.launch();',
      'await probe.close();',
      'process.stdout.write(JSON.stringify(run.report.browserSessions[0].browserProfile));',
      '',
    ].join('\n'),
  );

  try {
    const result = spawnSync(process.execPath, [exercise, root, output], {
      encoding: 'utf8',
      env: { ...process.env, PMS_CAPTURE_OPTIONS: capturedOptions },
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const options = JSON.parse(fs.readFileSync(capturedOptions, 'utf8'));
    const profile = JSON.parse(result.stdout);
    expect(path.dirname(options.userDataDir)).toBe(output);
    expect(options.userDataDir).toBe(profile.userDataDir);
    expect(profile.launchAttempted).toBe(true);
    expect(profile.browserProcess).toMatchObject({
      pid: 1234,
      status: 'closed',
    });
    expect(profile.cleanup).toEqual({
      browserClosed: true,
      userDataDirRemoved: true,
    });
    expect(fs.existsSync(profile.userDataDir)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
