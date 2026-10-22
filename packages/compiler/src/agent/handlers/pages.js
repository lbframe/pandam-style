/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AgentCodes,
  AgentError,
  packRecords,
} from '../../protocol/envelope.js';

export const PAGE_KIND = 'pandamstyle-agent-page';

/** A rejection the session hook returned as data, as `invalid-input`. */
export function rejectRequest(reason) {
  return new AgentError({
    outcome: 'invalid-input',
    code: AgentCodes.INVALID_REQUEST,
    reason,
    stage: 'execution',
  });
}

/** The effective page window of a paginated list request. */
export function pageWindow(ctx) {
  const limit = Math.min(
    ctx.input.page?.limit ?? ctx.viewLimits.pageLimit,
    ctx.viewLimits.pageLimit,
  );
  return { offset: ctx.input.page?.offset ?? 0, limit };
}

/** Packs one list into the remaining budget of the response. */
export function pack(ctx, { records, offset, total, addressOf, describe }) {
  const packed = packRecords({
    records,
    offset,
    total,
    ceiling: ctx.viewLimits.recordCeiling,
    budget: ctx.budget.remaining,
    addressOf,
    describe,
  });
  ctx.budget.remaining -= packed.used;
  return packed;
}

export function agentPage(list, offset, packed, total) {
  return {
    kind: PAGE_KIND,
    list,
    offset,
    records: packed.records,
    total,
    withheld: packed.withheld,
  };
}

export function envelopePage(offset, limit, packed, total) {
  return {
    offset,
    limit,
    returned: packed.returned,
    nextOffset: packed.nextOffset,
    total,
    truncated: packed.truncated,
  };
}

/** The `records.read` reference for a withheld record, at offset 0. */
export function readReference(view, rev, withheld) {
  return {
    operation: 'records.read',
    view,
    input: {
      rev,
      address: withheld.address,
      page: { offset: 0, limit: 262144 },
    },
  };
}

export function diagnosticDescription(record) {
  const out = {};
  if (typeof record?.code === 'string' && record.code.length <= 64)
    out.code = record.code;
  if (['error', 'warning', 'info'].includes(record?.severity))
    out.severity = record.severity;
  return out;
}
