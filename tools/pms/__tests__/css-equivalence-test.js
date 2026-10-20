/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

// CE-01.2 (AC3): the declaration-equivalence normaliser shared by the Vite,
// Rsbuild and Next qualifications. Accepted: minification, stripped comments
// and a reordered selector list. Rejected: any dropped, added, merged,
// reordered or rewritten declaration or rule.

const {
  declarationEquivalence,
  normalizeCss,
} = require('../css-equivalence.cjs');

const HEADER =
  '/* pandamstyle-design-system {"systemId":"oracle-ui","registryDigest":"46071e4d8cd937bf","abiVersion":1,"compilerContractVersion":"pms-0.1","manifestSchemaVersion":1} */';

// The canonical styles.css and the Next 16.3.8 webpack production asset
// observed for the same fixture (CE-01.2 note §10.3).
const CANONICAL = `${HEADER}
:root, .x5jm8p5{--x806e8r:8px;--x1efyk35:16px;}
.x1jmeyti.x1jmeyti, .x1jmeyti.x1jmeyti:root{--x1wcnge4:#112233;--x19gs4d:#ffffff;}
.x1db5p44:not(#\\#){padding:var(--x1efyk35)}
@media (min-width: 768px){.xr1eeyi:not(#\\#){padding:var(--x806e8r)}}
.x87ps6o:not(#\\#):not(#\\#){-webkit-user-select:none;user-select:none}
`;
const NEXT_OBSERVED =
  '.x5jm8p5,:root{--x806e8r:8px;--x1efyk35:16px}.x1jmeyti.x1jmeyti,.x1jmeyti.x1jmeyti:root{--x1wcnge4:#112233;--x19gs4d:#ffffff}.x1db5p44:not(#\\#){padding:var(--x1efyk35)}@media (min-width:768px){.xr1eeyi:not(#\\#){padding:var(--x806e8r)}}.x87ps6o:not(#\\#):not(#\\#){-webkit-user-select:none;user-select:none}';

const equivalent = (delivered) => declarationEquivalence(CANONICAL, delivered);

describe('accepted: the same declarations, written differently', () => {
  test.each([
    ['the canonical text itself', CANONICAL],
    ['the observed Next minified asset', NEXT_OBSERVED],
    [
      'minified (whitespace, final semicolons)',
      NEXT_OBSERVED.replace(/}/g, '}\n'),
    ],
    ['comment-stripped', CANONICAL.replace(HEADER, '')],
    [
      'with added comments and whitespace',
      CANONICAL.replace('{padding:', '{ /* c */ padding : '),
    ],
    [
      'selector-list reordered',
      CANONICAL.replace(
        '.x1jmeyti.x1jmeyti, .x1jmeyti.x1jmeyti:root',
        '.x1jmeyti.x1jmeyti:root,.x1jmeyti.x1jmeyti',
      ),
    ],
  ])('%s', (_, delivered) => {
    const result = equivalent(delivered);
    expect(result).toMatchObject({ equivalent: true, difference: null });
    expect(result.rules).toEqual({ canonical: 5, delivered: 5 });
  });
});

describe('rejected: a host redefining the CSS', () => {
  test.each([
    [
      'a dropped -webkit- declaration (observed: Rsbuild with chrome >= 100)',
      CANONICAL.replace('-webkit-user-select:none;', ''),
    ],
    [
      'reordered declarations',
      CANONICAL.replace(
        '-webkit-user-select:none;user-select:none',
        'user-select:none;-webkit-user-select:none',
      ),
    ],
    [
      'a merged rule',
      CANONICAL.replace(
        '.x1db5p44:not(#\\#){padding:var(--x1efyk35)}\n',
        '',
      ).replace(
        ':root, .x5jm8p5{',
        ':root, .x5jm8p5, .x1db5p44:not(#\\#){padding:var(--x1efyk35);',
      ),
    ],
    ['a changed value', CANONICAL.replace('#ffffff', '#fff')],
    [
      'an added declaration',
      CANONICAL.replace(
        '{padding:var(--x1efyk35)}',
        '{padding:var(--x1efyk35);margin:0}',
      ),
    ],
    [
      'a dropped !important',
      `${CANONICAL}.a{color:red!important}`.replace('!important', ''),
    ],
    [
      'a changed at-rule condition',
      CANONICAL.replace('(min-width: 768px)', '(min-width: 769px)'),
    ],
    [
      'reordered rules',
      CANONICAL.replace(
        '.x1db5p44:not(#\\#){padding:var(--x1efyk35)}\n@media (min-width: 768px){.xr1eeyi:not(#\\#){padding:var(--x806e8r)}}',
        '@media (min-width: 768px){.xr1eeyi:not(#\\#){padding:var(--x806e8r)}}\n.x1db5p44:not(#\\#){padding:var(--x1efyk35)}',
      ),
    ],
    [
      'a dropped rule',
      CANONICAL.replace('.x1db5p44:not(#\\#){padding:var(--x1efyk35)}', ''),
    ],
    ['an added rule', `${CANONICAL}.extra{color:red}`],
    [
      'a changed selector',
      CANONICAL.replace('.x87ps6o:not(#\\#):not(#\\#)', '.x87ps6o:not(#\\#)'),
    ],
  ])('%s', (_, delivered) => {
    const result = equivalent(delivered);
    expect(result.equivalent).toBe(false);
    expect(result.difference).toEqual(
      expect.objectContaining({ index: expect.any(Number) }),
    );
  });
});

describe('the normal form', () => {
  test('flattens at-rule conditions and keeps declarations in order', () => {
    expect(
      normalizeCss(
        '@layer a, b;\n@layer a{@media (hover: hover){.x , .y>z{color : red ;--v:1px 2px}}}@property --p{syntax:"<length>";inherits:true}',
      ),
    ).toEqual([
      { at: ['@layer a,b'], selectors: null, declarations: [] },
      {
        at: ['@layer a', '@media (hover:hover)'],
        selectors: ['.x', '.y>z'],
        declarations: ['color:red', '--v:1px 2px'],
      },
      {
        at: ['@property --p'],
        selectors: null,
        declarations: ['syntax:"<length>"', 'inherits:true'],
      },
    ]);
  });

  test('a selector list inside a function is not split', () => {
    expect(normalizeCss('.a:is(.b, .c){color:red}')[0].selectors).toEqual([
      '.a:is(.b,.c)',
    ]);
  });

  test('an unbalanced stylesheet is refused, never compared', () => {
    expect(() => normalizeCss('.a{color:red')).toThrow(/unbalanced/);
  });
});
