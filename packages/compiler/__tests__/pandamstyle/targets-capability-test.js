/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC2 on the bundled data: property support is never
 * substituted for keyword or subfeature support, and partial implementations
 * and browser bugs stay visible.
 *
 * Each case is emitted CSS and the outcomes of the feature keys extracted from
 * it on `pandamstyle:default@1`. A value is the state when every engine agrees,
 * otherwise `{ engine: "state/reason" }`. Every expected value was observed by
 * running the evaluator on BCD 8.1.6 before it was written here.
 *
 * Constructs whose property lies outside the emittable data set
 * (`container-type`, `mask`, `anchor-name`, `view-transition-name`) are
 * `unknown/unrecognized-construct`: they fail closed and borrow nothing.
 */

const { loadCompiler } = require('./session-helpers');

const { targets } = loadCompiler();
const { record: DEFAULT } = targets.resolveTargets(null);

function outcomesOf(css, keys) {
  const records = new Map(
    targets.featuresOfCss(css).map(({ record }) => [record.feature, record]),
  );
  const out = {};
  for (const key of keys) {
    const record = records.get(key);
    if (record == null) {
      out[key] = 'not-extracted';
      continue;
    }
    const [profile] = targets.profileOutcomes(record, DEFAULT);
    const engines = Object.fromEntries(
      profile.engines.map((o) => [
        o.engine,
        o.state === 'native' ? 'native' : `${o.state}/${o.reason}`,
      ]),
    );
    const values = new Set(Object.values(engines));
    out[key] = values.size === 1 ? [...values][0] : engines;
  }
  return out;
}

const CASES = {
  layers: {
    '@layer a, b;': {
      'at-rule:layer/statement': 'native',
    },
    '@layer a{.x{color:red !important}}': {
      'at-rule:layer/block': 'native',
      'combination:at-rule:layer/block+important': 'native',
    },
  },
  ':has()': {
    '.x:has(.y){color:red}': {
      'selector::has': 'native',
    },
    '.x:has(:has(.y)){color:red}': {
      'selector::has': 'native',
      'combination:selector:has+selector:has':
        'incompatible/invalid-combination',
    },
    '.x:has(::before){color:red}': {
      'selector::has': 'native',
      'combination:selector:has+pseudo-element':
        'incompatible/invalid-combination',
    },
  },
  'containers: query kinds and units': {
    '@container (min-width: 400px){.x{width:50cqi}}': {
      'at-rule:container': 'native',
      'unit:cqi': 'native',
    },
    '@container style(--a: 1){.x{color:red}}': {
      'at-rule:container': 'native',
      'at-rule:container/style': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'unknown/unreviewed-caveat',
        safari_ios: 'unknown/unreviewed-caveat',
      },
    },
    '@container scroll-state(stuck: top){.x{color:red}}': {
      'at-rule:container': 'native',
      'at-rule:container/scroll-state': {
        chrome: 'incompatible/support-after-floor',
        chrome_android: 'incompatible/support-after-floor',
        edge: 'incompatible/support-after-floor',
        firefox: 'incompatible/no-support',
        firefox_android: 'incompatible/no-support',
        safari: 'incompatible/no-support',
        safari_ios: 'incompatible/no-support',
      },
    },
    '.x{container-type:inline-size}': {
      'property:container-type': 'unknown/unrecognized-construct',
    },
  },
  'typed custom properties: @property and its descriptors': {
    '@property --x{syntax:"<color>";inherits:false;initial-value:red}': {
      'at-rule:property': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
      'descriptor:property/syntax': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
      'descriptor:property/inherits': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
      'descriptor:property/initial-value': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
    },
  },
  'intrinsic sizes': {
    '.x{width:fit-content}': {
      'property:width': 'native',
      'value:width/fit-content': 'native',
    },
  },
  'text-wrap keywords': {
    '.x{text-wrap:balance}': {
      'property:text-wrap': 'native',
      'value:text-wrap/balance': 'native',
    },
    '.x{text-wrap:pretty}': {
      'property:text-wrap': 'native',
      'value:text-wrap/pretty': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/no-support',
        firefox_android: 'incompatible/no-support',
        safari: 'incompatible/support-after-floor',
        safari_ios: 'incompatible/support-after-floor',
      },
    },
  },
  'display multi-keyword values': {
    '.x{display:inline flex}': {
      'property:display': 'native',
      'value:display/inline': 'native',
      'value:display/flex': 'native',
      'value:display/multi-keyword': 'native',
    },
  },
  colors: {
    '.x{color:#ff000080}': {
      'property:color': 'native',
      'value:color/alpha-hex': 'native',
    },
    '.x{color:oklch(50% 0.1 120)}': {
      'property:color': 'native',
      'function:oklch': 'native',
    },
    '.x{color:oklch(from red l c h)}': {
      'function:oklch': 'native',
      'function:oklch/relative': {
        chrome: 'unknown/partial-implementation',
        chrome_android: 'unknown/partial-implementation',
        edge: 'unknown/partial-implementation',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
    },
    '.x{color:color-mix(in oklch, red, blue)}': {
      'function:color-mix': 'native',
    },
  },
  masks: {
    '.x{mask-image:linear-gradient(red,blue)}': {
      'property:mask-image': 'native',
      'function:linear-gradient': 'native',
    },
    '.x{-webkit-mask-image:linear-gradient(red,blue)}': {
      'property:-webkit-mask-image': {
        chrome: 'unknown/unreviewed-caveat',
        chrome_android: 'unknown/unreviewed-caveat',
        edge: 'native',
        firefox: 'incompatible/no-support',
        firefox_android: 'incompatible/no-support',
        safari: 'unknown/unreviewed-caveat',
        safari_ios: 'unknown/unreviewed-caveat',
      },
    },
    '.x{mask:url(a.svg)}': {
      'property:mask': 'unknown/unrecognized-construct',
    },
  },
  anchors: {
    '.x{top:anchor(bottom)}': {
      'property:top': 'native',
      'value:top/anchor()': 'incompatible/support-after-floor',
    },
    '@position-try --p{top:anchor(bottom)}': {
      'at-rule:position-try': 'incompatible/support-after-floor',
      'value:top/anchor()': 'incompatible/support-after-floor',
    },
    '.x{anchor-name:--a}': {
      'property:anchor-name': 'unknown/unrecognized-construct',
    },
  },
  scopes: {
    '@scope (.card){.x{color:red}}': {
      'at-rule:scope': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'incompatible/removed-before-latest',
        safari_ios: 'incompatible/removed-before-latest',
      },
    },
  },
  'view transitions': {
    '.x{view-transition-name:hero}': {
      'property:view-transition-name': 'unknown/unrecognized-construct',
    },
    '::view-transition-old(hero){opacity:1}': {
      'selector:::view-transition-old': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
    },
    '::view-transition-group(*){opacity:1}': {
      'selector:::view-transition-group': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
    },
    '@view-transition{navigation:auto}': {
      'at-rule:view-transition': {
        chrome: 'incompatible/support-after-floor',
        chrome_android: 'incompatible/support-after-floor',
        edge: 'incompatible/support-after-floor',
        firefox: 'incompatible/no-support',
        firefox_android: 'incompatible/no-support',
        safari: 'native',
        safari_ios: 'native',
      },
    },
  },
  '@starting-style': {
    '@starting-style{.x{opacity:0}}': {
      'at-rule:starting-style': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'incompatible/support-after-floor',
        firefox_android: 'incompatible/support-after-floor',
        safari: 'native',
        safari_ios: 'native',
      },
    },
  },
  'text-decoration keywords (W-UTIL-343)': {
    '.x{text-decoration:underline dotted}': {
      'property:text-decoration': 'native',
      'value:text-decoration/underline': 'native',
      'value:text-decoration/dotted': {
        chrome: 'native',
        chrome_android: 'native',
        edge: 'native',
        firefox: 'native',
        firefox_android: 'native',
        safari: 'incompatible/support-after-floor',
        safari_ios: 'incompatible/support-after-floor',
      },
    },
  },
};

describe.each(Object.entries(CASES))('%s', (_family, cases) => {
  test.each(Object.entries(cases))('%s', (css, expected) => {
    expect(outcomesOf(css, Object.keys(expected))).toEqual(expected);
  });
});

describe('each key is evaluated on its own data path', () => {
  test('a keyword, function, unit, query kind or descriptor never reads its parent path', () => {
    const children = Object.values(CASES)
      .flatMap((cases) => Object.keys(cases))
      .flatMap((css) => targets.featuresOfCss(css).map(({ record }) => record))
      .filter((record) => record.recognized && record.parent != null);
    expect(children.length).toBeGreaterThan(10);
    for (const record of children) {
      const parent = targets.featureByKey(record.parent);
      const parentPaths = new Set((parent?.bcd ?? []).map((b) => b.path));
      for (const { path } of record.bcd) {
        expect({
          key: record.feature,
          path,
          borrowed: parentPaths.has(path),
        }).toEqual({ key: record.feature, path, borrowed: false });
      }
    }
  });

  test('a keyword without its own subfeature adds no key; the property grammar covers it', () => {
    const keys = targets
      .featuresOfCss('.x{text-wrap:nowrap-not-a-keyword}')
      .map(({ record }) => record.feature);
    expect(keys).toEqual(['property:text-wrap']);
  });

  test('profile summaries are the worst engine state; per-engine rows stay visible', () => {
    const record = targets
      .featuresOfCss('.x{text-wrap:pretty}')
      .map(({ record }) => record)
      .find((r) => r.feature === 'value:text-wrap/pretty');
    const [profile] = targets.profileOutcomes(record, DEFAULT);
    expect(profile.state).toBe('incompatible');
    expect(profile.engines).toHaveLength(7);
    expect(profile.engines.filter((o) => o.state === 'native')).toHaveLength(3);
  });
});
