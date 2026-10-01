/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Rollup build for @pandamstyle/compiler.
 *
 * Build the stable SDK/config/host surfaces plus explicit temporary Phase 2
 * runtime and Phase 8 Vite verifier bridges.
 */

import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { babel } from '@rollup/plugin-babel';
import path from 'path';

const __dirname = new URL('.', import.meta.url).pathname;
const rootDir = path.resolve(__dirname, '../..');

const extensions = ['.js', '.jsx', '.cjs', '.mjs'];

// Everything that must stay an external require, not be inlined.
const external = [
  '@babel/traverse',
  '@babel/types',
  '@babel/core',
  '@babel/parser',
  '@babel/helper-module-imports',
  '@babel/preset-react',
  '@babel/preset-typescript',
  '@dual-bundle/import-meta-resolve',
  '@stylexjs/stylex',
  '@stylexjs/shared',
  'postcss-value-parser',
  'styleq',
  'node:crypto',
  'node:fs',
  'node:module',
  'node:path',
  'node:url',
  'assert',
  'crypto',
  'fs',
  'module',
  'path',
  'url',
  'util',
];

// Both the fork sources and the PandamStyle modules must be transpiled:
// the fork is Flow, the PandamStyle modules are ESM.
const includeGlobs = ['../@stylexjs/babel-plugin/src/**/*', 'src/**/*'];

function plugins() {
  return [
    babel({
      babelHelpers: 'bundled',
      extensions,
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: '20' }, modules: false }],
        '@babel/preset-flow',
      ],
      // The fork sources use Flow type predicates that only the Hermes parser
      // accepts; this mirrors packages/@stylexjs/babel-plugin/.babelrc.
      plugins: [['babel-plugin-syntax-hermes-parser', { flow: 'detect' }]],
      include: includeGlobs,
    }),
    nodeResolve({
      preferBuiltins: true,
      extensions,
      allowExportsFolderMapping: true,
      rootDir,
    }),
    commonjs(),
    json(),
  ];
}

export default [
  {
    input: './src/api/cli.js',
    external,
    output: [{ file: './lib/cli.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    input: './src/api/index.js',
    external,
    output: [{ file: './lib/index.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    input: './src/api/config.js',
    plugins: plugins(),
    external,
    output: [{ file: './lib/config.mjs', format: 'es' }],
  },
  {
    input: './src/api/host.js',
    external,
    output: [{ file: './lib/host.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    // Temporary Phase 2 bridge. Generated modules will import @pandamstyle/core
    // when the independently qualified Phase 2 branch is reconciled.
    input: '../@stylexjs/babel-plugin/pandamstyle/runtime.js',
    external: ['@stylexjs/stylex'],
    output: [{ file: './lib/runtime.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    // Temporary Vite verifier seam. Phase 8 moves this implementation to
    // @pandamstyle/vite and removes this compiler subpath.
    input: '../@stylexjs/babel-plugin/pandamstyle/vite.js',
    external: [...external, 'vite', 'rollup', '@rollup/pluginutils'],
    output: [{ file: './lib/vite.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    // Tests use this private bundle instead of expanding the stable SDK root.
    input: '../../tests/support/compiler-inspection.js',
    external,
    output: [
      {
        file: '../../.pms-test-support/compiler-inspection.cjs',
        format: 'cjs',
        exports: 'named',
      },
    ],
    plugins: plugins(),
  },
];
