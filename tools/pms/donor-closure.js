/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseModuleImports } = require('./module-imports');

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx'];
const DONOR_PACKAGE =
  /^@(stylexjs|pandacss)\/|^(style-value-parser|styleq)$|^@dual-bundle\/import-meta-resolve$/;
const DONOR_PATH_PARTS = [
  `${path.sep}packages${path.sep}@stylexjs${path.sep}`,
  `${path.sep}packages${path.sep}style-value-parser${path.sep}`,
  `${path.sep}upstream${path.sep}stylex${path.sep}`,
  `${path.sep}upstream${path.sep}panda${path.sep}`,
];
const FORBIDDEN_REPOSITORY_PATHS = [
  'packages/@stylexjs',
  'packages/style-value-parser',
  'upstream/stylex',
  'upstream/panda',
  'legacy',
  'archive',
  'vendor',
  'old-stylex',
  'stylex-reference',
  'panda-reference',
  'reference-copy',
  'vendor-history',
  'donor-backup',
];
// The compiler CLI deliberately loads the consuming project's build config.
// This is the package's documented user-input boundary, not an engine or
// compiler dependency. Keep its cardinality pinned so any other computed
// import (including a second one added to this file) fails closed.
const APPROVED_DYNAMIC_IMPORTS = new Map([
  [
    path.resolve(__dirname, '../../packages/compiler/src/api/cli.js'),
    {
      kind: 'dynamic-import',
      count: 1,
      reason: 'loads the consuming project build config passed to pms-build',
    },
  ],
]);

function filesBelow(root, extensions = SOURCE_EXTENSIONS) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name)))
        files.push(full);
    }
  }
  visit(root);
  return files.sort();
}

function isDonorPath(file) {
  const absolute = path.resolve(file);
  return DONOR_PATH_PARTS.some((part) => absolute.includes(part));
}

function inspectForbiddenRepositoryPaths(repoRoot, findings) {
  const paths = FORBIDDEN_REPOSITORY_PATHS.map((relativePath) => {
    const fullPath = path.join(repoRoot, relativePath);
    const exists = fs.existsSync(fullPath);
    if (exists)
      addFinding(
        findings,
        'FORBIDDEN_REPOSITORY_PATH_PRESENT',
        relativePath,
        'forbidden donor or archive path exists',
      );
    return { path: relativePath, exists };
  });
  return {
    checked: paths.length,
    absentCount: paths.filter((item) => !item.exists).length,
    present: paths.filter((item) => item.exists).map((item) => item.path),
    paths,
  };
}

function isDonorSpecifier(specifier) {
  return DONOR_PACKAGE.test(specifier);
}

function manifestProductionDependencies(manifest) {
  return {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
}

function manifestInstalledDependencyEdges(manifest) {
  const edges = new Map();
  for (const name of Object.keys(manifest.dependencies ?? {}))
    edges.set(name, { name, optional: false });
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (!edges.has(name)) edges.set(name, { name, optional: true });
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    const previous = edges.get(name);
    edges.set(name, {
      name,
      optional: previous ? previous.optional && optional : optional,
    });
  }
  return [...edges.values()];
}

function addFinding(findings, code, location, detail) {
  findings.push({ code, location, detail });
}

function inspectSourceTree(root, label, findings) {
  const files = filesBelow(root);
  const edges = [];
  const approvedDynamicImports = [];
  for (const file of files) {
    let imports;
    try {
      imports = parseModuleImports(fs.readFileSync(file, 'utf8'), file);
    } catch (error) {
      addFinding(findings, 'SOURCE_PARSE_FAILED', file, error.message);
      continue;
    }
    const unresolved = imports.filter(
      (item) =>
        item.specifier == null &&
        (item.kind === 'dynamic-import' || item.kind === 'require'),
    );
    const approved = APPROVED_DYNAMIC_IMPORTS.get(path.resolve(file));
    if (approved != null) {
      if (
        unresolved.length !== approved.count ||
        unresolved.some((item) => item.kind !== approved.kind)
      ) {
        addFinding(
          findings,
          'APPROVED_DYNAMIC_IMPORT_CONTRACT_CHANGED',
          path.relative(process.cwd(), file),
          `expected ${approved.count} ${approved.kind}, found ${unresolved.length}`,
        );
      } else {
        approvedDynamicImports.push({
          file: path.relative(root, file),
          count: unresolved.length,
          reason: approved.reason,
        });
      }
    }
    for (const item of imports) {
      const location = `${path.relative(process.cwd(), file)}:${item.line ?? 0}`;
      edges.push({ file: path.relative(root, file), ...item });
      if (
        item.specifier == null &&
        (item.kind === 'dynamic-import' || item.kind === 'require')
      ) {
        if (approved != null && item.kind === approved.kind) continue;
        addFinding(
          findings,
          'UNRESOLVED_MODULE_SPECIFIER',
          location,
          `${item.kind} must have a literal specifier to prove its dependency closure`,
        );
        continue;
      }
      if (isDonorSpecifier(item.specifier))
        addFinding(findings, 'DONOR_PACKAGE_IMPORT', location, item.specifier);
      if (item.specifier.startsWith('.')) {
        const resolved = resolveRelativeImport(file, item.specifier);
        if (resolved != null && isDonorPath(resolved))
          addFinding(findings, 'DONOR_SOURCE_IMPORT', location, resolved);
      }
    }
  }
  return {
    label,
    root,
    fileCount: files.length,
    imports: edges,
    approvedDynamicImports,
  };
}

function resolveRelativeImport(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return fs.realpathSync(candidate);
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const index = path.join(base, `index${ext}`);
    if (fs.existsSync(index) && fs.statSync(index).isFile())
      return fs.realpathSync(index);
  }
  return null;
}

function inspectManifest(manifestPath, label, findings) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dependencies = manifestProductionDependencies(manifest);
  for (const name of Object.keys(dependencies)) {
    if (isDonorSpecifier(name))
      addFinding(findings, 'DONOR_PACKAGE_DEPENDENCY', manifestPath, name);
  }
  return {
    label,
    path: manifestPath,
    name: manifest.name,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)),
    ),
    donorDependencies: Object.keys(dependencies).filter(isDonorSpecifier),
  };
}

function inspectRootWorkspace(repoRoot, findings) {
  const manifestPath = path.join(repoRoot, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedWorkspaces = [
    { path: 'packages/compiler', name: '@pandamstyle/compiler' },
    { path: 'packages/core', name: '@pandamstyle/core' },
    { path: 'packages/vite', name: '@pandamstyle/vite' },
    { path: 'packages/next', name: '@pandamstyle/next' },
    { path: 'packages/rsbuild', name: '@pandamstyle/rsbuild' },
  ];
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);

  if (manifest.name !== 'pandamstyle-workspace')
    addFinding(
      findings,
      'ROOT_PACKAGE_IDENTITY_INVALID',
      manifestPath,
      `expected pandamstyle-workspace, found ${manifest.name ?? 'unnamed'}`,
    );
  if (manifest.private !== true)
    addFinding(
      findings,
      'ROOT_WORKSPACE_PACKAGE_MUST_BE_PRIVATE',
      manifestPath,
      'the root workspace must not become a public package',
    );
  if (manifest.packageManager !== 'yarn@1.22.22')
    addFinding(
      findings,
      'ROOT_PACKAGE_MANAGER_INVALID',
      manifestPath,
      `expected yarn@1.22.22, found ${manifest.packageManager ?? 'unset'}`,
    );
  if (
    workspaces.length !== expectedWorkspaces.length ||
    expectedWorkspaces.some((item) => !workspaces.includes(item.path))
  ) {
    addFinding(
      findings,
      'ROOT_WORKSPACE_SET_INVALID',
      manifestPath,
      `expected ${expectedWorkspaces.map((item) => item.path).join(', ')}, found ${workspaces.join(', ')}`,
    );
  }

  const workspacePackages = [];
  for (const { path: relativePath, name: expectedName } of expectedWorkspaces) {
    const packagePath = path.join(repoRoot, relativePath, 'package.json');
    if (!fs.existsSync(packagePath)) {
      addFinding(
        findings,
        'ROOT_WORKSPACE_PACKAGE_MISSING',
        relativePath,
        'workspace entry has no package manifest',
      );
      continue;
    }
    const workspaceManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (workspaceManifest.name !== expectedName)
      addFinding(
        findings,
        'ROOT_WORKSPACE_PACKAGE_IDENTITY_INVALID',
        relativePath,
        `expected ${expectedName}, found ${workspaceManifest.name ?? 'unnamed'}`,
      );
    workspacePackages.push({
      path: relativePath,
      name: workspaceManifest.name ?? null,
    });
  }

  const scripts = manifest.scripts ?? {};
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  const donorDependencies = Object.keys(dependencies)
    .filter(isDonorSpecifier)
    .sort();
  for (const dependency of donorDependencies)
    addFinding(
      findings,
      'DONOR_ROOT_TOOL_DEPENDENCY',
      manifestPath,
      dependency,
    );
  const forbiddenScriptReference =
    /@stylexjs\/|@pandacss\/|style-value-parser|upstream\/(stylex|panda)|packages\/(?:@stylexjs|style-value-parser)/i;
  for (const [name, command] of Object.entries(scripts)) {
    if (/^(?:release|publish)(?::|$)/i.test(name))
      addFinding(
        findings,
        'DONOR_RELEASE_SCRIPT_ACTIVE',
        `${manifestPath}#scripts.${name}`,
        'root release/publish machinery is outside Phase 5 scope',
      );
    if (forbiddenScriptReference.test(command))
      addFinding(
        findings,
        'DONOR_SCRIPT_REFERENCE',
        `${manifestPath}#scripts.${name}`,
        command,
      );
  }

  return {
    path: manifestPath,
    name: manifest.name ?? null,
    packageManager: manifest.packageManager ?? null,
    private: manifest.private === true,
    workspaces,
    workspacePackages,
    dependencyNames: Object.keys(dependencies).sort(),
    donorDependencies,
    scripts: Object.keys(scripts).sort(),
  };
}

async function inspectRollupGraph(repoRoot, findings) {
  const compilerDir = path.join(repoRoot, 'packages/compiler');
  const originalCwd = process.cwd();
  const graphs = [];
  try {
    process.chdir(compilerDir);
    const { default: configs } = await import(
      pathToFileURL(path.join(compilerDir, 'rollup.config.mjs')).href
    );
    const { rollup } = await import('rollup');
    for (const config of configs) {
      const inputPaths =
        typeof config.input === 'string'
          ? [config.input]
          : Array.isArray(config.input)
            ? config.input
            : Object.values(config.input ?? {});
      if (!inputPaths.some((input) => String(input).startsWith('./src/')))
        continue;
      const bundle = await rollup(config);
      try {
        const outputOptions = Array.isArray(config.output)
          ? config.output[0]
          : config.output;
        const generated = await bundle.generate(outputOptions);
        const watchFiles = bundle.watchFiles.map((file) => path.resolve(file));
        const donorFiles = watchFiles.filter(isDonorPath);
        const donorImports = generated.output.flatMap((chunk) =>
          chunk.type === 'chunk'
            ? [...chunk.imports, ...chunk.dynamicImports].filter(
                isDonorSpecifier,
              )
            : [],
        );
        if (donorFiles.length > 0)
          addFinding(
            findings,
            'DONOR_ROLLUP_SOURCE',
            'compiler Rollup graph',
            donorFiles,
          );
        for (const specifier of donorImports)
          addFinding(
            findings,
            'DONOR_ROLLUP_EXTERNAL',
            'compiler Rollup output',
            specifier,
          );
        graphs.push({
          input: inputPaths,
          watchedFileCount: watchFiles.length,
          donorSourceFiles: donorFiles,
          emittedImports: generated.output.flatMap((chunk) =>
            chunk.type === 'chunk'
              ? [...chunk.imports, ...chunk.dynamicImports]
              : [],
          ),
        });
      } finally {
        await bundle.close();
      }
    }
    if (graphs.length === 0)
      addFinding(
        findings,
        'ROLLUP_PRODUCTION_GRAPH_EMPTY',
        'packages/compiler/rollup.config.mjs',
        'no compiler source entry was inspected',
      );
    return graphs;
  } catch (error) {
    addFinding(
      findings,
      'ROLLUP_GRAPH_FAILED',
      'packages/compiler/rollup.config.mjs',
      error.message,
    );
    return graphs;
  } finally {
    process.chdir(originalCwd);
  }
}

function pathToFileURL(file) {
  return require('url').pathToFileURL(file);
}

function tarManifest(tarball) {
  const text = execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], {
    encoding: 'utf8',
  });
  return JSON.parse(text);
}

function inspectPackedPackages(repoRoot, pilotDir, findings) {
  const tarDir = path.join(pilotDir, '.tarballs');
  if (!fs.existsSync(tarDir)) {
    addFinding(
      findings,
      'PACKED_TARBALLS_MISSING',
      tarDir,
      'pilot tarballs are absent',
    );
    return {
      packages: [],
      installedGraph: {
        complete: false,
        packages: [],
        optionalMissingDependencies: [],
      },
    };
  }
  const tarballs = fs
    .readdirSync(tarDir)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(tarDir, name));
  const expected = new Map([
    ['@pandamstyle/compiler', null],
    ['@pandamstyle/core', null],
    ['@pandamstyle/vite', null],
  ]);
  for (const tarball of tarballs) {
    try {
      const manifest = tarManifest(tarball);
      if (expected.has(manifest.name)) {
        if (expected.get(manifest.name) != null)
          addFinding(
            findings,
            'PACKED_PACKAGE_DUPLICATE',
            tarball,
            manifest.name,
          );
        expected.set(manifest.name, { tarball, manifest });
      }
    } catch (error) {
      addFinding(
        findings,
        'PACKED_MANIFEST_UNREADABLE',
        tarball,
        error.message,
      );
    }
  }
  for (const [name, value] of expected) {
    if (value == null)
      addFinding(findings, 'PACKED_PACKAGE_MISSING', tarDir, name);
  }

  const packages = [];
  const extractionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-donor-closure-'),
  );
  try {
    for (const [name, packed] of expected) {
      if (packed == null) continue;
      const unpacked = path.join(extractionRoot, name.replace('/', '__'));
      fs.mkdirSync(unpacked, { recursive: true });
      execFileSync('tar', ['-xzf', packed.tarball, '-C', unpacked]);
      const packageDir = path.join(unpacked, 'package');
      const manifestProof = inspectManifest(
        path.join(packageDir, 'package.json'),
        `packed ${name}`,
        findings,
      );
      const sourceFiles = filesBelow(packageDir);
      const imports = [];
      for (const file of sourceFiles) {
        try {
          for (const item of parseModuleImports(
            fs.readFileSync(file, 'utf8'),
            file,
          )) {
            if (item.typeOnly) continue;
            imports.push({ file: path.relative(packageDir, file), ...item });
            if (isDonorSpecifier(item.specifier))
              addFinding(
                findings,
                'DONOR_PACKED_IMPORT',
                `${name}/${path.relative(packageDir, file)}:${item.line ?? 0}`,
                item.specifier,
              );
          }
        } catch (error) {
          addFinding(
            findings,
            'PACKED_SOURCE_PARSE_FAILED',
            file,
            error.message,
          );
        }
      }
      packages.push({
        ...manifestProof,
        tarball: path.basename(packed.tarball),
        fileCount: sourceFiles.length,
        imports,
      });
    }
  } catch (error) {
    addFinding(
      findings,
      'PACKED_EXTRACTION_FAILED',
      extractionRoot,
      error.message,
    );
  } finally {
    fs.rmSync(extractionRoot, { recursive: true, force: true });
  }

  const installRoot = path.join(pilotDir, 'app');
  const packageDirs = new Map();
  for (const name of expected.keys()) {
    const dir = path.join(installRoot, 'node_modules', ...name.split('/'));
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      addFinding(findings, 'PACKED_PACKAGE_NOT_INSTALLED', dir, name);
      continue;
    }
    const real = fs.realpathSync(dir);
    const sourcePath = path.join(repoRoot, 'packages');
    if (real === sourcePath || real.startsWith(`${sourcePath}${path.sep}`))
      addFinding(findings, 'WORKSPACE_LEAKAGE', dir, real);
    packageDirs.set(name, real);
  }
  const installedGraph = walkInstalledGraph(packageDirs, findings);
  return {
    packages,
    installedGraph: {
      complete: installedGraph.complete,
      packages: installedGraph.packages,
      optionalMissingDependencies: installedGraph.optionalMissingDependencies,
      donorPackages: installedGraph.donorPackages,
      workspaceLeakage: findings.some(
        (finding) => finding.code === 'WORKSPACE_LEAKAGE',
      ),
    },
  };
}

function resolveInstalledPackage(parentDir, name) {
  let current = parentDir;
  while (true) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'));
    const manifestPath = path.join(candidate, 'package.json');
    if (fs.existsSync(manifestPath)) return fs.realpathSync(candidate);
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function walkInstalledGraph(roots, findings) {
  const visited = new Set();
  const packages = [];
  const optionalMissingDependencies = [];
  let complete = true;
  const queue = [...roots.entries()].map(([name, dir]) => ({ name, dir }));
  while (queue.length > 0) {
    const { name, dir } = queue.shift();
    let real;
    let manifest;
    try {
      real = fs.realpathSync(dir);
      if (visited.has(real)) continue;
      visited.add(real);
      manifest = JSON.parse(
        fs.readFileSync(path.join(real, 'package.json'), 'utf8'),
      );
    } catch (error) {
      complete = false;
      addFinding(findings, 'INSTALLED_GRAPH_INCOMPLETE', dir, error.message);
      continue;
    }
    packages.push({
      name: manifest.name ?? name,
      version: manifest.version ?? null,
      path: real,
    });
    if (isDonorSpecifier(manifest.name ?? name))
      addFinding(
        findings,
        'DONOR_INSTALLED_PACKAGE',
        real,
        manifest.name ?? name,
      );
    for (const edge of manifestInstalledDependencyEdges(manifest)) {
      const { name: dependency, optional } = edge;
      if (isDonorSpecifier(dependency))
        addFinding(findings, 'DONOR_INSTALLED_DEPENDENCY', real, dependency);
      const resolved = resolveInstalledPackage(real, dependency);
      if (resolved == null) {
        if (optional) {
          optionalMissingDependencies.push({
            package: manifest.name ?? name,
            dependency,
          });
          continue;
        }
        complete = false;
        addFinding(findings, 'INSTALLED_DEPENDENCY_MISSING', real, dependency);
      } else queue.push({ name: dependency, dir: resolved });
    }
  }
  return {
    complete,
    packages,
    optionalMissingDependencies,
    donorPackages: [
      ...new Set(packages.map((item) => item.name).filter(isDonorSpecifier)),
    ].sort(),
  };
}

function inspectGeneratedRuntime(root, findings) {
  if (!fs.existsSync(root)) {
    addFinding(
      findings,
      'GENERATED_RUNTIME_MISSING',
      root,
      'artifact directory is absent',
    );
    return { fileCount: 0, imports: [], donorImports: [] };
  }
  const files = filesBelow(root);
  const imports = [];
  for (const file of files) {
    try {
      for (const item of parseModuleImports(
        fs.readFileSync(file, 'utf8'),
        file,
      )) {
        if (item.typeOnly) continue;
        const detail = { file: path.relative(root, file), ...item };
        imports.push(detail);
        if (isDonorSpecifier(item.specifier))
          addFinding(
            findings,
            'DONOR_GENERATED_RUNTIME_IMPORT',
            `${detail.file}:${item.line ?? 0}`,
            item.specifier,
          );
      }
    } catch (error) {
      addFinding(
        findings,
        'GENERATED_RUNTIME_PARSE_FAILED',
        file,
        error.message,
      );
    }
  }
  return {
    fileCount: files.length,
    imports,
    coreImportCount: imports.filter(
      (item) => item.specifier === '@pandamstyle/core',
    ).length,
    donorImports: imports.filter((item) => isDonorSpecifier(item.specifier)),
  };
}

function inspectBuiltCompiler(libDir, findings) {
  const files = filesBelow(libDir);
  const imports = [];
  for (const file of files) {
    try {
      for (const item of parseModuleImports(
        fs.readFileSync(file, 'utf8'),
        file,
      )) {
        if (item.typeOnly) continue;
        imports.push({ file: path.relative(libDir, file), ...item });
        if (isDonorSpecifier(item.specifier))
          addFinding(
            findings,
            'DONOR_BUILT_IMPORT',
            `${path.relative(libDir, file)}:${item.line ?? 0}`,
            item.specifier,
          );
      }
    } catch (error) {
      addFinding(findings, 'BUILT_ARTIFACT_PARSE_FAILED', file, error.message);
    }
  }
  if (files.length === 0)
    addFinding(
      findings,
      'BUILT_ARTIFACTS_MISSING',
      libDir,
      'compiler lib is empty',
    );
  return {
    fileCount: files.length,
    imports,
    donorImports: imports.filter((item) => isDonorSpecifier(item.specifier)),
  };
}

async function verify(repoRoot, pilotDir, generatedDir) {
  const findings = [];
  const repositoryPaths = inspectForbiddenRepositoryPaths(repoRoot, findings);
  const rootWorkspace = inspectRootWorkspace(repoRoot, findings);
  const coreManifest = inspectManifest(
    path.join(repoRoot, 'packages/core/package.json'),
    'core source manifest',
    findings,
  );
  const compilerManifest = inspectManifest(
    path.join(repoRoot, 'packages/compiler/package.json'),
    'compiler source manifest',
    findings,
  );
  const coreSources = inspectSourceTree(
    path.join(repoRoot, 'packages/core/src'),
    'core source',
    findings,
  );
  const compilerSources = inspectSourceTree(
    path.join(repoRoot, 'packages/compiler/src'),
    'compiler source',
    findings,
  );
  const buildSources = inspectSourceTree(
    path.join(repoRoot, 'packages/compiler/bin'),
    'compiler CLI source',
    findings,
  );
  const rollupGraphs = await inspectRollupGraph(repoRoot, findings);
  const builtCompiler = inspectBuiltCompiler(
    path.join(repoRoot, 'packages/compiler/lib'),
    findings,
  );
  const generatedRuntime = inspectGeneratedRuntime(generatedDir, findings);
  const packed = inspectPackedPackages(repoRoot, pilotDir, findings);
  return {
    documentKind: 'pandamstyle-phase-5-donor-closure',
    repo: path.basename(repoRoot),
    generatedAt: new Date().toISOString(),
    pass: findings.length === 0,
    productionDonorEngineEdges: findings.filter((finding) =>
      /DONOR_/.test(finding.code),
    ).length,
    repositoryPaths,
    rootWorkspace,
    findings,
    core: { manifest: coreManifest, sources: coreSources },
    compiler: {
      manifest: compilerManifest,
      sources: compilerSources,
      cliSources: buildSources,
      rollupGraphs,
      builtArtifacts: builtCompiler,
    },
    generatedRuntime,
    packed,
  };
}

async function main(args) {
  const [repoRootArg, pilotDirArg, generatedDirArg, reportArg] = args;
  if (!repoRootArg || !pilotDirArg || !generatedDirArg || !reportArg) {
    throw new Error(
      'usage: donor-closure.js <repo-root> <pilot-dir> <generated-runtime-dir> <report.json>',
    );
  }
  const repoRoot = path.resolve(repoRootArg);
  const pilotDir = path.resolve(pilotDirArg);
  const generatedDir = path.resolve(generatedDirArg);
  const reportPath = path.resolve(reportArg);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = await verify(repoRoot, pilotDir, generatedDir);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(
    `donor closure: ${report.pass ? 'PASS' : 'FAIL'} (${report.findings.length} findings)`,
  );
  if (!report.pass) {
    for (const finding of report.findings)
      console.error(`${finding.code}: ${finding.location}: ${finding.detail}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  inspectBuiltCompiler,
  inspectGeneratedRuntime,
  inspectForbiddenRepositoryPaths,
  inspectManifest,
  manifestInstalledDependencyEdges,
  inspectPackedPackages,
  inspectRollupGraph,
  inspectRootWorkspace,
  inspectSourceTree,
  isDonorPath,
  isDonorSpecifier,
  resolveInstalledPackage,
  verify,
  walkInstalledGraph,
};
