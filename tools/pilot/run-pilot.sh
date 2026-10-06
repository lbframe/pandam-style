#!/usr/bin/env bash
# Pack and qualify the real PandamStyle Vite adapter in an app outside the repo.
set -euo pipefail
unset NODE_PATH

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${1:-${PMS_PILOT_DIR:-/tmp/pandamstyle-vite-pilot}}"
PILOT_SRC="${REPO_ROOT}/examples/pilots/vite-react"
PACK_DIR="${WORK_DIR}/.tarballs"
REPEAT_PACK_DIR="${WORK_DIR}/.tarballs-repeat"
APP_DIR="${WORK_DIR}/app"

rm -rf "${WORK_DIR}"
mkdir -p "${PACK_DIR}" "${REPEAT_PACK_DIR}"

echo "== pack the compiler, core runtime, and Vite adapter twice =="
for package in compiler core vite; do
  cd "${REPO_ROOT}/packages/${package}"
  npm pack --pack-destination "${PACK_DIR}" --silent
  npm pack --pack-destination "${REPEAT_PACK_DIR}" --silent
done

echo "== verify repeat-pack bytes, exports, licenses, engines, and exact Vite peer =="
node --input-type=module - "${PACK_DIR}" "${REPEAT_PACK_DIR}" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packDir = process.argv[2];
const repeatPackDir = process.argv[3];
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expected = new Map([
  ['@pandamstyle/compiler', null],
  ['@pandamstyle/core', null],
  ['@pandamstyle/vite', null],
]);
const proof = [];
for (const filename of fs.readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'))) {
  const file = path.join(packDir, filename);
  const repeatFile = path.join(repeatPackDir, filename);
  assert.ok(fs.existsSync(repeatFile), `repeat pack is missing ${filename}`);
  assert.equal(sha256(repeatFile), sha256(file), `${filename} is not reproducible`);
  const manifest = JSON.parse(execFileSync('tar', ['-xOzf', file, 'package/package.json'], { encoding: 'utf8' }));
  if (expected.has(manifest.name)) expected.set(manifest.name, { file, manifest, repeatFile });
}
for (const [name, packed] of expected) {
  assert.ok(packed, `missing packed package ${name}`);
  const files = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' }).trim().split('\n');
  const packageFiles = new Set(files.map((entry) => entry.replace(/^package\//, '')));
  assert.ok(packageFiles.has('LICENSE'), `${name} is missing LICENSE`);
  assert.ok(packageFiles.has('ATTRIBUTIONS.md'), `${name} is missing ATTRIBUTIONS.md`);
  assert.equal(
    packed.manifest.engines?.node,
    '^22.12.0 || ^24.0.0 || ^26.0.0',
  );
  for (const group of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dependency, version] of Object.entries(packed.manifest[group] ?? {})) {
      assert.ok(!/^workspace:|^file:/i.test(version), `${name} has local edge ${dependency}=${version}`);
      assert.ok(!/^@(stylexjs|pandacss)\//.test(dependency), `${name} depends on donor ${dependency}`);
    }
  }
  for (const [exportName, value] of Object.entries(packed.manifest.exports ?? {})) {
    const targets = typeof value === 'string' ? [value] : Object.values(value);
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const normalized = target.replace(/^\.\//, '');
      assert.ok(packageFiles.has(normalized), `${name} export ${exportName} target missing: ${target}`);
    }
  }
  console.log(`${name}@${packed.manifest.version}: ${files.length} files, repeat pack identical`);
}
assert.deepEqual(expected.get('@pandamstyle/vite').manifest.exports, {
  '.': {
    types: './types/index.d.ts',
    import: './src/index.js',
  },
  './package.json': './package.json',
});
assert.equal(expected.get('@pandamstyle/vite').manifest.peerDependencies.vite, '8.3.1');
assert.equal(expected.get('@pandamstyle/vite').manifest.dependencies['@pandamstyle/compiler'], '0.1.0-alpha.1');
for (const [name, packed] of expected) {
  const packedFiles = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' })
    .trim()
    .split('\n');
  proof.push({
    name,
    version: packed.manifest.version,
    tarball: path.basename(packed.file),
    packedBytes: fs.statSync(packed.file).size,
    tarballSha256: sha256(packed.file),
    repeatPackIdentical: sha256(packed.file) === sha256(packed.repeatFile),
    fileCount: packedFiles.length,
    hasLicense: packedFiles.includes('package/LICENSE'),
    hasAttributions: packedFiles.includes('package/ATTRIBUTIONS.md'),
    engines: packed.manifest.engines ?? {},
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
assert.equal(vitePackage.peerDependencies.vite, '8.3.1');
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
PMS_PILOT_SOURCE_ROOT="${REPO_ROOT}" node "${APP_DIR}/.qualify-vite.mjs" "${APP_DIR}" "${WORK_DIR}/pilot-report.json"

echo "== run the complete Vite matrix on supported Node 24 =="
CURRENT_NODE_VERSION="$(node --version)"
if [[ "${CURRENT_NODE_VERSION}" == "v24.21.0" ]]; then
  echo "already running under Node 24.21.0; complete matrix ran above"
else
  npm install --save-dev --save-exact --no-audit --no-fund node24-pilot@npm:node@24.21.0 --loglevel=error
  APP_NODE24="${WORK_DIR}/app-node24"
  cp -R "${PILOT_SRC}" "${APP_NODE24}"
  ln -s "${APP_DIR}/node_modules" "${APP_NODE24}/node_modules"
  cp "${REPO_ROOT}/tools/pilot/qualify-vite.mjs" "${APP_NODE24}/.qualify-vite.mjs"
  NODE24_PILOT="${APP_DIR}/node_modules/node24-pilot/bin/node"
  test "$("${NODE24_PILOT}" --version)" = v24.21.0
  PMS_PILOT_SOURCE_ROOT="${REPO_ROOT}" "${NODE24_PILOT}" "${APP_NODE24}/.qualify-vite.mjs" "${APP_NODE24}" "${WORK_DIR}/pilot-node24-report.json"
fi

echo "== install and run the minimum-supported Node 22.12.0 lane =="
npm install --no-audit --no-fund node22-pilot@npm:node@22.12.0 --loglevel=error
NODE22_PILOT="${APP_DIR}/node_modules/node22-pilot/bin/node"
test "$("${NODE22_PILOT}" --version)" = v22.12.0
APP_NODE22="${WORK_DIR}/app-node22"
mkdir -p "${APP_NODE22}"
cp -R "${PILOT_SRC}/." "${APP_NODE22}/"
rm -rf "${APP_NODE22}/node_modules" "${APP_NODE22}/dist" "${APP_NODE22}/.pandamstyle"
node - "${APP_NODE22}" "${PACK_DIR}" <<'NODE'
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
cp "${REPO_ROOT}/tools/pilot/qualify-vite-node-minimum.mjs" "${APP_NODE22}/.qualify-vite-node-minimum.mjs"
(
  cd "${APP_NODE22}"
  PATH="$(dirname "${NODE22_PILOT}"):${PATH}" npm install --no-audit --no-fund --loglevel=error
  test "$(PATH="$(dirname "${NODE22_PILOT}"):${PATH}" node --version)" = v22.12.0
  PATH="$(dirname "${NODE22_PILOT}"):${PATH}" \
    PMS_PILOT_SOURCE_ROOT="${REPO_ROOT}" \
    node .qualify-vite-node-minimum.mjs "${APP_NODE22}" "${WORK_DIR}/pilot-node22-minimum-report.json"
)

echo
echo "PILOT OK: ${APP_DIR}"
