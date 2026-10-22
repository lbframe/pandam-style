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
//   node tools/baselines/archive.mjs candidate-pack --dest <empty dir>
//   node tools/baselines/archive.mjs candidate-manifest --epoch <name> --dest <dir> [--epochs-dir <dir>]
//
// Candidate epochs (CE-02.1): `candidate-pack` packs the five packages of the
// committed HEAD from a clean detached checkout (twice, to record
// reproducibility) and installs a candidate closure next to them, with the
// alpha1 closure's host pins. `candidate-manifest` records that closure as
// benchmarks/core-evolution/epochs/<name>/manifest.v1.json, with its closure
// package.json and lockfile. It never overwrites an epoch: an existing epoch
// directory, `alpha1`, or a name that is not a plain lowercase identifier is
// refused.
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
import crypto from 'node:crypto';
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

export const NPM_CACHE_RECORD = path.join(EPOCH_DIR, 'npm-cache.v1.json');

// Tree selections are file-level predicates: fileTreeDigest always descends
// into every directory and asks the predicate only about files and symlinks,
// so a selection can never prune the ancestors of a file it includes. (The
// manifest's npmCache.tree was recorded with a directory-pruning exclude that
// pruned `_cacache` itself and digested nothing; see npm-cache.v1.json.)

// Playwright writes these markers itself; they are not browser content.
const ENGINE_MARKERS = /(^|\/)(INSTALLATION_COMPLETE|DEPENDENCIES_VALIDATED)$/;
export const ENGINE_FILES = (rel) => !ENGINE_MARKERS.test(rel);
// npm's hidden lockfile records install-time metadata, not package content.
export const CLOSURE_FILES = (rel) =>
  rel !== '.package-lock.json' && !rel.startsWith('.cache/');
// The npm cache record covers content-addressed entries only; the index,
// logs and temporary files change on every (offline) use.
export const NPM_CACHE_FILES = (rel) => rel.startsWith('_cacache/content-v2/');

// Same line format and digest as lib.mjs treeDigest without a filter.
export function fileTreeDigest(root, include = () => true) {
  const lines = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!include(rel)) continue;
      if (entry.isSymbolicLink())
        lines.push(`l ${rel} ${fs.readlinkSync(full)}`);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        lines.push(
          `f ${rel} ${stat.mode & 0o111 ? 'x' : '-'} ${fileSha256(full)}`,
        );
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(root);
  return { sha256: sha256(lines.join('\n')), files, bytes };
}

// A tree digest that is expected to be non-empty must cover at least one file
// and at least the recorded minimum; otherwise it proves nothing.
export function vacuity(name, tree, minFiles = 1) {
  if (!(tree.files >= Math.max(1, minFiles)))
    return `${name}: digest covers ${tree.files} files, expected at least ${Math.max(1, minFiles)} (vacuous)`;
  return null;
}

function cachePath(cacheRoot, integrity) {
  const [algorithm, base64] = integrity.split('-');
  const hex = Buffer.from(base64, 'base64').toString('hex');
  return path.join(
    cacheRoot,
    '_cacache/content-v2',
    algorithm,
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

// The npm cache binding: the content-addressed inventory, and every lockfile
// package installed in the closure present in the cache with bytes matching
// its lockfile integrity.
export function npmCacheInventory(store) {
  const cache = path.join(store, 'npm-cache');
  const lock = readJson(path.join(CLOSURE_DIR, 'package-lock.json'));
  const lines = [];
  const missing = [];
  let installed = 0;
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === '' || entry.integrity == null) continue;
    if (!fs.existsSync(path.join(store, 'closure', key, 'package.json')))
      continue;
    installed++;
    const file = cachePath(cache, entry.integrity);
    const [algorithm, base64] = entry.integrity.split('-');
    const ok =
      fs.existsSync(file) &&
      crypto
        .createHash(algorithm)
        .update(fs.readFileSync(file))
        .digest('base64') === base64;
    if (ok) lines.push(`${key} ${entry.integrity}`);
    else missing.push(key);
  }
  return {
    contentTree: fileTreeDigest(cache, NPM_CACHE_FILES),
    lockedTarballs: {
      installedPackages: installed,
      cachedAndVerified: lines.length,
      missing,
      sha256: sha256(lines.join('\n')),
    },
  };
}

// Checks the npm cache against its record. The locked tarballs are the
// reproducible binding and are always checked; the full content inventory
// identifies the archived store's cache (the original install also cached
// registry metadata) and is checked unless `rebuilt` is set. The cache must
// never cover fewer content entries than the locked tarballs.
export function npmCacheProblems(store, record, { rebuilt = false } = {}) {
  const now = npmCacheInventory(store);
  const problems = [];
  const notes = [];
  const vacuous = vacuity(
    'npm cache content',
    now.contentTree,
    record.lockedTarballs.cachedAndVerified,
  );
  if (vacuous) problems.push(vacuous);
  const t = now.lockedTarballs;
  if (t.missing.length > 0)
    problems.push(
      `npm cache lacks verified tarballs for ${t.missing.join(', ')}`,
    );
  for (const field of ['installedPackages', 'cachedAndVerified', 'sha256'])
    if (t[field] !== record.lockedTarballs[field])
      problems.push(
        `npm cache locked tarballs ${field} ${t[field]} differs from ${record.lockedTarballs[field]}`,
      );
  const inventoryDiffers = ['sha256', 'files', 'bytes'].filter(
    (f) => now.contentTree[f] !== record.contentTree[f],
  );
  if (inventoryDiffers.length > 0) {
    const text = `npm cache content inventory ${now.contentTree.sha256.slice(0, 12)}… (${now.contentTree.files} files, ${now.contentTree.bytes} bytes) differs from the archived ${record.contentTree.sha256.slice(0, 12)}… (${record.contentTree.files} files, ${record.contentTree.bytes} bytes)`;
    if (rebuilt) notes.push(`${text}; expected for a rebuilt store`);
    else problems.push(text);
  }
  return { problems, notes, inventory: now };
}

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

  // 8. No built tree may be vacuous: the recorded file counts are minimums.
  const problems = builtTreeProblems(store);
  if (problems.length > 0)
    throw new Error(`vacuous build: ${problems.join('; ')}`);
}

// Non-vacuous guard for a built store: every tree the manifest and the npm
// cache record bind must cover at least its recorded number of files, and
// every installed locked package must be cached with a matching integrity.
export function builtTreeProblems(store) {
  const record = readJson(MANIFEST);
  const problems = [];
  const guard = (name, tree, minFiles) => {
    const vacuous = vacuity(name, tree, minFiles);
    if (vacuous) problems.push(vacuous);
  };
  guard(
    'installed closure tree',
    fileTreeDigest(path.join(store, 'closure/node_modules'), CLOSURE_FILES),
    record.closure.installedTree.files,
  );
  guard(
    'installed @pandamstyle tree',
    fileTreeDigest(path.join(store, 'closure/node_modules/@pandamstyle')),
    record.closure.installedPandamstyle.files,
  );
  for (const engine of record.engines)
    guard(
      `engine ${engine.name}`,
      fileTreeDigest(path.join(store, engine.path), ENGINE_FILES),
      engine.tree.files,
    );
  const inventory = npmCacheInventory(store);
  const minimum = fs.existsSync(NPM_CACHE_RECORD)
    ? readJson(NPM_CACHE_RECORD).lockedTarballs.cachedAndVerified
    : inventory.lockedTarballs.installedPackages;
  guard('npm cache content', inventory.contentTree, minimum);
  if (inventory.lockedTarballs.missing.length > 0)
    problems.push(
      `npm cache lacks verified tarballs for ${inventory.lockedTarballs.missing.join(', ')}`,
    );
  return problems;
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

// Git-pinned inputs recorded file by file: [id, commit, prefixes, description].
export const CORPORA = Object.freeze({
  assets: [
    'alpha1-assets',
    COMMIT,
    ['assets'],
    'Repository assets at the baseline commit (no package ships assets).',
  ],
  corpora: [
    [
      'ce-00.2-proof-corpus',
      '20ce741b8cdd1616560af7cd8be1420024414409',
      ['tests/core-evolution/corpus'],
      'CE-00.2 proof corpus, calibration and accounting as merged (PR #90).',
    ],
    [
      'alpha1-compiler-fixtures',
      COMMIT,
      ['packages/compiler/__tests__/pandamstyle/fixtures', 'tests/fixtures'],
      'Alpha 1 compiler and design-system fixtures at the baseline commit.',
    ],
    [
      'alpha1-vite-pilot',
      COMMIT,
      ['examples/pilots/vite-react'],
      'Alpha 1 Vite React pilot application at the baseline commit.',
    ],
  ],
});

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
      tree: fileTreeDigest(path.join(engineRoot, dir), ENGINE_FILES),
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
      installedTree: fileTreeDigest(
        path.join(closure, 'node_modules'),
        CLOSURE_FILES,
      ),
      installedPandamstyle: fileTreeDigest(
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
        tree: fileTreeDigest(path.join(store, 'npm-cache'), NPM_CACHE_FILES),
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
    assets: corpusRecord(...CORPORA.assets),
    corpora: CORPORA.corpora.map((args) => corpusRecord(...args)),
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
  const tree = fileTreeDigest(
    path.join(dest, 'node_modules'),
    CLOSURE_FILES,
  ).sha256;
  if (tree !== record.closure.installedTree.sha256)
    throw new Error(
      `offline closure ${tree} differs from ${record.closure.installedTree.sha256}`,
    );
  return tree;
}

export function verify(store, { replay = false, rebuilt = false } = {}) {
  const record = readJson(MANIFEST);
  const checks = [];
  const notes = [];
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
  // Tree checks: digest equality plus a non-vacuous guard against the
  // recorded file count.
  const treeCheck = (name, tree, recorded) => {
    const vacuous = vacuity(name, tree, recorded.files);
    checks.push({
      name,
      ok:
        vacuous == null &&
        tree.sha256 === recorded.sha256 &&
        tree.files === recorded.files,
      actual: vacuous ?? `${tree.sha256} (${tree.files} files)`,
      expected: `${recorded.sha256} (${recorded.files} files)`,
    });
  };
  treeCheck(
    'installed @pandamstyle tree',
    fileTreeDigest(path.join(store, 'closure/node_modules/@pandamstyle')),
    record.closure.installedPandamstyle,
  );
  treeCheck(
    'installed closure tree',
    fileTreeDigest(path.join(store, 'closure/node_modules'), CLOSURE_FILES),
    record.closure.installedTree,
  );
  for (const node of record.node)
    check(
      `node ${node.version}`,
      fileSha256(path.join(store, node.file)),
      node.sha256,
    );
  for (const engine of record.engines)
    treeCheck(
      `engine ${engine.name} ${engine.browserVersion}`,
      fileTreeDigest(path.join(store, engine.path), ENGINE_FILES),
      engine.tree,
    );
  for (const font of record.fonts.resolutions)
    check(
      `font ${font.family}`,
      fileSha256(path.join(store, font.archived)),
      font.sha256,
    );
  // Erratum: the manifest's npmCache.tree is vacuous (0 files) and binds
  // nothing; it is reported, never counted as a check. The binding is the
  // separate npm-cache.v1.json record.
  notes.push(
    `manifest closure.npmCache.tree is vacuous (${record.closure.npmCache.tree.files} files, ${record.closure.npmCache.tree.sha256.slice(0, 12)}…); superseded by ${path.relative(REPO, NPM_CACHE_RECORD)}`,
  );
  if (!fs.existsSync(NPM_CACHE_RECORD))
    checks.push({
      name: 'npm cache record',
      ok: false,
      actual: 'missing',
      expected: path.relative(REPO, NPM_CACHE_RECORD),
    });
  else {
    const cacheRecord = readJson(NPM_CACHE_RECORD);
    const { problems, notes: cacheNotes } = npmCacheProblems(
      store,
      cacheRecord,
      { rebuilt },
    );
    notes.push(...cacheNotes);
    checks.push({
      name: rebuilt
        ? `npm cache locked tarballs (${cacheRecord.lockedTarballs.cachedAndVerified} verified; rebuilt store)`
        : `npm cache content (${cacheRecord.contentTree.files} files, ${cacheRecord.lockedTarballs.cachedAndVerified} verified locked tarballs)`,
      ok: problems.length === 0,
      actual: problems.join('; ') || 'matches',
      expected: 'matches npm-cache.v1.json',
    });
  }
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
      treeCheck(
        'replayed closure tree (offline npm ci)',
        fileTreeDigest(path.join(closure, 'node_modules'), CLOSURE_FILES),
        record.closure.installedTree,
      );
      treeCheck(
        'replayed @pandamstyle tree',
        fileTreeDigest(path.join(closure, 'node_modules/@pandamstyle')),
        record.closure.installedPandamstyle,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  checks.notes = notes;
  return checks;
}

// ------------------------------------------------------- candidate epochs

const EPOCH_NAME = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const EPOCHS_DIR = path.join(BENCH, 'epochs');
const HOST_PINS = path.join(CLOSURE_DIR, 'package.json');
const CANDIDATE_RECORD = 'candidate.json';

function git(args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

const packFile = (name, version) => `pandamstyle-${name}-${version}.tgz`;

/**
 * Packs the committed HEAD and installs its candidate closure into `dest`:
 * `packs/`, `packs-repeat/`, `closure/` (package.json, package-lock.json,
 * packs/, node_modules/) and `candidate.json` (the packed commit). Refuses a
 * dirty worktree: a candidate is a commit, never uncommitted bytes.
 */
export function candidatePack(dest) {
  if (git(['status', '--porcelain']) !== '')
    throw new Error('candidate-pack needs a clean worktree: commit first');
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0)
    throw new Error(`${dest} is not empty`);
  fs.mkdirSync(dest, { recursive: true });
  const commit = git(['rev-parse', 'HEAD']);
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-candidate-'));
  fs.rmSync(checkout, { recursive: true });
  run('git', ['worktree', 'add', '--detach', checkout, commit], { cwd: REPO });
  try {
    run(
      'yarn',
      ['install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'],
      { cwd: checkout },
    );
    run('yarn', ['workspace', '@pandamstyle/compiler', 'run', 'build'], {
      cwd: checkout,
    });
    for (const kind of ['packs', 'packs-repeat']) {
      fs.mkdirSync(path.join(dest, kind), { recursive: true });
      for (const name of PACKAGES)
        run(
          'npm',
          ['pack', '--pack-destination', path.join(dest, kind), '--silent'],
          { cwd: path.join(checkout, 'packages', name) },
        );
    }
  } finally {
    run('git', ['worktree', 'remove', '--force', checkout], { cwd: REPO });
  }
  const closure = path.join(dest, 'closure');
  fs.mkdirSync(path.join(closure, 'packs'), { recursive: true });
  const pins = readJson(HOST_PINS);
  const dependencies = { ...pins.dependencies };
  for (const name of PACKAGES) {
    const file = fs
      .readdirSync(path.join(dest, 'packs'))
      .find((f) => f.startsWith(`pandamstyle-${name}-`));
    fs.copyFileSync(
      path.join(dest, 'packs', file),
      path.join(closure, 'packs', file),
    );
    dependencies[`@pandamstyle/${name}`] = `file:packs/${file}`;
  }
  writeJson(path.join(closure, 'package.json'), {
    name: 'pandamstyle-candidate-closure',
    private: true,
    description:
      'Candidate epoch closure: the packed PandamStyle packages of one commit and the alpha1 closure host pins.',
    dependencies,
  });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: closure,
  });
  writeJson(path.join(dest, CANDIDATE_RECORD), { commit });
  return commit;
}

/**
 * Records the candidate closure in `dest` as epoch `name`. Returns the
 * manifest. Never overwrites: refuses `alpha1`, an existing epoch directory and
 * any name that is not a plain lowercase identifier.
 */
export function candidateManifest(name, dest, epochsDir = EPOCHS_DIR) {
  if (typeof name !== 'string' || !EPOCH_NAME.test(name) || name === EPOCH)
    throw new Error(`refused epoch name ${JSON.stringify(name)}`);
  const epochDir = path.join(epochsDir, name);
  if (fs.existsSync(epochDir))
    throw new Error(`${name} exists: an epoch is never overwritten`);
  const { commit } = readJson(path.join(dest, CANDIDATE_RECORD));
  if (!/^[0-9a-f]{40}$/.test(commit ?? ''))
    throw new Error('candidate.json has no commit');
  const tree = git(['rev-parse', `${commit}^{tree}`]);
  const closure = path.join(dest, 'closure');
  const lock = readJson(path.join(closure, 'package-lock.json'));
  // Every locked package resolves to the registry or to a pack inside the
  // closure: no absolute or machine-local path enters the record.
  for (const [key, entry] of Object.entries(lock.packages))
    if (
      key !== '' &&
      entry.resolved != null &&
      !entry.resolved.startsWith('https://registry.npmjs.org/') &&
      !/^file:packs\/[^/]+\.tgz$/.test(entry.resolved)
    )
      throw new Error(`${key} resolves outside the registry and packs/`);
  const packages = PACKAGES.map((short) => {
    const lockKey = `node_modules/@pandamstyle/${short}`;
    const locked = lock.packages[lockKey];
    if (locked == null) throw new Error(`${lockKey} is not in the lockfile`);
    const version = locked.version;
    const file = packFile(short, version);
    const bytes = fs.readFileSync(path.join(dest, 'packs', file));
    const repeat = path.join(dest, 'packs-repeat', file);
    const integrity = sha512Integrity(bytes);
    if (locked.integrity !== integrity)
      throw new Error(`${lockKey} lock integrity differs from packs/${file}`);
    if (
      sha256(fs.readFileSync(path.join(closure, 'packs', file))) !==
      sha256(bytes)
    )
      throw new Error(`closure/packs/${file} differs from packs/${file}`);
    return {
      name: `@pandamstyle/${short}`,
      version,
      pack: {
        file: `packs/${file}`,
        bytes: bytes.length,
        sha256: sha256(bytes),
        integrity,
        shasum: sha1(bytes),
        repeatSha256: fs.existsSync(repeat) ? fileSha256(repeat) : null,
        reproducible: fs.existsSync(repeat)
          ? fileSha256(repeat) === sha256(bytes)
          : null,
      },
      closureLock: {
        resolved: locked.resolved,
        integrity: locked.integrity,
        matchesPack: true,
      },
    };
  });
  const hostVersion = (pkg) =>
    readJson(path.join(closure, 'node_modules', pkg, 'package.json')).version;
  const record = {
    schemaVersion: 1,
    kind: 'pandamstyle-baseline-epoch-manifest',
    epoch: name,
    epochKind: 'candidate',
    description:
      'Candidate epoch: the PandamStyle packages packed from one commit and installed with the alpha1 closure host pins. Compare it with alpha1 by name; it never replaces alpha1.',
    generatedBy: `node tools/baselines/archive.mjs candidate-manifest --epoch ${name}`,
    recordedAt: new Date().toISOString(),
    store: {
      note: 'The packs and the installed closure live outside Git, produced by `archive.mjs candidate-pack`. Paths below are relative to that directory.',
    },
    source: {
      commit,
      tree,
      packedFrom:
        'a clean detached checkout of the commit (yarn install --frozen-lockfile --ignore-scripts, compiler build, npm pack)',
    },
    lockfiles: [
      {
        path: 'yarn.lock',
        commit,
        sha256: sha256(
          execFileSync('git', ['cat-file', 'blob', `${commit}:yarn.lock`], {
            cwd: REPO,
            maxBuffer: 1 << 30,
          }),
        ),
        role: 'workspace install used to build and pack the candidate',
      },
      {
        path: `benchmarks/core-evolution/epochs/${name}/closure/package-lock.json`,
        sha256: fileSha256(path.join(closure, 'package-lock.json')),
        role: 'executable closure: the candidate packs and the alpha1 host pins',
      },
      {
        path: `benchmarks/core-evolution/epochs/${name}/closure/package.json`,
        sha256: fileSha256(path.join(closure, 'package.json')),
        role: 'executable closure manifest',
      },
      {
        path: path.relative(REPO, HOST_PINS),
        sha256: fileSha256(HOST_PINS),
        role: 'host pins the closure reuses',
      },
    ],
    packages,
    closure: {
      path: 'closure',
      install:
        'copy packs/ into closure/packs/, then npm ci --ignore-scripts --no-audit --no-fund',
      installedTree: fileTreeDigest(
        path.join(closure, 'node_modules'),
        CLOSURE_FILES,
      ),
      installedPandamstyle: fileTreeDigest(
        path.join(closure, 'node_modules/@pandamstyle'),
      ),
      lockedPackages: Object.keys(lock.packages).filter((k) => k !== '').length,
      hosts: Object.fromEntries(
        Object.keys(readJson(HOST_PINS).dependencies)
          .filter((pkg) => !pkg.startsWith('@pandamstyle/'))
          .sort()
          .map((pkg) => [pkg, hostVersion(pkg)]),
      ),
    },
    node: { version: process.version },
    reconstruction: [
      `git checkout ${commit}`,
      'node tools/baselines/archive.mjs candidate-pack --dest <empty dir>',
      `compare the packs and closure digests with benchmarks/core-evolution/epochs/${name}/manifest.v1.json`,
    ],
    agReuse: `Bind an agentic qualification to this epoch by name ("${name}") and by the pack and installed-tree digests above; alpha1 stays the baseline epoch.`,
  };
  fs.mkdirSync(path.join(epochDir, 'closure'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json'])
    fs.copyFileSync(
      path.join(closure, file),
      path.join(epochDir, 'closure', file),
    );
  writeJson(path.join(epochDir, 'manifest.v1.json'), record);
  return record;
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
  } else if (command === 'candidate-pack') {
    const index = argv.indexOf('--dest');
    if (index < 0)
      throw new Error('usage: archive.mjs candidate-pack --dest <empty dir>');
    console.log(`packed ${candidatePack(path.resolve(argv[index + 1]))}`);
  } else if (command === 'candidate-manifest') {
    const value = (flag) => {
      const index = argv.indexOf(flag);
      return index < 0 ? null : argv[index + 1];
    };
    if (value('--epoch') == null || value('--dest') == null)
      throw new Error(
        'usage: archive.mjs candidate-manifest --epoch <name> --dest <dir> [--epochs-dir <dir>]',
      );
    const record = candidateManifest(
      value('--epoch'),
      path.resolve(value('--dest')),
      value('--epochs-dir') == null
        ? undefined
        : path.resolve(value('--epochs-dir')),
    );
    console.log(
      `recorded epoch ${record.epoch} (${record.packages.length} packages, commit ${record.source.commit})`,
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
  } else if (command === 'npm-cache-record') {
    // Written once from a copy of the store; the committed record is frozen.
    if (fs.existsSync(NPM_CACHE_RECORD))
      throw new Error(
        `${path.relative(REPO, NPM_CACHE_RECORD)} exists and is frozen`,
      );
    const inventory = npmCacheInventory(store);
    const vacuous = vacuity(
      'npm cache content',
      inventory.contentTree,
      inventory.lockedTarballs.installedPackages,
    );
    if (vacuous != null || inventory.lockedTarballs.missing.length > 0)
      throw new Error(
        vacuous ??
          `missing locked tarballs: ${inventory.lockedTarballs.missing.join(', ')}`,
      );
    writeJson(NPM_CACHE_RECORD, {
      schemaVersion: 1,
      kind: 'pandamstyle-baseline-npm-cache-record',
      epoch: EPOCH,
      generatedBy:
        'node tools/baselines/archive.mjs npm-cache-record --store <copy of the store>',
      erratumFor: {
        path: path.relative(REPO, MANIFEST),
        field: 'closure.npmCache.tree',
        recorded: readJson(MANIFEST).closure.npmCache.tree,
        reason:
          'Recorded with a directory-pruning exclude filter that pruned `_cacache` itself: the digest covers 0 files and binds nothing. The manifest stays unchanged because budgets.v1.json binds its digest; this record is the npm cache binding.',
      },
      store: {
        path: 'npm-cache',
        scope: '_cacache/content-v2/** (content-addressed entries)',
      },
      contentTree: {
        ...inventory.contentTree,
        description:
          'Identity of the archived store cache. The original npm install also cached registry metadata, so a store rebuilt with npm ci from the lockfile holds only the locked tarballs and does not reproduce this inventory (verify --rebuilt reports it as a note).',
      },
      lockedTarballs: {
        description:
          'Reproducible binding: every lockfile package installed in the closure has a content entry whose bytes match its lockfile integrity; optional packages for other platforms are not installed and not cached. Checked on every store, archived or rebuilt.',
        installedPackages: inventory.lockedTarballs.installedPackages,
        cachedAndVerified: inventory.lockedTarballs.cachedAndVerified,
        sha256: inventory.lockedTarballs.sha256,
      },
    });
    console.log(
      `wrote ${path.relative(REPO, NPM_CACHE_RECORD)}: ${JSON.stringify(inventory.contentTree)}`,
    );
  } else if (command === 'verify') {
    const checks = verify(store, {
      replay: argv.includes('--replay'),
      rebuilt: argv.includes('--rebuilt'),
    });
    for (const c of checks)
      console.log(
        `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ok ? '' : ` (actual ${c.actual}, expected ${c.expected})`}`,
      );
    for (const note of checks.notes) console.log(`note ${note}`);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(`${checks.length - failed}/${checks.length} checks passed`);
    if (failed > 0) process.exitCode = 1;
  } else {
    console.error(
      'usage: archive.mjs build|manifest|npm-cache-record|verify|closure [--store <dir>] [--replay] [--rebuilt] [--dest <dir>]',
    );
    process.exitCode = 2;
  }
}
