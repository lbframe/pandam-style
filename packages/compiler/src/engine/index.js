/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * PandamStyle's canonical internal engine entry. Frontend, project CSS state,
 * and full/incremental generation reach the same lowering and ordering rules
 * through this module.
 */

import { defaultOptions } from './ordering/defaults';

export { defaultOptions };
export { default as lowerAtomicStyles } from './atomic/create-set';
export { default as lowerTokenVariables } from '../design-system/tokens/lowering';
export { default as projectTheme } from '../design-system/themes/lowering';
export {
  addAncestorSelector,
  addSpecificityLevel,
  createRuleComparator,
  declaredPropertyName,
  layerHeader,
  logicalFloatVars,
  processStylexRules,
  splitConstantRules,
  transformRuleEntry,
} from './ordering/rules';

export function normalizeEngineOptions(options = {}) {
  return { ...defaultOptions, ...options };
}
