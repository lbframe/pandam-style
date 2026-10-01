/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Build the private Vite qualification seam used by tests and the packed pilot.
 * The public compiler bundle intentionally does not contain a Vite adapter.
 */

import { babel } from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const seam = path.join(repoRoot, 'tools/pilot/vite-seam.js');
const compilerSource = path.join(repoRoot, 'packages/compiler/src');
const externalPackages = new Set([
  '@babel/core',
  '@babel/helper-module-imports',
  '@babel/parser',
  '@babel/preset-react',
  '@babel/preset-typescript',
  '@babel/traverse',
  '@babel/types',
  '@csstools/css-tokenizer',
  '@pandamstyle/core',
  'postcss-value-parser',
]);

function isExternal(id) {
  return (
    externalPackages.has(id) ||
    id.startsWith('@babel/') ||
    id.startsWith('node:') ||
    ['assert', 'crypto', 'fs', 'module', 'path', 'url', 'util'].includes(id)
  );
}

export default {
  input: seam,
  external: isExternal,
  output: {
    file: path.join(repoRoot, '.pms-test-support/vite-seam.mjs'),
    format: 'es',
  },
  plugins: [
    babel({
      babelHelpers: 'bundled',
      extensions: ['.js', '.jsx', '.mjs'],
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: '20' }, modules: false }],
        '@babel/preset-flow',
      ],
      plugins: [['babel-plugin-syntax-hermes-parser', { flow: 'detect' }]],
      include: [seam, `${compilerSource}/**/*`],
    }),
    nodeResolve({
      preferBuiltins: true,
      extensions: ['.js', '.jsx', '.mjs'],
      rootDir: repoRoot,
    }),
    commonjs(),
    json(),
  ],
};
