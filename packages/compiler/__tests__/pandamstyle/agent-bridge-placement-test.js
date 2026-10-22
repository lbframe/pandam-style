/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-02.1 fix-round class R2: bridge storage is verified, never assumed, to
 * lie outside every protected tree, before anything is created (I11, §3.3).
 * Each protected tree is reached through an explicit runtime directory,
 * `XDG_RUNTIME_DIR`, the `TMPDIR` fallback and a symlinked ancestor.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cleanup,
  compiler,
  expectDeclared,
  makeRuntimeDir,
  onCleanup,
  openHost,
  openWorkspace,
} = require('./agent-bridge-support');

jest.setTimeout(120000);
afterEach(cleanup);

const { bridgeRuntimeDir } = compiler;

/** Every path (directories included) under `dir`, with file digests. */
function treeOf(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(current, entry.name);
      const rel = path.relative(dir, abs);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(abs);
      } else out[rel] = fs.readFileSync(abs).toString('base64').slice(0, 64);
    }
  };
  walk(dir);
  return out;
}

function mkdir700(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

/** A host whose session watches its whole project (`roots: ['.']`). */
async function watchedHost(options = {}) {
  const host = await openHost({
    bridge: false,
    sessionOptions: {
      roots: [],
      ...(options.outDir == null ? {} : { outDir: options.outDir }),
    },
  });
  const project = host.project;
  const watched = host.fixture.openPublicSession({
    projectId: `${project}#watched`,
    roots: [project],
    outDir: path.join(path.dirname(project), 'watched-out'),
  });
  await watched.initialize();
  const watcher = await watched.watch({ debounceMs: 20 });
  onCleanup(async () => {
    watcher.close?.();
    await watched.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { host, watched };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('AG-02.1 R2: runtime storage inside a protected tree fails closed before any creation', () => {
  const placements = [
    {
      tree: 'rootDir',
      dir: (host) => path.join(host.project, '.inside'),
    },
    {
      tree: 'an outDir outside rootDir',
      outDir: (base) => path.join(base, 'out-outside'),
      dir: (host, base) => path.join(base, 'out-outside', 'rt'),
    },
    {
      tree: 'a declared watch root',
      watchRoot: (base) => path.join(base, 'shared-assets'),
      dir: (host, base) => path.join(base, 'shared-assets', 'rt'),
    },
  ];
  const ways = {
    explicit: async (dir, run) =>
      run({ runtimeDir: path.join(dir, 'pandamstyle') }),
    XDG_RUNTIME_DIR: async (dir, run) =>
      withEnv({ XDG_RUNTIME_DIR: dir }, () => run({})),
    // `os.tmpdir()` reads the real environment, which Jest's sandboxed
    // `process.env` does not reach: the fallback is resolved, then started.
    'TMPDIR fallback': async (dir, run) =>
      run({
        runtimeDir: bridgeRuntimeDir.runtimeDirCandidates({
          env: {},
          tmpdir: dir,
        })[0],
      }),
    'symlinked ancestor': async (dir, run) => {
      const link = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'pms-link-')),
        'via',
      );
      onCleanup(() =>
        fs.rmSync(path.dirname(link), { recursive: true, force: true }),
      );
      fs.symlinkSync(dir, link);
      return run({ runtimeDir: path.join(link, 'pandamstyle') });
    },
  };
  for (const placement of placements) {
    for (const [way, reach] of Object.entries(ways)) {
      test(`${placement.tree}, reached through ${way}`, async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-place-'));
        onCleanup(() => fs.rmSync(base, { recursive: true, force: true }));
        const { host, watched } = await watchedHost({
          outDir: placement.outDir?.(base),
        });
        const watchRoots =
          placement.watchRoot == null ? [] : [placement.watchRoot(base)];
        for (const root of watchRoots) fs.mkdirSync(root, { recursive: true });
        const dir = mkdir700(placement.dir(host, base));
        // The test's own directories settle before the baseline.
        await settle();
        const protectedParent =
          placement.tree === 'rootDir' ? path.dirname(host.project) : base;
        const before = treeOf(protectedParent);
        const revision = (await watched.current()).revision;
        const result = await reach(dir, (options) =>
          compiler.startOwnerBridge({
            session: host.session,
            host: 'test',
            watchRoots,
            ...options,
          }),
        );
        if (result.started) onCleanup(() => result.close());
        expect(result).toEqual({
          started: false,
          reason: 'runtime-dir-overlap',
        });
        await settle();
        expect(treeOf(protectedParent)).toEqual(before);
        expect((await watched.current()).revision).toEqual(revision);
      });
    }
  }

  test('a protected tree inside the runtime directory is not an overlap', async () => {
    const runtimeDir = makeRuntimeDir();
    mkdir700(runtimeDir);
    const host = await openHost({ bridge: false });
    // The project lives below the runtime directory: nothing the bridge
    // writes is inside the project.
    const moved = path.join(runtimeDir, 'project');
    fs.cpSync(path.dirname(host.project), moved, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const fixture = require('./session-helpers').openExistingProject(
      path.join(moved, 'valid'),
    );
    const inside = await openHost({ reuse: fixture, runtimeDir });
    expect(inside.bridge.started).toBe(true);
    expect(fs.readdirSync(runtimeDir).sort()).toEqual(
      ['json', 'key', 'project', 'sock']
        .map((ext) =>
          ext === 'project' ? 'project' : `${inside.bridge.name}.${ext}`,
        )
        .sort(),
    );
  });

  test('a client refuses a runtime directory inside its project: runtime-dir-unusable', async () => {
    const host = await openHost();
    const inside = mkdir700(path.join(host.project, '.client-rt'));
    const remote = openWorkspace(host, { runtimeDir: inside });
    const attach = await remote.attach();
    expect([attach.outcome, attach.failure.reason]).toEqual([
      'owner-required',
      'runtime-dir-unusable',
    ]);
    expectDeclared(attach);
  });

  test('a placement changed after opening is caught before the next creation', () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pms-place-project-'),
    );
    onCleanup(() => fs.rmSync(project, { recursive: true, force: true }));
    const runtimeDir = makeRuntimeDir();
    const opened = bridgeRuntimeDir.openRuntimeDir(runtimeDir, {
      create: true,
      protectedRoots: [project],
    });
    expect(opened.handle).toBeDefined();
    const name = 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
    opened.handle.write(`${name}.key`, 'k');
    // The directory moves into the project after the checks of its start.
    const moved = path.join(project, 'rt');
    fs.renameSync(runtimeDir, moved);
    expect(() => opened.handle.write(`${name}.json`, '{}')).toThrow(
      /runtime-dir-overlap/,
    );
    expect(fs.readdirSync(moved)).toEqual([`${name}.key`]);
    opened.handle.close();
  });

  test('unsafe runtime directories fail closed: open mode, a symlink, a file', async () => {
    const host = await openHost({ bridge: false });
    const loose = makeRuntimeDir();
    fs.mkdirSync(loose, { mode: 0o700 });
    fs.chmodSync(loose, 0o777);
    const linked = makeRuntimeDir();
    fs.symlinkSync(loose, linked);
    const file = makeRuntimeDir();
    fs.writeFileSync(file, 'x');
    for (const runtimeDir of [loose, linked, file]) {
      const result = await compiler.startOwnerBridge({
        session: host.session,
        host: 'test',
        runtimeDir,
      });
      expect(result).toEqual({ started: false, reason: 'runtime-dir-unsafe' });
    }
    expect(fs.readdirSync(loose)).toEqual([]);
  });

  test('anchoring: a directory swapped for a symlink after opening keeps writes in the pinned directory', () => {
    const runtimeDir = makeRuntimeDir();
    const opened = bridgeRuntimeDir.openRuntimeDir(runtimeDir, {
      create: true,
      protectedRoots: [],
    });
    const moved = `${runtimeDir}-moved`;
    const elsewhere = `${runtimeDir}-elsewhere`;
    fs.renameSync(runtimeDir, moved);
    onCleanup(() => fs.rmSync(moved, { recursive: true, force: true }));
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, runtimeDir);
    const name = 'aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb';
    opened.handle.write(`${name}.json`, '{}');
    expect(fs.readdirSync(moved)).toEqual([`${name}.json`]);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    opened.handle.close();
  });
});
