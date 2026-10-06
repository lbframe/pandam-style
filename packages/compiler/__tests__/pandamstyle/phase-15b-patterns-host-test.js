/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../../..');
jest.setTimeout(90000);

function appWithPattern(expression) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-pattern-vite-'));
  fs.cpSync(path.join(ROOT, 'examples/pilots/vite-react'), app, {
    recursive: true,
    filter: (source) =>
      !source.includes(`${path.sep}node_modules`) &&
      !source.includes(`${path.sep}dist`) &&
      !source.includes(`${path.sep}.pandamstyle`),
  });
  fs.symlinkSync(
    path.join(ROOT, 'node_modules'),
    path.join(app, 'node_modules'),
    'dir',
  );
  fs.writeFileSync(
    path.join(app, 'src/pages/App.jsx'),
    `import {patterns, token, props} from '../../.pandamstyle/design.pandamstyle';
const layout = ${expression};
export function App() { return <main {...props(layout)}>Constrained layout</main>; }`,
  );
  return app;
}

function build(app) {
  return spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules/vite/bin/vite.js'),
      'build',
      '--logLevel',
      'error',
    ],
    {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
}

test('Vite publishes the exact canonical pattern CSS through its existing adapter', () => {
  const app = appWithPattern(
    "patterns.grid({columns: 6, gap: token('spacing.md')})",
  );
  try {
    const result = build(app);
    if (result.status !== 0) throw new Error(result.stderr);
    expect(result.status).toBe(0);
    const canonical = fs.readFileSync(
      path.join(app, '.pandamstyle/styles.css'),
      'utf8',
    );
    expect(canonical).toContain(
      'grid-template-columns:repeat(6,minmax(0,1fr))',
    );
    expect(canonical).toContain('gap:var(--');
    expect(
      fs.readFileSync(path.join(app, 'dist/pandamstyle/styles.css'), 'utf8'),
    ).toBe(canonical);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(app, '.pandamstyle/manifest.json'), 'utf8'),
    );
    expect(manifest.capabilities.patterns).toBe(true);
    expect(manifest.patterns.grid.parameters.columns.values).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('Vite rejects an out-of-domain pattern without publishing a build', () => {
  const app = appWithPattern('patterns.grid({columns: 12})');
  try {
    const result = build(app);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PMS_INVALID_PATTERN_PARAMETER');
    expect(fs.existsSync(path.join(app, 'dist/index.html'))).toBe(false);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
