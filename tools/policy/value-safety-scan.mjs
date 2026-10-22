/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-02.2 (#47) PR B: the scan that froze APPROVED_FUNCTIONS
// (packages/compiler/src/design-system/policy/value-safety.js).
//
//   node tools/policy/value-safety-scan.mjs
//
// Run after `yarn build`. It runs S1 over every author text of every design
// system it can import from the repository: the frozen CE-00.3 workloads
// (materialized, digest-checked; `ce-corpus` holds the CE-00.2 corpus
// tokens), the compiler test fixtures, the examples and the agentic
// benchmark fixtures (read only). Author texts are token values, theme
// override values and condition definitions. It reports the functions each
// kind uses and every refusal; a refusal is a compatibility delta, never a
// reason to extend the list. Design systems defined inline in test files are
// covered by the compiler suite itself.
//
//   node tools/policy/value-safety-scan.mjs --emitted
//
// also compiles each workload through the built Project Service and runs S2
// on what it emits: every rule of styles.css, read alone and inside the
// whole sheet, must re-read as the same prelude and declarations, with one
// declaration per property. It counts the S1 refusals the validation raises
// (raw condition keys). Prints JSON; exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadWorkloads, materialize } from '../baselines/workloads.mjs';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname);
const require = createRequire(import.meta.url);
const { unsafeValueClass } = require(
  path.join(REPO, '.pms-test-support/compiler-inspection.cjs'),
);
const { tokenize } = require('@csstools/css-tokenizer');
const { readCss } = require(path.join(REPO, 'tests/support/css-reread.cjs'));
const EMITTED = process.argv.includes('--emitted');

async function emitted(project, definition) {
  const lib = await import(
    pathToFileURL(path.join(REPO, 'packages/compiler/lib/index.mjs')).href
  );
  const session = lib.createProjectSession({
    rootDir: project,
    definition,
    roots: ['src'],
    outDir: path.join(project, 'generated'),
    designSystemFile: 'design.pandamstyle.js',
  });
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    const valueSafety = (validation.diagnostics ?? []).filter((d) =>
      String(d.rule).startsWith('value-safety.'),
    ).length;
    if (!validation.ok) return { ok: false, valueSafety };
    await session.compile(init.revision);
    const css = fs.readFileSync(
      path.join(project, 'generated/styles.css'),
      'utf8',
    );
    // The first line is the identity header comment; one rule per line.
    const lines = css
      .split('\n')
      .slice(1)
      .filter((line) => line !== '');
    const alone = lines.flatMap((line) => readCss(line));
    const together = readCss(lines.join('\n'));
    const duplicates = together.filter((rule) => {
      const names = rule.declarations.map(([name]) => name);
      return names.length !== new Set(names).size;
    }).length;
    return {
      ok: true,
      valueSafety,
      rules: lines.length,
      declarations: together.reduce((n, r) => n + r.declarations.length, 0),
      rereadEqual: JSON.stringify(alone) === JSON.stringify(together),
      duplicates,
    };
  } finally {
    await session.close?.();
  }
}
const emittedReport = {};

const DEFINITION_FILE =
  /^design(\.pandamstyle|\.pms)?\.config\.m?js$|^design\.mjs$/;
const SEARCHED = [
  'packages/compiler/__tests__/pandamstyle/fixtures',
  'examples',
  'benchmarks/agentic/fixtures',
  'benchmarks/agentic/tasks',
];

function definitionFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (DEFINITION_FILE.test(entry.name)) out.push(file);
    }
  };
  for (const dir of SEARCHED) walk(path.join(REPO, dir));
  return out;
}

/** Every author text of a definition: [kind, where, text]. */
function authorTexts(definition) {
  const texts = [];
  const tokens = (node, where) => {
    for (const [key, entry] of Object.entries(node ?? {})) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.value === 'string' || typeof entry.value === 'number') {
        texts.push(['value', `${where}.${key}`, entry.value]);
      } else if (entry.ref == null) {
        tokens(entry, `${where}.${key}`);
      }
    }
  };
  tokens(definition.tokens, 'tokens');
  for (const [name, theme] of Object.entries(definition.themes ?? {})) {
    tokens(theme?.tokens, `themes.${name}`);
  }
  for (const [name, condition] of Object.entries(definition.conditions ?? {})) {
    const text =
      typeof condition === 'string'
        ? condition
        : (condition?.selector ?? condition?.atRule);
    if (typeof text === 'string') {
      texts.push(['condition', `conditions.${name}`, text]);
    }
  }
  return texts;
}

const functions = { value: {}, condition: {} };
const refusals = [];
let scanned = 0;
let systems = 0;

function scan(source, definition) {
  systems += 1;
  for (const [kind, where, text] of authorTexts(definition)) {
    scanned += 1;
    if (typeof text === 'string') {
      for (const token of tokenize({ css: text })) {
        if (token[0] === 'function-token') {
          const name = String(token[4].value).toLowerCase();
          functions[kind][name] = (functions[kind][name] ?? 0) + 1;
        }
      }
    }
    const unsafe = unsafeValueClass(text, kind);
    if (unsafe != null) {
      refusals.push({ source, where, kind, text: String(text), ...unsafe });
    }
  }
}

async function main() {
  const scratch = fs.mkdtempSync(
    path.join(REPO, 'out-pandamstyle', 'ce022-value-safety-scan-'),
  );
  try {
    for (const workload of loadWorkloads().workloads) {
      const project = path.join(scratch, workload.id);
      materialize(workload, project);
      const definition = (
        await import(pathToFileURL(path.join(project, 'design.mjs')).href)
      ).default;
      scan(`workload:${workload.id}`, definition);
      if (EMITTED)
        emittedReport[workload.id] = await emitted(project, definition);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const unimportable = [];
  for (const file of definitionFiles()) {
    const source = path.relative(REPO, file);
    let definition;
    try {
      const module = await import(pathToFileURL(file).href);
      definition = module.default ?? Object.values(module)[0];
    } catch (error) {
      unimportable.push({ source, error: String(error.message).slice(0, 160) });
      continue;
    }
    if (definition == null || typeof definition !== 'object') continue;
    scan(source, definition);
  }
  const sorted = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  process.stdout.write(
    `${JSON.stringify(
      {
        systems,
        texts: scanned,
        functions: {
          value: sorted(functions.value),
          condition: sorted(functions.condition),
        },
        refusals,
        unimportable,
        ...(EMITTED ? { emitted: emittedReport } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
