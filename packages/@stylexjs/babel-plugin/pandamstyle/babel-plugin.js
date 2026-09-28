/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - Babel plugin (native entry point, ARC-05).
 *
 * Registered as an ordinary Babel plugin and driven by the fork's pipeline:
 * the same evaluator (`src/utils/evaluate-path`), the same engine
 * (`styleXCreateSet`) and the same rule/CSS shape as StyleX, so there is a
 * single CSS emission circuit.
 *
 * Visitor order matters and is deliberate:
 *   1. `Program.enter`  - read imports, enforce the closed profile boundaries;
 *   2. JSX pass         - style channels / opaque spreads, BEFORE transforming
 *                         so `props(...)` is still recognizable by binding;
 *   3. usage pass       - transform recognized calls and theme accesses;
 *   4. `Program.exit`   - publish coverage, raise policy failures.
 */

import * as t from '@babel/types';
import StateManager from '../src/utils/state-manager';
import { PmsError } from './diagnostics';
import {
  createUsageContext,
  isCreateCall,
  isPropsCall,
  readModuleFacts,
} from './evaluate-usage';
import { transformResidualTokens, transformUsage } from './transform';

/** Engine/author APIs a consumer page may never reach. */
const ENGINE_EXPORT_NAMES = new Set([
  'defineVars',
  'unstable_defineVarsNested',
  'createTheme',
  'unstable_createThemeNested',
  'defineConsts',
  'unstable_defineConstsNested',
  'defineMarker',
  'keyframes',
  'positionTry',
  'viewTransitionClass',
  'include',
  'firstThatWorks',
  'attrs',
  'types',
  'defaultMarker',
  'env',
  'when',
  'unstable_conditional',
]);

/** Records identifiers bound to a recognized PMS call, before transforming. */
function collectDerivedBindings(programPath, ctx) {
  const propsDerived = new Set();
  const createDerived = new Set();

  programPath.traverse({
    VariableDeclarator(p) {
      const id = p.node.id;
      if (id.type !== 'Identifier') return;
      const init = p.get('init');
      if (init == null || init.node == null) return;
      if (isPropsCall(init, ctx)) {
        propsDerived.add(id.name);
        ctx.derived.set(id.name, 'props');
      } else if (isCreateCall(init, ctx)) {
        createDerived.add(id.name);
        ctx.derived.set(id.name, 'create');
      }
    },
  });

  return { propsDerived, createDerived };
}

/**
 * Resolves a JSX expression to "is it a PMS-composed value?".
 * A spread of `props(...)` (or of an identifier bound to one) is admitted; the
 * spec's own example is exactly that form.
 */
function jsxValueKind(nodePath, ctx, derived) {
  if (nodePath == null || nodePath.node == null) return 'unknown';
  if (isPropsCall(nodePath, ctx)) return 'props';
  if (isCreateCall(nodePath, ctx)) return 'create';
  if (nodePath.isIdentifier()) {
    const kind = derived.get(nodePath.node.name);
    if (kind != null) return kind;
    return 'unknown';
  }
  if (
    nodePath.isTSAsExpression() ||
    nodePath.isTSSatisfiesExpression?.() ||
    nodePath.isParenthesizedExpression()
  ) {
    return jsxValueKind(nodePath.get('expression'), ctx, derived);
  }
  if (
    nodePath.isMemberExpression() ||
    nodePath.isOptionalMemberExpression?.()
  ) {
    // `styles.page.className` - member of a create() result.
    let cur = nodePath;
    while (
      cur.isMemberExpression() ||
      cur.isOptionalMemberExpression?.() ||
      cur.isTSAsExpression?.()
    ) {
      cur = cur.get('object');
      if (cur == null || cur.node == null) return 'unknown';
    }
    if (cur.isIdentifier()) {
      const kind = derived.get(cur.node.name);
      if (kind != null) return kind;
    }
    return 'unknown';
  }
  return 'unknown';
}

function checkJsxChannels(programPath, ctx, derived) {
  programPath.traverse({
    JSXOpeningElement(p) {
      for (const attr of p.get('attributes')) {
        if (attr.isJSXSpreadAttribute()) {
          const kind = jsxValueKind(attr.get('argument'), ctx, derived);
          if (kind !== 'props') {
            ctx.diags.push(
              makeDiag(
                ctx,
                'PMS_UNVERIFIED_JSX_SPREAD',
                'A JSX spread whose absence of style/className cannot be ' +
                  'established statically is refused. Spread a props(...) ' +
                  'result instead.',
                attr,
                'profile.closed.jsx-spread',
                { kind },
              ),
            );
          }
          continue;
        }
        if (!attr.isJSXAttribute()) continue;
        const name = t.isJSXIdentifier(attr.node.name)
          ? attr.node.name.name
          : null;
        if (name === 'style') {
          ctx.diags.push(
            makeDiag(
              ctx,
              'PMS_FORBIDDEN_STYLE_CHANNEL',
              'The inline style attribute is refused in the closed profile; ' +
                'declare styles with create() and compose with props().',
              attr,
              'profile.closed.style-channel',
              { attribute: 'style' },
            ),
          );
        } else if (name === 'className') {
          const kind = jsxValueKind(attr.get('value'), ctx, derived);
          if (kind === 'unknown') {
            ctx.diags.push(
              makeDiag(
                ctx,
                'PMS_FORBIDDEN_STYLE_CHANNEL',
                'className must come from a recognized PandamStyle export ' +
                  '(props(...)), not from an unverified value.',
                attr,
                'profile.closed.style-channel',
                { attribute: 'className' },
              ),
            );
          }
        }
      }
    },
  });
}

function makeDiag(ctx, code, message, nodePath, rule, context) {
  const loc = nodePath?.node?.loc;
  return {
    schemaVersion: 1,
    code,
    severity: 'error',
    phase: 'coverage',
    message,
    source: ctx.filename,
    location: {
      file: ctx.filename,
      line: loc?.start.line ?? null,
      column: loc ? loc.start.column + 1 : null,
      role: ctx.role,
    },
    rule,
    context,
    autofix: null,
  };
}

/** Refuses engine/author entry points reachable from a page. */
function checkEngineImports(programPath, ctx) {
  for (const stmt of programPath.get('body')) {
    if (!stmt.isImportDeclaration()) continue;
    const source = stmt.node.source.value;
    for (const spec of stmt.node.specifiers) {
      let imported = null;
      if (spec.type === 'ImportSpecifier') {
        imported =
          spec.imported.type === 'Identifier'
            ? spec.imported.name
            : spec.imported.value;
      } else if (spec.type === 'ImportNamespaceSpecifier') {
        imported = '*';
      }
      if (imported == null) continue;
      if (ENGINE_EXPORT_NAMES.has(imported)) {
        ctx.diags.push(
          makeDiag(
            ctx,
            'PMS_ROLE_VIOLATION',
            `"${imported}" is an engine or design-system author entry point and ` +
              'is not reachable from a consumer page. The author role is ' +
              'assigned by build configuration, never self-declared by a page.',
            stmt,
            'profile.closed.roles',
            { imported, source },
          ),
        );
      }
    }
  }
}

function rejectSelfDeclaredAuthority(programPath, ctx) {
  programPath.traverse({
    ObjectProperty(p) {
      const key = p.node.key;
      const name = key.type === 'Identifier' ? key.name : key.value;
      if (name === 'trusted' || name === '__pmsRole' || name === 'role') {
        ctx.diags.push(
          makeDiag(
            ctx,
            'PMS_ROLE_VIOLATION',
            `A page cannot self-declare "${name}": authority is granted by the ` +
              'build configuration, not by the source.',
            p,
            'profile.closed.roles',
            { key: name },
          ),
        );
      }
    },
  });
}

export function pandamstyleBabelPlugin(api) {
  if (api != null && typeof api.assertVersion === 'function') {
    api.assertVersion(7);
  }

  return {
    name: 'pandamstyle',
    visitor: {
      Program: {
        enter(programPath, pluginPass) {
          const options = pluginPass.opts ?? {};
          const filename =
            pluginPass.file?.opts?.filename ?? pluginPass.filename ?? 'unknown';
          const role = options.role ?? 'page';

          // The fork's StateManager gives us its evaluator and its import path
          // resolver; it is the same object the StyleX visitors use.
          const state = new StateManager(pluginPass);

          const ctx = createUsageContext({
            state,
            pluginPass,
            filename,
            options,
            role,
          });
          pluginPass.__pandamstyle = ctx;

          readModuleFacts(programPath, ctx);
          checkEngineImports(programPath, ctx);
          rejectSelfDeclaredAuthority(programPath, ctx);
        },
        exit(programPath, pluginPass) {
          const ctx = pluginPass.__pandamstyle;
          if (ctx == null) return;

          collectDerivedBindings(programPath, ctx);
          checkJsxChannels(programPath, ctx, ctx.derived);

          if (ctx.diags.length === 0) {
            const ds = pluginPass.opts?.designSystem;
            if (ds != null) {
              // Pass 1 compiles create()/recipes/themes/props.
              //
              // The traversal does NOT stop at the first diagnostic: every
              // independent violation in the file must be reported, otherwise
              // "each route is refused" could not be proven from one build.
              // A failing call is left untransformed, so nothing downstream
              // consumes a half-compiled subtree.
              programPath.traverse({
                CallExpression: (p) => {
                  transformUsage({ path: p, ctx, ds, programPath });
                },
                'MemberExpression|OptionalMemberExpression': (p) => {
                  transformUsage({ path: p, ctx, ds, programPath });
                },
              });

              // Pass 2 runs afterwards on purpose: a token() hoisted into a
              // module-level constant is only lowerable once every create()
              // has consumed its own references.
              if (ctx.diags.length === 0) {
                programPath.traverse({
                  CallExpression: (p) => {
                    if (ctx.diags.length > 0) return;
                    transformResidualTokens({ path: p, ctx, ds });
                  },
                });
              }
            }
          }

          pluginPass.file.metadata.pandamstyleCoverage = {
            file: ctx.filename,
            role: ctx.role,
            usedDesignSystem: ctx.pmsModule != null,
            usedPmsHelpers: ctx.used,
            designSystemModule: ctx.pmsModulePath,
            relayChain: ctx.pmsModule?.chain ?? [],
            diagnosticCount: ctx.diags.length,
          };

          if (ctx.diags.length > 0) {
            throw new PmsError(ctx.diags);
          }
        },
      },
    },
  };
}

export default pandamstyleBabelPlugin;
