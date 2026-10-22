/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  AgentCodes,
  AgentError,
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
} from '../../protocol/envelope.js';
import { agentPage, envelopePage, pack, pageWindow } from './pages.js';

/**
 * One operation's description, rendered from its registry entry only (I7).
 * The detail view adds the input and output schemas, unchanged.
 */
export function describeOperation(entry, view, availability = null) {
  return {
    name: entry.name,
    status: entry.status,
    owner: entry.owner,
    summary: entry.summary,
    requires: entry.requires,
    preconditions: entry.preconditions,
    effects: entry.effects,
    errors: entry.errors.map(({ outcome, code, reasons }) => ({
      outcome,
      code,
      reasons,
    })),
    views: entry.views,
    pagination: entry.pagination,
    cancellation: entry.cancellation,
    retry: entry.retry,
    ...(availability == null ? {} : { availability }),
    ...(view === 'detail' ? { input: entry.input, output: entry.output } : {}),
  };
}

/** The tool descriptions behind `protocol.operations` (and, later, MCP). */
export function describeOperations(registry, view, { grants = null } = {}) {
  return registry.entries.map((entry) =>
    describeOperation(entry, view, availabilityOf(entry, grants)),
  );
}

function availabilityOf(entry, grants) {
  if (grants == null) return null;
  if (entry.status === 'planned') return 'planned';
  if (entry.requires.grant == null) return 'available';
  return grants.includes(entry.requires.grant) ? 'available' : 'denied';
}

export async function protocolOperations(ctx) {
  const { input, view, registry } = ctx;
  const versions = input.protocolVersions ?? [AGENT_PROTOCOL_VERSION];
  if (!versions.includes(AGENT_PROTOCOL_VERSION)) {
    throw new AgentError({
      outcome: 'unsupported-capability',
      code: AgentCodes.OPERATION_UNSUPPORTED,
      reason: 'protocol-version',
      stage: 'execution',
      capability: 'protocol-version',
    });
  }
  const names = input.names ?? null;
  if (names != null && !names.every((name) => registry.byName[name] != null)) {
    throw new AgentError({
      outcome: 'invalid-input',
      code: AgentCodes.UNKNOWN_OPERATION,
      reason: 'unknown-operation',
      stage: 'execution',
    });
  }
  const grants = ctx.grants;
  const entries = registry.entries.filter(
    (entry) => names == null || names.includes(entry.name),
  );
  const records = entries.map((entry) =>
    describeOperation(entry, view, availabilityOf(entry, grants)),
  );
  const { offset, limit } = pageWindow(ctx);
  const packed = pack(ctx, {
    records: records.slice(offset, offset + limit),
    offset,
    total: records.length,
    // Never reached: every description fits its view's record ceiling, which
    // `createRegistry` checks at load.
    addressOf: (index) => ({ kind: 'diagnostic', index }),
  });
  const viewLimits = (name) => {
    const limits = ctx.limitsOf(name);
    return {
      maxResponseBytes: limits.maxResponseBytes,
      recordCeiling: limits.recordCeiling,
      floor: limits.floor,
      frameMax: limits.frameMax,
      pageLimit: limits.pageLimit,
      candidatesPerDiagnostic: limits.candidatesPerDiagnostic,
      affectedEntries: limits.affectedEntries,
    };
  };
  return {
    identities: null,
    result: {
      protocol: AGENT_PROTOCOL,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      views: ['compact', 'detail'],
      limits: {
        stringLengthUnit: 'json-utf8-bytes',
        request: { ...registry.request },
        compact: viewLimits('compact'),
        detail: viewLimits('detail'),
      },
      vocabularies: ctx.vocabularies,
      granted: grants,
      page: agentPage('operations', offset, packed, records.length),
    },
    page: envelopePage(offset, limit, packed, records.length),
    withheld: packed.withheld,
    references: packed.truncated
      ? [
          {
            operation: 'protocol.operations',
            view,
            input: { page: { offset: packed.nextOffset, limit: 256 } },
          },
        ]
      : [],
  };
}
