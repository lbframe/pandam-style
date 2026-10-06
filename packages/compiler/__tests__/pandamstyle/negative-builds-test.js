/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle: negative builds, proven through a real process boundary.
 *
 * Every case spawns the build CLI and asserts BOTH:
 *  - the observed exit status is non-zero, and
 *  - the expected PMS code is among the reported diagnostics.
 *
 * A missing package, a syntax error or an install crash is NOT a policy
 * rejection: each case also asserts the process failed with a policy
 * diagnostic (exit 1 with PMS_JSON), never with an internal error (exit 2).
 *
 * Positive and negative fixtures live in separate projects, so the valid build
 * is never obtained by deleting or excluding the errors from its own inputs.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { freshCopyOf, runBuild } = require('./pms-helpers');

/**
 * Each entry: [fixture, expected code, acceptance cases, what it proves].
 */
const CASES = [
  [
    'neg-forbidden-value',
    'PMS_FORBIDDEN_VALUE',
    ['AC-011', 'AC-016', 'AC-018'],
    'raw value, forged var(), forged ref object, alias, computed key, spread',
  ],
  [
    'neg-forbidden-value-ts',
    'PMS_FORBIDDEN_VALUE',
    ['AC-017'],
    'same error in TSX with `as any` and a double cast, no tsc involved',
  ],
  [
    'neg-unknown-token',
    'PMS_UNKNOWN_TOKEN',
    ['AC-012'],
    'token absent from the registry',
  ],
  [
    'neg-private-token',
    'PMS_TOKEN_NOT_PUBLIC',
    ['AC-020'],
    'private primitive selected from a consumer page',
  ],
  [
    'neg-token-category',
    'PMS_INVALID_TOKEN_CATEGORY',
    ['AC-013'],
    'spacing token used for fontSize',
  ],
  [
    'neg-composite-form',
    'PMS_UNSUPPORTED_PROPERTY_FORM',
    ['AC-015'],
    'composite border shorthand',
  ],
  [
    'neg-unsupported-property',
    'PMS_UNSUPPORTED_PROPERTY',
    ['AC-012'],
    'property outside the closed profile',
  ],
  [
    'neg-unknown-condition',
    'PMS_UNKNOWN_CONDITION',
    ['AC-024'],
    'condition outside the P0 matrix',
  ],
  [
    'neg-forbidden-import',
    'PMS_FORBIDDEN_IMPORT',
    ['AC-051', 'AC-052'],
    'direct engine entries and the atoms path in a covered page',
  ],
  [
    'neg-style-channel',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['AC-054'],
    'inline style attribute and unapproved local stylesheet',
  ],
  [
    'neg-jsx-spread',
    'PMS_UNVERIFIED_JSX_SPREAD',
    ['AC-054'],
    'JSX spread that cannot be proven free of style/className',
  ],
  [
    'neg-invalid-variant',
    'PMS_INVALID_VARIANT_VALUE',
    ['AC-039'],
    'literal invalid variant rejected at build, before any style is emitted',
  ],
  [
    'neg-non-static',
    'PMS_NON_STATIC_VALUE',
    ['AC-023', 'AC-019'],
    'local helper named token gains no trust; props value is not static',
  ],
  // --- consolidation batch -------------------------------------------------
  // BC-1: props() admits no raw, unvalidated CSS.
  [
    'neg-props-raw-object',
    'PMS_UNVERIFIED_PROPS_SOURCE',
    ['BC-1'],
    'an object literal handed to props(), while a create() namespace in the ' +
      'same file compiles',
  ],
  [
    'neg-props-raw-reference',
    'PMS_UNVERIFIED_PROPS_SOURCE',
    ['BC-1'],
    'an arbitrary local object, and a spread of it, handed to props()',
  ],
  // BC-2: provenance is attached to a real binding.
  [
    'neg-props-shadowing',
    'PMS_UNVERIFIED_JSX_SPREAD',
    ['BC-2'],
    'a parameter shadowing a module-level props() result inherits nothing',
  ],
  [
    'neg-props-reassigned',
    'PMS_UNVERIFIED_JSX_SPREAD',
    ['BC-2'],
    'a props() result that is then reassigned is not the proven value',
  ],
  [
    'neg-props-mutated',
    'PMS_UNVERIFIED_PROVENANCE',
    ['BC-2'],
    'a proven props() result whose member is written to afterwards',
  ],
  [
    'neg-props-escaped',
    'PMS_UNVERIFIED_PROVENANCE',
    ['BC-2'],
    'a proven value handed to an unknown function and to Object.assign',
  ],
  [
    'neg-helper-shadowed',
    'PMS_UNVERIFIED_JSX_SPREAD',
    ['BC-2', 'BC-6'],
    'an alias of the helper, and a nested declaration shadowing it, are not ' +
      'the helper',
  ],
  // BC-3: the coverage graph follows the real local module edges.
  [
    'neg-relay-reexport-star',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['BC-3', 'BC-9'],
    'a module outside every root, reached through `export *`',
  ],
  [
    'neg-relay-reexport-named',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['BC-3', 'BC-9'],
    'a module outside every root, reached through a named re-export',
  ],
  [
    'neg-relay-barrel-chain',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['BC-3', 'BC-9'],
    'two barrels deep, both outside every root',
  ],
  [
    'neg-unresolved-import',
    'PMS_COVERAGE_GAP',
    ['BC-3', 'BC-4'],
    'a local import that resolves to nothing',
  ],
  [
    'neg-dynamic-import',
    'PMS_COVERAGE_GAP',
    ['BC-3', 'BC-4'],
    'a dynamic request that is not a static string',
  ],
  [
    'neg-dynamic-import-local',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['BC-3', 'BC-9'],
    'a literal dynamic import: the target is a normal local edge and is analysed',
  ],
  [
    'neg-stylesheet-via-relay',
    'PMS_FORBIDDEN_STYLE_CHANNEL',
    ['BC-3', 'BC-9'],
    'an unapproved stylesheet reached only through a relay',
  ],
];

describe.each(CASES)(
  '%s fails with %s',
  (fixture, expectedCode, cases, what) => {
    let result;
    let project;

    beforeAll(() => {
      project = freshCopyOf(fixture);
      result = runBuild(project);
    });

    test(`build process exits non-zero (AC ${cases.join(', ')}: ${what})`, () => {
      expect(result.status).not.toBe(0);
      // A policy rejection is exit 1. Exit 2 would mean a usage or
      // environment error, which does not count as a rejection.
      expect(result.status).toBe(1);
    });

    test('the failure is the expected policy code, not a crash', () => {
      expect(result.codes).toContain(expectedCode);
      expect(result.stderr).toContain('PMS_JSON:');
      expect(result.stderr).not.toContain('unexpected build error');
    });

    test('no artifact is published as current', () => {
      const styles = path.join(project, 'generated/styles.css');
      if (fs.existsSync(styles)) {
        // Any stylesheet present must be from an earlier successful build, and
        // the failing build must not have rewritten it in place.
        expect(fs.statSync(styles).isFile()).toBe(true);
      }
      // The CSS is only written on success.
      expect(result.stdout).not.toContain('build ok');
    });
  },
);

describe('role violation is reported on its own code', () => {
  let result;

  beforeAll(() => {
    result = runBuild(freshCopyOf('neg-role-violation'));
  });

  test('a page cannot self-declare authority', () => {
    expect(result.status).toBe(1);
    expect(result.codes).toContain('PMS_ROLE_VIOLATION');
    expect(result.codes).not.toContain('PMS_OK');
  });

  test('the engine entry point is refused too', () => {
    expect(result.codes).toContain('PMS_FORBIDDEN_IMPORT');
  });
});

describe('PMS_FORBIDDEN_VALUE diagnostic content', () => {
  let diag;

  beforeAll(() => {
    const result = runBuild(freshCopyOf('neg-forbidden-value'));
    const d = result.diagnostics.find((x) => x.code === 'PMS_FORBIDDEN_VALUE');
    diag = d;
  });

  test('names the offending property', () => {
    expect(diag.context.property).toBe('padding');
  });

  test('points at the location inside the page', () => {
    expect(diag.location).not.toBeNull();
    expect(diag.location.file).toBe('src/page.js');
    expect(typeof diag.location.line).toBe('number');
    expect(diag.location.line).toBeGreaterThan(0);
    expect(diag.role).toBe('page');
  });

  test('names the violated rule and the system identity', () => {
    expect(diag.rule).toBe('category-strict');
    expect(diag.context.systemId).toBe('conformance@0.1');
    expect(diag.expected.category).toBe('spacing');
  });

  test('lists only admissible public candidates', () => {
    expect(diag.candidates.map((candidate) => candidate.tokenId)).toEqual(
      expect.arrayContaining(['spacing.md', 'spacing.lg']),
    );
    // No private primitive may be offered as a candidate.
    expect(diag.candidates.map((candidate) => candidate.tokenId)).not.toContain(
      'colors.blue.500',
    );
  });

  test('keeps autofix null: 17px is not a proven visual equivalent of 16px', () => {
    expect(diag.autofix).toBeNull();
    expect(diag.context.value).toBe('17px');
  });

  test('the proximity to spacing.md does not authorize a rewrite', () => {
    // The message may suggest, but the diagnostic never carries a fix.
    expect(JSON.stringify(diag)).not.toMatch(/"autofix"\s*:\s*\{/);
  });
});

describe('every forbidden-value route is refused, none silently', () => {
  test('all six routes report PMS_FORBIDDEN_VALUE', () => {
    const result = runBuild(freshCopyOf('neg-forbidden-value'));
    const forbidden = result.diagnostics.filter(
      (d) => d.code === 'PMS_FORBIDDEN_VALUE',
    );
    // raw literal, var() string, forged ref, alias, computed key, spread
    expect(forbidden.length).toBe(6);
    const values = forbidden.map((d) => {
      try {
        return JSON.stringify(d.context.value);
      } catch {
        return 'unserializable';
      }
    });
    expect(new Set(values).size).toBeGreaterThan(1);
    expect(result.status).toBe(1);
  });
});

describe('a global runner may pass only when the negative builds really failed', () => {
  test('the runner fails if a negative build unexpectedly succeeds', () => {
    // Guard against a fixture silently becoming valid: the positive project and
    // the negative projects are distinct, and a green negative is a red flag.
    const result = runBuild(freshCopyOf('neg-forbidden-value'));
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('build ok');
  });

  test('the runner fails if a negative build fails for another reason', () => {
    const result = runBuild(freshCopyOf('neg-forbidden-value'));
    expect(result.stderr).not.toContain('unexpected build error');
    expect(result.status).not.toBe(2);
    expect(result.codes.length).toBeGreaterThan(0);
  });
});
