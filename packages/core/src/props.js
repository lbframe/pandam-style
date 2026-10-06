/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assertCompiledRef } from './abi.js';
import { selectionError } from './selection-error.js';

function invalidInput(value) {
  throw selectionError(
    'PMS_UNVERIFIED_PROPS_SOURCE',
    'props() accepts compiled StyleRef and ThemeRef values, nested arrays, and conditional omissions only.',
    'runtime.props-input',
    {
      actualType: value === null ? 'null' : typeof value,
      kind: value && typeof value === 'object' ? (value.kind ?? null) : null,
    },
  );
}

/** Compose trusted-at-compile-time references using their opaque conflict keys. */
export function props(...inputs) {
  const refs = [];
  const activeArrays = new Set();

  function flatten(value) {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) {
      if (activeArrays.has(value)) {
        throw selectionError(
          'PMS_UNVERIFIED_PROPS_SOURCE',
          'props() cannot compose a cyclic input array.',
          'runtime.props-input',
          { reason: 'cyclic-array' },
        );
      }
      activeArrays.add(value);
      for (const item of value) flatten(item);
      activeArrays.delete(value);
      return;
    }
    if (typeof value !== 'object') invalidInput(value);
    refs.push(assertCompiledRef(value));
  }

  for (const input of inputs) flatten(input);
  if (refs.length === 0) return {};

  const systemId = refs[0].systemId;
  for (const ref of refs) {
    if (ref.systemId !== systemId) {
      throw selectionError(
        'PMS_UNVERIFIED_PROPS_SOURCE',
        'props() cannot compose references from different design systems.',
        'runtime.props-system-identity',
        { expectedSystemId: systemId, actualSystemId: ref.systemId },
        { systemId },
      );
    }
  }

  const latestByConflict = new Map();
  let position = 0;
  for (const ref of refs) {
    for (const [conflictKey, className] of ref.entries) {
      latestByConflict.set(conflictKey, { className, position });
      position++;
    }
  }

  const latestByClass = new Map();
  for (const winner of latestByConflict.values()) {
    if (winner.className === null) continue;
    latestByClass.set(winner.className, winner.position);
  }
  const classNames = [...latestByClass.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([className]) => className);

  return classNames.length === 0 ? {} : { className: classNames.join(' ') };
}
