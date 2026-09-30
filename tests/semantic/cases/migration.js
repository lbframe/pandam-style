/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const {
  add,
  good,
  bad,
  spacing,
  design,
  c,
  r,
  yes,
  no,
  t,
  refs,
  page,
  selection,
  imports,
  DS,
} = require('./catalog');
const { coverage } = require('../expectations/values');

// G — identity-based forwarding. Each authored source is independent of the
// existing donor-owned forwarding suite and old tooling oracle.
const origin = 'generated/design.pandamstyle.js';
function binding(
  exported,
  imported = exported,
  chain = ['src/relay.js', origin],
) {
  return { exported, imported, origin, chain, kind: 'named' };
}
function forwardCheck(source, bindings, issues = []) {
  return c('forwarding', [{ source, bindings, issues }]);
}
function forward(id, title, relay, source, bindings, extra = {}) {
  add(
    id,
    'forwarding',
    title,
    source,
    yes(extra.observe?.runtime === null ? [] : [spacing], [
      forwardCheck('./relay', bindings),
    ]),
    {
      files: { 'src/relay.js': relay, ...extra.files },
      observe: {
        forwarding: 'src/page.js',
        runtime: {
          file: 'src/page.js',
          exports: ['result'],
          styleRef: { export: 's', key: 'a' },
        },
      },
      contractReferences: [refs.api, refs.provenance],
      ...extra,
    },
  );
}
const ct = [binding('create'), binding('token')];
const named = `export {create,token} from '${DS}';\n`;
const source =
  "import {create,token} from './relay';\nconst s=create({a:{gap:token('spacing.md')}});\nexport {s};\n";
// Runtime evaluation deliberately observes the compiled namespace's own atom,
// independent of generated props; binding answers carry ultimate origins.
add(
  'forward.direct',
  'forwarding',
  'Direct generated imports resolve to authenticated helper identities',
  good,
  yes(
    [spacing],
    [
      c(
        'forwarding/0/bindings',
        ['create', 'props', 'recipes', 'themes', 'token'].map((id) =>
          binding(id, id, [origin]),
        ),
      ),
    ],
  ),
  {
    observe: { forwarding: 'src/page.js' },
    contractReferences: [refs.provenance],
  },
);
add(
  'forward.renamed-import',
  'forwarding',
  'Renamed direct imports retain their original helper identity',
  imports.replace('create,', 'create as css,') +
    "const s=css({a:{gap:token('spacing.md')}});\nexport const result=props(s.a);",
  yes([spacing]),
  { observe: { forwarding: 'src/page.js' } },
);
add(
  'forward.namespace-import',
  'forwarding',
  'Namespace access resolves the actual exported helper binding',
  `import * as p from '${DS}';\nconst s=p.create({a:{gap:p.token('spacing.md')}});\nexport const result=p.props(s.a);`,
  yes([spacing]),
);
add(
  'forward.local-alias',
  'forwarding',
  'An immutable local intrinsic alias preserves binding identity',
  imports +
    "const css=create;\nconst s=css({a:{gap:token('spacing.md')}});\nexport const result=props(s.a);",
  yes([spacing]),
);
forward(
  'forward.named-reexport',
  'Direct named exports preserve helper identity',
  named,
  source,
  ct,
  {
    revisions: [
      {
        label: 'token forwarding removed',
        write: { 'src/relay.js': `export {create} from '${DS}';` },
        expected: no('PMS_FORBIDDEN_IMPORT', [
          forwardCheck('./relay', [binding('create')]),
        ]),
      },
      {
        label: 'forwarding restored',
        write: { 'src/relay.js': named },
        expected: yes([spacing], [forwardCheck('./relay', ct)]),
      },
    ],
  },
);
forward(
  'forward.renamed-reexport',
  'Renamed re-exports preserve the underlying API',
  `export {create as css, token as t} from '${DS}';`,
  source
    .replace('{create,token}', '{css,t}')
    .replace('s=create', 's=css')
    .replace('gap:token', 'gap:t'),
  [binding('css', 'create'), binding('t', 'token')],
);
forward(
  'forward.multi-hop',
  'Multi-hop named forwarding preserves the entire binding origin chain',
  "export {create,token} from './first';",
  source,
  [
    binding('create', 'create', ['src/relay.js', 'src/first.js', origin]),
    binding('token', 'token', ['src/relay.js', 'src/first.js', origin]),
  ],
  {
    files: {
      'src/relay.js': "export {create,token} from './first';",
      'src/first.js': named,
    },
  },
);
forward(
  'forward.star',
  'Unambiguous star forwarding admits only real generated APIs',
  `export * from '${DS}';`,
  source,
  [
    binding('create'),
    binding('props'),
    binding('recipes'),
    binding('themes'),
    binding('token'),
  ],
);
forward(
  'forward.mixed-barrel',
  'Unrelated barrel exports do not contaminate authentic bindings',
  named + "export {value} from './ordinary';",
  source,
  ct,
  {
    files: {
      'src/relay.js': named + "export {value} from './ordinary';",
      'src/ordinary.js': 'export const value=1;',
    },
  },
);
add(
  'forward.partial',
  'forwarding',
  'An incomplete forwarding surface rejects the unavailable helper',
  source,
  no('PMS_FORBIDDEN_IMPORT', [forwardCheck('./relay', [binding('create')])]),
  {
    files: { 'src/relay.js': `export {create} from '${DS}';` },
    observe: { forwarding: 'src/page.js' },
  },
);
forward(
  'forward.source-remap',
  'Changing the ultimate source changes helper identity even if spelling stays identical',
  `export {create as css} from '${DS}';`,
  "import {css} from './relay';\nexport const s=css({a:{display:'grid'}});",
  [binding('css', 'create')],
  {
    observe: { runtime: null, forwarding: 'src/page.js' },
    revisions: [
      {
        label: 'same export remapped to token',
        write: { 'src/relay.js': `export {token as css} from '${DS}';` },
        expected: no('PMS_NON_STATIC_VALUE', [
          forwardCheck('./relay', [binding('css', 'token')]),
        ]),
      },
      {
        label: 'underlying source restored',
        write: { 'src/relay.js': `export {create as css} from '${DS}';` },
        expected: yes(
          [],
          [forwardCheck('./relay', [binding('css', 'create')])],
        ),
      },
    ],
  },
);
add(
  'forward.non-pms-spelling',
  'forwarding',
  'Ordinary imports with API spellings do not become authorized intrinsics',
  source,
  yes(
    [],
    [
      forwardCheck('./relay', []),
      c('rules', r('gap', t('spacing.md')), 'excludes'),
    ],
  ),
  {
    files: {
      'src/relay.js': 'export const create=(x)=>x; export const token=(x)=>x;',
    },
    observe: { runtime: null, forwarding: 'src/page.js' },
  },
);
add(
  'forward.local-symbol',
  'provenance',
  'A local helper spelling cannot borrow authority from an unrelated import',
  imports.replace('create, ', '') +
    "const create=x=>x;\nconst s=create({a:{display:'grid'}});\nexport const result=props(s.a);",
  no('PMS_UNVERIFIED_PROPS_SOURCE'),
);
add(
  'forward.ambiguous-star',
  'forwarding',
  'Ambiguous star forwarding denies authorization for both conflicting helpers',
  source,
  no(
    ['PMS_FORBIDDEN_IMPORT', 'PMS_FORBIDDEN_IMPORT'],
    [c('forwarding/0/bindings', [])],
  ),
  {
    files: {
      'src/relay.js': "export * from './left'; export * from './right';",
      'src/left.js': named,
      'src/right.js': 'export const create=x=>x; export const token=x=>x;',
    },
    observe: { runtime: null, forwarding: 'src/page.js' },
  },
);
add(
  'forward.incomplete-provenance',
  'provenance',
  'A reassigned binding cannot maintain a durable StyleRef proof',
  imports +
    "let s=create({a:{display:'grid'}});\ns={a:{display:'flex'}};\nexport const result=props(s.a);",
  no('PMS_UNVERIFIED_PROPS_SOURCE'),
);
add(
  'forward.default-export',
  'forwarding',
  'A default alias of a named intrinsic retains its origin when explicitly forwarded',
  "import css from './relay';\nexport const styles=css({a:{display:'grid'}});",
  yes([], [forwardCheck('./relay', [binding('default', 'create')])]),
  {
    files: { 'src/relay.js': `export {create as default} from '${DS}';` },
    observe: { runtime: null, forwarding: 'src/page.js' },
  },
);

// H/I — positive and negative dependencies, root versus import-closure coverage.
const localImport = "import {value} from '../lib/value';\n";
add(
  'resolution.existing',
  'module-resolution',
  'An existing relative dependency joins declared coverage',
  localImport + good,
  yes(
    [spacing],
    [
      c('coverage', [
        { file: 'src/page.js', origin: 'root' },
        { file: 'lib/value.js', origin: 'closure:import' },
        { file: origin, origin: 'closure:import' },
      ]),
      c('negativeResolutionCount', 0),
    ],
  ),
  { files: { 'lib/value.js': 'export const value=1;' } },
);
add(
  'resolution.missing-created',
  'negative-resolution',
  'A missing dependency is tracked and its later creation repairs the revision',
  localImport + good,
  no('PMS_COVERAGE_GAP', [c('negativeResolutionCount', 1)]),
  {
    revisions: [
      {
        label: 'missing file created',
        write: { 'lib/value.js': 'export const value=1;' },
        expected: yes([spacing], [c('negativeResolutionCount', 0)]),
        incrementalExpected: [c('counters/negativeResolutionsInvalidated', 1)],
      },
    ],
  },
);
add(
  'resolution.deleted-restored',
  'module-resolution',
  'Deleting an existing dependency invalidates the consumer; restoration repairs it',
  localImport + good,
  yes([spacing], [c('negativeResolutionCount', 0)]),
  {
    files: { 'lib/value.js': 'export const value=1;' },
    revisions: [
      {
        label: 'dependency deleted',
        remove: ['lib/value.js'],
        expected: no('PMS_COVERAGE_GAP', [c('negativeResolutionCount', 1)]),
      },
      {
        label: 'dependency repaired',
        write: { 'lib/value.js': 'export const value=2;' },
        expected: yes([spacing], [c('negativeResolutionCount', 0)]),
      },
    ],
  },
);
add(
  'resolution.rename-import-repair',
  'module-resolution',
  'A file rename rejects stale imports until the import is updated',
  localImport + good,
  yes([spacing]),
  {
    files: { 'lib/value.js': 'export const value=1;' },
    revisions: [
      {
        label: 'dependency renamed',
        rename: [['lib/value.js', 'lib/moved.js']],
        expected: no('PMS_COVERAGE_GAP'),
      },
      {
        label: 'import updated',
        write: {
          'src/page.js':
            localImport.replace('../lib/value', '../lib/moved') + good,
        },
        expected: yes(
          [spacing],
          [
            c('coverage', [
              { file: 'src/page.js', origin: 'root' },
              { file: 'lib/moved.js', origin: 'closure:import' },
              { file: origin, origin: 'closure:import' },
            ]),
          ],
        ),
      },
    ],
  },
);
add(
  'resolution.relay-added-removed',
  'negative-resolution',
  'A missing relay remains a dependency across create/delete/restore',
  source,
  no('PMS_COVERAGE_GAP'),
  {
    observe: { runtime: null, forwarding: 'src/page.js' },
    revisions: [
      {
        label: 'relay added',
        write: { 'src/relay.js': named },
        expected: yes([], [forwardCheck('./relay', ct)]),
      },
      {
        label: 'relay removed',
        remove: ['src/relay.js'],
        expected: no('PMS_COVERAGE_GAP'),
      },
      {
        label: 'relay restored',
        write: { 'src/relay.js': named },
        expected: yes([], [forwardCheck('./relay', ct)]),
      },
    ],
  },
);
add(
  'resolution.coverage-change',
  'coverage',
  'Removing an import drops its external-root dependency from coverage',
  localImport + good,
  yes([spacing]),
  {
    files: { 'lib/value.js': 'export const value=1;' },
    revisions: [
      {
        label: 'import removed',
        write: { 'src/page.js': good },
        expected: yes([spacing], [c('coverage', coverage())]),
      },
    ],
  },
);
add(
  'coverage.root',
  'coverage',
  'Every declared source root is covered independently of helper imports',
  good,
  yes([spacing], [c('coverage', coverage(['src/page.js', 'src/plain.js']))]),
  {
    files: {
      'src/plain.js': 'export const businessData={role:"admin",trusted:true};',
    },
  },
);
add(
  'coverage.closure-no-helper',
  'coverage',
  'Covered closure files without PandamStyle imports still undergo channel validation',
  "import '../lib/unsafe';\n" + good,
  no('PMS_FORBIDDEN_STYLE_CHANNEL'),
  {
    files: {
      'lib/unsafe.js':
        'export const Page=()=> <div style={{display:"grid"}}/>;',
    },
  },
);
add(
  'coverage.enter-leave',
  'coverage',
  'A new root file enters validation and leaves after deletion',
  good,
  yes([spacing], [c('coverage', coverage())]),
  {
    revisions: [
      {
        label: 'covered file added',
        write: { 'src/new.js': 'export const value=1;' },
        expected: yes(
          [spacing],
          [c('coverage', coverage(['src/new.js', 'src/page.js']))],
        ),
      },
      {
        label: 'covered file deleted',
        remove: ['src/new.js'],
        expected: yes([spacing], [c('coverage', coverage())]),
      },
    ],
  },
);
add(
  'coverage.design-dependency',
  'coverage',
  'Design-system-related relay modules enter coverage through local closure',
  good.replace(DS, '../lib/design'),
  yes(
    [spacing],
    [
      c('coverage', [
        { file: 'src/page.js', origin: 'root' },
        { file: 'lib/design.js', origin: 'closure:import' },
        { file: origin, origin: 'closure:export-star' },
      ]),
    ],
  ),
  { files: { 'lib/design.js': `export * from '${DS}';` } },
);
add(
  'coverage.rename-delete',
  'coverage',
  'Coverage follows file identity after rename and removes deleted sources',
  good,
  yes([spacing], [c('coverage', coverage(['src/page.js', 'src/plain.js']))]),
  {
    files: { 'src/plain.js': 'export const value=1;' },
    revisions: [
      {
        label: 'root file renamed',
        rename: [['src/plain.js', 'src/moved.js']],
        expected: yes(
          [spacing],
          [c('coverage', coverage(['src/moved.js', 'src/page.js']))],
        ),
      },
      {
        label: 'renamed file deleted',
        remove: ['src/moved.js'],
        expected: yes([spacing], [c('coverage', coverage())]),
      },
    ],
  },
);

// J/O — long-lived revisions cannot depend on hidden history.
add(
  'revision.no-change',
  'revisions',
  'No-change transactions advance revision identity while reusing all source analysis',
  good,
  yes([spacing]),
  {
    revisions: [
      {
        label: 'unchanged revision',
        expected: yes([spacing]),
        incrementalExpected: [
          c('counters/filesRecompiled', 0),
          c('counters/filesReparsed', 0),
          c('counters/filesReused', 1),
        ],
      },
    ],
  },
);
add(
  'revision.local-edit',
  'revisions',
  'A local declaration change invalidates just its own compilation',
  good,
  yes([spacing]),
  {
    files: { 'src/stable.js': 'export const value=1;' },
    revisions: [
      {
        label: 'one file edited',
        write: { 'src/page.js': page("gap: token('spacing.lg')") },
        expected: yes([r('gap', t('spacing.lg'))]),
        incrementalExpected: [
          c('counters/filesRecompiled', 1),
          c('counters/filesReused', 1),
        ],
      },
    ],
  },
);
add(
  'revision.multi-file-transaction',
  'revisions',
  'Multiple source writes belong to one accepted revision',
  good,
  yes([spacing]),
  {
    files: { 'src/stable.js': 'export const value=1;' },
    revisions: [
      {
        label: 'two files changed together',
        write: {
          'src/page.js': page("gap: token('spacing.lg')"),
          'src/stable.js': 'export const value=2;',
        },
        expected: yes([r('gap', t('spacing.lg'))]),
        incrementalExpected: [c('counters/filesRecompiled', 2)],
      },
    ],
  },
);
add(
  'revision.valid-invalid-repaired',
  'multi-revision',
  'A valid-invalid-repaired sequence preserves publication until repair succeeds',
  good,
  yes([spacing]),
  {
    revisions: [
      {
        label: 'invalid raw edit',
        write: { 'src/page.js': bad },
        expected: no('PMS_FORBIDDEN_VALUE'),
        incrementalExpected: [
          c('current/revisionId', 1),
          c('current/generationId', 1),
          c('protocol/generation/published', false),
          { path: 'publicationDigests', op: 'sameAsRevision', revision: 1 },
        ],
      },
      {
        label: 'source repaired',
        write: { 'src/page.js': good },
        expected: yes([spacing]),
        incrementalExpected: [
          c('current/revisionId', 3),
          c('current/generationId', 2),
        ],
      },
    ],
  },
);
add(
  'revision.a-b-a',
  'multi-revision',
  'Returning to identical source content restores correct semantics without hidden allocation dependence',
  good,
  yes([spacing]),
  {
    revisions: [
      {
        label: 'content B',
        write: { 'src/page.js': page("gap: token('spacing.lg')") },
        expected: yes([r('gap', t('spacing.lg'))]),
      },
      {
        label: 'content A restored',
        write: { 'src/page.js': good },
        expected: yes([spacing]),
        checks: [{ path: 'runtime/result', op: 'sameAsRevision', revision: 1 }],
      },
    ],
  },
);

// K — actual rule owners are observed only inside the adapter.
const unique = page("gap: token('spacing.lg')");
add(
  'css.declaration-change',
  'incremental-css',
  'A changed atom removes its previous unowned rule',
  unique,
  yes([r('gap', t('spacing.lg'))]),
  {
    revisions: [
      {
        label: 'declaration changed',
        write: { 'src/page.js': good },
        expected: yes(
          [spacing],
          [c('rules', r('gap', t('spacing.lg')), 'excludes')],
        ),
      },
    ],
    observe: { ownership: true },
  },
);
add(
  'css.shared-owners',
  'incremental-css',
  'A shared atom persists with one owner and disappears after its final owner leaves',
  unique,
  yes([r('gap', t('spacing.lg'))]),
  {
    files: { 'src/other.js': unique },
    observe: { ownership: true },
    revisions: [
      {
        label: 'one of two owners disappears',
        remove: ['src/other.js'],
        expected: yes([r('gap', t('spacing.lg'))]),
        incrementalExpected: [
          c('owners', ['design-system', 'src/page.js'], 'keys'),
          c(
            'ruleOwners',
            { rule: r('gap', t('spacing.lg')), owners: ['src/page.js'] },
            'includes',
          ),
        ],
      },
      {
        label: 'final owner disappears',
        write: { 'src/page.js': selection('recipes.bare()') },
        expected: yes(
          [r('display', 'block')],
          [c('rules', r('gap', t('spacing.lg')), 'excludes')],
        ),
      },
    ],
  },
);
add(
  'css.shared-introduced',
  'incremental-css',
  'Adding a second owner does not duplicate a shared rule',
  unique,
  yes([r('gap', t('spacing.lg'))]),
  {
    observe: { ownership: true },
    revisions: [
      {
        label: 'new owner joins',
        write: { 'src/other.js': unique },
        expected: yes([r('gap', t('spacing.lg'))]),
        incrementalExpected: [
          c('owners', ['design-system', 'src/other.js', 'src/page.js'], 'keys'),
          c(
            'ruleOwners',
            {
              rule: r('gap', t('spacing.lg')),
              owners: ['src/other.js', 'src/page.js'],
            },
            'includes',
          ),
        ],
      },
    ],
  },
);
add(
  'css.conditioned-change',
  'incremental-css',
  'A conditioned atom replacement removes the old predicate rule',
  page("gap:{hover:token('spacing.md')}"),
  yes([r('gap', t('spacing.md'), [], '&:hover')]),
  {
    revisions: [
      {
        label: 'conditioned rule changed',
        write: { 'src/page.js': page("gap:{focus:token('spacing.lg')}") },
        expected: yes(
          [r('gap', t('spacing.lg'), [], '&:focus')],
          [c('rules', r('gap', t('spacing.md'), [], '&:hover'), 'excludes')],
        ),
      },
    ],
  },
);
const tokenMutation = structuredClone(design);
tokenMutation.tokens.spacing.lg.value = '28px';
add(
  'css.theme-token-change',
  'incremental-css',
  'Token values change theme CSS without changing logical consumer atoms',
  unique,
  yes([r('gap', t('spacing.lg'))]),
  {
    revisions: [
      {
        label: 'token variable changed',
        designSystem: tokenMutation,
        expected: yes(
          [r('gap', t('spacing.lg'))],
          [
            c(
              'rules',
              {
                themes: ['base', 'light'],
                declarations: [
                  ['token(spacing.sm)', '8px'],
                  ['token(spacing.md)', '16px'],
                  ['token(spacing.lg)', '28px'],
                  ['token(colors.ink)', '#112233'],
                  ['token(colors.paper)', '#ffffff'],
                  ['token(colors.text)', '#112233'],
                  ['token(colors.surface)', '#ffffff'],
                ],
              },
              'includes',
            ),
          ],
        ),
      },
    ],
  },
);
add(
  'css.no-op',
  'incremental-css',
  'No-op revisions preserve exact stylesheet bytes and rule owners',
  unique,
  yes([r('gap', t('spacing.lg'))]),
  {
    observe: { ownership: true },
    revisions: [
      {
        label: 'no-op',
        expected: yes([r('gap', t('spacing.lg'))]),
        checks: [
          {
            path: 'artifactBytes/styles.css',
            op: 'sameAsRevision',
            revision: 1,
          },
        ],
        incrementalExpected: [
          { path: 'owners', op: 'sameAsRevision', revision: 1 },
        ],
      },
    ],
  },
);

// L — publication: a revision verdict never implies a committed generation.
add(
  'publication.valid',
  'publication',
  'Valid compilation publishes the actual artifact set',
  good,
  yes(
    [spacing],
    [
      c('publication/exists', true),
      c('publication/artifacts', 'styles.css', 'includes'),
    ],
  ),
  {
    revisions: [
      {
        label: 'second valid edit',
        write: { 'src/page.js': unique },
        expected: yes([r('gap', t('spacing.lg'))]),
        incrementalExpected: [
          c('current/revisionId', 2),
          c('current/generationId', 2),
        ],
      },
    ],
  },
);
add(
  'publication.invalid-first',
  'publication',
  'An invalid first revision publishes no artifacts and no generation',
  bad,
  no('PMS_FORBIDDEN_VALUE', [
    c('publication/exists', false),
    c('publication/artifacts', []),
  ]),
  {
    revisions: [
      {
        label: 'repair publishes',
        write: { 'src/page.js': good },
        expected: yes([spacing]),
        incrementalExpected: [
          c('current/generationId', 1),
          c('current/revisionId', 2),
        ],
      },
    ],
  },
);
add(
  'publication.staged-failure',
  'publication',
  'A staged publication failure preserves the previous committed generation',
  good,
  yes([]),
  {
    observe: { runtime: null },
    freshApplicable: false,
    revisions: [
      {
        label: 'failed staged publish',
        write: { 'src/page.js': unique },
        publicationFailure: 'before-commit',
        expected: yes(
          [],
          [
            c('publicationError', 'PMS_INJECTED_PUBLICATION_FAILURE'),
            c('current/generationId', 1),
            c('current/revisionId', 1),
            { path: 'publicationDigests', op: 'sameAsRevision', revision: 1 },
          ],
        ),
      },
      {
        label: 'later valid commit',
        write: { 'src/page.js': good },
        expected: yes(
          [],
          [
            c('current/generationId', 2),
            c('current/revisionId', 3),
            c('publicationError', null),
          ],
        ),
      },
    ],
  },
);
add(
  'publication.superseded',
  'publication',
  'An uncommitted result is superseded by the next accepted mutation',
  good,
  yes([]),
  {
    observe: { runtime: null },
    freshApplicable: false,
    revisions: [
      {
        label: 'valid but unpublished',
        write: { 'src/page.js': unique },
        publish: false,
        expected: yes(
          [],
          [
            c('protocol/generation/published', false),
            c('protocol/generation/generationId', null),
            c('current/revisionId', 1),
          ],
        ),
      },
      {
        label: 'new mutation committed',
        write: { 'src/page.js': page("display:'grid'") },
        expected: yes(
          [],
          [c('current/revisionId', 3), c('current/generationId', 2)],
        ),
      },
    ],
  },
);

module.exports = {};
