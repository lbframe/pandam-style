/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - numeric literals and their one canonical spelling (CE-02.2).
 *
 * A numeric literal is a JS number (`0.5`) or a CSS numeric text (`'18px'`,
 * `'50%'`, `'200ms'`). Against a numeric constraint (policy/grammar.js) it is
 * either admissible, with exactly one canonical spelling, or refused with one
 * reason:
 *
 *   non-finite          NaN or ±Infinity
 *   out-of-bounds       outside the constraint's range, or |v| > 1e6
 *   number-not-length   a non-zero unitless number on a length/time type
 *   unit-not-applicable a unit the type does not take
 *   non-integer         a fraction on <integer>
 *   precision           more than 4 fraction digits (the engine's rounding)
 *   non-canonical       admissible, but spelled differently: `canonical` holds
 *                       the one spelling
 *
 * Canonical spelling: numbers stay JS numbers on <number>/<integer>; a
 * dimension is `<number><unit>` with no `+`, no exponent, no redundant zero
 * and a lowercase unit; `-0` is `0`; the zero of a length is the unitless
 * CSS zero `'0'`; `0%` and `0s` keep their unit. A number never gets a unit.
 */

/**
 * The CSS zero, defined once. Where a domain lists the CSS zero `'0'` (a
 * length or keyword list), the numeric `0` of style objects is the same value.
 */
export const CSS_ZERO = '0';

/** The engine rounds numbers to 4 fraction digits (transform-value.js). */
export const FRACTION_DIGITS = 4;
/** The largest magnitude a numeric literal may have. */
export const MAGNITUDE = 1e6;

// A CSS numeric text: sign, digits, optional exponent, optional unit.
const NUMERIC_TEXT =
  /^([+-]?)(\d+\.?\d*|\.\d+)(?:[eE]([+-]?\d+))?([A-Za-z]+|%)?$/;

const TIME_SCALE = { s: 1, ms: 0.001 };

/** The decimal text of a finite number, without exponent, or null. */
function decimalText(value) {
  const text = String(Object.is(value, -0) ? 0 : value);
  return /e/i.test(text) ? null : text;
}

function fractionDigitsOf(value) {
  const text = decimalText(value);
  if (text == null) return Infinity;
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * The numeric reading of a literal, or null when it is not numeric:
 * `{ value, unit, number }`, where `unit` is null for a unitless value or
 * `'%'`, and `number` tells a JS number from a text.
 */
export function readNumeric(input) {
  if (typeof input === 'number') {
    return { value: input, unit: null, number: true };
  }
  if (typeof input !== 'string') return null;
  const match = NUMERIC_TEXT.exec(input.trim());
  if (match == null) return null;
  const value = Number(`${match[1]}${match[2]}e${match[3] ?? '0'}`);
  const unit = match[4] == null ? null : match[4].toLowerCase();
  return { value, unit, number: false };
}

const isLengthType = (type) =>
  type === 'length' || type === 'length-percentage';
const isNumberType = (type) => type === 'number' || type === 'integer';

/**
 * Checks one numeric reading against one constraint. Returns
 * `{ ok: true, canonical }` or `{ ok: false, reason, step }`; `step` ranks how
 * far the reading got, to pick the most specific reason among constraints.
 */
function checkReading(constraint, reading) {
  const { value, unit } = reading;
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'non-finite', step: 0 };
  }
  if (Math.abs(value) > MAGNITUDE) {
    return { ok: false, reason: 'out-of-bounds', step: 1 };
  }
  const { type } = constraint;
  let scaled = value;
  if (isNumberType(type)) {
    if (unit != null) {
      return { ok: false, reason: 'unit-not-applicable', step: 2 };
    }
  } else if (unit == null) {
    // A unitless number: only the length zero.
    if (!(isLengthType(type) && value === 0)) {
      return { ok: false, reason: 'number-not-length', step: 2 };
    }
  } else if (!constraint.units.includes(unit)) {
    return { ok: false, reason: 'unit-not-applicable', step: 2 };
  } else if (type === 'time') {
    scaled = value * TIME_SCALE[unit];
  }
  if (constraint.integer && !Number.isInteger(value)) {
    return { ok: false, reason: 'non-integer', step: 3 };
  }
  if (fractionDigitsOf(value) > FRACTION_DIGITS) {
    return { ok: false, reason: 'precision', step: 4 };
  }
  if (
    (constraint.min != null && scaled < constraint.min) ||
    (constraint.max != null && scaled > constraint.max)
  ) {
    return { ok: false, reason: 'out-of-bounds', step: 5 };
  }
  const digits = decimalText(value);
  let canonical;
  if (isNumberType(type)) canonical = Object.is(value, -0) ? 0 : value;
  else if (value === 0 && (unit == null || isLengthType(type)) && unit !== '%')
    canonical = CSS_ZERO;
  else canonical = `${digits}${unit}`;
  return { ok: true, canonical };
}

/**
 * Checks a literal against the numeric constraints of a property. Returns
 * null when the literal is not numeric or there is no constraint; otherwise
 * `{ ok: true, canonical }` (the input may still be spelled differently:
 * compare with `isCanonicalSpelling`) or `{ ok: false, reason }`.
 */
export function checkNumericLiteral(constraints, input) {
  if (constraints == null || constraints.length === 0) return null;
  const reading = readNumeric(input);
  if (reading == null) return null;
  let best = null;
  for (const constraint of constraints) {
    const result = checkReading(constraint, reading);
    if (result.ok) return result;
    if (best == null || result.step > best.step) best = result;
  }
  return { ok: false, reason: best.reason };
}

/**
 * Whether `input` is the canonical spelling `canonical`. The CSS zero is one
 * value: numeric `0` and `'0'` are both its canonical spelling.
 */
export function isCanonicalSpelling(input, canonical) {
  if (input === canonical) return true;
  return canonical === CSS_ZERO && input === 0;
}

/**
 * The numeric facts of one numeric component (a token's value, CE-02.2
 * §3.5) checked against constraints: the same rules as a literal, except that
 * the spelling is not checked. Returns null when admissible, else a reason.
 */
export function componentReason(constraints, component) {
  let best = null;
  for (const constraint of constraints) {
    const result = checkReading(constraint, component);
    if (result.ok) return null;
    if (best == null || result.step > best.step) best = result;
  }
  return best.reason;
}
