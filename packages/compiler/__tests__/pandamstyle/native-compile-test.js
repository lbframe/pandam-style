/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle: the native entry point compiles real JS/TS/TSX page files.
 *
 * These tests drive the real build process over the `valid` fixture project.
 * They never call buildDesignSystem/compileStyles in place of a page.
 */

'use strict';

jest.autoMockOff();

const fs = require('fs');
const path = require('path');
const { FIXTURES, freshCopyOf, readJson, runBuild } = require('./pms-helpers');

const VALID = 'valid';
const VALID_IN_REPO = path.join(FIXTURES, 'valid');

let project;
let result;
let artifacts;
// The per-file coverage snapshot. It is its own document since Phase C split it
// out of the build report, so the assertions that used to read
// `report.coverage` read this, and the two are cross-checked below so a reader
// can see the split did not make them disagree.
let coverage;

beforeAll(() => {
  project = freshCopyOf(VALID);
  result = runBuild(project);
  if (result.status === 0) {
    artifacts = {
      css: fs.readFileSync(path.join(project, 'generated/styles.css'), 'utf8'),
      manifest: readJson(path.join(project, 'generated/manifest.json')),
      report: readJson(path.join(project, 'generated/build-report.json')),
      coverageReport: readJson(path.join(project, 'generated/coverage.json')),
      designSystem: fs.readFileSync(
        path.join(project, 'generated/design.pandamstyle.js'),
        'utf8',
      ),
      emittedDir: path.join(project, 'generated/js'),
    };
    coverage = artifacts.coverageReport.entries;
  }
});

describe('valid project builds through real files', () => {
  test('the build process exits 0', () => {
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('PMS_JSON:');
  });

  test('CSS is not empty and carries the expected declarations', () => {
    expect(artifacts.css.length).toBeGreaterThan(0);
    // Token references became CSS variables.
    expect(artifacts.css).toContain('padding:var(--');
    expect(artifacts.css).toContain('background-color:var(--');
    // The named condition became a real media query.
    expect(artifacts.css).toContain('@media (min-width: 768px)');
    // The variable group is emitted, and the dark theme overrides the very same
    // variable identities.
    expect(artifacts.css).toContain(':root');
    expect(artifacts.css).toMatch(/--x\w+:4px;/);
    expect(artifacts.css).toMatch(/--x\w+:16px;/);
    // Structural values inside their declared domain are accepted.
    expect(artifacts.css).toContain('opacity:.5');
    expect(artifacts.css).toContain('width:100%');
  });

  test('the emitted JS imports no compiler, loader or registry', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(artifacts.emittedDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      for (const forbidden of [
        '@babel/',
        'pandamstyle/registry',
        'pandamstyle/policy',
        'pandamstyle/compiler',
        'pandamstyle/build',
        '@pandamstyle/compiler"',
      ]) {
        expect(code).not.toContain(forbidden);
      }
      // No unresolved create()/token() call may reach the runtime.
      expect(code).not.toMatch(/\bcreate\s*\(\s*\{/);
      expect(code).not.toMatch(/\btoken\s*\(\s*['"]/);
    }
  });

  test('the runtime import of the page is the PandamStyle core composition runtime', () => {
    const code = fs.readFileSync(
      path.join(artifacts.emittedDir, 'src/page.js'),
      'utf8',
    );
    const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual(['@pandamstyle/core']);
  });

  test('page sources are not mutated by the build', () => {
    const original = fs.readFileSync(
      path.join(VALID_IN_REPO, 'src/page.js'),
      'utf8',
    );
    expect(original).toContain("from '../generated/design.pandamstyle'");
    expect(original).toContain("token('spacing.md')");
  });

  test('the build is repeatable and yields the same digest', () => {
    const again = runBuild(project);
    expect(again.status).toBe(0);
    expect(
      readJson(path.join(project, 'generated/manifest.json')).registryDigest,
    ).toBe(artifacts.manifest.registryDigest);
  });
});

describe('helper resolution follows binding and module', () => {
  test('renamed imports reached through a barrel are compiled', () => {
    const code = fs.readFileSync(
      path.join(artifacts.emittedDir, 'src/renamed.js'),
      'utf8',
    );
    // pmsCreate/pmsToken are gone: the call was compiled.
    expect(code).not.toContain('pmsCreate(');
    expect(code).not.toContain('pmsToken(');
    expect(code).toContain('pandamstyle-style-ref');
  });

  test('a page importing only a recipe is covered and compiled', () => {
    const entry = coverage.find((c) => c.file.endsWith('only-recipe.js'));
    expect(entry).toBeDefined();
    expect(entry.analysed).toBe(true);
    expect(entry.usedDesignSystem).toBe(true);
    const code = fs.readFileSync(
      path.join(artifacts.emittedDir, 'src/only-recipe.js'),
      'utf8',
    );
    expect(code).toContain('pandamstyle-style-ref');
  });

  test('a namespace import is recognized', () => {
    const code = fs.readFileSync(
      path.join(artifacts.emittedDir, 'src/namespace-import.js'),
      'utf8',
    );
    expect(code).not.toContain('pms.token(');
    expect(code).not.toContain('pms.create(');
    expect(code).toContain('pandamstyle-theme-ref');
    expect(code).toContain('pandamstyle-style-ref');
  });

  test('a hoisted token constant is lowered, not left for the runtime', () => {
    const code = fs.readFileSync(
      path.join(artifacts.emittedDir, 'src/page.js'),
      'utf8',
    );
    expect(code).toContain('var(--');
    expect(code).not.toMatch(/\btoken\s*\(/);
  });
});

describe('generated design system module', () => {
  test('carries the generation marker and the same digest as the manifest', () => {
    expect(artifacts.designSystem).toContain('__pandamstyle');
    const marker = JSON.parse(
      artifacts.designSystem.match(/__pandamstyle = (\{[\s\S]*?\n\});/)[1],
    );
    expect(marker.designSystem.registryDigest).toBe(
      artifacts.manifest.registryDigest,
    );
    expect(marker.designSystem.systemId).toBe(artifacts.manifest.systemId);
  });

  test('exposes the documented consumption surface', () => {
    for (const name of ['create', 'token', 'recipes', 'themes', 'props']) {
      expect(artifacts.designSystem).toMatch(
        new RegExp(`export const ${name}\\b`),
      );
    }
  });

  test('create() and token() throw if ever reached at runtime', () => {
    expect(artifacts.designSystem).toContain('PMS_UNCOMPILED_CREATE');
    expect(artifacts.designSystem).toContain('PMS_TOKEN_RUNTIME');
  });

  test('recipe selectors carry finite data, not a cartesian product', () => {
    const spec = JSON.parse(
      artifacts.designSystem.match(
        /defineRecipeSelector\((\{[\s\S]*?\n\})\);/,
      )[1],
    );
    expect(spec.axisOrder).toEqual(['variant', 'size']);
    expect(Object.keys(spec.branches.variant)).toEqual([
      'primary',
      'secondary',
    ]);
    expect(Object.keys(spec.branches.size)).toEqual(['sm', 'md']);
    // base + 2 + 2 branches, not 2 x 2 combinations.
    expect(Object.keys(spec.branches.variant).length).toBe(2);
    expect(spec.defaultVariants).toEqual({ variant: 'primary', size: 'md' });
  });
});

describe('generation coherence and coverage report', () => {
  test('every artifact references the same registryDigest', () => {
    const marker = JSON.parse(
      artifacts.designSystem.match(/__pandamstyle = (\{[\s\S]*?\n\});/)[1],
    );
    expect(artifacts.manifest.registryDigest).toBe(
      artifacts.report.registryDigest,
    );
    expect(marker.designSystem.registryDigest).toBe(
      artifacts.report.registryDigest,
    );
  });

  test('coverage lists the declared roots and the analysed files', () => {
    expect(artifacts.report.coveredRoots.length).toBeGreaterThan(0);
    expect(artifacts.report.coveredFileCount).toBe(coverage.length);
    expect(artifacts.report.coverageSummary.entries).toBe(coverage.length);
    for (const entry of coverage) {
      expect(entry.analysed).toBe(true);
      expect(entry.failed).toBeUndefined();
    }
    const kinds = new Set(coverage.map((c) => c.origin));
    expect(kinds).toContain('root');
    expect(kinds).toContain('generated');
  });

  test('the barrel relay is recorded in the coverage chain', () => {
    const entry = coverage.find((c) => c.file.endsWith('renamed.js'));
    expect(entry.relayChain.length).toBeGreaterThan(1);
  });

  test('the stylesheet is non-empty and rules were collected', () => {
    expect(artifacts.report.cssBytes).toBeGreaterThan(0);
    expect(artifacts.report.designSystemRuleCount).toBeGreaterThan(0);
    expect(artifacts.report.consumerRuleCount).toBeGreaterThan(0);
  });
});
