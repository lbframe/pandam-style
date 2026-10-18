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

import fs from 'node:fs';
import path from 'node:path';
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
  for (const key of ['status', 'payload', 'error', 'calls']) {
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

const REGISTRY_SOURCE = `
const byTestId = new Map();
export function record(type, props) {
  if (typeof type === 'string' && props != null && typeof props['data-testid'] === 'string') byTestId.set(props['data-testid'], props);
}
export function propsFor(testId) { return byTestId.get(testId) ?? null; }
`;
const JSX_SHIM_SOURCE = `
import * as real from ${JSON.stringify(jsxRuntimeUrl ?? '')};
import { record } from 'pms-sandbox:registry';
export const Fragment = real.Fragment;
export function jsx(type, props, key) { record(type, props); return real.jsx(type, props, key); }
export function jsxs(type, props, key) { record(type, props); return real.jsxs(type, props, key); }
export function jsxDEV(type, props, key) { record(type, props); return real.jsx(type, props, key); }
`;
const REACT_SHIM_SOURCE = `
import real from ${JSON.stringify(reactUrl ?? '')};
import { record } from 'pms-sandbox:registry';
const wrapped = { ...real, createElement(type, props, ...children) { record(type, props); return real.createElement(type, props, ...children); } };
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

// Remove ambient authority before any agent code is evaluated.
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
  const { propsFor } = await import('pms-sandbox:registry');
  const spies = {};
  let dispatching = false;
  const spyFor = (name) => {
    spies[name] ??= { inDispatch: 0, outside: 0 };
    return function spy() {
      if (dispatching) spies[name].inDispatch += 1;
      else spies[name].outside += 1;
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
  const r = request.render;
  const url = pathToFileURL(path.resolve(workspaceDir, r.module)).href;
  if (!overrides.has(url))
    throw new Error(`PMS_ORACLE_UNCOVERED_MODULE: ${r.module}`);
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
  const html = renderToStaticMarkup(element);
  const outcomes = [];
  for (const interaction of request.interactions ?? []) {
    const props = propsFor(interaction.testId);
    const handlerName = `on${interaction.event[0].toUpperCase()}${interaction.event.slice(1)}`;
    const handler = props?.[handlerName];
    if (typeof handler !== 'function') {
      outcomes.push(`${interaction.testId}:${interaction.event}:no-handler`);
      continue;
    }
    const event = {
      type: interaction.event,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation: NOOP,
      persist: NOOP,
      currentTarget: { value: '' },
      target: { value: '' },
    };
    dispatching = true;
    try {
      handler(event);
      outcomes.push(`${interaction.testId}:${interaction.event}:dispatched`);
    } catch {
      outcomes.push(`${interaction.testId}:${interaction.event}:threw`);
    } finally {
      dispatching = false;
    }
  }
  let calls = '';
  for (const name of Object.keys(spies)) {
    calls += `${calls ? ';' : ''}${name}:${'' + spies[name].inDispatch}:${'' + spies[name].outside}`;
  }
  return { payload: html, calls: `${calls}|${outcomes.join(';')}` };
}

async function main() {
  try {
    if (request.mode === 'definition')
      emit({ status: 'ok', payload: await runDefinition() });
    else if (request.mode === 'render')
      emit({ status: 'ok', ...(await runRender()) });
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
