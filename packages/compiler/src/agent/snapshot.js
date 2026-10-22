/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { types as utilTypes } from 'node:util';

/**
 * AG-01.1 input pipeline (T7, I6).
 *
 * Turns a request into frozen plain JSON data before any schema walk. Only own
 * enumerable data properties are read: an accessor is refused without being
 * invoked, and a proxy is refused before any trap could run. Every limit is
 * enforced during the walk, so an oversized request is refused before it is
 * copied. Validation and the handler then share this one snapshot.
 */

export const DEFAULT_REQUEST_LIMITS = Object.freeze({
  maxRequestBytes: 65536,
  maxDepth: 16,
  maxStringBytes: 4096,
  maxArrayItems: 512,
});

export const SNAPSHOT_REASONS = Object.freeze([
  'request-too-large',
  'too-deep',
  'string-too-long',
  'array-too-long',
  'cycle',
  'accessor',
  'non-enumerable',
  'symbol-key',
  'proxy',
  'non-plain-object',
  'sparse-array',
  'unsupported-value',
  'non-finite-number',
]);

class SnapshotRefusal {
  constructor(reason, depth) {
    this.reason = reason;
    this.depth = depth;
  }
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8');
}

export function snapshotRequest(value, limits = DEFAULT_REQUEST_LIMITS) {
  let bytes = 0;
  const ancestors = new Set();
  const charge = (amount, depth) => {
    bytes += amount;
    if (bytes > limits.maxRequestBytes)
      throw new SnapshotRefusal('request-too-large', depth);
  };

  const copy = (input, depth) => {
    if (depth > limits.maxDepth) throw new SnapshotRefusal('too-deep', depth);
    if (input === null) {
      charge(4, depth);
      return null;
    }
    switch (typeof input) {
      case 'string': {
        // Serialized bytes are at least the length: refuse before encoding.
        if (input.length > limits.maxStringBytes)
          throw new SnapshotRefusal('string-too-long', depth);
        const serialized = utf8Bytes(JSON.stringify(input));
        if (serialized - 2 > limits.maxStringBytes)
          throw new SnapshotRefusal('string-too-long', depth);
        charge(serialized, depth);
        return input;
      }
      case 'number':
        if (!Number.isFinite(input))
          throw new SnapshotRefusal('non-finite-number', depth);
        charge(String(input).length, depth);
        return input;
      case 'boolean':
        charge(input ? 4 : 5, depth);
        return input;
      case 'object':
        break;
      default:
        throw new SnapshotRefusal('unsupported-value', depth);
    }
    if (utilTypes.isProxy(input)) throw new SnapshotRefusal('proxy', depth);
    if (ancestors.has(input)) throw new SnapshotRefusal('cycle', depth);
    const isArray = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (
      isArray
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      throw new SnapshotRefusal('non-plain-object', depth);
    const keys = Reflect.ownKeys(input);
    if (isArray && input.length > limits.maxArrayItems)
      throw new SnapshotRefusal('array-too-long', depth);
    ancestors.add(input);
    charge(2, depth);
    let result;
    if (isArray) {
      // `length` is the one own non-index key an array has.
      if (keys.length !== input.length + 1)
        throw new SnapshotRefusal('sparse-array', depth);
      result = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, index);
        if (descriptor == null)
          throw new SnapshotRefusal('sparse-array', depth);
        if (!('value' in descriptor))
          throw new SnapshotRefusal('accessor', depth);
        if (index > 0) charge(1, depth);
        result.push(copy(descriptor.value, depth + 1));
      }
    } else {
      result = {};
      let first = true;
      for (const key of keys) {
        if (typeof key === 'symbol')
          throw new SnapshotRefusal('symbol-key', depth);
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!('value' in descriptor))
          throw new SnapshotRefusal('accessor', depth);
        if (!descriptor.enumerable)
          throw new SnapshotRefusal('non-enumerable', depth);
        if (key.length > limits.maxStringBytes)
          throw new SnapshotRefusal('string-too-long', depth);
        charge(utf8Bytes(JSON.stringify(key)) + 1 + (first ? 0 : 1), depth);
        first = false;
        // defineProperty, so a `__proto__` key stays plain data.
        Object.defineProperty(result, key, {
          value: copy(descriptor.value, depth + 1),
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
    }
    ancestors.delete(input);
    return Object.freeze(result);
  };

  try {
    return { ok: true, value: copy(value, 0), bytes };
  } catch (error) {
    if (error instanceof SnapshotRefusal)
      return { ok: false, reason: error.reason, depth: error.depth };
    // A stack overflow or a hostile host object: still a refusal, never a
    // partially read request.
    return { ok: false, reason: 'unsupported-value', depth: null };
  }
}
