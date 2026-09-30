/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the Phase C oracle (Spike 4).
 *
 * WHAT IT ANSWERS
 *
 * Did splitting the audit metadata change what the compiler DOES? It must not.
 * The metadata was moved between documents and the report's schema version
 * moved with it; the verdict, the diagnostics, the diagnostic locations, the
 * coverage set, the compiled JavaScript, the CSS, the generation's file set,
 * the manifest, the registry and system identity, and the runtime composition
 * must all be exactly what they were.
 *
 * WHICH IS WHY THE ORACLE HAS TWO HALVES
 *
 *   SEMANTIC   compared for EQUALITY. A page's compiled bytes, the stylesheet's
 *              bytes, the set of files the generation contains, the manifest,
 *              the diagnostics and where they point. Any difference is a
 *              compiler regression and fails the run.
 *
 *   AUDIT      compared for COMPLETENESS, not for byte equality. The old report
 *              was one document; the new one is a summary plus a coverage
 *              document. Demanding byte equality between them would demand that
 *              Phase C changed nothing about the format, which is the opposite
 *              of what Phase C is for. What is demanded instead is that the new
 *              representation CARRIES the old one's information: every field of
 *              the version 1 report is accounted for, and the per-file coverage
 *              records the version 1 report held inline are present, in order,
 *              with the same fields.
 *
 *   A field that is present in the old report and has no counterpart in the new
 *   one is a FAILURE, named by field. A field that is new is reported as such
 *   and is not a failure. That asymmetry is the whole point: it is what makes
 *   the audit half able to catch an accidental deletion while permitting the
 *   deliberate restructuring.
 *
 * THE THREE REFERENCES
 *
 *   1. this session, with the default `reference` policy - the compact one;
 *   2. this session, with `auditPolicy: 'inline'` - the same compiler producing
 *      the version 1 artifact, which is what makes the comparison a
 *      METADATA-POLICY comparison rather than a comparison between two
 *      checkouts;
 *   3. a fresh full rebuild in a SEPARATE PROCESS - the semantic reference,
 *      unchanged since Spike 1 and never derived from any session state.
 *
 * Reference 3 is a separate process on purpose. A "fresh rebuild" in the same
 * process would share the module registry, the compiler's caches and the design
 * system the session just built, and would not be a fresh rebuild at all.
 *
 * USAGE
 *
 *   node src/phase-c-oracle.js --corpus <dir> [--revisions 8] [--out <file>]
 *   node src/phase-c-oracle.js --self-test
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPILER_PKG = path.join(
  REPO_ROOT,
  'packages',
  '@pandamstyle',
  'compiler',
);

/**
 * The fields version 1 of the build report carried, and where each of them
 * lives in version 2.
 *
 * This table IS the audit oracle. It is written out field by field rather than
 * computed, because a computed comparison cannot tell the difference between
 * "the information was deliberately restructured" and "the information was
 * dropped", and that difference is the only thing the audit half exists to
 * catch.
 */
const AUDIT_FIELD_MAP = Object.freeze({
  documentKind: 'summary',
  // Present in the `inline` policy's report, which is version 1 of the FORMAT
  // plus the version field. The pre-Phase-C artifact had no version field at
  // all; Phase C adds one to every document it writes, so the inline policy is
  // version 1's content in a versioned envelope. That is the only difference
  // and it is stated here rather than glossed.
  schemaVersion: 'version',
  contractVersion: 'summary',
  systemId: 'summary',
  registryDigest: 'summary',
  coveredRoots: 'summary',
  coveredFileCount: 'summary',
  analysedFileCount: 'summary',
  designSystemRuleCount: 'summary',
  consumerRuleCount: 'summary',
  ruleCount: 'summary',
  cssBytes: 'summary',
  // Version 1: an inline array of per-file records. Version 2: the same
  // records, in `coverage.json`, plus the counts derived from them.
  coverage: 'coverage-document',
  coverageConsistency: 'summary',
  externalRequests: 'summary',
  relayEdges: 'summary',
  incremental: 'summary',
});

/**
 * Fields the compact representation adds. Not failures; reported so a reader
 * can see exactly what is new rather than having to diff the two documents.
 */
const AUDIT_ADDED_FIELDS = Object.freeze(['coverageSummary', 'coverageReport']);

let definitionNonce = 0;

/**
 * The definition object, freshly loaded from its own file.
 *
 * The generated corpus's definition is an ES module, and Node's ES module
 * registry is keyed by full URL with no public invalidation API - so neither
 * `delete require.cache[...]` nor a plain `require` can see a second edit. This
 * is not a hypothetical: with a plain `require` the trace wrote the changed
 * definition to disk, handed the session the SAME object it already had, the
 * session correctly reported no fallback, and the oracle recorded a divergence
 * against a fresh rebuild that had read the changed bytes. A harness that
 * cannot make a real change proves nothing about the path it is measuring.
 */
async function loadDefinitionFresh(definitionPath) {
  definitionNonce += 1;
  const href = require('url').pathToFileURL(definitionPath).href;
  const mod = await import(`${href}?pmsOracleRevision=${definitionNonce}`);
  const value = mod != null && mod.default != null ? mod.default : mod;
  if (value == null || typeof value !== 'object') {
    throw new Error(
      'phase-c-oracle: the design-system definition did not load as an object',
    );
  }
  return value;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function materialiseProject(sourceDir, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const walk = (d, base = sourceDir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep)[0] === 'node_modules') continue;
      if (rel.startsWith('.pandamstyle')) continue;
      if (e.isDirectory()) walk(abs, base);
      else if (e.isFile()) {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      }
    }
  };
  walk(sourceDir);
  return dir;
}

function linkCompiler(projectDir) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (!fs.existsSync(link)) fs.symlinkSync(COMPILER_PKG, link, 'dir');
}

/** Every file under `dir`, as relative path -> content digest. */
function digestTree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile())
        out[path.relative(dir, abs)] = sha256(fs.readFileSync(abs));
    }
  };
  walk(dir);
  return out;
}

function fileList(dir) {
  return Object.keys(digestTree(dir)).sort();
}

/**
 * The runtime composition structure, as the RUNTIME consumes it.
 *
 * The class literals, the `__pmsRecipe_*` references and the import specifiers,
 * extracted from the published JavaScript. It is compared as a structure and
 * not as a file digest, so a difference in a comment cannot be reported as a
 * difference in what the runtime reads.
 */
function runtimeCompositionOf(files) {
  const out = {};
  for (const [rel, text] of Object.entries(files)) {
    if (!rel.startsWith('js/')) continue;
    const classLiterals = [...text.matchAll(/__css-[A-Za-z0-9_]+/g)].map(
      (m) => m[0],
    );
    const recipes = [
      ...new Set(
        [...text.matchAll(/__pmsRecipe_[A-Za-z0-9_]+/g)].map((m) => m[0]),
      ),
    ].sort();
    const imports = [...text.matchAll(/from ["']([^"']+)["']/g)]
      .map((m) => m[1])
      .sort();
    out[rel] = {
      classLiterals: [...new Set(classLiterals)].sort(),
      recipes,
      imports,
    };
  }
  return out;
}

function readPublished(outDir) {
  const files = {};
  const walk = (d, base = outDir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, base);
      else if (e.isFile()) {
        files[path.relative(base, abs)] = fs.readFileSync(abs, 'utf8');
      }
    }
  };
  if (fs.existsSync(outDir)) walk(outDir);
  return files;
}

// ------------------------------------------------------------- the sessions ---

/**
 * One revision, driven three ways, with the verdicts and the published
 * generations captured for each.
 */
function openDriver(projectDir) {
  const compiler = require(path.join(COMPILER_PKG, 'lib', 'index.js'));
  const config = require(path.join(projectDir, 'pandamstyle.config.js'));
  const definitionPath = path.resolve(
    path.dirname(path.join(projectDir, 'pandamstyle.config.js')),
    config.definition,
  );
  const resolve = (r) => (path.isAbsolute(r) ? r : path.join(projectDir, r));
  const base = {
    definition: require(definitionPath),
    roots: (config.roots ?? []).map(resolve),
    outDir: resolve(config.outDir),
    runtimeModule: config.runtimeModule,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
    publishVariant: 'session_incremental_publish',
  };
  return { compiler, base, outDir: base.outDir };
}

function semanticStateOf(outDir) {
  const files = readPublished(outDir);
  const report =
    files['build-report.json'] != null
      ? JSON.parse(files['build-report.json'])
      : null;
  return {
    fileSet: Object.keys(files)
      .filter((f) => f !== 'build-report.json' && f !== 'coverage.json')
      .sort(),
    digests: Object.fromEntries(
      Object.entries(files)
        .filter(([f]) => f !== 'build-report.json' && f !== 'coverage.json')
        .map(([f, t]) => [f, sha256(t)]),
    ),
    css: files['styles.css'] ?? null,
    manifest:
      files['manifest.json'] != null
        ? JSON.parse(files['manifest.json'])
        : null,
    designSystem: files[configDesignSystemFile(files)] ?? null,
    systemId: report?.systemId ?? null,
    registryDigest: report?.registryDigest ?? null,
    contractVersion: report?.contractVersion ?? null,
    coveredFileCount: report?.coveredFileCount ?? null,
    analysedFileCount: report?.analysedFileCount ?? null,
    ruleCount: report?.ruleCount ?? null,
    designSystemRuleCount: report?.designSystemRuleCount ?? null,
    consumerRuleCount: report?.consumerRuleCount ?? null,
    cssBytes: report?.cssBytes ?? null,
    coverageConsistency: report?.coverageConsistency ?? null,
    externalRequests: report?.externalRequests ?? null,
    relayEdges: report?.relayEdges ?? null,
    runtime: runtimeCompositionOf(files),
  };
}

function configDesignSystemFile(files) {
  const key = Object.keys(files).find((f) =>
    f.endsWith('design.pandamstyle.js'),
  );
  return key ?? '__none__';
}

/** Diagnostics reduced to the facts an agent acts on. */
function diagnosticStateOf(validation) {
  return (validation.diagnostics ?? []).map((d) => ({
    code: d.code,
    severity: d.severity,
    phase: d.phase,
    rule: d.rule,
    source: d.source,
    location: d.location,
    context: d.context,
  }));
}

// ------------------------------------------------------------- the revisions ---

/**
 * A mixed trace, chosen so that the oracle sees every path that could differ.
 *
 * Local edits, an invalid edit and its repair, a module add, a remove, a
 * rename, a no-op transaction, and a design-system change. A trace that only
 * edited files would prove that edits are still equal and say nothing about
 * whether a rename still removes the old output, and a trace that only removed
 * files would say nothing about whether an edit is still incremental.
 */
const TRACE = [
  { name: 'edit-existing-atoms', kind: 'edit', files: 1 },
  { name: 'edit-five-files', kind: 'edit', files: 5 },
  { name: 'break-forbidden-value', kind: 'forbid', files: 1, expect: 'fail' },
  { name: 'repair-forbidden-value', kind: 'repair', files: 1, expect: 'ok' },
  { name: 'add-module', kind: 'add', files: 1 },
  { name: 'no-change', kind: 'noop', files: 1 },
  { name: 'remove-module', kind: 'remove', files: 1 },
  { name: 'rename-module', kind: 'rename', files: 1 },
  { name: 'import-change', kind: 'unresolved', files: 1, expect: 'fail' },
  { name: 'resolve-import', kind: 'resolve', files: 1, expect: 'ok' },
  { name: 'edit-twenty-files', kind: 'edit', files: 20 },
  { name: 'definition-change', kind: 'definition', expect: 'ok' },
];

/**
 * Builds the trace's writes against a pristine project.
 *
 * Same discipline as the benchmark harness: every edit asserts that its target
 * text is present, and a repair is the INVERSE of the violation it repairs
 * rather than a second independent edit.
 */
function planTrace(projectDir, definition) {
  const components = fs
    .readdirSync(path.join(projectDir, 'src', 'components'))
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f))
    .sort()
    .map((f) => `src/components/${f}`);
  const read = (rel) => fs.readFileSync(path.join(projectDir, rel), 'utf8');
  let cursor = 0;
  const take = (n) => {
    const out = components.slice(cursor, cursor + n);
    cursor += n;
    if (out.length < n) {
      throw new Error(
        `phase-c-oracle: the trace needs ${n} more component files than the ` +
          `corpus has (${components.length})`,
      );
    }
    return out;
  };
  const swap = (text, rel) => {
    const match = /token\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/.exec(text);
    if (match == null) {
      throw new Error(`phase-c-oracle: ${rel} has no token reference to edit`);
    }
    const category = match[1].split('.')[0];
    const members = definition.tokens[category] ?? {};
    const name = match[1].slice(category.length + 1);
    const visibility = members[name]?.visibility ?? 'public';
    const replacement = Object.keys(members).find(
      (k) => k !== name && members[k].visibility === visibility,
    );
    if (replacement == null) {
      throw new Error(
        `phase-c-oracle: category ${category} has no second token`,
      );
    }
    return (
      text.slice(0, match.index) +
      `token('${category}.${replacement}')` +
      text.slice(match.index + match[0].length)
    );
  };
  const forbid = (text, rel) => {
    const all = [
      ...text.matchAll(/token\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/g),
    ];
    if (all.length === 0)
      throw new Error(`phase-c-oracle: ${rel} has no token`);
    const chosen = all.find((m) => m[1].startsWith('colors.')) ?? all[0];
    return (
      text.slice(0, chosen.index) +
      '17' +
      text.slice(chosen.index + chosen[0].length)
    );
  };

  const plan = [];
  for (const step of TRACE) {
    const abs = (rel) => path.resolve(projectDir, rel);
    switch (step.kind) {
      case 'edit': {
        const files = take(step.files);
        plan.push({
          ...step,
          writes: files.map((rel) => ({
            path: rel,
            content: swap(read(rel), rel),
          })),
          mutation: { changed: files.map(abs) },
        });
        break;
      }
      case 'noop': {
        const files = take(step.files);
        plan.push({
          ...step,
          writes: files.map((rel) => ({ path: rel, content: read(rel) })),
          mutation: { changed: files.map(abs) },
        });
        break;
      }
      case 'forbid': {
        const files = take(step.files);
        const pristine = files.map((rel) => read(rel));
        plan.push({
          ...step,
          writes: files.map((rel, i) => ({
            path: rel,
            content: forbid(pristine[i], rel),
          })),
          mutation: { changed: files.map(abs) },
          pristine: files.map((rel, i) => ({
            path: rel,
            content: pristine[i],
          })),
        });
        break;
      }
      case 'repair': {
        const previous = plan[plan.length - 1];
        plan.push({
          ...step,
          writes: previous.pristine,
          mutation: { changed: previous.mutation.changed },
        });
        break;
      }
      case 'add': {
        const template = read(components[0]);
        const ext = path.extname(components[0]);
        const base = `OracleAdded${step.files}`;
        const rel = `src/components/${base}${ext}`;
        plan.push({
          ...step,
          writes: [
            { path: rel, content: template.replace(/Component\d+/g, base) },
          ],
          mutation: { added: [abs(rel)] },
        });
        break;
      }
      case 'remove': {
        const files = take(step.files);
        plan.push({
          ...step,
          deletes: files,
          mutation: { removed: files.map(abs) },
        });
        break;
      }
      case 'rename': {
        const files = take(step.files);
        const renames = files.map((rel) => ({
          from: rel,
          to: rel.replace(/(\.[cm]?[jt]sx?)$/, '-moved$1'),
        }));
        plan.push({
          ...step,
          writes: renames.map((m) => ({ path: m.to, content: read(m.from) })),
          deletes: renames.map((m) => m.from),
          mutation: {
            renamed: renames.map((m) => ({ from: abs(m.from), to: abs(m.to) })),
          },
        });
        break;
      }
      case 'unresolved': {
        const files = take(step.files);
        const pending = 'src/OraclePending/Pending.ts';
        plan.push({
          ...step,
          writes: files.map((rel) => ({
            path: rel,
            content:
              `${read(rel)}\nimport { pendingThing } from '../OraclePending/Pending';\n` +
              'export const pendingValue = pendingThing;\n',
          })),
          mutation: { changed: files.map(abs) },
          pending: {
            path: pending,
            content: 'export const pendingThing = 1;\n',
          },
        });
        break;
      }
      case 'resolve': {
        const previous = plan[plan.length - 1];
        plan.push({
          ...step,
          writes: [
            { path: previous.pending.path, content: previous.pending.content },
          ],
          mutation: { added: [abs(previous.pending.path)] },
        });
        break;
      }
      case 'definition': {
        plan.push({ ...step, definitionEdit: true, mutation: { changed: [] } });
        break;
      }
      default:
        throw new Error(`phase-c-oracle: unknown trace kind ${step.kind}`);
    }
  }
  return plan;
}

// ------------------------------------------------------------- the rebuild ---

/**
 * A fresh full rebuild of the CURRENT bytes, in a SEPARATE PROCESS.
 *
 * The process boundary is the point. A rebuild in the same process would share
 * the module registry, the compiler's in-process caches and the design system
 * the session built, and would then be a second opinion from the same memory -
 * which is precisely the question the oracle exists to answer.
 */
function freshRebuild(projectDir, script) {
  const out = spawnSync(process.execPath, [script, projectDir], {
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
  });
  if (out.status !== 0) {
    return {
      ok: false,
      error: String(out.stderr ?? out.stdout).slice(0, 2000),
    };
  }
  try {
    return { ok: true, state: JSON.parse(out.stdout) };
  } catch (err) {
    return {
      ok: false,
      error: `unparseable rebuild output: ${err.message}`,
    };
  }
}

const REBUILD_SCRIPT = path.join(__dirname, 'phase-c-rebuild.js');

// ---------------------------------------------------------------- the oracle ---

/**
 * Runs the whole trace and returns a document with every finding.
 *
 * Findings, not an exception: a caller needs to report all the differences, not
 * the first one, and a run that stops at the first difference cannot tell a
 * single regression from a systematic one.
 */
async function runOracle({
  corpusDir,
  corpusName,
  outDir,
  revisions = TRACE.length,
}) {
  const findings = [];
  const projectDir = path.join(outDir, 'project');
  materialiseProject(corpusDir, projectDir);
  linkCompiler(projectDir);
  process.chdir(projectDir);

  const driver = openDriver(projectDir);
  const config = require(path.join(projectDir, 'pandamstyle.config.js'));
  void config;
  const definitionPath = path.resolve(projectDir, 'pandamstyle.config.js');
  const definitionForPlan = (() => {
    const configPath = path.join(projectDir, 'pandamstyle.config.js');
    const cfg = require(configPath);
    const p = path.resolve(path.dirname(configPath), cfg.definition);
    // eslint-disable-next-line
    return require(p);
  })();
  void definitionPath;
  const plan = planTrace(projectDir, definitionForPlan).slice(0, revisions);

  const session = driver.compiler.createProjectSession({ ...driver.base });
  const revisionsOut = [];

  // The warmup: revision 1, a full analysis. Not compared - there is no
  // previous state to differ from - but published, so every later revision has
  // a generation to be a delta from.
  session.applyAgentChanges({ changed: [] });
  const warm = session.validate();
  if (!warm.ok) {
    findings.push({
      kind: 'warmup',
      message: 'the initial revision did not validate',
    });
    return { corpus: corpusName, revisions: [], findings };
  }
  session.compile();

  for (const step of plan) {
    for (const del of step.deletes ?? []) {
      fs.rmSync(path.join(projectDir, del), { force: true });
    }
    for (const write of step.writes ?? []) {
      const abs = path.join(projectDir, write.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, write.content, 'utf8');
    }
    let changedDefinition = null;
    if (step.definitionEdit === true) {
      const cfg = require(path.join(projectDir, 'pandamstyle.config.js'));
      const p = path.resolve(
        path.dirname(path.join(projectDir, 'pandamstyle.config.js')),
        cfg.definition,
      );
      const text = fs.readFileSync(p, 'utf8');
      const after = text.replace(/#[0-9a-fA-F]{6}/, (m) =>
        m === '#000000' ? '#010203' : '#000000',
      );
      if (after === text) {
        findings.push({
          kind: 'trace',
          message: 'the definition has no hex value to change',
        });
        break;
      }
      fs.writeFileSync(p, after, 'utf8');
      changedDefinition = await loadDefinitionFresh(p);
    }

    if (changedDefinition != null) {
      // The definition is a separate input from the mutation set, and the
      // session takes it as an argument: it digests what it is given and does
      // not watch the file. Handing it only the mutation would write the change
      // to disk and never tell the session about it - which the oracle caught,
      // as a `definition-change` revision that did not fall back while the
      // fresh rebuild, reading the same bytes, did.
      session.applyChanges({ definition: changedDefinition, ...step.mutation });
    } else {
      session.applyAgentChanges({ ...step.mutation });
    }
    const validation = session.validate();
    const expectedFailure = step.expect === 'fail';
    if (validation.ok === expectedFailure) {
      findings.push({
        kind: 'verdict',
        revision: step.name,
        message:
          `expected ${expectedFailure ? 'a refusal' : 'success'} and got ` +
          `${validation.ok ? 'success' : 'a refusal'}`,
      });
    }
    if (validation.ok) {
      session.compile();
      // The audit, produced on request, for this revision. Asking is the point:
      // the oracle must not require the detail document to be sitting in the
      // generation, or it would be asserting the old layout.
      session.requestFullAudit({});
    }

    const semantic = semanticStateOf(
      session.current ? driver.outDir : driver.outDir,
    );
    const rebuild = freshRebuild(projectDir, REBUILD_SCRIPT);

    // ---- the semantic half: equality ----
    //
    // The reference's published state is read HERE, from the output directory
    // the child just wrote. The child does not send it: at c10000 the semantic
    // state is megabytes, and a multi-megabyte document down a pipe is a way to
    // manufacture a failure that looks exactly like a compiler regression.
    if (rebuild.ok && validation.ok) {
      rebuild.state = {
        ...rebuild.state,
        semantic: semanticStateOf(driver.outDir),
      };
    }
    if (!rebuild.ok) {
      findings.push({
        kind: 'semantic',
        revision: step.name,
        message: `the fresh full rebuild failed: ${rebuild.error}`,
      });
    } else if (validation.ok) {
      for (const field of SEMANTIC_FIELDS) {
        const a = JSON.stringify(semantic[field] ?? null);
        const b = JSON.stringify(rebuild.state.semantic[field] ?? null);
        if (a !== b) {
          findings.push({
            kind: 'semantic',
            revision: step.name,
            field,
            message: describeDifference(
              field,
              semantic[field],
              rebuild.state.semantic[field],
            ),
          });
        }
      }
    } else {
      // A refused revision has no generation, so there is nothing to compare
      // byte-wise. The verdict and the diagnostics are the comparison, and both
      // are checked below.
      if (!rebuild.ok) {
        // correct
      } else if (rebuild.state.verdict.ok) {
        findings.push({
          kind: 'semantic',
          revision: step.name,
          message: 'the session refused a revision the full rebuild accepted',
        });
      }
    }

    // The diagnostics, always: a refusal and an acceptance both have to agree
    // with the reference about WHICH diagnostics and where they point.
    if (rebuild.ok) {
      const a = JSON.stringify(diagnosticStateOf(validation));
      const b = JSON.stringify(rebuild.state.diagnostics);
      if (a !== b) {
        findings.push({
          kind: 'semantic',
          revision: step.name,
          field: 'diagnostics',
          message: `session=${a.slice(0, 400)} full=${String(b).slice(0, 400)}`,
        });
      }
    }

    revisionsOut.push({
      revision: step.name,
      revisionId: validation.revisionId,
      ok: validation.ok,
      expect: step.expect ?? 'ok',
      verdictMatchesExpectation: validation.ok !== (step.expect === 'fail'),
      diagnostics: validation.diagnostics.map((d) => d.code),
      filesCompiled: validation.counters.filesCompiled,
      filesRecompiled: validation.counters.filesRecompiled,
      filesReused: validation.counters.filesReused,
      dirtyFilesRead: validation.counters.dirtyFilesRead,
      dirtyFilesHashed: validation.counters.dirtyFilesHashed,
    });
  }
  session.close();
  return { corpus: corpusName, revisions: revisionsOut, findings };
}

/** The semantic fields, compared for EQUALITY. */
const SEMANTIC_FIELDS = Object.freeze([
  'fileSet',
  'digests',
  'css',
  'manifest',
  'designSystem',
  'systemId',
  'registryDigest',
  'contractVersion',
  'coveredFileCount',
  'analysedFileCount',
  'ruleCount',
  'designSystemRuleCount',
  'consumerRuleCount',
  'cssBytes',
  'coverageConsistency',
  'externalRequests',
  'relayEdges',
  'runtime',
]);

function describeDifference(field, a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return `digests differ (${sha256(a).slice(0, 12)} vs ${sha256(b).slice(0, 12)})`;
  }
  return `${JSON.stringify(a)?.slice(0, 300)} vs ${JSON.stringify(b)?.slice(0, 300)}`;
}

// ------------------------------------------------------- the audit oracle ---

/**
 * The audit half: the version 1 artifact against the version 2 pair.
 *
 * Both are produced by the SAME compiler in the SAME process, differing only in
 * `auditPolicy`. The session publishes the compact pair; the `inline` session
 * publishes the monolithic document. Every field version 1 carried is looked up
 * in the version 2 pair, and every per-file record is compared.
 */
function runAuditOracle({ projectDir, workDir }) {
  const findings = [];
  // ONE project directory, two sequential passes.
  //
  // The first version of this ran the two policies in two COPIES of the
  // project, and reported that `coveredRoots` and `relayEdges` differed. They
  // did differ - the copies were at different absolute paths, and the report
  // stores paths - but the difference was the experiment's own doing, not a
  // property of either policy. Two passes over the SAME bytes, with the output
  // removed between them, is the only way for that comparison to mean anything.
  //
  // The destination is a SIBLING of the source. `materialiseProject` walks its
  // source while writing its destination, so a destination inside the source
  // makes the walk descend into a directory it is still filling - which showed
  // up as an output directory with no build report in it, a failure that looks
  // exactly like a compiler problem and is not one.
  // The SAME directory for both passes, wiped in between. Two directories would
  // be at two absolute paths, and the report stores paths - so `coveredRoots`
  // and every `relayEdges` entry would differ for no reason connected to the
  // metadata policy, and the oracle would report the experiment's own layout as
  // a difference in the compiler's output.
  const dir = path.join(workDir, 'audit');
  const pass = (name, auditPolicy) => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    materialiseProject(projectDir, dir);
    linkCompiler(dir);
    const driver = openDriver(dir);
    const session = driver.compiler.createProjectSession({
      ...driver.base,
      auditPolicy,
    });
    session.applyAgentChanges({ changed: [] });
    const warm = session.validate();
    if (!warm.ok) {
      findings.push({
        kind: 'audit',
        message: `the ${name} session's initial revision was refused`,
      });
      return null;
    }
    session.compile();

    // One real edit, so the comparison is of a REVISION and not only of the
    // initial state.
    //
    // The edit swaps a token reference for ANOTHER TOKEN OF THE SAME CATEGORY.
    // An earlier version wrote a token path that does not exist, which made
    // both revisions fail - and a comparison of two refusals publishes nothing,
    // so the oracle reported a missing build report for what was really an edit
    // that was never valid.
    const target = path.join(dir, 'src/components/Component0.tsx');
    const before = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(
      target,
      swapTokenFor(target, before, driver.base.definition),
      'utf8',
    );
    session.applyAgentChanges({ changed: [target] });
    const validation = session.validate();
    if (!validation.ok) {
      findings.push({
        kind: 'audit',
        message: `the ${name} session's edit revision was refused`,
      });
      return null;
    }
    session.compile();
    // The audit, produced on request, for this revision. Asking is the point:
    // the oracle must not require the detail document to be sitting inside the
    // generation, or it would be asserting the old layout.
    const request = session.requestFullAudit({});
    // The report is READ HERE, not after both passes. The two passes share one
    // directory, so reading afterwards would read the SECOND pass's report
    // twice and compare the inline policy with itself - a comparison that always
    // passes and therefore proves nothing.
    const report = JSON.parse(
      fs.readFileSync(path.join(driver.outDir, 'build-report.json'), 'utf8'),
    );
    session.close();
    return { driver, dir, request, revisionId: validation.revisionId, report };
  };

  const compact = pass('compact', 'reference');
  const inline = pass('inline', 'inline');
  if (compact == null || inline == null)
    return { findings, coveragePath: null };

  const compactReport = compact.report;
  const inlineReport = inline.report;

  // Every field the `inline` report carries must be accounted for. A field with
  // no entry in the map is an UNACCOUNTED field, and the oracle says so by name
  // rather than skipping it: a comparison that quietly ignores fields it does
  // not recognise is a comparison that passes when information was lost.
  for (const field of Object.keys(inlineReport)) {
    const where = AUDIT_FIELD_MAP[field];
    if (where == null) {
      findings.push({
        kind: 'audit',
        field,
        message:
          `the inline report carries ${JSON.stringify(field)} and the oracle ` +
          'does not know where the compact representation puts it; an ' +
          'unmapped field is an unaccounted field',
      });
      continue;
    }
    if (where === 'summary') {
      const a = comparableField(inlineReport, field);
      const b = comparableField(compactReport, field);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        findings.push({
          kind: 'audit',
          field,
          message:
            `${describeDifference(field, a, b)}; both policies produced this ` +
            'field and they differ',
        });
      }
    } else if (where === 'version') {
      // The version IS expected to differ - that is the schema change. What is
      // NOT acceptable is it being absent, because a reader that does not check
      // it would read a version 1 report's `coverage` as missing and could take
      // that for an empty project.
      if (inlineReport.schemaVersion !== 1) {
        findings.push({
          kind: 'audit',
          field: 'schemaVersion',
          message:
            'the inline report declares schema version ' +
            `${inlineReport.schemaVersion}, not 1; it is supposed to ` +
            'reproduce the version 1 format',
        });
      }
      if (compactReport.schemaVersion !== 2) {
        findings.push({
          kind: 'audit',
          field: 'schemaVersion',
          message:
            'the compact report declares schema version ' +
            `${compactReport.schemaVersion}, not 2`,
        });
      }
    }
    // `coverage-document` is checked below, against the document.
  }

  // The per-file records: the same list, in the same order, with the same fields.
  const coveragePath = firstExisting([
    path.join(compact.driver.outDir, 'coverage.json'),
    auditDocumentFor(compact.driver.outDir, compact.revisionId),
  ]);
  if (coveragePath == null) {
    findings.push({
      kind: 'audit',
      field: 'coverage',
      message:
        'the compact session produced no coverage document, in the generation ' +
        'or beside it; the audit was requested and is not available',
    });
    return { findings, coveragePath: null };
  }
  const coverageDoc = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  const a = inlineReport.coverage;
  const b = coverageDoc.entries;
  if (!Array.isArray(a) || !Array.isArray(b)) {
    findings.push({
      kind: 'audit',
      field: 'coverage',
      message: 'one of the two representations has no coverage entries array',
    });
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    const first = a.findIndex(
      (entry, i) => JSON.stringify(entry) !== JSON.stringify(b[i]),
    );
    findings.push({
      kind: 'audit',
      field: 'coverage',
      message:
        `the per-file coverage records differ (${a.length} inline vs ` +
        `${b.length} in the document); first difference at index ${first}`,
    });
  }

  // The counts in the summary must BE the counts in the document. The summary is
  // derived from the detail, so a disagreement here is a derivation bug rather
  // than a stale document, and it is checked rather than assumed.
  const entries = Array.isArray(b) ? b : [];
  const derived = {
    entries: entries.length,
    pages: entries.filter((e) => e.role === 'page').length,
    designSystem: entries.filter((e) => e.role === 'design-system').length,
    failed: entries.filter((e) => e.failed === true).length,
    withDiagnostics: entries.filter((e) => (e.diagnostics ?? 0) > 0).length,
    usedDesignSystem: entries.filter((e) => e.usedDesignSystem === true).length,
    usedPmsHelpers: entries.filter((e) => e.usedPmsHelpers === true).length,
    ruleTotal: entries.reduce((n, e) => n + (e.ruleCount ?? 0), 0),
    relayChainEntries: entries.reduce(
      (n, e) => n + (Array.isArray(e.relayChain) ? e.relayChain.length : 0),
      0,
    ),
  };
  for (const [key, value] of Object.entries(derived)) {
    if (compactReport.coverageSummary[key] !== value) {
      findings.push({
        kind: 'audit',
        field: `coverageSummary.${key}`,
        message:
          `the summary says ${compactReport.coverageSummary[key]} and the ` +
          `document says ${value}; the summary is derived from the document, so ` +
          'they cannot disagree',
      });
    }
  }
  if (compactReport.coveredFileCount !== entries.length) {
    findings.push({
      kind: 'audit',
      field: 'coveredFileCount',
      message:
        `the summary says ${compactReport.coveredFileCount} and the document ` +
        `has ${entries.length}`,
    });
  }

  return {
    findings,
    coveragePath,
    coverageBytes: fs.statSync(coveragePath).size,
  };
}

/**
 * One field, with the parts that state HOW rather than WHAT removed.
 *
 * The `incremental` block is the project's own account of the work a
 * generation cost, and two runs of the same work cost slightly different
 * numbers of milliseconds - comparing them would report the clock as a
 * difference in the report. `incrementalAnalysisMs` is dropped for that reason
 * and `auditPolicy` because it is the axis under test: the two policies are
 * SUPPOSED to differ there. Every other counter in the block is work, not time,
 * and is compared.
 */
const INCREMENTAL_EXCLUDED = Object.freeze([
  'incrementalAnalysisMs',
  'auditPolicy',
]);

function comparableField(report, field) {
  const value = report[field];
  if (field !== 'incremental' || value == null) return value ?? null;
  const copy = { ...value };
  for (const key of INCREMENTAL_EXCLUDED) delete copy[key];
  return copy;
}

/** A VALID token swap, from the design system the project actually has. */
function swapTokenFor(target, text, definition) {
  const match = /token\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/.exec(text);
  if (match == null) {
    throw new Error(`phase-c-oracle: ${target} has no token reference to edit`);
  }
  const category = match[1].split('.')[0];
  const name = match[1].slice(category.length + 1);
  const members = definition.tokens[category] ?? {};
  const visibility = members[name]?.visibility ?? 'public';
  const replacement = Object.keys(members).find(
    (k) => k !== name && members[k].visibility === visibility,
  );
  if (replacement == null) {
    throw new Error(`phase-c-oracle: category ${category} has no second token`);
  }
  return (
    text.slice(0, match.index) +
    `token('${category}.${replacement}')` +
    text.slice(match.index + match[0].length)
  );
}

/**
 * Where a deferred coverage document for a revision lives.
 *
 * Derived the way `session.js` derives it, from the OUTPUT directory rather
 * than from the project directory: it is a sibling of the output directory,
 * named after it. Deriving it a second time, differently, is how a check ends
 * up looking in a place the compiler never writes.
 */
function auditDocumentFor(outDir, revisionId) {
  const abs = path.resolve(outDir);
  return path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.pms-audit`,
    `coverage-rev-${revisionId}.json`,
  );
}

function firstExisting(paths) {
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

// ------------------------------------------------------------------- the CLI ---

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') args.corpus = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--revisions') args.revisions = Number(argv[++i]);
  }
  if (args.corpus == null) {
    process.stderr.write('phase-c-oracle: --corpus is required\n');
    process.exit(2);
  }
  const corpusName = path.basename(args.corpus);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase-c-oracle-'));
  const semantic = await runOracle({
    corpusDir: args.corpus,
    corpusName,
    outDir,
    revisions: args.revisions,
  });
  const audit = runAuditOracle({
    projectDir: path.join(outDir, 'project'),
    workDir: outDir,
  });

  const document = {
    documentKind: 'pandamstyle-phase-c-oracle',
    schemaVersion: 1,
    corpus: corpusName,
    semantic: {
      revisions: semantic.revisions.length,
      findings: semantic.findings,
      verdict: semantic.findings.length === 0 ? 'equivalent' : 'DIVERGENT',
    },
    audit: {
      findings: audit.findings,
      coverage_document_bytes: audit.coverageBytes ?? null,
      coverage_document: audit.coveragePath,
      verdict: audit.findings.length === 0 ? 'complete' : 'INCOMPLETE',
    },
    field_map: AUDIT_FIELD_MAP,
    added_fields: AUDIT_ADDED_FIELDS,
  };
  if (args.out != null) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(
      args.out,
      JSON.stringify(document, null, 2) + '\n',
      'utf8',
    );
  }
  process.stdout.write(JSON.stringify(document, null, 2) + '\n');
  fs.rmSync(outDir, { recursive: true, force: true });
  if (
    document.semantic.verdict !== 'equivalent' ||
    document.audit.verdict !== 'complete'
  ) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  AUDIT_ADDED_FIELDS,
  AUDIT_FIELD_MAP,
  SEMANTIC_FIELDS,
  TRACE,
  digestTree,
  fileList,
  planTrace,
  readPublished,
  runAuditOracle,
  runOracle,
  runtimeCompositionOf,
  semanticStateOf,
};
