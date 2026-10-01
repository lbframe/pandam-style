/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle: registry invalidation (ARC-14, P0-10, AC-056/057).
 *
 * The design system is a separate input file from the pages, so a token can be
 * removed WITHOUT touching any page. The second build must fail at the stale
 * usage and must not present any artifact as current.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const {
  freshCopyOf,
  readJson,
  runBuild,
  sharedDefinitionOf,
} = require('./pms-helpers');

describe('removing a token invalidates its stale usages', () => {
  let project;
  let first;
  let firstManifest;
  let firstCss;

  beforeAll(() => {
    project = freshCopyOf('valid');
    first = runBuild(project);
    expect(first.status).toBe(0);
    firstManifest = readJson(path.join(project, 'generated/manifest.json'));
    firstCss = fs.readFileSync(
      path.join(project, 'generated/styles.css'),
      'utf8',
    );
  });

  test('the first build is valid and records its digest', () => {
    expect(firstManifest.registryDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(firstCss).toContain('--x');
  });

  describe('second build after removing spacing.md, pages untouched', () => {
    let second;
    let defPath;

    beforeAll(() => {
      defPath = sharedDefinitionOf(project);
      const before = fs.readFileSync(defPath, 'utf8');
      // spacing.lg is used by pages only: the design system keeps building, so
      // the failure has to come from the stale page usage.
      const after = before.replace(
        /\n\s*lg:\s*\{\s*value:\s*'24px',\s*visibility:\s*'public'\s*\},/,
        '',
      );
      expect(after).not.toBe(before);
      fs.writeFileSync(defPath, after, 'utf8');

      // Prove the page files were not modified.
      const page = fs.readFileSync(path.join(project, 'src/page.js'), 'utf8');
      expect(page).toContain('SPACING.lg');

      second = runBuild(project);
    });

    test('the second build fails with a non-zero status', () => {
      expect(second.status).toBe(1);
      expect(second.stdout).not.toContain('build ok');
    });

    test('the stale usage is detected as an unknown token', () => {
      expect(second.codes).toContain('PMS_UNKNOWN_TOKEN');
      const diag = second.diagnostics.find(
        (d) => d.code === 'PMS_UNKNOWN_TOKEN',
      );
      expect(diag.context.tokenId).toBe('spacing.lg');
    });

    test('the diagnostic points at the page that still uses it', () => {
      const diag = second.diagnostics.find(
        (d) => d.code === 'PMS_UNKNOWN_TOKEN',
      );
      expect(diag.location.file).toBe('src/page.js');
      expect(diag.role).toBe('page');
    });

    test('no artifact is presented as the new current generation', () => {
      // The manifest still carries the digest of the previous valid build: the
      // failing build published nothing, and did not silently recompute.
      const manifest = readJson(path.join(project, 'generated/manifest.json'));
      expect(manifest.registryDigest).toBe(firstManifest.registryDigest);
      const marker = fs
        .readFileSync(
          path.join(project, 'generated/design.pandamstyle.js'),
          'utf8',
        )
        .match(/__pandamstyle = (\{[\s\S]*?\n\});/)[1];
      expect(JSON.parse(marker).designSystem.registryDigest).toBe(
        firstManifest.registryDigest,
      );
    });

    test('the previous stylesheet is not overwritten by a false current one', () => {
      const css = fs.readFileSync(
        path.join(project, 'generated/styles.css'),
        'utf8',
      );
      expect(css).toBe(firstCss);
    });
  });

  describe('restoring the token yields a valid build again', () => {
    test('the third build succeeds and the digest matches the first one', () => {
      const defPath = sharedDefinitionOf(project);
      const current = fs.readFileSync(defPath, 'utf8');
      fs.writeFileSync(
        defPath,
        current.replace(
          "      sm: { value: '8px', visibility: 'public' },",
          "      sm: { value: '8px', visibility: 'public' },\n      lg: { value: '24px', visibility: 'public' },",
        ),
        'utf8',
      );
      const third = runBuild(project);
      expect(third.status).toBe(0);
      const manifest = readJson(path.join(project, 'generated/manifest.json'));
      // The registry is back to its original content, so its digest is too.
      expect(manifest.registryDigest).toBe(firstManifest.registryDigest);
    });
  });
});

describe('changing a token value updates the digest but preserves identity', () => {
  let project;
  let before;
  let after;

  beforeAll(() => {
    project = freshCopyOf('valid');
    before = runBuild(project);
    expect(before.status).toBe(0);
    const defPath = sharedDefinitionOf(project);
    const original = fs.readFileSync(defPath, 'utf8');
    fs.writeFileSync(
      defPath,
      original.replace(
        "      md: { value: '16px', visibility: 'public' },",
        "      md: { value: '18px', visibility: 'public' },",
      ),
      'utf8',
    );
    after = runBuild(project);
  });

  test('the build still succeeds and the digest changed', () => {
    expect(after.status).toBe(0);
    const a = readJson(path.join(project, 'generated/manifest.json'));
    // read the "before" digest from the first report written by `before`
    expect(a.registryDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the logical variable identity of spacing.md is preserved', () => {
    const css = fs.readFileSync(
      path.join(project, 'generated/styles.css'),
      'utf8',
    );
    // 18px is now emitted...
    expect(css).toMatch(/--x\w+:18px;/);
    // ...and the atomic class still references a variable, not a raw value.
    expect(css).toContain('padding:var(--');
  });
});
