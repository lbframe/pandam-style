/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test-only process entry for exercising rollback inside publication. The
// production CLI deliberately has no failure-injection switch.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProjectSession,
  formatDiagnostic,
} from '../../packages/compiler/lib/index.mjs';

async function loadModule(file) {
  const namespace = await import(pathToFileURL(file).href);
  return namespace.default ?? namespace;
}

function reportFailure(error) {
  const diagnostic = {
    code: 'PMS_INJECTED_FAILURE',
    rule: 'test.inject-failure',
    severity: 'error',
    message: `Injected failure inside publication: ${error?.message ?? error}`,
    source: null,
  };
  process.stderr.write(`${formatDiagnostic(diagnostic)}\n`);
  process.stderr.write(
    `PMS_JSON:${JSON.stringify({ ok: false, diagnostics: [diagnostic] })}\n`,
  );
  process.exitCode = 1;
}

async function main() {
  const configPath = path.resolve(process.argv[2] ?? 'pandamstyle.config.js');
  let project;
  try {
    let config = await loadModule(configPath);
    if (typeof config === 'function') config = await config();
    const rootDir = path.dirname(configPath);
    const resolveRoot = (value) => path.resolve(rootDir, value);
    let definition = config.definitionObject;
    if (definition == null && config.definition != null) {
      definition = await loadModule(resolveRoot(config.definition));
    }
    project = createProjectSession({
      ...config,
      projectId: config.projectId ?? rootDir,
      rootDir,
      definition,
      roots: (config.roots ?? []).map(resolveRoot),
      outDir: resolveRoot(config.outDir ?? 'dist-pandamstyle'),
      publishFailAt: 'mid-stage',
    });
    const initial = await project.initialize();
    const result = await project.validate(initial.revision);
    if (!result.ok) {
      for (const diagnostic of result.agentResult?.diagnostics ?? []) {
        process.stderr.write(
          `${formatDiagnostic({ ...diagnostic, location: diagnostic.source })}\n`,
        );
      }
      process.stderr.write(`PMS_JSON:${JSON.stringify(result.agentResult)}\n`);
      process.exitCode = 1;
    } else {
      await project.requestFullAudit(result.revision);
      await project.compile(result.revision);
      process.stderr.write('expected publication failure did not occur\n');
      process.exitCode = 2;
    }
  } catch (error) {
    reportFailure(error);
  } finally {
    await project?.close();
  }
}

main().catch(reportFailure);
