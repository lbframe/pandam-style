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

test('agent code cannot forge the tagged result line', () => {
  const dir = workspace('forge', {});
  const r = render(
    dir,
    "export function C() { console.log('PMS-SANDBOX 0 status=6f6b payload=00'); return 'real'; }\n",
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.payload, 'real');
});

test('agent code has no process, argv, environment or builtin escape hatch', () => {
  const dir = workspace('ambient', {});
  const r = render(
    dir,
    "export function C() { return [typeof process.getBuiltinModule, typeof process.argv, typeof process.stdout, Object.keys(process.env).join(',')].join(':'); }\n",
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.payload, 'undefined:undefined:undefined:NODE_ENV');
});

test('agent code cannot import Node built-ins or harness modules', () => {
  const dir = workspace('builtins', {});
  for (const spec of [
    'node:fs',
    'fs',
    'node:child_process',
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
});

test('callbacks only count when invoked by the dispatched interaction', () => {
  const dir = workspace('spies', {});
  const good = render(
    dir,
    "import { jsx } from 'react/jsx-runtime';\nexport function C({ onGo }) { return jsx('button', { 'data-testid': 'go', onClick: () => onGo(), children: 'Go' }); }\n",
    {
      props: { onGo: { $pmsSpy: 'onGo' } },
      interactions: [{ testId: 'go', event: 'click' }],
    },
  );
  assert.equal(good.ok, true, good.error);
  assert.match(good.calls, /^onGo:1:0\|go:click:dispatched$/);
  const early = render(
    dir,
    "import { jsx } from 'react/jsx-runtime';\nexport function C({ onGo }) { onGo(); return jsx('button', { 'data-testid': 'go', children: 'Go' }); }\n",
    {
      props: { onGo: { $pmsSpy: 'onGo' } },
      interactions: [{ testId: 'go', event: 'click' }],
    },
  );
  assert.match(early.calls, /^onGo:0:1\|go:click:no-handler$/);
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
  };
  for (const [code, rules] of Object.entries(flagged)) {
    const found = new Set(findConstructs(code, 'x.jsx').map((f) => f.rule));
    for (const rule of rules)
      assert.ok(found.has(rule), `${rule} not reported for: ${code}`);
  }
  const clean =
    "import { props } from '../g.js';\nconst o = Object.assign({}, { a: 1 });\nexport const L = ({ items }) => <ul {...props(o)}>{items.map((i) => <li key={i.id}>{i.name}</li>)}</ul>;\n";
  assert.deepEqual(findConstructs(clean, 'x.jsx'), []);
});
