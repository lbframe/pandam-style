/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// One measurement sample in a fresh Node process:
//
//   node tools/baselines/sample.mjs <spec.json>
//
// The spec names the epoch closure, a prepared project directory and the
// sample kind. The project's node_modules links to the closure, so the
// compiler, runtime and hosts are exactly the epoch's installed packages,
// loaded through their public entry points only. The result is one JSON line
// on stdout. Timings use performance.now() around public API calls and
// include no instrumentation inside the measured packages.
//
// Kinds:
//   compile  cold full compile (initialize + validate + compile) followed by
//            warm incremental edits through applyChanges(), each toggled
//            forward and back so the project ends in its original state;
//            with verifyIncremental, the first forward edit's projections are
//            compared with a fresh full compile of the same state (untimed
//            `consistency` result);
//   runtime  replay of the props() and recipe selections recorded while
//            executing the compiled modules of a compiled project;
//   vite     production `vite build` of a host project through the epoch's
//            @pandamstyle/vite adapter.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const now = () => performance.now();
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
const modules = path.join(spec.project, 'node_modules');
const resolveIn = (specifier) =>
  pathToFileURL(path.join(modules, specifier)).href;

function usage() {
  const u = process.resourceUsage();
  return {
    maxRssBytes: u.maxRSS * 1024,
    userCpuMs: round(u.userCPUTime / 1000),
    systemCpuMs: round(u.systemCPUTime / 1000),
  };
}

// --------------------------------------------------------- output analysis

// Counts style rules and at-rules of emitted CSS with a small scanner that
// skips comments and strings; it does not validate CSS.
export function cssCounts(css) {
  let styleRules = 0;
  let atRules = 0;
  let declarations = 0;
  let prelude = '';
  let depth = 0;
  const stack = [];
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      prelude += css.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '{') {
      const head = prelude.trim();
      const kind = head.startsWith('@') ? 'at' : 'style';
      if (kind === 'at') atRules++;
      else styleRules++;
      stack.push(kind);
      depth++;
      prelude = '';
    } else if (ch === '}') {
      if (stack[stack.length - 1] === 'style' && prelude.trim() !== '')
        declarations++;
      stack.pop();
      depth--;
      prelude = '';
    } else if (ch === ';') {
      if (stack[stack.length - 1] === 'style') declarations++;
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  const classes = new Set(css.match(/\.x[a-z0-9]+/g) ?? []);
  return {
    styleRules,
    atRules,
    declarations,
    distinctClassNames: classes.size,
    balanced: depth === 0,
  };
}

function sizes(buffer) {
  return {
    bytes: buffer.length,
    gzipBytes: zlib.gzipSync(buffer, { level: 9 }).length,
    brotliBytes: zlib.brotliCompressSync(buffer, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).length,
  };
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out.sort();
}

function analyzeOutput(outDir, definition) {
  const css = fs.readFileSync(path.join(outDir, 'styles.css'));
  const designModule = fs.readFileSync(path.join(outDir, spec.designModule));
  const declarationsFile = path.join(
    outDir,
    spec.designModule.replace(/\.js$/, '.d.ts'),
  );
  const declarationsBytes = fs.existsSync(declarationsFile)
    ? fs.statSync(declarationsFile).size
    : null;
  const compiled = walkFiles(path.join(outDir, 'js'));
  const compiledBytes = compiled.reduce((n, f) => n + fs.statSync(f).size, 0);
  const compiledDigest = sha256(
    compiled
      .map((f) => `${path.relative(outDir, f)} ${sha256(fs.readFileSync(f))}`)
      .join('\n'),
  );
  const report = JSON.parse(
    fs.readFileSync(path.join(outDir, 'build-report.json'), 'utf8'),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
  );
  let recipeSelections = 0;
  let recipeAxisValues = 0;
  for (const recipe of Object.values(manifest.recipes ?? {})) {
    const axes = Object.values(recipe.axes ?? {});
    recipeAxisValues += axes.reduce((n, values) => n + values.length, 0);
    recipeSelections += axes.reduce((n, values) => n * values.length, 1);
  }
  let compoundVariants = 0;
  for (const recipe of Object.values(definition.recipes ?? {}))
    compoundVariants += (recipe.compoundVariants ?? []).length;
  const metaFiles = ['artifacts.json', 'manifest.json', 'build-report.json'];
  return {
    css: {
      ...sizes(css),
      sha256: sha256(css),
      ...cssCounts(css.toString('utf8')),
    },
    designModule: { ...sizes(designModule), sha256: sha256(designModule) },
    declarationsBytes,
    compiledModules: {
      count: compiled.length,
      bytes: compiledBytes,
      sha256: compiledDigest,
    },
    metadataBytes: Object.fromEntries(
      metaFiles.map((f) => [
        f,
        fs.existsSync(path.join(outDir, f))
          ? fs.statSync(path.join(outDir, f)).size
          : null,
      ]),
    ),
    report: {
      ruleCount: report.ruleCount,
      designSystemRuleCount: report.designSystemRuleCount,
      consumerRuleCount: report.consumerRuleCount,
      cssBytes: report.cssBytes,
      coveredFileCount: report.coveredFileCount,
      analysedFileCount: report.analysedFileCount,
    },
    variants: {
      recipes: Object.keys(manifest.recipes ?? {}).length,
      recipeAxisValues,
      recipeSelections,
      compoundVariants,
      themes: Object.keys(manifest.themes ?? {}).length,
      conditions: Object.keys(manifest.conditions ?? {}).length,
      tokens: Object.keys(manifest.tokens ?? {}).length,
    },
  };
}

// ------------------------------------------------------------ edit helpers

function setPath(object, keys, value) {
  let cursor = object;
  for (const key of keys.slice(0, -1)) cursor = cursor[key];
  cursor[keys.at(-1)] = value;
}

// Copies plain objects and arrays of a definition. Token references are
// frozen marker objects with a private key; they are immutable, so they are
// shared rather than copied.
function cloneDefinition(value) {
  if (Array.isArray(value)) return value.map(cloneDefinition);
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneDefinition(v)]),
    );
  return value;
}

// ------------------------------------------------------------------ compile

// Digests of every generated projection: CSS, design-system module and its
// declarations, compiled modules (by path relative to the output root), the
// manifest and the artifact metadata.
function projectionDigests(outDir) {
  const digest = (file) =>
    fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
  const compiled = walkFiles(path.join(outDir, 'js'));
  return {
    css: digest(path.join(outDir, 'styles.css')),
    designModule: digest(path.join(outDir, spec.designModule)),
    declarations: digest(
      path.join(outDir, spec.designModule.replace(/\.js$/, '.d.ts')),
    ),
    manifest: digest(path.join(outDir, 'manifest.json')),
    artifacts: digest(path.join(outDir, 'artifacts.json')),
    compiledModules: sha256(
      compiled
        .map((f) => `${path.relative(outDir, f)} ${sha256(fs.readFileSync(f))}`)
        .join('\n'),
    ),
  };
}

// Compiles the current project state in a fresh session, in a copy of the
// project without its generated output, and compares every projection with
// the incremental output. The copy keeps relative imports of the generated
// module identical.
async function compareWithCanonical(compiler, definition, outDir) {
  const copy = `${spec.project}-canonical`;
  fs.rmSync(copy, { recursive: true, force: true });
  fs.mkdirSync(copy);
  for (const entry of fs.readdirSync(spec.project)) {
    if (entry === spec.outDir) continue;
    const source = path.join(spec.project, entry);
    if (entry === 'node_modules')
      fs.symlinkSync(fs.readlinkSync(source), path.join(copy, entry));
    else fs.cpSync(source, path.join(copy, entry), { recursive: true });
  }
  const canonicalDir = path.join(copy, spec.outDir);
  const session = compiler.createProjectSession({
    rootDir: copy,
    definition,
    roots: ['src'],
    outDir: canonicalDir,
    designSystemFile: spec.designModule,
  });
  let failure = null;
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    if (validation.ok) await session.compile(init.revision);
    else failure = (validation.diagnostics ?? []).map((d) => d.code).join(', ');
  } finally {
    await session.close();
  }
  const incremental = projectionDigests(outDir);
  const full = failure == null ? projectionDigests(canonicalDir) : null;
  fs.rmSync(copy, { recursive: true, force: true });
  if (failure != null)
    return { error: `canonical validation failed: ${failure}` };
  const equal = Object.fromEntries(
    Object.keys(full).map((k) => [k, incremental[k] === full[k]]),
  );
  return { equal, incremental, canonical: full };
}

async function compileSample() {
  const tImport = now();
  const compiler = await import(
    resolveIn('@pandamstyle/compiler/lib/index.mjs')
  );
  const config = await import(
    resolveIn('@pandamstyle/compiler/lib/config.mjs')
  );
  const importMs = now() - tImport;
  const definitionUrl = pathToFileURL(
    path.join(spec.project, 'design.mjs'),
  ).href;
  const definition = (await import(definitionUrl)).default;
  const outDir = path.join(spec.project, spec.outDir);
  const session = compiler.createProjectSession({
    rootDir: spec.project,
    definition,
    roots: ['src'],
    outDir,
    designSystemFile: spec.designModule,
  });
  const result = { kind: 'compile', importMs: round(importMs) };
  try {
    const t0 = now();
    const init = await session.initialize();
    const t1 = now();
    const validation = await session.validate(init.revision);
    const t2 = now();
    if (!validation.ok)
      throw new Error(
        `full validation failed: ${(validation.diagnostics ?? []).map((d) => d.code).join(', ')}`,
      );
    await session.compile(init.revision);
    const t3 = now();
    result.full = {
      initializeMs: round(t1 - t0),
      validateMs: round(t2 - t1),
      compileMs: round(t3 - t2),
      toDiagnosticsMs: round(t2 - t0),
      totalMs: round(t3 - t0),
    };
    result.afterFull = usage();
    result.output = analyzeOutput(outDir, definition);

    let revision = init.revision;
    let current = definition;
    const canonical = [];
    result.incremental = [];
    for (const edit of spec.edits ?? []) {
      const iterations = [];
      for (let k = 0; k < spec.incrementalIterations; k++) {
        const forward = k % 2 === 0;
        const transaction = {
          baseRevision: revision,
          mode: 'verified-explicit',
          changed: [],
          added: [],
          removed: [],
          renamed: [],
        };
        if (edit.kind === 'source') {
          const file = path.join(spec.project, edit.file);
          const text = fs.readFileSync(file, 'utf8');
          const [from, to] = forward
            ? [edit.from, edit.to]
            : [edit.to, edit.from];
          if (!text.includes(from))
            throw new Error(`edit ${edit.id}: ${from} not found`);
          fs.writeFileSync(file, text.replace(from, to));
          transaction.changed = [edit.file];
        } else if (edit.kind === 'definition') {
          // Forward sets the edit's value; back restores the original node.
          const next = cloneDefinition(current);
          const original = edit.path.reduce(
            (node, key) => node[key],
            definition,
          );
          const value = edit.token ? config.token(edit.to) : edit.to;
          setPath(next, edit.path, forward ? value : original);
          transaction.definition = next;
          current = next;
        } else {
          throw new Error(`unknown edit kind ${edit.kind}`);
        }
        const a = now();
        const applied = await session.applyChanges(transaction);
        const b = now();
        const checked = await session.validate(applied.revision);
        const c = now();
        if (!checked.ok)
          throw new Error(
            `edit ${edit.id} iteration ${k}: ${(checked.diagnostics ?? []).map((d) => d.code).join(', ')}`,
          );
        await session.compile(applied.revision);
        const d = now();
        revision = applied.revision;
        if (spec.verifyIncremental && k === 0)
          canonical.push({
            id: edit.id,
            ...(await compareWithCanonical(compiler, current, outDir)),
          });
        iterations.push({
          iteration: k,
          direction: forward ? 'forward' : 'back',
          applyMs: round(b - a),
          validateMs: round(c - b),
          compileMs: round(d - c),
          toDiagnosticsMs: round(c - a),
          totalMs: round(d - a),
        });
      }
      const css = fs.readFileSync(path.join(outDir, 'styles.css'));
      result.incremental.push({
        id: edit.id,
        iterations,
        restoredCssSha256: sha256(css),
      });
    }
    if (spec.verifyIncremental) {
      result.kind = 'consistency';
      result.canonical = canonical;
    }
    result.restoredToFullOutput =
      (spec.edits ?? []).length === 0 ||
      result.incremental.every(
        (e) => e.restoredCssSha256 === result.output.css.sha256,
      );
  } finally {
    await session.close();
  }
  result.final = usage();
  return result;
}

// ------------------------------------------------------------------ runtime

// Rewrites each compiled module to import recording shims of the runtime
// props() and of the generated recipes, runs every module (and every exported
// function with a fixed set of arguments) once to record the selections, then
// replays them against the unwrapped runtime.
async function runtimeSample() {
  const outDir = path.join(spec.project, spec.outDir);
  const rt = path.join(spec.project, `.runtime-${process.pid}`);
  fs.rmSync(rt, { recursive: true, force: true });
  fs.mkdirSync(rt, { recursive: true });
  const designUrl = pathToFileURL(path.join(outDir, spec.designModule)).href;
  fs.writeFileSync(
    path.join(rt, 'shim-core.mjs'),
    "import { props as real } from '@pandamstyle/core';\n" +
      "export * from '@pandamstyle/core';\n" +
      'export const calls = [];\n' +
      'export const state = { recording: true };\n' +
      'export function props(...args) { if (state.recording) calls.push(args); return real(...args); }\n',
  );
  fs.writeFileSync(
    path.join(rt, 'shim-design.mjs'),
    `import * as d from ${JSON.stringify(designUrl)};\n` +
      `export * from ${JSON.stringify(designUrl)};\n` +
      "import { state } from './shim-core.mjs';\n" +
      'export const selections = [];\n' +
      'export const recipes = Object.fromEntries(Object.entries(d.recipes).map(([id, select]) => [id, Object.assign((selection) => { if (state.recording) selections.push([id, selection]); return select(selection); }, select)]));\n',
  );
  const compiled = walkFiles(path.join(outDir, 'js'));
  const entries = [];
  for (const file of compiled) {
    const rel = path.relative(path.join(outDir, 'js'), file);
    let text = fs.readFileSync(file, 'utf8');
    text = text.replace(/from "@pandamstyle\/core"/g, "from '__CORE__'");
    text = text.replace(
      /from '((?:\.\.\/)+)generated\/design\.pandamstyle(?:\.js)?'/g,
      "from '__DESIGN__'",
    );
    const target = path.join(rt, rel.replace(/\.(jsx|tsx|ts|js)$/, '.mjs'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const relShim = (name) => {
      const r = path
        .relative(path.dirname(target), path.join(rt, name))
        .split(path.sep)
        .join('/');
      return r.startsWith('.') ? r : `./${r}`;
    };
    text = text
      .replace(/'__CORE__'/g, `'${relShim('shim-core.mjs')}'`)
      .replace(/'__DESIGN__'/g, `'${relShim('shim-design.mjs')}'`);
    fs.writeFileSync(target, text);
    entries.push(target);
  }
  const core = await import(pathToFileURL(path.join(rt, 'shim-core.mjs')).href);
  const design = await import(
    pathToFileURL(path.join(rt, 'shim-design.mjs')).href
  );
  const { props } = await import(resolveIn('@pandamstyle/core/src/index.js'));
  const realRecipes = (await import(designUrl)).recipes;
  const argumentSets = spec.runtimeArguments ?? [{}];
  const tLoad = now();
  const functions = [];
  for (const entry of entries) {
    const module = await import(pathToFileURL(entry).href);
    for (const value of Object.values(module))
      if (typeof value === 'function') functions.push(value);
  }
  const loadMs = now() - tLoad;
  let renderErrors = 0;
  const renders = [];
  for (const fn of functions)
    for (const args of argumentSets) {
      try {
        fn(args);
        renders.push([fn, args]);
      } catch {
        renderErrors++;
      }
    }
  core.state.recording = false;
  // Keep only replayable calls (a recorded call the runtime rejects is a
  // provenance check the compiled module guards, not a selection).
  const propCalls = core.calls.filter((args) => {
    try {
      props(...args);
      return true;
    } catch {
      return false;
    }
  });
  const selections = design.selections.filter(([id, selection]) => {
    try {
      realRecipes[id](selection);
      return true;
    } catch {
      return false;
    }
  });
  const measure = (fn, count) => {
    if (count === 0) return null;
    for (let w = 0; w < spec.runtimeWarmupRounds; w++) fn();
    let calls = 0;
    const start = now();
    let elapsed = 0;
    while (elapsed < spec.runtimeBudgetMs) {
      fn();
      calls += count;
      elapsed = now() - start;
    }
    return round((elapsed * 1e6) / calls, 1);
  };
  let sink = 0;
  const result = {
    kind: 'runtime',
    modules: entries.length,
    moduleLoadMs: round(loadMs),
    recordedPropsCalls: propCalls.length,
    rejectedPropsCalls: core.calls.length - propCalls.length,
    recordedRecipeSelections: selections.length,
    renders: renders.length,
    renderErrors,
    propsNsPerCall: measure(() => {
      for (const args of propCalls)
        sink += props(...args).className?.length ?? 0;
    }, propCalls.length),
    recipeSelectNsPerCall: measure(() => {
      for (const [id, selection] of selections)
        sink += realRecipes[id](selection).entries?.length ?? 1;
    }, selections.length),
    renderNsPerCall: measure(() => {
      for (const [fn, args] of renders) sink += fn(args) == null ? 0 : 1;
    }, renders.length),
  };
  result.sink = sink > 0;
  result.final = usage();
  fs.rmSync(rt, { recursive: true, force: true });
  return result;
}

// --------------------------------------------------------------------- vite

async function viteSample() {
  const tImport = now();
  const vite = await import(resolveIn('vite/dist/node/index.js'));
  const importMs = now() - tImport;
  const dist = path.join(spec.project, 'dist');
  const t0 = now();
  await vite.build({
    root: spec.project,
    configFile: path.join(spec.project, 'vite.config.js'),
    logLevel: 'silent',
    build: { outDir: dist, emptyOutDir: true },
  });
  const totalMs = now() - t0;
  const files = walkFiles(dist);
  const sum = (filter) => {
    const chosen = files.filter(filter).map((f) => fs.readFileSync(f));
    const all = Buffer.concat(chosen);
    return { files: chosen.length, ...sizes(all) };
  };
  return {
    kind: 'vite',
    importMs: round(importMs),
    buildMs: round(totalMs),
    css: sum((f) => f.endsWith('.css')),
    js: sum((f) => f.endsWith('.js')),
    distSha256: sha256(
      files
        .map((f) => `${path.relative(dist, f)} ${sha256(fs.readFileSync(f))}`)
        .join('\n'),
    ),
    final: usage(),
  };
}

const runners = {
  compile: compileSample,
  consistency: compileSample,
  runtime: runtimeSample,
  vite: viteSample,
};
const started = now();
runners[spec.kind]()
  .then((result) => {
    result.wallMs = round(now() - started);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  })
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: String(error?.stack ?? error) })}\n`,
    );
    process.exitCode = 1;
  });
