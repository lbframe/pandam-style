/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Executes the CE-00.2 negative fixtures against the built Alpha 1 compiler
// and asserts the observed outcome recorded in corpus.v1.json:
//
//   yarn workspace @pandamstyle/compiler run build
//   node tests/core-evolution/run-negatives.mjs [--report <file>]
//
// Each fixture gets a fresh project in the system temporary directory. The
// design-system module is generated first through the public Project Service
// (createProjectSession), then the fixture source is added and validated with
// a new session. Accepted sources are compiled and their emitted CSS is kept
// for inspection. A fixture with a second system also gets that system's
// generated module and a runtime probe: compiled references of both systems
// are composed with the runtime props(). The runner records what Alpha 1 does;
// the intended rejection after every lot is a separate field.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const COMPILER = path.join(repo, 'packages/compiler/lib/index.mjs');
const CORE = path.join(repo, 'packages/core/src/index.js');
const TOKEN_REF = path.join(
  repo,
  'packages/compiler/src/design-system/tokens/ref.js',
);
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function loadDefinition(file) {
  const text = fs.readFileSync(path.join(repo, file), 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);
  // The conformance fixture imports token() from compiler source by a path
  // relative to its own directory; rebind it to an absolute file URL.
  const rebound = text.replace(
    /from '(\.\.\/)+packages\/compiler\/src\/design-system\/tokens\/ref'/,
    `from ${JSON.stringify(pathToFileURL(TOKEN_REF).href)}`,
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(rebound).toString('base64')}`
  );
  return Object.values(module).find((v) => v && typeof v === 'object');
}

function writeFiles(rootDir, files) {
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(rootDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}

// One validation (and, when clean, compilation) through a fresh session.
async function compileProject(compiler, config, files) {
  writeFiles(config.rootDir, files);
  const session = compiler.createProjectSession(config);
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    const errors = (validation.diagnostics ?? []).filter(
      (d) => d.severity === 'error',
    );
    if (errors.length > 0) return { errors, css: null };
    await session.compile(init.revision);
    const css = fs.readFileSync(path.join(config.outDir, 'styles.css'), 'utf8');
    return { errors: [], css };
  } finally {
    await session.close();
  }
}

function projectConfig(rootDir, definition, file) {
  return {
    rootDir,
    definition,
    roots: ['src'],
    outDir: path.join(rootDir, 'src/.pandamstyle'),
    designSystemFile: file,
  };
}

async function generate(compiler, rootDir, definition, file) {
  const result = await compileProject(
    compiler,
    projectConfig(rootDir, definition, file),
    { 'src/empty.js': 'export {};\n' },
  );
  if (result.errors.length > 0)
    throw new Error(
      `cannot generate ${file}: ${result.errors.map((d) => d.code).join(', ')}`,
    );
}

async function runtimeProbe(compiler, rootDir, primary, second) {
  const source = (file) =>
    `import { create, token } from './.pandamstyle/${file}';\n` +
    "export const styles = create({ box: { padding: token('spacing.md') } });\n";
  const refs = [];
  for (const [dir, definition, file] of [
    [path.join(rootDir, 'probe-primary'), primary, 'primary.pandamstyle.js'],
    [path.join(rootDir, 'probe-second'), second, 'second.pandamstyle.js'],
  ]) {
    await generate(compiler, dir, definition, file);
    const result = await compileProject(
      compiler,
      projectConfig(dir, definition, file),
      { 'src/box.js': source(file) },
    );
    if (result.errors.length > 0)
      throw new Error(`runtime probe source rejected in ${file}`);
    const compiled = fs.readFileSync(
      path.join(dir, 'src/.pandamstyle/js/src/box.js'),
      'utf8',
    );
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
    );
    refs.push(module.styles.box);
  }
  const { props } = await import(pathToFileURL(CORE).href);
  try {
    props(refs[0], refs[1]);
    return { outcome: 'runtime-accepted' };
  } catch (error) {
    return {
      outcome: 'runtime-rejected',
      code: error.code,
      rule: error.rule,
      phase: error.phase,
    };
  }
}

export async function runNegative(compiler, fixture) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce002-negative-'));
  try {
    const definition = await loadDefinition(fixture.definition.path);
    const primaryFile = 'conformance.pandamstyle.js';
    await generate(compiler, rootDir, definition, primaryFile);
    let second = null;
    if (fixture.secondSystem) {
      second = await loadDefinition(fixture.secondSystem.definition.path);
      await generate(
        compiler,
        path.join(rootDir, fixture.secondSystem.projectDir),
        second,
        fixture.secondSystem.designSystemFile,
      );
    }
    const result = await compileProject(
      compiler,
      projectConfig(rootDir, definition, primaryFile),
      { [`src/case.${fixture.sourceExtension}`]: fixture.source },
    );
    const observed =
      result.errors.length > 0
        ? {
            outcome: 'compiler-rejected',
            phase: result.errors[0].phase,
            codes: result.errors.map((d) => d.code),
            rule: result.errors[0].rule,
          }
        : {
            outcome: 'compiler-accepted',
            phase: null,
            codes: [],
            rule: null,
            emittedCssSha256: sha256(result.css),
            emittedCss: result.css,
          };
    if (second)
      observed.runtimeProbe = await runtimeProbe(
        compiler,
        rootDir,
        definition,
        second,
      );
    return observed;
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

// Compares an observation with the recorded Alpha 1 baseline.
export function compareObservation(fixture, observed) {
  const want = fixture.expected.observedAlpha1;
  const problems = [];
  for (const key of ['outcome', 'phase', 'rule'])
    if (observed[key] !== want[key])
      problems.push(`${key}: recorded ${want[key]}, observed ${observed[key]}`);
  if (JSON.stringify(observed.codes) !== JSON.stringify(want.codes))
    problems.push(
      `codes: recorded ${want.codes.join(',')}, observed ${observed.codes.join(',')}`,
    );
  if (want.emittedCssContains != null) {
    for (const needle of want.emittedCssContains)
      if (!observed.emittedCss?.includes(needle))
        problems.push(`emitted CSS lacks ${needle}`);
  }
  if (want.runtimeProbe != null) {
    for (const key of ['outcome', 'code', 'rule', 'phase'])
      if (observed.runtimeProbe?.[key] !== want.runtimeProbe[key])
        problems.push(
          `runtimeProbe.${key}: recorded ${want.runtimeProbe[key]}, observed ${observed.runtimeProbe?.[key]}`,
        );
  }
  return problems;
}

async function main() {
  if (!fs.existsSync(COMPILER)) {
    console.error(
      'Build the compiler first: yarn workspace @pandamstyle/compiler run build',
    );
    process.exit(2);
  }
  const compiler = await import(pathToFileURL(COMPILER).href);
  const corpus = JSON.parse(
    fs.readFileSync(
      path.join(repo, 'tests/core-evolution/corpus/corpus.v1.json'),
      'utf8',
    ),
  );
  const rows = [];
  let failed = 0;
  for (const fixture of corpus.negativeFixtures) {
    let observed;
    let problems;
    try {
      observed = await runNegative(compiler, fixture);
      problems = compareObservation(fixture, observed);
    } catch (error) {
      observed = { outcome: 'runner-error', codes: [], error: error.message };
      problems = [error.message];
    }
    if (problems.length > 0) failed += 1;
    const { emittedCss: _css, ...printable } = observed;
    rows.push({
      id: fixture.id,
      intended: fixture.expected.intended.outcome,
      observed: printable,
      pass: problems.length === 0,
      problems,
    });
    console.log(
      `${problems.length === 0 ? 'PASS' : 'FAIL'}  ${fixture.id}  intended ${fixture.expected.intended.outcome}; ` +
        `observed ${observed.outcome} ${observed.codes.join(',') || '-'} ${observed.phase ?? '-'}/${observed.rule ?? '-'}` +
        (observed.runtimeProbe
          ? `; runtime probe ${observed.runtimeProbe.outcome} ${observed.runtimeProbe.code ?? ''} ${observed.runtimeProbe.rule ?? ''}`
          : '') +
        (problems.length ? `\n      ${problems.join('\n      ')}` : ''),
    );
  }
  const reportIndex = process.argv.indexOf('--report');
  if (reportIndex > 0)
    fs.writeFileSync(
      process.argv[reportIndex + 1],
      `${JSON.stringify({ compiler: '@pandamstyle/compiler (workspace build)', node: process.version, rows }, null, 2)}\n`,
    );
  console.log(
    `${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed}/${rows.length} negative fixtures match their recorded Alpha 1 observation`,
  );
  if (failed > 0) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
