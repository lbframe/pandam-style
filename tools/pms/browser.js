/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

// Repository qualification only. Every harness that launches a system browser
// resolves it here, so the semantic oracle, Next and Rsbuild qualifications
// run, and report, the same executable.
const DEFAULT_BROWSER = '/opt/google/chrome/chrome';
// The CI browser is managed on the runner host, outside this repository. Its
// identity is committed here and checked, not downloaded.
const EXPECTED_FILE = path.join(__dirname, 'ci-browser.json');
// Real crash output (stack dumps, sandbox and zygote diagnostics) is far
// longer than a short tail.
const STDERR_LIMIT = 64 * 1024;

function browserExecutable(env = process.env) {
  return env.PMS_CHROMIUM || DEFAULT_BROWSER;
}

// Next alone accepts a launcher of its own, such as a profile-storage wrapper.
function nextBrowserExecutable(env = process.env) {
  return env.PMS_NEXT_CHROMIUM || browserExecutable(env);
}

function isCI(env = process.env) {
  return env.CI !== undefined && !['', '0', 'false'].includes(env.CI);
}

function expectedBrowser() {
  const { product, version } = require(EXPECTED_FILE);
  return { product, version };
}

// The binary reports its own identity; the environment only names its path.
function readBrowserIdentity(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const output = (result.stdout ?? '').trim();
  const match = output.match(/^(.*?)\s+(\d+(?:\.\d+)+)(?:\s|$)/);
  if (result.error || result.status !== 0 || !match)
    throw new Error(
      `BROWSER_IDENTITY_UNAVAILABLE: \`${executable} --version\` ` +
        (result.error
          ? `failed: ${result.error.message}`
          : `exited ${result.status ?? result.signal} with ${JSON.stringify(output)}`),
    );
  return { executable, product: match[1], version: match[2] };
}

// Fails in CI, warns locally: the CI browser is pinned by this check.
function qualifyBrowser({
  env = process.env,
  executable = browserExecutable(env),
  expected = expectedBrowser(),
  warn = (message) => process.stderr.write(`warning: ${message}\n`),
} = {}) {
  const ci = isCI(env);
  let identity;
  try {
    identity = readBrowserIdentity(executable);
  } catch (error) {
    if (ci) throw error;
    warn(error.message);
    return {
      executable,
      product: null,
      version: null,
      expected,
      matchesExpected: false,
      error: error.message,
    };
  }
  const matchesExpected =
    identity.product === expected.product &&
    identity.version === expected.version;
  if (!matchesExpected) {
    const message =
      `BROWSER_VERSION_UNEXPECTED: ${executable} is ${identity.product} ` +
      `${identity.version}; the CI browser is pinned to ${expected.product} ` +
      `${expected.version}. If the runner browser was upgraded deliberately, ` +
      'set "product" and "version" in tools/pms/ci-browser.json from ' +
      `\`${executable} --version\` on the CI host and commit the change.`;
    if (ci) throw new Error(message);
    warn(message);
  }
  return { ...identity, expected, matchesExpected };
}

// Keeps the end of a stream, where a crash reports its cause, and says so
// whenever anything was dropped.
function boundedTail(text, limit = STDERR_LIMIT) {
  if (text.length <= limit) return text;
  return (
    `[truncated: kept the last ${limit} of ${text.length} characters]\n` +
    text.slice(-limit)
  );
}

module.exports = {
  DEFAULT_BROWSER,
  STDERR_LIMIT,
  browserExecutable,
  nextBrowserExecutable,
  isCI,
  expectedBrowser,
  readBrowserIdentity,
  qualifyBrowser,
  boundedTail,
};
