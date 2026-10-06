/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
const { add, c, r, yes, t, page, imports } = require('./catalog');
const { namespaces } = require('../fixtures/sources');
add(
  'browser.shorthand-longhand',
  'browser',
  'A longhand override cancels only its component of an earlier shorthand',
  namespaces(
    "{a:{padding:token('spacing.md')},b:{paddingTop:token('spacing.sm')}}",
    's.a,s.b',
  ),
  yes(
    [],
    [
      c('browser/values', {
        'padding-top': '8px',
        'padding-right': '16px',
        'padding-bottom': '16px',
        'padding-left': '16px',
      }),
    ],
  ),
  {
    observe: {
      browser: {
        properties: [
          'padding-top',
          'padding-right',
          'padding-bottom',
          'padding-left',
        ],
      },
    },
  },
);
add(
  'browser.token-values',
  'browser',
  'Browser computed spacing and semantic color come from the authored token values',
  page("display:'grid',gap:token('spacing.md'),color:token('colors.text')"),
  yes(
    [
      r('gap', t('spacing.md')),
      r('color', t('colors.text')),
      r('display', 'grid'),
    ],
    [
      c('browser/values', {
        display: 'grid',
        gap: '16px',
        color: 'rgb(17, 34, 51)',
      }),
    ],
  ),
  { observe: { browser: { properties: ['display', 'gap', 'color'] } } },
);
add(
  'browser.theme-scope',
  'browser',
  'A composed dark theme changes the browser semantic color',
  page("color:token('colors.text')", 'themes.dark,s.a'),
  yes([], [c('browser/values', { color: 'rgb(255, 255, 255)' })]),
  { observe: { browser: { properties: ['color'] } } },
);
add(
  'browser.conflict',
  'browser',
  'Ordered composition produces the expected browser property winner',
  namespaces("{a:{display:'grid'},b:{display:'flex'}}", 's.a,s.b'),
  yes([r('display', 'flex')], [c('browser/values', { display: 'flex' })]),
  { observe: { browser: { properties: ['display'] } } },
);
add(
  'browser.media-cascade',
  'browser',
  'The applicable wide condition wins over the base spacing declaration',
  page("gap:{base:token('spacing.sm'),wide:token('spacing.lg')}"),
  yes([], [c('browser/values', { gap: '24px' })]),
  { observe: { browser: { properties: ['gap'] } } },
);
add(
  'browser.ssr-hydration',
  'browser',
  'Server rendering and browser hydration preserve compiled composition without recovery errors',
  imports +
    "const s=create({a:{display:'grid',gap:token('spacing.md')}});\nexport const result=props(s.a);\nexport const App=()=> <div data-probe {...props(s.a)}>oracle</div>;",
  yes(
    [r('gap', t('spacing.md')), r('display', 'grid')],
    [
      c('browser/values', { display: 'grid', gap: '16px' }),
      c('browser/hydrationErrors', []),
      c('browser/ssrClassMatchesBrowser', true),
    ],
  ),
  { observe: { browser: { properties: ['display', 'gap'], hydration: true } } },
);
