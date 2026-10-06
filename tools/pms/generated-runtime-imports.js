/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { parseModuleImports } = require('./module-imports');

function generatedFiles(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.[cm]?jsx?$/.test(entry.name)) files.push(full);
    }
  }
  visit(root);
  return files.sort();
}

function inspect(root) {
  const files = generatedFiles(root);
  const counts = {
    '@pandamstyle/core': 0,
    '@stylexjs/*': 0,
    '@pandacss/*': 0,
    '@pandamstyle/compiler/runtime': 0,
  };
  const imports = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const item of parseModuleImports(source, file)) {
      if (item.typeOnly) continue;
      const specifier = item.specifier;
      imports.push({ file: path.relative(root, file), ...item });
      if (specifier === '@pandamstyle/core') counts['@pandamstyle/core']++;
      if (specifier.startsWith('@stylexjs/')) counts['@stylexjs/*']++;
      if (specifier.startsWith('@pandacss/')) counts['@pandacss/*']++;
      if (specifier === '@pandamstyle/compiler/runtime')
        counts['@pandamstyle/compiler/runtime']++;
    }
  }
  return { fileCount: files.length, counts, imports };
}

if (require.main === module) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output)
    throw new Error('generated output and report paths required');
  const report = inspect(path.resolve(root));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (
    report.fileCount === 0 ||
    report.counts['@pandamstyle/core'] === 0 ||
    report.counts['@stylexjs/*'] !== 0 ||
    report.counts['@pandacss/*'] !== 0 ||
    report.counts['@pandamstyle/compiler/runtime'] !== 0
  ) {
    throw new Error('GENERATED_RUNTIME_IMPORT_CLOSURE_FAILED');
  }
}

module.exports = { inspect };
