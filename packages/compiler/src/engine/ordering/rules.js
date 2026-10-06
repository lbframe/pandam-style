/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * This file contains the CSS ordering behavior required from StyleX 0.19.1's
 * `packages/@stylexjs/babel-plugin/src/index.js`. The general Babel plugin
 * visitor is intentionally excluded; PandamStyle owns this bounded CSS API.
 *
 * @flow strict
 */

import { MediaQuery } from './media-query/media-query';
import type { MediaQueryRule } from './media-query/media-query';
import {
  LOGICAL_FLOAT_END_VAR,
  LOGICAL_FLOAT_START_VAR,
} from '../atomic/preprocess-rules/legacy-expand-shorthands';

export type Rule = [
  string,
  {
    ltr: string,
    rtl?: null | string,
    constKey?: string,
    constVal?: string | number,
  },
  number,
];

type LayerConfig =
  | boolean
  | $ReadOnly<{
      before?: $ReadOnlyArray<string>,
      after?: $ReadOnlyArray<string>,
      prefix?: string,
    }>;

type CSSRulesOptions = $ReadOnly<{
  useLayers?: LayerConfig,
  enableLTRRTLComments?: boolean,
  legacyDisableLayers?: boolean,
  useLegacyClassnamesSort?: boolean,
  __pmsPerfPhase?: <T>(name: string, work: () => T) => T,
  ...
}>;

type CSSRulesConfig = boolean | CSSRulesOptions;

function getLogicalFloatVars(rules: Array<Rule>): string {
  const hasLogicalFloat = rules.some(([, { ltr, rtl }]) => {
    const ltrStr = String(ltr);
    const rtlStr = rtl ? String(rtl) : '';
    return (
      ltrStr.includes(LOGICAL_FLOAT_START_VAR) ||
      ltrStr.includes(LOGICAL_FLOAT_END_VAR) ||
      rtlStr.includes(LOGICAL_FLOAT_START_VAR) ||
      rtlStr.includes(LOGICAL_FLOAT_END_VAR)
    );
  });

  return hasLogicalFloat
    ? `:root, [dir="ltr"] {
  ${LOGICAL_FLOAT_START_VAR}: left;
  ${LOGICAL_FLOAT_END_VAR}: right;
}
[dir="rtl"] {
  ${LOGICAL_FLOAT_START_VAR}: right;
  ${LOGICAL_FLOAT_END_VAR}: left;
}
`
    : '';
}

type WidthBound = $ReadOnly<{ kind: 'min' | 'max', value: number }>;

// A rule's width bound plus the at-rule context it sits in. Only rules with
// an identical context are comparable: a breakpoint nested under `@supports`
// says nothing about one nested under a different condition.
type WidthSortKey = $ReadOnly<{ context: string, bound: WidthBound }>;

// The `min-width`/`max-width` px bounds a media query imposes, or null if it
// has none to sort by: `not` and `or` can widen the matched range or split it
// in two, and rem/em bounds are unreadable at build time. Zero counts as a
// bound whatever unit it carries, or none at all.
function collectWidthBounds(rule: MediaQueryRule): Array<WidthBound> | null {
  if (rule.type === 'pair') {
    // Media feature names are ASCII case-insensitive.
    const key = rule.key.toLowerCase();
    const kind =
      key === 'min-width' ? 'min' : key === 'max-width' ? 'max' : null;
    // A non-width feature (e.g. `orientation`) constrains no width.
    if (kind == null) {
      return [];
    }

    const v = rule.value;
    // Zero is the one length that needs no unit. Any other unitless number is
    // invalid CSS for a media feature — the browser drops the whole query — so
    // leave those unsorted rather than assume px.
    if (v === 0) {
      return [{ kind, value: 0 }];
    }

    if (
      v != null &&
      typeof v === 'object' &&
      // A `Fraction` value (e.g. `aspect-ratio`) is array-shaped, not a length.
      !Array.isArray(v) &&
      typeof v.value === 'number' &&
      // Units are ASCII case-insensitive, and zero is zero in any unit.
      (v.value === 0 || String(v.unit).toLowerCase() === 'px')
    ) {
      return [{ kind, value: v.value }];
    }
    return null;
  }
  if (rule.type === 'and') {
    const bounds: Array<WidthBound> = [];
    for (const r of rule.rules) {
      const found = collectWidthBounds(r);
      if (found == null) {
        return null;
      }

      bounds.push(...found);
    }

    return bounds;
  }

  // A negated media type (e.g. `not screen`) inverts the whole expression.
  if (rule.type === 'media-keyword') {
    return rule.not ? null : [];
  }

  return null;
}

// The single width bound a media query sorts by, or null if it has none.
function mediaQueryWidthSortKey(prelude: string): WidthBound | null {
  let parsed;
  try {
    parsed = MediaQuery.parser.parseToEnd(prelude);
  } catch {
    return null;
  }
  const bounds = collectWidthBounds(parsed.queries);
  // Zero bounds means no width condition; more than one (a range, or a
  // redundant pair like `(min-width: 500px) and (min-width: 900px)`) has no
  // single value to sort by.
  if (bounds == null || bounds.length !== 1) {
    return null;
  }

  return bounds[0];
}

// The leading at-rule preludes of a rule, outermost first, e.g.
// `@supports (x){@media (y){.a{…}}}` -> ['@supports (x)', '@media (y)'].
function atRulePreludes(rule: string): Array<string> {
  const preludes = [];
  let index = 0;
  while (rule[index] === '@') {
    const brace = rule.indexOf('{', index);
    if (brace === -1) {
      break;
    }

    preludes.push(rule.slice(index, brace).trimEnd());
    index = brace + 1;
  }

  return preludes;
}

// The sort key for a rule's at-rule chain, or null if it has no single
// `@media` to sort by. Media queries nested in other at-rules still sort, but
// only against rules sharing the same surrounding conditions.
function widthSortKeyForChain(preludes: Array<string>): WidthSortKey | null {
  const mediaIndexes = [];
  preludes.forEach((prelude, i) => {
    if (prelude.startsWith('@media ')) {
      mediaIndexes.push(i);
    }
  });
  // Zero means nothing to sort by; more than one means nested media queries
  // whose combined bound isn't a single value.
  if (mediaIndexes.length !== 1) {
    return null;
  }

  const mediaIndex = mediaIndexes[0];
  const bound = mediaQueryWidthSortKey(preludes[mediaIndex]);
  if (bound == null) {
    return null;
  }

  // Blank out the media query itself so the context captures the surrounding
  // at-rules and the query's depth among them, but not its breakpoint.
  const context = preludes
    .map((p, i) => (i === mediaIndex ? '@media' : p))
    .join('{');
  return { context, bound };
}

// The property name a rule declares, e.g. `.a{width:500px}` -> `width`.
// Breakpoints are ordered within a property, so the property has to be
// compared without its value — two breakpoints for the same property differ
// in value by definition, and comparing that first would preempt the order.
function declaredPropertyName(rule: string): string {
  const declaration = rule.slice(rule.lastIndexOf('{') + 1);
  const colon = declaration.indexOf(':');
  return colon === -1 ? declaration : declaration.slice(0, colon);
}

// A total ordering over width sort keys, so the sort stays consistent no
// matter which pairs get compared: rules with a bound first, then grouped by
// at-rule context, then `min-width` ascending ahead of `max-width` descending
// — the conventional mobile-first order.
function compareWidthSortKeys(
  a: WidthSortKey | null,
  b: WidthSortKey | null,
): number {
  if (a == null || b == null) {
    if (a == null && b == null) {
      return 0;
    }

    return a == null ? 1 : -1;
  }

  if (a.context !== b.context) {
    return a.context.localeCompare(b.context);
  }

  if (a.bound.kind !== b.bound.kind) {
    return a.bound.kind === 'min' ? -1 : 1;
  }

  return a.bound.kind === 'min'
    ? a.bound.value - b.bound.value
    : b.bound.value - a.bound.value;
}

function measurePandamStylePhase<T>(
  config: CSSRulesConfig | void,
  name: string,
  work: () => T,
): T {
  const callback =
    config != null && typeof config === 'object' ? config.__pmsPerfPhase : null;
  return typeof callback === 'function' ? callback(name, work) : work();
}

function processStylexRules(
  rules: Array<Rule>,
  config?: CSSRulesConfig,
): string {
  // Benchmark-only callback supplied by the compiler. Ordinary StyleX callers
  // have no dependency on PandamStyle observability.
  return measurePandamStylePhase(config, 'css_serialize_ms', () =>
    processStylexRulesInner(rules, config),
  );
}

function processStylexRulesInner(
  rules: Array<Rule>,
  config?: CSSRulesConfig,
): string {
  const rawConfig =
    typeof config === 'boolean' ? { useLayers: config } : (config ?? {});
  // `enableLTRRTLComments` and `legacyDisableLayers` are read inside
  // `transformRuleEntry`, which the full aggregator now shares with the
  // incremental one, so they are not destructured here any more.
  const { useLegacyClassnamesSort = false } = rawConfig;

  const rawUseLayers = rawConfig.useLayers ?? false;
  const useLayers = rawUseLayers !== false;
  const layersBefore =
    typeof rawUseLayers === 'object' ? (rawUseLayers.before ?? []) : [];
  const layersAfter =
    typeof rawUseLayers === 'object' ? (rawUseLayers.after ?? []) : [];
  const layerPrefix =
    typeof rawUseLayers === 'object' ? (rawUseLayers.prefix ?? '') : '';

  if (rules.length === 0) {
    return '';
  }

  const constantRules = rules.filter(
    ([, ruleObj]) => ruleObj?.constKey != null && ruleObj?.constVal != null,
  );
  const nonConstantRules = rules.filter(
    ([, ruleObj]) => !(ruleObj?.constKey != null && ruleObj?.constVal != null),
  );

  const constsMap: Map<string, string | number> = new Map();
  for (const [keyhash, ruleObj] of constantRules) {
    // $FlowFixMe[incompatible-type] - null check above
    const constVal: string | number = ruleObj.constVal;
    const constName = `var(--${keyhash})`;
    constsMap.set(constName, constVal);
  }

  function resolveConstant(
    value: string | number,
    visited: Set<string> = new Set(),
  ): string | number {
    if (typeof value !== 'string') return value;
    const regex = /var\((--[A-Za-z0-9_-]+)\)/g;
    let result: string = value;
    let match: RegExp$matchResult | null;
    while ((match = regex.exec(result)) !== null) {
      if (match == null) continue;
      const ref = match[1];
      if (visited.has(ref)) {
        throw new Error(`circular reference detected for constant ${ref}`);
      }
      const refKey = `var(${ref})`;
      const refValue = constsMap.get(refKey);
      if (refValue == null) continue;
      visited.add(ref);
      const replacement = resolveConstant(refValue, visited);
      result = result.replace(match[0], () => replacement.toString());
      visited.delete(ref);
      regex.lastIndex = 0;
    }
    return result;
  }

  for (const [key, value] of constsMap.entries()) {
    constsMap.set(key, resolveConstant(value));
  }

  // Parsing is expensive and the comparator runs O(n log n) times. Key on the
  // at-rule chain, not the whole rule — every rule has a distinct class name,
  // so a full-rule key would never hit.
  const widthSortKeys: Map<string, WidthSortKey | null> = new Map();
  const getWidthSortKey = (rule: string): WidthSortKey | null => {
    if (rule[0] !== '@') {
      return null;
    }

    const preludes = atRulePreludes(rule);
    const chain = preludes.join('{');
    const cached = widthSortKeys.get(chain);
    if (cached !== undefined) {
      return cached;
    }

    const key = widthSortKeyForChain(preludes);
    widthSortKeys.set(chain, key);
    return key;
  };

  const sortedRules: Array<Rule> = measurePandamStylePhase(
    config,
    'rule_sort_ms',
    () =>
      nonConstantRules
        .map(([key, { ...styleObj }, priority]): Rule => {
          Object.keys(styleObj).forEach((dir) => {
            let original = styleObj[dir];
            for (const [varRef, constValue] of constsMap.entries()) {
              if (typeof original !== 'string') continue;
              const replacement = String(constValue);
              original = original.replaceAll(varRef, () => replacement);
              if (replacement.startsWith('var(') && replacement.endsWith(')')) {
                const inside = replacement.slice(4, -1).trim();
                const commaIdx = inside.indexOf(',');
                const targetName = (
                  commaIdx >= 0 ? inside.slice(0, commaIdx) : inside
                ).trim();
                const constName = varRef.slice(4, -1);
                original = original.replaceAll(
                  `${constName}:`,
                  `${targetName}:`,
                );
              }
              styleObj[dir] = original;
            }
          });
          return [key, styleObj, priority];
        })
        .sort(
          (
            [classname1, { ltr: rule1 }, firstPriority]: [string, any, number],
            [classname2, { ltr: rule2 }, secondPriority]: [string, any, number],
          ) => {
            const priorityComparison = firstPriority - secondPriority;
            if (priorityComparison !== 0) return priorityComparison;

            if (useLegacyClassnamesSort) {
              return classname1.localeCompare(classname2);
            } else {
              const nameComparison = declaredPropertyName(rule1).localeCompare(
                declaredPropertyName(rule2),
              );
              if (nameComparison !== 0) return nameComparison;

              // Only rules for the same property compete in the cascade, so the
              // breakpoint order applies within a property, after it. Ordering by
              // width first would decide some pairs by width and others by
              // declaration text, which is not a consistent ordering.
              const mqComparison = compareWidthSortKeys(
                getWidthSortKey(rule1),
                getWidthSortKey(rule2),
              );
              if (mqComparison !== 0) return mqComparison;

              const property1 = rule1.slice(rule1.lastIndexOf('{'));
              const property2 = rule2.slice(rule2.lastIndexOf('{'));
              const propertyComparison = property1.localeCompare(property2);
              if (propertyComparison !== 0) return propertyComparison;
              return rule1.localeCompare(rule2);
            }
          },
        ),
  );

  let lastKPri = -1;
  const grouped = sortedRules.reduce((acc: Array<Array<Rule>>, rule) => {
    const [key, styleObj, priority] = rule;
    const priorityLevel = Math.floor(priority / 1000);

    if (priorityLevel === lastKPri) {
      acc[acc.length - 1].push([key, styleObj, priority]);
      return acc;
    }

    lastKPri = priorityLevel;
    acc.push([[key, styleObj, priority]]);
    return acc;
  }, []);

  const logicalFloatVars = measurePandamStylePhase(config, 'styleq_ms', () =>
    getLogicalFloatVars(sortedRules),
  );

  // Delegates to the shared implementation rather than restating it, so the
  // full aggregator and the incremental one cannot name layers differently.
  const layerName = (index: number): string => layerNameFor(index, layerPrefix);

  const header = useLayers
    ? '\n@layer ' +
      [
        ...layersBefore,
        ...grouped.map((_, index) => layerName(index)),
        ...layersAfter,
      ].join(', ') +
      ';\n'
    : '';

  const collectRules = (rules: Array<Rule>, index: number): string =>
    Array.from(new Map(rules.map(([a, b]) => [a, b])).values())
      .flatMap((rule) => transformRuleEntry(rule, index, rawConfig))
      .join('\n');

  const collectedCSS = measurePandamStylePhase(config, 'css_join_ms', () =>
    grouped
      .map((group, index) => {
        // A `priorityLevel` (Math.floor(priority / 1000)) can mix rules that must
        // stay outside layers (`@property`, `@keyframes`, `@position-try` are all
        // priority 0) with rules that belong inside them (CSS custom properties
        // are priority 1). Deciding based on `group[0][2]` alone would let the
        // first rule's priority pull the whole group out of its layer, so we
        // partition the group by whether each rule is layerable (priority > 0).
        if (!useLayers) {
          return collectRules(group, index);
        }

        const layerable = group.filter(([, , pri]) => pri > 0);
        const unlayered = group.filter(([, , pri]) => pri === 0);

        const parts = [];
        if (unlayered.length > 0) {
          parts.push(collectRules(unlayered, index));
        }
        // Don't put @property, @keyframe, @position-try in layers
        if (layerable.length > 0) {
          parts.push(
            `@layer ${layerName(index)}{\n${collectRules(layerable, index)}\n}`,
          );
        }
        return parts.join('\n');
      })
      .join('\n'),
  );

  return logicalFloatVars + header + collectedCSS;
}

function createRuleComparator(
  config?: CSSRulesConfig,
): (first: Rule, second: Rule) => number {
  const { useLegacyClassnamesSort = false } =
    typeof config === 'boolean' ? {} : (config ?? {});
  const widthSortKeys: Map<string, WidthSortKey | null> = new Map();
  const getWidthSortKey = (rule: string): WidthSortKey | null => {
    if (rule[0] !== '@') {
      return null;
    }
    const preludes = atRulePreludes(rule);
    const chain = preludes.join('{');
    const cached = widthSortKeys.get(chain);
    if (cached !== undefined) {
      return cached;
    }
    const key = widthSortKeyForChain(preludes);
    widthSortKeys.set(chain, key);
    return key;
  };
  return (
    [classname1, { ltr: rule1 }, firstPriority]: Rule,
    [classname2, { ltr: rule2 }, secondPriority]: Rule,
  ): number => {
    const priorityComparison = firstPriority - secondPriority;
    if (priorityComparison !== 0) return priorityComparison;

    if (useLegacyClassnamesSort) {
      return classname1.localeCompare(classname2);
    }
    const nameComparison = declaredPropertyName(rule1).localeCompare(
      declaredPropertyName(rule2),
    );
    if (nameComparison !== 0) return nameComparison;

    const mqComparison = compareWidthSortKeys(
      getWidthSortKey(rule1),
      getWidthSortKey(rule2),
    );
    if (mqComparison !== 0) return mqComparison;

    const property1 = rule1.slice(rule1.lastIndexOf('{'));
    const property2 = rule2.slice(rule2.lastIndexOf('{'));
    const propertyComparison = property1.localeCompare(property2);
    if (propertyComparison !== 0) return propertyComparison;
    return rule1.localeCompare(rule2);
  };
}

/** One rule's final text for one layer group. The body of `collectRules`. */
function transformRuleEntry(
  rule: Rule[1],
  index: number,
  config?: CSSRulesConfig,
): Array<string> {
  const { enableLTRRTLComments = false, legacyDisableLayers = false } =
    typeof config === 'boolean' ? {} : (config ?? {});
  const rawUseLayers =
    typeof config === 'boolean' ? config : ((config ?? {}).useLayers ?? false);
  const useLayers = rawUseLayers !== false;

  // `rule` is the VALUE of `new Map(rules.map(([a, b]) => [a, b]))`, i.e. the
  // InjectableStyle `{ltr, rtl}`, not the rule tuple. `a` is the class name the
  // map was keyed by, which is where the deduplication happens.
  const { ltr, rtl } = rule;
  let ltrRule = ltr,
    rtlRule = rtl;

  if (!useLayers && !legacyDisableLayers) {
    ltrRule = addSpecificityLevel(ltrRule, index);
    rtlRule = rtlRule && addSpecificityLevel(rtlRule, index);
  }

  // check if the selector looks like .xtrlmmh, .xtrlmmh:root
  // if so, turn it into .xtrlmmh.xtrlmmh, .xtrlmmh.xtrlmmh:root
  // This is to ensure the themes always have precedence over the
  // default variable values
  ltrRule = ltrRule.replace(
    /\.([a-zA-Z0-9]+), \.([a-zA-Z0-9]+):root/g,
    '.$1.$1, .$1.$1:root',
  );
  if (rtlRule) {
    rtlRule = rtlRule.replace(
      /\.([a-zA-Z0-9]+), \.([a-zA-Z0-9]+):root/g,
      '.$1.$1, .$1.$1:root',
    );
  }

  return rtlRule
    ? enableLTRRTLComments
      ? [
          `/* @ltr begin */${ltrRule}/* @ltr end */`,
          `/* @rtl begin */${rtlRule}/* @rtl end */`,
        ]
      : [
          addAncestorSelector(ltrRule, "html:not([dir='rtl'])"),
          addAncestorSelector(rtlRule, "html[dir='rtl']"),
        ]
    : [ltrRule];
}

/** The `@layer` preamble for a stylesheet with `groupCount` groups. */
function layerHeader(config: CSSRulesConfig, groupCount: number): string {
  const rawConfig =
    typeof config === 'boolean' ? { useLayers: config } : (config ?? {});
  const rawUseLayers = rawConfig.useLayers ?? false;
  const useLayers = rawUseLayers !== false;
  const layersBefore =
    typeof rawUseLayers === 'object' ? (rawUseLayers.before ?? []) : [];
  const layersAfter =
    typeof rawUseLayers === 'object' ? (rawUseLayers.after ?? []) : [];
  const layerPrefix =
    typeof rawUseLayers === 'object' ? (rawUseLayers.prefix ?? '') : '';
  if (!useLayers) return '';
  return (
    '\n@layer ' +
    [
      ...layersBefore,
      ...Array.from({ length: groupCount }, (_, i) =>
        layerNameFor(i, layerPrefix),
      ),
      ...layersAfter,
    ].join(', ') +
    ';\n'
  );
}

function layerNameFor(index: number, layerPrefix: string): string {
  return layerPrefix
    ? `${layerPrefix}.priority${index + 1}`
    : `priority${index + 1}`;
}

/**
 * The logical-float preamble, and the constant substitution that has to happen
 * BEFORE ordering, because the comparator reads the substituted text.
 */
function splitConstantRules(rules: Array<Rule>): {
  constantRules: Array<Rule>,
  nonConstantRules: Array<Rule>,
} {
  const constantRules = rules.filter(
    ([, ruleObj]) => ruleObj?.constKey != null && ruleObj?.constVal != null,
  );
  const nonConstantRules = rules.filter(
    ([, ruleObj]) => !(ruleObj?.constKey != null && ruleObj?.constVal != null),
  );
  return { constantRules, nonConstantRules };
}

/**
 * Adds an ancestor selector in a media-query-aware way.
 *
 * Helper function for `processStylexRules`.
 */
function addAncestorSelector(
  selector: string,
  ancestorSelector: string,
): string {
  // These at-rules contain declarations, not selectors, so we cannot add one.
  if (
    selector.startsWith('@keyframes') ||
    selector.startsWith('@position-try')
  ) {
    return selector;
  }
  if (!selector.startsWith('@')) {
    return `${ancestorSelector} ${selector}`;
  }

  const lastAtRule = selector.lastIndexOf('@');
  const atRuleBracketIndex = selector.indexOf('{', lastAtRule);
  const mediaQueryPart = selector.slice(0, atRuleBracketIndex + 1);
  const rest = selector.slice(atRuleBracketIndex + 1);
  return `${mediaQueryPart}${ancestorSelector} ${rest}`;
}

/**
 * Adds :not(#\#) to bump up specificity. as a polyfill for @layer
 */
function addSpecificityLevel(selector: string, index: number): string {
  if (
    selector.startsWith('@keyframes') ||
    selector.startsWith('@position-try')
  ) {
    return selector;
  }
  const pseudo = Array.from({ length: index })
    .map(() => ':not(#\\#)')
    .join('');

  const lastOpenCurly = selector.includes('::')
    ? selector.indexOf('::')
    : selector.lastIndexOf('{');
  const beforeCurly = selector.slice(0, lastOpenCurly);
  const afterCurly = selector.slice(lastOpenCurly);

  return `${beforeCurly}${pseudo}${afterCurly}`;
}

export {
  addAncestorSelector,
  addSpecificityLevel,
  createRuleComparator,
  declaredPropertyName,
  getLogicalFloatVars as logicalFloatVars,
  layerHeader,
  processStylexRules,
  splitConstantRules,
  transformRuleEntry,
};
