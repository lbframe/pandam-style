/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Repository qualification only. Every harness that launches a system browser
// resolves it here, so the semantic oracle, Next and Rsbuild qualifications
// run, and report, the same executable.
const DEFAULT_BROWSER = '/opt/google/chrome/chrome';
const REPO = path.resolve(__dirname, '../..');
// The CI browser is managed on the runner host, outside this repository. Its
// identity is committed here and checked, not downloaded.
const CI_PIN = 'tools/pms/ci-browser.json';
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

// A pin is the canonical file it names: symlinks, in the pin or in any
// parent including the repository root, are resolved before containment is
// checked, and the file is read from that canonical path.
function pinFile(pin, repo = REPO) {
  let root;
  let file;
  try {
    root = fs.realpathSync(repo);
    file = fs.realpathSync(path.resolve(repo, pin));
  } catch (error) {
    throw new Error(`BROWSER_PIN_UNAVAILABLE: ${pin}: ${error.message}`);
  }
  const relative = path.relative(root, file);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative)
  )
    throw new Error(
      `BROWSER_PIN_OUTSIDE_REPOSITORY: ${pin} must name a pin committed in this repository`,
    );
  return { file, relative: relative.split(path.sep).join('/') };
}

// A reproduction binds its evidence to another committed pin, such as the
// archived engine of a baseline epoch, with PMS_BROWSER_PIN.
function browserPin(env = process.env, repo = REPO) {
  if (!env.PMS_BROWSER_PIN) return CI_PIN;
  return pinFile(env.PMS_BROWSER_PIN, repo).relative;
}

function expectedBrowser(pin = CI_PIN, repo = REPO) {
  const { product, version } = JSON.parse(
    fs.readFileSync(pinFile(pin, repo).file, 'utf8'),
  );
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

// Fails in CI or under a named pin, warns otherwise: the CI browser, and any
// reproduction that names a pin, is pinned by this check.
function qualifyBrowser({
  env = process.env,
  executable = browserExecutable(env),
  pin = browserPin(env),
  expected = expectedBrowser(pin),
  warn = (message) => process.stderr.write(`warning: ${message}\n`),
} = {}) {
  const strict = isCI(env) || Boolean(env.PMS_BROWSER_PIN);
  let identity;
  try {
    identity = readBrowserIdentity(executable);
  } catch (error) {
    if (strict) throw error;
    warn(error.message);
    return {
      executable,
      product: null,
      version: null,
      expected,
      pin,
      matchesExpected: false,
      error: error.message,
    };
  }
  const matchesExpected =
    identity.product === expected.product &&
    identity.version === expected.version;
  if (!matchesExpected) {
    const found = `${executable} is ${identity.product} ${identity.version}`;
    const message =
      pin === CI_PIN
        ? `BROWSER_VERSION_UNEXPECTED: ${found}; the CI browser is pinned to ` +
          `${expected.product} ${expected.version}. If the runner browser was ` +
          'upgraded deliberately, set "product" and "version" in ' +
          `${CI_PIN} from \`${executable} --version\` on the CI host and ` +
          'commit the change.'
        : `BROWSER_VERSION_UNEXPECTED: ${found}; ${pin} pins ` +
          `${expected.product} ${expected.version}. Set PMS_CHROMIUM to the ` +
          'pinned browser.';
    if (strict) throw new Error(message);
    warn(message);
  }
  return { ...identity, expected, pin, matchesExpected };
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
  browserPin,
  expectedBrowser,
  readBrowserIdentity,
  qualifyBrowser,
  boundedTail,
};
