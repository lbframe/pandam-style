#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle build CLI.
 *
 * A real process boundary: the exit status observed by a parent process is the
 * status of THIS process, not an object fabricated inside a test.
 *
 *   0  build succeeded, artifacts written
 *   1  policy / coverage failure (PMS_*), artifacts NOT published as current
 *   2  usage or environment error
 *
 * Diagnostics are printed to stderr as human-readable lines AND as a single
 * JSON document on the last stderr line (prefixed with `PMS_JSON:`), so a test
 * can assert both the cause and the status.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config;
  if (!configPath) {
    fail('usage: pms-build --config <build.config.js>', 2);
  }
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    fail(`config not found: ${abs}`, 2);
  }

  let config;
  try {
    // eslint-disable-next-line
    config = require(abs);
  } catch (err) {
    fail(
      `failed to load config ${abs}:\n${err && err.stack ? err.stack : err}`,
      2,
    );
  }
  if (typeof config === 'function') config = config();
  if (config == null || typeof config !== 'object') {
    fail(`config must export an object, got ${typeof config}`, 2);
  }

  // The design system definition is a separate input file, so a test can mutate
  // the design system without touching a page file.
  const definitionPath = config.definition
    ? path.resolve(path.dirname(abs), config.definition)
    : null;
  if (definitionPath != null && !fs.existsSync(definitionPath)) {
    fail(`definition not found: ${definitionPath}`, 2);
  }

  let build;
  let definition = config.definitionObject;
  if (definition == null && definitionPath != null) {
    try {
      // eslint-disable-next-line
      definition = require(definitionPath);
      if (definition != null && definition.default != null)
        definition = definition.default;
    } catch (err) {
      fail(
        `failed to load definition ${definitionPath}:\n${err && err.stack ? err.stack : err}`,
        2,
      );
    }
  }

  const rootDir = path.dirname(abs);
  const resolveRoot = (r) => (path.isAbsolute(r) ? r : path.join(rootDir, r));

  try {
    // eslint-disable-next-line
    build = require(path.join(__dirname, '..', 'lib', 'index.js'));
  } catch (err) {
    fail(
      `pandamstyle compiler is not built (expected lib/index.js):\n${
        err && err.message ? err.message : err
      }`,
      2,
    );
  }

  let result;
  try {
    result = build.buildProject({
      definition,
      roots: (config.roots ?? []).map(resolveRoot),
      outDir: resolveRoot(config.outDir ?? 'dist-pandamstyle'),
      runtimeModule: config.runtimeModule,
      designSystemFile: config.designSystemFile,
      engineOptions: config.engineOptions,
      useCSSLayers: config.useCSSLayers === true,
    });
  } catch (err) {
    const diagnostics = err != null ? err.diagnostics : null;
    if (Array.isArray(diagnostics) && diagnostics.length > 0) {
      for (const d of diagnostics) {
        process.stderr.write(`${build.formatDiagnostic(d)}\n`);
      }
      process.stderr.write(
        `PMS_JSON:${JSON.stringify({
          ok: false,
          code: diagnostics[0].code,
          diagnosticCount: diagnostics.length,
          diagnostics,
        })}\n`,
      );
      process.exit(1);
    }
    process.stderr.write(
      `unexpected build error:\n${err && err.stack ? err.stack : err}\n`,
    );
    process.exit(2);
  }

  process.stdout.write(
    `pandamstyle build ok registryDigest=${result.registryDigest} ` +
      `files=${result.coverage.length} cssBytes=${result.buildReport.cssBytes}\n`,
  );
  process.exit(0);
}

main();
