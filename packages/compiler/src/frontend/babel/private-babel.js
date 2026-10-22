/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The compiler's private Babel instance (issue #150).
 *
 * `@babel/traverse` keeps the NodePaths of every traversed AST in one
 * module-level WeakMap. Entries die with their AST, but the table keeps the
 * capacity of the most nodes created between two garbage collections, which
 * depends on GC timing, and the collector sizes the heap from it (#130). That
 * cache belongs to whoever loaded the module, so the compiler may not clear a
 * shared instance: another Babel user's held paths, bindings and path data
 * would lose their identity (#136, review round 1).
 *
 * The compiler therefore runs its Babel work on its own instance of the same
 * installed `@babel/*` CommonJS modules (core, traverse, the presets and every
 * helper they require), loaded through the small module loader below. Only
 * the compiler reaches this instance, so it owns its path cache and clears it
 * after each compiled file. Stateless `@babel/parser` and `@babel/types` and
 * every non-Babel dependency stay shared with the process: they are required
 * normally, so nothing is duplicated but the modules that hold state or
 * require ones that do. The files, versions and code are the installed ones:
 * no new dependency, no copy.
 *
 * Private or shared is decided by package identity (the owning
 * `package.json` name, from the real path), never by path spelling. Before
 * any clear, the instance must be proven not to be the host's; otherwise the
 * cache is never cleared and the compiler only forgoes the memory bound
 * (fail closed, #156 review round 1).
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Packages a private module may share with the process: no module state.
// Every other `@babel/*` package is loaded privately.
const DEFAULT_SHARED_PACKAGES = Object.freeze([
  '@babel/parser',
  '@babel/types',
]);

/**
 * The package name owning a directory: the `name` of the nearest
 * `package.json` that has one, walking up from the canonical (real) path.
 * Nested `package.json` files that only set `type` are skipped. Decided by
 * package identity, never by how the path is spelled: vendored, symlinked,
 * pnpm and workspace layouts place Babel outside `node_modules/@babel/`.
 */
function packageNameResolver() {
  const byDirectory = new Map();
  const nameOf = (directory) => {
    if (byDirectory.has(directory)) return byDirectory.get(directory);
    let name = null;
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
      );
      if (typeof manifest?.name === 'string') name = manifest.name;
    } catch {
      // No (readable) manifest here: look further up.
    }
    if (name == null) {
      const parent = path.dirname(directory);
      name = parent === directory ? null : nameOf(parent);
    }
    byDirectory.set(directory, name);
    return name;
  };
  return (filename) => nameOf(path.dirname(fs.realpathSync(filename)));
}

/**
 * A CommonJS `require` whose `@babel/*` modules (except the shared ones) come
 * from a module cache of its own, with Node's resolution and semantics:
 * cycles see the partial `exports`, JSON is parsed, everything else is the
 * process's own module. `owned` collects every `exports` object it created.
 */
function createPrivateRequire(anchor, sharedPackages) {
  const shared = new Set(sharedPackages);
  const packageOf = packageNameResolver();
  const isPrivateFile = (filename) => {
    const name = packageOf(filename);
    return name != null && name.startsWith('@babel/') && !shared.has(name);
  };
  const modules = new Map();
  const owned = new WeakSet();
  const load = (filename) => {
    const cached = modules.get(filename);
    if (cached != null) return cached.exports;
    const module = { id: filename, filename, exports: {}, loaded: false };
    modules.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.json')) {
      module.exports = JSON.parse(source);
    } else {
      vm.compileFunction(
        source,
        ['exports', 'require', 'module', '__filename', '__dirname'],
        { filename },
      ).call(
        module.exports,
        module.exports,
        requireFrom(filename),
        module,
        filename,
        path.dirname(filename),
      );
    }
    module.loaded = true;
    const value = module.exports;
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function')
    ) {
      owned.add(value);
    }
    return module.exports;
  };
  const requireFrom = (from) => {
    const real = createRequire(from);
    const privateRequire = (specifier) => {
      const relative =
        specifier.startsWith('./') || specifier.startsWith('../');
      if (!relative && !specifier.startsWith('@babel/')) {
        return real(specifier);
      }
      const filename = real.resolve(specifier);
      return isPrivateFile(filename) ? load(filename) : real(specifier);
    };
    privateRequire.resolve = real.resolve;
    return privateRequire;
  };
  return { require: requireFrom(anchor), requireFrom, owned };
}

const interop = (module) => module?.default ?? module;

/**
 * Whether `traverse` (with its path cache) is provably this loader's own:
 * created by it, and not the module Node's cache holds for `@babel/traverse`
 * as resolved from any of `bases`. Reads Node's module cache only, so it
 * never loads the host's Babel. Anything unproven is `false`.
 */
function provenPrivate(traverseModule, owned, bases) {
  try {
    const traverse = interop(traverseModule);
    if (!owned.has(traverseModule) || !owned.has(traverse.cache)) {
      return { isolated: false, reason: 'traverse not loaded privately' };
    }
    for (const base of bases) {
      const host = createRequire(base);
      const filename = host.resolve('@babel/traverse');
      const loaded = host.cache[filename]?.exports;
      if (
        loaded != null &&
        (loaded === traverseModule || interop(loaded) === traverse)
      ) {
        return { isolated: false, reason: 'traverse is the host instance' };
      }
    }
    return { isolated: true, reason: null };
  } catch (error) {
    return { isolated: false, reason: `unproven: ${error?.message ?? error}` };
  }
}

/**
 * A private Babel resolved from `anchor`: `{ core, traverse,
 * presetTypeScript, presetReact, isolation, clearPaths }`. `traverse` is the
 * one `@babel/core` itself resolves, so it owns the cache core fills.
 * `clearPaths()` drops that cache only when `isolation.isolated`: otherwise
 * it is a no-op (the compiler works, without the memory bound). Options are
 * a test seam.
 */
export function createPrivateBabel(
  anchor,
  { sharedPackages = DEFAULT_SHARED_PACKAGES } = {},
) {
  const loader = createPrivateRequire(anchor, sharedPackages);
  const coreFile = loader.require.resolve('@babel/core');
  const core = interop(loader.require('@babel/core'));
  const traverseModule = loader.requireFrom(coreFile)('@babel/traverse');
  const traverse = interop(traverseModule);
  const isolation = Object.freeze(
    provenPrivate(traverseModule, loader.owned, [anchor, coreFile]),
  );
  return Object.freeze({
    core,
    traverse,
    presetTypeScript: interop(loader.require('@babel/preset-typescript')),
    presetReact: interop(loader.require('@babel/preset-react')),
    // Debug only: never a diagnostic.
    isolation,
    clearPaths: isolation.isolated
      ? () => traverse.cache.clearPath()
      : () => {},
  });
}

let instance = null;

/** The compiler's private Babel, loaded once. */
export function privateBabel() {
  // Resolved from this module, exactly as its former static imports were.
  instance ??= createPrivateBabel(import.meta.url);
  return instance;
}

/**
 * Drops the private instance's cached NodePaths, when isolation is proven.
 * Only the compiler holds paths of this instance, and it calls this between
 * files, when it holds none of a finished file's paths.
 */
export function clearPrivatePaths() {
  instance?.clearPaths();
}

// Loaded with the compiler, as its former static imports were, so the first
// validation does not pay for loading Babel (#156: the CE-00.3 full-compile
// timings exclude import time).
privateBabel();
