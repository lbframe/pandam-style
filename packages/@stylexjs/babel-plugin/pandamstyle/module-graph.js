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

export function parseModuleFile(absolutePath) {
  const cached = parseCache.get(absolutePath);
  if (cached !== undefined) return cached;
  let ast = null;
  let code = null;
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
  const result = { ast, code };
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
