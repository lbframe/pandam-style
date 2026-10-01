/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared helpers for the incremental project session tests.
 *
 * Two things are deliberately NOT here:
 *
 *  - No fake cache. The session under test is the real one, from the real
 *    built package, driven exactly the way a build tool would drive it.
 *  - No comparison that normalises away meaning. The differential helper
 *    compares the PUBLISHED artifacts - the bytes a reader would load - and
 *    the ONLY thing it removes is the additive `incremental` block the session
 *    writes into the build report, which exists precisely so a reader can see
 *    how much of the generation was reused.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  COMPILER_PKG,
  evaluateDefinitionText,
  freshCopyOf,
  sharedDefinitionOf,
} = require('./pms-helpers');

/** The real compiler bundle, the same artifact the CLI loads. */
function loadCompiler() {
  // eslint-disable-next-line
  return require(
    path.resolve(
      __dirname,
      '../../../../.pms-test-support/compiler-inspection.cjs',
    ),
  );
}

/**
 * A collector compatible with the compiler's `perf` surface.
 *
 * It exists so "the no-change revision performs zero real source parses" is a
 * measured fact rather than an inference from a counter the session increments
 * itself. Every parse the compiler performs is reported here by the compiler at
 * the parse site, including Babel's own two passes.
 */
function makeParseCounter() {
  const events = [];
  return {
    events,
    addDuration() {},
    addCount() {},
    addParse(file, pipeline, durationNs) {
      events.push({ file, pipeline, durationNs: durationNs ?? null });
    },
    sampleMemory() {},
    reset() {
      events.length = 0;
    },
    snapshot() {
      return { events: [...events] };
    },
  };
}

/**
 * A collector that records BOTH durations and counters.
 *
 * Spike 4's whole claim is that a revision does less work, and "less work" is
 * only a fact if the counters are read from the same place every time. This is
 * that place, and `counters` is the object a test asserts on.
 */
function makeCounter() {
  const durations = {};
  const counts = {};
  return {
    durations,
    counts,
    addDuration(name, value) {
      durations[name] = (durations[name] ?? 0) + value;
    },
    addCount(name, value) {
      counts[name] = (counts[name] ?? 0) + value;
    },
    addParse() {},
    sampleMemory() {},
    reset() {
      for (const key of Object.keys(durations)) delete durations[key];
      for (const key of Object.keys(counts)) delete counts[key];
    },
    snapshot() {
      return { durations, counts };
    },
  };
}

/** Installs a counter for the duration of `fn`, and returns what it saw. */
function measure(fn) {
  const collector = makeCounter();
  const teardown = loadCompiler().installPerfCollector(collector);
  try {
    const value = fn();
    return {
      value,
      counters: { ...collector.counts },
      durationsMs: Object.fromEntries(
        Object.entries(collector.durations).map(([k, v]) => [k, v / 1e6]),
      ),
    };
  } finally {
    teardown();
  }
}

function readTree(dir) {
  const out = new Map();
  const walk = (d, base = dir) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs, base);
      else if (entry.isFile())
        out.set(path.relative(base, abs), fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/**
 * The session's additive block, removed.
 *
 * It is removed on BOTH sides and only because it is the one field that states
 * how the generation was produced rather than what it contains.
 */
function stripIncrementalBlock(text) {
  return text.replace(/,?\n {2}"incremental": \{[\s\S]*?\n {2}\}\n\}/, '\n}');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** The metadata documents, which are compared as AUDIT STATE, not as bytes. */
const METADATA_ARTIFACTS = new Set(['build-report.json', 'coverage.json']);

/**
 * The build report, in a form two producers can be compared through.
 *
 * Three things are removed, and each removal is a fact about the two producers
 * rather than a fact about the report's content:
 *
 *   `incremental`       how the generation was produced. A delta publisher and
 *                       a full publisher, and a reused generation and a written
 *                       one, describe themselves differently by design.
 *   `coverageReport`    WHERE the detail document physically lives. One producer
 *                       published it into the generation; the other wrote it
 *                       beside the output directory on request. Both hold the
 *                       same entries, and the entries are compared as audit
 *                       state below - comparing the pointer instead would be
 *                       comparing a file layout, which is the one thing the
 *                       split is allowed to change.
 *   `coverage`          absent in schema version 2, and asserted absent by its
 *                       own test.
 *
 * Everything a reader of the report would use - identity, counts, the
 * consistency cross-check, external requests, relay edges - is compared.
 */
function canonicalBuildReport(report) {
  const copy = { ...report };
  delete copy.incremental;
  delete copy.coverageReport;
  delete copy.coverage;
  return copy;
}

/**
 * The coverage document, without the two fields that are about WHICH revision
 * was being described rather than about what it contains.
 *
 * A session knows its revision and generation numbers; a one-shot full rebuild
 * has neither, and the audit oracle must be able to say "these describe the same
 * project" without a translation table for that.
 */
function canonicalCoverageReport(doc) {
  const copy = { ...doc };
  delete copy.revisionId;
  delete copy.generationId;
  return copy;
}

/**
 * The audit state of a generation, wherever its documents physically are.
 *
 * Returns the summary's semantic fields and the project-wide coverage snapshot
 * as two comparable values. `revisionId` selects the snapshot when it had to be
 * written beside the output directory rather than inside the generation, which
 * is the deferred case Phase C introduced.
 */
function auditStateOf(
  outDir,
  { auditDir = null, coveragePath = null, revisionId = null } = {},
) {
  const reportPath = path.join(outDir, 'build-report.json');
  const summary = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const inGeneration = path.join(outDir, 'coverage.json');
  let coverage = null;
  let where = null;
  const explicit =
    coveragePath != null && fs.existsSync(coveragePath) ? coveragePath : null;
  if (explicit != null) {
    coverage = JSON.parse(fs.readFileSync(explicit, 'utf8'));
    where = 'requested';
  } else if (fs.existsSync(inGeneration)) {
    coverage = JSON.parse(fs.readFileSync(inGeneration, 'utf8'));
    where = 'generation';
  } else if (auditDir != null && revisionId != null) {
    const file = path.join(auditDir, `coverage-rev-${revisionId}.json`);
    if (fs.existsSync(file)) {
      coverage = JSON.parse(fs.readFileSync(file, 'utf8'));
      where = 'audit-dir';
    }
  }
  return {
    summary: canonicalBuildReport(summary),
    coverage: coverage == null ? null : canonicalCoverageReport(coverage),
    coverageWhere: where,
  };
}

/** The sibling audit directory, derived the way the session derives it. */
function auditDirOf(outDir) {
  const abs = path.resolve(outDir);
  return path.join(path.dirname(abs), `.${path.basename(abs)}.pms-audit`);
}

/**
 * Content digests of every published COMPILER artifact.
 *
 * The two metadata documents are excluded: they are compared as audit state by
 * `auditStateOf`, because the split between them is the one thing Phase C
 * intentionally changed, and comparing them as opaque bytes would report that
 * intended change as a compiler difference on every single revision.
 */
function fingerprint(outDir) {
  const tree = readTree(outDir);
  const out = {};
  for (const rel of [...tree.keys()].sort()) {
    if (METADATA_ARTIFACTS.has(rel)) continue;
    out[rel] = sha256(stripIncrementalBlock(tree.get(rel)));
  }
  return out;
}

function diffFingerprints(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const differing = [];
  for (const key of [...keys].sort()) {
    if (a[key] === b[key]) continue;
    differing.push(
      key.startsWith('js/')
        ? 'compiled-js'
        : key === 'styles.css'
          ? 'css'
          : key,
    );
  }
  return differing;
}

/**
 * A project on disk, plus the two ways of building it.
 *
 * `session` is the incremental one; `full()` is the unchanged full rebuild,
 * which is the semantic reference every assertion is made against.
 */
/**
 * @param projectName  which fixture project to copy
 * @param options      session-only options. The fresh rebuild deliberately does
 *                     NOT receive these: it is the semantic reference, and it
 *                     must publish the way a fresh rebuild publishes, which is
 *                     always in full. Comparing an incrementally published
 *                     generation against a reference that was itself given the
 *                     variant under test would compare nothing.
 */
function openProject(projectName = 'valid', options = {}) {
  return openExistingProject(freshCopyOf(projectName), options);
}

/**
 * The same harness, over a project directory that already exists.
 *
 * `openProject` copies the pristine fixture, so a second harness built with it
 * would start from the ORIGINAL sources and silently compare an edited project
 * against an unedited one. Anything that needs two sessions over the same bytes
 * - "does the reference publisher and the delta publisher agree?" - has to go
 * through this.
 */
function openExistingProject(project, options = {}) {
  const compiler = loadCompiler();
  const config = require(path.join(project, 'pandamstyle.config.js'));
  const configDir = path.dirname(path.join(project, 'pandamstyle.config.js'));
  const definitionPath = path.resolve(configDir, config.definition);
  const outDir = path.resolve(project, config.outDir);
  const roots = (config.roots ?? []).map((r) => path.resolve(project, r));

  const loadDefinition = () => {
    return evaluateDefinitionText(definitionPath);
  };

  /**
   * Re-evaluates the definition file from its BYTES, bypassing every module
   * registry in the process.
   *
   * `delete require.cache[...]` is not enough here: the test runner owns its own
   * registry and the deletion is a no-op, so a "changed" definition would come
   * back as the same object identity and the session would - correctly, from
   * its own point of view - see no change at all. A test that cannot make a
   * real change is a test that proves nothing.
   */
  const reloadDefinitionFromBytes = () => {
    const text = fs.readFileSync(definitionPath, 'utf8');
    return evaluateDefinitionText(definitionPath, text);
  };

  let definition = loadDefinition();
  /** Extra build options applied to BOTH the session and the full rebuild. */
  const overrides = {};
  const args = () => ({
    definition,
    roots,
    outDir,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
    ...overrides,
  });

  const session = compiler.createProjectSession({ ...args(), ...options });

  return {
    compiler,
    project,
    config,
    outDir,
    roots,
    definitionPath,
    sharedDefinitionPath: sharedDefinitionOf(project),
    src: (...p) => path.join(project, ...p),
    session,

    /** Creates an isolated stable SDK session over the same fixture inputs. */
    openPublicSession(publicOptions = {}) {
      return compiler.createPublicProjectSession({
        ...args(),
        projectId: project,
        rootDir: project,
        ...publicOptions,
      });
    },

    /** Re-reads the design system definition from disk, from its bytes. */
    reloadDefinition() {
      definition = reloadDefinitionFromBytes();
      return definition;
    },

    /** Applies a build option to the session AND to the full rebuild. */
    setBuildOption(key, value) {
      overrides[key] = value;
    },

    /** Runs one revision of the incremental session. */
    revise(changes = {}) {
      session.applyChanges(changes);
      const validation = session.validate();
      if (validation.ok) session.compile();
      return validation;
    },

    /** A full rebuild of exactly what is on disk right now. */
    full(overrides = {}) {
      return compiler.buildProject({ ...args(), ...overrides });
    },

    /**
     * The session's audit state, after ASKING for it.
     *
     * This is the product's promise being exercised rather than assumed: the
     * session published a compact summary, and the project-wide coverage
     * snapshot is produced here, on request, for this revision. A session that
     * could not produce it would make the oracle's audit half report a missing
     * document rather than a wrong one, which is the difference between a
     * layout change and evidence loss.
     *
     * It reads the document AT THE PATH THE REQUEST RETURNED, not by globbing
     * the output directory. That matters because the differential runs a full
     * rebuild into the same output directory, and a glob would then read the
     * REFERENCE's coverage document and call the comparison a pass.
     */
    auditState() {
      const request = session.requestFullAudit({});
      expect(request.materialized).toBe(true);
      return auditStateOf(outDir, {
        coveragePath: request.path,
        revisionId: request.revisionId,
      });
    },

    /** The audit state of whatever `full()` just published, as-is. */
    fullAuditState() {
      return auditStateOf(outDir, { auditDir: auditDirOf(outDir) });
    },

    /** What the published generation looks like, as content digests. */
    published() {
      return fingerprint(outDir);
    },
  };
}

/**
 * The differential oracle, in miniature.
 *
 * For every revision: drive the session, capture the published generation, then
 * rebuild the SAME revision from scratch with `buildProject` and require the two
 * published generations to be identical - and the two verdicts to be identical
 * too. It returns the findings rather than asserting, so a test can report what
 * diverged instead of only that something did.
 *
 * THE ORACLE HAS TWO HALVES, AND PHASE C MADE THEM DIFFERENT THINGS
 *
 *   semantics   the compiled artifacts, the CSS, the manifest: the bytes a
 *               reader loads. Compared as digests, exactly.
 *   audit       the metadata: the summary's semantic fields and the
 *               project-wide coverage snapshot. Compared after ASKING the
 *               session to produce its audit, because "the information is
 *               available on request" is the claim, and a comparison that
 *               required the snapshot to be sitting in the generation would be
 *               asserting the old layout rather than the new promise.
 *
 * The audit half is not optional and not normalised away. If the session cannot
 * produce a coverage document equal to the full rebuild's, the finding says so
 * with the entry count of each side, because "the agent got a small object" and
 * "the evidence is still there" are two different claims and only the first one
 * is cheap.
 */
function differential(harness, label, changes = {}) {
  const validation = harness.revise(changes);
  const incremental = validation.ok ? harness.published() : null;
  const audit = validation.ok ? harness.auditState() : null;

  let fullOk = true;
  let fullDiagnostics = [];
  try {
    harness.full();
  } catch (err) {
    fullOk = false;
    fullDiagnostics = (err.diagnostics ?? []).map((d) => d.code).sort();
  }
  const full = fullOk ? harness.published() : null;
  const fullAudit = fullOk ? harness.fullAuditState() : null;

  const incrementalDiagnostics = validation.diagnostics
    .map((d) => d.code)
    .sort();
  const findings = [];
  if (validation.ok !== fullOk) {
    findings.push(`verdict: incremental=${validation.ok} full=${fullOk}`);
  }
  if (
    JSON.stringify(incrementalDiagnostics) !== JSON.stringify(fullDiagnostics)
  ) {
    findings.push(
      `diagnostics: incremental=[${incrementalDiagnostics}] full=[${fullDiagnostics}]`,
    );
  }
  if (validation.ok && fullOk) {
    const differing = diffFingerprints(full, incremental);
    if (differing.length > 0) {
      findings.push(`artifacts: ${differing.join(', ')}`);
    }
    findings.push(...auditFindings(audit, fullAudit));
  }
  return { label, revisionId: validation.revisionId, findings, validation };
}

/** The findings that say the two audit representations are not the same audit. */
function auditFindings(incremental, full) {
  const findings = [];
  if (incremental == null || full == null) return findings;
  if (JSON.stringify(incremental.summary) !== JSON.stringify(full.summary)) {
    findings.push(
      `audit-summary: ${describeSummaryDiff(incremental.summary, full.summary)}`,
    );
  }
  if (incremental.coverage == null) {
    findings.push(
      'audit-coverage: the session produced no coverage snapshot for this ' +
        'revision; the full rebuild published one',
    );
  } else if (
    JSON.stringify(incremental.coverage) !== JSON.stringify(full.coverage)
  ) {
    findings.push(
      `audit-coverage: entries differ (session=${incremental.coverage.entries?.length} ` +
        `full=${full.coverage?.entries?.length})`,
    );
  }
  return findings;
}

function describeSummaryDiff(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const differing = [...keys]
    .sort()
    .filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
  return differing.length === 0
    ? 'identical'
    : `fields [${differing.join(', ')}] differ`;
}

/**
 * Compares the ALREADY PUBLISHED generation with a fresh full rebuild of the
 * same bytes, without opening a new revision.
 *
 * Used where the revision under test has already been applied, so that the
 * comparison is about the bytes on disk rather than about a second, identical
 * revision.
 */
function comparePublished(harness) {
  const incremental = harness.published();
  const audit = harness.auditState();
  let fullOk = true;
  let fullDiagnostics = [];
  try {
    harness.full();
  } catch (err) {
    fullOk = false;
    fullDiagnostics = (err.diagnostics ?? []).map((d) => d.code).sort();
  }
  const full = fullOk ? harness.published() : null;
  const findings = [];
  if (!fullOk) findings.push(`full rebuild failed: [${fullDiagnostics}]`);
  if (fullOk) {
    const differing = diffFingerprints(full, incremental);
    if (differing.length > 0)
      findings.push(`artifacts: ${differing.join(', ')}`);
    findings.push(...auditFindings(audit, harness.fullAuditState()));
  }
  return { findings, fullOk, fullDiagnostics };
}

module.exports = {
  COMPILER_PKG,
  auditDirOf,
  auditStateOf,
  canonicalBuildReport,
  canonicalCoverageReport,
  comparePublished,
  differential,
  fingerprint,
  loadCompiler,
  makeCounter,
  makeParseCounter,
  measure,
  openExistingProject,
  openProject,
  readTree,
  stripIncrementalBlock,
};
