/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Module hooks used by the project worker to execute compiler output.
//
// Covered application modules are served from the Project Service artifacts
// (`readArtifact().javascript`), never from the original source: rendering
// therefore observes exactly what the compiler produced. Relative imports get
// the extension probing that bundlers perform; asset imports become empty
// modules because the oracle evaluates markup and compiler CSS only.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let overrides = new Map();
let workspaceUrl = '';

const ASSET = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|woff2?)$/;
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];

export function initialize(data) {
  overrides = new Map(Object.entries(data.overrides));
  workspaceUrl = data.workspaceUrl;
}

function exists(url) {
  try {
    return fs.statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith(workspaceUrl)
  ) {
    const base = new URL(specifier, context.parentURL);
    const candidates = [base.href];
    const stem = base.href.replace(/\.(js|jsx|mjs)$/, '');
    for (const ext of EXTENSIONS) candidates.push(`${stem}${ext}`);
    for (const ext of EXTENSIONS) candidates.push(`${base.href}/index${ext}`);
    for (const candidate of candidates) {
      if (overrides.has(candidate) || exists(candidate)) {
        return { url: candidate, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (overrides.has(url)) {
    return { format: 'module', source: overrides.get(url), shortCircuit: true };
  }
  if (url.startsWith(workspaceUrl) && !url.includes('/node_modules/')) {
    if (ASSET.test(url)) {
      return {
        format: 'module',
        source: 'export default "";',
        shortCircuit: true,
      };
    }
    if (/\.(jsx|tsx|ts)$/.test(url)) {
      throw new Error(
        `PMS_ORACLE_UNCOVERED_MODULE: ${url} has no compiler artifact`,
      );
    }
    if (/\.(js|mjs)$/.test(url)) {
      return {
        format: 'module',
        source: fs.readFileSync(fileURLToPath(url), 'utf8'),
        shortCircuit: true,
      };
    }
  }
  return nextLoad(url, context);
}
