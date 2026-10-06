/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// A wire codec, not a definition interpreter. Preserve public token references
// keyed by Symbol.for() instead of silently dropping them through JSON.
function encode(value, depth = 0, ancestors = new Set()) {
  if (depth > 64) throw new TypeError('PandamStyle IPC payload is too deep.');
  if (value === undefined) return ['undefined'];
  if (value === null || ['string', 'boolean'].includes(typeof value))
    return ['value', value];
  if (typeof value === 'number' && Number.isFinite(value))
    return ['value', value];
  if (typeof value === 'symbol') {
    const key = Symbol.keyFor(value);
    if (key === undefined)
      throw new TypeError('IPC requires registered symbols.');
    return ['symbol', key];
  }
  if (typeof value !== 'object')
    throw new TypeError('IPC requires plain data; functions stay in the host.');
  if (ancestors.has(value))
    throw new TypeError('IPC cannot encode cyclic data.');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    throw new TypeError('IPC requires plain objects or arrays.');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return [
        'array',
        Array.from(value, (item) => encode(item, depth + 1, ancestors)),
      ];
    const entries = Reflect.ownKeys(value).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) return [];
      if (!Object.hasOwn(descriptor, 'value'))
        throw new TypeError('IPC cannot encode property accessors.');
      return [
        [
          encode(key, depth + 1, ancestors),
          encode(descriptor.value, depth + 1, ancestors),
        ],
      ];
    });
    return ['object', entries];
  } finally {
    ancestors.delete(value);
  }
}

function decode(value, depth = 0) {
  if (depth > 64 || !Array.isArray(value))
    throw new TypeError('Invalid PandamStyle IPC data.');
  const [tag, payload] = value;
  if (tag === 'undefined' && value.length === 1) return undefined;
  if (
    tag === 'value' &&
    value.length === 2 &&
    (payload === null ||
      ['string', 'boolean'].includes(typeof payload) ||
      (typeof payload === 'number' && Number.isFinite(payload)))
  )
    return payload;
  if (tag === 'symbol' && value.length === 2 && typeof payload === 'string')
    return Symbol.for(payload);
  if (tag === 'array' && value.length === 2 && Array.isArray(payload))
    return payload.map((item) => decode(item, depth + 1));
  if (tag === 'object' && value.length === 2 && Array.isArray(payload)) {
    const result = {};
    for (const pair of payload) {
      if (!Array.isArray(pair) || pair.length !== 2)
        throw new TypeError('Invalid IPC object entry.');
      const key = decode(pair[0], depth + 1);
      if (
        !['string', 'symbol'].includes(typeof key) ||
        Object.hasOwn(result, key)
      )
        throw new TypeError('Invalid or duplicate IPC property.');
      Object.defineProperty(result, key, {
        value: decode(pair[1], depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  throw new TypeError('Invalid PandamStyle IPC data tag.');
}

module.exports = { encode, decode };
