/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Class tests of local-install detection (DESIGN.md section 4.5, smoke
// re-run finding 1): an install is what changes the installed packages,
// their identities, `.bin` links, install metadata or lockfiles; a build's
// tool caches are not packages and never count. The workspace layout is
// npm's (fixture closures install with `npm ci`).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  claudeInit,
  claudeResult,
  claudeText,
  fixtureConfig,
  goodDiscoveryResponse,
  MODELS,
  recordsOf,
  runFixture,
  STUB_GRADING,
  tmpDir,
  writeScenario,
} from './helpers.mjs';
import { describeInstallChange, installState } from '../src/workspace.mjs';

const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const pkg = (name, version) => JSON.stringify({ name, version });
const integrity = (s) => `sha512-${Buffer.from(s).toString('base64')}`;

/** An npm-installed workspace: packages, scoped, nested, bins, locks. */
function installedWorkspace() {
  const ws = tmpDir('install');
  write(ws, 'package.json', pkg('app', '1.0.0'));
  const locked = {
    'node_modules/a': { version: '1.0.0', integrity: integrity('a1') },
    'node_modules/@s/b': { version: '2.0.0', integrity: integrity('b2') },
    'node_modules/a/node_modules/c': {
      version: '3.0.0',
      integrity: integrity('c3'),
    },
  };
  write(
    ws,
    'package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...locked } }),
  );
  write(
    ws,
    'node_modules/.package-lock.json',
    JSON.stringify({ lockfileVersion: 3, packages: locked }),
  );
  write(ws, 'node_modules/a/package.json', pkg('a', '1.0.0'));
  write(ws, 'node_modules/a/index.js', 'module.exports = 1;\n');
  write(ws, 'node_modules/a/cli.js', '#!/usr/bin/env node\n');
  write(ws, 'node_modules/@s/b/package.json', pkg('@s/b', '2.0.0'));
  write(ws, 'node_modules/@s/b/lib/index.js', 'export default 2;\n');
  write(ws, 'node_modules/a/node_modules/c/package.json', pkg('c', '3.0.0'));
  fs.mkdirSync(path.join(ws, 'node_modules/.bin'));
  fs.symlinkSync('../a/cli.js', path.join(ws, 'node_modules/.bin/a'));
  return ws;
}

function change(mutate) {
  const ws = installedWorkspace();
  const before = installState(ws);
  mutate(ws);
  return describeInstallChange(before, installState(ws));
}

test('the install identity records packages with name, version and lockfile integrity', () => {
  const s = installState(installedWorkspace());
  assert.deepEqual(Object.keys(s.packages).sort(), [
    '@s/b',
    'a',
    'a/node_modules/c',
  ]);
  assert.equal(s.packages.a.version, '1.0.0');
  assert.equal(s.packages['@s/b'].name, '@s/b');
  assert.equal(s.packages['a/node_modules/c'].integrity, integrity('c3'));
  assert.equal(s.bins['.bin/a'], 'symlink:../a/cli.js');
  assert.ok(s.metadata['.package-lock.json']);
  assert.ok(s.lockfiles['package-lock.json']);
});

// Cache layouts of the builds in question, empty and populated. Vite: the
// empty `.vite-temp` left by `vite build` (observed in the smoke re-run,
// reproduced offline) and the dependency pre-bundle; Rsbuild/Rspack and
// babel-loader: `node_modules/.cache`; Next.js: `.next/cache` at the root,
// plus `.cache` plugins. Simulated layouts, not real builds.
const BUILDS = {
  'vite (empty .vite-temp)': (ws) =>
    fs.mkdirSync(path.join(ws, 'node_modules/.vite-temp')),
  'vite (populated)': (ws) => {
    write(ws, 'node_modules/.vite-temp/vite.config.js.timestamp-1.mjs', 'x');
    write(ws, 'node_modules/.vite/deps/_metadata.json', '{}');
    write(ws, 'node_modules/.vite/deps/react.js', 'export {};');
  },
  'rsbuild (empty .cache)': (ws) =>
    fs.mkdirSync(path.join(ws, 'node_modules/.cache')),
  'rsbuild (populated)': (ws) => {
    write(ws, 'node_modules/.cache/rspack/0.pack', 'pack');
    write(ws, 'node_modules/.cache/babel-loader/x.json', '{}');
  },
  'next (populated)': (ws) => {
    write(ws, '.next/cache/webpack/client/0.pack', 'pack');
    write(ws, 'node_modules/.cache/next-plugin/state.json', '{}');
  },
  'scope-level cache': (ws) => write(ws, 'node_modules/@s/.cache/x', 'x'),
  'build output and generation state': (ws) => {
    write(ws, 'dist/index.js', 'x');
    write(ws, '.pandamstyle/design.js', 'x');
  },
};
for (const [name, build] of Object.entries(BUILDS))
  test(`a build is never an install: ${name}`, () => {
    assert.equal(change(build), null);
  });

test('a build creating node_modules for its caches only is not an install', () => {
  const ws = tmpDir('install-none');
  write(ws, 'package.json', pkg('app', '1.0.0'));
  const before = installState(ws);
  fs.mkdirSync(path.join(ws, 'node_modules/.vite-temp'), { recursive: true });
  write(ws, 'node_modules/.cache/x/y', '1');
  assert.equal(describeInstallChange(before, installState(ws)), null);
  write(ws, 'node_modules/x/index.js', 'x');
  assert.match(describeInstallChange(before, installState(ws)), /\+x/);
});

const INSTALLS = {
  'npm install x': [
    (ws) => {
      write(ws, 'node_modules/x/package.json', pkg('x', '1.0.0'));
      write(ws, 'node_modules/x/index.js', 'x');
      fs.symlinkSync('../x/index.js', path.join(ws, 'node_modules/.bin/x'));
      write(ws, 'node_modules/.package-lock.json', '{"changed":true}');
      write(ws, 'package-lock.json', '{"changed":true}');
    },
    /\+x@1\.0\.0.*bins:\.bin\/x.*metadata:\.package-lock\.json.*package-lock\.json/,
  ],
  'npm i with a changed lock': [
    (ws) => {
      write(ws, 'node_modules/a/package.json', pkg('a', '1.1.0'));
      write(ws, 'package-lock.json', '{"bumped":true}');
      write(ws, 'node_modules/.package-lock.json', '{"bumped":true}');
    },
    /~a@1\.1\.0/,
  ],
  'a lockfile rewritten alone': [
    (ws) => write(ws, 'package-lock.json', '{"edited":true}'),
    /package-lock\.json/,
  ],
  'a hand-copied package directory': [
    (ws) => write(ws, 'node_modules/left-pad/index.js', 'x'),
    /\+left-pad/,
  ],
  'a hand-copied nested package': [
    (ws) =>
      write(
        ws,
        'node_modules/a/node_modules/d/package.json',
        pkg('d', '1.0.0'),
      ),
    /\+d@1\.0\.0/,
  ],
  'a modified file of an installed package': [
    (ws) => write(ws, 'node_modules/@s/b/lib/index.js', 'export default 3;\n'),
    /~@s\/b@2\.0\.0/,
  ],
  'a linked package (npm link)': [
    (ws) => fs.symlinkSync('/elsewhere/z', path.join(ws, 'node_modules/z')),
    /\+z/,
  ],
  'a loose module file (resolvable as require("q"))': [
    (ws) => write(ws, 'node_modules/q.js', 'x'),
    /\+q\.js/,
  ],
  'a removed package': [
    (ws) =>
      fs.rmSync(path.join(ws, 'node_modules/a/node_modules/c'), {
        recursive: true,
      }),
    /-c@3\.0\.0/,
  ],
  'node_modules replaced by a link': [
    (ws) => {
      fs.rmSync(path.join(ws, 'node_modules'), { recursive: true });
      fs.symlinkSync('/elsewhere', path.join(ws, 'node_modules'));
    },
    /node_modules dir -> symlink:\/elsewhere/,
  ],
};
for (const [name, [install, detail]] of Object.entries(INSTALLS))
  test(`an install is detected: ${name}`, () => {
    assert.match(change(install) ?? '', detail);
  });

test('end to end: a build writing tool caches has no local-install breach, an install still has one', async () => {
  const runSteps = async (cmd, as) => {
    const file = writeScenario(tmpDir('install-scn'), 's', {
      steps: [
        claudeInit(),
        { run: cmd, as },
        claudeText(goodDiscoveryResponse()),
        claudeResult({ text: goodDiscoveryResponse() }),
      ],
    });
    const out = await runFixture({
      config: fixtureConfig({ models: [MODELS.haiku] }),
      scenarios: { '*': [file] },
      grading: STUB_GRADING(),
    });
    return recordsOf(out.matrixDir)[0].outcome;
  };
  const build = await runSteps(
    'mkdir -p node_modules/.vite-temp node_modules/.cache/x && echo 1 > node_modules/.cache/x/y',
    'npm run build',
  );
  // The discovery task also withholds host builds: that separate detector
  // still sees the command; the filesystem sees no install.
  assert.deepEqual(
    (build.breaches ?? []).map((b) => [b.kind, b.source]),
    [['host-build', 'transcript']],
  );
  const install = await runSteps(
    'mkdir -p node_modules/left-pad && echo 1 > node_modules/left-pad/index.js',
    'cp -r /tmp/cache/left-pad node_modules/',
  );
  const b = install.breaches.find((x) => x.kind === 'local-install');
  assert.equal(b.source, 'filesystem');
  assert.match(b.detail, /\+left-pad/);
});
