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
import { createRequire } from 'node:module';
import { pandamstyle } from '../src/index.js';

const { declarationEquivalence, normalizeCss } = createRequire(import.meta.url)(
  '../../../tools/pms/css-equivalence.cjs',
);

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

test('the plugin forwards `targets` to the Project Service (CE-01.1)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms-ce011-rsbuild-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'src/index.js'),
    "import { create, props } from '../generated/design.js';\nconst styles = create({ box: { display: 'flex' } });\ndocument.body.setAttribute('class', props(styles.box).className);\n",
  );
  const instance = await createRsbuild({
    cwd: root,
    rsbuildConfig: {
      mode: 'production',
      source: { entry: { index: './src/index.js' } },
      output: { minify: false },
      plugins: [
        pandamstyle({
          definition: {
            systemId: 'rsbuild-targets@1',
            tokens: {},
            themes: {},
            recipes: {},
            conditions: {},
          },
          roots: ['src'],
          outDir: 'generated',
          designSystemFile: 'design.js',
          targets: { profiles: ['pandamstyle:electron@1'] },
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
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'generated/manifest.json'), 'utf8'),
  );
  assert.equal(manifest.targets.origin, 'project-config');
  assert.deepEqual(manifest.targets.profiles, [
    {
      ref: 'pandamstyle:electron@1',
      query: 'electron 44.7',
      platform: 'electron',
      engines: [{ engine: 'electron', floor: '152' }],
      excluded: 0,
    },
  ]);
});

test('a host browserslist cannot redefine the delivered stylesheet (CE-01.2)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms-ce012-rsbuild-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'app'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'src/index.js'),
    "import { create, props } from '../generated/design.js';\nconst styles = create({ box: { display: 'flex', userSelect: 'none' } });\ndocument.body.setAttribute('class', props(styles.box).className);\n",
  );
  // Application CSS outside the PandamStyle roots keeps Rsbuild's treatment.
  await fs.writeFile(
    path.join(root, 'app/app.css'),
    '.app { color: red; -webkit-user-select: none; user-select: none; }\n',
  );
  const delivered = async (output) => {
    const instance = await createRsbuild({
      cwd: root,
      rsbuildConfig: {
        mode: 'production',
        source: {
          entry: { index: './src/index.js' },
          preEntry: ['./app/app.css'],
        },
        output,
        plugins: [
          pandamstyle({
            definition: {
              systemId: 'rsbuild-ce012@1',
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
    const html = await fs.readFile(path.join(root, 'dist/index.html'), 'utf8');
    const links = [...html.matchAll(/href="\/?([^"]+\.css)"/g)].map(
      (m) => m[1],
    );
    const files = await Promise.all(
      links.map((file) => fs.readFile(path.join(root, 'dist', file), 'utf8')),
    );
    return { links, files };
  };
  for (const output of [{}, { overrideBrowserslist: ['chrome >= 100'] }]) {
    const { links, files } = await delivered(output);
    const canonical = await fs.readFile(
      path.join(root, 'generated/styles.css'),
      'utf8',
    );
    assert.ok(canonical.includes('-webkit-user-select:none;user-select:none'));
    // One delivered asset, as before: frameworks link CSS per JS chunk.
    assert.equal(links.length, 1, JSON.stringify(links));
    const rules = normalizeCss(files[0]);
    const app = rules.filter((rule) => rule.selectors?.includes('.app'));
    const ours = rules.filter((rule) => !rule.selectors?.includes('.app'));
    assert.deepEqual(ours, normalizeCss(canonical));
    // The application's CSS still follows its own browserslist.
    assert.equal(app.length, 1);
    assert.equal(
      app[0].declarations.includes('-webkit-user-select:none'),
      output.overrideBrowserslist == null,
      JSON.stringify(app[0]),
    );
    // The stylesheet text itself is declaration-equivalent.
    const own = files[0].slice(
      files[0].indexOf('/* pandamstyle-design-system'),
    );
    const result = declarationEquivalence(canonical, own);
    assert.equal(result.equivalent, true, JSON.stringify(result.difference));
  }
});
