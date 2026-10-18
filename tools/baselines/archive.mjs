/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The digest-bound Alpha 1 baseline store (CE-00.3).
//
//   node tools/baselines/archive.mjs build    [--store <dir>]
//   node tools/baselines/archive.mjs manifest [--store <dir>]
//   node tools/baselines/archive.mjs verify   [--store <dir>] [--replay]
//   node tools/baselines/archive.mjs closure  --dest <dir> [--store <dir>]
//
// The store holds large binaries outside Git (default
// ~/.local/share/pandamstyle-baselines/alpha1). Git holds the manifest
// (benchmarks/core-evolution/epochs/alpha1/manifest.v1.json) and the closure
// lockfile. `build` reconstructs the store from the immutable baseline commit,
// the npm registry, nodejs.org and the Playwright CDN; `manifest` records the
// store's identities; `verify` recomputes every recorded digest, and with
// --replay also reinstalls the closure offline from the committed lockfile and
// the archived npm cache, re-creates the source archive and compares both.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BENCH,
  DEFAULT_STORE,
  REPO,
  fileSha256,
  readJson,
  sha1,
  sha256,
  sha512Integrity,
  treeDigest,
  writeJson,
} from './lib.mjs';

export const EPOCH = 'alpha1';
export const COMMIT = '415e05539fcb5d36a78226112b5cf488b200b1aa';
export const RELEASE_TAG = 'v0.1.0-alpha.1';
export const VERSION = '0.1.0-alpha.1';
export const PACKAGES = ['core', 'compiler', 'vite', 'next', 'rsbuild'];
export const NODE_VERSIONS = [
  {
    version: '22.22.0',
    role: 'measurement runtime; Alpha 1 reference dataset Node version',
  },
  {
    version: '22.12.0',
    role: 'minimum engine qualified by Alpha 1 package qualification',
  },
  {
    version: '24.21.0',
    role: 'second major qualified by Alpha 1 package qualification',
  },
];
export const MEASUREMENT_NODE = '22.22.0';
export const FONT_FAMILIES = [
  'system-ui',
  'sans-serif',
  'Georgia',
  'serif',
  'ui-monospace',
  'monospace',
];
export const EPOCH_DIR = path.join(BENCH, 'epochs', EPOCH);
export const MANIFEST = path.join(EPOCH_DIR, 'manifest.v1.json');
export const CLOSURE_DIR = path.join(EPOCH_DIR, 'closure');

// Playwright writes these markers itself; they are not browser content.
const ENGINE_MARKERS = /(^|\/)(INSTALLATION_COMPLETE|DEPENDENCIES_VALIDATED)$/;
// npm's hidden lockfile records install-time metadata, not package content.
const CLOSURE_EXCLUDE = (rel) =>
  rel === 'node_modules/.package-lock.json' ||
  rel.startsWith('node_modules/.cache/');

// The npm cache digest covers content-addressed entries only; the index,
// logs and temporary files change on every (offline) use.
const NPM_CACHE_EXCLUDE = (rel) => !rel.startsWith('_cacache/content-v2/');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  return result.stdout;
}

function storeOf(argv) {
  const index = argv.indexOf('--store');
  return index >= 0
    ? path.resolve(argv[index + 1])
    : path.join(DEFAULT_STORE, EPOCH);
}

const tarball = (name) => `pandamstyle-${name}-${VERSION}.tgz`;

function tarballEntries(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-tgz-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', dir]);
    const out = new Map();
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.set(path.relative(dir, full), fileSha256(full));
      }
    };
    walk(dir);
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sourceArchiveCommand(output) {
  return `git archive --format=tar --prefix=pandamstyle-${COMMIT.slice(0, 7)}/ ${COMMIT} | gzip -n -9 > ${output}`;
}

function writeSourceArchive(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tar = execFileSync(
    'git',
    [
      'archive',
      '--format=tar',
      `--prefix=pandamstyle-${COMMIT.slice(0, 7)}/`,
      COMMIT,
    ],
    { cwd: REPO, maxBuffer: 1 << 30 },
  );
  const gz = execFileSync('gzip', ['-n', '-9'], {
    input: tar,
    maxBuffer: 1 << 30,
  });
  fs.writeFileSync(file, gz);
}

// ------------------------------------------------------------------- build

function build(store) {
  fs.mkdirSync(store, { recursive: true });
  // 1. Source archive of the baseline commit.
  writeSourceArchive(
    path.join(store, 'source', `pandamstyle-${COMMIT.slice(0, 7)}.tar.gz`),
  );

  // 2. Clean checkout of the baseline commit: install, build, pack twice.
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-alpha1-'));
  fs.rmSync(checkout, { recursive: true });
  run('git', ['worktree', 'add', '--detach', checkout, COMMIT], { cwd: REPO });
  try {
    run(
      'yarn',
      ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
      { cwd: checkout },
    );
    run('yarn', ['workspace', '@pandamstyle/compiler', 'run', 'build'], {
      cwd: checkout,
    });
    for (const kind of ['source-pack', 'source-pack-repeat']) {
      const destination = path.join(store, 'packages', kind);
      fs.mkdirSync(destination, { recursive: true });
      for (const name of PACKAGES)
        run('npm', ['pack', '--pack-destination', destination, '--silent'], {
          cwd: path.join(checkout, 'packages', name),
        });
    }
  } finally {
    run('git', ['worktree', 'remove', '--force', checkout], { cwd: REPO });
  }

  // 3. Published registry tarballs.
  const registry = path.join(store, 'packages', 'registry');
  fs.mkdirSync(registry, { recursive: true });
  for (const name of PACKAGES)
    run(
      'npm',
      [
        'pack',
        `@pandamstyle/${name}@${VERSION}`,
        '--silent',
        '--ignore-scripts',
      ],
      { cwd: registry },
    );

  // 4. Executable closure from the committed lockfile; fills the npm cache.
  const closure = path.join(store, 'closure');
  fs.rmSync(closure, { recursive: true, force: true });
  fs.mkdirSync(closure, { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(CLOSURE_DIR, file), path.join(closure, file));
  run(
    'npm',
    [
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(store, 'npm-cache'),
    ],
    { cwd: closure },
  );

  // 5. Official Node.js archives, checked against nodejs.org SHASUMS256.
  const nodeDir = path.join(store, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  for (const { version } of NODE_VERSIONS) {
    const file = `node-v${version}-linux-x64.tar.xz`;
    run('curl', [
      '-sSfL',
      '-o',
      path.join(nodeDir, file),
      `https://nodejs.org/dist/v${version}/${file}`,
    ]);
    run('curl', [
      '-sSfL',
      '-o',
      path.join(nodeDir, `SHASUMS256-v${version}.txt`),
      `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    ]);
    const expected = fs
      .readFileSync(path.join(nodeDir, `SHASUMS256-v${version}.txt`), 'utf8')
      .split('\n')
      .find((l) => l.endsWith(`  ${file}`))
      ?.split(' ')[0];
    if (expected !== fileSha256(path.join(nodeDir, file)))
      throw new Error(`${file} does not match nodejs.org SHASUMS256`);
  }
  run('tar', ['-xJf', `node-v${MEASUREMENT_NODE}-linux-x64.tar.xz`], {
    cwd: nodeDir,
  });

  // 6. Browser engine of the pinned playwright-core (closure dependency).
  run(
    process.execPath,
    [
      path.join(closure, 'node_modules/playwright-core/cli.js'),
      'install',
      'chromium',
    ],
    {
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(store, 'engines', 'ms-playwright'),
      },
    },
  );

  // 7. Fonts the reference fixtures resolve through fontconfig on this host.
  fs.mkdirSync(path.join(store, 'fonts'), { recursive: true });
  for (const family of FONT_FAMILIES) {
    const file = run('fc-match', ['-f', '%{file}', family]);
    fs.copyFileSync(file, path.join(store, 'fonts', path.basename(file)));
  }
}

// ---------------------------------------------------------------- manifest

function packageRecords(store) {
  return PACKAGES.map((name) => {
    const registryFile = path.join(store, 'packages/registry', tarball(name));
    const sourceFile = path.join(store, 'packages/source-pack', tarball(name));
    const repeatFile = path.join(
      store,
      'packages/source-pack-repeat',
      tarball(name),
    );
    const registryBytes = fs.readFileSync(registryFile);
    const sourceBytes = fs.readFileSync(sourceFile);
    const view = JSON.parse(
      run('npm', ['view', `@pandamstyle/${name}@${VERSION}`, 'dist', '--json']),
    );
    const registryEntries = tarballEntries(registryFile);
    const sourceEntries = tarballEntries(sourceFile);
    const differences = [];
    for (const file of new Set([
      ...registryEntries.keys(),
      ...sourceEntries.keys(),
    ]))
      if (registryEntries.get(file) !== sourceEntries.get(file))
        differences.push({
          file,
          registrySha256: registryEntries.get(file) ?? null,
          sourcePackSha256: sourceEntries.get(file) ?? null,
        });
    return {
      name: `@pandamstyle/${name}`,
      version: VERSION,
      registry: {
        tarball: view.tarball,
        file: `packages/registry/${tarball(name)}`,
        bytes: registryBytes.length,
        sha256: sha256(registryBytes),
        integrity: sha512Integrity(registryBytes),
        shasum: sha1(registryBytes),
        registryIntegrity: view.integrity,
        registryShasum: view.shasum,
        integrityMatchesRegistry:
          view.integrity === sha512Integrity(registryBytes) &&
          view.shasum === sha1(registryBytes),
      },
      sourcePack: {
        file: `packages/source-pack/${tarball(name)}`,
        bytes: sourceBytes.length,
        sha256: sha256(sourceBytes),
        integrity: sha512Integrity(sourceBytes),
        repeatSha256: fileSha256(repeatFile),
        reproducible: fileSha256(repeatFile) === sha256(sourceBytes),
        identicalToRegistry: sha256(sourceBytes) === sha256(registryBytes),
        contentDifferences: differences.sort((a, b) =>
          a.file < b.file ? -1 : 1,
        ),
      },
    };
  });
}

function corpusRecord(id, commit, prefixes, description) {
  const files = [];
  for (const prefix of prefixes)
    for (const file of execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', commit, '--', prefix],
      { cwd: REPO, encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean))
      files.push({
        path: file,
        sha256: sha256(
          execFileSync('git', ['cat-file', 'blob', `${commit}:${file}`], {
            cwd: REPO,
            maxBuffer: 1 << 30,
          }),
        ),
      });
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    id,
    description,
    commit,
    files: files.length,
    sha256: sha256(files.map((f) => `${f.path} ${f.sha256}`).join('\n')),
    entries: files,
  };
}

function manifest(store) {
  const closure = path.join(store, 'closure');
  const lock = readJson(path.join(CLOSURE_DIR, 'package-lock.json'));
  const hostVersion = (name) =>
    readJson(path.join(closure, 'node_modules', name, 'package.json')).version;
  const packages = packageRecords(store);
  for (const record of packages) {
    const locked = lock.packages[`node_modules/${record.name}`];
    record.closureLock = {
      resolved: locked.resolved,
      integrity: locked.integrity,
      matchesRegistryTarball: locked.integrity === record.registry.integrity,
    };
  }
  const sourceArchive = `source/pandamstyle-${COMMIT.slice(0, 7)}.tar.gz`;
  const engineRoot = path.join(store, 'engines/ms-playwright');
  const browsers = readJson(
    path.join(closure, 'node_modules/playwright-core/browsers.json'),
  ).browsers;
  const engines = ['chromium', 'chromium-headless-shell'].map((name) => {
    const entry = browsers.find((b) => b.name === name);
    const dir = `${name.replace(/-/g, '_')}-${entry.revision}`;
    return {
      name,
      browserVersion: entry.browserVersion,
      revision: entry.revision,
      playwrightCore: hostVersion('playwright-core'),
      path: `engines/ms-playwright/${dir}`,
      tree: treeDigest(path.join(engineRoot, dir), {
        exclude: (rel) => ENGINE_MARKERS.test(rel),
      }),
    };
  });
  const fonts = FONT_FAMILIES.map((family) => {
    const file = run('fc-match', ['-f', '%{file}', family]);
    return {
      family,
      resolvedFile: file,
      archived: `fonts/${path.basename(file)}`,
      sha256: fileSha256(path.join(store, 'fonts', path.basename(file))),
    };
  });
  const fcList = run('fc-list', ['--format', '%{file}\n'])
    .split('\n')
    .filter(Boolean)
    .sort();
  const optional = (command, args) => {
    try {
      return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const record = {
    schemaVersion: 1,
    kind: 'pandamstyle-baseline-epoch-manifest',
    epoch: EPOCH,
    epochKind: 'baseline',
    description:
      'Unchanged PandamStyle Alpha 1 (0.1.0-alpha.1). Every core-evolution and agentic-optimizations comparison names this epoch separately from any evolved epoch; nothing here may be rebuilt from a later commit.',
    generatedBy: 'node tools/baselines/archive.mjs manifest',
    recordedAt: new Date().toISOString(),
    store: {
      defaultPath: '~/.local/share/pandamstyle-baselines/alpha1',
      note: 'Large binaries live outside Git. Paths below are relative to the store.',
    },
    source: {
      commit: COMMIT,
      tree: execFileSync('git', ['rev-parse', `${COMMIT}^{tree}`], {
        cwd: REPO,
        encoding: 'utf8',
      }).trim(),
      archive: {
        file: sourceArchive,
        sha256: fileSha256(path.join(store, sourceArchive)),
        command: sourceArchiveCommand(sourceArchive),
      },
      release: {
        version: VERSION,
        npmDistTag: 'alpha',
        gitTag: RELEASE_TAG,
        gitTagCommit: execFileSync(
          'git',
          ['rev-parse', `${RELEASE_TAG}^{commit}`],
          { cwd: REPO, encoding: 'utf8' },
        ).trim(),
      },
      productEquivalence: {
        statement:
          'Package sources, types, manifests, build configuration, lockfile and package READMEs/licenses are identical at the release tag commit, f3e8803 and the baseline commit; the commits differ in documentation, AgentDoc catalog, CI metadata, .gitignore and typos configuration only.',
        command: `git diff --stat ${RELEASE_TAG} ${COMMIT} -- packages/*/src packages/*/types packages/*/package.json packages/*/bin packages/*/README.md packages/*/LICENSE packages/*/ATTRIBUTIONS.md packages/compiler/rollup.config.mjs package.json yarn.lock`,
        output: execFileSync(
          'git',
          [
            'diff',
            '--stat',
            RELEASE_TAG,
            COMMIT,
            '--',
            'packages/*/src',
            'packages/*/types',
            'packages/*/package.json',
            'packages/*/bin',
            'packages/*/README.md',
            'packages/*/LICENSE',
            'packages/*/ATTRIBUTIONS.md',
            'packages/compiler/rollup.config.mjs',
            'package.json',
            'yarn.lock',
          ],
          { cwd: REPO, encoding: 'utf8' },
        ).trim(),
      },
    },
    lockfiles: [
      {
        path: 'yarn.lock',
        commit: COMMIT,
        sha256: sha256(
          execFileSync('git', ['cat-file', 'blob', `${COMMIT}:yarn.lock`], {
            cwd: REPO,
            maxBuffer: 1 << 30,
          }),
        ),
        role: 'workspace install used to build and pack the source tarballs',
      },
      {
        path: path.relative(REPO, path.join(CLOSURE_DIR, 'package-lock.json')),
        sha256: fileSha256(path.join(CLOSURE_DIR, 'package-lock.json')),
        role: 'executable closure: published Alpha 1 packages and the exact qualified hosts',
      },
      {
        path: path.relative(REPO, path.join(CLOSURE_DIR, 'package.json')),
        sha256: fileSha256(path.join(CLOSURE_DIR, 'package.json')),
        role: 'executable closure manifest',
      },
    ],
    packages,
    closure: {
      path: 'closure',
      install:
        'npm ci --offline --ignore-scripts --no-audit --no-fund --cache <store>/npm-cache',
      installedTree: treeDigest(path.join(closure, 'node_modules'), {
        exclude: (rel) => CLOSURE_EXCLUDE(`node_modules/${rel}`),
      }),
      installedPandamstyle: treeDigest(
        path.join(closure, 'node_modules/@pandamstyle'),
      ),
      lockedPackages: Object.keys(lock.packages).filter((k) => k !== '').length,
      hosts: {
        vite: hostVersion('vite'),
        '@vitejs/plugin-react': hostVersion('@vitejs/plugin-react'),
        next: hostVersion('next'),
        '@rsbuild/core': hostVersion('@rsbuild/core'),
        '@rspack/core': hostVersion('@rspack/core'),
        react: hostVersion('react'),
        'react-dom': hostVersion('react-dom'),
        typescript: hostVersion('typescript'),
        'playwright-core': hostVersion('playwright-core'),
        rolldown: hostVersion('rolldown'),
        '@babel/core': hostVersion('@babel/core'),
      },
      hostModes: [
        'Vite 8.3.1: Rolldown development and production',
        'Next.js 16.3.8: webpack development and production; Turbopack semantic development and strict production',
        'Rsbuild 2.2.11 with Rspack 2.2.8: development and production',
      ],
      note: 'The published compiler declares caret ranges for its Babel/CSS dependencies; this lockfile freezes the resolution observed when the closure was created. React 19.3.0 follows tools/pms/package-qualification.js; the Vite pilot itself pins React 19.2.0.',
      npmCache: {
        path: 'npm-cache',
        tree: treeDigest(path.join(store, 'npm-cache'), {
          exclude: NPM_CACHE_EXCLUDE,
        }),
      },
    },
    node: NODE_VERSIONS.map(({ version, role }) => {
      const file = `node/node-v${version}-linux-x64.tar.xz`;
      return {
        version,
        role,
        file,
        sha256: fileSha256(path.join(store, file)),
        shasumsFile: `node/SHASUMS256-v${version}.txt`,
        source: `https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`,
      };
    }),
    measurementNode: {
      version: MEASUREMENT_NODE,
      binary: `node/node-v${MEASUREMENT_NODE}-linux-x64/bin/node`,
    },
    engines,
    unpinnedObserved: [
      {
        what: '/usr/local/bin/chromium (Alpha 1 Next qualification default executable)',
        version: optional('/usr/local/bin/chromium', ['--version']),
        pinned: false,
      },
      {
        what: '/opt/google/chrome/chrome (Alpha 1 Rsbuild qualification default executable)',
        version: optional('/opt/google/chrome/chrome', ['--version']),
        pinned: false,
      },
      {
        what: 'playwright-core used by tools/pilot/run-rsbuild-qualification.js',
        version: '1.56.1',
        pinned: false,
      },
    ],
    unpinnedNote:
      'Alpha 1 host qualification scripts launch a system browser unless PMS_CHROMIUM is set. Those executables update outside this repository and are recorded, not pinned. Reproductions must set PMS_CHROMIUM to the archived engine executable.',
    fonts: {
      fontconfig:
        spawnSync('fc-match', ['--version'], { encoding: 'utf8' })
          .stderr.trim()
          .split('\n')[0] || null,
      resolutions: fonts,
      fcListFiles: fcList.length,
      fcListSha256: sha256(fcList.join('\n')),
    },
    assets: corpusRecord(
      'alpha1-assets',
      COMMIT,
      ['assets'],
      'Repository assets at the baseline commit (no package ships assets).',
    ),
    corpora: [
      corpusRecord(
        'ce-00.2-proof-corpus',
        '20ce741b8cdd1616560af7cd8be1420024414409',
        ['tests/core-evolution/corpus'],
        'CE-00.2 proof corpus, calibration and accounting as merged (PR #90).',
      ),
      corpusRecord(
        'alpha1-compiler-fixtures',
        COMMIT,
        ['packages/compiler/__tests__/pandamstyle/fixtures', 'tests/fixtures'],
        'Alpha 1 compiler and design-system fixtures at the baseline commit.',
      ),
      corpusRecord(
        'alpha1-vite-pilot',
        COMMIT,
        ['examples/pilots/vite-react'],
        'Alpha 1 Vite React pilot application at the baseline commit.',
      ),
    ],
    reconstruction: [
      'git clone https://github.com/lbframe/pandam-style && cd pandam-style   # any commit containing this manifest',
      'node tools/baselines/archive.mjs build --store <empty dir>   # network: npm registry, nodejs.org, Playwright CDN',
      'node tools/baselines/archive.mjs verify --store <dir> --replay',
    ],
    agReuse:
      'AG-00.3 runs against the same store: use <store>/closure/node_modules (published 0.1.0-alpha.1 packages and hosts) and <store>/node/node-v22.22.0-linux-x64/bin/node, label results with epoch "alpha1", and check `archive.mjs verify` first. CE measurements do not complete the AG multi-model agent-efficiency baseline.',
  };
  writeJson(MANIFEST, record);
  return record;
}

// ------------------------------------------------------------------ verify

// Installs the closure offline from the committed lockfile and the archived
// npm cache into `dest`, and checks the installed trees against the manifest.
export function installClosure(store, dest) {
  const record = readJson(MANIFEST);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(CLOSURE_DIR, file), path.join(dest, file));
  run(
    'npm',
    [
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(store, 'npm-cache'),
    ],
    { cwd: dest },
  );
  const tree = treeDigest(path.join(dest, 'node_modules'), {
    exclude: (rel) => CLOSURE_EXCLUDE(`node_modules/${rel}`),
  }).sha256;
  if (tree !== record.closure.installedTree.sha256)
    throw new Error(
      `offline closure ${tree} differs from ${record.closure.installedTree.sha256}`,
    );
  return tree;
}

export function verify(store, { replay = false } = {}) {
  const record = readJson(MANIFEST);
  const checks = [];
  const check = (name, actual, expected) =>
    checks.push({ name, ok: actual === expected, actual, expected });
  check(
    'source archive',
    fileSha256(path.join(store, record.source.archive.file)),
    record.source.archive.sha256,
  );
  check(
    'source tree',
    execFileSync('git', ['rev-parse', `${record.source.commit}^{tree}`], {
      cwd: REPO,
      encoding: 'utf8',
    }).trim(),
    record.source.tree,
  );
  for (const lockfile of record.lockfiles) {
    const actual =
      lockfile.commit != null
        ? sha256(
            execFileSync(
              'git',
              ['cat-file', 'blob', `${lockfile.commit}:${lockfile.path}`],
              { cwd: REPO, maxBuffer: 1 << 30 },
            ),
          )
        : fileSha256(path.join(REPO, lockfile.path));
    check(`lockfile ${lockfile.path}`, actual, lockfile.sha256);
  }
  for (const pkg of record.packages) {
    const registryBytes = fs.readFileSync(path.join(store, pkg.registry.file));
    check(
      `${pkg.name} registry sha256`,
      sha256(registryBytes),
      pkg.registry.sha256,
    );
    check(
      `${pkg.name} registry integrity`,
      sha512Integrity(registryBytes),
      pkg.registry.registryIntegrity,
    );
    check(
      `${pkg.name} closure lock integrity`,
      pkg.closureLock.integrity,
      pkg.registry.registryIntegrity,
    );
    check(
      `${pkg.name} source pack sha256`,
      fileSha256(path.join(store, pkg.sourcePack.file)),
      pkg.sourcePack.sha256,
    );
  }
  check(
    'installed @pandamstyle tree',
    treeDigest(path.join(store, 'closure/node_modules/@pandamstyle')).sha256,
    record.closure.installedPandamstyle.sha256,
  );
  check(
    'installed closure tree',
    treeDigest(path.join(store, 'closure/node_modules'), {
      exclude: (rel) => CLOSURE_EXCLUDE(`node_modules/${rel}`),
    }).sha256,
    record.closure.installedTree.sha256,
  );
  for (const node of record.node)
    check(
      `node ${node.version}`,
      fileSha256(path.join(store, node.file)),
      node.sha256,
    );
  for (const engine of record.engines)
    check(
      `engine ${engine.name} ${engine.browserVersion}`,
      treeDigest(path.join(store, engine.path), {
        exclude: (rel) => ENGINE_MARKERS.test(rel),
      }).sha256,
      engine.tree.sha256,
    );
  for (const font of record.fonts.resolutions)
    check(
      `font ${font.family}`,
      fileSha256(path.join(store, font.archived)),
      font.sha256,
    );
  check(
    'npm cache content',
    treeDigest(path.join(store, 'npm-cache'), { exclude: NPM_CACHE_EXCLUDE })
      .sha256,
    record.closure.npmCache.tree.sha256,
  );
  if (replay) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-replay-'));
    try {
      writeSourceArchive(path.join(dir, 'source.tar.gz'));
      check(
        'replayed source archive',
        fileSha256(path.join(dir, 'source.tar.gz')),
        record.source.archive.sha256,
      );
      const closure = path.join(dir, 'closure');
      installClosure(store, closure);
      check(
        'replayed closure tree (offline npm ci)',
        treeDigest(path.join(closure, 'node_modules'), {
          exclude: (rel) => CLOSURE_EXCLUDE(`node_modules/${rel}`),
        }).sha256,
        record.closure.installedTree.sha256,
      );
      check(
        'replayed @pandamstyle tree',
        treeDigest(path.join(closure, 'node_modules/@pandamstyle')).sha256,
        record.closure.installedPandamstyle.sha256,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return checks;
}

const [command, ...argv] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const store = storeOf(argv);
  if (command === 'build') build(store);
  else if (command === 'manifest') {
    // The committed manifest is frozen; a new epoch gets a new manifest.
    if (fs.existsSync(MANIFEST) && !argv.includes('--force'))
      throw new Error(
        `${path.relative(REPO, MANIFEST)} exists and is frozen; --force is only for an uncommitted manifest`,
      );
    const record = manifest(store);
    console.log(
      `wrote ${path.relative(REPO, MANIFEST)} (${record.packages.length} packages, ${record.engines.length} engines)`,
    );
  } else if (command === 'closure') {
    const index = argv.indexOf('--dest');
    if (index < 0)
      throw new Error(
        'usage: archive.mjs closure --dest <dir> [--store <dir>]',
      );
    console.log(
      `installed ${installClosure(store, path.resolve(argv[index + 1]))}`,
    );
  } else if (command === 'verify') {
    const checks = verify(store, { replay: argv.includes('--replay') });
    for (const c of checks)
      console.log(
        `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` (actual ${c.actual}, expected ${c.expected})`}`,
      );
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`${checks.length - failed}/${checks.length} checks passed`);
    if (failed > 0) process.exitCode = 1;
  } else {
    console.error(
      'usage: archive.mjs build|manifest|verify|closure [--store <dir>] [--replay] [--dest <dir>]',
    );
    process.exitCode = 2;
  }
}
