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

export const DESIGN_SYSTEM_MARKER = '__PMS_DESIGN_SYSTEM__';

const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

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

/** Installs the in-memory modules and invalidates the parse cache. */
export function setModuleOverlay(map) {
  moduleOverlay = map == null ? new Map() : map;
  parseCache.clear();
}

export function clearModuleOverlay() {
  setModuleOverlay(null);
}

export function parseModuleFile(absolutePath) {
  const cached = parseCache.get(absolutePath);
  if (cached !== undefined) return cached;
  let ast = null;
  let code = null;
  const overlaid = moduleOverlay.get(absolutePath);
  if (overlaid != null) {
    code = overlaid;
    try {
      ast = parseModule(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        errorRecovery: true,
        plugins: [
          'jsx',
          'typescript',
          'importAttributes',
          'explicitResourceManagement',
        ],
      });
    } catch {
      ast = null;
    }
    const result = { ast, code, overlaid: true };
    parseCache.set(absolutePath, result);
    return result;
  }
  try {
    code = fs.readFileSync(absolutePath, 'utf8');
    ast = parseModule(code, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: [
        'jsx',
        'typescript',
        'importAttributes',
        'explicitResourceManagement',
      ],
    });
  } catch {
    ast = null;
  }
  const result = { ast, code, overlaid: false };
  parseCache.set(absolutePath, result);
  return result;
}

/** Reset the cache (used between two builds inside one process). */
export function clearModuleCache() {
  parseCache.clear();
}

/**
 * Relative path resolution, in the spirit of Node/Vite but restricted to the
 * explicit extension forms the spec allows a page to write.
 */
export function resolveRelativeFile(fromFile, request) {
  if (!request.startsWith('.')) return null;
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
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep probing */
    }
  }
  return null;
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

  const edges = [];
  const add = (request, form, node) => {
    if (request == null || typeof request !== 'string') return;
    const isStylesheet = STYLESHEET_RE.test(request);
    const local = request.startsWith('.');
    edges.push({
      request,
      form,
      local,
      isStylesheet,
      // A stylesheet is not a compilable module: the plugin's style-channel
      // check owns it, so the closure must not try to analyse it as one.
      resolved:
        local && !isStylesheet ? resolveRelativeFile(file, request) : null,
      line: node?.loc?.start?.line ?? null,
    });
  };

  const body = parsed.ast.program.body;

  for (const node of body) {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source != null
    ) {
      if (node.importKind === 'type') continue;
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
          resolved: null,
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

  return { edges, unreadable: false };
}

/**
 * Walks `request` from `fromFile` up to the design-system module.
 *
 * Returns `{ marker, modulePath, exports, chain }` or `null`.
 * `chain` lists the files traversed so coverage can report them.
 */
export function resolveDesignSystemModule(fromFile, request, config = {}) {
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
