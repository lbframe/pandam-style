#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Dedicated profiling runs.
 *
 * PROFILING IS NOT MEASUREMENT
 *
 * A sampling profiler and a V8 CPU profile both perturb what they observe, and
 * a profiler attached during the latency campaign would make every number in it
 * wrong. So profiling runs here are SEPARATE invocations, on separate corpora
 * from the same generator, and their output is evidence about where time goes
 * rather than a latency measurement. Nothing in a profile is reported as a
 * benchmark result, and no profile is taken while the campaign is running.
 *
 * Usage:
 *   node profile.js --corpus c100-t100-r10 --out <dir> [--engines both]
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = __dirname;
const { generate, MANIFEST_NAME } = require(
  path.join(SRC, 'generate-corpus.js'),
);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const eq = argv[i].indexOf('=');
    if (eq !== -1) out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1);
    else {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  for (const k of ['components', 'tokens', 'recipes', 'seed', 'fanout']) {
    if (out[k] != null) out[k] = Number(out[k]);
  }
  return out;
}

/**
 * A tiny driver that runs ONE build under the V8 CPU profiler.
 *
 * It is deliberately separate from `worker.js`: worker.js exists to produce
 * timed observations, and adding a profiler to it would put a profiler inside
 * every campaign number.
 */
const PROFILE_DRIVER = `
'use strict';
const inspector = require('node:inspector');
const fs = require('node:fs');
const path = require('node:path');

const job = JSON.parse(process.argv[2]);
const engine = require(job.engineModulePath);
engine.setPerfEngineName(job.engine);

const projectDir = job.projectDir;
const configPath = path.join(projectDir, 'pandamstyle.config.js');
const config = require(configPath);
const definitionPath = path.resolve(path.dirname(configPath), config.definition);

const session = new inspector.Session();
session.connect();
session.post('Profiler.enable');
session.post('Profiler.setSamplingInterval', { interval: job.sampleIntervalMicros });
session.post('Profiler.start');

const definition = require(definitionPath).default;
const result = engine.buildProject({
  definition,
  roots: (config.roots ?? []).map((r) =>
    path.isAbsolute(r) ? r : path.join(projectDir, r),
  ),
  outDir: path.resolve(path.join(projectDir, config.outDir ?? '.pandamstyle')),
  runtimeModule: config.runtimeModule,
  designSystemFile: config.designSystemFile,
  engineOptions: config.engineOptions,
  useCSSLayers: config.useCSSLayers === true,
});

session.post('Profiler.stop', (err, { profile }) => {
  if (err) throw err;
  fs.writeFileSync(job.profileOut, JSON.stringify(profile));
});
fs.writeFileSync(job.statsOut, JSON.stringify({
  registryDigest: result.registryDigest,
  coveredFileCount: result.coverage.length,
  cssBytes: result.buildReport.cssBytes,
}, null, 2));
process.exit(0);
`;

function materialise(sourceDir, projectDir) {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const walk = (dir, base = sourceDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep)[0] === 'node_modules') continue;
      if (rel.split(path.sep)[0].startsWith('.pandamstyle')) continue;
      if (e.isDirectory()) walk(abs, base);
      else {
        fs.mkdirSync(path.dirname(path.join(projectDir, rel)), {
          recursive: true,
        });
        fs.copyFileSync(abs, path.join(projectDir, rel));
      }
    }
  };
  walk(sourceDir);
}

/**
 * The generated design system imports `@pandamstyle/compiler`, so the package
 * has to be resolvable from the project. The link points at the ENGINE's own
 * package, so the definition is loaded by the same code that compiles it.
 */
function linkCompiler(projectDir, engineRoot) {
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (fs.existsSync(link)) fs.rmSync(link, { force: true });
  fs.symlinkSync(
    path.join(engineRoot, 'packages', '@pandamstyle', 'compiler'),
    link,
    'dir',
  );
}

/**
 * A flat self-time table from a V8 CPU profile.
 *
 * The V8 profile is a TREE of call frames with hit counts. The useful question
 * is "where did the samples land", so nodes are aggregated by function and the
 * tree is flattened. `url` is kept: a self-time table without a file is a list
 * of function names and nothing else.
 */
/**
 * A V8 CPU profile is a TREE whose `children` are node IDs, not nodes. A
 * single-pass recursion that treats them as nodes walks nothing, and the result
 * is an empty table that looks like "no time was spent anywhere".
 */
function indexNodes(profile) {
  const byId = new Map();
  for (const node of profile.nodes ?? []) byId.set(node.id, node);
  return byId;
}

function selfTimeTable(profile, topN = 40) {
  const byId = indexNodes(profile);

  const self = new Map();
  for (const id of profile.samples ?? []) {
    const node = byId.get(id);
    if (node == null) continue;
    const f = node.callFrame;
    const url = f.url || '(native)';
    // The corpus path is stripped so two runs at different scratch paths
    // aggregate together.
    const clean = url.replace(/^file:\/\//, '');
    const key = `${f.functionName || '(anonymous)'} @ ${clean}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + 1);
  }
  const total = (profile.samples ?? []).length;
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([frame, hits]) => ({
      frame,
      samples: hits,
      self_pct: total === 0 ? 0 : (hits / total) * 100,
    }));
}

/**
 * Names a function inside a rollup BUNDLE.
 *
 * The published compiler is a single generated `lib/index.js`, so every
 * internal function is anonymous and a profile frame identifies it only by line
 * number. A line number is not a finding. This walks BACKWARD from the frame's
 * line to the nearest function declaration and recovers its name, so the profile
 * says `resolveRelativeFile` rather than `index.js:9386`.
 *
 * A miss is a miss, not a guess: when no declaration is found the frame keeps
 * its raw form, and the reader can see that the name is unknown.
 */
function makeBundleResolver(bundlePath) {
  let lines = null;
  try {
    lines = fs.readFileSync(bundlePath, 'utf8').split('\n');
  } catch {
    return () => null;
  }
  const cache = new Map();
  return (lineNumber) => {
    if (lineNumber == null) return null;
    if (cache.has(lineNumber)) return cache.get(lineNumber);
    const idx = lineNumber - 1;
    let found = null;
    for (let i = idx; i >= 0 && i > idx - 400; i--) {
      const line = lines[i];
      if (line == null) break;
      const m =
        /(?:^|\b)(?:function\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:function)?\s*\(?)/.exec(
          line,
        );
      if (m != null) {
        const name = m[1] ?? m[2];
        if (name != null && name !== 'function' && name.length > 1) {
          found = name;
          break;
        }
      }
    }
    cache.set(lineNumber, found);
    return found;
  };
}

/** Which PandamStyle / fork file a frame belongs to, aggregated. */
function byModule(profile) {
  const byId = indexNodes(profile);
  const buckets = new Map();
  const classify = (url) => {
    const u = url || '';
    // The compiler is a ROLLUP BUNDLE: the fork and the PandamStyle modules are
    // inlined into one `lib/index.js`, so they share a URL and cannot be told
    // apart by file. The bucket therefore names the bundle, and the per-frame
    // table below it is where the individual functions are named.
    if (u.includes('@pandamstyle/compiler/lib/'))
      return 'pandamstyle-compiler-bundle';
    if (u.includes('/pandamstyle/')) return 'pandamstyle-harness';
    if (u.includes('@babel/core')) return '@babel/core';
    if (u.includes('@babel/parser')) return '@babel/parser';
    if (u.includes('@babel/traverse')) return '@babel/traverse';
    if (u.includes('@babel/generator')) return '@babel/generator';
    if (u.includes('@babel/types')) return '@babel/types';
    if (u.includes('/src/shared/')) return 'stylex-fork-shared';
    if (u.includes('/babel-plugin/src/')) return 'stylex-fork-visitors';
    if (u.includes('node_modules')) return 'other-node-modules';
    if (u.startsWith('node:')) return 'node-internal';
    if (u === '') return 'native/vm';
    if (u.includes('/.pms-bench/') || u.includes('/benchmarks/'))
      return 'bench-harness';
    return 'other';
  };
  for (const id of profile.samples ?? []) {
    const node = byId.get(id);
    if (node == null) continue;
    const bucket = classify(node.callFrame.url);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const total = (profile.samples ?? []).length;
  return [...buckets.entries()]
    .map(([module, hits]) => ({
      module,
      samples: hits,
      self_pct: total === 0 ? 0 : (hits / total) * 100,
    }))
    .sort((a, b) => b.self_pct - a.self_pct);
}

/**
 * Self time inside the compiler bundle, with the enclosing function recovered.
 * This is the table that answers "which PandamStyle or fork function is hot",
 * which a module-level table cannot: the bundle erases the module boundaries.
 */
function compilerFunctionTable(profile, bundlePath, topN = 30) {
  const table = selfTimeTable(profile, 4000);
  const resolve = makeBundleResolver(bundlePath);
  const acc = new Map();
  for (const row of table) {
    if (!row.frame.includes('@pandamstyle/compiler/lib/')) continue;
    const line = Number(row.frame.split(':').pop());
    const name = resolve(line);
    const key = name ?? `unresolved (bundle line ${line})`;
    acc.set(key, (acc.get(key) ?? 0) + row.self_pct);
  }
  return [...acc.entries()]
    .map(([fn, self_pct]) => ({ function: fn, self_pct }))
    .sort((a, b) => b.self_pct - a.self_pct)
    .slice(0, topN);
}

function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(
    args.out ?? path.join(os.tmpdir(), 'pms-profile'),
  );
  fs.mkdirSync(outDir, { recursive: true });

  const cells = (args.corpus ?? 'c100-t100-r10').split(',').map((name) => {
    const m = /^c(\d+)-t(\d+)-r(\d+)$/.exec(name.trim());
    if (m == null)
      throw new Error(`corpus must look like c100-t100-r10, got ${name}`);
    return {
      components: Number(m[1]),
      tokens: Number(m[2]),
      recipes: Number(m[3]),
      seed: Number(args.seed ?? 101),
      fanout: Number(args.fanout ?? (Number(m[1]) >= 1000 ? 8 : 4)),
    };
  });

  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
  const BASELINE =
    process.env.PMS_BASELINE_ROOT ?? path.join(REPO_ROOT, '..', 'pms-baseline');
  const engines = (args.engines ?? 'babel_current,babel_work_eliminated')
    .split(',')
    .map((s) => s.trim());

  const driverPath = path.join(outDir, 'profile-driver.cjs');
  fs.writeFileSync(driverPath, PROFILE_DRIVER);

  const results = [];
  for (const cell of cells) {
    const name = `c${cell.components}-t${cell.tokens}-r${cell.recipes}`;
    const corpusDir = path.join(outDir, 'corpus', name);
    if (!fs.existsSync(path.join(corpusDir, MANIFEST_NAME))) {
      generate({ ...cell, outDir: corpusDir, negative: false });
    }
    for (const engineName of engines) {
      const engineRoot = engineName === 'babel_current' ? BASELINE : REPO_ROOT;
      const projectDir = path.join(outDir, 'project', `${name}-${engineName}`);
      materialise(corpusDir, projectDir);
      linkCompiler(projectDir, engineRoot);
      const profileOut = path.join(outDir, `${name}-${engineName}.cpuprofile`);
      const statsOut = path.join(outDir, `${name}-${engineName}.stats.json`);
      const res = spawnSync(
        process.execPath,
        [
          driverPath,
          JSON.stringify({
            engineModulePath: path.join(
              engineRoot,
              'packages',
              '@pandamstyle',
              'compiler',
              'lib',
              'index.js',
            ),
            engine: engineName,
            projectDir,
            profileOut,
            statsOut,
            sampleIntervalMicros: Number(args['sample-interval-us'] ?? 200),
          }),
        ],
        {
          encoding: 'utf8',
          timeout: 3600000,
          env: {
            ...process.env,
            PMS_WORK_ELIMINATED:
              engineName === 'babel_work_eliminated' ? '1' : '',
          },
        },
      );
      if (res.status !== 0) {
        results.push({
          corpus: name,
          engine: engineName,
          status: 'error',
          message: (res.stderr ?? '').slice(0, 500),
        });
        continue;
      }
      const profile = JSON.parse(fs.readFileSync(profileOut, 'utf8'));
      const bundlePath = path.join(
        engineRoot,
        'packages',
        '@pandamstyle',
        'compiler',
        'lib',
        'index.js',
      );
      results.push({
        corpus: name,
        engine: engineName,
        status: 'ok',
        samples: (profile.samples ?? []).length,
        wall_ms: (profile.endTime - profile.startTime) / 1000,
        byModule: byModule(profile),
        selfTime: selfTimeTable(profile),
        // The compiler is a rollup bundle, so all of its internal functions
        // share one URL and the shallow table above collapses them. This deep
        // table is where the individual PandamStyle and fork functions become
        // visible.
        compilerFunctions: compilerFunctionTable(profile, bundlePath),
        stats: JSON.parse(fs.readFileSync(statsOut, 'utf8')),
        profileFile: path.relative(outDir, profileOut),
      });
    }
  }

  const report = {
    documentKind: 'pandamstyle-benchmark-profiles',
    note:
      'DEDICATED PROFILING RUNS. A profiler perturbs what it observes, so ' +
      'these were taken in separate invocations from the latency campaign and ' +
      'nothing here is a latency measurement. Sample counts are self-time: a ' +
      'frame is charged for the samples that landed in it, not for the samples ' +
      'of its callees.',
    generated_at: new Date().toISOString(),
    results,
  };
  fs.writeFileSync(
    path.join(outDir, 'profiles.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  process.stdout.write(
    `${JSON.stringify({ out: outDir, runs: results.length, ok: results.filter((r) => r.status === 'ok').length }, null, 2)}\n`,
  );
}

if (require.main === module) main();

module.exports = { selfTimeTable, byModule };
