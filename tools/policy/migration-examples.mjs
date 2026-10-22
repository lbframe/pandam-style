/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.2 (#47) executable migration examples (note AC3, Appendix B).
//
//   node tools/policy/migration-examples.mjs [--alpha1 <closure>] [--ce021 <pack dir>]
//
// Runs every example of
// packages/compiler/__tests__/pandamstyle/fixtures/ce022-migrations/examples.json
// through the public Project Service: its `before` against its baseline
// compiler, its CE-02.2 refusal and its `after` against this workspace's
// built compiler (`yarn build` first).
//
//   --alpha1  an installed Alpha 1 closure, such as `<store>/closure` of the
//             CE-00.3 baseline store (read only); its @pandamstyle tree must
//             equal the alpha1 epoch manifest, or the tool exits 2
//   --ce021   a CE-02.1 candidate pack directory (`archive.mjs candidate-pack
//             --dest <dir>` run at the CE-02.1 head); its candidate.json must
//             name the CE-02.1 commit below, or the tool exits 2
//
// A baseline that is not given is skipped loudly: each of its checks is
// reported with `skipped` and the reason. Prints JSON; exits 1 on any failed
// check, 0 otherwise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileTreeDigest } from '../baselines/archive.mjs';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const EXAMPLES = path.join(
  REPO,
  'packages/compiler/__tests__/pandamstyle/fixtures/ce022-migrations/examples.json',
);
// The CE-02.1 head CE-02.2 is stacked on (#132, round 2).
const CE021_COMMIT = '8d8f3b7847f70602d866d98234c73c4fc5b07402';

const argv = process.argv.slice(2);
const arg = (name) => {
  const index = argv.indexOf(name);
  return index < 0 ? null : argv[index + 1];
};
const libOf = (closure) =>
  path.join(closure, 'node_modules/@pandamstyle/compiler/lib/index.mjs');

function alpha1Lib(closure) {
  if (closure == null) return { skipped: 'no --alpha1 closure given' };
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        REPO,
        'benchmarks/core-evolution/epochs/alpha1/manifest.v1.json',
      ),
      'utf8',
    ),
  );
  const expected = manifest.closure.installedPandamstyle.sha256;
  const actual = fileTreeDigest(
    path.join(closure, 'node_modules/@pandamstyle'),
  ).sha256;
  if (actual !== expected) {
    process.stderr.write(
      `--alpha1 is not the recorded alpha1 closure: @pandamstyle tree ${actual}, manifest ${expected}\n`,
    );
    process.exit(2);
  }
  return { lib: libOf(closure), identity: `alpha1 tree ${actual}` };
}

function ce021Lib(pack) {
  if (pack == null) return { skipped: 'no --ce021 pack directory given' };
  const { commit } = JSON.parse(
    fs.readFileSync(path.join(pack, 'candidate.json'), 'utf8'),
  );
  if (commit !== CE021_COMMIT) {
    process.stderr.write(
      `--ce021 packs ${commit}, not the CE-02.1 head ${CE021_COMMIT}\n`,
    );
    process.exit(2);
  }
  return { lib: libOf(path.join(pack, 'closure')), identity: commit };
}

const record = JSON.parse(fs.readFileSync(EXAMPLES, 'utf8'));
const baselines = {
  alpha1: alpha1Lib(arg('--alpha1') && path.resolve(arg('--alpha1'))),
  ce021: ce021Lib(arg('--ce021') && path.resolve(arg('--ce021'))),
};
const candidate = {
  lib: path.join(REPO, 'packages/compiler/lib/index.mjs'),
  identity: 'workspace build',
};

const pageOf = (calls) =>
  [
    "import { create, token } from '../generated/design.pandamstyle';",
    ...calls.map((call, i) => `export const s${i} = ${call};`),
    '',
  ].join('\n');

const libs = new Map();
async function load(lib) {
  if (!libs.has(lib)) libs.set(lib, await import(pathToFileURL(lib).href));
  return libs.get(lib);
}

/** One project through the Project Service: { ok, diagnostics, css }. */
async function run(lib, { propertyDomains = null, page = [] }) {
  const compiler = await load(lib);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce022-migration-'));
  const definition = {
    ...record.definition,
    ...(propertyDomains == null ? {} : { propertyDomains }),
  };
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/page.js'), pageOf(page));
  const session = compiler.createProjectSession({
    rootDir: root,
    definition,
    roots: ['src'],
    outDir: path.join(root, 'generated'),
    designSystemFile: 'design.pandamstyle.js',
  });
  const diagnosticsOf = (list) =>
    (list ?? []).map((d) => ({
      code: d.code,
      rule: d.rule,
      reason: d.context?.reason ?? null,
      canonical: d.context?.canonical,
      candidates: d.context?.candidates ?? null,
    }));
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    if (validation.ok) await session.compile(init.revision);
    const file = path.join(root, 'generated/styles.css');
    const css = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n')
      : null;
    return {
      ok: validation.ok,
      diagnostics: diagnosticsOf(validation.diagnostics),
      css: validation.ok ? css : null,
    };
  } catch (error) {
    if (!Array.isArray(error.diagnostics)) throw error;
    return {
      ok: false,
      diagnostics: diagnosticsOf(error.diagnostics),
      css: null,
    };
  } finally {
    await session.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The checks of one expectation against one outcome. */
function checksOf(step, expect, outcome, baselineCss) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ step, name, ok, detail });
  if (expect.accepted === true) {
    add('accepted', outcome.ok, outcome.diagnostics);
  }
  if (expect.code != null) {
    const match = outcome.diagnostics.find(
      (d) => d.code === expect.code && d.rule === expect.rule,
    );
    add(
      `refused ${expect.code} / ${expect.rule}`,
      !outcome.ok && match != null,
      outcome.diagnostics,
    );
    if (expect.reason != null) {
      add(`reason ${expect.reason}`, match?.reason === expect.reason, match);
    }
    if (expect.canonical !== undefined) {
      add(
        `canonical ${JSON.stringify(expect.canonical)}`,
        match?.canonical === expect.canonical,
        match,
      );
    }
    if (expect.candidates != null) {
      add(
        `candidates ${expect.candidates.join(', ')}`,
        JSON.stringify(match?.candidates) === JSON.stringify(expect.candidates),
        match?.candidates,
      );
    }
  }
  for (const text of expect.cssContains ?? []) {
    add(
      `css contains ${text}`,
      outcome.css?.includes(text) === true,
      outcome.css,
    );
  }
  for (const text of expect.cssNotContains ?? []) {
    add(
      `css lacks ${text}`,
      outcome.css != null && !outcome.css.includes(text),
      outcome.css,
    );
  }
  if (expect.cssDeclarationUsesToken != null) {
    const { property, tokenValue } = expect.cssDeclarationUsesToken;
    const variable = new RegExp(
      `(--[\\w-]+):${tokenValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[;}]`,
    ).exec(outcome.css ?? '')?.[1];
    add(
      `${property} uses the variable of the ${tokenValue} token`,
      variable != null &&
        outcome.css.includes(`{${property}:var(${variable})}`),
      outcome.css,
    );
  }
  const compare = (name, wanted) => {
    if (baselineCss === undefined) {
      checks.push({ step, name, skipped: 'baseline not run' });
    } else {
      add(
        name,
        outcome.css != null && (outcome.css === baselineCss) === wanted,
        {
          baseline: baselineCss,
          css: outcome.css,
        },
      );
    }
  };
  if (expect.cssEqualsBaseline) compare('css byte-equal to the baseline', true);
  if (expect.cssDiffersFromBaseline)
    compare('css differs from the baseline', false);
  return checks;
}

async function main() {
  const results = [];
  for (const example of record.examples) {
    const baseline = baselines[example.baseline];
    const checks = [];
    let baselineCss;
    if (baseline.skipped != null) {
      checks.push({
        step: 'before',
        name: 'baseline',
        skipped: baseline.skipped,
      });
    } else {
      const before = await run(baseline.lib, example.before);
      checks.push(...checksOf('before', example.before.expect, before));
      baselineCss = before.css ?? undefined;
    }
    const ce022Input = {
      propertyDomains:
        example.ce022.propertyDomains ?? example.before.propertyDomains,
      page: example.ce022.page ?? example.before.page,
    };
    const ce022 = await run(candidate.lib, ce022Input);
    checks.push(...checksOf('ce022', example.ce022.expect, ce022, baselineCss));
    if (example.after != null) {
      const after = await run(candidate.lib, {
        propertyDomains: example.after.propertyDomains ?? null,
        page: example.after.page ?? example.before.page,
      });
      checks.push(
        ...checksOf(
          `after (${example.after.role})`,
          example.after.expect,
          after,
          baselineCss,
        ),
      );
    }
    results.push({
      id: example.id,
      baseline: example.baseline,
      baselineIdentity: baseline.identity ?? null,
      checks,
    });
  }
  const failed = results.flatMap((r) =>
    r.checks.filter((c) => c.ok === false).map((c) => ({ id: r.id, ...c })),
  );
  const skipped = results.flatMap((r) =>
    r.checks
      .filter((c) => c.skipped != null)
      .map((c) => `${r.id} ${c.step}: ${c.skipped}`),
  );
  const passed = results.reduce(
    (n, r) => n + r.checks.filter((c) => c.ok === true).length,
    0,
  );
  process.stdout.write(
    `${JSON.stringify({ examples: results.length, passed, failed: failed.length, skipped, failures: failed, results }, null, 2)}\n`,
  );
  if (skipped.length > 0) {
    process.stderr.write(
      `SKIPPED (baseline not given): ${skipped.join('; ')}\n`,
    );
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
