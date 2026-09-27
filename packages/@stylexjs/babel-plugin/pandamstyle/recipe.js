/**
 * PandamStyle — recipes compilées (ARC-10/ARC-11, D-06).
 * Sélection/défauts portés de @pandacss cva
 * (chakra-ui/panda @ 1a310482, packages/generator/src/artifacts/js/cva.ts)
 * avec restrictions P0 : pas de compoundVariants, pas de .raw/.merge,
 * branches précompilées et sélecteur runtime borné.
 */

import { diagnostic, PmsError, Codes } from './diagnostics';

function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj ?? {})) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

export function defineRecipe(config, compileStyleObject) {
  const { base = {}, variants = {}, defaultVariants = {} } = config;
  const recipeId = config.recipeId ?? 'anonymous';
  const axisOrder = Object.keys(variants); // ordre capturé à la déclaration

  // Compilation de chaque branche : base + une entrée par (axe, valeur).
  // Somme des branches, pas produit cartésien (ARC-11).
  const compiledBase = compileStyleObject(base, `${recipeId}.base`);
  const compiledBranches = {};
  for (const axis of axisOrder) {
    compiledBranches[axis] = {};
    for (const value of Object.keys(variants[axis])) {
      compiledBranches[axis][value] = compileStyleObject(
        variants[axis][value],
        `${recipeId}.${axis}.${value}`,
      );
    }
  }

  const variantMap = Object.fromEntries(
    axisOrder.map((axis) => [axis, Object.keys(variants[axis])]),
  );
  const variantKeys = axisOrder;

  const domainError = (code, message, context) =>
    new PmsError([
      diagnostic({
        code,
        severity: 'error',
        phase: 'runtime-selection',
        message,
        rule: 'recipe.bounded-domain',
        context: { recipeId, ...context },
      }),
    ]);

  function resolve(props = {}) {
    // Clés inconnues : erreur, jamais sélection implicite (D-06).
    for (const key of Object.keys(props)) {
      if (!axisOrder.includes(key)) {
        throw domainError(
          Codes.INVALID_VARIANT_KEY,
          `Axe de variant inconnu « ${key} » pour ${recipeId}.`,
          { axis: key, admitted: variantKeys },
        );
      }
    }
    const refs = [compiledBase];
    for (const axis of axisOrder) {
      let value = props[axis];
      if (value === undefined) {
        value = defaultVariants[axis];
        if (value === undefined) continue; // pas de défaut : aucune branche
      }
      if (value === null) {
        throw domainError(
          Codes.INVALID_VARIANT_VALUE,
          `null n'est pas une sélection valide pour ${recipeId}.${axis}.`,
          { axis, value, admitted: variantMap[axis] },
        );
      }
      const key = String(value);
      const branch = compiledBranches[axis][key];
      if (branch == null) {
        throw domainError(
          Codes.INVALID_VARIANT_VALUE,
          `Valeur « ${key} » hors domaine pour ${recipeId}.${axis}.`,
          { axis, value: key, admitted: variantMap[axis] },
        );
      }
      refs.push(branch);
    }
    return refs;
  }

  function cvaFn(props) {
    // StyleRef opaque : liste ordonnée de refs compilées ; seul le runtime
    // du fork (props) les compose. Aucune chaîne CSS ni fusion brute.
    return Object.freeze({ __pmsStyleRef: true, refs: resolve(props) });
  }

  function splitVariantProps(props) {
    const picked = {};
    const rest = {};
    for (const k of Object.keys(props ?? {})) {
      if (axisOrder.includes(k)) picked[k] = props[k];
      else rest[k] = props[k];
    }
    return [picked, rest];
  }

  const getVariantProps = (variants) => ({
    ...defaultVariants,
    ...compact(variants),
  });

  return Object.assign(cvaFn, {
    __pmsRecipe: true,
    recipeId,
    variantMap,
    variantKeys,
    axisOrder,
    splitVariantProps,
    getVariantProps,
    // ARC-11 : pas de .raw (CSS brut), pas de .merge (fusion libre).
  });
}

export function isStyleRef(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.__pmsStyleRef === true
  );
}
