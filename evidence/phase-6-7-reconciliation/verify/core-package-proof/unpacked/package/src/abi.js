/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { selectionError } from './selection-error.js';

export const ABI_VERSION = 1;

export function assertAbi(version) {
  if (version === ABI_VERSION) return version;
  throw selectionError(
    'PMS_ABI_MISMATCH',
    `ABI version ${String(version)} is not supported; this runtime supports ABI ${ABI_VERSION}.`,
    'runtime.abi-version',
    { actual: version, supported: [ABI_VERSION] },
    { abiVersion: ABI_VERSION },
  );
}

function malformedRef(reason, context = {}) {
  return selectionError(
    'PMS_UNVERIFIED_PROPS_SOURCE',
    `Composition input is not a valid compiled reference: ${reason}.`,
    'runtime.compiled-ref',
    { reason, ...context },
  );
}

function validClassName(value) {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

/** Runtime shape checking only; compiler binding provenance is separate. */
export function assertCompiledRef(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedRef('expected an object');
  }
  if (
    value.kind !== 'pandamstyle-style-ref' &&
    value.kind !== 'pandamstyle-theme-ref'
  ) {
    throw malformedRef('unknown reference kind', { kind: value.kind ?? null });
  }
  if (!Number.isInteger(value.abiVersion)) {
    throw malformedRef('missing integer ABI version', { kind: value.kind });
  }
  assertAbi(value.abiVersion);
  if (typeof value.systemId !== 'string' || value.systemId.length === 0) {
    throw malformedRef('missing system identity', { kind: value.kind });
  }
  if (
    value.kind === 'pandamstyle-theme-ref' &&
    (typeof value.themeId !== 'string' || value.themeId.length === 0)
  ) {
    throw malformedRef('missing theme identity', { kind: value.kind });
  }
  if (!Array.isArray(value.entries)) {
    throw malformedRef('entries must be an array', { kind: value.kind });
  }
  for (let index = 0; index < value.entries.length; index++) {
    const entry = value.entries[index];
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw malformedRef('entry must be a two-item tuple', {
        index,
        kind: value.kind,
      });
    }
    if (typeof entry[0] !== 'string' || entry[0].length === 0) {
      throw malformedRef('conflict key must be a nonempty string', {
        index,
        kind: value.kind,
      });
    }
    if (entry[1] !== null && !validClassName(entry[1])) {
      throw malformedRef('class name must be one class identifier or null', {
        index,
        kind: value.kind,
      });
    }
  }
  return value;
}
