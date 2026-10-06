/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { createRequire, isBuiltin } from 'node:module';
import { writeSemanticDevPerformance } from './next-semantic-dev-performance.mjs';
import nextBrowserProfile from './next-browser-profile.js';

const { createNextBrowserProfile } = nextBrowserProfile;

async function main() {
  const runId = randomUUID();
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
  );
  const output = path.resolve(process.argv[2]);
  const app = process.argv[3]
    ? path.resolve(process.argv[3])
    : await fs.mkdtemp(path.join(os.tmpdir(), 'pms-next-external-'));
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' };
  delete env.NODE_PATH;
  const report = {
    scope: 'pandamstyle-next-external-qualification',
    runId,
    app,
    node: process.version,
    packages: {},
    production: [],
    dev: [],
    pass: false,
    phase10Complete: false,
    browserProfile: {
      runId,
      userDataDir: null,
      launchAttempted: false,
      browserProcess: { pid: null, status: 'not-started' },
      cleanup: {
        serverStopped: null,
        browserClosed: null,
        userDataDirRemoved: null,
      },
    },
  };
  await fs.mkdir(output, { recursive: true });

  async function write(root, file, content) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }

  async function run(cwd, command, args, label, extraEnv = {}) {
    const child = spawn(command, args, {
      cwd,
      env: { ...env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (value) => {
      text += value;
    });
    child.stderr.on('data', (value) => {
      text += value;
    });
    const start = performance.now();
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await write(output, `${label}.log`, text);
    return { code, text, ms: performance.now() - start };
  }

  try {
    const packs = path.join(output, 'tarballs');
    await fs.mkdir(packs, { recursive: true });
    const tarballs = [];
    for (const slug of ['core', 'compiler', 'vite', 'next']) {
      const packed = await run(
        path.join(repo, 'packages', slug),
        'npm',
        ['pack', '--json', '--pack-destination', packs],
        `pack-${slug}`,
      );
      assert.equal(packed.code, 0, packed.text);
      const metadata = JSON.parse(packed.text)[0];
      const tarball = path.join(packs, metadata.filename);
      tarballs.push(tarball);
      const hash = createHash('sha256')
        .update(await fs.readFile(tarball))
        .digest('hex');
      const repeated = await run(
        path.join(repo, 'packages', slug),
        'npm',
        ['pack', '--json', '--pack-destination', packs],
        `pack-${slug}-repeat`,
      );
      assert.equal(repeated.code, 0, repeated.text);
      assert.equal(
        createHash('sha256')
          .update(await fs.readFile(tarball))
          .digest('hex'),
        hash,
      );
      report.packages[metadata.name] = {
        ...metadata,
        sha256: hash,
        repeatPack: 'identical',
      };
    }
    await write(
      app,
      'package.json',
      JSON.stringify({ private: true, type: 'module' }),
    );
    const installed = await run(
      app,
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        ...tarballs,
        'next@16.3.8',
        'vite@8.3.1',
        'react@19.3.0',
        'react-dom@19.3.0',
        'typescript@5.9.3',
        '@types/node@22.19.15',
        '@types/react@19.3.0',
        '@types/react-dom@19.3.0',
        'puppeteer-core@25.9.0',
        'node22-next@npm:node@22.12.0',
        'node24-next@npm:node@24.21.0',
      ],
      'external-install',
    );
    assert.equal(installed.code, 0, installed.text);
    for (const slug of ['core', 'compiler', 'vite', 'next']) {
      const installedPath = await fs.realpath(
        path.join(app, 'node_modules/@pandamstyle', slug),
      );
      assert(installedPath.startsWith(app + path.sep));
      report.packages[`@pandamstyle/${slug}`].realpath = installedPath;
      assert.deepEqual(
        await fs.readFile(path.join(installedPath, 'LICENSE')),
        await fs.readFile(path.join(repo, 'LICENSE')),
      );
      assert.deepEqual(
        await fs.readFile(path.join(installedPath, 'ATTRIBUTIONS.md')),
        await fs.readFile(path.join(repo, 'packages', slug, 'ATTRIBUTIONS.md')),
      );
    }
    await write(
      app,
      'public-contract.mjs',
      `import assert from 'node:assert/strict';
import { withPandamStyle } from '@pandamstyle/next';
const options = { backend: 'webpack', definition: { systemId: 'smoke' }, roots: ['app'] };
assert.throws(() => withPandamStyle({ ...options, backend: 'turbopack' }), error => error.code === 'PMS_UNSUPPORTED_FEATURE' && error.message.includes('TURBOPACK-DEV-SETTLEMENT'));
assert.throws(() => withPandamStyle({ ...options, backend: undefined }), error => error.code === 'PMS_UNSUPPORTED_FEATURE');
for (const input of [{ output: 'export' }, { output: 'standalone' }, { reactCompiler: true }, { experimental: { webpackBuildWorker: true } }, { adapterPath: './other.js' }]) {
  await assert.rejects(withPandamStyle(options)(input)('phase-production-build', {}), error => error.code === 'PMS_UNSUPPORTED_FEATURE');
}
await assert.rejects(import('@pandamstyle/next/src/state.js'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
await import('@pandamstyle/next/adapter');
await import('@pandamstyle/next/loader');
assert.equal(typeof (await import('@pandamstyle/next/turbopack-loader')).default, 'function');
assert.equal(typeof withPandamStyle({ ...options, backend: 'turbopack', publicationMode: 'semantic-dev' }), 'function');
assert.equal(typeof withPandamStyle({ ...options, backend: 'turbopack', publicationMode: 'strict' }), 'function');
assert.throws(() => withPandamStyle({ ...options, publicationMode: 'semantic-dev' }), error => error.code === 'PMS_UNSUPPORTED_FEATURE');
`,
    );
    const smoke = await run(
      app,
      process.execPath,
      ['public-contract.mjs'],
      'public-contract',
    );
    assert.equal(smoke.code, 0, smoke.text);
    report.publicContract = {
      pass: true,
      unsupportedConfigurationsRejected: 7,
      privatePathClosed: true,
      exportedSubpaths: true,
      explicitTurbopackModes: true,
      webpackSemanticDevRejected: true,
    };
    const definition = JSON.parse(
      await fs.readFile(
        path.join(repo, 'tests/semantic/fixtures/design.json'),
        'utf8',
      ),
    );
    await write(
      app,
      'definition.mjs',
      `import { token } from '@pandamstyle/compiler/config';
const raw = ${JSON.stringify(definition, null, 2)};
const refs = value => Array.isArray(value) ? value.map(refs) : value && typeof value === 'object'
  ? Object.keys(value).length === 1 && typeof value.$token === 'string' ? token(value.$token)
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refs(item)])) : value;
export default refs(raw);\n`,
    );
    await write(
      app,
      'next.config.mjs',
      `import fs from 'node:fs';
import path from 'node:path';
import { withPandamStyle } from '@pandamstyle/next';
const log = (event) => fs.appendFileSync(path.join(process.cwd(), 'host-events.jsonl'), JSON.stringify({ ...event, observedAt: Date.now() }) + '\\n');
export default withPandamStyle({ backend: 'webpack', definition: './definition.mjs', roots: ['./app'], outDir: './.pandamstyle',
  onEvent: log, onDiagnostics: result => log({ type: 'structured-diagnostics', result }) })(async () => ({
  experimental: { cpus: 2 }, images: { unoptimized: true }, reactCompiler: false,
  async headers() { return [{ source: '/:path*', headers: [{ key: 'x-config-composed', value: 'yes' }] }]; },
  webpack(config) { config.resolve.alias['fixture-config-preserved'] = path.join(process.cwd(), 'app/shared.jsx');
    log({ type: 'user-webpack-callback' });
    config.plugins.push({ apply(compiler) { compiler.hooks.emit.tap('ControlledFixtureEmit', () => {
      if (process.env.PMS_NEXT_FIXTURE_EMIT_FAILURE === '1') throw new Error('PMS_INJECTED_WEBPACK_EMIT');
    });
    compiler.hooks.done.tap('ControlledFixtureBundleAudit', stats => {
      if (compiler.name !== 'client' || stats.hasErrors()) return;
      const modules = stats.toJson({ all: false, modules: true, nestedModules: true }).modules ?? [];
      const resources = [];
      const collect = entries => { for (const entry of entries) { if (entry.identifier) resources.push(entry.identifier.split('!').at(-1)); if (entry.modules) collect(entry.modules); } };
      collect(modules);
      log({ type: 'fixture-client-module-audit', moduleCount: resources.length,
        forbiddenResources: resources.filter(resource => /@pandamstyle\\/(compiler|vite|next|rsbuild)(?:\\/|$)|@babel\\/|@stylexjs\\/|@pandacss\\/|external[^\\n]*node:(fs|path|crypto)/.test(resource)) });
    }); } }); return config; },
}));
`,
    );
    await write(
      app,
      'app/layout.jsx',
      `import { props, themes } from '../.pandamstyle/design.js';
export default function Layout({ children }) { return <html {...props(themes.light)}><body>{children}</body></html>; }
`,
    );
    await write(
      app,
      'app/shared.jsx',
      `import { create, token, props } from '../.pandamstyle/design.js';
const styles = create({ panel: { display: 'block', padding: token('spacing.md'), color: token('colors.text') } });
export default function Shared() { return <p id="server-style" {...props(styles.panel)}>shared server component</p>; }
`,
    );
    await write(
      app,
      'app/client.jsx',
      `'use client';
import { useState, useRef } from 'react';
import { props, recipes } from '../.pandamstyle/design.js';
export default function Client() { const [tone, setTone] = useState('quiet'); const ref = useRef(null); return <button id="client-style" ref={ref} {...props(recipes.button({ tone }))} onClick={event => { if (ref.current !== event.currentTarget) throw new Error('controlled ref composition failed'); setTone(tone === 'quiet' ? 'loud' : 'quiet'); }}>client recipe {tone}</button>; }
`,
    );
    // Compiler resolution is deliberately compiler-owned; avoid a framework-only
    // alias in consumer source while retaining the user's unrelated alias config.
    await write(
      app,
      'app/page.jsx',
      `import Link from 'next/link';
import Shared from './shared';
import Client from './client';
export default function Page() { return <main><Shared /><Client /><Link id="navigate" href="/nested/item">navigate</Link></main>; }
`,
    );
    await write(
      app,
      'app/nested/layout.jsx',
      `import { create, props, token } from '../../.pandamstyle/design.js';
const styles = create({ wrapper: { margin: token('spacing.sm') } });
export default function Nested({ children }) { return <section id="nested" {...props(styles.wrapper)}>{children}</section>; }
`,
    );
    await write(
      app,
      'app/nested/[id]/page.jsx',
      `import Shared from '../../shared';
export default async function Dynamic({ params }) { const { id } = await params; return <div><h1 id="route-id">{id}</h1><Shared /></div>; }
`,
    );
    await write(
      app,
      'app/loading.jsx',
      'export default function Loading() { return <p>loading</p>; }\n',
    );
    await write(
      app,
      'app/error.jsx',
      "'use client';\nexport default function Boundary({ reset }) { return <button onClick={reset}>retry</button>; }\n",
    );
    await write(
      app,
      'app/not-found.jsx',
      'export default function Missing() { return <p>controlled not found</p>; }\n',
    );
    await write(
      app,
      'types.mts',
      `import { withPandamStyle, type PandamStyleNextOptions } from '@pandamstyle/next';
import type { NextConfig } from 'next';
const options: PandamStyleNextOptions = { backend: 'webpack', roots: ['app'], definition: { systemId: 'test' } };
const config: NextConfig = { images: { unoptimized: true }, reactCompiler: false };
withPandamStyle(options)(config);
withPandamStyle(options)(async () => config);
const semanticDev: PandamStyleNextOptions = { backend: 'turbopack', publicationMode: 'semantic-dev', roots: ['semantic'], definition: './definition.mjs' };
const turboStrict: PandamStyleNextOptions = { ...semanticDev, publicationMode: 'strict' };
withPandamStyle(semanticDev)(config);
withPandamStyle(turboStrict)(config);
withPandamStyle({ ...options, publicationMode: 'strict' })(config);
// @ts-expect-error backend must be explicit
withPandamStyle({ roots: ['app'], definition: { systemId: 'test' } });
// @ts-expect-error unknown backend
withPandamStyle({ ...options, backend: 'other' });
// @ts-expect-error framework owns rootDir
withPandamStyle({ ...options, rootDir: '.' });
// @ts-expect-error Turbopack publication mode must be explicit
withPandamStyle({ backend: 'turbopack', roots: ['semantic'], definition: './definition.mjs' });
// @ts-expect-error semantic-dev does not apply to webpack
withPandamStyle({ ...options, publicationMode: 'semantic-dev' });
// @ts-expect-error unknown publication mode
withPandamStyle({ ...semanticDev, publicationMode: 'automatic' });
`,
    );
    const types = await run(
      app,
      process.execPath,
      [
        'node_modules/typescript/bin/tsc',
        '--strict',
        '--noEmit',
        '--skipLibCheck',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ESNext',
        '--jsx',
        'react-jsx',
        'types.mts',
      ],
      'strict-types',
    );
    assert.equal(types.code, 0, types.text);
    report.types = {
      pass: true,
      negativeAssertions: 6,
      strict: true,
      skipLibCheck: true,
      limitation:
        'Next 16.3.8 upstream declaration errors prevent dependency-wide declaration checking; strict consumer checks remain enabled.',
    };
    report.nativeHostTests = [];
    for (const [label, runtime] of [
      ['node22', process.execPath],
      ['node24', path.join(app, 'node_modules/node24-next/bin/node')],
    ]) {
      const tested = await run(
        repo,
        runtime,
        [
          '--test',
          '--test-reporter=tap',
          'packages/next/test/semantic-dev/coordinator.test.mjs',
          'packages/next/test/semantic-dev/transport.test.mjs',
          'packages/next/test/semantic-dev/protocol.test.mjs',
          'packages/next/test/semantic-dev/loader.test.mjs',
          'packages/next/test/semantic-dev/source-map.test.mjs',
        ],
        `native-host-${label}`,
      );
      assert.equal(tested.code, 0, tested.text);
      const counts = Object.fromEntries(
        ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => {
          const value = tested.text.match(
            new RegExp('^# ' + key + ' (\\d+)$', 'm'),
          );
          assert(value, `Missing native test count: ${key}`);
          return [key, Number(value[1])];
        }),
      );
      assert(counts.tests >= 72);
      assert.equal(counts.pass, counts.tests);
      for (const key of ['fail', 'cancelled', 'skipped', 'todo'])
        assert.equal(counts[key], 0);
      report.nativeHostTests.push({
        label,
        runtime,
        counts,
        pass: true,
        ms: tested.ms,
      });
    }
    const built = await run(
      app,
      process.execPath,
      ['node_modules/next/dist/bin/next', 'build', '--webpack'],
      'production-clean',
    );
    report.production.push({ case: 'clean', code: built.code, ms: built.ms });
    assert.equal(built.code, 0, built.text);
    report.events = (
      await fs.readFile(path.join(app, 'host-events.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert(report.events.some((event) => event.type === 'committed'));
    await qualifyRuntime();
    const strictProofFile = path.join(output, 'strict-regression-result.json');
    const strictRunId = `strict-webpack-${randomUUID()}`;
    const strictReportFile = path.join(output, 'strict-regression-report.json');
    const strictBytes =
      JSON.stringify(
        { ...report, pass: true, scope: 'strict-webpack-regression' },
        null,
        2,
      ) + '\n';
    await fs.writeFile(strictReportFile, strictBytes);
    await fs.writeFile(
      strictProofFile,
      JSON.stringify(
        {
          runId: strictRunId,
          scope: 'pandamstyle-next-external-qualification',
          pass: true,
          node: process.version,
          sourceReport: {
            path: strictReportFile,
            sha256: createHash('sha256').update(strictBytes).digest('hex'),
          },
          productionCases: report.production.length,
          devCases: report.dev.length,
          negativeCases: report.failures.length,
          nodeBoundary: report.nodeBoundary,
        },
        null,
        2,
      ) + '\n',
    );
    const semanticOutput = path.join(output, 'turbopack');
    const semantic = await run(
      repo,
      process.execPath,
      [
        path.join(repo, 'tools/pms/qualify-next-semantic-dev.mjs'),
        semanticOutput,
        '--strict-result',
        strictProofFile,
        '--strict-run-id',
        strictRunId,
      ],
      'turbopack-full-qualification',
    );
    assert.equal(semantic.code, 0, semantic.text);
    const semanticReportFile = path.join(semanticOutput, 'report.json');
    const semanticBytes = await fs.readFile(semanticReportFile);
    const semanticReport = JSON.parse(semanticBytes);
    assert.equal(semanticReport.pass, true);
    assert.equal(semanticReport.scope, 'pandamstyle-packed-next-semantic-dev');
    assert.equal(semanticReport.matrix.pass, true);
    assert.equal(semanticReport.matrix.totalRows, 80);
    assert.equal(semanticReport.matrix.laneCount, 2);
    assert.equal(semanticReport.strictProduction.pass, true);
    assert.equal(semanticReport.strictRegression.runId, strictRunId);
    assert.equal(semanticReport.toolchain.next, '16.3.8');
    assert.equal(semanticReport.toolchain.react, '19.2.8');
    assert.equal(semanticReport.toolchain.reactDom, '19.2.8');
    assert.deepEqual(semanticReport.lanes.map((lane) => lane.node).sort(), [
      '22.22.0',
      '24.21.0',
    ]);
    for (const lane of semanticReport.lanes) {
      assert.equal(lane.pass, true);
      assert.equal(lane.matrix.pass, true);
      assert.equal(lane.strictProduction.pass, true);
      assert.deepEqual(
        lane.matrix.rows.map((row) => row.id),
        Array.from(
          { length: 40 },
          (_, index) => 'T' + String(index + 1).padStart(2, '0'),
        ),
      );
      for (const row of lane.matrix.rows) assert.equal(row.status, 'PASS');
    }
    const performanceFile = path.join(semanticOutput, 'performance.json');
    const performanceReport = await writeSemanticDevPerformance(
      semanticReportFile,
      performanceFile,
    );
    assert.equal(performanceReport.pass, true);
    report.turbopack = {
      pass: true,
      status: 'qualified',
      semanticDev: semanticReport.matrix,
      strictProduction: semanticReport.strictProduction,
      reportFile: semanticReportFile,
      reportSha256: createHash('sha256').update(semanticBytes).digest('hex'),
      toolchain: semanticReport.toolchain,
      performanceFile,
      ms: semantic.ms,
    };
    report.phase10Complete = true;
    report.pass = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (process.env.PMS_KEEP_NEXT_QUALIFICATION_TMP !== '1') {
      const browserOutput = path.join(app, '.next/static');
      if (existsSync(browserOutput)) {
        await fs.cp(
          browserOutput,
          path.join(output, 'webpack-browser-bundles'),
          {
            recursive: true,
          },
        );
      }
      await fs.rm(app, { recursive: true });
      report.disposableConsumerRemovedAfterCapture = true;
    }
    await write(output, 'report.json', JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        app,
        runId,
        pass: report.pass,
        error: report.error ?? null,
        browserProfile: report.browserProfile,
      }),
    );
  }

  async function qualifyRuntime() {
    const resolve = createRequire(path.join(app, 'package.json'));
    const { default: puppeteer } = await import(
      pathToFileURL(resolve.resolve('puppeteer-core')).href
    );
    const browserProfile = await createNextBrowserProfile(output, runId);
    report.browserProfile.userDataDir = browserProfile.userDataDir;
    report.browserProfile.launchAttempted = true;
    report.browserProfile.browserProcess.status = 'launching';
    let browser;
    let page;
    let server;
    const cleanupRuntime = async () => {
      let cleanupError;
      let serverStopped = null;
      try {
        if (server) {
          await server.stop();
          serverStopped = true;
        }
      } catch (error) {
        serverStopped = false;
        report.browserProfile.serverStopError = error.message;
        cleanupError = error;
      }

      let browserClosed = null;
      try {
        if (browser) {
          await browser.close();
          browserClosed = true;
          report.browserProfile.browserProcess.status = 'closed';
        }
      } catch (error) {
        browserClosed = false;
        report.browserProfile.browserProcess.status = 'close-failed';
        report.browserProfile.closeError = error.message;
        cleanupError ??= error;
      }

      let userDataDirRemoved = false;
      try {
        const cleanup = await browserProfile.cleanup();
        userDataDirRemoved = cleanup.userDataDirRemoved;
      } catch (error) {
        report.browserProfile.profileCleanupError = error.message;
        cleanupError ??= error;
      }
      report.browserProfile.cleanup = {
        serverStopped,
        browserClosed,
        userDataDirRemoved,
      };
      return cleanupError;
    };

    try {
      browser = await puppeteer.launch({
        executablePath:
          process.env.PMS_NEXT_CHROMIUM ??
          process.env.PMS_CHROMIUM ??
          '/usr/local/bin/chromium',
        headless: true,
        userDataDir: browserProfile.userDataDir,
        args: ['--no-sandbox'],
      });
      report.browserProfile.browserProcess = {
        pid: browser.process()?.pid ?? null,
        status: 'running',
      };
      page = await browser.newPage();
    } catch (error) {
      report.browserProfile.browserProcess.status = browser
        ? 'initialization-failed'
        : 'launch-failed';
      report.browserProfile.launchError = error.message;
      await cleanupRuntime();
      throw error;
    }
    const warnings = [];
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type()))
        warnings.push(message.text());
    });
    page.on('pageerror', (error) => warnings.push(error.message));
    const readEvents = async () =>
      (await fs.readFile(path.join(app, 'host-events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    const canonical = async () => {
      const hashes = Object.fromEntries(
        await Promise.all(
          [
            'design.js',
            'design.d.ts',
            'manifest.json',
            'styles.css',
            'artifacts.json',
          ].map(async (file) => [
            file,
            createHash('sha256')
              .update(await fs.readFile(path.join(app, '.pandamstyle', file)))
              .digest('hex'),
          ]),
        ),
      );
      const metadata = JSON.parse(
        await fs.readFile(
          path.join(app, '.pandamstyle/artifacts.json'),
          'utf8',
        ),
      );
      for (const member of Object.values(metadata.artifacts))
        assert.equal(hashes[member.file], member.sha256);
      const manifest = JSON.parse(
        await fs.readFile(path.join(app, '.pandamstyle/manifest.json'), 'utf8'),
      );
      assert.equal(manifest.registryDigest, metadata.registryDigest);
      return hashes;
    };
    const start = async (
      mode,
      label,
      runtime = process.execPath,
      { nodeArgs = [], expectedStatus = 200 } = {},
    ) => {
      const socket = net.createServer();
      await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise((resolve) => socket.close(resolve));
      const child = spawn(
        runtime,
        [
          ...nodeArgs,
          'node_modules/next/dist/bin/next',
          mode,
          ...(mode === 'dev' ? ['--webpack'] : []),
          '-p',
          String(port),
          '-H',
          '127.0.0.1',
        ],
        { cwd: app, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let log = '',
        readyAt;
      child.stdout.on('data', (value) => {
        log += value;
        if (readyAt == null && /Ready in/.test(log))
          readyAt = performance.now();
      });
      child.stderr.on('data', (value) => {
        log += value;
      });
      const ended = new Promise((resolve) => child.on('close', resolve));
      const began = performance.now();
      const url = `http://localhost:${port}`;
      const stop = async () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* exited */
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }, 10000);
        await ended;
        clearTimeout(timer);
        await write(output, `${label}.log`, log);
      };
      try {
        await until(async () => {
          try {
            return (
              (await fetch(url, { signal: AbortSignal.timeout(10000) }))
                .status === expectedStatus
            );
          } catch {
            return false;
          }
        }, label);
      } catch (error) {
        await stop();
        throw error;
      }
      return {
        url,
        readyMs: performance.now() - began,
        pid: child.pid,
        coldReadyMs: readyAt == null ? null : readyAt - began,
        firstRelevantCompilationMs:
          readyAt == null ? null : performance.now() - readyAt,
        stop,
      };
    };
    let cleanupError;
    try {
      server = await start('start', 'production-server');
      const response = await fetch(server.url);
      const html = await response.text();
      assert.equal(response.headers.get('x-config-composed'), 'yes');
      assert.match(html, /id="server-style"[^>]*class=/);
      await page.goto(server.url);
      await page.waitForSelector('#client-style');
      assert.deepEqual(await styles(), {
        padding: '16px',
        color: 'rgb(17, 34, 51)',
        opacity: '0.5',
        serverOpacity: '1',
      });
      await page.click('#client-style');
      await page.waitForFunction(() =>
        document.querySelector('#client-style').textContent.includes('loud'),
      );
      assert.equal((await styles()).opacity, '1');
      await page.click('#navigate');
      await page.waitForSelector('#route-id');
      assert.equal(
        await page.$eval('#route-id', (node) => node.textContent),
        'item',
      );
      assert.equal(
        await page.$eval('#nested', (node) => getComputedStyle(node).margin),
        '8px',
      );
      assert.equal((await fetch(server.url + '/absent')).status, 404);
      assert.deepEqual(
        warnings.filter((value) =>
          /hydrat|did not match|server rendered/i.test(value),
        ),
        [],
      );
      report.ssrHydrationNavigation = {
        pass: true,
        styledSSR: true,
        clientRecipeSelection: true,
        serverClientComposition: true,
        nestedDynamicRoute: true,
        notFound: true,
        unrelatedHeadersPreserved: true,
        warnings,
      };
      await server.stop();
      server = null;
      for (let sample = 0; sample < 2; sample++) {
        const repeated = await run(
          app,
          process.execPath,
          ['node_modules/next/dist/bin/next', 'build', '--webpack'],
          `production-repeat-${sample}`,
        );
        report.production.push({
          case: 'repeat-cache',
          sample,
          ms: repeated.ms,
          code: repeated.code,
        });
        assert.equal(repeated.code, 0, repeated.text);
      }
      const minimumNode = path.join(app, 'node_modules/node22-next/bin/node');
      const nodeVersion = await run(
        app,
        minimumNode,
        ['--version'],
        'minimum-node-version',
      );
      assert.equal(nodeVersion.text.trim(), 'v22.12.0');
      const minimumBuild = await run(
        app,
        minimumNode,
        ['node_modules/next/dist/bin/next', 'build', '--webpack'],
        'minimum-node-build',
      );
      assert.equal(minimumBuild.code, 0, minimumBuild.text);
      report.nodeBoundary = {
        minimum: '22.12.0',
        current: process.version,
        production: 'passed',
        ms: minimumBuild.ms,
        dev: 'not independently qualified on minimum Node',
      };
      const previous = await canonical();
      const originalPage = await fs.readFile(
        path.join(app, 'app/page.jsx'),
        'utf8',
      );
      await write(
        app,
        'app/page.jsx',
        originalPage.replace(
          'return <main>',
          "throw new Error('controlled-prerender-failure'); return <main>",
        ),
      );
      const failed = await run(
        app,
        process.execPath,
        ['node_modules/next/dist/bin/next', 'build', '--webpack'],
        'production-prerender-failure',
      );
      assert.notEqual(failed.code, 0);
      assert.deepEqual(await canonical(), previous);
      report.production.push({
        case: 'prerender-failure',
        code: failed.code,
        previousGenerationRetained: true,
      });
      await write(app, 'app/page.jsx', originalPage);
      report.failures = [];
      await write(
        app,
        'app/page.jsx',
        "import { useState } from 'react';\n" +
          originalPage.replace('return <main>', 'useState(0); return <main>'),
      );
      const frameworkFailure = await run(
        app,
        process.execPath,
        ['node_modules/next/dist/bin/next', 'build', '--webpack'],
        'failure-framework-rsc',
      );
      assert.notEqual(frameworkFailure.code, 0);
      assert.match(frameworkFailure.text, /useState/);
      assert.deepEqual(await canonical(), previous);
      report.failures.push({
        case: 'framework-rsc-compilation',
        pass: true,
        previousFiveFileSetRetained: true,
      });
      await write(app, 'app/page.jsx', originalPage);
      const emitFailure = await run(
        app,
        process.execPath,
        ['node_modules/next/dist/bin/next', 'build', '--webpack'],
        'failure-webpack-emit',
        { PMS_NEXT_FIXTURE_EMIT_FAILURE: '1' },
      );
      assert.notEqual(emitFailure.code, 0);
      assert.match(emitFailure.text, /PMS_INJECTED_WEBPACK_EMIT/);
      assert.deepEqual(await canonical(), previous);
      report.failures.push({
        case: 'bundle-emit',
        pass: true,
        previousFiveFileSetRetained: true,
      });
      const resolution = await run(
        app,
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "process.stdout.write(import.meta.resolve('@pandamstyle/compiler/host'))",
        ],
        'public-host-resolution',
      );
      assert.equal(resolution.code, 0, resolution.text);
      for (const kind of [
        'prepare',
        'commit',
        'prepared-mutation',
        'transform',
      ]) {
        const faultSource = path.join(app, 'app/shared.jsx');
        const faultOriginal = await fs.readFile(faultSource, 'utf8');
        await fs.writeFile(
          faultSource,
          faultOriginal + `\n// force exact input for ${kind}\n`,
        );
        const target = resolution.text.trim();
        const changed =
          kind === 'prepare'
            ? "async preparePublication() { throw new Error('PMS_INJECTED_PREPARE'); }"
            : kind === 'commit'
              ? "async commitPrepared() { throw new Error('PMS_INJECTED_COMMIT'); }"
              : kind === 'transform'
                ? "async readArtifact() { throw new Error('PMS_INJECTED_TRANSFORM'); }"
                : `async preparePublication(revision) {
              const ticket = await bridge.preparePublication(revision);
              const current = await project.current();
              const source = await fs.readFile(${JSON.stringify(path.join(app, 'app/shared.jsx'))}, 'utf8');
              await project.applyChanges({ baseRevision: current.revision, mode: 'verified-explicit', changed: ['app/shared.jsx'], added: [], removed: [], renamed: [], sourceOverlays: [{ file: 'app/shared.jsx', source: source + '\\n// prepared mutation' }] });
              return ticket;
            }`;
        const wrapper = `import { createHostBridge as original } from ${JSON.stringify(target)};
import fs from 'node:fs/promises';
export function createHostBridge(project) { const bridge = original(project); return Object.freeze({ ...bridge, ${changed} }); }`;
        const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@pandamstyle/compiler/host') return { url: 'pandamstyle-test:host', shortCircuit: true };
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url === 'pandamstyle-test:host') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(wrapper)} };
  return nextLoad(url, context);
}`;
        await write(app, 'fault-loader.mjs', hook);
        const before = await canonical();
        const result = await run(
          app,
          process.execPath,
          [
            '--experimental-loader',
            './fault-loader.mjs',
            'node_modules/next/dist/bin/next',
            'build',
            '--webpack',
          ],
          `failure-${kind}`,
        );
        assert.notEqual(result.code, 0, `${kind} unexpectedly succeeded`);
        assert.deepEqual(await canonical(), before);
        if (kind === 'prepared-mutation')
          assert.match(result.text, /PMS_STALE_REVISION|PMS_STALE_PUBLICATION/);
        report.failures.push({
          case: kind,
          pass: true,
          code: result.code,
          previousFiveFileSetRetained: true,
        });
        await fs.writeFile(faultSource, faultOriginal);
      }
      await fs.unlink(path.join(app, 'fault-loader.mjs'));
      for (const kind of [
        'prepare',
        'commit',
        'prepared-mutation',
        'close-prepared',
      ]) {
        const active = path.join(app, '.dev-fault-active');
        const original = await fs.readFile(
          path.join(app, 'app/shared.jsx'),
          'utf8',
        );
        const guarded =
          kind === 'prepare'
            ? `async preparePublication(revision) { if (fs.existsSync(${JSON.stringify(active)})) throw new Error('PMS_INJECTED_DEV_PREPARE'); return bridge.preparePublication(revision); }`
            : kind === 'commit' || kind === 'close-prepared'
              ? `async commitPrepared(ticket) { if (fs.existsSync(${JSON.stringify(active)})) throw new Error('PMS_INJECTED_DEV_COMMIT'); return bridge.commitPrepared(ticket); }`
              : `async preparePublication(revision) {
              if (!fs.existsSync(${JSON.stringify(active)})) return bridge.preparePublication(revision);
              if (injected) throw new Error('PMS_INJECTED_DEV_PREPARED_ACTIVE');
              injected = true;
              const ticket = await bridge.preparePublication(revision);
              const current = await project.current();
              await project.applyChanges({ baseRevision: current.revision, mode: 'verified-explicit', changed: ['app/shared.jsx'], added: [], removed: [], renamed: [], sourceOverlays: [{ file: 'app/shared.jsx', source: ${JSON.stringify(original + '\n// dev prepared mutation')} }] });
              return ticket;
            }`;
        const wrapper = `import { createHostBridge as real } from ${JSON.stringify(resolution.text.trim())};
import fs from 'node:fs';
export function createHostBridge(project) { const bridge = real(project); let injected = false; return Object.freeze({ ...bridge, ${guarded} }); }`;
        await write(
          app,
          'dev-fault-loader.mjs',
          `export async function resolve(specifier, context, nextResolve) {
 if (specifier === '@pandamstyle/compiler/host') return { url: 'pandamstyle-test:dev-host', shortCircuit: true };
 return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
 if (url === 'pandamstyle-test:dev-host') return { format: 'module', shortCircuit: true, source: ${JSON.stringify(wrapper)} };
 return nextLoad(url, context);
}`,
        );
        await fs.writeFile(active, kind);
        const before = await canonical();
        const count = (await readEvents()).length;
        server = await start('dev', `dev-failure-${kind}`, process.execPath, {
          nodeArgs: ['--experimental-loader', './dev-fault-loader.mjs'],
          expectedStatus: 500,
        });
        assert.deepEqual(await canonical(), before);
        const failureEvents = (await readEvents()).slice(count);
        assert(
          failureEvents.some((event) => event.type === 'publication-error'),
          `${kind}: dev publication error missing`,
        );
        if (kind === 'close-prepared') {
          assert(failureEvents.some((event) => event.type === 'prepared'));
          await server.stop();
          server = null;
          assert.deepEqual(await canonical(), before);
        }
        await fs.unlink(active);
        await write(
          app,
          'app/shared.jsx',
          original + `\n// repair dev ${kind}\n`,
        );
        if (server == null)
          server = await start('dev', 'dev-close-prepared-restart');
        const faultServerUrl = server.url;
        await until(
          async () =>
            (
              await fetch(faultServerUrl, {
                signal: AbortSignal.timeout(10000),
              })
            ).status === 200,
          `dev-${kind}-repair`,
        );
        await until(
          async () =>
            (await readEvents())
              .slice(count)
              .some((event) => event.type === 'committed'),
          `dev-${kind}-commit`,
        );
        await canonical();
        await server.stop();
        server = null;
        await fs.unlink(path.join(app, 'dev-fault-loader.mjs'));
        await write(app, 'app/shared.jsx', original);
        report.failures.push({
          case: `dev-${kind}-repair`,
          pass: true,
          previousFiveFileSetRetained: true,
          watcherRecoveryOrRestart:
            kind === 'close-prepared' ? 'restart' : 'same server',
          events: failureEvents,
        });
      }
      server = await start('dev', 'dev-server');
      const devUrl = server.url;
      report.dev.push({
        case: 'startup',
        readyAndFirstCompilationMs: server.readyMs,
        coldReadyMs: server.coldReadyMs,
        firstRelevantCompilationMs: server.firstRelevantCompilationMs,
        pid: server.pid,
      });
      await page.goto(server.url);
      const sourceFile = 'app/shared.jsx';
      const original = await fs.readFile(path.join(app, sourceFile), 'utf8');
      for (const opacity of [0.33, 0.77]) {
        const began = performance.now();
        const wallStart = Date.now();
        await page.evaluate(() => {
          globalThis.__pmsRefreshProbe = 'retained';
        });
        const count = (await readEvents()).length;
        await write(
          app,
          sourceFile,
          original.replace(
            "display: 'block'",
            `display: 'block', opacity: ${opacity}`,
          ),
        );
        await until(
          async () => (await styles()).serverOpacity === String(opacity),
          'style-edit',
        );
        const rule = `opacity:${String(opacity).replace(/^0/, '')}`;
        await until(
          async () =>
            (
              await fs.readFile(
                path.join(app, '.pandamstyle/styles.css'),
                'utf8',
              )
            ).includes(rule),
          'canonical-css',
        );
        const css = await fs.readFile(
          path.join(app, '.pandamstyle/styles.css'),
          'utf8',
        );
        if (opacity === 0.77) assert(!css.includes('opacity:.33'));
        const observations = (await readEvents()).slice(count);
        const diagnostic = observations.find(
          (event) => event.type === 'diagnostics',
        );
        report.dev.push({
          case: 'style-edit',
          opacity,
          settledMs: performance.now() - began,
          diagnosticsMs:
            diagnostic == null ? null : diagnostic.observedAt - wallStart,
          refresh: (await page.evaluate(
            () => globalThis.__pmsRefreshProbe === 'retained',
          ))
            ? 'RSC/Fast Refresh without document reload'
            : 'full reload',
          events: observations,
          staleRuleRemoved: opacity === 0.77,
        });
      }
      const valid = await fs.readFile(path.join(app, sourceFile), 'utf8');
      for (const [name, invalid] of [
        [
          'invalid-pandamstyle',
          valid.replace("token('colors.text')", "token('colors.absent')"),
        ],
        ['unresolved-import', "import missing from './absent';\n" + valid],
      ]) {
        const previous = await canonical();
        const eventCount = (await readEvents()).length;
        const began = performance.now();
        await write(app, sourceFile, invalid);
        await until(async () => (await fetch(devUrl)).status === 500, name);
        assert.deepEqual(await canonical(), previous);
        const diagnostics = (await readEvents())
          .slice(eventCount)
          .filter(
            (event) =>
              event.type === 'structured-diagnostics' && !event.result.ok,
          );
        assert(diagnostics.length > 0, `${name}: structured protocol missing`);
        await write(app, sourceFile, valid);
        await until(
          async () => (await fetch(devUrl)).status === 200,
          name + '-repair',
        );
        await page.goto(server.url);
        assert.equal((await styles()).serverOpacity, '0.77');
        report.dev.push({
          case: name + '-repair',
          ms: performance.now() - began,
          previousGenerationRetained: true,
          structuredDiagnostics: diagnostics.map((item) => item.result),
        });
      }
      const mutation = async (name, action, sample) => {
        const count = (await readEvents()).length;
        const began = performance.now();
        await action();
        await until(async () => {
          // A cached HTTP 200 alone cannot prove that the edit compiled.
          void fetch(server.url, { signal: AbortSignal.timeout(5000) }).catch(
            () => {},
          );
          return (await readEvents())
            .slice(count)
            .some((event) => event.type === 'committed');
        }, name + '-publication');
        await until(
          async () =>
            (await fetch(server.url, { signal: AbortSignal.timeout(5000) }))
              .status === 200,
          name,
        );
        await canonical();
        report.dev.push({
          case: name,
          sample,
          ms: performance.now() - began,
          events: (await readEvents()).slice(count),
          pass: true,
        });
      };
      for (const sample of [0, 1]) {
        const broker = `broker-${sample}`;
        const renamed = `renamed-${sample}`;
        await mutation(
          'add',
          () =>
            write(
              app,
              `app/${broker}.jsx`,
              "export { default } from './shared';\n",
            ),
          sample,
        );
        await mutation(
          'import-edit',
          () =>
            write(
              app,
              'app/page.jsx',
              originalPage.replace("'./shared'", `'./${broker}'`),
            ),
          sample,
        );
        await mutation(
          'reexport-edit',
          () =>
            write(
              app,
              `app/${broker}.jsx`,
              "export { default } from './shared.jsx';\n",
            ),
          sample,
        );
        await mutation(
          'rename',
          async () => {
            await fs.rename(
              path.join(app, `app/${broker}.jsx`),
              path.join(app, `app/${renamed}.jsx`),
            );
            await write(
              app,
              'app/page.jsx',
              originalPage.replace("'./shared'", `'./${renamed}'`),
            );
          },
          sample,
        );
        await mutation(
          'import-repair',
          () => write(app, 'app/page.jsx', originalPage),
          sample,
        );
        await mutation(
          'delete',
          () => fs.unlink(path.join(app, `app/${renamed}.jsx`)),
          sample,
        );
      }
      const definitionFile = path.join(app, 'definition.mjs');
      const definition = await fs.readFile(definitionFile, 'utf8');
      // Start this live-refresh case on a settled document. Navigating during
      // compilation tests a different framework race, not active-page HMR.
      await page.goto(server.url);
      assert.equal((await styles()).color, 'rgb(17, 34, 51)');
      const began = performance.now();
      await fs.writeFile(
        definitionFile,
        definition.replace('#112233', '#224466'),
      );
      await until(async () => {
        report.definitionObservation = await styles();
        return report.definitionObservation.color === 'rgb(34, 68, 102)';
      }, 'definition-refresh');
      await until(
        async () =>
          (
            await fs.readFile(path.join(app, '.pandamstyle/styles.css'), 'utf8')
          ).includes('#224466'),
        'definition-canonical-css',
      );
      report.dev.push({
        case: 'definition-mutation',
        ms: performance.now() - began,
        pass: true,
      });
      await server.stop();
      server = null;
      const afterDefinition = await run(
        app,
        process.execPath,
        ['node_modules/next/dist/bin/next', 'build', '--webpack'],
        'production-after-definition',
      );
      assert.equal(afterDefinition.code, 0, afterDefinition.text);
      report.production.push({
        case: 'source-and-definition-cache-invalidation',
        code: 0,
        ms: afterDefinition.ms,
      });
      server = await start('start', 'production-after-definition-server');
      await page.goto(server.url);
      assert.equal((await styles()).color, 'rgb(34, 68, 102)');
      assert.equal((await styles()).serverOpacity, '0.77');
      await server.stop();
      server = null;
      server = await start('dev', 'minimum-node-dev', minimumNode);
      await page.goto(server.url);
      assert.equal((await styles()).color, 'rgb(34, 68, 102)');
      report.nodeBoundary.dev = 'startup/render passed';
      report.dev.push({
        case: 'minimum-node-dev',
        node: '22.12.0',
        ms: server.readyMs,
      });
      await server.stop();
      server = null;
      server = await start('dev', 'dev-restart');
      await page.goto(server.url);
      assert.equal((await styles()).color, 'rgb(34, 68, 102)');
      report.dev.push({
        case: 'restart-cache',
        readyAndFirstCompilationMs: server.readyMs,
        pass: true,
      });
      await server.stop();
      server = null;
      const bundles = [];
      const walk = async (root) => {
        for (const item of await fs.readdir(root, { withFileTypes: true })) {
          const target = path.join(root, item.name);
          if (item.isDirectory()) await walk(target);
          else if (/\.js$/.test(item.name)) bundles.push(target);
        }
      };
      await walk(path.join(app, '.next/static'));
      await walk(path.join(app, '.next/dev/static'));
      const { parse } = resolve('@babel/parser');
      const forbidden =
        /@pandamstyle\/(compiler|vite|next|rsbuild)|@babel\/|@stylexjs\/|@pandacss\//;
      const leakage = [];
      const diagnosticReferences = [];
      const inspectCode = (code, file, depth = 0) => {
        assert(depth < 8, 'unexpected nested executable eval depth');
        const ast = parse(code, { sourceType: 'unambiguous' });
        const visit = (node) => {
          if (node == null || typeof node !== 'object') return;
          if (
            node.type === 'Identifier' &&
            ['createProjectSession', 'preparePublication'].includes(node.name)
          )
            leakage.push({ file, identifier: node.name });
          if (
            [
              'ImportDeclaration',
              'ExportNamedDeclaration',
              'ExportAllDeclaration',
            ].includes(node.type) &&
            typeof node.source?.value === 'string' &&
            (forbidden.test(node.source.value) || isBuiltin(node.source.value))
          )
            leakage.push({ file, import: node.source.value });
          if (
            node.type === 'CallExpression' &&
            node.callee.type === 'Identifier'
          ) {
            const name = node.callee.name;
            if (name === 'eval' && node.arguments[0]?.type === 'StringLiteral')
              inspectCode(node.arguments[0].value, file, depth + 1);
            if (['require', '__webpack_require__'].includes(name)) {
              const value = node.arguments[0]?.value;
              if (
                typeof value === 'string' &&
                (forbidden.test(value) || isBuiltin(value))
              )
                leakage.push({ file, runtimeRequire: value });
            }
          }
          for (const [key, value] of Object.entries(node)) {
            if (
              [
                'comments',
                'leadingComments',
                'trailingComments',
                'innerComments',
                'loc',
                'extra',
              ].includes(key)
            )
              continue;
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
          }
        };
        visit(ast.program);
      };
      for (const file of bundles) {
        const code = await fs.readFile(file, 'utf8');
        const relative = path.relative(app, file);
        const labels =
          code.match(
            /@pandamstyle\/(?:compiler|vite|next|rsbuild)|node:(?:fs|path|crypto)/g,
          ) ?? [];
        if (labels.length > 0)
          diagnosticReferences.push({
            file: relative,
            references: labels.length,
          });
        inspectCode(code, relative);
      }
      assert.deepEqual(leakage, []);
      const moduleAudits = (await readEvents()).filter(
        (event) => event.type === 'fixture-client-module-audit',
      );
      assert(moduleAudits.length > 0);
      for (const audit of moduleAudits)
        assert.deepEqual(audit.forbiddenResources, []);
      report.bundleScan = {
        pass: true,
        files: bundles.length,
        leakage,
        moduleAudits,
        diagnosticReferences,
        note: 'Executable AST scan includes webpack eval bodies; public webpack module-resource audit excludes loader names from resource identity. Core comments and Next diagnostic strings are references, not imported build code.',
      };
      report.canonical = await canonical();
      report.events = await readEvents();
      report.authority = {
        owners: report.events
          .filter((event) => event.type === 'initialized')
          .map((event) => ({ pid: event.pid, revision: event.revision })),
        transport:
          'in-process public webpack loader; compilation workers rejected; prerender children receive compiled runtime only',
      };
      report.turbopack = {
        pass: false,
        status: 'not-yet-run',
        contract: 'explicit semantic-dev plus independent strict production',
      };
    } finally {
      cleanupError = await cleanupRuntime();
    }
    if (cleanupError) {
      throw cleanupError;
    }
    async function styles() {
      return page.evaluate(() => ({
        padding: getComputedStyle(document.querySelector('#server-style'))
          .padding,
        color: getComputedStyle(document.querySelector('#server-style')).color,
        opacity: getComputedStyle(document.querySelector('#client-style'))
          .opacity,
        serverOpacity: getComputedStyle(document.querySelector('#server-style'))
          .opacity,
      }));
    }
  }

  async function until(predicate, label) {
    const deadline = performance.now() + 45000;
    let last;
    while (performance.now() < deadline) {
      try {
        if (await predicate()) return;
      } catch (error) {
        last = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Timeout: ${label}${last ? ': ' + last.message : ''}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
