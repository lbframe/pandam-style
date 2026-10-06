/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, createServer, preview } from 'vite';

const REPO_ROOT = path.resolve(
  process.env.PMS_PILOT_SOURCE_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const PILOT_SOURCE = path.join(REPO_ROOT, 'examples/pilots/vite-react');

const [appRootArg, reportPathArg] = process.argv.slice(2);
if (appRootArg == null || reportPathArg == null) {
  throw new Error(
    'usage: qualify-vite-node-minimum.mjs <external-app-root> <report.json>',
  );
}

const appRoot = path.resolve(appRootArg);
const reportPath = path.resolve(reportPathArg);
const require = createRequire(path.join(appRoot, 'package.json'));
const report = {
  node: process.version,
  viteVersion: require('vite/package.json').version,
  appRoot,
  steps: [],
};

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function cssAt(port) {
  const response = await fetch(`http://127.0.0.1:${port}/__pandamstyle.css`);
  assert.equal(response.status, 200);
  return {
    content: await response.text(),
    revision: response.headers.get('x-pandamstyle-revision'),
  };
}

async function waitForUpdatedCss(port, prior) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const current = await cssAt(port);
    if (
      current.revision !== prior.revision &&
      digest(current.content) !== digest(prior.content)
    ) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    'minimum Node lane timed out waiting for the edited CSS revision',
  );
}

async function resetQualificationApp() {
  for (const relative of [
    'design.pandamstyle.config.js',
    'src/pages/App.jsx',
    'src/pages/bridge.js',
    'src/pages/forward.js',
  ]) {
    await fs.copyFile(
      path.join(PILOT_SOURCE, relative),
      path.join(appRoot, relative),
    );
  }
  for (const relative of [
    '.pandamstyle',
    '..pandamstyle.pms-state.json',
    'dist',
    'src/pages/Added.jsx',
    'src/pages/SharedA.jsx',
    'src/pages/SharedB.jsx',
    'src/pages/Renamed.jsx',
    'src/pages/missing.js',
    'node_modules/.vite',
  ]) {
    await fs.rm(path.join(appRoot, relative), { recursive: true, force: true });
  }
}

async function main() {
  await resetQualificationApp();
  const devServer = await createServer({
    root: appRoot,
    configFile: path.join(appRoot, 'vite.config.js'),
    logLevel: 'silent',
    clearScreen: false,
    server: { host: '127.0.0.1', port: 0 },
  });

  let port;
  try {
    await devServer.listen();
    port = devServer.httpServer.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-pandamstyle/);
    report.steps.push({ step: 'dev-startup', status: 'passed', port });

    const client =
      await devServer.environments.client.transformRequest(
        '/src/pages/App.jsx',
      );
    const ssr =
      await devServer.environments.ssr.transformRequest('/src/pages/App.jsx');
    assert.ok(client?.code.includes('__pmsProps'));
    assert.ok(ssr?.code.includes('pandamstyle-style-ref'));
    report.steps.push({
      step: 'client-and-ssr-transform',
      status: 'passed',
      clientDigest: digest(client.code),
      ssrDigest: digest(ssr.code),
    });

    const cssBefore = await cssAt(port);
    const sourcePath = path.join(appRoot, 'src/pages/App.jsx');
    const sourceBefore = await fs.readFile(sourcePath, 'utf8');
    const initialGap = sourceBefore.match(/gap: token\('spacing\.([^']+)'\)/);
    assert.ok(initialGap, 'the fixture page must expose an editable gap token');
    const changedGapToken = initialGap[1] === 'md' ? 'lg' : 'md';
    const sourceAfter = sourceBefore.replace(
      initialGap[0],
      `gap: token('spacing.${changedGapToken}')`,
    );
    assert.notEqual(sourceAfter, sourceBefore);
    await fs.writeFile(sourcePath, sourceAfter, 'utf8');
    const cssAfter = await waitForUpdatedCss(port, cssBefore);
    assert.notEqual(digest(cssAfter.content), digest(cssBefore.content));
    assert.ok(cssAfter.revision);
    const clientAfter =
      await devServer.environments.client.transformRequest(
        '/src/pages/App.jsx',
      );
    assert.ok(clientAfter?.code.includes('__pmsProps'));
    report.steps.push({
      step: 'representative-edit-and-css-settlement',
      status: 'passed',
      revisionBefore: cssBefore.revision,
      revisionAfter: cssAfter.revision,
      cssDigestBefore: digest(cssBefore.content),
      cssDigestAfter: digest(cssAfter.content),
    });
  } finally {
    await devServer.close();
  }

  await build({
    root: appRoot,
    configFile: path.join(appRoot, 'vite.config.js'),
    logLevel: 'silent',
  });
  const canonicalCss = await fs.readFile(
    path.join(appRoot, '.pandamstyle/styles.css'),
    'utf8',
  );
  const bundledCss = await fs.readFile(
    path.join(appRoot, 'dist/pandamstyle/styles.css'),
    'utf8',
  );
  assert.equal(bundledCss, canonicalCss);
  report.steps.push({
    step: 'production-build',
    status: 'passed',
    cssDigest: digest(bundledCss),
  });

  const previewServer = await preview({
    root: appRoot,
    configFile: path.join(appRoot, 'vite.config.js'),
    logLevel: 'silent',
    preview: { host: '127.0.0.1', port: 0 },
  });
  try {
    const previewPort = previewServer.httpServer.address().port;
    const response = await fetch(`http://127.0.0.1:${previewPort}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /pandamstyle\/styles\.css/);
    const cssResponse = await fetch(
      `http://127.0.0.1:${previewPort}/pandamstyle/styles.css`,
    );
    assert.equal(cssResponse.status, 200);
    assert.equal(await cssResponse.text(), canonicalCss);
    report.steps.push({
      step: 'built-server-smoke',
      status: 'passed',
      port: previewPort,
      htmlStatus: response.status,
      cssStatus: cssResponse.status,
    });
  } finally {
    await previewServer.close();
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
