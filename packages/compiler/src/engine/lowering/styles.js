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
  admittedValues,
  effectivePropertiesOf,
  isPrototypeName,
  literalAllowed,
  propertyDomainsOf,
  propertyRow,
} from '../../design-system/policy/domains';
import { recognizedProperty } from '../../design-system/policy/recognized';
// Benchmark-only measurement hooks (Spike 1).
import { count, perfCollector } from '../../observability/metrics';
import { applyTransforms } from '../../targets/transforms';

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

function admittedTokens(registry, categories, allowPrivateTokens) {
  let byKey = admittedCache.get(registry);
  if (byKey == null) {
    byKey = new Map();
    admittedCache.set(registry, byKey);
  }
  // `categories` is a row's frozen `domain.tokens`: one array per effective
  // row, so its identity is the memo key.
  let byVisibility = byKey.get(categories);
  if (byVisibility == null) {
    byVisibility = {};
    byKey.set(categories, byVisibility);
  }
  const key = allowPrivateTokens ? 'all' : 'public';
  const hit = byVisibility[key];
  if (hit !== undefined) return hit;
  const canonicalDomains = registry.vocabularyDomains;
  const list = [];
  for (const category of categories) {
    list.push(
      ...(allowPrivateTokens
        ? (canonicalDomains?.allTokenIdsByCategory?.[category] ??
          Object.keys(registry.tokens).filter(
            (id) => registry.tokens[id].category === category,
          ))
        : (canonicalDomains?.publicTokenIdsByCategory?.[category] ??
          Object.keys(registry.tokens).filter(
            (id) =>
              registry.tokens[id].category === category &&
              registry.tokens[id].visibility === 'public',
          ))),
    );
  }
  byVisibility[key] = list;
  return list;
}

/** A registered condition name: an own key of the registry's conditions. */
function hasCondition(registry, name) {
  return typeof name === 'string' && Object.hasOwn(registry.conditions, name);
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
      if (cond !== BASE_CONDITION && !hasCondition(registry, cond)) {
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

// Rule of an unsupported property, by its CE-00.1 disposition. Recognition
// authorizes nothing: every one of these is rejected.
const UNSUPPORTED_RULES = Object.freeze({
  'canonical-property': 'supported-properties.not-admitted',
  'system-resource': 'supported-properties.not-admitted',
  'incompatible-runtime-requirement': 'supported-properties.not-admitted',
  'normalized-alias': 'supported-properties.alias',
  'deprecated-or-experimental': 'supported-properties.deprecated',
  'scoped-platform-extension': 'supported-properties.platform-extension',
});

/**
 * PMS_UNSUPPORTED_PROPERTY for a property without an admitted domain: a
 * platform-extension row (recognition-only in CE-02.1, whatever the target
 * profile), a recognized name, or an unrecognized one (prototype keys
 * included).
 */
function unsupportedProperty(property, properties, row, where) {
  const recognized = row == null ? recognizedProperty(property) : null;
  const disposition =
    row != null
      ? 'scoped-platform-extension'
      : (recognized?.disposition ?? null);
  const rule =
    (disposition == null ? null : UNSUPPORTED_RULES[disposition]) ??
    'supported-properties.unrecognized';
  const context = { property };
  if (rule === 'supported-properties.unrecognized') {
    if (disposition != null) context.disposition = disposition;
    context.admitted = propertyDomainsOf(properties).keys;
  } else {
    context.css = row?.css ?? recognized.css;
    context.disposition = disposition;
    if (recognized?.replacement != null) {
      context.replacement = recognized.replacement;
    }
    if (rule === 'supported-properties.platform-extension') {
      context.platform = row?.platform ?? null;
    }
  }
  return diagnostic({
    code: Codes.UNSUPPORTED_PROPERTY,
    phase: 'policy',
    message: `Property not covered by the profile: ${property}.`,
    source: where,
    rule,
    context,
  });
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
  const properties = effectivePropertiesOf(registry);
  const row = propertyRow(properties, property);

  if (row != null && row.form === 'rejected-composite') {
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
  if (row == null || row.domain == null) {
    diagnostics.push(unsupportedProperty(property, properties, row, where));
    return null;
  }

  const domain = row.domain;
  // The rule names the shape of the domain, as Alpha 1 did: `category-strict`
  // for a token-only domain, `structural-domain` for literal values or a
  // range, `property-domain` for a domain that mixes both.
  const tokenOnly =
    domain.tokens.length > 0 &&
    domain.values.length === 0 &&
    domain.range == null;
  const literalOnly = domain.tokens.length === 0;
  const valueRule = tokenOnly
    ? 'category-strict'
    : literalOnly
      ? 'structural-domain'
      : 'property-domain';
  const categories = domain.tokens;
  const category = categories.length === 1 ? categories[0] : null;

  // The `compiler` mode accepts ONLY compiler-stamped TokenRefs: a page object
  // imitating the internal shape is not proof.
  const tokenId = tokenPathOf(value, refKind);
  if (tokenId == null || literalOnly) {
    if (tokenId == null && literalAllowed(domain, value)) return value;
    if (literalOnly) {
      diagnostics.push(
        diagnostic({
          code: Codes.FORBIDDEN_VALUE,
          phase: 'policy',
          message: `Valeur structurelle interdite : ${property} = ${JSON.stringify(value)}.`,
          source: where,
          rule: valueRule,
          context: {
            property,
            value,
            admitted: admittedValues(domain),
            conditionPath,
            ...(row.origin === 'default' ? {} : { origin: row.origin }),
          },
        }),
      );
      return null;
    }
    // The admissible-token list, derived from the registry already in hand
    // and memoised per (registry, domain, visibility): see `admittedTokens`.
    diagnostics.push(
      diagnostic({
        code: Codes.FORBIDDEN_VALUE,
        phase: 'policy',
        message: tokenOnly
          ? `Valeur interdite pour ${property} : ${JSON.stringify(value)}. Un token ${category ?? categories.join(' | ')} est requis.`
          : `Valeur interdite pour ${property} : ${JSON.stringify(value)}.`,
        source: where,
        rule: valueRule,
        context: {
          property,
          category,
          ...(tokenOnly ? {} : { admitted: admittedValues(domain) }),
          value,
          systemId,
          candidates: admittedTokens(registry, categories, allowPrivateTokens),
          conditionPath,
          ...(row.origin === 'default' ? {} : { origin: row.origin }),
        },
      }),
    );
    return null;
  }
  const admitted = admittedTokens(registry, categories, allowPrivateTokens);

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
  if (!categories.includes(entry.category)) {
    diagnostics.push(
      diagnostic({
        code: Codes.INVALID_TOKEN_CATEGORY,
        phase: 'policy',
        message: `${property} exige un token ${category ?? categories.join(' | ')} ; ${tokenId} est ${entry.category}.`,
        source: where,
        rule: 'category-strict',
        context: {
          property,
          systemId,
          expected: category ?? [...categories],
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

function setOwnStyleValue(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
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
      // An Object.prototype name is never a property nor a condition block:
      // refused here, before the `_condition` and `:`/`@`/`[` dispatch.
      if (isPrototypeName(key)) {
        diagnostics.push(
          unsupportedProperty(
            key,
            effectivePropertiesOf(registry),
            null,
            locate?.(nsName, key, null) ?? source,
          ),
        );
        continue;
      }
      // Author syntax `_hover` (carried over from Panda): named condition resolved
      // to its canonical definition before lowering.
      if (key.startsWith('_') && value !== null && typeof value === 'object') {
        const condName = key.slice(1);
        const condDef = hasCondition(registry, condName)
          ? registry.conditions[condName].definition
          : null;
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
        if (!Object.prototype.hasOwnProperty.call(outNs, condDef)) {
          setOwnStyleValue(outNs, condDef, {});
        }
        const conditionStyles = outNs[condDef];
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
            delete conditionStyles[prop];
          } else {
            setOwnStyleValue(conditionStyles, prop, lowered);
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
            if (!Object.prototype.hasOwnProperty.call(outNs, key)) {
              setOwnStyleValue(outNs, key, {});
            }
            setOwnStyleValue(outNs[key], prop, lowered);
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
          condName == null || !hasCondition(registry, condName)
            ? null
            : registry.conditions[condName].definition;
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
          setOwnStyleValue(outNs, key, lowered);
        } else {
          if (!Object.prototype.hasOwnProperty.call(outNs, condDef)) {
            setOwnStyleValue(outNs, condDef, {});
          }
          setOwnStyleValue(outNs[condDef], key, lowered);
        }
      }
    }
    setOwnStyleValue(normalized, nsName, outNs);
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
  return entries.map((e) => applyTransforms(e.ltr)).join('\n');
}
