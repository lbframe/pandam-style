/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const { isDeepStrictEqual } = require('util');

function at(value, pointer) {
  for (const key of pointer.split('/').filter(Boolean)) value = value?.[key];
  return value;
}

function contains(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => contains(actual[i], v))
    );
  if (expected && typeof expected === 'object')
    return (
      actual != null &&
      Object.entries(expected).every(([k, v]) => contains(actual[k], v))
    );
  return isDeepStrictEqual(actual, expected);
}

// No mutation, record mode, snapshot API or update flag is available.
function evaluate(result, checks, history = []) {
  return checks.map((check) => {
    const actual = at(result, check.path);
    let matches;
    switch (check.op ?? 'equal') {
      case 'equal':
        matches = isDeepStrictEqual(actual, check.value);
        break;
      case 'fields':
        matches = contains(actual, check.value);
        break;
      case 'includes':
        matches =
          Array.isArray(actual) && actual.some((v) => contains(v, check.value));
        break;
      case 'excludes':
        matches =
          Array.isArray(actual) &&
          !actual.some((v) => contains(v, check.value));
        break;
      case 'length':
        matches = actual?.length === check.value;
        break;
      case 'atLeast':
        matches = typeof actual === 'number' && actual >= check.value;
        break;
      case 'sameAsRevision':
        matches = isDeepStrictEqual(
          actual,
          at(history[check.revision - 1], check.path),
        );
        break;
      case 'keys':
        matches =
          actual != null &&
          isDeepStrictEqual(
            Object.keys(actual).sort(),
            [...check.value].sort(),
          );
        break;
      case 'requiredKeys':
        matches =
          actual != null &&
          check.value.every((key) => Object.hasOwn(actual, key));
        break;
      case 'nonEmptyString':
        matches = typeof actual === 'string' && actual.length > 0;
        break;
      case 'sameAsPath':
        matches =
          actual !== undefined &&
          isDeepStrictEqual(actual, at(result, check.value));
        break;
      default:
        throw new Error('Unknown semantic assertion ' + check.op);
    }
    return {
      ...check,
      matches,
      ...(matches ? {} : { actual: actual ?? null }),
    };
  });
}

module.exports = { evaluate, contains, at };
