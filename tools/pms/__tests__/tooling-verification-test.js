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
const { execFileSync, spawnSync } = require('child_process');
const {
  inspectManifest,
  inspectForbiddenRepositoryPaths,
  inspectRootWorkspace,
  inspectSourceTree,
  isDonorPath,
  isDonorSpecifier,
  walkInstalledGraph,
} = require('../donor-closure');
const { assessStep } = require('../step-contracts');
const { parseModuleImports } = require('../module-imports');
const { parseJestCounts } = require('../test-counts');

const ROOT = path.resolve(__dirname, '../../..');
const ORDER = [
  'install',
  'build',
  'pandamstyle',
  'pandamstyle-core',
  'semantic-oracle',
  'tooling-tests',
  'pilot',
  'artifacts',
  'donor-closure',
  'package-qualification',
  'next-qualification',
  'rsbuild-qualification',
];
let fixture;

function write(relative, text, executable = false) {
  const file = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: executable ? 0o755 : 0o644 });
}

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-eleven-step-'));
  write('verify-pms.sh', fs.readFileSync(path.join(ROOT, 'verify-pms.sh')));
  write('jest.config.js', fs.readFileSync(path.join(ROOT, 'jest.config.js')));
  for (const name of [
    'test-counts.js',
    'step-contracts.js',
    'run-tooling-tests.js',
    'module-imports.js',
  ]) {
    write(
      `tools/pms/${name}`,
      fs.readFileSync(path.join(ROOT, 'tools/pms', name)),
    );
  }
  write(
    'tools/pms/generated-runtime-imports.js',
    fs.readFileSync(path.join(ROOT, 'tools/pms/generated-runtime-imports.js')),
  );
  write(
    'tools/pms/donor-closure.js',
    `const fs = require('fs');
const path = require('path');
const output = process.argv[process.argv.length - 1];
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ pass: true, findings: [] }) + '\\n');
`,
  );
  write(
    'tools/pms/package-qualification.js',
    `const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
if (fs.readFileSync(path.join(root, 'mode'), 'utf8') !== 'qualification-missing') {
  const output = process.argv[2];
  fs.mkdirSync(output, { recursive: true });
  const names = fs.readFileSync(path.join(root, 'mode'), 'utf8') === 'qualification-without-vite'
    ? ['@pandamstyle/core', '@pandamstyle/compiler']
    : fs.readFileSync(path.join(root, 'mode'), 'utf8') === 'qualification-without-rsbuild'
      ? ['@pandamstyle/core', '@pandamstyle/compiler', '@pandamstyle/vite', '@pandamstyle/next']
      : fs.readFileSync(path.join(root, 'mode'), 'utf8') === 'qualification-without-next'
        ? ['@pandamstyle/core', '@pandamstyle/compiler', '@pandamstyle/vite', '@pandamstyle/rsbuild']
        : ['@pandamstyle/core', '@pandamstyle/compiler', '@pandamstyle/vite', '@pandamstyle/next', '@pandamstyle/rsbuild'];
  const packages = Object.fromEntries(names.map(name => [name, { tarballContents: 'passed', reproducibility: { contentDigestsStable: true } }]));
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ pass: true, packages, externalConsumer: { vite: { pass: true }, next: { pass: true }, rsbuild: { pass: true }, checkpoint: { pass: true }, typeScript: { viteOptions: 'passed', rsbuildOptions: 'passed', nextOptions: 'passed' } } }) + '\\n');
}
`,
  );
  write(
    'tools/pms/qualify-next.mjs',
    `import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const output = process.argv[2];
fs.mkdirSync(output, { recursive: true });
if (mode !== 'next-missing') fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ pass: true, phase10Complete: mode !== 'next-blocked' }));
`,
  );
  write('yarn.lock', '# fixture lockfile\n');
  write(
    'tools/pilot/run-rsbuild-qualification.js',
    "const fs = require('fs'); const path = require('path'); const root = path.resolve(__dirname, '../..'); const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8'); if (mode !== 'rsbuild-missing') { fs.mkdirSync(process.argv[2], { recursive: true }); fs.writeFileSync(path.join(process.argv[2], 'report.json'), JSON.stringify({ complete: mode !== 'rsbuild-incomplete', start: { dev: { pass: true }, production: { pass: true } }, isolation: { pass: true }, failures: [{ pass: true }], bundleScan: { pass: true } })); }",
  );
  write(
    'tools/semantic-oracle/run.js',
    'process.stderr.write("Test Suites: 1 passed, 1 total\\nTests: 2 passed, 2 total\\n");\n',
  );
  write(
    'bin/yarn',
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.22.22; fi\n',
    true,
  );
  for (const name of ['rollup'])
    write(`node_modules/.bin/${name}`, '#!/bin/sh\nexit 0\n', true);
  write(
    'node_modules/.bin/jest',
    '#!/bin/sh\nexec node "$(dirname "$0")/../jest/bin/jest.js" "$@"\n',
    true,
  );
  fs.symlinkSync(
    path.join(ROOT, 'node_modules/glob'),
    path.join(fixture, 'node_modules/glob'),
  );
  for (const name of ['@babel/parser', 'hermes-parser']) {
    const source = path.join(ROOT, 'node_modules', ...name.split('/'));
    const target = path.join(fixture, 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
  }
  for (const name of ['a', 'b', 'c'])
    write(`tools/pms/__tests__/${name}-test.js`, '// fixture suite\n');
  write('packages/compiler/lib/index.mjs', '// delivered build\n');
  write('packages/compiler/package.json', '{"name":"@pandamstyle/compiler"}\n');
  write('packages/core/package.json', '{"name":"@pandamstyle/core"}\n');
  write('packages/core/src/index.js', 'export {};\n');
  write(
    'packages/vite/package.json',
    JSON.stringify({
      name: '@pandamstyle/vite',
      type: 'module',
      exports: {
        '.': { types: './types/index.d.ts', import: './src/index.js' },
      },
      peerDependencies: { vite: '8.3.1' },
    }) + '\n',
  );
  write('packages/vite/src/index.js', 'export function pandamstyle() {}\n');
  write(
    'packages/rsbuild/package.json',
    JSON.stringify({
      name: '@pandamstyle/rsbuild',
      type: 'module',
      exports: { '.': { import: './src/index.js' } },
      peerDependencies: { '@rsbuild/core': '2.2.11' },
    }),
  );
  write('packages/rsbuild/src/index.js', 'export function pandamstyle() {}\n');
  write(
    'packages/vite/types/index.d.ts',
    'export declare function pandamstyle(): void;\n',
  );
  write(
    'tools/pms/core-package-proof.js',
    `const fs = require('fs');
const path = require('path');
const output = process.argv[2];
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'proof.json'), '{}\\n');
`,
  );
  write('packages/compiler/bin/pms-build.js', '// fixture generator\n');
  write(
    'packages/compiler/__tests__/pandamstyle/fixtures/valid/generated/fixture.css',
    '.fixture{}\n',
  );
  write(
    'packages/compiler/__tests__/pandamstyle/fixtures/valid/generated/design.pandamstyle.js',
    "import { props } from '@pandamstyle/core';\nexport { props };\n",
  );
  write('tools/pilot/run-pilot.sh', '#!/bin/sh\nexit 0\n', true);
  // Substitute costly commands, but exercise the actual shell runner, helper,
  // contract dispatcher, parser, summary writer and final exit decision.
  write(
    'node_modules/jest/bin/jest.js',
    `
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const mode = fs.readFileSync(path.join(root, 'mode'), 'utf8');
const args = process.argv.slice(2);
const tooling = args.some(a => a.includes('tools/pms/__tests__'));
const core = args.some(a => a.includes('/packages/core/__tests__/core-test.js'));
const semantic = args.some(a => a.includes('semantic-oracle'));
const pandamstyle = args.some(a => a.includes('/packages/compiler/__tests__/pandamstyle'));
const files = ['a', 'b', 'c'].map(n => path.join(root, 'tools/pms/__tests__', n + '-test.js'));
if (args.includes('--listTests')) {
  console.log(JSON.stringify(mode === 'discovery-missing' ? files.slice(1) : files));
  process.exit(0);
}
let tests = tooling ? 43 : core ? 14 : semantic ? 2 : pandamstyle ? 547 : 1007;
let suites = tooling ? 3 : core ? 1 : semantic ? 1 : pandamstyle ? 25 : 42;
let log = 'Test Suites: ' + suites + ' passed, ' + (tests === 1007 ? '1 skipped, ' : '') + (suites + (tests === 1007 ? 1 : 0)) + ' total\\nTests: ' + tests + ' passed, ' + (tests === 1007 ? '64 skipped, ' : '') + (tests + (tests === 1007 ? 64 : 0)) + ' total\\n';
if (tooling) {
  if (mode === 'command-fails') process.exit(2);
  if (mode === 'test-fails') log = 'Test Suites: 1 failed, 2 passed, 3 total\\nTests: 1 failed, 42 passed, 43 total\\n';
  if (mode === 'suite-fails') log = 'FAIL b-test.js\\nTest suite failed to run\\nTest Suites: 1 failed, 2 passed, 3 total\\nTests: 43 passed, 43 total\\n';
  if (mode === 'counts-missing') log = 'no count output\\n';
  if (mode === 'tests-line-missing') log = 'Test Suites: 3 passed, 3 total\\n';
  if (mode === 'suites-line-missing') log = 'Tests: 43 passed, 43 total\\n';
  if (mode === 'tests-unaccounted') log = 'Test Suites: 3 passed, 3 total\\nTests: 42 passed, 43 total\\n';
  if (mode === 'suites-unaccounted') log = 'Test Suites: 2 passed, 3 total\\nTests: 43 passed, 43 total\\n';
  if (mode === 'total-missing') log = 'Test Suites: 3 passed\\nTests: 43 passed\\n';
  fs.writeFileSync(args[args.indexOf('--outputFile') + 1], JSON.stringify({
    testResults: (mode === 'execution-missing' ? files.slice(1) : files).map(name => ({name})),
    numTotalTestSuites: 3, numPassedTestSuites: 3, numFailedTests: 0, success: true,
  }));
}
process.stderr.write(log);
`,
  );
  write('mode', 'green');
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: fixture, env: gitEnv, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'eleven-step fixture');
  git('branch', 'fixture-base');
});

afterAll(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

function run(mode = 'green', env = {}, omitted = false, reuseOutput = false) {
  write('mode', mode);
  const original = fs.readFileSync(path.join(ROOT, 'verify-pms.sh'), 'utf8');
  write(
    'verify-pms.sh',
    omitted
      ? original.replace(
          new RegExp(
            (omitted === 'pilot'
              ? 'if \\[ "\\$\\{PMS_SKIP_PILOT:-0\\}" = "1" \\]; then[\\s\\S]*?elif is_filtered_out "'
              : 'if is_filtered_out "') +
              (omitted === true ? 'tooling-tests' : omitted) +
              '"; then[\\s\\S]*?\\nfi\\n',
          ),
          '',
        )
      : original,
  );
  const outDir = path.join(fixture, 'evidence/run');
  if (!reuseOutput) fs.rmSync(outDir, { recursive: true, force: true });
  const result = spawnSync('bash', ['verify-pms.sh'], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH,
      PMS_OUT_DIR: outDir,
      PMS_BATCH_BASE_REF: 'fixture-base',
      PMS_SKIP_INSTALL: '',
      PMS_SKIP_PILOT: '',
      PMS_ONLY_STEPS: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.error) throw result.error;
  return {
    ...result,
    summary: fs.existsSync(path.join(outDir, 'summary.json'))
      ? JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'))
      : null,
  };
}

test('the real summary accepts a green eleven-step fixture with separate and summed counts', () => {
  const { status, stdout, summary } = run();
  if (status !== 0) throw new Error(`${stdout}\n${summary?.failedSteps ?? ''}`);
  expect(stdout).toContain('VERIFICATION OK');
  expect(Object.keys(summary.steps)).toEqual(ORDER);
  expect(summary.requiredStepCount).toBe(12);
  expect(summary.requiredStepOrder).toEqual(ORDER);
  expect(summary.omittedRequiredSteps).toEqual([]);
  expect(summary.complete).toBe(true);
  expect(summary.verification.verdict).toBe('verified');
  expect(summary.failedSteps).toEqual([]);
  expect(summary.skippedSteps).toEqual([]);
  for (const name of ORDER)
    expect(summary.steps[name].verification.verdict).toBe('verified');
  expect(summary.steps['tooling-tests'].kind).toBe('test');
  expect(summary.steps['tooling-tests'].counts.testsPassed).toBe(43);
  expect(summary.steps['semantic-oracle'].kind).toBe('test');
  expect(summary.steps['semantic-oracle'].counts.testsPassed).toBe(2);
  expect(summary.steps.pandamstyle.counts.testsPassed).toBe(547);
  expect(summary.steps['donor-closure'].kind).toBe('artifact-check');
  expect(summary.steps['package-qualification'].kind).toBe('artifact-check');
  expect(summary.steps['pandamstyle-core'].kind).toBe('test');
  expect(summary.steps['pandamstyle-core'].counts.testsPassed).toBe(14);
  expect(summary.verification.testsPassed).toBe(606);
  expect(summary.verification.suitesPassed).toBe(30);
  expect(summary.verification.testsSkipped).toBe(0);
  expect(summary.verification.suitesSkipped).toBe(0);
  for (const name of [
    'install',
    'build',
    'pilot',
    'artifacts',
    'donor-closure',
    'package-qualification',
  ])
    expect(summary.steps[name].counts).toBeNull();
});

test('package qualification requires a report even when its command exits zero', () => {
  const { status, summary } = run('qualification-missing');
  expect(status).not.toBe(0);
  expect(summary.steps['package-qualification'].exitCode).toBe(0);
  expect(summary.steps['package-qualification'].verification.verdict).toBe(
    'failed',
  );
  expect(
    summary.steps['package-qualification'].verification.findings.map(
      (item) => item.code,
    ),
  ).toContain('ARTIFACT_MISSING');
});

test('the real verifier rejects package qualification that omits Vite', () => {
  const { status, summary } = run('qualification-without-vite');
  expect(status).not.toBe(0);
  expect(summary.failedSteps).toContain('package-qualification');
});

test('the real verifier rejects a blocked Next backend', () => {
  const { status, summary } = run('next-blocked');
  expect(status).not.toBe(0);
  expect(summary.failedSteps).toEqual(['next-qualification']);
  expect(summary.complete).toBe(false);
});

test('the real verifier rejects missing Next evidence', () => {
  const { status, summary } = run('next-missing');
  expect(status).not.toBe(0);
  expect(summary.failedSteps).toContain('next-qualification');
});

test('the real verifier rejects package qualification that omits Next', () => {
  const { status, summary } = run('qualification-without-next');
  expect(status).not.toBe(0);
  expect(summary.failedSteps).toContain('package-qualification');
});

test('the real verifier rejects package qualification that omits Rsbuild', () => {
  const { status, summary } = run('qualification-without-rsbuild');
  expect(status).not.toBe(0);
  expect(summary.failedSteps).toContain('package-qualification');
});

test.each(['rsbuild-missing', 'rsbuild-incomplete'])(
  'Rsbuild qualification cannot be green with %s evidence',
  (mode) => {
    const { status, summary } = run(mode);
    expect(status).not.toBe(0);
    expect(summary.complete).toBe(false);
    expect(summary.steps['rsbuild-qualification'].verification.verdict).toBe(
      'failed',
    );
  },
);

test.each([
  'build',
  'pilot',
  'package-qualification',
  'next-qualification',
  'rsbuild-qualification',
])('a required %s step cannot be omitted from a green run', (step) => {
  const { status, summary } = run('green', {}, step);
  expect(status).not.toBe(0);
  expect(summary.omittedRequiredSteps).toContain(step);
  expect(summary.complete).toBe(false);
});

test('the verifier builds Vite and its pilot installs all three public tarballs', () => {
  const verifier = fs.readFileSync(path.join(ROOT, 'verify-pms.sh'), 'utf8');
  const pilot = fs.readFileSync(
    path.join(ROOT, 'tools/pilot/run-pilot.sh'),
    'utf8',
  );
  const qualification = fs.readFileSync(
    path.join(ROOT, 'tools/pms/package-qualification.js'),
    'utf8',
  );
  const nextQualification = fs.readFileSync(
    path.join(ROOT, 'tools/pms/qualify-next.mjs'),
    'utf8',
  );
  const vitePilot = fs.readFileSync(
    path.join(ROOT, 'tools/pilot/qualify-vite.mjs'),
    'utf8',
  );
  const minimumNodeVitePilot = fs.readFileSync(
    path.join(ROOT, 'tools/pilot/qualify-vite-node-minimum.mjs'),
    'utf8',
  );
  const viteManifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'packages/vite/package.json'), 'utf8'),
  );
  expect(viteManifest.peerDependencies.vite).toBe('8.3.1');
  expect(verifier).toContain(
    'node --check "$REPO_ROOT/packages/vite/src/index.js"',
  );
  expect(verifier).toContain('p.peerDependencies?.vite !== "8.3.1"');
  expect(pilot).toContain('for package in compiler core vite; do');
  expect(pilot).toContain("manifest.peerDependencies.vite, '8.3.1'");
  expect(pilot).toContain("await import('@pandamstyle/vite')");
  expect(pilot).toContain('.qualify-vite.mjs');
  expect(pilot).toContain('PMS_PILOT_SOURCE_ROOT="${REPO_ROOT}"');
  expect(vitePilot).toContain('process.env.PMS_PILOT_SOURCE_ROOT');
  expect(minimumNodeVitePilot).toContain('process.env.PMS_PILOT_SOURCE_ROOT');
  expect(qualification).toContain("? { vite: '8.3.1' }");
  expect(qualification).toContain("'vite@8.3.1'");
  expect(qualification).toContain("'react@19.3.0'");
  expect(nextQualification).toContain("'vite@8.3.1'");
  expect(nextQualification).toContain("'react@19.3.0'");
  expect(qualification).toContain("'@pandamstyle/vite': {");
  expect(fs.existsSync(path.join(ROOT, 'tools/pilot/vite-seam.js'))).toBe(
    false,
  );
});

test('the Next semantic-development browser allows a full CDP navigation window', () => {
  const nextSemanticDev = fs.readFileSync(
    path.join(ROOT, 'tools/pms/qualify-next-semantic-dev.mjs'),
    'utf8',
  );
  expect(nextSemanticDev).toContain('protocolTimeout: 60_000');
});

test('donor detection reads module syntax and ignores comments and matcher strings', () => {
  const imports = parseModuleImports(
    "// import '@stylexjs/comment-only';\n" +
      "const denied = '@pandacss/matcher';\n" +
      "import type { Theme } from '@stylexjs/types';\n" +
      "import { props } from '@pandamstyle/core';\n" +
      'const config = import(configPath);\n' +
      'const plugin = require(pluginName);\n' +
      "export { value } from './owned.js';\n",
    'fixture.js',
  );
  expect(imports.map((item) => [item.specifier, item.typeOnly])).toEqual([
    ['@stylexjs/types', true],
    ['@pandamstyle/core', false],
    [null, false],
    [null, false],
    ['./owned.js', false],
  ]);
  expect(isDonorSpecifier('style-value-parser')).toBe(true);
  expect(isDonorSpecifier('styleq')).toBe(true);
  expect(
    isDonorPath(path.join(ROOT, 'packages/style-value-parser/src/index.js')),
  ).toBe(true);
});

test('repository closure fails when a forbidden donor source tree exists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-forbidden-path-'));
  try {
    fs.mkdirSync(path.join(root, 'packages', '@stylexjs'), {
      recursive: true,
    });
    const findings = [];
    const paths = inspectForbiddenRepositoryPaths(root, findings);
    expect(paths.present).toEqual(['packages/@stylexjs']);
    expect(findings).toEqual([
      {
        code: 'FORBIDDEN_REPOSITORY_PATH_PRESENT',
        location: 'packages/@stylexjs',
        detail: 'forbidden donor or archive path exists',
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root workspace closure records only real PandamStyle packages', () => {
  const findings = [];
  const workspace = inspectRootWorkspace(ROOT, findings);
  expect(findings).toEqual([]);
  expect(workspace).toMatchObject({
    name: 'pandamstyle-workspace',
    packageManager: 'yarn@1.22.22',
    private: true,
    workspaces: [
      'packages/core',
      'packages/compiler',
      'packages/vite',
      'packages/next',
      'packages/rsbuild',
    ],
    workspacePackages: [
      { path: 'packages/compiler', name: '@pandamstyle/compiler' },
      { path: 'packages/core', name: '@pandamstyle/core' },
      { path: 'packages/vite', name: '@pandamstyle/vite' },
      { path: 'packages/next', name: '@pandamstyle/next' },
      { path: 'packages/rsbuild', name: '@pandamstyle/rsbuild' },
    ],
  });
  expect(workspace.scripts).not.toContain('release');
});

test('installed closure records absent optional peers without failing the graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-installed-graph-'));
  const packageDir = path.join(root, 'node_modules', 'fixture');
  const installedDir = path.join(root, 'node_modules', 'required-package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(installedDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      dependencies: { 'required-package': '1.0.0' },
      optionalDependencies: { 'optional-platform-package': '1.0.0' },
      peerDependencies: { 'optional-peer-package': '1.0.0' },
      peerDependenciesMeta: {
        'optional-peer-package': { optional: true },
      },
    }),
  );
  fs.writeFileSync(
    path.join(installedDir, 'package.json'),
    JSON.stringify({ name: 'required-package', version: '1.0.0' }),
  );
  try {
    const findings = [];
    const graph = walkInstalledGraph(
      new Map([['fixture', packageDir]]),
      findings,
    );
    expect(graph.complete).toBe(true);
    expect(graph.packages.map((item) => item.name).sort()).toEqual([
      'fixture',
      'required-package',
    ]);
    expect(graph.optionalMissingDependencies).toEqual([
      { package: 'fixture', dependency: 'optional-platform-package' },
      { package: 'fixture', dependency: 'optional-peer-package' },
    ]);
    expect(findings).toEqual([]);

    const manifestPath = path.join(packageDir, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies['required-missing-package'] = '1.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const requiredFindings = [];
    const incompleteGraph = walkInstalledGraph(
      new Map([['fixture', packageDir]]),
      requiredFindings,
    );
    expect(incompleteGraph.complete).toBe(false);
    expect(requiredFindings).toContainEqual({
      code: 'INSTALLED_DEPENDENCY_MISSING',
      location: fs.realpathSync(packageDir),
      detail: 'required-missing-package',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root workspace closure rejects donor workspace and release machinery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-workspace-test-'));
  try {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'stylex-monorepo',
        private: false,
        packageManager: 'yarn@1.22.22',
        workspaces: ['packages/@stylexjs/*'],
        scripts: { release: 'node tools/npm/release.js' },
        devDependencies: { '@stylexjs/babel-plugin': '1.0.0' },
      }),
    );
    const findings = [];
    inspectRootWorkspace(root, findings);
    expect(findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'ROOT_PACKAGE_IDENTITY_INVALID',
        'ROOT_WORKSPACE_PACKAGE_MUST_BE_PRIVATE',
        'ROOT_WORKSPACE_SET_INVALID',
        'ROOT_WORKSPACE_PACKAGE_MISSING',
        'DONOR_RELEASE_SCRIPT_ACTIVE',
        'DONOR_ROOT_TOOL_DEPENDENCY',
      ]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the module scanner parses TypeScript declaration files as TypeScript', () => {
  const imports = parseModuleImports(
    "import type { Donor } from '@stylexjs/shared';\n" +
      'export const Codes: Readonly<Record<string, string>>;\n',
    'types/index.d.ts',
  );
  expect(imports.map((item) => [item.specifier, item.typeOnly])).toEqual([
    ['@stylexjs/shared', true],
  ]);
});

test('the closure scanner fails on restored donor imports and manifest dependencies', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pms-donor-closure-test-'),
  );
  try {
    fs.writeFileSync(
      path.join(root, 'owned.js'),
      "// import '@stylexjs/comment-only';\n" +
        "const matcher = '@pandacss/deny-list';\n" +
        "import { props } from '@pandamstyle/core';\n",
    );
    const findings = [];
    const source = inspectSourceTree(root, 'fixture', findings);
    expect(source.imports.map((item) => item.specifier)).toEqual([
      '@pandamstyle/core',
    ]);
    expect(findings).toEqual([]);

    fs.writeFileSync(
      path.join(root, 'computed-import.js'),
      'const plugin = import(pluginName);\n',
    );
    inspectSourceTree(root, 'fixture', findings);
    expect(findings.map((finding) => finding.code)).toContain(
      'UNRESOLVED_MODULE_SPECIFIER',
    );

    fs.writeFileSync(
      path.join(root, 'reintroduced.js'),
      "export { props } from '@stylexjs/shared';\n" +
        "import { MediaQuery } from 'style-value-parser';\n",
    );
    inspectSourceTree(root, 'fixture', findings);
    expect(findings.map((finding) => finding.code)).toContain(
      'DONOR_PACKAGE_IMPORT',
    );
    expect(findings.map((finding) => finding.detail)).toContain(
      'style-value-parser',
    );

    const manifestPath = path.join(root, 'package.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'fixture',
        dependencies: { '@pandacss/core': '1.0.0' },
      }),
    );
    inspectManifest(manifestPath, 'fixture manifest', findings);
    expect(findings.map((finding) => finding.code)).toContain(
      'DONOR_PACKAGE_DEPENDENCY',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the one computed import for consumer config loading is explicitly pinned', () => {
  const findings = [];
  const source = inspectSourceTree(
    path.join(ROOT, 'packages/compiler/src/api'),
    'compiler CLI source',
    findings,
  );
  expect(findings).toEqual([]);
  expect(source.approvedDynamicImports).toEqual([
    expect.objectContaining({
      file: 'cli.js',
      count: 1,
      reason: expect.stringContaining('consuming project build config'),
    }),
  ]);
});

test.each([
  ['command-fails', 'EXIT_CODE_NONZERO'],
  ['test-fails', 'TEST_FAILED'],
  ['suite-fails', 'SUITE_FAILED'],
  ['counts-missing', 'COUNTS_MISSING'],
  ['tests-line-missing', 'TEST_LINE_MISSING'],
  ['suites-line-missing', 'SUITE_LINE_MISSING'],
  ['tests-unaccounted', 'TESTS_UNACCOUNTED'],
  ['suites-unaccounted', 'SUITES_UNACCOUNTED'],
  ['total-missing', 'TESTS_UNACCOUNTED'],
  ['discovery-missing', 'EXIT_CODE_NONZERO'],
  ['execution-missing', 'EXIT_CODE_NONZERO'],
])('%s cannot make the official summary complete', (mode, code) => {
  const result = run(mode);
  expect(result.status).toBe(1);
  expect(result.summary.complete).toBe(false);
  expect(result.summary.verification.verdict).not.toBe('verified');
  expect(result.stdout).not.toContain('VERIFICATION OK');
  expect(
    result.summary.steps['tooling-tests'].verification.findings.map(
      (f) => f.code,
    ),
  ).toContain(code);
});

test.each(['omitted', 'skipped'])(
  '%s required tooling step makes the actual runner incomplete',
  (mode) => {
    const result = run(
      'green',
      mode === 'skipped'
        ? {
            PMS_ONLY_STEPS: ORDER.filter((n) => n !== 'tooling-tests').join(
              ',',
            ),
          }
        : {},
      mode === 'omitted',
    );
    expect(result.summary.complete).toBe(false);
    expect(result.summary.verification.verdict).toBe('incomplete');
    expect(result.summary.skippedSteps).toEqual(['tooling-tests']);
    expect(
      result.summary.steps['tooling-tests'].verification.findings[0].code,
    ).toBe('STEP_SKIPPED');
    expect(result.stdout).not.toContain('VERIFICATION OK');
  },
);

test('tooling retains the exit disagreement and missing exit evidence findings', () => {
  const counts = parseJestCounts(
    'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total\n',
  );
  for (const [exitCode, code] of [
    [0, 'EXIT_CODE_DISAGREES'],
    [null, 'EXIT_CODE_MISSING'],
  ]) {
    const verdict = assessStep({
      step: 'tooling-tests',
      status: 'passed',
      exitCode,
      counts,
    });
    expect(verdict.verdict).not.toBe('verified');
    expect(verdict.findings.map((f) => f.code)).toContain(code);
  }
});

test.each(['omitted', 'skipped'])(
  '%s required semantic oracle prevents a complete official run',
  (mode) => {
    const result = run(
      'green',
      mode === 'skipped'
        ? {
            PMS_ONLY_STEPS: ORDER.filter(
              (name) => name !== 'semantic-oracle',
            ).join(','),
          }
        : {},
      mode === 'omitted' ? 'semantic-oracle' : false,
    );
    expect(result.status).toBe(mode === 'omitted' ? 1 : 0);
    expect(result.summary.complete).toBe(false);
    expect(result.summary.verification.verdict).toBe('incomplete');
    expect(result.summary.skippedSteps).toEqual(['semantic-oracle']);
    expect(
      result.summary.steps['semantic-oracle'].verification.findings[0].code,
    ).toBe('STEP_SKIPPED');
    expect(result.stdout).not.toContain('VERIFICATION OK');
  },
);

test('an empty tooling inventory fails before invoking Jest', () => {
  const testDir = path.join(fixture, 'tools/pms/__tests__');
  fs.renameSync(testDir, testDir + '.saved');
  try {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.summary.complete).toBe(false);
    expect(
      fs.readFileSync(
        path.join(fixture, 'evidence/run/tooling-tests.log'),
        'utf8',
      ),
    ).toContain('TOOLING_INVENTORY_EMPTY');
  } finally {
    fs.renameSync(testDir + '.saved', testDir);
  }
});

test.each(['test failure', 'suite load failure'])(
  'the tooling command propagates a real Jest %s',
  (mode) => {
    const jestDir = path.join(fixture, 'node_modules/jest');
    const testDir = path.join(fixture, 'tools/pms/__tests__');
    fs.renameSync(jestDir, jestDir + '.saved');
    fs.renameSync(testDir, testDir + '.saved');
    fs.symlinkSync(path.join(ROOT, 'node_modules/jest'), jestDir);
    write('jest.config.js', 'module.exports = { transform: {} };\n');
    write(
      'tools/pms/__tests__/a-test.js',
      'test("passes", () => expect(true).toBe(true));\n',
    );
    write(
      'tools/pms/__tests__/c-test.js',
      'test("also passes", () => expect(true).toBe(true));\n',
    );
    write(
      'tools/pms/__tests__/b-test.js',
      mode === 'test failure'
        ? 'test("fails", () => expect(true).toBe(false));\n'
        : 'throw new Error("intentional suite load failure");\n',
    );
    const out = path.join(fixture, 'real-jest-evidence');
    fs.mkdirSync(out, { recursive: true });
    try {
      const result = spawnSync(
        process.execPath,
        ['tools/pms/run-tooling-tests.js', out],
        {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 30000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(
        fs.readFileSync(path.join(out, 'tooling-jest-results.json'), 'utf8'),
      );
      expect(report.numFailedTestSuites).toBe(1);
      expect(report.numFailedTests).toBe(mode === 'test failure' ? 1 : 0);
      expect(result.stderr).toContain('Test Suites:');
      expect(result.stderr).toContain('Tests:');
    } finally {
      fs.rmSync(jestDir);
      fs.renameSync(jestDir + '.saved', jestDir);
      fs.rmSync(testDir, { recursive: true });
      fs.renameSync(testDir + '.saved', testDir);
      fs.rmSync(path.join(fixture, 'jest.config.js'));
    }
  },
);

test('a tracked tooling suite missing from disk cannot shrink the expected population', () => {
  const suite = path.join(fixture, 'tools/pms/__tests__/c-test.js');
  fs.renameSync(suite, suite + '.saved');
  try {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.summary.complete).toBe(false);
    expect(
      fs.readFileSync(
        path.join(fixture, 'evidence/run/tooling-tests.log'),
        'utf8',
      ),
    ).toContain('TOOLING_TRACKED_SUITE_MISSING');
  } finally {
    fs.renameSync(suite + '.saved', suite);
  }
});

test('broken verifier code preserves raw evidence and cannot invent a passing summary', () => {
  const parser = path.join(fixture, 'tools/pms/test-counts.js');
  const source = fs.readFileSync(parser);
  const out = path.join(fixture, 'evidence/run');
  try {
    expect(run().summary.complete).toBe(true);
    write(
      'tools/pms/test-counts.js',
      'throw new Error("intentional parser bootstrap failure");\n',
    );
    const result = run('green', {}, false, true);
    expect(result.status).toBe(1);
    expect(result.summary).toBeNull();
    expect(result.stderr).toContain('intentional parser bootstrap failure');
    expect(fs.existsSync(path.join(out, 'summary.json'))).toBe(false);
    expect(fs.readFileSync(path.join(out, 'steps.tsv'), 'utf8')).toContain(
      'tooling-tests',
    );
    expect(
      fs.readFileSync(path.join(out, 'tooling-tests.log'), 'utf8'),
    ).toContain('Tests:');
    expect(fs.readFileSync(path.join(out, 'run.log'), 'utf8')).not.toContain(
      'VERIFICATION OK',
    );
  } finally {
    fs.writeFileSync(parser, source);
  }
});
