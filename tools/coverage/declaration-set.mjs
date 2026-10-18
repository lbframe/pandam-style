/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Builds and re-derives a declaration set: the publishable record of one
// measured stylesheet. Extraction runs once against the (possibly private)
// stylesheet; everything after the raw record fields is derived here, so the
// committed set can be re-derived and compared without the private input.

import {
  PARSER,
  extractDeclarations,
  redactValue,
  sha256,
} from './declarations.mjs';
import {
  accountRegistry,
  boundaryFlags,
  classifyAlpha1,
  compositeAccounting,
  tally,
} from './classify.mjs';

// Raw fields come from extraction and redaction; the rest is derived.
export const RAW_FIELDS = Object.freeze([
  'id',
  'location',
  'property',
  'value',
  'important',
  'context',
  'denominator',
  'excludedReason',
  'redactions',
]);

// Raw records omit default members; normalize() restores them for derivation.
export function normalizeRaw(raw) {
  return {
    ...raw,
    important: raw.important === true,
    excludedReason: raw.excludedReason ?? null,
    redactions: raw.redactions ?? [],
  };
}

export function compactRaw(raw) {
  const out = {};
  for (const key of RAW_FIELDS) {
    const value = raw[key];
    if (value == null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export function deriveRecord(raw, policy, registryByName) {
  const record = normalizeRaw(raw);
  const inBaseline = record.denominator === 'alpha1-baseline';
  const alpha1 = inBaseline ? classifyAlpha1(record, policy) : null;
  const composite = compositeAccounting(record, policy);
  const flags = boundaryFlags(record, alpha1);
  return {
    ...compactRaw(record),
    ...(alpha1 == null
      ? {}
      : {
          alpha1: {
            bucket: alpha1.bucket,
            outcome: alpha1.outcome,
            ...(alpha1.gapKind ? { gapKind: alpha1.gapKind } : {}),
          },
        }),
    ...(composite == null ? {} : { composite }),
    registry: accountRegistry(record, registryByName),
    ...(flags.length === 0 ? {} : { flags }),
  };
}

export function countSet(records) {
  const baseline = records.filter((r) => r.alpha1 != null);
  const byOutcome = tally(baseline, (r) => r.alpha1.outcome);
  const gaps = tally(baseline, (r) => r.alpha1.gapKind ?? null);
  return {
    all: records.length,
    baseline: baseline.length,
    byOutcome,
    byGapKind: gaps,
    byBucket: tally(baseline, (r) => r.alpha1.bucket),
    excluded: tally(records, (r) => r.excludedReason),
    baselineFlags: tally(
      baseline.flatMap((r) => (r.flags ?? []).map((f) => ({ f }))),
      (x) => x.f,
    ),
    compositeRewrites: tally(
      baseline.filter((r) => r.composite != null),
      (r) =>
        r.composite.longhandsNotAdmitted.length === 0
          ? `${r.composite.rewrite}/all-longhands-admitted`
          : `${r.composite.rewrite}/some-longhands-not-admitted`,
    ),
    registryRequirement: tally(
      records,
      (r) =>
        r.registry.requirement ??
        `unregistered:${r.registry.unregisteredReason}`,
    ),
    registryEntries: new Set(
      records.map((r) => r.registry.entry).filter(Boolean),
    ).size,
    redactions: tally(
      records.flatMap((r) => r.redactions ?? []),
      (x) => x.kind,
    ),
  };
}

export function deriveSet(header, rawRecords, policy, registry) {
  const declarations = rawRecords.map((raw) =>
    deriveRecord(raw, policy, registry.byName),
  );
  return {
    ...header,
    registryVersion: registry.version,
    counts: countSet(declarations),
    declarations,
  };
}

/**
 * Extracts, redacts and derives a set from stylesheet text. Fails if any
 * redaction would change an Alpha 1 classification.
 */
export function extractSet({
  css,
  inputId,
  sourcePath,
  baselineLayer = null,
  header,
  policy,
  registry,
}) {
  const extracted = extractDeclarations(css, { baselineLayer, sourcePath });
  const width = String(extracted.length).length;
  const rawRecords = extracted.map((r) => {
    const { value, redactions } = redactValue(r.value);
    const raw = {
      id: `${inputId}#${String(r.ordinal + 1).padStart(width, '0')}`,
      location: r.location,
      property: r.property,
      value,
      important: r.important,
      context: r.context,
      denominator: r.denominator,
      excludedReason: r.excludedReason,
      redactions,
    };
    if (raw.denominator === 'alpha1-baseline' && redactions.length > 0) {
      const before = classifyAlpha1(r, policy);
      const after = classifyAlpha1(raw, policy);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(
          `${raw.id}: redaction changes the Alpha 1 classification of ${r.property}`,
        );
      }
    }
    return raw;
  });
  return deriveSet(
    {
      ...header,
      inputId,
      input: {
        sha256: sha256(css),
        bytes: Buffer.byteLength(css),
        ...(header.input ?? {}),
      },
      extraction: {
        parser: { ...PARSER },
        command: 'node tools/coverage/cli.mjs extract',
        baselineLayer,
        denominatorRule:
          'Alpha 1 baseline: every declaration except custom properties and declarations inside @keyframes' +
          (baselineLayer ? `, restricted to @layer ${baselineLayer}` : '') +
          '. Excluded declarations stay in the set with their reason.',
        selectorPolicy:
          'Selectors are not published; only pseudo-classes, pseudo-elements and allow-listed state attribute names are kept.',
        redactionPolicy:
          'url(), non-empty quoted strings, e-mail addresses, URIs, long opaque tokens and non-ASCII text are replaced by a placeholder carrying the SHA-256 of the removed text.',
      },
    },
    rawRecords,
    policy,
    registry,
  );
}

// One declaration per line keeps large sets reviewable in diffs.
export function serializeSet(set) {
  const { declarations, ...header } = set;
  const head = JSON.stringify({ ...header, declarations: [] }, null, 2);
  const body = declarations.map((d) => `    ${JSON.stringify(d)}`).join(',\n');
  return `${head.replace(/"declarations": \[\]\n\}$/, `"declarations": [\n${body}\n  ]\n}`)}\n`;
}
