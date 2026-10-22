/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) PR A: the closed grammar subset of property descriptors and
 * numeric literals with one canonical spelling.
 *
 *   - compileGrammar splits only top-level `|` alternatives into keyword,
 *     numeric and opaque branches; an unparsable grammar throws;
 *   - every descriptor's `standard` value is either matched by a keyword or
 *     numeric branch, or listed in its reviewed `opaqueValues`, never both;
 *   - numeric literals: each refusal reason, the canonical spelling and the
 *     CSS zero, over every numeric type;
 *   - units come from the one unit table (targets/units.js);
 *   - G1: value acceptance (engine/lowering/styles.js) never parses grammar
 *     or tokenizes.
 */

const fs = require('fs');
const path = require('path');
const { loadCompiler } = require('./session-helpers');

const compiler = loadCompiler();
const REPO = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO, 'packages/compiler/src');

const admitted = compiler
  .descriptorKeys()
  .map((key) => compiler.descriptorOf(key))
  .filter((d) => d.standard != null);

describe('compileGrammar', () => {
  test.each([
    ['auto | min-content', ['auto', 'min-content'], [], []],
    ['<number [0,1]>', [], [['number', 0, 1]], []],
    ['none | <number [0,∞]>', ['none'], [['number', 0, null]], []],
    [
      'auto | <length-percentage [0,∞]> | fit-content(<length-percentage [0,∞]>)',
      ['auto'],
      [['length-percentage', 0, null]],
      ['fit-content(<length-percentage [0,∞]>)'],
    ],
    ['<time [0s,∞]>', [], [['time', 0, null]], []],
    ['<time>', [], [['time', null, null]], []],
    ['<integer [1,12]>', [], [['integer', 1, 12]], []],
    ['<length-percentage>', [], [['length-percentage', null, null]], []],
    // Not interpreted: a multiplier, a property reference, `||`, `#`, a
    // group, another data type.
    ["<'padding-top'>{1,4}", [], [], ["<'padding-top'>{1,4}"]],
    ["<'padding-top'>", [], [], ["<'padding-top'>"]],
    ['<time [0s,∞]>#', [], [], ['<time [0s,∞]>#']],
    ['<length>{1,2}', [], [], ['<length>{1,2}']],
    ['normal | <x> || <y>', ['normal'], [], ['<x> || <y>']],
    ['[ a | b ]', [], [], ['[ a | b ]']],
    ['<color>', [], [], ['<color>']],
    [
      '<number> | <percentage>',
      [],
      [
        ['number', null, null],
        ['percentage', null, null],
      ],
      [],
    ],
  ])('%s', (text, keywords, numeric, opaque) => {
    const compiled = compiler.compileGrammar(text);
    expect(compiled.keywords).toEqual(keywords);
    expect(compiled.numeric.map((c) => [c.type, c.min, c.max])).toEqual(
      numeric,
    );
    expect(compiled.opaque).toEqual(opaque);
    expect(Object.isFrozen(compiled)).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['a | | b', 'empty alternative'],
    ['[ a | b', 'unbalanced'],
    ['a ] b', 'unbalanced'],
    ['<number [∞,1]>', 'lower bound'],
    ['<number [0,-∞]>', 'upper bound'],
    ['<time [1,∞]>', 'unit'],
    ['<length [0px,∞]>', 'unsupported range bound'],
    ['<length [0s,∞]>', 'unexpected unit'],
    ['<number [a,b]>', 'unsupported range bound'],
  ])('%j is refused (%s)', (text, message) => {
    expect(() => compiler.compileGrammar(text)).toThrow(message);
  });

  test('units come from the one unit table', () => {
    const lp = compiler.numericConstraint('<length-percentage>');
    expect(lp.units).toEqual([...compiler.unitsOfType('length'), '%']);
    expect(compiler.unitsOfType('length')).toEqual(
      expect.arrayContaining([
        'px',
        'rem',
        'em',
        'ch',
        'vw',
        'dvh',
        'cqi',
        'q',
      ]),
    );
    expect(compiler.unitsOfType('length')).not.toContain('deg');
    expect(compiler.numericConstraint('<time>').units).toEqual(['ms', 's']);
    expect(compiler.numericConstraint('<number>').units).toEqual([]);
    expect(compiler.numericConstraint('<percentage>').units).toEqual(['%']);
  });
});

describe('the descriptor catalog grammar', () => {
  test('every grammar compiles and standard.numeric is its numeric branches', () => {
    for (const d of compiler.descriptorKeys().map(compiler.descriptorOf)) {
      const compiled = compiler.compileGrammar(d.grammar);
      expect(compiler.grammarOf(d.key)).toEqual(compiled);
      if (d.standard != null) {
        expect(d.standard.numeric).toEqual(compiled.numeric);
      }
    }
  });

  // The reviewed opaque values are exactly the standard values no keyword or
  // numeric branch matches: nothing unreviewed, nothing redundant.
  test.each(admitted.map((d) => [d.key, d]))(
    '%s: standard values are grammar-matched or reviewed opaque, exclusively',
    (_, d) => {
      const grammar = compiler.grammarOf(d.key);
      const matched = (v) =>
        (typeof v === 'string' && grammar.keywords.includes(v)) ||
        compiler.checkNumericLiteral(d.standard.numeric, v)?.ok === true;
      for (const v of d.standard.values) {
        expect({ v, opaque: d.opaqueValues.includes(v) }).toEqual({
          v,
          opaque: !matched(v),
        });
      }
      for (const v of d.opaqueValues) expect(d.standard.values).toContain(v);
      // A default value is a standard value.
      for (const v of d.default.values) expect(d.standard.values).toContain(v);
    },
  );

  test('every grammar-matched standard number is in its canonical spelling', () => {
    for (const d of admitted) {
      for (const v of d.standard.values) {
        const result = compiler.checkNumericLiteral(d.standard.numeric, v);
        if (result?.ok !== true) continue;
        expect({ key: d.key, v, canonical: true }).toEqual({
          key: d.key,
          v,
          canonical: compiler.isCanonicalSpelling(v, result.canonical),
        });
      }
    }
  });
});

describe('numeric literals', () => {
  const C = (text) => [compiler.numericConstraint(text)];
  const LP0 = C('<length-percentage [0,∞]>');
  const LP = C('<length-percentage>');
  const NUM01 = C('<number [0,1]>');
  const NUM0 = C('<number [0,∞]>');
  const INT = C('<integer [1,12]>');
  const TIME0 = C('<time [0s,∞]>');
  const PCT = C('<percentage>');
  const ok = (canonical) => ({ ok: true, canonical });
  const no = (reason) => ({ ok: false, reason });

  test.each([
    // Canonical spellings.
    [LP0, '18px', ok('18px')],
    [LP0, '18.5px', ok('18.5px')],
    [LP0, '18.50px', ok('18.5px')],
    [LP0, '+18px', ok('18px')],
    [LP0, '.5rem', ok('0.5rem')],
    [LP0, '18PX', ok('18px')],
    [LP0, ' 18px ', ok('18px')],
    [LP0, '1e1px', ok('10px')],
    [LP0, '50%', ok('50%')],
    [LP0, '0', ok('0')],
    [LP0, 0, ok('0')],
    [LP0, -0, ok('0')],
    [LP0, '0px', ok('0')],
    [LP0, '-0px', ok('0')],
    [LP0, '0%', ok('0%')],
    [LP0, '46ch', ok('46ch')],
    [LP0, '100dvh', ok('100dvh')],
    [LP, '-4px', ok('-4px')],
    [NUM01, 0.5, ok(0.5)],
    [NUM01, '0.5', ok(0.5)],
    [NUM01, -0, ok(0)],
    [NUM01, 0.0001, ok(0.0001)],
    [NUM0, 1000000, ok(1000000)],
    [INT, 12, ok(12)],
    [TIME0, '200ms', ok('200ms')],
    [TIME0, '0.2s', ok('0.2s')],
    [TIME0, '0s', ok('0s')],
    [TIME0, '0ms', ok('0ms')],
    [PCT, '0%', ok('0%')],
    // Refusals.
    [NUM01, NaN, no('non-finite')],
    [NUM01, Infinity, no('non-finite')],
    [LP, -Infinity, no('non-finite')],
    [NUM0, 1e6 + 1, no('out-of-bounds')],
    [NUM0, 1e308, no('out-of-bounds')],
    [LP0, '1e308px', no('out-of-bounds')],
    [LP0, '-4px', no('out-of-bounds')],
    [LP0, '-1%', no('out-of-bounds')],
    [NUM01, 1.5, no('out-of-bounds')],
    [TIME0, '-1ms', no('out-of-bounds')],
    [INT, 13, no('out-of-bounds')],
    [LP0, 18, no('number-not-length')],
    [LP0, '18', no('number-not-length')],
    [TIME0, 200, no('number-not-length')],
    [TIME0, 0, no('number-not-length')],
    [LP0, '18deg', no('unit-not-applicable')],
    [LP0, '18furlongs', no('unit-not-applicable')],
    [LP0, '18s', no('unit-not-applicable')],
    [NUM01, '0.5px', no('unit-not-applicable')],
    [PCT, '18px', no('unit-not-applicable')],
    [INT, 1.5, no('non-integer')],
    [NUM01, 0.12345, no('precision')],
    [NUM0, 0.1 + 0.2, no('precision')],
    [LP0, '0.00001px', no('precision')],
    [NUM0, 1e-7, no('precision')],
  ])('%#: %j', (constraints, input, expected) => {
    expect(compiler.checkNumericLiteral(constraints, input)).toEqual(expected);
  });

  test.each([
    ['auto'],
    ['calc(1px)'],
    ['18px 4px'],
    [''],
    [null],
    [{}],
    [true],
  ])('%j is not a numeric literal', (input) => {
    expect(compiler.checkNumericLiteral(LP0, input)).toBe(null);
  });

  test('no constraint, no reading', () => {
    expect(compiler.checkNumericLiteral([], '18px')).toBe(null);
    expect(compiler.checkNumericLiteral(null, '18px')).toBe(null);
  });

  test('the most specific reason wins across alternative constraints', () => {
    // lineHeight: <number [0,∞]> | <length-percentage [0,∞]>.
    const lineHeight = [...NUM0, ...LP0];
    expect(compiler.checkNumericLiteral(lineHeight, 1.5)).toEqual(ok(1.5));
    expect(compiler.checkNumericLiteral(lineHeight, '24px')).toEqual(
      ok('24px'),
    );
    expect(compiler.checkNumericLiteral(lineHeight, '-24px')).toEqual(
      no('out-of-bounds'),
    );
    expect(compiler.checkNumericLiteral(lineHeight, '24deg')).toEqual(
      no('unit-not-applicable'),
    );
  });

  test('the caps are the engine rounding and a 1e6 magnitude', () => {
    expect(compiler.FRACTION_DIGITS).toBe(4);
    expect(compiler.MAGNITUDE).toBe(1e6);
    // An admitted number serializes exactly through the engine rounding.
    for (const v of [0.0001, 0.3333, 999999.9999, 0.05, 1.5]) {
      expect(String(Math.round(v * 10000) / 10000)).toBe(String(v));
    }
  });
});

describe('G1: value acceptance never parses grammar', () => {
  test('engine/lowering/styles.js imports no parser or tokenizer', () => {
    const text = fs.readFileSync(
      path.join(SRC, 'engine/lowering/styles.js'),
      'utf8',
    );
    const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const forbidden of [
      '@csstools/css-tokenizer',
      'postcss-value-parser',
      '../../design-system/policy/grammar',
      '../../design-system/policy/literals',
    ]) {
      expect(imports).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/compileGrammar|numericFactsOfValue|tokenize\(/);
  });

  test('the token numeric facts are recorded at registry build', () => {
    const text = fs.readFileSync(
      path.join(SRC, 'design-system/registry/index.js'),
      'utf8',
    );
    expect(text).toMatch(/recordNumericFacts\(registry\)/);
  });
});
