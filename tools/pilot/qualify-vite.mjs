/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';

const REPO_ROOT = path.resolve(
  process.env.PMS_PILOT_SOURCE_ROOT ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
);
const PILOT_SOURCE = path.join(REPO_ROOT, 'examples/pilots/vite-react');

const [appRootArg, reportPathArg] = process.argv.slice(2);
if (appRootArg == null || reportPathArg == null) {
  throw new Error('usage: qualify-vite.mjs <external-app-root> <report.json>');
}
const appRoot = path.resolve(appRootArg);
const reportPath = path.resolve(reportPathArg);
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const viteManifest = appRequire('vite/package.json');
const report = {
  node: process.version,
  documentKind: 'pandamstyle-phase-12-vite8-qualification',
  viteVersion: viteManifest.version,
  appRoot,
  dev: [],
  production: [],
  failures: [],
  isolation: {},
  bundles: {},
};

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function read(file) {
  return fs.readFile(path.join(appRoot, file), 'utf8');
}

async function write(file, content) {
  const target = path.join(appRoot, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function invalidGapSource(source) {
  const invalid = source.replace(
    /gap: token\('spacing\.[^']+'\)/,
    "gap: '12px'",
  );
  assert.notEqual(invalid, source, 'the fixture must contain an editable gap');
  return invalid;
}

async function digestTree(root) {
  const result = {};
  async function visit(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(absolute, name);
      else if (entry.isFile())
        result[name] = digest(await fs.readFile(absolute));
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return result;
}

async function canonicalArtifacts(root) {
  const directory = path.join(root, '.pandamstyle');
  const names = [
    'design.pandamstyle.js',
    'design.pandamstyle.d.ts',
    'manifest.json',
    'styles.css',
    'artifacts.json',
  ];
  const entries = {};
  for (const name of names) {
    entries[name] = await fs.readFile(path.join(directory, name), 'utf8');
  }
  return entries;
}

async function buildApp(env = {}) {
  const started = performance.now();
  const previous = new Map(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(env)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    await build({
      root: appRoot,
      configFile: path.join(appRoot, 'vite.config.js'),
      logLevel: 'silent',
      clearScreen: false,
    });
  } finally {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return performance.now() - started;
}

async function runCommitFailureWithLoader() {
  const compilerHost = path.join(
    appRoot,
    'node_modules/@pandamstyle/compiler/lib/host.mjs',
  );
  const target = JSON.stringify(pathToFileURL(compilerHost).href);
  const bridgeSource = [
    `import { createHostBridge as createOriginal } from ${target};`,
    'export function createHostBridge(project) {',
    '  const bridge = createOriginal(project);',
    "  return Object.freeze({ ...bridge, async commitPrepared() { throw new Error('PMS_INJECTED_COMMIT_FAILURE'); } });",
    '}',
  ].join('\n');
  return runHostBridgeLoaderBuild('.commit-failure-loader.mjs', bridgeSource);
}

async function runPreparedMutationWithLoader() {
  const compilerHost = path.join(
    appRoot,
    'node_modules/@pandamstyle/compiler/lib/host.mjs',
  );
  const target = JSON.stringify(pathToFileURL(compilerHost).href);
  const bridgeSource = [
    `import { createHostBridge as createOriginal } from ${target};`,
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    'export function createHostBridge(project) {',
    '  const bridge = createOriginal(project);',
    '  return Object.freeze({ ...bridge, async preparePublication(revision) {',
    '    const ticket = await bridge.preparePublication(revision);',
    '    const current = await project.current();',
    "    const source = await fs.readFile(path.join(current.revision.projectId, 'src/pages/App.jsx'), 'utf8');",
    "    await project.applyChanges({ baseRevision: current.revision, mode: 'watcher', changed: ['src/pages/App.jsx'], added: [], removed: [], renamed: [], sourceOverlays: [{ file: 'src/pages/App.jsx', source: source + '\\n// mutation after publication prepare' }] });",
    "    process.stdout.write('PMS_MUTATED_AFTER_PREPARE\\n');",
    '    return ticket;',
    '  } });',
    '}',
  ].join('\n');
  return runHostBridgeLoaderBuild(
    '.prepared-mutation-loader.mjs',
    bridgeSource,
  );
}

async function runHostBridgeLoaderBuild(filename, bridgeSource) {
  const loaderPath = path.join(appRoot, filename);
  const viteBin = path.join(appRoot, 'node_modules/vite/bin/vite.js');
  const loader = [
    'export async function resolve(specifier, context, nextResolve) {',
    "  if (specifier === '@pandamstyle/compiler/host') return { url: 'pandamstyle-test:host-bridge', shortCircuit: true };",
    '  return nextResolve(specifier, context);',
    '}',
    'export async function load(url, context, nextLoad) {',
    "  if (url !== 'pandamstyle-test:host-bridge') return nextLoad(url, context);",
    `  return { format: 'module', shortCircuit: true, source: ${JSON.stringify(bridgeSource)} };`,
    '}',
  ].join('\n');
  await fs.writeFile(loaderPath, loader, 'utf8');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['--experimental-loader', loaderPath, viteBin, 'build'],
    {
      cwd: appRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PMS_VITE_FAIL_AT: '',
        PMS_VITE_WRITE_FALSE: '',
        PMS_VITE_MULTI_OUTPUT: '',
      },
    },
  );
  await fs.rm(loaderPath, { force: true });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

function nextRevision(events, fromIndex, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = events
        .slice(fromIndex)
        .find(
          (event) =>
            event.type === 'custom' && event.event === 'pandamstyle:revision',
        );
      if (found != null) return resolve(found.data);
      if (Date.now() - started > timeoutMs) {
        return reject(
          new Error('timed out waiting for a Project Service revision event'),
        );
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function nextDiagnostic(events, fromIndex, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = events
        .slice(fromIndex)
        .find(
          (event) =>
            event.type === 'custom' &&
            event.event === 'pandamstyle:diagnostics' &&
            event.data?.ok === false,
        );
      if (found != null) return resolve(found.data);
      if (Date.now() - started > timeoutMs) {
        return reject(
          new Error('timed out waiting for structured PandamStyle diagnostics'),
        );
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function nextTransform(events, fromIndex, file, timeoutMs = 15000) {
  const sequence = (globalThis.__PMS_VITE_TRANSFORM_WAITS__ ?? 0) + 1;
  globalThis.__PMS_VITE_TRANSFORM_WAITS__ = sequence;
  if (process.env.PMS_VITE_QUALIFY_VERBOSE === '1') {
    console.log(`waiting for transform #${sequence}: ${file}`);
  }
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = events
        .slice(fromIndex)
        .find(
          (event) =>
            event.type === 'custom' &&
            event.event === 'pandamstyle:transform' &&
            event.data?.file === file,
        );
      if (found != null) return resolve(found.data);
      if (Date.now() - started > timeoutMs) {
        return reject(
          new Error(
            `timed out waiting for transform #${sequence} (${file}); received ${JSON.stringify(events.slice(fromIndex).map((event) => ({ type: event.type, event: event.event, file: event.data?.file })))}`,
          ),
        );
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function startDevServer(root = appRoot) {
  const started = performance.now();
  const port = await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close((error) =>
        error == null ? resolve(selected) : reject(error),
      );
    });
  });
  const server = await createServer({
    root,
    configFile: path.join(root, 'vite.config.js'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close();
    throw error;
  }
  const address = server.httpServer.address();
  const actualPort =
    typeof address === 'object' && address != null ? address.port : null;
  assert.ok(
    Number.isInteger(actualPort) && actualPort > 0,
    'Vite dev server did not bind an ephemeral port',
  );
  return { server, port: actualPort, readyMs: performance.now() - started };
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

function connectHmr(port, events) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr');
    const timeout = setTimeout(
      () => reject(new Error('Vite HMR websocket did not connect')),
      10000,
    );
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timeout);
        resolve(socket);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
      { once: true },
    );
    socket.addEventListener('message', (event) => {
      try {
        events.push(JSON.parse(String(event.data)));
      } catch {
        events.push({ type: 'unparsed', data: String(event.data) });
      }
    });
  });
}

async function cssResponseAt(port, href = null) {
  const response = await fetch(
    new URL(href ?? '/__pandamstyle.css', `http://127.0.0.1:${port}`),
  );
  assert.equal(
    response.status,
    200,
    'Vite did not serve the PandamStyle CSS route',
  );
  return {
    content: await response.text(),
    revision: response.headers.get('x-pandamstyle-revision'),
  };
}

async function cssAt(port, href = null) {
  return (await cssResponseAt(port, href)).content;
}

async function waitForSettledMessages() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function waitFor(predicate, label, timeoutMs = 10000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sessionIdFromHtml(html) {
  const value = html.match(/__pandamstyle\.css\?pms=([^"&]+)/)?.[1];
  assert.ok(value, 'the PandamStyle stylesheet URL has no revision identity');
  return decodeURIComponent(value).replace(/-\d+$/, '');
}

function sourceMapEvidence(map) {
  if (map == null) return { present: false };
  return {
    present: true,
    version: map.version,
    sources: map.sources ?? [],
    mappingsLength: map.mappings?.length ?? 0,
    allSourcesHaveContent:
      Array.isArray(map.sourcesContent) &&
      map.sourcesContent.every((source) => typeof source === 'string'),
    digest: digest(JSON.stringify(map)),
  };
}

function classifyDelivery(events, fromIndex, cssUpdate = null, outcome = null) {
  const messages = events
    .slice(fromIndex)
    .filter((event) => ['update', 'full-reload'].includes(event.type));
  const updateTypes = messages.flatMap((event) =>
    event.type === 'update'
      ? (event.updates ?? []).map((update) => update.type)
      : [],
  );
  const kinds = new Set();
  if (
    cssUpdate != null ||
    events
      .slice(fromIndex)
      .some(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:css-update',
      )
  )
    kinds.add('pandamstyle_css_update');
  if (updateTypes.includes('css-update')) kinds.add('vite_css_update');
  if (updateTypes.includes('js-update')) kinds.add('module_replacement');
  if (messages.some((event) => event.type === 'full-reload'))
    kinds.add('full_reload');
  if (kinds.size === 0 && outcome === 'diagnostic')
    kinds.add('diagnostic_without_update');
  if (kinds.size === 0 && outcome === 'serialized')
    kinds.add('serialized_revision_settlement');
  return {
    kinds: [...kinds],
    updateTypes,
    statePreservingHmr: 'not_observed_by_websocket_only_harness',
    messages,
  };
}

async function mutateAndRecord({
  port,
  events,
  label,
  mutation,
  checkCss,
  expectedOutcome,
}) {
  const cursor = events.length;
  await mutation();
  const observation = await nextRevision(events, cursor);
  await waitForSettledMessages();
  const cssUpdate =
    observation.outcome === 'diagnostic'
      ? null
      : events
          .slice(cursor)
          .find(
            (event) =>
              event.type === 'custom' &&
              event.event === 'pandamstyle:css-update' &&
              event.data?.revision?.sessionId ===
                observation.revisionAfter.sessionId &&
              event.data?.revision?.revisionId ===
                observation.revisionAfter.revisionId,
          );
  if (observation.outcome !== 'diagnostic') {
    assert.ok(
      cssUpdate,
      `${label} did not publish CSS for its exact Project Service revision`,
    );
  }
  const cssResponse = await cssResponseAt(port, cssUpdate?.data?.href ?? null);
  if (cssUpdate != null) {
    assert.equal(
      cssResponse.revision,
      `${observation.revisionAfter.sessionId}-${observation.revisionAfter.revisionId}`,
      `${label} served CSS for a different revision`,
    );
  }
  const css = cssResponse.content;
  const delivery = classifyDelivery(
    events,
    cursor,
    cssUpdate,
    observation.outcome,
  );
  if (checkCss != null) {
    try {
      checkCss(css);
    } catch (error) {
      console.error(
        JSON.stringify(
          {
            label,
            observation,
            diagnostics: events
              .slice(cursor)
              .filter(
                (event) =>
                  event.type === 'custom' &&
                  event.event === 'pandamstyle:diagnostics',
              ),
          },
          null,
          2,
        ),
      );
      throw error;
    }
  }
  if (expectedOutcome != null)
    assert.equal(observation.outcome, expectedOutcome, `${label} outcome`);
  report.dev.push({
    label,
    revisionBefore: observation.revisionBefore,
    revisionAfter: observation.revisionAfter,
    generationBefore: observation.generationBefore,
    generationAfter: observation.generationAfter,
    invalidatedModules: observation.invalidatedModules,
    mutation: observation.mutation,
    outcome: observation.outcome,
    counters: observation.counters,
    fullFallback: observation.fullFallback,
    fullFallbackReason: observation.fullFallbackReason,
    cssUpdate: cssUpdate?.data ?? null,
    servedCssRevision: cssResponse.revision,
    hostQueueWaitMs: observation.hostQueueWaitMs,
    hostValidationMs: observation.hostValidationMs,
    projectDiagnosticsMs: observation.projectDiagnosticsMs,
    hostCompileMs: observation.hostCompileMs,
    hostCssSettledMs: observation.hostCssSettledMs,
    cssDigest: digest(css),
    delivery,
    hmrMessages: delivery.messages,
  });
  return { observation, css, delivery };
}

async function runDevQualification() {
  const { server, port, readyMs } = await startDevServer();
  const events = [];
  let socket;
  let serverClosed = false;
  let initialSessionId = null;
  try {
    const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /data-pandamstyle/);
    assert.match(html, /html-proxy/);
    initialSessionId = sessionIdFromHtml(html);
    const htmlProxy = await server.environments.client.transformRequest(
      '/index.html?html-proxy&index=0.js',
    );
    assert.ok(
      htmlProxy?.code.includes('pandamstyle:client'),
      'the Vite HTML proxy omitted the PandamStyle HMR client',
    );
    socket = await connectHmr(port, events);
    const clientTransformCursor = events.length;
    const transformStarted = performance.now();
    const transformed =
      await server.environments.client.transformRequest('/src/pages/App.jsx');
    const firstTransformMs = performance.now() - transformStarted;
    assert.ok(
      transformed?.code.includes('__pmsProps'),
      'Vite did not use the compiler-owned module artifact',
    );
    assert.ok(
      transformed.code.includes('jsx-runtime') ||
        transformed.code.includes('const _jsx'),
      'the downstream React transform did not run after PandamStyle',
    );
    const clientArtifact = await nextTransform(
      events,
      clientTransformCursor,
      'src/pages/App.jsx',
    );
    report.dev.push({
      label: 'client environment first transform',
      environment: 'client',
      revision: clientArtifact.revision,
      sourceDigest: clientArtifact.sourceDigest,
      outputDigest: digest(transformed.code),
      sourceMap: sourceMapEvidence(transformed.map),
      pluginOrdering: {
        pandamstyleBeforeReact: true,
        evidence:
          'compiler props import and React JSX runtime binding coexist in the transformed module',
      },
    });
    for (const moduleId of [
      '/src/main.jsx',
      '/src/pages/bridge.js',
      '/src/pages/forward.js',
    ]) {
      const moduleResponse =
        await server.environments.client.transformRequest(moduleId);
      assert.ok(moduleResponse?.code, `Vite did not transform ${moduleId}`);
    }
    const ssrTransformCursor = events.length;
    const ssrTransformed =
      await server.environments.ssr.transformRequest('/src/pages/App.jsx');
    assert.ok(
      ssrTransformed?.code.includes('pandamstyle-style-ref'),
      'the Vite SSR environment did not use the compiler-owned module artifact',
    );
    const ssrArtifact = await nextTransform(
      events,
      ssrTransformCursor,
      'src/pages/App.jsx',
    );
    report.dev.push({
      label: 'SSR environment transform',
      environment: 'ssr',
      revision: ssrArtifact.revision,
      sourceDigest: ssrArtifact.sourceDigest,
      outputDigest: digest(ssrTransformed.code),
      sourceMap: sourceMapEvidence(ssrTransformed.map),
      delivery: {
        kinds: ['ssr_transform'],
        statePreservingHmr: 'not_applicable',
      },
    });
    const initialCss = await cssAt(port);
    assert.match(initialCss, /gap/);
    const oldApp = await read('src/pages/App.jsx');
    const initialGap = oldApp.match(/gap: token\('spacing\.([^']+)'\)/);
    assert.ok(initialGap, 'the fixture page must expose an editable gap token');
    const changedGapToken = initialGap[1] === 'md' ? 'lg' : 'md';
    const afterGap = oldApp.replace(
      initialGap[0],
      `gap: token('spacing.${changedGapToken}')`,
    );
    assert.notEqual(afterGap, oldApp, 'the style edit must change the fixture');

    await mutateAndRecord({
      server,
      port,
      events,
      label: 'one-file style edit and existing atom edit',
      mutation: () => write('src/pages/App.jsx', afterGap),
      checkCss: (css) => assert.notEqual(digest(css), digest(initialCss)),
      expectedOutcome: 'hmr',
    });

    const afterNewAtom = afterGap.replace(
      /gap: token\('spacing\.[^']+'\)/,
      (match) => `${match},\n    rowGap: token('spacing.sm')`,
    );
    assert.notEqual(
      afterNewAtom,
      afterGap,
      'the new atom edit must change the fixture',
    );
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'new atom',
      mutation: () => write('src/pages/App.jsx', afterNewAtom),
      checkCss: (css) => assert.match(css, /row-gap/),
      expectedOutcome: 'hmr',
    });

    const beforeImportEdit = await read('src/pages/App.jsx');
    const importCss = await cssAt(port);
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'import edit',
      mutation: () =>
        write(
          'src/pages/App.jsx',
          beforeImportEdit.replace("from './bridge.js'", "from './forward.js'"),
        ),
      checkCss: (css) => assert.equal(digest(css), digest(importCss)),
      expectedOutcome: 'hmr',
    });
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'import edit restore',
      mutation: () => write('src/pages/App.jsx', beforeImportEdit),
      checkCss: (css) => assert.equal(digest(css), digest(importCss)),
      expectedOutcome: 'hmr',
    });

    const raceSourceBefore = await read('src/pages/App.jsx');
    const raceSourceAfter = raceSourceBefore.replace(
      /rowGap: token\('spacing\.sm'\)/,
      "rowGap: token('spacing.lg')",
    );
    assert.notEqual(raceSourceAfter, raceSourceBefore);
    const raceCursor = events.length;
    globalThis.__PMS_VITE_DELAY_APP_TRANSFORM_ENTERED__ = false;
    const previousDelay = process.env.PMS_VITE_DELAY_APP_TRANSFORM;
    process.env.PMS_VITE_DELAY_APP_TRANSFORM = '1';
    let pendingTransform;
    let racedArtifactPromise;
    try {
      pendingTransform = server.environments.client.transformRequest(
        `/src/pages/App.jsx?phase8-race=${Date.now()}`,
      );
      racedArtifactPromise = nextTransform(
        events,
        raceCursor,
        'src/pages/App.jsx',
      );
      await waitFor(
        () => globalThis.__PMS_VITE_DELAY_APP_TRANSFORM_ENTERED__ === true,
        'the delayed Vite transform hook',
      );
      await write('src/pages/App.jsx', raceSourceAfter);
      await nextRevision(events, raceCursor);
      await pendingTransform;
    } finally {
      if (previousDelay == null)
        delete process.env.PMS_VITE_DELAY_APP_TRANSFORM;
      else process.env.PMS_VITE_DELAY_APP_TRANSFORM = previousDelay;
    }
    await waitForSettledMessages();
    const racedArtifact = await racedArtifactPromise;
    assert.ok(
      racedArtifact?.revision,
      'the Vite transform omitted its revision',
    );
    assert.ok(
      [digest(raceSourceBefore), digest(raceSourceAfter)].includes(
        racedArtifact.sourceDigest,
      ),
      'the Vite transform used source outside the serialized edit pair',
    );
    const racedCssHref = `/__pandamstyle.css?pms=${encodeURIComponent(`${racedArtifact.revision.sessionId}-${racedArtifact.revision.revisionId}`)}`;
    const racedCss = await cssResponseAt(port, racedCssHref);
    assert.equal(
      racedCss.revision,
      `${racedArtifact.revision.sessionId}-${racedArtifact.revision.revisionId}`,
      'the in-flight transform was paired with CSS from another revision',
    );

    const settledTransformCursor = events.length;
    await server.environments.client.transformRequest(
      `/src/pages/App.jsx?phase8-race-settled=${Date.now()}`,
    );
    const settledTransform = await nextTransform(
      events,
      settledTransformCursor,
      'src/pages/App.jsx',
    );
    assert.equal(
      settledTransform.sourceDigest,
      digest(raceSourceAfter),
      'a settled transform did not use the final filesystem source',
    );
    const settledRevision = settledTransform.revision;
    const settledCss = await cssResponseAt(
      port,
      `/__pandamstyle.css?pms=${encodeURIComponent(`${settledRevision.sessionId}-${settledRevision.revisionId}`)}`,
    );
    assert.equal(
      settledCss.revision,
      `${settledRevision.sessionId}-${settledRevision.revisionId}`,
    );
    report.dev.push({
      label: 'watcher edit while transform is pending',
      revisionBefore: null,
      revisionAfter: settledRevision,
      transformRevision: racedArtifact.revision,
      transformedSourceDigest: racedArtifact.sourceDigest,
      expectedSourceDigests: [
        digest(raceSourceBefore),
        digest(raceSourceAfter),
      ],
      servedCssRevision: racedCss.revision,
      settledSourceDigest: settledTransform.sourceDigest,
      settledCssRevision: settledCss.revision,
      revisionEvents: events
        .slice(raceCursor)
        .filter(
          (event) =>
            event.type === 'custom' && event.event === 'pandamstyle:revision',
        )
        .map((event) => event.data),
      outcome: 'serialized',
      delivery: classifyDelivery(events, raceCursor, null, 'serialized'),
    });

    const burstBase = await read('src/pages/App.jsx');
    const burstSources = ['md', 'sm', 'zero'].map((tokenName) =>
      burstBase.replace(
        /rowGap: token\('spacing\.(?:sm|md|lg|zero)'\)/,
        `rowGap: token('spacing.${tokenName}')`,
      ),
    );
    assert.ok(burstSources.every((source) => source !== burstBase));
    const burstCursor = events.length;
    for (const source of burstSources) {
      await write('src/pages/App.jsx', source);
    }
    await nextRevision(events, burstCursor);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const burstObservations = events
      .slice(burstCursor)
      .filter(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:revision',
      )
      .map((event) => event.data);
    assert.ok(burstObservations.length > 0);
    for (let index = 1; index < burstObservations.length; index += 1) {
      assert.ok(
        burstObservations[index].revisionAfter.revisionId >
          burstObservations[index - 1].revisionAfter.revisionId,
        'rapid edits produced non-monotonic Project Service revisions',
      );
    }
    const burstTransformCursor = events.length;
    await server.environments.client.transformRequest(
      `/src/pages/App.jsx?phase8-burst=${Date.now()}`,
    );
    const burstTransform = await nextTransform(
      events,
      burstTransformCursor,
      'src/pages/App.jsx',
    );
    assert.equal(
      burstTransform.sourceDigest,
      digest(burstSources[burstSources.length - 1]),
      'rapid edit burst did not settle on the final source',
    );
    const burstRevision = burstTransform.revision;
    const burstCss = await cssResponseAt(
      port,
      `/__pandamstyle.css?pms=${encodeURIComponent(`${burstRevision.sessionId}-${burstRevision.revisionId}`)}`,
    );
    assert.equal(
      burstCss.revision,
      `${burstRevision.sessionId}-${burstRevision.revisionId}`,
    );
    assert.match(burstCss.content, /row-gap:var\(--[a-z0-9]+\)/);
    report.dev.push({
      label: 'rapid edit burst',
      revisions: burstObservations.map((observation) => ({
        revisionBefore: observation.revisionBefore,
        revisionAfter: observation.revisionAfter,
        generationBefore: observation.generationBefore,
        generationAfter: observation.generationAfter,
        outcome: observation.outcome,
        counters: observation.counters,
        fullFallback: observation.fullFallback,
      })),
      finalSourceDigest: burstTransform.sourceDigest,
      finalCssRevision: burstCss.revision,
      finalCssDigest: digest(burstCss.content),
      delivery: classifyDelivery(events, burstCursor, null, 'hmr'),
    });

    const addedFile = [
      "import { create, token } from './bridge.js';",
      "export const added = create({ added: { marginRight: token('spacing.sm') } });",
      '',
    ].join('\n');
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'module add',
      mutation: () => write('src/pages/Added.jsx', addedFile),
      checkCss: (css) => assert.match(css, /margin-right/),
      expectedOutcome: 'full-reload',
    });

    const sharedOwnerSource = [
      "import { create, token } from './bridge.js';",
      "export const shared = create({ shared: { paddingInline: token('spacing.sm') } });",
      '',
    ].join('\n');
    const sharedRuleCount = (css) => css.match(/padding-inline:/g)?.length ?? 0;
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'shared rule owner A added',
      mutation: () => write('src/pages/SharedA.jsx', sharedOwnerSource),
      checkCss: (css) => assert.equal(sharedRuleCount(css), 1),
      expectedOutcome: 'full-reload',
    });
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'shared rule owner B added',
      mutation: () => write('src/pages/SharedB.jsx', sharedOwnerSource),
      checkCss: (css) => assert.equal(sharedRuleCount(css), 1),
      expectedOutcome: 'full-reload',
    });
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'shared rule owner A removed',
      mutation: () => fs.rm(path.join(appRoot, 'src/pages/SharedA.jsx')),
      checkCss: (css) => assert.equal(sharedRuleCount(css), 1),
      expectedOutcome: 'full-reload',
    });
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'last shared rule owner removed',
      mutation: () => fs.rm(path.join(appRoot, 'src/pages/SharedB.jsx')),
      checkCss: (css) => assert.equal(sharedRuleCount(css), 0),
      expectedOutcome: 'full-reload',
    });

    const appBeforeDependentRename = await read('src/pages/App.jsx');
    const appWithAddedImport = `import { added } from './Added.jsx';\n${appBeforeDependentRename}`;
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'dependent module import added',
      mutation: () => write('src/pages/App.jsx', appWithAddedImport),
      checkCss: (css) => assert.match(css, /margin-right/),
      expectedOutcome: 'hmr',
    });
    const appWithRenamedImport = appWithAddedImport.replace(
      './Added.jsx',
      './Renamed.jsx',
    );
    const renameCursor = events.length;
    await Promise.all([
      fs.rename(
        path.join(appRoot, 'src/pages/Added.jsx'),
        path.join(appRoot, 'src/pages/Renamed.jsx'),
      ),
      write('src/pages/App.jsx', appWithRenamedImport),
    ]);
    try {
      await waitFor(
        () =>
          events
            .slice(renameCursor)
            .some(
              (event) =>
                event.type === 'custom' &&
                event.event === 'pandamstyle:revision' &&
                event.data?.mutation?.renamed?.some(
                  (move) =>
                    move.from === 'src/pages/Added.jsx' &&
                    move.to === 'src/pages/Renamed.jsx',
                ),
            ),
        'the paired rename mutation and dependent edit',
      );
    } catch (error) {
      console.error(
        'rename race events:',
        JSON.stringify(events.slice(renameCursor)),
      );
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    const renameObservations = events
      .slice(renameCursor)
      .filter(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:revision',
      )
      .map((event) => event.data);
    const renameObservation = renameObservations.find((observation) =>
      observation.mutation?.renamed?.some(
        (move) =>
          move.from === 'src/pages/Added.jsx' &&
          move.to === 'src/pages/Renamed.jsx',
      ),
    );
    assert.ok(renameObservation);
    const renamedTransformCursor = events.length;
    await server.environments.client.transformRequest(
      `/src/pages/App.jsx?phase8-rename=${Date.now()}`,
    );
    const renamedDependentTransform = await nextTransform(
      events,
      renamedTransformCursor,
      'src/pages/App.jsx',
    );
    assert.equal(
      renamedDependentTransform.sourceDigest,
      digest(appWithRenamedImport),
      'the dependent module did not settle on its renamed import',
    );
    const renamedRevision = renamedDependentTransform.revision;
    const renamedCss = await cssResponseAt(
      port,
      `/__pandamstyle.css?pms=${encodeURIComponent(`${renamedRevision.sessionId}-${renamedRevision.revisionId}`)}`,
    );
    assert.equal(
      renamedCss.revision,
      `${renamedRevision.sessionId}-${renamedRevision.revisionId}`,
    );
    assert.match(renamedCss.content, /margin-right/);
    report.dev.push({
      label: 'module rename with dependent import edit',
      revisions: renameObservations,
      finalTransformRevision: renamedRevision,
      finalSourceDigest: renamedDependentTransform.sourceDigest,
      finalCssRevision: renamedCss.revision,
      outcome: 'serialized',
      delivery: classifyDelivery(events, renameCursor, null, 'serialized'),
    });

    await mutateAndRecord({
      server,
      port,
      events,
      label: 'dependent import restore',
      mutation: () => write('src/pages/App.jsx', appBeforeDependentRename),
      checkCss: (css) => assert.match(css, /margin-right/),
      expectedOutcome: 'hmr',
    });

    await mutateAndRecord({
      server,
      port,
      events,
      label: 'module delete',
      mutation: () => fs.rm(path.join(appRoot, 'src/pages/Renamed.jsx')),
      checkCss: (css) => assert.doesNotMatch(css, /margin-right/),
      expectedOutcome: 'full-reload',
    });

    const appBeforeInvalid = await read('src/pages/App.jsx');
    const validCss = await cssAt(port);
    const validArtifacts = await digestTree(path.join(appRoot, '.pandamstyle'));
    const invalidCursor = events.length;
    const lastValidCssUpdate = events
      .slice(0, invalidCursor)
      .filter(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:css-update',
      )
      .at(-1);
    assert.ok(lastValidCssUpdate);
    await write('src/pages/App.jsx', invalidGapSource(appBeforeInvalid));
    const invalidDiagnostics = await nextDiagnostic(events, invalidCursor);
    const invalidObservation = await nextRevision(events, invalidCursor);
    await waitForSettledMessages();
    assert.equal(
      invalidDiagnostics.documentKind,
      'pandamstyle-diagnostics-result',
    );
    assert.equal(invalidDiagnostics.schemaVersion, 1);
    assert.equal(invalidDiagnostics.ok, false);
    assert.ok(invalidDiagnostics.diagnostics.length > 0);
    assert.equal(invalidObservation.outcome, 'diagnostic');
    assert.equal(
      invalidObservation.generationAfter,
      invalidObservation.generationBefore,
    );
    assert.equal(
      await cssAt(port),
      validCss,
      'invalid revision changed the served CSS',
    );
    assert.equal(
      await cssAt(port, lastValidCssUpdate.data.href),
      validCss,
      'the exact last valid CSS revision was not retained after an invalid edit',
    );
    assert.equal(
      events
        .slice(invalidCursor)
        .some(
          (event) =>
            event.type === 'custom' && event.event === 'pandamstyle:css-update',
        ),
      false,
      'an invalid revision published a CSS update',
    );
    assert.deepEqual(
      await digestTree(path.join(appRoot, '.pandamstyle')),
      validArtifacts,
      'invalid revision changed canonical artifacts',
    );
    report.dev.push({
      label: 'invalid diagnostic no-publication',
      revisionBefore: invalidObservation.revisionBefore,
      revisionAfter: invalidObservation.revisionAfter,
      generationBefore: invalidObservation.generationBefore,
      generationAfter: invalidObservation.generationAfter,
      outcome: invalidObservation.outcome,
      delivery: classifyDelivery(
        events,
        invalidCursor,
        null,
        invalidObservation.outcome,
      ),
      diagnostics: invalidDiagnostics,
      cssDigest: digest(validCss),
    });

    await mutateAndRecord({
      server,
      port,
      events,
      label: 'invalid to repair',
      mutation: () => write('src/pages/App.jsx', appBeforeInvalid),
      checkCss: (css) => assert.equal(digest(css), digest(validCss)),
      expectedOutcome: 'hmr',
    });

    const originalBridge = await read('src/pages/bridge.js');
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'named re-export to star re-export',
      mutation: () =>
        write('src/pages/bridge.js', "export * from './forward.js';\n"),
      checkCss: (css) => assert.match(css, /gap/),
    });
    await mutateAndRecord({
      server,
      port,
      events,
      label: 'unresolved import diagnostic',
      mutation: () =>
        write('src/pages/forward.js', "export * from './missing.js';\n"),
      expectedOutcome: 'diagnostic',
    });
    const bridgeRestoreCursor = events.length;
    await write('src/pages/bridge.js', originalBridge);
    const bridgeRestore = await nextRevision(events, bridgeRestoreCursor);
    await waitForSettledMessages();
    assert.equal(bridgeRestore.outcome, 'diagnostic');
    const resolvedNegativeImport = await mutateAndRecord({
      server,
      port,
      events,
      label: 'previously unresolved import becomes resolvable after module add',
      mutation: () =>
        write(
          'src/pages/missing.js',
          "export * from '../../.pandamstyle/design.pandamstyle.js';\n",
        ),
      checkCss: (css) => assert.match(css, /gap/),
      expectedOutcome: 'full-reload',
    });
    assert.ok(
      resolvedNegativeImport.observation.counters
        .negativeResolutionsInvalidated > 0,
      'adding the missing target did not invalidate the negative resolution',
    );
    report.dev.push({
      label: 'unresolved import repaired by adding its target module',
      revisionBefore: resolvedNegativeImport.observation.revisionBefore,
      revisionAfter: resolvedNegativeImport.observation.revisionAfter,
      generationBefore: resolvedNegativeImport.observation.generationBefore,
      generationAfter: resolvedNegativeImport.observation.generationAfter,
      outcome: resolvedNegativeImport.observation.outcome,
      delivery: resolvedNegativeImport.delivery,
      counters: resolvedNegativeImport.observation.counters,
      fullFallback: resolvedNegativeImport.observation.fullFallback,
    });

    const definitionPath = path.join(appRoot, 'design.pandamstyle.config.js');
    const definitionBefore = await fs.readFile(definitionPath, 'utf8');
    let currentDefinition = definitionBefore;
    const changeDefinition = async (
      label,
      replace,
      { expectIdentityChange = true } = {},
    ) => {
      const nextDefinition = replace(currentDefinition);
      assert.notEqual(
        nextDefinition,
        currentDefinition,
        `${label} did not alter the definition fixture`,
      );
      const cssBefore = await cssAt(port);
      const designDigestBefore = JSON.parse(
        await read('.pandamstyle/manifest.json'),
      ).registryDigest;
      const cursor = events.length;
      await fs.writeFile(definitionPath, nextDefinition, 'utf8');
      const observation = await nextRevision(events, cursor);
      await waitForSettledMessages();
      const designDigestAfter = JSON.parse(
        await read('.pandamstyle/manifest.json'),
      ).registryDigest;
      const css = await cssAt(port);
      if (expectIdentityChange) {
        assert.notEqual(
          designDigestAfter,
          designDigestBefore,
          `${label} did not update the registry identity`,
        );
      } else {
        assert.notEqual(
          digest(css),
          digest(cssBefore),
          `${label} did not update canonical CSS`,
        );
      }
      assert.equal(observation.outcome, 'full-reload');
      assert.equal(
        observation.revisionAfter.revisionId,
        observation.revisionBefore.revisionId + 1,
      );
      assert.equal(
        observation.generationAfter,
        observation.generationBefore + 1,
      );
      assert.equal(observation.fullFallbackReason, null);
      assert.equal(observation.counters.fullFallback, 0);
      assert.equal(
        events
          .slice(cursor)
          .filter(
            (event) =>
              event.type === 'custom' && event.event === 'pandamstyle:revision',
          ).length,
        1,
      );
      const canonical = await canonicalArtifacts(appRoot);
      const metadata = JSON.parse(canonical['artifacts.json']);
      for (const item of Object.values(metadata.artifacts)) {
        assert.equal(digest(canonical[item.file]), item.sha256);
        assert.equal(Buffer.byteLength(canonical[item.file]), item.bytes);
      }
      report.dev.push({
        label,
        revisionBefore: observation.revisionBefore,
        revisionAfter: observation.revisionAfter,
        generationBefore: observation.generationBefore,
        generationAfter: observation.generationAfter,
        outcome: observation.outcome,
        registryDigestBefore: designDigestBefore,
        registryDigestAfter: designDigestAfter,
        fullFallback: observation.fullFallback,
        fullFallbackReason: observation.fullFallbackReason,
        counters: observation.counters,
        hostQueueWaitMs: observation.hostQueueWaitMs,
        hostValidationMs: observation.hostValidationMs,
        projectDiagnosticsMs: observation.projectDiagnosticsMs,
        hostCompileMs: observation.hostCompileMs,
        cssDigest: digest(css),
        hostCssSettledMs: observation.hostCssSettledMs,
        delivery: classifyDelivery(events, cursor, null, observation.outcome),
      });
      currentDefinition = nextDefinition;
    };

    await changeDefinition('design system token value change', (source) =>
      source.replace("sm: { value: '8px'", "sm: { value: '10px'"),
    );
    await changeDefinition('semantic-token alias change', (source) =>
      source.replace(
        "base: { ref: 'colors.slate100', visibility: 'public' }",
        "base: { ref: 'colors.slate900', visibility: 'public' }",
      ),
    );
    await changeDefinition('theme change', (source) =>
      source.replace(
        "base: { ref: 'colors.slate900' }",
        "base: { ref: 'colors.slate100' }",
      ),
    );
    await changeDefinition('condition change', (source) =>
      source.replace("hover: ':is(:hover, [data-hover])'", "hover: ':hover'"),
    );
    await changeDefinition('media condition change', (source) =>
      source.replace(
        "wide: '@media (min-width: 768px)'",
        "wide: '@media (min-width: 900px)'",
      ),
    );
    await changeDefinition(
      'recipe value change',
      (source) =>
        source.replace(
          "md: { fontSize: token('fontSizes.md'), padding: token('spacing.md') }",
          "md: { fontSize: token('fontSizes.md'), marginLeft: token('spacing.zero') }",
        ),
      { expectIdentityChange: false },
    );
    await changeDefinition('recipe variant domain change', (source) =>
      source.replace(
        "md: { fontSize: token('fontSizes.md'), marginLeft: token('spacing.zero') },",
        "md: { fontSize: token('fontSizes.md'), marginLeft: token('spacing.zero') },\n          lg: { fontSize: token('fontSizes.md'), padding: token('spacing.lg') },",
      ),
    );

    await fs.writeFile(definitionPath, definitionBefore, 'utf8');
    const restoreCursor = events.length;
    const restoredDesign = await nextRevision(events, restoreCursor);
    await waitForSettledMessages();
    assert.equal(restoredDesign.outcome, 'full-reload');
    report.dev.push({
      label: 'design-system definition restored',
      revisionBefore: restoredDesign.revisionBefore,
      revisionAfter: restoredDesign.revisionAfter,
      outcome: restoredDesign.outcome,
      delivery: classifyDelivery(
        events,
        restoreCursor,
        null,
        restoredDesign.outcome,
      ),
    });

    globalThis.__PMS_VITE_DELAY_APP_TRANSFORM_ENTERED__ = false;
    const previousCloseDelay = process.env.PMS_VITE_DELAY_APP_TRANSFORM;
    process.env.PMS_VITE_DELAY_APP_TRANSFORM = '1';
    let closingTransform;
    let closeResults;
    const closeStarted = performance.now();
    const closeCursor = events.length;
    try {
      closingTransform = server.environments.client.transformRequest(
        `/src/pages/App.jsx?phase8-close-pending=${Date.now()}`,
      );
      await waitFor(
        () => globalThis.__PMS_VITE_DELAY_APP_TRANSFORM_ENTERED__ === true,
        'the delayed Vite transform before server close',
      );
      closeResults = await Promise.allSettled([
        closingTransform,
        server.close(),
      ]);
      serverClosed = true;
    } finally {
      if (previousCloseDelay == null)
        delete process.env.PMS_VITE_DELAY_APP_TRANSFORM;
      else process.env.PMS_VITE_DELAY_APP_TRANSFORM = previousCloseDelay;
    }
    assert.equal(closeResults[1].status, 'fulfilled');
    let closeSettlement;
    if (closeResults[0].status === 'fulfilled') {
      const closeArtifact = await nextTransform(
        events,
        closeCursor,
        'src/pages/App.jsx',
        1000,
      );
      closeSettlement = {
        result: 'completed-before-close',
        revision: closeArtifact.revision,
        sourceDigest: closeArtifact.sourceDigest,
      };
    } else {
      const failure = closeResults[0].reason;
      assert.match(
        `${failure?.code ?? ''} ${failure?.message ?? failure}`,
        /SESSION_CLOSED|ERR_CLOSED_SERVER|closing or closed/i,
        `a transform pending at close did not reject deterministically: ${failure?.code ?? ''} ${failure?.message ?? failure}`,
      );
      closeSettlement = {
        result: 'rejected-closed',
        code: failure?.code ?? null,
        message: failure?.message ?? String(failure),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      events
        .slice(closeCursor)
        .some(
          (event) =>
            event.type === 'custom' &&
            ['pandamstyle:revision', 'pandamstyle:css-update'].includes(
              event.event,
            ),
        ),
      false,
      'the closed Project Service continued emitting revision or CSS events',
    );
    report.dev.push({
      label: 'server close with transform pending',
      settlement: closeSettlement,
      elapsedMs: performance.now() - closeStarted,
      postCloseProjectEvents: 0,
      delivery: {
        kinds: ['server_close'],
        statePreservingHmr: 'not_applicable',
      },
    });

    report.devSummary = {
      coldDevServerReadyMs: readyMs,
      firstTransformMs,
      initialCssDigest: digest(initialCss),
      matrixRows: report.dev.length,
      revisionEvents: events.filter(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:revision',
      ).length,
      hmrUpdates: events.filter((event) => event.type === 'update').length,
      fullReloads: events.filter((event) => event.type === 'full-reload')
        .length,
      pandamstyleCssUpdates: events.filter(
        (event) =>
          event.type === 'custom' && event.event === 'pandamstyle:css-update',
      ).length,
      browserStatePreservationObserved: false,
    };
  } finally {
    socket?.close();
    if (!serverClosed) await server.close();
  }
  return initialSessionId;
}

async function runCloseReopen(previousSessionId) {
  const { server, port, readyMs } = await startDevServer();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const nextSessionId = sessionIdFromHtml(await response.text());
    assert.notEqual(
      nextSessionId,
      previousSessionId,
      'close/reopen reused a session identity',
    );
    const transformed =
      await server.environments.client.transformRequest('/src/pages/App.jsx');
    assert.ok(transformed?.code.includes('__pmsProps'));
    const css = await cssAt(port);
    assert.match(css, /gap/);
    report.dev.push({
      label: 'close and reopen',
      sessionIdBefore: previousSessionId,
      sessionIdAfter: nextSessionId,
      coldDevServerReadyMs: readyMs,
      cssDigest: digest(css),
      delivery: {
        kinds: ['fresh_server_instance_after_close'],
        statePreservingHmr: 'not_applicable',
      },
    });
  } finally {
    await server.close();
  }
}

async function runServerRestart() {
  const { server, port, readyMs } = await startDevServer();
  try {
    const initialResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(initialResponse.status, 200);
    const sessionIdBefore = sessionIdFromHtml(await initialResponse.text());
    const initialTransform =
      await server.environments.client.transformRequest('/src/pages/App.jsx');
    assert.ok(initialTransform?.code.includes('__pmsProps'));

    globalThis.__PMS_VITE_CLOSE_SERVER_REASONS__ = [];
    const restartStarted = performance.now();
    await server.restart();
    await waitFor(
      () => server.httpServer?.listening === true,
      'Vite server restart to listen again',
    );
    const restartedResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(restartedResponse.status, 200);
    const sessionIdAfter = sessionIdFromHtml(await restartedResponse.text());
    assert.equal(
      sessionIdAfter,
      sessionIdBefore,
      'Vite server restart unexpectedly replaced the active Project Service session',
    );
    const transformed =
      await server.environments.client.transformRequest('/src/pages/App.jsx');
    assert.ok(transformed?.code.includes('__pmsProps'));
    const css = await cssAt(port);
    assert.match(css, /gap/);
    report.dev.push({
      label: 'Vite server restart',
      sessionIdBefore,
      sessionIdAfter,
      coldDevServerReadyMs: readyMs,
      restartMs: performance.now() - restartStarted,
      closeServerReasons: globalThis.__PMS_VITE_CLOSE_SERVER_REASONS__,
      cssDigest: digest(css),
      delivery: {
        kinds: ['server_restart', 'existing_project_service_session_reused'],
        statePreservingHmr: 'not_applicable',
      },
    });
  } finally {
    await server.close();
  }
}

async function runIsolationQualification() {
  const secondRoot = path.resolve(
    appRoot,
    '..',
    `${path.basename(appRoot)}-isolation`,
  );
  await fs.rm(secondRoot, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  await fs.mkdir(secondRoot, { recursive: true });
  await fs.cp(path.join(appRoot, 'src'), path.join(secondRoot, 'src'), {
    recursive: true,
  });
  for (const file of [
    'index.html',
    'vite.config.js',
    'design.pandamstyle.config.js',
    'package.json',
  ]) {
    await fs.copyFile(path.join(appRoot, file), path.join(secondRoot, file));
  }
  await fs.symlink(
    path.join(appRoot, 'node_modules'),
    path.join(secondRoot, 'node_modules'),
    'dir',
  );
  const secondDefinition = path.join(
    secondRoot,
    'design.pandamstyle.config.js',
  );
  const secondSource = await fs.readFile(secondDefinition, 'utf8');
  const changedSource = secondSource.replace(
    "sm: { value: '8px'",
    "sm: { value: '11px'",
  );
  assert.notEqual(changedSource, secondSource);
  await fs.writeFile(secondDefinition, changedSource, 'utf8');

  const first = await startDevServer(appRoot);
  const second = await startDevServer(secondRoot);
  const firstEvents = [];
  const secondEvents = [];
  let firstSocket;
  let secondSocket;
  try {
    firstSocket = await connectHmr(first.port, firstEvents);
    secondSocket = await connectHmr(second.port, secondEvents);
    for (const [server, root] of [
      [first.server, appRoot],
      [second.server, secondRoot],
    ]) {
      const transformed =
        await server.environments.client.transformRequest('/src/pages/App.jsx');
      assert.ok(transformed?.code.includes('__pmsProps'));
      assert.ok(await fs.stat(path.join(root, 'src/pages/App.jsx')));
    }
    const firstManifest = JSON.parse(
      await fs.readFile(
        path.join(appRoot, '.pandamstyle/manifest.json'),
        'utf8',
      ),
    );
    const secondManifest = JSON.parse(
      await fs.readFile(
        path.join(secondRoot, '.pandamstyle/manifest.json'),
        'utf8',
      ),
    );
    assert.equal(firstManifest.systemId, secondManifest.systemId);
    assert.notEqual(
      firstManifest.registryDigest,
      secondManifest.registryDigest,
    );
    const firstCss = await cssAt(first.port);
    const secondCss = await cssAt(second.port);
    assert.notEqual(digest(firstCss), digest(secondCss));

    const validApp = await read('src/pages/App.jsx');
    const validFirstCss = firstCss;
    const validSecondCss = secondCss;
    const invalidCursor = firstEvents.length;
    const secondCursor = secondEvents.length;
    await write('src/pages/App.jsx', invalidGapSource(validApp));
    const diagnostics = await nextDiagnostic(firstEvents, invalidCursor);
    const invalidObservation = await nextRevision(firstEvents, invalidCursor);
    await waitForSettledMessages();
    assert.equal(diagnostics.documentKind, 'pandamstyle-diagnostics-result');
    assert.equal(invalidObservation.outcome, 'diagnostic');
    assert.equal(await cssAt(first.port), validFirstCss);
    assert.equal(await cssAt(second.port), validSecondCss);
    assert.equal(
      secondEvents
        .slice(secondCursor)
        .filter(
          (event) =>
            event.type === 'custom' && event.event === 'pandamstyle:revision',
        ).length,
      0,
    );

    const repairCursor = firstEvents.length;
    await write('src/pages/App.jsx', validApp);
    const repaired = await nextRevision(firstEvents, repairCursor);
    await waitForSettledMessages();
    assert.equal(repaired.outcome, 'hmr');
    assert.equal(await cssAt(second.port), validSecondCss);
    report.isolation = {
      roots: [appRoot, secondRoot],
      sameRelativeModule: 'src/pages/App.jsx',
      systemId: firstManifest.systemId,
      registryDigests: [
        firstManifest.registryDigest,
        secondManifest.registryDigest,
      ],
      cssDigests: [digest(validFirstCss), digest(validSecondCss)],
      invalidDiagnosticSession: diagnostics.revision.sessionId,
      invalidRevision: invalidObservation.revisionAfter,
      repairedRevision: repaired.revisionAfter,
      project2EventsDuringProject1Invalidation: secondEvents
        .slice(secondCursor)
        .filter((event) => event.type === 'custom'),
    };
  } finally {
    firstSocket?.close();
    secondSocket?.close();
    await Promise.all([first.server.close(), second.server.close()]);
    await fs.rm(secondRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function runProductionQualification() {
  const firstBuildMs = await buildApp();
  const firstArtifacts = await canonicalArtifacts(appRoot);
  const firstArtifactDigests = Object.fromEntries(
    Object.entries(firstArtifacts).map(([name, content]) => [
      name,
      digest(content),
    ]),
  );
  const firstCss = await fs.readFile(
    path.join(appRoot, 'dist/pandamstyle/styles.css'),
    'utf8',
  );
  assert.equal(
    firstCss,
    firstArtifacts['styles.css'],
    'the bundle CSS differs from the canonical compiler artifact',
  );
  const firstHtml = await fs.readFile(
    path.join(appRoot, 'dist/index.html'),
    'utf8',
  );
  assert.match(firstHtml, /pandamstyle\/styles\.css/);
  assert.ok(firstCss.length > 0);
  const firstBundleFiles = await digestTree(path.join(appRoot, 'dist'));

  const repeatBuildMs = await buildApp();
  const repeatedArtifacts = await canonicalArtifacts(appRoot);
  const repeatedArtifactDigests = Object.fromEntries(
    Object.entries(repeatedArtifacts).map(([name, content]) => [
      name,
      digest(content),
    ]),
  );
  assert.deepEqual(
    repeatedArtifactDigests,
    firstArtifactDigests,
    'repeated build changed canonical artifact bytes',
  );
  assert.deepEqual(
    await digestTree(path.join(appRoot, 'dist')),
    firstBundleFiles,
    'repeated build changed emitted bytes',
  );

  const definitionPath = path.join(appRoot, 'design.pandamstyle.config.js');
  const definition = await fs.readFile(definitionPath, 'utf8');
  const changedDefinition = definition.replace(
    "sm: { value: '8px'",
    "sm: { value: '13px'",
  );
  assert.notEqual(changedDefinition, definition);
  await fs.writeFile(definitionPath, changedDefinition, 'utf8');
  const changedBuildMs = await buildApp();
  const changedArtifacts = await canonicalArtifacts(appRoot);
  const changedCss = await fs.readFile(
    path.join(appRoot, 'dist/pandamstyle/styles.css'),
    'utf8',
  );
  assert.notEqual(
    digest(changedArtifacts['manifest.json']),
    firstArtifactDigests['manifest.json'],
  );
  assert.notEqual(digest(changedCss), digest(firstCss));

  const bundleFiles = Object.keys(
    await digestTree(path.join(appRoot, 'dist')),
  ).filter((file) => file.endsWith('.js'));
  const forbidden = [];
  for (const file of bundleFiles) {
    const contents = await fs.readFile(
      path.join(appRoot, 'dist', file),
      'utf8',
    );
    if (
      /@pandamstyle\/(?:compiler|vite|next|rsbuild)|@babel\/|@stylexjs\/|@pandacss\/|['"]node:[a-z]/.test(
        contents,
      )
    )
      forbidden.push(file);
  }
  assert.deepEqual(
    forbidden,
    [],
    'browser bundle contains compiler, adapter, or Node runtime imports',
  );
  report.bundles = { javascriptFiles: bundleFiles, forbiddenFiles: forbidden };
  report.production.push(
    {
      label: 'clean build',
      hostBuildMs: firstBuildMs,
      artifactDigests: firstArtifactDigests,
      cssDigest: digest(firstCss),
    },
    {
      label: 'repeated byte-identical build',
      hostBuildMs: repeatBuildMs,
      artifactDigests: repeatedArtifactDigests,
    },
    {
      label: 'changed build',
      hostBuildMs: changedBuildMs,
      cssDigest: digest(changedCss),
      artifactDigests: Object.fromEntries(
        Object.entries(changedArtifacts).map(([name, content]) => [
          name,
          digest(content),
        ]),
      ),
    },
  );

  await fs.writeFile(definitionPath, definition, 'utf8');
  const baselineBuildMs = await buildApp();
  const baselineArtifacts = await canonicalArtifacts(appRoot);
  const baselineDigests = Object.fromEntries(
    Object.entries(baselineArtifacts).map(([name, content]) => [
      name,
      digest(content),
    ]),
  );
  assert.equal(
    JSON.parse(baselineArtifacts['manifest.json']).registryDigest,
    JSON.parse(firstArtifacts['manifest.json']).registryDigest,
  );
  assert.equal(baselineArtifacts['styles.css'], firstArtifacts['styles.css']);

  const validApp = await read('src/pages/App.jsx');
  const beforeFailures = await digestTree(path.join(appRoot, '.pandamstyle'));
  const expectedFailureBuild = async (
    label,
    operation,
    expectedText = null,
  ) => {
    let failed = false;
    try {
      await operation();
    } catch (error) {
      failed = true;
      const message = String(error.message ?? error);
      if (expectedText != null)
        assert.ok(
          message.includes(expectedText),
          `${label} reported an unexpected failure: ${message}`,
        );
      report.failures.push({ point: label, message });
    }
    assert.ok(failed, `${label} did not fail the Vite build`);
    assert.deepEqual(
      await digestTree(path.join(appRoot, '.pandamstyle')),
      beforeFailures,
      `${label} changed the committed generation`,
    );
  };

  await write('src/pages/App.jsx', invalidGapSource(validApp));
  await expectedFailureBuild('invalid-source-before-transform', () =>
    buildApp(),
  );
  await write('src/pages/App.jsx', validApp);

  for (const failurePoint of [
    'transform',
    'renderStart',
    'generateBundle',
    'writeBundle',
  ]) {
    await expectedFailureBuild(
      failurePoint,
      () => buildApp({ PMS_VITE_FAIL_AT: failurePoint }),
      `PMS_INJECTED_${failurePoint.toUpperCase()}_FAILURE`,
    );
  }

  const commitFailure = await runCommitFailureWithLoader();
  assert.notEqual(
    commitFailure.status,
    0,
    'injected prepared-ticket commit failure unexpectedly succeeded',
  );
  assert.ok(
    commitFailure.output.includes('PMS_INJECTED_COMMIT_FAILURE'),
    commitFailure.output,
  );
  assert.deepEqual(
    await digestTree(path.join(appRoot, '.pandamstyle')),
    beforeFailures,
    'commit failure changed the previous canonical generation',
  );
  report.failures.push({
    point: 'commitPrepared',
    message: commitFailure.output.trim().slice(-1200),
  });

  const preparedMutation = await runPreparedMutationWithLoader();
  assert.notEqual(
    preparedMutation.status,
    0,
    'a publication ticket committed after its revision was superseded',
  );
  assert.ok(
    preparedMutation.output.includes('PMS_MUTATED_AFTER_PREPARE'),
    preparedMutation.output,
  );
  assert.deepEqual(
    await digestTree(path.join(appRoot, '.pandamstyle')),
    beforeFailures,
    'editing after prepare changed the prior canonical generation',
  );
  report.failures.push({
    point: 'edit-during-prepared-publication',
    message: preparedMutation.output.trim().slice(-1200),
  });

  await expectedFailureBuild(
    'build.write-false',
    () => buildApp({ PMS_VITE_WRITE_FALSE: '1' }),
    'PMS_UNSUPPORTED_FEATURE',
  );
  await expectedFailureBuild(
    'multiple-outputs',
    () => buildApp({ PMS_VITE_MULTI_OUTPUT: '1' }),
    'PMS_UNSUPPORTED_FEATURE',
  );

  const afterFailuresMs = await buildApp();
  assert.deepEqual(
    await digestTree(path.join(appRoot, '.pandamstyle')),
    beforeFailures,
    'a stale prepared ticket committed after failure',
  );
  report.production.push({
    label:
      'failure matrix preserves previous generation and rejects stale tickets',
    beforeDigests: beforeFailures,
    failurePoints: report.failures.map((entry) => entry.point),
    recoveryBuildMs: afterFailuresMs,
  });
  report.production.push({
    label: 'restored build',
    hostBuildMs: baselineBuildMs,
    artifactDigests: baselineDigests,
  });
}

async function main() {
  await resetQualificationApp();
  const sessionIdBeforeReopen = await runDevQualification();
  await runServerRestart();
  await runCloseReopen(sessionIdBeforeReopen);
  report.devSummary.matrixRows = report.dev.length;
  await runIsolationQualification();
  await runProductionQualification();
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(
    JSON.stringify(
      {
        viteVersion: report.viteVersion,
        devRows: report.dev.length,
        productionRows: report.production.length,
        failurePoints: report.failures.map((entry) => entry.point),
        bundleScan: report.bundles,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
