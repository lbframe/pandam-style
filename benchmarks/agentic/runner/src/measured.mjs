/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Measured values (DESIGN.md sections 0.4 and 2.1). A value is `observed`
// only with harness integrity, or `cli-attested` integrity behind a
// demonstrated boundary (none exists today). Everything read from a CLI
// stream is at most an `estimate` with method `cli-stream-unattested`.
// Missing or ambiguous values are `unknown` with value null: this module
// never turns an absent value into 0.

export const STREAM_METHOD = 'cli-stream-unattested';

export function unknown(source = null, unit = undefined, reason = undefined) {
  return withUnit(
    { status: 'unknown', value: null, source, integrity: null, method: null },
    unit,
    reason,
  );
}

export function harnessObserved(value, source, unit = undefined) {
  if (!Number.isFinite(value))
    return unknown(source, unit, 'not a finite number');
  return withUnit(
    { status: 'observed', value, source, integrity: 'harness', method: null },
    unit,
  );
}

/**
 * A value read from a CLI stream. The stream is not attested (section 4.4),
 * so it is an estimate whatever the provenance rule says; an extra method
 * names the provenance (for example `claude-cli-api-equivalent`).
 */
export function fromStream(
  value,
  source,
  unit = undefined,
  extraMethod = null,
) {
  if (value == null || !Number.isFinite(value))
    return unknown(source, unit, 'absent from the stream');
  return withUnit(
    {
      status: 'estimate',
      value,
      source,
      integrity: 'cli-unattested',
      method: extraMethod ? `${STREAM_METHOD}+${extraMethod}` : STREAM_METHOD,
    },
    unit,
  );
}

export function estimate(value, source, method, unit = undefined, extra = {}) {
  if (method == null || method === '')
    throw new Error('an estimate needs a method');
  if (!Number.isFinite(value)) return unknown(source, unit, 'not computable');
  return withUnit(
    {
      status: 'estimate',
      value,
      source,
      integrity: extra.integrity ?? 'harness',
      method,
      ...(extra.lowerBound !== undefined
        ? { lowerBound: extra.lowerBound }
        : {}),
    },
    unit,
  );
}

function withUnit(m, unit, reason) {
  if (unit !== undefined) m.unit = unit;
  if (reason !== undefined) m.reason = reason;
  return m;
}

const RANK = { observed: 0, estimate: 1, unknown: 2 };

/**
 * Sum of measured values. Unknown if any component is unknown; the known part
 * is kept only as `lowerBound`. The status is the weakest component status.
 */
export function sumMeasured(parts, source, unit = undefined) {
  if (parts.length === 0) return unknown(source, unit, 'no components');
  const known = parts.filter((p) => p.status !== 'unknown');
  if (known.length !== parts.length) {
    const m = unknown(source, unit, 'a component is unknown');
    if (known.length > 0)
      m.lowerBound = known.reduce((acc, p) => acc + p.value, 0);
    return m;
  }
  const weakest = parts.reduce((w, p) =>
    RANK[p.status] > RANK[w.status] ? p : w,
  );
  const value = parts.reduce((acc, p) => acc + p.value, 0);
  const methods = [...new Set(parts.map((p) => p.method).filter(Boolean))];
  return withUnit(
    {
      status: weakest.status,
      value,
      source,
      integrity: weakest.integrity,
      method: methods.length > 0 ? methods.join(',') : null,
    },
    unit,
  );
}

/** Asserts the structural rules; used by tests and by the record writer. */
export function checkMeasured(m, at = 'value') {
  const errors = [];
  if (!['observed', 'estimate', 'unknown'].includes(m?.status))
    errors.push(`${at}: bad status ${m?.status}`);
  if (m.status === 'unknown' && m.value !== null)
    errors.push(`${at}: unknown with a value`);
  if (m.status !== 'unknown' && !Number.isFinite(m.value))
    errors.push(`${at}: ${m.status} without a number`);
  if (m.status === 'estimate' && !m.method)
    errors.push(`${at}: estimate without method`);
  if (
    m.status === 'observed' &&
    !['harness', 'cli-attested'].includes(m.integrity)
  )
    errors.push(`${at}: observed with integrity ${m.integrity}`);
  if (m.integrity === 'cli-attested')
    errors.push(
      `${at}: cli-attested requires a demonstrated stream boundary, which does not exist`,
    );
  return errors;
}
