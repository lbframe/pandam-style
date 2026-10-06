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
        "export const __pandamstyle={abiVersion:1,compilerContractVersion:'pms-0.1',designSystem:{systemId:'oracle-ui',registryDigest:'forged'},manifestSchemaVersion:1,capabilities:{slots:false,compoundVariants:false,patterns:false,rawDynamicStyles:false}};\nexport const create=x=>x;export const token=x=>x;export const props=x=>x;export const recipes={};export const themes={};",
    },
    contractReferences: [refs.abi, refs.provenance],
  },
);

// Phase 0 timing decisions: classification tests execute, features do not.
for (const [id, title] of [
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
// SG-12 is promoted to MUST_PRESERVE. The authored target above is unchanged.

const protocol = cases.find((x) => x.id === 'diagnostics.protocol-v1');
// Session allocation strings are opaque. Their association is semantic.
protocol.revisions[0].expected = protocol.revisions[0].expected.map((check) => {
  if (check.path === 'protocol/revision')
    return c(
      check.path,
      { projectId: 'oracle-project', revisionId: 1 },
      'fields',
    );
  if (check.path === 'protocol/diagnostics/0')
    delete check.value.revision.sessionId;
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
module.exports = { gap };
