#!/usr/bin/env bash
# Pack and qualify the real PandamStyle Vite adapter in an app outside the repo.
set -euo pipefail
unset NODE_PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${1:-${PMS_PILOT_DIR:-/tmp/pandamstyle-vite-pilot}}"
PILOT_SRC="${REPO_ROOT}/examples/pilots/vite-react"
PACK_DIR="${WORK_DIR}/.tarballs"
APP_DIR="${WORK_DIR}/app"

rm -rf "${WORK_DIR}"
mkdir -p "${PACK_DIR}"

echo "== pack the compiler, core runtime, and Vite adapter =="
for package in compiler core vite; do
  cd "${REPO_ROOT}/packages/${package}"
  npm pack --pack-destination "${PACK_DIR}" --silent
done

echo "== verify packed exports and the explicit Vite peer =="
node --input-type=module - "${PACK_DIR}" <<'NODE'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packDir = process.argv[2];
const expected = new Map([
  ['@pandamstyle/compiler', null],
  ['@pandamstyle/core', null],
  ['@pandamstyle/vite', null],
]);
const proof = [];
for (const filename of fs.readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'))) {
  const file = path.join(packDir, filename);
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }));
  if (expected.has(manifest.name)) expected.set(manifest.name, { file, manifest });
}
for (const [name, packed] of expected) {
  assert.ok(packed, `missing packed package ${name}`);
  const files = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' }).trim().split('\n');
  const packageFiles = new Set(files.map((entry) => entry.replace(/^package\//, '')));
  for (const [exportName, value] of Object.entries(packed.manifest.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value);
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const normalized = target.replace(/^\.\//, '');
      assert.ok(packageFiles.has(normalized), `${name} export ${exportName} target missing: ${target}`);
    }
  }
  console.log(`${name}@${packed.manifest.version}: ${files.length} packed files`);
}
assert.deepEqual(expected.get('@pandamstyle/vite').manifest.exports, {
  '.': {
    types: './types/index.d.ts',
    import: './src/index.js',
  },
  './package.json': './package.json',
});
  assert.equal(expected.get('@pandamstyle/vite').manifest.peerDependencies.vite, '7.3.2');
assert.equal(expected.get('@pandamstyle/vite').manifest.dependencies['@pandamstyle/compiler'], '0.1.0');
for (const [name, packed] of expected) {
  proof.push({
    name,
    version: packed.manifest.version,
    tarball: path.basename(packed.file),
    packedBytes: fs.statSync(packed.file).size,
    fileCount: execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' }).trim().split('\n').length,
    exports: packed.manifest.exports ?? {},
    dependencies: packed.manifest.dependencies ?? {},
    peerDependencies: packed.manifest.peerDependencies ?? {},
  });
}
fs.writeFileSync(path.resolve(packDir, '..', 'package-proof.json'), `${JSON.stringify({ packages: proof }, null, 2)}\n`);
NODE

echo "== install packed packages into a temporary external Vite app =="
cp -R "${PILOT_SRC}" "${APP_DIR}"
rm -rf "${APP_DIR}/node_modules" "${APP_DIR}/dist" "${APP_DIR}/.pandamstyle"
node - "${APP_DIR}" "${PACK_DIR}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const appDir = process.argv[2];
const packDir = process.argv[3];
const manifests = fs.readdirSync(packDir).filter((file) => file.endsWith('.tgz')).map((file) => {
  const tarball = path.join(packDir, file);
  const json = require('node:child_process').execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
  return { file, name: JSON.parse(json).name };
});
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
for (const name of ['@pandamstyle/compiler', '@pandamstyle/core', '@pandamstyle/vite']) {
  const packed = manifests.find((entry) => entry.name === name);
  if (!packed) throw new Error(`missing tarball for ${name}`);
  pkg.dependencies[name] = `file:${path.join(packDir, packed.file)}`;
}
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
NODE

cd "${APP_DIR}"
npm install --no-audit --no-fund --loglevel=error

echo "== prove the app resolves installed tarballs outside the repo =="
node - "${REPO_ROOT}" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(process.argv[2]);
const packages = [];
assert.equal(process.env.NODE_PATH, undefined);
for (const name of ['@pandamstyle/compiler', '@pandamstyle/core', '@pandamstyle/vite']) {
  const packagePath = require.resolve(`${name}/package.json`);
  const real = fs.realpathSync(path.dirname(packagePath));
  assert.equal(fs.lstatSync(path.dirname(packagePath)).isSymbolicLink(), false);
  assert.ok(!real.startsWith(`${repoRoot}${path.sep}`), `${name} resolved inside repository: ${real}`);
  const manifest = require(packagePath);
  console.log(`${name}@${manifest.version}: ${real}`);
  packages.push({
    name,
    version: manifest.version,
    realpath: real,
    outsideRepository: !real.startsWith(`${repoRoot}${path.sep}`),
  });
}
const vitePackage = require('@pandamstyle/vite/package.json');
assert.equal(vitePackage.peerDependencies.vite, '7.3.2');
fs.writeFileSync(path.resolve(process.cwd(), '..', 'external-install-proof.json'), `${JSON.stringify({
  repository: repoRoot,
  app: process.cwd(),
  viteVersion: require('vite/package.json').version,
  nodePathUnset: process.env.NODE_PATH === undefined,
  workspaceSymlinks: false,
  packages,
}, null, 2)}\n`);
NODE

node --input-type=module <<'NODE'
await import('@pandamstyle/compiler');
await import('@pandamstyle/compiler/config');
await import('@pandamstyle/compiler/host');
await import('@pandamstyle/core');
const adapter = await import('@pandamstyle/vite');
if (typeof adapter.pandamstyle !== 'function') throw new Error('pandamstyle() export missing');
console.log('public compiler SDK and @pandamstyle/vite exports load from installed tarballs');
NODE

echo "== run the Vite development, HMR, isolation, and production qualification =="
cp "${REPO_ROOT}/tools/pilot/qualify-vite.mjs" "${APP_DIR}/.qualify-vite.mjs"
node "${APP_DIR}/.qualify-vite.mjs" "${APP_DIR}" "${WORK_DIR}/pilot-report.json"

echo
echo "PILOT OK: ${APP_DIR}"
