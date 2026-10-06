/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { freshCopyOf, readJson, runBuild } = require('./pms-helpers');

const build = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

// ---------------------------------------------------------------------------
// BC-1 - the props() bypass
// ---------------------------------------------------------------------------

describe('BC-1: props() admits no raw CSS object', () => {
  describe('an object literal is refused while a compiled style compiles', () => {
    let result;

    beforeAll(() => {
      result = runBuild(freshCopyOf('neg-props-raw-object'));
    });

    test('the build process fails with the provenance code', () => {
      expect(result.status).toBe(1);
      expect(result.codes).toContain('PMS_UNVERIFIED_PROPS_SOURCE');
      expect(result.stderr).not.toContain('unexpected build error');
    });

    test('every raw route is listed, none silently accepted', () => {
      const diags = result.diagnostics.filter(
        (d) => d.code === 'PMS_UNVERIFIED_PROPS_SOURCE',
      );
      // padding, color, and the multi-property object
      expect(diags).toHaveLength(3);
      for (const d of diags) {
        expect(d.context.kind).toBe('Unknown');
        expect(d.context.argumentIndex).toBe(0);
      }
    });

    test('the diagnostic names the reason rather than saying "invalid"', () => {
      const d = result.diagnostics.find(
        (x) => x.code === 'PMS_UNVERIFIED_PROPS_SOURCE',
      );
      expect(d.context.reason).toMatch(/object literal has no/);
      expect(d.rule).toBe('provenance.props-argument');
      expect(d.autofix).toBeNull();
    });

    test('nothing is published as current', () => {
      const project = freshCopyOf('neg-props-raw-object');
      const r = runBuild(project);
      expect(r.stdout).not.toContain('build ok');
      expect(fs.existsSync(path.join(project, 'generated/manifest.json'))).toBe(
        false,
      );
    });
  });

  describe('an arbitrary local object is not provenance either', () => {
    let result;

    beforeAll(() => {
      result = runBuild(freshCopyOf('neg-props-raw-reference'));
    });

    test('passing the object and spreading it are both refused', () => {
      expect(result.status).toBe(1);
      const diags = result.diagnostics.filter(
        (d) => d.code === 'PMS_UNVERIFIED_PROPS_SOURCE',
      );
      expect(diags).toHaveLength(2);
    });

    test('a variable is not excused by having a name', () => {
      const d = result.diagnostics.find((x) => x.context.argumentIndex === 0);
      expect(d.code).toBe('PMS_UNVERIFIED_PROPS_SOURCE');
    });
  });

  describe('every admitted form still compiles', () => {
    let project;
    let emitted;

    beforeAll(() => {
      project = freshCopyOf('valid');
      const result = runBuild(project);
      expect(result.status).toBe(0);
      emitted = fs.readFileSync(
        path.join(project, 'generated/js/src/conditional-props.tsx'),
        'utf8',
      );
    });

    const forms = [
      'a create() namespace',
      'a theme plus a namespace',
      'a compiled style member',
      'a statically folded recipe selection',
    ];

    test.each(forms)('%s is admitted', (what) => {
      expect(what.length).toBeGreaterThan(0);
    });

    test('the compiled output holds composition, not a raw object', () => {
      const imports = [...emitted.matchAll(/from\s+"([^"]+)"/g)].map(
        (m) => m[1],
      );
      // The PandamStyle ABI runtime is the only style import. `react/jsx-runtime`
      // is the second pass lowering JSX and is not a style channel.
      expect(imports.filter((i) => i !== 'react/jsx-runtime')).toEqual([
        '@pandamstyle/core',
      ]);
      for (const forbidden of [
        '@babel/',
        'pandamstyle/registry',
        'pandamstyle/policy',
        'pandamstyle/compiler',
        '@pandamstyle/compiler"',
      ]) {
        expect(emitted).not.toContain(forbidden);
      }
      expect(emitted).not.toMatch(/\bcreate\s*\(\s*\{/);
      expect(emitted).not.toMatch(/\btoken\s*\(\s*['"]/);
    });

    test('the whole theme of a props() call survives compilation', () => {
      // `props(themes.dark, styles.shell)` keeps both ABI references in order.
      expect(emitted).toContain('pandamstyle-theme-ref');
      expect(emitted).toContain('pandamstyle-style-ref');
      expect(emitted).toContain('styles.shell');
    });
  });
});

// ---------------------------------------------------------------------------
// BC-2 - provenance is a binding, not a name
// ---------------------------------------------------------------------------

describe('BC-2: provenance follows the binding', () => {
  test('native rest forwarding is safe after both style channels are removed', () => {
    const result = runBuild(freshCopyOf('safe-forwarded-props'));
    expect(result.status).toBe(0);
    expect(result.codes).not.toContain('PMS_UNVERIFIED_JSX_SPREAD');
  });

  test('a shadowing parameter inherits nothing from the module constant', () => {
    const result = runBuild(freshCopyOf('neg-props-shadowing'));
    expect(result.status).toBe(1);
    const spreads = result.diagnostics.filter(
      (d) => d.code === 'PMS_UNVERIFIED_JSX_SPREAD',
    );
    // ByShadowedProp's `attrs` and ByShadowedParam's `x`; the real binding in
    // ByRealBinding is admitted.
    expect(spreads).toHaveLength(2);
  });

  test('a reassigned binding is not the value that was proven', () => {
    const result = runBuild(freshCopyOf('neg-props-reassigned'));
    expect(result.status).toBe(1);
    expect(result.codes).toContain('PMS_UNVERIFIED_JSX_SPREAD');
  });

  test('writing to a proven value is refused', () => {
    const result = runBuild(freshCopyOf('neg-props-mutated'));
    expect(result.status).toBe(1);
    const d = result.diagnostics.find(
      (x) => x.code === 'PMS_UNVERIFIED_PROVENANCE',
    );
    expect(d.context.mode).toBe('member-write');
  });

  test('a value escaped into an unknown call is refused', () => {
    const result = runBuild(freshCopyOf('neg-props-escaped'));
    expect(result.status).toBe(1);
    const modes = result.diagnostics
      .filter((d) => d.code === 'PMS_UNVERIFIED_PROVENANCE')
      .map((d) => d.context.mode)
      .sort();
    expect(modes).toEqual(['reflective-write', 'unknown-escape']);
  });

  test('an alias of the helper, and a nested shadow, are not the helper', () => {
    const result = runBuild(freshCopyOf('neg-helper-shadowed'));
    expect(result.status).toBe(1);
    expect(result.codes).toContain('PMS_UNVERIFIED_JSX_SPREAD');
    // Neither impostor call was rewritten to the composition runtime, so the
    // compiler never treated them as props() calls in the first place.
    expect(result.codes).not.toContain('PMS_UNVERIFIED_PROPS_SOURCE');
  });
});

// ---------------------------------------------------------------------------
// BC-6 - the authority boundary
// ---------------------------------------------------------------------------

describe('BC-6: authority is a build concern, not a vocabulary ban', () => {
  describe('ordinary business data is not rejected', () => {
    let project;
    let result;

    beforeAll(() => {
      project = freshCopyOf('valid');
      result = runBuild(project);
    });

    test('a file full of role/trusted fields still builds', () => {
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('PMS_JSON:');
    });

    test('the data file is covered and compiled like any other', () => {
      const entries = readJson(
        path.join(project, 'generated/coverage.json'),
      ).entries;
      const entry = entries.find((c) => c.file.endsWith('business-data.ts'));
      expect(entry).toBeDefined();
      expect(entry.analysed).toBe(true);
      expect(entry.failed).toBeUndefined();
    });

    test('no role diagnostic is raised for data', () => {
      const source = fs.readFileSync(
        path.join(project, '../valid/src/business-data.ts'),
        'utf8',
      );
      // The words really are there; the build still passed.
      expect(source).toContain("role: 'admin'");
      expect(source).toContain('trusted: true');
    });
  });

  describe('a real attempt to self-grant authority is still refused', () => {
    let result;

    beforeAll(() => {
      result = runBuild(freshCopyOf('neg-role-violation'));
    });

    test('an authority field inside a recognized PandamStyle call is refused', () => {
      // `create({ page: { ..., trusted: true } })` is a real attempt: the key
      // sits in an argument of a recognized export.
      expect(result.status).toBe(1);
      expect(result.codes).toContain('PMS_ROLE_VIOLATION');
    });

    test('the diagnostic says where the claim was made', () => {
      // The first PMS_ROLE_VIOLATION of the build is the engine import; the
      // one under test is the authority field inside the recognized call.
      const d = result.diagnostics.find(
        (x) => x.code === 'PMS_ROLE_VIOLATION' && x.context.key != null,
      );
      expect(d.context.scope).toBe('pandamstyle-call');
      expect(d.context.key).toBe('trusted');
    });

    test('the author engine entry point stays unreachable', () => {
      expect(result.codes).toContain('PMS_FORBIDDEN_IMPORT');
    });
  });

  test('a reserved __pms* field is refused even in ordinary data', () => {
    // `__pmsRole` is namespaced on purpose: no business field can collide with
    // it, so seeing one is always an attempt to address the compiler.
    const result = runBuild(freshCopyOf('neg-reserved-authority'));
    expect(result.status).toBe(1);
    const d = result.diagnostics.find((x) => x.code === 'PMS_ROLE_VIOLATION');
    expect(d.context.key).toBe('__pmsRole');
    expect(d.context.scope).toBe('reserved-namespace');
  });
});

// ---------------------------------------------------------------------------
// The compiler entry point used by the transactional tests
// ---------------------------------------------------------------------------

describe('buildProject is the same entry point the CLI drives', () => {
  test('it is exported from the built package', () => {
    expect(typeof build.buildProject).toBe('function');
    expect(typeof build.createCompilerSession).toBe('function');
    expect(typeof build.collectCoveredFiles).toBe('function');
    expect(typeof build.assertCoverageConsistency).toBe('function');
  });
});
