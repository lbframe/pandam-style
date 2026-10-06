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
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pandamstyle } from '@pandamstyle/rsbuild';
import { chromium } from 'playwright-core';
import { qualifyStart } from './qualify-rsbuild-start.mjs';
import { qualifyFailures } from './qualify-rsbuild-failures.mjs';
import { createProjectSession, Codes } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';

const base = path.dirname(fileURLToPath(import.meta.url));
const reportPath = process.argv[2] ?? path.join(base, 'rsbuild-report.json');
const require = createRequire(import.meta.url);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const report = {
  complete: false,
  versions: {},
  plain: { dev: [], production: [] },
  start: {},
  failures: [],
  isolation: {},
  events: [],
  node: process.version,
};
for (const name of [
  '@rsbuild/core',
  '@rspack/core',
  '@tanstack/react-start',
  '@pandamstyle/rsbuild',
]) {
  report.versions[name] = require(`${name}/package.json`).version;
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, limit = 20000) {
  const started = performance.now();
  while (performance.now() - started < limit) {
    try {
      if (await predicate()) return;
    } catch (error) {
      if (
        !/Execution context was destroyed|Cannot find context with specified id/.test(
          error.message,
        )
      )
        throw error;
    }
    await pause(30);
  }
  throw new Error(`Timed out: ${label}`);
}
async function write(root, file, value) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  const target = path.join(root, file);
  const pendingDirectory = path.join(base, '.pms-complete-writes');
  await fs.mkdir(pendingDirectory, { recursive: true });
  const pending = path.join(pendingDirectory, hash(target));
  // A scenario edits a complete author file. Avoid publishing the transient
  // empty file created by writeFile's truncate before the intended bytes arrive.
  // Keep the pending file outside all watched app roots: creating a neighbour
  // would trigger an unrelated native compile before the target edit exists.
  await fs.writeFile(pending, value);
  await fs.rename(pending, target);
}
const definitionSource = `import { token } from '@pandamstyle/compiler/config';
export default {
 systemId: 'phase11',
 tokens: { spacing: { sm: { value: '8px', visibility: 'public' }, md: { value: '16px', visibility: 'public' }, lg: { value: '24px', visibility: 'public' } },
 colors: { a: { value: '#112233', visibility: 'public' }, b: { value: '#445566', visibility: 'public' }, surface: { ref: 'colors.a', visibility: 'public' } } },
 themes: { light: { tokens: {} }, dark: { tokens: { colors: { surface: { ref: 'colors.b' } } } } },
 conditions: { hover: ':hover', wide: '@media (min-width: 768px)' },
 recipes: { button: { base: { display: 'inline-flex', padding: token('spacing.sm') }, variants: { tone: { normal: { color: token('colors.surface') }, loud: { color: token('colors.b') } } }, defaultVariants: { tone: 'normal' } } }
};`;
const pageSource = `import React from 'react';
import { create, token, props, recipes, themes } from './bridge.js';
const styles = create({ main: { padding: token('spacing.md'), display: 'flex', marginLeft: { base: token('spacing.sm'), wide: token('spacing.lg') } }, preview: { color: token('colors.surface') } });
export function App() { const [count, setCount] = React.useState(0); return <div {...props(styles.main)}><button id="count" {...props(recipes.button())} onClick={() => setCount(count + 1)}>Count {count}</button><div {...props(themes.dark)}><span id="themed" {...props(styles.preview)}>Theme preview</span></div></div>; }
`;
const bridgeSource =
  "export { create, token, props, recipes, themes } from '../.pandamstyle/design.pandamstyle.js';";
let browser;
const servers = [];
const compilationObservations = new WeakMap();
async function canonical(root) {
  const names = [
    'design.pandamstyle.js',
    'design.pandamstyle.d.ts',
    'styles.css',
    'manifest.json',
    'artifacts.json',
  ];
  const files = {};
  for (const name of names)
    files[name] = await fs.readFile(
      path.join(root, '.pandamstyle', name),
      'utf8',
    );
  const metadata = JSON.parse(files['artifacts.json']);
  assert.equal(Object.keys(metadata.artifacts).length, 4);
  for (const record of Object.values(metadata.artifacts)) {
    if (record.file && files[record.file])
      assert.equal(hash(files[record.file]), record.sha256);
  }
  return {
    digest: hash(JSON.stringify(files)),
    cssDigest: hash(files['styles.css']),
    files,
  };
}
async function plainFixture(root) {
  await write(root, 'package.json', '{"type":"module","private":true}');
  await write(root, 'definition.mjs', definitionSource);
  await write(root, 'src/bridge.js', bridgeSource);
  await write(root, 'src/App.jsx', pageSource);
  await write(
    root,
    'src/index.jsx',
    "import React from 'react'; import { createRoot } from 'react-dom/client'; import { App } from './App.jsx'; createRoot(document.getElementById('root')).render(<App/>);",
  );
}
async function host(root, events, mode = 'development', extra = []) {
  const compilation = { active: false, epoch: 0 };
  const instance = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      mode,
      plugins: [
        pluginReact(),
        {
          name: 'qualification-compilation-observer',
          setup(api) {
            api.onBeforeDevCompile({
              order: 'pre',
              handler() {
                compilation.active = true;
                compilation.epoch++;
              },
            });
            api.onAfterDevCompile({
              order: 'post',
              handler() {
                compilation.active = false;
              },
            });
          },
        },
        ...extra,
        pandamstyle({
          definition: './definition.mjs',
          roots: ['src'],
          onEvent(event) {
            const observation = { ...event, observedAt: performance.now() };
            events.push(observation);
            report.events.push({ root, ...observation });
            if (process.env.PMS_RSBUILD_DEBUG)
              console.log(JSON.stringify(event));
          },
        }),
      ],
      server: { port: 0, host: '127.0.0.1', strictPort: false },
      dev: { lazyCompilation: false, progressBar: false },
    },
  });
  compilationObservations.set(instance, compilation);
  return instance;
}
async function build(root, extra = []) {
  const events = [];
  const started = performance.now();
  const instance = await host(root, events, 'production', extra);
  const result = await instance.build();
  try {
    assert.equal(result.stats.hasErrors(), false);
  } finally {
    await result.close();
  }
  return {
    ms: performance.now() - started,
    events,
    canonical: await canonical(root),
  };
}
async function dev(root, extra = []) {
  const events = [];
  const started = performance.now();
  const instance = await host(root, events, 'development', extra);
  const startedServer = await instance.startDevServer();
  const server = startedServer.server;
  servers.push(server);
  await until(
    () => events.some((event) => event.kind === 'settled'),
    'initial dev compilation',
  );
  return {
    instance,
    server,
    events,
    compilation: compilationObservations.get(instance),
    url: `http://127.0.0.1:${server.port}`,
    ms: performance.now() - started,
  };
}
async function edit(devState, file, source, name, valid = true) {
  const started = performance.now();
  let transportReady;
  if (devState.page) {
    await until(() => {
      const socket = devState.browserSockets.findLast(
        (item) =>
          item.documentEpoch === devState.browserDocumentEpoch &&
          item.firstFrameObservedAt !== null &&
          !item.closed,
      );
      if (!socket) return false;
      transportReady = {
        url: socket.url,
        documentEpoch: socket.documentEpoch,
        firstFrameObservedAt: socket.firstFrameObservedAt,
        observedAt: performance.now(),
      };
      return true;
    }, `${name}: current browser reload channel ready`);
  }
  let before;
  let browserAssets = [];
  let assetBaseline;
  if (!valid && devState.browserAssetUrls) {
    const captureAssets = () =>
      Promise.all(
        devState.browserAssetUrls.map(async (url) => {
          const response = await fetch(url);
          assert.equal(response.status, 200);
          return { url, bytes: await response.text() };
        }),
      );
    await until(async () => {
      const observation = devState.compilation;
      if (observation.active) return false;
      const epoch = observation.epoch;
      const firstCanonical = await canonical(devState.root);
      const first = await captureAssets();
      const second = await captureAssets();
      const secondCanonical = await canonical(devState.root);
      if (
        observation.active ||
        epoch !== observation.epoch ||
        firstCanonical.digest !== secondCanonical.digest ||
        first.some((asset, i) => asset.bytes !== second[i].bytes)
      )
        return false;
      before = secondCanonical;
      browserAssets = second;
      assetBaseline = {
        coherent: true,
        compilationEpoch: epoch,
        canonicalDigest: before.digest,
        observedAt: performance.now(),
      };
      return true;
    }, `${name}: coherent idle browser assets`);
  } else before = await canonical(devState.root);
  const from = devState.events.length;
  const beforeRevision = Math.max(
    ...devState.events.map((event) => event.revision?.revisionId ?? 0),
  );
  const sourceMutationStartedAt = performance.now();
  if (typeof source === 'function') await source();
  else await write(devState.root, file, source);
  await until(
    () =>
      devState.events
        .slice(from)
        .some(
          (event) =>
            event.kind === (valid ? 'reload' : 'rejected') &&
            event.revision?.revisionId > beforeRevision &&
            (valid || event.diagnostics?.ok === false),
        ),
    name,
  );
  const events = devState.events.slice(from);
  const after = await canonical(devState.root);
  if (!valid)
    assert.equal(
      after.digest,
      before.digest,
      `${name}: invalid publication changed canonical set`,
    );
  if (browserAssets.length) {
    const assetChecks = await Promise.all(
      browserAssets.map(async (asset) => {
        const response = await fetch(asset.url);
        assert.equal(response.status, 200);
        const bytes = await response.text();
        return {
          url: asset.url,
          beforeSha256: hash(asset.bytes),
          afterSha256: hash(bytes),
          emittedErrorStub:
            /Module build failed|PMS_COVERAGE_GAP|PMS_FORBIDDEN_VALUE/.test(
              bytes,
            ),
          preserved: bytes === asset.bytes,
        };
      }),
    );
    report.plain.rejectedHostAssets ??= [];
    report.plain.rejectedHostAssets.push({
      name,
      baseline: assetBaseline,
      assets: assetChecks,
    });
    assert(
      assetChecks.every((asset) => asset.preserved),
      `${name}: rejected compilation replaced the last valid browser assets`,
    );
  }
  const settlement = events.findLast(
    (event) => event.kind === (valid ? 'settled' : 'rejected'),
  );
  const row = {
    name,
    ms: performance.now() - started,
    beforeDigest: before.digest,
    afterDigest: after.digest,
    cssDigest: after.cssDigest,
    ...settlement,
  };
  if (valid && devState.page) {
    // Sending a reload does not mean its browser document has loaded. Observe
    // the exact revision's send and a healthy document after the source edit.
    // Native liveReload can navigate before the adapter's deferred send;
    // its current document must have a connected channel before another edit.
    const reload = events.findLast(
      (event) =>
        event.kind === 'reload' &&
        event.revision?.sessionId === settlement.revision.sessionId &&
        event.revision?.revisionId === settlement.revision.revisionId,
    );
    assert(reload, `${name}: missing exact revision reload`);
    await until(
      async () =>
        devState.browserNavigations.some(
          (time) => time > sourceMutationStartedAt,
        ) && (await devState.page.locator('#count').isVisible()),
      `${name}: healthy browser document after source mutation and exact revision send`,
    );
    row.browserReload = {
      pass: true,
      revision: reload.revision,
      sourceMutationStartedAt,
      transportReadyBeforeMutation: transportReady,
      reloadObservedAt: reload.observedAt,
      navigationObservedAt: devState.browserNavigations.find(
        (time) => time > sourceMutationStartedAt,
      ),
    };
  }
  (devState.rows ?? report.plain.dev).push(row);
  return row;
}

async function isolation() {
  const roots = ['isolation-a', 'isolation-b'].map((name) =>
    path.join(base, name),
  );
  const definitions = [
    definitionSource.replace(
      "sm: { value: '8px'",
      "onlyA: { value: '101px', visibility: 'public' }, sm: { value: '8px'",
    ),
    definitionSource
      .replace(
        "sm: { value: '8px'",
        "onlyB: { value: '202px', visibility: 'public' }, sm: { value: '8px'",
      )
      .replace("value: '16px'", "value: '32px'"),
  ];
  for (let i = 0; i < roots.length; i++) {
    await plainFixture(roots[i]);
    await write(roots[i], 'definition.mjs', definitions[i]);
  }
  const states = await Promise.all(
    roots.map(async (root) => ({ ...(await dev(root)), root })),
  );
  const rows = [];
  for (const state of states) state.rows = rows;
  const sets = await Promise.all(roots.map(canonical));
  const identities = sets.map((set) => JSON.parse(set.files['artifacts.json']));
  assert.equal(identities[0].systemId, identities[1].systemId);
  assert.notEqual(identities[0].registryDigest, identities[1].registryDigest);
  assert.notEqual(sets[0].digest, sets[1].digest);
  assert.notEqual(
    states[0].events[0].revision.sessionId,
    states[1].events[0].revision.sessionId,
  );
  const pages = await Promise.all(
    states.map(async (state) => {
      const page = await browser.newPage();
      await page.goto(state.url);
      return page;
    }),
  );
  assert.equal(
    await pages[0]
      .locator('div:has(> #count)')
      .evaluate((el) => getComputedStyle(el).paddingTop),
    '16px',
  );
  assert.equal(
    await pages[1]
      .locator('div:has(> #count)')
      .evaluate((el) => getComputedStyle(el).paddingTop),
    '32px',
  );
  await edit(
    states[0],
    'src/App.jsx',
    pageSource.replace("token('spacing.md')", "token('spacing.unknown')"),
    'isolation-invalid-a',
    false,
  );
  const invalid = states[0].events.findLast(
    (event) => event.kind === 'rejected' && event.diagnostics?.ok === false,
  );
  const candidateIds = invalid.diagnostics.diagnostics
    .flatMap((item) => item.candidates ?? [])
    .map((item) => item.tokenId);
  assert(candidateIds.includes('spacing.onlyA'));
  assert(!candidateIds.includes('spacing.onlyB'));
  assert.equal((await canonical(roots[1])).digest, sets[1].digest);
  await edit(states[0], 'src/App.jsx', pageSource, 'isolation-repair-a');
  for (const page of pages) await page.close();
  for (const state of states) await state.server.close();
  const definitionsLoaded = await Promise.all(
    roots.map((root) =>
      import(new URL(path.join(root, 'definition.mjs'), 'file:').href).then(
        (module) => module.default,
      ),
    ),
  );
  const sessions = roots.map((root, i) =>
    createProjectSession({
      rootDir: root,
      roots: ['src'],
      definition: definitionsLoaded[i],
    }),
  );
  try {
    const revisions = await Promise.all(
      sessions.map(async (session) => {
        const revision = (await session.initialize()).revision;
        await session.validate(revision);
        return revision;
      }),
    );
    const bridges = sessions.map(createHostBridge);
    const tickets = await Promise.all(
      bridges.map((bridge, i) => bridge.preparePublication(revisions[i])),
    );
    await assert.rejects(bridges[1].commitPrepared(tickets[0]), (error) =>
      error.diagnostics.some((item) => item.code === Codes.INVALID_REVISION),
    );
    for (let i = 0; i < bridges.length; i++)
      await bridges[i].abortPrepared(tickets[i]);
  } finally {
    for (const session of sessions) await session.close();
  }
  report.isolation = {
    pass: true,
    sameRelativePaths: true,
    sameSystemId: true,
    differentRegistryDigests: identities.map((item) => item.registryDigest),
    differentArtifactDigests: sets.map((set) => set.digest),
    roots,
    candidateIds,
    foreignTicketRejected: true,
    dev: rows,
    browserPadding: ['16px', '32px'],
    eventProjectIds: states.map((state) => [
      ...new Set(state.events.map((event) => event.revision.projectId)),
    ]),
  };
}

async function bundleScan(roots) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.js$/.test(file)) {
        const source = await fs.readFile(file, 'utf8');
        assert(
          !/@pandamstyle\/(?:compiler|vite|next|rsbuild)|@babel\/|@stylexjs\/|@pandacss\/|node:(?:fs|path|crypto|module|url)|require\(["'](?:fs|path|crypto)["']\)/.test(
            source,
          ),
          `build-time/browser dependency leakage: ${file}`,
        );
        files.push({
          file,
          bytes: Buffer.byteLength(source),
          sha256: hash(source),
        });
      }
    }
  }
  for (const root of roots) await walk(root);
  assert(files.length > 2);
  return {
    pass: true,
    compilerLeakage: 0,
    adapterLeakage: 0,
    nodeLeakage: 0,
    babelLeakage: 0,
    donorLeakage: 0,
    files,
  };
}

async function topology(root) {
  const rows = [];
  for (const [name, environments] of [
    [
      'three-compilers',
      {
        client: { output: { target: 'web' } },
        server: { output: { target: 'node' } },
        extra: { output: { target: 'web' } },
      },
    ],
    [
      'two-web-compilers',
      {
        first: { output: { target: 'web' } },
        second: { output: { target: 'web' } },
      },
    ],
  ]) {
    const events = [];
    const before = await canonical(root);
    const instance = await createRsbuild({
      cwd: root,
      rsbuildConfig: {
        plugins: [
          pluginReact(),
          pandamstyle({
            roots: ['src'],
            definition: './definition.mjs',
            onEvent: (event) => events.push(event),
          }),
        ],
        environments,
      },
    });
    await assert.rejects(instance.createCompiler(), (error) =>
      error.message.includes(Codes.UNSUPPORTED_FEATURE),
    );
    assert(events.some((event) => event.kind === 'closed'));
    assert.equal((await canonical(root)).digest, before.digest);
    rows.push({
      name,
      pass: true,
      outcome: 'explicit-rejection',
      leaseReleased: true,
      canonicalUnchanged: true,
    });
  }
  await build(root);
  report.topology = {
    policy:
      'one compiler or one web/node pair; no RSC, no larger or two-browser topology',
    rejected: rows,
    supportedWebNodePair: report.start.production.logicalPublications === 1,
  };
}

async function main() {
  try {
    const root = path.join(base, 'plain');
    await fs.rm(root, { recursive: true, force: true });
    await plainFixture(root);
    browser = await chromium.launch({
      executablePath: process.env.PMS_CHROMIUM ?? '/opt/google/chrome/chrome',
      headless: true,
      chromiumSandbox: true,
    });
    const state = { ...(await dev(root)), root };
    const page = await browser.newPage();
    state.page = page;
    state.browserNavigations = [];
    state.browserDocumentEpoch = 0;
    state.browserSockets = [];
    await page.setViewportSize({ width: 800, height: 600 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    let navigations = 0;
    page.on('websocket', (socket) => {
      const address = new URL(socket.url());
      if (address.host !== new URL(state.url).host) return;
      const observation = {
        url: address.origin + address.pathname,
        documentEpoch: state.browserDocumentEpoch,
        firstFrameObservedAt: null,
        closed: false,
        frames: [],
      };
      state.browserSockets.push(observation);
      socket.on('framereceived', ({ payload }) => {
        const observedAt = performance.now();
        observation.firstFrameObservedAt ??= observedAt;
        let type;
        try {
          type = JSON.parse(String(payload)).type;
        } catch {
          type = 'unparsed';
        }
        observation.frames.push({ type, observedAt });
      });
      socket.on('close', () => {
        observation.closed = true;
      });
    });
    report.plain.browserTransport = {
      sockets: state.browserSockets,
      navigations: state.browserNavigations,
    };
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        navigations++;
        state.browserDocumentEpoch++;
        state.browserNavigations.push(performance.now());
      }
    });
    await page.goto(state.url);
    state.browserAssetUrls = await page
      .locator('script[src]')
      .evaluateAll((nodes) => nodes.map((node) => node.src));
    assert(state.browserAssetUrls.length > 0);
    await page.locator('#count').click();
    await until(
      () =>
        page
          .locator('#count')
          .textContent()
          .then((text) => text === 'Count 1'),
      'plain interaction',
    );
    assert.equal(
      await page
        .locator('div:has(> #count)')
        .evaluate((element) => getComputedStyle(element).paddingTop),
      '16px',
    );
    report.plain.coldReadyMs = state.ms;
    report.plain.firstTransformMs = state.events.find(
      (event) => event.kind === 'transform',
    ).hostMs;
    report.plain.browser = {
      interaction: true,
      initialComputedPadding: '16px',
      errors,
    };
    const changed = pageSource.replace(
      "token('spacing.md'), display",
      "token('spacing.lg'), display",
    );
    await edit(state, 'src/App.jsx', changed, 'existing-atom-style');
    await until(
      () =>
        page
          .locator('div:has(> #count)')
          .evaluate((element) => getComputedStyle(element).paddingTop)
          .then((text) => text === '24px'),
      'browser CSS style update',
    );
    await edit(
      state,
      'src/App.jsx',
      changed.replace("display: 'flex'", "display: 'grid'"),
      'new-atom-style',
    );
    await until(
      () =>
        page
          .locator('div:has(> #count)')
          .evaluate((el) => getComputedStyle(el).display)
          .then((value) => value === 'grid'),
      'browser new atom CSS',
    );
    await edit(
      state,
      'src/App.jsx',
      changed.replace("token('spacing.lg')", "'17px'"),
      'invalid-style',
      false,
    );
    await edit(state, 'src/App.jsx', pageSource, 'invalid-repair');
    await until(
      () => page.locator('#count').isVisible(),
      'browser invalid repair',
    );
    assert(
      !(await canonical(root)).files['styles.css'].includes('{display:grid}'),
      'removed atom remained in canonical CSS',
    );
    await edit(
      state,
      'src/App.jsx',
      pageSource.replace("'./bridge.js'", "'./missing.js'"),
      'unresolved-import',
      false,
    );
    await edit(state, 'src/missing.js', bridgeSource, 'unresolved-repair');
    await edit(state, 'src/App.jsx', pageSource, 'import-edit');
    await edit(
      state,
      'src/bridge.js',
      "export * from '../.pandamstyle/design.pandamstyle.js';",
      'star-re-export',
    );
    await edit(state, 'src/relay.js', bridgeSource, 'module-add');
    await edit(
      state,
      'src/bridge.js',
      "export { create, token, props, recipes, themes } from './relay.js';",
      'multi-hop-relay',
    );
    await edit(state, 'src/bridge.js', bridgeSource, 'named-re-export');
    await edit(
      state,
      'src/relay.js',
      `${bridgeSource}\nexport const unusedEdit = 1;`,
      'former-dependency-edit',
    );
    await edit(
      state,
      'src/relay.js',
      () => fs.unlink(path.join(root, 'src/relay.js')),
      'module-delete',
    );
    await edit(
      state,
      'src/App.jsx',
      pageSource.replace("'./bridge.js'", "'./renamed.js'"),
      'rename-dependent-import',
      false,
    );
    await edit(
      state,
      'src/bridge.js',
      () =>
        fs.rename(
          path.join(root, 'src/bridge.js'),
          path.join(root, 'src/renamed.js'),
        ),
      'module-rename',
    );
    await edit(
      state,
      'src/bridge.js',
      () =>
        fs.rename(
          path.join(root, 'src/renamed.js'),
          path.join(root, 'src/bridge.js'),
        ),
      'rename-back-unresolved',
      false,
    );
    await edit(state, 'src/App.jsx', pageSource, 'rename-restored');
    const mutationSources = [
      [
        'token-mutation',
        definitionSource.replace("value: '16px'", "value: '20px'"),
      ],
      [
        'alias-mutation',
        definitionSource.replace("ref: 'colors.a'", "ref: 'colors.b'"),
      ],
      [
        'theme-mutation',
        definitionSource.replace(
          "surface: { ref: 'colors.b' }",
          "surface: { ref: 'colors.a' }",
        ),
      ],
      ['condition-mutation', definitionSource.replace('768px', '900px')],
      [
        'recipe-mutation',
        definitionSource.replace(
          "padding: token('spacing.sm')",
          "padding: token('spacing.md')",
        ),
      ],
    ];
    for (const [name, source] of mutationSources) {
      const row = await edit(state, 'definition.mjs', source, name);
      const check = {
        'token-mutation': ['div:has(> #count)', 'paddingTop', '20px'],
        'alias-mutation': ['#count', 'color', 'rgb(68, 85, 102)'],
        'theme-mutation': ['#themed', 'color', 'rgb(17, 34, 51)'],
        'condition-mutation': ['div:has(> #count)', 'marginLeft', '8px'],
        'recipe-mutation': ['#count', 'paddingTop', '16px'],
      }[name];
      await until(
        () =>
          page
            .locator(check[0])
            .evaluate(
              (element, property) => getComputedStyle(element)[property],
              check[1],
            )
            .then((value) => value === check[2]),
        `${name}: browser CSS`,
      );
      row.browserCss = { property: check[1], expected: check[2], pass: true };
    }
    await edit(
      state,
      'definition.mjs',
      definitionSource,
      'definition-restored',
    );
    await edit(
      state,
      'src/App.jsx',
      async () => {
        for (let i = 0; i < 8; i++)
          await write(root, 'src/App.jsx', i % 2 ? pageSource : changed);
        await write(root, 'src/App.jsx', changed);
      },
      'rapid-edit-burst',
    );
    assert.equal(
      (await canonical(root)).files['styles.css'].includes('24px'),
      true,
    );
    await edit(state, 'src/App.jsx', pageSource, 'burst-restored');
    report.plain.browser.reloadNavigations = navigations;
    report.plain.browser.errors = errors;
    await state.server.close();
    await page.close();
    const restarted = await dev(root);
    report.plain.dev.push({
      name: 'close-reopen',
      pass: true,
      readyMs: restarted.ms,
      event: restarted.events.findLast((event) => event.kind === 'settled'),
    });
    await restarted.server.close();
    for (const name of ['clean', 'repeat', 'changed', 'restored']) {
      if (name === 'changed') await write(root, 'src/App.jsx', changed);
      if (name === 'restored') await write(root, 'src/App.jsx', pageSource);
      const result = await build(root);
      report.plain.production.push({
        name,
        ms: result.ms,
        digest: result.canonical.digest,
        cssDigest: result.canonical.cssDigest,
      });
    }
    assert.equal(
      report.plain.production[0].digest,
      report.plain.production[1].digest,
    );
    assert.equal(
      report.plain.production[0].digest,
      report.plain.production[3].digest,
    );
    await qualifyFailures({
      base,
      root,
      pageSource,
      changed,
      definitionSource,
      canonical,
      build,
      report,
    });
    const startRoot = await qualifyStart({
      base,
      browser,
      until,
      canonical,
      report,
    });
    await topology(root);
    await isolation();
    report.bundleScan = await bundleScan([
      path.join(root, 'dist'),
      path.join(startRoot, 'dist/client'),
    ]);
    const bundleText = (
      await Promise.all(
        report.bundleScan.files.map((file) => fs.readFile(file.file, 'utf8')),
      )
    ).join('\n');
    assert(
      !bundleText.includes('spacing.md') &&
        !bundleText.includes('pandamstyle-token-ref'),
      'removable token vocabulary retained in Rsbuild browser output',
    );
    report.treeShaking = {
      pass: true,
      removedTokenVocabulary: ['spacing.md', 'pandamstyle-token-ref'],
      sourceHasVocabulary: true,
      dynamicAxisRetention: 'existing deferred optimization; unchanged',
    };
    report.revisionConsistency = {
      pass: true,
      policy:
        'every compilation binds exact source digests to one immutable revision; stale/mixed settlement rejects',
      cases: [
        'rapid-edit-burst',
        'module-rename',
        'rename-dependent-import',
        'edit-during-transform',
        'source-change-prepared',
        'design-change-prepared',
        'stale-ticket',
        'close-with-prepared-ticket-and-reopen',
      ],
      authenticatedTransforms: report.events.filter(
        (event) => event.kind === 'transform',
      ).length,
    };
    const reloads = report.events.filter((event) => event.kind === 'reload');
    report.reloadMatrix = {
      policy: 'full-reload after aggregate done; superseded sends canceled',
      hmrClaimed: false,
      actualSendCount: reloads.length,
      browserNavigations: report.plain.browser.reloadNavigations,
      events: reloads,
    };
    assert(reloads.length > 0, 'No actual adapter reload was observed');
    for (const row of report.plain.dev) {
      if (row.revision)
        row.actualReloadSends = reloads.filter(
          (event) =>
            event.revision.projectId === row.revision.projectId &&
            event.revision.sessionId === row.revision.sessionId &&
            event.revision.revisionId === row.revision.revisionId,
        ).length;
    }
    report.complete = true;
  } catch (error) {
    const failedPage = browser?.contexts()[0]?.pages()[0];
    if (failedPage)
      report.failurePage = await failedPage
        .locator('body > *')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            tag: node.tagName,
            id: node.id,
            text:
              node.tagName === 'SCRIPT' ? '' : node.textContent.slice(0, 200),
          })),
        );
    console.error(error);
    throw error;
  } finally {
    for (const server of servers) await server.close().catch(() => {});
    await browser?.close();
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
