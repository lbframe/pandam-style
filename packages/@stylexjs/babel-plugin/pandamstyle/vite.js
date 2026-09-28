/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - Vite / Rollup integration (P0-09, P0-11, ARC-13).
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

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'node:url';
import { createCompilerSession, collectCoveredFiles } from './build';
import { PmsError, Codes, diagnostic, formatDiagnostic } from './diagnostics';

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
  const root = process.cwd();
  const options = { ...userOptions };
  const rulesById = new Map();
  const coverage = [];
  let session = null;
  let sessionPromise = null;
  let coveredFiles = null;
  let css = '';

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
      });

      // The generated design system module must exist for module resolution.
      const outDir = path.resolve(root, options.outDir ?? '.pandamstyle');
      fs.mkdirSync(outDir, { recursive: true });
      const dsFile = path.join(outDir, session.designSystemFile);
      fs.writeFileSync(dsFile, session.designSystemSource, 'utf8');

      if (session.unresolved.length > 0) {
        throw new PmsError(
          session.unresolved.map((u) =>
            diagnostic({
              code: Codes.COVERAGE_GAP,
              phase: 'coverage',
              message: `Unresolved local import "${u.request}" from covered file ${u.from}.`,
              source: u.from,
              rule: 'coverage.local-imports',
              context: { request: u.request, from: u.from },
            }),
          ),
        );
      }
      return session;
    })();
    return sessionPromise;
  }

  return {
    name: 'pandamstyle',
    // Run before other transforms so the JSX/TS folding order is ours.
    enforce: 'pre',

    buildStart() {
      rulesById.clear();
      coverage.length = 0;
    },

    /**
     * Ordering matters: the generated design system module must exist on disk
     * BEFORE coverage is computed, because pages import it by module path and
     * the compiler resolves the design system through the module graph.
     */
    async configResolved() {
      const s = await ensureSession();
      coveredFiles = new Set(s.coveredFiles);
    },

    /**
     * Coverage gate: a file is transformed when it lies under a declared root
     * or inside its local import closure. This is deliberately broader than any
     * textual import filter.
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
          // Rethrow: the bundler must fail, not warn.
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

      const outDir = path.resolve(root, options.outDir ?? '.pandamstyle');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'build-report.json'),
        JSON.stringify(
          {
            documentKind: 'pandamstyle-vite-build-report',
            systemId: s.designSystem.registry.systemId,
            registryDigest: s.registryDigest,
            coveredRoots: s.roots,
            coveredFileCount: s.coveredFiles.length,
            transformedFileCount: rulesById.size,
            coverage,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify(
          { ...s.designSystem.manifest, registryDigest: s.registryDigest },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      return { code: result.code, map: null };
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
