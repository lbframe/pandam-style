/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { classifyVerdict } from '../../protocol/envelope.js';
import {
  agentPage,
  diagnosticDescription,
  envelopePage,
  pack,
  pageWindow,
  readReference,
} from './pages.js';

/**
 * `check`: the verdict of the exact current revision (§3.9, §3.10).
 *
 * The outcome is classified on the complete document before any list is
 * projected (I5). At offset 0 the result is the v1 document with prefix lists
 * and true totals; after it, an agent page that never claims to be v1.
 */
export async function check(ctx) {
  const { input, view, viewLimits, hooks } = ctx;
  const { identities, value } = await hooks.check(
    input.rev,
    {
      candidateLimit: viewLimits.candidatesPerDiagnostic,
      affectedLimit: viewLimits.affectedEntries,
    },
    ctx.beforeStart,
  );
  const document = value.document;
  const classified = classifyVerdict(document, identities);
  const rev = identities.revision;
  const total = document.diagnostics.length;
  const { offset, limit } = pageWindow(ctx);
  const packed = pack(ctx, {
    records: document.diagnostics.slice(offset, offset + limit),
    offset,
    total,
    addressOf: (index) => ({ kind: 'diagnostic', index }),
    describe: diagnosticDescription,
  });
  const references = [];
  if (packed.truncated) {
    references.push({
      operation: 'check',
      view: 'detail',
      input: { rev, page: { offset: packed.nextOffset, limit: 256 } },
    });
  }
  const withheld = [...packed.withheld];

  if (offset > 0) {
    if (withheld.length > 0)
      references.push(readReference(view, rev, withheld[0]));
    return {
      identities,
      classified,
      result: { page: agentPage('diagnostics', offset, packed, total) },
      page: envelopePage(offset, limit, packed, total),
      withheld,
      references,
    };
  }

  // The inline affected list is the v1 projection of the session's own
  // records. A withheld entry describes the record its address reads.
  const affectedRecords = value.affected.slice(0, viewLimits.affectedEntries);
  const affectedPacked = pack(ctx, {
    records: affectedRecords,
    offset: 0,
    total: document.affected.total,
    addressOf: (index) => ({ kind: 'affected', index }),
  });
  const affectedShown = document.affected.entries.slice(
    0,
    affectedPacked.returned,
  );
  withheld.push(...affectedPacked.withheld);
  if (
    affectedShown.length + affectedPacked.withheld.length <
    document.affected.total
  ) {
    references.push({
      operation: 'diagnostics.affected',
      view,
      input: {
        rev,
        page: {
          offset: affectedShown.length + affectedPacked.withheld.length,
          limit: 256,
        },
      },
    });
  }
  const truncatedCandidates = packed.records.findIndex(
    (record) => record.candidatesTruncated === true,
  );
  if (truncatedCandidates >= 0) {
    references.push({
      operation: 'diagnostics.candidates',
      view,
      input: {
        rev,
        domain: { kind: 'from-diagnostic', index: truncatedCandidates },
        page: {
          offset: packed.records[truncatedCandidates].candidates.length,
          limit: 256,
        },
      },
    });
  }
  if (withheld.length > 0)
    references.push(readReference(view, rev, withheld[0]));

  return {
    identities,
    classified,
    result: {
      document: {
        ...document,
        diagnostics: packed.records,
        diagnosticsTotal: total,
        diagnosticsTruncated: packed.returned < total,
        affected: {
          ...document.affected,
          entries: affectedShown,
          truncated: affectedShown.length < document.affected.total,
        },
      },
    },
    page: envelopePage(offset, limit, packed, total),
    withheld,
    references,
  };
}
