/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  openProject,
} = require('../../packages/compiler/__tests__/pandamstyle/session-helpers');
const DS = '../generated/design.pandamstyle';
const named = `export { create, token } from '${DS}';\n`;
const ordinary =
  'export const create = (x) => x; export const token = (x) => x;\n';
const style = (c = 'create', t = 'token') =>
  `export const probe = ${c}({ a: { padding: ${t}('spacing.md') } });\n`;
const consumer = (
  imports = 'create, token',
  body = style(),
  source = './relay',
) => `import { ${imports} } from '${source}';\n${body}`;
const APIs = ['create', 'token', 'props', 'recipes', 'themes'];
const expected = (bindings, shape = 'style', diagnostics = []) => ({
  bindings,
  ok: diagnostics.length === 0,
  diagnostics,
  shape,
});
const ct = { create: 'create', token: 'token' };
const rejected = (bindings, code = 'PMS_FORBIDDEN_IMPORT') =>
  expected(bindings, 'rejected', [code]);
const cases = [
  {
    name: 'direct import',
    source: consumer('create, token', style(), DS),
    relay: '',
    expected: expected(ct),
  },
  {
    name: 'named source re-export',
    relay: named,
    expected: expected(ct),
    revisions: [
      {
        name: 'removed export',
        relay: `export { create } from '${DS}';\n`,
        expected: rejected({ create: 'create' }),
      },
      { name: 'restored export', relay: named, expected: expected(ct) },
    ],
  },
  {
    name: 'renamed source re-export',
    relay: `export { create as css, token as t } from '${DS}';\n`,
    source: consumer('css, t', style('css', 't')),
    expected: expected({ css: 'create', t: 'token' }),
  },
  {
    name: 'local import + re-export',
    relay: `import { create, token } from '${DS}'; export { create, token };\n`,
    expected: expected(ct),
  },
  {
    name: 'local import + renamed re-export',
    relay: `import { create as local, token } from '${DS}'; export { local as css, token };\n`,
    source: consumer('css, token', style('css')),
    expected: expected({ css: 'create', token: 'token' }),
  },
  {
    name: 'export star',
    relay: `export * from '${DS}';\n`,
    expected: expected(ct),
  },
  {
    name: 'namespace source re-export',
    relay: `export * as pms from '${DS}';\n`,
    source: consumer('pms', style('pms.create', 'pms.token')),
    expected: expected({ 'pms.create': 'create', 'pms.token': 'token' }),
  },
  {
    name: 'namespace import + export',
    relay: `import * as pms from '${DS}'; export { pms };\n`,
    source: consumer('pms', style('pms.create', 'pms.token')),
    expected: expected({ 'pms.create': 'create', 'pms.token': 'token' }),
  },
  {
    name: 'multi-hop named forwarding',
    files: { 'a.js': named },
    relay: "export { create, token } from './a';\n",
    expected: expected(ct),
  },
  {
    name: 'multi-hop renamed forwarding',
    files: {
      'a.js': `export { create as define, token as t } from '${DS}';\n`,
    },
    relay: "export { define as css, t as token } from './a';\n",
    source: consumer('css, token', style('css')),
    expected: expected({ css: 'create', token: 'token' }),
  },
  {
    name: 'multi-hop star forwarding',
    files: { 'a.js': `export * from '${DS}';\n` },
    relay: "export * from './a';\n",
    expected: expected(ct),
  },
  {
    name: 'partial forwarding',
    relay: `export { create } from '${DS}';\n`,
    expected: rejected({ create: 'create' }),
  },
  {
    name: 'same exported spelling before remap',
    relay: `export { create as css } from '${DS}';\n`,
    source: consumer(
      'css',
      "export const probe = css({ a: { display: 'flex' } });\n",
    ),
    expected: expected({ css: 'create' }),
    revisions: [
      {
        name: 'same exported spelling remapped',
        relay: `export { token as css } from '${DS}';\n`,
        expected: rejected({ css: 'token' }, 'PMS_NON_STATIC_VALUE'),
      },
      {
        name: 'same exported spelling restored',
        relay: `export { create as css } from '${DS}';\n`,
        expected: expected({ css: 'create' }),
      },
    ],
  },
  {
    name: 'mixed source barrel',
    files: { 'ordinary.js': ordinary },
    relay: `export { create } from '${DS}'; export { token } from './ordinary';\n`,
    expected: rejected({ create: 'create' }, 'PMS_NON_STATIC_VALUE'),
  },
  {
    name: 'non-PandamStyle same-name export',
    files: { 'ordinary.js': ordinary },
    relay: "export { create, token } from './ordinary';\n",
    expected: expected({}, 'ordinary'),
  },
  {
    name: 'relay before break',
    files: { 'ordinary.js': ordinary },
    relay: named,
    expected: expected(ct),
    revisions: [
      {
        name: 'relay break',
        relay: "export { create, token } from './ordinary';\n",
        expected: expected({}, 'ordinary'),
      },
      { name: 'relay restore', relay: named, expected: expected(ct) },
      {
        name: 'relay file removal',
        remove: 'relay.js',
        expected: rejected({}, 'PMS_COVERAGE_GAP'),
      },
      { name: 'relay file restoration', relay: named, expected: expected(ct) },
    ],
  },
  {
    name: 'deep negative answer',
    files: {
      'a.js': "export { create, token } from './ordinary';\n",
      'ordinary.js': ordinary,
    },
    relay: "export { create, token } from './a';\n",
    expected: expected({}, 'ordinary'),
    revisions: [
      {
        name: 'deep negative repair',
        files: { 'a.js': named },
        expected: expected(ct),
      },
    ],
  },
  {
    name: 'star collision',
    files: { 'ordinary.js': ordinary },
    relay: `export * from '${DS}'; export * from './ordinary';\n`,
    expected: rejected({}),
  },
  {
    name: 'star explicit override',
    files: { 'ordinary.js': ordinary },
    relay: `export * from './ordinary'; export * from '${DS}'; export { create, token } from '${DS}';\n`,
    expected: expected(ct),
  },
  {
    name: 'star same-origin diamond',
    files: { 'a.js': named, 'b.js': named },
    relay: "export * from './a'; export * from './b';\n",
    expected: expected(ct),
  },
  {
    name: 'star after renamed forwarding',
    files: { 'a.js': `export { create as css, token as t } from '${DS}';\n` },
    relay: "export * from './a';\n",
    source: consumer('css, t', style('css', 't')),
    expected: expected({ css: 'create', t: 'token' }),
  },
  {
    name: 'namespace of partial renamed barrel',
    files: { 'a.js': `export { create as css, token as t } from '${DS}';\n` },
    relay: "export * as pms from './a';\n",
    source: consumer('pms', style('pms.css', 'pms.t')),
    expected: expected({ 'pms.css': 'create', 'pms.t': 'token' }),
  },
  {
    name: 'direct namespace import',
    relay: named,
    source: `import * as pms from '${DS}';\n${style('pms.create', 'pms.token')}`,
    expected: expected({ 'pms.create': 'create', 'pms.token': 'token' }),
  },
  {
    name: 'default as foo is absent',
    relay: `export { default as foo } from '${DS}';\n`,
    source: consumer('foo', 'export const probe = foo;\n'),
    expected: rejected({}),
  },
  {
    name: 'default forwarding is absent',
    relay: `export { default } from '${DS}';\n`,
    source: "import foo from './relay'; export const probe = foo;\n",
    expected: rejected({}),
  },
  {
    name: 'metadata alias has no helper authority',
    relay: `export { manifest as create, __pandamstyle as token } from '${DS}';\n`,
    expected: expected({}, 'ordinary'),
  },
  {
    name: 'namespace partial forwarding rejects missing token',
    relay: `export { create } from '${DS}';\n`,
    source: `import * as pms from './relay';\n${style('pms.create', 'pms.token')}`,
    expected: rejected({ 'pms.create': 'create' }, 'PMS_NON_STATIC_VALUE'),
  },
  {
    name: 'direct token alias lowers',
    relay: `export { token as t } from '${DS}';\n`,
    source: consumer('t', "export const probe = t('spacing.md');\n"),
    expected: expected({ t: 'token' }, 'token'),
  },
  {
    name: 'transitive star collision stays ambiguous',
    files: {
      'a.js': `export * from '${DS}'; export * from './ordinary';\n`,
      'ordinary.js': ordinary,
    },
    relay: `export * from './a'; export * from '${DS}';\n`,
    expected: rejected({}),
  },
  {
    name: 'ordinary destructured exports collide',
    files: {
      'ordinary.js':
        'export const { create, token } = { create: 1, token: 2 };\n',
    },
    relay: `export * from '${DS}'; export * from './ordinary';\n`,
    expected: rejected({}),
  },
  {
    name: 'unknown external star fails closed',
    relay: `export * from '${DS}'; export * from 'unknown-library';\n`,
    expected: rejected({}),
  },
  {
    name: 'star cycle fails closed',
    files: { 'a.js': "export * from './relay';\n" },
    relay: `export * from '${DS}'; export * from './a';\n`,
    expected: rejected({}),
  },
  {
    name: 'resolution candidate appears',
    files: { 'a.js': named },
    relay: "export { create, token } from './a';\n",
    expected: expected(ct),
    revisions: [
      {
        name: 'earlier resolution candidate replaces origin',
        files: { 'a.ts': ordinary },
        expected: expected({}, 'ordinary'),
      },
      {
        name: 'earlier candidate removed restores origin',
        remove: 'a.ts',
        expected: expected(ct),
      },
    ],
  },
  {
    name: 'first-hop candidate before replacement',
    relay: named,
    expected: expected(ct),
    revisions: [
      {
        name: 'first-hop earlier candidate replaces origin',
        files: { 'relay.ts': ordinary },
        expected: expected({}, 'ordinary'),
      },
      {
        name: 'first-hop earlier candidate removal restores origin',
        remove: 'relay.ts',
        expected: expected(ct),
      },
    ],
  },
];

// Query precisely the paths used by each consumer; fixture expectations above
// are handwritten, never derived from a fresh compiler result.
function queriedBindings(source, bindings) {
  const result = {};
  const imports =
    source
      .match(/import \{ ([^}]+) \}/)?.[1]
      ?.split(',')
      .map((s) => s.trim()) ?? [];
  const namespace = source.match(/import \* as (\w+)/)?.[1];
  const visit = (items, prefix = '') => {
    for (const b of items) {
      const name = prefix + b.exported;
      if (b.kind === 'namespace') visit(b.members ?? [], `${name}.`);
      else if (
        b.designSystem &&
        APIs.includes(b.imported) &&
        source.includes(name)
      )
        result[name] = b.imported;
    }
  };
  if (namespace) visit(bindings, `${namespace}.`);
  else visit(bindings.filter((b) => imports.includes(b.exported)));
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function resultOf(h, source, bindings, ok, diagnostics) {
  const codes = [...new Set(diagnostics.map((d) => d.code))].sort();
  const code = ok
    ? fs.readFileSync(path.join(h.outDir, 'js/src/consumer.js'), 'utf8')
    : null;
  return {
    bindings: queriedBindings(source, bindings),
    ok,
    diagnostics: codes,
    shape: !ok
      ? 'rejected'
      : code.includes('$$css') ||
          code.includes('pandamstyle-style-ref') ||
          code.includes('pandamstyle-theme-ref')
        ? 'style'
        : code.includes('var(--')
          ? 'token'
          : 'ordinary',
  };
}

function runCase(fixture) {
  const h = openProject('valid');
  fs.rmSync(h.src('src'), { recursive: true });
  fs.mkdirSync(h.src('src'));
  // The generated API is a real input even for initially rejected fixtures.
  // Failed builds do not publish it; seed it from the actual generator so the
  // subsequent read-only fresh map audit sees the same API as both compilers.
  fs.mkdirSync(h.outDir, { recursive: true });
  const ds = h.compiler.buildDesignSystem(h.reloadDefinition());
  fs.writeFileSync(
    path.join(h.outDir, 'design.pandamstyle.js'),
    h.compiler.generateDesignSystemModule({
      designSystem: ds,
    }),
  );
  const source = fixture.source ?? consumer();
  fs.writeFileSync(h.src('src/consumer.js'), source);
  const write = (files) =>
    Object.entries(files).map(([name, text]) => {
      const file = h.src('src', name);
      fs.writeFileSync(file, text);
      return file;
    });
  write({ 'relay.js': fixture.relay, ...fixture.files });
  h.session.initialize();
  const rows = [];
  for (const [index, revision] of [
    fixture,
    ...(fixture.revisions ?? []),
  ].entries()) {
    if (index > 0) {
      const edits = { ...revision.files };
      if (revision.relay != null) edits['relay.js'] = revision.relay;
      const added = Object.keys(edits).filter(
        (f) => !fs.existsSync(h.src('src', f)),
      );
      const files = write(edits);
      const removed = revision.remove ? [h.src('src', revision.remove)] : [];
      for (const file of removed) fs.rmSync(file);
      h.session.applyAgentChanges({
        changed: files.filter((f) => !added.includes(path.basename(f))),
        added: added.map((f) => h.src('src', f)),
        removed,
        renamed: [],
      });
    }
    const validation = h.session.validate();
    for (const d of validation.diagnostics ?? []) {
      if (d.rule === 'module.forwarding') {
        assert(
          d.source &&
            d.code === 'PMS_FORBIDDEN_IMPORT' &&
            d.context.reason &&
            d.context.repairShape,
          'Forwarding diagnostics require source, code, rule, reason and repair shape',
        );
      }
    }
    if (validation.ok) h.session.compile();
    const cached = h.session.inspectForwarding(h.src('src/consumer.js'));
    const incremental = resultOf(
      h,
      source,
      cached[0]?.bindings ?? [],
      validation.ok,
      validation.diagnostics ?? [],
    );
    const incrementalCode = validation.ok
      ? fs.readFileSync(path.join(h.outDir, 'js/src/consumer.js'), 'utf8')
      : null;
    let freshOk = true,
      freshDiags = [];
    const request = source.match(/from ['"]([^'"]+)['"]/)?.[1];
    let info = null;
    try {
      h.full({
        onStage: ({ session }) => {
          info = session._withGraphContext(() =>
            h.compiler.resolveDesignSystemModule(
              h.src('src/consumer.js'),
              request,
            ),
          );
        },
      });
    } catch (err) {
      freshOk = false;
      freshDiags = err.diagnostics ?? [];
      if (!err.diagnostics) throw err;
    }
    const fresh = resultOf(
      h,
      source,
      info?.exportsOfRelay ?? [],
      freshOk,
      freshDiags,
    );
    const intended = {
      ...revision.expected,
      bindings: Object.fromEntries(
        Object.entries(revision.expected.bindings).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    };
    const freshExpected = JSON.stringify(fresh) === JSON.stringify(intended);
    const incrementalExpected =
      JSON.stringify(incremental) === JSON.stringify(intended);
    const equivalent =
      JSON.stringify(fresh) === JSON.stringify(incremental) &&
      (!freshOk ||
        incrementalCode ===
          fs.readFileSync(path.join(h.outDir, 'js/src/consumer.js'), 'utf8'));
    const views = h.session.verifyDesignSystemViews();
    rows.push({
      fixture: revision.name,
      expected: intended,
      freshActual: fresh,
      incrementalActual: incremental,
      freshMatchesExpected: freshExpected,
      incrementalMatchesExpected: incrementalExpected,
      freshEqualsIncremental: equivalent,
      viewsMatch: views.ok,
      viewDifferences: views.differences,
      verdict:
        freshExpected && incrementalExpected && equivalent && views.ok
          ? 'pass'
          : 'fail',
    });
  }
  h.session.close();
  return rows;
}

function runMatrix() {
  const rows = cases.flatMap(runCase);
  return {
    fixtureCount: rows.length,
    fresh: {
      passed: rows.filter((r) => r.freshMatchesExpected).length,
      failed: rows.filter((r) => !r.freshMatchesExpected).length,
    },
    incremental: {
      passed: rows.filter((r) => r.incrementalMatchesExpected).length,
      failed: rows.filter((r) => !r.incrementalMatchesExpected).length,
    },
    rows,
  };
}

if (require.main === module) {
  const report = runMatrix();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  assert(
    report.rows.every((r) => r.verdict === 'pass'),
    'Forwarding semantic matrix failed',
  );
}
module.exports = { cases, runCase, runMatrix };
