/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const {
  cases,
  add,
  design,
  c,
  r,
  yes,
  no,
  refs,
  page,
  good,
  bad,
  selection,
  imports,
} = require('./catalog');
function gap(id, gapId, reason, paths, observed, extra = {}) {
  const spec = cases.find((x) => x.id === id);
  Object.assign(spec, {
    status: 'KNOWN_GAP',
    gapId,
    gapReason: reason,
    targetMismatchPaths: paths,
    ...extra,
  });
  spec.contractReferences = [
    ...new Set([
      ...spec.contractReferences,
      refs.api,
      ...(extra.contractReferences ?? []),
    ]),
  ];
  for (const [i, step] of spec.revisions.entries()) step.observed = observed[i];
}
gap(
  'props.omissions',
  'SG-01',
  'Static provenance rejects the null and false omissions that the accepted API admits. No production fixes are permitted in Phase 1.',
  ['accepted', 'codes', 'runtime/result/rules', 'runtime/result/keys'],
  [no(['PMS_UNVERIFIED_PROPS_SOURCE', 'PMS_UNVERIFIED_PROPS_SOURCE'])],
);
gap(
  'props.empty',
  'SG-01',
  'Static validation requires an argument although the accepted runtime composition returns {} for empty input.',
  ['accepted', 'codes', 'runtime/result/rules', 'runtime/result/keys'],
  [no('PMS_UNVERIFIED_PROPS_SOURCE')],
);
gap(
  'forward.local-alias',
  'SG-02',
  'The frontend fails to recognize an immutable local intrinsic alias; name binding authority must survive accepted immutable aliasing.',
  ['accepted', 'codes', 'runtime/result/rules', 'runtime/result/keys'],
  [no('PMS_UNVERIFIED_PROPS_SOURCE')],
);

const rename = cases.find((x) => x.id === 'token.rename-removal');
const renamedBase = {
  themes: ['base', 'light'],
  declarations: [
    ['token(spacing.sm)', '8px'],
    ['token(spacing.lg)', '24px'],
    ['token(spacing.medium)', '16px'],
    ['token(colors.ink)', '#112233'],
    ['token(colors.paper)', '#ffffff'],
    ['token(colors.text)', '#112233'],
    ['token(colors.surface)', '#ffffff'],
  ],
};
rename.revisions[2].expected.push(c('rules', renamedBase, 'includes'));
gap(
  'token.rename-removal',
  'SG-03',
  'After invalid validation of a renamed token, repair updates the consumer but retains the old design-system CSS owner contribution. This differs from fresh and leaves a referenced variable undefined.',
  ['rules'],
  [yes([]), no('PMS_UNKNOWN_TOKEN'), yes([])],
  {
    comparisonMismatchPaths: ['rules', 'artifactBytes'],
    contractReferences: [refs.authority],
  },
);
rename.revisions[2].freshObserved = yes(
  [],
  [c('rules', renamedBase, 'includes')],
);
rename.revisions[2].incrementalObserved = yes(
  [],
  [
    c('rules/0/declarations', [
      ['token(spacing.sm)', '8px'],
      ['--x1efyk35', '16px'],
      ['token(spacing.lg)', '24px'],
      ['token(colors.ink)', '#112233'],
      ['token(colors.paper)', '#ffffff'],
      ['token(colors.text)', '#112233'],
      ['token(colors.surface)', '#ffffff'],
    ]),
  ],
);

const dependentCoverage = [
  { file: 'src/page.js', origin: 'root' },
  { file: 'generated/design.pandamstyle.js', origin: 'closure:import' },
];
for (const id of [
  'resolution.deleted-restored',
  'resolution.rename-import-repair',
]) {
  const spec = cases.find((x) => x.id === id);
  spec.revisions[1].expected.push(
    c('coverage', dependentCoverage),
    c(
      'diagnostics/0/context',
      { request: '../lib/value', from: 'src/page.js', form: 'import', line: 1 },
      'fields',
    ),
  );
  gap(
    id,
    'SG-04',
    'An invalidation of an existing relative dependency retains the removed positive edge and diagnoses the missing target as unparseable; negative dependency accounting and coverage differ from fresh.',
    ['negativeResolutionCount', 'coverage', 'diagnostics/0/context'],
    [yes([]), no('PMS_COVERAGE_GAP'), yes([])],
    {
      comparisonMismatchPaths: ['diagnostics', 'coverage'],
      contractReferences: [refs.authority],
    },
  );
  spec.revisions[1].freshObserved = no('PMS_COVERAGE_GAP', [
    c('coverage', dependentCoverage),
    c('negativeResolutionCount', 1),
  ]);
  spec.revisions[1].incrementalObserved = no('PMS_COVERAGE_GAP', [
    c('coverage', [
      { file: 'src/page.js', origin: 'root' },
      { file: 'lib/value.js', origin: 'closure:import' },
      { file: 'generated/design.pandamstyle.js', origin: 'closure:import' },
    ]),
    c('negativeResolutionCount', 0),
    c(
      'diagnostics/0/context',
      {
        request: '<unparseable>',
        from: 'lib/value.js',
        form: 'unreadable',
        line: null,
      },
      'fields',
    ),
  ]);
}

const relay = cases.find((x) => x.id === 'resolution.relay-added-removed');
relay.revisions[2].expected.push(
  c('coverage', [{ file: 'src/page.js', origin: 'root' }]),
  c(
    'diagnostics/0/context',
    { request: './relay', from: 'src/page.js', form: 'import', line: 1 },
    'fields',
  ),
);
gap(
  relay.id,
  'SG-04',
  'Relay deletion retains a stale positive edge and wrong coverage diagnostic; the import must remain a negative dependency until restoration.',
  ['coverage', 'diagnostics/0/context'],
  [no('PMS_COVERAGE_GAP'), yes([]), no('PMS_COVERAGE_GAP'), yes([])],
  {
    comparisonMismatchPaths: ['diagnostics', 'coverage'],
    contractReferences: [refs.authority],
  },
);
relay.revisions[2].freshObserved = no('PMS_COVERAGE_GAP', [
  c('coverage', [{ file: 'src/page.js', origin: 'root' }]),
]);
relay.revisions[2].incrementalObserved = no('PMS_COVERAGE_GAP', [
  c('coverage', [
    { file: 'src/page.js', origin: 'root' },
    { file: 'src/relay.js', origin: 'closure:import' },
  ]),
  c(
    'diagnostics/0/context',
    {
      request: '<unparseable>',
      from: 'src/relay.js',
      form: 'unreadable',
      line: null,
    },
    'fields',
  ),
]);

// M — Protocol v1 is an authored target, never a fabricated adapter envelope.
add(
  'diagnostics.protocol-v1',
  'diagnostics',
  'The SDK result exposes every mandatory Protocol v1 envelope and diagnostic field',
  bad,
  no('PMS_FORBIDDEN_VALUE', [
    c('protocol/documentKind', 'pandamstyle-diagnostics-result'),
    c('protocol/schemaVersion', 1),
    c('protocol/revision', {
      projectId: 'oracle-project',
      sessionId: 'oracle-session',
      revisionId: 1,
    }),
    c('protocol/abiVersion', 1),
    c('protocol/completeness', {
      status: 'complete',
      scope: 'declared-project',
      discovery: 'full-discovery',
      evidence: 'filesystem-scan',
      resyncRequired: false,
    }),
    c(
      'protocol/diagnostics/0',
      {
        schemaVersion: 1,
        code: 'PMS_FORBIDDEN_VALUE',
        severity: 'error',
        rule: 'category-strict',
        source: {
          file: 'src/page.js',
          line: 2,
          column: 30,
          endLine: null,
          endColumn: null,
        },
        role: 'page',
        context: { property: 'gap', value: '9px', conditionPath: [] },
        expected: {
          category: 'spacing',
          visibility: 'public',
          static: true,
          domain: null,
        },
        candidates: [
          { tokenId: 'spacing.lg', category: 'spacing' },
          { tokenId: 'spacing.md', category: 'spacing' },
          { tokenId: 'spacing.sm', category: 'spacing' },
        ],
        candidatesTotal: 3,
        candidatesTruncated: false,
        repair: {
          kind: 'replace-with-token',
          applicable: true,
          target: { property: 'gap' },
          expected: { category: 'spacing' },
          reason: null,
        },
        autofix: null,
        revision: {
          projectId: 'oracle-project',
          sessionId: 'oracle-session',
          revisionId: 1,
        },
      },
      'fields',
    ),
  ]),
  {
    freshApplicable: false,
    observe: { runtime: null },
    contractReferences: [refs.diagnostics],
  },
);
gap(
  'diagnostics.protocol-v1',
  'SG-05',
  'The historical agent-result v1 wire shape is not the frozen diagnostics-result v1 protocol. Missing identity/completeness/role/domain/end fields and different candidate/repair structures must be migrated explicitly.',
  [
    'protocol/documentKind',
    'protocol/revision',
    'protocol/abiVersion',
    'protocol/completeness',
    'protocol/diagnostics/0',
  ],
  [
    [
      c('protocol/documentKind', 'pandamstyle-agent-result'),
      c('protocol/schemaVersion', 1),
      c('protocol/revisionId', 1),
      c(
        'protocol/diagnostics/0',
        {
          schemaVersion: 1,
          code: 'PMS_FORBIDDEN_VALUE',
          severity: 'error',
          source: { file: 'src/page.js', line: 2, column: 30, role: 'page' },
          expected: { category: 'spacing', admitted: null },
          candidates: ['spacing.sm', 'spacing.md', 'spacing.lg'],
          candidatesTotal: 3,
          candidatesTruncated: false,
          repair: { kind: 'substitute-token', applicable: true },
          autofix: null,
        },
        'fields',
      ),
    ],
  ],
  { contractReferences: [refs.diagnostics] },
);

add(
  'diagnostics.category-repair',
  'diagnostics',
  'Wrong-category diagnostics carry the category needed for a structured repair',
  page("gap:token('colors.text')"),
  no('PMS_INVALID_TOKEN_CATEGORY', [
    c('protocol/diagnostics/0/expected/category', 'spacing'),
    c('protocol/diagnostics/0/repair/expected/category', 'spacing'),
  ]),
  { freshApplicable: false, contractReferences: [refs.diagnostics] },
);
gap(
  'diagnostics.category-repair',
  'SG-06',
  'The wrong-category diagnostic has expected spacing in context but both machine expected.category and repair.expected.category are null.',
  [
    'protocol/diagnostics/0/expected/category',
    'protocol/diagnostics/0/repair/expected/category',
  ],
  [
    [
      c('protocol/diagnostics/0/expected/category', null),
      c('protocol/diagnostics/0/repair/expected/category', null),
      c('protocol/diagnostics/0/context/expected', 'spacing'),
    ],
  ],
  { contractReferences: [refs.diagnostics] },
);

add(
  'diagnostics.private-repair',
  'diagnostics',
  'Private-token repair suggests only public vocabulary and a structured operation',
  page("color:token('colors.ink')"),
  no('PMS_TOKEN_NOT_PUBLIC', [
    c(
      'protocol/diagnostics/0/repair',
      {
        kind: 'replace-with-token',
        applicable: true,
        target: { property: 'color' },
        expected: { category: 'colors', visibility: 'public' },
        reason: null,
      },
      'fields',
    ),
  ]),
  { freshApplicable: false, contractReferences: [refs.diagnostics] },
);
gap(
  'diagnostics.private-repair',
  'SG-07',
  'The historical repair shape lacks target/category and its how text suggests allowing a private page channel, forbidden by the frozen contract.',
  ['protocol/diagnostics/0/repair'],
  [
    [
      c(
        'protocol/diagnostics/0/repair',
        {
          kind: 'use-public-token',
          applicable: true,
          tokenId: 'colors.ink',
          expected: { visibility: 'public' },
          how: 'replace the private token with a public one, or import this page with the private channel explicitly allowed',
        },
        'fields',
      ),
    ],
  ],
  { contractReferences: [refs.diagnostics] },
);

const manyTokens = structuredClone(design);
for (let i = 0; i < 34; i++)
  manyTokens.tokens.spacing['v' + String(i).padStart(2, '0')] = {
    value: 40 + i + 'px',
    visibility: 'public',
  };
add(
  'diagnostics.truncation',
  'diagnostics',
  'Bounded candidates preserve the true domain total and explicit truncation without permitting private values',
  bad,
  no('PMS_FORBIDDEN_VALUE'),
  {
    freshApplicable: false,
    observe: { runtime: null },
    designSystem: manyTokens,
  },
);
const truncation = cases.find((x) => x.id === 'diagnostics.truncation');
truncation.revisions[0].incrementalExpected = [
  c('protocol/diagnostics/0/candidates', 32, 'length'),
  c('protocol/diagnostics/0/candidatesTotal', 37),
  c('protocol/diagnostics/0/candidatesTruncated', true),
  c('protocol/diagnostics/0/autofix', null),
  c('protocol/revisionId', 1),
];

// N — malformed edits reject and repair in a persistent session, but missing
// useful source identity is explicitly a target protocol gap.
const syntax = imports + 'const s = create({ a: {\n';
const syntaxTarget = no('PMS_COVERAGE_GAP', [
  c(
    'diagnostics/0/location',
    { file: 'src/page.js', line: 3, column: 1, role: 'page' },
    'fields',
  ),
]);
add(
  'syntax.incomplete-edit',
  'syntax',
  'An incomplete agent edit retains useful source coordinates and repairs normally',
  good,
  yes([]),
  {
    observe: { runtime: null },
    revisions: [
      {
        label: 'incomplete source',
        write: { 'src/page.js': syntax },
        expected: syntaxTarget,
      },
      {
        label: 'valid syntax repaired',
        write: { 'src/page.js': good },
        expected: yes([]),
      },
    ],
  },
);
gap(
  'syntax.incomplete-edit',
  'SG-08',
  'Parsing failure collapses to coverage.local-imports with <unparseable> and null location; the frontend does not expose available parser source coordinates.',
  ['diagnostics/0/location'],
  [
    yes([]),
    no('PMS_COVERAGE_GAP', [
      c('diagnostics/0/location', null),
      c(
        'diagnostics/0/context',
        {
          request: '<unparseable>',
          from: 'src/page.js',
          form: 'unreadable',
          line: null,
        },
        'fields',
      ),
    ]),
    yes([]),
  ],
  { contractReferences: [refs.diagnostics] },
);
add(
  'syntax.error-affected',
  'syntax',
  'Syntax error in an affected file must carry its original location',
  imports + 'const s = ;\n',
  no('PMS_COVERAGE_GAP', [
    c(
      'diagnostics/0/location',
      { file: 'src/page.js', line: 2, column: 11, role: 'page' },
      'fields',
    ),
  ]),
  { observe: { runtime: null } },
);
gap(
  'syntax.error-affected',
  'SG-08',
  'Affected-file syntax errors collapse into an unlocated coverage diagnostic.',
  ['diagnostics/0/location'],
  [no('PMS_COVERAGE_GAP', [c('diagnostics/0/location', null)])],
  { contractReferences: [refs.diagnostics] },
);

add(
  'publication.noop-generation',
  'publication',
  'A no-op publication names both artifact origin and current association in its generation receipt',
  good,
  yes([]),
  {
    freshApplicable: false,
    observe: { runtime: null },
    revisions: [
      {
        label: 'no-op publication',
        expected: yes(
          [],
          [
            c('current/revisionId', 2),
            c(
              'protocol/generation/generationId',
              'current/generationId',
              'sameAsPath',
            ),
            c('protocol/generation/artifactRevision/revisionId', 1, 'atLeast'),
            c(
              'protocol/generation/associationRevision',
              { projectId: 'oracle-project', revisionId: 2 },
              'fields',
            ),
          ],
        ),
      },
    ],
  },
);
gap(
  'publication.noop-generation',
  'SG-09',
  'The current generation receipt omits distinct artifact origin and association revision identities. New metadata bytes legitimately allocate a generation; no-op generation reuse is optional, not an imposed requirement.',
  [
    'protocol/generation/artifactRevision/revisionId',
    'protocol/generation/associationRevision',
  ],
  [
    yes([], [c('current/generationId', 1)]),
    yes(
      [],
      [
        c('current/generationId', 2),
        c('current/revisionId', 2),
        c('protocol/generation/generationReused', false),
      ],
    ),
  ],
  { contractReferences: [refs.authority] },
);

const privateRecipe = structuredClone(design);
privateRecipe.recipes.secret = {
  visibility: 'private',
  base: { display: 'grid' },
};
add(
  'recipe.private-visibility',
  'recipes',
  'Private recipe selectors are absent from consumer vocabulary',
  selection('recipes.bare()'),
  yes(
    [r('display', 'block')],
    [c('manifest/recipes', ['button', 'bare'], 'keys')],
  ),
  { designSystem: privateRecipe },
);
gap(
  'recipe.private-visibility',
  'SG-10',
  'The current generator exports a private recipe in the consumer manifest and selector map; Phase 0 explicitly requires a private-visibility gap fixture.',
  ['manifest/recipes'],
  [yes([], [c('manifest/recipes', ['button', 'bare', 'secret'], 'keys')])],
);

add(
  'provenance.generated-authentication',
  'provenance',
  'Copied generated metadata cannot authenticate an arbitrary module',
  good.replace('../generated/design.pandamstyle', './counterfeit'),
  no('PMS_GENERATED_ARTIFACT_MISMATCH'),
  {
    observe: { runtime: null },
    files: {
      'src/counterfeit.js':
        "export const __PMS_DESIGN_SYSTEM__={systemId:'oracle-ui',registryDigest:'forged',contractVersion:'pms-0.1'};\nexport const create=x=>x;export const token=x=>x;export const props=x=>x;export const recipes={};export const themes={};",
    },
    contractReferences: [refs.abi, refs.provenance],
  },
);
gap(
  'provenance.generated-authentication',
  'SG-11',
  'The resolver recognizes a user-authored marker without checking it against the service-owned generated artifact digest. The current marker-shaped module obtains compiler intrinsic authority.',
  ['accepted', 'codes'],
  [yes([])],
);

// Phase 0 timing decisions: classification tests execute, features do not.
for (const [id, title] of [
  ['deferred.slots', 'slot recipes'],
  ['deferred.compounds', 'compound variants'],
  ['deferred.patterns', 'patterns/layout'],
  ['deferred.advanced-themes', 'advanced theme axes/runtime generation'],
]) {
  cases.push({
    schemaVersion: 1,
    id,
    area: 'deferred',
    title,
    intent:
      id === 'deferred.advanced-themes'
        ? 'Advanced theme axes/runtime generation are retained and deferred by the public API.'
        : 'Architecturally retained; implementation waits until Phase 12 after Phase 11.',
    status: 'DEFERRED',
    files: {},
    designSystem: null,
    roots: [],
    initialRevision: null,
    revisions: [],
    freshApplicable: false,
    incrementalApplicable: false,
    contractReferences: [refs.deferred, refs.api],
    notes:
      'No executable expectation is manufactured for this absent capability.',
  });
}
add(
  'props.runtime-malformed',
  'props',
  'The generated runtime rejects a raw ref with the structured selection-error code',
  good,
  yes(
    [],
    [
      c('runtimeGuard', {
        rejected: true,
        code: 'PMS_UNVERIFIED_PROPS_SOURCE',
      }),
    ],
  ),
  { observe: { runtime: null, runtimeGuard: { className: 'invented' } } },
);
gap(
  'props.runtime-malformed',
  'SG-12',
  'The current generated props wrapper accepts an arbitrary runtime object instead of raising the frozen structured selection error. Static provenance protection does not repair the runtime contract.',
  ['runtimeGuard'],
  [yes([], [c('runtimeGuard', { rejected: false, code: null })])],
);

const protocol = cases.find((x) => x.id === 'diagnostics.protocol-v1');
// Session allocation strings are opaque. Their association is semantic.
protocol.revisions[0].expected = protocol.revisions[0].expected.map((check) => {
  if (check.path === 'protocol/revision')
    return c(
      check.path,
      { projectId: 'oracle-project', revisionId: 1 },
      'fields',
    );
  if (check.path === 'protocol/diagnostics/0') {
    delete check.value.revision.sessionId;
    check.value.candidates = [
      { tokenId: 'spacing.sm', category: 'spacing' },
      { tokenId: 'spacing.md', category: 'spacing' },
      { tokenId: 'spacing.lg', category: 'spacing' },
    ];
  }
  return check;
});
protocol.revisions[0].expected.push(
  c('protocol/revision/sessionId', null, 'nonEmptyString'),
  c('protocol/diagnostics/0/revision', 'protocol/revision', 'sameAsPath'),
  c(
    'protocol',
    [
      'documentKind',
      'schemaVersion',
      'revision',
      'designSystem',
      'abiVersion',
      'ok',
      'completeness',
      'diagnostics',
      'diagnosticsTotal',
      'diagnosticsTruncated',
      'affected',
      'generation',
      'milestones',
      'audit',
      'incremental',
    ],
    'requiredKeys',
  ),
  c(
    'protocol/diagnostics/0',
    [
      'schemaVersion',
      'code',
      'severity',
      'phase',
      'rule',
      'message',
      'source',
      'role',
      'context',
      'expected',
      'candidates',
      'candidatesTotal',
      'candidatesTruncated',
      'candidatesQuery',
      'repair',
      'autofix',
      'affectedRegion',
      'coverage',
      'revision',
    ],
    'requiredKeys',
  ),
  c('protocol/ok', false),
  c('protocol/diagnosticsTotal', 1),
  c('protocol/diagnosticsTruncated', false),
);
protocol.targetMismatchPaths.push(
  'protocol/revision/sessionId',
  'protocol/diagnostics/0/revision',
  'protocol',
  'protocol/diagnosticsTotal',
  'protocol/diagnosticsTruncated',
);
add(
  'diagnostics.smaller-bound',
  'diagnostics',
  'A host-requested smaller candidate bound retains total cardinality and explicit truncation',
  bad,
  no('PMS_FORBIDDEN_VALUE', [
    c('protocol/diagnostics/0/candidates', 2, 'length'),
    c('protocol/diagnostics/0/candidatesTotal', 3),
    c('protocol/diagnostics/0/candidatesTruncated', true),
  ]),
  {
    freshApplicable: false,
    observe: { runtime: null, agentOptions: { candidateLimit: 2 } },
    contractReferences: [refs.diagnostics],
  },
);
gap(
  'diagnostics.smaller-bound',
  'SG-13',
  'The session result ignores the requested candidateLimit although Protocol v1 permits smaller host bounds. This is recorded separately from default-bound behavior.',
  [
    'protocol/diagnostics/0/candidates',
    'protocol/diagnostics/0/candidatesTruncated',
  ],
  [
    [
      c('protocol/diagnostics/0/candidates', [
        'spacing.sm',
        'spacing.md',
        'spacing.lg',
      ]),
      c('protocol/diagnostics/0/candidatesTotal', 3),
      c('protocol/diagnostics/0/candidatesTruncated', false),
    ],
  ],
  { contractReferences: [refs.diagnostics] },
);
module.exports = { gap };
