/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The trusted grading tree (DESIGN.md section 4.8, invariant G). The product
// under evaluation and the grading compiler are both the frozen product
// build: the tree is an offline install from the fixture closure whose every
// @pandamstyle/* package is compared file by file with the digest-verified
// product tarballs. Its digest is recorded and re-checked before each
// grading pass; the oracles' ancestor fallback is refused.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeDigest } from '../../src/fs-tree.mjs';
import { digestJson, fileSha256 } from './util.mjs';

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Offline install of a closure (package.json + package-lock.json). */
export function installClosure({
  closureDir,
  dest,
  cacheDir = null,
  npm = 'npm',
  env = {},
}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['package.json', 'package-lock.json'])
    fs.copyFileSync(path.join(closureDir, f), path.join(dest, f));
  const args = [
    'ci',
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ];
  if (cacheDir != null) args.push('--cache', cacheDir);
  const r = spawnSync(npm, args, {
    cwd: dest,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false', ...env },
  });
  if (r.status !== 0)
    throw coded('install', `npm ci --offline failed: ${r.stderr.slice(-800)}`);
  return path.join(dest, 'node_modules');
}

function listPackageFiles(dir, rel = '') {
  const out = new Map();
  for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    if (name === 'node_modules') continue;
    const st = fs.lstatSync(path.join(dir, childRel));
    if (st.isDirectory())
      for (const [k, v] of listPackageFiles(dir, childRel)) out.set(k, v);
    else if (st.isSymbolicLink())
      out.set(childRel, `symlink:${fs.readlinkSync(path.join(dir, childRel))}`);
    else if (st.isFile())
      out.set(childRel, fileSha256(path.join(dir, childRel)));
  }
  return out;
}

/**
 * Compares every installed @pandamstyle/* package directory with the
 * `package/` entries of its product tarball. Returns the list of problems.
 */
/**
 * `required`: the @pandamstyle/* package names that must be installed (all
 * of the binding when omitted, e.g. the trusted grading tree); a package of
 * the binding that is not required may be absent (a fixture installs only
 * what its package.json declares). Every installed @pandamstyle/* package
 * must be one of the binding's and equal its tarball (section 4.7).
 */
export function verifyProductPackages({
  nodeModules,
  binding,
  storeCopy,
  required = null,
}) {
  const problems = [];
  const names = new Set(binding.packages.map((p) => p.name));
  const scope = path.join(nodeModules, '@pandamstyle');
  if (fs.existsSync(scope))
    for (const entry of fs.readdirSync(scope))
      if (!names.has(`@pandamstyle/${entry}`))
        problems.push(
          `@pandamstyle/${entry}: installed but not in the product build`,
        );
  for (const name of required ?? [])
    if (!names.has(name))
      problems.push(`${name}: required but not in the product build`);
  for (const pkg of binding.packages) {
    const installed = path.join(nodeModules, ...pkg.name.split('/'));
    if (!fs.existsSync(installed)) {
      if (required == null || required.includes(pkg.name))
        problems.push(`${pkg.name}: not installed`);
      continue;
    }
    const tarball = path.join(storeCopy, pkg.file);
    if (fileSha256(tarball) !== pkg.sha256) {
      problems.push(`${pkg.name}: tarball sha256 mismatch`);
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-pkg-'));
    try {
      const r = spawnSync(
        'tar',
        ['-xzf', tarball, '-C', tmp, '--no-same-owner'],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) {
        problems.push(`${pkg.name}: tarball does not extract`);
        continue;
      }
      const expected = listPackageFiles(path.join(tmp, 'package'));
      const actual = listPackageFiles(installed);
      for (const [rel, digest] of expected)
        if (actual.get(rel) !== digest)
          problems.push(`${pkg.name}: ${rel} differs`);
      for (const rel of actual.keys())
        if (!expected.has(rel))
          problems.push(`${pkg.name}: ${rel} not in the tarball`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return problems;
}

export function trustedTreeDigests(nodeModules) {
  return {
    digest: treeDigest(nodeModules),
    pandamstyleDigest: fs.existsSync(path.join(nodeModules, '@pandamstyle'))
      ? treeDigest(path.join(nodeModules, '@pandamstyle'))
      : null,
  };
}

/** Builds and verifies the trusted tree; throws `trusted-tree` on mismatch. */
export function buildTrustedTree({
  closureDir,
  dest,
  cacheDir,
  binding,
  storeCopy,
  npm,
}) {
  const nodeModules = installClosure({ closureDir, dest, cacheDir, npm });
  const problems = verifyProductPackages({ nodeModules, binding, storeCopy });
  if (problems.length > 0)
    throw coded(
      'trusted-tree',
      `trusted tree differs from the product build: ${problems.slice(0, 8).join('; ')}`,
    );
  return {
    nodeModules,
    ...trustedTreeDigests(nodeModules),
    matchesProductTarballs: true,
  };
}

/** Checked before every grading pass (section 4.8 item 2). */
export function checkTrustedTree({ nodeModules, expected }) {
  if (nodeModules == null || !fs.existsSync(nodeModules))
    throw coded(
      'trusted-tree',
      'trusted node_modules missing: provider-backed grading refuses the ancestor fallback',
    );
  const got = trustedTreeDigests(nodeModules);
  if (
    got.digest !== expected.digest ||
    got.pandamstyleDigest !== expected.pandamstyleDigest
  )
    throw coded(
      'trusted-tree',
      'trusted node_modules digest differs from the recorded tree',
    );
  return got;
}

/** No node_modules may exist above the scratch location (section 4.8 item 3). */
export function assertNoAncestorNodeModules(scratchDir) {
  let dir = path.dirname(path.resolve(scratchDir));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules')))
      throw coded(
        'trusted-tree',
        `node_modules found above the scratch location: ${dir}`,
      );
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Lockfile digest without product entries (comparability, section 1.4). */
export function nonProductLockDigest(lockPath) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const strip = (obj) =>
    Object.fromEntries(
      Object.entries(obj ?? {}).filter(([k]) => !k.includes('@pandamstyle/')),
    );
  return digestJson({
    lockfileVersion: lock.lockfileVersion ?? null,
    packages: strip(lock.packages),
    dependencies: strip(lock.dependencies),
  });
}

/** Declared identity of a fixture closure, from its lockfile. */
export function closureIdentity(closureDir) {
  const lock = path.join(closureDir, 'package-lock.json');
  return {
    closureLockSha256: fileSha256(lock),
    nonProductLockSha256: nonProductLockDigest(lock),
  };
}

/**
 * Installs a fixture closure into a workspace before the agent starts and
 * verifies it (sections 4.7 and 4.8): an exact offline `npm ci` of the
 * closure's lockfile, every @pandamstyle/* package equal to the product
 * tarballs, and the identity of what was installed. The lock digests enter
 * that cell's comparability projection.
 */
export function installFixtureClosure({
  closureDir,
  cacheDir = null,
  workspace,
  binding,
  storeCopy,
  npm = 'npm',
}) {
  const lock = path.join(closureDir, 'package-lock.json');
  if (!fs.existsSync(lock))
    throw coded(
      'install',
      `fixture closure without package-lock.json: ${closureDir}`,
    );
  const nodeModules = installClosure({
    closureDir,
    dest: workspace,
    cacheDir,
    npm,
  });
  // Required: the @pandamstyle/* packages the closure's package.json declares.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(closureDir, 'package.json'), 'utf8'),
  );
  const required = [
    ...new Set(
      Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      }).filter((n) => n.startsWith('@pandamstyle/')),
    ),
  ];
  const problems =
    binding == null
      ? []
      : verifyProductPackages({ nodeModules, binding, storeCopy, required });
  if (problems.length > 0)
    throw coded(
      'install',
      `workspace @pandamstyle packages differ from the product build: ${problems.slice(0, 5).join('; ')}`,
    );
  return {
    closureLockSha256: fileSha256(lock),
    nonProductLockSha256: nonProductLockDigest(lock),
    nodeModulesDigest: treeDigest(nodeModules),
    productPackagesVerified: binding != null,
  };
}
