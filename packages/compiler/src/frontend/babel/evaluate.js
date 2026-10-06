/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - recognition and static evaluation of usages (ARC-06, D-02).
 *
 * Principle: a call is recognized only when its *binding* and its *module* are
 * truthful. A textual name is never compared. A local helper named `token`, a
 * `var(--...)` string, or an object imitating an internal reference therefore
 * gains no trust.
 *
 * Evaluation is static (D-02): literals, local constants, spreads, statically
 * computable property keys, and TypeScript forms (`as any`, `satisfies`, `!`)
 * are folded. Everything else yields `PMS_NON_STATIC_VALUE` - never a silent
 * acceptance.
 */

import { evaluateStaticExpression } from './static-evaluator';
import { diagnostic, Codes } from '../../protocol/diagnostics';
import { mintTokenRef } from '../../design-system/tokens/ref';
import {
  resolveDesignSystemModule,
  resolveRelativeFile,
  relayExportMap,
} from '../../project/graph/resolution';

/** Export names the generated design-system module must provide. */
export const REQUIRED_HELPERS = [
  'create',
  'token',
  'recipes',
  'themes',
  'props',
  'patterns',
];

const FORBIDDEN_IMPORT_PATTERNS = [
  { test: (s) => s === '@stylexjs/stylex', reason: 'upstream-stylex-entry' },
  {
    test: (s) => s.startsWith('@stylexjs/stylex/'),
    reason: 'stylex-private-subpath',
  },
  { test: (s) => s === '@stylexjs/atoms', reason: 'stylex-atoms-entry' },
  {
    test: (s) =>
      s === '@stylexjs/babel-plugin' || s.startsWith('@stylexjs/babel-plugin/'),
    reason: 'compiler-entry',
  },
  {
    test: (s) => s === '@pandacss/dev-runtime' || s.startsWith('@pandacss/'),
    reason: 'panda-engine',
  },
  {
    test: (s) => /(^|\/)pandamstyle\/(token|policy|registry|compiler)$/.test(s),
    reason: 'pandamstyle-private-subpath',
  },
];

const FORBIDDEN_CSS_RE =
  /(^|\/)[^?]*\.(css|scss|sass|less|styl)$|\?.*\b(css|scss|sass|less|styl)\b/;

export const FAIL = Symbol('pandamstyle.evalFail');

export function originKey(ns, prop, cond) {
  return JSON.stringify([ns, prop, cond ?? null]);
}

function locationOf(nodePath, ctx) {
  const node = nodePath?.node;
  if (node?.loc == null) {
    return {
      file: ctx.filename,
      line: null,
      column: null,
      role: ctx.role,
    };
  }
  return {
    file: ctx.filename,
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    role: ctx.role,
  };
}

function importedNameOf(specifier) {
  const imported = specifier.imported;
  if (imported == null) return null;
  return imported.type === 'Identifier' ? imported.name : imported.value;
}

/**
 * Builds the context of one covered file: role, recognized helpers
 * (BINDING -> design-system export), and boundary violations.
 *
 * Every map is keyed by a Babel `Binding`, never by a name. A name-keyed map
 * cannot tell a module-level import from a parameter that shadows it, and it
 * cannot tell a `const` from a `let` that is later reassigned.
 */
export function createUsageContext({
  state,
  pluginPass,
  filename,
  options = {},
  role = 'page',
}) {
  return {
    // `state` is a per-pass PandamStyle context for source identity;
    // `pluginPass` is the Babel PluginPass used for file metadata.
    state,
    pluginPass,
    filename,
    options,
    role,
    // Binding -> { exportName } for a named import of the design system, or
    // { namespace: true } for `import * as ds`.
    helperBindings: new Map(),
    pmsModule: null,
    pmsModulePath: null,
    diags: [],
    origins: new Map(),
    used: false,
    // Binding -> provenance descriptor, computed in pandamstyle/provenance.js.
    provenance: new Map(),
    // Binding -> true for a local constant whose value is a `props(...)` result.
    // Used by the JSX channel checks, so a spread of a renamed or shadowed
    // identifier is resolved through the binding and not through its spelling.
    propsResults: new Set(),
    // Binding -> 'create' for a local constant whose value is a `create()` result.
    createResults: new Set(),
    // Local dependency requests that could not be resolved statically.
    dynamicGaps: [],
    // The project session uses these semantic unit keys to invalidate only
    // compiled files whose transformed output or diagnostics can change.
    // They are populated by the same binding-resolved transform that consumes
    // the design system, so no host or parallel parser invents dependencies.
    semanticUnits: new Set(),
  };
}

export function addSemanticUnit(ctx, unit) {
  ctx.semanticUnits?.add(unit);
}

function pushDiag(ctx, diag) {
  ctx.diags.push(diag);
}

function helperOf(binding, namespaceChain = []) {
  if (binding?.kind === 'namespace') {
    const members = new Map();
    for (const member of binding.members ?? []) {
      const helper = helperOf(member, [
        ...namespaceChain,
        ...(binding.chain ?? []),
      ]);
      if (helper != null) members.set(member.exported, helper);
    }
    return members.size === 0 ? null : { namespace: true, members };
  }
  return binding?.designSystem === true &&
    REQUIRED_HELPERS.includes(binding.imported)
    ? {
        exportName: binding.imported,
        provenance: {
          ...binding,
          chain: [...new Set([...namespaceChain, ...binding.chain])],
        },
      }
    : null;
}

/** Reads the program imports and classifies every source. */
export function readModuleFacts(programPath, ctx) {
  readStaticModuleFacts(programPath, ctx);
  readDynamicModuleFacts(programPath, ctx);
}

/** Reads import declarations without walking the AST for dynamic requests. */
export function readStaticModuleFacts(programPath, ctx) {
  for (const stmt of programPath.get('body')) {
    if (!stmt.isImportDeclaration()) continue;
    const source = stmt.node.source.value;

    if (stmt.node.importKind === 'type' || stmt.node.importKind === 'typeof') {
      continue;
    }

    // 1. Design system, directly or through an intermediate re-export.
    const resolved = resolveDesignSystemModule(ctx.filename, source, {
      maxDepth: ctx.options.maxRelayDepth,
    });
    if (resolved?.artifactMismatch?.length > 0) {
      pushDiag(
        ctx,
        diagnostic({
          code: Codes.GENERATED_ARTIFACT_MISMATCH,
          phase: 'imports',
          message:
            `Generated design-system metadata in "${source}" is not owned by this compiler session. ` +
            'Import the generated artifact from the configured design-system output.',
          source: locationOf(stmt, ctx),
          rule: 'provenance.generated-artifact',
          context: {
            source,
            modules: resolved.artifactMismatch.map(
              (artifact) => artifact.modulePath,
            ),
          },
        }),
      );
      continue;
    }
    if (resolved != null) {
      ctx.pmsModule = resolved;
      ctx.pmsModulePath = resolved.modulePath;
      const relay = relayExportMap(resolved);
      for (const spec of stmt.node.specifiers) {
        if (spec.importKind === 'type' || spec.importKind === 'typeof')
          continue;
        const exported =
          spec.type === 'ImportDefaultSpecifier'
            ? 'default'
            : importedNameOf(spec);
        const descriptor =
          spec.type === 'ImportNamespaceSpecifier'
            ? { kind: 'namespace', members: [...relay.values()] }
            : relay.get(exported);
        const helper = helperOf(descriptor);
        const binding = stmt.scope?.getBinding(spec.local.name) ?? null;
        if (binding != null && helper != null)
          ctx.helperBindings.set(binding, helper);
        if (descriptor == null && exported != null) {
          pushDiag(
            ctx,
            diagnostic({
              code: Codes.FORBIDDEN_IMPORT,
              phase: 'imports',
              message: `No unambiguous export "${exported}" is forwarded by "${source}".`,
              source: locationOf(stmt, ctx),
              rule: 'module.forwarding',
              context: {
                source,
                exported,
                reason: 'missing-or-ambiguous-export',
                forwardingIssues: resolved.issues,
                repairShape:
                  'Import an explicitly forwarded binding or repair the relay export.',
              },
            }),
          );
        }
      }
      continue;
    }

    // 2. Engine entries and style channels forbidden in the closed profile.
    for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
      if (pattern.test(source)) {
        pushDiag(
          ctx,
          diagnostic({
            code: Codes.FORBIDDEN_IMPORT,
            phase: 'imports',
            message:
              `Import forbidden in the closed profile: "${source}" ` +
              `(${pattern.reason}). Styles must go through the PandamStyle exports.`,
            source: locationOf(stmt, ctx),
            rule: 'profile.closed.imports',
            context: { source, reason: pattern.reason },
          }),
        );
        break;
      }
    }
    if (FORBIDDEN_CSS_RE.test(source)) {
      pushDiag(
        ctx,
        diagnostic({
          code: Codes.FORBIDDEN_STYLE_CHANNEL,
          phase: 'imports',
          message:
            `Unapproved local stylesheet: "${source}". PandamStyle CSS is ` +
            'static and extracted by the build.',
          source: locationOf(stmt, ctx),
          rule: 'profile.closed.style-channel',
          context: { source },
        }),
      );
    }

    // 3. A local import from a covered root must resolve, or it is a gap.
    //    Stylesheets were already reported above as a style channel.
    if (source.startsWith('.') && !FORBIDDEN_CSS_RE.test(source)) {
      const target = resolveRelativeFile(ctx.filename, source);
      if (target == null) {
        pushDiag(
          ctx,
          diagnostic({
            code: Codes.COVERAGE_GAP,
            phase: 'imports',
            message: `Unresolved local import from a covered root: "${source}".`,
            source: locationOf(stmt, ctx),
            rule: 'coverage.local-imports',
            context: { source },
          }),
        );
      }
    }
  }
}

/**
 * The P0 decision about `import(...)` and `require(...)`, stated explicitly so
 * a dynamic edge is never ignored silently.
 *
 * P0 is a closed profile with a static module graph, so:
 *
 *  - a dynamic request with a LITERAL local specifier is a normal local edge:
 *    the coverage graph follows it and the target is analysed;
 *  - a dynamic request with a NON-static specifier cannot be resolved, so the
 *    module it will load is unknown. That is a coverage gap, not a detail: it
 *    fails with PMS_COVERAGE_GAP rather than being dropped;
 *  - a dynamic request for a PACKAGE is not a local edge, so it is not part of
 *    the local coverage contract. A literal one is still checked against the
 *    forbidden-import table, so `await import('@pandamstyle/dev-runtime')`
 *    cannot reach the engine by the back door.
 */
export function readDynamicModuleFacts(
  programPath,
  ctx,
  additionalVisitors = {},
) {
  programPath.traverse({
    ...additionalVisitors,
    // @babel/parser models a dynamic import as CallExpression with an `Import`
    // callee; ESTree uses ImportExpression. Both are visited, because a shape
    // this pass does not recognise is a dynamic edge nobody checked.
    ImportExpression(nodePath) {
      checkDynamicRequest(nodePath, nodePath.get('source'), 'import()', ctx);
    },
    CallExpression(nodePath) {
      const calleeNode = nodePath.node.callee;
      if (calleeNode != null && calleeNode.type === 'Import') {
        const arg = nodePath.get('arguments')[0] ?? null;
        checkDynamicRequest(nodePath, arg, 'import()', ctx);
        return;
      }
      const callee = nodePath.get('callee');
      if (!callee.isIdentifier?.() || callee.node.name !== 'require') return;
      // Only a global, unbound `require` is the CommonJS form; a local
      // `require` binding is ordinary application code.
      if (nodePath.scope.getBinding('require') != null) return;
      const args = nodePath.get('arguments');
      checkDynamicRequest(nodePath, args[0] ?? null, 'require()', ctx);
    },
  });
}

function checkDynamicRequest(nodePath, argPath, form, ctx) {
  if (argPath == null || argPath.node == null) {
    pushDiag(
      ctx,
      diagnostic({
        code: Codes.COVERAGE_GAP,
        phase: 'imports',
        message: `${form} without a request: the module it will load is unknown.`,
        source: locationOf(nodePath, ctx),
        rule: 'coverage.dynamic-modules',
        context: { form },
      }),
    );
    return;
  }

  const literal = staticStringLiteral(argPath);
  if (literal == null) {
    if (
      argPath.isTemplateLiteral?.() &&
      argPath.node.expressions.length === 0
    ) {
      // A quasi-static template is still resolvable.
      const value = argPath.node.quasis[0]?.value?.cooked;
      if (typeof value === 'string') {
        checkDynamicLiteral(nodePath, value, form, ctx);
        return;
      }
    }
    const gap = { form, file: ctx.filename, request: '<computed>' };
    ctx.dynamicGaps.push(gap);
    pushDiag(
      ctx,
      diagnostic({
        code: Codes.COVERAGE_GAP,
        phase: 'imports',
        message:
          `${form} with a request that is not a static string. P0 supports a ` +
          'static module graph only, so a computed request would load an ' +
          'unknown, unanalysed module.',
        source: locationOf(argPath, ctx),
        rule: 'coverage.dynamic-modules',
        context: { form },
      }),
    );
    return;
  }
  checkDynamicLiteral(nodePath, literal, form, ctx);
}

function checkDynamicLiteral(nodePath, request, form, ctx) {
  // The same closed-profile rules as a static import apply to a literal
  // dynamic request: the back door is the problem, not the syntax.
  for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
    if (pattern.test(request)) {
      pushDiag(
        ctx,
        diagnostic({
          code: Codes.FORBIDDEN_IMPORT,
          phase: 'imports',
          message:
            `Import forbidden in the closed profile: "${request}" ` +
            `(${pattern.reason}), reached through ${form}. Styles must go ` +
            'through the PandamStyle exports.',
          source: locationOf(nodePath, ctx),
          rule: 'profile.closed.imports',
          context: { source: request, reason: pattern.reason, form },
        }),
      );
      return;
    }
  }
  if (FORBIDDEN_CSS_RE.test(request)) {
    pushDiag(
      ctx,
      diagnostic({
        code: Codes.FORBIDDEN_STYLE_CHANNEL,
        phase: 'imports',
        message: `Unapproved local stylesheet: "${request}", reached through ${form}.`,
        source: locationOf(nodePath, ctx),
        rule: 'profile.closed.style-channel',
        context: { source: request, form },
      }),
    );
    return;
  }
  if (
    request.startsWith('.') &&
    resolveRelativeFile(ctx.filename, request) == null
  ) {
    pushDiag(
      ctx,
      diagnostic({
        code: Codes.COVERAGE_GAP,
        phase: 'imports',
        message: `Unresolved local ${form} from a covered root: "${request}".`,
        source: locationOf(nodePath, ctx),
        rule: 'coverage.dynamic-modules',
        context: { request, form },
      }),
    );
  }
}

function staticStringLiteral(nodePath) {
  if (nodePath.isStringLiteral?.()) return nodePath.node.value;
  return null;
}

/** Does this covered file reach the design system (directly or via a relay)? */
export function usesDesignSystem(ctx) {
  return ctx.pmsModule != null;
}

function staticPropertyName(nodePath) {
  const node = nodePath.node;
  if (node.computed) {
    const key = node.property;
    if (key.type === 'StringLiteral') return key.value;
    if (key.type === 'NumericLiteral') return String(key.value);
    return null;
  }
  const prop = node.property;
  if (prop == null) return null;
  if (prop.type === 'Identifier') return prop.name;
  if (prop.type === 'StringLiteral') return prop.value;
  return null;
}

/**
 * Resolves an expression to an export path of the design system.
 * `recipes.button` -> { exportPath: ['recipes','button'] }
 *
 * A bare identifier is only recognized when its BINDING is a recognized import.
 * A parameter, a function parameter shadowing the import, or a local variable
 * with the same spelling resolves to a different Binding and is therefore not
 * recognized: a name never confers trust.
 */
export function resolvePmsAccess(nodePath, ctx, seenAliases = new Set()) {
  if (nodePath == null) return null;
  if (nodePath.isIdentifier()) {
    const binding = nodePath.scope?.getBinding(nodePath.node.name) ?? null;
    if (binding == null) return null;
    const helper = ctx.helperBindings.get(binding);
    if (helper == null) {
      // A const alias keeps the authority of the authenticated binding it
      // directly names. Resolve by Babel Binding identity and initializer; a
      // matching spelling, mutable `let`, or reassigned alias proves nothing.
      if (
        binding.kind !== 'const' ||
        binding.constantViolations.length > 0 ||
        seenAliases.has(binding)
      ) {
        return null;
      }
      const bindingPath = binding.path;
      if (
        bindingPath == null ||
        !bindingPath.isVariableDeclarator() ||
        bindingPath.node.id.type !== 'Identifier'
      ) {
        return null;
      }
      const init = bindingPath.get('init');
      if (init == null || init.node == null) return null;
      seenAliases.add(binding);
      const alias = resolvePmsAccess(init, ctx, seenAliases);
      seenAliases.delete(binding);
      if (alias == null) return null;
      return { ...alias, binding };
    }
    if (helper.namespace === true)
      return { exportPath: [], binding, members: helper.members };
    return { exportPath: [helper.exportName], binding };
  }
  if (
    nodePath.isTSAsExpression() ||
    nodePath.isTSSatisfiesExpression?.() ||
    nodePath.isTSNonNullExpression?.() ||
    nodePath.isTypeCastExpression?.()
  ) {
    return resolvePmsAccess(nodePath.get('expression'), ctx, seenAliases);
  }
  if (
    nodePath.isMemberExpression() ||
    nodePath.isOptionalMemberExpression?.()
  ) {
    const objectAccess = resolvePmsAccess(
      nodePath.get('object'),
      ctx,
      seenAliases,
    );
    if (objectAccess == null) return null;
    const prop = staticPropertyName(nodePath);
    if (prop == null) return null;
    if (objectAccess.exportPath.length === 0) {
      const helper = objectAccess.members?.get(prop);
      if (helper == null) return null;
      return helper.namespace
        ? { exportPath: [], members: helper.members }
        : { exportPath: [helper.exportName] };
    }
    return { exportPath: [...objectAccess.exportPath, prop] };
  }
  return null;
}

/**
 * A `token(...)` call is recognized by binding and module, whether the helper
 * was imported by name (`token`, or renamed) or reached through a namespace
 * import (`pms.token`).
 */
export function isTokenHelperCall(nodePath, ctx) {
  if (!nodePath.isCallExpression()) return false;
  const access = resolvePmsAccess(nodePath.get('callee'), ctx);
  return (
    access != null &&
    access.exportPath.length === 1 &&
    access.exportPath[0] === 'token'
  );
}

export function isCreateCall(nodePath, ctx) {
  if (!nodePath.isCallExpression()) return false;
  const access = resolvePmsAccess(nodePath.get('callee'), ctx);
  return (
    access != null &&
    access.exportPath.length === 1 &&
    access.exportPath[0] === 'create'
  );
}

export function isPropsCall(nodePath, ctx) {
  if (!nodePath.isCallExpression()) return false;
  const access = resolvePmsAccess(nodePath.get('callee'), ctx);
  return (
    access != null &&
    access.exportPath.length === 1 &&
    access.exportPath[0] === 'props'
  );
}

/** `recipes.button(...)` -> ['recipes','button']; `themes.light` -> ['themes','light'] */
export function resolveDesignAccess(nodePath, ctx, root) {
  const access = resolvePmsAccess(nodePath, ctx);
  if (access == null) return null;
  if (access.exportPath.length >= 1 && access.exportPath[0] === root) {
    return access.exportPath;
  }
  return null;
}

/** Folding delegated to the PandamStyle-owned static evaluator. */
function forkEvaluate(nodePath, ctx) {
  return evaluateStaticExpression(nodePath, ctx.state);
}

function nonStatic(ctx, nodePath, reason) {
  pushDiag(
    ctx,
    diagnostic({
      code: Codes.NON_STATIC_VALUE,
      phase: 'evaluation',
      message:
        `Value not statically resolvable${reason ? ` (${reason})` : ''}. ` +
        'P0 does not evaluate arbitrary JavaScript: declare a literal, a local ' +
        'constant, or a token reference.',
      source: locationOf(nodePath, ctx),
      rule: 'static-resolution',
      context: { reason: reason ?? null },
    }),
  );
  return FAIL;
}

/**
 * Statically evaluates a declaration value.
 * Returns the value, or `FAIL` after pushing a diagnostic.
 */
export function evaluateValue(nodePath, ctx, origin = null, mode = 'value') {
  if (nodePath == null || nodePath.node == null) {
    return nonStatic(ctx, ctx.state.file.path, 'missing');
  }

  // `x as any`, `x satisfies T`, `x!`, `(x)`: transparent folding.
  if (
    nodePath.isTSAsExpression() ||
    nodePath.isTSSatisfiesExpression?.() ||
    nodePath.isTypeCastExpression?.() ||
    nodePath.isTSNonNullExpression?.() ||
    nodePath.isTSInstantiationExpression?.() ||
    nodePath.isParenthesizedExpression()
  ) {
    return evaluateValue(nodePath.get('expression'), ctx, origin);
  }

  if (isTokenHelperCall(nodePath, ctx)) {
    const args = nodePath.get('arguments');
    if (args.length !== 1) {
      return nonStatic(ctx, nodePath, 'token() takes exactly one argument');
    }
    const argRes = forkEvaluate(args[0], ctx);
    if (
      !argRes.confident ||
      typeof argRes.value !== 'string' ||
      argRes.value === ''
    ) {
      return nonStatic(ctx, args[0], 'token() expects a static token path');
    }
    if (origin != null) ctx.origins.set(origin, locationOf(args[0], ctx));
    addSemanticUnit(ctx, `token:${argRes.value}`);
    addSemanticUnit(ctx, 'runtime-identity');
    return mintTokenRef(argRes.value);
  }

  // Member access over a statically resolvable local constant, e.g.
  // `SPACING.md` where `const SPACING = { md: token('spacing.md') }`.
  // Resolved here because the fork's evaluator cannot fold a token() call.
  if (
    nodePath.isMemberExpression() ||
    nodePath.isOptionalMemberExpression?.()
  ) {
    const objectValue = evaluateValue(
      nodePath.get('object'),
      ctx,
      null,
      'value',
    );
    if (objectValue === FAIL) return FAIL;
    const prop = staticPropertyName(nodePath);
    if (prop == null) {
      return nonStatic(ctx, nodePath, 'computed member key is not resolvable');
    }
    if (
      objectValue === null ||
      typeof objectValue !== 'object' ||
      Array.isArray(objectValue)
    ) {
      return nonStatic(ctx, nodePath, 'member access on a non-object value');
    }
    if (!Object.prototype.hasOwnProperty.call(objectValue, prop)) {
      return nonStatic(ctx, nodePath, `property "${prop}" is not defined`);
    }
    if (origin != null) ctx.origins.set(origin, locationOf(nodePath, ctx));
    return objectValue[prop];
  }

  if (nodePath.isObjectExpression()) {
    return evaluateObject(nodePath, ctx, origin, mode);
  }

  if (nodePath.isArrayExpression()) {
    const out = [];
    const elems = nodePath.get('elements');
    for (let i = 0; i < elems.length; i++) {
      const el = elems[i];
      if (el == null || el.node == null) {
        out.push(null);
        continue;
      }
      const v = evaluateValue(el, ctx, null);
      if (v === FAIL) return FAIL;
      out.push(v);
    }
    return out;
  }

  // Local constant: fold to its initializer, which lets
  // `const SPACING = token('spacing.md')` work.
  if (nodePath.isIdentifier()) {
    const name = nodePath.node.name;
    const binding = nodePath.scope?.getBinding(name);
    if (binding != null) {
      if (binding.constantViolations.length > 0) {
        return nonStatic(ctx, nodePath, `binding "${name}" is reassigned`);
      }
      const bp = binding.path;
      if (
        bp != null &&
        bp.isVariableDeclarator() &&
        bp.node.id.type === 'Identifier'
      ) {
        const init = bp.get('init');
        if (init == null || init.node == null) {
          return nonStatic(ctx, nodePath, `"${name}" is not initialized`);
        }
        return evaluateValue(init, ctx, origin, 'value');
      }
    }
  }

  const res = forkEvaluate(nodePath, ctx);
  if (!res.confident) {
    return nonStatic(ctx, nodePath, res.reason ?? 'expression is not constant');
  }
  if (origin != null) ctx.origins.set(origin, locationOf(nodePath, ctx));
  return res.value;
}

/** Reads a property key from an ObjectProperty path (handles computed keys). */
function staticKeyName(propPath, ctx) {
  if (propPath.node == null) return { ok: false };
  if (!propPath.node.computed) {
    const k = propPath.node.key;
    if (k == null) return { ok: false };
    if (k.type === 'Identifier') return { ok: true, name: k.name };
    if (k.type === 'StringLiteral') return { ok: true, name: k.value };
    if (k.type === 'NumericLiteral') return { ok: true, name: String(k.value) };
    return { ok: false };
  }
  const res = forkEvaluate(propPath.get('key'), ctx);
  if (!res.confident) return { ok: false };
  const v = res.value;
  if (typeof v === 'string' || typeof v === 'number') {
    return { ok: true, name: String(v) };
  }
  return { ok: false };
}

/**
 * Evaluates a declaration object, recording provenance per
 * `namespace / property / condition` path.
 */
function evaluateObject(nodePath, ctx, origin, mode = 'declaration') {
  const isDeclaration = mode === 'declaration';
  const out = {};
  for (const prop of nodePath.get('properties')) {
    if (prop.isObjectMethod() || prop.isClassMethod?.()) {
      return nonStatic(
        ctx,
        prop,
        'object methods are not accepted in a declaration',
      );
    }
    if (prop.isSpreadElement()) {
      const v = evaluateValue(prop.get('argument'), ctx, null, 'value');
      if (v === FAIL) return FAIL;
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        return nonStatic(
          ctx,
          prop,
          'the spread does not produce a declaration object',
        );
      }
      // The spread is folded: every value it carries passes through policy
      // again, so an alias or a spread never launders a value.
      Object.assign(out, v);
      continue;
    }
    if (!prop.isObjectProperty()) {
      return nonStatic(ctx, prop, 'unsupported property form');
    }
    const key = staticKeyName(prop, ctx);
    if (!key.ok) {
      if (isDeclaration) {
        return nonStatic(
          ctx,
          prop.get('key'),
          'property key is not resolvable',
        );
      }
      // In a VALUE position the object is opaque data, not a declaration. It
      // is kept as-is so the policy judges it: an object imitating an internal
      // reference carries no proof and is rejected as a raw value.
      const raw = evaluateValue(prop.get('value'), ctx, null, 'value');
      if (raw === FAIL) return FAIL;
      const keyNode = prop.node.key;
      if (keyNode.type === 'Identifier' && !prop.node.computed) {
        out[keyNode.name] = raw;
      } else {
        const evaluatedKey = forkEvaluate(prop.get('key'), ctx);
        if (evaluatedKey.confident) {
          out[String(evaluatedKey.value)] = raw;
        } else {
          const sym = prop.node.key;
          if (sym.type === 'Identifier') out[sym.name] = raw;
        }
      }
      continue;
    }
    const nsName = ctx.currentNs ?? '';
    const value = evaluateValue(
      prop.get('value'),
      ctx,
      originKey(nsName, key.name, null),
      'value',
    );
    if (value === FAIL) return FAIL;
    out[key.name] = value;
  }
  if (origin != null) ctx.origins.set(origin, locationOf(nodePath, ctx));
  return out;
}

/**
 * Provenance of a declaration value, falling back to the closest known path.
 */
export function locateOrigin(ctx, ns, prop, cond) {
  const exact = ctx.origins.get(originKey(ns, prop, cond));
  if (exact != null) return exact;
  const byProp = ctx.origins.get(originKey(ns, prop, null));
  if (byProp != null) return byProp;
  return { file: ctx.filename, line: null, column: null, role: ctx.role };
}
