/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const parser = require('@babel/parser');
const hermesParser = require('hermes-parser');

function parseTypeScriptProgram(source, filename) {
  const declarationFile = /\.d\.(?:ts|mts|cts)$/.test(filename);
  return parser.parse(source, {
    sourceType: 'unambiguous',
    sourceFilename: filename,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    plugins: [
      'jsx',
      ['typescript', { dts: declarationFile }],
      'decorators-legacy',
      'dynamicImport',
    ],
  }).program;
}

function parseProgram(source, filename = '<source>') {
  if (/\.(?:ts|tsx|mts|cts)$/.test(filename))
    return parseTypeScriptProgram(source, filename);
  try {
    return hermesParser.parse(source, {
      babel: true,
      flow: 'all',
      sourceType: 'unambiguous',
      sourceFilename: filename,
      allowReturnOutsideFunction: true,
    }).program;
  } catch (flowError) {
    try {
      return parseTypeScriptProgram(source, filename);
    } catch (typescriptError) {
      typescriptError.cause = flowError;
      throw typescriptError;
    }
  }
}

function stringValue(node) {
  if (node?.type === 'StringLiteral' || node?.type === 'Literal')
    return typeof node.value === 'string' ? node.value : null;
  if (
    node?.type === 'TemplateLiteral' &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  return null;
}

function parseModuleImports(source, filename = '<source>') {
  const ast = parseProgram(source, filename);
  const imports = [];
  const visited = new WeakSet();

  function record(specifier, kind, node, typeOnly = false) {
    if (typeof specifier !== 'string') {
      if (kind === 'dynamic-import' || kind === 'require') {
        imports.push({
          specifier: null,
          kind,
          typeOnly,
          line: node.loc?.start.line ?? null,
          column: node.loc?.start.column ?? null,
        });
      }
      return;
    }
    imports.push({
      specifier,
      kind,
      typeOnly,
      line: node.loc?.start.line ?? null,
      column: node.loc?.start.column ?? null,
    });
  }

  function visit(node) {
    if (node == null || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    switch (node.type) {
      case 'ImportDeclaration':
        record(
          stringValue(node.source),
          'import',
          node,
          node.importKind === 'type' || node.importKind === 'typeof',
        );
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source != null)
          record(
            stringValue(node.source),
            're-export',
            node,
            node.exportKind === 'type',
          );
        break;
      case 'ImportExpression':
        record(stringValue(node.source), 'dynamic-import', node);
        break;
      case 'TSImportType':
        record(stringValue(node.argument), 'type-import', node, true);
        break;
      case 'CallExpression': {
        const specifier = stringValue(node.arguments?.[0]);
        if (node.callee?.type === 'Import')
          record(specifier, 'dynamic-import', node);
        else if (
          node.callee?.type === 'Identifier' &&
          node.callee.name === 'require'
        )
          record(specifier, 'require', node);
        break;
      }
      default:
        break;
    }

    for (const [key, value] of Object.entries(node)) {
      if (
        key === 'loc' ||
        key === 'start' ||
        key === 'end' ||
        key === 'extra' ||
        key === 'tokens' ||
        key.endsWith('Comments')
      )
        continue;
      if (value != null && typeof value === 'object') visit(value);
    }
  }

  visit(ast);
  return imports;
}

module.exports = { parseModuleImports, parseProgram };
