/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  agentPage,
  continuation,
  envelopePage,
  pack,
  pageWindow,
  readReference,
  rejectRequest,
} from './pages.js';

function nextReferences(ctx, operation, limit, packed, rev) {
  const references = [];
  if (packed.truncated)
    references.push(continuation(ctx, operation, packed.nextOffset, limit));
  if (packed.withheld.length > 0)
    references.push(readReference(ctx.view, rev, packed.withheld[0]));
  return references;
}

/**
 * `diagnostics.candidates`: one page of a category's public candidate domain,
 * from the current revision's own design system (§3.12). Withheld records are
 * addressed through the category enumeration, so no address depends on a
 * diagnostic or carries a category name (BV-1).
 */
export async function diagnosticsCandidates(ctx) {
  const { input, hooks } = ctx;
  const { offset, limit } = pageWindow(ctx);
  const { identities, value } = await hooks.candidates(
    input.rev,
    {
      selector: input.domain,
      offset,
      limit,
      candidateLimit: ctx.viewLimits.candidatesPerDiagnostic,
    },
    ctx.beforeStart,
  );
  if (value.rejected != null) throw rejectRequest(value.rejected);
  const domain =
    value.categoryIndex == null
      ? input.domain
      : { kind: 'category-index', index: value.categoryIndex };
  const packed = pack(ctx, {
    records: value.entries,
    offset,
    total: value.total,
    addressOf: (index) => ({ kind: 'candidate', domain, index }),
  });
  const rev = identities.revision;
  return {
    identities,
    result: {
      page: agentPage('candidates', offset, packed, value.total),
      categoriesTotal: value.categoriesTotal,
      categoryIndex: value.categoryIndex,
    },
    page: envelopePage(offset, limit, packed, value.total),
    withheld: packed.withheld,
    references: nextReferences(
      ctx,
      'diagnostics.candidates',
      limit,
      packed,
      rev,
    ),
  };
}

/** `diagnostics.affected`: the complete affected list, recomputed (§3.10). */
export async function diagnosticsAffected(ctx) {
  const { input, hooks } = ctx;
  const { offset, limit } = pageWindow(ctx);
  const { identities, value } = await hooks.affected(
    input.rev,
    { offset, limit },
    ctx.beforeStart,
  );
  const packed = pack(ctx, {
    records: value.entries,
    offset,
    total: value.total,
    addressOf: (index) => ({ kind: 'affected', index }),
  });
  const rev = identities.revision;
  return {
    identities,
    result: { page: agentPage('affected', offset, packed, value.total) },
    page: envelopePage(offset, limit, packed, value.total),
    withheld: packed.withheld,
    references: nextReferences(ctx, 'diagnostics.affected', limit, packed, rev),
  };
}
