/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Provider-backed matrix wiring (DESIGN.md sections 3.7, 4.3, 4.7 and 4.8).
// Every precondition is checked before the first CLI starts, in this order:
// authorization and CI (matrix validation), a clean checkout, credential
// sources, the product build bound from a verified store copy, the trusted
// grading tree, the isolation self-test of the exact binding, and the CLI
// identity inside the agent image. Nothing here was executed against a
// provider during AG-00.2: the authorized smoke run (section 9.4) is the
// first execution.

import fs from 'node:fs';
import path from 'node:path';
import { findTask, loadCorpus } from '../../src/corpus.mjs';
import { effectiveConfigFromPromptInput } from './adapters/codex.mjs';
import * as codex from './adapters/codex.mjs';
import {
  DockerExecutor,
  checkCliIdentity,
  containerEvaluator,
  docker,
  observeCliIdentity,
} from './docker.mjs';
import {
  dockerVersion,
  harnessIdentity,
  hostFacts,
  startLoadSampler,
} from './identity.mjs';
import { runMatrix, validateMatrixConfig } from './matrix.mjs';
import { requireValidSelfTest } from './selftest.mjs';
import { enforcementPlan } from './capabilities.mjs';
import { bindProductBuild } from './store.mjs';
import {
  buildTrustedTree,
  checkTrustedTree,
  closureIdentity,
  installFixtureClosure,
  trustedTreeDigests,
  verifyProductPackages,
} from './trusted-tree.mjs';
import { CORPUS_ROOT, REPO_ROOT, readJson } from './util.mjs';

export const SETUP_SCHEMA = 'pms-agentic-provider-setup/v1';
export const CLI_PATHS = { claude: '/opt/cli/claude', codex: '/opt/cli/codex' };

function refuse(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Validates the operator's setup file: the verified store copy, the CE
 * manifest, the fixture closures and the images built by the runner.
 */
export function checkSetup(setup) {
  const errors = [];
  if (setup?.schema !== SETUP_SCHEMA)
    errors.push(`setup schema must be ${SETUP_SCHEMA}`);
  for (const k of ['storeCopy', 'manifest', 'trustedClosure'])
    if (typeof setup?.[k] !== 'string') errors.push(`setup.${k} is required`);
  if (setup?.closures == null || typeof setup.closures !== 'object')
    errors.push('setup.closures (per fixture: { dir, cache }) is required');
  return errors;
}

/**
 * Fixture closures (section 4.8): every runnable task installed before the
 * agent needs its fixture's closure (package.json + package-lock.json); a
 * missing one refuses the matrix instead of running without dependencies.
 */
export function closureErrors({ config, setup, loaded }) {
  const errors = [];
  for (const taskId of config.tasks ?? []) {
    const entry = findTask(loaded, taskId);
    if (entry == null) continue;
    const fixture = loaded.fixtures.get(entry.task.workspace.fixture);
    if (enforcementPlan(entry.task, fixture?.meta).refusals.length > 0)
      continue;
    if (entry.task.environment.install !== 'before-agent') continue;
    const closure = setup?.closures?.[entry.task.workspace.fixture];
    if (closure == null || typeof closure.dir !== 'string') {
      errors.push(
        `setup.closures.${entry.task.workspace.fixture} is required by ${taskId}`,
      );
      continue;
    }
    for (const f of ['package.json', 'package-lock.json'])
      if (!fs.existsSync(path.join(path.resolve(closure.dir), f)))
        errors.push(
          `setup.closures.${entry.task.workspace.fixture}: ${f} missing`,
        );
  }
  return errors;
}

/** Preconditions that need no Docker; the tests exercise every refusal. */
export function providerPreflight({
  config,
  identity,
  setup,
  loaded = loadCorpus(CORPUS_ROOT),
  home,
}) {
  const errors = validateMatrixConfig(config, home ? { home } : {});
  if (config.kind !== 'provider-backed')
    errors.push('not a provider-backed matrix');
  if (!identity.harness.clean)
    errors.push('provider-backed matrices refuse a dirty checkout');
  const setupErrors = checkSetup(setup);
  errors.push(...setupErrors);
  if (setupErrors.length === 0)
    errors.push(...closureErrors({ config, setup, loaded }));
  if (errors.length > 0)
    throw refuse(
      'preflight',
      `provider-backed preflight refused:\n- ${errors.join('\n- ')}`,
    );
}

/** Codex effective configuration (section 3.3), rendered without a model call. */
/**
 * Arguments of the Codex evidence render (section 3.3): `codex debug
 * prompt-input` with the same `-c` overrides as the attempt and the model
 * as `-c model=…`. Codex 0.163.0 accepts neither `--strict-config` nor `-m`
 * on `debug` (observed); its `-c` values are still validated by type (an
 * unknown `web_search` variant fails), and the attempt itself runs
 * `codex exec --strict-config`.
 */
export function codexPromptInputArgs(model) {
  const inv = codex.buildInvocation({
    model: model.model,
    effort: model.reasoningEffort ?? null,
  });
  const overrides = [];
  for (let i = 0; i < inv.argv.length; i += 1)
    if (inv.argv[i] === '-c') overrides.push('-c', inv.argv[i + 1]);
  return [
    'debug',
    'prompt-input',
    '-c',
    `model="${model.model}"`,
    ...overrides,
  ];
}

/** Codex effective configuration (section 3.3), rendered without a model call. */
export function codexEffectiveConfig({ image, model }) {
  const r = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--tmpfs',
    '/run/agent:rw,mode=1777',
    '-e',
    'CODEX_HOME=/run/agent',
    '-e',
    'HOME=/run/agent',
    '--user',
    `${process.getuid()}:${process.getuid()}`,
    image,
    CLI_PATHS.codex,
    ...codexPromptInputArgs(model),
  ]);
  let promptInput = null;
  try {
    promptInput = JSON.parse(r.stdout);
  } catch {
    // Unparseable: the evidence stays unknown and the attempt is refused.
  }
  return effectiveConfigFromPromptInput({
    promptInput,
    // Overrides accepted with type validation (exit 0); see above.
    strictConfigAccepted: r.status === 0 && Array.isArray(promptInput),
  });
}

export async function providerBackedRun({
  config,
  runsRoot,
  stateDir,
  setupFile,
  matrixId,
}) {
  if (!setupFile)
    throw refuse(
      'preflight',
      'provider-backed runs need --setup <provider-setup.json>',
    );
  const setup = readJson(setupFile);
  const identityBase = { harness: harnessIdentity() };
  providerPreflight({ config, identity: identityBase, setup });

  // Product build (section 4.8): only from a verified copy, digests pinned.
  const loaded = loadCorpus(CORPUS_ROOT);
  const { binding, agentDocsDir } = bindProductBuild({
    storeCopy: path.resolve(setup.storeCopy),
    manifestPath: path.resolve(setup.manifest),
    manifestSource: path.relative(REPO_ROOT, path.resolve(setup.manifest)),
    expectedManifestSha256: config.productBuild.manifestSha256,
    corpus: loaded.corpus,
  });
  if (binding.digest !== config.productBuild.digest)
    throw refuse(
      'product-build',
      `product build digest ${binding.digest} is not the matrix's ${config.productBuild.digest}`,
    );

  // Trusted grading tree, built once per binding and re-checked per pass.
  const treeDir = path.join(stateDir, 'trusted', binding.digest);
  let trusted;
  if (fs.existsSync(path.join(treeDir, 'node_modules'))) {
    const nm = path.join(treeDir, 'node_modules');
    const problems = verifyProductPackages({
      nodeModules: nm,
      binding,
      storeCopy: path.resolve(setup.storeCopy),
    });
    if (problems.length > 0)
      throw refuse(
        'trusted-tree',
        `existing trusted tree differs: ${problems.slice(0, 5).join('; ')}`,
      );
    trusted = { nodeModules: nm, ...trustedTreeDigests(nm) };
  } else
    trusted = buildTrustedTree({
      closureDir: path.resolve(setup.trustedClosure),
      dest: treeDir,
      cacheDir: setup.trustedCache ? path.resolve(setup.trustedCache) : null,
      binding,
      storeCopy: path.resolve(setup.storeCopy),
    });
  checkTrustedTree({ nodeModules: trusted.nodeModules, expected: trusted });

  // Isolation self-test for exactly this configuration and host: the same
  // binding function the self-test used (section 4.3).
  const selftest = requireValidSelfTest({ stateDir, config });

  // CLI identity inside the agent image (section 3.7).
  for (const m of config.models)
    checkCliIdentity({
      expected: m,
      observed: observeCliIdentity({
        image: config.images.agent,
        binary: CLI_PATHS[m.cli],
      }),
    });
  const codexEvidence = new Map();
  for (const m of config.models)
    if (m.cli === 'codex')
      codexEvidence.set(
        m.key,
        codexEffectiveConfig({ image: config.images.agent, model: m }),
      );

  const identity = {
    harness: identityBase.harness,
    productBuild: {
      digest: binding.digest,
      epoch: binding.epoch,
      sourceCommit: binding.source.commit,
    },
    environment: {
      images: {
        agent: config.images.agent,
        grader: config.images.grader,
        proxy: config.images.proxy,
      },
      dockerVersion: dockerVersion(),
      ...hostFacts(),
      cgroup: null,
      isolationSelfTest: selftest.bindingDigest,
    },
    dependencies: {
      nodeSha256: binding.node.sha256,
      packageManager: {
        name: 'npm',
        version: setup.npmVersion ?? null,
        sha256: setup.npmSha256 ?? null,
      },
      // Per cell, from the closure each workspace was installed from.
      fixtureClosureNonProductLockSha256: null,
    },
    startLoadSampler,
  };
  const executor = new DockerExecutor({
    images: { agent: config.images.agent, harness: config.images.proxy },
    limits: config.container,
    allow: config.network.allow,
    docsDir: agentDocsDir,
    cliBinary: CLI_PATHS,
  });
  return runMatrix({
    config,
    runsRoot,
    stateDir,
    identity,
    grading: {
      mode: 'trusted',
      trustedNodeModules: trusted.nodeModules,
      trustedExpected: {
        digest: trusted.digest,
        pandamstyleDigest: trusted.pandamstyleDigest,
      },
      hostCommands: true,
      evaluate: containerEvaluator({
        image: config.images.grader,
        harnessDir: REPO_ROOT,
      }),
    },
    executorFor: () => executor,
    effectiveConfigFor: (m) =>
      m.cli === 'codex' ? codexEvidence.get(m.key) : null,
    installFor: ({ task, taskId }) => {
      task ??= findTask(loaded, taskId).task;
      if (task.environment.install !== 'before-agent') return null;
      const closure = setup.closures[task.workspace.fixture];
      const installer = ({ workspace }) =>
        installFixtureClosure({
          closureDir: path.resolve(closure.dir),
          cacheDir: closure.cache ? path.resolve(closure.cache) : null,
          workspace,
          binding,
          storeCopy: path.resolve(setup.storeCopy),
        });
      // Declared before any attempt: binds the matrix identity (resume).
      installer.identity = closureIdentity(path.resolve(closure.dir));
      return installer;
    },
    sweepLabels: true,
    ...(matrixId ? { matrixId } : {}),
  });
}
