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
import { loadCorpus } from '../../src/corpus.mjs';
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
import { requireValidSelfTest, selftestBinding } from './selftest.mjs';
import { bindProductBuild } from './store.mjs';
import {
  buildTrustedTree,
  checkTrustedTree,
  installClosure,
  nonProductLockDigest,
  trustedTreeDigests,
  verifyProductPackages,
} from './trusted-tree.mjs';
import { CORPUS_ROOT, REPO_ROOT, fileSha256, readJson } from './util.mjs';

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

/** Preconditions that need no Docker; the tests exercise every refusal. */
export function providerPreflight({ config, identity, setup }) {
  const errors = validateMatrixConfig(config);
  if (config.kind !== 'provider-backed')
    errors.push('not a provider-backed matrix');
  if (!identity.harness.clean)
    errors.push('provider-backed matrices refuse a dirty checkout');
  errors.push(...checkSetup(setup));
  if (errors.length > 0)
    throw refuse(
      'preflight',
      `provider-backed preflight refused:\n- ${errors.join('\n- ')}`,
    );
}

/** Codex effective configuration (section 3.3), rendered without a model call. */
export function codexEffectiveConfig({ image, model }) {
  const inv = codex.buildInvocation({
    model: model.model,
    effort: model.reasoningEffort ?? null,
  });
  const overrides = [];
  for (let i = 0; i < inv.argv.length; i += 1)
    if (inv.argv[i] === '-c') overrides.push('-c', inv.argv[i + 1]);
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
    'debug',
    'prompt-input',
    '--strict-config',
    '-m',
    model.model,
    ...overrides,
  ]);
  let promptInput = null;
  try {
    promptInput = JSON.parse(r.stdout);
  } catch {
    // Unparseable: the evidence stays unknown and the attempt is refused.
  }
  return effectiveConfigFromPromptInput({
    promptInput,
    strictConfigAccepted: r.status === 0,
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

  // Isolation self-test bound to the exact images, allowlist and host.
  const images = { harness: config.images.proxy };
  const selftest = requireValidSelfTest({
    stateDir,
    binding: selftestBinding({ images, allow: config.network.allow }),
  });

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
      fixtureClosureNonProductLockSha256: nonProductLockDigest(
        path.join(path.resolve(setup.trustedClosure), 'package-lock.json'),
      ),
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
    installFor: ({ task }) => {
      const closure = setup.closures[task.workspace.fixture];
      if (closure == null) return null;
      return ({ workspace }) => {
        installClosure({
          closureDir: path.resolve(closure.dir),
          dest: workspace,
          cacheDir: closure.cache ? path.resolve(closure.cache) : null,
        });
        const problems = verifyProductPackages({
          nodeModules: path.join(workspace, 'node_modules'),
          binding,
          storeCopy: path.resolve(setup.storeCopy),
        });
        if (problems.length > 0)
          throw refuse(
            'install',
            `workspace @pandamstyle packages differ from the product build: ${problems.slice(0, 5).join('; ')}`,
          );
        return {
          lockSha256: fileSha256(
            path.join(path.resolve(closure.dir), 'package-lock.json'),
          ),
        };
      };
    },
    ...(matrixId ? { matrixId } : {}),
  });
}
