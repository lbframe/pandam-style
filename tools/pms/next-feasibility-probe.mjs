/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Upstream lifecycle observations only. This is not a PandamStyle adapter,
// package qualification, or performance benchmark.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function main() {
  const output = path.resolve(process.argv[2]);
  await fs.mkdir(output, { recursive: true });
  const scratch = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pms-next-feasibility-'),
  );
  const report = {
    scope: 'upstream-public-lifecycle-probe',
    node: process.version,
    scratch,
    integrationQualified: false,
    rows: [],
    pass: false,
  };
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', CI: '1' };
  delete env.NODE_PATH;

  async function write(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }

  function run(cwd, args, label, timeout = 180000) {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (value) => {
      text += value;
    });
    child.stderr.on('data', (value) => {
      text += value;
    });
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(stop, timeout);
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        await write(path.join(output, `${label}.log`), text);
        resolve({ code, signal, pid: child.pid });
      });
    });
    return { done, stop, log: () => text };
  }

  async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  async function events(root) {
    const text = await fs
      .readFile(path.join(root, 'events.jsonl'), 'utf8')
      .catch(() => '');
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  try {
    for (const version of ['15.5.27', '16.3.8']) {
      const root = path.join(scratch, version);
      await write(
        path.join(root, 'package.json'),
        JSON.stringify({
          private: true,
          dependencies: {
            next: version,
            react: '19.2.0',
            'react-dom': '19.2.0',
          },
        }),
      );
      const installed = await run(
        root,
        ['npm', 'install', '--no-audit', '--no-fund'],
        `${version}-install`,
      ).done;
      assert.equal(installed.code, 0);
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(root, 'node_modules/next/package.json'),
          'utf8',
        ),
      );
      assert.equal(manifest.version, version);
      const realpath = await fs.realpath(path.join(root, 'node_modules/next'));
      assert(realpath.startsWith(scratch + path.sep));
      const next = path.join(root, 'node_modules/next/dist/bin/next');
      await write(
        path.join(root, 'probe.cjs'),
        `const fs = require('node:fs');
const path = require('node:path');
module.exports = function event(type, details = {}) {
  fs.appendFileSync(path.join(__dirname, 'events.jsonl'), JSON.stringify({ type, pid: process.pid, ...details }) + '\\n');
};
`,
      );
      await write(
        path.join(root, 'loader.cjs'),
        `const event = require('./probe.cjs');
module.exports = function (source) {
  event('loader-completed', { file: this.resourcePath });
  return source;
};
`,
      );
      await write(
        path.join(root, 'adapter.cjs'),
        `const event = require('./probe.cjs');
module.exports = {
  name: 'pandamstyle-public-feasibility-probe',
  modifyConfig(config) { event('adapter-config'); return config; },
  onBuildComplete() { event('build-complete'); },
};
`,
      );
      await write(
        path.join(root, 'next.config.js'),
        `const event = require('./probe.cjs');
const path = require('node:path');
const mode = process.env.PMS_PROBE_BACKEND;
const adapterPath = path.join(__dirname, 'adapter.cjs');
module.exports = {
  ${version.startsWith('16') ? 'adapterPath,' : ''}
  experimental: { cpus: 2, ${version.startsWith('15') ? 'adapterPath,' : ''} },
  images: { unoptimized: true },
  async headers() { return [{ source: '/:path*', headers: [{ key: 'x-probe', value: 'preserved' }] }]; },
  compiler: { runAfterProductionCompile() { event('production-compiled'); } },
  ...(mode === 'webpack' ? { webpack(config, context) {
    event('webpack-config', { dev: context.dev, isServer: context.isServer, nextRuntime: context.nextRuntime ?? null });
    config.module.rules.push({ test: /\\.[jt]sx?$/, include: path.join(__dirname, 'app'), enforce: 'pre', use: path.join(__dirname, 'loader.cjs') });
    config.plugins.push({ apply(compiler) {
      compiler.hooks.done.tap('PublicProbe', stats => event('webpack-done', { compiler: compiler.name, errors: stats.hasErrors() }));
      compiler.hooks.failed.tap('PublicProbe', () => event('webpack-failed', { compiler: compiler.name }));
      compiler.hooks.watchClose.tap('PublicProbe', () => event('webpack-watch-close', { compiler: compiler.name }));
    } });
    return config;
  } } : { turbopack: { root: __dirname, rules: { '*.jsx': { loaders: [path.join(__dirname, 'loader.cjs')] } } } }),
};
`,
      );
      const valid = `import Client from './client';
export default function Page() { return <main><h1>public probe</h1><Client /></main>; }
`;
      await write(
        path.join(root, 'app/layout.jsx'),
        'export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n',
      );
      await write(
        path.join(root, 'app/client.jsx'),
        "'use client';\nimport { useState } from 'react';\nexport default function Client() { const [value, setValue] = useState(0); return <button onClick={() => setValue(value + 1)}>{value}</button>; }\n",
      );
      for (const backend of ['webpack', 'turbopack']) {
        env.PMS_PROBE_BACKEND = backend;
        const flags =
          backend === 'turbopack'
            ? ['--turbopack']
            : version.startsWith('16')
              ? ['--webpack']
              : [];
        for (const outcome of ['success', 'prerender-failure']) {
          await fs.rm(path.join(root, '.next'), {
            recursive: true,
            force: true,
          });
          await fs.rm(path.join(root, 'events.jsonl'), { force: true });
          await write(
            path.join(root, 'app/page.jsx'),
            outcome === 'success'
              ? valid
              : "export default function Page() { throw new Error('PMS_PROBE_PRERENDER_FAILURE'); }\n",
          );
          const result = await run(
            root,
            [process.execPath, next, 'build', ...flags],
            `${version}-${backend}-${outcome}`,
          ).done;
          const trace = await events(root);
          assert.equal(result.signal, null);
          assert.equal(result.code === 0, outcome === 'success');
          assert(trace.some((event) => event.type === 'production-compiled'));
          assert.equal(
            trace.some((event) => event.type === 'build-complete'),
            outcome === 'success',
          );
          assert(trace.some((event) => event.type === 'loader-completed'));
          report.rows.push({
            version,
            backend,
            mode: 'production',
            outcome,
            realpath,
            nodeEngines: manifest.engines,
            ...result,
            events: trace,
          });
        }
        await fs.rm(path.join(root, '.next'), { recursive: true, force: true });
        await fs.rm(path.join(root, 'events.jsonl'), { force: true });
        await write(path.join(root, 'app/page.jsx'), valid);
        const port = await freePort();
        const server = run(
          root,
          [
            process.execPath,
            next,
            'dev',
            ...flags,
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          `${version}-${backend}-dev`,
        );
        const started = Date.now();
        let first;
        while (Date.now() - started < 90000) {
          try {
            first = await fetch(`http://127.0.0.1:${port}`, {
              signal: AbortSignal.timeout(15000),
            });
            if (first.status === 200) break;
          } catch {
            /* startup */
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        try {
          assert.equal(first?.status, 200, server.log());
          assert.equal(first.headers.get('x-probe'), 'preserved');
          await write(
            path.join(root, 'app/page.jsx'),
            "import Missing from './absent';\nexport default function Page() { return <Missing />; }\n",
          );
          let failure;
          for (let attempt = 0; attempt < 30; attempt++) {
            failure = await fetch(`http://127.0.0.1:${port}`, {
              signal: AbortSignal.timeout(15000),
            });
            if (failure.status === 500) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          assert.equal(failure.status, 500);
          const trace = await events(root);
          assert(trace.some((event) => event.type === 'loader-completed'));
          assert(!trace.some((event) => event.type === 'build-complete'));
          if (backend === 'webpack')
            assert(
              trace.some(
                (event) => event.type === 'webpack-done' && event.errors,
              ),
            );
          report.rows.push({
            version,
            backend,
            mode: 'dev',
            outcome: 'module-resolution-failure',
            status: failure.status,
            realpath,
            events: trace,
          });
        } finally {
          server.stop();
          await server.done;
        }
        console.log(
          `Observed ${version} ${backend} lifecycle; no integration support claim.`,
        );
      }
    }
    report.pass = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    await write(
      path.join(output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
