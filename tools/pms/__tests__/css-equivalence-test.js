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
  const ident = (value) => JSON.stringify(['ident-token', value]);
  const delim = (value) => JSON.stringify(['delim-token', value]);

  test('keeps block structure and declarations in order', () => {
    const [statement, layer, property] = normalizeCss(
      '@layer a, b;\n@layer a{@media (hover: hover){.x , .y>z{color : red ;--v:1px 2px}}}@property --p{syntax:"<length>";inherits:true}',
    );
    expect(statement).toEqual({
      at: 'layer',
      prelude: [ident('a'), 'comma-token', ident('b')],
      block: null,
    });
    expect(layer.at).toBe('layer');
    const [media] = layer.block.rules;
    expect(media).toMatchObject({
      at: 'media',
      prelude: [
        '(-token',
        ident('hover'),
        'colon-token',
        ident('hover'),
        ')-token',
      ],
    });
    expect(media.block.rules).toEqual([
      {
        rule: [
          JSON.stringify([delim('.'), ident('x')]),
          JSON.stringify([delim('.'), ident('y'), delim('>'), ident('z')]),
        ],
        declarations: [
          ['color', [ident('red')], false],
          ['--v', '1px 2px', false],
        ],
      },
    ]);
    expect(property).toMatchObject({
      at: 'property',
      block: {
        declarations: [
          ['syntax', [JSON.stringify(['string-token', '<length>'])], false],
          ['inherits', [ident('true')], false],
        ],
      },
    });
  });

  test('a selector list inside a function is not split', () => {
    expect(normalizeCss('.a:is(.b, .c){color:red}')[0].rule).toHaveLength(1);
  });

  test('an unbalanced stylesheet is refused, never compared', () => {
    expect(() => normalizeCss('.a{color:red')).toThrow(/unbalanced/);
  });
});

// CE-01.2 review round 1 (PR #117): each finding, reproduced.
describe('review findings B1 to B6', () => {
  test.each([
    [
      'B1 a descendant combinator after ]',
      '[title] .a{color:red}',
      '[title].a{color:red}',
    ],
    [
      'B1 a descendant combinator after )',
      '.a:is(:where(.b) .c){color:red}',
      '.a:is(:where(.b).c){color:red}',
    ],
    [
      'B2 a comment between identifiers',
      '.a{font-family:foo/**/bar}',
      '.a{font-family:foobar}',
    ],
    ['B2 a comment inside an identifier', '.a{color:re/**/d}', '.a{color:red}'],
    [
      'B2 a comment between a number and a unit',
      '.a{width:1/**/px}',
      '.a{width:1px}',
    ],
    ['B3 custom property whitespace', '.a{--x: a  b}', '.a{--x:a b}'],
    [
      'B4 two anonymous layers merged into one',
      '@layer{.a{color:red!important}}@layer{.a{color:blue!important}}',
      '@layer{.a{color:red!important}.a{color:blue!important}}',
    ],
  ])('%s is rejected', (_, canonical, delivered) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(false);
  });

  // Produced at test time by the minifiers the review executed.
  const esbuild = require('esbuild');
  const lightningcss = require('lightningcss');
  const esbuildMinified = (css) =>
    esbuild.transformSync(css, { loader: 'css', minifyWhitespace: true }).code;
  const lightningMinified = (css) =>
    lightningcss
      .transform({ filename: 'x.css', code: Buffer.from(css), minify: true })
      .code.toString();

  test.each([
    [
      'B5 esbuild minifyWhitespace',
      '@media (width: 1px){.a{color: red}}',
      esbuildMinified,
      '@media(width:1px){.a{color:red}}\n',
    ],
    [
      'B6 Lightning CSS lowercases a property name',
      '.a{COLOR:red}',
      lightningMinified,
      '.a{color:red}',
    ],
    [
      'B6 Lightning CSS decodes an escaped class',
      '.\\61{color:red}',
      lightningMinified,
      '.a{color:red}',
    ],
  ])('%s is accepted', (_, canonical, minify, observed) => {
    const delivered = minify(canonical);
    expect(delivered).toBe(observed);
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(true);
  });
});

// Whitespace is significant by default. Each grammar position where it is
// not is accepted, and the same shape is rejected where it is significant.
describe('the whitespace allow-list, with paired rejections', () => {
  test.each([
    [
      'next to a selector-list comma',
      '.a, .b{color:red}',
      '.a,.b{color:red}',
      true,
    ],
    [
      'next to a value comma',
      '.a{transition-property:color, opacity}',
      '.a{transition-property:color,opacity}',
      true,
    ],
    [
      'around a child combinator',
      '.a > .b{color:red}',
      '.a>.b{color:red}',
      true,
    ],
    [
      'around a sibling combinator',
      '.a ~ .b + .c{color:red}',
      '.a~.b+.c{color:red}',
      true,
    ],
    [
      '  paired: the descendant combinator',
      '.a .b{color:red}',
      '.a.b{color:red}',
      false,
    ],
    [
      '  paired: + inside a value is not a combinator',
      '.a{width:calc(1px + 2px)}',
      '.a{width:calc(1px +2px)}',
      false,
    ],
    [
      'after an opening parenthesis and before a closing one',
      '.a{width:calc( 1px )}',
      '.a{width:calc(1px)}',
      true,
    ],
    [
      '  paired: after a closing parenthesis',
      '.a{margin:var(--a) var(--b)}',
      '.a{margin:var(--a)var(--b)}',
      false,
    ],
    [
      'next to a colon inside parentheses',
      '@media (min-width : 1px){.a{color:red}}',
      '@media (min-width:1px){.a{color:red}}',
      true,
    ],
    [
      '  paired: a pseudo-class colon inside :is()',
      '.x:is(.a :hover){color:red}',
      '.x:is(.a:hover){color:red}',
      false,
    ],
    [
      '  paired: before a colon outside parentheses',
      '.a :hover{color:red}',
      '.a:hover{color:red}',
      false,
    ],
    [
      'after an at-keyword before (',
      '@media (hover:hover){.a{color:red}}',
      '@media(hover:hover){.a{color:red}}',
      true,
    ],
    [
      '  paired: between an identifier and (',
      '@media screen and (hover:hover){.a{color:red}}',
      '@media screen and(hover:hover){.a{color:red}}',
      false,
    ],
    ['at the edges of a value', '.a{ color : red }', '.a{color:red}', true],
    [
      '  paired: between identifiers inside a value',
      '.a{margin:0 auto}',
      '.a{margin:0auto}',
      false,
    ],
    [
      '  paired: between numbers inside a value',
      '.a{margin:1px 2px}',
      '.a{margin:1px/**/2px}',
      false,
    ],
    [
      'at the edges of a custom property value',
      '.a{--x: a b }',
      '.a{--x:a b}',
      true,
    ],
    [
      '  paired: inside a custom property value',
      '.a{--x:a b}',
      '.a{--x:a  b}',
      false,
    ],
    [
      'before !important',
      '.a{color:red !important}',
      '.a{color:red!important}',
      true,
    ],
  ])('%s', (_, canonical, delivered, equivalent) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(
      equivalent,
    );
  });
});

describe('tokens compare by decoded value', () => {
  test.each([
    ['an escaped identifier', '.a{color:red}', '.\\61{color:red}', true],
    ['quote style of a string', ".a{content:'x'}", '.a{content:"x"}', true],
    [
      'an ASCII-uppercase at-rule name',
      '@MEDIA (hover:hover){.a{color:red}}',
      '@media (hover:hover){.a{color:red}}',
      true,
    ],
    [
      '  class names stay case-sensitive',
      '.A{color:red}',
      '.a{color:red}',
      false,
    ],
    [
      '  custom property names stay case-sensitive',
      '.a{--X:1}',
      '.a{--x:1}',
      false,
    ],
    [
      '  value identifiers stay case-sensitive',
      '.a{color:RED}',
      '.a{color:red}',
      false,
    ],
    ['  an integer is not a number', '.a{z-index:1}', '.a{z-index:1.0}', false],
  ])('%s', (_, canonical, delivered, equivalent) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(
      equivalent,
    );
  });
});
