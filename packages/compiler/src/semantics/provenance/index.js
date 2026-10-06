/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - provenance of a value offered to a style channel (ARC-05, P0).
 *
 * WHY THIS FILE EXISTS
 *
 * A recognized `props(...)` call was, until now, treated as a valid channel and
 * rewritten to the fork's composition runtime. The fork runtime accepts
 * UNCOMPILED objects and produces inline styles, so this alone was a hole:
 *
 *     <div {...props({ padding: '17px' })} />
 *
 * would have been accepted, and an arbitrary object becomes safe merely by
 * being handed to a function that happens to be called `props`.
 *
 * A value is admitted only if its provenance belongs to a FINITE domain that
 * this compiler produced. The domain is not a boolean (`derived = 'props'`); it
 * is a discriminated representation, so a diagnostic can say WHAT was trusted
 * and the check can recurse through arrays, logicals and ternaries.
 *
 *   CompiledStyleRef      a namespace of a `create()` result
 *   ThemeRef              `themes.<name>` of the generated module
 *   RecipeSelectionRef    a `recipes.<name>(...)` selector call
 *   ConditionalComposition  a composition of the above, guarded by a condition
 *   Unknown / Raw         anything else, including every object literal
 *
 * PROVENANCE IS ATTACHED TO A BINDING, NEVER TO A NAME
 *
 * A JavaScript identifier is not an identity: `props` can be shadowed, and a
 * `let` can be reassigned. Every recorded fact therefore hangs off the real
 * Babel `Binding`, and a lookup re-resolves the binding through
 * `path.scope.getBinding(name)` so an inner declaration can never inherit an
 * outer one. A reassigned binding has `constantViolations`, and an admitted
 * value that can still be mutated has an escape; both lose their provenance.
 */

import { Codes, diagnostic } from '../../protocol/diagnostics';
import {
  isCreateCall,
  isTokenHelperCall,
  resolveDesignAccess,
  resolvePmsAccess,
} from '../../frontend/babel/evaluate';

export const Provenance = {
  /** A namespace of a `create()` result: `styles.page`, `styles.page.className`. */
  COMPILED_STYLE: 'CompiledStyleRef',
  /** A theme object of the generated module: `themes.light`. */
  THEME: 'ThemeRef',
  /** A recipe selector result: `recipes.button({ variant: 'primary' })`. */
  RECIPE_SELECTION: 'RecipeSelectionRef',
  RECIPE_SLOTS: 'RecipeSlotsContainer',
  /** A StyleX-compatible composition of admitted values. */
  CONDITIONAL: 'ConditionalComposition',
  /**
   * A `create()` result seen as a whole. NOT admissible as a props() argument -
   * it is a bag of namespaces, and spreading it would spread unknown keys - but
   * its members ARE `CompiledStyleRef`. Structural, not a value provenance.
   */
  CREATE_CONTAINER: 'CreateContainer',
  /**
   * A local constant whose value is a `props(...)` result. Tracked so it cannot
   * be mutated or escaped into, but not admitted as a props() ARGUMENT: the
   * composition runtime consumes a props() result, it does not re-wrap one.
   */
  PROPS_RESULT: 'PropsResult',
  /** No demonstrated provenance. */
  UNKNOWN: 'Unknown',
};

/** Provenance kinds accepted as a `props()` argument. */
const ADMITTED = new Set([
  Provenance.COMPILED_STYLE,
  Provenance.THEME,
  Provenance.RECIPE_SELECTION,
  Provenance.CONDITIONAL,
]);

export function isAdmitted(kind) {
  return ADMITTED.has(kind);
}

const UNKNOWN = (reason) => ({ kind: Provenance.UNKNOWN, reason });
const admitted = (kind, detail = {}) => ({ kind, reason: null, ...detail });

/** Strips TS/paren wrappers: they change the syntax, not the value. */
function unwrap(nodePath) {
  let cur = nodePath;
  for (;;) {
    if (cur == null || cur.node == null) return null;
    if (
      cur.isTSAsExpression?.() ||
      cur.isTSSatisfiesExpression?.() ||
      cur.isTSNonNullExpression?.() ||
      cur.isTypeCastExpression?.() ||
      cur.isTSInstantiationExpression?.() ||
      cur.isParenthesizedExpression?.()
    ) {
      cur = cur.get('expression');
      continue;
    }
    return cur;
  }
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
 * The binding a reference really points at.
 *
 * This is the whole point of the module: the result of
 * `path.scope.getBinding(name)` distinguishes a module-level import from a
 * shadowing parameter of the same name, which a name-keyed map cannot do.
 */
function bindingOfReference(nodePath) {
  if (!nodePath.isIdentifier()) return null;
  return nodePath.scope?.getBinding(nodePath.node.name) ?? null;
}

function locationOf(nodePath, ctx) {
  const loc = nodePath?.node?.loc;
  return {
    file: ctx.filename,
    line: loc?.start.line ?? null,
    column: loc != null ? loc.start.column + 1 : null,
    role: ctx.role,
  };
}

/**
 * Resolves the provenance of `nodePath`, memoizing the result on the BINDING of
 * any local constant it walks through.
 */
export function provenanceOf(nodePath, ctx, seen = new Set()) {
  const cur = unwrap(nodePath);
  if (cur == null || cur.node == null) return UNKNOWN('missing expression');

  // The frozen props ABI treats null and false as conditional omissions. A
  // true value, raw object, or other literal remains outside the finite
  // composition domain.
  if (cur.isNullLiteral?.() || cur.isBooleanLiteral?.({ value: false })) {
    return admitted(Provenance.CONDITIONAL, {
      operator: 'omission',
      parts: [],
    });
  }

  if (cur.isIdentifier()) {
    const binding = bindingOfReference(cur);
    if (binding == null) {
      return UNKNOWN(`"${cur.node.name}" has no resolvable binding`);
    }
    // A shadowing declaration produces a different Binding, so it simply is not
    // in the map: the outer provenance is not inherited.
    const memo = ctx.provenance.get(binding);
    if (memo != null) return memo;
    if (seen.has(binding)) {
      return UNKNOWN(`"${cur.node.name}" is defined in terms of itself`);
    }
    // A `let` that is reassigned later is not a constant: its value is whatever
    // the last assignment made, and no provenance survives that.
    if (binding.constantViolations.length > 0) {
      const result = UNKNOWN(`"${cur.node.name}" is reassigned`);
      ctx.provenance.set(binding, result);
      return result;
    }
    const bindingPath = binding.path;
    if (
      bindingPath == null ||
      !bindingPath.isVariableDeclarator() ||
      bindingPath.node.id.type !== 'Identifier'
    ) {
      const result = UNKNOWN(`"${cur.node.name}" is not a local constant`);
      ctx.provenance.set(binding, result);
      return result;
    }
    const init = bindingPath.get('init');
    if (init == null || init.node == null) {
      const result = UNKNOWN(`"${cur.node.name}" is not initialized`);
      ctx.provenance.set(binding, result);
      return result;
    }
    seen.add(binding);
    const result = provenanceOf(init, ctx, seen);
    seen.delete(binding);
    ctx.provenance.set(binding, result);
    return result;
  }

  if (cur.isCallExpression()) {
    const patternAccess = resolveDesignAccess(
      cur.get('callee'),
      ctx,
      'patterns',
    );
    if (patternAccess != null) {
      return admitted(Provenance.COMPILED_STYLE, {
        pattern: patternAccess.slice(1).join('.'),
      });
    }
    // `recipes.button({...})` - a finite selection over precompiled branches.
    const access = resolveDesignAccess(cur.get('callee'), ctx, 'recipes');
    if (access != null) {
      const recipeId =
        access.length === 2 ? access[1] : access.slice(1).join('.');
      const slots =
        ctx.options?.designSystem?.registry.recipes[recipeId]?.slots;
      if (slots !== undefined)
        return admitted(Provenance.RECIPE_SLOTS, { recipe: recipeId, slots });
      return admitted(Provenance.RECIPE_SELECTION, {
        recipe: recipeId,
      });
    }
    // A bare `token(...)` is a value, not a style: it cannot feed composition.
    if (isTokenHelperCall(cur, ctx)) {
      return UNKNOWN('a token reference is not a composable style');
    }
    // A bare `create()` result is a CONTAINER of namespaces, not a style. Only
    // one of its namespaces is a CompiledStyleRef, so the container is refused
    // as an argument while its members stay admitted.
    if (isCreateCall(cur, ctx)) {
      return admitted(Provenance.CREATE_CONTAINER);
    }
    return UNKNOWN(
      'the call result has no demonstrated PandamStyle provenance',
    );
  }

  if (cur.isMemberExpression() || cur.isOptionalMemberExpression?.()) {
    const prop = staticPropertyName(cur);
    const base = provenanceOf(cur.get('object'), ctx, seen);
    if (base.kind === Provenance.RECIPE_SLOTS) {
      if (prop === null)
        return {
          ...UNKNOWN('recipe slots require a static named access'),
          code: Codes.NON_STATIC_VALUE,
          context: { recipeId: base.recipe, admitted: base.slots },
        };
      if (!base.slots.includes(prop))
        return {
          ...UNKNOWN(`unknown recipe slot "${prop}"`),
          code: Codes.INVALID_RECIPE_SLOT,
          context: { recipeId: base.recipe, slot: prop, admitted: base.slots },
        };
      return admitted(Provenance.RECIPE_SELECTION, {
        recipe: base.recipe,
        slot: prop,
      });
    }
    if (prop == null) return UNKNOWN('the member key is not resolvable');

    // `themes.light` - a theme object of the generated module.
    const themeAccess = resolveDesignAccess(cur, ctx, 'themes');
    if (themeAccess != null) {
      if (themeAccess.length !== 2) {
        return UNKNOWN(
          'a theme must be selected by name, not as the whole theme table',
        );
      }
      return admitted(Provenance.THEME, { theme: themeAccess[1] });
    }

    // `styles.page` / `styles.page.className` - a namespace of a create() result.
    if (base.kind === Provenance.COMPILED_STYLE) {
      return admitted(Provenance.COMPILED_STYLE, { member: prop });
    }
    if (base.kind === Provenance.CREATE_CONTAINER) {
      // One namespace of the create() result. The compiled result is an object
      // of those namespaces, so this is exactly `styles.<namespace>`.
      return admitted(Provenance.COMPILED_STYLE, { namespace: prop });
    }
    if (base.kind === Provenance.THEME) {
      return UNKNOWN('a theme object has no style member to compose');
    }
    if (base.kind === Provenance.RECIPE_SELECTION) {
      return UNKNOWN('a recipe selection result has no style member');
    }
    if (base.kind === Provenance.CONDITIONAL) {
      return UNKNOWN(
        'a conditional composition has no statically resolvable style member',
      );
    }
    return UNKNOWN(`the base of ".${prop}" has no demonstrated provenance`);
  }

  if (cur.isLogicalExpression()) {
    // `active && styles.active` - the fork runtime composes a falsy left side by
    // simply not applying the right side. The right side is what must be proven.
    const value = provenanceOf(cur.get('right'), ctx, seen);
    if (!isAdmitted(value.kind)) return value;
    return admitted(Provenance.CONDITIONAL, {
      operator: cur.node.operator,
      parts: [value],
    });
  }

  if (cur.isConditionalExpression()) {
    const consequent = provenanceOf(cur.get('consequent'), ctx, seen);
    const alternate = provenanceOf(cur.get('alternate'), ctx, seen);
    if (!isAdmitted(consequent.kind)) return consequent;
    // `cond ? styles.a : null` is the idiomatic StyleX form.
    if (
      alternate.kind === Provenance.UNKNOWN &&
      (isEmptyLiteral(cur.get('alternate')) ||
        cur.get('alternate').isBooleanLiteral?.())
    ) {
      return admitted(Provenance.CONDITIONAL, {
        operator: '?:',
        parts: [consequent],
      });
    }
    if (!isAdmitted(alternate.kind)) return alternate;
    return admitted(Provenance.CONDITIONAL, {
      operator: '?:',
      parts: [consequent, alternate],
    });
  }

  if (cur.isArrayExpression()) {
    const parts = [];
    for (const element of cur.get('elements')) {
      if (element == null || element.node == null) continue; // a hole
      const item = provenanceOf(element, ctx, seen);
      if (item.kind === Provenance.UNKNOWN && isEmptyLiteral(element)) continue;
      if (!isAdmitted(item.kind)) return item;
      parts.push(item);
    }
    return admitted(Provenance.CONDITIONAL, { operator: 'array', parts });
  }

  if (cur.isObjectExpression()) {
    // The hole this file closes. An object literal carries no provenance: it is
    // the exact shape the fork runtime would happily turn into inline CSS.
    return UNKNOWN(
      'an object literal has no PandamStyle provenance; compose compiled ' +
        'styles, themes or recipe selections instead',
    );
  }

  return UNKNOWN(
    `a ${cur.node.type} has no demonstrated PandamStyle provenance`,
  );
}

function isEmptyLiteral(nodePath) {
  return (
    nodePath != null &&
    (nodePath.isNullLiteral?.() || nodePath.isBooleanLiteral?.())
  );
}

/**
 * Refuses a value whose provenance could be destroyed after the fact.
 *
 * An admitted value is only useful because it cannot change between the check
 * and the render. Two ways to break that are refused:
 *
 *  - a WRITE to the value or to one of its members
 *    (`attrs.style = {...}`, `Object.assign(styles, {...})`, `delete s.x`, `s++`);
 *  - an ESCAPE into a call this compiler does not recognize
 *    (`mutateLater(styles)`), because that call can mutate anything it is given.
 *
 * Reassignment is handled upstream, by the `constantViolations` check in
 * `provenanceOf`, so that a name-keyed map can never be the reason a value is
 * admitted.
 */
export function analyzeProvenanceEscapes(programPath, ctx) {
  for (const [binding, prov] of [...ctx.provenance.entries()]) {
    if (prov.kind === Provenance.UNKNOWN) continue;
    const name = binding.identifier?.name ?? '<binding>';

    for (const ref of binding.referencePaths) {
      // `s = ...` is a constant violation, already refused before it got here.
      // `s.x = ...` and `s.x.y = ...` are not, so walk the member chain up to
      // whatever actually receives the value.
      const target = memberChainRoot(ref);
      const parentPath = target.parentPath;
      if (parentPath == null) continue;

      if (parentPath.isAssignmentExpression()) {
        const left = parentPath.get('left');
        if (left.node === target.node) {
          ctx.diags.push(
            escapeDiag(
              ctx,
              target,
              'member-write',
              `"${name}" is written to after it was proven; a style value that ` +
                'can still change cannot carry provenance',
            ),
          );
        }
        continue;
      }

      if (parentPath.isUpdateExpression?.()) {
        ctx.diags.push(
          escapeDiag(
            ctx,
            target,
            'update',
            `"${name}" is updated, so its value is not the proven one`,
          ),
        );
        continue;
      }

      if (
        parentPath.isUnaryExpression?.() &&
        parentPath.node.operator === 'delete'
      ) {
        ctx.diags.push(
          escapeDiag(
            ctx,
            target,
            'delete',
            `"${name}" has a member deleted from it, which can remove a style`,
          ),
        );
        continue;
      }

      if (parentPath.isCallExpression?.()) {
        // The value itself is the argument, or the root of a member chain that
        // is: `Object.assign(attrs.style, ...)` is as much a write as
        // `Object.assign(attrs, ...)`.
        if (!isArgumentOf(parentPath, target)) continue;
        if (isRecognizedHelperCall(parentPath, ctx)) continue;
        if (isReflectiveMutation(parentPath)) {
          ctx.diags.push(
            escapeDiag(
              ctx,
              target,
              'reflective-write',
              `"${name}" is handed to ${describeCallee(parentPath)}, which can ` +
                'replace the proven value with an arbitrary object',
            ),
          );
        } else {
          ctx.diags.push(
            escapeDiag(
              ctx,
              target,
              'unknown-escape',
              `"${name}" is passed to an unrecognized function, which may ` +
                'mutate it; composition must stay inside the recognized helpers',
            ),
          );
        }
      }
    }
  }
}

/**
 * The outermost node of a `a.b.c` chain rooted at `ref`.
 * Returns `ref` itself when it is not the object of a member expression.
 */
function memberChainRoot(ref) {
  let cur = ref;
  for (;;) {
    const parentPath = cur.parentPath;
    if (parentPath == null) return cur;
    const isMember =
      parentPath.isMemberExpression?.() ||
      parentPath.isOptionalMemberExpression?.();
    if (!isMember) return cur;
    const objectPath = parentPath.get('object');
    if (objectPath == null || objectPath.node !== cur.node) return cur;
    cur = parentPath;
  }
}

function isArgumentOf(callPath, ref) {
  for (const arg of callPath.get('arguments')) {
    if (arg.node === ref.node) return true;
  }
  return false;
}

function isRecognizedHelperCall(callPath, ctx) {
  return resolvePmsAccess(callPath.get('callee'), ctx) != null;
}

const REFLECTIVE = new Set([
  'assign',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
]);

function isReflectiveMutation(callPath) {
  const callee = callPath.get('callee');
  if (!callee.isMemberExpression?.()) return false;
  const object = callee.get('object');
  if (!object.isIdentifier?.() || object.node.name !== 'Object') return false;
  const prop = staticPropertyName(callee);
  return prop != null && REFLECTIVE.has(prop);
}

function describeCallee(callPath) {
  const callee = callPath.get('callee');
  if (callee.isIdentifier?.()) return `${callee.node.name}()`;
  const prop = staticPropertyName(callee);
  return prop != null ? `Object.${prop}()` : 'a function';
}

function escapeDiag(ctx, nodePath, mode, message) {
  return diagnostic({
    code: Codes.UNVERIFIED_PROVENANCE,
    phase: 'provenance',
    message,
    source: locationOf(nodePath, ctx),
    rule: 'provenance.binding',
    context: { mode },
  });
}

/**
 * Checks every recognized `props(...)` call BEFORE the rewrite to the fork
 * runtime, and reports the arguments that have no demonstrated provenance.
 *
 * The traversal does not stop at the first failure: one build must list every
 * offending argument, otherwise "each route is refused" could not be proven
 * from a single process.
 */
export function checkPropsProvenance(programPath, ctx, candidates = null) {
  const checkMember = (memberPath) => {
    const prov = provenanceOf(memberPath, ctx);
    if (prov.code === undefined) return;
    ctx.diags.push(
      diagnostic({
        code: prov.code,
        phase: 'provenance',
        message: prov.reason,
        source: locationOf(memberPath, ctx),
        rule: 'recipe.slots',
        context: prov.context,
      }),
    );
  };
  const checkCall = (callPath) => {
    if (!isRecognizedPropsCall(callPath, ctx)) return;
    const args = callPath.get('arguments');
    // Empty composition is a valid no-op and the runtime returns `{}`.
    if (args.length === 0) return;
    for (let i = 0; i < args.length; i++) {
      if (args[i] == null || args[i].node == null) continue;
      if (args[i].isSpreadElement?.()) {
        ctx.diags.push(
          diagnostic({
            code: Codes.UNVERIFIED_PROPS_SOURCE,
            phase: 'provenance',
            message:
              'props() does not accept a spread argument: a spread can carry ' +
              'an arbitrary object whose provenance is not demonstrated.',
            source: locationOf(args[i], ctx),
            rule: 'provenance.props-argument',
            context: { argumentIndex: i, kind: Provenance.UNKNOWN },
          }),
        );
        continue;
      }
      const prov = provenanceOf(args[i], ctx);
      if (isAdmitted(prov.kind)) continue;
      if (prov.code !== undefined) continue; // The member event reports its exact slot error.
      ctx.diags.push(
        diagnostic({
          code: Codes.UNVERIFIED_PROPS_SOURCE,
          phase: 'provenance',
          message:
            `props() argument ${i} has no demonstrated PandamStyle ` +
            `provenance (${prov.reason ?? 'unknown origin'}). The fork ` +
            'runtime accepts uncompiled objects and would emit inline ' +
            'styles, so only compiled styles, themes, recipe selections and ' +
            'proven compositions are admitted.',
          source: locationOf(args[i], ctx),
          rule: 'provenance.props-argument',
          context: { argumentIndex: i, kind: prov.kind, reason: prov.reason },
        }),
      );
    }
  };
  const visitor = {
    'MemberExpression|OptionalMemberExpression': checkMember,
    CallExpression: checkCall,
  };
  if (candidates != null) {
    for (const candidate of candidates) {
      if (candidate.isCallExpression()) checkCall(candidate);
      else checkMember(candidate);
    }
    return;
  }
  programPath.traverse(visitor);
}

function isRecognizedPropsCall(callPath, ctx) {
  const access = resolvePmsAccess(callPath.get('callee'), ctx);
  return (
    access != null &&
    access.exportPath.length === 1 &&
    access.exportPath[0] === 'props'
  );
}
