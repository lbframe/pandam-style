/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import babel from '@babel/core';
import presetTypeScript from '@babel/preset-typescript';
import presetReact from '@babel/preset-react';
import styleXTransform from '../../../../@stylexjs/babel-plugin/src/index';
import { pandamstyleBabelPlugin } from './plugin';
import {
  count,
  perfNow,
  recordParse,
  withParseOwner,
} from '../../observability/metrics';

// Babel presets ship as CommonJS; normalize the interop shape once.
const tsPreset = presetTypeScript?.default ?? presetTypeScript;
const reactPreset = presetReact?.default ?? presetReact;

/** Runs both Babel passes for one source module. */
export function compileFile(code, filename, designSystem, engineOptions = {}) {
  // Pass 1 parses the original source with TS and JSX intact so policy and
  // provenance checks see the syntax the author wrote.
  const pass1Start = perfNow();
  const pass1 = withParseOwner('babel:pass1', () =>
    babel.transformSync(code, {
      filename,
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      parserOpts: { plugins: ['jsx', 'typescript'] },
      plugins: [
        [pandamstyleBabelPlugin, { designSystem, role: 'page', engineOptions }],
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
  const pass2 = withParseOwner('babel:pass2', () =>
    babel.transformSync(pass1.code, {
      filename: filename.replace(/\.tsx?$/, '.jsx'),
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      presets: [
        [tsPreset, { allExtensions: true, isTSX: true }],
        [reactPreset, { runtime: 'automatic', development: false }],
      ],
    }),
  );
  recordParse(filename, 'babel:pass2', perfNow() - pass2Start);
  count('parse_calls');
  count('parsed_files');
  count('pass2_calls');
  const out = pass2 ?? pass1;
  return { code: out.code, metadata: { ...out.metadata, ...pass1.metadata } };
}

export { styleXTransform };
