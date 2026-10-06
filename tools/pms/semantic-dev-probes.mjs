/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/** Isolated public Next/Turbopack feasibility probes; these are not package qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

async function main() {
  const output = path.resolve(
    process.argv[2] ?? 'evidence/phase-10-next/semantic-dev/probes/node22',
  );
  const app = process.argv[3]
    ? path.resolve(process.argv[3])
    : await fs.mkdtemp(path.join(os.tmpdir(), 'pms-semantic-dev-probes-'));
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const report = {
    scope: 'isolated-public-next-turbopack-feasibility',
    packageQualification: false,
    app,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    startedAt: new Date().toISOString(),
    scenarios: [],
    launches: [],
    mutations: [],
    dependencies: {},
    snapshots: {},
    pass: false,
  };
  const environment = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' };
  delete environment.NODE_PATH;
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(app, { recursive: true });
  async function write(file, bytes) {
    const target = path.join(app, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    const digest = sha(bytes);
    await fs.mkdir(path.join(output, 'input-bytes'), { recursive: true });
    await fs.writeFile(path.join(output, 'input-bytes', digest), bytes);
    report.mutations.push({
      file,
      sha256: digest,
      exactBytes: 'input-bytes/' + digest,
      at: Date.now(),
    });
  }
  async function save() {
    await fs.writeFile(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  async function run(command, args, label) {
    const child = spawn(command, args, {
      cwd: app,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (bytes) => {
      log += bytes;
    });
    child.stderr.on('data', (bytes) => {
      log += bytes;
    });
    const start = Date.now();
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    await fs.writeFile(path.join(output, label + '.log'), log);
    return { command: [command, ...args], code, ms: Date.now() - start, log };
  }
  async function until(fn, description, timeout = 40000) {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
      try {
        last = await fn();
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Observed condition timed out: ${description}; last=${JSON.stringify(last)}`,
    );
  }
  async function scenario(name, fn) {
    const start = Date.now();
    try {
      const observations = await fn();
      report.scenarios.push({
        name,
        status: 'PASS',
        ms: Date.now() - start,
        observations,
      });
      process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
      report.scenarios.push({
        name,
        status: 'FAIL',
        ms: Date.now() - start,
        error: error.stack,
      });
      process.stdout.write(`FAIL ${name}: ${error.message}\n`);
    }
    await save();
  }
  const loaderSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const sha = value => createHash('sha256').update(value).digest('hex');
module.exports = function publicProbeLoader(source) {
  const callback = this.async();
  const options = this.getOptions();
  const root = options.root;
  const file = this.resourcePath;
  const inputHash = sha(source);
  const requestId = randomUUID();
  const statusFile = path.join(root, 'probe-status.json');
  const context = path.join(root, 'probe-context');
  const dependencies = [statusFile, path.join(root, 'probe-config.json')];
  for (const dependency of dependencies) this.addDependency(dependency);
  this.addContextDependency(context);
  const log = event => fs.appendFileSync(path.join(root, 'loader-events.jsonl'), JSON.stringify({ at: Date.now(), pid: process.pid, file: path.relative(root, file), requestId, inputHash, dependencies, context, ...event }) + '\n');
  log({ type: 'invocation-start' });
  const work = async () => {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const config = JSON.parse(fs.readFileSync(dependencies[1], 'utf8'));
    const files = fs.readdirSync(context).sort();
    if (source.includes('PMS_DELAY_OLD')) {
      log({ type: 'controlled-race-delay', delayMs: 1100 });
      await new Promise(resolve => setTimeout(resolve, 1100));
      if (sha(fs.readFileSync(file)) !== inputHash) throw new Error('PMS_PROBE_STALE_INPUT');
    }
    if (status.fail) throw new Error('PMS_PROBE_STATUS_INVALID');
    if (source.includes('PMS_TRANSFORM_ERROR')) throw new Error('PMS_PROBE_TRANSFORM_INVALID');
    let result = source;
    const selected = status.selected;
    const cssSelected = status.mixedCss ?? selected;
    const relative = target => './' + path.relative(path.dirname(file), target).split(path.sep).join('/');
    if (result.includes('@probe/snapshot')) {
      result = result.replaceAll('@probe/snapshot', relative(path.join(root, 'snapshots', selected, 'design.js')));
      // A single descriptor selects JS/CSS. mixedCss exists solely for the negative control.
      result += '\nimport ' + JSON.stringify(relative(path.join(root, 'snapshots', cssSelected, 'styles.css'))) + ';\n';
    }
    result = result.replaceAll('__PMS_STATUS__', JSON.stringify(status.label))
      .replaceAll('__PMS_CONTEXT__', JSON.stringify(files.join(',')))
      .replaceAll('__PMS_CONFIG__', JSON.stringify(config.label))
      .replaceAll('__PMS_SESSION__', JSON.stringify(status.session));
    log({ type: 'callback-success', selected, cssSelected, session: status.session, statusHash: sha(fs.readFileSync(statusFile)), contextFiles: files, outputHash: sha(result) });
    callback(null, result);
  };
  work().catch(error => { log({ type: 'callback-error', error: error.message }); callback(error); });
};
`;
  const serverSource = (
    label,
  ) => `import { snapshot, className } from '@probe/snapshot';
export default function Server() { return <p id="server" className={className} data-snapshot={snapshot} data-status={__PMS_STATUS__} data-context={__PMS_CONTEXT__} data-config={__PMS_CONFIG__} data-session={__PMS_SESSION__}>${label}</p>; }
`;
  const clientSource = (label) => `'use client';
import { useState } from 'react';
import Link from 'next/link';
import { snapshot, className } from '@probe/snapshot';
export default function Client() {
  const [count, setCount] = useState(0);
  const [Lazy, setLazy] = useState(null);
  return <section><button id="counter" className={className} data-snapshot={snapshot} data-status={__PMS_STATUS__} data-context={__PMS_CONTEXT__} data-config={__PMS_CONFIG__} data-session={__PMS_SESSION__} onClick={() => setCount(count + 1)}>${label} {count}</button>
  <button id="show-dynamic" onClick={async () => { const loaded = await import('./dynamic.jsx'); setLazy(() => loaded.default); }}>show dynamic</button>{Lazy && <Lazy />}
  <Link id="lazy-link" href="/lazy" prefetch={false}>lazy route</Link></section>;
}
`;
  let status = {
    selected: 'A',
    label: 'initial',
    fail: false,
    session: randomUUID(),
  };
  async function select(patch) {
    status = { ...status, ...patch };
    const temp = path.join(app, 'probe-status.next');
    await fs.writeFile(temp, JSON.stringify(status));
    await fs.rename(temp, path.join(app, 'probe-status.json'));
    const bytes = JSON.stringify(status);
    await fs.mkdir(path.join(output, 'input-bytes'), { recursive: true });
    await fs.writeFile(path.join(output, 'input-bytes', sha(bytes)), bytes);
    report.mutations.push({
      file: 'probe-status.json',
      sha256: sha(bytes),
      exactBytes: 'input-bytes/' + sha(bytes),
      value: status,
      at: Date.now(),
    });
  }
  let nextProcess;
  let browser;
  let page;
  let oldPage;
  let port;
  async function getPort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const number = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return number;
  }
  async function launch(label, node = process.execPath) {
    const command = [
      node,
      path.join(app, 'node_modules/next/dist/bin/next'),
      'dev',
      '--turbopack',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ];
    nextProcess = spawn(command[0], command.slice(1), {
      cwd: app,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logPath = path.join(output, label + '.log');
    const log = fs.open(logPath, 'w');
    nextProcess.stdout.on('data', async (bytes) => (await log).write(bytes));
    nextProcess.stderr.on('data', async (bytes) => (await log).write(bytes));
    nextProcess.once('close', async () => (await log).close());
    report.launches.push({
      label,
      command,
      pid: nextProcess.pid,
      session: status.session,
      at: Date.now(),
      cacheRetained: report.launches.length > 0,
    });
    await until(
      async () => {
        if (nextProcess.exitCode !== null)
          throw new Error('Next exited with ' + nextProcess.exitCode);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`, {
            signal: AbortSignal.timeout(2000),
          });
          return response.status === 200;
        } catch {
          return false;
        }
      },
      'public dev route ready',
      70000,
    );
  }
  async function stop(signal = 'SIGTERM') {
    if (!nextProcess || nextProcess.exitCode !== null) return;
    const child = nextProcess;
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      process.kill(-child.pid, signal);
    } catch {}
    await Promise.race([
      closed,
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      await closed;
    }
  }
  async function observe(target = page, selector = '#counter') {
    return target.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const css = getComputedStyle(element);
      return {
        text: element.textContent,
        snapshot: element.dataset.snapshot,
        status: element.dataset.status,
        context: element.dataset.context,
        config: element.dataset.config,
        session: element.dataset.session,
        className: element.className,
        color: css.color,
        background: css.backgroundColor,
        padding: css.padding,
        rootSnapshot: getComputedStyle(document.documentElement)
          .getPropertyValue('--probe-snapshot')
          .trim(),
        token: getComputedStyle(document.documentElement)
          .getPropertyValue('--probe-bg')
          .trim(),
        cssUrls: Array.from(document.styleSheets, (sheet) => sheet.href),
      };
    }, selector);
  }
  async function expect(patch, target = page, selector = '#counter') {
    return until(async () => {
      const seen = await observe(target, selector);
      return seen &&
        Object.entries(patch).every(([key, value]) => seen[key] === value)
        ? seen
        : false;
    }, JSON.stringify(patch));
  }
  async function cssResources(target = page) {
    const urls = (await observe(target)).cssUrls.filter(Boolean);
    return Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        const bytes = await response.text();
        const relative = `css-resource-${sha(bytes)}.css`;
        await fs.writeFile(path.join(output, relative), bytes);
        return {
          url,
          status: response.status,
          sha256: sha(bytes),
          evidence: relative,
        };
      }),
    );
  }
  async function events() {
    return (await fs.readFile(path.join(app, 'loader-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  async function http(route = '/') {
    const response = await fetch(`http://127.0.0.1:${port}${route}`);
    const text = await response.text();
    return { status: response.status, sha256: sha(text), text };
  }
  async function reloadHealthy(target = page) {
    await until(
      async () => (await http()).status === 200,
      'healthy route before full reload',
    );
    await target.bringToFront();
    try {
      await target.reload({ waitUntil: 'networkidle0' });
    } catch (error) {
      if (!error.message.includes('Not attached to an active page'))
        throw error;
      report.browserAutomationRetries ??= [];
      report.browserAutomationRetries.push({
        operation: 'Page.reload',
        error: error.message,
        action: 'public page navigation after concurrent Next reload',
        at: Date.now(),
      });
      await target.goto(`http://127.0.0.1:${port}`, {
        waitUntil: 'networkidle0',
      });
    }
  }
  async function mcp(method, params = {}, requestId = 1) {
    const response = await fetch(`http://127.0.0.1:${port}/_next/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      const line = body.split('\n').find((line) => line.startsWith('data: '));
      if (line) json = JSON.parse(line.slice(6));
    }
    return { status: response.status, body, json };
  }
  try {
    if (!process.argv[3]) {
      await write(
        'package.json',
        JSON.stringify({
          private: true,
          type: 'module',
          name: 'pms-isolated-turbopack-probe',
        }),
      );
      report.install = await run(
        'npm',
        [
          'install',
          '--save-exact',
          '--no-audit',
          '--no-fund',
          'next@16.3.8',
          'react@19.2.8',
          'react-dom@19.2.8',
          'puppeteer-core@25.9.0',
          'node20-probe@npm:node@20.9.0',
        ],
        'install',
      );
      assert.equal(report.install.code, 0, report.install.log);
      delete report.install.log;
    }
    const require = createRequire(path.join(app, 'package.json'));
    for (const name of [
      'next',
      'react',
      'react-dom',
      'puppeteer-core',
      'node20-probe',
    ]) {
      report.dependencies[name] = require(name + '/package.json').version;
    }
    assert.equal(report.dependencies.next, '16.3.8');
    assert.equal(report.dependencies.react, '19.2.8');
    assert.equal(report.dependencies['react-dom'], '19.2.8');
    const lock = await fs.readFile(path.join(app, 'package-lock.json'));
    report.lockSha256 = sha(lock);
    await fs.writeFile(path.join(output, 'package-lock.json'), lock);
    await write('probe-loader.cjs', loaderSource);
    await write('loader-events.jsonl', '');
    await write(
      'next.config.mjs',
      `import path from 'node:path';
export default { experimental: { cpus: 2 }, turbopack: { root: process.cwd(), rules: {
  '*.jsx': { loaders: [{ loader: path.join(process.cwd(), 'probe-loader.cjs'), options: { root: process.cwd() } }] }
} } };
`,
    );
    await fs.mkdir(path.join(app, 'probe-context'), { recursive: true });
    await write('probe-context/initial.txt', 'initial');
    await write(
      'probe-config.json',
      JSON.stringify({ label: 'config-initial' }),
    );
    await select({});
    for (const [id, color, bg, padding] of [
      ['A', 'rgb(190, 10, 20)', 'rgb(11, 22, 33)', '11px'],
      ['B', 'rgb(10, 150, 70)', 'rgb(44, 55, 66)', '23px'],
    ]) {
      const js = `export const snapshot = '${id}'; export const className = 'probe-${id.toLowerCase()}';\n`;
      const css = `:root { --probe-bg: ${bg}; --probe-snapshot: "${id}"; }\n.probe-${id.toLowerCase()} { color: ${color}; background-color: var(--probe-bg); padding: ${padding}; }\n`;
      await write(`snapshots/${id}/design.js`, js);
      await write(`snapshots/${id}/styles.css`, css);
      report.snapshots[id] = {
        js: sha(js),
        css: sha(css),
        color,
        background: bg,
        padding,
      };
    }
    await write(
      'semantic/RootShell.jsx',
      `import { snapshot, className } from '@probe/snapshot';
export default function RootShell({ children }) { return <html lang="en" data-snapshot={snapshot}><body><p id="outside-app" className={className} data-snapshot={snapshot}>outside app root</p>{children}</body></html>; }
`,
    );
    await write(
      'app/layout.jsx',
      `import RootShell from '../semantic/RootShell.jsx';
export default function Layout({ children }) { return <RootShell>{children}</RootShell>; }
`,
    );
    await write('app/server.jsx', serverSource('server-initial'));
    await write('app/client.jsx', clientSource('client-initial'));
    await write(
      'app/dynamic.jsx',
      `'use client';
import { snapshot, className } from '@probe/snapshot';
export default function Dynamic() { return <p id="dynamic" className={className} data-snapshot={snapshot}>dynamic {snapshot}</p>; }
`,
    );
    await write(
      'app/page.jsx',
      `import Server from './server.jsx'; import Client from './client.jsx';
export default function Page() { return <main><Server /><Client /></main>; }
`,
    );
    await write(
      'app/lazy/page.jsx',
      `import { snapshot, className } from '@probe/snapshot';
export default function Page() { return <main><p id="lazy" className={className} data-snapshot={snapshot}>lazy {snapshot}</p></main>; }
`,
    );
    port = await getPort();
    await launch('dev-first');
    const puppeteer = await import(
      pathToFileURL(require.resolve('puppeteer-core')).href
    );
    browser = await puppeteer.default.launch({
      executablePath: process.env.PMS_CHROMIUM ?? '/usr/local/bin/chromium',
      headless: true,
      protocolTimeout: 15000,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    report.browserVersion = await browser.version();
    page = await browser.newPage();
    const browserEvents = [];
    page.on('pageerror', (error) =>
      browserEvents.push({
        type: 'pageerror',
        message: error.message,
        at: Date.now(),
      }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        browserEvents.push({
          type: 'console-error',
          message: message.text(),
          at: Date.now(),
        });
    });
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle0' });
    await scenario('public-loader-client-and-rsc', async () => {
      const client = await expect({
        snapshot: 'A',
        color: report.snapshots.A.color,
      });
      const server = await expect(
        { snapshot: 'A', color: report.snapshots.A.color },
        page,
        '#server',
      );
      const invoked = await events();
      assert(
        invoked.some(
          (event) =>
            event.file === 'app/server.jsx' &&
            event.type === 'callback-success',
        ),
      );
      assert(
        invoked.some(
          (event) =>
            event.file === 'app/client.jsx' &&
            event.type === 'callback-success',
        ),
      );
      const outsideApp = await expect(
        { snapshot: 'A', color: report.snapshots.A.color },
        page,
        '#outside-app',
      );
      assert(
        invoked.some(
          (event) =>
            event.file === 'semantic/RootShell.jsx' &&
            event.type === 'callback-success',
        ),
      );
      return { client, server, outsideApp, css: await cssResources() };
    });
    await scenario('status-only-file-invalidation', async () => {
      const sourceHash = sha(
        await fs.readFile(path.join(app, 'app/client.jsx')),
      );
      await select({ label: 'status-only' });
      const seen = await expect({ status: 'status-only' });
      assert.equal(
        sha(await fs.readFile(path.join(app, 'app/client.jsx'))),
        sourceHash,
      );
      return { seen, unchangedSourceHash: sourceHash };
    });
    await scenario('failed-transform-status-dependency-repair', async () => {
      const sourceHash = sha(
        await fs.readFile(path.join(app, 'app/client.jsx')),
      );
      await select({ fail: true, label: 'status-invalid' });
      const response = await until(async () => {
        const seen = await http();
        return seen.status === 500 &&
          seen.text.includes('PMS_PROBE_STATUS_INVALID')
          ? seen
          : false;
      }, 'status invalid visible 500');
      await page.reload({ waitUntil: 'domcontentloaded' });
      const overlay = await page.evaluate(() => document.body.innerText);
      await select({ fail: false, label: 'status-repaired' });
      const repaired = await expect({ status: 'status-repaired' });
      assert.equal(
        sha(await fs.readFile(path.join(app, 'app/client.jsx'))),
        sourceHash,
      );
      return {
        errorStatus: response.status,
        errorBodyHash: response.sha256,
        overlay,
        repaired,
        unchangedSourceHash: sourceHash,
      };
    });
    await scenario('source-transform-error-repair', async () => {
      await write(
        'app/server.jsx',
        serverSource('server-error') + '\n// PMS_TRANSFORM_ERROR\n',
      );
      const error = await until(async () => {
        const r = await http();
        return r.status === 500 &&
          r.text.includes('PMS_PROBE_TRANSFORM_INVALID')
          ? r
          : false;
      }, 'transform error');
      await write('app/server.jsx', serverSource('server-repaired'));
      await reloadHealthy();
      const repaired = await expect(
        { text: 'server-repaired' },
        page,
        '#server',
      );
      return { errorStatus: error.status, repaired };
    });
    await scenario('source-syntax-error-repair', async () => {
      await write(
        'app/server.jsx',
        serverSource('server-syntax') + '\nconst broken = ;\n',
      );
      const error = await until(async () => {
        const r = await http();
        return r.status === 500 ? r : false;
      }, 'syntax error');
      await write('app/server.jsx', serverSource('server-syntax-repaired'));
      await reloadHealthy();
      return {
        errorStatus: error.status,
        repaired: await expect(
          { text: 'server-syntax-repaired' },
          page,
          '#server',
        ),
      };
    });
    await scenario('context-add-delete-invalidation', async () => {
      await write('probe-context/added.txt', 'added');
      const added = await expect({ context: 'added.txt,initial.txt' });
      await fs.unlink(path.join(app, 'probe-context/added.txt'));
      report.mutations.push({
        file: 'probe-context/added.txt',
        operation: 'delete',
        at: Date.now(),
      });
      const removed = await expect({ context: 'initial.txt' });
      return { added, removed };
    });
    await scenario('config-only-invalidation', async () => {
      await write(
        'probe-config.json',
        JSON.stringify({ label: 'config-warm' }),
      );
      return await expect({ config: 'config-warm' });
    });
    await scenario(
      'immutable-js-css-visible-edit-and-refresh-state',
      async () => {
        await page.bringToFront();
        await page.click('#counter');
        await expect({ text: 'client-initial 1' });
        oldPage = await browser.newPage();
        await oldPage.goto(`http://127.0.0.1:${port}`, {
          waitUntil: 'networkidle0',
        });
        await oldPage.setOfflineMode(true);
        const oldBefore = await expect(
          { snapshot: 'A', background: report.snapshots.A.background },
          oldPage,
        );
        await select({ selected: 'B', label: 'snapshot-B' });
        const updated = await expect({
          snapshot: 'B',
          color: report.snapshots.B.color,
          background: report.snapshots.B.background,
        });
        const oldAfter = await observe(oldPage);
        assert.equal(oldAfter.snapshot, 'A');
        assert.equal(oldAfter.background, report.snapshots.A.background);
        return {
          updated,
          statePreserved: updated.text === 'client-initial 1',
          oldBefore,
          oldAfter,
          css: await cssResources(),
        };
      },
    );
    await scenario('first-lazy-route-and-dynamic-client-import', async () => {
      await page.bringToFront();
      await page.click('#show-dynamic');
      const dynamic = await expect(
        {
          snapshot: 'B',
          color: report.snapshots.B.color,
          background: report.snapshots.B.background,
        },
        page,
        '#dynamic',
      );
      await page.click('#lazy-link');
      const lazy = await expect(
        {
          snapshot: 'B',
          color: report.snapshots.B.color,
          background: report.snapshots.B.background,
        },
        page,
        '#lazy',
      );
      await page.goto(`http://127.0.0.1:${port}`, {
        waitUntil: 'networkidle0',
      });
      return { dynamic, lazy };
    });
    await scenario(
      'old-tab-full-reload-and-immutable-member-integrity',
      async () => {
        await oldPage.setOfflineMode(false);
        await reloadHealthy(oldPage);
        const reloaded = await expect(
          {
            snapshot: 'B',
            color: report.snapshots.B.color,
            background: report.snapshots.B.background,
          },
          oldPage,
        );
        for (const id of ['A', 'B']) {
          assert.equal(
            sha(await fs.readFile(path.join(app, `snapshots/${id}/design.js`))),
            report.snapshots[id].js,
          );
          assert.equal(
            sha(
              await fs.readFile(path.join(app, `snapshots/${id}/styles.css`)),
            ),
            report.snapshots[id].css,
          );
        }
        return { reloaded, oldMembersUnchanged: true };
      },
    );
    await scenario(
      'intentional-mixed-js-css-negative-control-detected',
      async () => {
        await select({
          selected: 'B',
          mixedCss: 'A',
          label: 'negative-control',
        });
        await reloadHealthy();
        const seen = await expect({ snapshot: 'B', rootSnapshot: '"A"' });
        const mismatch =
          seen.background !== report.snapshots.B.background ||
          seen.color !== report.snapshots.B.color;
        assert(mismatch, 'mixed-pair negative control must visibly fail');
        const css = await cssResources();
        delete status.mixedCss;
        await select({ label: 'negative-control-repaired' });
        await reloadHealthy();
        await expect({
          snapshot: 'B',
          color: report.snapshots.B.color,
          background: report.snapshots.B.background,
        });
        return { seen, verifierDetectedMismatch: mismatch, css };
      },
    );
    await scenario('delayed-old-source-versus-new-source-race', async () => {
      await write(
        'app/server.jsx',
        serverSource('delayed-old') + '// PMS_DELAY_OLD\n',
      );
      const oldHash = sha(await fs.readFile(path.join(app, 'app/server.jsx')));
      const request = http();
      await until(
        async () =>
          (await events()).some(
            (event) =>
              event.inputHash === oldHash &&
              event.type === 'controlled-race-delay',
          ),
        'old loader invocation entered controlled delay',
      );
      await write('app/server.jsx', serverSource('rapid-new'));
      await request;
      await reloadHealthy();
      const seen = await expect({ text: 'rapid-new' }, page, '#server');
      const rejected = (await events()).filter(
        (event) =>
          event.inputHash === oldHash &&
          event.error === 'PMS_PROBE_STALE_INPUT',
      );
      assert(rejected.length > 0);
      return { oldHash, seen, staleCallbacks: rejected };
    });
    await scenario('mcp-public-discovery-and-route-diagnostics', async () => {
      const initialized = await mcp('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pms-isolated-probe', version: '1.0.0' },
      });
      const list = await mcp('tools/list', {}, 2);
      assert(list.json?.result?.tools?.length > 0, list.body);
      report.mcp = { initialized, tools: list.json.result.tools };
      const tools = list.json.result.tools;
      const observed = [];
      for (const name of [
        'compile_route',
        'get_compilation_issues',
        'get_errors',
      ]) {
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) {
          observed.push({ name, status: 'NOT EXPOSED' });
          continue;
        }
        let args = {};
        if (name === 'compile_route')
          args = tool.inputSchema?.properties?.path
            ? { path: '/' }
            : { routeSpecifier: '/' };
        observed.push({
          name,
          schema: tool.inputSchema,
          response: await mcp('tools/call', { name, arguments: args }, 3),
        });
      }
      await write(
        'app/mcp-broken/page.jsx',
        "import Missing from './missing-public-probe.jsx'; export default function Broken() { return <Missing />; }\n",
      );
      const routeDiscovery = await until(async () => {
        const result = await mcp(
          'tools/call',
          { name: 'get_routes', arguments: {} },
          4,
        );
        return result.body.includes('/mcp-broken') ? result : false;
      }, 'public MCP route discovery observes newly added unopened route');
      observed.push({
        name: 'get_routes',
        unvisitedBrokenRoute: true,
        response: routeDiscovery,
      });
      const graphTool = tools.find(
        (tool) => tool.name === 'get_compilation_issues',
      );
      if (graphTool) {
        const graphIssues = await until(async () => {
          const result = await mcp(
            'tools/call',
            { name: 'get_compilation_issues', arguments: {} },
            5,
          );
          return result.body.includes('missing-public-probe') ? result : false;
        }, 'whole-route module graph query detects unopened missing import');
        observed.push({
          name: 'get_compilation_issues',
          unvisitedBrokenRoute: true,
          response: graphIssues,
        });
      }
      for (const name of ['compile_route', 'get_compilation_issues']) {
        const tool = tools.find((tool) => tool.name === name);
        if (!tool) continue;
        const args =
          name === 'compile_route'
            ? tool.inputSchema?.properties?.path
              ? { path: '/mcp-broken' }
              : { routeSpecifier: '/mcp-broken' }
            : {};
        const result = await mcp('tools/call', { name, arguments: args }, 6);
        assert(
          result.body.includes('missing-public-probe'),
          `${name} must report actual missing-import issue: ${result.body}`,
        );
        observed.push({ name, unvisitedBrokenRoute: true, response: result });
      }
      await fs.rm(path.join(app, 'app/mcp-broken'), { recursive: true });
      return observed;
    });
    await scenario(
      'normal-stop-unchanged-restart-with-next-cache',
      async () => {
        const oldSession = status.session;
        await stop();
        assert((await fs.stat(path.join(app, '.next'))).isDirectory());
        await select({ session: randomUUID(), label: 'restart-unchanged' });
        await launch('dev-restart-unchanged');
        await reloadHealthy();
        const seen = await expect({ session: status.session, snapshot: 'B' });
        assert.notEqual(seen.session, oldSession);
        return {
          oldSession,
          newSession: status.session,
          seen,
          cacheRetained: true,
        };
      },
    );
    await scenario(
      'source-config-deletion-while-stopped-and-restart',
      async () => {
        await stop();
        await write('app/server.jsx', serverSource('edited-while-stopped'));
        await write(
          'probe-config.json',
          JSON.stringify({ label: 'config-while-stopped' }),
        );
        await fs.unlink(path.join(app, 'probe-context/initial.txt'));
        await fs.rename(
          path.join(app, 'app/lazy'),
          path.join(app, 'app/renamed'),
        );
        await select({
          session: randomUUID(),
          selected: 'A',
          label: 'restart-edits',
        });
        await launch('dev-restart-edits');
        await reloadHealthy();
        const seen = await expect({
          session: status.session,
          snapshot: 'A',
          config: 'config-while-stopped',
          context: '',
        });
        const server = await expect(
          { text: 'edited-while-stopped' },
          page,
          '#server',
        );
        const deleted = await http('/lazy');
        assert.equal(deleted.status, 404);
        const renamed = await http('/renamed');
        assert.equal(renamed.status, 200);
        return {
          seen,
          server,
          deletedRouteStatus: deleted.status,
          renamedRouteStatus: renamed.status,
          cacheRetained: true,
        };
      },
    );
    await scenario('crash-recovery-with-next-cache-new-session', async () => {
      const oldSession = status.session;
      await stop('SIGKILL');
      await write('app/server.jsx', serverSource('edited-after-crash'));
      await select({
        session: randomUUID(),
        selected: 'B',
        label: 'restart-crash',
      });
      await launch('dev-restart-crash');
      await reloadHealthy();
      const seen = await expect({
        session: status.session,
        snapshot: 'B',
        color: report.snapshots.B.color,
      });
      const server = await expect(
        { text: 'edited-after-crash' },
        page,
        '#server',
      );
      return { oldSession, seen, server, cacheRetained: true };
    });
    await scenario(
      'node20-public-cli-and-loader-restart-with-cache',
      async () => {
        await stop();
        await write(
          'next.config.mjs',
          `import path from 'node:path';
export default { experimental: { cpus: 2 }, turbopack: { root: process.cwd(), rules: {
  '*.jsx': { condition: { all: [{ not: 'foreign' }, { path: /^(app|semantic)\\// }] }, loaders: [{ loader: path.join(process.cwd(), 'probe-loader.cjs'), options: { root: process.cwd() } }] }
} } };\n`,
        );
        await select({ session: randomUUID(), label: 'node20-restart' });
        await launch(
          'dev-node20',
          path.join(app, 'node_modules/node20-probe/bin/node'),
        );
        await reloadHealthy();
        const seen = await expect({
          session: status.session,
          snapshot: 'B',
          color: report.snapshots.B.color,
        });
        return {
          node: report.dependencies['node20-probe'],
          seen,
          cacheRetained: true,
          publicConditionPath: '^(app|semantic)/',
          asOmitted: true,
        };
      },
    );
    report.browserEvents = browserEvents;
    report.pass =
      report.scenarios.length > 0 &&
      report.scenarios.every((test) => test.status === 'PASS');
  } catch (error) {
    report.fatal = error.stack;
    process.stdout.write(`FATAL ${error.message}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await stop();
    const sourceDirectory = path.join(output, 'fixture-source-text');
    const capturedSources = [];
    await fs.mkdir(sourceDirectory, { recursive: true });
    const captureSource = async (logicalFile) => {
      const bytes = await fs.readFile(path.join(app, logicalFile));
      const evidence = logicalFile + '.txt';
      await fs.mkdir(path.dirname(path.join(sourceDirectory, evidence)), {
        recursive: true,
      });
      await fs.writeFile(path.join(sourceDirectory, evidence), bytes);
      capturedSources.push({
        logicalFile,
        evidence,
        sha256: sha(bytes),
        bytes: bytes.length,
      });
    };
    const captureDirectory = async (logicalDirectory) => {
      for (const entry of await fs.readdir(path.join(app, logicalDirectory), {
        withFileTypes: true,
      })) {
        const logicalFile = path.join(logicalDirectory, entry.name);
        if (entry.isDirectory()) await captureDirectory(logicalFile);
        else if (entry.isFile()) await captureSource(logicalFile);
      }
    };
    for (const file of [
      'package.json',
      'next.config.mjs',
      'probe-loader.cjs',
      'probe-config.json',
      'probe-status.json',
      'loader-events.jsonl',
    ]) {
      await captureSource(file).catch(() => {});
    }
    for (const directory of ['app', 'snapshots', 'semantic'])
      await captureDirectory(directory).catch(() => {});
    await fs.writeFile(
      path.join(sourceDirectory, 'manifest.json'),
      JSON.stringify(capturedSources, null, 2) + '\n',
    );
    report.finishedAt = new Date().toISOString();
    await save();
    process.stdout.write(
      `REPORT ${path.join(output, 'report.json')} PASS=${report.pass}\n`,
    );
    process.exitCode = report.pass ? 0 : 1;
  }
}

main().catch((error) => {
  process.stderr.write(error.stack + '\n');
  process.exitCode = 1;
});
