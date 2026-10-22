/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { classifyError } from '../../protocol/envelope.js';
import {
  agentPage,
  continuation,
  envelopePage,
  pack,
  pageWindow,
  readReference,
} from './pages.js';

/**
 * AG-01.2 audit operations. `audit.compute` and `audit.read` are
 * consultations: their session hooks assign nothing. `audit.materialize` is
 * the one write, behind the `materialize-audit` grant.
 */

const checkReference = (ctx, rev) => ({
  operation: 'check',
  view: ctx.view,
  input: { rev },
});

/**
 * An unvalidated revision is refused, never validated here (AG-01.2 §3.3):
 * the refusal refers to `check`, which validates without revoking tickets.
 */
async function refusingUnvalidated(ctx, run) {
  try {
    return await run();
  } catch (error) {
    const classified = classifyError(error);
    if (classified.reason !== 'not-validated') throw error;
    return { classified, references: [checkReference(ctx, ctx.input.rev)] };
  }
}

/** The closed limitations of an audit, in their declared order (§3.3). */
function limitationsOf(value, designSystemCurrent) {
  const limitations = [];
  if (!value.ok) limitations.push('validation-failed');
  if (!designSystemCurrent) limitations.push('design-system-unavailable');
  if (value.scanFailed) limitations.push('scan-failed');
  if (value.stage === 'none') limitations.push('closure-not-computed');
  if (value.stage === 'closure-partial') limitations.push('closure-incomplete');
  if (value.stage === 'closure' || value.stage === 'closure-partial')
    limitations.push('analysis-not-run');
  if (value.stage === 'analysed' && value.unknownEntries > 0)
    limitations.push('files-not-analysed');
  if (value.summary.failed > 0) limitations.push('failed-files-without-rules');
  return limitations;
}

function completenessOf(value) {
  if (value.stage === 'none') return 'unknown';
  return value.stage === 'analysed' && value.unknownEntries === 0
    ? 'complete'
    : 'partial';
}

/**
 * `audit.compute`: the coverage audit of the validated current revision,
 * valid or not. It is not a verdict operation: it succeeds whenever it
 * describes the revision, and validity is a field of the result (TA9).
 */
export async function auditCompute(ctx) {
  const { input, view, hooks } = ctx;
  const { offset, limit } = pageWindow(ctx);
  return refusingUnvalidated(ctx, async () => {
    const { identities, value } = await hooks.auditCompute(
      input.rev,
      { offset, limit, summary: offset === 0 },
      ctx.beforeStart,
    );
    const rev = identities.revision;
    const audit =
      offset === 0
        ? {
            kind: 'pandamstyle-agent-audit',
            version: 1,
            validation: { ok: value.ok },
            coverage: {
              stage: value.stage,
              completeness: completenessOf(value),
              coveredFiles: value.coveredFiles,
              knownEntries: value.knownEntries,
              unknownEntries: value.unknownEntries,
              summary: value.summary,
            },
            limitations: limitationsOf(value, identities.designSystem != null),
            canonical: value.canonical,
          }
        : null;
    const packed = pack(ctx, {
      records: value.entries,
      offset,
      total: value.total,
      addressOf: (index) => ({ kind: 'audit-entry', index }),
    });
    const references = [];
    if (packed.truncated)
      references.push(
        continuation(ctx, 'audit.compute', packed.nextOffset, limit),
      );
    for (const entry of packed.withheld)
      references.push(readReference(view, rev, entry));
    if (audit != null && !value.ok) references.push(checkReference(ctx, rev));
    const page = agentPage('audit-entries', offset, packed, value.total);
    return {
      identities,
      result: audit == null ? { page } : { audit, page },
      page: envelopePage(offset, limit, packed, value.total),
      withheld: packed.withheld,
      references,
    };
  });
}

/**
 * `audit.read`: both audit locations, verified against the canonical document
 * by bytes. A fresh document has the content `audit.compute` describes, so the
 * result refers to it instead of returning any file's content.
 */
export async function auditRead(ctx) {
  const { input, hooks } = ctx;
  return refusingUnvalidated(ctx, async () => {
    const { identities, value } = await hooks.auditRead(
      input.rev,
      ctx.beforeStart,
    );
    return {
      identities,
      result: {
        canonical: value.canonical,
        artifacts: value.artifacts.map((artifact) => ({
          location: artifact.location,
          path: artifact.path,
          status: artifact.status,
          reason: artifact.reason,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
        })),
      },
      references: [
        {
          operation: 'audit.compute',
          view: ctx.view,
          input: {
            rev: identities.revision,
            page: { offset: 0, limit: ctx.viewLimits.pageLimit },
          },
        },
      ],
    };
  });
}

/**
 * `audit.materialize`: writes the canonical document through the anchored
 * writer and returns its receipt. The receipt attests what was verified at the
 * publication point; it confers nothing (TA7).
 */
export async function auditMaterialize(ctx) {
  const { input, hooks } = ctx;
  const { identities, value } = await hooks.auditMaterialize(
    input.rev,
    input.expectedGenerationId,
    ctx.beforeStart,
  );
  return {
    identities,
    result: {
      receiptKind: 'pandamstyle-audit-receipt',
      receiptVersion: 1,
      operation: 'audit.materialize',
      requestId: ctx.requestId ?? null,
      revision: identities.revision,
      designSystem: identities.designSystem,
      generationId: value.generationId,
      location: 'audit-directory',
      path: value.path,
      documentKind: value.documentKind,
      schemaVersion: value.schemaVersion,
      bytes: value.bytes,
      sha256: value.sha256,
      entryCount: value.entryCount,
    },
  };
}
