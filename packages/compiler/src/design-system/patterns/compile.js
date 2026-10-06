/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Codes, diagnostic, PmsError } from '../../protocol/diagnostics';
import { tokenPathOf } from '../tokens/ref';

const ALIGN = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  stretch: 'stretch',
  baseline: 'baseline',
};
const JUSTIFY = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  between: 'space-between',
  around: 'space-around',
};

// Each parameter controls one semantic dimension. There is no CSS escape hatch.
const SCHEMAS = {
  stack: { gap: 'spacing', align: ALIGN, justify: JUSTIFY },
  inline: { gap: 'spacing', align: ALIGN, justify: JUSTIFY },
  center: { inline: 'boolean' },
  grid: { columns: 'columns', gap: 'spacing', align: ALIGN },
  box: {
    padding: 'spacing',
    paddingInline: 'spacing',
    paddingBlock: 'spacing',
  },
};

export const PATTERN_IDS = Object.freeze(Object.keys(SCHEMAS));
export const PATTERN_CATALOG = Object.freeze(
  Object.fromEntries(
    PATTERN_IDS.map((patternId) => [
      patternId,
      Object.freeze({
        patternId,
        parameters: Object.freeze(
          Object.fromEntries(
            Object.entries(SCHEMAS[patternId]).map(([parameter, domain]) => [
              parameter,
              Object.freeze({
                responsive: domain !== 'boolean',
                ...(domain === 'spacing'
                  ? { category: 'spacing', token: true }
                  : {
                      values: Object.freeze(
                        domain === 'boolean'
                          ? [false, true]
                          : domain === 'columns'
                            ? [1, 2, 3, 4, 5, 6]
                            : Object.keys(domain),
                      ),
                    }),
              }),
            ]),
          ),
        ),
      }),
    ]),
  ),
);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The sole pattern IR: a validated name, bounded parameters and ordinary
 * declarations. The existing policy and atomic engine own token checks and CSS.
 * `registry` adds named-condition validation for consumer compilation.
 */
export function createPatternIR(patternId, parameters = {}, options = {}) {
  const { registry, source = 'design-system:patterns', locate } = options;
  const diagnostics = [];
  const schema = Object.hasOwn(SCHEMAS, patternId) ? SCHEMAS[patternId] : null;
  const fail = (
    code,
    message,
    parameter = null,
    condition = null,
    admitted = [],
  ) => {
    diagnostics.push(
      diagnostic({
        code,
        phase: 'patterns',
        message,
        source: locate?.(parameter, condition) ?? source,
        rule: 'patterns.constrained-domain',
        context: {
          patternId,
          parameter,
          condition,
          admitted,
          ...(schema?.[parameter] === 'spacing' ? { category: 'spacing' } : {}),
        },
      }),
    );
  };
  if (schema == null) {
    fail(
      Codes.UNKNOWN_PATTERN,
      `Unknown pattern "${patternId}". Choose ${PATTERN_IDS.join(', ')}.`,
      null,
      null,
      PATTERN_IDS,
    );
  } else if (!isRecord(parameters)) {
    fail(
      Codes.INVALID_PATTERN_PARAMETER,
      `patterns.${patternId}() expects one static parameter object.`,
    );
  }
  if (diagnostics.length) throw new PmsError(diagnostics);

  const scalar = (parameter, value, condition) => {
    const domain = schema[parameter];
    if (domain === 'spacing') {
      // Category, visibility and existence are checked by compileStyles.
      if (tokenPathOf(value, options.refKind ?? 'author') != null) return value;
      fail(
        Codes.INVALID_PATTERN_PARAMETER,
        `patterns.${patternId}.${parameter} requires a spacing token reference; use token('spacing.<name>').`,
        parameter,
        condition,
      );
    } else if (domain === 'columns') {
      if (Number.isInteger(value) && value >= 1 && value <= 6) {
        return `repeat(${value}, minmax(0, 1fr))`;
      }
      fail(
        Codes.INVALID_PATTERN_PARAMETER,
        'patterns.grid.columns requires an integer from 1 through 6.',
        parameter,
        condition,
        [1, 2, 3, 4, 5, 6],
      );
    } else if (domain === 'boolean') {
      if (typeof value === 'boolean') return value;
      fail(
        Codes.INVALID_PATTERN_PARAMETER,
        `patterns.${patternId}.${parameter} requires a static boolean; responsive maps are not supported.`,
        parameter,
        condition,
        [false, true],
      );
    } else if (typeof value === 'string' && Object.hasOwn(domain, value)) {
      return domain[value];
    } else {
      fail(
        Codes.INVALID_PATTERN_PARAMETER,
        `Invalid patterns.${patternId}.${parameter} value. Choose ${Object.keys(domain).join(', ')}.`,
        parameter,
        condition,
        Object.keys(domain),
      );
    }
    return undefined;
  };
  const mapped = {};
  for (const parameter of Object.keys(parameters).sort()) {
    if (!Object.hasOwn(schema, parameter)) {
      fail(
        Codes.INVALID_PATTERN_PARAMETER,
        `Unknown parameter "${parameter}" on patterns.${patternId}. Allowed parameters: ${Object.keys(schema).join(', ')}.`,
        parameter,
        null,
        Object.keys(schema),
      );
      continue;
    }
    const value = parameters[parameter];
    if (
      schema[parameter] !== 'boolean' &&
      isRecord(value) &&
      tokenPathOf(value, options.refKind ?? 'author') == null
    ) {
      const conditions = Object.keys(value).sort();
      if (conditions.length === 0) {
        fail(
          Codes.INVALID_PATTERN_PARAMETER,
          `patterns.${patternId}.${parameter} requires a value or a non-empty named-condition map.`,
          parameter,
        );
      }
      if (conditions.includes('base') && conditions.includes('default')) {
        fail(
          Codes.INVALID_PATTERN_PARAMETER,
          `patterns.${patternId}.${parameter} cannot specify both base and default. Choose one base value.`,
          parameter,
        );
      }
      mapped[parameter] = {};
      for (const condition of conditions) {
        if (
          registry != null &&
          condition !== 'base' &&
          condition !== 'default' &&
          !Object.hasOwn(registry.conditions, condition)
        ) {
          fail(
            Codes.UNKNOWN_CONDITION,
            `Unknown condition "${condition}" on patterns.${patternId}.${parameter}. Use a registered condition.`,
            parameter,
            condition,
            Object.keys(registry.conditions),
          );
          continue;
        }
        mapped[parameter][condition] = scalar(
          parameter,
          value[condition],
          condition,
        );
      }
    } else {
      mapped[parameter] = scalar(parameter, value, null);
    }
  }
  if (diagnostics.length) throw new PmsError(diagnostics);

  const withDefault = (value, fallback) => {
    if (value == null) return fallback;
    if (
      isRecord(value) &&
      !Object.hasOwn(value, 'base') &&
      !Object.hasOwn(value, 'default')
    ) {
      return { base: fallback, ...value };
    }
    return value;
  };
  let declarations;
  if (patternId === 'stack' || patternId === 'inline') {
    declarations = {
      display: 'flex',
      flexDirection: patternId === 'stack' ? 'column' : 'row',
      alignItems: withDefault(
        mapped.align,
        patternId === 'stack' ? 'stretch' : 'center',
      ),
      justifyContent: withDefault(mapped.justify, 'flex-start'),
      ...(mapped.gap == null ? {} : { gap: mapped.gap }),
    };
  } else if (patternId === 'grid') {
    declarations = {
      display: 'grid',
      gridTemplateColumns: withDefault(
        mapped.columns,
        'repeat(1, minmax(0, 1fr))',
      ),
      alignItems: withDefault(mapped.align, 'stretch'),
      ...(mapped.gap == null ? {} : { gap: mapped.gap }),
    };
  } else if (patternId === 'center') {
    declarations = {
      display: mapped.inline === true ? 'inline-flex' : 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
  } else {
    declarations = { boxSizing: 'border-box', ...mapped };
  }
  return { patternId, parameters, declarations };
}

/** Author-side recipe/base composition; CSS still passes through system policy. */
export function patternStyles(patternId, parameters = {}) {
  return createPatternIR(patternId, parameters).declarations;
}
