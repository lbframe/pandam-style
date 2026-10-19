/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

/**
 * CE-01.1 (#44) AC3 and AC4 end to end, through the Project Service session
 * and the fresh full build:
 *
 *   - no `targets`: advisory. Findings are warnings, the revision is ok and
 *     publishes, and the build report records the default profile as failing;
 *   - explicit `targets`: enforced. The same finding is an error, the
 *     revision is not ok and nothing is published;
 *   - a design-system enhancement turns it into a warning;
 *   - target digests agree across snapshot, manifest, artifacts.json and the
 *     build report, and `validateArtifactSet` refuses a mismatch;
 *   - a `targets` change is a `compiler-configuration` fallback equal to the
 *     fresh oracle;
 *   - the design module, its declarations and the CSS bytes do not depend on
 *     targets.
 */

const fs = require('fs');
const path = require('path');
const { differential, openProject } = require('./session-helpers');

const ENFORCED = { profiles: ['pandamstyle:default@1'] };
const NOT_NATIVE = 'at-rule:container/scroll-state';
// The queried feature is a subfeature with its own BCD statement.
const NOT_NATIVE_FORM = 'at-rule:container/scroll-state/stuck';
const TWO_INCOMPATIBLE = [
  'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
  'PMS_TARGET_CAPABILITY_INCOMPATIBLE',
];

/**
 * The valid fixture with one condition the default profile does not support
 * natively, used by a page: `@container scroll-state()` is incompatible on
 * every default engine.
 */
function openWithUnsupportedCondition({ enhancement = false } = {}) {
  const h = openProject('valid');
  let definition = fs.readFileSync(h.sharedDefinitionPath, 'utf8');
  definition = definition.replace(
    "reducedMotion: '@media (prefers-reduced-motion: reduce)',",
    "reducedMotion: '@media (prefers-reduced-motion: reduce)',\n    stuck: '@container scroll-state(stuck: top)',",
  );
  if (enhancement) {
    definition = definition.replace(
      "systemId: 'conformance@0.1',",
      `systemId: 'conformance@0.1',\n  enhancements: [{ feature: '${NOT_NATIVE}', fallback: { kind: 'degrade', note: 'no sticky styling' } }],`,
    );
  }
  fs.writeFileSync(h.sharedDefinitionPath, definition);
  const page = h.src('src/page.js');
  fs.writeFileSync(
    page,
    fs
      .readFileSync(page, 'utf8')
      .replace(
        'padding: { base: SPACING.md, wide: SPACING.lg },',
        'padding: { base: SPACING.md, wide: SPACING.lg, stuck: SPACING.xl },',
      ),
  );
  return h;
}

function readOut(h, name) {
  return fs.readFileSync(path.join(h.outDir, name), 'utf8');
}
const codes = (diagnostics) => diagnostics.map((d) => d.code);

/** Re-opens a harness so its session starts from the edited bytes. */
function prepared(h, targets) {
  h.reloadDefinition();
  if (targets !== undefined) h.setBuildOption('targets', targets);
  h.session.applyChanges({
    definition: h.reloadDefinition(),
    config: targets === undefined ? undefined : { targets },
    mutation: undefined,
  });
  return h;
}

describe('advisory mode (no targets)', () => {
  let h;
  let validation;
  beforeAll(() => {
    h = prepared(openWithUnsupportedCondition());
    validation = h.session.validate();
    if (validation.ok) h.session.compile();
  });

  test('the finding is a warning and the revision is ok', () => {
    expect(validation.ok).toBe(true);
    expect(codes(validation.diagnostics)).toEqual(TWO_INCOMPATIBLE);
    expect(validation.diagnostics.map((d) => d.context.feature)).toEqual([
      NOT_NATIVE,
      NOT_NATIVE_FORM,
    ]);
    const [warning] = validation.diagnostics;
    expect(warning).toMatchObject({
      severity: 'warning',
      role: 'page',
      context: {
        feature: NOT_NATIVE,
        profile: 'pandamstyle:default@1',
        enforcement: 'advisory',
        conditions: ['stuck'],
      },
      repair: { kind: 'replace-condition', target: { conditions: ['stuck'] } },
    });
    expect(warning.location.file).toBe(h.src('src/page.js'));
    // Candidates are the declared conditions native on every engine.
    expect(warning.candidates.map((c) => c.value)).toEqual(
      expect.arrayContaining(['wide', 'reducedMotion']),
    );
    expect(warning.candidates.map((c) => c.value)).not.toContain('stuck');
    expect(warning.candidatesTotal).toBe(warning.candidates.length);
    expect(warning.candidatesTruncated).toBe(false);
  });

  test('the full build agrees and its report records the profile as failing', () => {
    const result = h.full();
    expect(codes(result.targetDiagnostics)).toEqual(TWO_INCOMPATIBLE);
    const report = JSON.parse(readOut(h, 'build-report.json')).targets;
    expect(report).toMatchObject({
      kind: 'pandamstyle-target-report',
      schemaVersion: 1,
      enforcement: 'advisory',
      profiles: [{ ref: 'pandamstyle:default@1', status: 'failing' }],
      failing: [NOT_NATIVE, NOT_NATIVE_FORM].map((feature) => ({
        feature,
        profiles: [{ ref: 'pandamstyle:default@1', state: 'incompatible' }],
      })),
      failingTotal: 2,
      failingTruncated: false,
    });
    expect(report.counts.failingRequired).toBe(2);
  });
});

describe('enforced mode (explicit targets)', () => {
  test('the same finding is an error, the revision is not ok and nothing is published', () => {
    const h = prepared(openWithUnsupportedCondition(), ENFORCED);
    const validation = h.session.validate();
    expect(validation.ok).toBe(false);
    expect(codes(validation.diagnostics)).toEqual(TWO_INCOMPATIBLE);
    expect(validation.diagnostics[0]).toMatchObject({
      severity: 'error',
      rule: 'targets.capability.required',
      context: { feature: NOT_NATIVE, state: 'incompatible' },
    });
    expect(() => h.session.compile()).toThrow();
    expect(fs.existsSync(path.join(h.outDir, 'manifest.json'))).toBe(false);

    let error = null;
    try {
      h.full();
    } catch (e) {
      error = e;
    }
    expect(codes(error.diagnostics)).toEqual(TWO_INCOMPATIBLE);
    expect(fs.existsSync(path.join(h.outDir, 'manifest.json'))).toBe(false);
  });

  test('an author enhancement turns it into a warning and the revision publishes', () => {
    const h = prepared(
      openWithUnsupportedCondition({ enhancement: true }),
      ENFORCED,
    );
    const validation = h.session.validate();
    expect(validation.ok).toBe(true);
    // The policy of the construct covers its subfeature form.
    expect(codes(validation.diagnostics)).toEqual([
      'PMS_TARGET_ENHANCEMENT_DEGRADED',
      'PMS_TARGET_ENHANCEMENT_DEGRADED',
    ]);
    expect(validation.diagnostics.map((d) => d.context.feature)).toEqual([
      NOT_NATIVE,
      NOT_NATIVE_FORM,
    ]);
    expect(validation.diagnostics[0]).toMatchObject({
      severity: 'warning',
      context: {
        feature: NOT_NATIVE,
        profile: 'pandamstyle:default@1',
        fallback: { kind: 'degrade', note: 'no sticky styling' },
      },
    });
    h.session.compile();
    const report = JSON.parse(readOut(h, 'build-report.json')).targets;
    expect(report.enforcement).toBe('enforced');
    expect(report.profiles).toEqual([
      { ref: 'pandamstyle:default@1', status: 'passing' },
    ]);
    expect(report.counts.enhancements).toBe(2);
  });
});

describe('consistency of the published target records', () => {
  let h;
  beforeAll(() => {
    h = prepared(openProject('valid'), ENFORCED);
    expect(h.session.validate().ok).toBe(true);
    h.session.compile();
  });

  test('snapshot, manifest, artifacts.json and build report name the same resolution', () => {
    const manifest = JSON.parse(readOut(h, 'manifest.json'));
    const artifacts = JSON.parse(readOut(h, 'artifacts.json'));
    const report = JSON.parse(readOut(h, 'build-report.json'));
    // The canonical snapshot built from the same definition and resolution.
    const snapshot = h.compiler.buildDesignSystem(
      h.reloadDefinition(),
      {},
      { targets: h.compiler.targets.resolveTargets(ENFORCED).record },
    ).snapshot;
    const digest = manifest.targets.digest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifacts.targetsDigest).toBe(digest);
    expect(report.targets.resolutionDigest).toBe(digest);
    expect(snapshot.targets.digest).toBe(digest);
    expect(manifest.targetRequirements.digest).toBe(
      snapshot.targetFacts.digest,
    );
    expect(snapshot.targetFacts).toMatchObject({
      kind: 'pandamstyle-target-facts',
      schemaVersion: 1,
      scope: 'design-system',
      resolutionDigest: digest,
    });
    expect(manifest.targets).toMatchObject({
      schemaVersion: 1,
      enforcement: 'enforced',
      origin: 'project-config',
      profiles: [{ ref: 'pandamstyle:default@1', excluded: 0 }],
    });
    expect(manifest.targetRequirements.schemaVersion).toBe(1);
    expect(manifest.targetRequirements.features).toEqual(
      expect.arrayContaining(['property:custom-property', 'selector::is']),
    );
    // Schema versions are unchanged: the members are additive.
    expect(manifest.manifestSchemaVersion).toBe(1);
    expect(artifacts.schemaVersion).toBe(1);
    expect(report.schemaVersion).toBe(2);
  });

  test('validateArtifactSet refuses a targets digest that disagrees with the manifest', () => {
    const metadata = JSON.parse(readOut(h, 'artifacts.json'));
    const contents = Object.fromEntries(
      Object.entries(metadata.artifacts).map(([name, record]) => [
        name,
        readOut(h, record.file),
      ]),
    );
    expect(h.compiler.validateArtifactSet(metadata, contents)).toBe(true);
    expect(() =>
      h.compiler.validateArtifactSet(
        { ...metadata, targetsDigest: `sha256:${'0'.repeat(64)}` },
        contents,
      ),
    ).toThrow(/targetsDigest/);
    const { targetsDigest: _dropped, ...withoutDigest } = metadata;
    expect(() =>
      h.compiler.validateArtifactSet(withoutDigest, contents),
    ).toThrow(/targetsDigest/);
  });
});

describe('incremental session against the fresh oracle', () => {
  test('a targets change is a compiler-configuration fallback equal to a fresh build', () => {
    const h = openProject('valid');
    expect(h.revise().ok).toBe(true);
    expect(differential(h, 'implicit default').findings).toEqual([]);
    for (const [label, targets] of [
      ['explicit default', ENFORCED],
      [
        'ios and electron',
        { profiles: ['pandamstyle:ios-safari@1', 'pandamstyle:electron@1'] },
      ],
      ['back to implicit', null],
    ]) {
      h.setBuildOption('targets', targets);
      const result = differential(h, label, { config: { targets } });
      expect(result.validation.counters.fullFallbackReason).toBe(
        'compiler-configuration',
      );
      expect(result.findings).toEqual([]);
    }
  });

  test('advisory warnings are the same in the session and the fresh oracle', () => {
    const h = prepared(openWithUnsupportedCondition());
    const result = differential(h, 'advisory warning');
    expect(result.validation.ok).toBe(true);
    expect(codes(result.validation.diagnostics)).toEqual(TWO_INCOMPATIBLE);
    expect(result.findings).toEqual([]);
  });

  test('an invalid targets change is refused and a later valid one recovers', () => {
    const h = openProject('valid');
    expect(h.revise().ok).toBe(true);
    const bad = h.revise({ config: { targets: { profiles: ['nope'] } } });
    expect(bad.ok).toBe(false);
    expect(codes(bad.diagnostics)).toEqual(['PMS_INVALID_TARGET_CONFIG']);
    h.setBuildOption('targets', ENFORCED);
    const result = differential(h, 'recovered', {
      config: { targets: ENFORCED },
    });
    expect(result.validation.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

describe('target records do not depend on the checkout location', () => {
  test('the same project in two directories gives the same facts, report section and manifest', () => {
    // A page-owned failing feature, so page owners enter the facts.
    const copies = [
      openWithUnsupportedCondition(),
      openWithUnsupportedCondition(),
    ];
    for (const h of copies) h.reloadDefinition();
    const records = copies.map((h) => {
      const result = h.full();
      const report = JSON.parse(readOut(h, 'build-report.json')).targets;
      return {
        report,
        manifest: readOut(h, 'manifest.json'),
        warnings: result.targetDiagnostics.map((d) => d.code),
      };
    });
    expect(records[0].report.failingTotal).toBeGreaterThan(0);
    expect(records[0].warnings).toContain('PMS_TARGET_CAPABILITY_INCOMPATIBLE');
    expect(records[1].report).toEqual(records[0].report);
    expect(records[1].manifest).toBe(records[0].manifest);
  });

  test('facts carry owner counts by role, never file paths', () => {
    const h = openProject('valid');
    h.full();
    const report = JSON.parse(readOut(h, 'build-report.json'));
    expect(JSON.stringify(report.targets)).not.toContain(h.project);
  });
});

describe('generated runtime outputs do not depend on targets', () => {
  test('design module, declarations and CSS bytes are identical with and without targets', () => {
    const read = (targets) => {
      const h = openProject('valid');
      h.setBuildOption('targets', targets);
      h.full();
      const manifest = JSON.parse(readOut(h, 'manifest.json'));
      const artifacts = JSON.parse(readOut(h, 'artifacts.json'));
      return {
        module: readOut(h, 'design.pandamstyle.js'),
        declarations: readOut(h, 'design.pandamstyle.d.ts'),
        css: readOut(h, 'styles.css'),
        manifestIdentity: {
          systemId: manifest.systemId,
          registryDigest: manifest.registryDigest,
          abiVersion: manifest.abiVersion,
          compilerContractVersion: manifest.compilerContractVersion,
          manifestSchemaVersion: manifest.manifestSchemaVersion,
        },
        targetsDigest: artifacts.targetsDigest,
      };
    };
    const implicit = read(null);
    const ios = read({ profiles: ['pandamstyle:ios-safari@1'] });
    expect(ios.module).toBe(implicit.module);
    expect(ios.declarations).toBe(implicit.declarations);
    expect(ios.css).toBe(implicit.css);
    expect(ios.manifestIdentity).toEqual(implicit.manifestIdentity);
    expect(ios.targetsDigest).not.toBe(implicit.targetsDigest);
    expect(implicit.module).not.toMatch(/targets|browserslist/);
  });
});
