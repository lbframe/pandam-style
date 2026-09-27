/**
 * PandamStyle — pipeline de compilation (ARC-05).
 * Registre -> validation de politique -> abaissement vers le moteur du fork
 * (styleXDefineVars / styleXCreateTheme / styleXCreateSet de src/shared).
 * Aucune émission CSS parallèle : toutes les règles sortent du moteur.
 */

import styleXCreateSet from '../src/shared/stylex-create';
import styleXDefineVars from '../src/shared/stylex-define-vars';
import styleXCreateTheme from '../src/shared/stylex-create-theme';
import { defaultOptions } from '../src/shared/utils/default-options';

import { diagnostic, PmsError, Codes } from './diagnostics';
import { isTokenRef, tokenRefPath } from './token';
import {
  propertyKind,
  propertyCategory,
  structuralAllowed,
  structuralDomain,
} from './policy';

// Identité de variable stable : systemId + tokenId (D-03). Le hash upstream
// porte sur `${exportId}.${key}` ; indépendant du chemin de checkout.
function varKeyOf(tokenId) {
  return tokenId.replace(/[.\-]/g, '_');
}

/**
 * Compile les tokens du registre en variables CSS + classes de thème.
 * Retourne { varsByToken, themeClasses, injected }.
 */
export function compileTokens(registry, options = {}) {
  const engineOptions = { ...defaultOptions, ...options };
  const baseValues = {};
  for (const tokenId of Object.keys(registry.tokens)) {
    baseValues[varKeyOf(tokenId)] = registry.resolvedValues[tokenId];
  }
  const [varsObj, varsStyles] = styleXDefineVars(baseValues, {
    ...engineOptions,
    exportId: registry.systemId,
  });

  const varsByToken = {};
  for (const tokenId of Object.keys(registry.tokens)) {
    varsByToken[tokenId] = varsObj[varKeyOf(tokenId)];
  }

  const injected = { ...varsStyles };
  const themeClasses = { base: varsObj.__varGroupHash__ };
  for (const themeName of Object.keys(registry.themes)) {
    const overrides = {};
    for (const tokenId of Object.keys(registry.themes[themeName])) {
      overrides[varKeyOf(tokenId)] = registry.themes[themeName][tokenId];
    }
    if (Object.keys(overrides).length === 0) {
      themeClasses[themeName] = varsObj.__varGroupHash__;
      continue;
    }
    const [themeClassObj, themeStyles] = styleXCreateTheme(
      varsObj,
      overrides,
      engineOptions,
    );
    Object.assign(injected, themeStyles);
    themeClasses[themeName] = themeClassObj[varsObj.__varGroupHash__];
  }
  return { varsByToken, themeClasses, varGroupHash: varsObj.__varGroupHash__, injected };
}

const BASE_CONDITION = 'default';

/**
 * Normalise une valeur de déclaration en entrées { condition, tokenRef|literal }.
 * Forme publique orientée propriété ({ base, <cond> }) normalisée en blocs (D-05).
 */
function expandValue(property, value, registry, source, diagnostics) {
  if (
    value !== null &&
    typeof value === 'object' &&
    !isTokenRef(value) &&
    !Array.isArray(value)
  ) {
    const entries = [];
    for (const condName of Object.keys(value)) {
      const cond =
        condName === 'base' || condName === 'default'
          ? BASE_CONDITION
          : condName;
      if (
        cond !== BASE_CONDITION &&
        registry.conditions[cond] == null
      ) {
        diagnostics.push(
          diagnostic({
            code: Codes.UNKNOWN_CONDITION,
            phase: 'policy',
            message: `Condition inconnue « ${cond} » sur ${property}.`,
            source,
            rule: 'conditions.named-only',
            context: { property, condition: condName, admitted: Object.keys(registry.conditions) },
          }),
        );
        continue;
      }
      entries.push([cond === BASE_CONDITION ? null : cond, value[condName]]);
    }
    return entries;
  }
  return [[null, value]];
}

function checkValue({
  property,
  value,
  role,
  allowPrivateTokens,
  registry,
  varsByToken,
  source,
  conditionPath,
  diagnostics,
}) {
  const kind = propertyKind(property);

  if (kind === 'composite-form') {
    diagnostics.push(
      diagnostic({
        code: Codes.UNSUPPORTED_PROPERTY_FORM,
        phase: 'policy',
        message: `La forme composite « ${property} » est refusée en P0 ; utiliser les propriétés longues.`,
        source,
        rule: 'supported-properties.composite-forms',
        context: { property },
      }),
    );
    return null;
  }
  if (kind === 'unsupported') {
    diagnostics.push(
      diagnostic({
        code: Codes.UNSUPPORTED_PROPERTY,
        phase: 'policy',
        message: `Propriété non couverte par le profil : ${property}.`,
        source,
        rule: 'supported-properties',
        context: { property },
      }),
    );
    return null;
  }
  if (kind === 'structural-set' || kind === 'structural-number') {
    if (!structuralAllowed(property, value)) {
      diagnostics.push(
        diagnostic({
          code: Codes.FORBIDDEN_VALUE,
          phase: 'policy',
          message: `Valeur structurelle interdite : ${property} = ${JSON.stringify(value)}.`,
          source,
          rule: 'structural-domain',
          context: {
            property,
            value,
            admitted: structuralDomain(property),
            conditionPath,
          },
        }),
      );
      return null;
    }
    return value;
  }

  // kind === 'category' : TokenRef obligatoire, de la bonne catégorie.
  const category = propertyCategory(property);
  const admitted = Object.keys(registry.tokens).filter(
    (id) =>
      registry.tokens[id].category === category &&
      (allowPrivateTokens || registry.tokens[id].visibility === 'public'),
  );

  if (!isTokenRef(value)) {
    diagnostics.push(
      diagnostic({
        code: Codes.FORBIDDEN_VALUE,
        phase: 'policy',
        message: `Valeur interdite pour ${property} : ${JSON.stringify(value)}. Un token ${category} est requis.`,
        source,
        rule: 'category-strict',
        context: { property, category, value, candidates: admitted, conditionPath },
      }),
    );
    return null;
  }

  const tokenId = tokenRefPath(value);
  const entry = registry.tokens[tokenId];
  if (entry == null) {
    diagnostics.push(
      diagnostic({
        code: Codes.UNKNOWN_TOKEN,
        phase: 'policy',
        message: `Token inconnu : ${tokenId}.`,
        source,
        rule: 'registry.tokens',
        context: { property, tokenId, candidates: admitted, conditionPath },
      }),
    );
    return null;
  }
  if (entry.category !== category) {
    diagnostics.push(
      diagnostic({
        code: Codes.INVALID_TOKEN_CATEGORY,
        phase: 'policy',
        message: `${property} exige un token ${category} ; ${tokenId} est ${entry.category}.`,
        source,
        rule: 'category-strict',
        context: { property, expected: category, actual: entry.category, tokenId, conditionPath },
      }),
    );
    return null;
  }
  if (role === 'consumer' && entry.visibility !== 'public') {
    diagnostics.push(
      diagnostic({
        code: Codes.TOKEN_NOT_PUBLIC,
        phase: 'policy',
        message: `Le token ${tokenId} n'est pas sélectionnable côté consommateur.`,
        source,
        rule: 'visibility.consumer',
        context: { property, tokenId, candidates: admitted, conditionPath },
      }),
    );
    return null;
  }
  return varsByToken[tokenId];
}

/**
 * Compile des namespaces de déclarations PandamStyle.
 * signature : compileStyles({ registry, varsByToken, namespaces, role, source, options })
 * Retourne { compiled, injected, classPaths } ou lève PmsError.
 */
export function compileStyles({
  registry,
  varsByToken,
  namespaces,
  role = 'consumer',
  allowPrivateTokens = false,
  source = null,
  options = {},
}) {
  const diagnostics = [];
  const normalized = {};

  for (const nsName of Object.keys(namespaces)) {
    const ns = namespaces[nsName];
    const outNs = {};
    for (const key of Object.keys(ns)) {
      const value = ns[key];
      // Syntaxe auteur `_hover` (portée de Panda) : condition nommée résolue
      // vers sa définition canonique avant abaissement.
      if (key.startsWith('_') && value !== null && typeof value === 'object') {
        const condName = key.slice(1);
        const condDef = registry.conditions[condName]?.definition;
        if (condDef == null) {
          diagnostics.push(
            diagnostic({
              code: Codes.UNKNOWN_CONDITION,
              phase: 'policy',
              message: `Condition inconnue « ${condName} » (bloc ${key}).`,
              source,
              rule: 'conditions.named-only',
              context: {
                condition: condName,
                admitted: Object.keys(registry.conditions),
              },
            }),
          );
          continue;
        }
        outNs[condDef] = outNs[condDef] ?? {};
        for (const prop of Object.keys(value)) {
          const lowered = checkValue({
            property: prop,
            value: value[prop],
            role,
            allowPrivateTokens,
            registry,
            varsByToken,
            source,
            conditionPath: [condName],
            diagnostics,
          });
          if (lowered === null) {
            delete outNs[condDef][prop];
          } else {
            outNs[condDef][prop] = lowered;
          }
        }
        continue;
      }
      const isConditionBlock =
        key.startsWith(':') || key.startsWith('@') || key.startsWith('[');
      if (isConditionBlock) {
        // Bloc conditionnel moteur : seuls les noms enregistrés sont admis
        // côté consommateur ; ici la forme normalisée interne porte déjà la
        // définition canonique — les entrées publiques passent par expandValue.
        for (const prop of Object.keys(value)) {
          const lowered = checkValue({
            property: prop,
            value: value[prop],
            role,
            allowPrivateTokens,
            registry,
            varsByToken,
            source,
            conditionPath: [key],
            diagnostics,
          });
          if (lowered !== null) {
            outNs[key] = outNs[key] ?? {};
            outNs[key][prop] = lowered;
          }
        }
        continue;
      }
      for (const [condName, inner] of expandValue(
        key,
        value,
        registry,
        source,
        diagnostics,
      )) {
        const condDef =
          condName == null ? null : registry.conditions[condName]?.definition;
        const lowered = checkValue({
          property: key,
          value: inner,
          role,
          allowPrivateTokens,
          registry,
          varsByToken,
          source,
          conditionPath: condName == null ? [] : [condName],
          diagnostics,
        });
        if (lowered === null) continue;
        if (condDef == null) {
          outNs[key] = lowered;
        } else {
          outNs[condDef] = outNs[condDef] ?? {};
          outNs[condDef][key] = lowered;
        }
      }
    }
    normalized[nsName] = outNs;
  }

  if (diagnostics.length > 0) {
    throw new PmsError(diagnostics);
  }

  const engineOptions = { ...defaultOptions, ...options };
  const [compiled, injected, classPaths] = styleXCreateSet(
    normalized,
    engineOptions,
  );
  return { compiled, injected, classPaths };
}

/** Collecte et trie les règles injectables par priorité -> texte CSS. */
export function renderCss(injectedByKey) {
  const entries = Object.entries(injectedByKey).map(([key, s]) => ({
    key,
    ltr: s.ltr,
    priority: s.priority ?? 0,
  }));
  entries.sort((a, b) => a.priority - b.priority);
  return entries.map((e) => e.ltr).join('\n');
}
