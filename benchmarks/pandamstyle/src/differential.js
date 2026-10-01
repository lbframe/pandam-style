#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle differential oracle.
 *
 * `babel_current` is the current compiler with work elimination disabled.
 * `babel_work_eliminated` must be indistinguishable from it, on:
 *
 *   - build success / failure
 *   - PMS diagnostic codes, count, and per-diagnostic source location
 *   - coverage: which files were analysed, and the expected-vs-analysed verdict
 *   - registry identity (systemId + registryDigest)
 *   - manifest semantics
 *   - compiled JS semantics
 *   - CSS text and its hash
 *   - runtime composition behaviour (the emitted props()/recipe references)
 *
 * WHAT COMPARED, AND WHAT DELIBERATELY NOT
 *
 * CSS is compared BYTE FOR BYTE, and cascade-relevant ordering is never
 * normalised away. Sorting rules, grouping them, or stripping whitespace would
 * hide exactly the class of regression a CSS backend optimization causes. The
 * only normalisation applied anywhere is the absolute project path, which
 * differs per engine because each build publishes into its own directory; it is
 * replaced by a fixed token AFTER the comparison-relevant content is extracted,
 * and both sides are replaced identically.
 *
 * Compiled JS is compared by a structural normalisation: the engines may not
 * reformat, but the check is on module exports, imported bindings, and the
 * literal class-name / recipe-reference payloads, because those are what the
 * runtime consumes. A raw text comparison is ALSO run and reported, and any
 * difference in it is surfaced as a finding rather than swallowed.
 *
 * A FAILURE IS A FAILURE. The oracle exits non-zero if any pair differs, and it
 * never reports a "close enough" verdict.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Runs one build in a child process and returns everything observable. */
function runBuild({ engineRoot, projectDir, configRel }) {
  const compilerPackage = path.join(engineRoot, 'packages', 'compiler');
  if (!fs.existsSync(path.join(compilerPackage, 'package.json'))) {
    throw new Error(
      `No PandamStyle compiler package found under ${engineRoot}`,
    );
  }
  const res = spawnSync(
    process.execPath,
    [path.join(compilerPackage, 'bin', 'pms-build.js'), '--config', configRel],
    {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PMS_WORK_ELIMINATED: process.env.__PMS_WE ? '1' : '',
      },
      timeout: 600000,
    },
  );
  const stderr = res.stderr ?? '';
  const jsonLine = stderr
    .split('\n')
    .filter((l) => l.startsWith('PMS_JSON:'))
    .pop();
  let diagnostics = null;
  if (jsonLine != null) {
    try {
      diagnostics = JSON.parse(jsonLine.slice('PMS_JSON:'.length));
    } catch {
      diagnostics = null;
    }
  }
  return {
    exit: res.status,
    signal: res.signal ?? null,
    stdout: res.stdout ?? '',
    diagnostics,
  };
}

function readTree(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  const walk = (d, base = dir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, base);
      else if (e.isFile())
        out.set(path.relative(base, abs), fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

/** The stable, path-independent view of one engine's published generation. */
function fingerprint(dir, projectDir) {
  const tree = readTree(dir);
  const files = {};
  for (const [rel, buf] of [...tree.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    files[rel] = {
      bytes: buf.length,
      sha256: sha256(buf),
    };
  }
  const read = (rel) => {
    const buf = tree.get(rel);
    return buf == null ? null : buf.toString('utf8');
  };

  const css = read('styles.css');
  const manifest = read('manifest.json');
  const report = read('build-report.json');
  const generated = read('design.pandamstyle.js');

  // A compiled-JS digest over the emitted module text, per file, and one over
  // the whole set. Both raw and normalised, because they answer different
  // questions: "did the bytes change" and "did the emitted program change".
  const jsFiles = [...tree.keys()].filter((k) => k.startsWith('js/')).sort();
  const js = {};
  for (const rel of jsFiles) js[rel] = sha256(tree.get(rel));

  // Structural view of the emitted program: the class-name literals and recipe
  // references the runtime actually consumes. This is what "same runtime
  // composition behaviour" means, stated as something checkable.
  const structural = {};
  for (const rel of jsFiles) {
    const text = tree.get(rel).toString('utf8');
    structural[rel] = {
      classLiterals: [...new Set(text.match(/x[0-9a-z]{6,}/g) ?? [])].sort(),
      stylexCalls: (text.match(/__pmsProps|__cssProps/g) ?? []).length,
      recipeRefs: (text.match(/__pmsRecipe_[A-Za-z0-9_]+/g) ?? []).length,
      importSpecifiers: (text.match(/from\s+"([^"]+)"/g) ?? []).sort(),
    };
  }

  const abs = (s) =>
    s == null ? s : String(s).split(projectDir).join('<PROJECT>');

  return {
    files,
    css: {
      bytes: css == null ? 0 : Buffer.byteLength(css, 'utf8'),
      sha256: css == null ? null : sha256(Buffer.from(css, 'utf8')),
      // Cascade-relevant order is part of the value: the first and last rules,
      // and the full ordered rule list, are compared as text.
      text: abs(css),
    },
    manifest: manifest == null ? null : JSON.parse(abs(manifest)),
    buildReport: report == null ? null : parseReport(abs(report)),
    generatedModule:
      generated == null ? null : sha256(Buffer.from(abs(generated), 'utf8')),
    generatedModuleText: abs(generated),
    js,
    structural,
  };
}

function parseReport(text) {
  try {
    const r = JSON.parse(text);
    return {
      documentKind: r.documentKind,
      contractVersion: r.contractVersion,
      systemId: r.systemId,
      registryDigest: r.registryDigest,
      coveredFileCount: r.coveredFileCount,
      analysedFileCount: r.analysedFileCount,
      designSystemRuleCount: r.designSystemRuleCount,
      consumerRuleCount: r.consumerRuleCount,
      ruleCount: r.ruleCount,
      cssBytes: r.cssBytes,
      coveredFiles: (r.coverage ?? []).map((c) => c.file).sort(),
      coverageConsistency: r.coverageConsistency,
      externalRequests: r.externalRequests,
      relayEdges: r.relayEdges,
    };
  } catch {
    return null;
  }
}

/** Everything about a negative build that must match the reference. */
function negativeFingerprint(run, projectDir) {
  const d = run.diagnostics;
  if (d == null) return { exit: run.exit, diagnostics: null };
  return {
    exit: run.exit,
    ok: d.ok,
    diagnosticCount: d.diagnosticCount,
    codes: (d.diagnostics ?? []).map((x) => x.code).sort(),
    // Location is compared RELATIVE to the project, so a path difference
    // between two checkouts is not a finding, but a line or column difference is.
    diagnostics: (d.diagnostics ?? [])
      .map((x) => ({
        code: x.code,
        phase: x.phase,
        rule: x.rule,
        severity: x.severity,
        line: x.location?.line ?? null,
        column: x.location?.column ?? null,
        role: x.location?.role ?? null,
        source:
          x.source == null
            ? null
            : String(JSON.stringify(x.source))
                .split(projectDir)
                .join('<PROJECT>'),
        context: normaliseContext(x.context, projectDir),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

function normaliseContext(ctx, projectDir) {
  if (ctx == null) return null;
  const out = {};
  for (const k of Object.keys(ctx).sort()) {
    const v = ctx[k];
    out[k] = typeof v === 'string' ? v.split(projectDir).join('<PROJECT>') : v;
  }
  return out;
}

function diffPaths(a, b, prefix = '', out = []) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of [...keys].sort()) {
    const va = a?.[k];
    const vb = b?.[k];
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (va === undefined && vb === undefined) continue;
    if (va === undefined || vb === undefined) {
      out.push({ path: p, a: va, b: vb, kind: 'missing-on-one-side' });
      continue;
    }
    if (
      typeof va === 'object' &&
      va !== null &&
      typeof vb === 'object' &&
      vb !== null
    ) {
      diffPaths(va, vb, p, out);
      continue;
    }
    if (va !== vb) out.push({ path: p, a: va, b: vb, kind: 'value' });
  }
  return out;
}

/**
 * Compares the two engines on one project.
 * `configRel` is relative to the project directory.
 */
function compareProject({
  projectDir,
  configRel,
  label,
  outDirRel,
  expect = 'ok',
}) {
  const currentRoot = REPO_ROOT;
  const variantRoot = REPO_ROOT;

  const outRel = outDirRel ?? '.pandamstyle';
  const results = {};
  for (const [name, root, we] of [
    ['babel_current', currentRoot, false],
    ['babel_work_eliminated', variantRoot, true],
  ]) {
    // Each engine publishes into its own copy, so neither can observe or
    // disturb the other's artifacts. The copy lives OUTSIDE the project: a
    // copy inside it would be a subdirectory of its own source, which `cp`
    // refuses and which would in any case put the oracle's scratch space
    // inside the thing being measured.
    const stage = path.join(
      path.dirname(projectDir),
      `.stage-${name}-${path.basename(projectDir)}`,
    );
    rmrf(stage);
    fs.cpSync(projectDir, stage, {
      recursive: true,
      filter: (src) =>
        !src.includes(`${path.sep}.stage-`) &&
        !src.includes(`${path.sep}node_modules`),
    });
    // The design system resolves `@pandamstyle/compiler`; point it at the
    // engine's own package so the definition is loaded by the same code that
    // compiles it.
    const scope = path.join(stage, 'node_modules', '@pandamstyle');
    fs.mkdirSync(scope, { recursive: true });
    const link = path.join(scope, 'compiler');
    if (fs.existsSync(link)) fs.rmSync(link, { force: true });
    const compilerPackage = path.join(root, 'packages', 'compiler');
    if (!fs.existsSync(path.join(compilerPackage, 'package.json'))) {
      throw new Error(`No PandamStyle compiler package found under ${root}`);
    }
    fs.symlinkSync(compilerPackage, link, 'dir');

    process.env.__PMS_WE = we ? '1' : '';
    const run = runBuild({ engineRoot: root, projectDir: stage, configRel });
    results[name] = {
      run,
      fingerprint:
        run.exit === 0 ? fingerprint(path.join(stage, outRel), stage) : null,
      stage,
    };
  }
  delete process.env.__PMS_WE;

  const a = results.babel_current;
  const b = results.babel_work_eliminated;
  const findings = [];

  // EXPECTATION GATE, checked against the REFERENCE engine first.
  //
  // Equivalence between two engines is worthless if both of them are wrong: a
  // negative scenario where both engines quietly ACCEPTED the program would
  // compare as "equivalent" while the policy guarantee was broken. So the
  // reference engine's verdict is asserted against the scenario's declared
  // expectation BEFORE the two engines are compared.
  const referenceVerdict = a.run.exit === 0 ? 'accepted' : 'rejected';
  const expectedVerdict = expect === 'fail' ? 'rejected' : 'accepted';
  if (referenceVerdict !== expectedVerdict) {
    findings.push({
      severity: 'error',
      check: 'expectation',
      detail:
        `the reference engine ${referenceVerdict} a program the scenario ` +
        `expects to be ${expectedVerdict}. This is a broken scenario or a ` +
        'broken corpus, not an equivalence result, and it is reported as such ' +
        'rather than being folded into the comparison.',
      exit: a.run.exit,
      diagnostics: firstDiagnostic(a.run),
    });
  }

  if (a.run.exit !== b.run.exit) {
    findings.push({
      severity: 'error',
      check: 'build-verdict',
      detail: `exit status differs: current=${a.run.exit} work_eliminated=${b.run.exit}`,
      current: firstDiagnostic(a.run),
      work_eliminated: firstDiagnostic(b.run),
    });
    return { label, configRel, findings, current: a, work_eliminated: b };
  }

  if (a.run.exit !== 0) {
    // A negative case: the diagnostics themselves are the contract.
    const na = negativeFingerprint(a.run, a.stage);
    const nb = negativeFingerprint(b.run, b.stage);
    const d = diffPaths(na, nb);
    if (d.length > 0) {
      findings.push({
        severity: 'error',
        check: 'negative-diagnostics',
        detail: 'the two engines refused the program differently',
        differences: d.slice(0, 20),
      });
    }
    return {
      label,
      configRel,
      findings,
      current: a,
      work_eliminated: b,
      negative: true,
    };
  }

  const fa = a.fingerprint;
  const fb = b.fingerprint;
  const checks = [
    ['css-bytes', fa.css.sha256, fb.css.sha256],
    ['css-text', fa.css.text, fb.css.text],
    [
      'registry-digest',
      fa.manifest?.registryDigest,
      fb.manifest?.registryDigest,
    ],
    ['system-id', fa.manifest?.systemId, fb.manifest?.systemId],
    ['manifest', fa.manifest, fb.manifest],
    ['build-report', fa.buildReport, fb.buildReport],
    ['generated-design-system-module', fa.generatedModule, fb.generatedModule],
    ['compiled-js-bytes', fa.js, fb.js],
    ['runtime-composition-structure', fa.structural, fb.structural],
  ];
  for (const [name, va, vb] of checks) {
    const d =
      typeof va === 'string' || typeof vb === 'string'
        ? va === vb
          ? []
          : [{ path: name, a: shorten(va), b: shorten(vb), kind: 'value' }]
        : diffPaths(va, vb);
    if (d.length > 0) {
      findings.push({
        severity: 'error',
        check: name,
        detail: `${d.length} difference(s)`,
        differences: d.slice(0, 12),
      });
    }
  }

  return {
    label,
    configRel,
    findings,
    current: a,
    work_eliminated: b,
    negative: false,
  };
}

function shorten(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? null : s.length > 400 ? `${s.slice(0, 400)}...` : s;
}

function firstDiagnostic(run) {
  const d = run.diagnostics;
  if (d == null) return (run.stderr_tail ?? '').slice(0, 300);
  return (d.diagnostics ?? []).map(
    (x) => `${x.code}@${x.location?.file}:${x.location?.line}`,
  );
}

function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (!process.argv[i].startsWith('--')) continue;
    const eq = process.argv[i].indexOf('=');
    if (eq !== -1)
      args[process.argv[i].slice(2, eq)] = process.argv[i].slice(eq + 1);
    else {
      args[process.argv[i].slice(2)] = process.argv[i + 1];
      i++;
    }
  }
  for (const k of ['components', 'tokens', 'recipes', 'seed', 'fanout']) {
    if (args[k] != null) args[k] = Number(args[k]);
  }

  const corpusDir = path.resolve(args.corpus ?? '/tmp/pms-oracle-corpus');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-oracle-'));

  const { generate } = require('./generate-corpus');
  const manifest = generate({
    components: Number(args.components ?? 24),
    tokens: Number(args.tokens ?? 120),
    recipes: Number(args.recipes ?? 6),
    seed: Number(args.seed ?? 101),
    fanout: Number(args.fanout ?? 3),
    outDir: corpusDir,
    negative: true,
  });

  const { getScenario, SCENARIOS } = require('./scenarios');
  const wanted = args.scenarios
    ? args.scenarios.split(',').map((s) => s.trim())
    : SCENARIOS.filter((s) => s.kind !== 'not-implemented').map((s) => s.name);

  const results = [];
  for (const name of wanted) {
    const scenario = getScenario(name);
    // ONE project per scenario, with revisions applied CUMULATIVELY. A
    // two-revision scenario is a statement about one project's history
    // ("remove a token, then put it back"); giving each revision a pristine copy
    // would turn the second revision into a different scenario and would make
    // the pair meaningless.
    const projectDir = path.join(workDir, name);
    fs.cpSync(corpusDir, projectDir, { recursive: true });
    for (let rev = 0; rev < Math.max(1, scenario.revisions); rev++) {
      const edits = scenario.edit(projectDir, { revision: rev, iteration: 0 });
      for (const e of edits) {
        if (e.delete === true) fs.rmSync(e.path, { force: true });
        else {
          fs.mkdirSync(path.dirname(e.path), { recursive: true });
          fs.writeFileSync(e.path, e.content, 'utf8');
        }
      }
      // A negative scenario is driven by its OWN config, rooted at the file the
      // scenario violated, so the oracle compares the one verdict under test
      // rather than twenty incidental ones.
      const isNegativeOnly = scenario.expect === 'fail';
      const configRel = isNegativeOnly
        ? `oracle-negative-${rev}.config.js`
        : 'pandamstyle.config.js';
      if (isNegativeOnly) {
        fs.writeFileSync(
          path.join(projectDir, configRel),
          `module.exports = { definition: './design/design.pms.config.js', roots: ${JSON.stringify(
            rootsForScenario(projectDir, name, edits),
          )}, outDir: './.pandamstyle', runtimeModule: '@pandamstyle/compiler/runtime' };\n`,
        );
      }
      // The expectation of a multi-revision scenario applies to its LAST
      // revision; earlier revisions are intermediate states (a violation
      // introduced, a token removed) and are expected to be whatever they are.
      const expect =
        scenario.revisionExpect?.[rev] ??
        (rev === Math.max(1, scenario.revisions) - 1 ? scenario.expect : 'ok');
      results.push(
        compareProject({
          projectDir,
          configRel,
          label: `${name}#${rev}`,
          outDirRel: '.pandamstyle',
          expect,
        }),
      );
    }
  }

  const errors = results.flatMap((r) =>
    r.findings.map((f) => ({ scenario: r.label, ...f })),
  );
  const report = {
    documentKind: 'pandamstyle-differential-oracle',
    corpus: {
      name: manifest.name,
      contentHash: manifest.contentHash,
      sourceFiles: manifest.files.length,
    },
    reference: 'babel_current',
    variant: 'babel_work_eliminated',
    scenariosCompared: results.length,
    checksPerScenario: [
      'build-verdict',
      'negative-diagnostics (codes, locations, rules, context)',
      'css-bytes (byte identical, ordering preserved)',
      'css-text',
      'registry-digest',
      'system-id',
      'manifest',
      'build-report (coverage, consistency, external requests, relay edges)',
      'generated-design-system-module',
      'compiled-js-bytes',
      'runtime-composition-structure',
    ],
    expectationsChecked: results.length,
    verdict: errors.length === 0 ? 'equivalent' : 'divergent',
    errors,
  };

  for (const r of results) {
    for (const e of [r.current, r.work_eliminated]) {
      if (e?.stage != null) rmrf(e.stage);
    }
  }

  const out = args.out
    ? path.resolve(args.out)
    : path.join(workDir, 'differential.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(
    `${JSON.stringify({ verdict: report.verdict, scenarios: results.length, errors: errors.length, report: out }, null, 2)}\n`,
  );
  if (errors.length > 0) {
    process.stderr.write(`${JSON.stringify(errors.slice(0, 5), null, 2)}\n`);
  }
  rmrf(workDir);
  process.exit(errors.length === 0 ? 0 : 1);
}

/**
 * The covered root for a negative scenario.
 *
 * Rooted at the file the scenario actually edited, so the build reports the ONE
 * violation under test. Rooting the whole directory would report every
 * violation in the corpus at once and the comparison would be about a count
 * rather than about the diagnostic.
 */
function rootsForScenario(projectDir, scenarioName, edits) {
  const touched = (edits ?? [])
    .map((e) => e.path)
    .filter(
      (p) =>
        p != null && p.startsWith(path.join(projectDir, 'src', 'components')),
    )
    .map((p) => path.relative(projectDir, p).split(path.sep).join('/'));
  if (touched.length === 0) return ['./src/components'];
  // policy_global is intentionally many files: its whole point is the shape of
  // a global failure, so its root stays the directory.
  if (scenarioName === 'policy_global') return ['./src/components'];
  return touched.map((p) => `./${p}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  compareProject,
  fingerprint,
  negativeFingerprint,
  diffPaths,
};
