/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-01.1 shared corpus feature collection.
//
// Collects the feature keys used by:
//   - the CE-00.2 corpus reference stylesheets (whole files, every occurrence);
//   - every CE-00.2 corpus declaration and every declaration of both Wacando
//     declaration sets, each rebuilt as one CSS rule from its recorded context;
//   - the CSS the compiler actually emits for the frozen CE-00.3 workloads;
//   - the compiler's intrinsic emission (layer wrappers or specificity ladder).
//
// Requires `yarn build` (it reads the private inspection bundle and the
// public compiler entry from the repository build).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const require = createRequire(import.meta.url);

export function loadInspection() {
  return require(path.join(REPO, '.pms-test-support/compiler-inspection.cjs'));
}

export const CORPUS_ACCOUNTING = path.join(
  REPO,
  'tests/core-evolution/corpus/accounting.v1.json',
);
export const WACANDO_SETS = [
  'tests/core-evolution/corpus/calibration/w-mockup-1559.declarations.v1.json',
  'tests/core-evolution/corpus/calibration/w-util-343.declarations.v1.json',
].map((file) => path.join(REPO, file));
export const EMITTED_WORKLOADS = [
  'alpha1-valid-fixture',
  'ce-corpus',
  'synthetic-c1000-t200-r20-s307',
];

const FUNCTIONAL_ARGUMENT = {
  dir: '(rtl)',
  lang: '(en)',
  'nth-child': '(2n)',
  'nth-last-child': '(2n)',
  'nth-of-type': '(2n)',
  'nth-last-of-type': '(2n)',
};
const SELECTOR_LIST_PSEUDO = new Set(['has', 'is', 'where', 'not']);

/** One CSS rule rebuilt from a recorded declaration and its context. */
export function declarationCss(declaration) {
  const context = declaration.context ?? {};
  const state = context.state ?? {};
  let selector = '.x';
  for (const pseudo of state.pseudoClasses ?? []) {
    const name = pseudo.replace(/^:/, '');
    if (SELECTOR_LIST_PSEUDO.has(name)) selector += `:${name}(.y)`;
    else if (Object.hasOwn(FUNCTIONAL_ARGUMENT, name)) {
      selector += `:${name}${FUNCTIONAL_ARGUMENT[name]}`;
    } else selector += `:${name}`;
  }
  for (const attribute of state.attributes ?? []) selector += `[${attribute}]`;
  for (let i = 0; i < (state.redactedAttributes ?? 0); i += 1) {
    selector += '[data-redacted]';
  }
  const selectors = (state.pseudoElements ?? []).length
    ? state.pseudoElements.map((element) => `${selector}${element}`)
    : [selector];
  const important = declaration.flags?.includes('important-ignored')
    ? ' !important'
    : '';
  const body = `${declaration.property}:${declaration.value}${important}`;
  let css;
  if (context.keyframes) {
    css = `@keyframes k{from{${body}}}`;
  } else if (context.descriptor != null) {
    css = `@${context.descriptor}{${body}}`;
  } else {
    css = `${selectors.join(',')}{${body}}`;
    for (const atRule of [...(context.atRules ?? [])].reverse()) {
      if (atRule.startsWith('@keyframes') || atRule.startsWith('@font-face')) {
        continue;
      }
      css = `${atRule}{${css}}`;
    }
  }
  if (context.layer != null) css = `@layer ${context.layer}{${css}}`;
  return css;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Materializes and compiles a frozen workload; returns its emitted CSS. */
export async function emittedCss(workloadId) {
  const { findWorkload, materialize } = await import(
    pathToFileURL(path.join(REPO, 'tools/baselines/workloads.mjs')).href
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pms-targets-${workloadId}-`));
  try {
    materialize(findWorkload(workloadId), dir);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    const compiler = await import(
      pathToFileURL(path.join(REPO, 'packages/compiler/lib/index.mjs')).href
    );
    const definition = (await import(pathToFileURL(path.join(dir, 'design.mjs')).href))
      .default;
    const outDir = path.join(dir, 'generated');
    const session = compiler.createProjectSession({
      rootDir: dir,
      definition,
      roots: ['src'],
      outDir,
      designSystemFile: 'design.pandamstyle.js',
    });
    try {
      const init = await session.initialize();
      const validation = await session.validate(init.revision);
      if (!validation.ok) {
        return {
          css: null,
          diagnostics: validation.diagnostics ?? [],
        };
      }
      await session.compile(init.revision);
      return {
        css: fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8'),
        diagnostics: validation.diagnostics ?? [],
      };
    } finally {
      await session.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every feature use, attributed. Returns
 * `{ sources: [{ id, group, profileScope, uses: [{ feature, record, attribution, context }] }] }`.
 */
export async function collectFeatureUses({ includeEmitted = true } = {}) {
  const inspection = loadInspection();
  const t = inspection.targets;
  const toUses = (css, attribution, dedupe = true) =>
    t.extractConstructs(css, { dedupe }).flatMap(({ construct, context }) =>
      t.featuresOf(construct).map((record) => ({
        feature: record.feature,
        record,
        attribution,
        context,
      })),
    );
  const sources = [];

  const accounting = readJson(CORPUS_ACCOUNTING);
  for (const sheet of accounting.stylesheets) {
    const css = fs.readFileSync(path.join(REPO, sheet.path), 'utf8');
    sources.push({
      id: `corpus-css:${sheet.path}`,
      group: 'ce-00.2-corpus',
      uses: toUses(css, { stylesheet: sheet.path }, false),
    });
    const uses = [];
    for (const declaration of sheet.declarations) {
      uses.push(
        ...toUses(declarationCss(declaration), {
          declaration: declaration.id,
          denominator: declaration.denominator ?? null,
        }),
      );
    }
    sources.push({ id: `corpus-declarations:${sheet.path}`, group: 'ce-00.2-corpus', uses });
  }

  for (const file of WACANDO_SETS) {
    const set = readJson(file);
    const uses = [];
    for (const declaration of set.declarations) {
      uses.push(
        ...toUses(declarationCss(declaration), {
          declaration: declaration.id,
          denominator: declaration.denominator ?? null,
        }),
      );
    }
    sources.push({ id: `wacando:${set.inputId}`, group: `wacando:${set.inputId}`, uses });
  }

  if (includeEmitted) {
    for (const workloadId of EMITTED_WORKLOADS) {
      const { css, diagnostics } = await emittedCss(workloadId);
      if (css == null) {
        throw new Error(
          `workload ${workloadId} did not compile: ${diagnostics.map((d) => d.code).join(', ')}`,
        );
      }
      sources.push({
        id: `emitted:${workloadId}`,
        group: 'compiler-emitted',
        uses: toUses(css, { workload: workloadId }, false),
      });
    }
  }

  for (const useCSSLayers of [false, true]) {
    sources.push({
      id: `intrinsic:${useCSSLayers ? 'layers' : 'specificity-ladder'}`,
      group: useCSSLayers ? 'intrinsic-layers' : 'intrinsic-default',
      uses: toUses(t.intrinsicCss({ useCSSLayers }), {
        intrinsic: useCSSLayers ? 'useCSSLayers' : 'default',
      }),
    });
  }
  return { sources, inspection };
}
