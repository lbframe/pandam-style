/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// The one derivation of a repetition's `contested` status (DESIGN.md
// section 5.3), shared by the matrix (outcomes.json, resume, the record's
// `integrity.contested`) and the report, so the two can never disagree.

/**
 * A repetition is contested when its attempt history holds an attempt that
 * consumed infrastructure (any `infrastructure` class, retried or halting,
 * rate limits included) or an attempt directory without a record (a crash
 * or an aborted provider start). Cancelled attempts do not count.
 *
 * @param {{records: object[], crashed: number}} history
 */
export function repetitionContested({ records, crashed }) {
  return (
    crashed > 0 || records.some((r) => r.outcome.class === 'infrastructure')
  );
}
