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
const { execFileSync } = require('node:child_process');
const {
  DEFAULT_BROWSER,
  STDERR_LIMIT,
  browserExecutable,
  nextBrowserExecutable,
  isCI,
  expectedBrowser,
  readBrowserIdentity,
  qualifyBrowser,
  boundedTail,
} = require('../browser');

const ROOT = path.resolve(__dirname, '../../..');
const EXPECTED = { product: 'Google Chrome', version: '155.0.8059.84' };

let scratch;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-browser-test-'));
});
afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

function fakeBrowser(body, name = 'browser') {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

function qualify(executable, env, warnings = []) {
  return qualifyBrowser({
    env,
    executable,
    expected: EXPECTED,
    warn: (message) => warnings.push(message),
  });
}

test('one default browser, overridden by PMS_CHROMIUM and, for Next, PMS_NEXT_CHROMIUM', () => {
  expect(DEFAULT_BROWSER).toBe('/opt/google/chrome/chrome');
  expect(browserExecutable({})).toBe(DEFAULT_BROWSER);
  expect(browserExecutable({ PMS_CHROMIUM: '' })).toBe(DEFAULT_BROWSER);
  expect(browserExecutable({ PMS_CHROMIUM: '/x/chrome' })).toBe('/x/chrome');
  expect(nextBrowserExecutable({})).toBe(DEFAULT_BROWSER);
  expect(nextBrowserExecutable({ PMS_CHROMIUM: '/x/chrome' })).toBe(
    '/x/chrome',
  );
  expect(
    nextBrowserExecutable({
      PMS_CHROMIUM: '/x/chrome',
      PMS_NEXT_CHROMIUM: '/x/next',
    }),
  ).toBe('/x/next');
  // The semantic oracle, Next and Rsbuild harnesses read the same helper.
  expect(browserExecutable({ PMS_NEXT_CHROMIUM: '/x/next' })).toBe(
    DEFAULT_BROWSER,
  );
});

test('CI is detected from a set, non-false CI variable', () => {
  expect(isCI({})).toBe(false);
  for (const value of ['', '0', 'false'])
    expect(isCI({ CI: value })).toBe(false);
  for (const value of ['true', '1', 'yes'])
    expect(isCI({ CI: value })).toBe(true);
});

test('the committed CI identity names a product and a full four-part version', () => {
  const expected = expectedBrowser();
  expect(Object.keys(expected)).toEqual(['product', 'version']);
  expect(expected.product).toMatch(/\S/);
  expect(expected.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  expect(
    Object.keys(
      JSON.parse(fs.readFileSync(require.resolve('../ci-browser.json'))),
    ),
  ).toEqual(['product', 'version']);
});

test('the identity is read from the binary, not from the environment', () => {
  const chrome = fakeBrowser('echo "Google Chrome 155.0.8059.84 "');
  expect(readBrowserIdentity(chrome)).toEqual({
    executable: chrome,
    product: 'Google Chrome',
    version: '155.0.8059.84',
  });
  const chromium = fakeBrowser(
    'echo "Chromium 148.0.7778.96 snap"',
    'chromium',
  );
  expect(readBrowserIdentity(chromium)).toMatchObject({
    product: 'Chromium',
    version: '148.0.7778.96',
  });
  const failing = fakeBrowser('echo "Google Chrome 1.2.3.4"; exit 3', 'fail');
  expect(() => readBrowserIdentity(failing)).toThrow(
    /BROWSER_IDENTITY_UNAVAILABLE: .*exited 3/,
  );
  const unparsable = fakeBrowser('echo "no version here"', 'odd');
  expect(() => readBrowserIdentity(unparsable)).toThrow(
    /BROWSER_IDENTITY_UNAVAILABLE/,
  );
  expect(() => readBrowserIdentity(path.join(scratch, 'missing'))).toThrow(
    /BROWSER_IDENTITY_UNAVAILABLE: .*failed: .*ENOENT/,
  );
});

test('the expected browser passes silently, in CI and locally', () => {
  const chrome = fakeBrowser('echo "Google Chrome 155.0.8059.84"');
  for (const env of [{ CI: 'true' }, {}]) {
    const warnings = [];
    expect(qualify(chrome, env, warnings)).toEqual({
      executable: chrome,
      product: 'Google Chrome',
      version: '155.0.8059.84',
      expected: EXPECTED,
      matchesExpected: true,
    });
    expect(warnings).toEqual([]);
  }
});

test('an unexpected version or product fails in CI and only warns locally', () => {
  for (const output of [
    'Google Chrome 155.0.8059.85',
    'Google Chrome 156.0.8059.84',
    'Chromium 155.0.8059.84',
  ]) {
    const browser = fakeBrowser(`echo "${output}"`);
    let error;
    try {
      qualify(browser, { CI: 'true' });
    } catch (caught) {
      error = caught;
    }
    expect(error?.message).toMatch(/^BROWSER_VERSION_UNEXPECTED: /);
    expect(error.message).toContain(output);
    expect(error.message).toContain('Google Chrome 155.0.8059.84');
    // The message says how to accept a deliberate upgrade.
    expect(error.message).toContain('tools/pms/ci-browser.json');
    expect(error.message).toContain(`${browser} --version`);

    const warnings = [];
    expect(qualify(browser, {}, warnings)).toMatchObject({
      executable: browser,
      matchesExpected: false,
    });
    expect(warnings).toEqual([error.message]);
  }
});

test('an unreadable browser identity fails in CI and is recorded locally', () => {
  const missing = path.join(scratch, 'missing');
  expect(() => qualify(missing, { CI: '1' })).toThrow(
    /BROWSER_IDENTITY_UNAVAILABLE/,
  );
  const warnings = [];
  const identity = qualify(missing, {}, warnings);
  expect(identity).toMatchObject({
    executable: missing,
    product: null,
    version: null,
    matchesExpected: false,
  });
  expect(identity.error).toMatch(/BROWSER_IDENTITY_UNAVAILABLE/);
  expect(warnings).toEqual([identity.error]);
});

test('stderr keeps at least 64 KiB and marks every truncation', () => {
  expect(STDERR_LIMIT).toBeGreaterThanOrEqual(64 * 1024);
  const short = 'x'.repeat(STDERR_LIMIT);
  expect(boundedTail(short)).toBe(short);
  expect(boundedTail('')).toBe('');
  const long = 'head-' + 'y'.repeat(STDERR_LIMIT) + '-tail';
  const kept = boundedTail(long);
  expect(kept).toBe(
    `[truncated: kept the last ${STDERR_LIMIT} of ${long.length} characters]\n` +
      long.slice(-STDERR_LIMIT),
  );
  expect(kept).toContain('-tail');
  expect(kept).not.toContain('head-');
});

test('a semantic browser crash reports its executable and bounded stderr', () => {
  const {
    observeBrowser,
  } = require('../../../tests/semantic/harness/browser-adapter');
  const total = STDERR_LIMIT + 1000;
  const crashing = fakeBrowser(
    `node -e "process.stderr.write('a'.repeat(${total - 9}) + 'CRASH-END')"; exit 7`,
  );
  const spec = {
    observe: { browser: { hydration: false, properties: ['color'] } },
  };
  const previous = process.env.PMS_CHROMIUM;
  process.env.PMS_CHROMIUM = crashing;
  let error;
  try {
    observeBrowser(scratch, scratch, spec, { result: { className: '' } }, '');
  } catch (caught) {
    error = caught;
  } finally {
    if (previous === undefined) delete process.env.PMS_CHROMIUM;
    else process.env.PMS_CHROMIUM = previous;
  }
  expect(error?.message).toContain(
    `Semantic browser execution failed (${crashing}, exit 7): `,
  );
  expect(error.message).toContain(
    `[truncated: kept the last ${STDERR_LIMIT} of ${total} characters]`,
  );
  expect(error.message).toMatch(/CRASH-END$/);
});

test('a semantic case whose lane fails to execute still writes its failure report', () => {
  const { runCase } = require('../../../tests/semantic/harness/run-case');
  const spec = {
    id: 'unregistered.case',
    area: 'browser',
    status: 'MUST_PRESERVE',
    freshApplicable: true,
    incrementalApplicable: false,
    revisions: [],
  };
  expect(() => runCase(spec, scratch)).toThrow(/failed to execute/);
  const report = JSON.parse(
    fs.readFileSync(path.join(scratch, 'cases/unregistered.case.json'), 'utf8'),
  );
  expect(report).toMatchObject({
    id: 'unregistered.case',
    area: 'browser',
    status: 'MUST_PRESERVE',
    classificationVerified: false,
  });
  expect(report.failure).toContain('Missing semantic case unregistered.case');
});

test('no harness resolves the browser outside the shared helper', () => {
  // Class-level: a second default or a local fallback must not reappear.
  const tracked = execFileSync(
    'git',
    ['ls-files', '--', 'tools', 'tests/semantic', 'verify-pms.sh'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter((file) => /\.(c?js|mjs|sh)$/.test(file));
  const allowed = new Set([
    'tools/pms/browser.js',
    'tools/pms/__tests__/browser-test.js',
    // The frozen Alpha 1 epoch records the defaults Alpha 1 shipped with.
    'tools/baselines/archive.mjs',
  ]);
  const offenders = [];
  for (const file of tracked) {
    if (allowed.has(file)) continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (
      /PMS_(NEXT_)?CHROMIUM\s*(\?\?|\|\|)/.test(text) ||
      /['"`](\/usr\/local\/bin\/chromium|\/opt\/google\/chrome\/chrome|chromium|google-chrome)['"`]/.test(
        text,
      )
    )
      offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
