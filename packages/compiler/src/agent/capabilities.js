/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 capabilities (D5, T1, T2).
 *
 * A capability is a frozen object with no own data. Its authority is an entry
 * in this module-private WeakMap, so a JSON copy, a structured clone, a spread
 * copy, `Object.create(capability)` or a proxy has none, and a capability from
 * another copy of this module fails closed. Authority is never read from a
 * request, project metadata, a definition or a config value.
 */

export const GRANTS = Object.freeze([
  'consult',
  'publish',
  'mutate-sources',
  'extend-design-system',
  'materialize-audit',
  'load-config',
  'manage-session',
]);

export const DENIAL_REASONS = Object.freeze([
  'no-capability',
  'unknown-capability',
  'foreign-binding',
  'revoked',
  'missing-grant',
]);

const authorities = new WeakMap();

export function mintCapability(binding, grants) {
  if (!Array.isArray(grants) || grants.length === 0) {
    throw new TypeError('mintCapability() requires a non-empty grants list.');
  }
  for (const grant of grants) {
    // The set is closed. Only `consult` unlocks an implemented operation in
    // this build; every other grant guards a planned one.
    if (!GRANTS.includes(grant)) {
      throw new TypeError('mintCapability() received an unknown grant.');
    }
  }
  const capability = Object.freeze(Object.create(null));
  authorities.set(capability, {
    binding,
    grants: Object.freeze([...new Set(grants)]),
  });
  return capability;
}

/**
 * Returns `null` when `capability` authorizes `grant` on `binding`, or the
 * closed denial reason. `binding.revoked` is checked live, so closing the
 * session or disposing the binding revokes every capability at once.
 */
export function capabilityDenial(capability, binding, grant) {
  if (capability == null) return 'no-capability';
  if (typeof capability !== 'object') return 'unknown-capability';
  const authority = authorities.get(capability);
  if (authority == null) return 'unknown-capability';
  if (authority.binding !== binding) return 'foreign-binding';
  if (binding.revoked()) return 'revoked';
  if (!authority.grants.includes(grant)) return 'missing-grant';
  return null;
}

export function grantsOf(capability, binding) {
  if (capability == null || typeof capability !== 'object') return null;
  const authority = authorities.get(capability);
  if (authority == null || authority.binding !== binding) return null;
  return binding.revoked() ? [] : [...authority.grants];
}
