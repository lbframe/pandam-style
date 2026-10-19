/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Product build binding and trusted grading tree (DESIGN.md section 4.8,
// invariant G; F51-F53, F55). A synthetic fixture store stands in for
// ~/.local/share/pandamstyle-baselines/alpha1: the runner copies it, never
// writes the original, verifies every consumed artifact and builds the
// trusted tree by an offline install compared file by file with the tarballs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { tmpDir } from './helpers.mjs';
import { grade } from '../src/attempt.mjs';
import { checkCliIdentity } from '../src/docker.mjs';
import {
  assertNotOriginal,
  bindProductBuild,
  copyStore,
} from '../src/store.mjs';
import {
  assertNoAncestorNodeModules,
  buildTrustedTree,
  checkTrustedTree,
  nonProductLockDigest,
  verifyProductPackages,
} from '../src/trusted-tree.mjs';
import { fileSha256, sha256 } from '../src/util.mjs';
import { treeDigest } from '../../src/fs-tree.mjs';

const COMMIT = '415e05539fcb5d36a78226112b5cf488b200b1aa';
const CORPUS = { epochs: { alpha1: { product: { commits: [COMMIT] } } } };

function tar(dir, out, top) {
  const r = spawnSync('tar', ['-czf', out, '-C', dir, top], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A store with two product tarballs, a Node archive and a source archive. */
function fixtureStore() {
  const root = tmpDir('store');
  const original = path.join(root, 'original');
  const build = path.join(root, 'build');
  for (const d of ['packages/registry', 'node', 'source'])
    fs.mkdirSync(path.join(original, d), { recursive: true });
  const packages = [];
  for (const name of ['core', 'compiler']) {
    const pkg = path.join(build, name, 'package');
    fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({
        name: `@pandamstyle/${name}`,
        version: '0.1.0-test',
        main: 'lib/index.js',
      }),
    );
    fs.writeFileSync(
      path.join(pkg, 'lib/index.js'),
      `module.exports = '${name}';\n`,
    );
    const file = `packages/registry/pandamstyle-${name}-0.1.0-test.tgz`;
    tar(path.join(build, name), path.join(original, file), 'package');
    packages.push({
      name: `@pandamstyle/${name}`,
      version: '0.1.0-test',
      registry: {
        file,
        sha256: fileSha256(path.join(original, file)),
        integrity: 'sha512-test',
      },
    });
  }
  fs.writeFileSync(
    path.join(original, 'node/node.tar.xz'),
    'node runtime bytes',
  );
  const src = path.join(build, 'src', 'pandamstyle-415e055');
  fs.mkdirSync(path.join(src, 'docs/reference'), { recursive: true });
  fs.writeFileSync(path.join(src, 'docs/agent-guide.md'), '# guide\n');
  fs.writeFileSync(path.join(src, 'docs/reference/api.md'), '# api\n');
  fs.writeFileSync(path.join(src, 'docs/internal.md'), '# not for agents\n');
  tar(
    path.join(build, 'src'),
    path.join(original, 'source/src.tar.gz'),
    'pandamstyle-415e055',
  );
  const manifest = {
    epoch: 'alpha1',
    source: {
      commit: COMMIT,
      tree: 't',
      archive: {
        file: 'source/src.tar.gz',
        sha256: fileSha256(path.join(original, 'source/src.tar.gz')),
      },
    },
    packages,
    node: [
      {
        version: '22.22.0',
        file: 'node/node.tar.xz',
        sha256: fileSha256(path.join(original, 'node/node.tar.xz')),
      },
    ],
    measurementNode: { version: '22.22.0' },
  };
  const manifestPath = path.join(root, 'manifest.v1.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, original, manifestPath, manifest };
}

function closureFor(store, copy) {
  const dir = path.join(store.root, 'closure');
  fs.mkdirSync(dir, { recursive: true });
  const deps = Object.fromEntries(
    store.manifest.packages.map((p) => [
      p.name,
      `file:${path.join(copy, p.registry.file)}`,
    ]),
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'trusted', version: '1.0.0', dependencies: deps }),
  );
  const r = spawnSync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

function digestOf(dir) {
  return treeDigest(dir);
}

test('G: the store is only read from a verified copy; the original is never written', () => {
  const store = fixtureStore();
  const before = digestOf(store.original);
  const copy = path.join(store.root, 'copy');
  copyStore({ original: store.original, dest: copy });
  assert.throws(
    () => assertNotOriginal(store.original, store.original),
    (e) => e.code === 'original-store',
  );
  assert.throws(
    () => assertNotOriginal(path.join(store.original, 'x'), store.original),
    (e) => e.code === 'original-store',
  );
  assert.throws(
    () =>
      bindProductBuild({
        storeCopy: store.original,
        originalStore: store.original,
        manifestPath: store.manifestPath,
        corpus: CORPUS,
        extractDocs: false,
      }),
    (e) => e.code === 'original-store',
  );
  const { binding, agentDocsDir } = bindProductBuild({
    storeCopy: copy,
    originalStore: store.original,
    manifestPath: store.manifestPath,
    manifestSource: 'fixture',
    corpus: CORPUS,
  });
  assert.equal(binding.packages.length, 2);
  assert.equal(binding.storeCopy.verifiedArtifacts.length, 4);
  assert.match(binding.digest, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(agentDocsDir, 'docs/agent-guide.md')));
  assert.ok(fs.existsSync(path.join(agentDocsDir, 'docs/reference/api.md')));
  assert.ok(!fs.existsSync(path.join(agentDocsDir, 'docs/internal.md')));
  assert.equal(digestOf(store.original), before, 'original store unchanged');
});

test('G: a changed artifact, a wrong epoch or a pinned manifest mismatch refuses the binding', () => {
  const store = fixtureStore();
  const copy = path.join(store.root, 'copy');
  copyStore({ original: store.original, dest: copy });
  const bind = (extra = {}) =>
    bindProductBuild({
      storeCopy: copy,
      originalStore: store.original,
      manifestPath: store.manifestPath,
      corpus: CORPUS,
      extractDocs: false,
      ...extra,
    });
  assert.throws(
    () => bind({ expectedManifestSha256: '0'.repeat(64) }),
    (e) => e.code === 'manifest',
  );
  assert.throws(
    () =>
      bind({
        corpus: { epochs: { alpha1: { product: { commits: ['other'] } } } },
      }),
    (e) => e.code === 'epoch',
  );
  fs.appendFileSync(
    path.join(copy, store.manifest.packages[0].registry.file),
    'tampered',
  );
  assert.throws(
    () => bind(),
    (e) => e.code === 'artifact',
  );
});

test('G + F52: trusted tree built offline equals the tarballs; any difference or digest change is refused', () => {
  const store = fixtureStore();
  const copy = path.join(store.root, 'copy');
  copyStore({ original: store.original, dest: copy });
  const { binding } = bindProductBuild({
    storeCopy: copy,
    originalStore: store.original,
    manifestPath: store.manifestPath,
    corpus: CORPUS,
    extractDocs: false,
  });
  const closure = closureFor(store, copy);
  const tree = buildTrustedTree({
    closureDir: closure,
    dest: path.join(store.root, 'trusted'),
    binding,
    storeCopy: copy,
  });
  assert.equal(tree.matchesProductTarballs, true);
  assert.deepEqual(
    checkTrustedTree({ nodeModules: tree.nodeModules, expected: tree }),
    { digest: tree.digest, pandamstyleDigest: tree.pandamstyleDigest },
  );
  // F52: a @pandamstyle file differing from its tarball.
  fs.appendFileSync(
    path.join(tree.nodeModules, '@pandamstyle/compiler/lib/index.js'),
    '// changed\n',
  );
  assert.ok(
    verifyProductPackages({
      nodeModules: tree.nodeModules,
      binding,
      storeCopy: copy,
    }).some((p) => p.includes('lib/index.js differs')),
  );
  assert.throws(
    () => checkTrustedTree({ nodeModules: tree.nodeModules, expected: tree }),
    (e) => e.code === 'trusted-tree',
  );
  // An extra file in a product package is a difference too.
  fs.writeFileSync(
    path.join(tree.nodeModules, '@pandamstyle/core/extra.js'),
    '1',
  );
  assert.ok(
    verifyProductPackages({
      nodeModules: tree.nodeModules,
      binding,
      storeCopy: copy,
    }).some((p) => p.includes('extra.js not in the tarball')),
  );
  // A missing tree refuses grading instead of falling back to ancestors.
  assert.throws(
    () =>
      checkTrustedTree({
        nodeModules: path.join(store.root, 'absent'),
        expected: tree,
      }),
    (e) => e.code === 'trusted-tree',
  );
});

test('comparability: the non-product lock digest ignores @pandamstyle entries only', () => {
  const dir = tmpDir('lock');
  const lock = (v, other) => ({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/@pandamstyle/core': { version: v },
      'node_modules/react': { version: other },
    },
  });
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(lock('1', '19')));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(lock('2', '19')));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(lock('1', '18')));
  const d = (f) => nonProductLockDigest(path.join(dir, f));
  assert.equal(d('a.json'), d('b.json'));
  assert.notEqual(d('a.json'), d('c.json'));
});

const gradeCtx = (kind, grading) => ({
  kind,
  epoch: 'alpha1',
  grading,
  taskEntry: { name: 't', task: { expectations: { alpha1: { checks: [] } } } },
});
const gradeInputs = () => {
  const root = tmpDir('g');
  return {
    root,
    baseline: root,
    workspace: root,
    files: { response: path.join(root, 'r') },
  };
};

test('F51 provider-backed grading without the trusted tree is a hard error before grading', () => {
  let called = false;
  const evaluate = () => {
    called = true;
    return { status: 'completed', result: { verdict: 'pass', checks: [] } };
  };
  assert.throws(
    () =>
      grade(
        gradeCtx('provider-backed', { mode: 'dev-ancestor', evaluate }),
        gradeInputs(),
      ),
    (e) => e.code === 'trusted-tree',
  );
  assert.equal(called, false);
  assert.throws(
    () =>
      grade(
        gradeCtx('provider-backed', {
          mode: 'trusted',
          trustedNodeModules: null,
          trustedExpected: {},
          evaluate,
        }),
        gradeInputs(),
      ),
    (e) => e.code === 'trusted-tree',
  );
  assert.equal(called, false);
});

test('F53 a node_modules directory in an ancestor of the scratch path is refused', () => {
  const root = tmpDir('anc');
  const scratch = path.join(root, 'a/b/scratch');
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(path.join(root, 'a/node_modules'));
  assert.throws(
    () => assertNoAncestorNodeModules(path.join(scratch, 'x')),
    (e) => e.code === 'trusted-tree',
  );
  // The repository itself has node_modules: dev scratch inside it is refused in trusted mode.
  assert.throws(
    () => assertNoAncestorNodeModules(path.join(tmpDir('in-repo'), 'x')),
    /node_modules found above/,
  );
});

test('F55 CLI version or binary digest drift refuses the matrix', () => {
  const expected = {
    cli: 'claude',
    cliVersion: '2.1.303',
    cliSha256: sha256('a'),
  };
  assert.equal(
    checkCliIdentity({
      expected,
      observed: { version: '2.1.303 (Claude Code)', sha256: sha256('a') },
    }),
    true,
  );
  assert.throws(
    () =>
      checkCliIdentity({
        expected,
        observed: { version: '2.1.304 (Claude Code)', sha256: sha256('a') },
      }),
    (e) => e.code === 'drift',
  );
  assert.throws(
    () =>
      checkCliIdentity({
        expected,
        observed: { version: '2.1.303', sha256: sha256('b') },
      }),
    (e) => e.code === 'drift',
  );
});
