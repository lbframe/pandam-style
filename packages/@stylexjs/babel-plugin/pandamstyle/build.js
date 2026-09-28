/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - project build (ARC-13, ARC-14, P0-09, P0-10).
 *
 * This is the real entry point the tests and the pilot drive. It does NOT take
 * a pre-normalized IR: it reads actual JS/TS/TSX files from declared roots,
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
import babel from '@babel/core';
import presetTypeScript from '@babel/preset-typescript';
import presetReact from '@babel/preset-react';
import styleXTransform from '../src/index';

// Babel presets ship as CommonJS; normalize the interop shape once.
const tsPreset = presetTypeScript?.default ?? presetTypeScript;
const reactPreset = presetReact?.default ?? presetReact;

import { PmsError, Codes, diagnostic, formatDiagnostic } from './diagnostics';
import { buildDesignSystem } from './index';
import { generateDesignSystemModule } from './codegen';
import { pandamstyleBabelPlugin } from './babel-plugin';
import {
  clearModuleCache,
  parseModuleFile,
  resolveRelativeFile,
} from './module-graph';

const SOURCE_RE = /\.(jsx?|tsx?|mjs|cjs)$/;
// Stylesheet requests are handled by the plugin's style-channel check, not by
// the module closure: a .css file is not a compilable module.
const STYLESHEET_RE = /\.(css|scss|sass|less|styl)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
]);

function walkFiles(dir, out = []) {
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

function localImportsOf(file) {
  const parsed = parseModuleFile(file);
  if (parsed.ast == null) return [];
  const out = [];
  for (const node of parsed.ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (node.source == null) continue;
    const request = node.source.value;
    if (!request.startsWith('.')) continue;
    if (STYLESHEET_RE.test(request)) continue;
    const resolved = resolveRelativeFile(file, request);
    out.push({ request, resolved });
  }
  return out;
}

/**
 * Declared roots + the local-import closure they pull in.
 * Every returned file must be analysed, or the build fails.
 */
export function collectCoveredFiles(roots) {
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

  // Import closure: a page that only imports a generated recipe or a re-export
  // is still covered.
  const unresolved = [];
  while (queue.length > 0) {
    const file = queue.pop();
    for (const imp of localImportsOf(file)) {
      if (imp.resolved == null) {
        unresolved.push({ from: file, request: imp.request });
        continue;
      }
      if (!covered.has(imp.resolved)) {
        covered.set(imp.resolved, 'import-closure');
        queue.push(imp.resolved);
      }
    }
  }
  return { covered, unresolved };
}

/** Deepest common directory of a list of paths. */
function commonBase(paths) {
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function relativeToCwd(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? file : rel;
}

/**
 * Creates a reusable compilation session.
 *
 * The Vite/Rollup adapter and `buildProject` share it so both drive the exact
 * same two-pass pipeline, the same policy and the same engine: there is only
 * one compilation circuit.
 */
export function createCompilerSession(config) {
  const {
    definition,
    roots = [],
    runtimeModule = '@pandamstyle/compiler/runtime',
    designSystemFile = 'design.pandamstyle.js',
    engineOptions = {},
    useCSSLayers = false,
    role = 'page',
  } = config;

  clearModuleCache();
  const designSystem = buildDesignSystem(definition, { ...engineOptions });

  // Coverage is LAZY on purpose: the generated design system module must be on
  // disk before the import closure is walked, because pages import it by module
  // path. The bundler adapter writes it right after this call returns.
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
    runtimeModule,
    designSystemFile,
    get coveredFiles() {
      return [...covered().covered.keys()];
    },
    get coverage() {
      return covered().covered;
    },
    get unresolved() {
      return covered().unresolved;
    },
    registryDigest: designSystem.registry.registryDigest,
    designSystemSource: generateDesignSystemModule({
      designSystem,
      runtimeModule,
    }),
    compileSource: (code, filename) =>
      compileFile(code, filename, designSystem, { ...engineOptions, role }),
    renderCss: (rules) =>
      styleXTransform.processStylexRules(rules, { useLayers: useCSSLayers }),
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
 * @param {object} config
 * @param {object} config.definition       design system definition object
 * @param {string[]} config.roots          declared covered roots (absolute or cwd-relative)
 * @param {string}   config.outDir         output directory
 * @param {string}   [config.runtimeModule] module specifier the generated design system imports
 * @param {string}   [config.designSystemFile] filename of the generated design system module
 */
export function buildProject(config) {
  const {
    definition,
    roots = [],
    outDir,
    runtimeModule = '@pandamstyle/compiler/runtime',
    designSystemFile = 'design.pandamstyle.js',
    engineOptions = {},
    useCSSLayers = false,
  } = config;

  clearModuleCache();

  const designSystem = buildDesignSystem(definition, { ...engineOptions });
  const registryDigest = designSystem.registry.registryDigest;

  const absOut = path.resolve(outDir);
  const designSystemPath = path.join(absOut, designSystemFile);

  ensureDir(absOut);
  // The design system module must exist on disk before the pages are compiled:
  // the compiler resolves the design system by module path, not by config.
  // It is therefore snapshotted so a failing build can restore the last valid
  // generation instead of leaving a half-published one (ARC-14).
  const previousDesignSystem = fs.existsSync(designSystemPath)
    ? fs.readFileSync(designSystemPath, 'utf8')
    : null;
  const restoreDesignSystem = () => {
    if (previousDesignSystem == null) {
      fs.rmSync(designSystemPath, { force: true });
    } else {
      fs.writeFileSync(designSystemPath, previousDesignSystem, 'utf8');
    }
  };
  fs.writeFileSync(
    designSystemPath,
    generateDesignSystemModule({ designSystem, runtimeModule }),
    'utf8',
  );

  const { covered, unresolved } = collectCoveredFiles(roots);

  // Compiled JS is emitted next to the artifacts, never over the page sources:
  // the build must be repeatable and must not mutate application code.
  const sourceBase = commonBase(roots.map((r) => path.resolve(r)));
  const outputPathFor = (file) => {
    const rel = path.relative(sourceBase, file);
    const safe = rel.startsWith('..') ? path.basename(file) : rel;
    return path.join(absOut, 'js', safe);
  };

  if (unresolved.length > 0) {
    restoreDesignSystem();
    throw new PmsError(
      unresolved.map((u) =>
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

  // The generated design system module is part of the shipped application.
  covered.set(designSystemPath, 'generated');

  // The design system emits its own rules first: the `:root` variable group and
  // the theme classes. Consumer rules join the same generation (ARC-14), so the
  // whole stylesheet references one registry.
  const allRules = [];
  for (const [key, { priority, ...rest }] of Object.entries(
    designSystem.injected,
  )) {
    allRules.push([key, rest, priority ?? 0]);
  }
  const designSystemRuleCount = allRules.length;

  const coverage = [];
  const failures = [];
  const outputs = [];

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
    const code = fs.readFileSync(file, 'utf8');
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
    outputs.push({ file, code: result.code });
  }

  // A failing generation must not publish artifacts as current (ARC-14).
  if (failures.length > 0) {
    restoreDesignSystem();
    throw new PmsError(failures);
  }

  // Single CSS circuit: the fork's own rule processor.
  const css = styleXTransform.processStylexRules(allRules, {
    useLayers: useCSSLayers,
  });

  const buildReport = {
    documentKind: 'pandamstyle-build-report',
    contractVersion: designSystem.manifest.compilerContractVersion,
    systemId: designSystem.registry.systemId,
    registryDigest,
    coveredRoots: roots.map((r) => path.resolve(r)),
    coveredFileCount: coverage.length,
    designSystemRuleCount,
    consumerRuleCount: allRules.length - designSystemRuleCount,
    ruleCount: allRules.length,
    cssBytes: Buffer.byteLength(css, 'utf8'),
    coverage,
  };

  const manifestWithDigest = {
    ...designSystem.manifest,
    registryDigest,
    designSystemModule: relativeToCwd(designSystemPath),
  };

  for (const { file, code } of outputs) {
    const target = outputPathFor(file);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, code, 'utf8');
  }
  fs.writeFileSync(path.join(absOut, 'styles.css'), css, 'utf8');
  fs.writeFileSync(
    path.join(absOut, 'manifest.json'),
    JSON.stringify(manifestWithDigest, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(absOut, 'build-report.json'),
    JSON.stringify(buildReport, null, 2) + '\n',
    'utf8',
  );

  return {
    css,
    manifest: manifestWithDigest,
    buildReport,
    designSystem,
    designSystemPath,
    coverage,
    outputs,
    registryDigest,
  };
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
export function compileFile(code, filename, designSystem, engineOptions = {}) {
  const pass1 = babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [
      [pandamstyleBabelPlugin, { designSystem, role: 'page', engineOptions }],
    ],
  });
  if (pass1 == null) throw new Error(`No output for ${filename}`);

  const pass2 = babel.transformSync(pass1.code, {
    filename: filename.replace(/\.tsx?$/, '.jsx'),
    babelrc: false,
    configFile: false,
    sourceType: 'module',
    presets: [
      [tsPreset, { allExtensions: true, isTSX: true }],
      [reactPreset, { runtime: 'automatic', development: false }],
    ],
  });
  const out = pass2 ?? pass1;
  return { code: out.code, metadata: { ...out.metadata, ...pass1.metadata } };
}

export { formatDiagnostic };
