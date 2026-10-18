/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Re-derives the four upstream property-name surfaces of the CE-00.1 research
// inventory from pinned sources: StyleX `CSSProperties`, Panda csstype plus
// `ModernCssProperties`, Panda base utility keys and BCD `css.properties`.
//
// Upstream sources are untrusted data. They are parsed, never imported or
// executed, and their locations are passed as arguments:
//
//   node tests/core-evolution/tools/extract-upstream-keys.mjs \
//     --stylex-src <stylex checkout> --panda-src <panda checkout> \
//     --bcd-data <@mdn/browser-compat-data data.json> --out <file.json>

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseFlow } from 'hermes-parser';
import ts from 'typescript';
import {
  normalizePropertyName,
  parseArgs,
  run,
  sha256,
  writeJson,
} from './lib.mjs';

function stylexKeys(root) {
  const rel = 'packages/@stylexjs/stylex/src/types/StyleXCSSTypes.js';
  const buffer = fs.readFileSync(path.join(root, rel));
  const ast = parseFlow(buffer.toString('utf8'), { flow: 'all' });
  let alias = null;
  for (const node of ast.body) {
    const decl =
      node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (decl?.type === 'TypeAlias' && decl.id.name === 'CSSProperties') {
      alias = decl;
    }
  }
  if (alias == null) {
    throw new Error(`CSSProperties alias not found in ${rel}`);
  }
  const keys = [];
  const visit = (node) => {
    if (node == null || typeof node !== 'object') {
      return;
    }
    if (node.type === 'ObjectTypeProperty') {
      const name =
        node.key.type === 'Identifier' ? node.key.name : String(node.key.value);
      keys.push(name);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === 'object' && value.type) {
        visit(value);
      }
    }
  };
  visit(alias.right);
  return { file: rel, digest: sha256(buffer), keys: [...new Set(keys)] };
}

function readTs(root, rel) {
  const buffer = fs.readFileSync(path.join(root, rel));
  const source = ts.createSourceFile(
    rel,
    buffer.toString('utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  return { buffer, source };
}

function pandaTypeKeys(root) {
  const cssRel = 'packages/types/src/csstype.d.ts';
  const modernRel = 'packages/types/src/system-types.ts';
  const css = readTs(root, cssRel);
  const keys = [];
  // Top-level interfaces only: the separate `AtRule` descriptor namespace
  // describes at-rule descriptors, not element properties.
  for (const statement of css.source.statements) {
    if (!ts.isInterfaceDeclaration(statement)) {
      continue;
    }
    for (const member of statement.members) {
      if (
        ts.isPropertySignature(member) &&
        member.questionToken &&
        ts.isIdentifier(member.name)
      ) {
        keys.push(member.name.text);
      }
    }
  }
  const modern = readTs(root, modernRel);
  const modernKeys = [];
  for (const statement of modern.source.statements) {
    if (
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'ModernCssProperties'
    ) {
      for (const member of statement.members) {
        if (ts.isPropertySignature(member)) {
          modernKeys.push(member.name.getText(modern.source));
        }
      }
    }
  }
  return {
    files: [
      { file: cssRel, digest: sha256(css.buffer) },
      { file: modernRel, digest: sha256(modern.buffer) },
    ],
    keys: [...new Set([...keys, ...modernKeys])],
    modernKeys,
  };
}

function pandaUtilityKeys(root) {
  const dir = 'packages/preset-base/src/utilities';
  const files = fs
    .readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .sort();
  const keys = [];
  const fileRecords = [];
  for (const name of files) {
    const rel = `${dir}/${name}`;
    const { buffer, source } = readTs(root, rel);
    fileRecords.push({ file: rel, digest: sha256(buffer) });
    for (const statement of source.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some(
          (m) => m.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        continue;
      }
      for (const decl of statement.declarationList.declarations) {
        let init = decl.initializer;
        while (
          init &&
          (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))
        ) {
          init = init.expression;
        }
        if (!init || !ts.isObjectLiteralExpression(init)) {
          continue;
        }
        for (const prop of init.properties) {
          if (
            prop.name &&
            (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
          ) {
            keys.push({
              key: prop.name.text,
              file: rel,
              group: decl.name.getText(source),
            });
          }
        }
      }
    }
  }
  const unique = new Map();
  for (const item of keys) {
    if (!unique.has(item.key)) {
      unique.set(item.key, item);
    }
  }
  return { files: fileRecords, keys: [...unique.values()] };
}

function bcdKeys(dataFile) {
  const buffer = fs.readFileSync(dataFile);
  const data = JSON.parse(buffer.toString('utf8'));
  const properties = data.css.properties;
  const keys = Object.keys(properties)
    .filter((key) => !key.startsWith('__'))
    .map((key) => {
      const compat = properties[key].__compat ?? {};
      return {
        key,
        status: compat.status ?? null,
        specUrl: compat.spec_url ?? null,
        mdnUrl: compat.mdn_url ?? null,
      };
    });
  return {
    version: data.__meta?.version ?? null,
    timestamp: data.__meta?.timestamp ?? null,
    digest: sha256(buffer),
    keys,
  };
}

const options = parseArgs(process.argv.slice(2), [
  'stylex-src',
  'panda-src',
  'bcd-data',
  'out',
]);
const stylex = stylexKeys(options['stylex-src']);
const pandaTypes = pandaTypeKeys(options['panda-src']);
const pandaUtilities = pandaUtilityKeys(options['panda-src']);
const bcd = bcdKeys(options['bcd-data']);
const withNames = (keys) =>
  keys.map((key) => ({ key, name: normalizePropertyName(key) }));
const result = {
  schemaVersion: 1,
  kind: 'upstream-property-key-extraction',
  method:
    'StyleX: hermes-parser ObjectTypeProperty keys of the CSSProperties alias. Panda types: TypeScript optional identifier property signatures of top-level csstype.d.ts interfaces plus ModernCssProperties members. Panda utilities: top-level keys of exported object literals in preset-base/src/utilities/*.ts except index.ts. BCD: css.properties keys of published data.json.',
  stylex: { ...stylex, keys: withNames(stylex.keys) },
  pandaTypes: {
    ...pandaTypes,
    keys: withNames(pandaTypes.keys),
  },
  pandaUtilities: {
    ...pandaUtilities,
    keys: pandaUtilities.keys.map((item) => ({
      ...item,
      name: normalizePropertyName(item.key),
    })),
  },
  bcd: { ...bcd, keys: bcd.keys.map((item) => ({ ...item, name: item.key })) },
};
run(async () => {
  await writeJson(options.out, result);
  process.stdout.write(
    `stylex=${result.stylex.keys.length} pandaTypes=${result.pandaTypes.keys.length} pandaUtilities=${result.pandaUtilities.keys.length} bcd=${result.bcd.keys.length}\n`,
  );
});
