/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PILOT_SOURCE = path.join(REPO_ROOT, 'examples/pilots/vite-react');
const PANDAMSTYLE_DIR = '.pandamstyle';

jest.setTimeout(180000);

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

/** Every file below `dir`, as relpath -> sha256. */
function digestTree(dir) {
  const files = {};
  if (!fs.existsSync(dir)) return files;
  const walk = (current, relative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const key = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isFile()) files[key] = sha256(full);
    }
  };
  walk(dir, '');
  return files;
}

function makeApp(extraFiles = {}) {
  const app = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-vite-public-package-'),
  );
  fs.cpSync(PILOT_SOURCE, app, { recursive: true });
  fs.rmSync(path.join(app, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(app, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(app, '.pandamstyle'), { recursive: true, force: true });

  for (const [relative, content] of Object.entries(extraFiles)) {
    const full = path.join(app, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  // This suite tests the public workspace package entry. The separate pilot
  // installs packed tarballs outside the workspace and proves package release
  // shape without workspace links.
  const scope = path.join(app, 'node_modules');
  fs.mkdirSync(scope, { recursive: true });
  for (const dep of ['vite', '@vitejs', 'react', 'react-dom', '@pandamstyle']) {
    const from = path.join(REPO_ROOT, 'node_modules', dep);
    if (!fs.existsSync(from)) continue;
    const to = path.join(scope, dep);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!fs.existsSync(to)) fs.symlinkSync(from, to, 'dir');
  }
  return app;
}

function runViteBuild(app, env = {}, args = []) {
  const bin = path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');
  const result = spawnSync(
    process.execPath,
    [bin, 'build', ...args, '--logLevel', 'error'],
    {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, ...env, NODE_ENV: 'production' },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

const CANONICAL_FILES = [
  'design.pandamstyle.js',
  'design.pandamstyle.d.ts',
  'manifest.json',
  'styles.css',
  'artifacts.json',
];

describe('a real Vite build through the public @pandamstyle/vite package', () => {
  let app;
  let result;

  beforeAll(() => {
    app = makeApp();
    result = runViteBuild(app);
    if (result.status !== 0) {
      throw new Error(`fixture build failed:\n${result.output}`);
    }
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the public Vite adapter build exits 0', () => {
    expect(result.status).toBe(0);
  });

  test('the compiler publishes all five canonical artifact members', () => {
    for (const name of CANONICAL_FILES) {
      expect(fs.existsSync(path.join(app, PANDAMSTYLE_DIR, name))).toBe(true);
    }
  });

  test('the exact canonical stylesheet is emitted in the Vite bundle', () => {
    const canonical = fs.readFileSync(
      path.join(app, PANDAMSTYLE_DIR, 'styles.css'),
      'utf8',
    );
    const emitted = fs.readFileSync(
      path.join(app, 'dist/pandamstyle/styles.css'),
      'utf8',
    );
    expect(emitted).toBe(canonical);
    expect(emitted).toContain('padding:var(--');
    expect(
      fs.readFileSync(path.join(app, 'dist/index.html'), 'utf8'),
    ).toContain('pandamstyle/styles.css');
  });

  test('the manifest, generated module, and metadata share the registry identity', () => {
    const dir = path.join(app, PANDAMSTYLE_DIR);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    );
    const moduleSource = fs.readFileSync(
      path.join(dir, 'design.pandamstyle.js'),
      'utf8',
    );
    const metadata = fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8');
    expect(manifest.registryDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(moduleSource).toContain(manifest.registryDigest);
    expect(metadata).toContain(manifest.registryDigest);
  });

  test('the Project Service coverage cross-check has no missing files', () => {
    const report = JSON.parse(
      fs.readFileSync(
        path.join(app, PANDAMSTYLE_DIR, 'build-report.json'),
        'utf8',
      ),
    );
    expect(report.coverageConsistency.missing).toEqual([]);
    expect(report.analysedFileCount).toBeGreaterThan(0);
    expect(report.incremental.fullFallback).toBe(0);
  });

  test('the generated design-system module is not treated as a source file', () => {
    const report = JSON.parse(
      fs.readFileSync(
        path.join(app, PANDAMSTYLE_DIR, 'build-report.json'),
        'utf8',
      ),
    );
    expect(report.coverage).toBeUndefined();
    expect(report.coverageSummary.pages).toBe(4);
    expect(report.analysedFileCount).toBe(4);
  });
});

describe('coverage gaps fail the real public Vite build', () => {
  let app;
  let result;

  beforeAll(() => {
    const source = fs.readFileSync(
      path.join(PILOT_SOURCE, 'src/pages/App.jsx'),
      'utf8',
    );
    app = makeApp({
      'src/pages/relay.js':
        "export { Unsafe } from '../../outside/Unsafe.jsx';\n",
      'outside/Unsafe.jsx': `export function Unsafe() {
  return <div style={{ padding: '17px' }}>uncovered</div>;
}
`,
      'src/pages/App.jsx': `import { Unsafe } from './relay.js';\nvoid Unsafe;\n${source}`,
    });
    result = runViteBuild(app);
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the escaped re-export fails the production build', () => {
    expect(result.status).not.toBe(0);
  });

  test('the actual uncovered module is named in the compiler diagnostic', () => {
    expect(result.output).toMatch(
      /PMS_(?:COVERAGE_GAP|FORBIDDEN_STYLE_CHANNEL)/,
    );
    expect(result.output).toContain('Unsafe.jsx');
  });

  test('no canonical generation is published after a coverage failure', () => {
    expect(
      fs.existsSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json')),
    ).toBe(false);
  });
});

describe('output and prepared-ticket failures preserve the previous generation', () => {
  let app;
  let before;

  beforeAll(() => {
    app = makeApp();
    const initial = runViteBuild(app);
    if (initial.status !== 0) {
      throw new Error(`baseline build failed:\n${initial.output}`);
    }
    before = digestTree(path.join(app, PANDAMSTYLE_DIR));
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('a late generateBundle failure rejects the build', () => {
    const failed = runViteBuild(app, { PMS_VITE_FAIL_AT: 'generateBundle' });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('PMS_INJECTED_GENERATEBUNDLE_FAILURE');
  });

  test('a changed design-system generation fails before commit', () => {
    const definition = path.join(app, 'design.pandamstyle.config.js');
    const source = fs.readFileSync(definition, 'utf8');
    fs.writeFileSync(
      definition,
      source.replace("sm: { value: '8px'", "sm: { value: '19px'"),
      'utf8',
    );
    const failed = runViteBuild(app, { PMS_VITE_FAIL_AT: 'generateBundle' });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('PMS_INJECTED_GENERATEBUNDLE_FAILURE');
  });

  test('all canonical output remains byte-identical to the prior generation', () => {
    expect(digestTree(path.join(app, PANDAMSTYLE_DIR))).toEqual(before);
  });

  test('no staging or backup directories remain after failure', () => {
    const strays = fs
      .readdirSync(app)
      .filter(
        (name) => name.includes('.staging-') || name.includes('.backup-'),
      );
    expect(strays).toEqual([]);
  });

  test('a clean retry commits the changed design-system generation', () => {
    const successful = runViteBuild(app);
    expect(successful.status).toBe(0);
    const after = digestTree(path.join(app, PANDAMSTYLE_DIR));
    expect(after).not.toEqual(before);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json'), 'utf8'),
    );
    expect(manifest.registryDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('unsupported build.write false is explicit', () => {
  let app;

  beforeAll(() => {
    app = makeApp();
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('build.write false fails with a structured configuration diagnostic', () => {
    const result = runViteBuild(app, { PMS_VITE_WRITE_FALSE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('PMS_UNSUPPORTED_FEATURE');
    expect(result.output).toContain('build.write: false');
  });

  test('the rejected configuration publishes no canonical generation', () => {
    expect(
      fs.existsSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json')),
    ).toBe(false);
  });
});

describe('a shared Vite builder keeps one Project Service across environments', () => {
  let app;
  let result;

  beforeAll(() => {
    app = makeApp();
    fs.writeFileSync(
      path.join(app, 'vite.shared.config.mjs'),
      `import { mergeConfig } from 'vite';
import base from './vite.config.js';

export default mergeConfig(base, {
  builder: { sharedPlugins: true },
  environments: {
    client: { build: { outDir: 'dist/client' } },
    ssr: {
      consumer: 'server',
      build: {
        outDir: 'dist/ssr',
        rollupOptions: { input: 'src/pages/App.jsx' },
      },
    },
    nitro: {
      consumer: 'server',
      build: {
        outDir: 'dist/nitro',
        rollupOptions: { input: 'src/pages/App.jsx' },
      },
    },
  },
});
`,
      'utf8',
    );
    result = runViteBuild(app, {}, [
      '--app',
      '--config',
      'vite.shared.config.mjs',
    ]);
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the shared multi-environment app build exits 0', () => {
    expect(result.status).toBe(0);
  });

  test('the client bundle receives the canonical stylesheet and server environments build', () => {
    const canonical = fs.readFileSync(
      path.join(app, PANDAMSTYLE_DIR, 'styles.css'),
      'utf8',
    );
    expect(
      fs.readFileSync(
        path.join(app, 'dist/client/pandamstyle/styles.css'),
        'utf8',
      ),
    ).toBe(canonical);
    for (const environment of ['ssr', 'nitro']) {
      expect(fs.existsSync(path.join(app, `dist/${environment}/App.js`))).toBe(
        true,
      );
    }
  });

  test('the shared build publishes one complete canonical artifact set', () => {
    const dir = path.join(app, PANDAMSTYLE_DIR);
    for (const name of CANONICAL_FILES) {
      expect(fs.existsSync(path.join(dir, name))).toBe(true);
    }
    const report = JSON.parse(
      fs.readFileSync(path.join(dir, 'build-report.json'), 'utf8'),
    );
    expect(report.incremental.fullFallback).toBe(0);
    expect(report.coverageConsistency.missing).toEqual([]);
  });
});
