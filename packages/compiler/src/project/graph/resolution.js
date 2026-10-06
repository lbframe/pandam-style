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
import { AsyncLocalStorage } from 'node:async_hooks';
import { parse as parseModule } from '@babel/parser';
import traverse from '@babel/traverse';
import { getBindingIdentifiers } from '@babel/types';
import {
  count,
  phase,
  recordParse,
  withParseOwner,
  workEliminated,
} from '../../observability/metrics';

export const DESIGN_SYSTEM_MARKER = '__pandamstyle';

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];
const HOST_RESOURCE_EXTENSIONS = new Set([
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.mp4',
  '.webm',
  '.pdf',
  '.csv',
  '.xml',
  '.yaml',
  '.yml',
]);

/**
 * The explicit extension forms a page is allowed to write (or to omit).
 *
 * Exported because the project session resolves edges with the SAME candidate
 * order. Two resolvers with two candidate orders are how a file becomes
 * "resolvable" in one code path and "unresolvable" in the other, and the
 * resulting coverage verdict would depend on which one ran.
 */
export { SOURCE_EXTENSIONS };

function isLocalResourceRequest(request) {
  const pathname = request.split(/[?#]/, 1)[0];
  const extension = path.extname(pathname).toLowerCase();
  // The bundler owns known resource imports such as JSON and images. They are
  // local host resources, but they are not JavaScript modules in the style
  // graph. Unknown extensions remain unresolved and keep the coverage check
  // closed. `.pandamstyle` is intentionally not a resource: the compiler uses
  // that suffix as an extensionless hint for its generated JS module.
  return HOST_RESOURCE_EXTENSIONS.has(extension);
}

export function createModuleGraphContext() {
  return {
    parseCache: new Map(),
    moduleOverlay: new Map(),
    resolutionCache: new Map(),
    designSystemCache: new Map(),
    firstHopCache: new Map(),
    serviceOwnedGeneratedArtifacts: new Map(),
    relayAnswerStore: null,
  };
}

const moduleGraphContexts = new AsyncLocalStorage();
const fallbackModuleGraphContext = createModuleGraphContext();

function moduleGraphContext() {
  return moduleGraphContexts.getStore() ?? fallbackModuleGraphContext;
}

export function currentModuleGraphContext() {
  return moduleGraphContexts.getStore() ?? null;
}

export function runWithModuleGraphContext(context, callback) {
  return moduleGraphContexts.run(context, callback);
}

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
function resolutionKey(fromFile, request) {
  return `${path.dirname(fromFile)}\u0000${request}`;
}

/** Installs the in-memory modules and invalidates every derived cache. */
export function setModuleOverlay(map) {
  const context = moduleGraphContext();
  context.moduleOverlay = map == null ? new Map() : map;
  context.serviceOwnedGeneratedArtifacts.clear();
  context.parseCache.clear();
  context.resolutionCache.clear();
  context.designSystemCache.clear();
}

/** Registers the exact source the compiler generated for this session. */
export function registerServiceOwnedGeneratedArtifact(file, source) {
  if (typeof file !== 'string' || typeof source !== 'string') {
    throw new TypeError(
      'A service-owned generated artifact needs a path and source text.',
    );
  }
  moduleGraphContext().serviceOwnedGeneratedArtifacts.set(
    path.resolve(file),
    source,
  );
}

function isServiceOwnedGeneratedArtifact(file, source) {
  return (
    moduleGraphContext().serviceOwnedGeneratedArtifacts.get(
      path.resolve(file),
    ) === source
  );
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
  const context = moduleGraphContext();
  const cached = context.parseCache.get(absolutePath);
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
  let parseLocation = null;
  const overlaid = context.moduleOverlay.get(absolutePath);
  if (overlaid != null) {
    code = overlaid;
    try {
      ast = parseWith(code);
    } catch (err) {
      // Same distinction as below: a syntax error is an unparseable module, an
      // error inside the parse helper is a defect in this compiler.
      if (!(err instanceof SyntaxError)) throw err;
      ast = null;
      parseLocation = parserLocationOf(err);
    }
    count('parse_calls');
    count('parsed_files');
    recordParse(
      absolutePath,
      'module-graph',
      Number(process.hrtime.bigint() - start),
    );
    const result = { ast, code, overlaid: true, parseLocation };
    context.parseCache.set(absolutePath, result);
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
      parseLocation = parserLocationOf(err);
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
  const result = { ast, code, overlaid: false, parseLocation };
  context.parseCache.set(absolutePath, result);
  return result;
}

function parserLocationOf(error) {
  const location = error?.loc;
  if (location == null || !Number.isInteger(location.line)) return null;
  return Object.freeze({
    line: location.line,
    column: Number.isInteger(location.column) ? location.column + 1 : null,
  });
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
  const context = moduleGraphContext();
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
    parseCache: sizeOf(context.parseCache),
    resolutionCache: sizeOf(context.resolutionCache),
    designSystemCache: sizeOf(context.designSystemCache),
  };
}

/** Reset the cache (used between two builds inside one process). */
/**
 * The first hop a request resolves to, memoised for the revision.
 *
 * `resolveRelativeFile` consults `resolutionCache` only under
 * `PMS_WORK_ELIMINATED`, which is off in production because Spike 1 introduced
 * it as a measured, opt-in axis and nothing here is allowed to quietly conflate
 * itself with that. The consequence is that asking "where does this request
 * land?" per CONSUMER costs a filesystem probe per candidate extension per
 * consumer - nineteen `stat` calls to answer a question that cannot change while
 * the revision is being analysed, because nothing writes files during a
 * revision.
 *
 * So the answer is memoised here, for the revision, and dropped with the rest of
 * the module-graph cache at the start of the next analysis. That is the same
 * lifetime `parseCache` has, and it is the same claim: a revision's view of the
 * filesystem is fixed from the moment it starts.
 */
export function clearModuleCache() {
  const context = moduleGraphContext();
  context.parseCache.clear();
  context.resolutionCache.clear();
  context.designSystemCache.clear();
  context.firstHopCache.clear();
}

/**
 * Relative path resolution, in the spirit of Node/Vite but restricted to the
 * explicit extension forms the spec allows a page to write.
 */
function probeRelativeFile(fromFile, request, consulted = null) {
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
    // Resolution inputs count too: appearance of an earlier candidate can
    // change the answer without changing the previous winner's bytes.
    consulted?.add(candidate);
    // An in-memory module resolves without existing on disk: that is the whole
    // point of the overlay for the generated design-system module.
    if (moduleGraphContext().moduleOverlay.has(candidate)) return candidate;
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
  const context = moduleGraphContext();
  if (!request.startsWith('.')) return null;
  if (!workEliminated()) return probeRelativeFile(fromFile, request);

  const key = resolutionKey(fromFile, request);
  if (context.resolutionCache.has(key)) {
    count('resolution_probes');
    if (context.resolutionCache.get(key) == null)
      count('resolution_negative_hits');
    else count('resolution_positive_hits');
    return context.resolutionCache.get(key);
  }
  const resolved = phase('resolve_ms', () =>
    probeRelativeFile(fromFile, request),
  );
  context.resolutionCache.set(key, resolved);
  return resolved;
}

function collectOwnExports(ast) {
  const names = new Set();
  for (const node of ast.program.body) {
    if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue;
      if (node.declaration != null) {
        if (node.declaration.type === 'VariableDeclaration') {
          for (const d of node.declaration.declarations) {
            for (const name of Object.keys(getBindingIdentifiers(d.id)))
              names.add(name);
          }
        } else if (node.declaration.id != null)
          names.add(node.declaration.id.name);
      }
      for (const s of node.specifiers) {
        if (s.type === 'ExportSpecifier' && s.exportKind !== 'type') {
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

function markerLiteral(node) {
  if (
    node?.type === 'StringLiteral' ||
    node?.type === 'NumericLiteral' ||
    node?.type === 'BooleanLiteral'
  ) {
    return { ok: true, value: node.value };
  }
  if (node?.type === 'NullLiteral') return { ok: true, value: null };
  if (node?.type === 'ArrayExpression') {
    const values = node.elements.map((element) => markerLiteral(element));
    return values.every((value) => value.ok)
      ? { ok: true, value: values.map((value) => value.value) }
      : { ok: false };
  }
  if (node?.type === 'ObjectExpression') {
    const value = {};
    for (const property of node.properties) {
      if (
        property.type !== 'ObjectProperty' ||
        property.computed === true ||
        property.method === true
      ) {
        return { ok: false };
      }
      const key =
        property.key.type === 'Identifier'
          ? property.key.name
          : property.key.value;
      const entry = markerLiteral(property.value);
      if (!entry.ok) return { ok: false };
      value[key] = entry.value;
    }
    return { ok: true, value };
  }
  return { ok: false };
}

function extractMarker(ast) {
  // `export const __pandamstyle = { ... }` with strict JSON literals.
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
      const marker = markerLiteral(d.init);
      return marker.ok ? marker.value : null;
    }
  }
  return null;
}

function collectReexports(ast) {
  const out = [];
  let scope;
  (traverse.default ?? traverse)(ast, {
    Program(p) {
      scope = p.scope;
      p.stop();
    },
  });
  for (const node of ast.program.body) {
    if (node.exportKind === 'type') continue;
    if (node.type === 'ExportNamedDeclaration') {
      for (const s of node.specifiers) {
        if (s.exportKind === 'type') continue;
        if (s.type === 'ExportSpecifier') {
          let request = node.source?.value;
          let imported = s.local.name ?? s.local.value;
          let kind = 'named';
          if (request == null) {
            // Only a real import binding can forward a local export. A local
            // declaration with the same name has its own ordinary identity.
            const binding = scope.getBinding(imported);
            const spec = binding?.path.node;
            if (
              !binding?.constant ||
              !binding.path.parentPath.isImportDeclaration()
            )
              continue;
            if (
              binding.path.parent.importKind === 'type' ||
              spec.importKind === 'type'
            )
              continue;
            request = binding.path.parent.source.value;
            imported =
              spec.type === 'ImportNamespaceSpecifier'
                ? '*'
                : spec.type === 'ImportDefaultSpecifier'
                  ? 'default'
                  : (spec.imported.name ?? spec.imported.value);
            kind = imported === '*' ? 'namespace' : 'local-reexport';
          }
          out.push({
            kind,
            request,
            imported,
            exported: s.exported.name ?? s.exported.value,
          });
        } else if (s.type === 'ExportNamespaceSpecifier') {
          out.push({
            kind: 'namespace',
            request: node.source.value,
            imported: '*',
            exported: s.exported.name ?? s.exported.value,
          });
        }
      }
    } else if (node.type === 'ExportAllDeclaration') {
      out.push({ kind: 'star', request: node.source.value });
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
  if (parsed.ast == null)
    return {
      edges: [],
      unreadable: true,
      parseLocation: parsed.parseLocation ?? null,
    };
  const { edges, importSources } = extractModuleFacts(parsed.ast);
  // Resolution is DERIVED here rather than stored, so an edge that a caller
  // wants resolved later can be re-resolved without re-parsing. A computed
  // dynamic request has no request to resolve at all, which is exactly why it
  // is a coverage gap.
  return {
    edges: edges.map((edge) => ({
      ...edge,
      resolved:
        edge.computed === true ||
        !edge.local ||
        edge.isStylesheet ||
        edge.resource
          ? null
          : resolveRelativeFile(file, edge.request),
    })),
    importSources,
    unreadable: false,
    parseLocation: null,
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
    const resource = local && !isStylesheet && isLocalResourceRequest(request);
    edges.push({
      request,
      form,
      local,
      isStylesheet,
      resource,
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
          resource: false,
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
  let parseLocation = null;
  try {
    ast = parseWith(code);
  } catch (err) {
    // Same distinction as `parseModuleFile`: a syntax error is an unparseable
    // module, anything else is a defect in this compiler.
    if (!(err instanceof SyntaxError)) throw err;
    parseLocation = parserLocationOf(err);
  }
  if (ast == null)
    return {
      unreadable: true,
      edges: [],
      importSources: [],
      parseLocation,
    };
  const { edges, importSources } = extractModuleFacts(ast);
  return { unreadable: false, edges, importSources, parseLocation: null };
}

/** The module summary of a file already in the in-memory parse cache. */
export function moduleSummaryOfFile(file) {
  const parsed = parseModuleFile(file);
  if (parsed.ast == null)
    return {
      ...moduleSummaryOfCode(parsed.code),
      parseLocation: parsed.parseLocation ?? null,
    };
  const { edges, importSources } = extractModuleFacts(parsed.ast);
  return { unreadable: false, edges, importSources, parseLocation: null };
}

/**
 * Walks `request` from `fromFile` up to the design-system module.
 *
 * Returns `{ marker, modulePath, exports, chain }` or `null`.
 * `chain` lists the files traversed so coverage can report them.
 */
/**
 * THE SESSION'S RELAY ANSWER STORE.
 *
 * `resolveDesignSystemModule` is asked the same question twice for every
 * compiled file: once by the project session, when it derives the file's
 * DESIGN-SYSTEM VIEW, and once by the transform, when it decides which
 * bindings are recognized. Both answers come out of the same relay walk, and
 * that walk re-extracts the marker, the export map and the re-export map from a
 * module whose AST holds the whole design system - ten thousand tokens of it at
 * c10000. Asking twice and paying twice is not a design; it is the absence of
 * one, and Phase D2 found it.
 *
 * The store is a plain table supplied by whoever owns the state that can
 * invalidate it, which in this codebase is the project session: it knows which
 * file's BYTES changed and can therefore say whether a cached answer is still
 * true. This module deliberately knows nothing about revisions - it asks the
 * store and believes the answer it is given.
 *
 * INSTALLED FOR THE DURATION OF A SESSION ANALYSIS, AND REMOVED AGAIN BEFORE
 * ANYTHING ELSE RUNS. A full rebuild therefore never consults a session's
 * memory and can never be answered by one, which is the rule the differential
 * oracle rests on and the reason the store is a module-level variable set by
 * its owner rather than something this module owns.
 */
export function setRelayAnswerStore(store) {
  moduleGraphContext().relayAnswerStore = store;
}

/**
 * The key one relay walk is stored under.
 *
 * It is the resolved FIRST HOP and the relay depth, and nothing else, because
 * the walk depends on the contents and downstream resolution candidates from
 * that hop. Its owner versions both dependency sets. Ten thousand pages importing the same barrel by the same specifier
 * are one walk, and keying by the specifier as well would be a way of not
 * noticing that.
 */
export function relayAnswerKey(fromFile, request, maxDepth) {
  const context = moduleGraphContext();
  const cacheKey = `${path.dirname(fromFile)}\u0000${request}`;
  let firstHop = context.firstHopCache.get(cacheKey);
  if (firstHop === undefined) {
    firstHop = resolveRelativeFile(fromFile, request);
    context.firstHopCache.set(cacheKey, firstHop);
  }
  return `${maxDepth ?? 16}\u0000${firstHop ?? ''}`;
}

export function resolveDesignSystemModule(fromFile, request, config = {}) {
  const context = moduleGraphContext();
  // `consulted` is every module whose BYTES this walk read, whether or not it
  // ended up finding a design system behind the request. The chain alone is not
  // enough to invalidate an answer, and the difference is a relay that stops
  // reaching the design system and then starts again: the answer is `null`,
  // there is no chain to version, and a store that versions only the chain
  // keeps the `null` forever - through the revision that broke the relay and
  // the revision that repaired it.
  const consulted = config.consulted ?? new Set();
  if (context.relayAnswerStore != null) {
    const key = relayAnswerKey(fromFile, request, config.maxDepth);
    const entry = context.relayAnswerStore.get(key);
    if (entry !== undefined) return entry.info;
    const computed = walkToDesignSystem(fromFile, request, config, consulted);
    context.relayAnswerStore.set(
      key,
      resolveRelativeFile(fromFile, request),
      computed,
      consulted,
    );
    return computed;
  }
  if (workEliminated()) {
    const key = `${resolutionKey(fromFile, request)}\u0000${config.maxDepth ?? 16}`;
    if (context.designSystemCache.has(key)) {
      count('ds_module_walk_hits');
      return context.designSystemCache.get(key);
    }
    count('ds_module_walks');
    const computed = walkToDesignSystem(fromFile, request, config, consulted);
    context.designSystemCache.set(key, computed);
    return computed;
  }
  count('ds_module_walks');
  return walkToDesignSystem(fromFile, request, config, consulted);
}

function walkToDesignSystem(fromFile, request, config = {}, consulted = null) {
  const active = new Set();
  const readModules = new Set();
  const resolutionDependencies = new Set();
  const systems = new Map();
  const artifactMismatches = new Map();
  const issues = [];
  const budget = config.maxDepth ?? 16;
  const resolve = (file, source) =>
    source.startsWith('.')
      ? probeRelativeFile(file, source, resolutionDependencies)
      : null;
  const unknown = () => ({ bindings: new Map(), opaque: true });
  const identity = (b) =>
    b == null
      ? null
      : `${b.kind === 'namespace' ? '*' : b.imported}\u0000${b.modulePath}`;
  function walk(file, depth) {
    // Cyclic and truncated export sets cannot safely select a star winner.
    if (file == null || active.has(file) || depth > budget) return unknown();
    active.add(file);
    consulted?.add(file);
    readModules.add(file);
    const parsed = parseModuleFile(file);
    if (parsed.ast == null || parsed.ast.errors?.length > 0) {
      active.delete(file);
      return unknown();
    }
    const marker = extractMarker(parsed.ast);
    const authenticatedMarker =
      marker != null && isServiceOwnedGeneratedArtifact(file, parsed.code);
    const bindings = new Map();
    for (const name of collectOwnExports(parsed.ast)) {
      bindings.set(name, {
        kind: 'named',
        imported: name,
        modulePath: file,
        chain: [file],
        designSystem: authenticatedMarker,
      });
    }
    if (marker != null) {
      if (authenticatedMarker) {
        systems.set(file, { marker, exports: [...bindings.keys()] });
      } else {
        artifactMismatches.set(file, { modulePath: file, marker });
      }
      active.delete(file);
      return { bindings, opaque: false };
    }
    const targets = new Map();
    const stars = new Map();
    let opaque = false;
    const specs = collectReexports(parsed.ast);
    const explicit = new Set(bindings.keys());
    for (const s of specs) if (s.kind !== 'star') explicit.add(s.exported);
    for (const s of specs) {
      let target = targets.get(s.request);
      if (target == null) {
        const targetPath = resolve(file, s.request);
        target = { ...walk(targetPath, depth + 1), modulePath: targetPath };
        targets.set(s.request, target);
      }
      if (s.kind === 'star') {
        opaque ||= target.opaque;
        for (const [name, b] of target.bindings) {
          if (name === 'default' || explicit.has(name)) continue;
          if (stars.has(name) && identity(stars.get(name)) !== identity(b)) {
            stars.set(name, null);
            issues.push({
              module: file,
              exported: name,
              reason: 'ambiguous-star-export',
            });
          } else if (!stars.has(name)) stars.set(name, b);
        }
      } else {
        const b =
          s.kind === 'namespace' && target.modulePath != null
            ? {
                kind: 'namespace',
                imported: '*',
                modulePath: target.modulePath,
                members: [...target.bindings]
                  .filter(([, member]) => member != null)
                  .map(([exported, member]) => ({ exported, ...member })),
                chain: [target.modulePath],
              }
            : target.bindings.get(s.imported);
        // Missing exports erase the provisional own-name identity as well.
        bindings.delete(s.exported);
        if (b != null)
          bindings.set(s.exported, {
            ...b,
            chain: [file, ...b.chain],
            forwardingKind: s.kind,
            sourceRequest: s.request,
          });
      }
    }
    if (!opaque) {
      for (const [name, b] of stars) {
        bindings.set(
          name,
          b == null
            ? null
            : { ...b, chain: [file, ...b.chain], forwardingKind: 'star' },
        );
      }
    } else if (specs.some((s) => s.kind === 'star')) {
      issues.push({ module: file, reason: 'incomplete-star-export-set' });
    }
    active.delete(file);
    return { bindings, opaque };
  }
  // First-hop resolution is owned by the consumer's resolution digest/index.
  // Shared relay answers start at that hop; their downstream candidates are
  // dependencies, but consumer-specific first-hop candidates are not shared.
  const file = resolveRelativeFile(fromFile, request);
  const result = walk(file, 0);
  // The cache owner's dependencies include existence/order inputs separately
  // from the modules whose bytes were read. This also runs for null answers.
  for (const candidate of resolutionDependencies) consulted?.add(candidate);
  if (artifactMismatches.size > 0) {
    return {
      artifactMismatch: [...artifactMismatches.values()],
      modulePath: [...artifactMismatches.keys()][0],
      chain: [...readModules],
      consulted: [...readModules],
      resolutionDependencies: [...resolutionDependencies],
      issues,
    };
  }
  if (systems.size === 0) return null;
  // The current compiler compiles one generated system per project. Do not
  // assign a single system's policy to a barrel containing multiple systems.
  if (systems.size > 1)
    issues.push({ module: file, reason: 'multiple-design-systems' });
  const [modulePath, system] = systems.entries().next().value;
  return {
    ...system,
    modulePath,
    relayPath: file === modulePath ? null : file,
    exportsOfRelay:
      systems.size === 1
        ? [...result.bindings]
            .filter(([, b]) => b != null)
            .map(([exported, b]) => ({ exported, ...b }))
        : [],
    chain: [...readModules],
    consulted: [...readModules],
    resolutionDependencies: [...resolutionDependencies],
    issues,
  };
}

/** Re-export map of the design system for a given name, through a relay. */
export function relayExportMap(moduleInfo) {
  const map = new Map();
  if (moduleInfo?.exportsOfRelay != null) {
    for (const r of moduleInfo.exportsOfRelay) map.set(r.exported, r);
  }
  return map;
}
