/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Declaration classification for CE-00.2.
//
// classifyAlpha1() reconstructs the recovered consumer measurement: it asks
// the Alpha 1 property policy module, by its own exported functions, how each
// declaration is admitted. Its buckets and coercions follow the recovered
// script exactly so that the reported 343 and 1,559 baselines can be
// recalibrated. accountRegistry() is separate: it binds each declaration to
// its CE-00.1 registry entry and proof fixture. Neither result says anything
// about rendered behavior; that is a separate proof gate.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isColor } from './css-colors.mjs';
import { sha256 } from './declarations.mjs';

export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// The Alpha 1 policy module that the recovered measurement imported. Its Git
// blob is identical at f3e88039 (the commit the consumer session used),
// 415e0553 (source baseline) and 943adf7f (CE-00.1).
export const ALPHA1_POLICY = Object.freeze({
  path: 'packages/compiler/src/design-system/policy/properties.js',
  gitBlob: '7c7a6cad5baf7d8e0c67f018fb8d7d2156a1afc0',
  sha256: 'f3427cc540f2b9a0fabdcf0af638fc8367ae88eb1bf7658ede0a6d0357470540',
});

// Loads the policy module from exactly the bytes that were digested, so the
// evaluated code is the pinned code. The module has no imports.
export async function loadAlpha1Policy(
  file = path.join(REPO, ALPHA1_POLICY.path),
) {
  const bytes = fs.readFileSync(file);
  const digest = sha256(bytes);
  if (digest !== ALPHA1_POLICY.sha256) {
    throw new Error(
      `${file} has SHA-256 ${digest}, not the calibrated Alpha 1 policy ` +
        `${ALPHA1_POLICY.sha256}. Extract the pinned blob with ` +
        `\`git cat-file blob ${ALPHA1_POLICY.gitBlob} > alpha1-policy.js\` ` +
        'and pass it with --policy.',
    );
  }
  const url = `data:text/javascript;base64,${bytes.toString('base64')}`;
  const policy = await import(url);
  return { policy, identity: { ...ALPHA1_POLICY } };
}

// The recovered script converted names with this exact expression, so a
// vendor-prefixed name becomes e.g. `WebkitUserSelect`.
export const camel = (property) =>
  property.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export const ALPHA1_OUTCOMES = Object.freeze([
  'expressible',
  'composite-rewrite',
  'gap',
]);

/**
 * Alpha 1 classification of one baseline declaration.
 *
 * bucket: category | structural-ok | structural-forbidden | composite |
 *   unsupported (the recovered script's five tallies)
 * outcome: expressible (category + structural-ok), composite-rewrite, or gap
 * gapKind: absent-property (unsupported) or out-of-domain
 *   (structural-forbidden)
 * numericCoercion: the declaration is expressible only because the recovered
 *   script retried the CSS text as a JavaScript number
 */
export function classifyAlpha1(record, policy) {
  const property = camel(record.property);
  const value = record.value;
  const kind = policy.propertyKind(property);
  let bucket;
  let numericCoercion = false;
  if (kind === 'category') bucket = 'category';
  else if (kind === 'composite-form') bucket = 'composite';
  else if (kind === 'unsupported') bucket = 'unsupported';
  else if (policy.structuralAllowed(property, value)) bucket = 'structural-ok';
  else if (policy.structuralAllowed(property, Number(value))) {
    bucket = 'structural-ok';
    numericCoercion = true;
  } else bucket = 'structural-forbidden';
  const outcome =
    bucket === 'category' || bucket === 'structural-ok'
      ? 'expressible'
      : bucket === 'composite'
        ? 'composite-rewrite'
        : 'gap';
  const gapKind =
    bucket === 'unsupported'
      ? 'absent-property'
      : bucket === 'structural-forbidden'
        ? 'out-of-domain'
        : null;
  return {
    policyKind: kind,
    category: policy.propertyCategory(property),
    bucket,
    outcome,
    gapKind,
    numericCoercion,
  };
}

// Longhands reset by the five Alpha 1 composite forms (CSS Backgrounds 3,
// Fonts 4, Animations 1, Transitions 1). Used to account for every composite
// declaration at property level; value-level rewriting is not inferred.
export const COMPOSITE_LONGHANDS = Object.freeze({
  background: [
    'background-color',
    'background-image',
    'background-position',
    'background-size',
    'background-repeat',
    'background-attachment',
    'background-origin',
    'background-clip',
  ],
  border: [
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'border-top-style',
    'border-right-style',
    'border-bottom-style',
    'border-left-style',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'border-image',
  ],
  font: [
    'font-style',
    'font-variant',
    'font-weight',
    'font-stretch',
    'font-size',
    'line-height',
    'font-family',
  ],
  animation: [
    'animation-name',
    'animation-duration',
    'animation-timing-function',
    'animation-delay',
    'animation-iteration-count',
    'animation-direction',
    'animation-fill-mode',
    'animation-play-state',
  ],
  transition: [
    'transition-property',
    'transition-duration',
    'transition-timing-function',
    'transition-delay',
    'transition-behavior',
  ],
});

// A background whose whole value is one <color> rewrites to background-color;
// the shorthand also resets the other background longhands to their initial
// values, which background-color alone leaves untouched. `var(--x)` counts as
// a color only when every declaration of --x in the same stylesheet is one.
// Anything else, `background: none` included (it resets background-image to
// none and background-color to transparent), needs the full longhand reset.
export function backgroundBasis(value, customProperties) {
  if (isColor(value)) return 'color';
  const reference = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (reference != null) {
    const values = customProperties.get(reference[1]) ?? [];
    if (values.length > 0 && values.every((v) => isColor(v)))
      return 'custom-property-color';
    return 'unresolved-custom-property';
  }
  if (value.trim().toLowerCase() === 'none') return 'none-keyword';
  return 'other';
}

export function compositeAccounting(record, policy, customProperties) {
  const longhands = COMPOSITE_LONGHANDS[record.property];
  if (longhands == null) return null;
  const basis =
    record.property === 'background'
      ? backgroundBasis(record.value, customProperties)
      : 'other';
  const colorOnly = basis === 'color' || basis === 'custom-property-color';
  const minimal = colorOnly ? ['background-color'] : longhands;
  const kinds = Object.fromEntries(
    minimal.map((name) => [name, policy.propertyKind(camel(name))]),
  );
  return {
    rewrite: colorOnly ? 'background-color-only' : 'full-longhand-reset',
    basis,
    longhands: minimal,
    longhandsNotAdmitted: minimal.filter((n) => kinds[n] === 'unsupported'),
  };
}

// Custom-property values of one stylesheet, for composite accounting.
export function customPropertyValues(records) {
  const out = new Map();
  for (const r of records) {
    if (!r.property.startsWith('--')) continue;
    if (!out.has(r.property)) out.set(r.property, []);
    out.get(r.property).push(r.value);
  }
  return out;
}

// Registry binding. Custom properties bind to the `custom-property` system
// resource; descriptors bind by name when the inventory has the name.
export function accountRegistry(record, registryByName) {
  const name = record.property.startsWith('--')
    ? 'custom-property'
    : record.property;
  const entry = registryByName.get(name);
  if (entry == null) {
    return {
      entry: null,
      unregisteredReason:
        record.context.descriptor != null
          ? `${record.context.descriptor}-descriptor-not-in-inventory`
          : 'not-in-research-inventory',
    };
  }
  return {
    entry: entry.name,
    requirement: entry.requirement,
    fixtureId: entry.proof.fixtureId,
    ...(record.context.descriptor != null
      ? { descriptorOf: record.context.descriptor }
      : {}),
  };
}

export function loadRegistry() {
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
      'utf8',
    ),
  );
  return {
    version: registry.registryVersion,
    byName: new Map(registry.entries.map((e) => [e.name, e])),
  };
}

// Boundary annotations: places where the calibrated Alpha 1 outcome is a
// coarse statement rather than proof that the declaration is reproducible.
export function boundaryFlags(record, alpha1) {
  const flags = [];
  const c = record.context;
  const state = c.state ?? {};
  if (alpha1?.numericCoercion) flags.push('numeric-coercion');
  if (c.descriptor) flags.push(`${c.descriptor}-descriptor`);
  if (/^-[a-z]+-/.test(record.property)) flags.push('vendor-prefixed');
  if (record.important) flags.push('important-ignored');
  if (
    (c.atRules ?? []).some((a) => a !== '@font-face') ||
    (state.pseudoClasses ?? []).some((p) => p !== ':root') ||
    state.attributes != null ||
    state.redactedAttributes != null
  )
    flags.push('conditional-context-not-checked');
  if (state.pseudoElements != null) flags.push('pseudo-element-not-checked');
  if (alpha1?.bucket === 'category' && !/var\(--/.test(record.value))
    flags.push('raw-value-needs-token');
  return flags;
}

export function tally(records, key) {
  const out = {};
  for (const r of records) {
    const k = key(r);
    if (k == null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort());
}
