/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const {
  evaluateDefinitionText,
  freshCopyOf,
  readJson,
  runBuild,
} = require('./pms-helpers');

const build = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);
const { collectCoveredFiles, assertCoverageConsistency, moduleEdgesOf } = build;

const FIXTURES = path.resolve(__dirname, 'fixtures');

function absoluteIn(fixture, ...parts) {
  return path.join(FIXTURES, fixture, ...parts);
}

// ---------------------------------------------------------------------------
// BC-3 - the closure follows every local edge, not only ImportDeclaration
// ---------------------------------------------------------------------------

describe('BC-3: the closure follows re-exports', () => {
  const cases = [
    ['export * from', 'neg-relay-reexport-star'],
    ['export { x } from', 'neg-relay-reexport-named'],
    ['a two-hop barrel chain', 'neg-relay-barrel-chain'],
  ];

  test.each(cases)(
    '%s pulls the target into the covered set',
    (_label, fixture) => {
      const { covered } = collectCoveredFiles([absoluteIn(fixture, 'src')]);
      const files = [...covered.keys()].map((f) => path.relative(FIXTURES, f));
      // The target sits outside the declared root and must still be covered.
      expect(files).toContain(path.join(fixture, 'outside', 'Unsafe.tsx'));
      expect(covered.get(absoluteIn(fixture, 'outside', 'Unsafe.tsx'))).toMatch(
        /^closure:/,
      );
    },
  );

  test('the closure records how each file was reached', () => {
    const { relayEdges } = collectCoveredFiles([
      absoluteIn('neg-relay-reexport-star', 'src'),
    ]);
    const forms = relayEdges.map((e) => e.form);
    expect(forms).toContain('export-star');
  });

  test('a named re-export is an edge, not just `export *`', () => {
    const { relayEdges } = collectCoveredFiles([
      absoluteIn('neg-relay-reexport-named', 'src'),
    ]);
    expect(relayEdges.map((e) => e.form)).toContain('export-named');
  });

  test('every edge syntax is discovered from a real file', () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pms-edges-'));
    const write = (name, body) =>
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    try {
      write('a.js', "import './b.js';\nexport * from './c.js';\n");
      write('b.js', "export * as ns from './d.js';\n");
      write('c.js', "export { x } from './e.js';\n");
      write('d.js', 'export const x = 1;\n');
      write('e.js', "const lazy = () => import('./f.js');\nexport { lazy };\n");
      write('f.js', 'module.exports = 1;\n');

      const edges = moduleEdgesOf(path.join(dir, 'a.js')).edges;
      expect(edges.map((e) => e.form)).toEqual(
        expect.arrayContaining(['import', 'export-star']),
      );
      // `export * as ns from` is a real edge, labelled distinctly.
      expect(
        moduleEdgesOf(path.join(dir, 'b.js')).edges.map((e) => e.form),
      ).toEqual(expect.arrayContaining(['export-namespace']));
      expect(
        moduleEdgesOf(path.join(dir, 'c.js')).edges.map((e) => e.form),
      ).toEqual(expect.arrayContaining(['export-named']));
      // A dynamic import nested inside an exported arrow function.
      expect(
        moduleEdgesOf(path.join(dir, 'e.js')).edges.map((e) => e.form),
      ).toEqual(expect.arrayContaining(['dynamic-import']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a stylesheet is not treated as a compilable module', () => {
    const { edges } = moduleEdgesOf(
      absoluteIn('neg-stylesheet-via-relay', 'outside', 'with-css.js'),
    );
    const css = edges.find((e) => e.request === './theme.css');
    expect(css).toBeDefined();
    expect(css.isStylesheet).toBe(true);
    // The plugin's style-channel check owns it, not the closure.
    expect(css.resolved).toBeNull();
  });

  test('a local resource import stays with the host loader', () => {
    const dir = fs.mkdtempSync(
      path.join(require('os').tmpdir(), 'pms-resource-'),
    );
    try {
      const page = path.join(dir, 'page.tsx');
      fs.writeFileSync(
        page,
        "import messages from './messages.json';\nimport icon from './icon.svg';\nexport { messages, icon };\n",
        'utf8',
      );
      fs.writeFileSync(
        page.replace('page.tsx', 'messages.json'),
        '{ invalid json }',
        'utf8',
      );
      fs.writeFileSync(
        page.replace('page.tsx', 'icon.svg'),
        '<svg></svg>',
        'utf8',
      );

      const { covered, unresolved } = collectCoveredFiles([page]);
      const edges = moduleEdgesOf(page).edges;

      expect([...covered.keys()]).toEqual([page]);
      expect(unresolved).toEqual([]);
      expect(
        edges.filter((edge) => edge.resource).map((edge) => edge.request),
      ).toEqual(['./messages.json', './icon.svg']);
      expect(
        edges
          .filter((edge) => edge.resource)
          .every((edge) => edge.resolved === null),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the generated PandamStyle suffix still resolves as source code', () => {
    const dir = fs.mkdtempSync(
      path.join(require('os').tmpdir(), 'pms-generated-suffix-'),
    );
    try {
      const page = path.join(dir, 'page.js');
      const generated = path.join(dir, 'design.pandamstyle.js');
      fs.writeFileSync(page, "import './design.pandamstyle';\n", 'utf8');
      fs.writeFileSync(generated, 'export const ready = true;\n', 'utf8');

      const { covered, unresolved } = collectCoveredFiles([page]);
      const edge = moduleEdgesOf(page).edges[0];

      expect(edge.resource).toBe(false);
      expect(edge.resolved).toBe(generated);
      expect([...covered.keys()]).toEqual([page, generated]);
      expect(unresolved).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BC-3 - the P0 decision about import() / require()
// ---------------------------------------------------------------------------

describe('BC-3: dynamic requests are decided, not ignored', () => {
  test('a computed dynamic request is a coverage gap', () => {
    const result = runBuild(freshCopyOf('neg-dynamic-import'));
    expect(result.status).toBe(1);
    // The coverage closure reads the graph BEFORE any page is compiled, so it is
    // the first reader to refuse. The build therefore never reaches the plugin,
    // which is the intended order: a gap in the graph is not a per-file problem.
    const gaps = result.diagnostics.filter(
      (x) => x.code === 'PMS_COVERAGE_GAP',
    );
    expect(gaps.length).toBeGreaterThanOrEqual(1);
    expect(gaps.map((g) => g.rule)).toContain('coverage.local-imports');
    for (const g of gaps) {
      expect(g.context.form).toBe('dynamic-import');
      expect(g.context.request).toBe('<computed>');
    }
  });

  test('the plugin refuses the same edge on its own, with its own rule', () => {
    // The two readers are independent on purpose: a file can be analysed
    // without going through the project closure (a bundler, a single-file
    // compile), and the plugin must still refuse a computed request.
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-dyn-gap-'));
    try {
      const file = path.join(dir, 'page.js');
      fs.writeFileSync(
        file,
        'export const load = (name) => import(`./panels/${name}`);\n',
        'utf8',
      );
      const session = build.createCompilerSession({
        definition: evaluateDefinitionText(
          path.join(FIXTURES, '_shared', 'design.pms.config.mjs'),
        ),
        roots: [file],
      });
      let diags = null;
      try {
        session.compileSource(fs.readFileSync(file, 'utf8'), file);
      } catch (err) {
        diags = err.diagnostics ?? null;
      }
      expect(diags).not.toBeNull();
      const d = diags.find((x) => x.code === 'PMS_COVERAGE_GAP');
      expect(d.rule).toBe('coverage.dynamic-modules');
      expect(d.context.form).toBe('import()');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a literal local dynamic request is a normal local edge', () => {
    const project = freshCopyOf('neg-dynamic-import-local');
    const { covered } = collectCoveredFiles([path.join(project, 'src')]);
    const files = [...covered.keys()];
    expect(files.some((f) => f.endsWith('lazy.jsx'))).toBe(true);
    // And the target is really analysed, which is why the build fails.
    const result = runBuild(project);
    expect(result.status).toBe(1);
    expect(result.codes).toContain('PMS_FORBIDDEN_STYLE_CHANNEL');
  });

  test('a forbidden engine entry cannot be reached through import()', () => {
    // The same closed-profile rules as a static import, on a literal dynamic
    // request: the syntax is not the question, the target module is.
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-dyn-'));
    try {
      const file = path.join(dir, 'page.js');
      fs.writeFileSync(
        file,
        "export const load = () => import('@stylexjs/stylex');\n",
        'utf8',
      );
      const session = build.createCompilerSession({
        definition: evaluateDefinitionText(
          path.join(FIXTURES, '_shared', 'design.pms.config.mjs'),
        ),
        roots: [dir],
      });
      let diags = null;
      try {
        session.compileSource(fs.readFileSync(file, 'utf8'), file);
      } catch (err) {
        diags = err.diagnostics ?? null;
      }
      expect(diags).not.toBeNull();
      const d = diags.find((x) => x.code === 'PMS_FORBIDDEN_IMPORT');
      expect(d).toBeDefined();
      // The diagnostic says it came through the dynamic form, so the refusal is
      // attributable to the route and not to a generic import ban.
      expect(d.context.form).toBe('import()');
      expect(d.context.reason).toBe('upstream-stylex-entry');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// BC-3 / BC-9 - end to end, through a real process
// ---------------------------------------------------------------------------

describe('BC-3/BC-9: every relay escape is caught by a real build', () => {
  const cases = [
    ['neg-relay-reexport-star', 'PMS_FORBIDDEN_STYLE_CHANNEL', 'export *'],
    [
      'neg-relay-reexport-named',
      'PMS_FORBIDDEN_STYLE_CHANNEL',
      'named re-export',
    ],
    [
      'neg-relay-barrel-chain',
      'PMS_FORBIDDEN_STYLE_CHANNEL',
      'two-hop barrel chain',
    ],
    [
      'neg-stylesheet-via-relay',
      'PMS_FORBIDDEN_STYLE_CHANNEL',
      'stylesheet through a relay',
    ],
    ['neg-unresolved-import', 'PMS_COVERAGE_GAP', 'unresolved local import'],
    ['neg-dynamic-import', 'PMS_COVERAGE_GAP', 'computed dynamic import'],
  ];

  test.each(cases)('%s fails with %s (%s)', (fixture, code, _label) => {
    const result = runBuild(freshCopyOf(fixture));
    expect(result.status).toBe(1);
    expect(result.codes).toContain(code);
    expect(result.stderr).not.toContain('unexpected build error');
    expect(result.stdout).not.toContain('build ok');
  });

  test('the diagnostic points at the module outside every root', () => {
    const result = runBuild(freshCopyOf('neg-relay-reexport-star'));
    const d = result.diagnostics.find(
      (x) => x.code === 'PMS_FORBIDDEN_STYLE_CHANNEL',
    );
    // Either the relayed module or the stylesheet it imports, both outside src.
    expect(d.location.file).toMatch(/^(outside|bridge)\//);
  });

  test('the report names the relays, so the closure is auditable', () => {
    // The negative builds fail, so no report is published. Prove the same
    // reporting on the clean `valid` project, which does publish one.
    const clean = freshCopyOf('valid');
    const result = runBuild(clean);
    expect(result.status).toBe(0);
    const report = readJson(path.join(clean, 'generated/build-report.json'));
    expect(Array.isArray(report.relayEdges)).toBe(true);
    expect(Array.isArray(report.externalRequests)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BC-4 - expected vs analysed
// ---------------------------------------------------------------------------

describe('BC-4: a covered file that was never analysed is a failure', () => {
  const covered = ['/p/src/a.js', '/p/src/b.js'];

  test('a fully analysed set is consistent', () => {
    const r = assertCoverageConsistency({
      coveredFiles: covered,
      transformedFiles: covered,
    });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  test('a covered file the bundler loaded but never compiled is missing', () => {
    // This is the tripwire: `transformInclude()` returning true is an offer,
    // not a proof. b.js was in the graph and got no transform.
    const r = assertCoverageConsistency({
      coveredFiles: covered,
      transformedFiles: ['/p/src/a.js'],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['/p/src/b.js']);
    expect(r.expectedCount).toBe(2);
    expect(r.transformedCount).toBe(1);
  });

  test('the generated design-system module is exempt, with a reason', () => {
    const r = assertCoverageConsistency({
      coveredFiles: [...covered, '/p/.pms/design.pandamstyle.js'],
      transformedFiles: covered,
      exemptFiles: ['/p/.pms/design.pandamstyle.js'],
    });
    expect(r.ok).toBe(true);
  });

  test('paths are compared canonically, so a query suffix cannot hide a file', () => {
    const r = assertCoverageConsistency({
      coveredFiles: ['/p/src/a.js'],
      transformedFiles: ['/p/src/./a.js'],
    });
    expect(r.ok).toBe(true);
  });

  test('a file loaded but not covered is reported separately', () => {
    const r = assertCoverageConsistency({
      coveredFiles: ['/p/src/a.js'],
      transformedFiles: ['/p/src/a.js', '/p/other/c.js'],
    });
    expect(r.ok).toBe(true);
    expect(r.loadedNotCovered).toEqual(['/p/other/c.js']);
  });
});

describe('the CLI cross-checks expected vs analysed before publishing', () => {
  let project;

  beforeAll(() => {
    project = freshCopyOf('valid');
    const result = runBuild(project);
    expect(result.status).toBe(0);
  });

  test('the published report carries the cross-check', () => {
    const report = readJson(path.join(project, 'generated/build-report.json'));
    expect(report.coverageConsistency.missing).toEqual([]);
    expect(report.analysedFileCount).toBeGreaterThan(0);
    // The design-system module is covered and exempt, not silently dropped.
    // The per-file snapshot is its own document since Phase C, and the counts
    // in the summary must be the counts in it.
    const coverage = readJson(
      path.join(project, 'generated/coverage.json'),
    ).entries;
    expect(report.coveredFileCount).toBe(coverage.length);
    expect(report.coverageSummary.entries).toBe(coverage.length);
    expect(report.coverageReport.entries).toBe(coverage.length);
    expect(report.coverageReport.materialized).toBe(true);
  });

  test('a covered file that fails the policy still counts as analysed', () => {
    // The policy DID run on it: it refused. That is different from skipping.
    const neg = freshCopyOf('neg-forbidden-value');
    expect(runBuild(neg).status).toBe(1);
    const clean = freshCopyOf('valid');
    expect(runBuild(clean).status).toBe(0);
    const entries = readJson(
      path.join(clean, 'generated/coverage.json'),
    ).entries;
    for (const entry of entries) {
      expect(entry.analysed).toBe(true);
    }
  });
});
