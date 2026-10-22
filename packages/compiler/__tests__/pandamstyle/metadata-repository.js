/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Every standalone design-system definition module of the repository (the
 * AG-03.1 design note's P10 set), evaluated from its bytes. Used by the
 * metadata differential (AC4) and the ingress regression check (R2-1).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../../../..');
const ROOTS = [
  'benchmarks/agentic/fixtures',
  'benchmarks/agentic/tasks',
  'examples',
  'packages/compiler/__tests__/pandamstyle/fixtures',
  'tests/fixtures',
];

function candidateFiles() {
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (
        /\.(m?js)$/.test(entry.name) &&
        /systemId\s*:/.test(fs.readFileSync(abs, 'utf8'))
      )
        out.push(abs);
    }
  };
  for (const root of ROOTS) walk(path.join(REPO, root));
  return out.sort();
}

function evaluate(file) {
  const babel = require('@babel/core');
  const transformed = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    filename: file,
    babelrc: false,
    configFile: false,
    plugins: [require('@babel/plugin-transform-modules-commonjs')],
  });
  const compiler = require(
    path.join(REPO, '.pms-test-support/compiler-inspection.cjs'),
  );
  const nodeRequire = require('module').createRequire(file);
  const localRequire = (specifier) =>
    specifier === '@pandamstyle/compiler/config' ||
    specifier.endsWith('design-system/tokens/ref') ||
    specifier.endsWith('design-system/tokens/ref.js')
      ? { token: compiler.token, defineConfig: (config) => config }
      : nodeRequire(specifier);
  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', transformed.code)(
    localRequire,
    module_,
    module_.exports,
  );
  return module_.exports;
}

/** `{ file, name, definition }` for every exported definition object. */
function repositoryDefinitions() {
  const out = [];
  for (const file of candidateFiles()) {
    const exports = evaluate(file);
    for (const [name, value] of Object.entries(exports)) {
      if (value === null || typeof value !== 'object') continue;
      const definition = Object.hasOwn(value, 'systemId')
        ? value
        : value.definition;
      if (
        definition == null ||
        typeof definition !== 'object' ||
        !Object.hasOwn(definition, 'systemId')
      )
        continue;
      out.push({
        file: path.relative(REPO, file).split(path.sep).join('/'),
        name,
        definition,
      });
    }
  }
  return out;
}

module.exports = { repositoryDefinitions };
