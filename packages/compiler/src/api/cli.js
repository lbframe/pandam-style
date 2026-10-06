/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectSession, formatDiagnostic } from './index.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else {
      out[arg.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function loadModule(file) {
  const namespace = await import(pathToFileURL(file).href);
  return Object.hasOwn(namespace, 'default') ? namespace.default : namespace;
}

function printDiagnostics(diagnostics, format = formatDiagnostic) {
  for (const diagnostic of diagnostics) {
    process.stderr.write(
      `${format({
        ...diagnostic,
        location:
          diagnostic.source != null && typeof diagnostic.source === 'object'
            ? diagnostic.source
            : diagnostic.location,
      })}\n`,
    );
  }
  process.stderr.write(
    `PMS_JSON:${JSON.stringify({ ok: false, diagnostics })}\n`,
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.config) {
    process.stderr.write('usage: pms-build --config <build.config.js>\n');
    process.exitCode = 2;
    return;
  }

  const configPath = path.resolve(args.config);
  if (!(await fs.stat(configPath).catch(() => null))) {
    process.stderr.write(`config not found: ${configPath}\n`);
    process.exitCode = 2;
    return;
  }

  let config;
  try {
    config = await loadModule(configPath);
    if (typeof config === 'function') config = await config();
  } catch (error) {
    process.stderr.write(
      `failed to load config ${configPath}:\n${error?.stack ?? error}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (config == null || typeof config !== 'object') {
    process.stderr.write(
      `config must export an object, got ${typeof config}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const rootDir = path.dirname(configPath);
  const resolveRoot = (value) => path.resolve(rootDir, value);
  let definition = config.definitionObject;
  if (definition == null && config.definition != null) {
    const definitionPath = resolveRoot(config.definition);
    if (!(await fs.stat(definitionPath).catch(() => null))) {
      process.stderr.write(`definition not found: ${definitionPath}\n`);
      process.exitCode = 2;
      return;
    }
    try {
      definition = await loadModule(definitionPath);
    } catch (error) {
      process.stderr.write(
        `failed to load definition ${definitionPath}:\n${error?.stack ?? error}\n`,
      );
      process.exitCode = 2;
      return;
    }
  }

  let project;
  try {
    project = createProjectSession({
      ...config,
      projectId: config.projectId ?? rootDir,
      rootDir,
      definition,
      roots: (config.roots ?? []).map(resolveRoot),
      outDir: resolveRoot(config.outDir ?? 'dist-pandamstyle'),
    });
    const initial = await project.initialize();
    const result = await project.validate(initial.revision);
    if (!result.ok) {
      printDiagnostics(result.agentResult?.diagnostics ?? []);
      process.exitCode = 1;
      return;
    }

    // A one-shot build is its own complete consumer: write the detailed
    // coverage document as part of the same publication generation.
    await project.requestFullAudit(result.revision);
    const publication = await project.compile(result.revision);
    const outDir = resolveRoot(config.outDir ?? 'dist-pandamstyle');
    const css = await fs
      .readFile(path.join(outDir, 'styles.css'), 'utf8')
      .catch(() => '');
    process.stdout.write(
      `pandamstyle build ok registryDigest=${publication.designSystem.registryDigest ?? ''} ` +
        `files=${result.counters?.coveredFileCount ?? 0} cssBytes=${Buffer.byteLength(css)}\n`,
    );
  } catch (error) {
    const diagnostics = Array.isArray(error?.diagnostics)
      ? error.diagnostics
      : [];
    if (diagnostics.length > 0) {
      printDiagnostics(diagnostics);
      process.exitCode = 1;
    } else {
      process.stderr.write(
        `unexpected build error:\n${error?.stack ?? error}\n`,
      );
      process.exitCode = 2;
    }
  } finally {
    await project?.close();
  }
}
