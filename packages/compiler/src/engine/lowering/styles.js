/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - compilation pipeline (ARC-05).
 * Registry -> policy validation -> lowering through the canonical
 * PandamStyle-owned atomic, token-variable, and theme engine.
 * No parallel CSS emission: every rule comes out of the engine.
 */

import {
  lowerAtomicStyles,
  lowerTokenVariables,
  normalizeEngineOptions,
  projectTheme,
} from '../index';

import { diagnostic, PmsError, Codes } from '../../protocol/diagnostics';
import { tokenPathOf } from '../../design-system/tokens/ref';
import {
  propertyKind,
  propertyCategory,
  structuralAllowed,
  structuralDomain,
} from '../../design-system/policy/properties';
// Benchmark-only measurement hooks (Spike 1).
import { count, perfCollector } from '../../observability/metrics';

// Stable variable identity: systemId + tokenId (D-03). The upstream hash
// is computed over `${exportId}.${key}`, independent of the checkout path.
function varKeyOf(tokenId) {
  return tokenId.replace(/[.-]/g, '_');
}

const lexicalCompare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compiles the registry tokens into CSS variables + theme classes.
 * Retourne { varsByToken, themeClasses, injected }.
 */
export function compileTokens(registry, options = {}) {
  const engineOptions = normalizeEngineOptions(options);
  const baseValues = {};
  const tokenIds =
    registry.vocabularyDomains?.allTokenIds ?? Object.keys(registry.tokens);
  for (const tokenId of tokenIds) {
    baseValues[varKeyOf(tokenId)] = registry.resolvedValues[tokenId];
  }
  const [varsObj, varsStyles] = lowerTokenVariables(baseValues, {
    ...engineOptions,
    exportId: registry.systemId,
  });

  const varsByToken = {};
  for (const tokenId of tokenIds) {
    varsByToken[tokenId] = varsObj[varKeyOf(tokenId)];
  }

  const injected = { ...varsStyles };
  const themeClasses = { base: varsObj.__varGroupHash__ };
  const themeNames =
    registry.vocabularyDomains?.themeNames ??
    Object.keys(registry.themes).sort(lexicalCompare);
  for (const themeName of themeNames) {
    const overrides = {};
    for (const tokenId of Object.keys(registry.themes[themeName]).sort(
      lexicalCompare,
    )) {
      overrides[varKeyOf(tokenId)] = registry.themes[themeName][tokenId];
    }
    if (Object.keys(overrides).length === 0) {
      themeClasses[themeName] = varsObj.__varGroupHash__;
      continue;
    }
    const [themeClassObj, themeStyles] = projectTheme(
      varsObj,
      overrides,
      engineOptions,
    );
    Object.assign(injected, themeStyles);
    themeClasses[themeName] = themeClassObj[varsObj.__varGroupHash__];
  }
  return {
    varsByToken,
    themeClasses,
    varGroupHash: varsObj.__varGroupHash__,
    injected,
  };
}

const BASE_CONDITION = 'default';

/**
 * Memoised admissible-token lists, keyed on the REGISTRY OBJECT.
 *
 * Keyed on the object rather than on a string, so a second design system in the
 * same process cannot read the first one's list: the cache dies with the
 * registry it describes, and there is no invalidation key to get wrong.
 */
const admittedCache = new WeakMap();

function admittedTokens(registry, category, allowPrivateTokens) {
  let byKey = admittedCache.get(registry);
  if (byKey == null) {
    byKey = new Map();
    admittedCache.set(registry, byKey);
  }
  const key = `${category}|${allowPrivateTokens ? 'all' : 'public'}`;
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  const canonicalDomains = registry.vocabularyDomains;
  const list = allowPrivateTokens
    ? (canonicalDomains?.allTokenIdsByCategory?.[category] ??
      Object.keys(registry.tokens).filter(
        (id) => registry.tokens[id].category === category,
      ))
    : (canonicalDomains?.publicTokenIdsByCategory?.[category] ??
      Object.keys(registry.tokens).filter(
        (id) =>
          registry.tokens[id].category === category &&
          registry.tokens[id].visibility === 'public',
      ));
  byKey.set(key, list);
  return list;
}

/**
 * Normalizes a declaration value into { condition, tokenRef|literal } entries.
 * Property-oriented public form ({ base, <cond> }) normalized into blocks (D-05).
 */
function expandValue(property, value, registry, source, refKind, diagnostics) {
  if (
    value !== null &&
    typeof value === 'object' &&
    tokenPathOf(value, refKind) == null &&
    !Array.isArray(value)
  ) {
    // An object with no statically named key is not a condition map: it is a
    // raw value (an object imitating an internal reference, for instance).
    // Treating it as an empty condition map would silently drop the
    // declaration, which is exactly the silent exemption P0 forbids.
    if (Object.keys(value).length === 0) {
      return [[null, value]];
    }
    const entries = [];
    for (const condName of Object.keys(value)) {
      const cond =
        condName === 'base' || condName === 'default'
          ? BASE_CONDITION
          : condName;
      if (cond !== BASE_CONDITION && registry.conditions[cond] == null) {
        diagnostics.push(
          diagnostic({
            code: Codes.UNKNOWN_CONDITION,
            phase: 'policy',
            message: `Unknown condition "${cond}" on ${property}.`,
            source,
            rule: 'conditions.named-only',
            context: {
              property,
              condition: condName,
              admitted:
                registry.vocabularyDomains?.conditionNames ??
                Object.keys(registry.conditions),
            },
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
  refKind = 'author',
  registry,
  varsByToken,
  source,
  systemId,
  locate,
  conditionPath,
  diagnostics,
}) {
  // Provenance: the location of the declaration inside the page, when known.
  const where = locate?.() ?? source;
  const kind = propertyKind(property);

  if (kind === 'composite-form') {
    diagnostics.push(
      diagnostic({
        code: Codes.UNSUPPORTED_PROPERTY_FORM,
        phase: 'policy',
        message: `The composite form "${property}" is refused in P0; use longhand properties.`,
        source: where,
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
        message: `Property not covered by the profile: ${property}.`,
        source: where,
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
          source: where,
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

  // kind === 'category': a TokenRef of the right category is mandatory.
  const category = propertyCategory(property);

  // The admissible-token list, DERIVED FROM THE REGISTRY ALREADY IN HAND.
  //
  // The baseline rebuilt this array with a full `Object.keys(registry.tokens)`
  // scan for EVERY declaration it checked, and used it for exactly one thing:
  // the `candidates` field of a diagnostic that is raised only when the value
  // was refused. The scan is O(tokens) per declaration, so a registry of 10,000
  // tokens and a file of 12 declarations costs 120,000 comparisons to produce
  // zero diagnostics.
  //
  // The work-eliminated variant computes it once per (category,
  // allowPrivateTokens) pair and memoises it on the registry object. The RESULT
  // is identical: same members, same order, same diagnostic text. Only the
  // number of times it is computed changes.
  //
  const admitted = admittedTokens(registry, category, allowPrivateTokens);

  // The `compiler` mode accepts ONLY compiler-stamped TokenRefs: a page object
  // imitating the internal shape is not proof.
  const tokenId = tokenPathOf(value, refKind);
  if (tokenId == null) {
    diagnostics.push(
      diagnostic({
        code: Codes.FORBIDDEN_VALUE,
        phase: 'policy',
        message: `Valeur interdite pour ${property} : ${JSON.stringify(value)}. Un token ${category} est requis.`,
        source: where,
        rule: 'category-strict',
        context: {
          property,
          category,
          value,
          systemId,
          candidates: admitted,
          conditionPath,
        },
      }),
    );
    return null;
  }

  const entry = registry.tokens[tokenId];
  if (entry == null) {
    diagnostics.push(
      diagnostic({
        code: Codes.UNKNOWN_TOKEN,
        phase: 'policy',
        message: `Token inconnu : ${tokenId}.`,
        source: where,
        rule: 'registry.tokens',
        context: {
          property,
          tokenId,
          systemId,
          category: entry?.category ?? null,
          visibility: entry?.visibility ?? null,
          candidates: admitted,
          conditionPath,
        },
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
        source: where,
        rule: 'category-strict',
        context: {
          property,
          systemId,
          expected: category,
          actual: entry.category,
          tokenId,
          visibility: entry.visibility,
          conditionPath,
        },
      }),
    );
    return null;
  }
  if (role === 'consumer' && entry.visibility !== 'public') {
    diagnostics.push(
      diagnostic({
        code: Codes.TOKEN_NOT_PUBLIC,
        phase: 'policy',
        message: `Token ${tokenId} is not selectable from the consumer side.`,
        source: where,
        rule: 'visibility.consumer',
        context: {
          property,
          tokenId,
          systemId,
          category: entry.category,
          visibility: entry.visibility,
          candidates: admitted,
          conditionPath,
        },
      }),
    );
    return null;
  }
  return varsByToken[tokenId];
}

/**
 * Compiles PandamStyle declaration namespaces.
 * signature : compileStyles({ registry, varsByToken, namespaces, role, source, options })
 * Returns { compiled, injected, classPaths } or throws PmsError.
 */
export function compileStyles({
  registry,
  varsByToken,
  namespaces,
  role = 'consumer',
  allowPrivateTokens = false,
  source = null,
  refKind = 'author',
  locate = null,
  options = {},
}) {
  const diagnostics = [];
  const normalized = {};
  const systemId = registry.systemId;
  const policyStart = process.hrtime.bigint();

  for (const nsName of Object.keys(namespaces)) {
    const ns = namespaces[nsName];
    const outNs = {};
    for (const key of Object.keys(ns)) {
      const value = ns[key];
      // Author syntax `_hover` (carried over from Panda): named condition resolved
      // to its canonical definition before lowering.
      if (key.startsWith('_') && value !== null && typeof value === 'object') {
        const condName = key.slice(1);
        const condDef = registry.conditions[condName]?.definition;
        if (condDef == null) {
          diagnostics.push(
            diagnostic({
              code: Codes.UNKNOWN_CONDITION,
              phase: 'policy',
              message: `Unknown condition "${condName}" (block ${key}).`,
              source: locate?.(nsName, key, null) ?? source,
              rule: 'conditions.named-only',
              context: {
                condition: condName,
                admitted:
                  registry.vocabularyDomains?.conditionNames ??
                  Object.keys(registry.conditions),
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
            refKind,
            systemId,
            locate: locate && (() => locate(nsName, key, null)),
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
        // Engine condition block: only registered names are admitted
        // on the consumer side; here the internal normalized form already carries the
        // canonical definition - public entries go through expandValue.
        for (const prop of Object.keys(value)) {
          const lowered = checkValue({
            property: prop,
            value: value[prop],
            role,
            allowPrivateTokens,
            registry,
            varsByToken,
            source,
            refKind,
            systemId,
            locate: locate && (() => locate(nsName, key, null)),
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
        refKind,
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
          refKind,
          systemId,
          locate: locate && (() => locate(nsName, key, condName)),
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

  const engineOptions = {
    ...normalizeEngineOptions(options),
    __pmsCount: perfCollector() === null ? null : count,
  };
  // Atomic lowering is timed separately, so the policy figure EXCLUDES it.
  // Two nested numbers that are added by a reader is one number reported wrong;
  // the two phases are disjoint here, which makes the split exact rather than
  // an estimate.
  const lowerStart = process.hrtime.bigint();
  const [compiled, injected, classPaths] = lowerAtomicStyles(
    normalized,
    engineOptions,
  );
  const lowerNs = Number(process.hrtime.bigint() - lowerStart);
  const collector = perfCollector();
  if (collector != null) {
    collector.addDuration('atomic_lower_ms', lowerNs);
    collector.addDuration(
      'policy_ms',
      Number(process.hrtime.bigint() - policyStart) - lowerNs,
    );
  }
  return { compiled, injected, classPaths };
}

/** Collects and sorts injectable rules by priority -> CSS text. */
export function renderCss(injectedByKey) {
  const entries = Object.entries(injectedByKey).map(([key, s]) => ({
    key,
    ltr: s.ltr,
    priority: s.priority ?? 0,
  }));
  entries.sort((a, b) => a.priority - b.priority);
  return entries.map((e) => e.ltr).join('\n');
}
