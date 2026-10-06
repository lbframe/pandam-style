/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { tanstackStart } from '@tanstack/react-start/plugin/rsbuild';
import { pandamstyle } from '@pandamstyle/rsbuild';

const home = `import React from 'react'; import { createFileRoute } from '@tanstack/react-router'; import { createServerFn } from '@tanstack/react-start'; import { create, token, props } from '../../.pandamstyle/design.pandamstyle.js';
const getValue = createServerFn({ method: 'GET' }).handler(() => 'server-loaded');
const styles = create({ main: { padding: token('spacing.md'), display: 'flex' } });
export const Route = createFileRoute('/')({ component: Home, loader: () => getValue() });
function Home() { const value = Route.useLoaderData(); const [count, setCount] = React.useState(0); return <div id="home" {...props(styles.main)}><p id="server-value">{value}</p><button id="count" onClick={() => setCount(count + 1)}>Count {count}</button></div>; }`;

export async function qualifyStart({
  base,
  browser,
  until,
  canonical,
  report,
}) {
  const root = path.join(base, 'start');
  await fs.rm(root, { recursive: true, force: true });
  async function write(file, content) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await write('package.json', '{"type":"module","private":true}');
  await write(
    'definition.mjs',
    "export default { systemId: 'phase11-start', tokens: { spacing: { md: { value: '16px', visibility: 'public' }, lg: { value: '24px', visibility: 'public' } } } };",
  );
  await write(
    'tsconfig.json',
    '{"compilerOptions":{"jsx":"react-jsx","moduleResolution":"Bundler","module":"ESNext","target":"ES2022","strictNullChecks":true}}',
  );
  await write(
    'src/router.tsx',
    "import { createRouter } from '@tanstack/react-router'; import { routeTree } from './routeTree.gen'; export function getRouter() { return createRouter({ routeTree, scrollRestoration: true }); }",
  );
  await write(
    'src/routes/__root.tsx',
    'import { createRootRoute, Outlet, HeadContent, Scripts, Link } from \'@tanstack/react-router\'; export const Route = createRootRoute({ component: Root }); function Root() { return <html><head><HeadContent/></head><body><nav><Link to="/">Home</Link> <Link to="/nested">Nested</Link></nav><Outlet/><Scripts/></body></html>; }',
  );
  await write('src/routes/index.tsx', home);
  await write(
    'src/routes/nested.tsx',
    "import { createFileRoute, Outlet } from '@tanstack/react-router'; export const Route = createFileRoute('/nested')({ component: () => <section id=\"layout\"><h1>Nested layout</h1><Outlet/></section> });",
  );
  await write(
    'src/routes/nested.index.tsx',
    "import { createFileRoute } from '@tanstack/react-router'; export const Route = createFileRoute('/nested/')({ component: () => <p id=\"nested\">Nested route</p> });",
  );
  const events = [];
  const devCompilations = [];
  const config = () => ({
    plugins: [
      pluginReact(),
      tanstackStart(),
      pandamstyle({
        roots: ['src/routes/index.tsx'],
        passthroughUncovered: true,
        definition: './definition.mjs',
        onEvent(event) {
          events.push(event);
          report.events.push({ root, ...event });
        },
      }),
      {
        name: 'phase14-start-compilation-observer',
        setup(api) {
          api.modifyRspackConfig((rspackConfig, { environment }) => {
            if (api.context.action !== 'dev') return;
            rspackConfig.plugins ??= [];
            rspackConfig.plugins.push({
              apply(compiler) {
                compiler.hooks.done.tap(
                  'Phase14StartCompilationObserver',
                  (stats) =>
                    devCompilations.push({
                      environment: environment.name,
                      failed: stats.hasErrors(),
                    }),
                );
              },
            });
          });
        },
      },
    ],
    server: { port: 0, host: '127.0.0.1' },
    dev: { lazyCompilation: false, progressBar: false },
  });
  const started = performance.now();
  const dev = await createRsbuild({ cwd: root, rsbuildConfig: config() });
  const { server } = await dev.startDevServer();
  const url = `http://127.0.0.1:${server.port}`;
  async function browserChecks(url, label) {
    const html = await fetch(url, { headers: { Connection: 'close' } }).then(
      (response) => {
        assert.equal(response.status, 200);
        return response.text();
      },
    );
    assert(
      html.includes('server-loaded'),
      `${label}: server function loader absent in SSR`,
    );
    assert(html.includes('id="home"'), `${label}: SSR markup absent`);
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const ssrPage = await noJs.newPage();
    await ssrPage.goto(url);
    const ssrClass = await ssrPage.locator('#home').getAttribute('class');
    const ssrPadding = await ssrPage
      .locator('#home')
      .evaluate((element) => getComputedStyle(element).paddingTop);
    assert.equal(ssrPadding, '16px');
    await noJs.close();
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let navigations = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame())
        navigations++;
    });
    await page.goto(url);
    await page.locator('#count').click();
    await until(
      () =>
        page
          .locator('#count')
          .textContent()
          .then((text) => text === 'Count 1'),
      `${label}: hydration interaction`,
    );
    assert.equal(await page.locator('#home').getAttribute('class'), ssrClass);
    assert.equal(
      await page
        .locator('#home')
        .evaluate((element) => getComputedStyle(element).paddingTop),
      ssrPadding,
    );
    const from = navigations;
    const navStart = performance.now();
    await page.getByRole('link', { name: 'Nested', exact: true }).click();
    await page.locator('#layout #nested').waitFor();
    assert.equal(
      navigations,
      from,
      `${label}: navigation reloaded the document`,
    );
    const navMs = performance.now() - navStart;
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await page.locator('#server-value').waitFor();
    assert.equal(
      await page.locator('#server-value').textContent(),
      'server-loaded',
    );
    assert.deepEqual(errors, [], `${label}: browser/hydration errors`);
    return {
      page,
      row: {
        pass: true,
        ssr: true,
        serverFunction: true,
        hydration: true,
        matchingClass: ssrClass,
        computedPadding: ssrPadding,
        nestedLayout: true,
        clientNavigation: true,
        interaction: true,
        navigationMs: navMs,
        errors,
      },
      navigationCount: () => navigations,
    };
  }
  try {
    const { page, row, navigationCount } = await browserChecks(
      url,
      'Start dev',
    );
    await until(
      () => events.some((event) => event.kind === 'settled'),
      'Start initial PandamStyle settlement',
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const settledEventsBeforeQuietPeriod = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    const compilerCompletionsBeforeQuietPeriod = devCompilations.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const settledEventsAfterQuietPeriod = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    const compilerCompletionsAfterQuietPeriod = devCompilations.length;
    assert.equal(
      settledEventsAfterQuietPeriod,
      settledEventsBeforeQuietPeriod,
      'Start dev must stay idle after PandamStyle output and state files are published',
    );
    assert.equal(
      compilerCompletionsAfterQuietPeriod,
      compilerCompletionsBeforeQuietPeriod,
      'Start dev must not recompile from its own generated files',
    );
    report.start.dev = {
      ...row,
      readyMs: performance.now() - started,
      generatedArtifactWatchStability: {
        pass: true,
        quietPeriodMs: 1000,
        settledEventsBefore: settledEventsBeforeQuietPeriod,
        settledEventsAfter: settledEventsAfterQuietPeriod,
        compilerCompletionsBefore: compilerCompletionsBeforeQuietPeriod,
        compilerCompletionsAfter: compilerCompletionsAfterQuietPeriod,
      },
    };
    const from = events.length;
    await write(
      'src/routes/index.tsx',
      home.replace("token('spacing.md')", "token('spacing.lg')"),
    );
    await until(
      () => events.slice(from).some((event) => event.kind === 'settled'),
      'Start style settlement',
    );
    await until(
      () =>
        page
          .locator('#home')
          .evaluate((element) => getComputedStyle(element).paddingTop)
          .then((value) => value === '24px'),
      'Start CSS reload',
    );
    report.start.dev.styleReload = {
      pass: true,
      outcome: 'full-reload',
      event: events.slice(from).findLast((event) => event.kind === 'settled'),
    };
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const settledAfterAtomicPublicationBeforeQuiet = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    const compilesAfterAtomicPublicationBeforeQuiet = devCompilations.length;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const settledAfterAtomicPublicationQuiet = events.filter(
      (event) => event.kind === 'settled',
    ).length;
    const compilesAfterAtomicPublicationQuiet = devCompilations.length;
    assert.equal(
      settledAfterAtomicPublicationQuiet,
      settledAfterAtomicPublicationBeforeQuiet,
      'Start dev must stay idle after an atomic output replacement',
    );
    assert.equal(
      compilesAfterAtomicPublicationQuiet,
      compilesAfterAtomicPublicationBeforeQuiet,
      'Start dev must ignore its atomic staging, backup, and state temporary files',
    );
    report.start.dev.generatedArtifactWatchStability.afterAtomicReplacement = {
      pass: true,
      quietPeriodMs: 1000,
      settledBefore: settledAfterAtomicPublicationBeforeQuiet,
      settledAfter: settledAfterAtomicPublicationQuiet,
      compilerCompletionsBefore: compilesAfterAtomicPublicationBeforeQuiet,
      compilerCompletionsAfter: compilesAfterAtomicPublicationQuiet,
    };

    const baselineHome = home;
    const unresolvedHome = home
      .replace(
        "import React from 'react';",
        "import React from 'react'; import { repairValue } from './repair-probe';",
      )
      .replace(
        '<p id="server-value">{value}</p>',
        '<p id="server-value">{value}</p><p id="repair-value">{repairValue}</p>',
      );
    const invalidFrom = events.length;
    await write('src/routes/index.tsx', unresolvedHome);
    await until(
      () =>
        events
          .slice(invalidFrom)
          .some((event) =>
            event.diagnostics?.diagnostics?.some(
              (diagnostic) => diagnostic.code === 'PMS_COVERAGE_GAP',
            ),
          ),
      'Start unresolved module diagnostic',
    );
    const invalidEvent = events
      .slice(invalidFrom)
      .find((event) =>
        event.diagnostics?.diagnostics?.some(
          (diagnostic) => diagnostic.code === 'PMS_COVERAGE_GAP',
        ),
      );
    const beforeRepairNavigation = navigationCount();
    const repairFrom = events.length;
    await write(
      'src/routes/repair-probe.ts',
      "export const repairValue = 'module-added-after-unresolved-import';\n",
    );
    await until(
      () =>
        events
          .slice(repairFrom)
          .some(
            (event) =>
              event.kind === 'settled' && event.outcome === 'full-reload',
          ),
      'Start module-add repair settlement',
    );
    await until(
      () => navigationCount() > beforeRepairNavigation,
      'Start module-add explicit browser reload',
    );
    await until(
      () =>
        page
          .locator('#repair-value')
          .textContent()
          .then((text) => text === 'module-added-after-unresolved-import'),
      'Start module-add repair browser recovery',
    );
    report.start.dev.unresolvedImportRepair = {
      pass: true,
      diagnosticCodes: [
        ...new Set(
          invalidEvent.diagnostics.diagnostics.map((item) => item.code),
        ),
      ],
      repairSettlement: events
        .slice(repairFrom)
        .findLast((event) => event.kind === 'settled'),
      explicitBrowserReload: navigationCount() > beforeRepairNavigation,
      recoveredText: await page.locator('#repair-value').textContent(),
    };
    const cleanupFrom = events.length;
    await write('src/routes/index.tsx', baselineHome);
    await fs.rm(path.join(root, 'src/routes/repair-probe.ts'), {
      force: true,
    });
    await until(
      () => events.slice(cleanupFrom).some((event) => event.kind === 'settled'),
      'Start module-repair fixture cleanup',
    );
    await page.close();
  } finally {
    await server.close();
  }
  await write('src/routes/index.tsx', home);
  const buildStart = performance.now();
  const production = await createRsbuild({
    cwd: root,
    rsbuildConfig: { ...config(), mode: 'production' },
  });
  const before = events.length;
  const built = await production.build();
  try {
    assert.equal(built.stats.hasErrors(), false);
  } finally {
    await built.close();
  }
  const settlements = events
    .slice(before)
    .filter((event) => event.kind === 'settled');
  assert.equal(settlements.length, 1, 'Start client/server must publish once');
  const set = await canonical(root);
  const clientCss = await fs.readFile(
    path.join(root, 'dist/client/pandamstyle/styles.css'),
    'utf8',
  );
  const serverCss = await fs.readFile(
    path.join(root, 'dist/server/pandamstyle/styles.css'),
    'utf8',
  );
  assert.equal(clientCss, set.files['styles.css']);
  assert.equal(serverCss, clientCss);
  const handler = (
    await import(pathToFileURL(path.join(root, 'dist/server/index.js')).href)
  ).default;
  const productionServer = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const asset = path.resolve(root, 'dist/client', `.${url.pathname}`);
      if (asset.startsWith(path.join(root, 'dist/client') + path.sep)) {
        try {
          const data = await fs.readFile(asset);
          const type = asset.endsWith('.js')
            ? 'text/javascript'
            : asset.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream';
          response.writeHead(200, { 'Content-Type': type });
          response.end(data);
          return;
        } catch (error) {
          if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error;
        }
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const method = request.method;
      const result = await handler.fetch(
        new Request(url, {
          method,
          headers: request.headers,
          ...(method === 'GET' || method === 'HEAD'
            ? {}
            : { body: Buffer.concat(chunks) }),
        }),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise((resolve) =>
    productionServer.listen(0, '127.0.0.1', resolve),
  );
  try {
    const { page, row } = await browserChecks(
      `http://127.0.0.1:${productionServer.address().port}`,
      'Start production',
    );
    report.start.production = {
      ...row,
      buildMs: performance.now() - buildStart,
      canonicalDigest: set.digest,
      logicalPublications: settlements.length,
      cssDigest: set.cssDigest,
    };
    await page.close();
  } finally {
    await new Promise((resolve) => productionServer.close(resolve));
  }
  report.start.queryTransforms = events.filter(
    (event) => event.kind === 'transform' && event.query,
  );
  assert(
    report.start.queryTransforms.some((event) =>
      event.query.includes('tsr-split'),
    ),
  );
  report.start.sourceDigestAuthenticated = true;
  return root;
}
