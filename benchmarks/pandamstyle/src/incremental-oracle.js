#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the INCREMENTAL-vs-FULL differential oracle (Spike 2).
 *
 * The authoritative correctness gate for the project session.
 *
 * For every revision of every scenario, in ONE project whose revisions are
 * cumulative:
 *
 *   1. apply the revision to the source tree;
 *   2. drive the project session (applyChanges / validate / compile) and
 *      capture what it PUBLISHED;
 *   3. rebuild the SAME bytes from scratch, in a FRESH PROCESS, with the
 *      unchanged full rebuild, and capture what it published;
 *   4. require the two to be identical.
 *
 * Step 3 is a separate process on purpose. A "fresh full rebuild" performed in
 * the same process as the session would share the module registry, the
 * compiler's own caches and the design system the session built - and would
 * therefore not be a fresh rebuild at all. It would be a second opinion from
 * the same memory, and the whole question is whether the session's memory is
 * sound.
 *
 * WHAT IS COMPARED
 *
 *   - the verdict (accepted / rejected), for every revision;
 *   - diagnostics: code, phase, rule, severity, line, column, role, source and
 *     context, for every rejected revision;
 *   - every published artifact, byte-compared per file after normalizing only
 *     publisher lifecycle ids in coverage metadata;
 *   - the generated design-system module, stylesheet (cascade-relevant order
 *     never normalised), manifest, and build report;
 *   - the build report's semantic state: the covered file set, the
 *     expected-vs-analysed verdict, the external requests, the relay edges;
 *   - runtime composition structure: the class literals, the
 *     `__pmsRecipe_*` references and the import specifiers the runtime
 *     actually consumes.
 *
 * Normalization removes the session-only `incremental` work block and the
 * publisher-assigned revision/generation ids in coverage metadata. Those ids
 * identify a publisher's lifecycle rather than the content. The coverage
 * entries, registry identity, and all other artifact bytes remain compared.
 *
 * A FAILURE IS A FAILURE. The oracle exits non-zero if any revision diverges
 * and never reports a "close enough" verdict.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPILER_PKG = path.join(REPO_ROOT, 'packages', 'compiler');
const COMPILER_SUPPORT = path.join(
  REPO_ROOT,
  '.pms-test-support',
  'compiler-inspection.cjs',
);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Remove session-only work data and normalize publisher-assigned report id. */
function stripIncrementalBlock(text) {
  const report = JSON.parse(text);
  delete report.incremental;
  if (report.coverageReport != null) report.coverageReport.revisionId = 0;
  return JSON.stringify(report, null, 2) + '\n';
}

function normaliseCoverageReport(text) {
  const report = JSON.parse(text);
  // Revision and generation ids identify a publisher's lifecycle. They differ
  // by construction between an incremental session and an isolated full build;
  // all coverage entries and registry identity remain byte-compared.
  report.revisionId = 0;
  report.generationId = null;
  return JSON.stringify(report, null, 2) + '\n';
}

function readTree(dir) {
  const out = new Map();
  const walk = (d, base = dir) => {
    if (!fs.existsSync(d)) return;
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

/** The stable, comparable view of one published generation. */
function fingerprint(dir) {
  const tree = readTree(dir);
  const files = {};
  const structural = {};
  for (const rel of [...tree.keys()].sort()) {
    let buf = tree.get(rel);
    if (rel === 'build-report.json') {
      buf = Buffer.from(stripIncrementalBlock(buf.toString('utf8')), 'utf8');
    } else if (rel === 'coverage.json') {
      buf = Buffer.from(normaliseCoverageReport(buf.toString('utf8')), 'utf8');
    }
    files[rel] = { bytes: buf.length, sha256: sha256(buf) };
    if (rel.startsWith('js/')) {
      const text = tree.get(rel).toString('utf8');
      structural[rel] = {
        classLiterals: [...new Set(text.match(/x[0-9a-z]{6,}/g) ?? [])].sort(),
        stylexCalls: (text.match(/__pmsProps|__cssProps/g) ?? []).length,
        recipeRefs: (text.match(/__pmsRecipe_[A-Za-z0-9_]+/g) ?? []).length,
        importSpecifiers: (text.match(/from\s+"([^"]+)"/g) ?? []).sort(),
      };
    }
  }
  const read = (rel) => {
    const buf = tree.get(rel);
    return buf == null ? null : buf.toString('utf8');
  };
  const reportText = read('build-report.json');
  let report = null;
  try {
    const r = JSON.parse(reportText);
    report = {
      documentKind: r.documentKind,
      contractVersion: r.contractVersion,
      systemId: r.systemId,
      registryDigest: r.registryDigest,
      coverageSummary: r.coverageSummary,
      coverageReport:
        r.coverageReport == null
          ? null
          : { ...r.coverageReport, revisionId: 0 },
      coveredRoots: r.coveredRoots,
      coveredFileCount: r.coveredFileCount,
      analysedFileCount: r.analysedFileCount,
      designSystemRuleCount: r.designSystemRuleCount,
      consumerRuleCount: r.consumerRuleCount,
      ruleCount: r.ruleCount,
      cssBytes: r.cssBytes,
      coverageConsistency: r.coverageConsistency,
      externalRequests: r.externalRequests,
      relayEdges: r.relayEdges,
    };
  } catch {
    report = null;
  }
  return {
    files,
    structural,
    css: sha256(tree.get('styles.css') ?? Buffer.alloc(0)),
    cssText: read('styles.css'),
    manifest:
      read('manifest.json') == null ? null : JSON.parse(read('manifest.json')),
    generatedModule: sha256(
      tree.get('design.pandamstyle.js') ?? Buffer.alloc(0),
    ),
    report,
  };
}

function diffPaths(a, b, prefix = '', out = []) {
  if (a === b) return out;
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of [...keys].sort()) {
    const va = a?.[k];
    const vb = b?.[k];
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (va === undefined && vb === undefined) continue;
    if (va === undefined || vb === undefined) {
      out.push({ path: p, kind: 'missing-on-one-side' });
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
    if (va !== vb) {
      out.push({
        path: p,
        kind: 'value',
        a: typeof va === 'string' ? va.slice(0, 200) : va,
        b: typeof vb === 'string' ? vb.slice(0, 200) : vb,
      });
    }
  }
  return out;
}

/**
 * Every string under `value`, with the project path replaced.
 *
 * An EMPTY project directory is the identity, not "split on nothing":
 * `String.split('')` splits a string into characters, and a comparison that
 * did that would report every diagnostic as different while the compilers
 * agreed perfectly.
 */
function scrub(value, projectDir) {
  if (typeof value === 'string') {
    return projectDir === ''
      ? value
      : value.split(projectDir).join('<PROJECT>');
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, projectDir));
  if (value != null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort())
      out[k] = scrub(value[k], projectDir);
    return out;
  }
  return value;
}

function normaliseDiagnostic(d, projectDir) {
  const clean = (s) =>
    s == null ? s : String(s).split(projectDir).join('<PROJECT>');
  return {
    code: d.code,
    phase: d.phase,
    rule: d.rule,
    severity: d.severity,
    line: d.location?.line ?? null,
    column: d.location?.column ?? null,
    role: d.location?.role ?? null,
    source: clean(
      d.location?.file == null ? d.source : String(d.location.file),
    ),
    message: clean(d.message),
    context: scrub(d.context, projectDir),
  };
}

/**
 * Diagnostics in a deterministic order.
 *
 * The list must already be normalised: normalising twice would re-scrub an
 * already-scrubbed string, and a diagnostic that names a token would then
 * differ between two compilers that emitted it identically.
 */
function sortDiagnostics(list) {
  return [...list].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

/** One fresh full rebuild, in its own process, from the bytes on disk. */
function freshFullRebuild(projectDir, configRel) {
  const runner = `
    const path = require('node:path');
    const { pathToFileURL } = require('node:url');
    const { buildProject } = require(process.argv[1]);
    const configPath = path.resolve(process.argv[2]);
    const config = require(configPath);
    (async () => {
      const definitionPath = path.resolve(config.definition);
      const imported = await import(pathToFileURL(definitionPath).href);
      buildProject({ ...config, definition: imported.default ?? imported });
      process.stdout.write(JSON.stringify({ ok: true, diagnostics: [] }));
    })().catch((error) => {
      const diagnostics = Array.isArray(error?.diagnostics) ? error.diagnostics : [];
      process.stdout.write(JSON.stringify({ ok: false, diagnostics }));
      process.stderr.write(error?.stack ?? String(error));
      process.exitCode = diagnostics.length > 0 ? 1 : 2;
    });
  `;
  const res = spawnSync(
    process.execPath,
    ['-e', runner, COMPILER_SUPPORT, configRel],
    {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 900000,
      env: { ...process.env },
    },
  );
  let result = null;
  try {
    result = JSON.parse(res.stdout);
  } catch {
    result = null;
  }
  return {
    ok: res.status === 0 && result?.ok === true,
    exit: res.status,
    diagnostics: result?.diagnostics ?? [],
    stderr: res.stderr ?? '',
  };
}

function linkCompiler(projectDir) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (fs.existsSync(link)) fs.rmSync(link, { recursive: true });
  fs.symlinkSync(COMPILER_PKG, link, 'dir');
}

function applyEdits(projectDir, edits) {
  for (const edit of edits ?? []) {
    if (edit.delete === true) {
      fs.rmSync(edit.path, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(edit.path), { recursive: true });
    fs.writeFileSync(edit.path, edit.content, 'utf8');
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq !== -1) {
      out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
    } else {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  for (const k of ['components', 'tokens', 'recipes', 'seed', 'fanout']) {
    if (out[k] != null) out[k] = Number(out[k]);
  }
  return out;
}

const PUBLISH_VARIANTS = [
  'session_full_publish',
  'session_incremental_publish',
  'session_incremental_publish_css',
];

async function main() {
  const args = parseArgs(process.argv);
  const variant = args.variant ?? 'session_full_publish';
  if (!PUBLISH_VARIANTS.includes(variant)) {
    process.stderr.write(
      `unknown --variant ${variant}; expected one of ${PUBLISH_VARIANTS.join(', ')}\n`,
    );
    process.exit(2);
  }
  const corpusDir = path.resolve(args.corpus ?? '/tmp/pms-incremental-oracle');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-inc-oracle-'));
  const previousCwd = process.cwd();

  const { generate } = require('./generate-corpus');
  const manifest = generate({
    components: args.components ?? 24,
    tokens: args.tokens ?? 120,
    recipes: args.recipes ?? 6,
    seed: args.seed ?? 101,
    fanout: args.fanout ?? 3,
    outDir: corpusDir,
    negative: true,
  });

  const { getScenario, SCENARIOS } = require('./scenarios');
  const wanted = args.scenarios
    ? args.scenarios.split(',').map((s) => s.trim())
    : SCENARIOS.filter((s) => s.kind !== 'not-implemented').map((s) => s.name);

  const compiler = require(COMPILER_SUPPORT);
  const revisions = [];
  let mismatches = 0;
  let errors = 0;

  for (const name of wanted) {
    const scenario = getScenario(name);
    const projectDir = path.join(workDir, name);
    fs.cpSync(corpusDir, projectDir, { recursive: true });
    linkCompiler(projectDir);

    // The session resolves paths RELATIVE TO THE PROCESS, exactly as the CLI
    // does, so the oracle runs from the project directory. Both builders then
    // embed the same relative paths and no path normalisation is needed.
    process.chdir(projectDir);
    try {
      const configPath = path.join(projectDir, 'pandamstyle.config.js');
      let config = require(configPath);
      const definitionPath = path.resolve(
        projectDir,
        path.dirname('./pandamstyle.config.js'),
        config.definition,
      );
      // The generated definition is an ES MODULE, and Node's ES module registry
      // is keyed by full URL and has no public invalidation API:
      // `delete require.cache[...]` is a no-op for it. Loading it with the same
      // bytes and the same object identity would make every design-system
      // scenario a no-op, and the session would then be judged on whether it
      // notices a change that was never delivered to it.
      let definitionNonce = 0;
      const loadDefinition = async () => {
        definitionNonce += 1;
        const href = pathToFileURL(definitionPath).href;
        const mod = await import(
          `${href}?pmsIncrementalOracle=${definitionNonce}`
        );
        return mod != null && mod.default != null ? mod.default : mod;
      };
      let definition = await loadDefinition();
      const options = () => ({
        definition,
        roots: (config.roots ?? []).map((r) => path.resolve(projectDir, r)),
        outDir: path.resolve(projectDir, config.outDir),
        runtimeModule: config.runtimeModule,
        designSystemFile: config.designSystemFile,
        engineOptions: config.engineOptions,
        useCSSLayers: config.useCSSLayers === true,
        // Which publication strategy the subject drives. The fresh rebuild
        // below NEVER receives this: it is the reference, and it must publish
        // the way a fresh rebuild publishes.
        publishVariant: variant,
      });

      const session = compiler.createProjectSession(options());
      const outDir = options().outDir;
      const total = Math.max(1, scenario.revisions);
      let configRel = 'pandamstyle.config.js';

      // The session is established on the PRISTINE project, exactly as an agent
      // loop establishes it, and that establishing revision is itself compared
      // against a fresh full rebuild. A session that only ever sees its first
      // revision is not a session.
      session.initialize();
      const seedValidation = session.validate();
      if (seedValidation.ok) {
        // A one-shot full build materializes coverage before publishing. Ask
        // the session for the same document before its commit so this oracle
        // compares like-for-like generations.
        session.requestFullAudit({});
        session.compile();
      }
      if (seedValidation.ok) {
        const seedIncremental = fingerprint(outDir);
        definition = await loadDefinition();
        const seedFull = freshFullRebuild(projectDir, 'pandamstyle.config.js');
        const findings = [];
        if (!seedFull.ok) {
          findings.push({
            check: 'verdict',
            detail: 'the full rebuild of the pristine project failed',
          });
        } else {
          const d = diffPaths(seedIncremental.files, fingerprint(outDir).files);
          if (d.length > 0) {
            findings.push({
              check: 'published-artifacts',
              differences: d.slice(0, 8),
            });
          }
        }
        if (findings.length > 0) mismatches += 1;
        revisions.push({
          scenario: name,
          revision: 'seed',
          sessionVerdict: seedValidation.ok ? 'accepted' : 'rejected',
          fullVerdict: seedFull.ok ? 'accepted' : 'rejected',
          sessionCounters: seedValidation.counters,
          equivalent: findings.length === 0,
          findings,
        });
        process.stdout.write(
          `${findings.length === 0 ? 'ok  ' : 'FAIL'} ${name}#seed ` +
            `session=${seedValidation.ok ? 'accepted' : 'rejected'} ` +
            `full=${seedFull.ok ? 'accepted' : 'rejected'}\n`,
        );
      }

      for (let rev = 0; rev < total; rev++) {
        const edits = scenario.edit(projectDir, {
          revision: rev,
          iteration: 0,
        });
        applyEdits(projectDir, edits);
        // A negative-only scenario is rooted at the file it violated, so the
        // verdict under test is that one violation rather than every
        // incidental one.
        if (scenario.expect === 'fail') {
          configRel = `oracle-negative-${rev}.config.js`;
          const touched = (edits ?? [])
            .map((e) => e.path)
            .filter((p) =>
              p.startsWith(path.join(projectDir, 'src', 'components')),
            )
            .map(
              (p) =>
                `./${path.relative(projectDir, p).split(path.sep).join('/')}`,
            );
          const roots =
            touched.length === 0 || name === 'policy_global'
              ? ['./src/components']
              : touched;
          fs.writeFileSync(
            path.join(projectDir, configRel),
            `module.exports = { definition: ${JSON.stringify(
              config.definition,
            )}, roots: ${JSON.stringify(roots)}, outDir: ${JSON.stringify(
              config.outDir,
            )}, runtimeModule: ${JSON.stringify(config.runtimeModule)} };\n`,
          );
        }

        // The build configuration and the design-system definition are INPUTS
        // that a revision may have changed, so they are re-read from their
        // bytes before the session sees them. Reading them from a module cache
        // would silently feed the session the previous revision's design
        // system, and the session would then be "correct" about the wrong
        // input - which is the most expensive way to be wrong.
        delete require.cache[require.resolve(configPath)];
        // eslint-disable-next-line
        config = require(configPath);
        definition = await loadDefinition();

        // 1. the session
        const first = session.current() == null;
        session.applyChanges(
          first
            ? { initial: true }
            : {
                config: {
                  roots: options().roots,
                  outDir: options().outDir,
                  runtimeModule: options().runtimeModule,
                  designSystemFile: options().designSystemFile,
                  engineOptions: options().engineOptions,
                  useCSSLayers: options().useCSSLayers,
                },
                definition,
              },
        );
        const validation = session.validate();
        if (validation.ok) {
          session.requestFullAudit({});
          session.compile();
        }
        const incremental = validation.ok ? fingerprint(outDir) : null;

        // 2. a FRESH PROCESS, full rebuild, same bytes
        const full = freshFullRebuild(projectDir, configRel);
        const fullPrint = full.ok ? fingerprint(outDir) : null;

        // 3. compare
        const findings = [];
        if (validation.ok !== full.ok) {
          findings.push({
            check: 'verdict',
            detail: `session=${validation.ok ? 'accepted' : 'rejected'} full=${
              full.ok ? 'accepted' : 'rejected'
            }`,
          });
        }
        const incDiags = sortDiagnostics(
          validation.diagnostics.map((d) => normaliseDiagnostic(d, projectDir)),
        );
        const fullDiags = sortDiagnostics(
          full.diagnostics.map((d) => normaliseDiagnostic(d, projectDir)),
        );
        const diagDiff = diffPaths(incDiags, fullDiags);
        if (diagDiff.length > 0) {
          findings.push({
            check: 'diagnostics',
            detail: `${diagDiff.length} difference(s)`,
            differences: diagDiff.slice(0, 8),
          });
        }
        if (validation.ok && full.ok) {
          const checks = [
            // The whole point of a separate check: comparing only the files the
            // reference expects cannot see a STALE file the reference does not
            // have. This one compares the two SETS, so a leftover from an older
            // generation is a difference and not an absence.
            [
              'generation-file-set',
              Object.keys(incremental.files).sort(),
              Object.keys(fullPrint.files).sort(),
            ],
            ['published-artifacts', incremental.files, fullPrint.files],
            [
              'runtime-composition-structure',
              incremental.structural,
              fullPrint.structural,
            ],
            ['css-bytes', incremental.css, fullPrint.css],
            ['css-text', incremental.cssText, fullPrint.cssText],
            [
              'generated-design-system-module',
              incremental.generatedModule,
              fullPrint.generatedModule,
            ],
            ['manifest', incremental.manifest, fullPrint.manifest],
            [
              'build-report-semantic-state',
              incremental.report,
              fullPrint.report,
            ],
          ];
          for (const [check, a, b] of checks) {
            const d = diffPaths(a, b);
            if (d.length > 0) {
              findings.push({
                check,
                detail: `${d.length} difference(s)`,
                differences: d.slice(0, 8),
              });
            }
          }
        } else if (!validation.ok && !full.ok && full.exit !== 1) {
          findings.push({
            check: 'fresh-rebuild-process',
            detail:
              `the fresh rebuild exited ${full.exit} rather than 1, so it did ` +
              'not fail as a policy rejection and the comparison is not a ' +
              'comparison of two verdicts',
            stderr: full.stderr.slice(-600),
          });
        }

        if (findings.length > 0) mismatches += 1;
        revisions.push({
          scenario: name,
          revision: rev,
          sessionVerdict: validation.ok ? 'accepted' : 'rejected',
          fullVerdict: full.ok ? 'accepted' : 'rejected',
          sessionCounters: validation.counters,
          fullFallbackReason: validation.counters?.fullFallbackReason ?? null,
          equivalent: findings.length === 0,
          findings,
        });
        process.stdout.write(
          `${findings.length === 0 ? 'ok  ' : 'FAIL'} ${name}#${rev} ` +
            `session=${validation.ok ? 'accepted' : 'rejected'} ` +
            `full=${full.ok ? 'accepted' : 'rejected'} ` +
            `reparsed=${validation.counters?.filesReparsed} ` +
            `recompiled=${validation.counters?.filesRecompiled} ` +
            `reused=${validation.counters?.filesReused}` +
            ` revdep=${validation.counters?.reverseDependentsInvalidated}` +
            ` fallback=${validation.counters?.fullFallbackReason ?? '-'}` +
            `${findings.length === 0 ? '' : ` ${JSON.stringify(findings[0])}`}\n`,
        );
      }
      session.close();
    } catch (err) {
      errors += 1;
      revisions.push({
        scenario: name,
        equivalent: false,
        findings: [
          {
            check: 'oracle',
            detail: String(err?.stack ?? err).slice(0, 1200),
          },
        ],
      });
      process.stdout.write(
        `FAIL ${name} threw: ${String(err?.stack ?? err)}\n`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  }

  const report = {
    documentKind: 'pandamstyle-incremental-differential-oracle',
    batch: 'spike-3',
    publishVariant: variant,
    corpus: {
      name: manifest.name,
      contentHash: manifest.contentHash,
      sourceFiles: manifest.files.length,
    },
    subject: `createProjectSession (incremental), ${variant}`,
    reference: 'buildProject (full rebuild), in a fresh process, same bytes',
    freshRebuildIsolation:
      'the reference build runs in a child process, so it shares neither the ' +
      'module registry, nor the compiler caches, nor the design system the ' +
      'session built',
    normalisation:
      'the additive `incremental` block and per-publisher revision/generation ' +
      'ids in coverage metadata; all coverage entries and other artifact bytes ' +
      'remain compared, and cascade-relevant CSS order is compared as text',
    checksPerRevision: [
      'verdict (accepted / rejected)',
      'diagnostics (code, phase, rule, severity, line, column, role, source, context)',
      'generation file set, as a set difference (a stale extra file fails)',
      'published artifacts after lifecycle normalization',
      'runtime composition structure (class literals, recipe references, import specifiers)',
      'css bytes and css text (ordering preserved)',
      'generated design-system module',
      'manifest',
      'build report semantic state (covered set, consistency, external requests, relay edges)',
    ],
    scenariosCompared: wanted.length,
    revisionsCompared: revisions.length,
    mismatches,
    errors,
    verdict: mismatches === 0 && errors === 0 ? 'equivalent' : 'divergent',
    revisions,
  };

  const out = args.out
    ? path.resolve(args.out)
    : path.join(workDir, 'incremental-differential.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  process.chdir(previousCwd);
  rmrf(workDir);
  process.stdout.write(
    `${JSON.stringify(
      {
        verdict: report.verdict,
        revisions: report.revisionsCompared,
        mismatches,
        errors,
        report: out,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(mismatches === 0 && errors === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(2);
  });
}

module.exports = { fingerprint, stripIncrementalBlock, diffPaths };
