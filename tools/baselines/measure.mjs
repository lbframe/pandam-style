/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// CE-00.3 measurement orchestrator.
//
//   node tools/baselines/measure.mjs --plan <pilot|final> \
//     --epoch alpha1=<closure dir> [--epoch <name>=<closure dir> ...] \
//     --label <run label> [--node <node binary>] [--work <dir>] \
//     [--require-quiet] [--quiet-wait-minutes 40] [--only <workload,...>]
//
// Every sample is a fresh `node tools/baselines/sample.mjs` process on a
// fresh copy of the frozen workload project. Epochs are interleaved inside
// each round and their order alternates between rounds; the order of
// (workload, kind) items is shuffled per round with a fixed seed. A load
// record is taken before and after the batch, and the 1-minute load average
// before every sample. With --require-quiet the batch starts only on a quiet
// machine (lib.mjs QUIET_RULE); after the bounded wait it writes
// READY-TO-MEASURE.json and exits with status 3 without measuring.
//
// Output: <out>/raw.json (rewritten after every sample) and <out>/summary.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BENCH,
  DEFAULT_STORE,
  REPO,
  cpuCounters,
  environment,
  fileSha256,
  isQuiet,
  loadSnapshot,
  mulberry32,
  QUIET_RULE,
  readJson,
  redactHome,
  treeDigest,
  utilisationBetween,
  writeJson,
} from './lib.mjs';
import { loadWorkloads, materialize, WORKLOADS_FILE } from './workloads.mjs';
import { summarizeRun } from './summarize.mjs';

const SAMPLE = path.join(REPO, 'tools/baselines/sample.mjs');

function parseArgs(argv) {
  const args = {
    epochs: [],
    requireQuiet: false,
    quietWaitMinutes: 40,
    seed: 307,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => argv[++i];
    if (key === '--plan') args.plan = value();
    else if (key === '--epoch') {
      const [name, dir] = value().split('=');
      args.epochs.push({ name, closure: path.resolve(dir) });
    } else if (key === '--label') args.label = value();
    else if (key === '--node') args.node = path.resolve(value());
    else if (key === '--work') args.work = path.resolve(value());
    else if (key === '--out') args.out = path.resolve(value());
    else if (key === '--require-quiet') args.requireQuiet = true;
    else if (key === '--quiet-wait-minutes')
      args.quietWaitMinutes = Number(value());
    else if (key === '--only') args.only = value().split(',');
    else if (key === '--seed') args.seed = Number(value());
    else throw new Error(`unknown argument ${key}`);
  }
  if (!args.plan || args.epochs.length === 0 || !args.label)
    throw new Error(
      'usage: measure.mjs --plan <plan> --epoch <name>=<closure> --label <label>',
    );
  args.node ??= process.execPath;
  args.work ??= path.join(DEFAULT_STORE, 'work', args.label);
  args.out ??= path.join(BENCH, 'results', args.label);
  return args;
}

// The identity of an epoch closure: its lockfile and the installed
// @pandamstyle packages, with the integrity the lockfile pins.
export function epochIdentity(closure) {
  const lockFile = path.join(closure, 'package-lock.json');
  const lock = readJson(lockFile);
  const packages = {};
  for (const [key, entry] of Object.entries(lock.packages))
    if (/^node_modules\/@pandamstyle\/[^/]+$/.test(key))
      packages[key.slice('node_modules/'.length)] = {
        version: entry.version,
        resolved: entry.resolved,
        integrity: entry.integrity,
      };
  const hosts = {};
  for (const name of [
    'vite',
    'next',
    '@rsbuild/core',
    '@rspack/core',
    'react',
    'react-dom',
    '@vitejs/plugin-react',
    'playwright-core',
    'typescript',
  ])
    hosts[name] = readJson(
      path.join(closure, 'node_modules', name, 'package.json'),
    ).version;
  return {
    closure: redactHome(closure),
    packageLockSha256: fileSha256(lockFile),
    packages,
    installedPandamstyle: treeDigest(
      path.join(closure, 'node_modules/@pandamstyle'),
    ),
    hosts,
  };
}

async function waitForQuiet(args, records) {
  const deadline = Date.now() + args.quietWaitMinutes * 60_000;
  for (;;) {
    const snapshot = await loadSnapshot();
    records.push(snapshot);
    if (isQuiet(snapshot)) return true;
    if (Date.now() + 60_000 > deadline) return false;
    process.stderr.write(
      `machine busy (cpu ${snapshot.cpuUtilisation}, ${snapshot.foreignHeavyCores} foreign heavy cores); retrying in 5 min\n`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(300_000, deadline - Date.now())),
    );
  }
}

function copyProject(template, dir, closure) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(template, dir, { recursive: true });
  fs.symlinkSync(
    path.join(closure, 'node_modules'),
    path.join(dir, 'node_modules'),
  );
}

function runSample(args, specFile) {
  const child = spawnSync(args.node, [SAMPLE, specFile], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '' },
  });
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return {
      ok: false,
      error: `exit ${child.status}: ${child.stderr.slice(-2000)}`,
    };
  }
}

function sampleSpec(args, plan, workload, kind, project) {
  return {
    kind,
    project,
    outDir: workload.outDir,
    designModule: workload.designModule,
    edits: workload.edits ?? [],
    incrementalIterations:
      kind === 'consistency'
        ? 2
        : (plan.incrementalIterationsByWorkload?.[workload.id] ??
          plan.incrementalIterations),
    runtimeArguments: workload.runtimeArguments,
    runtimeWarmupRounds: plan.runtimeWarmupRounds,
    runtimeBudgetMs: plan.runtimeBudgetMs,
    verifyIncremental: kind === 'consistency',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const record = loadWorkloads();
  const plan = record.plans[args.plan];
  if (plan == null) throw new Error(`unknown plan ${args.plan}`);
  const workloads = record.workloads.filter(
    (w) =>
      plan.repetitions[w.id] != null &&
      (args.only == null || args.only.includes(w.id)),
  );
  fs.mkdirSync(args.work, { recursive: true });
  fs.mkdirSync(args.out, { recursive: true });

  const raw = {
    schemaVersion: 1,
    kind: 'pandamstyle-ce003-raw-results',
    label: args.label,
    plan: { id: args.plan, ...plan },
    workloadsRecord: {
      path: path.relative(REPO, WORKLOADS_FILE),
      sha256: fileSha256(WORKLOADS_FILE),
    },
    harness: Object.fromEntries(
      [
        'lib.mjs',
        'sample.mjs',
        'measure.mjs',
        'workloads.mjs',
        'summarize.mjs',
      ].map((f) => [f, fileSha256(path.join(REPO, 'tools/baselines', f))]),
    ),
    repositoryCommit: spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf8',
    }).stdout.trim(),
    repositoryDirty:
      spawnSync(
        'git',
        [
          'status',
          '--porcelain',
          '--',
          'tools/baselines',
          'benchmarks/core-evolution/workloads.v1.json',
          'benchmarks/core-evolution/workloads',
        ],
        {
          cwd: REPO,
          encoding: 'utf8',
        },
      ).stdout.trim() !== '',
    environment: environment(args.node, args.work),
    quietRule: QUIET_RULE,
    epochs: args.epochs.map((e) => ({
      name: e.name,
      ...epochIdentity(e.closure),
    })),
    workloads: [],
    load: { before: [], after: null },
    seed: args.seed,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    samples: [],
  };

  let quiet;
  if (args.requireQuiet) quiet = await waitForQuiet(args, raw.load.before);
  else {
    const snapshot = await loadSnapshot();
    raw.load.before.push(snapshot);
    quiet = isQuiet(snapshot);
  }
  if (args.requireQuiet && !quiet) {
    writeJson(path.join(args.out, 'READY-TO-MEASURE.json'), {
      status: 'READY-TO-MEASURE',
      reason: 'the machine was not quiet within the bounded wait',
      quietRule: QUIET_RULE,
      waitedMinutes: args.quietWaitMinutes,
      load: raw.load.before,
    });
    process.stderr.write(
      'READY-TO-MEASURE: machine not quiet; nothing measured\n',
    );
    process.exitCode = 3;
    return;
  }
  raw.load.quietAtStart = quiet;
  raw.load.quietRequired = args.requireQuiet;

  // Templates, materialized once from frozen inputs (digest-checked).
  const templates = {};
  for (const workload of workloads) {
    const dir = path.join(args.work, 'templates', workload.id);
    fs.rmSync(dir, { recursive: true, force: true });
    const info = materialize(workload, dir);
    templates[workload.id] = dir;
    raw.workloads.push({
      id: workload.id,
      contentSha256: info.digest,
      files: info.files,
      bytes: info.bytes,
    });
  }

  // Compiled projects for runtime samples: one per (epoch, workload).
  const compiled = {};
  for (const epoch of args.epochs)
    for (const workload of workloads)
      if (plan.repetitions[workload.id].runtime != null) {
        const dir = path.join(args.work, 'compiled', epoch.name, workload.id);
        copyProject(templates[workload.id], dir, epoch.closure);
        const specFile = path.join(args.work, `spec-${process.pid}.json`);
        writeJson(specFile, {
          ...sampleSpec(args, plan, workload, 'compile', dir),
          edits: [],
        });
        const result = runSample(args, specFile);
        if (!result.ok)
          throw new Error(
            `cannot prepare ${epoch.name}/${workload.id}: ${result.error}`,
          );
        compiled[`${epoch.name}/${workload.id}`] = dir;
      }

  const items = [];
  for (const workload of workloads)
    for (const [kind, count] of Object.entries(plan.repetitions[workload.id]))
      items.push({ workload, kind, count });
  const rounds = Math.max(...items.map((i) => i.count));
  const random = mulberry32(args.seed);
  let index = 0;
  const total = items.reduce((n, i) => n + i.count, 0) * args.epochs.length;
  for (let r = 0; r < rounds; r++) {
    const roundItems = items.filter((i) => i.count > r);
    for (let i = roundItems.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [roundItems[i], roundItems[j]] = [roundItems[j], roundItems[i]];
    }
    const epochOrder = r % 2 === 0 ? args.epochs : [...args.epochs].reverse();
    for (const item of roundItems)
      for (const epoch of epochOrder) {
        const runtime = item.kind === 'runtime';
        const dir = runtime
          ? compiled[`${epoch.name}/${item.workload.id}`]
          : path.join(args.work, 'run', `${epoch.name}-${item.workload.id}`);
        if (!runtime)
          copyProject(templates[item.workload.id], dir, epoch.closure);
        const specFile = path.join(args.work, `spec-${process.pid}.json`);
        writeJson(
          specFile,
          sampleSpec(args, plan, item.workload, item.kind, dir),
        );
        const loadavg = () =>
          os.loadavg().map((v) => Math.round(v * 100) / 100);
        const loadBefore = loadavg();
        const cpuBefore = cpuCounters();
        const startedAt = new Date().toISOString();
        const result = runSample(args, specFile);
        if (!result.ok) result.error = redactHome(result.error);
        raw.samples.push({
          index: index++,
          round: r,
          epoch: epoch.name,
          workload: item.workload.id,
          kind: item.kind,
          startedAt,
          // Machine load around this sample: load averages before and after,
          // and whole-machine CPU utilisation during it (this sample's own
          // process included).
          load: {
            loadavgBefore: loadBefore,
            loadavgAfter: loadavg(),
            cpuUtilisation: utilisationBetween(cpuBefore, cpuCounters()),
          },
          result,
        });
        if (!runtime) fs.rmSync(dir, { recursive: true, force: true });
        process.stderr.write(
          `[${index}/${total}] r${r} ${epoch.name} ${item.workload.id} ${item.kind} ${result.ok ? `${result.wallMs} ms` : `FAILED ${result.error.slice(0, 200)}`}\n`,
        );
        writeJson(path.join(args.out, 'raw.json'), raw);
      }
  }
  raw.load.after = await loadSnapshot();
  raw.load.quietAtEnd = isQuiet(raw.load.after);
  const perSample = raw.samples.map((x) => x.load);
  const utilisations = perSample
    .map((l) => l.cpuUtilisation)
    .filter((v) => v != null);
  raw.load.batch = {
    maxLoadavg1: Math.max(
      ...perSample.flatMap((l) => [l.loadavgBefore[0], l.loadavgAfter[0]]),
    ),
    maxSampleCpuUtilisation: Math.max(...utilisations),
    meanSampleCpuUtilisation:
      Math.round(
        (utilisations.reduce((a, b) => a + b, 0) / utilisations.length) * 1000,
      ) / 1000,
  };
  raw.finishedAt = new Date().toISOString();
  writeJson(path.join(args.out, 'raw.json'), raw);
  writeJson(path.join(args.out, 'summary.json'), summarizeRun(raw));
  fs.rmSync(path.join(args.work, 'run'), { recursive: true, force: true });
  const failures = raw.samples.filter((s) => !s.result.ok).length;
  process.stderr.write(
    `done: ${raw.samples.length} samples, ${failures} failed; quiet at end: ${raw.load.quietAtEnd}\n`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
