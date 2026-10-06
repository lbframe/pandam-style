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
import { createPassState } from './pass-state';
import { PmsError } from '../../protocol/diagnostics';
import {
  createUsageContext,
  isCreateCall,
  isPropsCall,
  readDynamicModuleFacts,
  readStaticModuleFacts,
  resolvePmsAccess,
} from './evaluate';
import {
  analyzeProvenanceEscapes,
  checkPropsProvenance,
  Provenance,
  provenanceOf,
} from '../../semantics/provenance/index';
import { transformResidualTokens, transformUsage } from './transform';
// Benchmark-only measurement hooks (Spike 1).
import { count, phase as perfPhase } from '../../observability/metrics';

/** Engine/author APIs a consumer page may never reach. */
const ENGINE_EXPORT_NAMES = new Set([
  'patternStyles',
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

/** Reserved authority fields, namespaced so no business key can collide. */
const RESERVED_AUTHORITY_KEYS = new Set([
  '__pmsRole',
  '__pmsTrusted',
  '__pmsRoleOverride',
]);

/** Authority-looking keys that only matter INSIDE a PandamStyle call. */
const AUTHORITY_KEYS_IN_PMS_CONTEXT = new Set(['role', 'trusted']);

/**
 * Records which local constants hold a recognized PMS result.
 *
 * The record is keyed by BINDING, not by name. `const x = props(...)` and a
 * function parameter `x` are different bindings, so the parameter cannot inherit
 * the provenance of the module-level constant of the same spelling.
 *
 * A REASSIGNED binding is not recorded at all:
 *
 *     let x = props(styles.root)
 *     x = userInput
 *     <div {...x} />
 *
 * Here `x` is whatever the last assignment made, so the fact that its
 * initializer was a props() call carries no information about its value.
 */
function collectDerivedBinding(p, ctx) {
  const id = p.node.id;
  if (id.type !== 'Identifier') return;
  const init = p.get('init');
  if (init == null || init.node == null) return;
  const binding = p.scope.getBinding(id.name);
  if (binding == null || binding.constantViolations.length > 0) return;
  if (isPropsCall(init, ctx)) {
    ctx.propsResults.add(binding);
    // Tracked for mutation/escape too: a proven value that can still be
    // written to or handed to an unknown function has no durable provenance
    // (see provenance.js).
    ctx.provenance.set(binding, {
      kind: Provenance.PROPS_RESULT,
      reason: null,
    });
  } else if (isCreateCall(init, ctx)) {
    ctx.createResults.add(binding);
    ctx.provenance.set(binding, {
      kind: Provenance.CREATE_CONTAINER,
      reason: null,
    });
  }
}

/**
 * Collects binding facts and the paths consumed by read-only semantic checks.
 * The checks run after this walk so declaration order and hoisted bindings do
 * not change their results.
 */
function collectSemanticCandidates(programPath, ctx) {
  const provenanceNodes = [];
  const jsxOpeningElements = [];
  programPath.traverse({
    VariableDeclarator(p) {
      collectDerivedBinding(p, ctx);
    },
    MemberExpression(p) {
      provenanceNodes.push(p);
    },
    OptionalMemberExpression(p) {
      provenanceNodes.push(p);
    },
    CallExpression(p) {
      provenanceNodes.push(p);
    },
    JSXOpeningElement(p) {
      jsxOpeningElements.push(p);
    },
  });
  return { provenanceNodes, jsxOpeningElements };
}

/**
 * Resolves a JSX expression to the KIND of value it is, through bindings.
 *
 * `derived.get(name)` could not exist here: a name-keyed map would let a
 * parameter shadowing a module-level `props` result be admitted.
 */
function jsxValueKind(nodePath, ctx) {
  if (nodePath == null || nodePath.node == null) return 'unknown';
  if (isPropsCall(nodePath, ctx)) return 'props';
  if (isCreateCall(nodePath, ctx)) return 'create';
  if (nodePath.isIdentifier()) {
    const binding = nodePath.scope?.getBinding(nodePath.node.name) ?? null;
    if (binding == null) return 'unknown';
    if (ctx.propsResults.has(binding)) return 'props';
    if (ctx.createResults.has(binding)) return 'create';
    return 'unknown';
  }
  if (
    nodePath.isTSAsExpression() ||
    nodePath.isTSSatisfiesExpression?.() ||
    nodePath.isParenthesizedExpression?.()
  ) {
    return jsxValueKind(nodePath.get('expression'), ctx);
  }
  if (
    nodePath.isMemberExpression() ||
    nodePath.isOptionalMemberExpression?.()
  ) {
    // `styles.page.className` - a member of a create() result.
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
      const binding = cur.scope?.getBinding(cur.node.name) ?? null;
      if (binding == null) return 'unknown';
      if (ctx.propsResults.has(binding)) return 'props';
      if (ctx.createResults.has(binding)) return 'create';
    }
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Forwarding the rest of an object is safe when its destructuring pattern
 * explicitly removed both style channels. The remaining native attributes
 * cannot introduce a className or inline style, even when their values came
 * from a caller such as React Hook Form's register().
 */
function isStyleSafeRestSpread(nodePath) {
  if (nodePath == null || !nodePath.isIdentifier()) return false;
  const binding = nodePath.scope?.getBinding(nodePath.node.name) ?? null;
  if (binding == null || binding.constantViolations.length > 0) {
    return false;
  }
  // A copied rest object remains safe for a function parameter as well as a
  // `const`, provided its only uses are JSX spreads. That excludes reassignment,
  // property reads with side effects, writes, and handing the object to code
  // that could add style keys.
  if (
    binding.referencePaths.length === 0 ||
    !binding.referencePaths.every((reference) => {
      const parent = reference.parentPath;
      return (
        parent?.isJSXSpreadAttribute() &&
        parent.get('argument').node === reference.node
      );
    })
  ) {
    return false;
  }
  // Function parameters can be nested inside an outer variable declarator
  // (arrow components). Prefer their own object pattern before looking up a
  // local variable declarator, or `const Component = ({ ...rest }) => ...`
  // would accidentally inspect the `Component` identifier instead.
  const declarator = binding.path.isVariableDeclarator() ? binding.path : null;
  const pattern =
    declarator != null
      ? declarator.get('id')
      : binding.path.isObjectPattern()
        ? binding.path
        : binding.path.findParent((candidate) => candidate.isObjectPattern());
  if (pattern == null || !pattern.isObjectPattern()) {
    return false;
  }
  const rest = pattern
    .get('properties')
    .find(
      (property) =>
        property.isRestElement() &&
        property.get('argument').isIdentifier() &&
        property.get('argument').node === binding.identifier,
    );
  if (rest == null) return false;
  const omitted = new Set();
  for (const property of pattern.get('properties')) {
    if (!property.isObjectProperty()) continue;
    const key = property.node.key;
    if (property.node.computed) continue;
    if (t.isIdentifier(key) || t.isStringLiteral(key))
      omitted.add(key.name ?? key.value);
  }
  return omitted.has('className') && omitted.has('style');
}

function checkJsxChannels(programPath, ctx, openingElements = null) {
  const checkOpeningElement = (p) => {
    for (const attr of p.get('attributes')) {
      if (attr.isJSXSpreadAttribute()) {
        const argument = attr.get('argument');
        const kind = jsxValueKind(argument, ctx);
        if (kind !== 'props' && !isStyleSafeRestSpread(argument)) {
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
        const kind = jsxValueKind(attr.get('value'), ctx);
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
  };
  if (openingElements != null) {
    for (const openingElement of openingElements) {
      checkOpeningElement(openingElement);
    }
    return;
  }
  programPath.traverse({ JSXOpeningElement: checkOpeningElement });
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

/**
 * Refuses an attempt to GRANT ITSELF authority, and nothing else.
 *
 * The previous rule refused any object property literally named `role`,
 * `trusted` or `__pmsRole` anywhere in a covered file. That is not a security
 * boundary, it is a vocabulary ban: `const user = { role: 'admin' }` and
 * `{ trusted: true }` are ordinary application data, and a compiler that
 * refuses them is not enforcing a profile, it is censoring a word.
 *
 * Authority in PandamStyle comes from the build configuration (the `role`
 * option and the design-system definition), never from a page. So a violation
 * requires an actual attempt to influence the compiler, and there are exactly
 * two shapes:
 *
 *  1. a NAMESPACED reserved field (`__pmsRole`, `__pmsTrusted`, ...). These
 *     cannot collide with business data, so seeing one is always an attempt;
 *
 *  2. an authority-looking field INSIDE a call to a recognized PandamStyle
 *     export - `props(x, { role: 'author' })`, `recipes.button({ trusted: true })`
 *     - which is a real attempt to configure the compiler from a page.
 *
 * `{ role: 'admin' }` as data, in a component prop, in a payload, in a
 * redux-shaped object, is none of those and is accepted.
 */
function selfDeclaredAuthorityVisitor(ctx) {
  return {
    ObjectProperty(p) {
      const key = p.node.key;
      const name = key.type === 'Identifier' ? key.name : key.value;
      if (typeof name !== 'string') return;

      if (RESERVED_AUTHORITY_KEYS.has(name)) {
        ctx.diags.push(
          makeDiag(
            ctx,
            'PMS_ROLE_VIOLATION',
            `A page cannot self-declare "${name}": authority is granted by the ` +
              'build configuration, not by the source.',
            p,
            'profile.closed.roles',
            { key: name, scope: 'reserved-namespace' },
          ),
        );
        return;
      }

      if (!AUTHORITY_KEYS_IN_PMS_CONTEXT.has(name)) return;

      const call = enclosingCall(p);
      if (call == null) return; // ordinary data: not an authority claim
      if (resolvePmsAccess(call.get('callee'), ctx) == null) return;

      ctx.diags.push(
        makeDiag(
          ctx,
          'PMS_ROLE_VIOLATION',
          `"${name}" may not be passed to a PandamStyle export: authority is ` +
            'granted by the build configuration, not by the source.',
          p,
          'profile.closed.roles',
          { key: name, scope: 'pandamstyle-call' },
        ),
      );
    },
  };
}

/** The nearest enclosing CallExpression whose argument subtree contains `p`. */
function enclosingCall(p) {
  let cur = p.parentPath;
  while (cur != null) {
    if (cur.isCallExpression?.()) {
      for (const arg of cur.get('arguments')) {
        if (arg == null || arg.node == null) continue;
        if (isDescendant(arg, p)) return cur;
      }
    }
    if (cur.isProgram?.()) return null;
    cur = cur.parentPath;
  }
  return null;
}

function isDescendant(ancestor, node) {
  let cur = node;
  while (cur != null) {
    if (cur === ancestor || cur.node === ancestor.node) return true;
    cur = cur.parentPath;
  }
  return false;
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

          const state = createPassState(pluginPass);

          count('semantic_builds');
          const ctx = createUsageContext({
            state,
            pluginPass,
            filename,
            options,
            role,
          });
          pluginPass.__pandamstyle = ctx;

          perfPhase('semantic_ms', () => {
            readStaticModuleFacts(programPath, ctx);
            const dynamicContext = { ...ctx, diags: [] };
            const authorityContext = { ...ctx, diags: [] };
            readDynamicModuleFacts(
              programPath,
              dynamicContext,
              selfDeclaredAuthorityVisitor(authorityContext),
            );
            ctx.diags.push(...dynamicContext.diags);
            checkEngineImports(programPath, ctx);
            ctx.diags.push(...authorityContext.diags);
          });
        },
        exit(programPath, pluginPass) {
          const ctx = pluginPass.__pandamstyle;
          if (ctx == null) return;

          let semanticCandidates;
          perfPhase('semantic_ms', () => {
            semanticCandidates = collectSemanticCandidates(programPath, ctx);
          });

          // PROVENANCE PASS - strictly before any rewrite.
          //
          // `checkPropsProvenance` must see the ORIGINAL tree: a `create()`
          // result is still a call, so `styles.page` is still provably a compiled
          // namespace. Running it after the transform would only see the emitted
          // object literal and could no longer tell a compiled style from a raw
          // one.
          perfPhase('semantic_ms', () => {
            checkPropsProvenance(
              programPath,
              ctx,
              semanticCandidates.provenanceNodes,
            );
            checkJsxChannels(
              programPath,
              ctx,
              semanticCandidates.jsxOpeningElements,
            );
            analyzeProvenanceEscapes(programPath, ctx);
          });

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
              perfPhase('ir_lower_ms', () => {
                programPath.traverse({
                  CallExpression: (p) => {
                    transformUsage({ path: p, ctx, ds, programPath });
                  },
                  'MemberExpression|OptionalMemberExpression': (p) => {
                    transformUsage({ path: p, ctx, ds, programPath });
                  },
                });
              });

              // Pass 2 runs afterwards on purpose: a token() hoisted into a
              // module-level constant is only lowerable once every create()
              // has consumed its own references.
              if (ctx.diags.length === 0) {
                perfPhase('ir_lower_ms', () => {
                  programPath.traverse({
                    CallExpression: (p) => {
                      if (ctx.diags.length > 0) return;
                      transformResidualTokens({ path: p, ctx, ds });
                    },
                  });
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
          pluginPass.file.metadata.pandamstyleSemanticUnits = [
            ...ctx.semanticUnits,
          ].sort();

          count('diagnostics', ctx.diags.length);
          if (ctx.diags.length > 0) {
            throw new PmsError(ctx.diags);
          }
        },
      },
    },
  };
}

export { provenanceOf, Provenance };
export default pandamstyleBabelPlugin;
