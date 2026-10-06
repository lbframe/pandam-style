/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - transformation of recognized usages (ARC-05 steps 3 to 7).
 *
 * CSS comes only from the fork engine (`styleXCreateSet`, and for the design
 * system `styleXDefineVars` / `styleXCreateTheme`). The emitted JS keeps only
 * what composition and finite selection need: class literals, theme objects and
 * compiled recipe branch references. No registry, no CSS object interpreted at
 * runtime.
 */

import * as t from '@babel/types';
import { defineRecipeSelector } from '@pandamstyle/core';
import { compileStyles } from '../../engine/lowering/styles';
import { createPatternIR } from '../../design-system/patterns/compile';
import { diagnostic, Codes } from '../../protocol/diagnostics';
import {
  toRecipeSpec,
  toRuntimeRefs,
  toThemeRef,
} from '../../artifacts/javascript/refs';
import {
  FAIL,
  addSemanticUnit,
  evaluateValue,
  isCreateCall,
  isPropsCall,
  isTokenHelperCall,
  locateOrigin,
  resolveDesignAccess,
  resolvePmsAccess,
} from './evaluate';
import { isAdmitted, provenanceOf } from '../../semantics/provenance/index';
// Benchmark-only measurement hooks (Spike 1).
import { phase as perfPhase } from '../../observability/metrics';

const CORE_PROPS_LOCAL = '__pmsProps';

function lineOnly(ctx, nodePath) {
  return {
    file: ctx.filename,
    line: nodePath?.node?.loc?.start.line ?? null,
    column: null,
    role: ctx.role,
  };
}

function fullLoc(ctx, nodePath) {
  const loc = nodePath?.node?.loc;
  return {
    file: ctx.filename,
    line: loc?.start.line ?? null,
    column: loc ? loc.start.column + 1 : null,
    role: ctx.role,
  };
}

function addNamedImport(programPath, source, imported, local) {
  for (const stmt of programPath.get('body')) {
    if (!stmt.isImportDeclaration() || stmt.node.source.value !== source)
      continue;
    for (const spec of stmt.node.specifiers) {
      if (spec.type === 'ImportSpecifier' && spec.local.name === local)
        return local;
    }
    stmt.node.specifiers.push(
      t.importSpecifier(t.identifier(local), t.identifier(imported)),
    );
    return local;
  }
  programPath.unshiftContainer(
    'body',
    t.importDeclaration(
      [t.importSpecifier(t.identifier(local), t.identifier(imported))],
      t.stringLiteral(source),
    ),
  );
  return local;
}

function literalOf(value) {
  if (Array.isArray(value)) {
    return t.arrayExpression(value.map((item) => literalOf(item)));
  }
  if (typeof value === 'string') return t.stringLiteral(value);
  if (typeof value === 'number') return t.numericLiteral(value);
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  if (value === null) return t.nullLiteral();
  if (value === undefined) return t.identifier('undefined');
  return t.objectExpression(
    Object.entries(value).map(([key, item]) =>
      t.objectProperty(
        t.isValidIdentifier(key, false)
          ? t.identifier(key)
          : t.stringLiteral(key),
        literalOf(item),
      ),
    ),
  );
}

/** Records the rules emitted by the engine in the file metadata. */
function registerRules(pluginPass, injected, callPath) {
  const file = pluginPass.file;
  file.metadata.pandamstyle = file.metadata.pandamstyle ?? [];
  file.metadata.pandamstyleRuleOrigins =
    file.metadata.pandamstyleRuleOrigins ?? [];
  for (const [key, { priority, ...rest }] of Object.entries(injected)) {
    file.metadata.pandamstyle.push([key, rest, priority ?? 0]);
    const start = callPath.node.loc?.start;
    if (start != null)
      file.metadata.pandamstyleRuleOrigins.push({
        className: key,
        line: start.line,
        column: start.column,
      });
  }
}

/**
 * Compiles an already-evaluated `create({...})` object.
 * Provenance locates each diagnostic inside the page.
 */
function compileNamespaces(namespaces, ctx, ds) {
  return perfPhase('policy_ms', () =>
    compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces,
      role: 'consumer',
      allowPrivateTokens: false,
      source: ctx.filename,
      refKind: 'compiler',
      locate: (ns, prop, cond) => locateOrigin(ctx, ns, prop, cond),
      options: ctx.options.engineOptions ?? {},
    }),
  );
}

function reject(ctx, code, message, nodePath, rule, context = {}) {
  ctx.diags.push(
    diagnostic({
      code,
      phase: 'transform',
      message,
      source: fullLoc(ctx, nodePath),
      rule,
      context,
    }),
  );
}

function transformCreateCall(callPath, ctx, ds) {
  const args = callPath.get('arguments');
  if (args.length !== 1) {
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      'create() expects a single static declaration object.',
      callPath,
      'static-resolution',
    );
    return;
  }

  const namespaces = {};
  const argPath = args[0];

  if (argPath.isObjectExpression()) {
    for (const prop of argPath.get('properties')) {
      if (prop.isObjectMethod()) {
        reject(
          ctx,
          Codes.NON_STATIC_VALUE,
          'Unresolvable style namespace (object method).',
          prop,
          'static-resolution',
        );
        continue;
      }
      if (prop.isSpreadElement()) {
        const v = evaluateValue(prop.get('argument'), ctx, null);
        if (v === FAIL) return;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(namespaces, v);
        }
        continue;
      }
      if (!prop.isObjectProperty()) continue;
      const keyNode = prop.node.key;
      const nsName =
        keyNode.type === 'Identifier'
          ? keyNode.name
          : String(keyNode.value ?? '');
      if (nsName === '') continue;
      const prev = ctx.currentNs;
      ctx.currentNs = nsName;
      const v = evaluateValue(prop.get('value'), ctx, null, 'declaration');
      ctx.currentNs = prev;
      if (v === FAIL) return;
      namespaces[nsName] = v;
    }
  } else {
    // An object built outside a literal is not resolvable in P0.
    const v = evaluateValue(argPath, ctx, null);
    if (v === FAIL) return;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      reject(
        ctx,
        Codes.NON_STATIC_VALUE,
        "create()'s argument must be a declaration object.",
        argPath,
        'static-resolution',
      );
      return;
    }
    Object.assign(namespaces, v);
  }

  // Report this call's own verdict even if an earlier one already failed, so a
  // single build lists every distinct violation in the file.
  const priorCount = ctx.diags.length;

  let result;
  try {
    result = compileNamespaces(namespaces, ctx, ds);
  } catch (err) {
    if (err != null && Array.isArray(err.diagnostics)) {
      ctx.diags.push(...err.diagnostics);
      return;
    }
    throw err;
  }
  if (ctx.diags.length > priorCount) return;
  addSemanticUnit(ctx, 'runtime-identity');
  addSemanticUnit(ctx, 'conditions');
  registerRules(ctx.pluginPass, result.injected, callPath);
  callPath.replaceWith(
    literalOf(toRuntimeRefs(result.compiled, ds.registry.systemId)),
  );
  ctx.used = true;
}

/** Record parameters must keep their static value until extraction. */
function checkPatternInputs(argumentPath, ctx) {
  const checked = new Set();
  const active = new Set();
  const isRecordBinding = (binding, seen = new Set()) => {
    if (
      binding == null ||
      seen.has(binding) ||
      !binding.path?.isVariableDeclarator()
    )
      return false;
    seen.add(binding);
    let init = binding.path.get('init');
    while (
      init?.isTSAsExpression() ||
      init?.isTSSatisfiesExpression?.() ||
      init?.isParenthesizedExpression()
    )
      init = init.get('expression');
    if (init?.isIdentifier())
      return isRecordBinding(init.scope.getBinding(init.node.name), seen);
    return init?.isObjectExpression() || init?.isArrayExpression();
  };
  let valid = true;
  const rejectInput = (path, reason) => {
    valid = false;
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      `Pattern parameters must be static constants (${reason}). Use an immutable literal or local constant.`,
      path,
      'patterns.static-input',
    );
  };
  const inspectBinding = (binding) => {
    if (binding == null || !binding.path?.isVariableDeclarator()) return;
    if (active.has(binding)) {
      rejectInput(binding.path, 'cyclic constant dependency');
      return;
    }
    if (checked.has(binding)) return;
    active.add(binding);
    const init = binding.path.get('init');
    inspectExpression(init);
    active.delete(binding);
    checked.add(binding);
    for (const ref of binding.referencePaths) {
      let target = ref;
      while (
        (target.parentPath?.isMemberExpression() ||
          target.parentPath?.isOptionalMemberExpression?.()) &&
        target.parentPath.get('object').node === target.node
      ) {
        target = target.parentPath;
      }
      const parent = target.parentPath;
      if (
        (parent?.isAssignmentExpression() &&
          parent.get('left').node === target.node) ||
        parent?.isUpdateExpression() ||
        parent?.isUnaryExpression({ operator: 'delete' })
      ) {
        rejectInput(target, `"${binding.identifier.name}" is mutated`);
      } else if (
        parent?.isCallExpression() &&
        (parent.get('arguments').some((arg) => arg.node === target.node) ||
          parent.get('callee').node === target.node) &&
        resolvePmsAccess(parent.get('callee'), ctx) == null
      ) {
        // Unknown calls may mutate a record, including nested responsive maps.
        // Primitive constant arguments do not share mutable state.
        if (isRecordBinding(binding) || target !== ref) {
          rejectInput(
            target,
            `"${binding.identifier.name}" escapes to an unrecognized function`,
          );
        }
      } else if (
        parent?.isVariableDeclarator() &&
        parent.get('init').node === target.node
      ) {
        inspectBinding(parent.scope.getBinding(parent.node.id.name));
      } else if (
        parent?.isAssignmentExpression() &&
        parent.get('right').node === target.node &&
        isRecordBinding(binding)
      ) {
        rejectInput(
          target,
          `"${binding.identifier.name}" escapes through an assignment`,
        );
      }
    }
  };
  const inspectExpression = (expression) => {
    if (expression?.isIdentifier())
      inspectBinding(expression.scope.getBinding(expression.node.name));
    expression?.traverse({
      ReferencedIdentifier(path) {
        inspectBinding(path.scope.getBinding(path.node.name));
      },
    });
  };
  inspectExpression(argumentPath);
  return valid;
}

/** Patterns become the same StyleRef ABI as a compiled create() namespace. */
function transformPatternCall(callPath, ctx, ds) {
  const access = resolveDesignAccess(callPath.get('callee'), ctx, 'patterns');
  const patternId =
    access?.length === 2 ? access[1] : (access?.slice(1).join('.') ?? '?');
  const args = callPath.get('arguments');
  if (args.length > 1 || args[0]?.isSpreadElement()) {
    reject(
      ctx,
      Codes.INVALID_PATTERN_PARAMETER,
      `patterns.${patternId}() expects at most one static parameter object.`,
      callPath,
      'patterns.constrained-domain',
      { patternId },
    );
    return;
  }
  if (args.length !== 0 && !checkPatternInputs(args[0], ctx)) return;
  const parameters = args.length === 0 ? {} : evaluateValue(args[0], ctx);
  if (parameters === FAIL) return;
  addSemanticUnit(ctx, `pattern:${patternId}`);
  addSemanticUnit(ctx, 'runtime-identity');
  addSemanticUnit(ctx, 'conditions');
  // Locate parameter/token failures at their authored value, including conditions.
  const locateParameter = (parameter, condition) => {
    let valuePath = args[0];
    for (const key of [parameter, condition]) {
      if (key == null || !valuePath?.isObjectExpression()) continue;
      const property = valuePath
        .get('properties')
        .find(
          (p) =>
            p.isObjectProperty() &&
            (p.node.key.name ?? p.node.key.value) === key,
        );
      if (property != null) valuePath = property.get('value');
    }
    return fullLoc(ctx, valuePath ?? callPath);
  };
  try {
    const ir = createPatternIR(patternId, parameters, {
      registry: ds.registry,
      refKind: 'compiler',
      source: fullLoc(ctx, callPath),
      locate: locateParameter,
    });
    const parameterFor = {
      alignItems: 'align',
      justifyContent: 'justify',
      gridTemplateColumns: 'columns',
    };
    const result = compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: { pattern: ir.declarations },
      role: 'consumer',
      allowPrivateTokens: false,
      refKind: 'compiler',
      source: ctx.filename,
      locate: (_namespace, property, condition) =>
        locateParameter(parameterFor[property] ?? property, condition),
      options: ctx.options.engineOptions ?? {},
    });
    registerRules(ctx.pluginPass, result.injected, callPath);
    callPath.replaceWith(
      literalOf(toRuntimeRefs(result.compiled.pattern, ds.registry.systemId)),
    );
    ctx.used = true;
  } catch (err) {
    if (Array.isArray(err?.diagnostics)) {
      ctx.diags.push(...err.diagnostics);
      return;
    }
    throw err;
  }
}

/**
 * `recipes.button({...})`:
 *  - literal selection -> validated at build, precompiled refs emitted;
 *  - props-dependent selection -> the bounded runtime guard.
 */
function transformRecipeCall(callPath, ctx, ds) {
  const access = resolveDesignAccess(callPath.get('callee'), ctx, 'recipes');
  const recipeId = access != null && access.length === 2 ? access[1] : null;
  const recipeDefinition =
    recipeId == null ? null : ds.registry.recipes[recipeId];
  const recipe =
    recipeDefinition?.visibility === 'public' ? ds.recipes[recipeId] : null;

  if (recipe == null) {
    reject(
      ctx,
      Codes.UNSUPPORTED_FEATURE,
      `Unknown recipe: ${recipeId ?? access?.slice(1).join('.') ?? '?'}.`,
      callPath,
      'registry.recipes',
      { recipeId, admitted: ds.snapshot.vocabulary.publicRecipeIds },
    );
    return;
  }

  addSemanticUnit(ctx, `recipe:${recipeId}`);
  addSemanticUnit(ctx, 'runtime-identity');

  const args = callPath.get('arguments');
  if (args.length > 1) {
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      'A recipe selector takes at most one selection object.',
      callPath,
      'static-resolution',
      { recipeId },
    );
    return;
  }

  // No argument, or a selection we cannot fold: the bounded runtime guard.
  if (args.length === 0) {
    ctx.used = true;
    return;
  }
  const staticSelection = tryStaticSelection(args[0], ctx);
  if (staticSelection === null) {
    ctx.used = true;
    return;
  }

  let selected;
  try {
    selected = perfPhase('recipe_ms', () =>
      defineRecipeSelector(toRecipeSpec(recipe, ds.registry.systemId))(
        staticSelection,
      ),
    );
  } catch (err) {
    if (err != null && Array.isArray(err.diagnostics)) {
      for (const d of err.diagnostics) {
        ctx.diags.push({
          ...d,
          phase: 'build-selection',
          location: fullLoc(ctx, args[0]),
        });
      }
      return;
    }
    if (err != null && typeof err.code === 'string') {
      ctx.diags.push(
        diagnostic({
          code: err.code,
          phase: 'build-selection',
          message: err.message,
          source: fullLoc(ctx, args[0]),
          rule: err.rule ?? 'recipe.bounded-domain',
          context: err.context ?? {},
        }),
      );
      return;
    }
    throw err;
  }
  callPath.replaceWith(literalOf(selected));
  ctx.used = true;
}

/** Returns the selection object when statically resolvable, else null. */
function tryStaticSelection(argPath, ctx) {
  if (argPath == null || argPath.node == null) return null;
  if (argPath.isIdentifier()) {
    // A selection coming from props is not resolvable here.
    const binding = argPath.scope?.getBinding(argPath.node.name);
    if (binding == null) return null;
    const bp = binding.path;
    if (
      bp != null &&
      bp.isVariableDeclarator() &&
      bp.node.id.type === 'Identifier' &&
      binding.constantViolations.length === 0
    ) {
      return tryStaticSelection(bp.get('init'), ctx);
    }
    return null;
  }
  if (argPath.isTSAsExpression() || argPath.isTSSatisfiesExpression?.()) {
    return tryStaticSelection(argPath.get('expression'), ctx);
  }
  if (!argPath.isObjectExpression()) return null;
  const out = {};
  for (const prop of argPath.get('properties')) {
    if (!prop.isObjectProperty()) return null;
    const keyNode = prop.node.key;
    const name =
      keyNode.type === 'Identifier'
        ? keyNode.name
        : String(keyNode.value ?? '');
    if (name === '') return null;
    const valuePath = prop.get('value');
    if (valuePath.isIdentifier()) return null; // depends on props
    const v = evaluateValue(valuePath, ctx, null);
    if (v === FAIL) return null;
    out[name] = v;
  }
  return out;
}

/** `themes.light` -> compiled theme object (shared varGroup class). */
function transformThemeAccess(memberPath, ctx, ds) {
  const access = resolveDesignAccess(memberPath, ctx, 'themes');
  if (access == null || access.length !== 2) return false;
  const themeName = access[1];
  const theme = ds.themes[themeName];
  if (theme == null) {
    reject(
      ctx,
      Codes.UNKNOWN_CONDITION,
      `Unknown theme: ${themeName}.`,
      memberPath,
      'registry.themes',
      { themeName, admitted: Object.keys(ds.themes) },
    );
    return true;
  }
  addSemanticUnit(ctx, `theme:${themeName}`);
  addSemanticUnit(ctx, 'runtime-identity');
  memberPath.replaceWith(
    literalOf(toThemeRef(themeName, theme, ds.registry.systemId, ds.themes)),
  );
  ctx.used = true;
  return true;
}

/**
 * `props(...)` becomes the call to core's composition runtime.
 *
 * The rewrite happens ONLY for an argument whose provenance was already proven
 * (pandamstyle/provenance.js, run as a pre-pass in the plugin). The re-check
 * here is deliberate: the compiler must reject unproven values even though
 * core independently validates the runtime ref shape.
 */
function transformPropsCall(callPath, ctx, programPath) {
  const args = callPath.get('arguments');
  for (const arg of args) {
    if (arg == null || arg.node == null) continue;
    if (arg.isSpreadElement?.()) continue;
    const prov = provenanceOf(arg, ctx);
    if (isAdmitted(prov.kind)) continue;
    reject(
      ctx,
      Codes.UNVERIFIED_PROPS_SOURCE,
      'props() argument has no demonstrated PandamStyle provenance ' +
        `(${prov.reason ?? 'unknown origin'}); it was not rewritten to the ` +
        'composition runtime.',
      arg,
      'provenance.props-argument',
      { kind: prov.kind },
    );
    return;
  }

  const local = addNamedImport(
    programPath,
    '@pandamstyle/core',
    'props',
    CORE_PROPS_LOCAL,
  );
  callPath.node.callee = t.identifier(local);
  ctx.used = true;
}

/**
 * Lowers a `token(...)` call that survived the first pass (a reference hoisted
 * into a module-level constant).
 *
 * It becomes the compiled variable reference, exactly like the lowering applied
 * inside `create()`. No `token()` call is ever left for the runtime, so the
 * generated module's throwing `token()` can never be reached.
 */
function lowerHoistedTokenCall(callPath, ctx, ds) {
  const args = callPath.get('arguments');
  if (args.length !== 1) {
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      'token() takes exactly one argument.',
      callPath,
      'token.usage',
    );
    return;
  }
  const evaluated = evaluateValue(args[0], ctx, null);
  if (evaluated === FAIL) return;
  if (typeof evaluated !== 'string') {
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      'token() expects a static token path.',
      callPath,
      'token.usage',
    );
    return;
  }
  const tokenId = evaluated;
  addSemanticUnit(ctx, `token:${tokenId}`);
  addSemanticUnit(ctx, 'runtime-identity');
  const varRef = ds.varsByToken[tokenId];
  if (varRef == null) {
    ctx.diags.push(
      diagnostic({
        code: Codes.UNKNOWN_TOKEN,
        phase: 'transform',
        message: `Unknown token: ${tokenId}.`,
        source: fullLoc(ctx, callPath),
        rule: 'registry.tokens',
        context: { tokenId, systemId: ds.registry.systemId },
      }),
    );
    return;
  }
  callPath.replaceWith(t.stringLiteral(varRef));
  ctx.used = true;
}

export function transformUsage({ path, ctx, ds, programPath }) {
  if (
    (path.isMemberExpression() || path.isOptionalMemberExpression?.()) &&
    transformThemeAccess(path, ctx, ds)
  ) {
    return;
  }
  if (!path.isCallExpression()) return;

  if (isCreateCall(path, ctx)) {
    transformCreateCall(path, ctx, ds);
    return;
  }
  if (resolveDesignAccess(path.get('callee'), ctx, 'patterns') != null) {
    transformPatternCall(path, ctx, ds);
    return;
  }
  const callee = path.get('callee');
  if (
    (callee.isMemberExpression() || callee.isOptionalMemberExpression?.()) &&
    resolveDesignAccess(callee.get('object'), ctx, 'patterns') != null
  ) {
    reject(
      ctx,
      Codes.NON_STATIC_VALUE,
      'A pattern name must be static. Choose stack, inline, center, grid or box.',
      callee,
      'patterns.static-name',
    );
    return;
  }
  if (resolveDesignAccess(path.get('callee'), ctx, 'recipes') != null) {
    transformRecipeCall(path, ctx, ds);
    return;
  }
  if (isPropsCall(path, ctx)) {
    transformPropsCall(path, ctx, programPath);
  }
}

/** Second pass: no `token()` call may survive into the emitted JS. */
export function transformResidualTokens({ path, ctx, ds }) {
  if (ctx.diags.length > 0) return;
  if (isTokenHelperCall(path, ctx)) {
    lowerHoistedTokenCall(path, ctx, ds);
  }
}

export { lineOnly };
