/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 shared schema fragments. Every string carries its source bound
 * (§3.10): identities are bounded where they enter (`createAgentBinding`, the
 * `systemId` guard), and lengths are JSON-serialized UTF-8 bytes (`schema.js`).
 */

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Serialized bounds of the identities that reach a response frame. */
export const BOUNDS = Object.freeze({
  projectId: 1024,
  rootDir: 4096,
  outDir: 4096,
  // 128 raw UTF-8 bytes (the definition guard), escaped at most six-fold.
  systemId: 768,
  requestSessionId: 64,
  category: 256,
  auditPath: 4352,
  code: 64,
  reason: 64,
  operationName: 64,
  summary: 512,
  capability: 96,
  owner: 64,
});

export const RECORD_LISTS = Object.freeze([
  'diagnostics',
  'candidates',
  'affected',
  'bootstrap',
  'operations',
]);

export const VIEWS = Object.freeze(['compact', 'detail']);

export const str = (maxLength, extra = {}) => ({
  type: 'string',
  maxLength,
  ...extra,
});
export const int = (minimum, maximum = MAX_SAFE) => ({
  type: 'integer',
  minimum,
  maximum,
});
export const bool = Object.freeze({ type: 'boolean' });
export const constant = (value) => ({ const: value });
export const enumOf = (values) => ({ type: 'string', enum: [...values] });
export const arr = (items, maxItems) => ({ type: 'array', items, maxItems });
export const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const nullable = (schema) => ({
  ...schema,
  type: [schema.type, 'null'],
});
export const oneOf = (...branches) => ({ oneOf: branches });
export const RECORD = Object.freeze({ type: 'object', format: 'record' });

export const REVISION_INPUT = obj({
  projectId: str(BOUNDS.projectId),
  sessionId: str(BOUNDS.requestSessionId),
  revisionId: int(1),
});

export const REVISION_OUTPUT = obj({
  projectId: str(BOUNDS.projectId),
  sessionId: { type: 'string', format: 'uuid' },
  revisionId: int(1),
});

export const DESIGN_SYSTEM_OUTPUT = obj({
  systemId: str(BOUNDS.systemId),
  registryDigest: { type: 'string', format: 'hex-digest' },
});

export const PAGE_INPUT = obj(
  {
    offset: int(0),
    limit: int(1, 256),
  },
  ['offset', 'limit'],
);

export const CHUNK_PAGE_INPUT = obj({
  offset: int(0),
  limit: int(1, 262144),
});

/**
 * Selects a candidate domain without depending on any other list or on an
 * unbounded key (BV-1). `category-index` addresses the revision's sorted
 * enumeration of public token categories, so every category, whatever its
 * length, is reachable whether or not a diagnostic names it.
 */
export const CANDIDATE_DOMAIN = oneOf(
  obj({
    kind: constant('category-index'),
    index: int(0),
  }),
  obj({
    kind: constant('category'),
    category: str(BOUNDS.category, { minLength: 1 }),
  }),
  obj({
    kind: constant('from-diagnostic'),
    index: int(0),
  }),
);

export const RECORD_ADDRESS = oneOf(
  obj({ kind: constant('diagnostic'), index: int(0) }),
  obj({
    kind: constant('candidate'),
    domain: CANDIDATE_DOMAIN,
    index: int(0),
  }),
  obj({ kind: constant('affected'), index: int(0) }),
  obj({ kind: constant('bootstrap'), index: int(0) }),
);

export const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

export const WITHHELD = obj(
  {
    address: RECORD_ADDRESS,
    code: str(BOUNDS.code),
    severity: enumOf(SEVERITIES),
    bytes: int(0),
    sha256: { type: 'string', format: 'sha256' },
  },
  ['address', 'bytes', 'sha256'],
);

export const AGENT_PAGE = obj({
  kind: constant('pandamstyle-agent-page'),
  list: enumOf(RECORD_LISTS),
  offset: int(0),
  records: arr(RECORD, 256),
  total: int(0),
  withheld: arr(WITHHELD, 1),
});

const V1_DESIGN_SYSTEM = obj({
  systemId: nullable(str(BOUNDS.systemId)),
  registryDigest: nullable({ type: 'string', format: 'hex-digest' }),
});

/**
 * The protocol v1 document with its frame fields closed. List items are v1
 * records, unchanged (`record`).
 */
export const V1_DOCUMENT = obj({
  documentKind: constant('pandamstyle-diagnostics-result'),
  schemaVersion: constant(1),
  revision: REVISION_OUTPUT,
  designSystem: V1_DESIGN_SYSTEM,
  abiVersion: constant(1),
  ok: bool,
  completeness: obj({
    status: enumOf(['complete', 'partial', 'unknown']),
    scope: constant('declared-project'),
    discovery: enumOf(['full-discovery', 'watcher', 'verified-explicit']),
    evidence: enumOf([
      'filesystem-scan',
      'watcher-journal',
      'host-reported-set',
    ]),
    resyncRequired: bool,
  }),
  diagnostics: arr(RECORD, 256),
  diagnosticsTotal: int(0),
  diagnosticsTruncated: bool,
  affected: obj({
    entries: arr(RECORD, 64),
    total: int(0),
    truncated: bool,
  }),
  generation: obj({
    published: bool,
    generationId: nullable(int(0)),
    artifactRevision: nullable(REVISION_OUTPUT),
    artifactDigest: nullable({ type: 'string', format: 'hex-digest' }),
    associationRevision: nullable(REVISION_OUTPUT),
  }),
  milestones: obj({
    diagnosticsReady: bool,
    generationReady: bool,
    generationCommitted: bool,
    auditReportReady: bool,
  }),
  audit: obj({
    requested: bool,
    materialized: bool,
    document: nullable(str(BOUNDS.auditPath)),
  }),
  incremental: obj({
    fullFallback: bool,
    reason: nullable(str(BOUNDS.reason)),
  }),
});
