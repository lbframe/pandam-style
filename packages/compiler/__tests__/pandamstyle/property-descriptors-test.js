/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-02.1 (#46), descriptor authority:
 *
 *   - the effective property table is the only property authority, immutable
 *     and closed to prototype keys (invariants 1, 5, 6 of the design note);
 *   - `effectiveDomain` disables every member an override does not restate;
 *   - descriptors agree with the CE-00.1 registry, the target catalog and the
 *     engine's own expansion and direction tables;
 *   - Alpha 1 equivalence: for every Alpha 1 name, every recognized name Alpha 1
 *     did not support and every prototype key, the same accept/reject outcome
 *     and code as the pinned Alpha 1 policy, with only the intended deltas;
 *   - platform-extension names stay rejected, also under a target profile
 *     that announces their platform.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadCompiler, openProject } = require('./session-helpers');

const REPO = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO, 'packages/compiler/src');
const POLICY_DIR = path.join(SRC, 'design-system/policy');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const compiler = loadCompiler();
const { targets } = compiler;
const REGISTRY = readJson(
  path.join(REPO, 'docs/research/core-evolution-registry.v1.json'),
);
const RECOGNIZED = readJson(path.join(POLICY_DIR, 'recognized.v1.json'));
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);
const PROTOTYPE_NAMES = [...PROTOTYPE_KEYS, 'prototype'];

const properties = compiler.effectivePropertiesOf(null);
const rows = Object.values(properties.descriptors);
const rowOf = (key) => compiler.propertyRow(properties, key);

// ---------------------------------------------------------------------------
// The pinned Alpha 1 policy, loaded from exactly the bytes CE-00.2 calibrated
// (tools/coverage/classify.mjs pins its SHA-256).

const ALPHA1_POLICY_FILE = path.join(POLICY_DIR, 'properties.js');
const ALPHA1_POLICY_SHA256 = /sha256: '([0-9a-f]{64})'/.exec(
  fs.readFileSync(path.join(REPO, 'tools/coverage/classify.mjs'), 'utf8'),
)[1];

function loadAlpha1Policy() {
  const bytes = fs.readFileSync(ALPHA1_POLICY_FILE);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== ALPHA1_POLICY_SHA256) {
    throw new Error(`the Alpha 1 policy changed: ${digest}`);
  }
  // The module has no imports: its declarations evaluate as a function body.
  const body = bytes.toString('utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  return new Function(
    `${body}\nreturn { propertyKind, propertyCategory, structuralAllowed, structuralDomain, supportedProperties };`,
  )();
}

const alpha1 = loadAlpha1Policy();

// CE-02.2 intended deltas from Alpha 1, stated independently of the
// implementation:
//  - the four former continuous ranges are finite: opacity in steps of 0.05,
//    flex/flexGrow/flexShrink the integers 0 to 12;
//  - a token whose value is not a value of the property is refused at use.
//    In this suite every token's value is '1px'/'2px', which is not a
//    font-weight (a number) nor a time.
const CE022_FINITE = {
  opacity: Array.from({ length: 21 }, (_, i) => (i * 5) / 100),
  flex: Array.from({ length: 13 }, (_, i) => i),
  flexGrow: Array.from({ length: 13 }, (_, i) => i),
  flexShrink: Array.from({ length: 13 }, (_, i) => i),
};
const CE022_LENGTH_TOKEN_REFUSED = new Set([
  'fontWeight',
  'transitionDuration',
  'transitionDelay',
  'animationDuration',
  'animationDelay',
]);
function ce022Outcome(registry, property, value) {
  const outcome = alpha1Outcome(registry, property, value);
  if (outcome != null) return outcome;
  if (Object.hasOwn(CE022_FINITE, property)) {
    return CE022_FINITE[property].includes(value)
      ? null
      : ['PMS_FORBIDDEN_VALUE', 'structural-domain'];
  }
  if (
    CE022_LENGTH_TOKEN_REFUSED.has(property) &&
    compiler.tokenPathOf(value, 'author') != null
  ) {
    return ['PMS_FORBIDDEN_VALUE', 'category-strict'];
  }
  return null;
}

// Alpha 1's checkValue dispatch (engine/lowering/styles.js at 01a556b) over the
// pinned policy, for a consumer: [code, rule] or null when accepted.
function alpha1Outcome(registry, property, value) {
  const kind = alpha1.propertyKind(property);
  if (kind === 'composite-form') {
    return [
      'PMS_UNSUPPORTED_PROPERTY_FORM',
      'supported-properties.composite-forms',
    ];
  }
  if (kind === 'unsupported') {
    return ['PMS_UNSUPPORTED_PROPERTY', 'supported-properties'];
  }
  if (kind === 'structural-set' || kind === 'structural-number') {
    return alpha1.structuralAllowed(property, value)
      ? null
      : ['PMS_FORBIDDEN_VALUE', 'structural-domain'];
  }
  const category = alpha1.propertyCategory(property);
  const tokenId = compiler.tokenPathOf(value, 'author');
  if (tokenId == null) return ['PMS_FORBIDDEN_VALUE', 'category-strict'];
  const entry = registry.tokens[tokenId];
  if (entry == null) return ['PMS_UNKNOWN_TOKEN', 'registry.tokens'];
  if (entry.category !== category) {
    return ['PMS_INVALID_TOKEN_CATEGORY', 'category-strict'];
  }
  if (entry.visibility !== 'public') {
    return ['PMS_TOKEN_NOT_PUBLIC', 'visibility.consumer'];
  }
  return null;
}

// ---------------------------------------------------------------------------
// A design system with one public and one private token in every category.

const CATEGORIES = [
  'colors',
  'spacing',
  'radii',
  'fontFamilies',
  'fontSizes',
  'fontWeights',
  'lineHeights',
  'letterSpacings',
  'shadows',
  'durations',
  'easings',
  'sizes',
];
const ds = compiler.buildDesignSystem({
  systemId: 'ce021-descriptors',
  conditions: { hover: ':hover' },
  tokens: Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      {
        a: { value: '1px', visibility: 'public' },
        p: { value: '2px', visibility: 'private' },
      },
    ]),
  ),
});

function newOutcome(property, value) {
  try {
    compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: { n: { [property]: value } },
      role: 'consumer',
    });
    return null;
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    expect(error.diagnostics).toHaveLength(1);
    return [error.diagnostics[0].code, error.diagnostics[0].rule];
  }
}

function newOutcomeIn(block, property, value) {
  try {
    compiler.compileStyles({
      registry: ds.registry,
      varsByToken: ds.varsByToken,
      namespaces: { n: { [block]: { [property]: value } } },
      role: 'consumer',
    });
    return null;
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    expect(error.diagnostics).toHaveLength(1);
    return [error.diagnostics[0].code, error.diagnostics[0].rule];
  }
}

function probesOf(property) {
  const values = [
    'x',
    '',
    'auto',
    'inherit',
    'calc(1px)',
    '0',
    0,
    1,
    0.5,
    -1,
    2,
    1e308,
    Infinity,
    NaN,
    '0.5',
    null,
    {},
    ...CATEGORIES.flatMap((category) => [
      compiler.token(`${category}.a`),
      compiler.token(`${category}.p`),
      compiler.token(`${category}.missing`),
    ]),
  ];
  const kind = alpha1.propertyKind(property);
  if (kind === 'structural-set')
    values.push(...alpha1.structuralDomain(property));
  return values;
}

const describeValue = (value) =>
  compiler.tokenPathOf(value, 'author') ??
  JSON.stringify(value) ??
  String(value);

// ---------------------------------------------------------------------------

describe('the effective property table', () => {
  test('is the snapshot member, frozen, with a null prototype', () => {
    expect(ds.snapshot.properties).toBe(properties);
    expect(properties).toMatchObject({
      kind: 'pandamstyle-property-catalog',
      schemaVersion: 2,
      catalogVersion: 2,
    });
    expect(properties.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(properties.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.getPrototypeOf(properties.descriptors)).toBe(null);
    const walk = (value) => {
      if (value === null || typeof value !== 'object') return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const key of Object.keys(value)) walk(value[key]);
    };
    walk(properties);
  });

  test('rows carry exactly the enforced fields: no `standard` or `default`', () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [...compiler.ENFORCED_FIELDS].sort(),
      );
    }
    expect(compiler.ENFORCED_FIELDS).not.toContain('standard');
    expect(compiler.ENFORCED_FIELDS).not.toContain('default');
    expect(compiler.ENFORCED_FIELDS).not.toContain('meta');
  });

  test('mutation is refused at every level', () => {
    'use strict';
    const row = rowOf('width');
    expect(() => {
      properties.descriptors.width = null;
    }).toThrow(TypeError);
    expect(() => {
      properties.descriptors.injected = row;
    }).toThrow(TypeError);
    expect(() => {
      row.domain.values.push('auto');
    }).toThrow(TypeError);
    expect(() => {
      row.domain.tokens = ['spacing'];
    }).toThrow(TypeError);
    expect(() => {
      compiler.descriptorKeys().push('injected');
    }).toThrow(TypeError);
    expect(newOutcome('width', 'auto')).toEqual([
      'PMS_FORBIDDEN_VALUE',
      'structural-domain',
    ]);
  });

  test.each(PROTOTYPE_KEYS)('prototype key %s resolves to no row', (key) => {
    expect(rowOf(key)).toBe(null);
    expect(compiler.recognizedProperty(key)).toBe(null);
  });

  test('every admitted row has a domain; other rows have none', () => {
    const counts = { admitted: 0, composite: 0, platform: 0 };
    for (const row of rows) {
      if (row.status === 'platform') {
        counts.platform += 1;
        expect(row.domain).toBe(null);
      } else if (row.form === 'rejected-composite') {
        counts.composite += 1;
        expect(row.domain).toBe(null);
      } else {
        counts.admitted += 1;
        expect(row.domain.resources).toEqual([]);
        expect(
          row.domain.values.length + row.domain.tokens.length,
        ).toBeGreaterThan(0);
      }
      expect(row.origin).toBe('default');
      expect(row.contexts).toEqual(['element']);
    }
    // Alpha 1: 102 admitted names, 5 refused composite forms; CE-01.1: 3
    // platform extensions.
    expect(counts).toEqual({ admitted: 102, composite: 5, platform: 3 });
  });

  // CE-02.2: every domain is finite; no row carries a range.
  test('every domain is exactly { values, tokens, resources }', () => {
    for (const row of rows) {
      if (row.domain == null) continue;
      expect(Object.keys(row.domain).sort()).toEqual([
        'resources',
        'tokens',
        'values',
      ]);
    }
  });

  // The four former ranges are finite numbers everywhere they are published.
  const OPACITY_GRID = Array.from({ length: 21 }, (_, i) => (i * 5) / 100);
  const FLEX_INTEGERS = Array.from({ length: 13 }, (_, i) => i);
  test.each([
    ['opacity', OPACITY_GRID],
    ['flex', FLEX_INTEGERS],
    ['flexGrow', FLEX_INTEGERS],
    ['flexShrink', FLEX_INTEGERS],
  ])('%s default is finite in every serialization', (key, values) => {
    expect(rowOf(key).domain).toEqual({ values, tokens: [], resources: [] });
    const manifest = ds.snapshot.tooling.manifest;
    expect(manifest.properties.byProperty[key]).toEqual({ values });
    expect(
      JSON.parse(JSON.stringify(manifest)).properties.byProperty[key],
    ).toEqual({ values });
    const module = compiler.generateDesignSystemModule({ designSystem: ds });
    const embedded = JSON.parse(
      /export const manifest = ([\s\S]*?);\n\nexport const props/.exec(
        module,
      )[1],
    );
    expect(embedded.properties.byProperty[key]).toEqual({ values });
    expect(
      compiler.repairDomainOf(ds.snapshot, { kind: 'property', property: key }),
    ).toEqual({ values, tokens: [], resources: [] });
    const declarations = compiler.generateDesignSystemDeclarations(ds.snapshot);
    expect(declarations).toContain(
      `readonly ${JSON.stringify(key)}: ${values.map((v) => JSON.stringify(v)).join(' | ')};`,
    );
    expect(declarations).not.toMatch(/ranges|legacy: true/);
    for (const text of [JSON.stringify(manifest), module]) {
      expect(text).not.toMatch(/"range"|Infinity/);
    }
  });

  test('the manifest is the projection of the table, as manifest version 2', () => {
    const manifest = ds.snapshot.tooling.manifest;
    expect(manifest.manifestSchemaVersion).toBe(2);
    expect(manifest).not.toHaveProperty('supportedProperties');
    expect(manifest.properties.digest).toBe(properties.digest);
    for (const row of rows) {
      const entry = manifest.properties.byProperty[row.key];
      if (row.status === 'platform') {
        expect(entry).toBeUndefined();
        continue;
      }
      expect(entry.values ?? []).toEqual(row.domain?.values ?? []);
      expect(entry.tokens ?? []).toEqual(row.domain?.tokens ?? []);
      expect(entry).not.toHaveProperty('range');
      expect(entry.form ?? 'admitted').toBe(
        row.form === 'rejected-composite' ? row.form : 'admitted',
      );
    }
    // The generated module embeds the same object.
    const module = compiler.generateDesignSystemModule({ designSystem: ds });
    const embedded =
      /export const manifest = ([\s\S]*?);\n\nexport const props/.exec(
        module,
      )[1];
    expect(JSON.parse(embedded).properties).toEqual(
      JSON.parse(JSON.stringify(manifest.properties)),
    );
  });

  test('candidate and repair domains read the same domain objects', () => {
    const repair = compiler.repairDomainOf(ds.snapshot, { kind: 'property' });
    for (const row of rows) {
      if (row.domain == null) {
        expect(Object.hasOwn(repair, row.key)).toBe(false);
      } else {
        expect(repair[row.key]).toBe(row.domain);
        expect(
          compiler.repairDomainOf(ds.snapshot, {
            kind: 'property',
            property: row.key,
          }),
        ).toBe(row.domain);
      }
    }
    for (const key of PROTOTYPE_KEYS) {
      expect(
        compiler.repairDomainOf(ds.snapshot, {
          kind: 'property',
          property: key,
        }),
      ).toBe(null);
    }
    expect(ds.snapshot.tooling.candidateDomains.properties.keys).toEqual(
      rows.filter((row) => row.domain != null).map((row) => row.key),
    );
  });

  test('target candidates come from one function per table', () => {
    const domainOf = compiler.domainOfCssFor(properties);
    expect(compiler.domainOfCssFor(properties)).toBe(domainOf);
    expect(domainOf.digest).toBe(properties.digest);
    expect(domainOf('display')).toBe(rowOf('display').domain.values);
    expect(domainOf('color')).toBe(null);
    // CE-02.2: the former range rows have finite candidates.
    expect(domainOf('opacity')).toBe(rowOf('opacity').domain.values);
    expect(domainOf('constructor')).toBe(null);
  });
});

// The manifest v2 reader is unchanged by CE-02.2 (D2): it still accepts the
// CE-02.1 shape, a legacy `range` entry with finite bounds, and refuses a
// malformed one. CE-02.2 manifests simply never carry `range`.
describe('validateArtifactSet and legacy range bounds', () => {
  const LEGACY = {
    opacity: { min: 0, max: 1, legacy: true },
    flex: { min: 0, legacy: true },
    flexGrow: { min: 0, legacy: true },
    flexShrink: { min: 0, legacy: true },
  };
  const withLegacyRanges = (text) => {
    const manifest = JSON.parse(text);
    for (const [key, range] of Object.entries(LEGACY)) {
      manifest.properties.byProperty[key] = { range: { ...range } };
    }
    return manifest;
  };
  const setWith = (manifestText) =>
    compiler.createArtifactSet(ds.snapshot, {
      designModuleFile: 'design.js',
      declarationsFile: 'design.d.ts',
      designModule: compiler.generateDesignSystemModule({ designSystem: ds }),
      declarations: compiler.generateDesignSystemDeclarations(ds.snapshot),
      manifest: manifestText,
      css: compiler.withDesignSystemCssIdentity(
        ds.renderCss(),
        ds.snapshot.identity,
      ),
    });
  const manifestText = `${JSON.stringify(ds.snapshot.tooling.manifest, null, 2)}\n`;

  test('the generated manifest is valid', () => {
    const set = setWith(manifestText);
    expect(compiler.validateArtifactSet(set.metadata, set.contents)).toBe(true);
    expect(manifestText).not.toMatch(/"range"/);
  });

  test('a CE-02.1-shaped manifest with legacy ranges is still valid', () => {
    const text = `${JSON.stringify(withLegacyRanges(manifestText), null, 2)}\n`;
    const set = setWith(text);
    expect(compiler.validateArtifactSet(set.metadata, set.contents)).toBe(true);
  });

  test.each([
    ['flex max null', 'flex', (r) => ({ ...r, max: null })],
    ['opacity max null', 'opacity', (r) => ({ ...r, max: null })],
    ['flexGrow max as text', 'flexGrow', (r) => ({ ...r, max: 'Infinity' })],
    ['flexShrink min null', 'flexShrink', (r) => ({ ...r, min: null })],
    ['opacity min absent', 'opacity', ({ min: _min, ...r }) => r],
  ])('%s is refused', (_, key, tamper) => {
    const manifest = withLegacyRanges(manifestText);
    manifest.properties.byProperty[key].range = tamper(
      manifest.properties.byProperty[key].range,
    );
    // createArtifactSet validates the set it builds (validateArtifactSet):
    // a manifest with such a bound cannot become an artifact set.
    expect(() => setWith(`${JSON.stringify(manifest, null, 2)}\n`)).toThrow(
      /range bounds of .* are not finite numbers/,
    );
  });

  test('a bound that parses to Infinity is refused', () => {
    const legacyText = `${JSON.stringify(withLegacyRanges(manifestText), null, 2)}\n`;
    const tampered = legacyText.replace(
      /("flex": \{[^}]*"range": \{\s*"min": 0)/,
      '$1,\n        "max": 1e999',
    );
    expect(tampered).not.toBe(legacyText);
    expect(() => setWith(tampered)).toThrow(
      /range bounds of flex are not finite numbers/,
    );
  });
});

describe('effectiveDomain', () => {
  const descriptor = {
    default: {
      values: ['a'],
      tokens: ['spacing'],
      resources: [],
    },
  };
  test('without an override it is the default object', () => {
    expect(compiler.effectiveDomain(descriptor)).toBe(descriptor.default);
    expect(compiler.effectiveDomain({ default: null })).toBe(null);
  });
  // Every non-empty subset of the members an override can restate.
  const MEMBERS = {
    values: ['b'],
    tokens: ['sizes'],
  };
  const subsets = [];
  for (let mask = 1; mask < 4; mask++) {
    subsets.push(Object.keys(MEMBERS).filter((_, i) => mask & (1 << i)));
  }
  test.each(subsets.map((s) => [s.join('+'), s]))(
    'an override restating %s disables every other member',
    (_, members) => {
      const override = Object.fromEntries(members.map((m) => [m, MEMBERS[m]]));
      const effective = compiler.effectiveDomain(descriptor, override);
      expect(effective).toEqual({
        values: members.includes('values') ? ['b'] : [],
        tokens: members.includes('tokens') ? ['sizes'] : [],
        resources: [],
      });
      expect(Object.isFrozen(effective)).toBe(true);
      expect(Object.isFrozen(effective.values)).toBe(true);
    },
  );
});

describe('descriptors agree with their other sources', () => {
  const registryByName = new Map(REGISTRY.entries.map((e) => [e.name, e]));

  test('every row is a CE-00.1 registry entry with its family and authoring key', () => {
    for (const row of rows) {
      const entry = registryByName.get(row.css);
      expect({ key: row.key, found: entry != null }).toEqual({
        key: row.key,
        found: true,
      });
      expect({ key: row.key, family: row.family }).toEqual({
        key: row.key,
        family: entry.family,
      });
      expect(camel(row.css)).toBe(row.key);
      expect(RECOGNIZED.entries[row.key].css).toBe(row.css);
    }
  });

  test('the Alpha 1 rows are exactly the registry rows Alpha 1 did not leave unsupported', () => {
    const alpha1Names = REGISTRY.entries
      .filter((e) => e.alpha1.kind !== 'unsupported')
      .map((e) => e.name)
      .sort();
    expect(
      rows
        .filter((row) => row.status === 'standard')
        .map((row) => row.css)
        .sort(),
    ).toEqual(alpha1Names);
  });

  test('PLATFORM_FEATURES is derived and content-identical to CE-01.1', () => {
    expect({ ...targets.PLATFORM_FEATURES }).toEqual({
      '-webkit-app-region': 'electron',
      '-webkit-user-drag': 'electron',
      '-webkit-font-smoothing': 'electron',
    });
    expect(targets.PLATFORM_FEATURES).toBe(compiler.platformExtensions());
    for (const row of rows.filter((r) => r.status === 'platform')) {
      expect(targets.PLATFORM_FEATURES[row.css]).toBe(row.platform);
      expect(RECOGNIZED.entries[row.key].disposition).toBe(
        'scoped-platform-extension',
      );
    }
  });

  test('each targetFeature is the target catalog key of the emitted property', () => {
    for (const row of rows) {
      const [feature] = targets.featuresOf({ kind: 'property', name: row.css });
      expect({ key: row.key, feature: feature.feature }).toEqual({
        key: row.key,
        feature: row.targetFeature,
      });
      expect(feature.recognized).toBe(true);
    }
  });

  test('conflicts are the inverse of shorthand longhands', () => {
    const byCss = new Map(rows.map((row) => [row.css, row.key]));
    for (const row of rows) {
      const expected = rows
        .filter((r) => r.form === 'shorthand' && r.longhands.includes(row.css))
        .map((r) => r.key)
        .sort();
      expect({ key: row.key, conflicts: row.conflicts }).toEqual({
        key: row.key,
        conflicts: expected,
      });
      if (row.form !== 'shorthand') continue;
      for (const longhand of row.longhands) {
        if (byCss.has(longhand)) {
          expect(rowOf(byCss.get(longhand)).conflicts).toContain(row.key);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Engine parity. The engine keeps its own expansion and direction tables until
// CE-02.3 rewires it to the descriptors; these tests pin the two together.

describe('descriptors agree with the engine tables', () => {
  const kebab = (key) => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
  const LEGACY = {
    styleResolution: 'legacy-expand-shorthands',
    enableLogicalStylesPolyfill: true,
    propertyValidationMode: 'throw',
  };
  const SPECIFICITY = {
    styleResolution: 'property-specificity',
    propertyValidationMode: 'throw',
  };
  // Physical name in a left-to-right, horizontal-tb writing mode: the engine's
  // own logical-to-physical table, then the block axis it assumes.
  const physicalLtr = (css) => {
    const [ltr] = compiler.generateLTR([css, 'v'], LEGACY);
    return ltr
      .replace(/^inset-block-start$/, 'top')
      .replace(/^inset-block-end$/, 'bottom')
      .replace(/-block-start(?=-|$)/, '-top')
      .replace(/-block-end(?=-|$)/, '-bottom');
  };
  const expand = (key, options) =>
    compiler.flatMapExpandedShorthands([key, '1px 2px 3px 4px'], options);

  test('a shorthand sets the longhands the engine expands it to', () => {
    const unexpanded = [];
    for (const row of rows.filter((r) => r.form === 'shorthand')) {
      const engine = expand(row.key, LEGACY).map(([k]) => k);
      if (engine.length === 1 && engine[0] === row.key) {
        unexpanded.push(row.key);
        continue;
      }
      expect({
        key: row.key,
        longhands: [...new Set(row.longhands.map(physicalLtr))].sort(),
      }).toEqual({
        key: row.key,
        longhands: [...new Set(engine.map(kebab).map(physicalLtr))].sort(),
      });
    }
    // The engine has no `flex` expansion; CE-02.3 owns flex tuples.
    expect(unexpanded).toEqual(['flex']);
  });

  test('an inline-axis side or a logical corner maps to the engine physical name', () => {
    const LTR_SIDE = { start: 'left', end: 'right' };
    const LTR_CORNER = {
      'start-start': 'top-left',
      'start-end': 'top-right',
      'end-start': 'bottom-left',
      'end-end': 'bottom-right',
    };
    let checked = 0;
    for (const row of rows) {
      const d = row.direction;
      let expected = null;
      if (d?.axis === 'inline' && d.side != null) {
        expected =
          row.css === `inset-inline-${d.side}`
            ? LTR_SIDE[d.side]
            : row.css.replace(`inline-${d.side}`, LTR_SIDE[d.side]);
      } else if (d?.corner != null) {
        expected = row.css.replace(d.corner, LTR_CORNER[d.corner]);
      }
      if (expected == null) continue;
      checked += 1;
      expect({
        key: row.key,
        ltr: compiler.generateLTR([row.css, 'v'], LEGACY)[0],
      }).toEqual({
        key: row.key,
        ltr: expected,
      });
    }
    expect(checked).toBe(10);
  });

  test('a block-axis side is the physical property the default resolution writes', () => {
    const BLOCK = { start: 'top', end: 'bottom' };
    let checked = 0;
    for (const row of rows) {
      const d = row.direction;
      if (d?.axis !== 'block' || d.side == null) continue;
      checked += 1;
      const physical =
        row.css === `inset-block-${d.side}`
          ? BLOCK[d.side]
          : row.css.replace(`block-${d.side}`, BLOCK[d.side]);
      expect({
        key: row.key,
        out: expand(row.key, SPECIFICITY).map(([k]) => kebab(k)),
      }).toEqual({
        key: row.key,
        out: [physical],
      });
    }
    expect(checked).toBe(6);
  });

  test('other rows pass through the default resolution; composite forms never expand', () => {
    for (const row of rows) {
      const d = row.direction;
      if (d?.axis === 'block' && d.side != null) continue;
      let out;
      try {
        out = expand(row.key, SPECIFICITY).map(([k]) => k);
      } catch {
        out = 'throws';
      }
      if (row.form === 'rejected-composite') {
        expect([['throws'], [[row.key]]]).toContainEqual([out]);
      } else {
        expect({ key: row.key, out }).toEqual({ key: row.key, out: [row.key] });
      }
      if (d?.physical != null) {
        expect(compiler.generateLTR([row.css, 'v'], LEGACY)[0]).toBe(row.css);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Alpha 1 equivalence.

describe('Alpha 1 equivalence', () => {
  const ALPHA1_NAMES = Object.keys(alpha1.supportedProperties().categories)
    .concat(Object.keys(alpha1.supportedProperties().structuralSets))
    .concat(Object.keys(alpha1.supportedProperties().structuralNumbers))
    .concat(alpha1.supportedProperties().compositeFormsRejected);

  test('the probed Alpha 1 names are the 107 the policy describes', () => {
    expect(new Set(ALPHA1_NAMES).size).toBe(107);
  });

  test('the CE-02.2 deltas are exercised by the probes', () => {
    const deltas = [];
    for (const property of ALPHA1_NAMES) {
      for (const value of probesOf(property)) {
        const a = alpha1Outcome(ds.registry, property, value);
        const b = ce022Outcome(ds.registry, property, value);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          deltas.push(`${property}=${describeValue(value)}`);
        }
      }
    }
    // flex*: 0.5 and 1e308 (Alpha 1 accepted any number >= 0); opacity: none
    // of the probes in [0, 1] is off the grid; the public token of the
    // length-valued category on five number/time rows.
    expect(deltas.sort()).toEqual(
      [
        'flex=0.5',
        'flex=1e+308',
        'flexGrow=0.5',
        'flexGrow=1e+308',
        'flexShrink=0.5',
        'flexShrink=1e+308',
        'fontWeight=fontWeights.a',
        'transitionDuration=durations.a',
        'transitionDelay=durations.a',
        'animationDuration=durations.a',
        'animationDelay=durations.a',
      ].sort(),
    );
  });

  test.each(ALPHA1_NAMES.map((name) => [name]))(
    '%s: every probe has the Alpha 1 outcome, code and rule (CE-02.2 deltas aside)',
    (property) => {
      for (const value of probesOf(property)) {
        expect({
          value: describeValue(value),
          outcome: newOutcome(property, value),
        }).toEqual({
          value: describeValue(value),
          outcome: ce022Outcome(ds.registry, property, value),
        });
      }
    },
  );

  const UNSUPPORTED = REGISTRY.entries.filter(
    (e) => e.alpha1.kind === 'unsupported',
  );
  const RULES = {
    'canonical-property': 'supported-properties.not-admitted',
    'system-resource': 'supported-properties.not-admitted',
    'incompatible-runtime-requirement': 'supported-properties.not-admitted',
    'normalized-alias': 'supported-properties.alias',
    'deprecated-or-experimental': 'supported-properties.deprecated',
    'scoped-platform-extension': 'supported-properties.platform-extension',
    'non-css-syntax': 'supported-properties.unrecognized',
  };

  test('the 1,001 recognized names Alpha 1 did not support', () => {
    expect(UNSUPPORTED).toHaveLength(1001);
  });

  test.each(UNSUPPORTED.map((e) => [e.name, e]))(
    '%s stays rejected; only the rule gains its suffix',
    (name, entry) => {
      const key = camel(name);
      for (const value of ['x', 0, compiler.token('colors.a')]) {
        expect(alpha1Outcome(ds.registry, key, value)).toEqual([
          'PMS_UNSUPPORTED_PROPERTY',
          'supported-properties',
        ]);
        expect(newOutcome(key, value)).toEqual([
          'PMS_UNSUPPORTED_PROPERTY',
          RULES[entry.disposition],
        ]);
      }
      // Inside a named-condition block and an engine condition block, the
      // name is checked by the same policy and stays rejected.
      for (const block of ['_hover', ':hover']) {
        expect(newOutcomeIn(block, key, 'x')).toEqual([
          'PMS_UNSUPPORTED_PROPERTY',
          RULES[entry.disposition],
        ]);
      }
    },
  );

  // The intended delta: Alpha 1 resolved prototype keys as category
  // properties; they are now unrecognized names, whatever the value, refused
  // before any condition dispatch.
  test.each(PROTOTYPE_NAMES.map((key) => [key]))(
    'prototype name %s is an unrecognized property for every value kind',
    (key) => {
      for (const value of [
        'x',
        0,
        compiler.token('colors.a'),
        { color: compiler.token('colors.a') },
        {},
      ]) {
        expect({
          value: describeValue(value),
          outcome: newOutcome(key, value),
        }).toEqual({
          value: describeValue(value),
          outcome: [
            'PMS_UNSUPPORTED_PROPERTY',
            'supported-properties.unrecognized',
          ],
        });
      }
    },
  );

  test('unsupported-property diagnostics carry their disposition', () => {
    const contextOf = (property) => {
      try {
        compiler.compileStyles({
          registry: ds.registry,
          varsByToken: ds.varsByToken,
          namespaces: { n: { [property]: 'x' } },
          role: 'consumer',
        });
      } catch (error) {
        return error.diagnostics[0].context;
      }
      return null;
    };
    expect(contextOf('gridGap')).toEqual({
      property: 'gridGap',
      css: 'grid-gap',
      disposition: 'normalized-alias',
      replacement: 'gap',
    });
    expect(contextOf('WebkitAppRegion')).toEqual({
      property: 'WebkitAppRegion',
      css: '-webkit-app-region',
      disposition: 'scoped-platform-extension',
      platform: 'electron',
    });
    expect(contextOf('WebkitTouchCallout')).toEqual({
      property: 'WebkitTouchCallout',
      css: '-webkit-touch-callout',
      disposition: 'scoped-platform-extension',
      platform: null,
    });
    expect(contextOf('notAProperty')).toEqual({
      property: 'notAProperty',
      admitted: ds.snapshot.tooling.candidateDomains.properties.keys,
    });
  });
});

// ---------------------------------------------------------------------------

describe('platform extensions stay rejected under a matching profile', () => {
  const PLATFORM_NAMES = REGISTRY.entries
    .filter((e) => e.disposition === 'scoped-platform-extension')
    .map((e) => camel(e.name));

  test('the seven registry platform extensions', () => {
    expect(PLATFORM_NAMES).toHaveLength(7);
  });

  // A project profile that announces the `electron` platform with a query
  // every pinned data version resolves the same way. The built-in
  // `pandamstyle:electron@1` profile (query `electron 44.7`) resolves only
  // with the lockfile's electron-to-chromium: with another installed version
  // the precomputed list is (correctly) not used, the live query fails with
  // PMS_INVALID_TARGET_CONFIG and no page is compiled, which says nothing
  // about platform extensions.
  const ELECTRON_PROJECT = {
    profiles: ['project:desktop'],
    define: { desktop: { query: 'chrome 120', platform: 'electron' } },
  };

  test('the project profile announces the electron platform', () => {
    const { record } = targets.resolveTargets(ELECTRON_PROJECT);
    expect(record.profiles.map((p) => [p.ref, p.platform])).toEqual([
      ['project:desktop', 'electron'],
    ]);
  });

  test.each([
    ['without targets', undefined],
    ['under a profile announcing the electron platform', ELECTRON_PROJECT],
  ])('%s', (_, targetConfig) => {
    const h = openProject('valid');
    if (targetConfig !== undefined) h.setBuildOption('targets', targetConfig);
    const page = h.src('src/platform.js');
    fs.writeFileSync(
      page,
      [
        "import { create } from '../generated/design.pandamstyle';",
        ...PLATFORM_NAMES.map(
          (key, index) =>
            `export const s${index} = create({ a: { ${key}: 'none' } });`,
        ),
        '',
      ].join('\n'),
    );
    h.session.applyChanges({
      definition: h.reloadDefinition(),
      config:
        targetConfig === undefined ? undefined : { targets: targetConfig },
      mutation: undefined,
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    // The targets resolved: the refusals below come from the property policy,
    // not from a revision stopped at target resolution.
    expect(
      validation.diagnostics.filter(
        (d) => d.code === 'PMS_INVALID_TARGET_CONFIG',
      ),
    ).toEqual([]);
    const platform = validation.diagnostics.filter(
      (d) => d.location?.file === page,
    );
    expect(platform.map((d) => [d.code, d.rule, d.context.property])).toEqual(
      PLATFORM_NAMES.map((key) => [
        'PMS_UNSUPPORTED_PROPERTY',
        'supported-properties.platform-extension',
        key,
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Prototype names in real page source: preserved through evaluation and
// spreads, then refused. One create() call per line; outcomes read by line.

describe('prototype names in page source never vanish', () => {
  const T = "token('colors.text.primary')";
  const CASES = [
    [
      'literal __proto__',
      "create({ n: { __proto__: 'x' } })",
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'computed __proto__',
      "create({ n: { ['__proto__']: 'x' } })",
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'token value',
      `create({ n: { __proto__: ${T} } })`,
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'object value',
      `create({ n: { __proto__: { color: ${T} } } })`,
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'empty object value',
      "create({ n: { ['__proto__']: {} } })",
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'spread of a computed key',
      'create({ n: { ...COMPUTED } })',
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'spread of a literal key',
      'create({ n: { ...LITERAL } })',
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'nested condition block',
      `create({ n: { _hover: { __proto__: ${T} } } })`,
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'condition-map key',
      `create({ n: { color: { base: ${T}, __proto__: ${T} } } })`,
      'PMS_UNKNOWN_CONDITION',
      'conditions.named-only',
    ],
    [
      'constructor',
      "create({ n: { constructor: 'x' } })",
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'toString',
      `create({ n: { toString: ${T} } })`,
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'prototype',
      "create({ n: { prototype: 'x' } })",
      'PMS_UNSUPPORTED_PROPERTY',
      'supported-properties.unrecognized',
    ],
    [
      'namespace __proto__',
      `create({ __proto__: { color: ${T} } })`,
      'PMS_UNSUPPORTED_FEATURE',
      'static-resolution.prototype-name',
    ],
    [
      'computed namespace __proto__',
      `create({ ['__proto__']: { color: ${T} } })`,
      'PMS_UNSUPPORTED_FEATURE',
      'static-resolution.prototype-name',
    ],
    [
      'namespace spread',
      'create({ ...NAMESPACES })',
      'PMS_UNSUPPORTED_FEATURE',
      'static-resolution.prototype-name',
    ],
  ];
  const HEADER = [
    "import { create, token } from '../generated/design.pandamstyle';",
    "const COMPUTED = { ['__proto__']: 'x' };",
    "const LITERAL = { __proto__: 'x' };",
    `const NAMESPACES = { ['__proto__']: { color: ${T} } };`,
  ];
  let byLine;
  let unlocated;
  let page;
  beforeAll(() => {
    const h = openProject('valid');
    page = h.src('src/prototype-names.js');
    fs.writeFileSync(
      page,
      [
        ...HEADER,
        ...CASES.map(([, call], i) => `export const s${i} = ${call};`),
        '',
      ].join('\n'),
    );
    h.session.applyChanges({
      definition: h.reloadDefinition(),
      mutation: undefined,
    });
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    byLine = new Map();
    unlocated = validation.diagnostics.filter((d) => d.location?.line == null);
    for (const d of validation.diagnostics) {
      if (d.location?.file !== page) continue;
      if (!byLine.has(d.location.line)) byLine.set(d.location.line, []);
      byLine.get(d.location.line).push([d.code, d.rule]);
    }
  });

  // A spread reports at the declaration that defines the key; a condition-map
  // key's PMS_UNKNOWN_CONDITION carries no source line (existing behavior).
  const LINE = new Map(
    Object.entries({
      'spread of a computed key': 2,
      'spread of a literal key': 3,
    }),
  );
  test.each(CASES.map((c, i) => [c[0], i, c[2], c[3]]))(
    '%s is refused, not dropped',
    (name, index, code, rule) => {
      if (name === 'condition-map key') {
        expect(
          unlocated
            .filter((d) => d.context?.condition === '__proto__')
            .map((d) => [d.code, d.rule, d.context.property]),
        ).toEqual([[code, rule, 'color']]);
        return;
      }
      const line = LINE.get(name) ?? HEADER.length + index + 1;
      expect(byLine.get(line)).toContainEqual([code, rule]);
      // The call's own line holds nothing else: the key was not dropped
      // silently while another diagnostic was reported.
      if (!LINE.has(name)) expect(byLine.get(line)).toEqual([[code, rule]]);
    },
  );

  test('every case is rejected and none is accepted silently', () => {
    const lines = new Set(byLine.keys());
    for (let i = 0; i < CASES.length; i++) {
      const [name] = CASES[i];
      if (LINE.has(name) || name === 'condition-map key') continue;
      expect(lines.has(HEADER.length + i + 1)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Structural invariants over the source tree.

describe('one property authority in the source tree', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' || entry.name === '__tests__'
          ? []
          : walk(full);
      }
      return /\.(js|mjs|cjs)$/.test(entry.name) ? [full] : [];
    });
  const compilerFiles = walk(SRC);
  const inPolicy = (file) => file.startsWith(`${POLICY_DIR}${path.sep}`);

  test('no compiler module imports the frozen Alpha 1 policy', () => {
    const importers = compilerFiles.filter((file) =>
      /from\s+['"][^'"]*policy\/properties(\.js)?['"]/.test(
        fs.readFileSync(file, 'utf8'),
      ),
    );
    expect(importers).toEqual([]);
  });

  test('only policy/ reads the catalog; others import only named helpers', () => {
    const ALLOWED = new Set(['platformExtensions']);
    for (const file of compilerFiles.filter((f) => !inPolicy(f))) {
      const text = fs.readFileSync(file, 'utf8');
      const re =
        /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*policy\/descriptors(\.js)?['"]/g;
      let match;
      while ((match = re.exec(text)) != null) {
        const names = match[1]
          .split(',')
          .map((n) => n.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
        expect({
          file: path.relative(REPO, file),
          names: names.filter((n) => !ALLOWED.has(n)),
        }).toEqual({ file: path.relative(REPO, file), names: [] });
      }
      expect(
        /import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]*policy\/descriptors/.test(
          text,
        ),
      ).toBe(false);
    }
  });

  // A property-to-domain map: object entries keyed by admitted authoring keys
  // whose values are token categories or literal-value collections.
  const ADMITTED_KEYS = rows
    .filter((row) => row.domain != null)
    .map((row) => row.key);
  // Pattern parameter schemas map parameters named after properties to their
  // token category: design note follow-up F2 (CE-10) derives them.
  const KNOWN = new Set([
    'packages/compiler/src/design-system/patterns/compile.js',
  ]);
  const CATEGORY_NAMES = CATEGORIES.join('|');
  const domainEntries = (text) => {
    const found = new Set();
    for (const key of ADMITTED_KEYS) {
      const re = new RegExp(
        `(^|[\\s{,'"])${key}['"]?\\s*:\\s*(['"](${CATEGORY_NAMES})['"]|new Set\\(|\\[)`,
        'm',
      );
      if (re.test(text)) found.add(key);
    }
    return found.size;
  };

  test('the detector finds the Alpha 1 tables (positive control)', () => {
    expect(
      domainEntries(fs.readFileSync(ALPHA1_POLICY_FILE, 'utf8')),
    ).toBeGreaterThan(90);
  });

  test('no compiler or tooling module outside policy/ holds a property-domain map', () => {
    const toolFiles = walk(path.join(REPO, 'tools'));
    const offenders = [
      ...compilerFiles.filter((f) => !inPolicy(f)),
      ...toolFiles,
    ]
      .map((file) => [
        path.relative(REPO, file),
        domainEntries(fs.readFileSync(file, 'utf8')),
      ])
      .filter(([file, count]) => count >= 3 && !KNOWN.has(file));
    expect(offenders).toEqual([]);
  });
});
