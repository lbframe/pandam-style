/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

import type { EngineOptions, TStyleValue } from '../../types';

import applicationOrder from './application-order';
import legacyExpandShorthands from './legacy-expand-shorthands';
import propertySpecificity from './property-specificity';

const expansions = {
  'application-order': applicationOrder,
  'property-specificity': propertySpecificity,
  'legacy-expand-shorthands': legacyExpandShorthands,
};

export function getExpandedKeys(
  options: EngineOptions,
): $ReadOnlyArray<string> {
  return Object.keys(
    expansions[options.styleResolution ?? 'property-specificity'],
  );
}

export default function flatMapExpandedShorthands(
  objEntry: $ReadOnly<[string, TStyleValue]>,
  options: $ReadOnly<{
    styleResolution: EngineOptions['styleResolution'],
    propertyValidationMode?: EngineOptions['propertyValidationMode'],
    ...
  }>,
): $ReadOnlyArray<[string, TStyleValue]> {
  // eslint-disable-next-line prefer-const
  let [key, value] = objEntry;
  if (key.startsWith('var(') && key.endsWith(')')) {
    key = key.slice(4, -1);
  }
  const expansion: (
    string | number | null,
  ) => $ReadOnlyArray<[string, TStyleValue]> =
    expansions[options.styleResolution ?? 'property-specificity'][key];
  // $FlowFixMe[constant-condition] - expansion is a function
  if (expansion) {
    if (Array.isArray(value)) {
      throw new Error(
        'Cannot use fallbacks for shorthands. Use the expansion instead.',
      );
    }
    try {
      return expansion(value);
    } catch (error) {
      const validationMode = options.propertyValidationMode ?? 'silent';
      if (validationMode === 'throw') {
        throw error;
      } else if (validationMode === 'warn') {
        console.warn(`[stylex] ${error.message}`);
        return [];
      } else {
        // silent mode - skip the property without any output
        return [];
      }
    }
  }
  return [[key, value]];
}
