/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { recordInfo } from '../../protocol/envelope.js';
import { continuation, rejectRequest } from './pages.js';

async function recordAt(ctx) {
  const { input, hooks, binding } = ctx;
  const { address } = input;
  if (address.kind === 'bootstrap') {
    // The one retained list: the binding's recorded bootstrap failure (§3.7).
    if (input.rev != null) throw rejectRequest('unexpected-revision');
    const failure = binding.bootstrapFailure();
    if (failure == null) throw rejectRequest('no-bootstrap-failure');
    if (address.index >= failure.records.length)
      throw rejectRequest('index-out-of-range');
    return {
      identities: failure.identities,
      record: failure.records[address.index],
    };
  }
  if (input.rev == null) throw rejectRequest('missing-revision');
  if (address.kind === 'diagnostic') {
    const { identities, value } = await hooks.document(
      input.rev,
      { candidateLimit: ctx.viewLimits.candidatesPerDiagnostic },
      ctx.beforeStart,
    );
    const record = value.document.diagnostics[address.index];
    if (record == null) throw rejectRequest('index-out-of-range');
    return { identities, record };
  }
  if (address.kind === 'candidate') {
    const { identities, value } = await hooks.candidates(
      input.rev,
      {
        selector: address.domain,
        offset: address.index,
        limit: 1,
        candidateLimit: ctx.viewLimits.candidatesPerDiagnostic,
      },
      ctx.beforeStart,
    );
    if (value.rejected != null) throw rejectRequest(value.rejected);
    if (value.entries.length === 0) throw rejectRequest('index-out-of-range');
    return { identities, record: value.entries[0] };
  }
  const { identities, value } = await hooks.affected(
    input.rev,
    { offset: address.index, limit: 1 },
    ctx.beforeStart,
  );
  if (value.entries.length === 0) throw rejectRequest('index-out-of-range');
  return { identities, record: value.entries[0] };
}

/**
 * `records.read`: one chunk of a record's canonical serialization (§3.10).
 * The chunk is sized to the response budget, so every read with
 * `offset < bytes` returns at least one byte.
 */
export async function recordsRead(ctx) {
  const { identities, record } = await recordAt(ctx);
  const info = recordInfo(record);
  const start = Math.min(ctx.input.page.offset, info.bytes);
  const end = Math.min(start + ctx.input.page.limit, info.bytes);
  let cost = 2;
  let stop = start;
  while (stop < end) {
    const code = info.text.charCodeAt(stop);
    const charCost = code === 34 || code === 92 ? 2 : 1;
    if (cost + charCost > ctx.budget.remaining) break;
    cost += charCost;
    stop += 1;
  }
  ctx.budget.remaining -= cost;
  const nextOffset = stop < info.bytes ? stop : null;
  return {
    identities,
    references:
      nextOffset == null
        ? []
        : [continuation(ctx, 'records.read', nextOffset, ctx.input.page.limit)],
    result: {
      chunk: info.text.slice(start, stop),
      offset: start,
      returned: stop - start,
      nextOffset,
      bytes: info.bytes,
      sha256: info.sha256,
    },
  };
}
