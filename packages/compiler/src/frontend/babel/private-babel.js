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
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Packages a private module may share with the process: no module state.
const SHARED_PACKAGES = new Set(['@babel/parser', '@babel/types']);

const BABEL_SEGMENT = `${path.sep}node_modules${path.sep}@babel${path.sep}`;

/** Whether `filename` belongs to an `@babel/*` package loaded privately. */
function isPrivateFile(filename) {
  const at = filename.lastIndexOf(BABEL_SEGMENT);
  if (at === -1) return false;
  const name = filename.slice(at + BABEL_SEGMENT.length).split(path.sep, 1)[0];
  return !SHARED_PACKAGES.has(`@babel/${name}`);
}

/**
 * A CommonJS `require` whose `@babel/*` modules (except the shared ones) come
 * from a module cache of its own, with Node's resolution and semantics:
 * cycles see the partial `exports`, JSON is parsed, everything else is the
 * process's own module.
 */
function createPrivateRequire(anchor) {
  const modules = new Map();
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
  return requireFrom(anchor);
}

let instance = null;

/** `{ core, traverse, presetTypeScript, presetReact }`, loaded once. */
export function privateBabel() {
  if (instance == null) {
    // Resolved from this module, exactly as its former static imports were.
    const privateRequire = createPrivateRequire(import.meta.url);
    const interop = (module) => module?.default ?? module;
    instance = Object.freeze({
      core: interop(privateRequire('@babel/core')),
      traverse: interop(privateRequire('@babel/traverse')),
      presetTypeScript: interop(privateRequire('@babel/preset-typescript')),
      presetReact: interop(privateRequire('@babel/preset-react')),
    });
  }
  return instance;
}

/**
 * Drops the private instance's cached NodePaths. Only the compiler holds
 * paths of this instance, and it calls this between files, when it holds
 * none of a finished file's paths.
 */
export function clearPrivatePaths() {
  instance?.traverse.cache.clearPath();
}
