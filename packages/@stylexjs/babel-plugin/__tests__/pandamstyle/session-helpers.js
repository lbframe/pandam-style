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
  freshCopyOf,
  sharedDefinitionOf,
} = require('./pms-helpers');

/** The real compiler bundle, the same artifact the CLI loads. */
function loadCompiler() {
  // eslint-disable-next-line
  return require(path.join(COMPILER_PKG, 'lib', 'index.js'));
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
 * how the generation was produced rather than what it contains. Everything else
 * - the coverage array, the consistency verdict, the external requests, the
 * relay edges, every rule count - is compared as published.
 */
function stripIncrementalBlock(text) {
  return text.replace(/,?\n {2}"incremental": \{[\s\S]*?\n {2}\}\n\}/, '\n}');
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Content digests of every published artifact, path-independent. */
function fingerprint(outDir) {
  const tree = readTree(outDir);
  const out = {};
  for (const rel of [...tree.keys()].sort()) {
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
    delete require.cache[require.resolve(definitionPath)];
    // eslint-disable-next-line
    const mod = require(definitionPath);
    return mod != null && mod.default != null ? mod.default : mod;
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
    const nodeRequire = require('module').createRequire(definitionPath);
    const module_ = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('require', 'module', 'exports', text);
    fn(nodeRequire, module_, module_.exports);
    const value = module_.exports;
    return value != null && value.default != null ? value.default : value;
  };

  let definition = loadDefinition();
  /** Extra build options applied to BOTH the session and the full rebuild. */
  const overrides = {};
  const args = () => ({
    definition,
    roots,
    outDir,
    runtimeModule: config.runtimeModule,
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
    full() {
      return compiler.buildProject(args());
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
 */
function differential(harness, label, changes = {}) {
  const validation = harness.revise(changes);
  const incremental = validation.ok ? harness.published() : null;

  let fullOk = true;
  let fullDiagnostics = [];
  try {
    harness.full();
  } catch (err) {
    fullOk = false;
    fullDiagnostics = (err.diagnostics ?? []).map((d) => d.code).sort();
  }
  const full = fullOk ? harness.published() : null;

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
  }
  return { label, revisionId: validation.revisionId, findings, validation };
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
  }
  return { findings, fullOk, fullDiagnostics };
}

module.exports = {
  COMPILER_PKG,
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
