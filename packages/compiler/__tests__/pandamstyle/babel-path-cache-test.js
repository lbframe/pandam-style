/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// Issue #130: the compiler evicts Babel's cached NodePaths of the ASTs it
// compiled, to bound the process-wide path cache. That cache is shared with
// every Babel user in the process, so a compile must never change another
// compilation's paths, bindings or path data, including a compilation
// suspended while the Project Service validates.

const { createRequire } = require('module');
const babel = require('@babel/core');
const sharedTraverse = require('@babel/traverse').default;
const { loadCompiler, openProject } = require('./session-helpers');

const OUTER_SOURCE = 'const foo = 1; console.log(foo);';

/** Runs `outer` as an async Babel plugin around a public `validate()`. */
async function withValidatedProject(run) {
  const fixture = openProject('valid');
  const project = fixture.openPublicSession();
  try {
    const { revision } = await project.initialize();
    const validate = async () => {
      const validated = await project.validate(revision);
      expect(validated.ok).toBe(true);
    };
    return await run(validate);
  } finally {
    await project.close();
    fixture.session.close();
  }
}

function transformOuter(plugin) {
  return babel.transformAsync(OUTER_SOURCE, {
    filename: '/virtual/outer.js',
    babelrc: false,
    configFile: false,
    plugins: [plugin],
  });
}

describe('Babel path cache shared with other compilations (#130)', () => {
  test('a binding held across validate() still owns its reference paths', async () => {
    await withValidatedProject(async (validate) => {
      let held = null;
      let before = null;
      let after = null;
      const result = await transformOuter(() => ({
        async pre(file) {
          held = file.path.scope.getBinding('foo');
          before = held.referencePaths[0];
          await validate();
        },
        visitor: {
          ReferencedIdentifier(p) {
            if (p.node.name !== 'foo') return;
            after = p;
            if (held.referencePaths.includes(p)) {
              p.replaceWithSourceString('42');
            }
          },
        },
      }));
      // Identity as a boolean: a failing NodePath comparison would print
      // both whole trees.
      expect(after != null && after === before).toBe(true);
      expect(result.code).toBe('const foo = 1;\nconsole.log(42);');
    });
  });

  test('a traversal suspended mid-tree resumes on the same paths and data', async () => {
    await withValidatedProject(async (validate) => {
      let resumed = null;
      const result = await transformOuter(() => ({
        async pre(file) {
          // Walk part of the tree, keep its paths and path data, suspend.
          const declaration = file.path.get('body.0');
          declaration.setData('pms-test', 'held');
          const init = declaration.get('declarations.0.init');
          const call = file.path.get('body.1.expression');
          await validate();
          // Resume where the walk stopped: the cache must answer with the
          // same paths, still carrying their data.
          const again = file.path.get('body.0');
          resumed = {
            declaration: again === declaration,
            init: again.get('declarations.0.init') === init,
            call: file.path.get('body.1.expression') === call,
            data: again.getData('pms-test'),
          };
        },
        visitor: {
          VariableDeclaration(p) {
            if (p.getData('pms-test') === 'held') {
              p.get('declarations.0.init').replaceWithSourceString('2');
            }
          },
        },
      }));
      expect(resumed).toEqual({
        declaration: true,
        init: true,
        call: true,
        data: 'held',
      });
      expect(result.code).toBe('const foo = 2;\nconsole.log(foo);');
    });
  });
});

describe('the compiler Babel instance is private (#150)', () => {
  test('compiling leaves the shared path cache untouched and clears its own', async () => {
    const { privateBabel } = loadCompiler();
    const own = privateBabel().traverse;
    // Distinct from the test's Babel and from the process's own CommonJS
    // instance of the same installed files (Jest has a registry of its own).
    const nodeRequire = createRequire(require.resolve('@babel/core'));
    expect(own === sharedTraverse).toBe(false);
    expect(own === nodeRequire('@babel/traverse').default).toBe(false);
    expect(privateBabel().core === nodeRequire('@babel/core')).toBe(false);

    // A path the user holds in the process's shared Babel cache.
    const ast = babel.parseSync('const held = 1;', {
      babelrc: false,
      configFile: false,
    });
    let held = null;
    sharedTraverse(ast, {
      VariableDeclarator(p) {
        held = p;
      },
    });
    const sharedCache = sharedTraverse.cache.path;
    const cachedHeld = () =>
      sharedTraverse.cache.path.get(held.parent)?.get(held.node);

    await withValidatedProject(async (validate) => {
      const before = own.cache.path;
      await validate();
      // Ours: the compiled files' paths were dropped (a fresh table).
      expect(own.cache.path === before).toBe(false);
      // Theirs: the same table, still answering with the held path.
      expect(sharedTraverse.cache.path === sharedCache).toBe(true);
      expect(cachedHeld() === held).toBe(true);
    });
  });
});

// #156 review round 1: private or shared is decided by package identity, so
// isolation holds when Babel lives outside a `node_modules/@babel/` path, and
// nothing is cleared unless the instance is proven not to be the host's.
describe('private Babel isolation across package layouts (#156)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  // The installed packages every fixture copies or links.
  const installed = path.dirname(
    path.dirname(path.dirname(require.resolve('@babel/core/package.json'))),
  );
  const babelDir = (name) => path.join(installed, '@babel', name);
  const link = (target, at) => {
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.symlinkSync(target, at, 'dir');
  };
  const copy = (name, to) => fs.cpSync(babelDir(name), to, { recursive: true });
  const fixtures = [];
  afterAll(() => {
    for (const dir of fixtures)
      fs.rmSync(dir, { recursive: true, force: true });
  });
  const fixture = () => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'pms156-')),
    );
    fixtures.push(dir);
    return dir;
  };
  /** The app every layout shares: presets from the install, a manifest. */
  const app = (dir, babel) => {
    const appDir = path.join(dir, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{"name":"app"}');
    for (const [name, target] of Object.entries({
      core: babel.core,
      traverse: babel.traverse,
      'preset-typescript': babelDir('preset-typescript'),
      'preset-react': babelDir('preset-react'),
    })) {
      link(target, path.join(appDir, 'node_modules', '@babel', name));
    }
    return path.join(appDir, 'package.json');
  };

  const LAYOUTS = {
    // Vendored copies linked into the app: real paths without node_modules.
    'symlink to vendor': () => {
      const dir = fixture();
      const vendor = path.join(dir, 'vendor');
      copy('core', path.join(vendor, 'core'));
      copy('traverse', path.join(vendor, 'traverse'));
      link(
        path.join(vendor, 'traverse'),
        path.join(vendor, 'core', 'node_modules', '@babel', 'traverse'),
      );
      link(installed, path.join(vendor, 'node_modules'));
      return app(dir, {
        core: path.join(vendor, 'core'),
        traverse: path.join(vendor, 'traverse'),
      });
    },
    // pnpm: one store directory per package version, siblings linked.
    pnpm: () => {
      const dir = fixture();
      const store = path.join(dir, 'node_modules', '.pnpm');
      const at = (pkg) =>
        path.join(store, `@babel+${pkg}@7.0.0`, 'node_modules', '@babel', pkg);
      copy('core', at('core'));
      copy('traverse', at('traverse'));
      link(
        at('traverse'),
        path.join(
          store,
          '@babel+core@7.0.0',
          'node_modules',
          '@babel',
          'traverse',
        ),
      );
      link(installed, path.join(store, 'node_modules'));
      return app(dir, { core: at('core'), traverse: at('traverse') });
    },
    // A workspace: Babel packages are workspace packages, linked by name.
    'workspace symlink': () => {
      const dir = fixture();
      const packages = path.join(dir, 'packages');
      copy('core', path.join(packages, 'babel-core'));
      copy('traverse', path.join(packages, 'babel-traverse'));
      link(
        path.join(packages, 'babel-traverse'),
        path.join(packages, 'babel-core', 'node_modules', '@babel', 'traverse'),
      );
      link(installed, path.join(packages, 'node_modules'));
      return app(dir, {
        core: path.join(packages, 'babel-core'),
        traverse: path.join(packages, 'babel-traverse'),
      });
    },
  };

  /** A host path held in `traverse`'s cache, and a check that it survives. */
  function holdHostPath(hostRequire) {
    const traverse = hostRequire('@babel/traverse').default;
    const ast = require('@babel/parser').parse('const held = 1;');
    let held = null;
    traverse(ast, {
      VariableDeclarator(p) {
        held = p;
      },
    });
    const table = traverse.cache.path;
    return {
      traverse,
      untouched: () =>
        traverse.cache.path === table &&
        traverse.cache.path.get(held.parent)?.get(held.node) === held,
    };
  }

  function compileWith(babel) {
    return babel.core.transformSync(
      'const value: number = 2; export const el = <div>{value}</div>;',
      {
        filename: '/virtual/page.tsx',
        babelrc: false,
        configFile: false,
        presets: [
          [babel.presetTypeScript, { allExtensions: true, isTSX: true }],
          babel.presetReact,
        ],
      },
    ).code;
  }

  for (const [layout, build] of Object.entries(LAYOUTS)) {
    test(`${layout}: private, cleared, host cache untouched`, () => {
      const { createPrivateBabel } = loadCompiler();
      const anchor = build();
      const hostRequire = createRequire(anchor);
      // The layout really places core's traverse outside node_modules/@babel
      // (except pnpm, which keeps the segment inside its store).
      const ownTraverseFile = fs.realpathSync(
        createRequire(hostRequire.resolve('@babel/core')).resolve(
          '@babel/traverse',
        ),
      );
      expect(
        ownTraverseFile.startsWith(path.dirname(path.dirname(anchor))),
      ).toBe(true);
      const host = holdHostPath(hostRequire);

      const babel = createPrivateBabel(anchor);
      expect(babel.isolation).toEqual({ isolated: true, reason: null });
      expect(babel.traverse === host.traverse).toBe(false);
      expect(compileWith(babel)).toContain('React.createElement("div"');
      const before = babel.traverse.cache.path;
      babel.clearPaths();
      expect(babel.traverse.cache.path === before).toBe(false);
      expect(host.untouched()).toBe(true);
    });
  }

  test('an instance not proven private is never cleared (fail closed)', () => {
    const { createPrivateBabel } = loadCompiler();
    const anchor = LAYOUTS['symlink to vendor']();
    const hostRequire = createRequire(anchor);
    const host = holdHostPath(hostRequire);
    // Core and traverse forced shared: the "private" instance is the host's.
    const babel = createPrivateBabel(anchor, {
      sharedPackages: [
        '@babel/parser',
        '@babel/types',
        '@babel/core',
        '@babel/traverse',
      ],
    });
    expect(babel.traverse === host.traverse).toBe(true);
    expect(babel.isolation.isolated).toBe(false);
    compileWith(babel);
    babel.clearPaths();
    expect(host.untouched()).toBe(true);
  });
});
