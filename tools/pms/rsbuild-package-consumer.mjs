/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createRsbuild } from '@rsbuild/core';
import * as adapter from '@pandamstyle/rsbuild';

async function main() {
  const require = createRequire(import.meta.url);
  assert.deepEqual(Object.keys(adapter).sort(), ['default', 'pandamstyle']);
  assert.equal(adapter.default, adapter.pandamstyle);
  await assert.rejects(
    import('@pandamstyle/rsbuild/src/index.js'),
    (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
  const realpath = await fs.realpath(
    path.dirname(require.resolve('@pandamstyle/rsbuild/package.json')),
  );
  assert(
    realpath.startsWith(path.join(process.cwd(), 'node_modules') + path.sep),
  );
  const root = path.join(process.cwd(), 'rsbuild-package-app');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'src/index.js'),
    "import { create, token, props } from '../.pandamstyle/design.pandamstyle.js'; const styles = create({ root: { padding: token('spacing.md') } }); document.getElementById('root').className = props(styles.root).className;",
  );
  const events = [];
  const config = {
    plugins: [
      adapter.pandamstyle({
        definition: {
          systemId: 'node-boundary',
          tokens: { spacing: { md: { value: '16px', visibility: 'public' } } },
        },
        roots: ['src'],
        onEvent: (event) => events.push(event),
      }),
    ],
    server: { port: 0, host: '127.0.0.1' },
    dev: { lazyCompilation: false },
  };
  const dev = await createRsbuild({ cwd: root, rsbuildConfig: config });
  const { server } = await dev.startDevServer();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}`, {
      headers: { Connection: 'close' },
    });
    assert.equal(response.status, 200);
    await response.text();
    assert(
      events.some(
        (event) => event.kind === 'transform' && event.file === 'src/index.js',
      ),
    );
    assert(events.some((event) => event.kind === 'settled'));
  } finally {
    await server.close();
  }
  const production = await createRsbuild({
    cwd: root,
    rsbuildConfig: { ...config, mode: 'production' },
  });
  const built = await production.build();
  try {
    assert.equal(built.stats.hasErrors(), false);
  } finally {
    await built.close();
  }
  for (const file of [
    'design.pandamstyle.js',
    'design.pandamstyle.d.ts',
    'manifest.json',
    'styles.css',
    'artifacts.json',
  ])
    assert((await fs.stat(path.join(root, '.pandamstyle', file))).isFile());
  console.log(
    JSON.stringify({
      node: process.version,
      import: 'passed',
      privateSubpath: 'rejected',
      realpath,
      dev: 'passed',
      transform: 'passed',
      production: 'passed',
      canonicalSet: 'passed',
      integrationSupported: true,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
