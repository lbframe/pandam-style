/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Static source rules evaluated by the harness on the final workspace.
// Findings are compared with the baseline file so that only constructs the
// evaluated agent introduced are attributed to it.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

const CSS_IN_JS =
  /^(styled-components|@emotion\/|@stitches\/|@vanilla-extract\/|goober|jss|@pandacss\/|twin\.macro|styled-jsx)/;
// `st[y]l` is the Stylus extension, spelled so the spell checker does not read it as a typo.
const STYLESHEET = /\.(css|scss|sass|less|st[y]l)(\?.*)?$/;
const PMS_DIRECT = /^@pandamstyle\/(core|compiler)(\/.*)?$/;

export const STATIC_RULES = [
  'jsx-style-prop',
  'runtime-style-injection',
  'css-in-js-import',
  'stylesheet-import',
  'raw-classname',
  'type-escape',
  'direct-pandamstyle-import',
  'generated-internal-import',
];

function parseSource(code, file) {
  return parse(code, {
    sourceType: 'unambiguous',
    errorRecovery: false,
    plugins: [
      'jsx',
      file.endsWith('.ts') || file.endsWith('.tsx') ? 'typescript' : 'flow',
      'importAttributes',
      'decorators-legacy',
    ],
  });
}

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra')
      continue;
    if (value != null && typeof value === 'object') walk(value, visit);
  }
}

function memberName(node) {
  if (
    node?.type === 'MemberExpression' ||
    node?.type === 'OptionalMemberExpression'
  ) {
    if (!node.computed && node.property.type === 'Identifier')
      return node.property.name;
    if (node.property.type === 'StringLiteral') return node.property.value;
  }
  return null;
}

/** Returns `[{ rule, line, detail }]` for one file. */
export function findConstructs(code, file, { isDefinition = false } = {}) {
  let ast;
  try {
    ast = parseSource(code, file);
  } catch (error) {
    return [
      {
        rule: 'parse-error',
        line: error.loc?.line ?? 0,
        detail: error.message,
      },
    ];
  }
  const out = [];
  const add = (rule, node, detail) =>
    out.push({ rule, line: node.loc?.start.line ?? 0, detail });
  for (const comment of ast.comments ?? []) {
    if (
      /@ts-(ignore|expect-error|nocheck)|eslint-disable/.test(comment.value)
    ) {
      add('type-escape', comment, comment.value.trim().slice(0, 60));
    }
  }
  walk(ast.program, (node) => {
    switch (node.type) {
      case 'JSXAttribute': {
        const name = node.name?.name;
        if (name === 'style') add('jsx-style-prop', node, 'style attribute');
        if (name === 'dangerouslySetInnerHTML')
          add('runtime-style-injection', node, 'dangerouslySetInnerHTML');
        if (
          name === 'className' &&
          (node.value?.type === 'StringLiteral' ||
            node.value?.expression?.type === 'StringLiteral' ||
            node.value?.expression?.type === 'TemplateLiteral')
        ) {
          add('raw-classname', node, 'literal className');
        }
        break;
      }
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        const source = node.source?.value;
        if (typeof source !== 'string') break;
        if (CSS_IN_JS.test(source)) add('css-in-js-import', node, source);
        if (STYLESHEET.test(source)) add('stylesheet-import', node, source);
        if (!isDefinition && PMS_DIRECT.test(source))
          add('direct-pandamstyle-import', node, source);
        if (
          /\.pandamstyle\/(js|css)\//.test(source) ||
          /manifest\.json$/.test(source)
        ) {
          add('generated-internal-import', node, source);
        }
        break;
      }
      case 'CallExpression': {
        const callee = memberName(node.callee) ?? node.callee?.name;
        const arg = node.arguments?.[0];
        if (
          callee === 'createElement' &&
          arg?.type === 'StringLiteral' &&
          arg.value === 'style'
        ) {
          add('runtime-style-injection', node, "createElement('style')");
        }
        if (
          [
            'insertRule',
            'replaceSync',
            'setProperty',
            'insertAdjacentHTML',
          ].includes(callee)
        ) {
          add('runtime-style-injection', node, callee);
        }
        if (callee === 'require' && arg?.type === 'StringLiteral') {
          if (CSS_IN_JS.test(arg.value))
            add('css-in-js-import', node, arg.value);
          if (STYLESHEET.test(arg.value))
            add('stylesheet-import', node, arg.value);
        }
        break;
      }
      case 'NewExpression':
        if (node.callee?.name === 'CSSStyleSheet')
          add('runtime-style-injection', node, 'new CSSStyleSheet');
        break;
      case 'MemberExpression': {
        const name = memberName(node);
        if (
          name === 'adoptedStyleSheets' ||
          name === 'cssText' ||
          name === 'styleSheets'
        ) {
          add('runtime-style-injection', node, name);
        }
        break;
      }
      case 'AssignmentExpression': {
        const target = node.left;
        if (
          (target.type === 'MemberExpression' &&
            memberName(target.object) === 'style') ||
          memberName(target) === 'innerHTML'
        ) {
          add('runtime-style-injection', node, 'style/innerHTML assignment');
        }
        break;
      }
      case 'TSAsExpression':
      case 'TSTypeAssertion':
        if (node.typeAnnotation?.type === 'TSAnyKeyword')
          add('type-escape', node, 'as any');
        break;
      case 'TypeCastExpression':
        if (node.typeAnnotation?.typeAnnotation?.type === 'AnyTypeAnnotation') {
          add('type-escape', node, 'any cast');
        }
        break;
      case 'TaggedTemplateExpression': {
        const tag = node.tag;
        const name = tag?.name ?? memberName(tag) ?? tag?.callee?.name;
        if (
          [
            'css',
            'styled',
            'injectGlobal',
            'createGlobalStyle',
            'keyframes',
          ].includes(name)
        ) {
          add('css-in-js-import', node, `tagged template ${name}`);
        }
        break;
      }
      default:
        break;
    }
  });
  return out;
}

/** Counts findings per rule. */
export function countByRule(findings) {
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  return counts;
}

/**
 * Extracts the literal options passed to a PandamStyle host integration.
 * Returns `{ found, options, plugins }` where `plugins` lists callee names of
 * the entries in a `plugins: [...]` array (in order).
 */
export function inspectHostConfig(code, file) {
  let ast;
  try {
    ast = parseSource(code, file);
  } catch (error) {
    return { found: false, error: error.message, plugins: [] };
  }
  const imported = new Map();
  walk(ast.program, (node) => {
    if (
      node.type === 'ImportDeclaration' &&
      /^@pandamstyle\//.test(node.source.value)
    ) {
      for (const s of node.specifiers)
        imported.set(s.local.name, node.source.value);
    }
    if (
      node.type === 'VariableDeclarator' &&
      node.init?.type === 'CallExpression' &&
      node.init.callee?.name === 'require' &&
      /^@pandamstyle\//.test(node.init.arguments?.[0]?.value ?? '')
    ) {
      if (node.id.type === 'ObjectPattern') {
        for (const p of node.id.properties) {
          if (p.value?.type === 'Identifier')
            imported.set(p.value.name, node.init.arguments[0].value);
        }
      }
    }
  });
  const literal = (node) => {
    if (node == null) return undefined;
    if (
      node.type === 'StringLiteral' ||
      node.type === 'BooleanLiteral' ||
      node.type === 'NumericLiteral'
    ) {
      return node.value;
    }
    if (node.type === 'ArrayExpression') return node.elements.map(literal);
    if (node.type === 'ObjectExpression') {
      const obj = {};
      for (const p of node.properties) {
        if (p.type !== 'ObjectProperty') return { __nonLiteral: true };
        obj[p.key.name ?? p.key.value] = literal(p.value);
      }
      return obj;
    }
    return { __nonLiteral: node.type };
  };
  const calls = [];
  const plugins = [];
  walk(ast.program, (node) => {
    if (node.type === 'CallExpression' && imported.has(node.callee?.name)) {
      calls.push({
        callee: node.callee.name,
        module: imported.get(node.callee.name),
        options: literal(node.arguments[0]),
      });
    }
    if (
      node.type === 'ObjectProperty' &&
      (node.key?.name ?? node.key?.value) === 'plugins' &&
      node.value?.type === 'ArrayExpression'
    ) {
      for (const el of node.value.elements) {
        if (el?.type === 'CallExpression')
          plugins.push(el.callee?.name ?? memberName(el.callee) ?? '?');
        else if (el?.type === 'ObjectExpression') {
          const nameProp = el.properties.find(
            (p) => (p.key?.name ?? p.key?.value) === 'name',
          );
          plugins.push(`object:${nameProp?.value?.value ?? '?'}`);
        } else if (el != null) plugins.push(el.type);
      }
    }
  });
  return { found: calls.length > 0, calls, plugins };
}
