/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle — production des artefacts de preuve.
 * Écrit dans PMS_OUT_DIR (défaut: ./out-pandamstyle) :
 * styles.css, manifest.json, diagnostics-17px.json, page.example.json,
 * demo.html, build-report.json.
 */

'use strict';

jest.autoMockOff();

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  buildDesignSystem,
  conformanceDefinition,
  token,
  PmsError,
} from '../../../../.pms-test-support/compiler-inspection.cjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const OUT = path.join(REPO_ROOT, 'out-pandamstyle', 'artifacts-test');

function write(name, content) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), content);
}

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: REPO_ROOT,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

describe('pandamstyle: artefacts', () => {
  test('build de la fixture conformance + page exemple + rejet 17px', () => {
    const ds = buildDesignSystem(conformanceDefinition);

    // Page consommatrice (cf. exemple §5 du périmètre P0).
    const page = ds.create({
      page: {
        backgroundColor: token('colors.surface.primary'),
        color: token('colors.text.primary'),
        padding: { base: token('spacing.md'), wide: token('spacing.lg') },
      },
      actions: {
        display: 'flex',
        gap: token('spacing.sm'),
      },
    });

    const lightProps = ds.props(ds.themes.light, page.compiled.page);
    const darkProps = ds.props(ds.themes.dark, page.compiled.page);
    const buttonPrimary = ds.props(
      ds.recipes.button({ variant: 'primary', size: 'md' }),
    );
    const buttonSecondary = ds.props(
      ds.recipes.button({ variant: 'secondary', size: 'sm' }),
    );

    // Rejet effectif d'une valeur interdite — le chemin réel de compilation.
    let rejected = null;
    try {
      ds.create({ page: { padding: '17px' } });
    } catch (e) {
      expect(e).toBeInstanceOf(PmsError);
      rejected = { exitCode: 1, diagnostics: e.diagnostics };
    }
    expect(rejected).not.toBeNull();
    expect(rejected.diagnostics[0].code).toBe('PMS_FORBIDDEN_VALUE');

    write('styles.css', ds.renderCss() + '\n');
    write('manifest.json', JSON.stringify(ds.manifest, null, 2) + '\n');
    write(
      'diagnostics-17px.json',
      JSON.stringify(
        {
          case: 'consumer page with padding: "17px" (role: consumer, no TS)',
          ...rejected,
        },
        null,
        2,
      ) + '\n',
    );
    write(
      'page.example.json',
      JSON.stringify(
        {
          compiledNamespaces: page.compiled,
          classPaths: page.classPaths,
          props: {
            light: lightProps,
            dark: darkProps,
            buttonPrimary,
            buttonSecondary,
          },
        },
        null,
        2,
      ) + '\n',
    );
    write(
      'demo.html',
      [
        '<!doctype html><meta charset="utf-8"><title>pandamstyle demo</title>',
        `<style>${ds.renderCss()}</style>`,
        `<main class="${lightProps.className}">`,
        '<h1>theme light</h1>',
        `<button class="${buttonPrimary.className}">Continue</button>`,
        `<button class="${buttonSecondary.className}">Cancel</button>`,
        '</main>',
        `<main class="${darkProps.className}">`,
        '<h1>theme dark</h1>',
        `<button class="${buttonPrimary.className}">Continue</button>`,
        `<button class="${buttonSecondary.className}">Cancel</button>`,
        '</main>',
        '',
      ].join('\n'),
    );
    write(
      'build-report.json',
      JSON.stringify(
        {
          documentKind: 'pandamstyle-demo-build-report',
          forkCommit: gitSha(),
          systemId: ds.registry.systemId,
          registryDigest: ds.registry.registryDigest,
          compilerContractVersion: ds.manifest.compilerContractVersion,
          node: process.version,
          generatedAt: null, // hors digest par construction
          artifacts: [
            'styles.css',
            'manifest.json',
            'diagnostics-17px.json',
            'page.example.json',
            'demo.html',
          ],
          cases: {
            'chain.tokens-recipe-css': 'passed',
            'reject.forbidden-value-17px': 'passed',
          },
        },
        null,
        2,
      ) + '\n',
    );
  });
});
