/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const design = require('../fixtures/design.json');
const {
  DS,
  imports,
  page,
  namespaces,
  selection,
} = require('../fixtures/sources');
const {
  check: c,
  rule: r,
  coverage,
  accepted: yes,
  rejected: no,
  token: t,
  baseTheme,
  darkTheme,
  recipeDefault,
  recipeSmallLoud,
  refs,
} = require('../expectations/values');
const cases = [];
function add(id, area, title, source, expected, options = {}) {
  const {
    files = {},
    revisions = [],
    observe = {},
    status = 'MUST_PRESERVE',
    ...rest
  } = options;
  cases.push({
    schemaVersion: 1,
    id,
    area,
    title,
    intent: title,
    status,
    files: { 'src/page.js': source, ...files },
    designSystem: design,
    roots: ['src'],
    initialRevision: 1,
    revisions: [{ label: 'initial', expected }, ...revisions],
    freshApplicable: true,
    incrementalApplicable: true,
    contractReferences: [refs.api, refs.abi],
    observe: {
      coverage: true,
      runtime: { file: 'src/page.js', exports: ['result'] },
      ...observe,
    },
    notes:
      'Expectations are authored from the frozen contracts; current execution cannot rewrite them.',
    ...rest,
  });
}
const spacing = r('gap', t('spacing.md'));
const good = page("gap: token('spacing.md')");
const bad = page("gap: '9px'");

// A — tokens: declaration values, category, visibility and binding trust.
add(
  'token.public',
  'tokens',
  'A public spacing token is accepted and keeps its logical identity',
  good,
  yes([spacing], [c('coverage', coverage())]),
);
add(
  'token.semantic',
  'tokens',
  'A public semantic color aliases a private primitive without exposing it',
  page("color: token('colors.text')"),
  yes(
    [r('color', t('colors.text'))],
    [
      c('rules', baseTheme, 'includes'),
      c('manifest/tokens/colors.text', { category: 'colors' }),
      c(
        'manifest/tokens',
        [
          'spacing.sm',
          'spacing.md',
          'spacing.lg',
          'colors.text',
          'colors.surface',
        ],
        'keys',
      ),
    ],
  ),
);
add(
  'token.alias-reference',
  'tokens',
  'Alias resolution uses the referenced value in the base theme',
  page("backgroundColor: token('colors.surface')"),
  yes(
    [r('background-color', t('colors.surface'))],
    [c('rules', baseTheme, 'includes')],
  ),
);
add(
  'token.private',
  'tokens',
  'A page cannot select a private token',
  page("color: token('colors.ink')"),
  no('PMS_TOKEN_NOT_PUBLIC', [
    c(
      'diagnostics/0',
      {
        severity: 'error',
        rule: 'visibility.consumer',
        location: { file: 'src/page.js', line: 2, column: 38, role: 'page' },
        context: {
          tokenId: 'colors.ink',
          category: 'colors',
          visibility: 'private',
          candidates: ['colors.text', 'colors.surface'],
        },
        autofix: null,
      },
      'fields',
    ),
  ]),
);
add(
  'token.unknown',
  'tokens',
  'Unknown token paths reject with structured identity and public candidates',
  page("gap: token('spacing.absent')"),
  no('PMS_UNKNOWN_TOKEN', [
    c(
      'diagnostics/0/context',
      {
        property: 'gap',
        tokenId: 'spacing.absent',
        candidates: ['spacing.sm', 'spacing.md', 'spacing.lg'],
      },
      'fields',
    ),
  ]),
);
add(
  'token.category',
  'tokens',
  'A color token cannot be used as spacing',
  page("gap: token('colors.text')"),
  no('PMS_INVALID_TOKEN_CATEGORY', [
    c(
      'diagnostics/0/context',
      {
        property: 'gap',
        tokenId: 'colors.text',
        expected: 'spacing',
        actual: 'colors',
      },
      'fields',
    ),
  ]),
);
add(
  'token.raw-spacing',
  'tokens',
  'Raw spacing is forbidden even when its bytes equal a token value',
  bad,
  no('PMS_FORBIDDEN_VALUE', [
    c(
      'diagnostics/0/context',
      { property: 'gap', category: 'spacing', value: '9px' },
      'fields',
    ),
  ]),
);
add(
  'token.raw-color',
  'tokens',
  'Raw page colors cannot impersonate semantic tokens',
  page("color: '#112233'"),
  no('PMS_FORBIDDEN_VALUE'),
);
add(
  'token.binding-alias',
  'tokens',
  'A renamed import retains token binding authority',
  imports.replace('token,', 'token as t,') +
    "const s=create({a:{gap:t('spacing.md')}});\nexport const result=props(s.a);\n",
  yes([spacing]),
);
add(
  'token.local-function',
  'tokens',
  'A local function named token cannot grant token authority',
  imports.replace('token, ', '') +
    "function token(x){return x;}\nconst s=create({a:{gap:token('spacing.md')}});\nexport const result=props(s.a);\n",
  no('PMS_NON_STATIC_VALUE'),
);
add(
  'token.forged',
  'tokens',
  'A token-shaped object is not a trusted TokenRef',
  page(
    "gap: {base: { kind:'pandamstyle-token-ref', abiVersion:1, systemId:'oracle-ui', path:'spacing.md',category:'spacing' }}",
  ),
  no('PMS_FORBIDDEN_VALUE'),
);
const renamedToken = structuredClone(design);
renamedToken.tokens.spacing.medium = renamedToken.tokens.spacing.md;
delete renamedToken.tokens.spacing.md;
renamedToken.recipes.button.variants.size.md.padding = {
  $token: 'spacing.medium',
};
renamedToken.recipes.button.defaultVariants.size = 'sm';
add(
  'token.rename-removal',
  'tokens',
  'Token removal invalidates an unchanged consumer; repair selects the renamed path',
  good,
  yes([spacing]),
  {
    revisions: [
      {
        label: 'token renamed',
        designSystem: renamedToken,
        expected: no('PMS_UNKNOWN_TOKEN'),
      },
      {
        label: 'consumer repaired',
        write: { 'src/page.js': page("gap: token('spacing.medium')") },
        expected: yes([r('gap', t('spacing.medium'))]),
      },
    ],
  },
);

// B — themes. Identity and CSS variables remain distinct from style atoms.
add(
  'theme.base',
  'themes',
  'The base theme owns the complete token-variable projection',
  selection('themes.light'),
  yes(
    [],
    [
      c('runtime/result/rules', [baseTheme], 'fields'),
      c('runtime/result/keys', ['className']),
    ],
  ),
);
add(
  'theme.alternate',
  'themes',
  'Alternate theme selection applies its partial override over base variables',
  selection('themes.dark'),
  yes([], [c('runtime/result/rules', [baseTheme, darkTheme], 'fields')]),
);
add(
  'theme.token-override',
  'themes',
  'A dark theme overrides the same semantic variable identity',
  page("color: token('colors.text')", 'themes.dark, s.a'),
  yes([darkTheme, r('color', t('colors.text'))]),
);
add(
  'theme.semantic-multiple',
  'themes',
  'Semantic color identity is stable under both named themes',
  imports +
    "const s=create({a:{color:token('colors.text')}});\nexport const result=props(themes.light,s.a);\nexport const alternate=props(themes.dark,s.a);",
  yes(
    [baseTheme, r('color', t('colors.text'))],
    [
      c('runtime/alternate/rules', darkTheme, 'includes'),
      c('runtime/alternate/rules', r('color', t('colors.text')), 'includes'),
    ],
  ),
  {
    observe: {
      runtime: { file: 'src/page.js', exports: ['result', 'alternate'] },
    },
  },
);
add(
  'theme.composition',
  'themes',
  'Later themes in the same group win without discarding styles',
  page("display: 'grid'", 'themes.light, themes.dark, s.a'),
  yes([darkTheme, r('display', 'grid')]),
);
add(
  'theme.composition-reverse',
  'themes',
  'Reversing theme selection restores the base projection',
  selection('themes.dark, themes.light'),
  yes([], [c('runtime/result/rules', [baseTheme], 'fields')]),
);
add(
  'theme.unknown',
  'themes',
  'Unknown theme selection is rejected through the stable named-reference diagnostic',
  selection('themes.absent'),
  no('PMS_UNKNOWN_CONDITION'),
);
const darkMutation = structuredClone(design);
darkMutation.themes.dark.tokens.colors.text.value = '#aabbcc';
add(
  'theme.mutation',
  'themes',
  'Theme input mutation invalidates CSS but preserves token identity',
  page("color: token('colors.text')", 'themes.dark,s.a'),
  yes([darkTheme, r('color', t('colors.text'))]),
  {
    revisions: [
      {
        label: 'theme override changed',
        designSystem: darkMutation,
        expected: yes([
          {
            themes: ['dark'],
            declarations: [
              ['token(colors.surface)', '#112233'],
              ['token(colors.text)', '#aabbcc'],
            ],
          },
          r('color', t('colors.text')),
        ]),
      },
    ],
  },
);

// C — conditions: exact selector meaning and conflict-relevant rule order.
add(
  'condition.pseudo',
  'conditions',
  'Named hover conditions preserve the pseudo selector',
  page("gap: { hover: token('spacing.md') }"),
  yes([r('gap', t('spacing.md'), [], '&:hover')]),
);
add(
  'condition.media',
  'conditions',
  'A named media predicate remains an at-rule',
  page("gap: { wide: token('spacing.md') }"),
  yes([r('gap', t('spacing.md'), ['@media (min-width: 768px)'])]),
);
add(
  'condition.base-map',
  'conditions',
  'Base and hover declarations coexist',
  page("gap: { base: token('spacing.sm'), hover: token('spacing.md') }"),
  yes([r('gap', t('spacing.sm')), r('gap', t('spacing.md'), [], '&:hover')]),
);
add(
  'condition.default-alias',
  'conditions',
  'The historical default spelling means base',
  page("gap: { default: token('spacing.md') }"),
  yes([spacing]),
);
add(
  'condition.multiple',
  'conditions',
  'Pseudo and media declarations keep both predicate identities',
  page(
    "gap: { wide: token('spacing.lg'), hover: token('spacing.md'), base: token('spacing.sm') }",
  ),
  yes([
    r('gap', t('spacing.sm')),
    r('gap', t('spacing.md'), [], '&:hover'),
    r('gap', t('spacing.lg'), ['@media (min-width: 768px)']),
  ]),
);
add(
  'condition.canonical-order',
  'conditions',
  'Reordering source condition keys retains the same cascade',
  page(
    "gap: { base: token('spacing.sm'), hover: token('spacing.md'), wide: token('spacing.lg') }",
  ),
  yes([
    r('gap', t('spacing.sm')),
    r('gap', t('spacing.md'), [], '&:hover'),
    r('gap', t('spacing.lg'), ['@media (min-width: 768px)']),
  ]),
  {
    revisions: [
      {
        label: 'keys reordered',
        write: {
          'src/page.js': page(
            "gap: { wide: token('spacing.lg'), hover: token('spacing.md'), base: token('spacing.sm') }",
          ),
        },
        expected: yes([
          r('gap', t('spacing.sm')),
          r('gap', t('spacing.md'), [], '&:hover'),
          r('gap', t('spacing.lg'), ['@media (min-width: 768px)']),
        ]),
        checks: [
          { path: 'runtime/result/rules', op: 'sameAsRevision', revision: 1 },
        ],
      },
    ],
  },
);
add(
  'condition.unknown',
  'conditions',
  'Undeclared condition names reject',
  page("gap: { mystery: token('spacing.md') }"),
  no('PMS_UNKNOWN_CONDITION'),
);
const conditionMutation = structuredClone(design);
conditionMutation.conditions.wide = '@media (min-width: 1024px)';
add(
  'condition.mutation',
  'conditions',
  'Condition definition changes invalidate consumers',
  page("gap: { wide: token('spacing.md') }"),
  yes([r('gap', t('spacing.md'), ['@media (min-width: 768px)'])]),
  {
    revisions: [
      {
        label: 'predicate changed',
        designSystem: conditionMutation,
        expected: yes([
          r('gap', t('spacing.md'), ['@media (min-width: 1024px)']),
        ]),
      },
    ],
  },
);

// D — create is a static namespace declaration; no runtime CSS interpreter.
add(
  'create.simple',
  'create',
  'A static structural declaration becomes a compiled StyleRef',
  page("display: 'grid'"),
  yes([r('display', 'grid')]),
);
add(
  'create.multiple-keys',
  'create',
  'Distinct namespace keys compile independently and compose',
  namespaces("{a:{display:'grid'},b:{gap:token('spacing.md')}}", 's.a,s.b'),
  yes([spacing, r('display', 'grid')]),
);
add(
  'create.constrained',
  'create',
  'Admitted structural literals and numeric ranges remain supported',
  page("display:'flex', alignItems:'center', opacity:0.5"),
  yes([r('align-items', 'center'), r('display', 'flex'), r('opacity', '0.5')]),
);
add(
  'create.nested-condition',
  'create',
  'Author-admitted nested condition blocks preserve selectors',
  page("display:'grid', _hover:{gap:token('spacing.md')}"),
  yes([r('display', 'grid'), r('gap', t('spacing.md'), [], '&:hover')]),
);
add(
  'create.forbidden-value',
  'create',
  'Out-of-domain structural literals are rejected',
  page("display:'contents'"),
  no('PMS_FORBIDDEN_VALUE'),
);
add(
  'create.unsupported-property',
  'create',
  'Unsupported properties cannot open a raw styling channel',
  page("cursor:'pointer'"),
  no('PMS_UNSUPPORTED_PROPERTY'),
);
add(
  'create.forbidden-channel',
  'create',
  'Inline JSX style is rejected in a covered page',
  imports + "export const Page=()=> <div style={{display:'grid'}}/>;",
  no('PMS_FORBIDDEN_STYLE_CHANNEL'),
  { observe: { runtime: null } },
);
add(
  'create.static-computed',
  'create',
  'Static computed keys are evaluated without introducing dynamic authority',
  page("['display']:'grid'"),
  yes([r('display', 'grid')]),
);
add(
  'create.spread',
  'create',
  'A literal immutable spread remains statically constrained',
  page("...{display:'grid'},gap:token('spacing.md')"),
  yes([spacing, r('display', 'grid')]),
);
add(
  'create.local-shadow',
  'create',
  'A local create spelling is ordinary application code',
  "function create(x){return x;}\nexport const result=create({a:{gap:'9px'}});",
  yes(
    [],
    [
      c('rules', r('gap', '9px'), 'excludes'),
      c('coverage', [{ file: 'src/page.js', origin: 'root' }]),
    ],
  ),
  { observe: { runtime: null } },
);
add(
  'create.dynamic',
  'create',
  'Dynamic declarations are rejected rather than evaluated at runtime',
  page('gap: window.value'),
  no('PMS_NON_STATIC_VALUE'),
);

// E — actual runtime composition, including conflict cancellation.
add(
  'props.single',
  'props',
  'A single StyleRef produces only its extracted classes',
  page("display:'grid'"),
  yes([r('display', 'grid')]),
);
add(
  'props.multiple',
  'props',
  'Nonconflicting refs retain all declarations',
  namespaces("{a:{display:'grid'},b:{opacity:0.5}}", 's.a,s.b'),
  yes(
    [r('display', 'grid'), r('opacity', '0.5')],
    [
      c(
        'runtime/result/classOrder',
        [[r('display', 'grid')], [r('opacity', '0.5')]],
        'fields',
      ),
    ],
  ),
);
add(
  'props.ordered',
  'props',
  'Later property conflicts replace the earlier class',
  namespaces("{a:{display:'grid'},b:{display:'flex'}}", 's.a,s.b'),
  yes([r('display', 'flex')]),
);
add(
  'props.conflict-reverse',
  'props',
  'Composition order is observable at a property conflict',
  namespaces("{a:{display:'grid'},b:{display:'flex'}}", 's.b,s.a'),
  yes([r('display', 'grid')]),
);
add(
  'props.recipe-local',
  'props',
  'Local refs override recipe conflicts without losing other branches',
  page("display:'grid'", 'recipes.button(),s.a'),
  yes([
    r('padding', t('spacing.md')),
    r('color', t('colors.text')),
    r('display', 'grid'),
    r('opacity', '0.5'),
  ]),
);
add(
  'props.theme-style',
  'props',
  'Theme refs and style refs keep independent conflict identities',
  page("display:'grid'", 'themes.dark,s.a'),
  yes([darkTheme, r('display', 'grid')]),
);
add(
  'props.invalid',
  'props',
  'A raw object is not a StyleRef',
  selection("{display:'grid'}"),
  no('PMS_UNVERIFIED_PROPS_SOURCE'),
);
add(
  'props.forged',
  'props',
  'A copied compiled-ref shape cannot authenticate a source binding',
  selection("{$$css:true,display:'invented'}"),
  no('PMS_UNVERIFIED_PROPS_SOURCE'),
);
add(
  'props.omissions',
  'props',
  'False and null conditional omissions do not introduce classes',
  page("display:'grid'", 'null,false,s.a'),
  yes([r('display', 'grid')]),
);
add(
  'props.empty',
  'props',
  'Empty composition returns an empty object',
  selection(''),
  yes([], [c('runtime/result/keys', []), c('runtime/result/rules', [])]),
);
add(
  'props.nested-array',
  'props',
  'Readonly nested arrays flatten left to right',
  namespaces("{a:{display:'grid'},b:{opacity:0.5}}", '[s.a,[s.b]]'),
  yes([r('display', 'grid'), r('opacity', '0.5')]),
);
add(
  'props.condition-conflict',
  'props',
  'A base override cannot cancel a distinct pseudo conflict key',
  namespaces(
    "{a:{gap:{base:token('spacing.sm'),hover:token('spacing.md')}},b:{gap:token('spacing.lg')}}",
    's.a,s.b',
  ),
  yes([r('gap', t('spacing.lg')), r('gap', t('spacing.md'), [], '&:hover')]),
);

// F — finite recipe selection. Expectations pin branch CSS, not object shape.
add(
  'recipe.base',
  'recipes',
  'A recipe without axes contributes exactly its base',
  selection('recipes.bare()'),
  yes([r('display', 'block')]),
);
add(
  'recipe.defaults',
  'recipes',
  'Empty selection applies declared defaults',
  selection('recipes.button()'),
  yes(recipeDefault),
);
add(
  'recipe.one-axis',
  'recipes',
  'An explicit axis overrides its default while other defaults remain',
  selection("recipes.button({tone:'loud'})"),
  yes([
    r('padding', t('spacing.md')),
    r('color', t('colors.text')),
    r('display', 'inline-flex'),
    r('opacity', '1'),
  ]),
);
add(
  'recipe.multiple-axes',
  'recipes',
  'Each declared selected axis contributes one branch',
  selection("recipes.button({tone:'loud',size:'sm'})"),
  yes(recipeSmallLoud),
);
add(
  'recipe.override-default',
  'recipes',
  'Small overrides the default medium spacing branch',
  selection("recipes.button({size:'sm'})"),
  yes([
    r('padding', t('spacing.sm')),
    r('color', t('colors.text')),
    r('display', 'inline-flex'),
    r('opacity', '0.5'),
  ]),
);
add(
  'recipe.boolean-false',
  'recipes',
  'False is a finite variant value rather than omission',
  selection('recipes.button({flag:false})'),
  yes([
    r('padding', t('spacing.md')),
    r('color', t('colors.text')),
    r('display', 'block'),
    r('opacity', '0.5'),
  ]),
);
add(
  'recipe.invalid-value',
  'recipes',
  'Unknown finite variant values reject with the declared domain',
  selection("recipes.button({size:'huge'})"),
  no('PMS_INVALID_VARIANT_VALUE', [
    c(
      'diagnostics/0/context',
      {
        recipeId: 'button',
        axis: 'size',
        value: 'huge',
        admitted: ['sm', 'md'],
      },
      'fields',
    ),
  ]),
);
add(
  'recipe.invalid-axis',
  'recipes',
  'Unknown variant axes reject',
  selection("recipes.button({invented:'sm'})"),
  no('PMS_INVALID_VARIANT_KEY'),
);
add(
  'recipe.determinism',
  'recipes',
  'Selection object key order cannot change declaration-axis order',
  selection("recipes.button({tone:'loud',size:'sm'})"),
  yes(recipeSmallLoud),
  {
    revisions: [
      {
        label: 'selection reordered',
        write: {
          'src/page.js': selection("recipes.button({size:'sm',tone:'loud'})"),
        },
        expected: yes(recipeSmallLoud),
        checks: [{ path: 'runtime/result', op: 'sameAsRevision', revision: 1 }],
      },
    ],
  },
);
add(
  'recipe.result-composition',
  'recipes',
  'A recipe result composes with a local spacing override',
  page("padding:token('spacing.lg')", 'recipes.button(),s.a'),
  yes([
    r('padding', t('spacing.lg')),
    r('color', t('colors.text')),
    r('display', 'inline-flex'),
    r('opacity', '0.5'),
  ]),
);
add(
  'recipe.branch-css',
  'recipes',
  'All finite branches exist without a Cartesian product',
  selection('recipes.button()'),
  yes(recipeDefault, [
    c(
      'manifest/recipes/button',
      {
        axes: {
          tone: ['quiet', 'loud'],
          size: ['sm', 'md'],
          flag: ['true', 'false'],
        },
        axisOrder: ['tone', 'size', 'flag'],
        defaults: { tone: 'quiet', size: 'md' },
      },
      'equal',
    ),
    c('rules', r('opacity', '1'), 'includes'),
    c('rules', r('display', 'block'), 'includes'),
    c('rules', r('padding', t('spacing.sm')), 'includes'),
  ]),
);
add(
  'recipe.null-selection',
  'recipes',
  'Whole-selection null means empty selection',
  selection('recipes.button(null)'),
  yes(recipeDefault),
);
add(
  'recipe.null-axis',
  'recipes',
  'Null is not a finite axis value',
  selection('recipes.button({size:null})'),
  no('PMS_INVALID_VARIANT_VALUE'),
);

add(
  'props.compiled-null-cancellation',
  'props',
  'A compiled null conflict entry cancels its earlier class without emitting a replacement',
  good + '\nexport {s};\n',
  yes(
    [],
    [
      c('runtime/result/keys', []),
      c('runtime/result/rules', []),
      c('runtime/result/classOrder', []),
    ],
  ),
  {
    observe: {
      runtime: {
        file: 'src/page.js',
        exports: ['result'],
        compiledCancellation: { export: 's', key: 'a' },
      },
    },
  },
);

const scalarRecipe = structuredClone(design);
scalarRecipe.recipes.scalar = {
  base: { display: 'block' },
  variants: { level: { '1': { opacity: 0.5 }, '2': { opacity: 1 } } },
};
add(
  'recipe.scalar-coercion',
  'recipes',
  'Baseline scalar finite selection coerces numeric values to their declared string keys',
  selection('recipes.scalar({level:2})'),
  yes([r('display', 'block'), r('opacity', '1')]),
  { designSystem: scalarRecipe },
);
for (const id of ['condition.multiple', 'condition.canonical-order']) {
  const spec = cases.find((x) => x.id === id);
  for (const step of spec.revisions)
    step.expected.push(
      c(
        'runtime/result/rules',
        [
          r('gap', t('spacing.sm')),
          r('gap', t('spacing.md'), [], '&:hover'),
          r('gap', t('spacing.lg'), ['@media (min-width: 768px)']),
        ],
        'fields',
      ),
    );
}

module.exports = {
  cases,
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
};
