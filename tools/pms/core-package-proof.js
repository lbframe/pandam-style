/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Pack and exercise @pandamstyle/core from a clean project outside the
 * workspace. The installed tarball, dependency graph and runtime checks become
 * qualification evidence; the fixture itself stays outside the repository.
 */
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { builtinModules } = require('module');

const repo = path.resolve(__dirname, '../..');
const packageDir = path.join(repo, 'packages/core');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function walkDependencies(node, names = []) {
  for (const [name, value] of Object.entries(node?.dependencies ?? {})) {
    names.push(name);
    walkDependencies(value, names);
  }
  return names;
}

function sourceImports(source) {
  const specifiers = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) specifiers.push(match[1]);
  return specifiers;
}

function isBuiltin(specifier) {
  const unprefixed = specifier.startsWith('node:')
    ? specifier.slice('node:'.length)
    : specifier;
  return (
    builtinModules.includes(specifier) || builtinModules.includes(unprefixed)
  );
}

function main(outDir) {
  const output = path.resolve(outDir);
  const tarballDir = path.join(output, 'tarball');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(tarballDir, { recursive: true });

  const packed = JSON.parse(
    run('npm', ['pack', '--json', '--pack-destination', tarballDir], {
      cwd: packageDir,
    }),
  )[0];
  const tarball = path.join(tarballDir, packed.filename);
  const inspectionDir = path.join(output, 'unpacked');
  fs.mkdirSync(inspectionDir, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', inspectionDir]);

  const unpackedPackage = path.join(inspectionDir, 'package');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(unpackedPackage, 'package.json'), 'utf8'),
  );
  assert.strictEqual(manifest.name, '@pandamstyle/core');
  assert.strictEqual(manifest.private, false);
  assert.strictEqual(manifest.type, 'module');
  assert.strictEqual(manifest.sideEffects, false);
  assert.deepStrictEqual(manifest.dependencies ?? {}, {});
  assert.strictEqual(manifest.exports['.'].require, undefined);

  const jsFiles = [];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.name.endsWith('.js')) jsFiles.push(file);
    }
  }
  collect(unpackedPackage);
  const imports = jsFiles.flatMap((file) =>
    sourceImports(fs.readFileSync(file, 'utf8')),
  );
  const nodeBuiltins = [...new Set(imports.filter(isBuiltin))].sort();
  const donorImports = imports.filter(
    (specifier) =>
      specifier.startsWith('@stylexjs/') || specifier.startsWith('@pandacss/'),
  );
  assert.deepStrictEqual(nodeBuiltins, []);
  assert.deepStrictEqual(donorImports, []);

  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pandamstyle-core-consumer-'),
  );
  fs.writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'pandamstyle-core-external-proof',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
  );
  const consumer = String.raw`import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { ABI_VERSION, PmsSelectionError, assertAbi, defineRecipeSelector, props } from '@pandamstyle/core';

const ref = (entries) => ({
  kind: 'pandamstyle-style-ref',
  abiVersion: ABI_VERSION,
  systemId: 'external-ui',
  entries,
});
const base = ref([['display', 'c-grid'], ['opacity', 'c-half']]);
const override = ref([['display', 'c-flex'], ['gap', 'c-gap']]);
const theme = {
  kind: 'pandamstyle-theme-ref',
  abiVersion: 1,
  systemId: 'external-ui',
  themeId: 'dark',
  entries: [['theme:colors', 'c-dark']],
};
assert.equal(assertAbi(1), 1);
assert.deepEqual(props(), {});
assert.deepEqual(props(null, false, undefined), {});
assert.equal(props(base, override, theme).className, 'c-half c-flex c-gap c-dark');

const spec = {
  abiVersion: 1,
  systemId: 'external-ui',
  recipeId: 'button',
  axisOrder: ['size'],
  variantMap: { size: ['sm', 'md'] },
  defaultVariants: { size: 'md' },
  base,
  branches: { size: { sm: ref([['padding', 'c-small']]), md: ref([['padding', 'c-medium']]) } },
};
const recipe = defineRecipeSelector(spec);
assert.deepEqual(recipe({ size: 'sm' }).entries, [
  ...base.entries,
  ['padding', 'c-small'],
]);
assert.equal(props(recipe()).className, 'c-grid c-half c-medium');
assert.deepEqual(recipe.variantKeys, ['size']);
assert.equal(recipe.getVariantProps({ size: 'sm' }).size, 'sm');
assert.deepEqual(recipe.splitVariantProps({ size: 'sm', id: 'x' }), [{ size: 'sm' }, { id: 'x' }]);

let malformed;
try {
  props({ className: 'invented' });
} catch (error) {
  malformed = error;
}
assert(malformed instanceof PmsSelectionError);
assert.equal(malformed.code, 'PMS_UNVERIFIED_PROPS_SOURCE');
let abiMismatch;
try {
  assertAbi(2);
} catch (error) {
  abiMismatch = error;
}
assert.equal(abiMismatch.code, 'PMS_ABI_MISMATCH');

function benchmark(fn, iterations) {
  for (let index = 0; index < 100; index++) fn();
  const start = performance.now();
  for (let index = 0; index < iterations; index++) fn();
  return { iterations, elapsedMs: Number((performance.now() - start).toFixed(3)) };
}
const repeated = Array.from({ length: 128 }, () => base);
const benchmarkResults = {
  singleStyleRef: benchmark(() => props(base), 10000),
  multipleStyleRefs: benchmark(() => props(base, override, theme), 10000),
  recipeSelection: benchmark(() => recipe({ size: 'sm' }), 10000),
  largeRepeatedComposition: benchmark(() => props(repeated), 1000),
};
console.log(JSON.stringify({
  resolved: import.meta.resolve('@pandamstyle/core'),
  benchmarkResults,
}));
`;
  fs.writeFileSync(path.join(fixture, 'consumer.mjs'), consumer);
  run('npm', [
    'install',
    '--prefix',
    fixture,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    tarball,
  ]);
  const consumerResult = JSON.parse(
    run(process.execPath, [path.join(fixture, 'consumer.mjs')], {
      cwd: fixture,
    }),
  );
  const resolvedPath = fs.realpathSync(fileURLToPath(consumerResult.resolved));
  assert(
    resolvedPath.startsWith(path.join(fixture, 'node_modules') + path.sep),
  );
  assert(!resolvedPath.startsWith(repo + path.sep));

  const dependencyGraph = JSON.parse(
    run('npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: fixture }),
  );
  const dependencyNames = walkDependencies(dependencyGraph).sort();
  assert.deepStrictEqual(
    dependencyNames.filter(
      (name) => name.startsWith('@stylexjs/') || name.startsWith('@pandacss/'),
    ),
    [],
  );
  assert.deepStrictEqual(dependencyNames, ['@pandamstyle/core']);

  const proof = {
    package: manifest.name,
    version: manifest.version,
    tarball: path.relative(repo, tarball),
    tarballBytes: packed.size,
    installedPath: resolvedPath,
    fixturePath: fixture,
    workspaceLeakage: false,
    exports: Object.keys(manifest.exports),
    runtimeDependencies: manifest.dependencies ?? {},
    dependencyGraph: dependencyNames,
    stylexDependencyCount: dependencyNames.filter((name) =>
      name.startsWith('@stylexjs/'),
    ).length,
    pandacssDependencyCount: dependencyNames.filter((name) =>
      name.startsWith('@pandacss/'),
    ).length,
    nodeBuiltinImports: nodeBuiltins,
    donorRuntimeImports: donorImports,
    runtimeChecks: {
      composition: 'passed',
      recipeSelection: 'passed',
      malformedRefCode: 'PMS_UNVERIFIED_PROPS_SOURCE',
      unsupportedAbiCode: 'PMS_ABI_MISMATCH',
    },
    benchmark: consumerResult.benchmarkResults,
  };
  fs.writeFileSync(
    path.join(output, 'proof.json'),
    JSON.stringify(proof, null, 2) + '\n',
  );
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
}

function fileURLToPath(value) {
  return require('url').fileURLToPath(value);
}

if (require.main === module) {
  try {
    main(process.argv[2] ?? path.join(repo, 'evidence/core-package-proof'));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { main };
