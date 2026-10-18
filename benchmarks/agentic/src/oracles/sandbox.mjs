/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Untrusted-code executor. It is the only process that runs code written by
// the evaluated agent (application modules and design-system definitions).
//
// Isolation layers, outermost first:
//   1. The parent starts it under the Node permission model: reads are limited
//      to the scratch workspace copy and the trusted dependency tree; no file
//      writes, child processes, worker threads, native addons or WASI.
//   2. Module hooks deny Node built-ins, `pms-sandbox:` modules, absolute and
//      out-of-workspace specifiers to agent modules.
//   3. `process` and `console` are replaced before agent code loads, so there
//      is no argv, environment, stdout, `getBuiltinModule` or IPC handle.
//   4. The result leaves on stdout as one line tagged with a per-run nonce read
//      from stdin before agent code runs; the parent ignores everything else.
//
// The output is data the agent's code produced (markup, a definition, callback
// counts). The parent treats it as untrusted input and validates it.
//
// Render mode also records a dynamic trace. Code generation from strings is
// disabled by the parent (`--disallow-code-generation-from-strings`); an
// instrumented fake DOM (`document`, `window`, CSSOM constructors) records any
// style-channel access, DOM write or insertion; and after rendering, every
// rendered element's ref, every effect and every event handler is exercised
// against instrumented elements so that code paths SSR does not run are
// observed too. Intrinsics the harness relies on are frozen before agent code
// loads, so agent code cannot rewire the harness's own logic.

import fs from 'node:fs';
import path from 'node:path';
import { parseHtml, elements } from '../html.mjs';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const writeSync = fs.writeSync;
const readFileSync = fs.readFileSync;
const statSync = fs.statSync;
const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const HEX = [];
for (let i = 0; i < 256; i += 1) HEX[i] = (i < 16 ? '0' : '') + i.toString(16);

const request = JSON.parse(readFileSync(0, 'utf8'));
const nonce = request.nonce;
request.nonce = undefined;
const workspaceDir = request.workspaceDir;
const workspaceUrl = pathToFileURL(workspaceDir + path.sep).href;
const overrides = new Map(Object.entries(request.overrides ?? {}));

// UTF-16 code units as 4 hex digits each; built only from captured primitives.
function encode(text) {
  let out = '';
  const s = '' + text;
  for (let i = 0; i < s.length; i += 1) {
    const c = charCodeAt(s, i);
    out += HEX[c >> 8] + HEX[c & 255];
  }
  return out;
}

function emit(fields) {
  let line = 'PMS-SANDBOX ' + nonce;
  for (const key of ['status', 'payload', 'error']) {
    line += ' ' + key + '=' + encode(fields[key] ?? '');
  }
  writeSync(1, line + '\n');
}

const ASSET = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|woff2?)$/;
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function insideWorkspace(url) {
  return url.startsWith(workspaceUrl) && !url.includes('/node_modules/');
}

function deny(specifier, parent) {
  throw new Error(`PMS_SANDBOX_DENIED_IMPORT: ${specifier} from ${parent}`);
}

const requireFromWs = createRequire(path.join(workspaceDir, 'package.json'));
let React = null;
let server = null;
let reactUrl = null;
let jsxRuntimeUrl = null;
if (request.mode === 'render') {
  React = requireFromWs('react');
  server = requireFromWs('react-dom/server');
  requireFromWs('react/jsx-runtime');
  reactUrl = pathToFileURL(requireFromWs.resolve('react')).href;
  jsxRuntimeUrl = pathToFileURL(
    requireFromWs.resolve('react/jsx-runtime'),
  ).href;
}
const renderToStaticMarkup = server?.renderToStaticMarkup;
const createElement = React?.createElement;
const reactExportNames =
  React == null
    ? []
    : Object.keys(React).filter(
        (k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default',
      );

// Host elements created through JSX get a `data-pms-node` id, so the markup
// identifies exactly which created elements were rendered. Handlers and refs
// are looked up by that id: unused JSX never counts.
const REGISTRY_SOURCE = `
let next = 1;
const nodes = new Map();
const effects = [];
export function mark(type, props) {
  if (typeof type !== 'string' || props == null || typeof props !== 'object') return props;
  const id = String(next++);
  nodes.set(id, props);
  return { ...props, 'data-pms-node': id };
}
export function nodeProps(id) { return nodes.get(id) ?? null; }
export function recordEffect(kind, fn) { effects.push({ kind, fn }); }
export function takeEffects() { return effects.slice(); }
`;
const JSX_SHIM_SOURCE = `
import real from ${JSON.stringify(jsxRuntimeUrl ?? '')};
import { mark } from 'pms-sandbox:registry';
export const Fragment = real.Fragment;
export function jsx(type, props, key) { return real.jsx(type, mark(type, props), key); }
export function jsxs(type, props, key) { return real.jsxs(type, mark(type, props), key); }
export function jsxDEV(type, props, key) { return real.jsx(type, mark(type, props), key); }
`;
const REACT_SHIM_SOURCE = `
import real from ${JSON.stringify(reactUrl ?? '')};
import { mark, recordEffect } from 'pms-sandbox:registry';
const effect = (kind, hook) => (fn, deps) => { recordEffect(kind, fn); return hook(fn, deps); };
const wrapped = {
  ...real,
  createElement(type, props, ...children) { return real.createElement(type, mark(type, props ?? {}), ...children); },
  useEffect: effect('effect', real.useEffect),
  useLayoutEffect: effect('layout', real.useLayoutEffect),
  useInsertionEffect: effect('insertion', real.useInsertionEffect),
};
export default wrapped;
${reactExportNames.map((n) => `export const ${n} = wrapped[${JSON.stringify(n)}];`).join('\n')}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const fromAgent = insideWorkspace(parent);
    if (specifier.startsWith('pms-sandbox:')) {
      if (fromAgent) deny(specifier, parent);
      return { url: specifier, shortCircuit: true };
    }
    if (!fromAgent) return nextResolve(specifier, context);
    if (isBuiltin(specifier)) deny(specifier, parent);
    if (
      specifier === 'react/jsx-runtime' ||
      specifier === 'react/jsx-dev-runtime'
    ) {
      return { url: 'pms-sandbox:jsx-runtime', shortCircuit: true };
    }
    if (specifier === 'react')
      return { url: 'pms-sandbox:react', shortCircuit: true };
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const base = new URL(specifier, parent).href;
      const stem = base.replace(/\.(js|jsx|mjs)$/, '');
      const candidates = [
        base,
        ...EXTENSIONS.map((e) => stem + e),
        ...EXTENSIONS.map((e) => `${base}/index${e}`),
      ];
      for (const candidate of candidates) {
        if (!candidate.startsWith(workspaceUrl)) deny(specifier, parent);
        if (overrides.has(candidate) || isFile(candidate))
          return { url: candidate, shortCircuit: true };
      }
      deny(specifier, parent);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('/'))
      deny(specifier, parent);
    // Bare package names resolve through the trusted dependency tree; the
    // permission model bounds what any resolution can read.
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith('file:')) deny(specifier, parent);
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url === 'pms-sandbox:registry')
      return { format: 'module', source: REGISTRY_SOURCE, shortCircuit: true };
    if (url === 'pms-sandbox:jsx-runtime')
      return { format: 'module', source: JSX_SHIM_SOURCE, shortCircuit: true };
    if (url === 'pms-sandbox:react')
      return {
        format: 'module',
        source: REACT_SHIM_SOURCE,
        shortCircuit: true,
      };
    if (overrides.has(url))
      return {
        format: 'module',
        source: overrides.get(url),
        shortCircuit: true,
      };
    if (insideWorkspace(url)) {
      if (ASSET.test(url))
        return {
          format: 'module',
          source: 'export default "";',
          shortCircuit: true,
        };
      if (request.mode === 'render' && /\.(jsx|tsx|ts)$/.test(url)) {
        throw new Error(
          `PMS_ORACLE_UNCOVERED_MODULE: ${url} has no compiler artifact`,
        );
      }
      if (/\.(js|mjs)$/.test(url)) {
        return {
          format: 'module',
          source: readFileSync(fileURLToPath(url), 'utf8'),
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

// --- Dynamic trace ---------------------------------------------------------

const violations = [];
// Callbacks agent code hands to the DOM or to timers. They never run during
// SSR; the exercise phase runs them so their effects are observed.
const deferred = [];
const defer = (fn) => {
  if (deferred.length < 500) deferred[deferred.length] = fn;
};
const violation = (text) => {
  if (violations.length < 100) violations[violations.length] = text;
};
// Reading these yields a style or markup channel; touching them is a violation.
const STYLE_PROPS = new Set([
  'style',
  'cssText',
  'styleSheets',
  'adoptedStyleSheets',
  'sheet',
  'cssRules',
  'attributeStyleMap',
  'innerHTML',
  'outerHTML',
  'className',
  'classList',
  'attributes',
]);
// Calls that mutate the document, attributes or style sheets.
const MUTATING_CALLS = new Set([
  'setAttribute',
  'setAttributeNS',
  'setAttributeNode',
  'toggleAttribute',
  'removeAttribute',
  'insertRule',
  'deleteRule',
  'addRule',
  'replace',
  'replaceSync',
  'setProperty',
  'removeProperty',
  'appendChild',
  'append',
  'prepend',
  'insertBefore',
  'replaceChild',
  'replaceWith',
  'after',
  'before',
  'insertAdjacentElement',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'replaceChildren',
  'write',
  'writeln',
  'animate',
  'attachShadow',
  'importNode',
  'adoptNode',
  'execCommand',
  'add',
  'toggle',
]);
const EMPTY_ITERATOR = function* emptyIterator() {};

// A recording stand-in for any DOM object. Reads return further stand-ins,
// so agent code can navigate freely; what it does is recorded, not executed.
function fakeNode(label) {
  const target = function fake() {};
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === Symbol.iterator) return EMPTY_ITERATOR;
        return undefined;
      }
      if (prop === 'then') return undefined;
      if (prop === 'toString' || prop === 'valueOf') return () => '';
      if (STYLE_PROPS.has(prop)) violation(`read ${label}.${prop}`);
      return fakeNode(`${label}.${prop}`);
    },
    set(t, prop) {
      violation(`write ${label}.${String(prop)}`);
      return true;
    },
    defineProperty(t, prop) {
      violation(`define ${label}.${String(prop)}`);
      return true;
    },
    deleteProperty(t, prop) {
      violation(`delete ${label}.${String(prop)}`);
      return true;
    },
    apply(t, thisArg, args) {
      const name = label.slice(label.lastIndexOf('.') + 1);
      if (MUTATING_CALLS.has(name)) violation(`call ${label}()`);
      if (
        (name === 'createElement' || name === 'createElementNS') &&
        (typeof args[args.length - 1] !== 'string' ||
          /^(style|link)$/i.test(args[args.length - 1]))
      ) {
        violation(
          `call ${label}(${typeof args[args.length - 1] === 'string' ? args[args.length - 1] : 'non-literal'})`,
        );
      }
      for (const arg of args) if (typeof arg === 'function') defer(arg);
      return fakeNode(`${label}()`);
    },
    construct() {
      violation(`new ${label}`);
      return fakeNode(`new ${label}`);
    },
  });
}

const DOM_GLOBALS = [
  'document',
  'window',
  'self',
  'top',
  'frames',
  'parent',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'CSSStyleSheet',
  'CSS',
  'StyleSheet',
  'CSSStyleDeclaration',
  'HTMLElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
];
if (request.mode === 'render') {
  for (const name of DOM_GLOBALS) {
    Object.defineProperty(globalThis, name, {
      value: fakeNode(name),
      writable: false,
      configurable: false,
    });
  }
}

// --- Remove ambient authority and freeze what the harness relies on ----------

const NOOP = () => undefined;
Object.defineProperty(globalThis, 'process', {
  value: Object.freeze({ env: Object.freeze({ NODE_ENV: 'production' }) }),
  writable: false,
  configurable: false,
});
Object.defineProperty(globalThis, 'console', {
  value: Object.freeze({
    log: NOOP,
    info: NOOP,
    warn: NOOP,
    error: NOOP,
    debug: NOOP,
    trace: NOOP,
  }),
  writable: false,
  configurable: false,
});
const EvalErrorRef = EvalError;
const setTimeoutRef = setTimeout;
if (request.mode === 'render') {
  for (const name of [
    'setTimeout',
    'setInterval',
    'setImmediate',
    'requestIdleCallback',
  ]) {
    Object.defineProperty(globalThis, name, {
      value: (fn) => {
        if (typeof fn === 'function') defer(fn);
        return 0;
      },
      writable: false,
      configurable: false,
    });
  }
}
const iteratorPrototypes = [
  Object.getPrototypeOf([][Symbol.iterator]()),
  Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())),
  Object.getPrototypeOf(new Map()[Symbol.iterator]()),
  Object.getPrototypeOf(new Set()[Symbol.iterator]()),
  Object.getPrototypeOf(''[Symbol.iterator]()),
  Object.getPrototypeOf(/x/[Symbol.matchAll]('x')),
];
for (const intrinsic of [
  Object,
  Object.prototype,
  Array,
  Array.prototype,
  Function.prototype,
  String,
  String.prototype,
  Number.prototype,
  Boolean.prototype,
  Symbol,
  Symbol.prototype,
  RegExp,
  RegExp.prototype,
  Map,
  Map.prototype,
  Set,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Promise,
  Promise.prototype,
  JSON,
  Reflect,
  Math,
  Proxy,
  ...iteratorPrototypes,
]) {
  Object.freeze(intrinsic);
}
for (const name of [
  'Object',
  'Array',
  'Function',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'JSON',
  'Reflect',
  'Math',
  'Proxy',
  'Error',
  'EvalError',
  'TypeError',
  'URL',
]) {
  Object.defineProperty(globalThis, name, {
    value: globalThis[name],
    writable: false,
    configurable: false,
  });
}

const TOKEN_REF = Symbol.for('pandamstyle.tokenRef');

// Definitions must be plain data. Anything else fails closed.
function toData(value, at, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return value;
  }
  if (typeof value !== 'object')
    throw new Error(`non-data value (${typeof value}) at ${at}`);
  if (seen.has(value)) throw new Error(`cycle at ${at}`);
  seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).includes(TOKEN_REF)) {
      const p = value[TOKEN_REF];
      if (typeof p !== 'string')
        throw new Error(`invalid token reference at ${at}`);
      return { $pmsTokenRef: p };
    }
    if (Array.isArray(value))
      return value.map((v, i) => toData(v, `${at}[${i}]`, seen));
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new Error(`non-plain object at ${at}`);
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '$pmsTokenRef') throw new Error(`reserved key at ${at}`);
      out[key] = toData(value[key], `${at}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// Serializes plain data without consulting prototypes or toJSON.
function serialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean')
    return '' + value;
  if (typeof value === 'string') {
    let out = '"';
    for (let i = 0; i < value.length; i += 1) {
      const c = charCodeAt(value, i);
      out +=
        c === 34 || c === 92 || c < 32 || c > 126
          ? '\\u' + HEX[c >> 8] + HEX[c & 255]
          : value[i];
    }
    return out + '"';
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i += 1)
      out += (i ? ',' : '') + serialize(value[i]);
    return out + ']';
  }
  let out = '{';
  let first = true;
  for (const key of Object.keys(value)) {
    out += (first ? '' : ',') + serialize(key) + ':' + serialize(value[key]);
    first = false;
  }
  return out + '}';
}

async function runDefinition() {
  const ns = await import(
    pathToFileURL(path.join(workspaceDir, request.definition)).href
  );
  const definition = Object.hasOwn(ns, 'default') ? ns.default : ns;
  return serialize(toData(definition, 'definition', new Set()));
}

async function runRender() {
  const { nodeProps, takeEffects } = await import('pms-sandbox:registry');
  const outside = {};
  let mode = 'render';
  let attribution = null;
  const spyFor = (name) => {
    outside[name] ??= 0;
    return function spy() {
      if (mode === 'dispatch') attribution[name] = (attribution[name] ?? 0) + 1;
      else if (mode === 'render') outside[name] += 1;
    };
  };
  const withSpies = (value) => {
    if (Array.isArray(value)) return value.map(withSpies);
    if (value != null && typeof value === 'object') {
      if (typeof value.$pmsSpy === 'string') return spyFor(value.$pmsSpy);
      const out = {};
      for (const key of Object.keys(value)) out[key] = withSpies(value[key]);
      return out;
    }
    return value;
  };
  const isCodeGeneration = (error) => error instanceof EvalErrorRef;
  const r = request.render;
  const url = pathToFileURL(path.resolve(workspaceDir, r.module)).href;
  if (!overrides.has(url))
    throw new Error(`PMS_ORACLE_UNCOVERED_MODULE: ${r.module}`);
  let html;
  try {
    const mod = await import(url);
    const Component = mod[r.export ?? 'default'];
    if (typeof Component !== 'function')
      throw new Error(
        `PMS_ORACLE_MISSING_EXPORT: ${r.module}#${r.export ?? 'default'}`,
      );
    let element = createElement(Component, withSpies(r.props ?? {}));
    if (r.theme != null) {
      const className = request.themeClasses?.[r.theme];
      if (className == null)
        throw new Error(`PMS_ORACLE_UNKNOWN_THEME: ${r.theme}`);
      element = createElement(
        'div',
        { className, 'data-pms-oracle-theme': r.theme },
        element,
      );
    }
    html = renderToStaticMarkup(element);
  } catch (error) {
    if (isCodeGeneration(error))
      violation('code generation from strings during render');
    throw error;
  }
  const tree = parseHtml(html);
  const rendered = elements(tree).filter(
    (el) => typeof el.attributes['data-pms-node'] === 'string',
  );
  const event = (type, node) => ({
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    persist: NOOP,
    target: fakeNode(`element#${node.attributes['data-testid'] ?? node.tag}`),
    currentTarget: fakeNode(
      `element#${node.attributes['data-testid'] ?? node.tag}`,
    ),
    nativeEvent: fakeNode('nativeEvent'),
  });
  // Dispatch on the rendered element and bubble through its rendered
  // ancestors, as the browser would. Eligibility (disabled, inert, hidden,
  // pointer-events) is decided by the parent, which owns the cascade.
  const interactions = [];
  for (const interaction of request.interactions ?? []) {
    const handlerName = `on${interaction.event[0].toUpperCase()}${interaction.event.slice(1)}`;
    const candidates = [];
    for (const node of rendered) {
      if (node.attributes['data-testid'] !== interaction.testId) continue;
      const calls = {};
      let outcome = 'no-handler';
      const e = event(interaction.event, node);
      mode = 'dispatch';
      attribution = calls;
      try {
        for (
          let current = node;
          current != null && current.tag !== '#root';
          current = current.parent
        ) {
          const props = nodeProps(current.attributes?.['data-pms-node']);
          const handler = props?.[handlerName];
          if (typeof handler === 'function') {
            outcome = 'dispatched';
            handler(e);
            if (e.propagationStopped) break;
          }
        }
      } catch (error) {
        outcome = isCodeGeneration(error) ? 'code-generation' : 'threw';
        if (isCodeGeneration(error))
          violation('code generation from strings in a handler');
      } finally {
        mode = 'exercise';
        attribution = null;
      }
      candidates[candidates.length] = {
        node: node.attributes['data-pms-node'],
        outcome,
        calls,
      };
    }
    interactions[interactions.length] = {
      testId: interaction.testId,
      event: interaction.event,
      candidates,
    };
  }
  mode = 'exercise';
  // Exercise code SSR never runs: refs, effects and every handler of every
  // rendered element, against recording stand-ins.
  const run = (label, fn) => {
    try {
      const result = fn();
      if (result != null && typeof result.then === 'function')
        result.then(NOOP, NOOP);
      return result;
    } catch (error) {
      if (isCodeGeneration(error))
        violation(`code generation from strings in ${label}`);
      return undefined;
    }
  };
  for (const node of rendered) {
    const props = nodeProps(node.attributes['data-pms-node']);
    const ref = props?.ref;
    const fake = fakeNode(
      `element#${node.attributes['data-testid'] ?? node.tag}`,
    );
    if (typeof ref === 'function') {
      const cleanup = run('a ref callback', () => ref(fake));
      if (typeof cleanup === 'function') run('a ref cleanup', cleanup);
      else run('a ref callback', () => ref(null));
    } else if (ref != null && typeof ref === 'object') {
      run('a ref object', () => {
        ref.current = fake;
      });
    }
  }
  for (const { kind, fn } of takeEffects()) {
    const cleanup = run(`a ${kind} effect`, fn);
    if (typeof cleanup === 'function') run(`a ${kind} effect cleanup`, cleanup);
  }
  for (const node of rendered) {
    const props = nodeProps(node.attributes['data-pms-node']);
    for (const key of Object.keys(props ?? {})) {
      if (/^on[A-Z]/.test(key) && typeof props[key] === 'function')
        run(`handler ${key}`, () =>
          props[key](event(key.slice(2).toLowerCase(), node)),
        );
    }
  }
  // Run callbacks deferred to timers or DOM APIs (they may defer more) and
  // let asynchronous continuations settle, in bounded rounds.
  let next = 0;
  for (let round = 0; round < 5; round += 1) {
    for (; next < deferred.length; next += 1) {
      const fn = deferred[next];
      run('a deferred callback', () => fn(fakeNode('event')));
    }
    await new Promise((resolve) => setTimeoutRef(resolve, 0));
  }
  return { payload: serialize({ html, interactions, outside, violations }) };
}

// Evaluates the harness's vocabulary probe (compiled by the trusted compiler)
// here rather than in the trusted worker: it executes generated code.
async function runProbe() {
  const mod = await import(request.probeUrl);
  return serialize(
    toData(
      { themeClasses: mod.themeClasses, tokenClasses: mod.tokenClasses },
      'probe',
      new Set(),
    ),
  );
}

async function main() {
  try {
    if (request.mode === 'definition')
      emit({ status: 'ok', payload: await runDefinition() });
    else if (request.mode === 'render')
      emit({ status: 'ok', payload: (await runRender()).payload });
    else if (request.mode === 'probe')
      emit({ status: 'ok', payload: await runProbe() });
    else emit({ status: 'error', error: `unknown mode ${request.mode}` });
  } catch (error) {
    let message = 'unknown error';
    try {
      message = '' + (error?.message ?? error);
    } catch {
      // An agent-controlled error object may refuse conversion.
    }
    emit({ status: 'error', error: message.slice(0, 2000) });
  }
}

main();
