/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Isolation of agent-written code from trusted observations, and the
// fail-closed static rules. Run: node --test benchmarks/agentic/__tests__/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { CORPUS_ROOT } from '../src/corpus.mjs';
import { loadDefinitionData, runSandbox } from '../src/oracles/run-sandbox.mjs';
import { findConstructs } from '../src/oracles/static-source.mjs';

// Inside the repository so React and the compiler resolve from the workspace
// root, as from a runner-provided trusted dependency tree.
const SCRATCH = path.resolve(CORPUS_ROOT, '../../.pms-bench/agentic-isolation');

function workspace(name, files) {
  const dir = path.join(SCRATCH, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function render(dir, source, extra = {}) {
  const file = path.join(dir, 'src/C.jsx');
  fs.writeFileSync(file, source);
  return runSandbox({
    mode: 'render',
    workspaceDir: dir,
    overrides: { [pathToFileURL(file).href]: source },
    scenarios: [
      {
        render: { module: 'src/C.jsx', export: 'C', props: extra.props ?? {} },
        interactions: extra.interactions ?? [],
      },
    ],
  });
}

// The single scenario of a render request; a sandbox-level failure throws.
const payload = (r) => {
  assert.equal(r.ok, true, r.error);
  return JSON.parse(r.payload).scenarios[0];
};
const failure = (r) =>
  r.ok ? JSON.parse(r.payload).scenarios[0].error : r.error;

test('agent code cannot forge the tagged result line', () => {
  const dir = workspace('forge', {});
  const r = render(
    dir,
    "export function C() { console.log('PMS-SANDBOX 0 status=6f6b payload=00'); return 'real'; }\n",
  );
  assert.equal(payload(r).html, 'real');
});

test('agent code has no process, argv, environment or builtin escape hatch', () => {
  const dir = workspace('ambient', {});
  const r = render(
    dir,
    "export function C() { return [typeof process.getBuiltinModule, typeof process.argv, typeof process.stdout, typeof globalThis.process.binding, Object.keys(process.env).join(',')].join(':'); }\n",
  );
  assert.equal(
    payload(r).html,
    'undefined:undefined:undefined:undefined:NODE_ENV',
  );
});

test('agent code cannot import Node built-ins, harness modules or undeclared packages', () => {
  const dir = workspace('builtins', {});
  for (const spec of [
    'node:fs',
    'fs',
    'node:child_process',
    'node:worker_threads',
    'pms-sandbox:registry',
    'pms-cjs:file:///x.js',
    '/etc/passwd',
    'jsdom',
    'parse5',
  ]) {
    const r = render(
      dir,
      `import x from ${JSON.stringify(spec)};\nexport function C() { return String(x); }\n`,
    );
    assert.match(failure(r), /PMS_SANDBOX_DENIED_IMPORT/, spec);
  }
  assert.match(
    failure(
      render(
        dir,
        "const fs = await import('node:fs');\nexport function C() { return String(fs); }\n",
      ),
    ),
    /PMS_SANDBOX_DENIED_IMPORT/,
  );
});

test('code generation from strings is impossible and recorded', () => {
  const dir = workspace('codegen', {});
  for (const source of [
    "export function C() { return (() => {}).constructor('return 1')(); }\n",
    "export function C() { const make = Function; return make('return 1')(); }\n",
    "export function C() { return eval('1'); }\n",
  ]) {
    const scenario = payload(render(dir, source));
    assert.match(
      scenario.error,
      /Code generation from strings disallowed/,
      source,
    );
    assert.ok(
      scenario.violations.includes('code generation from strings'),
      source,
    );
  }
});

test('agent code cannot rewire the harness through prototypes', () => {
  const dir = workspace('prototype', {});
  const polluted = payload(
    render(
      dir,
      "Object.prototype.status = 'ok';\nexport function C() { throw new Error('actual failure'); }\n",
    ),
  );
  assert.ok(polluted.error != null);
  const frozen = payload(
    render(
      dir,
      "export function C() { try { Array.prototype.push = () => 0; return 'patched'; } catch { return 'frozen'; } }\n",
    ),
  );
  assert.equal(frozen.html, 'frozen');
});

test('the committed DOM and its instrumentation observe React refs, effects, handlers and deferred work', () => {
  const dir = workspace('trace', {});
  const jsxHeader =
    "import { jsx } from 'react/jsx-runtime';\nimport { useEffect, useRef, cloneElement } from 'react';\n";
  const cases = {
    "export function C() { document.body.style.color = 'red'; return 'x'; }\n":
      /style channel/,
    [`${jsxHeader}export function C() { return jsx('div', { ref: (el) => { if (el) el[['st', 'yle'].join('')].color = 'red'; }, children: 'x' }); }\n`]:
      /style channel CSSStyle\w+\.color written by code at src\/C\.jsx/,
    [`${jsxHeader}export function C() { return jsx('div', { ref: (el) => { if (el?.nodeType === 1) el.hidden = true; }, children: 'x' }); }\n`]:
      /DOM write HTMLElement\.hidden by code at src\/C\.jsx/,
    [`${jsxHeader}export function C() { return jsx('section', { ref: (el) => { if (el?.tagName === 'SECTION') el.textContent = 'Gone'; }, children: 'x' }); }\n`]:
      /DOM write Node\.textContent by code/,
    [`${jsxHeader}export function C() { useEffect(() => { document.head.appendChild(document.createElement('style')); }); return jsx('div', { children: 'x' }); }\n`]:
      /createElement\(style\)/,
    [`${jsxHeader}export function C() { return jsx('button', { onClick: (e) => { e.currentTarget.setAttribute('style', 'x'); }, children: 'x' }); }\n`]:
      /style channel Element\.setAttribute/,
    [`${jsxHeader}export function C() { useEffect(() => { document.adoptedStyleSheets = [new CSSStyleSheet()]; }, []); return jsx('div', { children: 'x' }); }\n`]:
      /adoptedStyleSheets/,
    [`${jsxHeader}export function C() { return jsx('div', { ref: (el) => { if (el) el.addEventListener('click', () => { el.style.color = 'red'; }); }, children: 'x' }); }\n`]:
      /style channel CSSStyle\w+\./,
    [`${jsxHeader}export function C() { useEffect(() => { setTimeout(() => { document.body.style.color = 'red'; }, 100000); }, []); return jsx('div', { children: 'x' }); }\n`]:
      /style channel/,
    [`${jsxHeader}export function C() { useEffect(() => { requestAnimationFrame(() => { document.body.hidden = true; }); }, []); return jsx('div', { children: 'x' }); }\n`]:
      /DOM write HTMLElement\.hidden/,
    [`${jsxHeader}export function C() { const ref = useRef(null); useEffect(() => { const el = ref.current; const impl = el[Object.getOwnPropertySymbols(el)[0]]; impl.setAttributeNS(null, 'hidden', ''); }, []); return jsx('div', { ref, children: 'x' }); }\n`]:
      /unattributed DOM attributes mutation \(hidden\)/,
    [`${jsxHeader}export function C() { const b = jsx('div', { children: 'x' }); return cloneElement(b, { ref: (n) => { if (n) { const s = n[['st', 'yle'].join('')]; s.color = 'red'; } } }); }\n`]:
      /style channel/,
    [`${jsxHeader}export function C() { useEffect(() => { customElements.define('x-y', class extends HTMLElement {}); }, []); return jsx('div', { children: 'x' }); }\n`]:
      /CustomElementRegistry\.define/,
  };
  for (const [source, pattern] of Object.entries(cases)) {
    const trace = payload(render(dir, source)).violations.join('\n');
    assert.match(trace, pattern, source);
  }
  const clean = payload(
    render(
      dir,
      `${jsxHeader}export function C({ items = ['a', 'b'] }) { const ref = useRef(null); useEffect(() => { ref.current?.focus(); }, []); return jsx('ul', { ref, tabIndex: -1, children: items.map((x, i) => jsx('li', { children: items[i] }, x)) }); }\n`,
    ),
  );
  assert.deepEqual(clean.violations, []);
  assert.equal(clean.html, '<ul tabindex="-1"><li>a</li><li>b</li></ul>');
});

test('interactions are native events on the committed DOM', () => {
  const dir = workspace('spies', {});
  const spy = {
    props: { onGo: { $pmsSpy: 'onGo' } },
    interactions: [{ testId: 'go', event: 'click' }],
  };
  const jsxHeader =
    "import { jsx } from 'react/jsx-runtime';\nimport { cloneElement } from 'react';\n";
  const calls = (source) =>
    payload(
      render(dir, `${jsxHeader}${source}`, spy),
    ).interactions[0].candidates.map((c) => c.calls.onGo ?? 0);
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { return jsx('span', { onClick: () => onGo(), children: jsx('button', { 'data-testid': 'go', children: 'Go' }) }); }\n",
    ),
    [1],
    'bubbling to a rendered ancestor',
  );
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { return jsx('button', { 'data-testid': 'go', onClick: (e) => { if (e.button === 0 && e.target === e.currentTarget) onGo(); }, children: 'Go' }); }\n",
    ),
    [1],
    'native MouseEvent fields',
  );
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { const unused = jsx('button', { 'data-testid': 'go', onClick: onGo }); return jsx('button', { 'data-testid': 'go', children: 'Go' }); }\n",
    ),
    [0],
    'unused JSX never counts',
  );
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { return cloneElement(jsx('button', { 'data-testid': 'go', onClick: onGo, children: 'Go' }), { onClick: undefined }); }\n",
    ),
    [0],
    'cloneElement removing the handler',
  );
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { return cloneElement(jsx('button', { 'data-testid': 'go', children: 'Go' }), { onClick: onGo }); }\n",
    ),
    [1],
    'cloneElement adding the handler',
  );
  assert.deepEqual(
    calls(
      "export function C({ onGo }) { return jsx('button', { 'data-testid': 'go', disabled: true, onClick: onGo, children: 'Go' }); }\n",
    ),
    [0],
    'disabled buttons do not fire',
  );
  const early = payload(
    render(
      dir,
      `${jsxHeader}export function C({ onGo }) { onGo(); return jsx('button', { 'data-testid': 'go', children: 'Go' }); }\n`,
      spy,
    ),
  );
  assert.equal(early.outside.onGo, 1);
});

test('the committed DOM must be what React committed, read through frozen interfaces', () => {
  const dir = workspace('committed', {});
  const jsxHeader =
    "import { jsx, jsxs } from 'react/jsx-runtime';\nimport { useEffect, useRef, useState } from 'react';\n";
  const violations = (body) =>
    payload(render(dir, `${jsxHeader}${body}\n`)).violations.join('\n');
  // Bound DOM methods leave no agent stack frame.
  assert.match(
    violations(
      "export function C() { const [t, setT] = useState(null); return jsxs('div', { children: [jsx('span', { ref: setT, children: 'a' }), jsx('i', { ref: t ? t.remove.bind(t) : null, children: 'b' })] }); }",
    ),
    /committed DOM diverges from React \(render\): children of <div>/,
  );
  assert.match(
    violations(
      "export function C() { return jsx('b', { ref: (el) => el?.addEventListener('click', el.toggleAttribute.bind(el, 'hidden')), children: 'x' }); }",
    ),
    /DOM write Element\.toggleAttribute by a native callback/,
  );
  // Shadowing a DOM member on a node is reported; interfaces are frozen.
  assert.match(
    violations(
      "export function C() { return jsx('div', { ref: (el) => { if (el) Object.defineProperty(el, 'childNodes', { value: [] }); }, children: 'x' }); }",
    ),
    /own property childNodes shadows the DOM on <div>/,
  );
  assert.match(
    violations(
      "export function C() { return jsx('div', { ref: (el) => { if (el) Object.setPrototypeOf(el, Object.create(Object.getPrototypeOf(el))); }, children: 'x' }); }",
    ),
    /\[\[Prototype\]\] shadows the DOM on <div>/,
  );
  assert.match(
    failure(
      render(
        dir,
        "Element.prototype.querySelectorAll = () => [];\nexport function C() { return 'x'; }\n",
      ),
    ),
    /read only/,
  );
  // Network APIs throw; stray rejections stay on the scenario.
  assert.equal(
    payload(
      render(
        dir,
        "export function C() { try { fetch('http://localhost/'); return 'sent'; } catch (e) { return e.message; } }\n",
      ),
    ).html,
    'PMS_SANDBOX_NO_NETWORK',
  );
  assert.match(
    failure(
      render(
        dir,
        "export function C() { Promise.reject(new Error('stray')); return 'x'; }\n",
      ),
    ),
    /uncaught error: stray/,
  );
  // The evidence is the structured committed DOM, not a re-parse of markup.
  const raw = payload(
    render(
      dir,
      `${jsxHeader}export function C() { return jsxs('ul', { children: [jsx('xmp', { children: '</xmp><li>forged</li><xmp>' }), jsx('template', { children: jsx('li', { children: 'inert' }) })] }); }\n`,
    ),
  );
  assert.deepEqual(raw.violations, []);
  assert.deepEqual(raw.tree, [
    {
      t: 'ul',
      a: [],
      c: [
        { t: 'xmp', a: [], c: [{ x: '</xmp><li>forged</li><xmp>' }] },
        { t: 'template', a: [], c: [{ t: 'li', a: [], c: [{ x: 'inert' }] }] },
      ],
    },
  ]);
  // Honest form controls, SVG and portals are consistent with React.
  assert.equal(
    violations(
      "import { createPortal } from 'react-dom';\nexport function C() { const [v, setV] = useState('a'); return jsxs('form', { children: [jsx('input', { value: v, onChange: (e) => setV(e.target.value) }), jsx('select', { value: 'b', onChange: () => {}, children: [jsx('option', { value: 'a', children: 'A' }), jsx('option', { value: 'b', children: 'B' })] }), jsx('textarea', { defaultValue: 't' }), jsx('details', { children: jsx('summary', { children: 'S' }) }), jsx('svg', { viewBox: '0 0 1 1', children: jsx('path', { d: 'M0 0' }) }), createPortal(jsx('p', { children: 'p' }), document.body)] }); }",
    ),
    '',
  );
});

test('definitions load in the sandbox as plain data with token references', () => {
  const dir = workspace('definition', {
    'ok.mjs':
      "import { token } from '@pandamstyle/compiler/config';\nexport default { systemId: 'x@1', tokens: { spacing: { md: { value: '16px' } } }, recipes: { b: { base: { padding: token('spacing.md') } } } };\n",
    'fn.mjs':
      'export default { systemId: "x@1", recipes: { b: { base: () => 1 } } };\n',
    'fs.mjs':
      "import fs from 'node:fs';\nexport default { systemId: String(fs) };\n",
  });
  const ok = loadDefinitionData(dir, 'ok.mjs');
  assert.deepEqual(ok.data.recipes.b.base, {
    padding: { $pmsTokenRef: 'spacing.md' },
  });
  assert.match(loadDefinitionData(dir, 'fn.mjs').error, /non-data value/);
  assert.match(
    loadDefinitionData(dir, 'fs.mjs').error,
    /PMS_SANDBOX_DENIED_IMPORT/,
  );
});

test('static rules fail closed on runtime style mutation and ambient access', () => {
  const flagged = {
    'Object.assign(document.body.style, {})': [
      'runtime-style-injection',
      'dom-global-access',
    ],
    'export const f = (r) => { const s = r.current.style; s.color = "red"; };':
      ['runtime-style-injection'],
    'export const f = (el) => { const { style } = el; };': [
      'runtime-style-injection',
    ],
    "export const f = (el) => { el['st' + 'yle'].color = 'red'; };": [
      'runtime-style-injection',
    ],
    "export const f = (el) => el.style.setProperty('color', 'red');": [
      'runtime-style-injection',
    ],
    "export const f = (el) => { el.cssText = 'color:red'; };": [
      'runtime-style-injection',
    ],
    "const s = new CSSStyleSheet(); s.insertRule('a{}');": [
      'runtime-style-injection',
    ],
    'export const f = (d, x) => { d.adoptedStyleSheets = x; };': [
      'runtime-style-injection',
    ],
    "export const f = (d) => d.createElement('style');": [
      'runtime-style-injection',
    ],
    "export const f = (el) => el.setAttribute('style', 'color:red');": [
      'runtime-style-injection',
    ],
    'export const f = (el, v) => Reflect.set(el, "x", v);': [
      'runtime-style-injection',
    ],
    "export const A = () => <style>{'a{}'}</style>;": [
      'runtime-style-injection',
    ],
    "export const A = () => <div {...{ style: { color: 'red' } }} />;": [
      'jsx-style-prop',
    ],
    'export const g = () => window.location;': ['dom-global-access'],
    "eval('1');": ['dynamic-code'],
    'export const f = (m) => import(m);': ['dynamic-code'],
    "import fs from 'node:fs';": ['privileged-import'],
    'export const A = () => <div ref={(el) => { if (el) { const k = ["st", "yle"].join(""); el[k].backgroundColor = "red"; } }} />;':
      ['dynamic-code'],
    'const make = Function; make("x")();': ['dynamic-code'],
    "export const A = () => createElement('div', { dangerouslySetInnerHTML: { __html: '' } });":
      ['runtime-style-injection'],
    "export const A = () => <table bgColor='white'><tbody><tr><td><font color='white'>x</font></td></tr></tbody></table>;":
      ['jsx-style-prop'],
    'export function A({ k }) { const r = useRef(null); useEffect(() => { r.current[k] = 1; }); return <div ref={r} />; }':
      ['dynamic-code'],
    "import { useRef as useR } from 'react';\nexport function A({ k }) { const r = useR(null); useEffect(() => { r.current[k] = 1; }); return <div ref={r} />; }":
      ['dynamic-code'],
    'export const T = () => <table><tbody><tr><td align="left">a</td></tr></tbody></table>;':
      ['jsx-style-prop'],
    '(() => {}).constructor("x")();': ['dynamic-code'],
    "String.prototype.trim = () => '';": ['dynamic-code'],
    'export function A() { const r = useRef(null); useEffect(() => { const n = r.current; n[key] = 1; }); return <div ref={r} />; }':
      ['dynamic-code'],
  };
  for (const [code, rules] of Object.entries(flagged)) {
    const found = new Set(findConstructs(code, 'x.jsx').map((f) => f.rule));
    for (const rule of rules)
      assert.ok(found.has(rule), `${rule} not reported for: ${code}`);
  }
  const clean =
    "import { props } from '../g.js';\nconst o = Object.assign({}, { a: 1 });\nexport const L = ({ items }) => <ul {...props(o)}>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>;\n";
  assert.deepEqual(findConstructs(clean, 'x.jsx'), []);
  const idiomatic = [
    'export const L = ({ items }) => <ul>{items.map((item, index) => <li key={item.id}>{items[index].name}</li>)}</ul>;',
    "const labels = { success: 'In stock', danger: 'Sold out' };\nexport const B = ({ status }) => <span>{labels[status]}</span>;",
    'const counts = {};\nexport function count(k) { counts[k] = (counts[k] ?? 0) + 1; }',
    'export const onKey = (e) => { const handlers = { Enter: () => {} }; handlers[e.key]?.(); };',
    'export const index = (items) => items.reduce((acc, item) => { acc[item.id] = item; return acc; }, {});',
    'export function L({ items }) { const refs = useRef([]); return items.map((x, i) => <li key={x} ref={(el) => { refs.current[i] = el; }} />); }',
    'export const add = (a) => (b) => a + b;\nexport const three = add(1)(2);',
    'export function f(obj, k) { obj[k] = 1; }',
    'export const byId = (items) => items.reduce((acc, item) => Object.assign(acc, { [item.id]: item }), {});',
    "export function L({ items }) { const refs = useRef([]); return items.map((it, i) => <li key={it.id} tabIndex={-1} ref={(el) => { refs.current[i] = el; }} onKeyDown={(e) => { if (e.key === 'Enter') refs.current[(i + 1) % items.length]?.focus(); }}>{it.name}</li>); }",
    'export const Icon = () => <svg width={16} height={16} color="red"><rect width={2} height={2} /></svg>;',
    'function IconPath() { return <path color="currentColor" d="M0 0" />; }\nexport const Icon = () => <svg><IconPath /></svg>;',
    'export const Meta = () => <product-meta text="sku-123" color="blue" width={3} />;',
    "import { useRef as useNodeRefs } from 'react';\nexport function L({ items }) { const refs = useNodeRefs(new Array(items.length)); return items.map((it, i) => <li key={it.id} ref={(el) => { refs.current[i] = el; }} onKeyDown={() => refs.current[(i + 1) % items.length]?.focus()} />); }",
  ];
  for (const code of idiomatic)
    assert.deepEqual(findConstructs(code, 'x.jsx'), [], code);
});
