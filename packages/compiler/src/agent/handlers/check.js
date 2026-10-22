/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { classifyVerdict } from '../../protocol/envelope.js';
import {
  agentPage,
  continuation,
  diagnosticDescription,
  envelopePage,
  pack,
  pageWindow,
  readReference,
} from './pages.js';

/**
 * The candidate domain of the first shown diagnostic whose candidates are
 * truncated, by its index in the complete list, among the records the page
 * covers, shown or withheld (R3).
 * It starts at offset 0: the v1 record orders its candidate prefix by name,
 * the domain by declaration, so the prefix length is no offset into it.
 */
function candidateReference(ctx, rev, covered, offset) {
  const index = covered.findIndex(
    (record) => record.candidatesTruncated === true,
  );
  if (index < 0) return [];
  return [
    {
      operation: 'diagnostics.candidates',
      view: ctx.view,
      input: {
        rev,
        domain: { kind: 'from-diagnostic', index: offset + index },
        page: { offset: 0, limit: ctx.viewLimits.pageLimit },
      },
    },
  ];
}

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
  if (packed.truncated)
    references.push(continuation(ctx, 'check', packed.nextOffset, limit));
  const withheld = [...packed.withheld];

  if (offset > 0) {
    references.push(
      ...candidateReference(
        ctx,
        rev,
        document.diagnostics.slice(
          offset,
          offset + packed.returned + packed.withheld.length,
        ),
        offset,
      ),
    );
    for (const entry of withheld)
      references.push(readReference(view, rev, entry));
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
          limit: viewLimits.pageLimit,
        },
      },
    });
  }
  references.push(
    ...candidateReference(
      ctx,
      rev,
      document.diagnostics.slice(
        offset,
        offset + packed.returned + packed.withheld.length,
      ),
      offset,
    ),
  );
  // Every withheld record of every list gets its own reference (R3).
  for (const entry of withheld)
    references.push(readReference(view, rev, entry));

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
