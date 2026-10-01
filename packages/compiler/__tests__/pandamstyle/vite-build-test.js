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
const VITE_SEAM = path.join(REPO_ROOT, '.pms-test-support/vite-seam.mjs');
const VITE_SEAM_ROLLUP_CONFIG = path.join(
  REPO_ROOT,
  'tools/pilot/vite-seam.rollup.config.mjs',
);
const SHARED_DEFINITION = path.resolve(
  __dirname,
  'fixtures/_shared/design.pms.config.mjs',
);

jest.setTimeout(180000);

let viteSeamBuilt = false;

function ensureViteSeamBundle() {
  if (viteSeamBuilt && fs.existsSync(VITE_SEAM)) return;
  const result = spawnSync(
    path.join(REPO_ROOT, 'node_modules/.bin/rollup'),
    ['--config', VITE_SEAM_ROLLUP_CONFIG],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to build the private Vite qualification seam:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  viteSeamBuilt = true;
}

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
  const walk = (cur, rel) => {
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isFile()) files[key] = sha256(full);
    }
  };
  walk(dir, '');
  return files;
}

const PAGE = `import {
  create,
  token,
  themes,
  recipes,
  props,
} from '../../.pandamstyle/design.pandamstyle.js';

const styles = create({
  page: {
    backgroundColor: token('colors.surface.primary'),
    color: token('colors.text.primary'),
    padding: token('spacing.md'),
  },
});

export function App() {
  return (
    <div {...props(themes.light, styles.page)}>
      <button {...props(recipes.button({ variant: 'primary', size: 'md' }))}>
        Continue
      </button>
    </div>
  );
}
`;

const HTML = `<!doctype html>
<html>
  <head><title>vite fixture</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>
</html>
`;

const MAIN = `import { createRoot } from 'react-dom/client';
import { App } from './pages/App.jsx';

createRoot(document.getElementById('root')).render(<App />);
`;

/**
 * Writes a self-contained Vite application. `extraFiles` are written relative to
 * the app root, so a fixture can add a relay barrel outside the covered root.
 */
function makeApp(extraFiles = {}) {
  ensureViteSeamBundle();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-vite-'));
  fs.mkdirSync(path.join(app, 'src/pages'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), HTML, 'utf8');
  fs.writeFileSync(path.join(app, 'src/main.jsx'), MAIN, 'utf8');
  fs.writeFileSync(path.join(app, 'src/pages/App.jsx'), PAGE, 'utf8');
  fs.writeFileSync(
    path.join(app, 'design.pms.config.mjs'),
    `export { default } from ${JSON.stringify(SHARED_DEFINITION)};\n`,
    'utf8',
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(app, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  // The late-failure plugin is a TEST FIXTURE plugin, not a product seam: it is
  // declared `enforce: 'post'`, so its generateBundle runs after the PandamStyle
  // CSS has been rendered and after the PandamStyle transform is done, but
  // before `writeBundle` publishes the generation. That is exactly the window a
  // real application or bundler bug would land in, and it is the window the
  // previous implementation got wrong by writing artifacts during the build.
  fs.writeFileSync(
    path.join(app, 'vite.config.mjs'),
    `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from ${JSON.stringify(VITE_SEAM)};

const lateFailure = {
  name: 'pms-test-late-failure',
  enforce: 'post',
  generateBundle() {
    if (process.env.PMS_VITE_INJECT_FAILURE === '1') {
      throw new Error('injected bundler failure after the CSS was rendered');
    }
  },
};

export default defineConfig({
  logLevel: 'error',
  root: import.meta.dirname,
  plugins: [
    react(),
    pandamstyle({
      designSystem: './design.pms.config.mjs',
      roots: ['./src/pages'],
      outDir: './.pandamstyle',
      role: 'page',
    }),
    lateFailure,
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
`,
    'utf8',
  );

  // Vite and React must resolve from the workspace, the way an installed app
  // would resolve them; NODE_PATH is not read by ESM, so link instead.
  const scope = path.join(app, 'node_modules');
  fs.mkdirSync(scope, { recursive: true });
  for (const dep of ['vite', '@vitejs', 'react', 'react-dom', '@pandamstyle']) {
    const from = path.join(REPO_ROOT, 'node_modules', dep);
    if (!fs.existsSync(from)) continue;
    const to = path.join(scope, dep);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) continue;
    try {
      fs.symlinkSync(from, to, 'dir');
    } catch {
      /* already present */
    }
  }
  return app;
}

function runViteBuild(app, env = {}) {
  // A real child process running Vite's own CLI: the observed status is the
  // status of the bundler, not of a hook this test called.
  const bin = path.join(REPO_ROOT, 'node_modules/vite/bin/vite.js');
  const result = spawnSync(process.execPath, [bin, 'build'], {
    cwd: app,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

const PANDAMSTYLE_DIR = '.pandamstyle';

describe('BC-3/BC-5: a real vite build publishes one coherent generation', () => {
  let app;

  beforeAll(() => {
    app = makeApp();
    const result = runViteBuild(app);
    if (result.status !== 0) {
      throw new Error(`fixture build failed:\n${result.output}`);
    }
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the build exits 0', () => {
    expect(runViteBuild(app).status).toBe(0);
  });

  test('the manifest, the module and the stylesheet are all published', () => {
    for (const name of [
      'manifest.json',
      'build-report.json',
      'styles.css',
      'design.pandamstyle.js',
    ]) {
      expect(fs.existsSync(path.join(app, PANDAMSTYLE_DIR, name))).toBe(true);
    }
  });

  test('the stylesheet is also emitted into the bundle', () => {
    expect(fs.existsSync(path.join(app, 'dist/pandamstyle.css'))).toBe(true);
    const css = fs.readFileSync(path.join(app, 'dist/pandamstyle.css'), 'utf8');
    expect(css).toContain('padding:var(--');
  });

  test('every artifact references the same registryDigest', () => {
    const dir = path.join(app, PANDAMSTYLE_DIR);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(dir, 'build-report.json'), 'utf8'),
    );
    const moduleSource = fs.readFileSync(
      path.join(dir, 'design.pandamstyle.js'),
      'utf8',
    );
    const marker = JSON.parse(
      moduleSource.match(/__PMS_DESIGN_SYSTEM__ = (\{[\s\S]*?\n\});/)[1],
    );
    expect(manifest.registryDigest).toBe(report.registryDigest);
    expect(marker.registryDigest).toBe(report.registryDigest);
  });

  test('the report shows the expected-vs-analysed cross-check as clean', () => {
    const report = JSON.parse(
      fs.readFileSync(
        path.join(app, PANDAMSTYLE_DIR, 'build-report.json'),
        'utf8',
      ),
    );
    expect(report.coverageConsistency.missing).toEqual([]);
    expect(report.transformedFileCount).toBeGreaterThan(0);
    // The cross-check is recorded with the rule that produced it, not silently.
    expect(typeof report.coverageConsistency.classification).toBe('string');
  });

  test('the generated design-system module is not expected to be analysed', () => {
    const report = JSON.parse(
      fs.readFileSync(
        path.join(app, PANDAMSTYLE_DIR, 'build-report.json'),
        'utf8',
      ),
    );
    const ds = report.coverage.find((c) =>
      c.file.endsWith('design.pandamstyle.js'),
    );
    // It is not in the analysed coverage at all: it is the generator's output.
    expect(ds).toBeUndefined();
  });
});

describe('BC-3/BC-4/BC-9: a relay escape fails a real vite build', () => {
  let app;
  let result;

  beforeAll(() => {
    app = makeApp({
      // Outside `src/pages`, so outside every declared root. Reached only by a
      // re-export, which is exactly how a module used to escape the policy.
      'src/bridge/index.js':
        "export { Panel } from '../../outside/Unsafe.jsx';\n",
      'outside/Unsafe.jsx': `export function Panel() {
  return <div style={{ padding: '17px' }}>relayed</div>;
}
`,
      'src/pages/App.jsx': `export { Panel } from '../bridge/index.js';
${PAGE}`,
    });
    result = runViteBuild(app);
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the build exits non-zero', () => {
    expect(result.status).not.toBe(0);
  });

  test('the relayed module is the one refused', () => {
    expect(result.output).toContain('PMS_FORBIDDEN_STYLE_CHANNEL');
    expect(result.output).toContain('Unsafe.jsx');
  });

  test('no generation is published', () => {
    expect(
      fs.existsSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json')),
    ).toBe(false);
  });
});

describe('BC-5: a late bundler failure publishes no new generation', () => {
  let app;
  let before;

  beforeAll(() => {
    app = makeApp();
    const ok = runViteBuild(app);
    if (ok.status !== 0) {
      throw new Error(`fixture build failed:\n${ok.output}`);
    }
    before = digestTree(path.join(app, PANDAMSTYLE_DIR));
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the failing build exits non-zero', () => {
    const failed = runViteBuild(app, { PMS_VITE_INJECT_FAILURE: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain('injected bundler failure');
  });

  test('the design system changes, so a partial publish would be visible', () => {
    // Make generation N+1 genuinely different. If the plugin had already
    // written its manifest or its module when the bundler failed, the digests
    // below would differ.
    const def = path.join(app, 'design.pms.config.mjs');
    fs.writeFileSync(
      def,
      `import def from ${JSON.stringify(SHARED_DEFINITION)};
def.tokens.spacing.md = { value: '19px', visibility: 'public' };
export default def;
`,
      'utf8',
    );
    const failed = runViteBuild(app, { PMS_VITE_INJECT_FAILURE: '1' });
    expect(failed.status).not.toBe(0);
  });

  test('every artifact is still byte-identical to generation N', () => {
    expect(digestTree(path.join(app, PANDAMSTYLE_DIR))).toEqual(before);
  });

  test('no staging or backup directory is left behind', () => {
    const strays = fs
      .readdirSync(app)
      .filter((n) => n.includes('.staging-') || n.includes('.backup-'));
    expect(strays).toEqual([]);
  });

  test('the same design system then builds cleanly and does publish', () => {
    // Proves the rollback did not simply break the output directory.
    const ok = runViteBuild(app);
    expect(ok.status).toBe(0);
    const after = digestTree(path.join(app, PANDAMSTYLE_DIR));
    expect(after).not.toEqual(before);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json'), 'utf8'),
    );
    expect(manifest.registryDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('a build that cannot publish is refused up front', () => {
  let app;

  beforeAll(() => {
    app = makeApp();
    // `build.write: false` means the bundler never calls `writeBundle`, which is
    // the plugin's only success signal. Publishing nothing would be
    // indistinguishable from having no stylesheet, so it is refused before any
    // work rather than discovered at the end of a green-looking build.
    const config = path.join(app, 'vite.config.mjs');
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace(
          '    emptyOutDir: true,',
          '    emptyOutDir: true,\n    write: false,',
        ),
      'utf8',
    );
  });

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true });
  });

  test('the build fails with a configuration diagnostic', () => {
    const result = runViteBuild(app);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('PMS_UNSUPPORTED_FEATURE');
    expect(result.output).toContain('build.write: false');
  });

  test('no generation is left behind by the refusal', () => {
    expect(
      fs.existsSync(path.join(app, PANDAMSTYLE_DIR, 'manifest.json')),
    ).toBe(false);
  });
});
