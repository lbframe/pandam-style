/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Untrusted-code executor. It is the only process that runs code written by
// the evaluated agent (application modules and design-system definitions).
//
// Isolation, outermost first:
//   1. The parent starts it under the Node permission model (reads limited to
//      the scratch workspace copy, the trusted dependency tree and the
//      harness's own DOM implementation; no writes, child processes, worker
//      threads, addons or WASI) and with code generation from strings
//      disabled.
//   2. Module hooks deny Node built-ins, harness modules, absolute and
//      out-of-workspace specifiers to agent modules.
//   3. `process` and `console` are replaced, timers are bounded, and the
//      intrinsics and module objects the harness relies on are frozen before
//      agent code loads.
//   4. The result leaves on stdout as one line tagged with a per-run nonce read
//      from stdin before agent code runs; the parent ignores everything else.
//
// Render mode renders with the real `react-dom/client` into a real standards
// DOM (jsdom), so refs, effects, cloneElement, props and events have their
// real semantics. The DOM is instrumented before agent code runs:
//   - every write to a style channel (CSSStyleDeclaration, CSSOM, adopted
//     style sheets, `style` attributes, creating <style>/<link>) is a
//     violation, whoever the caller is;
//   - every other DOM mutation is a violation unless its immediate caller is
//     React itself (React commits are the only legitimate DOM writers);
//   - a MutationObserver catches mutations that bypass the wrapped APIs.
// Requested interactions are dispatched natively (`click()`, real events) on
// the committed DOM; a sweep of common events over every rendered element then
// surfaces handler code the task does not exercise.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const writeSync = fs.writeSync;
const readFileSync = fs.readFileSync;
const statSync = fs.statSync;
const realpathSync = fs.realpathSync;
const ErrorRef = Error;
const apply = Reflect.apply;
const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const HEX = [];
for (let i = 0; i < 256; i += 1) HEX[i] = (i < 16 ? '0' : '') + i.toString(16);
const SANDBOX_FILE = fileURLToPath(import.meta.url);

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
const SCENARIO = /[?&]pms-scenario=(\d+)$/;

function stripQuery(url) {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

// Agent code is everything in the workspace copy except its top-level
// node_modules link to the trusted dependency tree.
function insideWorkspace(url) {
  return (
    url.startsWith(workspaceUrl) &&
    !url.slice(workspaceUrl.length).startsWith('node_modules/')
  );
}

// Packages agent code may import: the workspace's declared dependencies (the
// trusted tree is installed from them), React and PandamStyle. Harness-only
// packages (the DOM implementation and its dependencies) are not reachable.
const allowedPackages = new Set(['react', 'react-dom', 'scheduler']);
try {
  const manifest = JSON.parse(
    readFileSync(path.join(workspaceDir, 'package.json'), 'utf8'),
  );
  for (const section of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    for (const name of Object.keys(manifest[section] ?? {}))
      allowedPackages.add(name);
  }
} catch {
  // No manifest: only React and PandamStyle.
}
const packageName = (specifier) =>
  specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];

const moduleTypes = new Map();
function isCommonJs(url) {
  const file = fileURLToPath(url);
  if (file.endsWith('.cjs')) return true;
  if (!file.endsWith('.js')) return false;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (!moduleTypes.has(dir)) {
      let type = null;
      try {
        type =
          JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
            .type ?? 'commonjs';
      } catch {
        type = null;
      }
      moduleTypes.set(dir, type);
    }
    const type = moduleTypes.get(dir);
    if (type != null) return type !== 'module';
    if (path.dirname(dir) === dir) return true;
  }
}

function deny(specifier, parent) {
  throw new Error(`PMS_SANDBOX_DENIED_IMPORT: ${specifier} from ${parent}`);
}

// --- Render-mode dependencies (loaded before any agent code) ---------------

// The DOM implementation comes from the harness's own dependency tree
// (`benchmarks/agentic/dom`), installed apart from the repository workspaces.
const DOM_TREE = path.join(path.dirname(SANDBOX_FILE), '../../dom');
const harnessRequire = createRequire(path.join(DOM_TREE, 'package.json'));
const requireFromWs = createRequire(path.join(workspaceDir, 'package.json'));
const packageDir = (req, name) =>
  path.dirname(realpathSync(req.resolve(`${name}/package.json`)));

const scenarios = request.mode === 'render' ? (request.scenarios ?? []) : [];
let JSDOM = null;
let VirtualConsole = null;
let React = null;
let createRoot = null;
let flushSync = null;
let renderToStaticMarkup = null;
// An uninstrumented document agent code never sees, for parsing React's own
// attribute serialization.
let parserDocument = null;
let reactDirs = [];
let jsdomDir = null;
let currentWindow = null;
let sink = null;
// > 0 only while the harness itself calls into the DOM (dispatching events).
let harnessDepth = 0;

if (request.mode === 'render') {
  try {
    ({ JSDOM, VirtualConsole } = harnessRequire('jsdom'));
  } catch (error) {
    throw new Error(
      `PMS_SANDBOX_DOM_MISSING: the harness DOM tree is not installed (yarn bench:agentic:install): ${error.message}`,
    );
  }
  // Frames anywhere in that tree are the DOM implementation itself.
  jsdomDir = realpathSync(path.join(DOM_TREE, 'node_modules'));
}

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const realProcess = process;

// --- DOM instrumentation ------------------------------------------------------

const MUTATING_METHODS = new Set([
  'appendChild',
  'insertBefore',
  'removeChild',
  'replaceChild',
  'append',
  'prepend',
  'before',
  'after',
  'replaceWith',
  'remove',
  'replaceChildren',
  'insertAdjacentElement',
  'insertAdjacentHTML',
  'insertAdjacentText',
  'setAttribute',
  'setAttributeNS',
  'removeAttribute',
  'removeAttributeNS',
  'toggleAttribute',
  'setAttributeNode',
  'setAttributeNodeNS',
  'removeAttributeNode',
  'setNamedItem',
  'setNamedItemNS',
  'removeNamedItem',
  'removeNamedItemNS',
  'add',
  'toggle',
  'replace',
  'normalize',
  'splitText',
  'appendData',
  'insertData',
  'deleteData',
  'replaceData',
  'setProperty',
  'removeProperty',
  'insertRule',
  'deleteRule',
  'addRule',
  'removeRule',
  'replaceSync',
  'appendMedium',
  'deleteMedium',
  'attachShadow',
  'write',
  'writeln',
  'open',
  'execCommand',
  'importNode',
  'adoptNode',
  'setHTMLUnsafe',
  'showPopover',
  'hidePopover',
  'togglePopover',
  'showModal',
  'show',
  'close',
  'deleteContents',
  'extractContents',
  'insertNode',
  'surroundContents',
  'deleteFromDocument',
  'insertRow',
  'deleteRow',
  'insertCell',
  'deleteCell',
  'createCaption',
  'deleteCaption',
  'createTHead',
  'deleteTHead',
  'createTFoot',
  'deleteTFoot',
  'createTBody',
  'reset',
  'define',
]);
// Every CSSOM interface (whatever jsdom version exposes) and the style
// sheet elements.
const isStyleInterface = (name) =>
  /^CSS/.test(name) ||
  /^(StyleSheet|StyleSheetList|MediaList|HTMLStyleElement|HTMLLinkElement)$/.test(
    name,
  );
const STYLE_MEMBERS = new Set(['style', 'cssText', 'adoptedStyleSheets']);
const DOM_INTERFACES = new Set([
  'DOMTokenList',
  'NamedNodeMap',
  'Attr',
  'Range',
  'Selection',
  'DOMStringMap',
  'ElementInternals',
  'CustomElementRegistry',
]);

function violation(text) {
  if (sink != null && sink.violations.length < 100)
    sink.violations[sink.violations.length] = text;
}

// Classifies the immediate caller of a DOM API: React (the only legitimate DOM
// writer), or anything else. Stack depth and formatting are locked below.
function callerOf() {
  const lines = ('' + new ErrorRef('pms-caller').stack).split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /\(([^()]*)\)\s*$/.exec(line) ?? /\bat (.*)$/.exec(line);
    if (m == null) continue;
    let loc = m[1].replace(/:\d+:\d+$/, '');
    if (loc.startsWith('file://')) {
      try {
        loc = fileURLToPath(stripQuery(loc));
      } catch {
        // Leave unparsable locations as they are.
      }
    }
    if (
      loc === SANDBOX_FILE ||
      loc.startsWith('node:') ||
      loc === '<anonymous>' ||
      loc === 'native'
    )
      continue;
    if (jsdomDir != null && loc.startsWith(jsdomDir + path.sep)) continue;
    if (reactDirs.some((d) => loc.startsWith(d + path.sep))) return 'react';
    return `code at ${loc.startsWith(workspaceDir) ? path.relative(workspaceDir, loc) : loc}`;
  }
  // No application or React frame: the harness itself, or code reaching the
  // DOM through a native trampoline (bound methods queued as callbacks).
  return harnessDepth > 0 ? 'harness' : 'unknown code';
}

function guarded(iface, member, args, call) {
  if (sink == null) return call();
  const observer = sink.observer;
  if (observer != null) sink.unattributed.push(...observer.takeRecords());
  const caller = callerOf();
  const first = args[0];
  const attributeName = typeof first === 'string' ? first.toLowerCase() : null;
  const styleChannel =
    isStyleInterface(iface) ||
    STYLE_MEMBERS.has(member) ||
    (/^(setAttribute|setAttributeNS|toggleAttribute)$/.test(member) &&
      (member === 'setAttributeNS'
        ? typeof args[1] !== 'string' || args[1].toLowerCase() === 'style'
        : attributeName == null || attributeName === 'style'));
  if (styleChannel)
    violation(`style channel ${iface}.${member} written by ${caller}`);
  else if (caller === 'harness')
    // The harness never writes the DOM while observing; this is a native
    // function agent code registered as a callback (a bound DOM method).
    violation(`DOM write ${iface}.${member} by a native callback`);
  else if (caller !== 'react')
    violation(`DOM write ${iface}.${member} by ${caller}`);
  try {
    return call();
  } finally {
    if (observer != null) observer.takeRecords();
  }
}

function instrument(win) {
  for (const name of Object.getOwnPropertyNames(win)) {
    if (!/^[A-Z]/.test(name)) continue;
    let ctor;
    try {
      ctor = win[name];
    } catch {
      continue;
    }
    if (typeof ctor !== 'function' || ctor.prototype == null) continue;
    const proto = ctor.prototype;
    // Only DOM and CSSOM interfaces: without script execution the window shares
    // JavaScript intrinsics (String, Array, ...) with this realm.
    const isNode =
      proto === win.Node.prototype || win.Node.prototype.isPrototypeOf(proto);
    if (!isNode && !DOM_INTERFACES.has(name) && !isStyleInterface(name))
      continue;
    for (const key of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d == null || !d.configurable || key === 'constructor') continue;
      if (typeof d.set === 'function') {
        const set = d.set;
        Object.defineProperty(proto, key, {
          get: d.get,
          set(value) {
            return guarded(name, key, [value], () => set.call(this, value));
          },
          enumerable: d.enumerable,
          configurable: false,
        });
      } else if (
        typeof d.value === 'function' &&
        (MUTATING_METHODS.has(key) ||
          (isStyleInterface(name) &&
            /^(insert|delete|add|remove|replace|set|append)/.test(key)))
      ) {
        const fn = d.value;
        Object.defineProperty(proto, key, {
          value(...args) {
            return guarded(name, key, args, () => fn.apply(this, args));
          },
          writable: false,
          enumerable: d.enumerable,
          configurable: false,
        });
      }
    }
  }
  // Inline style objects are proxies over prototypes the window does not
  // expose; every setter and mutating method on that chain is a style channel.
  for (
    let proto = Object.getPrototypeOf(win.document.createElement('div').style);
    proto != null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d == null || !d.configurable || key === 'constructor') continue;
      if (typeof d.set === 'function') {
        const set = d.set;
        Object.defineProperty(proto, key, {
          get: d.get,
          set(value) {
            return guarded('CSSStyleDeclaration', key, [value], () =>
              set.call(this, value),
            );
          },
          enumerable: d.enumerable,
          configurable: false,
        });
      } else if (
        typeof d.value === 'function' &&
        /^(setProperty|removeProperty)$/.test(key)
      ) {
        const fn = d.value;
        Object.defineProperty(proto, key, {
          value(...args) {
            return guarded('CSSStyleDeclaration', key, args, () =>
              fn.apply(this, args),
            );
          },
          writable: false,
          enumerable: d.enumerable,
          configurable: false,
        });
      }
    }
  }
  const createElement = win.Document.prototype.createElement;
  const createElementNS = win.Document.prototype.createElementNS;
  const styleTag = (tag) =>
    typeof tag !== 'string' || /^(style|link)$/i.test(tag);
  Object.defineProperty(win.Document.prototype, 'createElement', {
    value(tag, ...rest) {
      if (sink != null && styleTag(tag))
        violation(
          `style channel Document.createElement(${tag}) by ${callerOf()}`,
        );
      return createElement.call(this, tag, ...rest);
    },
    writable: false,
    configurable: false,
  });
  Object.defineProperty(win.Document.prototype, 'createElementNS', {
    value(ns, tag, ...rest) {
      if (sink != null && styleTag(tag))
        violation(
          `style channel Document.createElementNS(${tag}) by ${callerOf()}`,
        );
      return createElementNS.call(this, ns, tag, ...rest);
    },
    writable: false,
    configurable: false,
  });
  // jsdom does not implement adopted style sheets; an accessor stands in so
  // assigning them is observed instead of landing as an inert expando.
  for (const ctor of [win.Document, win.ShadowRoot]) {
    if (ctor?.prototype == null) continue;
    if (Object.getOwnPropertyDescriptor(ctor.prototype, 'adoptedStyleSheets'))
      continue;
    const sheets = new WeakMap();
    Object.defineProperty(ctor.prototype, 'adoptedStyleSheets', {
      get() {
        return sheets.get(this) ?? [];
      },
      set(value) {
        guarded(ctor.name, 'adoptedStyleSheets', [value], () =>
          sheets.set(this, value),
        );
      },
      configurable: false,
    });
  }
  for (const key of NETWORK) {
    Object.defineProperty(win, key, {
      value: noNetwork,
      writable: false,
      configurable: false,
    });
  }
  // Bounded timers inside the window realm too (window.setTimeout).
  for (const [name, fn] of Object.entries(agentTimers)) win[name] = fn;
}

// Timers seen by agent code fire promptly (bounded), so deferred work happens
// while the harness is still observing.
let pendingTimers = 0;
const later = (fn, ...args) => {
  pendingTimers += 1;
  return realSetTimeout(() => {
    pendingTimers -= 1;
    if (typeof fn === 'function') fn(...args);
  }, 0);
};
const agentTimers = {
  setTimeout: (fn, _ms, ...args) => later(fn, ...args),
  clearTimeout: (id) => realClearTimeout(id),
  setInterval: (fn, _ms, ...args) => {
    let runs = 0;
    const handle = { id: null };
    const tick = () => {
      runs += 1;
      if (typeof fn === 'function') fn(...args);
      if (runs < 3) handle.id = later(tick);
    };
    handle.id = later(tick);
    return handle;
  },
  clearInterval: (handle) => realClearTimeout(handle?.id),
  setImmediate: (fn, ...args) => later(fn, ...args),
  requestIdleCallback: (fn) =>
    later(fn, { didTimeout: false, timeRemaining: () => 0 }),
  requestAnimationFrame: (fn) => later(fn, 0),
  cancelAnimationFrame: (id) => realClearTimeout(id),
};

function newWindow() {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body></body></html>',
    {
      pretendToBeVisual: true,
      virtualConsole,
      url: 'http://localhost/',
    },
  );
  const win = dom.window;
  instrument(win);
  // The harness reaches the DOM only through functions captured here, before
  // agent code exists.
  const getter = (proto, key) =>
    Object.getOwnPropertyDescriptor(proto, key).get;
  harnessDom.set(win, {
    read: domReader(win),
    click: win.HTMLElement.prototype.click,
    dispatchEvent: win.EventTarget.prototype.dispatchEvent,
    innerHTML: getter(win.Element.prototype, 'innerHTML'),
    events: {
      Event: win.Event,
      MouseEvent: win.MouseEvent,
      KeyboardEvent: win.KeyboardEvent,
      FocusEvent: win.FocusEvent,
    },
  });
  // Every DOM and CSSOM interface is then frozen, and so are the window's
  // bindings to them: agent code cannot patch what the harness and React use.
  const prototypes = new Set();
  harnessDom.get(win).prototypes = prototypes;
  for (const name of Object.getOwnPropertyNames(win)) {
    if (!/^[A-Z]/.test(name)) continue;
    const d = Object.getOwnPropertyDescriptor(win, name);
    const ctor = d?.value;
    if (typeof ctor !== 'function' || ctor === globalThis[name]) continue;
    if (ctor.prototype != null) {
      Object.freeze(ctor.prototype);
      prototypes.add(ctor.prototype);
    }
    Object.freeze(ctor);
    if (d.configurable)
      Object.defineProperty(win, name, {
        value: ctor,
        writable: false,
        enumerable: d.enumerable,
        configurable: false,
      });
  }
  for (
    let proto = Object.getPrototypeOf(win.document.createElement('div').style);
    proto != null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  )
    Object.freeze(proto);
  return win;
}
const harnessDom = new Map();

// Window globals agent code and React see, swapped per scenario.
const KEEP_NODE_GLOBALS = new Set([
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
  'console',
  'process',
  'global',
  'globalThis',
  'Buffer',
  'structuredClone',
  'fetch',
  'crypto',
  'performance',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'Blob',
  'atob',
  'btoa',
  'WebAssembly',
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
  'Date',
  'Intl',
  'eval',
  'undefined',
  'NaN',
  'Infinity',
  'requestIdleCallback',
]);

const WINDOW_ALIASES = new Set(['window', 'self', 'top', 'parent', 'frames']);
const windowValue = (key) =>
  WINDOW_ALIASES.has(key) ? currentWindow : currentWindow[key];

// The permission model does not restrict the network: every request API
// (Node's and the DOM implementation's) throws, so observations never depend
// on a remote party.
const NETWORK = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
const noNetwork = () => {
  throw new ErrorRef('PMS_SANDBOX_NO_NETWORK');
};

function installWindowGlobals(win) {
  for (const key of NETWORK) {
    Object.defineProperty(globalThis, key, {
      value: noNetwork,
      writable: false,
      configurable: false,
    });
  }
  for (const key of Object.getOwnPropertyNames(win)) {
    if (KEEP_NODE_GLOBALS.has(key) || NETWORK.includes(key)) continue;
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    if (d != null && !d.configurable) continue;
    Object.defineProperty(globalThis, key, {
      get: windowValue.bind(null, key),
      configurable: false,
    });
  }
}

const windows = [];
if (request.mode === 'render') {
  for (let i = 0; i < Math.max(1, scenarios.length); i += 1)
    windows.push(newWindow());
  currentWindow = windows[0];
  installWindowGlobals(currentWindow);
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  React = requireFromWs('react');
  const reactDomClient = requireFromWs('react-dom/client');
  const reactDom = requireFromWs('react-dom');
  const jsxRuntime = requireFromWs('react/jsx-runtime');
  createRoot = reactDomClient.createRoot;
  flushSync = reactDom.flushSync;
  renderToStaticMarkup = requireFromWs('react-dom/server').renderToStaticMarkup;
  parserDocument = new JSDOM('', { virtualConsole: new VirtualConsole() })
    .window.document;
  const reactDomRequire = createRequire(
    realpathSync(requireFromWs.resolve('react-dom')),
  );
  reactDirs = [
    packageDir(requireFromWs, 'react'),
    packageDir(requireFromWs, 'react-dom'),
    packageDir(reactDomRequire, 'scheduler'),
  ];
  for (const exported of [React, reactDomClient, reactDom, jsxRuntime])
    Object.freeze(exported);
  for (const [name, fn] of Object.entries(agentTimers)) {
    Object.defineProperty(globalThis, name, {
      value: fn,
      writable: false,
      configurable: false,
    });
  }
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const fromAgent = insideWorkspace(parent);
    if (
      specifier.startsWith('pms-sandbox:') ||
      specifier.startsWith('pms-cjs:')
    ) {
      if (fromAgent || !specifier.startsWith('pms-cjs:'))
        deny(specifier, parent);
    }
    if (!fromAgent) return nextResolve(specifier, context);
    if (isBuiltin(specifier)) deny(specifier, parent);
    // Each scenario loads its own instances of workspace modules.
    const scenario = SCENARIO.exec(parent)?.[1] ?? null;
    const tag = (url) =>
      scenario != null && insideWorkspace(url)
        ? `${url}?pms-scenario=${scenario}`
        : url;
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const base = new URL(specifier, stripQuery(parent)).href;
      const stem = base.replace(/\.(js|jsx|mjs)$/, '');
      const candidates = [
        base,
        ...EXTENSIONS.map((e) => stem + e),
        ...EXTENSIONS.map((e) => `${base}/index${e}`),
      ];
      for (const candidate of candidates) {
        if (!candidate.startsWith(workspaceUrl)) deny(specifier, parent);
        if (overrides.has(candidate) || isFile(candidate))
          return { url: tag(candidate), shortCircuit: true };
      }
      deny(specifier, parent);
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('/'))
      deny(specifier, parent);
    // Bare package names resolve through the trusted dependency tree; the
    // permission model bounds what any resolution can read.
    const pkg = packageName(specifier);
    if (!allowedPackages.has(pkg) && !pkg.startsWith('@pandamstyle/'))
      deny(specifier, parent);
    const resolved = nextResolve(specifier, context);
    if (!resolved.url.startsWith('file:')) deny(specifier, parent);
    // With code generation disabled Node cannot detect CommonJS named
    // exports; serve an ESM facade with the module's real export names.
    if (isCommonJs(resolved.url))
      return { url: `pms-cjs:${resolved.url}`, shortCircuit: true };
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pms-cjs:')) {
      const real = url.slice('pms-cjs:'.length);
      const file = fileURLToPath(real);
      const exported = createRequire(file)(file);
      const names = Object.keys(exported ?? {}).filter(
        (k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default',
      );
      return {
        format: 'module',
        source: `import m from ${JSON.stringify(real)};\nexport default m;\n${names.map((n) => `export const ${n} = m[${JSON.stringify(n)}];`).join('\n')}\n`,
        shortCircuit: true,
      };
    }
    const base = stripQuery(url);
    if (overrides.has(base))
      return {
        format: 'module',
        source: overrides.get(base),
        shortCircuit: true,
      };
    if (insideWorkspace(base)) {
      if (ASSET.test(base))
        return {
          format: 'module',
          source: 'export default "";',
          shortCircuit: true,
        };
      if (request.mode === 'render' && /\.(jsx|tsx|ts)$/.test(base)) {
        throw new Error(
          `PMS_ORACLE_UNCOVERED_MODULE: ${base} has no compiler artifact`,
        );
      }
      if (/\.(js|mjs)$/.test(base)) {
        return {
          format: 'module',
          source: readFileSync(fileURLToPath(base), 'utf8'),
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

// --- Remove ambient authority and freeze what the harness relies on ----------

const NOOP = () => undefined;
// Errors agent code leaves uncaught (a throwing timer callback, a rejected
// promise nobody handles) belong to the scenario being observed, as in a
// browser; they must not end the process and lose every observation.
let processError = null;
let lastResult = null;
const uncaught = (error) => {
  let message = 'unknown error';
  try {
    message = '' + (error?.message ?? error);
  } catch {
    // An agent-controlled error object may refuse conversion.
  }
  // Outside a scenario, the error is late deferred work of the last one.
  const target = sink ?? lastResult;
  if (target != null) target.error ??= `uncaught error: ${message}`;
  else processError ??= `uncaught error: ${message}`;
};
realProcess.on('uncaughtException', uncaught);
realProcess.on('unhandledRejection', uncaught);
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
// Stack traces drive caller attribution: their depth and format are locked.
Object.defineProperty(ErrorRef, 'stackTraceLimit', {
  value: 200,
  writable: false,
  configurable: false,
});
Object.defineProperty(ErrorRef, 'prepareStackTrace', {
  value: undefined,
  writable: false,
  configurable: false,
});
const EvalErrorRef = EvalError;
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

// Waits until agent-scheduled work has run: a few event-loop turns, then
// until no agent timer is pending (bounded).
const settle = async (rounds = 6) => {
  const pending = () => pendingTimers > 0;
  for (let i = 0; i < 400; i += 1) {
    if (i >= rounds && !pending()) break;
    await new Promise((resolve) => realSetTimeout(resolve, 0));
  }
};
const isCodeGeneration = (error) => error instanceof EvalErrorRef;
const SWEEP_EVENTS = [
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'mouseover',
  'focusin',
  'focusout',
  'keydown',
  'keyup',
  'input',
  'change',
  'submit',
  'toggle',
];

function dispatch(win, el, type) {
  harnessDepth += 1;
  try {
    return dispatchEvent(harnessDom.get(win), el, type);
  } finally {
    harnessDepth -= 1;
  }
}

function dispatchEvent(dom, el, type) {
  const fire = (event) => apply(dom.dispatchEvent, el, [event]);
  const E = dom.events;
  if (type === 'click') return apply(dom.click, el, []);
  if (type === 'keydown' || type === 'keyup')
    return fire(
      new E.KeyboardEvent(type, {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  if (/^(mouse|dbl)/.test(type))
    return fire(
      new E.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
    );
  if (type === 'focusin' || type === 'focusout')
    return fire(new E.FocusEvent(type, { bubbles: true }));
  if (type === 'submit')
    return fire(new E.Event('submit', { bubbles: true, cancelable: true }));
  return fire(new E.Event(type, { bubbles: true }));
}

// --- Committed-tree consistency -----------------------------------------------
//
// React's committed fiber tree says what the DOM must be: which nodes, in which
// order, with which text and with the attributes React derives from the
// committed props. Any difference was made by something other than a React
// commit, however it was invoked (a bound DOM method handed to React as a ref
// or handler leaves no agent stack frame). Attributes are derived with React's
// own serializer. Every read goes through accessors captured before agent code
// (`dom.read`), so own properties and DOM clobbering cannot redirect it.

const HOST_PORTAL = 4;
const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const OFFSCREEN = 22;
const HOST_HOISTABLE = 26;
const HOST_SINGLETON = 27;
// Live form state React writes as properties, or the user agent changes.
const FORM_STATE = new Set([
  'value',
  'checked',
  'selected',
  'multiple',
  'defaultvalue',
  'defaultchecked',
]);
const UNCOMPARED = new Set(['autofocus', 'action', 'formaction']);
const FORM_CONTROL = /^(input|select|option|textarea)$/;

// Accessors the checks read the DOM with, captured from the pristine window.
function domReader(win) {
  const getter = (proto, key) =>
    Object.getOwnPropertyDescriptor(proto, key).get;
  const childNodes = getter(win.Node.prototype, 'childNodes');
  const nodeType = getter(win.Node.prototype, 'nodeType');
  const tagName = getter(win.Element.prototype, 'tagName');
  const data = getter(win.CharacterData.prototype, 'data');
  const attributes = getter(win.Element.prototype, 'attributes');
  const mapLength = getter(win.NamedNodeMap.prototype, 'length');
  const mapItem = win.NamedNodeMap.prototype.item;
  const attrName = getter(win.Attr.prototype, 'name');
  const attrValue = getter(win.Attr.prototype, 'value');
  const listLength = getter(win.NodeList.prototype, 'length');
  const listItem = win.NodeList.prototype.item;
  const parentNode = getter(win.Node.prototype, 'parentNode');
  const head = getter(win.Document.prototype, 'head');
  const body = getter(win.Document.prototype, 'body');
  const documentElement = getter(win.Document.prototype, 'documentElement');
  const list = (nodes) => {
    const out = [];
    const n = apply(listLength, nodes, []);
    for (let i = 0; i < n; i += 1) out[i] = apply(listItem, nodes, [i]);
    return out;
  };
  const read = {
    children: (node) => list(apply(childNodes, node, [])),
    parent: (node) => apply(parentNode, node, []),
    type: (node) => apply(nodeType, node, []),
    tag: (node) => ('' + apply(tagName, node, [])).toLowerCase(),
    text: (node) => apply(data, node, []),
    head: (doc) => apply(head, doc, []),
    body: (doc) => apply(body, doc, []),
    root: (doc) => apply(documentElement, doc, []),
    nodes: list,
    // Attribute [name, value] pairs, names as written.
    attributePairs(el) {
      const map = apply(attributes, el, []);
      const out = [];
      const n = apply(mapLength, map, []);
      for (let i = 0; i < n; i += 1) {
        const a = apply(mapItem, map, [i]);
        out[i] = ['' + apply(attrName, a, []), '' + apply(attrValue, a, [])];
      }
      return out;
    },
    attributes(el) {
      const out = new Map();
      for (const [name, value] of read.attributePairs(el))
        out.set(name.toLowerCase(), value);
      return out;
    },
  };
  read.describe = (node) =>
    read.type(node) === 1 ? `<${read.tag(node)}>` : 'text';
  return read;
}

// The committed DOM as data: elements `{ t, a, c }` and text `{ x }`. The
// evaluator reads this tree, never a re-parse of serialized markup (raw-text
// elements such as <script> or <xmp> serialize their text unescaped, and a
// <template> serializes its content instead of its children).
function snapshotTree(read, node, depth = 0) {
  const children = [];
  for (const child of read.children(node)) {
    const type = read.type(child);
    if (type === 3) children[children.length] = { x: read.text(child) };
    else if (type === 1) {
      if (depth > 200) throw new ErrorRef('committed DOM is too deep');
      const sub = snapshotTree(read, child, depth + 1);
      children[children.length] = {
        t: read.tag(child),
        a: read.attributePairs(child),
        c: sub,
      };
    }
  }
  return children;
}

// React's FiberRoot for a container, captured right after createRoot and
// before any agent render code runs; its `current` is the committed tree.
const COMPONENT_WRAPPERS = new Set([
  Symbol.for('react.memo'),
  Symbol.for('react.forward_ref'),
  Symbol.for('react.lazy'),
]);

function fiberRootOf(container) {
  for (const key of Object.getOwnPropertyNames(container)) {
    if (key.startsWith('__reactContainer$'))
      return container[key]?.stateNode ?? null;
  }
  return null;
}

// Host children of a fiber, in order. Portals and hoistables are collected
// separately; a hidden subtree (Suspense fallback, hidden Activity) is not
// decidable here.
function hostChildren(fiber, acc = { nodes: [], portals: [], elsewhere: [] }) {
  for (let c = fiber.child; c != null; c = c.sibling) {
    if (c.tag === HOST_COMPONENT || c.tag === HOST_TEXT) acc.nodes.push(c);
    else if (c.tag === HOST_PORTAL) acc.portals.push(c);
    else if (c.tag === HOST_HOISTABLE || c.tag === HOST_SINGLETON)
      acc.elsewhere.push(c);
    else if (c.tag === OFFSCREEN && c.memoizedState != null) acc.hidden = true;
    else hostChildren(c, acc);
  }
  return acc;
}

// The attributes React's serializer derives from the committed props.
function expectedAttributes(fiber, parse) {
  const props = {};
  for (const key of Object.keys(fiber.memoizedProps ?? {})) {
    if (key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    props[key] = fiber.memoizedProps[key];
  }
  const t = parserDocument.createElement('template');
  t.innerHTML = renderToStaticMarkup(React.createElement(fiber.type, props));
  const el = t.content.firstElementChild;
  if (el == null) throw new ErrorRef('no element');
  return parse(el);
}

const parserAttributes = (el) => {
  const out = new Map();
  for (const a of el.attributes) out.set(a.name.toLowerCase(), a.value);
  return out;
};

function checkTree(read, container, fiberRoot, phase) {
  const problems = [];
  const unmeasured = [];
  const known = new Set([container]);
  const channels = [];
  const root = fiberRoot?.current ?? null;
  if (root == null)
    return {
      problems: ['no committed React root'],
      unmeasured,
      known,
      channels,
    };
  // Portals into a node React itself renders (or the root container): their
  // nodes are expected among that node's children, next to its own.
  const owned = new Set([container]);
  const portalsInto = new Map();
  const collect = (fiber) => {
    for (let c = fiber.child; c != null; c = c.sibling) {
      if (c.tag === HOST_COMPONENT || c.tag === HOST_TEXT)
        owned.add(c.stateNode);
      if (c.tag === HOST_PORTAL) {
        const target = c.stateNode.containerInfo;
        const groups = portalsInto.get(target) ?? [];
        groups.push(hostChildren(c).nodes.map((f) => f.stateNode));
        portalsInto.set(target, groups);
      }
      collect(c);
    }
  };
  collect(root);
  const inOrder = (actual, group) => {
    let at = 0;
    for (const n of actual) if (n === group[at]) at += 1;
    return at === group.length;
  };
  const checkChildren = (parent, acc, exact) => {
    if (acc.hidden) {
      unmeasured.push(
        `hidden React subtree under ${read.describe(parent)} is not measured`,
      );
      return;
    }
    const expected = acc.nodes.map((f) => f.stateNode);
    const actual = read.children(parent);
    const portals = exact ? (portalsInto.get(parent) ?? []) : [];
    if (portals.length > 0) {
      // Exactly the node's own children and the portals' nodes, each group
      // in its own order.
      const groups = [expected, ...portals];
      const all = new Set(groups.flat());
      const same =
        actual.length === all.size &&
        actual.every((n) => all.has(n)) &&
        groups.every((g) => inOrder(actual, g));
      if (!same)
        problems.push(
          `children of ${read.describe(parent)} differ from React's committed tree`,
        );
    } else if (exact) {
      const same =
        expected.length === actual.length &&
        expected.every((n, i) => n === actual[i]);
      if (!same)
        problems.push(
          `children of ${read.describe(parent)} differ from React's committed tree`,
        );
    } else {
      // Portal containers may hold other content; React's nodes must still be
      // there, in order.
      if (!inOrder(actual, expected))
        problems.push(`portal content in ${read.describe(parent)} was altered`);
    }
  };
  const compareAttributes = (fiber, node, tag) => {
    if (tag.includes('-')) {
      unmeasured.push(`attributes of custom element <${tag}> are not compared`);
      return;
    }
    let want = null;
    try {
      want = expectedAttributes(fiber, parserAttributes);
    } catch {
      unmeasured.push(`attributes of <${tag}> are not compared`);
      return;
    }
    const have = read.attributes(node);
    for (const name of new Set([...want.keys(), ...have.keys()])) {
      if (UNCOMPARED.has(name)) continue;
      if (FORM_CONTROL.test(tag) && FORM_STATE.has(name)) continue;
      // The user agent toggles <details open> on activation.
      if (name === 'open' && phase !== 'render' && tag === 'details') continue;
      const same =
        name === 'style'
          ? want.has(name) === have.has(name)
          : want.get(name) === have.get(name);
      if (!same)
        problems.push(
          `attribute ${name} of <${tag}> differs from React's committed props`,
        );
    }
  };
  const visit = (fiber) => {
    const node = fiber.stateNode;
    known.add(node);
    if (fiber.tag === HOST_TEXT) {
      if (read.type(node) !== 3 || read.text(node) !== '' + fiber.memoizedProps)
        problems.push("text differs from React's committed text");
      return;
    }
    const tag = read.tag(node);
    const props = fiber.memoizedProps ?? {};
    compareAttributes(fiber, node, tag);
    const acc = hostChildren(fiber);
    const children = props.children;
    // Raw markup is a channel around the design system, like inline styles.
    if (props.dangerouslySetInnerHTML != null)
      channels.push(`raw markup (dangerouslySetInnerHTML) on <${tag}>`);
    if (
      props.dangerouslySetInnerHTML != null ||
      tag === 'textarea' ||
      tag === 'noscript'
    ) {
      // React sets this content as text or markup; it has no fibers.
      for (const n of read.children(node)) known.add(n);
    } else if (
      typeof children === 'string' ||
      typeof children === 'number' ||
      typeof children === 'bigint'
    ) {
      const text = '' + children;
      const kids = read.children(node);
      const ok =
        text === ''
          ? kids.length === 0
          : kids.length === 1 &&
            read.type(kids[0]) === 3 &&
            read.text(kids[0]) === text;
      if (!ok)
        problems.push(
          `content of <${tag}> differs from React's committed text`,
        );
      for (const n of kids) known.add(n);
    } else checkChildren(node, acc, true);
    descend(acc);
  };
  const descend = (acc) => {
    for (const f of acc.nodes) visit(f);
    for (const f of acc.elsewhere) {
      known.add(f.stateNode);
      unmeasured.push('hoisted or singleton React element is not measured');
    }
    for (const portal of acc.portals) {
      const inner = hostChildren(portal);
      const target = portal.stateNode.containerInfo;
      // A React-owned target is checked with its owner's children.
      if (!owned.has(target)) checkChildren(target, inner, false);
      descend(inner);
    }
  };
  const top = hostChildren(root);
  checkChildren(container, top, true);
  descend(top);
  return { problems, unmeasured, known, channels };
}

// Style channels anywhere in the document, whoever made them: style sheet
// elements, `style` attributes and legacy presentational HTML (the lists
// come from the parent, `style-channels.mjs`).
const STYLE_CHANNELS = request.styleChannels ?? {
  elements: [],
  attributes: [],
  dimensioned: [],
};

function documentStyleChannels(read, doc) {
  const out = [];
  const visit = (el, inSvg) => {
    const tag = read.tag(el);
    const svg = inSvg || tag === 'svg';
    if (tag === 'style' || tag === 'link') out.push(`<${tag}> element`);
    if (!svg && STYLE_CHANNELS.elements.includes(tag))
      out.push(`presentational <${tag}> element`);
    for (const name of read.attributes(el).keys()) {
      if (name === 'style') out.push(`style attribute on <${tag}>`);
      else if (
        !svg &&
        (STYLE_CHANNELS.attributes.includes(name) ||
          (name === 'size' && tag === 'hr') ||
          ((name === 'width' || name === 'height') &&
            !STYLE_CHANNELS.dimensioned.includes(tag)))
      )
        out.push(`presentational ${name} attribute on <${tag}>`);
    }
    for (const child of read.children(el))
      if (read.type(child) === 1) visit(child, svg);
  };
  visit(read.root(doc), false);
  return out;
}

// Outside the container the document must stay as the harness created it,
// apart from nodes React placed there (portals, hoisted elements).
function snapshotDocument(read, doc) {
  const attrs = (el) =>
    [...read.attributes(el)].map(([k, v]) => `${k}=${v}`).join('\n');
  const fixed = () => [read.root(doc), read.head(doc), read.body(doc)];
  return {
    fixed: fixed(),
    head: read.children(read.head(doc)),
    body: read.children(read.body(doc)),
    documentChildren: read.children(doc),
    rootChildren: read.children(read.root(doc)),
    attributes: fixed().map(attrs),
    attrs,
    current: fixed,
  };
}

function checkDocument(read, doc, before, known) {
  const problems = [];
  const now = before.current();
  if (now.some((n, i) => n !== before.fixed[i]))
    return ['document structure was altered'];
  const sameAround = (list, current) => {
    const base = new Set(list);
    for (const n of current) if (!base.has(n) && !known.has(n)) return false;
    for (const n of list) if (!current.includes(n)) return false;
    return true;
  };
  if (!sameAround(before.head, read.children(now[1])))
    problems.push('document head was altered outside React');
  if (!sameAround(before.body, read.children(now[2])))
    problems.push('document body was altered outside React');
  if (
    !sameAround(before.documentChildren, read.children(doc)) ||
    !sameAround(before.rootChildren, read.children(now[0]))
  )
    problems.push('document structure was altered');
  if (now.map(before.attrs).some((a, i) => a !== before.attributes[i]))
    problems.push('attributes of <html>, <head> or <body> were altered');
  return problems;
}

// Own properties that shadow a DOM interface member (an own `childNodes`,
// `getAttribute`, `parentNode`, ...) would mislead React and agent-visible
// reads. React's bookkeeping and value tracker, the DOM implementation's
// symbols and the legacy named and indexed properties of forms and selects
// are expected.
const VALUE_TRACKING = new Set(['value', 'checked', '_valueTracker']);
const WELL_KNOWN_SYMBOLS = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map((k) => Symbol[k])
    .filter((v) => typeof v === 'symbol'),
);

function shadowingProperties(read, node, prototypes) {
  const out = [];
  // A replaced prototype swaps the node's whole interface.
  if (!prototypes.has(Object.getPrototypeOf(node))) out.push('[[Prototype]]');
  const isElement = read.type(node) === 1;
  const tag = isElement ? read.tag(node) : '#node';
  const legacy = tag === 'form' || tag === 'select';
  for (const key of Object.getOwnPropertyNames(node)) {
    if (/^_{1,2}react/.test(key)) continue;
    if (FORM_CONTROL.test(tag) && VALUE_TRACKING.has(key)) continue;
    if (legacy) continue;
    if (key in Object.getPrototypeOf(node)) out.push(key);
  }
  for (const key of Object.getOwnPropertySymbols(node))
    if (WELL_KNOWN_SYMBOLS.has(key)) out.push(String(key));
  return out;
}

function checkOwnProperties(read, doc, container, prototypes) {
  const problems = [];
  const visit = (node) => {
    const extra = shadowingProperties(read, node, prototypes);
    if (extra.length > 0)
      problems.push(
        `own property ${extra[0]} shadows the DOM on ${read.describe(node)}`,
      );
    if (read.type(node) === 1 || read.type(node) === 9)
      for (const child of read.children(node)) visit(child);
  };
  for (const node of [doc, read.root(doc), read.head(doc), read.body(doc)]) {
    const extra = shadowingProperties(read, node, prototypes);
    if (extra.length > 0)
      problems.push(`own property ${extra[0]} shadows the DOM on the document`);
  }
  visit(container);
  return problems;
}

async function renderScenario(spec, index) {
  const win = windows[index];
  const dom = harnessDom.get(win);
  currentWindow = win;
  const doc = win.document;
  const scenario = {
    html: null,
    tree: null,
    interactions: [],
    outside: {},
    violations: [],
    unmeasured: [],
    unattributed: [],
    observer: null,
    error: null,
  };
  let mode = 'render';
  let attribution = null;
  const spyFor = (name) => {
    scenario.outside[name] ??= 0;
    return function spy() {
      if (mode === 'dispatch') attribution[name] = (attribution[name] ?? 0) + 1;
      else if (mode === 'render') scenario.outside[name] += 1;
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
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const read = dom.read;
  const documentBefore = snapshotDocument(read, doc);
  // Run after every settled phase: the DOM must be what React committed.
  let fiberRoot = null;
  const verify = (phase) => {
    const tree = checkTree(read, container, fiberRoot, phase);
    const problems = [
      ...checkOwnProperties(read, doc, container, dom.prototypes),
      ...tree.problems,
      ...checkDocument(read, doc, documentBefore, tree.known),
    ];
    for (const p of problems.slice(0, 10))
      violation(`committed DOM diverges from React (${phase}): ${p}`);
    const channels = [...tree.channels, ...documentStyleChannels(read, doc)];
    for (const c of channels.slice(0, 10))
      violation(`style channel in the document (${phase}): ${c}`);
    for (const u of tree.unmeasured)
      if (!scenario.unmeasured.includes(u)) scenario.unmeasured.push(u);
  };
  // Delivered records (mutations no instrumented call drained) are kept: they
  // came from a path around the wrapped APIs.
  const observer = new win.MutationObserver((records) => {
    scenario.unattributed.push(...records);
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  scenario.observer = observer;
  const drain = (phase) => {
    const records = [...scenario.unattributed, ...observer.takeRecords()];
    scenario.unattributed = [];
    for (const r of records) {
      const added = read.nodes(r.addedNodes);
      const styleNode = added.some(
        (n) => read.type(n) === 1 && /^(style|link)$/.test(read.tag(n)),
      );
      const styleAttr = r.type === 'attributes' && r.attributeName === 'style';
      // During harness-dispatched events the user agent itself toggles `open`
      // (<details> activation); every other unattributed mutation came from a
      // path around the instrumented APIs.
      const userAgent =
        phase === 'dispatch' &&
        r.type === 'attributes' &&
        r.attributeName === 'open';
      if (styleNode || styleAttr)
        violation(`style channel: unattributed ${r.type} mutation`);
      else if (!userAgent)
        violation(
          `unattributed DOM ${r.type} mutation${r.attributeName ? ` (${r.attributeName})` : ''}`,
        );
    }
  };
  sink = scenario;
  const onUncaught = (error) => {
    if (isCodeGeneration(error)) violation('code generation from strings');
    scenario.error ??= `uncaught error: ${'' + (error?.message ?? error)}`;
  };
  let root = null;
  try {
    const r = spec.render;
    const url = pathToFileURL(path.resolve(workspaceDir, r.module)).href;
    if (!overrides.has(url))
      throw new Error(`PMS_ORACLE_UNCOVERED_MODULE: ${r.module}`);
    const mod = await import(`${url}?pms-scenario=${index}`);
    const Component = mod[r.export ?? 'default'];
    // Function components and React's component wrappers (memo, forwardRef,
    // lazy); React validates the rest.
    const wrapper =
      Component != null &&
      typeof Component === 'object' &&
      COMPONENT_WRAPPERS.has(Component.$$typeof);
    if (typeof Component !== 'function' && !wrapper)
      throw new Error(
        `PMS_ORACLE_MISSING_EXPORT: ${r.module}#${r.export ?? 'default'}`,
      );
    let element = React.createElement(Component, withSpies(r.props ?? {}));
    if (r.theme != null) {
      const className = request.themeClasses?.[r.theme];
      if (className == null)
        throw new Error(`PMS_ORACLE_UNKNOWN_THEME: ${r.theme}`);
      element = React.createElement(
        'div',
        { className, 'data-pms-oracle-theme': r.theme },
        element,
      );
    }
    root = createRoot(container, {
      onUncaughtError: onUncaught,
      onCaughtError: onUncaught,
      onRecoverableError: NOOP,
    });
    fiberRoot = fiberRootOf(container);
    flushSync(() => root.render(element));
    await settle();
    drain('render');
    verify('render');
    scenario.html = apply(dom.innerHTML, container, []);
    scenario.tree = snapshotTree(read, container);
    // Committed elements in document order, walked exactly as the tree above,
    // so candidates correspond one to one with the evaluator's elements.
    const committedElements = () => {
      const out = [];
      const walk = (node) => {
        for (const child of read.children(node)) {
          if (read.type(child) !== 1) continue;
          out[out.length] = child;
          walk(child);
        }
      };
      walk(container);
      return out;
    };
    const committed = committedElements();
    for (const interaction of spec.interactions ?? []) {
      const candidates = [];
      const nodes = committed.filter(
        (el) => read.attributes(el).get('data-testid') === interaction.testId,
      );
      for (let i = 0; i < nodes.length; i += 1) {
        const calls = {};
        mode = 'dispatch';
        attribution = calls;
        try {
          dispatch(win, nodes[i], interaction.event);
          await settle(3);
        } catch (error) {
          if (isCodeGeneration(error))
            violation('code generation from strings in a handler');
        } finally {
          mode = 'sweep';
          attribution = null;
        }
        drain('dispatch');
        verify('interaction');
        candidates[candidates.length] = { index: i, calls };
      }
      scenario.interactions[scenario.interactions.length] = {
        testId: interaction.testId,
        event: interaction.event,
        candidates,
      };
    }
    mode = 'sweep';
    // Sweep common events over every rendered element: handler code the task
    // does not exercise still runs under observation.
    const all = committedElements().slice(0, 300);
    for (const el of all) {
      for (const type of SWEEP_EVENTS) {
        try {
          dispatch(win, el, type);
        } catch (error) {
          if (isCodeGeneration(error))
            violation('code generation from strings in a handler');
        }
      }
    }
    await settle();
    drain('dispatch');
    verify('sweep');
  } catch (error) {
    if (isCodeGeneration(error))
      violation('code generation from strings during render');
    scenario.error ??= '' + (error?.message ?? error);
  } finally {
    sink = null;
    observer.disconnect();
    try {
      if (root != null) flushSync(() => root.unmount());
    } catch {
      // Unmount errors do not change what was observed.
    }
    win.close();
  }
  lastResult = {
    html: scenario.html,
    tree: scenario.tree,
    interactions: scenario.interactions,
    outside: scenario.outside,
    violations: scenario.violations,
    unmeasured: scenario.unmeasured,
    error: scenario.error,
  };
  return lastResult;
}

async function runRender() {
  const results = [];
  for (let i = 0; i < scenarios.length; i += 1)
    results[results.length] = await renderScenario(scenarios[i], i);
  // Late deferred work of the last scenario still counts.
  await settle();
  return serialize({ scenarios: results });
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
    let payload = null;
    if (request.mode === 'definition') payload = await runDefinition();
    else if (request.mode === 'render') payload = await runRender();
    else if (request.mode === 'probe') payload = await runProbe();
    else throw new ErrorRef(`unknown mode ${request.mode}`);
    await settle(2);
    // Definition and probe evaluation fail closed on stray errors.
    if (processError != null && request.mode !== 'render')
      throw new ErrorRef(processError);
    emit({ status: 'ok', payload });
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
