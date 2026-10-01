#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/*
 * Qualify the public packages as npm tarballs from an external consumer.
 * Every consumer command runs with NODE_PATH unset, and the repository's
 * packages/ tree is temporarily moved out of the way while imports, CLI, SDK,
 * types, and browser bundles are exercised.
 */
'use strict';

const assert = require('node:assert/strict');
const { parse } = require('@babel/parser');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const REPO = path.resolve(__dirname, '../..');
const CORE_DIR = path.join(REPO, 'packages/core');
const COMPILER_DIR = path.join(REPO, 'packages/compiler');
const EXPECTED = {
  '@pandamstyle/core': {
    directory: CORE_DIR,
    exports: ['.', './package.json'],
  },
  '@pandamstyle/compiler': {
    directory: COMPILER_DIR,
    exports: ['.', './config', './host', './package.json'],
  },
};
const TOOL_VERSIONS = {
  typescript: '5.9.3',
  rollup: '4.59.0',
  '@rollup/plugin-node-resolve': '15.3.0',
  node: '20.0.0',
};
const DONOR_RE = /^@(stylexjs|pandacss)\//;
const BUNDLE_FORBIDDEN_RE =
  /@pandamstyle\/compiler|@babel\/|@stylexjs\/|@pandacss\//;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function safeEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_PATH;
  return env;
}

function invoke(command, args, options = {}) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO,
    env: safeEnv(options.env),
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Number((performance.now() - started).toFixed(3));
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs,
  };
}

function requireSuccess(command, args, options = {}) {
  const result = invoke(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal}):\n${(result.stderr || result.stdout).slice(-8000)}`,
    );
  }
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listFiles(root) {
  const output = [];
  function walk(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) output.push(file);
      else if (entry.isSymbolicLink()) output.push(file);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return output;
}

function fileInventory(root) {
  return listFiles(root).map((file) => {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const stat = fs.lstatSync(file);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(`symlink:${fs.readlinkSync(file)}`)
      : fs.readFileSync(file);
    return { path: relative, size: bytes.length, sha256: sha256(bytes) };
  });
}

function importsOf(source) {
  const found = [];
  const ast = parse(source, {
    sourceType: 'unambiguous',
    plugins: ['jsx', 'typescript'],
  });
  function visit(node) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node == null || typeof node !== 'object') return;
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      node.source?.type === 'StringLiteral'
    ) {
      found.push(node.source.value);
    } else if (
      node.type === 'ImportExpression' &&
      node.source?.type === 'StringLiteral'
    ) {
      found.push(node.source.value);
    } else if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Import' &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      found.push(node.arguments[0].value);
    }
    for (const [key, value] of Object.entries(node)) {
      if (
        key !== 'loc' &&
        key !== 'start' &&
        key !== 'end' &&
        key !== 'comments' &&
        key !== 'tokens'
      )
        visit(value);
    }
  }
  visit(ast.program);
  return found;
}

function isBuiltin(specifier) {
  const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return builtinModules.includes(specifier) || builtinModules.includes(name);
}

function barePackageName(specifier) {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    isBuiltin(specifier)
  )
    return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function collectTargets(value, result = []) {
  if (typeof value === 'string') result.push(value);
  else if (value != null && typeof value === 'object') {
    for (const item of Object.values(value)) collectTargets(item, result);
  }
  return result;
}

function packageManifestAudit(name, manifest, unpackedPackage) {
  const expected = EXPECTED[name];
  assert(expected, `unexpected packed package ${name}`);
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.private, false);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(
    Object.keys(manifest.exports).sort(),
    [...expected.exports].sort(),
  );
  assert.equal(manifest.repository?.type, 'git');
  assert.equal(
    manifest.repository?.url,
    'https://github.com/lbframe/pandam-style.git',
  );
  assert.equal(
    manifest.repository?.directory,
    `packages/${name.endsWith('/core') ? 'core' : 'compiler'}`,
  );

  const targets = [];
  for (const [subpath, targetValue] of Object.entries(manifest.exports)) {
    for (const target of collectTargets(targetValue)) {
      assert(
        target.startsWith('./'),
        `${name} export ${subpath} target must be package-relative: ${target}`,
      );
      const absolute = path.resolve(unpackedPackage, target);
      assert(
        inside(unpackedPackage, absolute),
        `${name} export ${subpath} escapes package: ${target}`,
      );
      assert(
        fs.existsSync(absolute),
        `${name} export ${subpath} target is absent: ${target}`,
      );
      targets.push({ subpath, target });
    }
  }
  if (manifest.types)
    assert(
      fs.existsSync(
        path.join(unpackedPackage, manifest.types.replace(/^\.\//, '')),
      ),
      `${name} types target is absent`,
    );
  if (manifest.module)
    assert(
      fs.existsSync(
        path.join(unpackedPackage, manifest.module.replace(/^\.\//, '')),
      ),
      `${name} module target is absent`,
    );
  if (manifest.bin) {
    for (const [binName, target] of Object.entries(manifest.bin)) {
      assert(
        fs.existsSync(path.join(unpackedPackage, target.replace(/^\.\//, ''))),
        `${name} bin ${binName} target is absent`,
      );
    }
  }
  assert.equal(
    manifest.exports['.']?.require,
    undefined,
    `${name} must remain ESM-only`,
  );

  const dependencies = manifest.dependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  const optionalDependencies = manifest.optionalDependencies ?? {};
  for (const [kind, values] of Object.entries({
    dependencies,
    peerDependencies,
    optionalDependencies,
  })) {
    for (const [dependency, version] of Object.entries(values)) {
      assert(
        !/^workspace:|^file:/i.test(version),
        `${name} ${kind} has a workspace/local reference: ${dependency}=${version}`,
      );
      assert(
        !DONOR_RE.test(dependency),
        `${name} ${kind} depends on donor package ${dependency}`,
      );
    }
  }
  if (name === '@pandamstyle/core') {
    assert.deepEqual(dependencies, {});
    assert.equal(manifest.sideEffects, false);
    assert.equal(
      manifest.engines,
      undefined,
      'browser runtime must not inherit compiler Node restrictions',
    );
    assert.equal(manifest.exports['.'].import, './src/index.js');
    assert.equal(manifest.exports['.'].types, './src/types.ts');
  } else {
    assert.equal(manifest.engines?.node, '>=20.0.0');
    assert.equal(manifest.dependencies['@pandamstyle/core'], '0.1.0');
    assert.equal(manifest.exports['.'].import, './lib/index.mjs');
    assert.equal(manifest.exports['./config'].import, './lib/config.mjs');
    assert.equal(manifest.exports['./host'].import, './lib/host.mjs');
    assert.equal(manifest.bin?.['pms-build'], './bin/pms-build.js');
  }
  return {
    name,
    version: manifest.version,
    private: manifest.private,
    type: manifest.type,
    exports: manifest.exports,
    exportTargets: targets,
    types: manifest.types ?? null,
    bin: manifest.bin ?? null,
    files: manifest.files ?? null,
    sideEffects: manifest.sideEffects ?? null,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines: manifest.engines ?? null,
    license: manifest.license,
    repository: manifest.repository,
  };
}

function assertTarballContents(name, inventory) {
  const allowed =
    name === '@pandamstyle/core'
      ? (file) =>
          file === 'package.json' ||
          file === 'LICENSE' ||
          file === 'ATTRIBUTIONS.md' ||
          file.startsWith('src/')
      : (file) =>
          file === 'package.json' ||
          file === 'LICENSE' ||
          file === 'ATTRIBUTIONS.md' ||
          file.startsWith('lib/') ||
          file.startsWith('bin/') ||
          file.startsWith('types/') ||
          file.startsWith('LICENSES/') ||
          file === 'docs/architecture/phase-4-derived-source-provenance.md' ||
          file === 'docs/architecture/phase-4-engine-absorption-map.md';
  const paths = inventory.map((item) => item.path);
  const accidental = paths.filter((file) => !allowed(file));
  assert.deepEqual(
    accidental,
    [],
    `${name} tarball has accidental files: ${accidental.join(', ')}`,
  );
  for (const pathName of paths) {
    assert(
      !/(^|\/)(?:__tests__|tests|benchmarks|evidence|fixtures|\.git|node_modules)(?:\/|$)/i.test(
        pathName,
      ),
      `${name} tarball contains excluded path ${pathName}`,
    );
    assert(
      !/(?:worktree|cmux-drop|\.log$)/i.test(pathName),
      `${name} tarball contains temporary material ${pathName}`,
    );
  }
  if (name === '@pandamstyle/compiler') {
    assert(
      !paths.some((file) => file.startsWith('src/')),
      'compiler source tree must not ship',
    );
    assert(
      paths.includes('lib/index.mjs') &&
        paths.includes('lib/config.mjs') &&
        paths.includes('lib/host.mjs') &&
        paths.includes('lib/cli.mjs'),
    );
    assert(
      paths.includes('bin/pms-build.js') &&
        paths.includes('types/index.d.ts') &&
        paths.includes('types/config.d.ts') &&
        paths.includes('types/host.d.ts'),
    );
  } else {
    assert(paths.includes('src/index.js') && paths.includes('src/types.ts'));
  }
}

function packOne(name, destination, suffix, commandLog) {
  fs.mkdirSync(destination, { recursive: true });
  const result = requireSuccess(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
    { cwd: EXPECTED[name].directory },
  );
  const metadata = JSON.parse(result.stdout);
  assert.equal(
    metadata.length,
    1,
    `npm pack produced an unexpected number of tarballs for ${name}`,
  );
  const entry = metadata[0];
  const archive = path.join(destination, entry.filename);
  assert(fs.existsSync(archive), `npm pack did not create ${archive}`);
  const unpacked = path.join(destination, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  requireSuccess('tar', ['-xzf', archive, '-C', unpacked]);
  const packageDir = path.join(unpacked, 'package');
  const manifest = readJson(path.join(packageDir, 'package.json'));
  const inventory = fileInventory(packageDir);
  const inventoryDigest = sha256(Buffer.from(JSON.stringify(inventory)));
  const packReport = {
    ...entry,
    packageName: name,
    packDurationMs: result.durationMs,
    archivePath: archive,
    unpackedPackagePath: packageDir,
    contentInventoryDigest: inventoryDigest,
    unpackedFileCount: inventory.length,
    completeFileList: inventory,
  };
  writeJson(path.join(destination, `npm-pack-${suffix}.json`), metadata);
  commandLog.push({
    name: `npm-pack-${name}-${suffix}`,
    command: 'npm pack --json',
    exitCode: 0,
    durationMs: result.durationMs,
  });
  return { entry, archive, packageDir, manifest, inventory, packReport };
}

function comparePackContents(first, second, name) {
  const firstMap = new Map(
    first.inventory.map((item) => [item.path, item.sha256]),
  );
  const secondMap = new Map(
    second.inventory.map((item) => [item.path, item.sha256]),
  );
  const firstFiles = [...firstMap.keys()].sort();
  const secondFiles = [...secondMap.keys()].sort();
  assert.deepEqual(
    firstFiles,
    secondFiles,
    `${name} file list changed between npm pack runs`,
  );
  const differences = firstFiles.filter(
    (file) => firstMap.get(file) !== secondMap.get(file),
  );
  assert.deepEqual(
    differences,
    [],
    `${name} package content changed between npm pack runs`,
  );
  return {
    fileListStable: true,
    contentDigestsStable: true,
    archiveByteIdentical:
      sha256(fs.readFileSync(first.archive)) ===
      sha256(fs.readFileSync(second.archive)),
    archiveSha256: [
      sha256(fs.readFileSync(first.archive)),
      sha256(fs.readFileSync(second.archive)),
    ],
    contentInventoryDigest: first.packReport.contentInventoryDigest,
  };
}

function resolveInstalledPackage(parentDir, name) {
  let current = parentDir;
  while (true) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json')))
      return fs.realpathSync(candidate);
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function installedDependencyGraph(consumerDir) {
  const roots = ['@pandamstyle/core', '@pandamstyle/compiler'];
  const visited = new Map();
  const queue = roots.map((name) => ({
    name,
    dir: resolveInstalledPackage(consumerDir, name),
    requestedBy: 'consumer',
  }));
  const missing = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current.dir) {
      missing.push({ name: current.name, requestedBy: current.requestedBy });
      continue;
    }
    const real = fs.realpathSync(current.dir);
    if (visited.has(real)) continue;
    const manifest = readJson(path.join(real, 'package.json'));
    visited.set(real, {
      name: manifest.name ?? current.name,
      version: manifest.version ?? null,
      realpath: real,
      sizeBytes: fileInventory(real).reduce((n, f) => n + f.size, 0),
    });
    const dependencyGroups = [
      manifest.dependencies ?? {},
      manifest.optionalDependencies ?? {},
      manifest.peerDependencies ?? {},
    ];
    for (const dependencies of dependencyGroups) {
      for (const dependency of Object.keys(dependencies)) {
        const resolved = resolveInstalledPackage(real, dependency);
        if (resolved)
          queue.push({
            name: dependency,
            dir: resolved,
            requestedBy: manifest.name ?? current.name,
          });
        else if (
          Object.hasOwn(manifest.optionalDependencies ?? {}, dependency)
        ) {
          // An optional dependency may be absent on the current platform.
        } else if (
          Object.hasOwn(manifest.peerDependenciesMeta ?? {}, dependency) &&
          manifest.peerDependenciesMeta[dependency].optional === true
        ) {
          // Optional peer dependencies are not required for package closure.
        } else
          missing.push({
            name: dependency,
            requestedBy: manifest.name ?? current.name,
          });
      }
    }
  }
  const packages = [...visited.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  return {
    packages,
    missing,
    totalInstalledBytes: packages.reduce((n, item) => n + item.sizeBytes, 0),
  };
}

function externalFixtureFiles(consumerDir) {
  const pkg = {
    name: 'pandamstyle-phase-9-external-consumer',
    private: true,
    type: 'module',
    scripts: { build: 'pms-build --config ./pandamstyle.config.mjs' },
  };
  fs.writeFileSync(
    path.join(consumerDir, 'package.json'),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'pandamstyle.config.mjs'),
    `export default {
  definition: './design-system.mjs',
  roots: ['./src'],
  outDir: './generated',
  designSystemFile: 'design.js',
};
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'design-system.mjs'),
    String.raw`import { token } from '@pandamstyle/compiler/config';

export default {
  systemId: 'phase-9-external@0.1',
  tokens: {
    spacing: {
      sm: { value: '8px', visibility: 'public' },
      md: { value: '16px', visibility: 'public' },
      lg: { value: '24px', visibility: 'public' },
    },
      colors: {
        brand: { value: '#2457d6', visibility: 'public' },
        ink: { value: '#172033', visibility: 'public' },
        onBrand: { value: '#ffffff', visibility: 'public' },
        quietSurface: { value: '#eef2ff', visibility: 'public' },
        warningText: { value: '#92400e', visibility: 'public' },
        hiddenInk: { value: '#991b1b', visibility: 'private' },
      },
    radii: {
      sm: { value: '4px', visibility: 'public' },
    },
  },
  themes: {
    light: { tokens: {} },
    dark: { tokens: { colors: { ink: { value: '#f8fafc' } } } },
  },
  conditions: {
    hover: ':hover',
    wide: '@media (min-width: 720px)',
  },
  recipes: {
    button: {
      base: { display: 'inline-flex', borderRadius: token('radii.sm') },
      variants: {
        tone: {
          brand: { backgroundColor: token('colors.brand'), color: token('colors.onBrand') },
          quiet: { backgroundColor: token('colors.quietSurface'), color: token('colors.ink') },
        },
        size: {
          sm: { padding: token('spacing.sm') },
          md: { padding: token('spacing.md') },
        },
      },
      defaultVariants: { tone: 'brand', size: 'md' },
    },
    notice: {
      base: { display: 'block', padding: token('spacing.sm') },
      variants: {
        kind: {
          info: { color: token('colors.ink') },
          warning: { color: token('colors.warningText') },
        },
      },
      defaultVariants: { kind: 'info' },
    },
  },
};
`,
  );
  fs.mkdirSync(path.join(consumerDir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(consumerDir, 'src/app.tsx'),
    String.raw`import { create, token, themes, recipes, props } from '../generated/design.js';

const layout = create({
  root: {
    display: 'flex',
    gap: token('spacing.md'),
    padding: { base: token('spacing.sm'), wide: token('spacing.lg') },
  },
});

export function App() {
  return (
    <main {...props(themes.light, layout.root)}>
      <button {...props(recipes.button({ tone: 'brand', size: 'md' }))}>
        Continue
      </button>
    </main>
  );
}
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          jsx: 'preserve',
          skipLibCheck: false,
        },
        include: ['types-positive.ts', 'types-negative.ts'],
      },
      null,
      2,
    )}\n`,
  );
}

function createTypeFixtures(consumerDir) {
  fs.writeFileSync(
    path.join(consumerDir, 'types-positive.ts'),
    String.raw`import {
  ABI_VERSION,
  PmsSelectionError,
  assertAbi,
  defineRecipeSelector,
  props,
} from '@pandamstyle/core';
import type {
  CompositionInput,
  CompositionProps,
  PmsRuntimeDiagnostic,
  RecipeRef,
  RecipeSelection,
  RecipeSpec,
  StyleRef,
  ThemeRef,
  TokenRef as CoreTokenRef,
} from '@pandamstyle/core';
import { defineConfig, token } from '@pandamstyle/compiler/config';
import type {
  Definition,
  DiagnosticsResult,
  MutationTransaction,
  ProjectConfig,
  ProjectSession,
  PublicationReceipt,
  RevisionIdentity,
} from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';
import type { ArtifactResult, HostBridge } from '@pandamstyle/compiler/host';
import { create, recipes, themes, token as generatedToken } from './generated/design.js';

const style: StyleRef = {
  kind: 'pandamstyle-style-ref',
  abiVersion: ABI_VERSION,
  systemId: 'phase-9-external@0.1',
  entries: [['display', 'u-grid']],
};
const theme: ThemeRef = {
  kind: 'pandamstyle-theme-ref',
  abiVersion: 1,
  systemId: 'phase-9-external@0.1',
  themeId: 'light',
  entries: [],
};
const coreToken: CoreTokenRef<'spacing', 'spacing.md'> = null as unknown as CoreTokenRef<'spacing', 'spacing.md'>;
const coreRecipeSpec: RecipeSpec = {
  abiVersion: 1,
  systemId: 'phase-9-external@0.1',
  recipeId: 'typed-button',
  axisOrder: ['size'],
  variantMap: { size: ['sm', 'md'] },
  defaultVariants: { size: 'md' },
  base: style,
  branches: { size: { sm: style, md: style } },
};
const coreRecipe: RecipeRef = defineRecipeSelector(coreRecipeSpec);
const selection: RecipeSelection = { size: 'sm' };
const selected: StyleRef = coreRecipe(selection);
const composition: CompositionInput = [style, theme, selected];
const propsResult: CompositionProps = props(composition);
const runtimeDiagnostic: PmsRuntimeDiagnostic | null = null;
const runtimeError = new PmsSelectionError({ code: 'PMS_INVALID_VARIANT_VALUE' });
const abi: 1 = assertAbi(ABI_VERSION);

const definition: Definition = {
  systemId: 'phase-9-external@0.1',
  tokens: { spacing: { md: { value: '16px', visibility: 'public' } } },
};
const config: ProjectConfig = {
  rootDir: '.',
  definition,
  roots: ['./src'],
  auditPolicy: 'reference',
};
declare const session: ProjectSession;
const revision: RevisionIdentity = { projectId: 'p', sessionId: 's', revisionId: 1 };
const mutation: MutationTransaction = {
  baseRevision: revision,
  mode: 'verified-explicit',
  changed: ['src/app.tsx'],
  added: [],
  removed: [],
  renamed: [],
};
const diagnostics: Promise<DiagnosticsResult> = session.validate(revision);
const publication: Promise<PublicationReceipt> = session.compile(revision);
const read: Promise<ArtifactResult> = session.readArtifact(revision, 'src/app.tsx');
const host: HostBridge = createHostBridge(session);
const hostRead: Promise<ArtifactResult> = host.readArtifact(revision, 'src/app.tsx');
const authored = defineConfig({ systemId: 'typed@1', token: token('spacing.md') });
const generatedStyle = create({ pad: { padding: generatedToken('spacing.md') } });
const generatedResponsiveStyle = create({ responsive: { padding: { base: generatedToken('spacing.md'), wide: generatedToken('spacing.lg') } } });
const generatedRecipe: StyleRef = recipes.button({ tone: 'brand', size: 'sm' });
const generatedTheme: ThemeRef = themes.light;

void [coreToken, runtimeDiagnostic, runtimeError, abi, config, mutation, diagnostics, publication, read, hostRead, authored, generatedStyle, generatedResponsiveStyle, generatedRecipe, generatedTheme];
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'types-negative.ts'),
    String.raw`import { props } from '@pandamstyle/core';
import type { CompositionInput, StyleRef } from '@pandamstyle/core';
import { create, recipes, themes, token } from './generated/design.js';

// @ts-expect-error private token paths are absent from the generated type surface
token('colors.hiddenInk');
// @ts-expect-error token paths are finite and public
token('spacing.unknown');
// @ts-expect-error recipe axis values are finite
recipes.button({ tone: 'danger' });
// @ts-expect-error recipe axis values are finite
recipes.button({ size: 'xl' });
// @ts-expect-error generated condition names are finite
const invalidCondition = create({ responsive: { padding: { wideScreen: token('spacing.md') } } });
// @ts-expect-error generated theme names are finite
themes.sepia;
// @ts-expect-error arbitrary class objects are not CompositionInput
const invalidComposition: CompositionInput = { className: 'invented' };
// @ts-expect-error ABI version is fixed by the public runtime type
const invalidStyle: StyleRef = { kind: 'pandamstyle-style-ref', abiVersion: 2, systemId: 'x', entries: [] };
// @ts-expect-error props only accepts compiled references and omissions
props({ className: 'invented' });

void [invalidComposition, invalidStyle, invalidCondition];
`,
  );
}

function makeRuntimeSmoke(consumerDir) {
  fs.writeFileSync(
    path.join(consumerDir, 'runtime-smoke.mjs'),
    String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as core from '@pandamstyle/core';
import * as compiler from '@pandamstyle/compiler';
import * as configApi from '@pandamstyle/compiler/config';
import { createHostBridge } from '@pandamstyle/compiler/host';

const root = process.cwd();
const require = createRequire(import.meta.url);
assert.deepEqual(Object.keys(core).sort(), ['ABI_VERSION', 'PmsSelectionError', 'assertAbi', 'defineRecipeSelector', 'props']);
assert.deepEqual(Object.keys(compiler).sort(), ['COMPILER_ABI_VERSION', 'Codes', 'DIAGNOSTICS_RESULT_KIND', 'DIAGNOSTICS_RESULT_SCHEMA_VERSION', 'PmsError', 'createProjectSession', 'formatDiagnostic']);
assert.deepEqual(Object.keys(configApi).sort(), ['defineConfig', 'token']);
assert.deepEqual(Object.keys(await import('@pandamstyle/compiler/host')).sort(), ['createHostBridge']);
assert.equal(compiler.COMPILER_ABI_VERSION, core.ABI_VERSION);

const resolved = {};
const packageJsonPaths = {
  '@pandamstyle/core': require.resolve('@pandamstyle/core/package.json'),
  '@pandamstyle/compiler': require.resolve('@pandamstyle/compiler/package.json'),
};
for (const [specifier, relativeTarget] of [
  ['@pandamstyle/core', 'src/index.js'],
  ['@pandamstyle/compiler', 'lib/index.mjs'],
  ['@pandamstyle/compiler/config', 'lib/config.mjs'],
  ['@pandamstyle/compiler/host', 'lib/host.mjs'],
  ['@pandamstyle/compiler/package.json', 'package.json'],
]) {
  const packageName = specifier === '@pandamstyle/core' ? '@pandamstyle/core' : '@pandamstyle/compiler';
  const real = fs.realpathSync(path.join(path.dirname(packageJsonPaths[packageName]), relativeTarget));
  assert(real.startsWith(path.join(root, 'node_modules') + path.sep), specifier + ' resolved outside the external install: ' + real);
  resolved[specifier] = real;
}
const privateSubpathsRejected = [];
for (const specifier of [
  '@pandamstyle/core/src/props.js',
  '@pandamstyle/compiler/lib/index.mjs',
  '@pandamstyle/compiler/private',
]) {
  await assert.rejects(import(specifier), (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
  privateSubpathsRejected.push(specifier);
}

const packageJson = JSON.parse(fs.readFileSync(resolved['@pandamstyle/compiler/package.json'], 'utf8'));
assert.equal(packageJson.type, 'module');
const { ABI_VERSION, PmsSelectionError, assertAbi, defineRecipeSelector, props } = core;
const ref = (entries) => ({ kind: 'pandamstyle-style-ref', abiVersion: ABI_VERSION, systemId: 'external-ui', entries });
const base = ref([['display', 'c-grid'], ['opacity', 'c-half']]);
const override = ref([['display', 'c-flex'], ['gap', 'c-gap']]);
const theme = { kind: 'pandamstyle-theme-ref', abiVersion: 1, systemId: 'external-ui', themeId: 'dark', entries: [['theme:colors', 'c-dark']] };
assert.equal(assertAbi(1), 1);
assert.deepEqual(props(), {});
assert.deepEqual(props(null, false, undefined), {});
assert.equal(props(base, override, theme).className, 'c-half c-flex c-gap c-dark');
const recipe = defineRecipeSelector({
  abiVersion: 1,
  systemId: 'external-ui',
  recipeId: 'button',
  axisOrder: ['size'],
  variantMap: { size: ['sm', 'md'] },
  defaultVariants: { size: 'md' },
  base,
  branches: { size: { sm: ref([['padding', 'c-small']]), md: ref([['padding', 'c-medium']]) } },
});
assert.deepEqual(recipe({ size: 'sm' }).entries, [...base.entries, ['padding', 'c-small']]);
assert.equal(props(recipe()).className, 'c-grid c-half c-medium');
assert.deepEqual(recipe.variantKeys, ['size']);
assert.equal(recipe.getVariantProps({ size: 'sm' }).size, 'sm');
assert.deepEqual(recipe.splitVariantProps({ size: 'sm', id: 'x' }), [{ size: 'sm' }, { id: 'x' }]);
assert.throws(() => recipe({ size: 'xl' }), (error) => error instanceof PmsSelectionError && error.code === 'PMS_INVALID_VARIANT_VALUE');
assert.throws(() => props({ className: 'invented' }), (error) => error instanceof PmsSelectionError && error.code === 'PMS_UNVERIFIED_PROPS_SOURCE');
assert.throws(() => assertAbi(2), (error) => error.code === 'PMS_ABI_MISMATCH');

const configValue = { systemId: 'external-config@1' };
assert.equal(configApi.defineConfig(configValue), configValue);
assert.equal(Object.getOwnPropertySymbols(configApi.token('spacing.md')).length, 1);
let hostCalls = 0;
const fakeProject = {
  marker: 4,
  async readArtifact() { hostCalls += this.marker; return 'read'; },
  async preparePublication() { hostCalls += this.marker; return 'ticket'; },
  async commitPrepared() { hostCalls += this.marker; return 'committed'; },
  async abortPrepared() { hostCalls += this.marker; return true; },
};
const host = createHostBridge(fakeProject);
assert.equal(Object.isFrozen(host), true);
assert.equal(await host.readArtifact({}), 'read');
assert.equal(await host.preparePublication({}), 'ticket');
assert.equal(await host.commitPrepared({}), 'committed');
assert.equal(await host.abortPrepared({}), true);
assert.equal(hostCalls, 16);
assert.throws(() => createHostBridge({}), TypeError);

const outDir = path.join(root, 'generated');
const canonical = ['design.js', 'design.d.ts', 'manifest.json', 'styles.css', 'artifacts.json'];
for (const file of canonical) assert(fs.existsSync(path.join(outDir, file)), 'missing canonical generated artifact ' + file);
const text = Object.fromEntries(canonical.map((file) => [file, fs.readFileSync(path.join(outDir, file), 'utf8')]));
const metadata = JSON.parse(text['artifacts.json']);
const manifest = JSON.parse(text['manifest.json']);
const markerMatch = text['design.js'].match(/export const __pandamstyle = (\{[\s\S]*?\n\});/);
assert(markerMatch, 'generated JS identity marker missing');
const marker = JSON.parse(markerMatch[1]);
for (const key of ['systemId', 'registryDigest', 'abiVersion', 'compilerContractVersion', 'manifestSchemaVersion']) {
  assert.equal(metadata[key], manifest[key], key + ' differs between artifacts and manifest');
}
assert.equal(metadata.systemId, marker.designSystem.systemId);
assert.equal(metadata.registryDigest, marker.designSystem.registryDigest);
assert.equal(metadata.abiVersion, core.ABI_VERSION);
for (const [name, file] of [['designModule', 'design.js'], ['declarations', 'design.d.ts'], ['manifest', 'manifest.json'], ['css', 'styles.css']]) {
  const record = metadata.artifacts[name];
  assert.equal(record.file, file);
  assert.equal(record.bytes, Buffer.byteLength(text[file]));
  assert.equal(record.sha256, (await import('node:crypto')).createHash('sha256').update(text[file]).digest('hex'));
}
assert.equal(metadata.schemaVersion, 1);
assert(text['styles.css'].startsWith('/* pandamstyle-design-system '));
assert(!text['design.d.ts'].includes('colors.hiddenInk'), 'private token leaked into generated declarations');

console.log(JSON.stringify({ resolved, exports: { core: Object.keys(core).sort(), compiler: Object.keys(compiler).sort(), config: Object.keys(configApi).sort(), host: ['createHostBridge'] }, privateSubpathsRejected, runtime: 'passed', abiMismatchCode: 'PMS_ABI_MISMATCH', artifactSet: metadata.artifactSetDigest, canonicalArtifacts: canonical }));
`,
  );
}

function makeSdkConsumer(consumerDir) {
  fs.writeFileSync(
    path.join(consumerDir, 'sdk-consumer.mjs'),
    String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectSession } from '@pandamstyle/compiler';
import { createHostBridge } from '@pandamstyle/compiler/host';
import definition from './design-system.mjs';

const rootDir = process.cwd();
const project = createProjectSession({
  projectId: 'phase-9-sdk-consumer',
  rootDir,
  definition,
  roots: [path.join(rootDir, 'src')],
  outDir: path.join(rootDir, 'generated'),
  designSystemFile: 'design.js',
});
try {
  const initialized = await project.initialize();
  const changed = await project.applyChanges({
    baseRevision: initialized.revision,
    mode: 'verified-explicit',
    changed: ['src/app.tsx'],
    added: [],
    removed: [],
    renamed: [],
  });
  const validation = await project.validate(changed.revision);
  assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
  const agent = await project.agentResult(validation.revision);
  assert(agent && agent.revision.revisionId === validation.revision.revisionId);
  const candidates = await project.candidateTokens({ revision: validation.revision, category: 'spacing', limit: 2 });
  assert.equal(candidates.total, 3);
  assert.equal(candidates.candidates.length, 2);
  const audit = await project.requestFullAudit(validation.revision);
  assert.equal(audit.revision.revisionId, validation.revision.revisionId);
  const artifact = await project.readArtifact(validation.revision, 'src/app.tsx');
  assert.equal(artifact.source, 'src/app.tsx');
  assert(artifact.javascript.includes('__pmsProps'));

  const cancelled = await project.preparePublication(validation.revision);
  assert.equal(cancelled.state, 'prepared');
  assert.equal(await project.abortPrepared(cancelled), true);
  const receipt = await project.compile(validation.revision);
  assert.equal(receipt.abiVersion, 1);
  assert.equal(receipt.designSystem.systemId, definition.systemId);
  assert.equal(receipt.revision.revisionId, validation.revision.revisionId);
  const bridge = createHostBridge(project);
  const hostArtifact = await bridge.readArtifact(validation.revision, 'src/app.tsx');
  assert.equal(hostArtifact.source, artifact.source);
  const hostTicket = await bridge.preparePublication(validation.revision);
  const hostReceipt = await bridge.commitPrepared(hostTicket);
  assert.equal(hostReceipt.generationId, receipt.generationId);
  assert.equal((await project.current()).generation.generationId, hostReceipt.generationId);
  const appPath = path.join(rootDir, 'src/app.tsx');
  const source = fs.readFileSync(appPath, 'utf8');
  fs.writeFileSync(appPath, source.replace("token('spacing.md')", "token('spacing.lg')"));
  const edited = await project.applyChanges({ baseRevision: validation.revision, mode: 'verified-explicit', changed: ['src/app.tsx'], added: [], removed: [], renamed: [] });
  const editedValidation = await project.validate(edited.revision);
  assert.equal(editedValidation.ok, true, JSON.stringify(editedValidation.diagnostics));
  const editedTicket = await bridge.preparePublication(editedValidation.revision);
  const editedReceipt = await bridge.commitPrepared(editedTicket);
  assert(editedReceipt.generationId > hostReceipt.generationId);
  assert.equal((await project.current()).generation.generationId, editedReceipt.generationId);
  console.log(JSON.stringify({ initialize: 'passed', applyChanges: 'passed', validate: 'passed', compile: 'passed', current: 'passed', agentResult: 'passed', candidateTokens: 'passed', requestFullAudit: 'passed', prepareAbortCommit: 'passed', hostReadCommit: 'passed', sameContentGenerationReuse: 'passed', changedContentGenerationAdvance: 'passed', revision: editedValidation.revision, generationId: editedReceipt.generationId }));
} finally {
  await project.close();
}
`,
  );
  fs.mkdirSync(path.join(consumerDir, 'counterfeit', 'src'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(consumerDir, 'counterfeit', 'src/page.js'),
    `import { create, token } from './counterfeit-design.js';
export const invalid = create({ root: { padding: token('spacing.md') } });
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'counterfeit', 'counterfeit-consumer.mjs'),
    String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createProjectSession } from '@pandamstyle/compiler';
import definition from '../design-system.mjs';
const rootDir = path.dirname(new URL(import.meta.url).pathname);
const generated = fs.readFileSync(path.join(path.dirname(rootDir), 'generated/design.js'), 'utf8');
fs.writeFileSync(path.join(rootDir, 'src/counterfeit-design.js'), generated);
const project = createProjectSession({ projectId: 'counterfeit-generated-artifact', rootDir, definition, roots: [path.join(rootDir, 'src')], outDir: path.join(rootDir, 'out'), designSystemFile: 'design.js' });
try {
  const initialized = await project.initialize();
  const result = await project.validate(initialized.revision);
  const codes = result.diagnostics.map((item) => item.code);
  assert(codes.includes('PMS_GENERATED_ARTIFACT_MISMATCH'), JSON.stringify(codes));
  console.log(JSON.stringify({ result: 'rejected', expectedCode: 'PMS_GENERATED_ARTIFACT_MISMATCH', codes }));
} finally { await project.close(); }
`,
  );
}

function makeBundleHarness(consumerDir) {
  const cases = {
    'props-only': `import { props } from '@pandamstyle/core';
const ref = { kind: 'pandamstyle-style-ref', abiVersion: 1, systemId: 'x', entries: [['display', 'u-grid']] };
export const value = props(ref).className;
`,
    'unused-core': `import { assertAbi } from '@pandamstyle/core';
`,
  };
  const entries = path.join(consumerDir, 'bundle-entries');
  const output = path.join(consumerDir, 'bundle-output');
  fs.mkdirSync(entries, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  for (const [name, source] of Object.entries(cases))
    fs.writeFileSync(path.join(entries, `${name}.mjs`), source);
  fs.writeFileSync(
    path.join(consumerDir, 'bundle-sources.mjs'),
    String.raw`import fs from 'node:fs';
import path from 'node:path';
import { createProjectSession } from '@pandamstyle/compiler';
import definition from './design-system.mjs';

const root = process.cwd();
const entries = path.join(root, 'bundle-entries');
const cases = {
  'one-recipe': ["import { recipes, props } from '../generated/design.js';", "export const value = props(recipes.button({ tone: 'brand', size: 'md' })).className;"].join(String.fromCharCode(10)),
  'one-theme': ["import { themes, props } from '../generated/design.js';", "export const value = props(themes.light).className;"].join(String.fromCharCode(10)),
  'multiple-recipes': ["import { recipes, props } from '../generated/design.js';", "export const value = [props(recipes.button({ tone: 'brand' })), props(recipes.notice({ kind: 'warning' }))];"].join(String.fromCharCode(10)),
  'dynamic-axis': ["import { recipes, props } from '../generated/design.js';", "export function choose(size) { return props(recipes.button({ tone: 'brand', size })).className; }"].join(String.fromCharCode(10)),
  'dynamic-namespace': ["import { recipes, props } from '../generated/design.js';", "const name = globalThis.__pmsRecipeName;", "export const value = props(recipes[name]({ tone: 'brand' })).className;"].join(String.fromCharCode(10)),
};
const results = {};
for (const [name, source] of Object.entries(cases)) {
  const caseRoot = path.join(root, 'tree-shaking', name);
  const sourceRoot = path.join(caseRoot, 'src');
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'entry.js'), source);
  const project = createProjectSession({ projectId: 'package-qualification-' + name, rootDir: caseRoot, definition, roots: [sourceRoot], outDir: path.join(caseRoot, 'generated'), designSystemFile: 'design.js' });
  try {
    const initialized = await project.initialize();
    const validation = await project.validate(initialized.revision);
    const diagnostics = validation.diagnostics.map((item) => item.code);
    if (!validation.ok) {
      if (name === 'dynamic-axis' || name === 'dynamic-namespace') {
        results[name] = { supported: false, diagnostics };
        continue;
      }
      throw new Error(name + ' compiled application validation failed: ' + JSON.stringify(validation.diagnostics));
    }
    await project.requestFullAudit(validation.revision);
    await project.compile(validation.revision);
    const artifact = await project.readArtifact(validation.revision, 'src/entry.js');
    fs.writeFileSync(path.join(entries, name + '.mjs'), artifact.javascript);
    results[name] = { supported: true, diagnostics, javascriptBytes: Buffer.byteLength(artifact.javascript) };
  } finally { await project.close(); }
}
console.log(JSON.stringify(results));
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'bundle.mjs'),
    String.raw`import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const root = process.cwd();
const reports = {};
const names = JSON.parse(fs.readFileSync(path.join(root, 'bundle-case-names.json'), 'utf8'));
for (const name of names) {
  const bundle = await rollup({
    input: path.join(root, 'bundle-entries', name + '.mjs'),
    treeshake: { propertyReadSideEffects: false },
    plugins: [nodeResolve({ browser: true, exportConditions: ['browser', 'import'] })],
  });
  try {
    const generated = await bundle.generate({ format: 'es' });
    const code = generated.output.filter((item) => item.type === 'chunk').map((item) => item.code).join('\n');
    fs.writeFileSync(path.join(root, 'bundle-output', name + '.mjs'), code);
    reports[name] = { bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, modules: generated.output.filter((item) => item.type === 'chunk').flatMap((item) => Object.keys(item.modules)) };
  } finally { await bundle.close(); }
}
console.log(JSON.stringify(reports));
`,
  );
  return { entries, output, cases: Object.keys(cases) };
}

function assertBrowserSafety(consumerDir, unpackedPackages) {
  const inspected = [];
  for (const [label, root] of [
    ['core-tarball', unpackedPackages['@pandamstyle/core']],
    ['generated-runtime', path.join(consumerDir, 'generated')],
    ['browser-bundles', path.join(consumerDir, 'bundle-output')],
  ]) {
    for (const file of listFiles(root)) {
      if (!/\.(?:mjs|js|cjs|jsx|ts|tsx)$/.test(file)) continue;
      const source = fs.readFileSync(file, 'utf8');
      const imports = importsOf(source);
      const forbiddenImports = imports.filter(
        (item) => isBuiltin(item) || BUNDLE_FORBIDDEN_RE.test(item),
      );
      const processReferences = [
        ...source.matchAll(/\bprocess\.(?:env|cwd|argv|versions)\b/g),
      ].map((match) => match[0]);
      assert.deepEqual(
        forbiddenImports,
        [],
        `${label} contains forbidden runtime imports in ${path.relative(root, file)}`,
      );
      assert.deepEqual(
        processReferences,
        [],
        `${label} contains Node process-dependent runtime code in ${path.relative(root, file)}`,
      );
      inspected.push({
        artifact: label,
        file: path.relative(root, file).split(path.sep).join('/'),
        imports,
        forbiddenImports,
        processReferences,
      });
    }
  }
  return { pass: true, inspected };
}

function assertNoRepositoryLeak(consumerDir, repositoryRoot) {
  const packages = installedDependencyGraph(consumerDir);
  assert.deepEqual(
    packages.missing,
    [],
    `installed production dependency closure is incomplete: ${JSON.stringify(packages.missing)}`,
  );
  const donorPackages = packages.packages.filter((item) =>
    DONOR_RE.test(item.name),
  );
  assert.deepEqual(donorPackages, [], 'donor packages are installed');
  const leakedPaths = packages.packages.filter((item) =>
    inside(repositoryRoot, item.realpath),
  );
  assert.deepEqual(
    leakedPaths,
    [],
    `installed packages resolve into the repository: ${JSON.stringify(leakedPaths)}`,
  );
  const workspaceSpecs = [];
  for (const item of packages.packages) {
    const manifest = readJson(path.join(item.realpath, 'package.json'));
    for (const group of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [dependency, range] of Object.entries(manifest[group] ?? {})) {
        if (/^(?:workspace:|file:)/i.test(range))
          workspaceSpecs.push({ package: item.name, group, dependency, range });
      }
    }
  }
  assert.deepEqual(
    workspaceSpecs,
    [],
    'installed production graph contains local/workspace dependency specs',
  );
  for (const name of Object.keys(EXPECTED)) {
    const installed = resolveInstalledPackage(consumerDir, name);
    assert(installed, `${name} is not installed`);
    assert(
      inside(path.join(consumerDir, 'node_modules'), installed),
      `${name} is not installed under the external consumer`,
    );
  }
  return {
    complete: packages.missing.length === 0,
    packages: packages.packages,
    packageCount: packages.packages.length,
    installedProductionBytes: packages.totalInstalledBytes,
    donorPackages,
    workspaceFileReferences: workspaceSpecs,
    repositoryPathLeakage: leakedPaths,
    installedPandamStyleRealpaths: Object.fromEntries(
      Object.keys(EXPECTED).map((name) => [
        name,
        resolveInstalledPackage(consumerDir, name),
      ]),
    ),
  };
}

function makeInvalidCliCases(consumerDir) {
  fs.writeFileSync(
    path.join(consumerDir, 'missing-definition.config.mjs'),
    `export default { definition: './absent-design-system.mjs', roots: ['./src'], outDir: './missing-output', designSystemFile: 'design.js' };
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'invalid.config.mjs'),
    `export default null;
`,
  );
  fs.writeFileSync(
    path.join(consumerDir, 'src/invalid-source.js'),
    `import { create, token } from '../generated/design.js';
export const broken = create({ root: { padding: token('spacing.absent') } });
`,
  );
}

function cliInvocation(binary, args, cwd, nodeBinary = null) {
  return nodeBinary
    ? invoke(nodeBinary, [binary, ...args], { cwd })
    : invoke(binary, args, { cwd });
}

function runCliMatrix(consumerDir, node20Path) {
  const bin = path.join(consumerDir, 'node_modules/.bin/pms-build');
  assert(fs.existsSync(bin), 'installed pms-build binary is missing');
  const outDir = path.join(consumerDir, 'generated');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'stale-from-previous-build.txt'), 'stale');
  const first = cliInvocation(
    bin,
    ['--config', './pandamstyle.config.mjs'],
    consumerDir,
  );
  assert.equal(
    first.status,
    0,
    `external CLI build failed:\n${first.stderr || first.stdout}`,
  );
  const canonicalNames = [
    'design.js',
    'design.d.ts',
    'manifest.json',
    'styles.css',
    'artifacts.json',
  ];
  for (const name of canonicalNames)
    assert(fs.existsSync(path.join(outDir, name)), `CLI omitted ${name}`);
  assert(
    !fs.existsSync(path.join(outDir, 'stale-from-previous-build.txt')),
    'CLI did not clean stale output',
  );
  const firstArtifacts = Object.fromEntries(
    canonicalNames.map((name) => [
      name,
      sha256(fs.readFileSync(path.join(outDir, name))),
    ]),
  );
  const second = cliInvocation(
    bin,
    ['--config', './pandamstyle.config.mjs'],
    consumerDir,
  );
  assert.equal(
    second.status,
    0,
    `repeated external CLI build failed:\n${second.stderr || second.stdout}`,
  );
  const secondArtifacts = Object.fromEntries(
    canonicalNames.map((name) => [
      name,
      sha256(fs.readFileSync(path.join(outDir, name))),
    ]),
  );
  assert.deepEqual(
    secondArtifacts,
    firstArtifacts,
    'repeated CLI build changed canonical output bytes',
  );

  makeInvalidCliCases(consumerDir);
  const invalid = cliInvocation(
    bin,
    ['--config', './pandamstyle.config.mjs'],
    consumerDir,
  );
  assert.notEqual(invalid.status, 0, 'invalid source unexpectedly compiled');
  const jsonLine = invalid.stderr
    .split('\n')
    .find((line) => line.startsWith('PMS_JSON:'));
  assert(
    jsonLine,
    `invalid CLI build did not emit structured diagnostics:\n${invalid.stderr}`,
  );
  const diagnosticResult = JSON.parse(jsonLine.slice('PMS_JSON:'.length));
  assert.equal(diagnosticResult.ok, false);
  assert(
    diagnosticResult.diagnostics.some(
      (item) => item.code === 'PMS_UNKNOWN_TOKEN',
    ),
  );
  fs.rmSync(path.join(consumerDir, 'src/invalid-source.js'), { force: true });
  fs.rmSync(path.join(consumerDir, 'invalid-source.js'), { force: true });
  const clean = cliInvocation(
    bin,
    ['--config', './pandamstyle.config.mjs'],
    consumerDir,
  );
  assert.equal(
    clean.status,
    0,
    `CLI did not recover after invalid input was removed:\n${clean.stderr || clean.stdout}`,
  );
  const recoveredArtifacts = Object.fromEntries(
    canonicalNames.map((name) => [
      name,
      sha256(fs.readFileSync(path.join(outDir, name))),
    ]),
  );
  assert.deepEqual(
    recoveredArtifacts,
    firstArtifacts,
    'clean CLI output differs after invalid source removal',
  );

  const missingConfig = cliInvocation(
    bin,
    ['--config', './missing.config.mjs'],
    consumerDir,
  );
  assert.equal(missingConfig.status, 2);
  assert.match(missingConfig.stderr, /config not found/);
  const missingDefinition = cliInvocation(
    bin,
    ['--config', './missing-definition.config.mjs'],
    consumerDir,
  );
  assert.equal(missingDefinition.status, 2);
  assert.match(missingDefinition.stderr, /definition not found/);
  const invalidConfig = cliInvocation(
    bin,
    ['--config', './invalid.config.mjs'],
    consumerDir,
  );
  assert.equal(invalidConfig.status, 2);
  assert.match(invalidConfig.stderr, /config must export an object/);

  const node20 = cliInvocation(
    path.join(
      consumerDir,
      'node_modules/@pandamstyle/compiler/bin/pms-build.js',
    ),
    ['--config', './pandamstyle.config.mjs'],
    consumerDir,
    node20Path,
  );
  assert.equal(
    node20.status,
    0,
    `Node 20 CLI build failed:\n${node20.stderr || node20.stdout}`,
  );
  return {
    binary: 'node_modules/.bin/pms-build',
    successfulBuild: 'passed',
    repeatedBuildContentIdentical: true,
    invalidSourceExitCode: invalid.status,
    invalidSourceDiagnosticCodes: [
      ...new Set(diagnosticResult.diagnostics.map((item) => item.code)),
    ].sort(),
    structuredDiagnostics: 'passed',
    missingConfigExitCode: missingConfig.status,
    missingDefinitionExitCode: missingDefinition.status,
    invalidConfigExitCode: invalidConfig.status,
    cleanOutputAndRecovery: 'passed',
    node20Cli: 'passed',
    canonicalFiles: canonicalNames,
    canonicalDigests: firstArtifacts,
  };
}

function runTypeChecks(consumerDir) {
  createTypeFixtures(consumerDir);
  const started = performance.now();
  const result = requireSuccess(
    process.execPath,
    [
      path.join(consumerDir, 'node_modules/typescript/bin/tsc'),
      '--project',
      path.join(consumerDir, 'tsconfig.json'),
    ],
    { cwd: consumerDir },
  );
  return {
    compiler: `typescript@${TOOL_VERSIONS.typescript}`,
    strictNoEmit: true,
    positiveCoreAndSdk: 'passed',
    positiveGeneratedDesignSystem: 'passed',
    negativeCases: 9,
    negativeCaseNames: [
      'private-token',
      'unknown-token',
      'invalid-recipe-axis-value',
      'invalid-recipe-size-value',
      'unknown-condition',
      'unknown-theme',
      'invalid-composition-object',
      'wrong-abi-version',
      'unverified-props-input',
    ],
    negativeCasesRejected: true,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    commandDurationMs: result.durationMs,
    declarationBytes: fs.statSync(
      path.join(consumerDir, 'generated/design.d.ts'),
    ).size,
  };
}

function runTreeShaking(consumerDir) {
  const started = performance.now();
  const sourceResult = requireSuccess(
    process.execPath,
    [path.join(consumerDir, 'bundle-sources.mjs')],
    { cwd: consumerDir },
  );
  const sourceCases = JSON.parse(sourceResult.stdout);
  const caseNames = [
    'props-only',
    'one-recipe',
    'one-theme',
    'multiple-recipes',
    'unused-core',
    ...['dynamic-axis', 'dynamic-namespace'].filter(
      (name) => sourceCases[name]?.supported,
    ),
  ];
  writeJson(path.join(consumerDir, 'bundle-case-names.json'), caseNames);
  const result = requireSuccess(
    process.execPath,
    [path.join(consumerDir, 'bundle.mjs')],
    { cwd: consumerDir },
  );
  const reports = JSON.parse(result.stdout);
  const outputDir = path.join(consumerDir, 'bundle-output');
  const code = Object.fromEntries(
    Object.keys(reports).map((name) => [
      name,
      fs.readFileSync(path.join(outputDir, `${name}.mjs`), 'utf8'),
    ]),
  );
  assert(
    !code['one-recipe'].includes('notice'),
    'unused recipe vocabulary remained in one-recipe bundle',
  );
  assert(
    !code['one-theme'].includes('dark'),
    'unused theme vocabulary remained in one-theme bundle',
  );
  assert(
    reports['multiple-recipes'].bytes > reports['one-recipe'].bytes,
    'multiple-recipe bundle did not retain additional compiled recipe output',
  );
  if (sourceCases['dynamic-axis']?.supported) {
    assert(
      code['dynamic-axis'].includes('notice'),
      'dynamic-axis bundle did not retain the bounded recipe selector data',
    );
    assert(
      reports['dynamic-axis'].bytes >= reports['one-recipe'].bytes,
      'dynamic-axis bundle omitted its selected recipe',
    );
  }
  if (sourceCases['dynamic-namespace']?.supported) {
    assert(
      reports['dynamic-namespace'].bytes >= reports['multiple-recipes'].bytes,
      'dynamic namespace bundle did not retain the reachable recipe set',
    );
  }
  assert(
    reports['unused-core'].bytes <= 16,
    'unused core export was not removed by tree shaking',
  );
  return {
    bundler: `rollup@${TOOL_VERSIONS.rollup}`,
    elapsedMs: Number((performance.now() - started).toFixed(3)),
    compiledApplicationSources: sourceCases,
    cases: Object.fromEntries(
      Object.entries(reports).map(([name, item]) => [
        name,
        {
          bytes: item.bytes,
          gzipBytes: item.gzipBytes,
          moduleCount: item.modules.length,
        },
      ]),
    ),
    dynamicSelectionVocabulary: sourceCases['dynamic-axis']?.supported
      ? {
          selectedRecipe: 'button',
          unrelatedRecipeDataRetained:
            code['dynamic-axis'].includes('__pmsRecipe_notice'),
          unrelatedRecipeIds: code['dynamic-axis'].includes(
            '__pmsRecipe_notice',
          )
            ? ['notice']
            : [],
          unrelatedThemeDataRetained: code['dynamic-axis'].includes('dark'),
          reason:
            'runtime dynamic axis selection keeps the generated recipes aggregate reachable; Rollup retains its finite object members',
        }
      : { supported: false },
    assertions: {
      propsOnly: 'passed',
      oneRecipeDropsNoticeRecipe: 'passed',
      oneThemeDropsDarkTheme: 'passed',
      multipleRecipesRetainAdditionalCompiledOutput: 'passed',
      dynamicAxisRetainsBoundedSelectorData: sourceCases['dynamic-axis']
        ?.supported
        ? 'passed'
        : 'not-supported-by-compiler',
      dynamicNamespaceAccess: sourceCases['dynamic-namespace']?.supported
        ? 'compiled-and-bundled'
        : 'not-supported-by-compiler',
      unusedCoreExportRemoved: 'passed',
    },
    caseModules: Object.fromEntries(
      Object.entries(reports).map(([name, item]) => [
        name,
        item.modules.map((file) =>
          path.relative(consumerDir, file).split(path.sep).join('/'),
        ),
      ]),
    ),
  };
}

async function runSdkChecks(consumerDir, commandLog) {
  makeSdkConsumer(consumerDir);
  const start = performance.now();
  const result = requireSuccess(
    process.execPath,
    [path.join(consumerDir, 'sdk-consumer.mjs')],
    { cwd: consumerDir },
  );
  commandLog.push({
    name: 'external-sdk',
    command: 'node sdk-consumer.mjs',
    exitCode: 0,
    durationMs: result.durationMs,
  });
  const runtime = JSON.parse(result.stdout.trim().split('\n').at(-1));

  const counterfeit = invoke(
    process.execPath,
    [path.join(consumerDir, 'counterfeit/counterfeit-consumer.mjs')],
    { cwd: consumerDir },
  );
  assert.equal(
    counterfeit.status,
    0,
    `generated-artifact mismatch check failed:\n${counterfeit.stderr || counterfeit.stdout}`,
  );
  const mismatchReport = JSON.parse(
    counterfeit.stdout.trim().split('\n').at(-1),
  );
  return {
    ...runtime,
    elapsedMs: Number((performance.now() - start).toFixed(3)),
    generatedArtifactMismatch: mismatchReport,
  };
}

function nodeRuntimeMatrix(consumerDir, node20Path, commandLog) {
  makeRuntimeSmoke(consumerDir);
  const runtimes = [
    { label: 'repository-node', binary: process.execPath },
    { label: 'minimum-node', binary: node20Path },
  ];
  const matrix = [];
  for (const runtime of runtimes) {
    const version = requireSuccess(runtime.binary, ['--version'], {
      cwd: consumerDir,
    }).stdout.trim();
    const start = performance.now();
    const smoke = requireSuccess(
      runtime.binary,
      [path.join(consumerDir, 'runtime-smoke.mjs')],
      { cwd: consumerDir },
    );
    const cliStart = performance.now();
    const cli = requireSuccess(
      runtime.binary,
      [
        path.join(
          consumerDir,
          'node_modules/@pandamstyle/compiler/bin/pms-build.js',
        ),
        '--config',
        './pandamstyle.config.mjs',
      ],
      { cwd: consumerDir },
    );
    matrix.push({
      label: runtime.label,
      node: version,
      esmImportsRuntimeConfigHost: 'passed',
      externalRealpaths: 'passed',
      coreRuntimeAndAbiErrors: 'passed',
      canonicalArtifactIdentity: 'passed',
      esmSmokeElapsedMs: Number((performance.now() - start).toFixed(3)),
      cliBuild: 'passed',
      cliBuildElapsedMs: Number((performance.now() - cliStart).toFixed(3)),
      smoke: JSON.parse(smoke.stdout.trim().split('\n').at(-1)),
      cliOutput: cli.stdout.trim().split('\n').at(-1),
    });
    commandLog.push({
      name: `external-runtime-${runtime.label}`,
      command: `${version} runtime-smoke + pms-build`,
      exitCode: 0,
      durationMs:
        matrix[matrix.length - 1].esmSmokeElapsedMs +
        matrix[matrix.length - 1].cliBuildElapsedMs,
    });
  }
  return matrix;
}

function licenseAndProvenanceReport(packages) {
  const rootLicense = fs.readFileSync(path.join(REPO, 'LICENSE'));
  const compilerAttributions = fs.readFileSync(
    path.join(REPO, 'ATTRIBUTIONS.md'),
  );
  const pandaLicense = fs.readFileSync(
    path.join(REPO, 'LICENSES/PANDA-MIT-LICENSE.md'),
  );
  for (const name of Object.keys(EXPECTED)) {
    const packageDir = packages[name].first.packageDir;
    assert.deepEqual(
      fs.readFileSync(path.join(packageDir, 'LICENSE')),
      rootLicense,
      `${name} LICENSE differs from repository notice`,
    );
  }
  const compilerDir = packages['@pandamstyle/compiler'].first.packageDir;
  assert.deepEqual(
    fs.readFileSync(path.join(compilerDir, 'ATTRIBUTIONS.md')),
    compilerAttributions,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(compilerDir, 'LICENSES/PANDA-MIT-LICENSE.md')),
    pandaLicense,
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        compilerDir,
        'docs/architecture/phase-4-derived-source-provenance.md',
      ),
    ),
    fs.readFileSync(
      path.join(REPO, 'docs/architecture/phase-4-derived-source-provenance.md'),
    ),
  );
  assert.deepEqual(
    fs.readFileSync(
      path.join(
        compilerDir,
        'docs/architecture/phase-4-engine-absorption-map.md',
      ),
    ),
    fs.readFileSync(
      path.join(REPO, 'docs/architecture/phase-4-engine-absorption-map.md'),
    ),
  );
  const coreAttributions = fs
    .readFileSync(
      path.join(
        packages['@pandamstyle/core'].first.packageDir,
        'ATTRIBUTIONS.md',
      ),
      'utf8',
    )
    .replace(/\s+/g, ' ');
  assert(coreAttributions.includes('no third-party runtime dependency'));
  assert(coreAttributions.includes('no StyleX or Panda implementation'));
  return {
    pass: true,
    core: {
      license: 'LICENSE is byte-identical to repository LICENSE',
      attribution: 'package-specific runtime provenance present',
      donorImplementation: 'none shipped',
    },
    compiler: {
      license: 'LICENSE is byte-identical to repository LICENSE',
      attributions: 'repository ATTRIBUTIONS.md byte-identical',
      pandaLicense: 'LICENSES/PANDA-MIT-LICENSE.md byte-identical',
      derivedSourceMapping: [
        'docs/architecture/phase-4-derived-source-provenance.md',
        'docs/architecture/phase-4-engine-absorption-map.md',
      ],
    },
    donorSourceTreesShipped: false,
  };
}

function writeQualificationReports(output, report) {
  const external = report.externalConsumer;
  writeJson(
    path.join(output, 'external-install-report.json'),
    external.install,
  );
  writeJson(path.join(output, 'realpath-workspace-leakage.json'), {
    realpaths: external.realpaths,
    workspaceLeakage: external.workspaceLeakage,
    packageLockFileReferences: external.packageLockFileReferences,
  });
  writeJson(
    path.join(output, 'dependency-closure.json'),
    external.installedDependencyGraph,
  );
  writeJson(path.join(output, 'runtime-import-report.json'), {
    compilerRuntimeImports: external.compilerRuntimeImports,
    browserRuntimeImports: external.browserSafety,
  });
  writeJson(path.join(output, 'cli-report.json'), external.cli);
  writeJson(path.join(output, 'compiler-sdk-report.json'), external.sdk);
  writeJson(path.join(output, 'host-report.json'), {
    import: '@pandamstyle/compiler/host',
    operations: external.sdk.hostReadCommit,
    source: 'external compiler SDK session exercised through createHostBridge',
  });
  writeJson(path.join(output, 'typescript-report.json'), external.typeScript);
  writeJson(path.join(output, 'generated-design-system-types.json'), {
    canonicalArtifacts: external.cli.canonicalFiles,
    declarationBytes: external.typeScript.declarationBytes,
    declarationTypecheck: external.typeScript.positiveGeneratedDesignSystem,
    negativeCases: external.typeScript.negativeCases,
    negativeCaseNames: external.typeScript.negativeCaseNames,
    negativeCasesRejected: external.typeScript.negativeCasesRejected,
  });
  writeJson(
    path.join(output, 'tree-shaking-report.json'),
    external.treeShaking,
  );
  writeJson(
    path.join(output, 'browser-runtime-scan.json'),
    external.browserSafety,
  );
  writeJson(
    path.join(output, 'node-compatibility-matrix.json'),
    external.runtimeMatrix,
  );
  writeJson(
    path.join(output, 'license-provenance-report.json'),
    report.licensesAndProvenance,
  );
  writeJson(path.join(output, 'package-footprint-and-performance.json'), {
    packages: Object.fromEntries(
      Object.entries(report.packages).map(([name, item]) => [
        name,
        {
          packedBytes: item.npmPack.first.size,
          unpackedBytes: item.npmPack.first.unpackedSize,
          fileCount: item.npmPack.first.unpackedFileCount,
          contentInventoryDigest: item.npmPack.first.contentInventoryDigest,
        },
      ]),
    ),
    productionDependencyCount: external.installedDependencyGraph.packageCount,
    installedProductionBytes:
      external.installedDependencyGraph.installedProductionBytes,
    browserBundles: external.treeShaking.cases,
    generatedDeclarationBytes: external.typeScript.declarationBytes,
    performance: external.performance,
  });
}

async function runExternalConsumer(
  consumerDir,
  node20Path,
  packages,
  commandLog,
) {
  externalFixtureFiles(consumerDir);
  const packageTarballs = [
    packages['@pandamstyle/compiler'].first.archive,
    packages['@pandamstyle/core'].first.archive,
  ];
  const install = requireSuccess(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      ...packageTarballs,
    ],
    { cwd: consumerDir },
  );
  commandLog.push({
    name: 'external-install-tarballs',
    command: 'npm install <compiler.tgz> <core.tgz>',
    exitCode: 0,
    durationMs: install.durationMs,
  });
  const tools = Object.entries(TOOL_VERSIONS).map(
    ([name, version]) => `${name}@${version}`,
  );
  const toolingInstall = requireSuccess(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--save-dev',
      '--save-exact',
      ...tools,
    ],
    { cwd: consumerDir },
  );
  commandLog.push({
    name: 'external-install-tooling',
    command: `npm install --save-dev ${tools.join(' ')}`,
    exitCode: 0,
    durationMs: toolingInstall.durationMs,
  });
  const node20PathInstalled = path.join(
    consumerDir,
    'node_modules/node/bin/node',
  );
  assert(
    fs.existsSync(node20PathInstalled),
    'Node 20 boundary binary was not installed',
  );
  assert.equal(
    requireSuccess(node20PathInstalled, ['--version'], {
      cwd: consumerDir,
    }).stdout.trim(),
    'v20.0.0',
  );
  const dependencyGraph = assertNoRepositoryLeak(consumerDir, REPO);

  const cli = runCliMatrix(consumerDir, node20PathInstalled);
  const runtimeMatrix = nodeRuntimeMatrix(
    consumerDir,
    node20PathInstalled,
    commandLog,
  );
  const sdk = await runSdkChecks(consumerDir, commandLog);
  const typeScript = runTypeChecks(consumerDir);
  const bundleSetup = makeBundleHarness(consumerDir);
  const treeShaking = runTreeShaking(consumerDir);
  const browserSafety = assertBrowserSafety(consumerDir, {
    '@pandamstyle/core': packages['@pandamstyle/core'].first.packageDir,
  });

  const productionPrune = requireSuccess(
    'npm',
    ['prune', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd: consumerDir },
  );
  commandLog.push({
    name: 'external-prune-dev-dependencies',
    command: 'npm prune --omit=dev',
    exitCode: 0,
    durationMs: productionPrune.durationMs,
  });
  const productionTree = requireSuccess(
    'npm',
    ['ls', '--omit=dev', '--all', '--json'],
    { cwd: consumerDir },
  );
  const npmTree = JSON.parse(productionTree.stdout);
  const npmPackages = [];
  function collectNpmTree(node) {
    for (const [name, value] of Object.entries(node.dependencies ?? {})) {
      npmPackages.push({
        name,
        version: value.version ?? null,
        problems: value.problems ?? [],
      });
      collectNpmTree(value);
    }
  }
  collectNpmTree(npmTree);
  assert(!npmPackages.some((item) => DONOR_RE.test(item.name)));
  assert(!npmPackages.some((item) => item.problems.length > 0));

  const compilerPackage = packages['@pandamstyle/compiler'].first;
  const compiledImports = [
    ...new Set(
      listFiles(path.join(compilerPackage.packageDir, 'lib')).flatMap((file) =>
        importsOf(fs.readFileSync(file, 'utf8')),
      ),
    ),
  ].sort();
  const unresolvedExternalImports = compiledImports
    .map(barePackageName)
    .filter(Boolean)
    .filter(
      (name) =>
        !Object.hasOwn(compilerPackage.manifest.dependencies ?? {}, name),
    );
  assert.deepEqual(
    unresolvedExternalImports,
    [],
    `compiler bundle imports undeclared runtime dependencies: ${unresolvedExternalImports.join(', ')}`,
  );
  const browserBundles = fileInventory(bundleSetup.output);
  const packageRoot = JSON.parse(
    fs.readFileSync(path.join(consumerDir, 'package.json'), 'utf8'),
  );
  const packageLockText = fs.readFileSync(
    path.join(consumerDir, 'package-lock.json'),
    'utf8',
  );
  const repositoryPathStrings = [
    packageLockText,
    ...listFiles(path.join(consumerDir, 'node_modules/@pandamstyle')).map(
      (file) => fs.readFileSync(file, 'utf8'),
    ),
  ].filter((text) => text.includes(REPO)).length;
  assert.equal(
    repositoryPathStrings,
    0,
    'installed package or lockfile contains repository path leakage',
  );

  const timing = {
    coldCompilerImportMs: runtimeMatrix[0].esmSmokeElapsedMs,
    coldCliStartupMs: cliInvocation(
      path.join(consumerDir, 'node_modules/.bin/pms-build'),
      ['--config', './missing.config.mjs'],
      consumerDir,
    ).durationMs,
    generatedTypecheckMs: typeScript.elapsedMs,
    npmInstallMs: install.durationMs + toolingInstall.durationMs,
  };
  return {
    packageManager: {
      name: 'npm',
      version: requireSuccess('npm', ['--version'], {
        cwd: consumerDir,
      }).stdout.trim(),
    },
    install: {
      command: 'npm install <local compiler tarball> <local core tarball>',
      status: 'passed',
      externalConsumer: consumerDir,
      packageJson: packageRoot,
      dependencyGraph: npmPackages,
      productionDependencyGraph: dependencyGraph,
    },
    realpaths: dependencyGraph.installedPandamStyleRealpaths,
    cli,
    runtimeMatrix,
    sdk,
    typeScript,
    treeShaking,
    browserSafety,
    installedDependencyGraph: dependencyGraph,
    compilerRuntimeImports: {
      emittedImports: compiledImports,
      undeclaredImports: unresolvedExternalImports,
    },
    workspaceLeakage: {
      repositoryPathStrings,
      nodePathUsed: false,
      sourcesUnavailableDuringTests: true,
    },
    packageLockFileReferences:
      'local tarballs are in an external temporary directory; no package or lock reference points into the repository',
    performance: timing,
    bundleFiles: browserBundles,
  };
}

function buildCompiler(commandLog) {
  const result = requireSuccess(
    'yarn',
    ['workspace', '@pandamstyle/compiler', 'run', 'build'],
    { cwd: REPO },
  );
  commandLog.push({
    name: 'build-compiler',
    command: 'yarn workspace @pandamstyle/compiler run build',
    exitCode: 0,
    durationMs: result.durationMs,
  });
}

async function withPackageSourcesUnavailable(scratchRoot, callback) {
  const source = path.join(REPO, 'packages');
  const parked = path.join(scratchRoot, 'workspace-packages-unavailable');
  assert(
    fs.existsSync(source),
    'repository packages directory is absent before isolation',
  );
  fs.renameSync(source, parked);
  try {
    return await callback(parked);
  } finally {
    if (fs.existsSync(parked)) fs.renameSync(parked, source);
  }
}

async function main() {
  const output = path.resolve(
    process.argv[2] ??
      process.env.PMS_PACKAGE_QUALIFICATION_OUT ??
      'evidence/phase-9-release-qualification/package-qualification',
  );
  const reportPath = path.join(output, 'report.json');
  const commandLog = [];
  const testedCommit = requireSuccess('git', ['rev-parse', 'HEAD'], {
    cwd: REPO,
  }).stdout.trim();
  const testedTree = requireSuccess('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: REPO,
  }).stdout.trim();
  const scratchRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pandamstyle-phase-9-'),
  );
  const tarballsRoot = path.join(scratchRoot, 'tarballs');
  const consumerDir = path.join(scratchRoot, 'consumer');
  fs.mkdirSync(tarballsRoot, { recursive: true });
  fs.mkdirSync(consumerDir, { recursive: true });
  const report = {
    documentKind: 'pandamstyle-standalone-package-qualification-v1',
    testedCommit,
    testedTree,
    startedAt: new Date().toISOString(),
    status: 'running',
    commandLog,
    toolchain: {
      node: process.version,
      npm: requireSuccess('npm', ['--version'], { cwd: REPO }).stdout.trim(),
      packageManager: 'npm',
    },
    packages: {},
  };
  try {
    assert(
      process.versions.node.split('.')[0] >= 20,
      `qualification tooling requires Node >=20 (found ${process.version})`,
    );
    buildCompiler(commandLog);

    const packages = {};
    for (const name of Object.keys(EXPECTED)) {
      const pack1 = packOne(
        name,
        path.join(
          tarballsRoot,
          name.endsWith('/core') ? 'core-pack-1' : 'compiler-pack-1',
        ),
        'first',
        commandLog,
      );
      const pack2 = packOne(
        name,
        path.join(
          tarballsRoot,
          name.endsWith('/core') ? 'core-pack-2' : 'compiler-pack-2',
        ),
        'second',
        commandLog,
      );
      const sourceManifest = readJson(
        path.join(EXPECTED[name].directory, 'package.json'),
      );
      const sourceAudit = packageManifestAudit(
        name,
        sourceManifest,
        pack1.packageDir,
      );
      const packedAudit = packageManifestAudit(
        name,
        pack1.manifest,
        pack1.packageDir,
      );
      assertTarballContents(name, pack1.inventory);
      assertTarballContents(name, pack2.inventory);
      const reproducibility = comparePackContents(pack1, pack2, name);
      packages[name] = {
        first: pack1,
        second: pack2,
        sourceAudit,
        packedAudit,
        reproducibility,
      };
      report.packages[name] = {
        manifest: packedAudit,
        npmPack: { first: pack1.packReport, second: pack2.packReport },
        tarballInventory: pack1.inventory,
        tarballContents: 'passed',
        reproducibility,
      };
    }

    const compilerFiles = packages['@pandamstyle/compiler'].first.inventory.map(
      (item) => item.path,
    );
    const coreFiles = packages['@pandamstyle/core'].first.inventory.map(
      (item) => item.path,
    );
    assert(
      !compilerFiles.some(
        (item) => item.startsWith('packages/') || item.startsWith('src/'),
      ),
    );
    assert(
      !coreFiles.some(
        (item) => item.startsWith('packages/') || item.startsWith('tests/'),
      ),
    );
    report.licensesAndProvenance = licenseAndProvenanceReport(packages);
    writeJson(path.join(output, 'npm-pack-core.json'), {
      first: packages['@pandamstyle/core'].first.entry,
      second: packages['@pandamstyle/core'].second.entry,
    });
    writeJson(path.join(output, 'npm-pack-compiler.json'), {
      first: packages['@pandamstyle/compiler'].first.entry,
      second: packages['@pandamstyle/compiler'].second.entry,
    });
    writeJson(
      path.join(output, 'tarball-inventories.json'),
      Object.fromEntries(
        Object.entries(packages).map(([name, item]) => [
          name,
          item.first.inventory,
        ]),
      ),
    );
    writeJson(
      path.join(output, 'reproducibility.json'),
      Object.fromEntries(
        Object.entries(packages).map(([name, item]) => [
          name,
          item.reproducibility,
        ]),
      ),
    );

    report.externalConsumer = await withPackageSourcesUnavailable(
      scratchRoot,
      async () =>
        runExternalConsumer(
          consumerDir,
          path.join(consumerDir, 'node_modules/node/bin/node'),
          packages,
          commandLog,
        ),
    );
    writeQualificationReports(output, report);
    report.status = 'passed';
    report.pass = true;
    report.completedAt = new Date().toISOString();
    report.scratchRoot = scratchRoot;
    writeJson(reportPath, report);
    process.stdout.write(
      `package qualification: PASS (${Object.keys(packages).length} packages, external consumer, ${report.externalConsumer.installedDependencyGraph.packageCount} production dependencies)\n`,
    );
  } catch (error) {
    report.status = 'failed';
    report.pass = false;
    report.completedAt = new Date().toISOString();
    report.error = { message: error.message, stack: error.stack };
    report.scratchRoot = scratchRoot;
    writeJson(reportPath, report);
    process.stderr.write(`package qualification: FAIL: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (process.env.PMS_KEEP_PACKAGE_QUALIFICATION_TMP !== '1') {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
