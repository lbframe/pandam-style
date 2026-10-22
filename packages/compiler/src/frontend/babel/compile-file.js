/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import babel from '@babel/core';
import path from 'node:path';
import presetTypeScript from '@babel/preset-typescript';
import presetReact from '@babel/preset-react';
import { pandamstyleBabelPlugin } from './plugin';
import { normalizeEngineOptions } from '../../engine/index';
import {
  count,
  perfNow,
  recordParse,
  recordDuration,
  withParseOwner,
} from '../../observability/metrics';

// Babel presets ship as CommonJS; normalize the interop shape once.
const tsPreset = presetTypeScript?.default ?? presetTypeScript;
const reactPreset = presetReact?.default ?? presetReact;

/** Runs both Babel passes for one source module. */
export function compileFile(
  code,
  filename,
  designSystem,
  engineOptions = {},
  rootDir = path.dirname(filename),
) {
  const ownedEngineOptions = normalizeEngineOptions(engineOptions);
  const sourceFileName = path
    .relative(rootDir, filename)
    .split(path.sep)
    .join('/');
  // Pass 1 parses the original source with TS and JSX intact so policy and
  // provenance checks see the syntax the author wrote.
  const pass1Start = perfNow();
  const pass1 = withParseOwner('babel:pass1', () =>
    babel.transformSync(code, {
      filename,
      ast: true,
      sourceMaps: true,
      sourceFileName,
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [
        [
          pandamstyleBabelPlugin,
          { designSystem, role: 'page', engineOptions: ownedEngineOptions },
        ],
      ],
    }),
  );
  recordParse(filename, 'babel:pass1', perfNow() - pass1Start);
  count('parse_calls');
  count('parsed_files');
  if (pass1 == null) throw new Error(`No output for ${filename}`);
  count('pass1_calls');

  // Pass 2 lowers TS and JSX only after the policy plugin has checked the
  // original tree.
  const pass2Start = perfNow();
  // Pass 1 has already parsed the authored tree, and the policy plugin has
  // lowered its PandamStyle calls in place. Feed that AST into the TypeScript
  // and JSX presets so Babel core does not parse the generated pass-1 text a
  // second time. The nodes retain authored locations; using the original code
  // as generator input maps pass 2 directly to the source file.
  const pass2 = withParseOwner('babel:pass2', () =>
    babel.transformFromAstSync(pass1.ast, code, {
      filename: filename.replace(/\.tsx?$/, '.jsx'),
      sourceMaps: true,
      sourceFileName,
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      presets: [
        [tsPreset, { allExtensions: true, isTSX: true }],
        [reactPreset, { runtime: 'automatic', development: false }],
      ],
    }),
  );
  recordDuration('babel_pass2_ast_ms', perfNow() - pass2Start);
  count('pass2_ast_calls');
  count('pass2_calls');
  const out = pass2 ?? pass1;
  return {
    code: out.code,
    sourceMap: JSON.stringify(out.map),
    metadata: { ...out.metadata, ...pass1.metadata },
  };
}
