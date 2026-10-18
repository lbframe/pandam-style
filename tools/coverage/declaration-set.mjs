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
import { PUBLIC_DIGESTER } from './digest.mjs';
import { policeRecord } from './publication.mjs';
import {
  accountRegistry,
  boundaryFlags,
  classifyAlpha1,
  compositeAccounting,
  customPropertyValues,
  tally,
} from './classify.mjs';

// Raw fields come from extraction and redaction; the rest is derived.
export const RAW_FIELDS = Object.freeze([
  'id',
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

export function deriveRecord(raw, policy, registryByName, customProperties) {
  const record = normalizeRaw(raw);
  const inBaseline = record.denominator === 'alpha1-baseline';
  const alpha1 = inBaseline ? classifyAlpha1(record, policy) : null;
  const composite = compositeAccounting(record, policy, customProperties);
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
  const customProperties = customPropertyValues(rawRecords);
  const declarations = rawRecords.map((raw) =>
    deriveRecord(raw, policy, registry.byName, customProperties),
  );
  return {
    ...header,
    registryVersion: registry.version,
    counts: countSet(declarations),
    declarations,
  };
}

/**
 * Extracts, redacts and derives a set from stylesheet text. With `approved`
 * (an approved-identifier map) the consumer identifier policy is applied too.
 * Fails if any redaction would change an Alpha 1 classification or a
 * composite accounting. Returns the set and the private position map
 * (ordinal id to line and column), which is never part of the set.
 */
export function extractSet({
  css,
  inputId,
  baselineLayer = null,
  header,
  policy,
  registry,
  approved = null,
  digester = PUBLIC_DIGESTER,
}) {
  const extracted = extractDeclarations(css, { baselineLayer, digester });
  const width = Math.max(3, String(extracted.length).length);
  const positions = [];
  const plain = [];
  const rawRecords = extracted.map((r) => {
    const id = `${inputId}#${String(r.ordinal + 1).padStart(width, '0')}`;
    positions.push({ id, ...r.position });
    const base = {
      id,
      property: r.property,
      value: r.value,
      important: r.important,
      context: r.context,
      denominator: r.denominator,
      excludedReason: r.excludedReason,
      redactions: [],
    };
    plain.push(base);
    const { value, redactions } = redactValue(r.value, digester);
    const redacted = { ...base, value, redactions };
    return approved == null
      ? redacted
      : policeRecord(redacted, approved, digester, registry.byName);
  });
  const derive = (records) =>
    deriveSet({}, records, policy, registry).declarations.map((d) =>
      JSON.stringify([d.alpha1 ?? null, d.composite ?? null]),
    );
  const before = derive(plain);
  derive(rawRecords).forEach((after, i) => {
    if (after !== before[i])
      throw new Error(
        `${rawRecords[i].id}: redaction changes the classification of ${plain[i].property}`,
      );
  });
  const set = deriveSet(
    {
      ...header,
      inputId,
      input: {
        sha256: sha256(css),
        bytes: Buffer.byteLength(css),
        ...(header.input ?? {}),
        positionMapSha256: sha256(serializePositions(positions)),
      },
      extraction: extractionHeader(baselineLayer, digester),
    },
    rawRecords,
    policy,
    registry,
  );
  return { set, positions };
}

// Closed vocabularies of the set header. Their meaning is documented in
// tests/core-evolution/corpus/calibration/README.md, never in the records.
export const BASELINE_LAYERS = Object.freeze([null, 'utilities']);
export const EXTRACTION_RULES = Object.freeze({
  denominator: { null: 'CE-DEN-01', utilities: 'CE-DEN-02' },
  selectors: 'CE-SEL-01',
  redaction: 'CE-RED-01',
});

/** The extraction header of a set; the validator recomputes and compares it. */
export function extractionHeader(baselineLayer, digester) {
  if (!BASELINE_LAYERS.includes(baselineLayer))
    throw new Error(
      `baseline layer must be one of ${BASELINE_LAYERS.join(', ')}`,
    );
  return {
    parser: { ...PARSER },
    baselineLayer,
    rules: {
      denominator: EXTRACTION_RULES.denominator[String(baselineLayer)],
      selectors: EXTRACTION_RULES.selectors,
      redaction: EXTRACTION_RULES.redaction,
    },
    redactionDigest: {
      scheme: digester.scheme,
      ...(digester.keyFingerprint
        ? { keyFingerprint: digester.keyFingerprint }
        : {}),
    },
  };
}

// The private position map: kept outside the repository with the private
// inputs; only its digest is published.
export function serializePositions(positions) {
  return `${JSON.stringify(positions)}\n`;
}

// One declaration per line keeps large sets reviewable in diffs.
export function serializeSet(set) {
  const { declarations, ...header } = set;
  const head = JSON.stringify({ ...header, declarations: [] }, null, 2);
  const body = declarations.map((d) => `    ${JSON.stringify(d)}`).join(',\n');
  return `${head.replace(/"declarations": \[\]\n\}$/, `"declarations": [\n${body}\n  ]\n}`)}\n`;
}
