/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Static source rules evaluated by the harness on the final workspace.
// Findings are compared with the baseline file so that only constructs the
// evaluated agent introduced are attributed to it.

import { createRequire, isBuiltin } from 'node:module';
import { HTML_ELEMENTS, presentationalChannel } from './style-channels.mjs';

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
  'dom-global-access',
  'dynamic-code',
  'privileged-import',
];

// Members whose use reads or writes inline styles, style sheets or raw markup.
const STYLE_MEMBERS = new Set([
  'style',
  'cssText',
  'adoptedStyleSheets',
  'styleSheets',
  'sheet',
  'cssRules',
  'insertRule',
  'deleteRule',
  'addRule',
  'replaceSync',
  'setProperty',
  'removeProperty',
  'attributeStyleMap',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'animate',
]);
const STYLE_GLOBALS = new Set([
  'CSSStyleSheet',
  'CSS',
  'StyleSheet',
  'CSSStyleDeclaration',
  'CSSStyleRule',
  'FontFace',
]);
// Ambient objects through which any DOM or runtime mutation is reachable.
// Static analysis cannot prove a use harmless, so use fails closed.
const DOM_GLOBALS = new Set([
  'document',
  'window',
  'globalThis',
  'self',
  'top',
  'frames',
  'navigator',
  'location',
]);
const MUTATORS = new Set([
  'assign',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
]);

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

// Folds a computed member key to a string when it is a constant expression.
function constantKey(node) {
  if (node == null) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis.map((q) => q.value.cooked).join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = constantKey(node.left);
    const r = constantKey(node.right);
    return l != null && r != null ? l + r : null;
  }
  return null;
}

function propertyName(node) {
  if (
    node?.type !== 'MemberExpression' &&
    node?.type !== 'OptionalMemberExpression'
  )
    return null;
  if (!node.computed)
    return node.property.type === 'Identifier' ? node.property.name : null;
  return constantKey(node.property);
}

function isLiteralObject(node) {
  return node?.type === 'ObjectExpression' || node?.type === 'ArrayExpression';
}

function isReference(node, parent, key) {
  if (parent == null) return true;
  if (
    (parent.type === 'MemberExpression' ||
      parent.type === 'OptionalMemberExpression') &&
    key === 'property' &&
    !parent.computed
  )
    return false;
  if (
    (parent.type === 'ObjectProperty' ||
      parent.type === 'ObjectMethod' ||
      parent.type === 'ClassProperty' ||
      parent.type === 'ClassMethod') &&
    key === 'key' &&
    !parent.computed
  )
    return false;
  if (parent.type === 'VariableDeclarator' && key === 'id') return false;
  if (
    (parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') &&
    key !== 'body'
  )
    return false;
  if (parent.type.startsWith('Import') || parent.type === 'ExportSpecifier')
    return false;
  if (parent.type.startsWith('JSX')) return false;
  if (parent.type.startsWith('TS') || parent.type.endsWith('TypeAnnotation'))
    return false;
  if (
    parent.type === 'LabeledStatement' ||
    parent.type === 'BreakStatement' ||
    parent.type === 'ContinueStatement'
  )
    return false;
  return true;
}

function walkWithParent(node, visit, parent = null, key = null) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkWithParent(child, visit, parent, key);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent, key);
  for (const [k, value] of Object.entries(node)) {
    if (
      k === 'loc' ||
      k === 'start' ||
      k === 'end' ||
      k === 'extra' ||
      k === 'leadingComments' ||
      k === 'trailingComments' ||
      k === 'innerComments'
    )
      continue;
    if (value != null && typeof value === 'object')
      walkWithParent(
        value,
        visit,
        typeof node.type === 'string' ? node : parent,
        k,
      );
  }
}

// --- Analyzable subset ------------------------------------------------------
//
// Code outside the subset the analysis can decide fails `dynamic-code`, never
// passes: string-built code (eval, Function and any alias, `.constructor`),
// prototype mutation, `with`, calls through computed members or call results,
// computed writes on values not provably plain data, and computed reads on
// values that may be DOM nodes. Computed reads on ordinary data (array
// indexing, lookup maps) stay inside the subset.

const DOM_PROPERTIES = new Set([
  'current',
  'target',
  'currentTarget',
  'srcElement',
  'relatedTarget',
  'nativeEvent',
  'parentNode',
  'parentElement',
  'firstChild',
  'lastChild',
  'firstElementChild',
  'lastElementChild',
  'nextSibling',
  'previousSibling',
  'nextElementSibling',
  'previousElementSibling',
  'children',
  'childNodes',
  'ownerDocument',
  'documentElement',
  'body',
  'head',
  'defaultView',
  'view',
  'shadowRoot',
  'style',
  'sheet',
  'frameElement',
]);
const DOM_QUERIES = new Set([
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'getElementsByName',
  'closest',
  'item',
  'elementFromPoint',
  'elementsFromPoint',
  'cloneNode',
  'getRootNode',
  'getComputedStyle',
  'useRef',
  'createRef',
]);
const PLAIN_CONSTRUCTORS = new Set([
  'Map',
  'Set',
  'Array',
  'Object',
  'WeakMap',
  'WeakSet',
]);

function isPlainDataInit(init) {
  if (init == null) return false;
  if (init.type === 'ObjectExpression' || init.type === 'ArrayExpression')
    return true;
  if (
    init.type === 'NewExpression' &&
    PLAIN_CONSTRUCTORS.has(init.callee?.name)
  )
    return true;
  if (init.type === 'CallExpression') {
    const callee = init.callee;
    const owner = callee?.object?.name;
    const name = propertyName(callee);
    if (
      owner === 'Object' &&
      ['freeze', 'fromEntries', 'assign'].includes(name)
    )
      return name !== 'assign' || isPlainDataInit(init.arguments?.[0]);
    if (owner === 'Array' && name === 'from') return true;
  }
  return false;
}

function collectBindings(program) {
  const plain = new Set();
  const declarators = [];
  const domParams = new Set();
  walkWithParent(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      declarators.push(node);
      if (node.id.type === 'Identifier' && isPlainDataInit(node.init))
        plain.add(node.id.name);
    }
    if (node.type === 'JSXAttribute') {
      const name = node.name?.name;
      const fn = node.value?.expression;
      if (
        (name === 'ref' || /^on[A-Z]/.test(name ?? '')) &&
        fn != null &&
        (fn.type === 'ArrowFunctionExpression' ||
          fn.type === 'FunctionExpression')
      ) {
        for (const param of fn.params)
          walkWithParent(
            param,
            (p) => p.type === 'Identifier' && domParams.add(p.name),
          );
      }
    }
  });
  const tainted = new Set(domParams);
  const isTainted = (expr) => {
    if (expr == null) return false;
    if (expr.type === 'Identifier')
      return tainted.has(expr.name) || DOM_GLOBALS.has(expr.name);
    if (
      expr.type === 'MemberExpression' ||
      expr.type === 'OptionalMemberExpression'
    ) {
      const name = propertyName(expr);
      return (
        (name != null && DOM_PROPERTIES.has(name)) || isTainted(expr.object)
      );
    }
    if (
      expr.type === 'CallExpression' ||
      expr.type === 'OptionalCallExpression'
    ) {
      const name = propertyName(expr.callee) ?? expr.callee?.name;
      return (
        (name != null && DOM_QUERIES.has(name)) ||
        isTainted(expr.callee?.object)
      );
    }
    if (
      expr.type === 'LogicalExpression' ||
      expr.type === 'ConditionalExpression'
    ) {
      return (
        isTainted(expr.left ?? expr.consequent) ||
        isTainted(expr.right ?? expr.alternate)
      );
    }
    if (
      expr.type === 'TSAsExpression' ||
      expr.type === 'TSNonNullExpression' ||
      expr.type === 'TypeCastExpression'
    )
      return isTainted(expr.expression);
    return false;
  };
  const namesIn = (pattern) => {
    const names = [];
    walkWithParent(
      pattern,
      (p) => p.type === 'Identifier' && names.push(p.name),
    );
    return names;
  };
  let size = -1;
  while (tainted.size !== size) {
    size = tainted.size;
    for (const d of declarators) {
      if (isTainted(d.init))
        for (const name of namesIn(d.id)) tainted.add(name);
    }
  }
  // Ref containers: `const refs = useRef([])` (or `{}`, `new Array(n)`, ...)
  // holds a collection;
  // `refs.current` is plain data even though its elements may be nodes.
  const refContainers = new Set();
  // Local names of React's useRef (`import { useRef as useR } from 'react'`);
  // `React.useRef` is matched by member name.
  const useRefNames = new Set(['useRef']);
  walk(program, (node) => {
    if (node.type === 'ImportDeclaration' && node.source?.value === 'react')
      for (const spec of node.specifiers ?? [])
        if (
          spec.type === 'ImportSpecifier' &&
          (spec.imported?.name ?? spec.imported?.value) === 'useRef'
        )
          useRefNames.add(spec.local.name);
  });
  // A provably plain initial value: a literal, `new Array(n)`, `Array.from`,
  // ... or a local bound to one.
  const plainInitial = (arg) =>
    isPlainDataInit(arg) || (arg?.type === 'Identifier' && plain.has(arg.name));
  // Accumulators of `reduce(fn, <plain literal>)`: the callback's first
  // parameter, by name and callback source range.
  const accumulators = [];
  for (const d of declarators) {
    const init = d.init;
    if (
      d.id.type === 'Identifier' &&
      init?.type === 'CallExpression' &&
      (useRefNames.has(init.callee?.name) ||
        propertyName(init.callee) === 'useRef') &&
      plainInitial(init.arguments?.[0])
    )
      refContainers.add(d.id.name);
  }
  walkWithParent(program, (node) => {
    if (
      node.type === 'CallExpression' &&
      ['reduce', 'reduceRight'].includes(propertyName(node.callee)) &&
      isPlainDataInit(node.arguments?.[1])
    ) {
      const fn = node.arguments[0];
      if (
        (fn?.type === 'ArrowFunctionExpression' ||
          fn?.type === 'FunctionExpression') &&
        fn.params[0]?.type === 'Identifier'
      )
        accumulators.push({
          name: fn.params[0].name,
          start: fn.start,
          end: fn.end,
        });
    }
  });
  // Provably plain data as a mutation target: a literal, a local bound to a
  // literal, or a reduce accumulator seeded with one.
  const isPlainTarget = (expr, at) =>
    isLiteralObject(expr) ||
    (expr?.type === 'Identifier' &&
      (plain.has(expr.name) ||
        accumulators.some(
          (a) => a.name === expr.name && at.start >= a.start && at.end <= a.end,
        )));
  const isRefContainer = (expr) =>
    propertyName(expr) === 'current' &&
    expr.object?.type === 'Identifier' &&
    refContainers.has(expr.object.name);
  return { plain, isTainted, isPlainTarget, isRefContainer };
}

function isNonConstantComputed(node) {
  return (
    (node?.type === 'MemberExpression' ||
      node?.type === 'OptionalMemberExpression') &&
    node.computed &&
    constantKey(node.property) == null &&
    node.property?.type !== 'NumericLiteral'
  );
}

/**
 * Returns `[{ rule, line, detail }]` for one file. Rules fail closed: a
 * construct that could mutate styles and cannot be proven harmless statically
 * is reported (`dom-global-access`, `dynamic-code`, non-literal mutation
 * targets), never assumed safe.
 */
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
  const checkModule = (node, source) => {
    if (typeof source !== 'string') {
      add('dynamic-code', node, 'non-literal module specifier');
      return;
    }
    if (CSS_IN_JS.test(source)) add('css-in-js-import', node, source);
    if (STYLESHEET.test(source)) add('stylesheet-import', node, source);
    if (!isDefinition && PMS_DIRECT.test(source))
      add('direct-pandamstyle-import', node, source);
    if (
      /\.pandamstyle\/(js|css)\//.test(source) ||
      /manifest\.json$/.test(source)
    )
      add('generated-internal-import', node, source);
    if (isBuiltin(source)) add('privileged-import', node, source);
  };
  const bindings = collectBindings(ast.program);
  // JSX elements inside <svg> carry SVG's own attributes.
  const insideSvg = new Set();
  walk(ast.program, (node) => {
    if (node.type === 'JSXElement' && node.openingElement?.name?.name === 'svg')
      walk(node.children, (inner) => {
        if (inner.type === 'JSXOpeningElement') insideSvg.add(inner);
      });
  });
  const presentational = (node, tag, attributes) => {
    if (typeof tag !== 'string' || !/^[a-z]/.test(tag)) return;
    if (tag === 'svg' || insideSvg.has(node)) return;
    const element = presentationalChannel(tag);
    if (element != null) add('jsx-style-prop', node, element);
    // Attributes only on provably HTML elements; the committed-DOM checks
    // cover the rest with the real namespace.
    if (!HTML_ELEMENTS.has(tag)) return;
    for (const name of attributes) {
      const channel = presentationalChannel(tag, name);
      if (channel != null) add('jsx-style-prop', node, channel);
    }
  };
  const writeTarget = (target, node, how) => {
    if (
      target?.type === 'MemberExpression' ||
      target?.type === 'OptionalMemberExpression'
    ) {
      if (
        propertyName(target.object) === 'prototype' ||
        propertyName(target) === 'prototype' ||
        propertyName(target) === '__proto__'
      ) {
        add('dynamic-code', node, `prototype mutation (${how})`);
      }
      // Computed writes on ordinary values are left to the dynamic trace,
      // which observes their effect on the DOM; only DOM-reachable targets
      // are undecidable here. A ref container (`refs.current[i] = el`) is
      // ordinary data.
      const owner = target.object;
      const refContainer = bindings.isRefContainer(owner);
      if (
        isNonConstantComputed(target) &&
        !refContainer &&
        bindings.isTainted(owner)
      ) {
        add(
          'dynamic-code',
          node,
          `computed ${how} on a value that may be a DOM node`,
        );
      }
    }
  };
  walkWithParent(ast.program, (node, parent, key) => {
    if (node.type === 'WithStatement')
      add('dynamic-code', node, 'with statement');
    if (node.type === 'UpdateExpression')
      writeTarget(node.argument, node, 'update');
    if (node.type === 'UnaryExpression' && node.operator === 'delete')
      writeTarget(node.argument, node, 'delete');
    if (
      node.type === 'CallExpression' ||
      node.type === 'OptionalCallExpression' ||
      node.type === 'NewExpression'
    ) {
      const callee = node.callee;
      // Computed calls on ordinary values (lookup maps such as
      // `handlers[e.key]?.()`) are left to the dynamic trace; a computed call
      // on a DOM-reachable value (`el[name](...)`) is undecidable.
      if (isNonConstantComputed(callee) && bindings.isTainted(callee.object)) {
        add(
          'dynamic-code',
          node,
          'computed call on a value that may be a DOM node',
        );
      }
    }
    if (
      (node.type === 'MemberExpression' ||
        node.type === 'OptionalMemberExpression') &&
      !(parent?.type === 'AssignmentExpression' && key === 'left')
    ) {
      const name = propertyName(node);
      if (name === 'constructor' || name === '__proto__')
        add('dynamic-code', node, `.${name} access`);
      // Indexing a ref container (`refs.current[i]`) reads plain data; the
      // element it yields stays a possible DOM node for later uses.
      if (
        isNonConstantComputed(node) &&
        bindings.isTainted(node.object) &&
        !bindings.isRefContainer(node.object)
      )
        add(
          'dynamic-code',
          node,
          'computed access on a value that may be a DOM node',
        );
    }
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
      case 'JSXSpreadAttribute':
        if (node.argument?.type === 'ObjectExpression') {
          for (const p of node.argument.properties) {
            const k = p.key?.name ?? p.key?.value;
            if (k === 'style')
              add('jsx-style-prop', node, 'style in spread attributes');
            if (k === 'className' || k === 'class')
              add('raw-classname', node, 'className in spread attributes');
          }
        }
        break;
      case 'JSXOpeningElement': {
        const tag = node.name?.type === 'JSXIdentifier' ? node.name.name : null;
        if (tag === 'style' || tag === 'link')
          add('runtime-style-injection', node, `<${tag}> element`);
        presentational(
          node,
          tag,
          (node.attributes ?? [])
            .filter((a) => a.type === 'JSXAttribute')
            .map((a) => a.name?.name)
            .filter((n) => typeof n === 'string'),
        );
        break;
      }
      case 'ObjectProperty': {
        // Raw markup through props objects (createElement, spreads, jsx()).
        const k = node.computed
          ? constantKey(node.key)
          : (node.key?.name ?? node.key?.value);
        if (k === 'dangerouslySetInnerHTML')
          add('runtime-style-injection', node, 'dangerouslySetInnerHTML');
        break;
      }
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (node.source != null) checkModule(node, node.source.value);
        break;
      case 'ImportExpression':
        checkModule(node, constantKey(node.source));
        break;
      case 'CallExpression':
      case 'OptionalCallExpression':
      case 'NewExpression': {
        const callee = node.callee;
        const name = propertyName(callee) ?? callee?.name;
        const arg = node.arguments?.[0];
        const argKey = constantKey(arg);
        if (callee?.type === 'Import') checkModule(node, argKey);
        if (name === 'require') checkModule(node, argKey);
        if (name === 'createElement' || name === 'createElementNS') {
          const tag = node.arguments?.[name === 'createElementNS' ? 1 : 0];
          const tagKey = constantKey(tag);
          if (
            tagKey == null &&
            tag?.type !== 'Identifier' &&
            tag?.type !== 'MemberExpression'
          )
            add(
              'runtime-style-injection',
              node,
              `${name} with non-constant tag`,
            );
          if (tagKey === 'style' || tagKey === 'link')
            add('runtime-style-injection', node, `${name}('${tagKey}')`);
          const props = node.arguments?.[name === 'createElementNS' ? 2 : 1];
          if (name === 'createElement' && tagKey != null)
            presentational(
              node,
              tagKey,
              props?.type === 'ObjectExpression'
                ? props.properties
                    .map((p) => p.key?.name ?? p.key?.value)
                    .filter((n) => typeof n === 'string')
                : [],
            );
        }
        if (
          ['setAttribute', 'setAttributeNS', 'toggleAttribute'].includes(name)
        ) {
          const attr = constantKey(
            node.arguments?.[name === 'setAttributeNS' ? 1 : 0],
          );
          if (attr == null)
            add(
              'runtime-style-injection',
              node,
              `${name} with non-constant attribute`,
            );
          else if (attr === 'style')
            add('runtime-style-injection', node, `${name}('style')`);
          else if (attr === 'class')
            add('raw-classname', node, `${name}('class')`);
        }
        if (['write', 'writeln'].includes(name) && propertyName(callee) != null)
          add('runtime-style-injection', node, `document.${name}`);
        const objectName = callee?.object?.name;
        if (
          (objectName === 'Object' && MUTATORS.has(name)) ||
          objectName === 'Reflect'
        ) {
          if (objectName === 'Reflect' || !bindings.isPlainTarget(arg, node))
            add(
              'runtime-style-injection',
              node,
              `${objectName}.${name} on a non-literal target`,
            );
        }
        if (
          (callee?.name === 'eval' || callee?.name === 'Function') &&
          node.type !== 'NewExpression'
        )
          add('dynamic-code', node, callee.name);
        if (node.type === 'NewExpression' && callee?.name === 'Function')
          add('dynamic-code', node, 'new Function');
        if (
          (callee?.name === 'setTimeout' || callee?.name === 'setInterval') &&
          arg != null &&
          arg.type !== 'ArrowFunctionExpression' &&
          arg.type !== 'FunctionExpression' &&
          arg.type !== 'Identifier'
        ) {
          add(
            'dynamic-code',
            node,
            `${callee.name} with a non-function argument`,
          );
        }
        if (node.type === 'NewExpression' && STYLE_GLOBALS.has(callee?.name))
          add('runtime-style-injection', node, `new ${callee.name}`);
        break;
      }
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const name = propertyName(node);
        if (name != null && STYLE_MEMBERS.has(name))
          add('runtime-style-injection', node, `.${name}`);
        if (name === 'classList') add('raw-classname', node, '.classList');
        if (
          node.computed &&
          name == null &&
          constantKey(node.property) == null
        ) {
          // A computed key on an object reached from a DOM global or a style
          // object cannot be checked against the style members above.
          let root = node.object;
          while (
            root?.type === 'MemberExpression' ||
            root?.type === 'OptionalMemberExpression'
          )
            root = root.object;
          if (root?.type === 'Identifier' && DOM_GLOBALS.has(root.name))
            add('dom-global-access', node, `${root.name}[computed]`);
        }
        if (
          node.object?.type === 'Identifier' &&
          node.object.name === 'process' &&
          propertyName(node) !== 'env'
        ) {
          add(
            'privileged-import',
            node,
            `process.${propertyName(node) ?? '[computed]'}`,
          );
        }
        break;
      }
      case 'AssignmentExpression': {
        const target = node.left;
        writeTarget(target, node, 'write');
        if (propertyName(target) === 'className')
          add('raw-classname', node, 'className assignment');
        break;
      }
      case 'ObjectPattern':
        for (const p of node.properties) {
          const k = p.key?.name ?? p.key?.value;
          if (k != null && STYLE_MEMBERS.has(k))
            add('runtime-style-injection', node, `destructured ${k}`);
        }
        break;
      case 'Identifier':
        if (isReference(node, parent, key)) {
          if (node.name === 'Function' || node.name === 'eval')
            add('dynamic-code', node, `${node.name} reference`);
          if (DOM_GLOBALS.has(node.name))
            add('dom-global-access', node, node.name);
          if (STYLE_GLOBALS.has(node.name))
            add('runtime-style-injection', node, node.name);
        }
        break;
      case 'TSAsExpression':
      case 'TSTypeAssertion':
        if (node.typeAnnotation?.type === 'TSAnyKeyword')
          add('type-escape', node, 'as any');
        break;
      case 'TypeCastExpression':
        if (node.typeAnnotation?.typeAnnotation?.type === 'AnyTypeAnnotation')
          add('type-escape', node, 'any cast');
        break;
      case 'TaggedTemplateExpression': {
        const tag = node.tag;
        const name = tag?.name ?? propertyName(tag) ?? tag?.callee?.name;
        if (
          [
            'css',
            'styled',
            'injectGlobal',
            'createGlobalStyle',
            'keyframes',
          ].includes(name)
        )
          add('css-in-js-import', node, `tagged template ${name}`);
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
