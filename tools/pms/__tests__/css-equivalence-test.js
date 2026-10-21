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
          [
            '--v',
            [
              JSON.stringify(['dimension-token', 1, 'integer', '', 'px']),
              JSON.stringify(['ws', ' ']),
              JSON.stringify(['dimension-token', 2, 'integer', '', 'px']),
            ],
            false,
          ],
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

// CE-01.2 review round 2 (PR #117): token identity (B7, B8) and the
// micro-syntaxes minifiers rewrite (B9, B10), each with its sibling mutation.
describe('review findings B7 to B10', () => {
  const R = String.raw;
  test.each([
    [
      'B7 custom property: comment between identifiers',
      R`.a{--x:foo/**/bar;font-family:var(--x)}`,
      '.a{--x:foobar;font-family:var(--x)}',
    ],
    [
      'B7 custom property: comment inside an identifier',
      R`.a{--x:re/**/d}`,
      '.a{--x:red}',
    ],
    [
      'B7 custom property: comment between a number and a unit',
      R`.a{--x:1/**/px}`,
      '.a{--x:1px}',
    ],
    [
      'B7 outside: comment between identifiers',
      R`.a{font-family:foo/**/bar}`,
      '.a{font-family:foobar}',
    ],
    [
      'B7 outside: comment inside an identifier',
      R`.a{color:re/**/d}`,
      '.a{color:red}',
    ],
    [
      'B7 outside: comment between a number and a unit',
      R`.a{width:1/**/px}`,
      '.a{width:1px}',
    ],
    [
      'B8 an escaped digit id is not an unrestricted hash',
      R`#\31{color:red}`,
      '#1{color:red}',
    ],
    [
      'B8 an escaped digit then a letter',
      R`#\32 a{color:red}`,
      '#2a{color:red}',
    ],
    [
      'B8 an escaped hyphen then a digit',
      R`#\2d 1{color:red}`,
      '#-1{color:red}',
    ],
    [
      '  paired: An+B 2n+1 vs 2n-1',
      '.a:nth-child(2n+1){color:red}',
      '.a:nth-child(2n-1){color:red}',
    ],
    [
      '  paired: attribute value a vs b',
      '[x=a]{color:red}',
      '[x=b]{color:red}',
    ],
    [
      '  paired: a dropped attribute modifier',
      '[x="a" i]{color:red}',
      '[x=a]{color:red}',
    ],
    [
      '  paired: url(a) vs url(b)',
      '.a{background:url(a)}',
      '.a{background:url(b)}',
    ],
    ['  paired: #\\31 vs #\\32', R`#\31{color:red}`, R`#\32{color:red}`],
  ])('%s is rejected', (_, canonical, delivered) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(false);
  });

  test.each([
    [
      'B9 An+B whitespace',
      '.a:nth-child(2n + 1){color:red}',
      '.a:nth-child(2n+1){color:red}',
    ],
    [
      'B10 attribute string vs identifier, modifier kept',
      '.a[data-x="a" i]{color:red}',
      '.a[data-x=a i]{color:red}',
    ],
    [
      'B10 url() string vs url token',
      '.a{background:url("https://example.com/a.png")}',
      '.a{background:url(https://example.com/a.png)}',
    ],
  ])('%s is accepted', (_, canonical, delivered) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(true);
  });
});

// Each canonical micro-syntax, accepted, with the sibling that stays rejected.
describe('canonical micro-syntax, by the specification', () => {
  test.each([
    ['An+B odd is 2n+1', '.a:nth-child(odd){}', '.a:nth-child(2n+1){}', true],
    ['An+B even is 2n', '.a:nth-of-type(even){}', '.a:nth-of-type(2n){}', true],
    [
      'An+B -n + 3',
      '.a:nth-last-child(-n + 3){}',
      '.a:nth-last-child(-n+3){}',
      true,
    ],
    [
      'An+B n-2 dimension',
      '.a:nth-last-of-type(3n - 2){}',
      '.a:nth-last-of-type(3n-2){}',
      true,
    ],
    [
      '  paired: An+B on another pseudo-class',
      '.a:nth-child(2n+1){}',
      '.a:nth-of-type(2n+1){}',
      false,
    ],
    [
      '  paired: + separated from n',
      '.a:nth-child(+n){}',
      '.a:nth-child(+ n){}',
      false,
    ],
    [
      'An+B of S, list order and whitespace',
      '.a:nth-child(2n + 1 of .b, .c){}',
      '.a:nth-child(2n+1 of.c,.b){}',
      true,
    ],
    [
      '  paired: a different of S',
      '.a:nth-child(2n+1 of .b){}',
      '.a:nth-child(2n+1 of .c){}',
      false,
    ],
    ['attribute whitespace', '[ x = "a" ]{}', '[x=a]{}', true],
    ['attribute string needing quotes', '[x="a b"]{}', "[x='a b']{}", true],
    ['  paired: a different matcher', '[x^=a]{}', '[x$=a]{}', false],
    ['  paired: whitespace inside a matcher', '[x^=a]{}', '[x^ =a]{}', false],
    [
      'url whitespace and function case',
      '.a{b:url( "a" )}',
      '.a{b:URL(a)}',
      true,
    ],
    [
      'legacy one-colon pseudo-element',
      '.a::before{content:"a"}',
      '.a:before{content:"a"}',
      true,
    ],
    [
      '  paired: a one-colon pseudo-class stays one',
      '.a:hover{}',
      '.a::hover{}',
      false,
    ],
    [
      'font family string vs identifiers',
      '.a{font-family:"Helvetica Neue", Arial}',
      '.a{font-family:Helvetica Neue,Arial}',
      true,
    ],
    [
      'font family identifiers separated by a comment',
      '.a{font-family:foo/**/bar}',
      '.a{font-family:foo bar}',
      true,
    ],
    [
      '  paired: a generic family is not its quoted name',
      '.a{font-family:sans-serif}',
      '.a{font-family:"sans-serif"}',
      false,
    ],
    [
      '  paired: a different family',
      '.a{font-family:"Helvetica Neue"}',
      '.a{font-family:Helvetica}',
      false,
    ],
    [
      'keyframe from and to',
      '@keyframes k{from{opacity:0}to{opacity:1}}',
      '@keyframes k{0%{opacity:0}100%{opacity:1}}',
      true,
    ],
    [
      '  paired: from and to swapped',
      '@keyframes k{from{opacity:0}to{opacity:1}}',
      '@keyframes k{to{opacity:0}from{opacity:1}}',
      false,
    ],
    [
      '  paired: from outside keyframes',
      '.from{color:red}',
      '.0%{color:red}',
      false,
    ],
    [
      'prelude: after ) before and',
      '@media (a:b) and (c:d){.a{color:red}}',
      '@media (a:b)and (c:d){.a{color:red}}',
      true,
    ],
    [
      'prelude: around a range operator',
      '@media (width >= 600px){.a{color:red}}',
      '@media (width>=600px){.a{color:red}}',
      true,
    ],
    [
      '  paired: inside a range operator',
      '@media (width >= 600px){.a{color:red}}',
      '@media (width > = 600px){.a{color:red}}',
      false,
    ],
    [
      '  paired: a different range operator',
      '@media (width >= 600px){.a{color:red}}',
      '@media (width > 600px){.a{color:red}}',
      false,
    ],
  ])('%s', (_, canonical, delivered, equivalent) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(
      equivalent,
    );
  });
});

// CE-01.2 bounded verification (PR #117): a canonicaliser equates two
// spellings only when both are valid under its strict grammar; otherwise the
// tokens are compared (fail-closed). B11, B12 and one invalid form per
// canonicaliser, each against its valid spelling.
describe('fail-closed canonicalisers (B11, B12)', () => {
  test.each([
    [
      'B11 font-family: generic first',
      '.a{font-family:"serif foo"}',
      '.a{font-family:serif foo}',
    ],
    [
      'B11 font-family: hyphenated generic first',
      '.a{font-family:"sans-serif foo"}',
      '.a{font-family:sans-serif foo}',
    ],
    [
      'B11 font-family: monospace first',
      '.a{font-family:"monospace bar"}',
      '.a{font-family:monospace bar}',
    ],
    [
      'font-family invalid: default in a sequence',
      '.a{font-family:"default foo"}',
      '.a{font-family:default foo}',
    ],
    [
      'font-family invalid: a CSS-wide keyword in a sequence',
      '.a{font-family:"Foo inherit"}',
      '.a{font-family:Foo inherit}',
    ],
    [
      'font-family invalid: a ui-* identifier in a sequence',
      '.a{font-family:"ui-x foo"}',
      '.a{font-family:ui-x foo}',
    ],
    [
      'B12 attribute: space before | after *',
      '[*|x]{color:red}',
      '[* |x]{color:red}',
    ],
    [
      'B12 attribute: space after a lone |',
      '[|x]{color:red}',
      '[| x]{color:red}',
    ],
    ['B12 attribute: space after *|', '[*|x]{color:red}', '[*| x]{color:red}'],
    [
      'attribute invalid: space around a named namespace',
      '[a|x]{color:red}',
      '[a |x]{color:red}',
    ],
    [
      'attribute invalid: an unknown modifier',
      '[x="a" i]{color:red}',
      '[x="a" j]{color:red}',
    ],
    [
      'attribute invalid: an unquoted value with a space',
      '[x="a b"]{color:red}',
      '[x=a b]{color:red}',
    ],
    [
      'An+B invalid: two signs',
      '.a:nth-child(2n+1){color:red}',
      '.a:nth-child(2n + +1){color:red}',
    ],
    [
      'An+B invalid: a sign apart from n',
      '.a:nth-child(-n){color:red}',
      '.a:nth-child(- n){color:red}',
    ],
    [
      'An+B invalid: an empty of S',
      '.a:nth-child(2n+1 of .b){color:red}',
      '.a:nth-child(2n+1 of){color:red}',
    ],
    [
      'An+B invalid: an empty of S entry',
      '.a:nth-child(2n+1 of .b, .c){color:red}',
      '.a:nth-child(2n+1 of .b,){color:red}',
    ],
    [
      'url invalid: two arguments',
      '.a{background:url(a)}',
      '.a{background:url("a" x)}',
    ],
    [
      'pseudo-element invalid inside :is()',
      '.a:is(::before){color:red}',
      '.a:is(:before){color:red}',
    ],
    [
      'keyframes invalid: two keywords in one selector',
      '@keyframes k{from,to{opacity:0}}',
      '@keyframes k{0% 100%{opacity:0}}',
    ],
    [
      'keyframes invalid: from and to as one selector',
      '@keyframes k{from to{opacity:0}}',
      '@keyframes k{0% 100%{opacity:0}}',
    ],
    [
      'prelude invalid: after ) inside selector() is a descendant combinator',
      '@supports selector(:is(.a) .b){.a{color:red}}',
      '@supports selector(:is(.a).b){.a{color:red}}',
    ],
    [
      'prelude invalid: inside a range operator',
      '@media (width >= 1px){.a{color:red}}',
      '@media (width > = 1px){.a{color:red}}',
    ],
  ])('%s is rejected', (_, canonical, delivered) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(false);
  });

  test.each([
    [
      'font-family: a valid identifier sequence',
      '.a{font-family:"Helvetica Neue", Arial}',
      '.a{font-family:Helvetica Neue,Arial}',
    ],
    [
      'font-family: a lone generic stays a keyword',
      '.a{font-family:system-ui, sans-serif}',
      '.a{font-family:system-ui,sans-serif}',
    ],
    [
      'attribute: a namespace without whitespace',
      '[*|x="a"]{color:red}',
      '[*|x=a]{color:red}',
    ],
    [
      'pseudo-element at the top level',
      '.a::before{content:"a"}',
      '.a:before{content:"a"}',
    ],
    [
      'keyframes: one keyword per selector',
      '@keyframes k{from{opacity:0}}',
      '@keyframes k{0%{opacity:0}}',
    ],
  ])('%s is still accepted', (_, canonical, delivered) => {
    expect(declarationEquivalence(canonical, delivered).equivalent).toBe(true);
  });
});
