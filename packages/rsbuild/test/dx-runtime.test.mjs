/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRsbuild } from '@rsbuild/core';
import { pandamstyle } from '../src/index.js';

test('real Rsbuild/Rspack composes authored JavaScript and extracted CSS source maps', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms15d-rsbuild-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const source =
    "import { create, props } from '../generated/design.js';\nconst styles = create({ box: { display: 'flex' } });\nexport function marker(value: string) { throw new Error('rsbuild-map-marker'); }\ndocument.body.setAttribute('class', props(styles.box).className);\n";
  await fs.writeFile(path.join(root, 'src/index.tsx'), source);
  const instance = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      mode: 'production',
      source: { entry: { index: './src/index.tsx' } },
      output: { sourceMap: { js: 'source-map', css: true }, minify: false },
      plugins: [
        pandamstyle({
          definition: {
            systemId: 'dx-rspack@1',
            tokens: {},
            themes: {},
            recipes: {},
            conditions: {},
          },
          roots: ['src'],
          outDir: 'generated',
          designSystemFile: 'design.js',
        }),
      ],
    },
  });
  const result = await instance.build();
  try {
    assert.equal(result.stats.hasErrors(), false);
  } finally {
    await result.close();
  }
  const jsFiles = await fs.readdir(path.join(root, 'dist/static/js'));
  const jsMapName = jsFiles.find((name) => name.endsWith('.js.map'));
  assert.ok(jsMapName);
  const map = JSON.parse(
    await fs.readFile(path.join(root, 'dist/static/js', jsMapName), 'utf8'),
  );
  const sourceIndex = map.sources.findIndex((item) =>
    item.endsWith('src/index.tsx'),
  );
  assert.ok(sourceIndex >= 0, JSON.stringify(map.sources));
  assert.equal(map.sourcesContent[sourceIndex], source);
  assert.ok(map.mappings.length > 0);
  const cssFiles = await fs.readdir(path.join(root, 'dist/static/css'));
  const cssMapName = cssFiles.find((name) => name.endsWith('.css.map'));
  assert.ok(cssMapName);
  const cssMap = JSON.parse(
    await fs.readFile(path.join(root, 'dist/static/css', cssMapName), 'utf8'),
  );
  assert.ok(
    cssMap.sources.some((item) => item.endsWith('src/index.tsx')),
    JSON.stringify(cssMap.sources),
  );
  assert.ok(cssMap.sourcesContent.includes(source));
  assert.equal(
    await fs.readFile(path.join(root, 'dist/pandamstyle/styles.css'), 'utf8'),
    await fs.readFile(path.join(root, 'generated/styles.css'), 'utf8'),
  );
});
