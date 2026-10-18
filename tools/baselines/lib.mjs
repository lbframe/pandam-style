/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared helpers for the CE-00.3 baseline tooling: digests, tree digests,
// statistics, environment and machine-load records. Node built-ins only, so
// the same file runs under any archived Node runtime and any epoch.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const BENCH = path.join(REPO, 'benchmarks/core-evolution');
export const DEFAULT_STORE = path.join(
  os.homedir(),
  '.local/share/pandamstyle-baselines',
);

export const sha256 = (data) =>
  crypto.createHash('sha256').update(data).digest('hex');
export const sha512Integrity = (data) =>
  `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`;
export const sha1 = (data) =>
  crypto.createHash('sha1').update(data).digest('hex');
export const fileSha256 = (file) => sha256(fs.readFileSync(file));

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 1 << 30,
  });
}

// Bytes of a file at a commit, read from the object store, so a baseline input
// never depends on the working tree.
export function gitBlob(commit, file) {
  return git(['cat-file', 'blob', `${commit}:${file}`], { encoding: 'buffer' });
}

export function gitFiles(commit, prefix) {
  return git(['ls-tree', '-r', '--name-only', commit, '--', prefix])
    .split('\n')
    .filter(Boolean)
    .sort();
}

// Digest of a directory: every regular file (path, executable bit, SHA-256)
// and symlink (path, target) in byte order of the relative POSIX path.
// Directories contribute only through their contents.
export function treeDigest(root, { exclude = () => false } = {}) {
  const lines = [];
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (exclude(rel)) continue;
      if (entry.isSymbolicLink()) {
        lines.push(`l ${rel} ${fs.readlinkSync(full)}`);
      } else if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        const exec = stat.mode & 0o111 ? 'x' : '-';
        lines.push(`f ${rel} ${exec} ${fileSha256(full)}`);
        files++;
        bytes += stat.size;
      }
    }
  };
  walk(root);
  return { sha256: sha256(lines.join('\n')), files, bytes };
}

// ---------------------------------------------------------------- statistics

export function sorted(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  const s = sorted(values);
  const n = s.length;
  if (n === 0) return null;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Nearest-rank quantile: the smallest sample with at least q*n samples at or
// below it. Never interpolates, so it is always an observed value.
export function quantile(values, q) {
  const s = sorted(values);
  if (s.length === 0) return null;
  return s[Math.min(s.length, Math.max(1, Math.ceil(q * s.length))) - 1];
}

function binomialCdf(k, n, p) {
  // P(X <= k) for X ~ Binomial(n, p), summed in log space for stability.
  if (k < 0) return 0;
  if (k >= n) return 1;
  let total = 0;
  let logCoefficient = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logCoefficient += Math.log(n - i + 1) - Math.log(i);
    total += Math.exp(
      logCoefficient + i * Math.log(p) + (n - i) * Math.log(1 - p),
    );
  }
  return Math.min(1, total);
}

// Distribution-free confidence interval for the q-quantile from order
// statistics: the widest symmetric-tail ranks [l, u] (1-based) with
// P(X(l) <= xi_q <= X(u)) >= confidence. A bound that would need a rank
// outside the sample is reported as null (unbounded at this sample size).
export function quantileInterval(values, q, confidence = 0.95) {
  const s = sorted(values);
  const n = s.length;
  if (n === 0) return { lower: null, upper: null, coverage: null };
  const alpha = (1 - confidence) / 2;
  let l = 0;
  for (let r = 1; r <= n; r++) {
    if (binomialCdf(r - 1, n, q) <= alpha) l = r;
    else break;
  }
  let u = n + 1;
  for (let r = n; r >= 1; r--) {
    if (1 - binomialCdf(r - 1, n, q) <= alpha) u = r;
    else break;
  }
  const lower = l >= 1 ? s[l - 1] : null;
  const upper = u <= n ? s[u - 1] : null;
  const coverage =
    l >= 1 && u <= n
      ? binomialCdf(u - 1, n, q) - binomialCdf(l - 1, n, q)
      : null;
  return {
    lower,
    upper,
    lowerRank: l || null,
    upperRank: u <= n ? u : null,
    coverage,
  };
}

export function summarize(values) {
  if (values.length === 0) return null;
  const s = sorted(values);
  return {
    n: s.length,
    min: s[0],
    median: median(s),
    p95: quantile(s, 0.95),
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    medianCi95: quantileInterval(s, 0.5),
    p95Ci95: quantileInterval(s, 0.95),
  };
}

// Deterministic PRNG for reproducible bootstrap resampling and corpora.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Percentile bootstrap interval of median(candidate) / median(reference),
// resampling each epoch independently with a fixed seed.
export function bootstrapRatio(
  reference,
  candidate,
  { seed = 307, rounds = 2000 } = {},
) {
  const random = mulberry32(seed);
  const resample = (values) =>
    values.map(() => values[Math.floor(random() * values.length)]);
  const ratios = [];
  for (let i = 0; i < rounds; i++)
    ratios.push(median(resample(candidate)) / median(resample(reference)));
  const s = sorted(ratios);
  return {
    point: median(candidate) / median(reference),
    lower: s[Math.floor(0.025 * rounds)],
    upper: s[Math.ceil(0.975 * rounds) - 1],
    rounds,
    seed,
  };
}

// --------------------------------------------------------------- environment

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function osRelease() {
  const text = readOptional('/etc/os-release') ?? '';
  return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text)?.[1] ?? null;
}

export function environment(nodeBinary = process.execPath, workDir = REPO) {
  const cpus = os.cpus();
  let filesystem = null;
  try {
    filesystem = execFileSync('stat', ['-f', '-c', '%T', workDir], {
      encoding: 'utf8',
    }).trim();
  } catch {}
  return {
    os: osRelease(),
    kernel: os.release(),
    architecture: os.arch(),
    cpu: cpus[0]?.model.trim() ?? null,
    logicalCores: cpus.length,
    memoryBytes: os.totalmem(),
    scalingGovernor: readOptional(
      '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor',
    ),
    boost: readOptional('/sys/devices/system/cpu/cpufreq/boost'),
    filesystem,
    node: execFileSync(nodeBinary, ['-p', 'process.version'], {
      encoding: 'utf8',
    }).trim(),
    nodeBinary,
    nodeBinarySha256: fileSha256(fs.realpathSync(nodeBinary)),
    hostname: os.hostname(),
  };
}

// --------------------------------------------------------------- machine load

function processTimes() {
  const result = new Map();
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const stat = readOptional(`/proc/${pid}/stat`);
    if (stat == null) continue;
    const close = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, close);
    const fields = stat.slice(close + 2).split(' ');
    result.set(Number(pid), {
      comm,
      ppid: Number(fields[1]),
      // utime + stime, plus cutime + cstime so that a parent running many
      // short-lived jobs is attributed the CPU of children it reaped.
      ticks:
        Number(fields[11]) +
        Number(fields[12]) +
        Number(fields[13]) +
        Number(fields[14]),
    });
  }
  return result;
}

function cpuTotals() {
  const line = readOptional('/proc/stat').split('\n')[0];
  const values = line.split(/\s+/).slice(1).map(Number);
  const idle = values[3] + values[4];
  return { total: values.reduce((a, b) => a + b, 0), idle };
}

function commandLine(pid) {
  const raw = readOptional(`/proc/${pid}/cmdline`);
  return raw == null ? null : raw.replace(/\0/g, ' ').trim().slice(0, 160);
}

const HEAVY =
  /^(node|MainThread|chrome|chromium|headless_shell|next-server|rspack|esbuild|vite|jest|tsc|flow|java|cc1plus|rustc|cargo|webpack|bun|deno|python3?)$/;

// A load record: load averages, whole-machine CPU utilisation over a sampling
// window, and every process that used at least `threshold` of one core during
// that window (foreign to this process tree), with a heavy-tool flag.
export async function loadSnapshot({ windowMs = 5000, threshold = 0.2 } = {}) {
  const ownTree = new Set([process.pid]);
  const t0 = processTimes();
  const c0 = cpuTotals();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const t1 = processTimes();
  const c1 = cpuTotals();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, info] of t1)
      if (!ownTree.has(pid) && ownTree.has(info.ppid)) {
        ownTree.add(pid);
        grew = true;
      }
  }
  const hz = 100;
  const seconds = windowMs / 1000;
  const busy = [];
  for (const [pid, info] of t1) {
    const before = t0.get(pid);
    const ticks = info.ticks - (before?.ticks ?? 0);
    const cores = ticks / hz / seconds;
    if (cores >= threshold && !ownTree.has(pid))
      busy.push({
        pid,
        comm: info.comm,
        cores: Math.round(cores * 100) / 100,
        heavy: HEAVY.test(info.comm),
        cmd: commandLine(pid),
      });
  }
  busy.sort((a, b) => b.cores - a.cores);
  const totalDelta = c1.total - c0.total;
  const utilisation =
    totalDelta > 0 ? 1 - (c1.idle - c0.idle) / totalDelta : null;
  const [l1, l5, l15] = os.loadavg();
  return {
    at: new Date().toISOString(),
    loadavg: [l1, l5, l15].map((v) => Math.round(v * 100) / 100),
    windowMs,
    cpuUtilisation:
      utilisation == null ? null : Math.round(utilisation * 1000) / 1000,
    busyCores: Math.round((utilisation ?? 0) * os.cpus().length * 100) / 100,
    foreignBusyProcesses: busy,
  };
}

// The quiet-machine rule used before and after every final batch.
export const QUIET_RULE = Object.freeze({
  maxCpuUtilisation: 0.1,
  maxForeignHeavyCores: 0.5,
  description:
    'Whole-machine CPU utilisation at most 10% over a 5 s window, and no foreign heavy tool process (node, chromium, next, rspack, esbuild, jest, tsc, ...) using half a core or more.',
});

export function isQuiet(snapshot) {
  const heavyCores = snapshot.foreignBusyProcesses
    .filter((p) => p.heavy)
    .reduce((sum, p) => sum + p.cores, 0);
  return (
    snapshot.cpuUtilisation != null &&
    snapshot.cpuUtilisation <= QUIET_RULE.maxCpuUtilisation &&
    heavyCores < QUIET_RULE.maxForeignHeavyCores
  );
}
