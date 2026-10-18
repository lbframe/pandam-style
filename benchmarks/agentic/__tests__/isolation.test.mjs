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
    render: { module: 'src/C.jsx', export: 'C', props: extra.props ?? {} },
    interactions: extra.interactions ?? [],
  });
}

const payload = (r) => {
  assert.equal(r.ok, true, r.error);
  return JSON.parse(r.payload);
};

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

test('agent code cannot import Node built-ins or harness modules', () => {
  const dir = workspace('builtins', {});
  for (const spec of [
    'node:fs',
    'fs',
    'node:child_process',
    'node:worker_threads',
    'pms-sandbox:registry',
    '/etc/passwd',
  ]) {
    const r = render(
      dir,
      `import x from ${JSON.stringify(spec)};\nexport function C() { return String(x); }\n`,
    );
    assert.equal(r.ok, false, spec);
    assert.match(r.error, /PMS_SANDBOX_DENIED_IMPORT/, spec);
  }
  const dynamic = render(
    dir,
    "const fs = await import('node:fs');\nexport function C() { return String(fs); }\n",
  );
  assert.match(dynamic.error, /PMS_SANDBOX_DENIED_IMPORT/);
});

test('code generation from strings is impossible and recorded', () => {
  const dir = workspace('codegen', {});
  for (const source of [
    "export function C() { return (() => {}).constructor('return 1')(); }\n",
    "export function C() { const make = Function; return make('return 1')(); }\n",
    "export function C() { return eval('1'); }\n",
  ]) {
    const r = render(dir, source);
    assert.equal(r.ok, false, source);
    assert.match(r.error, /Code generation from strings disallowed/, source);
  }
});

test('agent code cannot rewire the harness through prototypes', () => {
  const dir = workspace('prototype', {});
  const polluted = render(
    dir,
    "Object.prototype.status = 'ok';\nexport function C() { throw new Error('actual failure'); }\n",
  );
  assert.equal(polluted.ok, false);
  const frozen = render(
    dir,
    "export function C() { try { Array.prototype.push = () => 0; return 'patched'; } catch { return 'frozen'; } }\n",
  );
  assert.equal(payload(frozen).html, 'frozen');
});

test('style and DOM activity is traced dynamically, including refs, effects and handlers', () => {
  const dir = workspace('trace', {});
  const cases = {
    "export function C() { document.body.style.color = 'red'; return 'x'; }\n":
      /read document\.body\.style/,
    "import { jsx } from 'react/jsx-runtime';\nexport function C() { return jsx('div', { ref: (el) => { if (el) el[['st', 'yle'].join('')].color = 'red'; }, children: 'x' }); }\n":
      /element#div\.style/,
    "import { jsx } from 'react/jsx-runtime';\nimport { useEffect } from 'react';\nexport function C() { useEffect(() => { document.head.appendChild(document.createElement('style')); }); return jsx('div', { children: 'x' }); }\n":
      /createElement\(style\)/,
    "import { jsx } from 'react/jsx-runtime';\nexport function C() { return jsx('button', { onClick: (e) => { e.currentTarget.setAttribute('style', 'x'); }, children: 'x' }); }\n":
      /setAttribute/,
    "import { jsx } from 'react/jsx-runtime';\nexport function C() { return jsx('div', { ref: (el) => { if (el) el.addEventListener('click', () => { el.style.color = 'red'; }); }, children: 'x' }); }\n":
      /element#div\.style/,
    "import { jsx } from 'react/jsx-runtime';\nimport { useEffect } from 'react';\nexport function C() { useEffect(() => { setTimeout(() => { document.body.style.color = 'red'; }, 1000); }, []); return jsx('div', { children: 'x' }); }\n":
      /document\.body\.style/,
    "export function C() { new CSSStyleSheet(); return 'x'; }\n":
      /new CSSStyleSheet/,
  };
  for (const [source, pattern] of Object.entries(cases)) {
    const trace = payload(render(dir, source)).violations.join('\n');
    assert.match(trace, pattern, source);
  }
  const clean = payload(
    render(
      dir,
      "import { jsx } from 'react/jsx-runtime';\nexport function C({ items = ['a', 'b'] }) { return jsx('ul', { children: items.map((x, i) => jsx('li', { children: items[i] }, x)) }); }\n",
    ),
  );
  assert.deepEqual(clean.violations, []);
});

test('interactions dispatch only on rendered elements and bubble to rendered ancestors', () => {
  const dir = workspace('spies', {});
  const spy = {
    props: { onGo: { $pmsSpy: 'onGo' } },
    interactions: [{ testId: 'go', event: 'click' }],
  };
  const good = payload(
    render(
      dir,
      "import { jsx } from 'react/jsx-runtime';\nexport function C({ onGo }) { return jsx('span', { onClick: () => onGo(), children: jsx('button', { 'data-testid': 'go', children: 'Go' }) }); }\n",
      spy,
    ),
  );
  assert.deepEqual(
    good.interactions[0].candidates.map((c) => [c.outcome, c.calls.onGo]),
    [['dispatched', 1]],
  );
  const unused = payload(
    render(
      dir,
      "import { jsx } from 'react/jsx-runtime';\nexport function C({ onGo }) { const unused = jsx('button', { 'data-testid': 'go', onClick: onGo }); return jsx('button', { 'data-testid': 'go', children: 'Go' }); }\n",
      spy,
    ),
  );
  assert.deepEqual(
    unused.interactions[0].candidates.map((c) => c.outcome),
    ['no-handler'],
  );
  const early = payload(
    render(
      dir,
      "import { jsx } from 'react/jsx-runtime';\nexport function C({ onGo }) { onGo(); return jsx('button', { 'data-testid': 'go', children: 'Go' }); }\n",
      spy,
    ),
  );
  assert.equal(early.outside.onGo, 1);
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
    '(() => {}).constructor("x")();': ['dynamic-code'],
    "String.prototype.trim = () => '';": ['dynamic-code'],
    'export function f(obj, k) { obj[k] = 1; }': ['dynamic-code'],
    "export function f(n, k) { n[k].color = 'red'; }": ['dynamic-code'],
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
  ];
  for (const code of idiomatic)
    assert.deepEqual(findConstructs(code, 'x.jsx'), [], code);
});
