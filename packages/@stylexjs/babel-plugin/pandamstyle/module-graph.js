/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - module graph of the closed profile (ARC-13, P0-09).
 *
 * Import discovery is NOT a text filter looking for `@stylexjs/stylex`: it
 * starts from the Babel *binding*, resolves the file, then follows re-exports
 * up to the generated design-system module.
 *
 * Three consequences the brief requires:
 *  - a renamed import is recognized (we track `specifier.local`);
 *  - an intermediate re-export is followed up to the design system;
 *  - a local helper named `token`, a `var(--...)` string, or an object
 *    imitating an internal reference gains no trust: only the exports of a
 *    file carrying the generated mark count.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseModule } from '@babel/parser';
import {
  count,
  phase,
  recordParse,
  withParseOwner,
  workEliminated,
} from './perf';

export const DESIGN_SYSTEM_MARKER = '__PMS_DESIGN_SYSTEM__';

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/**
 * The explicit extension forms a page is allowed to write (or to omit).
 *
 * Exported because the project session resolves edges with the SAME candidate
 * order. Two resolvers with two candidate orders are how a file becomes
 * "resolvable" in one code path and "unresolvable" in the other, and the
 * resulting coverage verdict would depend on which one ran.
 */
export { SOURCE_EXTENSIONS };

const parseCache = new Map();

/**
 * In-memory modules: absolute path -> source text.
 *
 * This exists for ONE reason. The generated design-system module must be
 * resolvable by module path while the pages are compiled, because that is how
 * the compiler recognizes a design system. The obvious way to arrange that is to
 * write it to disk first - and that is precisely what makes a failed build
 * observable as a mixed generation: the file on disk is generation N+1 while the
 * manifest next to it is still generation N.
 *
 * A bundler also cannot be relied on to tell us that it failed. Vite calls the
 * `buildEnd` hook at the end of the BUILD phase, which is before the output
 * phase: an error thrown from `generateBundle` - by a later plugin, or by the
 * bundler itself - never reaches `buildEnd` or `closeBundle`. A plugin that
 * writes during the build therefore has no reliable moment at which to undo it.
 *
 * So nothing is written during the build. The generated module is served from
 * this overlay, and it is published with the rest of the generation, atomically,
 * only after the bundler has succeeded.
 */
let moduleOverlay = new Map();

/**
 * WORK-ELIMINATED ONLY.
 *
 * Two caches of derivations that are pure functions of the overlay plus the
 * files already in `parseCache`. Both are dropped by exactly the same
 * operations that drop `parseCache`, so neither outlives a build any longer
 * than the parse cache the baseline already keeps. A stale hit is therefore
 * never more stale than a stale parse.
 *
 * - `resolutionCache`    (fromDir, request) -> resolved path | null
 * - `designSystemCache`  (fromDir, request) -> resolved design-system info
 *
 * The negative entries are the reason the lifetime matters: a `null` for
 * `./foo` is only correct while `foo.tsx` does not exist. It is therefore NOT
 * cached across `setModuleOverlay()` / `clearModuleCache()`, both of which run
 * at every generation boundary, and a resolved `null` is recomputed as soon as
 * the containing directory's own entry is invalidated, which the existing parse
 * cache already forces.
 */
const resolutionCache = new Map();
const designSystemCache = new Map();

function resolutionKey(fromFile, request) {
  return `${path.dirname(fromFile)}\u0000${request}`;
}

/** Installs the in-memory modules and invalidates every derived cache. */
export function setModuleOverlay(map) {
  moduleOverlay = map == null ? new Map() : map;
  parseCache.clear();
  resolutionCache.clear();
  designSystemCache.clear();
}

export function clearModuleOverlay() {
  setModuleOverlay(null);
}

function parseWith(code) {
  return withParseOwner('module-graph', () =>
    parseModule(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx',
        'typescript',
        'importAttributes',
        'explicitResourceManagement',
      ],
    }),
  );
}

export function parseModuleFile(absolutePath) {
  const cached = parseCache.get(absolutePath);
  if (cached !== undefined) {
    // A cache HIT is a lookup, not a parse. Recording it as a parse would make
    // "how many times is a file parsed" answer a different question, and the
    // question the brief asks is the one about parses.
    count('parse_lookups');
    count('parse_cache_hits');
    recordParse(absolutePath, 'module-graph:cache-hit');
    return cached;
  }
  const start = process.hrtime.bigint();
  let ast = null;
  let code = null;
  const overlaid = moduleOverlay.get(absolutePath);
  if (overlaid != null) {
    code = overlaid;
    try {
      ast = parseWith(code);
    } catch (err) {
      // Same distinction as below: a syntax error is an unparseable module, an
      // error inside the parse helper is a defect in this compiler.
      if (!(err instanceof SyntaxError)) throw err;
      ast = null;
    }
    count('parse_calls');
    count('parsed_files');
    recordParse(
      absolutePath,
      'module-graph',
      Number(process.hrtime.bigint() - start),
    );
    const result = { ast, code, overlaid: true };
    parseCache.set(absolutePath, result);
    return result;
  }
  // The read and the parse are failed separately, because they mean different
  // things. A file that cannot be READ is `null`, and the coverage graph reports
  // that as a gap - which is exactly what the baseline did, and narrowing it
  // would change a policy verdict into an unexpected exception. A file that
  // cannot be PARSED is also `null`. Anything else - a `ReferenceError` from a
  // missing import in this file, say - is a defect in this compiler, and
  // reporting it as "unparseable module" would hide a bug behind a policy
  // verdict, so it is re-thrown.
  try {
    code = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    code = null;
  }
  if (code != null) {
    try {
      ast = parseWith(code);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      ast = null;
    }
    // Only a parse that actually ran is recorded as a parse. A file that could
    // not even be read is a coverage gap, and counting it as a parse would put a
    // number in the parse statistics for work that never happened.
    count('parse_calls');
    count('parsed_files');
    recordParse(
      absolutePath,
      'module-graph',
      Number(process.hrtime.bigint() - start),
    );
  } else {
    count('unreadable_modules');
  }
  count('read_calls');
  count('read_bytes', code == null ? 0 : Buffer.byteLength(code, 'utf8'));
  const result = { ast, code, overlaid: false };
  parseCache.set(absolutePath, result);
  return result;
}

/**
 * The size of each module-level cache.
 *
 * These are process-wide and are NOT part of any session's state, so a long
 * session's memory trace cannot attribute growth to them without this. Kept
 * because the alternative is reporting "the heap grew" and not saying which of
 * the compiler's own structures grew with it.
 */
export function moduleGraphCacheStats() {
  const sizeOf = (map) => {
    // The retained cost of a cache is its VALUES, not its key count: a module
    // summary is a few hundred bytes of strings, a design system is not.
    let bytes = 0;
    for (const value of map.values()) {
      try {
        bytes += Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
      } catch {
        bytes += 0;
      }
    }
    return { entries: map.size, approxBytes: bytes };
  };
  return {
    parseCache: sizeOf(parseCache),
    resolutionCache: sizeOf(resolutionCache),
    designSystemCache: sizeOf(designSystemCache),
  };
}

/** Reset the cache (used between two builds inside one process). */
export function clearModuleCache() {
  parseCache.clear();
  resolutionCache.clear();
  designSystemCache.clear();
}

/**
 * Relative path resolution, in the spirit of Node/Vite but restricted to the
 * explicit extension forms the spec allows a page to write.
 */
function probeRelativeFile(fromFile, request) {
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = [base];

  // Extension may be omitted: always try appending each source extension.
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);

  // The request may carry its own extension, possibly a dotted name that is not
  // a source extension (e.g. `./design.pandamstyle`). Retry after dropping it.
  const ext = path.extname(base);
  if (ext !== '' && SOURCE_EXTENSIONS.includes(ext)) {
    const stem = base.slice(0, -ext.length);
    for (const e of SOURCE_EXTENSIONS) candidates.push(stem + e);
  }

  // Directory import: ./foo -> ./foo/index.tsx
  for (const e of SOURCE_EXTENSIONS) {
    candidates.push(path.join(base, 'index' + e));
  }

  for (const candidate of candidates) {
    // An in-memory module resolves without existing on disk: that is the whole
    // point of the overlay for the generated design-system module.
    if (moduleOverlay.has(candidate)) return candidate;
    try {
      count('stat_calls');
      count('resolution_probes');
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

export function resolveRelativeFile(fromFile, request) {
  if (!request.startsWith('.')) return null;
  if (!workEliminated()) return probeRelativeFile(fromFile, request);

  const key = resolutionKey(fromFile, request);
  if (resolutionCache.has(key)) {
    count('resolution_probes');
    if (resolutionCache.get(key) == null) count('resolution_negative_hits');
    else count('resolution_positive_hits');
    return resolutionCache.get(key);
  }
  const resolved = phase('resolve_ms', () =>
    probeRelativeFile(fromFile, request),
  );
  resolutionCache.set(key, resolved);
  return resolved;
}

function collectOwnExports(ast) {
  const names = new Set();
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration != null) {
        if (node.declaration.type === 'VariableDeclaration') {
          for (const d of node.declaration.declarations) {
            if (d.id.type === 'Identifier') names.add(d.id.name);
          }
        } else if (node.declaration.id != null) {
          names.add(node.declaration.id.name);
        }
      }
      for (const s of node.specifiers) {
        if (s.type === 'ExportSpecifier') {
          names.add(
            s.exported.type === 'Identifier'
              ? s.exported.name
              : s.exported.value,
          );
        }
      }
    } else if (node.type === 'ExportDefaultDeclaration') {
      names.add('default');
    }
  }
  return [...names];
}

function extractMarker(ast) {
  // `export const __PMS_DESIGN_SYSTEM__ = { ... }` with strict JSON literals.
  for (const node of ast.program.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration == null) {
      continue;
    }
    const decl = node.declaration;
    if (decl.type !== 'VariableDeclaration') continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== DESIGN_SYSTEM_MARKER) {
        continue;
      }
      const init = d.init;
      if (init == null || init.type !== 'ObjectExpression') return null;
      const out = {};
      for (const p of init.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const key = p.key.type === 'Identifier' ? p.key.name : p.key.value;
        out[key] = p.value.value;
      }
      return out;
    }
  }
  return null;
}

function collectReexports(ast) {
  const out = [];
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration' && node.source != null) {
      for (const s of node.specifiers) {
        if (s.type === 'ExportSpecifier') {
          out.push({
            kind: 'named',
            imported:
              s.local.type === 'Identifier' ? s.local.name : s.local.value,
            exported:
              s.exported.type === 'Identifier'
                ? s.exported.name
                : s.exported.value,
          });
        } else if (s.type === 'ExportNamespaceSpecifier') {
          out.push({
            kind: 'namespace',
            imported: '*',
            exported: s.exported.name,
          });
        }
      }
      out.push({ kind: 'source', request: node.source.value });
    } else if (node.type === 'ExportAllDeclaration') {
      out.push({ kind: 'source', request: node.source.value, star: true });
    }
  }
  return out;
}

/**
 * A dynamic `import(...)` request, in either AST shape.
 *
 * @babel/parser represents a dynamic import as `CallExpression` with an
 * `Import` callee; `ImportExpression` is the shape used by ESTree and by the
 * ES2020 proposal. Both are handled, because relying on one of them is how a
 * dynamic edge silently disappears from the graph.
 */
function dynamicImportRequest(node) {
  if (node == null) return null;
  if (node.type === 'ImportExpression') {
    return { form: 'dynamic-import', source: node.source ?? null };
  }
  if (node.type === 'CallExpression' && node.callee?.type === 'Import') {
    return {
      form: 'dynamic-import',
      source: node.arguments?.[0] ?? null,
    };
  }
  return null;
}

/** A CommonJS `require(...)` request with a single argument. */
function requireRequest(node) {
  if (node == null) return null;
  if (node.type !== 'CallExpression') return null;
  if (node.callee?.type !== 'Identifier' || node.callee.name !== 'require') {
    return null;
  }
  if (node.arguments?.length !== 1) return null;
  return { form: 'require', source: node.arguments[0] };
}

const STYLESHEET_RE = /\.(css|scss|sass|less|styl)$/;

/**
 * Every LOCAL module edge leaving `file`, whatever syntax carries it.
 *
 * Coverage that only walks `ImportDeclaration` is not the real module graph of
 * an application. A file must not be able to step outside the policy just
 * because it is reached through a re-export, so the closure follows:
 *
 *   import ... from '...'
 *   export { ... } from '...'
 *   export * from '...'
 *   export * as ns from '...'
 *   import('...')            (literal local request)
 *   require('...')           (literal local request)
 *
 * Each edge reports how it was found, so a coverage report can show a relay.
 */
export function moduleEdgesOf(file) {
  const parsed = parseModuleFile(file);
  if (parsed.ast == null) return { edges: [], unreadable: true };
  const { edges, importSources } = extractModuleFacts(parsed.ast);
  // Resolution is DERIVED here rather than stored, so an edge that a caller
  // wants resolved later can be re-resolved without re-parsing. A computed
  // dynamic request has no request to resolve at all, which is exactly why it
  // is a coverage gap.
  return {
    edges: edges.map((edge) => ({
      ...edge,
      resolved:
        edge.computed === true || !edge.local || edge.isStylesheet
          ? null
          : resolveRelativeFile(file, edge.request),
    })),
    importSources,
    unreadable: false,
  };
}

/**
 * The owned, compact module summary of ALREADY PARSED source.
 *
 * This is the whole persistent state an incremental session needs about a
 * module's edges. It contains plain data only - no `NodePath`, no AST, no
 * borrowed reference into a parse that a later phase is free to mutate.
 *
 * `importSources` is kept separately because it is a different question with a
 * different consumer: the Babel plugin asks "which of my import declarations
 * reach the design system", and only static import declarations are asked that.
 */
function extractModuleFacts(ast) {
  const edges = [];
  const importSources = [];
  const add = (request, form, node) => {
    if (request == null || typeof request !== 'string') return;
    const isStylesheet = STYLESHEET_RE.test(request);
    const local = request.startsWith('.');
    edges.push({
      request,
      form,
      local,
      isStylesheet,
      line: node?.loc?.start?.line ?? null,
    });
  };

  const body = ast.program.body;

  for (const node of body) {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source != null
    ) {
      if (node.importKind === 'type') continue;
      if (node.type === 'ImportDeclaration') {
        importSources.push(node.source.value);
      }
      // `export * as ns from '...'` is a NAMED declaration carrying a namespace
      // specifier. It is still a module edge, and it is labelled distinctly so
      // the coverage report can show which re-export form carried a file.
      const isNamespaceReexport =
        node.type === 'ExportNamedDeclaration' &&
        (node.specifiers ?? []).some(
          (s) => s.type === 'ExportNamespaceSpecifier',
        );
      add(
        node.source.value,
        node.type === 'ImportDeclaration'
          ? 'import'
          : node.type === 'ExportAllDeclaration'
            ? 'export-star'
            : isNamespaceReexport
              ? 'export-namespace'
              : 'export-named',
        node,
      );
    }
  }

  // Dynamic edges anywhere in the body, not only at the top level.
  const visit = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const dynamic = dynamicImportRequest(node) ?? requireRequest(node);
    if (dynamic != null) {
      if (dynamic.source?.type === 'StringLiteral') {
        add(dynamic.source.value, dynamic.form, node);
      } else {
        // No static string: the module this will load is unknown, so it cannot
        // be analysed. Reported as a gap rather than dropped.
        edges.push({
          request: null,
          form: dynamic.form,
          local: true,
          isStylesheet: false,
          computed: true,
          line: node.loc?.start?.line ?? null,
        });
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments') continue;
      const value = node[key];
      if (value != null && typeof value === 'object') visit(value);
    }
  };
  visit(body);

  return { edges, importSources };
}

/**
 * The module summary of SOURCE TEXT, without caching and without resolution.
 *
 * The incremental session owns the decision about when a module is parsed, so it
 * parses the bytes it has already read and keeps the summary. The resolution of
 * each edge stays OUT of the summary on purpose: resolution is a property of
 * the filesystem at a revision, not of the source, and a summary that froze it
 * would be a permanent negative resolution - the exact defect this module
 * already documents for its own resolution cache.
 */
export function moduleSummaryOfCode(code) {
  if (code == null) return { unreadable: true, edges: [], importSources: [] };
  let ast = null;
  try {
    ast = parseWith(code);
  } catch (err) {
    // Same distinction as `parseModuleFile`: a syntax error is an unparseable
    // module, anything else is a defect in this compiler.
    if (!(err instanceof SyntaxError)) throw err;
  }
  if (ast == null) return { unreadable: true, edges: [], importSources: [] };
  const { edges, importSources } = extractModuleFacts(ast);
  return { unreadable: false, edges, importSources };
}

/** The module summary of a file already in the in-memory parse cache. */
export function moduleSummaryOfFile(file) {
  const parsed = parseModuleFile(file);
  if (parsed.ast == null) return moduleSummaryOfCode(parsed.code);
  const { edges, importSources } = extractModuleFacts(parsed.ast);
  return { unreadable: false, edges, importSources };
}

/**
 * Walks `request` from `fromFile` up to the design-system module.
 *
 * Returns `{ marker, modulePath, exports, chain }` or `null`.
 * `chain` lists the files traversed so coverage can report them.
 */
export function resolveDesignSystemModule(fromFile, request, config = {}) {
  if (workEliminated()) {
    const key = `${resolutionKey(fromFile, request)}\u0000${config.maxDepth ?? 16}`;
    if (designSystemCache.has(key)) {
      count('ds_module_walk_hits');
      return designSystemCache.get(key);
    }
    count('ds_module_walks');
    const computed = walkToDesignSystem(fromFile, request, config);
    designSystemCache.set(key, computed);
    return computed;
  }
  count('ds_module_walks');
  return walkToDesignSystem(fromFile, request, config);
}

function walkToDesignSystem(fromFile, request, config = {}) {
  const seen = new Set();
  const chain = [];
  const budget = config.maxDepth ?? 16;

  function walk(file, depth) {
    if (file == null || seen.has(file) || depth > budget) return null;
    seen.add(file);
    chain.push(file);
    const parsed = parseModuleFile(file);
    if (parsed.ast == null) return null;

    const marker = extractMarker(parsed.ast);
    if (marker != null) {
      return {
        marker,
        modulePath: file,
        exports: collectOwnExports(parsed.ast),
        chain: [...chain],
      };
    }

    // No mark: this module may be a plain relay.
    const reexports = collectReexports(parsed.ast);
    const bySource = new Map();
    for (const r of reexports) {
      if (r.kind !== 'source') continue;
      if (!bySource.has(r.request)) bySource.set(r.request, []);
      bySource.get(r.request).push(r);
    }
    for (const [subRequest, specs] of bySource) {
      const target = resolveRelativeFile(file, subRequest);
      if (target == null) continue;
      const found = walk(target, depth + 1);
      if (found == null) continue;
      // `export *` forwards every export; `export {}` renames explicitly.
      const remapped = [];
      for (const s of specs) {
        if (s.star === true) {
          for (const name of found.exports) {
            remapped.push({ exported: name, imported: name });
          }
        } else if (s.kind === 'named') {
          remapped.push({ exported: s.exported, imported: s.imported });
        }
      }
      if (specs.some((s) => s.kind === 'namespace')) {
        return { ...found, chain: [...chain] };
      }
      return {
        marker: found.marker,
        modulePath: found.modulePath,
        exports: found.exports,
        exportsOfRelay: remapped,
        relayPath: file,
        chain: [...chain],
      };
    }
    return null;
  }

  const file = resolveRelativeFile(fromFile, request);
  if (file == null) return null;
  return walk(file, 0);
}

/** Re-export map of the design system for a given name, through a relay. */
export function relayExportMap(moduleInfo) {
  const map = new Map();
  if (moduleInfo?.exportsOfRelay != null) {
    for (const r of moduleInfo.exportsOfRelay) map.set(r.exported, r.imported);
  }
  return map;
}
