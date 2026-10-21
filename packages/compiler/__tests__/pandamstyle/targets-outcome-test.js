/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC2, outcome classes: every reason of the outcome function on
 * synthetic statements, and the rule that partial, prefixed, flagged and
 * unreviewed statements are never native.
 *
 * Statement fields are the compat-data compact form: `a` version_added, `r`
 * version_removed, `p` partial_implementation, `x` prefix, `n`
 * alternative_name, `f` flags, `t` note digest.
 */

const { loadCompiler } = require('./session-helpers');

const { targets } = loadCompiler();
const RANGE = { floor: '120', upTo: '149' };
const NOTE = 'aaaaaaaaaaaaaaaa';

function outcome(statements, extra = {}) {
  const { reviews = () => null, ...rest } = extra;
  return targets.statementOutcome({
    path: 'css.properties.example',
    engine: 'chrome',
    statements,
    range: RANGE,
    reviews,
    ...rest,
  });
}
const stateOf = (statements, extra) => {
  const { state, reason } = outcome(statements, extra);
  return [state, reason];
};
const reviewOf = (review) => (path, engine, note) =>
  note === NOTE ? { path, engines: [engine], note, ...review } : null;

describe('statementOutcome: one class per reason', () => {
  test.each([
    [
      'full support at the floor',
      [{ a: '100' }],
      'native',
      'full-support-at-floor',
    ],
    [
      'full support exactly at the floor',
      [{ a: '120' }],
      'native',
      'full-support-at-floor',
    ],
    [
      'full support only after the floor',
      [{ a: '125' }],
      'incompatible',
      'support-after-floor',
    ],
    [
      'ranged data at the floor',
      [{ a: '≤100' }],
      'native',
      'full-support-at-floor',
    ],
    ['ranged data above the floor', [{ a: '≤130' }], 'unknown', 'ranged-data'],
    [
      'removed within the target range',
      [{ a: '100', r: '140' }],
      'incompatible',
      'removed-before-latest',
    ],
    [
      'removed before the floor',
      [{ a: '90', r: '110' }],
      'incompatible',
      'no-support',
    ],
    ['flagged only', [{ a: '100', f: 1 }], 'incompatible', 'flagged-only'],
    [
      'prefixed only',
      [{ a: '100', x: '-webkit-' }],
      'incompatible',
      'prefixed-only',
    ],
    [
      'alternative name only',
      [{ a: '100', n: 'old-name' }],
      'incompatible',
      'alternative-name-only',
    ],
    ['preview only', [{ a: 'preview' }], 'unknown', 'preview-only'],
    ['supported, version unknown', [{ a: true }], 'unknown', 'no-data'],
    ['no data', [{ a: null }], 'unknown', 'no-data'],
    ['not supported', [{ a: false }], 'incompatible', 'no-support'],
  ])('%s', (_label, statements, state, reason) => {
    expect(stateOf(statements)).toEqual([state, reason]);
  });

  test('an engine absent from the data is unknown', () => {
    expect(stateOf(undefined)).toEqual(['unknown', 'engine-not-in-data']);
  });

  test('the emitted name is matched exactly: a prefixed emission reads only prefixed statements', () => {
    const statements = [{ a: '130' }, { a: '100', x: '-webkit-' }];
    expect(stateOf(statements, { match: { prefix: '-webkit-' } })).toEqual([
      'native',
      'full-support-at-floor',
    ]);
    expect(stateOf(statements)).toEqual([
      'incompatible',
      'support-after-floor',
    ]);
  });
});

describe('partial implementations are never native without a full partial review', () => {
  const partial = [{ a: '100', p: 1, t: NOTE }];

  test('unreviewed', () => {
    const result = outcome(partial);
    expect([result.state, result.reason]).toEqual([
      'unknown',
      'partial-implementation',
    ]);
    expect(result.caveats).toEqual([
      expect.objectContaining({ partial: true, disposition: 'unreviewed' }),
    ]);
  });

  test('a partial statement without a note cannot be reviewed', () => {
    expect(stateOf([{ a: '100', p: 1 }])).toEqual([
      'unknown',
      'partial-implementation',
    ]);
  });

  test.each([
    ['a plain note review', { disposition: 'irrelevant', rationale: 'r' }],
    [
      'a review without partial: true',
      { disposition: 'restricts', missing: 'm', rationale: 'r' },
    ],
    [
      'a partial review without `missing`',
      { partial: true, disposition: 'restricts', rationale: 'r' },
    ],
    [
      'a partial review with an empty `missing`',
      { partial: true, disposition: 'restricts', missing: ' ', rationale: 'r' },
    ],
    [
      'a partial review without a rationale',
      { partial: true, disposition: 'restricts', missing: 'm' },
    ],
  ])('%s keeps it unknown', (_label, review) => {
    expect(stateOf(partial, { reviews: reviewOf(review) })).toEqual([
      'unknown',
      'partial-implementation',
    ]);
  });

  test('a complete partial review makes it native, with the restriction recorded', () => {
    const result = outcome(partial, {
      reviews: reviewOf({
        partial: true,
        disposition: 'restricts',
        missing: 'the missing sub-behavior',
        rationale: 'why the emitted use does not depend on it',
      }),
    });
    expect([result.state, result.reason]).toEqual([
      'native',
      'reviewed-partial',
    ]);
    expect(result.caveats).toEqual([
      expect.objectContaining({
        partial: true,
        disposition: 'restricts',
        missing: 'the missing sub-behavior',
      }),
    ]);
  });

  test('a blocking partial review refuses it', () => {
    expect(
      stateOf(partial, {
        reviews: reviewOf({
          partial: true,
          disposition: 'blocking',
          missing: 'm',
          rationale: 'r',
        }),
      }),
    ).toEqual(['incompatible', 'blocking-caveat']);
  });

  test('a reviewed partial that ends with no full statement taking over is refused', () => {
    expect(
      stateOf([{ a: '100', r: '130', p: 1, t: NOTE }], {
        reviews: reviewOf({
          partial: true,
          disposition: 'restricts',
          missing: 'm',
          rationale: 'r',
        }),
      }),
    ).toEqual(['incompatible', 'removed-before-latest']);
  });

  test('a partial, flagged statement is not partial support', () => {
    expect(stateOf([{ a: '100', p: 1, f: 1, t: NOTE }])).toEqual([
      'incompatible',
      'flagged-only',
    ]);
  });
});

describe('notes on full statements need a committed review', () => {
  const noted = [{ a: '100', t: NOTE }];

  test('unreviewed note', () => {
    expect(stateOf(noted)).toEqual(['unknown', 'unreviewed-caveat']);
  });

  test('a changed note is unreviewed again', () => {
    expect(
      stateOf([{ a: '100', t: 'bbbbbbbbbbbbbbbb' }], {
        reviews: reviewOf({ disposition: 'irrelevant', rationale: 'r' }),
      }),
    ).toEqual(['unknown', 'unreviewed-caveat']);
  });

  test.each([
    ['irrelevant', 'native', 'full-support-at-floor'],
    ['restricts', 'native', 'full-support-at-floor'],
    ['blocking', 'incompatible', 'blocking-caveat'],
  ])('disposition %s', (disposition, state, reason) => {
    expect(
      stateOf(noted, { reviews: reviewOf({ disposition, rationale: 'r' }) }),
    ).toEqual([state, reason]);
  });

  test('effectiveFrom: below it the note counts as unreviewed', () => {
    const reviews = reviewOf({
      disposition: 'irrelevant',
      rationale: 'r',
      effectiveFrom: '125',
    });
    expect(stateOf(noted, { reviews })).toEqual([
      'unknown',
      'unreviewed-caveat',
    ]);
    expect(
      stateOf(noted, { reviews, range: { floor: '125', upTo: '149' } }),
    ).toEqual(['native', 'full-support-at-floor']);
    expect(
      stateOf(noted, { reviews, range: { floor: '130', upTo: '149' } }),
    ).toEqual(['native', 'full-support-at-floor']);
  });

  test('a property-scoped review accepts only its properties', () => {
    const reviews = reviewOf({
      partial: true,
      disposition: 'restricts',
      missing: 'only color applies',
      rationale: 'r',
      properties: ['color'],
    });
    const partial = [{ a: '100', p: 1, t: NOTE }];
    expect(stateOf(partial, { reviews, scope: { property: 'color' } })).toEqual(
      ['native', 'reviewed-partial'],
    );
    expect(
      stateOf(partial, { reviews, scope: { property: 'font-weight' } }),
    ).toEqual(['incompatible', 'blocking-caveat']);
  });
});

describe('featureOutcome: recognition, fixed records and platform scope', () => {
  const target = {
    engine: 'chrome',
    dataEngine: 'chrome',
    floor: '120',
    upTo: '149',
    basis: 'declared',
    platform: null,
  };
  const recordOf = (css, key) => {
    const found = targets
      .featuresOfCss(css)
      .map((entry) => entry.record)
      .find((record) => record.feature === key);
    if (found == null) throw new Error(`${key} not extracted from ${css}`);
    return found;
  };

  test('an unrecognized construct is unknown before any data is read', () => {
    const outcome = targets.featureOutcome(
      recordOf('.x{not-a-property:1}', 'property:not-a-property'),
      target,
    );
    expect(outcome).toMatchObject({
      state: 'unknown',
      reason: 'unrecognized-construct',
      basis: 'catalog',
    });
  });

  test('an obsolete-engine prefix is incompatible everywhere', () => {
    for (const name of ['-ms-flex', '-o-transition', '-khtml-user-select']) {
      expect(
        targets.featureOutcome(
          recordOf(`.x{${name}:1}`, `property:${name}`),
          target,
        ),
      ).toMatchObject({ state: 'incompatible', reason: 'obsolete-engine' });
    }
  });

  test('a platform feature is incompatible outside its platform and evaluated on it', () => {
    const record = recordOf(
      '.x{-webkit-app-region:drag}',
      'platform:electron/-webkit-app-region',
    );
    expect(targets.featureOutcome(record, target)).toMatchObject({
      state: 'incompatible',
      reason: 'platform-scoped',
    });
    const electron = {
      ...target,
      engine: 'electron',
      floor: '152',
      upTo: '152',
      basis: 'derived-from-electron',
      platform: 'electron',
    };
    expect(targets.featureOutcome(record, electron).basis).toBe(
      'derived-from-electron',
    );
  });

  test('a reviewed platform inapplicability is an equivalent fallback that keeps the data answer', () => {
    const record = recordOf('.x{resize:both}', 'property:resize');
    const ios = targets.featureOutcome(record, {
      ...target,
      engine: 'safari_ios',
      dataEngine: 'safari_ios',
      floor: '18.2',
      upTo: '26.4',
    });
    expect(ios).toMatchObject({
      state: 'equivalent-fallback',
      reason: 'platform-inapplicable',
      basis: 'catalog',
      equivalent: { kind: 'no-effect' },
    });
    expect(['incompatible', 'unknown']).toContain(ios.equivalent.data.state);
    // The same feature on an engine where it can act is not touched.
    expect(targets.featureOutcome(record, target).state).toBe('native');
  });
});

describe('parent data is never substituted: mutation self-test', () => {
  const data = targets.compatDataFromText(
    JSON.stringify({
      kind: 'pandamstyle-compat-data',
      schemaVersion: 1,
      sources: {},
      paths: {
        'css.properties.text-wrap': {
          e: { chrome: [{ a: '114' }], firefox: [{ a: '121' }] },
        },
        'css.properties.text-wrap.pretty': {
          e: { chrome: [{ a: '117' }], firefox: [{ a: false }] },
        },
      },
    }),
  );
  const childRecord = Object.freeze({
    feature: 'value:text-wrap/pretty',
    kind: 'value',
    parent: 'property:text-wrap',
    bcd: [{ path: 'css.properties.text-wrap.pretty', match: null }],
    recognized: true,
  });
  const firefox = {
    engine: 'firefox',
    dataEngine: 'firefox',
    floor: '121',
    upTo: '151',
    basis: 'declared',
    platform: null,
  };
  const parentPath = (path) => path.slice(0, path.lastIndexOf('.'));
  // A mutant of the outcome function that answers from the parent's path.
  const readsParent = (record, target, options) =>
    targets.featureOutcome(
      {
        ...record,
        bcd: record.bcd.map((b) => ({ ...b, path: parentPath(b.path) })),
      },
      target,
      options,
    );
  const childIsJudgedOnItsOwnData = (outcomeOf) =>
    outcomeOf(childRecord, firefox, { data }).state === 'incompatible';

  test('the real outcome function passes and the parent-reading mutant fails', () => {
    expect(childIsJudgedOnItsOwnData(targets.featureOutcome)).toBe(true);
    expect(childIsJudgedOnItsOwnData(readsParent)).toBe(false);
  });

  test('on the bundled data, the mutant changes every AC2 child outcome', () => {
    const { record: resolution } = targets.resolveTargets(null);
    const cases = [
      ['.x{text-wrap:pretty}', 'value:text-wrap/pretty'],
      ['.x{text-wrap:wrap}', 'value:text-wrap/wrap'],
      ['.x{color:oklch(from red l c h)}', 'function:oklch/relative'],
      ['@container style(--a: 1){.x{color:red}}', 'at-rule:container/style'],
      [
        '@container scroll-state(stuck: top){.x{color:red}}',
        'at-rule:container/scroll-state',
      ],
      ['.x{top:anchor(bottom)}', 'value:top/anchor()'],
    ];
    for (const [css, key] of cases) {
      const record = targets
        .featuresOfCss(css)
        .map((entry) => entry.record)
        .find((r) => r.feature === key);
      const real = resolution.profiles[0].engines.map(
        (target) => targets.featureOutcome(record, target).state,
      );
      const mutant = resolution.profiles[0].engines.map(
        (target) => readsParent(record, target).state,
      );
      expect({ key, differs: real.join() !== mutant.join() }).toEqual({
        key,
        differs: true,
      });
    }
  });
});
