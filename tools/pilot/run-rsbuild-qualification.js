#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const output = path.resolve(
  process.argv[2] ?? path.join(repo, 'evidence/phase-11-rsbuild/qualification'),
);
const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-phase11-rsbuild-'));
fs.mkdirSync(output, { recursive: true });
const tarballs = path.join(consumer, '.tarballs');
fs.mkdirSync(tarballs);
const env = { ...process.env };
delete env.NODE_PATH;
function run(command, args, cwd = consumer) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 48 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout).slice(-10000)}`,
    );
  return result.stdout;
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) =>
  fs.writeFileSync(
    path.join(output, file),
    JSON.stringify(value, null, 2) + '\n',
  );
function captureRuntimeArtifacts(label) {
  for (const fixture of ['plain', 'start', 'isolation-a', 'isolation-b']) {
    const source = path.join(consumer, fixture);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(output, 'runtime-artifacts', label, fixture);
    fs.mkdirSync(destination, { recursive: true });
    for (const item of [
      'src',
      '.pandamstyle',
      'definition.mjs',
      'tsconfig.json',
      'package.json',
      'dist',
    ]) {
      if (fs.existsSync(path.join(source, item)))
        fs.cpSync(path.join(source, item), path.join(destination, item), {
          recursive: true,
        });
    }
  }
}
try {
  const proof = [];
  for (const slug of ['core', 'compiler', 'vite', 'rsbuild']) {
    const packed = JSON.parse(
      run(
        'npm',
        ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballs],
        path.join(repo, 'packages', slug),
      ),
    )[0];
    proof.push({
      ...packed,
      archiveSha256: sha(fs.readFileSync(path.join(tarballs, packed.filename))),
    });
  }
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    '{"private":true,"type":"module"}',
  );
  const candidates = [
    '@rsbuild/core@2.2.11',
    '@rspack/core@2.2.8',
    '@rsbuild/plugin-react@2.1.1',
    '@tanstack/react-start@1.168.60',
    'react@19.2.0',
    'react-dom@19.2.0',
    'playwright-core@1.56.1',
  ];
  run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    ...proof.map((item) => path.join(tarballs, item.filename)),
    ...candidates,
  ]);
  run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--save-dev',
    '--save-exact',
    'node22-start@npm:node@22.12.0',
    'node24-start@npm:node@24.21.0',
  ]);
  for (const name of [
    'qualify-rsbuild.mjs',
    'qualify-rsbuild-start.mjs',
    'qualify-rsbuild-failures.mjs',
    'rsbuild-start-boundary.mjs',
  ])
    fs.copyFileSync(
      path.join(repo, 'tools/pilot', name),
      path.join(consumer, name),
    );
  const realpaths = {};
  for (const slug of ['core', 'compiler', 'vite', 'rsbuild']) {
    const installed = fs.realpathSync(
      path.join(consumer, 'node_modules/@pandamstyle', slug),
    );
    assert(installed.startsWith(consumer + path.sep));
    assert(!installed.startsWith(repo + path.sep));
    realpaths[`@pandamstyle/${slug}`] = installed;
  }
  json('package-proof.json', {
    packages: proof,
    candidates,
    externalConsumer: consumer,
    realpaths,
    nodePathUsed: false,
    workspaceLeakage: 0,
  });
  fs.cpSync(tarballs, path.join(output, 'tarballs'), { recursive: true });
  fs.copyFileSync(
    path.join(consumer, 'package-lock.json'),
    path.join(output, 'external-package-lock.json'),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(consumer, 'qualify-rsbuild.mjs'),
      path.join(output, 'report.json'),
    ],
    { cwd: consumer, env, encoding: 'utf8', maxBuffer: 48 * 1024 * 1024 },
  );
  fs.writeFileSync(
    path.join(output, 'host.log'),
    result.stdout + result.stderr,
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.slice(-10000));
  const report = JSON.parse(
    fs.readFileSync(path.join(output, 'report.json'), 'utf8'),
  );
  assert.equal(report.complete, true);
  const boundary = path.join(consumer, 'node_modules/node22-start/bin/node');
  assert.equal(run(boundary, ['--version']).trim(), 'v22.12.0');
  const boundaryResult = spawnSync(
    boundary,
    [
      path.join(consumer, 'rsbuild-start-boundary.mjs'),
      path.join(output, 'start-node22-boundary.json'),
    ],
    { cwd: consumer, env, encoding: 'utf8', maxBuffer: 48 * 1024 * 1024 },
  );
  fs.writeFileSync(
    path.join(output, 'start-node22-boundary.log'),
    boundaryResult.stdout + boundaryResult.stderr,
  );
  if (boundaryResult.error) throw boundaryResult.error;
  assert.equal(boundaryResult.status, 0, boundaryResult.stderr.slice(-10000));
  const qualifiedBoundary = JSON.parse(
    fs.readFileSync(path.join(output, 'start-node22-boundary.json'), 'utf8'),
  );
  assert.equal(qualifiedBoundary.start.dev.pass, true);
  assert.equal(qualifiedBoundary.start.production.pass, true);
  report.startNodeMatrix = [qualifiedBoundary.node, report.node];
  captureRuntimeArtifacts('node22');
  const node24 = path.join(consumer, 'node_modules/node24-start/bin/node');
  assert.equal(run(node24, ['--version']).trim(), 'v24.21.0');
  const stableOutput = path.join(output, 'node24');
  fs.mkdirSync(stableOutput);
  const stableResult = spawnSync(
    node24,
    [
      path.join(consumer, 'qualify-rsbuild.mjs'),
      path.join(stableOutput, 'report.json'),
    ],
    {
      cwd: consumer,
      env,
      encoding: 'utf8',
      maxBuffer: 48 * 1024 * 1024,
    },
  );
  fs.writeFileSync(
    path.join(stableOutput, 'host.log'),
    stableResult.stdout + stableResult.stderr,
  );
  if (stableResult.error) throw stableResult.error;
  assert.equal(stableResult.status, 0, stableResult.stderr.slice(-10000));
  const stableReport = JSON.parse(
    fs.readFileSync(path.join(stableOutput, 'report.json'), 'utf8'),
  );
  assert.equal(stableReport.node, 'v24.21.0');
  assert.equal(stableReport.complete, true);
  captureRuntimeArtifacts('node24');
  report.stableNodeMatrix = [report.node, stableReport.node];
  report.startNodeMatrix.push(stableReport.node);
  report.node24Qualification = {
    required: true,
    complete: true,
    report: 'node24/report.json',
  };
  report.experimentalCompatibility = {
    required: false,
    support: 'experimental',
    node: 'v26.10.0',
    pass: false,
  };
  try {
    run('npm', [
      'install',
      '--save-dev',
      '--save-exact',
      '--no-audit',
      '--no-fund',
      'node26-start@npm:node@26.10.0',
    ]);
    const node26 = path.join(consumer, 'node_modules/node26-start/bin/node');
    assert.equal(run(node26, ['--version']).trim(), 'v26.10.0');
    const betaOutput = path.join(output, 'node26');
    fs.mkdirSync(betaOutput);
    const betaResult = spawnSync(
      node26,
      [
        path.join(consumer, 'qualify-rsbuild.mjs'),
        path.join(betaOutput, 'report.json'),
      ],
      {
        cwd: consumer,
        env,
        encoding: 'utf8',
        maxBuffer: 48 * 1024 * 1024,
      },
    );
    fs.writeFileSync(
      path.join(betaOutput, 'host.log'),
      betaResult.stdout + betaResult.stderr,
    );
    if (betaResult.error) throw betaResult.error;
    assert.equal(betaResult.status, 0, betaResult.stderr.slice(-10000));
    const betaReport = JSON.parse(
      fs.readFileSync(path.join(betaOutput, 'report.json'), 'utf8'),
    );
    assert.equal(betaReport.node, 'v26.10.0');
    assert.equal(betaReport.complete, true);
    captureRuntimeArtifacts('node26');
    report.experimentalCompatibility.pass = true;
    report.experimentalCompatibility.report = 'node26/report.json';
  } catch (error) {
    report.experimentalCompatibility.error = error.message;
  }
  json('report.json', report);
  fs.copyFileSync(
    path.join(consumer, 'package-lock.json'),
    path.join(output, 'external-package-lock.json'),
  );
  for (const fixture of ['plain', 'start', 'isolation-a', 'isolation-b']) {
    const source = path.join(consumer, fixture);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(output, 'fixtures', fixture);
    fs.mkdirSync(destination, { recursive: true });
    for (const item of [
      'src',
      '.pandamstyle',
      'definition.mjs',
      'tsconfig.json',
      'package.json',
    ]) {
      if (fs.existsSync(path.join(source, item)))
        fs.cpSync(path.join(source, item), path.join(destination, item), {
          recursive: true,
        });
    }
  }
  console.log(
    `Rsbuild qualification PASS: ${report.plain.dev.length} dev cases; ${report.failures.length} failure cases; Start dev/production SSR + hydration; ${output}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
