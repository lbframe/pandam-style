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
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { pandamstyle } from '../src/index.js';

test('real Vite graph transforms and updates imported sources outside roots and serves exact CSS maps', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms15d-vite-'));
  await fs.symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'semantic'));
  await fs.mkdir(path.join(root, 'shared'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await fs.writeFile(
    path.join(root, 'semantic/page.js'),
    "export { box } from '../shared/styles.js';\n",
  );
  const source = [
    "import { create, token, props, patterns, recipes, themes } from '../generated/design.js';",
    "const styles = create({ box: { color: token('colors.ink') } });",
    "const layout = patterns.stack({gap: token('spacing.sm')});",
    "export const box = props(themes.dark, styles.box, layout, recipes.card({size: 'sm'}).root);",
    '',
  ].join('\n');
  const file = path.join(root, 'shared/styles.js');
  await fs.writeFile(file, source);
  const plugin = pandamstyle({
    definition: {
      systemId: 'dx@1',
      tokens: {
        spacing: {
          sm: { value: '8px', visibility: 'public' },
          md: { value: '16px', visibility: 'public' },
        },
        colors: {
          ink: { value: '#123456', visibility: 'public' },
          accent: { value: '#654321', visibility: 'public' },
        },
      },
      themes: {
        dark: {
          tokens: { colors: { ink: { value: '#010101' } } },
        },
        light: {
          tokens: { colors: { ink: { value: '#fefefe' } } },
        },
      },
      recipes: {
        card: {
          slots: ['root'],
          base: { root: { display: 'flex' } },
          variants: {
            size: {
              sm: { root: { display: 'block' } },
              md: { root: { display: 'grid' } },
            },
          },
          defaultVariants: { size: 'sm' },
          compoundVariants: [{ size: 'md', css: { root: { opacity: 0.75 } } }],
        },
      },
      conditions: {},
    },
    roots: ['semantic'],
    outDir: 'generated',
    designSystemFile: 'design.js',
  });
  const server = await createServer({
    configFile: false,
    root,
    plugins: [plugin],
    logLevel: 'silent',
    server: { port: 0 },
  });
  t.after(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await server.listen();
  await server.transformRequest('/semantic/page.js');
  const transformed = await server.transformRequest('/shared/styles.js');
  assert.match(transformed.code, /__pmsProps/);
  assert.deepEqual(transformed.map.sourcesContent, [source]);
  assert.ok(
    transformed.map.sources.some((item) => item.endsWith('styles.js')),
    JSON.stringify(transformed.map.sources),
  );
  const address = server.httpServer.address();
  const base = `http://localhost:${address.port}`;
  const css = await fetch(base + '/__pandamstyle.css');
  assert.equal(css.status, 200);
  const mapAddress = css.headers.get('SourceMap');
  assert.ok(mapAddress.endsWith('.map'));
  const map = await (await fetch(base + mapAddress)).json();
  assert.ok(map.sources.some((item) => item.endsWith('/shared/styles.js')));
  assert.ok(map.mappings.length > 0);
  // Drive the host hook against a real module graph without racing Chokidar.
  await server.watcher.unwatch(root);
  const modules = [
    ...server.environments.client.moduleGraph.getModulesByFile(file),
  ];
  const changed = source;
  const updateSource = async (nextSource, previousTransform) => {
    await fs.writeFile(file, nextSource);
    const updated = await plugin.handleHotUpdate({
      file,
      modules,
      server,
      timestamp: Date.now(),
      read: async () => nextSource,
    });
    assert.ok(updated.some((module) => module.file === file));
    const nextTransform = await server.transformRequest('/shared/styles.js');
    assert.notEqual(nextTransform.code, previousTransform.code);
    return nextTransform;
  };
  const patternEdit = changed.replace(
    "patterns.stack({gap: token('spacing.sm')})",
    "patterns.grid({columns: 2, gap: token('spacing.md')})",
  );
  const next = await updateSource(patternEdit, transformed);
  const response = await fetch(base + '/__pandamstyle.css');
  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/,
  );
  const recipeEdit = patternEdit.replace("size: 'sm'", "size: 'md'");
  const recipeTransform = await updateSource(recipeEdit, next);
  const themeEdit = recipeEdit.replace('themes.dark', 'themes.light');
  const themeTransform = await updateSource(themeEdit, recipeTransform);
  const tokenEdit = themeEdit.replace('colors.ink', 'colors.accent');
  await updateSource(tokenEdit, themeTransform);
  const invalid = tokenEdit.replace('colors.accent', 'colors.missing');
  await fs.writeFile(file, invalid);
  assert.deepEqual(
    await plugin.handleHotUpdate({
      file,
      modules,
      server,
      timestamp: Date.now(),
      read: async () => invalid,
    }),
    [],
  );
  await assert.rejects(
    server.transformRequest('/shared/styles.js'),
    /requires a valid current revision/,
  );
  await fs.writeFile(file, tokenEdit);
  await plugin.handleHotUpdate({
    file,
    modules,
    server,
    timestamp: Date.now(),
    read: async () => tokenEdit,
  });
  assert.match(
    (await server.transformRequest('/shared/styles.js')).code,
    /__pmsProps/,
  );
  const output = path.join(root, '.generated.pms-staging/fake.js');
  assert.equal(
    await plugin.handleHotUpdate({
      file: output,
      modules: [],
      read: async () => '',
    }),
    undefined,
  );
});

test('a global token edit updates CSS and reloads without clearing the Vite graph', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pms16b-vite-'));
  await fs.symlink(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
    'dir',
  );
  await fs.mkdir(path.join(root, 'semantic'));
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const definitionFile = path.join(root, 'design.mjs');
  const definition = (value) =>
    `export default { systemId: 'vite16b', tokens: { colors: { ink: { value: '${value}', visibility: 'public' } } } };\n`;
  await fs.writeFile(definitionFile, definition('#111111'));
  await fs.writeFile(
    path.join(root, 'semantic/page.js'),
    [
      "import { create, token, props } from '../generated/design.js';",
      "const style = create({ root: { color: token('colors.ink') } });",
      'export const page = props(style.root);',
      '',
    ].join('\n'),
  );
  await fs.writeFile(
    path.join(root, 'semantic/unrelated.js'),
    'export const unrelated = 1;\n',
  );
  const plugin = pandamstyle({
    definition: 'design.mjs',
    roots: ['semantic'],
    outDir: 'generated',
    designSystemFile: 'design.js',
  });
  const server = await createServer({
    configFile: false,
    root,
    plugins: [plugin],
    logLevel: 'silent',
    server: { port: 0 },
  });
  t.after(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await server.listen();
  await server.transformRequest('/semantic/page.js');
  await server.transformRequest('/semantic/unrelated.js');
  await server.watcher.unwatch(root);

  const graph = server.environments.client.moduleGraph;
  const unrelated = await graph.ensureEntryFromUrl('/semantic/unrelated.js');
  const page = await graph.ensureEntryFromUrl('/semantic/page.js');
  assert.ok(unrelated);
  assert.ok(page);
  const originalInvalidateAll = graph.invalidateAll.bind(graph);
  const originalInvalidateModule = graph.invalidateModule.bind(graph);
  let invalidateAllCalls = 0;
  const invalidatedIds = [];
  graph.invalidateAll = (...args) => {
    invalidateAllCalls += 1;
    return originalInvalidateAll(...args);
  };
  graph.invalidateModule = (module, ...args) => {
    invalidatedIds.push(module.id);
    return originalInvalidateModule(module, ...args);
  };
  let reloadMessages = 0;
  const hot = server.environments.client.hot;
  const originalSend = hot.send.bind(hot);
  hot.send = (event, ...args) => {
    if (event?.type === 'full-reload') reloadMessages += 1;
    return originalSend(event, ...args);
  };

  await fs.writeFile(definitionFile, definition('#222222'));
  const outcome = await plugin.handleHotUpdate({
    file: definitionFile,
    modules: [],
    server,
    timestamp: Date.now(),
    read: async () => definition('#222222'),
  });
  assert.deepEqual(outcome, []);
  assert.equal(invalidateAllCalls, 0);
  assert.equal(invalidatedIds.includes(unrelated.id), false);
  assert.equal(invalidatedIds.includes(page.id), false);
  assert.equal(reloadMessages, 1);

  const css = await fetch(
    `http://localhost:${server.httpServer.address().port}/__pandamstyle.css`,
  );
  assert.equal(css.status, 200);
  assert.match(await css.text(), /#222222/);
});
