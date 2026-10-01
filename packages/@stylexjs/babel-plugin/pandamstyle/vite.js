/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - Vite / Rollup integration (P0-09, P0-11, ARC-13).
 *
 * TEMPORARY PHASE 8 INTEGRATION SEAM: the compiler package bundles this
 * adapter only for the current verifier/pilot. Phase 8 moves it to
 * `packages/vite`; remove this source and the compiler `/vite` subpath then.
 *
 * This adapts the fork's integration rather than replacing it: rules are
 * collected in the same shape as StyleX and rendered by the fork's own
 * `processStylexRules`, so there is a single CSS emission circuit.
 *
 * What it changes on purpose, compared to the upstream import gate:
 *  - coverage is declared by ROOTS, not by grepping the source for
 *    `@stylexjs/stylex`. A file under a declared root is analysed whether or not
 *    it looks like a style file;
 *  - the local import closure of those roots is analysed too, so a page that
 *    only imports a generated recipe or a re-export is still covered;
 *  - a policy or coverage failure THROWS, so the bundler exits non-zero.
 */

import * as path from 'path';
import { pathToFileURL } from 'node:url';
import {
  assertCoverageConsistency,
  createCompilerSession,
  collectCoveredFiles,
} from '../../../compiler/src/project/session/fresh.js';
import { beginGeneration } from '../../../compiler/src/artifacts/publication/transaction.js';
import { clearModuleOverlay } from '../../../compiler/src/project/graph/resolution.js';
import {
  PmsError,
  Codes,
  diagnostic,
  formatDiagnostic,
} from '../../../compiler/src/protocol/diagnostics.js';

const SOURCE_RE = /\.(jsx?|tsx?|mjs|cjs)$/;

/**
 * Resolves the design system definition.
 *
 * An object is used as-is (the usual case: `vite.config.js` imports it). A
 * string is a module path, loaded with a dynamic import so an ESM definition
 * works in both the CJS and the ESM build of this adapter.
 */
async function loadDefinition(designSystemOption, root) {
  if (designSystemOption == null) {
    throw new Error(
      'pandamstyle: `designSystem` is required and must be the design system ' +
        'definition object, or a path to its module.',
    );
  }
  if (typeof designSystemOption === 'object') return designSystemOption;
  const file = path.resolve(root, designSystemOption);
  const mod = await import(pathToFileURL(file).href);
  const value = mod != null && mod.default != null ? mod.default : mod;
  return typeof value === 'function' ? value() : value;
}

const CSS_ASSET_RE = /\.css$/i;

export function pandamstyle(userOptions = {}) {
  // `process.cwd()` is only a bootstrap default: Vite's resolved root is
  // authoritative, because `outDir` and the covered roots are resolved against
  // it and a project whose root differs from the cwd must still work.
  let root = process.cwd();
  const options = { ...userOptions };
  const rulesById = new Map();
  const coverage = [];
  let session = null;
  let sessionPromise = null;
  let coveredFiles = null;
  let css = '';
  // The transaction spans the whole bundler run. Every artifact is staged and
  // published in closeBundle(), so a build that fails after this plugin started
  // generating leaves the previous generation current, byte for byte.
  let gen = null;
  let settled = false;

  async function ensureSession() {
    if (session != null) return session;
    if (sessionPromise != null) return sessionPromise;
    sessionPromise = (async () => {
      const definition = await loadDefinition(options.designSystem, root);
      session = createCompilerSession({
        definition,
        roots: (options.roots ?? ['.']).map((r) => path.resolve(root, r)),
        runtimeModule: options.runtimeModule,
        designSystemFile: options.designSystemFile,
        engineOptions: options.engineOptions,
        useCSSLayers: options.useCSSLayers === true,
        role: options.role ?? 'page',
        // The generated module is provided at its final path: the pages import
        // it by path and the compiler resolves the design system through the
        // module graph. The transaction snapshots it, so a rollback restores it.
        generation: gen,
      });
      return session;
    })();
    return sessionPromise;
  }

  function outDir() {
    return path.resolve(root, options.outDir ?? '.pandamstyle');
  }

  /**
   * Fails the build when a covered module the bundler actually loaded was never
   * handed to this plugin. `transformInclude()` returning true is not evidence
   * that a transform ran, so the sets are compared after the fact.
   *
   * The generated design-system module is exempt: it is the generator's own
   * output, and re-analysing it would be meaningless.
   */
  function assertBundledCoverage(s) {
    const expected = s.coveredFiles.filter((f) => rulesById.has(f) === false);
    const consistency = assertCoverageConsistency({
      coveredFiles: [...s.coveredFiles],
      transformedFiles: [...rulesById.keys()],
      exemptFiles: [path.join(outDir(), s.designSystemFile)],
      phase: 'vite',
    });
    return { consistency, expected };
  }

  /**
   * Modules the bundler demonstrably loaded. `transformInclude` is only an
   * offer, so the graph is recorded from the `load` hook, which runs for every
   * module the bundler really reads.
   */
  const bundlerModules = new Set();

  function discardGeneration() {
    if (gen == null) return;
    gen.rollback();
    clearModuleOverlay();
  }

  return {
    name: 'pandamstyle',
    // Run before other transforms so the JSX/TS folding order is ours.
    enforce: 'pre',

    buildStart() {
      rulesById.clear();
      coverage.length = 0;
      bundlerModules.clear();
    },

    /**
     * Opens the generation and creates the session. The generated design-system
     * module becomes resolvable through the module overlay - NOT on disk - so
     * coverage can be computed while the output directory is still untouched.
     */
    async configResolved(config) {
      if (config != null && config.root != null) {
        root = path.resolve(config.root);
      }
      // `build.write: false` means the bundler never calls `writeBundle`, which is
      // this plugin's only success signal. Refused here, before any work, with a
      // message the user can act on - rather than discovered at the end of a build
      // that silently published no stylesheet.
      if (config?.build?.write === false) {
        throw new PmsError([
          diagnostic({
            code: 'PMS_UNSUPPORTED_FEATURE',
            phase: 'publish',
            message:
              "PandamStyle publishes its generation from the bundler's " +
              '`writeBundle` hook, which `build.write: false` never calls. ' +
              'Publishing nothing is indistinguishable from having no ' +
              'stylesheet, so this mode is refused. Run PandamStyle from the CLI ' +
              '(`pms-build`) when the bundler is configured not to write.',
            rule: 'publish.output-phase',
            context: { buildWrite: false },
          }),
        ]);
      }
      gen = beginGeneration(outDir(), { label: 'vite' });
      settled = false;
      const s = await ensureSession();
      // `s.coveredFiles` excludes the generated design-system module: it is the
      // generator's output, so it is not analysed and not expected to be.
      coveredFiles = new Set(s.coveredFiles);

      if (s.unresolved.length > 0) {
        const error = new PmsError(
          s.unresolved.map((u) =>
            diagnostic({
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
              },
            }),
          ),
        );
        // Nothing was ever written into the output directory, so discarding the
        // generation here is only about the scratch directories.
        discardGeneration();
        settled = true;
        throw error;
      }
    },

    /** Records what the bundler really loaded, for the coverage cross-check. */
    load(id) {
      const file = id.split('?')[0];
      if (SOURCE_RE.test(file)) bundlerModules.add(path.resolve(file));
      return null;
    },

    /**
     * Coverage gate: a file is transformed when it lies under a declared root
     * or inside the local module closure of those roots (imports AND
     * re-exports). This is deliberately broader than any textual import filter.
     */
    transformInclude(id) {
      const file = id.split('?')[0];
      if (!SOURCE_RE.test(file)) return false;
      // Coverage is computed from the declared roots alone, so this gate needs
      // no design system and stays synchronous, as the bundler requires.
      if (coveredFiles == null) {
        coveredFiles = new Set([
          ...collectCoveredFiles(
            (options.roots ?? ['.']).map((r) => path.resolve(root, r)),
          ).covered.keys(),
        ]);
      }
      return coveredFiles.has(path.resolve(file));
    },

    async transform(code, id) {
      const file = path.resolve(id.split('?')[0]);
      const s = await ensureSession();
      if (!s.coveredFiles.includes(file)) return null;

      let result;
      try {
        result = s.compileSource(code, file);
      } catch (err) {
        if (err != null && Array.isArray(err.diagnostics)) {
          coverage.push({
            file,
            analysed: true,
            failed: true,
            codes: [...new Set(err.diagnostics.map((d) => d.code))],
          });
          // Rethrow: the bundler must fail, not warn. The generation is
          // discarded in buildEnd/closeBundle, so no artifact becomes current.
          const wrapped = new PmsError(err.diagnostics);
          wrapped.message = err.diagnostics.map(formatDiagnostic).join('\n');
          throw wrapped;
        }
        throw err;
      }

      const rules = result.metadata.pandamstyle ?? [];
      rulesById.set(file, rules);
      coverage.push({
        file,
        analysed: true,
        role: result.metadata.pandamstyleCoverage?.role ?? 'page',
        usedDesignSystem:
          result.metadata.pandamstyleCoverage?.usedDesignSystem === true,
        usedPmsHelpers:
          result.metadata.pandamstyleCoverage?.usedPmsHelpers === true,
        relayChain: result.metadata.pandamstyleCoverage?.relayChain ?? [],
        ruleCount: rules.length,
      });

      // NOTHING is written here. The previous version wrote the report and the
      // manifest during this hook, so a build failing later presented a
      // generation that was never complete.
      return { code: result.code, map: null };
    },

    /**
     * End-of-build coverage cross-check. This runs at the end of the BUILD phase,
     * which is BEFORE the output phase, so it cannot observe an output-phase
     * failure. Nothing has been written to the output directory at this point,
     * which is what makes that acceptable: if the output phase later fails, the
     * previous generation is still the state on disk.
     */
    async buildEnd(error) {
      if (gen == null || settled) return;
      if (error != null) {
        discardGeneration();
        settled = true;
        return;
      }
      const s = await ensureSession();
      const { consistency } = assertBundledCoverage(s);
      if (!consistency.ok) {
        const missing = new PmsError(
          consistency.missing.map((file) =>
            diagnostic({
              code: Codes.COVERAGE_GAP,
              phase: 'coverage',
              message:
                `Covered file was never analysed: ${file}. The bundler loaded it ` +
                '(so it is part of the application) but this plugin did not ' +
                'compile it. A transform hook admitting a module is not proof ' +
                'it ran.',
              source: file,
              rule: 'coverage.expected-vs-analysed',
              context: { file, phase: 'vite' },
            }),
          ),
        );
        discardGeneration();
        settled = true;
        throw missing;
      }
    },

    async generateBundle(_options, bundle) {
      const s = await ensureSession();
      const allRules = [...s.designSystemRules()];
      for (const rules of rulesById.values()) allRules.push(...rules);
      css = s.renderCss(allRules);

      // Emit the stylesheet as a first-class asset, and also append it to the
      // application's own CSS asset when one exists, so the production CSS is
      // loaded before the first render.
      const cssAssetName = 'pandamstyle.css';
      this.emitFile({ type: 'asset', fileName: cssAssetName, source: css });

      const target = Object.values(bundle).find(
        (chunk) =>
          chunk.type === 'asset' && CSS_ASSET_RE.test(chunk.fileName ?? ''),
      );
      if (target != null) {
        const current = typeof target.source === 'string' ? target.source : '';
        target.source = `${current}\n${css}`;
      }
    },

    /**
     * THE PUBLICATION POINT.
     *
     * `writeBundle` is the one output-phase hook a bundler calls only when the
     * output phase completed. The others are not usable as a success signal:
     *
     *   - `buildEnd` runs at the end of the BUILD phase, before `generateBundle`,
     *     so it always reports success, even for a build that fails later;
     *   - `closeBundle` runs after a failed output phase too;
     *   - `buildApp` is a Vite config-time hook, not an end-of-build one.
     *
     * So the commit happens here, and `closeBundle` discards the generation if it
     * is reached without a commit.
     */
    writeBundle() {
      if (gen == null || settled) return;
      settled = true;
      const s = session;
      if (s == null) {
        gen.rollback();
        clearModuleOverlay();
        return;
      }

      const { consistency } = assertBundledCoverage(s);
      const report = {
        documentKind: 'pandamstyle-vite-build-report',
        systemId: s.designSystem.registry.systemId,
        registryDigest: s.registryDigest,
        coveredRoots: s.roots,
        coveredFileCount: s.coveredFiles.length,
        transformedFileCount: rulesById.size,
        bundlerLoadedFileCount: bundlerModules.size,
        coverageConsistency: {
          expectedCount: consistency.expectedCount,
          analysedCount: consistency.transformedCount,
          missing: consistency.missing,
          classification:
            'a covered file the bundler loaded but this plugin did not compile ' +
            'fails the build; a covered file the entry graph never reaches is ' +
            'analysed by the CLI path and reported here, not silently dropped',
          notInBundlerGraph: s.coveredFiles
            .filter((f) => !rulesById.has(f))
            .filter((f) => !bundlerModules.has(f)),
        },
        externalRequests: (s.externalRequests ?? []).map((e) => ({
          request: e.request,
          form: e.form,
          from: e.from,
        })),
        relayEdges: (s.relayEdges ?? []).map((e) => ({
          from: e.from,
          to: e.to,
          form: e.form,
        })),
        coverage,
      };

      gen.stage('styles.css', css);
      gen.stage('build-report.json', JSON.stringify(report, null, 2) + '\n');
      gen.stage(
        'manifest.json',
        JSON.stringify(
          { ...s.designSystem.manifest, registryDigest: s.registryDigest },
          null,
          2,
        ) + '\n',
      );
      gen.commit();
      clearModuleOverlay();
    },

    /**
     * Reached after `writeBundle` on success, and after a failed output phase on
     * failure. An uncommitted generation means the output phase did not complete,
     * so the previous generation is restored.
     *
     * Nothing is thrown here: the build has already failed and the caller must
     * see the REAL cause, not a publishing complaint from a plugin that was
     * working as designed. The `build.write: false` case, which cannot reach
     * `writeBundle` at all, is refused up front in `configResolved` instead.
     */
    closeBundle() {
      if (gen == null || settled) return;
      settled = true;
      discardGeneration();
    },

    transformIndexHtml(html) {
      if (css === '') return html;
      return html.replace(
        /<\/head>/i,
        '  <link rel="stylesheet" href="/pandamstyle.css" />\n</head>',
      );
    },
  };
}

export default pandamstyle;
