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
import crypto from 'crypto';
import fs from 'fs';
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
  // CE-01.1: exact-pinned target data, loaded from the installed packages.
  'baseline-browser-mapping',
  'browserslist',
  'caniuse-lite',
  'electron-to-chromium',
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

// CE-01.1 target data. The generated compat data is ~0.6 MB of JSON; every
// public entry reads ONE shared copy emitted next to the bundles instead of
// inlining it into each of them. The private CommonJS test bundle has no
// `import.meta.url`, so it inlines the text. Either way the bytes are the
// committed file, which is what the data digest is computed over.
const COMPAT_DATA_ID = 'pandamstyle:compat-data';
const COMPAT_DATA_FILE = 'compat-data.v1.json';
const COMPAT_DATA_SOURCE = path.resolve(
  __dirname,
  'src/targets/data/compat-data.v1.json',
);
// CE-02.1 recognized property names (~0.1 MB of JSON), read only on an
// unsupported-property diagnostic; shipped the same way as the compat data.
const RECOGNIZED_ID = 'pandamstyle:recognized-properties';
const RECOGNIZED_FILE = 'recognized-properties.v1.json';
const RECOGNIZED_SOURCE = path.resolve(
  __dirname,
  'src/design-system/policy/recognized.v1.json',
);

function dataAsset({ id, file, source, inline, withDigest }) {
  return {
    name: `pandamstyle-data:${file}`,
    resolveId(request) {
      return request === id ? `\0${id}` : null;
    },
    load(request) {
      if (request !== `\0${id}`) return null;
      const bytes = fs.readFileSync(source);
      const text = bytes.toString('utf8');
      if (inline) {
        return [
          `export default function dataText() { return ${JSON.stringify(text)}; }`,
          // The test bundle hashes its inlined text at run time.
          ...(withDigest ? ['export const compatDataDigest = null;'] : []),
        ].join('\n');
      }
      this.emitFile({ type: 'asset', fileName: file, source: bytes });
      // The digest of exactly the bytes emitted next to the bundle, so the
      // first evaluation does not hash the file; a test checks it against the
      // shipped file.
      const digest =
        'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
      return [
        "import { readFileSync } from 'node:fs';",
        'export default function dataText() {',
        `  return readFileSync(new URL('./${file}', import.meta.url));`,
        '}',
        ...(withDigest
          ? [`export const compatDataDigest = ${JSON.stringify(digest)};`]
          : []),
      ].join('\n');
    },
  };
}

function compatData({ inline }) {
  return dataAsset({
    id: COMPAT_DATA_ID,
    file: COMPAT_DATA_FILE,
    source: COMPAT_DATA_SOURCE,
    inline,
    withDigest: true,
  });
}

function recognizedProperties({ inline }) {
  return dataAsset({
    id: RECOGNIZED_ID,
    file: RECOGNIZED_FILE,
    source: RECOGNIZED_SOURCE,
    inline,
    withDigest: false,
  });
}

function plugins({ inlineCompatData = false } = {}) {
  return [
    compatData({ inline: inlineCompatData }),
    recognizedProperties({ inline: inlineCompatData }),
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
    json({ exclude: [COMPAT_DATA_SOURCE, RECOGNIZED_SOURCE] }),
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
    plugins: plugins({ inlineCompatData: true }),
  },
];
