/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.2 (#45) AC2: computed cascade and inheritance in an exact engine.
 *
 * Fixtures run in headless Chrome (`PMS_CHROMIUM`, the CI runner's Google
 * Chrome) and read `getComputedStyle`:
 *
 *   - TX-1 user-select pair: base-only CSS, the stage's pair and variant-only
 *     CSS give identical computed values on parents, children and
 *     conflicting classes, in ladder and layer modes;
 *   - TX-1b user-select descendant override: parent `none`, child `text`; the
 *     child stays selectable with every CSS form;
 *   - TX-2 layers vs ladder: why no layer lowering is equivalent (external
 *     unlayered CSS and `!important` reversal);
 *   - TX-3 inheritance of tokens: a registered `<length>` token computes at
 *     its declaration, an unregistered one at its use;
 *   - TX-4 light-dark hazard: native `light-dark()` against the recorded
 *     Lightning CSS 1.33.0 lowering.
 *
 * Each run produces `pandamstyle-target-evidence` v1 records (class E4,
 * device headless) for Chrome and one `unavailable` row per engine that is
 * not executed here; Safari is never inferred from Chromium. A missing Chrome
 * fails the suite: an unrun check is not a pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const { targets } = loadCompiler();
const BROWSER = process.env.PMS_CHROMIUM ?? 'chromium';

const UNAVAILABLE = [
  {
    engine: 'firefox',
    reason:
      'no Firefox driver is owned by the repository (none added by CE-01.2)',
  },
  {
    engine: 'firefox_android',
    reason:
      'no Firefox driver is owned by the repository (none added by CE-01.2)',
  },
  {
    engine: 'safari',
    reason: 'no Safari on the runner; executed evidence deferred to #81',
  },
  {
    engine: 'safari_ios',
    reason:
      'no iOS device or simulator on the runner; executed evidence deferred to #81',
  },
  { engine: 'webview_android', reason: 'no Android device; deferred to #81' },
  {
    engine: 'electron',
    reason: 'no Electron runtime in this suite; deferred to #81',
  },
];

function browserVersion() {
  const result = spawnSync(BROWSER, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `CE-01.2 browser fixtures need Chrome (PMS_CHROMIUM=${BROWSER}): ${result.error?.message ?? result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** Loads `html` in headless Chrome; the page reports JSON through its title. */
function observe(html) {
  const scratch = fs.mkdtempSync(path.join(os.homedir(), 'pms-ce012-browser-'));
  try {
    const file = path.join(scratch, 'fixture.html');
    fs.writeFileSync(file, html);
    const child = spawnSync(
      BROWSER,
      [
        '--headless',
        '--disable-gpu',
        '--window-size=800,600',
        '--virtual-time-budget=1000',
        `--user-data-dir=${path.join(scratch, 'profile')}`,
        '--dump-dom',
        `file://${file}`,
      ],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    );
    if (child.status !== 0) {
      throw new Error(`browser run failed: ${child.stderr.slice(-1200)}`);
    }
    const encoded = child.stdout.match(
      /<title>PMS_RESULT_([A-Za-z0-9+/=]+)<\/title>/,
    )?.[1];
    if (encoded == null) {
      throw new Error(
        `browser produced no result: ${child.stderr.slice(-1200)}`,
      );
    }
    return JSON.parse(Buffer.from(encoded, 'base64').toString());
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A page with `css` and `body`; `probe` is a script expression -> JSON. */
function page(css, body, probe) {
  return `<!doctype html><html><head><style>${css}</style></head><body>${body}<script>
const read = (id, p) => getComputedStyle(document.getElementById(id)).getPropertyValue(p);
document.title = 'PMS_RESULT_' + btoa(JSON.stringify(${probe}));
</script></body></html>`;
}

/** A probe expression reading `{ key: [elementId, property] }`. */
function probeOf(spec) {
  return `Object.fromEntries(Object.entries(${JSON.stringify(spec)}).map(([k, [id, p]]) => [k, read(id, p)]))`;
}

const VERSION = browserVersion();
const records = [];
function evidence(fixtureId, feature, pass) {
  const record = {
    kind: targets.EVIDENCE_KIND,
    schemaVersion: targets.EVIDENCE_SCHEMA_VERSION,
    class: 'E4',
    fixtureId,
    feature,
    result: pass ? 'pass' : 'fail',
    engine: {
      id: 'chrome',
      version: VERSION.replace(/^[^0-9]*/, '').split(' ')[0],
      build: VERSION,
      device: 'headless',
      driver: 'chrome --headless --dump-dom',
    },
  };
  expect(targets.evidenceProblems(record)).toEqual([]);
  records.push(record);
}

afterAll(() => {
  const out = process.env.PMS_TARGET_EVIDENCE_OUT;
  if (out != null) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          kind: 'pandamstyle-ce-01.2-browser-run',
          executed: records,
          unavailable: UNAVAILABLE,
        },
        null,
        2,
      ) + '\n',
    );
  }
});

// ------------------------------------------------------------------ TX-1 ----

/**
 * The rules as the compiler orders them: group 0 then group 1, in ladder mode
 * (`:not(#\#)` per group index) or layer mode. `form` is how a user-select
 * declaration is written: the base only, the stage's pair, or the variant only.
 */
function userSelectCss(mode, form) {
  const declare = (value) => {
    const pair = targets
      .applyTransforms(`.q{user-select:${value}}`)
      .slice(3, -1);
    if (form === 'pair') return pair;
    if (form === 'variant') return pair.split(';')[0];
    return `user-select:${value}`;
  };
  const groups = [
    [
      ['n', declare('none')],
      ['t', declare('text')],
    ],
    // A later group: its rules win over group 0 for the same element.
    [['n2', declare('none')]],
  ];
  if (mode === 'layers') {
    return `@layer priority1, priority2;\n${groups
      .map(
        (rules, i) =>
          `@layer priority${i + 1}{${rules.map(([c, d]) => `.${c}{${d}}`).join('')}}`,
      )
      .join('\n')}`;
  }
  return groups
    .map((rules, i) =>
      rules.map(([c, d]) => `.${c}${':not(#\\#)'.repeat(i)}{${d}}`).join('\n'),
    )
    .join('\n');
}

const USER_SELECT_BODY = `
<div id="p" class="n"><span id="c">NONE</span><span id="d" class="t">TEXT</span></div>
<div id="e" class="t n2">OVERRIDDEN</div>
<div id="f" class="n t">ORDERED</div>`;
const USER_SELECT_PROBE = `(() => {
  const out = {};
  for (const id of ['p', 'c', 'd', 'e', 'f'])
    out[id] = [read(id, 'user-select'), read(id, '-webkit-user-select')];
  const selection = getSelection();
  selection.selectAllChildren(document.getElementById('p'));
  out.selected = selection.toString();
  return out;
})()`;

describe.each(['ladder', 'layers'])(
  'TX-1 user-select pair (%s mode)',
  (mode) => {
    const results = Object.fromEntries(
      ['base', 'pair', 'variant'].map((form) => [
        form,
        observe(
          page(userSelectCss(mode, form), USER_SELECT_BODY, USER_SELECT_PROBE),
        ),
      ]),
    );

    test('the pair and the variant alone compute exactly like the base', () => {
      expect(results.pair).toEqual(results.base);
      expect(results.variant).toEqual(results.base);
      // The stage's output is what was observed.
      expect(userSelectCss(mode, 'pair')).toContain(
        '-webkit-user-select:none;user-select:none',
      );
      // The cascade is the compiler's: a later group wins, later rules win.
      expect(results.base.e[0]).toBe('none');
      expect(results.base.f[0]).toBe('text');
      evidence(
        `TX-1 user-select pair (${mode})`,
        'property:user-select/prefix-alias',
        true,
      );
    });

    test('TX-1b user-select descendant override: parent none, child text stays selectable', () => {
      for (const form of ['base', 'pair', 'variant']) {
        expect({ form, p: results[form].p[0], d: results[form].d[0] }).toEqual({
          form,
          p: 'none',
          d: 'text',
        });
        // The selection over the parent keeps the selectable child only.
        expect({ form, selected: results[form].selected }).toEqual({
          form,
          selected: 'TEXT',
        });
      }
      evidence(
        `TX-1b user-select descendant override (${mode})`,
        'property:user-select/prefix-alias',
        true,
      );
    });
  },
);

// ------------------------------------------------------------------ TX-2 ----

describe('TX-2 layers vs ladder', () => {
  const rules = [
    ['g1', 'color:rgb(1, 0, 0)'],
    ['i1', 'background-color:rgb(4, 0, 0)!important'],
  ];
  const later = [
    ['g2', 'color:rgb(0, 2, 0)'],
    ['i2', 'background-color:rgb(0, 5, 0)!important'],
  ];
  const external = '.ext{color:rgb(0, 0, 3)}';
  const ladder = `${external}\n${rules.map(([c, d]) => `.${c}{${d}}`).join('\n')}\n${later
    .map(([c, d]) => `.${c}:not(#\\#){${d}}`)
    .join('\n')}`;
  const layers = `${external}\n@layer priority1, priority2;\n@layer priority1{${rules
    .map(([c, d]) => `.${c}{${d}}`)
    .join(
      '',
    )}}\n@layer priority2{${later.map(([c, d]) => `.${c}{${d}}`).join('')}}`;
  const body =
    '<div id="a" class="g1 g2">A</div><div id="x" class="ext g1 g2">X</div><div id="i" class="i1 i2">I</div>';
  const probe = probeOf({
    a: ['a', 'color'],
    x: ['x', 'color'],
    i: ['i', 'background-color'],
  });

  test('internal order agrees; unlayered CSS and !important do not', () => {
    const fromLadder = observe(page(ladder, body, probe));
    const fromLayers = observe(page(layers, body, probe));
    // Compiler-internal order: the later group wins in both modes.
    expect(fromLadder.a).toBe('rgb(0, 2, 0)');
    expect(fromLayers.a).toBe('rgb(0, 2, 0)');
    // Unlayered CSS outside the compiler beats every layer, not the ladder.
    expect(fromLayers.x).toBe('rgb(0, 0, 3)');
    expect(fromLadder.x).toBe('rgb(0, 2, 0)');
    // !important reverses layer order, not ladder order.
    expect(fromLayers.i).toBe('rgb(4, 0, 0)');
    expect(fromLadder.i).toBe('rgb(0, 5, 0)');
    evidence('TX-2 layers vs ladder', 'at-rule:layer/block', true);
  });
});

// ------------------------------------------------------------------ TX-3 ----

describe('TX-3 inheritance of tokens', () => {
  const body = '<div id="p" class="theme"><div id="c">C</div></div>';
  const tokens = `:root{font-size:10px;--len:1em;--fg:rgb(1, 1, 1)}
.theme{--fg:rgb(9, 9, 9)}
#c{font-size:20px;width:var(--len);color:var(--fg)}`;
  const registered = `@property --len{syntax:"<length>";inherits:true;initial-value:0px}\n${tokens}`;
  const probe = probeOf({ width: ['c', 'width'], color: ['c', 'color'] });

  test('a theme override is inherited; registration changes where a length computes', () => {
    const withRegistration = observe(page(registered, body, probe));
    const without = observe(page(tokens, body, probe));
    expect(withRegistration.color).toBe('rgb(9, 9, 9)');
    expect(without.color).toBe('rgb(9, 9, 9)');
    // Registered: computed at :root (10px) and inherited as a length.
    expect(withRegistration.width).toBe('10px');
    // Unregistered: inherited as `1em`, resolved at the child (20px).
    expect(without.width).toBe('20px');
    evidence('TX-3 inheritance of tokens', 'at-rule:property', true);
  });
});

// ------------------------------------------------------------------ TX-4 ----

describe('TX-4 light-dark hazard', () => {
  const body =
    '<div id="l" class="fg">L</div><div class="dark"><div id="d" class="fg">D</div></div>';
  const probe = probeOf({ l: ['l', 'color'], d: ['d', 'color'] });
  const native =
    ':root{color-scheme:light dark}.dark{color-scheme:dark}.fg{color:light-dark(rgb(1, 1, 1), rgb(2, 2, 2))}';
  // The Lightning CSS 1.33.0 output at the O13 floor (design note §3.2),
  // with the `.dark` rule left in another, untransformed unit.
  const lowered =
    ':root{--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--lightningcss-light: ;--lightningcss-dark:initial}}.dark{color-scheme:dark}.fg{color:var(--lightningcss-light,rgb(1, 1, 1))var(--lightningcss-dark,rgb(2, 2, 2))}';
  const loweredAlone =
    '.fg{color:var(--lightningcss-light,rgb(1, 1, 1))var(--lightningcss-dark,rgb(2, 2, 2))}';

  test('the lowering differs from native light-dark()', () => {
    const fromNative = observe(page(native, body, probe));
    const fromLowered = observe(page(lowered, body, probe));
    const fromAlone = observe(page(loweredAlone, body, probe));
    expect(fromNative).toEqual({ l: 'rgb(1, 1, 1)', d: 'rgb(2, 2, 2)' });
    // The nested color-scheme is lost when its rule is not in the unit.
    expect(fromLowered.l).toBe('rgb(1, 1, 1)');
    expect(fromLowered.d).toBe('rgb(1, 1, 1)');
    // Without a transformed color-scheme the value is invalid at computed
    // time and color falls back to its inherited value.
    expect(fromAlone.l).not.toBe('rgb(1, 1, 1)');
    expect(fromAlone.l).not.toBe('rgb(2, 2, 2)');
    evidence('TX-4 light-dark hazard', 'function:light-dark', true);
  });
});

test('engines not executed here are recorded as unavailable', () => {
  expect(UNAVAILABLE.map((row) => row.engine)).toEqual([
    'firefox',
    'firefox_android',
    'safari',
    'safari_ios',
    'webview_android',
    'electron',
  ]);
  for (const row of UNAVAILABLE) expect(row.reason).toMatch(/\S/);
});
