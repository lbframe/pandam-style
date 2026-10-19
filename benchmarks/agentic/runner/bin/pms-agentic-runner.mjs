#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// AG-00.2 evaluation runner (benchmarks/agentic/runner/DESIGN.md).
//
// Usage:
//   pms-agentic-runner validate-config <matrix.json>
//   pms-agentic-runner run <matrix.json> [--runs-root d] [--matrix-id id]
//                          [--state-dir d] [--setup provider-setup.json]
//   pms-agentic-runner report <matrix dir> [--out report.json] [--markdown report.md]
//   pms-agentic-runner compare <record a> <record b>
//   pms-agentic-runner regrade <attempt dir> [--trusted-node-modules d]
//   pms-agentic-runner copy-store --dest d [--original d]
//   pms-agentic-runner bind --store-copy d [--manifest f] [--out f]
//   pms-agentic-runner trusted-tree --closure d --binding f --store-copy d --dest d [--cache d]
//   pms-agentic-runner selftest [--state-dir d]
//   pms-agentic-runner recover [--runs-root d]
//   pms-agentic-runner prune --older-than <days> [--runs-root d]
//
// Adapter-fixture matrices run fake CLIs locally (no provider, no isolation).
// Provider-backed matrices need the orchestrator's authorization in the
// matrix, a clean checkout, a valid isolation self-test, a verified product
// build and trusted tree, and never run in CI. Held-out tasks and
// `--heldout-dir` are refused unconditionally (F1).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate } from '../../src/json-schema.mjs';
import { loadCorpus } from '../../src/corpus.mjs';
import { effectiveConfigFromPromptInput } from '../src/adapters/codex.mjs';
import { heldoutRefusal } from '../src/capabilities.mjs';
import { compareRecords } from '../src/comparability.mjs';
import { LocalFixtureExecutor } from '../src/executors/local.mjs';
import {
  harnessIdentity,
  hostFacts,
  startLoadSampler,
} from '../src/identity.mjs';
import { runMatrix, validateMatrixConfig } from '../src/matrix.mjs';
import { recoverStale } from '../src/recovery.mjs';
import { regradeAttempt } from '../src/regrade.mjs';
import { buildReport, loadMatrix, renderMarkdown } from '../src/report.mjs';
import { bindProductBuild, copyStore } from '../src/store.mjs';
import { buildTrustedTree } from '../src/trusted-tree.mjs';
import {
  CORPUS_ROOT,
  REPO_ROOT,
  RUNNER_ROOT,
  isInside,
  readJson,
  writeJson,
} from '../src/util.mjs';

export const FAKE_CLI = path.join(RUNNER_ROOT, 'fixtures/bin/fake-cli.mjs');
export const DEFAULT_PROVIDER_RUNS_ROOT = path.join(
  os.homedir(),
  '.local/share/pandamstyle-agentic-runs',
);
export const DEFAULT_FIXTURE_RUNS_ROOT = path.join(
  REPO_ROOT,
  '.pms-bench/agentic-runs',
);
export const DEFAULT_STATE_DIR = path.join(
  os.homedir(),
  '.local/state/pandamstyle-agentic',
);
export const DEFAULT_MANIFEST = path.join(
  REPO_ROOT,
  'benchmarks/core-evolution/epochs/alpha1/manifest.v1.json',
);

const BOOLEAN_FLAGS = new Set(['json']);

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
      else {
        flags[a.slice(2)] = argv[i + 1];
        i += 1;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

export function loadSchema(name) {
  return readJson(path.join(RUNNER_ROOT, 'schema', name));
}

/** Schema and policy validation of a matrix configuration. */
export function checkMatrixFile(file) {
  const config = readJson(file);
  const errors = validate(loadSchema('run-config.v1.schema.json'), config).map(
    (e) => `schema: ${e}`,
  );
  errors.push(...validateMatrixConfig(config));
  return { config, errors };
}

/** Run root rules (section 6.4). */
export function resolveRunsRoot(config, flag) {
  const root = path.resolve(
    flag ??
      (config.kind === 'provider-backed'
        ? DEFAULT_PROVIDER_RUNS_ROOT
        : DEFAULT_FIXTURE_RUNS_ROOT),
  );
  if (isInside(REPO_ROOT, root)) {
    if (config.kind === 'provider-backed')
      throw new Error(
        'provider-backed run roots must be outside the repository',
      );
    if (!isInside(path.join(REPO_ROOT, '.pms-bench'), root))
      throw new Error(
        'run roots inside the repository must be under the gitignored .pms-bench/',
      );
  }
  return root;
}

function fixtureIdentity() {
  return {
    harness: harnessIdentity(),
    productBuild: {
      digest: null,
      epoch: null,
      sourceCommit: null,
      synthetic: true,
    },
    environment: {
      images: { agent: null, grader: null, proxy: null },
      dockerVersion: null,
      ...hostFacts(),
      cgroup: null,
      isolationSelfTest: null,
    },
    startLoadSampler,
  };
}

/** Executors of an adapter-fixture matrix: scenarios relative to the matrix file. */
export function fixtureExecutorFor(config, matrixFile) {
  const base = path.dirname(path.resolve(matrixFile));
  return ({ model, taskId, attempt }) => {
    const list =
      config.adapterFixtures?.[`${taskId}/${model.key}`] ??
      config.adapterFixtures?.['*'];
    if (!Array.isArray(list) || list.length === 0)
      throw new Error(`no adapter fixture scenario for ${taskId}/${model.key}`);
    const scenario = path.resolve(
      base,
      list[Math.min(attempt, list.length) - 1],
    );
    return new LocalFixtureExecutor({ fakeBinary: FAKE_CLI, scenario });
  };
}

async function runCommand(positional, flags) {
  const file = positional[0];
  if (!file) throw new Error('run: missing matrix.json');
  const { config, errors } = checkMatrixFile(file);
  if (errors.length > 0)
    throw new Error(`invalid matrix:\n- ${errors.join('\n- ')}`);
  const runsRoot = resolveRunsRoot(config, flags['runs-root']);
  const stateDir = path.resolve(flags['state-dir'] ?? DEFAULT_STATE_DIR);
  // Crash recovery runs before anything else (section 4.6).
  const recovered = recoverStale(runsRoot);
  if (recovered.length > 0)
    process.stderr.write(`recovered ${recovered.length} stale attempt(s)\n`);
  let out;
  if (config.kind === 'adapter-fixture') {
    out = await runMatrix({
      config,
      runsRoot,
      stateDir,
      identity: fixtureIdentity(),
      grading: { mode: 'dev-ancestor', hostCommands: false },
      executorFor: fixtureExecutorFor(config, file),
      // Codex evidence is the recorded `debug prompt-input` rendering of the
      // fixture; it runs through the same evidence code as a real run.
      effectiveConfigFor: (m) =>
        m.cli === 'codex' && config.adapterEffectiveConfig?.codex != null
          ? effectiveConfigFromPromptInput(config.adapterEffectiveConfig.codex)
          : null,
      ...(flags['matrix-id'] ? { matrixId: flags['matrix-id'] } : {}),
    });
  } else {
    const { providerBackedRun } = await import('../src/provider.mjs');
    out = await providerBackedRun({
      config,
      matrixFile: file,
      runsRoot,
      stateDir,
      setupFile: flags.setup,
      matrixId: flags['matrix-id'],
    });
  }
  const loaded = loadMatrix(out.matrixDir);
  const report = buildReport(loaded);
  writeJson(path.join(out.matrixDir, 'report.json'), report);
  fs.writeFileSync(
    path.join(out.matrixDir, 'report.md'),
    renderMarkdown(report),
  );
  return { matrixDir: out.matrixDir, outcomes: out.outcomes };
}

export async function main(argv) {
  // F1: unconditional, before anything else reads a task.
  const refusal = heldoutRefusal({ taskId: null, argv });
  if (refusal) throw new Error(refusal);
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case 'validate-config': {
      const { errors } = checkMatrixFile(positional[0]);
      return { ok: errors.length === 0, errors };
    }
    case 'run':
      return runCommand(positional, flags);
    case 'report': {
      const report = buildReport(loadMatrix(positional[0]));
      const errors = validate(loadSchema('report.v1.schema.json'), report);
      if (errors.length > 0)
        throw new Error(`report schema: ${errors.join('; ')}`);
      if (flags.out) writeJson(flags.out, report);
      if (flags.markdown)
        fs.writeFileSync(flags.markdown, renderMarkdown(report));
      return flags.out ? { written: flags.out } : report;
    }
    case 'compare':
      return compareRecords(readJson(positional[0]), readJson(positional[1]));
    case 'regrade': {
      // Inside the gitignored .pms-bench/ so the dev grading fallback resolves
      // packages from the workspace; pass --trusted-node-modules otherwise.
      const scratchParent = path.join(REPO_ROOT, '.pms-bench');
      fs.mkdirSync(scratchParent, { recursive: true });
      return regradeAttempt({
        attemptDir: positional[0],
        scratchRoot: fs.mkdtempSync(path.join(scratchParent, 'regrade-')),
        trustedNodeModules: flags['trusted-node-modules'] ?? null,
      });
    }
    case 'copy-store':
      return {
        copied: copyStore({
          ...(flags.original ? { original: flags.original } : {}),
          dest: path.resolve(flags.dest),
        }),
      };
    case 'bind': {
      const manifest = path.resolve(flags.manifest ?? DEFAULT_MANIFEST);
      const { binding } = bindProductBuild({
        storeCopy: path.resolve(flags['store-copy']),
        manifestPath: manifest,
        manifestSource: path.relative(REPO_ROOT, manifest),
        corpus: loadCorpus(CORPUS_ROOT).corpus,
      });
      if (flags.out) writeJson(flags.out, binding);
      return binding;
    }
    case 'trusted-tree':
      return buildTrustedTree({
        closureDir: path.resolve(flags.closure),
        dest: path.resolve(flags.dest),
        cacheDir: flags.cache ? path.resolve(flags.cache) : null,
        binding: readJson(flags.binding),
        storeCopy: path.resolve(flags['store-copy']),
      });
    case 'selftest': {
      const { runSelfTest } = await import('../src/selftest.mjs');
      return runSelfTest({
        stateDir: path.resolve(flags['state-dir'] ?? DEFAULT_STATE_DIR),
      });
    }
    case 'recover':
      return recoverStale(
        path.resolve(flags['runs-root'] ?? DEFAULT_PROVIDER_RUNS_ROOT),
      );
    case 'prune': {
      const days = Number(flags['older-than']);
      if (!(days > 0))
        throw new Error('prune: --older-than <days> is required');
      const root = path.resolve(
        flags['runs-root'] ?? DEFAULT_PROVIDER_RUNS_ROOT,
      );
      const cutoff = Date.now() - days * 86400000;
      const pruned = [];
      for (const m of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        const dir = path.join(root, m);
        if (!fs.existsSync(path.join(dir, 'matrix.json'))) continue;
        if (fs.statSync(path.join(dir, 'matrix.json')).mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
          pruned.push(m);
        }
      }
      return { pruned };
    }
    default:
      throw new Error(`unknown command ${command ?? ''}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (out) => process.stdout.write(`${JSON.stringify(out, null, 2)}\n`),
    (error) => {
      process.stderr.write(`pms-agentic-runner: ${error.message}\n`);
      process.exit(1);
    },
  );
}
