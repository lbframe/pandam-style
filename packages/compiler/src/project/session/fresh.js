/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - independent fresh semantic oracle (ARC-13, ARC-14, P0-09, P0-10).
 *
 * This is the reference path used by differential tests and the qualification
 * pilot. It is not the production Project Service or a host-facing session. It
 * does NOT take a pre-normalized IR: it reads actual JS/TS/TSX files from roots,
 * runs them through the fork's compiler pipeline, collects the rules the engine
 * emitted, and produces CSS, JS, a manifest and a coverage report that all
 * reference the SAME registryDigest.
 *
 * Coverage is explicit: every file under a declared root is analysed, and the
 * local-import closure of those files is pulled in and reported too. A file
 * that cannot be analysed fails the build (PMS_COVERAGE_GAP); it is never
 * silently skipped.
 */

import * as fs from 'fs';
import * as path from 'path';
import { processStylexRules } from '../../engine/index';
import { PmsError, Codes, diagnostic } from '../../protocol/diagnostics';
import {
  BUILD_REPORT_KIND,
  BUILD_REPORT_SCHEMA_VERSION,
  COVERAGE_REPORT_FILE,
  buildCoverageReport,
  coverageReference,
  coverageSummary,
} from '../../protocol/diagnostics-result';
import { buildDesignSystem } from '../../design-system/registry/build-system';
import { generateDesignSystemModule } from '../../artifacts/javascript/design-module';
import { generateDesignSystemDeclarations } from '../../artifacts/types/design-declarations';
import {
  createArtifactSet,
  designDeclarationFile,
  withDesignSystemCssIdentity,
} from '../../artifacts/metadata/artifact-set';
import { withGeneration } from '../../artifacts/publication/transaction';
import {
  clearModuleCache,
  clearModuleOverlay,
  createModuleGraphContext,
  currentModuleGraphContext,
  moduleEdgesOf,
  registerServiceOwnedGeneratedArtifact,
  runWithModuleGraphContext,
  setModuleOverlay,
} from '../graph/resolution';
import { compileFile } from '../../frontend/babel/compile-file';
// Benchmark-only measurement hooks (Spike 1).
import { perfCollector, perfNow, phase } from '../../observability/metrics';

export const SOURCE_RE = /\.(jsx?|tsx?|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
]);

export function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(full, out);
      continue;
    }
    if (entry.isFile() && SOURCE_RE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Declared roots + the LOCAL MODULE CLOSURE they pull in.
 *
 * The closure follows every local edge of the real module graph - imports AND
 * re-exports AND literal dynamic requests - so a file cannot step outside the
 * policy by being reached through a barrel:
 *
 *     covered-root/page.tsx -> bridge/index.ts -> outside/Unsafe.tsx
 *
 * `Unsafe.tsx` is now covered, so it is analysed. A local edge that cannot be
 * resolved, or a dynamic request that is not a static string, is reported as
 * PMS_COVERAGE_GAP rather than dropped.
 */
export function collectCoveredFiles(roots) {
  const start = perfNow();
  try {
    return collectCoveredFilesInner(roots);
  } finally {
    const collector = perfCollector();
    if (collector != null) {
      collector.addDuration('coverage_graph_ms', perfNow() - start);
    }
  }
}

function collectCoveredFilesInner(roots) {
  const covered = new Map();
  const queue = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new PmsError([
        diagnostic({
          code: Codes.COVERAGE_GAP,
          phase: 'coverage',
          message: `Declared root does not exist: ${abs}`,
          rule: 'coverage.roots',
          context: { root: abs },
        }),
      ]);
    }
    if (stat.isFile()) {
      covered.set(abs, 'root');
      queue.push(abs);
    } else {
      for (const f of walkFiles(abs)) {
        covered.set(f, 'root');
        queue.push(f);
      }
    }
  }

  const unresolved = [];
  const external = [];
  const relayEdges = [];
  while (queue.length > 0) {
    const file = queue.pop();
    const { edges, unreadable, parseLocation } = moduleEdgesOf(file);
    if (unreadable) {
      unresolved.push({
        from: file,
        request: parseLocation == null ? '<unparseable>' : '<syntax-error>',
        form: parseLocation == null ? 'unreadable' : 'syntax',
        line: parseLocation?.line ?? null,
        column: parseLocation?.column ?? null,
      });
      continue;
    }
    for (const edge of edges) {
      if (edge.computed === true) {
        // A dynamic request with no static string: the module it loads is
        // unknown, and an unknown module cannot be analysed.
        unresolved.push({
          from: file,
          request: '<computed>',
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!edge.local) {
        // A package request: outside the local coverage contract, but not
        // hidden. The plugin refuses the forbidden ones in every syntax.
        if (edge.form !== 'import') {
          external.push({
            from: file,
            request: edge.request,
            form: edge.form,
          });
        }
        continue;
      }
      if (edge.isStylesheet) continue;
      if (edge.resource) continue;
      if (edge.resolved == null) {
        unresolved.push({
          from: file,
          request: edge.request,
          form: edge.form,
          line: edge.line,
        });
        continue;
      }
      if (!covered.has(edge.resolved)) {
        covered.set(edge.resolved, `closure:${edge.form}`);
        relayEdges.push({
          from: file,
          to: edge.resolved,
          form: edge.form,
          request: edge.request,
        });
        queue.push(edge.resolved);
      }
    }
  }
  return { covered, unresolved, external, relayEdges };
}
/**
 * Consistency between the files a run EXPECTED to analyse and the files it
 * ACTUALLY analysed.
 *
 * `transformInclude()` is not evidence: it only says a hook is willing to look
 * at a module. A covered module that the bundler loaded and the compiler never
 * analysed is a hole, and it must be a failure rather than a note in a report.
 *
 * Two sets are compared:
 *  - `expected`  : covered files the bundler demonstrably loaded;
 *  - `transformed`: files the transform hook really compiled.
 *
 * Files covered by a declared root but never reachable from the entry are
 * reported with `classification: 'not-in-bundler-graph'`. The CLI analyses
 * those directly, so they are not a failure; the bundler cannot, and pretending
 * otherwise would be the lie this function exists to prevent.
 */
export function assertCoverageConsistency({
  coveredFiles = [],
  transformedFiles = [],
  exemptFiles = [],
  phase = 'build',
} = {}) {
  const exempt = new Set(exemptFiles.map((f) => path.resolve(f)));
  const covered = new Set(coveredFiles.map((f) => path.resolve(f)));
  const transformed = new Set(transformedFiles.map((f) => path.resolve(f)));

  const missing = [];
  for (const file of covered) {
    if (exempt.has(file)) continue;
    if (transformed.has(file)) continue;
    missing.push(file);
  }

  const loadedNotCovered = [];
  for (const file of transformed) {
    if (!covered.has(file) && !exempt.has(file)) loadedNotCovered.push(file);
  }

  return {
    phase,
    expectedCount: covered.size,
    transformedCount: transformed.size,
    missing,
    loadedNotCovered,
    ok: missing.length === 0,
  };
}

export function coverageGapDiagnostics(missing, phase) {
  return missing.map((file) =>
    diagnostic({
      code: Codes.COVERAGE_GAP,
      phase: 'coverage',
      message:
        `Covered file was never analysed: ${file}. It is inside the declared ` +
        'coverage and was presented to the bundler, so a real policy check was ' +
        'skipped. A transform hook admitting a module is not proof it ran.',
      source: file,
      rule: 'coverage.expected-vs-analysed',
      context: { file, phase, missingCount: missing.length },
    }),
  );
}

/** Deepest common directory of a list of paths. */
export function commonBase(paths) {
  if (paths.length === 0) return process.cwd();
  const dirLists = paths.map((p) => {
    const abs = path.resolve(p);
    return path.dirname(abs).split(path.sep);
  });
  let base = dirLists[0].slice();
  for (const list of dirLists.slice(1)) {
    let i = 0;
    while (i < base.length && i < list.length && base[i] === list[i]) i++;
    base = base.slice(0, i);
  }
  const joined = base.join(path.sep);
  return joined === '' ? path.sep : joined;
}

export function relativeToCwd(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? file : rel;
}

/**
 * Creates a reusable fresh-reference session. This is private to semantic
 * qualification and the Phase 8 Vite seam under tools/pilot; production hosts
 * use the Promise-based Project Service in `api/project.js`.
 *
 * It remains separate from the incremental service so fresh-vs-incremental
 * comparisons stay independent. Both use the same compiler pipeline, policy,
 * and engine, while only the service owns production project lifecycle.
 *
 * `generation` is the transaction the caller opened (see generation.js). The
 * session NEVER writes: publishing is the transaction's job, so a failed
 * generation leaves nothing current.
 */
export function createCompilerSession(config) {
  const graphContext =
    currentModuleGraphContext() ?? createModuleGraphContext();
  return runWithModuleGraphContext(graphContext, () =>
    createCompilerSessionInContext(config, graphContext),
  );
}

function createCompilerSessionInContext(config, graphContext) {
  const runGraph = (callback) =>
    runWithModuleGraphContext(graphContext, callback);
  const {
    definition,
    roots = [],
    designSystemFile = 'design.pandamstyle.js',
    engineOptions = {},
    useCSSLayers = false,
    role = 'page',
    generation = null,
  } = config;

  clearModuleCache();
  const designSystem = phase('boundary_ms', () =>
    buildDesignSystem(definition, { ...engineOptions }),
  );
  const designSystemSource = phase('ds_module_codegen_ms', () =>
    generateDesignSystemModule({ designSystem }),
  );
  const designDeclarationsFile = designDeclarationFile(designSystemFile);
  const designDeclarationsSource = phase('ds_types_codegen_ms', () =>
    generateDesignSystemDeclarations(designSystem.snapshot),
  );

  // The generated design system module must be RESOLVABLE while the pages are
  // compiled, because that is how a design system is recognized. It is served
  // from the module overlay rather than written to disk, so nothing exists on
  // disk until the generation is published. See module-graph.js for why a
  // bundler cannot be trusted to report its own failure.
  const outDirAbs =
    generation != null
      ? path.resolve(generation.outDir)
      : path.resolve(designSystemFile, '..');
  const generatedModulePath = path.join(outDirAbs, designSystemFile);
  setModuleOverlay(new Map([[generatedModulePath, designSystemSource]]));
  registerServiceOwnedGeneratedArtifact(
    generatedModulePath,
    designSystemSource,
  );
  if (generation != null) {
    generation.stage(designSystemFile, designSystemSource);
  }
  // It is discovered by the closure like any other local module, but it is the
  // GENERATOR'S OUTPUT, not a page: it is never re-analysed. Excluding it here
  // is what lets the expected-vs-analysed cross-check mean something.
  const isGeneratedModule = (file) => file === generatedModulePath;

  // Coverage is LAZY on purpose: the generated design system module must be on
  // disk before the module closure is walked.
  let coveredCache = null;
  const covered = () => {
    if (coveredCache == null) coveredCache = collectCoveredFiles(roots);
    return coveredCache;
  };

  return {
    designSystem,
    roots,
    role,
    useCSSLayers,
    engineOptions,
    designSystemFile,
    designSystemSource,
    designDeclarationsFile,
    designDeclarationsSource,
    generatedModulePath,
    get coveredFiles() {
      return runGraph(() =>
        [...covered().covered.keys()].filter((f) => !isGeneratedModule(f)),
      );
    },
    get coverage() {
      return runGraph(() => covered().covered);
    },
    get unresolved() {
      return runGraph(() => covered().unresolved);
    },
    get externalRequests() {
      return runGraph(() => covered().external);
    },
    get relayEdges() {
      return runGraph(() => covered().relayEdges);
    },
    registryDigest: designSystem.registry.registryDigest,
    // Test-oracle inspection only. Production SDK consumers cannot reach this
    // object because api/index.js exposes only the stable project service.
    _withGraphContext: runGraph,
    compileSource: (code, filename) =>
      runGraph(() =>
        compileFile(code, filename, designSystem, { ...engineOptions, role }),
      ),
    renderCss: (rules) =>
      processStylexRules(rules, {
        useLayers: useCSSLayers,
        __pmsPerfPhase: phase,
      }),
    designSystemRules: () => {
      const rules = [];
      for (const [key, { priority, ...rest }] of Object.entries(
        designSystem.injected,
      )) {
        rules.push([key, rest, priority ?? 0]);
      }
      return rules;
    },
  };
}

/**
 * Builds a project.
 *
 * Publication is transactional (ARC-14, P0-10). The order is fixed:
 *
 *   snapshot the current generation
 *   -> provide the design-system module (pages import it BY PATH, so it must
 *      exist while the pages are compiled; it is snapshotted, so a rollback
 *      restores it)
 *   -> compute the module closure of the declared roots
 *   -> compile every covered source
 *   -> compare expected vs analysed
 *   -> generate CSS / manifest / report into STAGING
 *   -> publish (manifest last)
 *
 * Any throw rolls the whole generation back, so the previously published
 * artifacts stay current, byte for byte, and no N/N+1 mix can be observed.
 *
 * @param {object} config
 * @param {object} config.definition       design system definition object
 * @param {string[]} config.roots          declared covered roots (absolute or cwd-relative)
 * @param {string}   config.outDir         output directory
 * @param {string}   [config.designSystemFile] filename of the generated design system module
 * @param {Function} [config.onStage]      test seam, called once every source is
 *                                         compiled and BEFORE anything is
 *                                         published, so an internal failure at
 *                                         that point can be exercised
 */
export function buildProject(config) {
  const graphContext = createModuleGraphContext();
  return runWithModuleGraphContext(graphContext, () =>
    buildProjectInContext(config),
  );
}

function buildProjectInContext(config) {
  const {
    definition,
    roots = [],
    outDir,
    designSystemFile = 'design.pandamstyle.js',
    engineOptions = {},
    useCSSLayers = false,
    onStage = null,
  } = config;

  const absOut = path.resolve(outDir);
  const designSystemPath = path.join(absOut, designSystemFile);

  try {
    return withGeneration(
      absOut,
      (gen) => {
        // The session makes the design system module resolvable (through the
        // module overlay, never on disk) and stages it with the rest of the
        // generation.
        const session = createCompilerSession({
          definition,
          roots,
          designSystemFile,
          engineOptions,
          useCSSLayers,
          generation: gen,
        });
        const designSystem = session.designSystem;
        const registryDigest = session.registryDigest;

        const { covered, unresolved, external, relayEdges } =
          collectCoveredFiles(roots);

        // Compiled JS is emitted next to the artifacts, never over the page
        // sources: the build must be repeatable and must not mutate application
        // code.
        const sourceBase = commonBase(roots.map((r) => path.resolve(r)));
        const outputRelFor = (file) => {
          const rel = path.relative(sourceBase, file);
          const safe = rel.startsWith('..') ? path.basename(file) : rel;
          return path.posix.join('js', safe.split(path.sep).join('/'));
        };

        if (unresolved.length > 0) {
          throw new PmsError(
            unresolved.map((u) =>
              u.form === 'syntax'
                ? diagnostic({
                    code: Codes.COVERAGE_GAP,
                    phase: 'coverage',
                    message: `Syntax error in covered file ${u.from}. Fix the parse error before compiling this project.`,
                    source: {
                      file: u.from,
                      line: u.line ?? null,
                      column: u.column ?? null,
                      role: 'page',
                    },
                    rule: 'coverage.source-syntax',
                    context: {
                      from: u.from,
                      form: 'syntax',
                      line: u.line ?? null,
                      column: u.column ?? null,
                    },
                  })
                : diagnostic({
                    code: Codes.COVERAGE_GAP,
                    phase: 'coverage',
                    message:
                      `Unresolved local ${u.form ?? 'import'} "${u.request}" from ` +
                      `covered file ${u.from}. P0 requires a static module graph, so ` +
                      'an unresolved edge is a coverage gap, not a skipped file.',
                    source: u.from,
                    rule: 'coverage.local-imports',
                    context: {
                      request: u.request,
                      from: u.from,
                      form: u.form ?? 'import',
                      line: u.line ?? null,
                    },
                  }),
            ),
          );
        }

        // The generated design system module is part of the shipped application.
        covered.set(designSystemPath, 'generated');

        // The design system emits its own rules first: the `:root` variable group
        // and the theme classes. Consumer rules join the same generation
        // (ARC-14), so the whole stylesheet references one registry.
        const allRules = session.designSystemRules();
        const designSystemRuleCount = allRules.length;

        const coverage = [];
        const failures = [];
        const outputs = [];
        const analysed = [];

        for (const [file, origin] of covered) {
          if (file === designSystemPath) {
            // Emitted as-is; the generator already produced it.
            coverage.push({
              file: relativeToCwd(file),
              origin,
              role: 'design-system',
              analysed: true,
              diagnostics: 0,
            });
            continue;
          }
          const readStart = perfNow();
          const code = fs.readFileSync(file, 'utf8');
          const collector = perfCollector();
          if (collector != null) {
            collector.addDuration('io_ms', perfNow() - readStart);
            collector.addCount('read_bytes', Buffer.byteLength(code, 'utf8'));
            collector.addCount('read_calls');
          }
          let result;
          try {
            result = compileFile(code, file, designSystem, engineOptions);
          } catch (err) {
            if (err != null && Array.isArray(err.diagnostics)) {
              failures.push(...err.diagnostics);
              coverage.push({
                file: relativeToCwd(file),
                origin,
                role: 'page',
                analysed: true,
                failed: true,
                diagnostics: err.diagnostics.length,
                codes: [...new Set(err.diagnostics.map((d) => d.code))],
              });
              // Still counted as analysed: the policy DID run and refused it.
              analysed.push(file);
              continue;
            }
            throw err;
          }
          const rules = result.metadata.pandamstyle ?? [];
          for (const rule of rules) allRules.push(rule);
          const coverageEntry = result.metadata.pandamstyleCoverage ?? {};
          coverage.push({
            file: relativeToCwd(file),
            origin,
            role: 'page',
            analysed: true,
            usedDesignSystem: coverageEntry.usedDesignSystem === true,
            usedPmsHelpers: coverageEntry.usedPmsHelpers === true,
            ruleCount: rules.length,
            relayChain: (coverageEntry.relayChain ?? []).map(relativeToCwd),
            diagnostics: 0,
          });
          analysed.push(file);
          outputs.push({ file, code: result.code });
        }

        // Expected vs analysed, before anything is published. The generated
        // design-system module is exempt: it IS the generator output, and the
        // build does not re-analyse it.
        const consistency = assertCoverageConsistency({
          coveredFiles: [...covered.keys()],
          transformedFiles: analysed,
          exemptFiles: [designSystemPath],
          phase: 'cli',
        });
        if (!consistency.ok) {
          throw new PmsError(
            coverageGapDiagnostics(consistency.missing, 'cli'),
          );
        }

        // Test seam: observe the generated state after every covered source
        // has been attempted but BEFORE a verdict can publish anything. This
        // remains available for rejected builds so the independent fresh
        // oracle can inspect the same authority context that produced them.
        if (typeof onStage === 'function') {
          onStage({ gen, session, coverage });
        }

        // A failing generation must not publish artifacts as current (ARC-14).
        if (failures.length > 0) {
          throw new PmsError(failures);
        }

        // Single CSS circuit: the fork's own rule processor.
        const css = withDesignSystemCssIdentity(
          session.renderCss(allRules),
          designSystem.snapshot.identity,
        );

        const buildReport = {
          documentKind: BUILD_REPORT_KIND,
          // The same schema version the project session writes, and for the
          // same reason. The full rebuild is the session's SEMANTIC reference -
          // if the two disagreed about the report's shape, an oracle comparing
          // them would be comparing two formats and calling the difference a
          // compiler difference.
          schemaVersion: BUILD_REPORT_SCHEMA_VERSION,
          contractVersion: designSystem.manifest.compilerContractVersion,
          systemId: designSystem.registry.systemId,
          registryDigest,
          coveredRoots: roots.map((r) => path.resolve(r)),
          coveredFileCount: coverage.length,
          analysedFileCount: analysed.length,
          designSystemRuleCount,
          consumerRuleCount: allRules.length - designSystemRuleCount,
          ruleCount: allRules.length,
          cssBytes: Buffer.byteLength(css, 'utf8'),
          // Schema version 1 carried the project-wide `coverage` array inline.
          // Version 2 carries the counts and a reference; the detail document is
          // `coverage.json`, staged below. See `agent-result.js`.
          coverageSummary: coverageSummary(coverage),
          coverageReport: coverageReference({
            // The full rebuild has no revision counter of its own: a build is
            // one revision, and naming it 0 is a fact about the API rather than
            // a stand-in for a sequence the caller does not have.
            revisionId: 0,
            summary: coverageSummary(coverage),
            materialized: true,
          }),
          coverageConsistency: {
            expectedCount: consistency.expectedCount,
            analysedCount: consistency.transformedCount,
            missing: consistency.missing.map(relativeToCwd),
            classification:
              'a covered file that the CLI did not analyse fails the build',
          },
          externalRequests: external.map((e) => ({
            request: e.request,
            form: e.form,
            from: relativeToCwd(e.from),
          })),
          relayEdges: relayEdges.map((e) => ({
            from: relativeToCwd(e.from),
            to: relativeToCwd(e.to),
            form: e.form,
          })),
        };

        // A one-shot build has no agent waiting on a compact result, so it has
        // no reason to defer anything: the coverage detail is staged with
        // everything else, in the same generation and the same commit. The
        // deferral exists for a long-lived session's hot path, not for a build
        // that is going to write its whole output once.
        const coverageDoc = buildCoverageReport({
          contractVersion: designSystem.manifest.compilerContractVersion,
          systemId: designSystem.registry.systemId,
          registryDigest,
          revisionId: 0,
          generationId: null,
          coveredRoots: roots.map((r) => path.resolve(r)),
          entries: coverage,
        });

        const manifestWithDigest = designSystem.snapshot.tooling.manifest;
        const manifestText = phase(
          'ds_manifest_codegen_ms',
          () => JSON.stringify(manifestWithDigest, null, 2) + '\n',
        );
        const artifactSet = phase('ds_artifact_set_ms', () =>
          createArtifactSet(designSystem.snapshot, {
            designModuleFile: designSystemFile,
            declarationsFile: session.designDeclarationsFile,
            designModule: session.designSystemSource,
            declarations: session.designDeclarationsSource,
            manifest: manifestText,
            css,
          }),
        );

        for (const { file, code } of outputs) {
          gen.stage(outputRelFor(file), code);
        }
        gen.stage('styles.css', css);
        gen.stage(
          session.designDeclarationsFile,
          session.designDeclarationsSource,
        );
        gen.stage(
          'build-report.json',
          JSON.stringify(buildReport, null, 2) + '\n',
        );
        gen.stage(
          COVERAGE_REPORT_FILE,
          JSON.stringify(coverageDoc, null, 2) + '\n',
        );
        gen.stage('manifest.json', manifestText);
        gen.stage('artifacts.json', artifactSet.text);

        return {
          css,
          manifest: manifestWithDigest,
          buildReport,
          coverageReport: coverageDoc,
          designSystem,
          designSystemPath,
          coverage,
          outputs,
          registryDigest,
          // withGeneration() publishes this once the callback returns.
          published: [
            ...outputs.map(({ file }) => outputRelFor(file)),
            'styles.css',
            session.designDeclarationsFile,
            'build-report.json',
            COVERAGE_REPORT_FILE,
            'manifest.json',
            'artifacts.json',
            designSystemFile,
          ],
        };
      },
      { commitMarker: 'manifest.json' },
    );
  } finally {
    // The overlay is a compile-time convenience of THIS generation; it must not
    // leak into a later build in the same process.
    clearModuleOverlay();
  }
}

/**
 * Runs the fork's Babel pipeline with the PandamStyle plugin, then lowers TS and
 * JSX in a second pass.
 *
 * The two passes are deliberate: pass 1 must see real JSX so the closed-profile
 * channel checks (inline `style`, opaque spreads) can inspect them, and it must
 * see real TS so `as any` / `satisfies` folding happens before policy. Pass 2
 * only lowers syntax; it cannot introduce a style channel.
 */
