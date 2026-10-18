/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Flattens design-system definition data (as produced by the sandbox, with
// token references encoded as `{ $pmsTokenRef }`) into comparable entries
// such as `token:colors.status.warning` or `variant:badge.status.warning`.

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function flattenDefinition(definition) {
  const out = {};
  const tokens = (node, prefix) => {
    for (const [key, value] of Object.entries(node ?? {})) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (
        value != null &&
        typeof value === 'object' &&
        ('value' in value || 'ref' in value)
      ) {
        out[`token:${p}`] = stable(value);
      } else if (value != null && typeof value === 'object') {
        tokens(value, p);
      }
    }
  };
  out['system:id'] = stable(definition?.systemId ?? null);
  tokens(definition?.tokens, '');
  for (const [name, value] of Object.entries(definition?.conditions ?? {}))
    out[`condition:${name}`] = stable(value);
  for (const [name, value] of Object.entries(definition?.themes ?? {}))
    out[`theme:${name}`] = stable(value);
  for (const [id, recipe] of Object.entries(definition?.recipes ?? {})) {
    out[`recipe:${id}`] = stable(recipe?.base ?? null);
    for (const slot of recipe?.slots ?? [])
      out[`slot:${id}.${slot}`] = stable(true);
    for (const [axis, branches] of Object.entries(recipe?.variants ?? {})) {
      for (const [value, branch] of Object.entries(branches ?? {}))
        out[`variant:${id}.${axis}.${value}`] = stable(branch);
    }
    for (const [axis, value] of Object.entries(recipe?.defaultVariants ?? {}))
      out[`default:${id}.${axis}`] = stable(value);
    (recipe?.compoundVariants ?? []).forEach((compound, i) => {
      out[`compound:${id}#${i}`] = stable(compound);
    });
  }
  return out;
}
