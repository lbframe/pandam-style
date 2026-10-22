/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.2 design evidence: what Lightning CSS does at the O13 minimum floor.
//
//   node tools/targets/lightningcss-probe.mjs
//
// Runs the installed `lightningcss` (a dependency of the Vite host package
// only, never of the compiler) over probe CSS for the transformation families
// of #45, with targets at the O13 floor. The output backs the rejection of
// option (b) in docs/architecture/ce-01.2-transformation-stage.md §3.2.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './corpus-features.mjs';

const require = createRequire(path.join(REPO, 'package.json'));
const lightningcss = require('lightningcss');
const { version } = JSON.parse(
  fs.readFileSync(
    path.join(REPO, 'node_modules/lightningcss/package.json'),
    'utf8',
  ),
);

const v = (major, minor = 0) => (major << 16) | (minor << 8);
const TARGETS = {
  chrome: v(100),
  edge: v(100),
  firefox: v(100),
  safari: v(15, 4),
  ios_saf: v(15, 4),
  android: v(100),
};

export const PROBES = {
  layer:
    '@layer priority1, priority2;\n@layer priority2{.a:hover{color:red}}\n@layer priority1{.b{color:blue!important}}',
  oklch: '.a{color:oklch(50% 0.1 30)}',
  'oklch-token': ':root{--c:oklch(50% 0.1 30)}',
  'color-mix': '.a{color:color-mix(in oklab, red, blue)}',
  relative: '.a{color:oklch(from red l c h)}',
  'color-p3': '.a{color:color(display-p3 1 0 0)}',
  'light-dark': '.a{color:light-dark(red, blue)}',
  'light-dark-token': ':root{--fg:light-dark(black, white)}',
  'color-scheme': ':root{color-scheme:light dark}',
  'color-scheme-class':
    '.dark{color-scheme:dark}.a{color:light-dark(red, blue)}',
  nesting: '.a{&:hover{color:red}}',
  is: '.a:is(.b,.c){color:red}',
  has: '.a:has(.b){color:red}',
  'media-range': '@media (width >= 600px){.a{color:red}}',
  'media-range-strict': '@media (width > 600px){.a{color:red}}',
  container: '@container (min-width: 400px){.a{color:red}}',
  property:
    '@property --x { syntax: "<color>"; inherits: true; initial-value: red }',
  'user-select': '.a{user-select:none}',
  'mask-image': '.a{mask-image:linear-gradient(red, blue)}',
  logical: '.a{margin-inline-start:1px;inset-inline:0;float:inline-start}',
  dir: '.a:dir(rtl){color:red}',
};

const lines = [`lightningcss ${version}, targets ${JSON.stringify(TARGETS)}`];
for (const [name, css] of Object.entries(PROBES)) {
  try {
    const out = lightningcss.transform({
      filename: `${name}.css`,
      code: Buffer.from(css),
      targets: TARGETS,
      minify: true,
    });
    lines.push(`== ${name}`, `in:  ${css}`, `out: ${out.code.toString()}`);
    for (const warning of out.warnings) lines.push(`warn: ${warning.message}`);
  } catch (error) {
    lines.push(`== ${name}`, `in:  ${css}`, `error: ${error.message}`);
  }
}
process.stdout.write(lines.join('\n') + '\n');
