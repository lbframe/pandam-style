/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-02.1: `archive.mjs candidate-manifest` records a candidate epoch from a
 * packed closure, and never overwrites an epoch. Runs the real command over a
 * synthetic candidate directory: tiny packs, a closure lockfile bound to them,
 * installed package manifests.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../..');
const ARCHIVE = path.join(REPO, 'tools/baselines/archive.mjs');
const PACKAGES = ['core', 'compiler', 'vite', 'next', 'rsbuild'];
const VERSION = '0.1.0-alpha.1';
const HOST_PINS = JSON.parse(
  fs.readFileSync(
    path.join(
      REPO,
      'benchmarks/core-evolution/epochs/alpha1/closure/package.json',
    ),
    'utf8',
  ),
).dependencies;
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: REPO,
  encoding: 'utf8',
}).trim();

const integrityOf = (bytes) =>
  `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = (bytes) =>
  crypto.createHash('sha256').update(bytes).digest('hex');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A synthetic candidate directory, as `candidate-pack` lays it out. */
function candidate({ tamper = null } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ce021-candidate-'));
  const lockPackages = { '': { name: 'pandamstyle-candidate-closure' } };
  for (const name of PACKAGES) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce021-pack-'));
    writeJson(path.join(work, 'package', 'package.json'), {
      name: `@pandamstyle/${name}`,
      version: VERSION,
    });
    const file = `pandamstyle-${name}-${VERSION}.tgz`;
    for (const dir of ['packs', 'packs-repeat', 'closure/packs']) {
      fs.mkdirSync(path.join(dest, dir), { recursive: true });
      execFileSync('tar', [
        '--mtime=@0',
        '--owner=0',
        '--group=0',
        '-czf',
        path.join(dest, dir, file),
        '-C',
        work,
        'package',
      ]);
    }
    fs.rmSync(work, { recursive: true, force: true });
    const bytes = fs.readFileSync(path.join(dest, 'packs', file));
    lockPackages[`node_modules/@pandamstyle/${name}`] = {
      version: VERSION,
      resolved: `file:packs/${file}`,
      integrity: integrityOf(bytes),
    };
    writeJson(
      path.join(
        dest,
        'closure/node_modules/@pandamstyle',
        name,
        'package.json',
      ),
      { name: `@pandamstyle/${name}`, version: VERSION },
    );
  }
  for (const [host, version] of Object.entries(HOST_PINS)) {
    if (host.startsWith('@pandamstyle/')) continue;
    lockPackages[`node_modules/${host}`] = {
      version,
      resolved: `https://registry.npmjs.org/${host}/-/x-${version}.tgz`,
      integrity: 'sha512-x',
    };
    writeJson(path.join(dest, 'closure/node_modules', host, 'package.json'), {
      name: host,
      version,
    });
  }
  const lock = {
    name: 'pandamstyle-candidate-closure',
    lockfileVersion: 3,
    packages: lockPackages,
  };
  if (tamper != null) tamper(lock, dest);
  writeJson(path.join(dest, 'closure/package-lock.json'), lock);
  writeJson(path.join(dest, 'closure/package.json'), {
    name: 'pandamstyle-candidate-closure',
    private: true,
  });
  writeJson(path.join(dest, 'candidate.json'), { commit: HEAD });
  return dest;
}

function record(epoch, dest, epochsDir) {
  return spawnSync(
    process.execPath,
    [
      ARCHIVE,
      'candidate-manifest',
      '--epoch',
      epoch,
      '--dest',
      dest,
      '--epochs-dir',
      epochsDir,
    ],
    { cwd: REPO, encoding: 'utf8' },
  );
}

describe('candidate epoch manifests', () => {
  let epochsDir;
  beforeEach(() => {
    epochsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce021-epochs-'));
  });

  test('records the packs, the closure and the commit', () => {
    const dest = candidate();
    const result = record('ce-02.1-test', dest, epochsDir);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(epochsDir, 'ce-02.1-test/manifest.v1.json'),
        'utf8',
      ),
    );
    expect(manifest).toMatchObject({
      kind: 'pandamstyle-baseline-epoch-manifest',
      epoch: 'ce-02.1-test',
      epochKind: 'candidate',
      source: { commit: HEAD },
    });
    expect(manifest.packages.map((p) => p.name)).toEqual(
      PACKAGES.map((name) => `@pandamstyle/${name}`),
    );
    for (const p of manifest.packages) {
      const bytes = fs.readFileSync(path.join(dest, p.pack.file));
      expect(p.pack.sha256).toBe(sha256(bytes));
      expect(p.pack.integrity).toBe(integrityOf(bytes));
      expect(p.pack.reproducible).toBe(true);
      expect(p.closureLock.matchesPack).toBe(true);
    }
    expect(Object.keys(manifest.closure.hosts).sort()).toEqual(
      Object.keys(HOST_PINS)
        .filter((h) => !h.startsWith('@pandamstyle/'))
        .sort(),
    );
    // The committed closure files are the candidate's own.
    for (const file of ['package.json', 'package-lock.json']) {
      expect(
        fs.readFileSync(
          path.join(epochsDir, 'ce-02.1-test/closure', file),
          'utf8',
        ),
      ).toBe(fs.readFileSync(path.join(dest, 'closure', file), 'utf8'));
    }
    // No machine-local path enters the record.
    const text = JSON.stringify(manifest);
    expect(text).not.toContain(dest);
    expect(text).not.toContain(os.tmpdir());
    expect(text).not.toContain(os.homedir());
  });

  test('never overwrites an epoch', () => {
    const dest = candidate();
    expect(record('ce-02.1-test', dest, epochsDir).status).toBe(0);
    const before = fs.readFileSync(
      path.join(epochsDir, 'ce-02.1-test/manifest.v1.json'),
      'utf8',
    );
    const again = record('ce-02.1-test', dest, epochsDir);
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/never overwritten/);
    expect(
      fs.readFileSync(
        path.join(epochsDir, 'ce-02.1-test/manifest.v1.json'),
        'utf8',
      ),
    ).toBe(before);
  });

  test.each(['alpha1', '../escape', 'Upper', 'a/b', '', '-x', 'x-'])(
    'refuses the epoch name %j',
    (name) => {
      const result = record(name, candidate(), epochsDir);
      expect(result.status).not.toBe(0);
      expect(fs.readdirSync(epochsDir)).toEqual([]);
    },
  );

  test('refuses the real alpha1 directory even without --epochs-dir', () => {
    const result = spawnSync(
      process.execPath,
      [
        ARCHIVE,
        'candidate-manifest',
        '--epoch',
        'alpha1',
        '--dest',
        candidate(),
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refused epoch name/);
  });

  test.each([
    [
      'a lock integrity that does not match the pack',
      (lock) => {
        lock.packages['node_modules/@pandamstyle/compiler'].integrity =
          'sha512-other';
      },
      /lock integrity differs/,
    ],
    [
      'an absolute resolved path',
      (lock) => {
        lock.packages['node_modules/@pandamstyle/core'].resolved =
          'file:/somewhere/pandamstyle-core.tgz';
      },
      /resolves outside the registry and packs/,
    ],
    [
      'a missing package',
      (lock) => {
        delete lock.packages['node_modules/@pandamstyle/next'];
      },
      /is not in the lockfile/,
    ],
    [
      'a closure pack that differs from packs/',
      (_, dest) => {
        fs.appendFileSync(
          path.join(dest, `closure/packs/pandamstyle-vite-${VERSION}.tgz`),
          'x',
        );
      },
      /differs from packs/,
    ],
  ])('refuses %s', (_, tamper, message) => {
    const result = record('ce-02.1-test', candidate({ tamper }), epochsDir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
    expect(fs.existsSync(path.join(epochsDir, 'ce-02.1-test'))).toBe(false);
  });
});
