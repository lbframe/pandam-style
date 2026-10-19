/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Regression test for vacuous tree digests:
//
//   node tools/baselines/tree-digest-regression.mjs [--store <copy of the store>]
//
// Class: a path filter applied to directories prunes the ancestors of the
// files it means to include, and the digest silently covers nothing. Checks:
//   1. the old npm-cache filter, run through the directory-pruning walk,
//      digests 0 files on a cache-shaped tree and the non-vacuous guard
//      rejects it; the file-level digest includes the content entries;
//   2. for the engine and closure selections, the file-level digest equals
//      the recorded semantics (so the frozen manifest digests stay valid);
//   3. no tools/baselines module calls treeDigest with an exclude filter;
//   4. with --store, the same holds on the real store copy and every built
//      tree passes the guard.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, treeDigest } from './lib.mjs';
import {
  CLOSURE_FILES,
  ENGINE_FILES,
  NPM_CACHE_FILES,
  builtTreeProblems,
  fileTreeDigest,
  vacuity,
} from './archive.mjs';

// The filters as committed before this fix (archive.mjs at e2a864b).
const OLD = {
  npmCache: (rel) => !rel.startsWith('_cacache/content-v2/'),
  engine: (rel) =>
    /(^|\/)(INSTALLATION_COMPLETE|DEPENDENCIES_VALIDATED)$/.test(rel),
  closure: (rel) => rel === '.package-lock.json' || rel.startsWith('.cache/'),
};

const results = [];
const expect = (name, ok, detail = '') => results.push({ name, ok, detail });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-tree-digest-'));
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

try {
  // 1. Cache-shaped tree.
  const cache = path.join(work, 'npm-cache');
  write(cache, '_cacache/content-v2/sha512/ab/cd/ef0123', 'tarball bytes');
  write(cache, '_cacache/index-v5/12/34/5678', '{"time": 1}');
  write(cache, '_logs/debug-0.log', 'log');
  const old = treeDigest(cache, { exclude: OLD.npmCache });
  expect(
    'old npm-cache filter digests 0 files',
    old.files === 0,
    JSON.stringify(old),
  );
  expect(
    'the guard rejects the old vacuous digest',
    vacuity('npm cache', old) != null,
    vacuity('npm cache', old),
  );
  expect(
    'the guard rejects a recorded minimum of 0 too',
    vacuity('npm cache', old, 0) != null,
  );
  const fixed = fileTreeDigest(cache, NPM_CACHE_FILES);
  expect(
    'file-level digest includes exactly the content entry',
    fixed.files === 1,
    JSON.stringify(fixed),
  );
  expect(
    'the guard accepts the fixed digest',
    vacuity('npm cache', fixed, 1) == null,
  );

  // 2. Engine and closure selections keep their recorded semantics.
  const engine = path.join(work, 'engine');
  write(engine, 'chrome-linux64/chrome', 'binary');
  write(engine, 'chrome-linux64/locales/en.pak', 'pak');
  write(engine, 'INSTALLATION_COMPLETE', '');
  write(engine, 'DEPENDENCIES_VALIDATED', '');
  expect(
    'engine selection: file-level digest equals the recorded walk',
    fileTreeDigest(engine, ENGINE_FILES).sha256 ===
      treeDigest(engine, { exclude: OLD.engine }).sha256,
  );
  const closure = path.join(work, 'node_modules');
  write(closure, '.package-lock.json', '{}');
  write(closure, '.cache/vite/deps.json', '{}');
  write(closure, 'react/package.json', '{}');
  write(closure, 'react/index.js', 'x');
  fs.symlinkSync('../react/index.js', path.join(closure, 'react-link'));
  expect(
    'closure selection: file-level digest equals the recorded walk',
    fileTreeDigest(closure, CLOSURE_FILES).sha256 ===
      treeDigest(closure, { exclude: OLD.closure }).sha256,
  );
  expect(
    'unfiltered: file-level digest equals lib treeDigest',
    fileTreeDigest(closure).sha256 === treeDigest(closure).sha256,
  );

  // 3. No directory-pruning filter remains in use.
  const offenders = [];
  for (const file of fs
    .readdirSync(path.join(REPO, 'tools/baselines'))
    .filter((f) => f.endsWith('.mjs'))) {
    if (file === 'tree-digest-regression.mjs') continue;
    const text = fs.readFileSync(
      path.join(REPO, 'tools/baselines', file),
      'utf8',
    );
    for (const match of text.matchAll(
      /(?<![\w.])treeDigest\(([^()]|\([^()]*\))*\)/g,
    ))
      if (
        /exclude/.test(match[0]) &&
        !/function\s+$/.test(text.slice(0, match.index))
      )
        offenders.push(
          `${file}: ${match[0].replace(/\s+/g, ' ').slice(0, 80)}`,
        );
  }
  expect(
    'no tools/baselines module calls treeDigest with an exclude filter',
    offenders.length === 0,
    offenders.join('; '),
  );

  // 4. The real store copy.
  const index = process.argv.indexOf('--store');
  if (index >= 0) {
    const store = path.resolve(process.argv[index + 1]);
    const oldReal = treeDigest(path.join(store, 'npm-cache'), {
      exclude: OLD.npmCache,
    });
    expect(
      'store copy: old npm-cache filter digests 0 files and is rejected',
      oldReal.files === 0 && vacuity('npm cache', oldReal) != null,
      JSON.stringify(oldReal),
    );
    const fixedReal = fileTreeDigest(
      path.join(store, 'npm-cache'),
      NPM_CACHE_FILES,
    );
    expect(
      'store copy: file-level npm-cache digest is non-vacuous',
      vacuity('npm cache', fixedReal) == null,
      JSON.stringify(fixedReal),
    );
    const problems = builtTreeProblems(store);
    expect(
      'store copy: every built tree passes the non-vacuous guard',
      problems.length === 0,
      problems.join('; '),
    );
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

for (const r of results)
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`,
  );
const failed = results.filter((r) => !r.ok).length;
console.log(
  `tree digest regression: ${results.length - failed}/${results.length} as expected`,
);
if (failed > 0) process.exitCode = 1;
