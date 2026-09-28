/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Rollup build for @pandamstyle/compiler.
 *
 * The published package bundles the StyleX fork engine (src/shared, the fork's
 * evaluator and its rule processor) together with the PandamStyle modules, so
 * the package really contains the fork code (ARC-01) instead of delegating to
 * two upstream installations.
 *
 * Two entry points:
 *  - lib/index.*     : Node/build-time surface (compiler + build pipeline)
 *  - lib/runtime.*   : consumer runtime, dependency-light, browser-safe
 */

import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { babel } from '@rollup/plugin-babel';
import path from 'path';

const __dirname = new URL('.', import.meta.url).pathname;
const rootDir = path.resolve(__dirname, '../../..');
const PANDAMSTYLE = '../../@stylexjs/babel-plugin/pandamstyle';

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
const includeGlobs = [
  '../../@stylexjs/babel-plugin/src/**/*',
  '../../@stylexjs/babel-plugin/pandamstyle/**/*',
];

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
    input: `${PANDAMSTYLE}/entry-node.js`,
    external,
    output: [{ file: './lib/index.js', format: 'cjs', exports: 'named' }],
    plugins: plugins(),
  },
  {
    input: `${PANDAMSTYLE}/entry-node.js`,
    external,
    output: [{ file: './lib/index.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    // Bundler adapter for Vite/Rollup.
    input: `${PANDAMSTYLE}/vite.js`,
    external: [
      ...external,
      'vite',
      'rollup',
      '@rollup/pluginutils',
    ],
    output: [{ file: './lib/vite.js', format: 'cjs', exports: 'named' }],
    plugins: plugins(),
  },
  {
    input: `${PANDAMSTYLE}/vite.js`,
    external: [...external, 'vite', 'rollup', '@rollup/pluginutils'],
    output: [{ file: './lib/vite.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    // Consumer runtime: no Node builtins, no Babel, no registry.
    input: `${PANDAMSTYLE}/runtime.js`,
    external: ['@stylexjs/stylex'],
    output: [{ file: './lib/runtime.mjs', format: 'es' }],
    plugins: plugins(),
  },
  {
    input: `${PANDAMSTYLE}/runtime.js`,
    external: ['@stylexjs/stylex'],
    output: [{ file: './lib/runtime.cjs', format: 'cjs', exports: 'named' }],
    plugins: plugins(),
  },
];
