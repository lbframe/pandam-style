/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Rollup build for @pandamstyle/compiler.
 *
 * Build the stable SDK/config/host surfaces from PandamStyle-owned source.
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
  '@pandamstyle/core',
  '@csstools/css-tokenizer',
  'postcss-value-parser',
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
// The private CommonJS inspection bundle used by the existing Jest suites
// needs the ESM-only core inlined. Public compiler bundles keep core external.
const inspectionExternal = external.filter(
  (specifier) => specifier !== '@pandamstyle/core',
);

// The owned engine retains Flow annotations; no donor tree enters this build.
const includeGlobs = ['src/**/*'];

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
      // The owned engine uses Flow type predicates parsed by Hermes.
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
    // Tests use this private bundle instead of expanding the stable SDK root.
    input: '../../tests/support/compiler-inspection.js',
    external: inspectionExternal,
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
