/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Codes } from '../protocol/diagnostics.js';
import {
  AgentCodes,
  AGENT_PROTOCOL,
  AGENT_PROTOCOL_VERSION,
  OUTCOMES,
  RETRY_HINTS,
  STAGES,
} from '../protocol/envelope.js';
import { DENIAL_REASONS, GRANTS } from './capabilities.js';
import { HANDLERS } from './handlers/index.js';
import { describeOperation } from './handlers/operations.js';
import { recordInfo } from '../protocol/envelope.js';
import { compileSchema, maxJsonBytes } from './schema.js';
import {
  AGENT_PAGE,
  arr,
  bool,
  BOUNDS,
  CANDIDATE_DOMAIN,
  CHUNK_PAGE_INPUT,
  constant,
  DESIGN_SYSTEM_OUTPUT,
  enumOf,
  int,
  nullable,
  obj,
  PAGE_INPUT,
  RECORD_ADDRESS,
  REVISION_INPUT,
  REVISION_OUTPUT,
  str,
  V1_DOCUMENT,
  VIEWS,
  WITHHELD,
} from './schemas.js';
import { DEFAULT_REQUEST_LIMITS, SNAPSHOT_REASONS } from './snapshot.js';

/**
 * AG-01.1 operation registry: the only description of an operation (I7).
 *
 * Runtime validation interprets these schemas, `codegen.js` renders their
 * types, and `describeOperations` (behind `protocol.operations`) renders their
 * descriptions. `createRegistry` refuses, at module load, any entry that
 * breaks a rule of §3.2.3, planned or implemented alike (I12).
 */

export const EFFECT_KINDS = Object.freeze([
  'reads-registry',
  'reads-sources',
  'reads-generated',
  'computes',
  'session-state',
  'session-lifecycle',
  'schedules',
  'writes-generated',
  'writes-audit',
  'writes-sources',
  'executes-config',
]);

export const EFFECT_DETAILS = Object.freeze({
  'session-state': Object.freeze([
    'records-validation-verdict',
    'binds-client',
    'revokes-publication-tickets',
    'advances-revision',
    'stages-audit',
  ]),
  'session-lifecycle': Object.freeze([
    'opens-session',
    'acquires-output-lease',
    'closes-session',
    'releases-output-lease',
  ]),
});

const CONSULT_EFFECTS = Object.freeze([
  'reads-registry',
  'reads-sources',
  'reads-generated',
  'computes',
  'session-state:records-validation-verdict',
  'session-state:binds-client',
]);

const MUTATE_EFFECTS = Object.freeze([
  ...CONSULT_EFFECTS,
  'writes-sources',
  'session-state:advances-revision',
  'session-state:revokes-publication-tickets',
]);

/** §3.2.2. No grant allows `session-state:stages-audit`. */
export const GRANT_EFFECTS = Object.freeze({
  none: Object.freeze(['reads-registry']),
  consult: CONSULT_EFFECTS,
  publish: Object.freeze([
    ...CONSULT_EFFECTS,
    'writes-generated',
    'session-state:revokes-publication-tickets',
  ]),
  'mutate-sources': MUTATE_EFFECTS,
  'extend-design-system': MUTATE_EFFECTS,
  'materialize-audit': Object.freeze([...CONSULT_EFFECTS, 'writes-audit']),
  'load-config': Object.freeze([
    ...CONSULT_EFFECTS,
    'executes-config',
    'session-lifecycle:opens-session',
    'session-lifecycle:acquires-output-lease',
  ]),
  'manage-session': Object.freeze([
    ...CONSULT_EFFECTS,
    'schedules',
    'session-lifecycle:closes-session',
    'session-lifecycle:releases-output-lease',
  ]),
});

/** Effects that are never retried blindly (§3.2.3 rule 6). */
const UNSAFE_RETRY_EFFECTS = Object.freeze([
  'writes-generated',
  'writes-audit',
  'writes-sources',
  'executes-config',
  'session-lifecycle',
  'session-state:advances-revision',
  'session-state:revokes-publication-tickets',
]);

/** Effects that need an operation-specific error contract (rule 5). */
const CONTRACTED_EFFECTS = Object.freeze([
  'writes-generated',
  'writes-audit',
  'writes-sources',
  'executes-config',
  'session-lifecycle',
]);

export const PRECONDITIONS = Object.freeze({
  'session-initialized': 'invalid-input',
  'revision-validated': 'invalid-input',
  'design-system-current': 'constraint-violation',
  'revision-valid': 'constraint-violation',
  'output-lease-held': 'denied-access',
});

export const SCHEMA_FAILURE_KEYWORDS = Object.freeze([
  'type',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'oneOf',
  'format',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
]);

/** `maxLength` → `schema-max-length`: reasons are kebab-case ids. */
export function schemaFailureReason(keyword) {
  return `schema-${keyword.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

export const REQUEST_FAILURE_REASONS = Object.freeze([
  ...SNAPSHOT_REASONS,
  ...SCHEMA_FAILURE_KEYWORDS.map((keyword) => schemaFailureReason(keyword)),
  'response-floor',
  'response-ceiling',
]);

const KNOWN_CODES = new Set([
  ...Object.values(Codes),
  ...Object.values(AgentCodes),
  'PMS_SESSION_INTERNAL',
]);

const VIEW_DEFAULTS = Object.freeze({
  compact: Object.freeze({
    maxResponseBytes: 262144,
    recordCeiling: 8192,
    pageLimit: 20,
    candidatesPerDiagnostic: 8,
    affectedEntries: 16,
  }),
  detail: Object.freeze({
    maxResponseBytes: 2097152,
    recordCeiling: 65536,
    pageLimit: 256,
    candidatesPerDiagnostic: 32,
    affectedEntries: 64,
  }),
});

// ------------------------------------------------------------- helpers ----

const contract = (outcome, code, reasons, covers = []) =>
  Object.freeze({
    outcome,
    code,
    reasons: Object.freeze([...reasons]),
    covers: Object.freeze([...covers]),
  });

const REVISION_IDENTITY_ERRORS = [
  contract('stale-revision', Codes.STALE_REVISION, ['revision-mismatch']),
  contract('invalid-input', Codes.INVALID_REVISION, [
    'malformed-identity',
    'foreign-identity',
  ]),
];

const NOT_VALIDATED = contract(
  'invalid-input',
  Codes.INVALID_REVISION,
  ['not-validated'],
  ['precondition:revision-validated'],
);

const DESIGN_SYSTEM_UNAVAILABLE = contract(
  'constraint-violation',
  Codes.INVALID_REVISION,
  ['design-system-unavailable'],
  ['precondition:design-system-current'],
);

const SESSION_INITIALIZED = {
  id: 'session-initialized',
  outcome: 'invalid-input',
};

/** The contracts every entry of its kind carries (§3.2.3 rule 5). */
export function universalErrors(entry) {
  const errors = [
    contract(
      'invalid-input',
      AgentCodes.INVALID_REQUEST,
      REQUEST_FAILURE_REASONS,
    ),
    contract('unsupported-capability', AgentCodes.OPERATION_UNSUPPORTED, [
      'view',
      'protocol-version',
      ...(entry.status === 'planned' ? ['planned'] : []),
    ]),
    contract('internal-error', AgentCodes.INTERNAL, [
      'unclassified',
      'output-schema-violation',
      'unbounded-failure-record',
      'response-over-ceiling',
    ]),
  ];
  if (entry.requires.grant != null)
    errors.push(
      contract('denied-access', AgentCodes.ACCESS_DENIED, DENIAL_REASONS),
    );
  if (entry.cancellation !== 'none')
    errors.push(contract('cancelled', AgentCodes.CANCELLED, ['before-start']));
  if (entry.requires.binding === 'session') {
    // A session-bound operation can meet the session's lifecycle: a close
    // racing the request, or the recorded bootstrap failure of the binding.
    errors.push(
      contract(
        'invalid-input',
        Codes.INVALID_REVISION,
        ['not-initialized', 'already-initialized'],
        ['precondition:session-initialized'],
      ),
      contract('stale-revision', Codes.SESSION_CLOSED, ['session-closed']),
      contract('denied-access', Codes.INVALID_REVISION, ['output-owned']),
      contract('constraint-violation', null, ['validation-errors']),
      contract('internal-error', 'PMS_SESSION_INTERNAL', ['compiler-fault']),
      contract('internal-error', Codes.ABI_MISMATCH, ['compiler-fault']),
      contract('internal-error', Codes.GENERATED_ARTIFACT_MISMATCH, [
        'compiler-fault',
      ]),
    );
  }
  return errors;
}

const SAFE = Object.freeze({ idempotent: true, policy: 'safe' });
const NEVER = Object.freeze({ idempotent: false, policy: 'never' });

function define(entry) {
  return {
    views: ['compact', 'detail'],
    pagination: null,
    cancellation: 'before-start',
    preconditions: [],
    ...entry,
    errors: [
      ...universalErrors({ cancellation: 'before-start', ...entry }),
      ...(entry.errors ?? []),
    ],
  };
}

const sessionEntry = (entry) =>
  define({
    ...entry,
    preconditions: [SESSION_INITIALIZED, ...(entry.preconditions ?? [])],
  });

const RECEIPT_IDENTITIES = obj({
  revision: REVISION_OUTPUT,
  designSystem: nullable(DESIGN_SYSTEM_OUTPUT),
});

const SCOPE = arr({ type: 'string', format: 'project-relative-path' }, 512);
const PROPOSAL_INPUT = {
  rev: REVISION_INPUT,
  proposalId: str(128),
  proposalDigest: { type: 'string', format: 'sha256' },
};
const NEW_REVISION_OUTPUT = obj({
  revision: REVISION_OUTPUT,
  receipt: obj({
    written: arr({ type: 'string', format: 'project-relative-path' }, 512),
    digest: { type: 'string', format: 'sha256' },
  }),
});
const PLAN_OUTPUT = obj({
  planId: str(128),
  planDigest: { type: 'string', format: 'sha256' },
  page: AGENT_PAGE,
});

const VIEW_LIMITS = obj({
  maxResponseBytes: int(1),
  recordCeiling: int(1),
  floor: int(1),
  frameMax: int(1),
  pageLimit: int(1),
  candidatesPerDiagnostic: int(0),
  affectedEntries: int(0),
});

// ------------------------------------------------------------- entries ----

const ENTRIES = [
  define({
    name: 'protocol.operations',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      'Negotiates the protocol version and describes every registered operation: status, grant, effects, error contracts, cancellation and retry; the detail view adds input and output schemas. With a capability, reports what it grants.',
    requires: { grant: null, binding: 'none', revision: 'none' },
    effects: [{ kind: 'reads-registry' }],
    input: obj(
      {
        protocolVersions: arr(int(1, 1024), 16),
        names: arr(str(BOUNDS.operationName), 64),
        page: PAGE_INPUT,
      },
      [],
    ),
    output: obj(
      {
        protocol: constant(AGENT_PROTOCOL),
        protocolVersion: constant(AGENT_PROTOCOL_VERSION),
        views: arr(enumOf(VIEWS), 2),
        limits: obj({
          stringLengthUnit: constant('json-utf8-bytes'),
          request: obj({
            maxRequestBytes: int(1),
            maxDepth: int(1),
            maxStringBytes: int(1),
            maxArrayItems: int(1),
          }),
          compact: VIEW_LIMITS,
          detail: VIEW_LIMITS,
        }),
        vocabularies: obj({
          grants: arr(enumOf(GRANTS), 16),
          effects: arr(enumOf(EFFECT_KINDS), 16),
          outcomes: arr(enumOf(OUTCOMES), 16),
          stages: arr(enumOf(STAGES), 8),
          retry: arr(enumOf(RETRY_HINTS), 8),
        }),
        granted: nullable(arr(enumOf(GRANTS), 16)),
        page: AGENT_PAGE,
      },
      [
        'protocol',
        'protocolVersion',
        'views',
        'limits',
        'vocabularies',
        'granted',
        'page',
      ],
    ),
    cancellation: 'none',
    pagination: { kind: 'offset', boundTo: 'registry' },
    errors: [
      contract('invalid-input', AgentCodes.UNKNOWN_OPERATION, [
        'unknown-operation',
      ]),
    ],
    retry: SAFE,
  }),
  define({
    name: 'session.status',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      'Reports the bound session: identities, whether it is initialized, and the last committed generation. A binding whose bootstrap failed returns that failure, as every operation does.',
    requires: { grant: 'consult', binding: 'session', revision: 'none' },
    effects: [{ kind: 'reads-registry' }],
    input: obj({}, []),
    output: obj({ initialized: bool, generationId: nullable(int(0)) }),
    errors: [],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'check',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      'Returns the validation verdict of the exact current revision as a protocol v1 document at offset 0, or an agent page of its diagnostics after. Reuses an existing verdict, so it never revokes a prepared publication.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [
      { kind: 'computes' },
      { kind: 'reads-sources' },
      { kind: 'session-state', detail: 'records-validation-verdict' },
    ],
    input: obj({ rev: REVISION_INPUT, page: PAGE_INPUT }, ['rev']),
    output: obj({ document: V1_DOCUMENT, page: AGENT_PAGE }, []),
    pagination: { kind: 'offset', boundTo: 'revision' },
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      contract('constraint-violation', null, [
        'validation-errors',
        'incomplete-validation',
        'design-system-unavailable',
      ]),
      contract('internal-error', null, ['compiler-fault']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'diagnostics.candidates',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      "Pages the public candidate domain of one token category from the current revision's own design system. The category is selected by its index in the revision's category enumeration, by name, or from a diagnostic's expected category.",
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    preconditions: [
      { id: 'design-system-current', outcome: 'constraint-violation' },
    ],
    effects: [{ kind: 'reads-registry' }],
    input: obj(
      { rev: REVISION_INPUT, domain: CANDIDATE_DOMAIN, page: PAGE_INPUT },
      ['rev', 'domain'],
    ),
    output: obj({
      page: AGENT_PAGE,
      categoriesTotal: int(0),
      categoryIndex: nullable(int(0)),
    }),
    pagination: { kind: 'offset', boundTo: 'revision' },
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      NOT_VALIDATED,
      DESIGN_SYSTEM_UNAVAILABLE,
      contract('invalid-input', AgentCodes.INVALID_REQUEST, [
        'index-out-of-range',
        'no-candidate-domain',
      ]),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'diagnostics.affected',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      'Pages the complete sorted affected list of the validated current revision, recomputed on demand: every touched, added and removed file with its role and analysis state.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    preconditions: [{ id: 'revision-validated', outcome: 'invalid-input' }],
    effects: [{ kind: 'computes' }],
    input: obj({ rev: REVISION_INPUT, page: PAGE_INPUT }, ['rev']),
    output: obj({ page: AGENT_PAGE }),
    pagination: { kind: 'offset', boundTo: 'revision' },
    errors: [...REVISION_IDENTITY_ERRORS, NOT_VALIDATED],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'records.read',
    status: 'implemented',
    owner: 'AG-01.1',
    summary:
      'Reads one record in byte chunks of its canonical serialization (JSON, non-ASCII escaped), addressed by integers at the current revision: a diagnostic, a candidate, an affected entry, or a bootstrap failure diagnostic (rev null).',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [{ kind: 'computes' }],
    input: obj({
      rev: nullable(REVISION_INPUT),
      address: RECORD_ADDRESS,
      page: CHUNK_PAGE_INPUT,
    }),
    output: obj({
      chunk: { type: 'string', format: 'chunk' },
      offset: int(0),
      returned: int(0),
      nextOffset: nullable(int(0)),
      bytes: int(0),
      sha256: { type: 'string', format: 'sha256' },
    }),
    pagination: { kind: 'offset', boundTo: 'revision' },
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      NOT_VALIDATED,
      DESIGN_SYSTEM_UNAVAILABLE,
      contract('invalid-input', AgentCodes.INVALID_REQUEST, [
        'index-out-of-range',
        'no-candidate-domain',
        'missing-revision',
        'unexpected-revision',
        'no-bootstrap-failure',
      ]),
    ],
    retry: SAFE,
  }),

  // ------------------------------------------------------- planned ------
  sessionEntry({
    name: 'publish',
    status: 'planned',
    owner: 'AG-07.3 #25',
    summary:
      'Publishes the validated candidate of the exact current revision and returns its publication receipt. A staged coverage document is part of the written generation.',
    requires: { grant: 'publish', binding: 'session', revision: 'current' },
    preconditions: [
      { id: 'revision-valid', outcome: 'constraint-violation' },
      { id: 'output-lease-held', outcome: 'denied-access' },
    ],
    effects: [
      { kind: 'computes' },
      { kind: 'writes-generated' },
      { kind: 'session-state', detail: 'revokes-publication-tickets' },
    ],
    input: obj({
      rev: REVISION_INPUT,
      candidateDigest: { type: 'string', format: 'sha256' },
    }),
    output: obj({
      generationId: int(1),
      artifactDigest: { type: 'string', format: 'hex-digest' },
      identities: RECEIPT_IDENTITIES,
    }),
    errors: [
      contract(
        'constraint-violation',
        Codes.INVALID_REVISION,
        ['revision-invalid', 'no-publishable-candidate'],
        ['precondition:revision-valid', 'effect:writes-generated'],
      ),
      contract('stale-revision', Codes.STALE_REVISION, ['candidate-changed']),
      contract(
        'denied-access',
        Codes.INVALID_REVISION,
        ['output-owned'],
        ['precondition:output-lease-held'],
      ),
    ],
    retry: NEVER,
  }),
  define({
    name: 'discover',
    status: 'planned',
    owner: 'AG-02.1 #11',
    summary:
      'Reports observed facts with their freshness: versions, hosts, roots, config files and artifacts. Config files are read as text, never executed.',
    requires: { grant: 'consult', binding: 'none', revision: 'none' },
    effects: [
      { kind: 'reads-sources' },
      { kind: 'reads-generated' },
      { kind: 'computes' },
    ],
    input: obj({
      include: arr(
        enumOf(['versions', 'hosts', 'roots', 'config-files', 'artifacts']),
        5,
      ),
    }),
    output: obj({ page: AGENT_PAGE }),
    errors: [
      contract('unsupported-capability', AgentCodes.OPERATION_UNSUPPORTED, [
        'owner-absent',
      ]),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'query',
    status: 'planned',
    owner: 'AG-04.1 #19',
    summary:
      "Ranks the current revision's design-system entities against a short text, with an explanation per match.",
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    preconditions: [
      { id: 'design-system-current', outcome: 'constraint-violation' },
    ],
    effects: [{ kind: 'reads-registry' }, { kind: 'computes' }],
    input: obj(
      {
        rev: REVISION_INPUT,
        text: str(256, { minLength: 1 }),
        kinds: arr(
          enumOf([
            'token',
            'recipe',
            'slot',
            'variant',
            'pattern',
            'condition',
            'theme',
          ]),
          7,
        ),
        page: PAGE_INPUT,
      },
      ['rev', 'text'],
    ),
    output: obj({ page: AGENT_PAGE }),
    errors: [...REVISION_IDENTITY_ERRORS, DESIGN_SYSTEM_UNAVAILABLE],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'describe',
    status: 'planned',
    owner: 'AG-03.2 #13',
    summary:
      'Returns the contract of one design-system entity of the current revision.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    preconditions: [
      { id: 'design-system-current', outcome: 'constraint-violation' },
    ],
    effects: [{ kind: 'reads-registry' }],
    input: obj({
      rev: REVISION_INPUT,
      entity: obj({
        kind: enumOf([
          'token',
          'recipe',
          'slot',
          'variant',
          'pattern',
          'condition',
          'theme',
        ]),
        id: str(1024, { minLength: 1 }),
      }),
    }),
    output: obj({ page: AGENT_PAGE }),
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      DESIGN_SYSTEM_UNAVAILABLE,
      contract('invalid-input', AgentCodes.INVALID_REQUEST, ['unknown-entity']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'context',
    status: 'planned',
    owner: 'AG-05.1 #20',
    summary:
      'Assembles a byte-budgeted context for a task over files and entities, with references and an explicit omitted list.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [
      { kind: 'reads-registry' },
      { kind: 'reads-sources' },
      { kind: 'computes' },
    ],
    input: obj({
      rev: REVISION_INPUT,
      task: obj(
        {
          files: arr({ type: 'string', format: 'project-relative-path' }, 64),
          entities: arr(str(1024), 64),
        },
        [],
      ),
      budgetBytes: int(1024, 2097152),
    }),
    output: obj({ page: AGENT_PAGE, omitted: int(0) }),
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      contract('invalid-input', AgentCodes.INVALID_REQUEST, [
        'budget-too-small',
      ]),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'impact',
    status: 'planned',
    owner: 'AG-09.1 #27',
    summary:
      'Pages the usages and consequences of changing the named entities.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [
      { kind: 'reads-registry' },
      { kind: 'reads-sources' },
      { kind: 'computes' },
    ],
    input: obj(
      { rev: REVISION_INPUT, entities: arr(str(1024), 64), page: PAGE_INPUT },
      ['rev', 'entities'],
    ),
    output: obj({ page: AGENT_PAGE }),
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      contract('invalid-input', AgentCodes.INVALID_REQUEST, ['unknown-entity']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'repair.propose',
    status: 'planned',
    owner: 'AG-07.2 #24',
    summary:
      'Proposes repairs for the named diagnostics, each verified as an isolated candidate, with a proposal id and digest. Writes nothing.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    preconditions: [{ id: 'revision-validated', outcome: 'invalid-input' }],
    effects: [{ kind: 'computes' }, { kind: 'reads-sources' }],
    input: obj(
      { rev: REVISION_INPUT, diagnostics: arr(int(0), 64), page: PAGE_INPUT },
      ['rev', 'diagnostics'],
    ),
    output: obj({ page: AGENT_PAGE }),
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      NOT_VALIDATED,
      contract('constraint-violation', null, ['no-applicable-repair']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'repair.apply',
    status: 'planned',
    owner: 'AG-07.3 #25',
    summary:
      'Applies a verified repair proposal inside the declared scope and returns the new revision and a receipt.',
    requires: {
      grant: 'mutate-sources',
      binding: 'session',
      revision: 'current',
    },
    effects: [
      { kind: 'writes-sources' },
      { kind: 'session-state', detail: 'advances-revision' },
      { kind: 'session-state', detail: 'revokes-publication-tickets' },
    ],
    input: obj({ ...PROPOSAL_INPUT, scope: SCOPE }),
    output: NEW_REVISION_OUTPUT,
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['proposal-stale']),
      contract(
        'constraint-violation',
        null,
        ['out-of-scope', 'conflict'],
        ['effect:writes-sources'],
      ),
    ],
    retry: NEVER,
  }),
  sessionEntry({
    name: 'extend.propose',
    status: 'planned',
    owner: 'AG-08.1 #26',
    summary:
      'Proposes a design-system extension under the definition policy, with a proposal id and digest. Writes nothing.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [{ kind: 'computes' }, { kind: 'reads-registry' }],
    input: obj({
      rev: REVISION_INPUT,
      request: obj({
        kind: enumOf([
          'token',
          'recipe',
          'variant',
          'pattern',
          'condition',
          'theme',
        ]),
        name: str(256, { minLength: 1 }),
        rationale: str(2048),
      }),
    }),
    output: obj({
      proposalId: str(128),
      proposalDigest: { type: 'string', format: 'sha256' },
      page: AGENT_PAGE,
    }),
    errors: [
      ...REVISION_IDENTITY_ERRORS,
      contract('constraint-violation', null, ['policy-refused']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'extend.apply',
    status: 'planned',
    owner: 'AG-08.1 #26',
    summary:
      'Applies an extension proposal to the definition module only, and returns the new revision and a receipt.',
    requires: {
      grant: 'extend-design-system',
      binding: 'session',
      revision: 'current',
    },
    effects: [
      { kind: 'writes-sources' },
      { kind: 'session-state', detail: 'advances-revision' },
      { kind: 'session-state', detail: 'revokes-publication-tickets' },
    ],
    input: obj(PROPOSAL_INPUT),
    output: NEW_REVISION_OUTPUT,
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['proposal-stale']),
      contract(
        'constraint-violation',
        null,
        ['conflict'],
        ['effect:writes-sources'],
      ),
    ],
    retry: NEVER,
  }),
  define({
    name: 'session.open',
    status: 'planned',
    owner: 'AG-02.1 #11',
    summary:
      'Opens a standalone session from a config file, which it executes under the load-config grant, and returns the binding identities or a structured bootstrap failure.',
    requires: { grant: 'load-config', binding: 'none', revision: 'none' },
    effects: [
      { kind: 'executes-config' },
      { kind: 'reads-sources' },
      { kind: 'session-lifecycle', detail: 'opens-session' },
      { kind: 'session-lifecycle', detail: 'acquires-output-lease' },
    ],
    input: obj({
      config: { type: 'string', format: 'project-relative-path' },
      mode: enumOf(['standalone']),
    }),
    output: obj({ identities: RECEIPT_IDENTITIES }),
    errors: [
      contract('invalid-input', AgentCodes.INVALID_REQUEST, [
        'config-not-found',
      ]),
      contract(
        'constraint-violation',
        null,
        ['config-threw', 'config-not-object'],
        ['effect:executes-config'],
      ),
      contract(
        'denied-access',
        Codes.INVALID_REVISION,
        ['output-owned'],
        ['effect:session-lifecycle'],
      ),
    ],
    retry: NEVER,
  }),
  define({
    name: 'session.attach',
    status: 'planned',
    owner: 'AG-02.1 #11',
    summary:
      'Attaches to the existing owner of a project and returns its identities.',
    requires: { grant: 'consult', binding: 'none', revision: 'none' },
    effects: [
      { kind: 'session-state', detail: 'binds-client' },
      { kind: 'reads-generated' },
    ],
    input: obj({
      projectId: str(BOUNDS.projectId),
      protocolVersions: arr(int(1, 1024), 16),
    }),
    output: obj({ identities: RECEIPT_IDENTITIES }),
    errors: [
      contract('unsupported-capability', AgentCodes.OPERATION_UNSUPPORTED, [
        'owner-absent',
        'protocol-version',
      ]),
      contract('stale-revision', Codes.STALE_REVISION, ['descriptor-stale']),
    ],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'session.close',
    status: 'planned',
    owner: 'AG-10.1 #29',
    summary:
      'Closes the bound session and releases its output lease. Idempotency is evidenced by a repeat-call test when AG-10.1 implements it; until then it is never retried.',
    requires: { grant: 'manage-session', binding: 'session', revision: 'none' },
    effects: [
      { kind: 'session-lifecycle', detail: 'closes-session' },
      { kind: 'session-lifecycle', detail: 'releases-output-lease' },
    ],
    input: obj({ sessionId: { type: 'string', format: 'uuid' } }),
    output: obj({ closed: constant(true) }),
    errors: [
      contract(
        'stale-revision',
        Codes.SESSION_CLOSED,
        ['session-closed'],
        ['effect:session-lifecycle'],
      ),
    ],
    retry: NEVER,
  }),
  sessionEntry({
    name: 'session.apply-changes',
    status: 'planned',
    owner: 'AG-10.1 #29',
    summary:
      'Declares changes already on disk and advances the revision. Writes nothing; it needs mutate-sources because it advances the revision and revokes tickets.',
    requires: {
      grant: 'mutate-sources',
      binding: 'session',
      revision: 'current',
    },
    effects: [
      { kind: 'reads-sources' },
      { kind: 'session-state', detail: 'advances-revision' },
      { kind: 'session-state', detail: 'revokes-publication-tickets' },
    ],
    input: obj({
      baseRevision: REVISION_INPUT,
      mode: enumOf(['full-discovery', 'verified-explicit']),
      changed: SCOPE,
      added: SCOPE,
      removed: SCOPE,
      renamed: arr(
        obj({
          from: { type: 'string', format: 'project-relative-path' },
          to: { type: 'string', format: 'project-relative-path' },
        }),
        512,
      ),
    }),
    output: obj({ revision: REVISION_OUTPUT }),
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['revision-mismatch']),
      contract('invalid-input', AgentCodes.INVALID_REQUEST, [
        'path-outside-root',
      ]),
    ],
    retry: NEVER,
  }),
  sessionEntry({
    name: 'audit.read',
    status: 'planned',
    owner: 'AG-01.2 #9',
    summary:
      'Reads a materialized audit for the revision or a generation. Missing and stale audits are explicit results.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [{ kind: 'reads-generated' }],
    input: obj({ rev: REVISION_INPUT, generationId: int(1) }, ['rev']),
    output: obj({ present: bool, fresh: bool, page: AGENT_PAGE }),
    errors: [...REVISION_IDENTITY_ERRORS],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'audit.compute',
    status: 'planned',
    owner: 'AG-01.2 #9',
    summary:
      'Computes the coverage audit in memory for a valid or invalid revision, with its known limitations. Stages nothing.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [{ kind: 'computes' }],
    input: obj({ rev: REVISION_INPUT, page: PAGE_INPUT }, ['rev']),
    output: obj({ page: AGENT_PAGE }),
    errors: [...REVISION_IDENTITY_ERRORS],
    retry: SAFE,
  }),
  sessionEntry({
    name: 'audit.materialize',
    status: 'planned',
    owner: 'AG-01.2 #9',
    summary:
      'Writes the audit of the revision for an expected generation and returns a receipt with path, bytes, digest and identities.',
    requires: {
      grant: 'materialize-audit',
      binding: 'session',
      revision: 'current',
    },
    effects: [{ kind: 'writes-audit' }],
    input: obj({ rev: REVISION_INPUT, expectedGenerationId: int(1) }),
    output: obj({
      path: str(BOUNDS.auditPath),
      bytes: int(0),
      digest: { type: 'string', format: 'sha256' },
      identities: RECEIPT_IDENTITIES,
    }),
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['generation-changed']),
      contract(
        'constraint-violation',
        Codes.INVALID_REVISION,
        ['revision-invalid'],
        ['effect:writes-audit'],
      ),
    ],
    retry: NEVER,
  }),
  define({
    name: 'install.plan',
    status: 'planned',
    owner: 'AG-11.1 #30',
    summary:
      'Plans an installation for a qualified host: steps, planned writes and unsupported steps, with a plan id and digest. Writes nothing.',
    requires: { grant: 'consult', binding: 'none', revision: 'none' },
    effects: [{ kind: 'reads-sources' }, { kind: 'computes' }],
    input: obj({
      host: enumOf(['vite', 'rsbuild', 'next-webpack', 'next-turbopack']),
      mode: enumOf(['dev', 'build']),
    }),
    output: PLAN_OUTPUT,
    errors: [
      contract('unsupported-capability', AgentCodes.OPERATION_UNSUPPORTED, [
        'host-unqualified',
      ]),
    ],
    retry: SAFE,
  }),
  define({
    name: 'install.apply',
    status: 'planned',
    owner: 'AG-11.1 #30',
    summary:
      'Applies an installation plan inside the declared scope and returns the written files.',
    requires: { grant: 'mutate-sources', binding: 'none', revision: 'none' },
    effects: [{ kind: 'writes-sources' }],
    input: obj({
      planId: str(128),
      planDigest: { type: 'string', format: 'sha256' },
      scope: SCOPE,
    }),
    output: NEW_REVISION_OUTPUT,
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['plan-stale']),
      contract(
        'constraint-violation',
        null,
        ['out-of-scope'],
        ['effect:writes-sources'],
      ),
    ],
    retry: NEVER,
  }),
  define({
    name: 'migration.plan',
    status: 'planned',
    owner: 'AG-11.1 #30',
    summary:
      'Plans a version migration: edits, and non-expressible declarations with justified gaps, with a plan id and digest. Writes nothing.',
    requires: { grant: 'consult', binding: 'none', revision: 'none' },
    effects: [{ kind: 'reads-sources' }, { kind: 'computes' }],
    input: obj({
      fromVersion: str(64, { minLength: 1 }),
      toVersion: str(64, { minLength: 1 }),
      scope: SCOPE,
    }),
    output: PLAN_OUTPUT,
    errors: [
      contract('unsupported-capability', AgentCodes.OPERATION_UNSUPPORTED, [
        'version-pair',
      ]),
    ],
    retry: SAFE,
  }),
  define({
    name: 'migration.apply',
    status: 'planned',
    owner: 'AG-11.1 #30',
    summary:
      'Applies a migration plan inside the declared scope and returns a receipt.',
    requires: { grant: 'mutate-sources', binding: 'none', revision: 'none' },
    effects: [{ kind: 'writes-sources' }],
    input: obj({
      planId: str(128),
      planDigest: { type: 'string', format: 'sha256' },
      scope: SCOPE,
    }),
    output: NEW_REVISION_OUTPUT,
    errors: [
      contract('stale-revision', Codes.STALE_REVISION, ['plan-stale']),
      contract(
        'constraint-violation',
        null,
        ['out-of-scope', 'conflict'],
        ['effect:writes-sources'],
      ),
    ],
    retry: NEVER,
  }),
  sessionEntry({
    name: 'measurement.collect',
    status: 'planned',
    owner: 'AG-11.1 #30',
    summary:
      'Collects compiler cost, artifact size, diagnostics and gap measurements, kept separate from application success.',
    requires: { grant: 'consult', binding: 'session', revision: 'current' },
    effects: [{ kind: 'reads-generated' }, { kind: 'computes' }],
    input: obj({
      rev: REVISION_INPUT,
      metrics: arr(
        enumOf(['compiler-cost', 'artifact-size', 'diagnostics', 'gaps']),
        4,
      ),
    }),
    output: obj({ page: AGENT_PAGE }),
    errors: [...REVISION_IDENTITY_ERRORS],
    retry: SAFE,
  }),
];

// ---------------------------------------------------------- the frame -----

const REFERENCE = obj(
  {
    operation: enumOf([
      'check',
      'diagnostics.candidates',
      'diagnostics.affected',
      'records.read',
      'protocol.operations',
    ]),
    view: enumOf(VIEWS),
    input: obj(
      {
        rev: nullable(REVISION_OUTPUT),
        page: CHUNK_PAGE_INPUT,
        domain: CANDIDATE_DOMAIN,
        address: RECORD_ADDRESS,
      },
      [],
    ),
  },
  ['operation', 'view', 'input'],
);

/**
 * The envelope as an output schema. Every frame component is bounded here;
 * list records (`record`) and chunks (`chunk`) are accounted for by the
 * packer against the record ceiling and the response budget instead.
 */
export function envelopeSchema(resultSchema, operationNames) {
  return obj(
    {
      protocol: constant(AGENT_PROTOCOL),
      protocolVersion: constant(AGENT_PROTOCOL_VERSION),
      operation: enumOf(operationNames),
      requestId: { type: 'string', format: 'request-id' },
      outcome: enumOf(OUTCOMES),
      identities: obj(
        {
          projectId: str(BOUNDS.projectId),
          sessionId: { type: 'string', format: 'uuid' },
          revision: REVISION_OUTPUT,
          designSystem: DESIGN_SYSTEM_OUTPUT,
          lastValidDesignSystem: obj({
            systemId: str(BOUNDS.systemId),
            registryDigest: { type: 'string', format: 'hex-digest' },
            derivedFromRevision: REVISION_OUTPUT,
          }),
        },
        [],
      ),
      result: nullable(resultSchema),
      diagnostics: arr({ type: 'object', format: 'record' }, 256),
      diagnosticsTotal: int(0),
      diagnosticsTruncated: bool,
      failure: nullable(
        obj({
          stage: enumOf(STAGES),
          reason: str(BOUNDS.reason),
          precondition: nullable(enumOf(Object.keys(PRECONDITIONS))),
          capability: nullable(str(BOUNDS.capability)),
          retry: enumOf(RETRY_HINTS),
        }),
      ),
      references: arr(REFERENCE, 4),
      view: enumOf(VIEWS),
      page: nullable(
        obj({
          offset: int(0),
          limit: int(0),
          returned: int(0),
          nextOffset: nullable(int(0)),
          total: int(0),
          truncated: bool,
        }),
      ),
      withheld: arr(WITHHELD, 2),
      limits: obj({
        maxResponseBytes: int(1),
        responseBytes: int(0),
        floor: int(1),
        frameMax: int(1),
      }),
    },
    [
      'protocol',
      'protocolVersion',
      'outcome',
      'identities',
      'result',
      'diagnostics',
      'diagnosticsTotal',
      'diagnosticsTruncated',
      'failure',
      'references',
      'view',
      'page',
      'withheld',
      'limits',
    ],
  );
}

// ------------------------------------------------------- load checks ------

function refuse(name, message) {
  throw new TypeError(`pandamstyle agent registry: ${name}: ${message}`);
}

const ENTRY_KEYS = [
  'name',
  'status',
  'owner',
  'summary',
  'requires',
  'preconditions',
  'effects',
  'input',
  'output',
  'errors',
  'views',
  'pagination',
  'cancellation',
  'retry',
];

function effectKey(effect) {
  return effect.detail == null
    ? effect.kind
    : `${effect.kind}:${effect.detail}`;
}

function sameContract(declared, required) {
  return (
    declared.outcome === required.outcome &&
    declared.code === required.code &&
    required.reasons.every((reason) => declared.reasons.includes(reason))
  );
}

function checkEntry(entry, handlers) {
  const name = typeof entry?.name === 'string' ? entry.name : '<unnamed>';
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.includes(key)) refuse(name, `field ${key} is closed`);
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in entry)) refuse(name, `field ${key} is required`);
  }
  if (!/^[a-z]+(?:[.-][a-z]+)*$/.test(entry.name) || entry.name.length > 64)
    refuse(name, 'name must be kebab/dot case');
  if (!['implemented', 'planned'].includes(entry.status))
    refuse(name, 'status is closed');
  if (typeof entry.owner !== 'string' || entry.owner.length > BOUNDS.owner)
    refuse(name, 'owner must name the delivering issue');
  if (
    typeof entry.summary !== 'string' ||
    entry.summary.length > BOUNDS.summary
  )
    refuse(name, 'summary must be a bounded string');

  // Rule 2: implemented exactly when a handler exists.
  const hasHandler = Object.hasOwn(handlers, entry.name);
  if ((entry.status === 'implemented') !== hasHandler)
    refuse(name, 'status implemented holds exactly when a handler exists');

  // Rule 1: closed requirement, effect, outcome and precondition sets.
  const { grant, binding, revision } = entry.requires ?? {};
  if (
    Object.keys(entry.requires ?? {})
      .sort()
      .join() !== 'binding,grant,revision'
  )
    refuse(name, 'requires is { grant, binding, revision }');
  if (grant !== null && !GRANTS.includes(grant))
    refuse(name, 'grant is closed');
  if (!['none', 'session'].includes(binding)) refuse(name, 'binding is closed');
  if (!['none', 'current'].includes(revision))
    refuse(name, 'revision is closed');
  if (revision === 'current' && binding !== 'session')
    refuse(name, 'a revision needs a session binding');

  if (!Array.isArray(entry.effects) || entry.effects.length === 0)
    refuse(name, 'effects must be non-empty');
  const allowed = GRANT_EFFECTS[grant ?? 'none'];
  for (const effect of entry.effects) {
    if (!EFFECT_KINDS.includes(effect?.kind))
      refuse(name, 'effect kind is closed');
    const details = EFFECT_DETAILS[effect.kind];
    if (
      details == null ? effect.detail != null : !details.includes(effect.detail)
    )
      refuse(name, `effect ${effect.kind} detail is closed`);
    // Rule 3: one grant, one effect class.
    if (!allowed.includes(effectKey(effect)))
      refuse(name, `effect ${effectKey(effect)} is outside grant ${grant}`);
  }
  if (!Array.isArray(entry.preconditions))
    refuse(name, 'preconditions is a list');
  for (const precondition of entry.preconditions) {
    if (PRECONDITIONS[precondition?.id] == null)
      refuse(name, 'precondition id is closed');
    if (PRECONDITIONS[precondition.id] !== precondition.outcome)
      refuse(name, `precondition ${precondition.id} has a fixed outcome`);
  }

  // Rule 4: schemas compile; the input is a closed object that binds the
  // revision where the operation needs one.
  compileSchema(entry.input, 'input', [name, 'input']);
  compileSchema(entry.output, 'output', [name, 'output']);
  if (entry.input.type !== 'object') refuse(name, 'input must be an object');
  if (entry.output.type !== 'object') refuse(name, 'output must be an object');
  const inputFields = Object.keys(entry.input.properties ?? {});
  // The one documented exception: the binding is the subject of the request.
  const bindingSubject = binding === 'session' && revision === 'none';
  if (
    inputFields.length === 0 &&
    !(bindingSubject && entry.name === 'session.status')
  )
    refuse(name, 'input must declare the fields the operation reads');
  if (revision === 'current') {
    const rev =
      entry.input.properties.rev ?? entry.input.properties.baseRevision;
    const field = entry.input.properties.rev != null ? 'rev' : 'baseRevision';
    if (rev == null || !(entry.input.required ?? []).includes(field))
      refuse(name, 'input must bind the revision');
  }
  if (entry.pagination != null) {
    if (
      entry.pagination.kind !== 'offset' ||
      !['revision', 'registry'].includes(entry.pagination.boundTo)
    )
      refuse(name, 'pagination is closed');
    if (entry.input.properties.page == null)
      refuse(name, 'a paginated input declares page');
  }

  // Rule 5: universal contracts, and a specific one per precondition and per
  // write, execution or lifecycle effect.
  if (!Array.isArray(entry.errors)) refuse(name, 'errors is a list');
  for (const error of entry.errors) {
    if (!OUTCOMES.includes(error?.outcome) || error.outcome === 'success')
      refuse(name, 'error outcome is closed');
    if (
      error.code === null
        ? !['constraint-violation', 'internal-error'].includes(error.outcome)
        : !KNOWN_CODES.has(error.code)
    )
      refuse(name, 'error code is closed');
    if (
      !Array.isArray(error.reasons) ||
      error.reasons.length === 0 ||
      !error.reasons.every(
        (reason) =>
          typeof reason === 'string' && /^[a-z]+(?:-[a-z]+)*$/.test(reason),
      )
    )
      refuse(name, 'error reasons are closed ids');
  }
  for (const required of universalErrors(entry)) {
    if (!entry.errors.some((declared) => sameContract(declared, required)))
      refuse(
        name,
        `universal contract ${required.outcome}/${required.code} is missing`,
      );
  }
  const covered = new Set(entry.errors.flatMap((error) => error.covers ?? []));
  for (const precondition of entry.preconditions) {
    if (!covered.has(`precondition:${precondition.id}`))
      refuse(name, `precondition ${precondition.id} has no error contract`);
  }
  for (const effect of entry.effects) {
    if (
      CONTRACTED_EFFECTS.includes(effect.kind) &&
      !covered.has(`effect:${effect.kind}`)
    )
      refuse(name, `effect ${effect.kind} has no error contract`);
  }

  // Rule 6: retry agrees with the effects.
  const { idempotent, policy, evidence } = entry.retry ?? {};
  if (
    typeof idempotent !== 'boolean' ||
    !['safe', 'after-refresh', 'never'].includes(policy)
  )
    refuse(name, 'retry is { idempotent, policy }');
  const unsafe = entry.effects.some(
    (effect) =>
      UNSAFE_RETRY_EFFECTS.includes(effect.kind) ||
      UNSAFE_RETRY_EFFECTS.includes(effectKey(effect)),
  );
  if (
    unsafe &&
    (idempotent || policy !== 'never') &&
    typeof evidence !== 'string'
  )
    refuse(
      name,
      'a write, execution, lifecycle or revision effect is never retried',
    );

  // Rule 7: one grant, so no field can select between consultation and
  // mutation. A grant list would be a second effect class.
  if (Array.isArray(grant)) refuse(name, 'exactly one grant');

  if (
    !Array.isArray(entry.views) ||
    entry.views.length === 0 ||
    !entry.views.every((view) => VIEWS.includes(view))
  )
    refuse(name, 'views are closed');
  if (!['none', 'before-start'].includes(entry.cancellation))
    refuse(name, 'cancellation is closed');
}

function deepFreeze(value) {
  if (value != null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Builds a registry, refusing any entry that breaks a load-time rule. The
 * response limits are derived from the output schemas: `frameMax` bounds every
 * frame, and `floor` adds one record at the record ceiling.
 */
export function createRegistry(entries = ENTRIES, handlers = HANDLERS) {
  const names = new Set();
  for (const entry of entries) {
    checkEntry(entry, handlers);
    if (names.has(entry.name)) refuse(entry.name, 'duplicate name');
    names.add(entry.name);
  }
  for (const handlerName of Object.keys(handlers)) {
    if (!names.has(handlerName))
      refuse(handlerName, 'a handler exists for no registered entry');
  }
  const operationNames = [...names];
  const frame = Math.max(
    maxJsonBytes(
      envelopeSchema(
        {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        operationNames,
      ),
    ),
    ...entries
      .filter((entry) => entry.status === 'implemented')
      .map((entry) =>
        maxJsonBytes(envelopeSchema(entry.output, operationNames)),
      ),
  );
  const views = {};
  for (const view of VIEWS) {
    const defaults = VIEW_DEFAULTS[view];
    // One failure record may sit in the frame (§3.10): it is bounded by the
    // record ceiling through the `classify()` fail-safe.
    const frameMax = frame + defaults.recordCeiling;
    views[view] = {
      ...defaults,
      frameMax,
      floor: frameMax + defaults.recordCeiling,
    };
  }
  for (const view of VIEWS) {
    if (views[view].maxResponseBytes < views[view].floor)
      refuse('limits', `the ${view} ceiling is below its floor`);
    // Descriptions are compiler constants: each one fits its view's record
    // ceiling, so `protocol.operations` never withholds one.
    for (const entry of entries) {
      if (
        recordInfo(describeOperation(entry, view, 'available')).bytes >
        views[view].recordCeiling
      )
        refuse(
          entry.name,
          `its ${view} description exceeds the record ceiling`,
        );
    }
  }
  return deepFreeze({
    entries: entries.map((entry) => entry),
    byName: Object.fromEntries(entries.map((entry) => [entry.name, entry])),
    names: operationNames,
    handlers,
    views,
    request: { ...DEFAULT_REQUEST_LIMITS },
  });
}

export const REGISTRY = createRegistry();

export { ENTRIES as REGISTRY_ENTRIES, VIEW_DEFAULTS };
