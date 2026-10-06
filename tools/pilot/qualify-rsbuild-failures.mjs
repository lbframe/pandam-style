/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRsbuild } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { createProjectSession, Codes } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';

// Fault injection copies the installed adapter and wraps only its public SDK
// factory. The real service and canonical publisher execute every operation.
// No injected hook, option or private entry ships in the production package.
export async function qualifyFailures({
  base,
  root,
  pageSource,
  changed,
  definitionSource,
  canonical,
  build,
  report,
}) {
  const installed = await fs.readFile(
    new URL(import.meta.resolve('@pandamstyle/rsbuild')),
    'utf8',
  );
  const wrapped = installed.replace(
    "import { createHostBridge } from '@pandamstyle/compiler/host';",
    `import { createHostBridge as publicHostBridge } from '@pandamstyle/compiler/host';
function createHostBridge(project) {
 const bridge = publicHostBridge(project);
 return { ...bridge,
  async preparePublication(revision) {
   const fault = globalThis.__pmsFault;
   if (fault?.mode === 'publication-prepare') throw new Error('Injected prepare failure');
   const ticket = await bridge.preparePublication(revision);
   if (fault?.mode === 'design-change-prepared') await fsp.writeFile(fault.definitionFile, fault.changedDefinition);
   if (fault?.mode === 'source-change-prepared') await fsp.writeFile(fault.sourceFile, fault.changedSource);
   if (fault?.mode === 'stale-ticket') {
    const current = await project.current();
    await project.applyChanges({ baseRevision: current.revision, mode: 'verified-explicit', changed: [], added: [], removed: [], renamed: [], definition: { systemId: 'phase11', tokens: { spacing: { md: { value: '99px', visibility: 'public' } } } } });
   }
   return ticket;
  },
  async commitPrepared(ticket) {
   if (globalThis.__pmsFault?.mode === 'publication-commit') throw new Error('Injected commit failure');
   return bridge.commitPrepared(ticket);
  }
 };
}`,
  );
  assert.notEqual(wrapped, installed);
  const instrumented = path.join(base, 'instrumented-rsbuild.mjs');
  await fs.writeFile(instrumented, wrapped);
  const injectedAdapter = (await import(pathToFileURL(instrumented).href))
    .pandamstyle;
  report.failureInjection = {
    strategy:
      'copy installed adapter, wrap public createHostBridge factory for prepare/commit faults; public Rsbuild hooks for host faults',
    installedSourceUnchanged: true,
    privateSdkCalls: 0,
  };
  const modes = [
    'validation',
    'source-transform',
    'source-bytes-diverged',
    'edit-during-transform',
    'rspack-compilation',
    'asset-generation',
    'publication-prepare',
    'publication-commit',
    'source-change-prepared',
    'design-change-prepared',
    'stale-ticket',
  ];
  for (const mode of modes) {
    const before = await canonical(root);
    const events = [];
    let compiler;
    const hostErrors = [];
    let fired = false;
    await fs.writeFile(
      path.join(root, 'src/App.jsx'),
      mode === 'validation'
        ? pageSource.replace("token('spacing.md')", "'17px'")
        : changed,
    );
    globalThis.__pmsFault = {
      mode,
      definitionFile: path.join(root, 'definition.mjs'),
      changedDefinition: definitionSource.replace(
        "value: '16px'",
        "value: '20px'",
      ),
      sourceFile: path.join(root, 'src/App.jsx'),
      changedSource: pageSource,
    };
    const injector = {
      name: `phase11-inject-${mode}`,
      enforce: 'post',
      setup(api) {
        api.onAfterCreateCompiler(({ compiler: value }) => {
          compiler = value;
          compiler.hooks.done.tap('phase11-error-evidence', (stats) => {
            hostErrors.push(
              ...(stats.toJson({ all: false, errors: true, errorDetails: true })
                .errors ?? []),
            );
          });
        });
        api.transform({ test: /App\.jsx$/, order: 'pre' }, async (context) => {
          if (mode === 'source-transform')
            throw new Error('Injected source-transform failure');
          if (mode === 'source-bytes-diverged')
            return `${context.code}\nexport const wrapper = true;`;
          if (mode === 'edit-during-transform' && !fired) {
            fired = true;
            await fs.writeFile(path.join(root, 'src/App.jsx'), pageSource);
          }
          return context.code;
        });
        api.processAssets({ stage: 'summarize' }, ({ compilation }) => {
          if (mode === 'asset-generation')
            throw new Error('Injected asset-generation failure');
          if (mode === 'rspack-compilation')
            compilation.errors.push(
              new Error('Injected Rspack compilation failure'),
            );
        });
      },
    };
    const instance = await createRsbuild({
      cwd: root,
      rsbuildConfig: {
        mode: 'production',
        plugins: [
          pluginReact(),
          injectedAdapter({
            roots: ['src'],
            definition: './definition.mjs',
            onEvent: (event) => events.push(event),
          }),
          injector,
        ],
      },
    });
    let rejection = null;
    let handle;
    try {
      handle = await instance.build();
      assert(
        handle.stats.hasErrors(),
        `${mode}: unexpectedly successful build`,
      );
      rejection = 'stats.hasErrors';
    } catch (error) {
      rejection = error.message;
    } finally {
      if (handle) await handle.close();
      else if (compiler)
        await new Promise((resolve, reject) =>
          compiler.close((error) => (error ? reject(error) : resolve())),
        );
      globalThis.__pmsFault = null;
    }
    const after = await canonical(root);
    assert.equal(
      after.digest,
      before.digest,
      `${mode}: failed build changed canonical generation`,
    );
    assert.equal(
      events.filter((event) => event.kind === 'settled').length,
      0,
      `${mode}: failed build published`,
    );
    assert(rejection, `${mode}: missing rejection`);
    if (mode === 'source-bytes-diverged')
      assert(JSON.stringify(hostErrors).includes(Codes.COVERAGE_GAP));
    await fs.writeFile(path.join(root, 'src/App.jsx'), pageSource);
    await fs.writeFile(path.join(root, 'definition.mjs'), definitionSource);
    const recovery = await build(root);
    assert.equal(
      recovery.canonical.digest,
      before.digest,
      `${mode}: recovery differs from canonical baseline`,
    );
    report.failures.push({
      name: mode,
      pass: true,
      previousGenerationPreserved: true,
      mixedArtifacts: false,
      beforeDigest: before.digest,
      afterDigest: after.digest,
      recoveryDigest: recovery.canonical.digest,
      rejection,
      hostErrors,
      events,
    });
    if (mode === 'validation')
      report.plain.production.push(
        {
          name: 'failed',
          pass: true,
          outcome: 'expected-rejection',
          canonicalDigest: after.digest,
        },
        {
          name: 'recovery',
          pass: true,
          ms: recovery.ms,
          canonicalDigest: recovery.canonical.digest,
        },
      );
  }
  // SDK ticket lifecycle: no host substitute for stale/close checks.
  const definition = (
    await import(pathToFileURL(path.join(root, 'definition.mjs')).href)
  ).default;
  const session = createProjectSession({
    rootDir: root,
    roots: ['src'],
    definition,
  });
  const bridge = createHostBridge(session);
  let revision = (await session.initialize()).revision;
  await session.validate(revision);
  const baseline = await canonical(root);
  const ticket = await bridge.preparePublication(revision);
  revision = (
    await session.applyChanges({
      baseRevision: revision,
      mode: 'verified-explicit',
      changed: [],
      added: [],
      removed: [],
      renamed: [],
    })
  ).revision;
  await assert.rejects(bridge.commitPrepared(ticket), (error) =>
    error.diagnostics.some((item) => item.code === Codes.STALE_REVISION),
  );
  await session.validate(revision);
  const pending = await bridge.preparePublication(revision);
  await session.close();
  await assert.rejects(bridge.commitPrepared(pending), (error) =>
    error.diagnostics.some((item) => item.code === Codes.SESSION_CLOSED),
  );
  assert.equal((await canonical(root)).digest, baseline.digest);
  const reopened = await build(root);
  assert.equal(reopened.canonical.digest, baseline.digest);
  report.failures.push({
    name: 'close-with-prepared-ticket-and-reopen',
    pass: true,
    staleTicketRejected: true,
    closedTicketRejected: true,
    previousGenerationPreserved: true,
    mixedArtifacts: false,
    recoveryDigest: reopened.canonical.digest,
  });
}
