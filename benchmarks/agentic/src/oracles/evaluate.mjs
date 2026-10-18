/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Independent task oracles.
//
// `evaluateTask` observes a finished workspace and never trusts the evaluated
// agent: scope is a byte diff against the materialized baseline, compilation
// and rendering run in a scratch copy through the public compiler SDK, and the
// agent's report only counts for what the agent claims to have diagnosed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  copyTree,
  diffSnapshots,
  fileDigest,
  listFiles,
  snapshotTree,
} from '../fs-tree.mjs';
import { compileGlobs, matchesAny } from '../glob.mjs';
import { computeStyle, parseCss } from '../css-cascade.mjs';
import { classList, parseHtml, select, textContent } from '../html.mjs';
import { checkReport, extractReport } from './report.mjs';
import {
  countByRule,
  findConstructs,
  inspectHostConfig,
} from './static-source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALWAYS_IGNORED = ['node_modules/**', '**/node_modules/**', '.git/**'];
const SCRATCH_EXCLUDE = [...ALWAYS_IGNORED, 'dist/**', 'build/**', '.next/**'];
const SOURCE_GLOB = '**/*.{js,jsx,ts,tsx,mjs,cjs}';
const GENERATED_COMPARED = [
  'design.pandamstyle.js',
  'design.pandamstyle.d.ts',
  'manifest.json',
  'styles.css',
];

export const CHECK_CLASSES = [
  'scope',
  'integrity',
  'compile',
  'static',
  'rendered',
  'behavioral',
  'report',
  'transcript',
  'environment',
  'visual',
];

const result = (status, reason, evidence) => ({
  status,
  reason: reason ?? null,
  evidence: evidence ?? null,
});

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function prepareScratch(src, dest, extraExclude = []) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  copyTree(src, dest, {
    exclude: [...SCRATCH_EXCLUDE, ...extraExclude],
    includeEmptyDirs: true,
  });
  const nm = path.join(src, 'node_modules');
  if (fs.existsSync(nm))
    fs.symlinkSync(nm, path.join(dest, 'node_modules'), 'dir');
}

function runWorker(request, scratchRoot, timeoutMs) {
  const requestPath = path.join(
    scratchRoot,
    `request-${process.pid}-${Date.now()}.json`,
  );
  const responsePath = `${requestPath}.out`;
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const child = spawnSync(
    process.execPath,
    [path.join(HERE, 'project-worker.mjs'), requestPath, responsePath],
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  if (child.status !== 0 || !fs.existsSync(responsePath)) {
    return {
      error: `project worker failed (${child.status ?? child.signal}): ${(child.stderr ?? '').slice(-2000)}`,
    };
  }
  return JSON.parse(fs.readFileSync(responsePath, 'utf8'));
}

function renderKey(render) {
  return JSON.stringify([
    render.module,
    render.export ?? 'default',
    render.props ?? {},
    render.theme ?? null,
  ]);
}

function collectTokenExpectations(checks) {
  const tokens = new Set();
  for (const check of checks) {
    for (const exp of Object.values(check.expect?.styles ?? {})) {
      if (exp.token) tokens.add(exp.token);
      if (exp.notToken) tokens.add(exp.notToken);
      for (const t of exp.oneOfTokens ?? []) tokens.add(t);
    }
  }
  return [...tokens].sort();
}

function elementChain(target) {
  const chain = [];
  for (
    let node = target;
    node != null && node.tag !== '#root';
    node = node.parent
  ) {
    chain.unshift({
      tag: node.tag,
      classes: classList(node),
      attributes: node.attributes,
    });
  }
  chain.unshift({ tag: 'html', classes: [], attributes: {}, isRoot: true });
  return chain;
}

// Compiler CSS is minified (`.5`, `repeat(2,minmax(0,1fr))`); expectations
// are written in ordinary CSS. Both sides are compared in one normal form.
export function normalizeCssValue(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()])\s*/g, '$1')
    .replace(/(^|[^\d.])0+\.(\d)/g, '$1.$2');
}

function evaluateStyleExpectation(property, exp, computed, tokenVars) {
  if (Object.hasOwn(computed.unmeasuredProperties, property)) {
    return {
      status: 'unmeasured',
      detail: `${property}: ${computed.unmeasuredProperties[property]}`,
    };
  }
  const got = computed.properties[property];
  const tokenVar = (t) => tokenVars[t];
  if (exp.absent === true) {
    return got == null
      ? { status: 'pass' }
      : { status: 'fail', detail: `${property} is set to ${got.declared}` };
  }
  if (got == null) return { status: 'fail', detail: `${property} is not set` };
  const usesToken = (t) => {
    const v = tokenVar(t);
    return v != null && got.declared === `var(${v})`;
  };
  for (const t of [exp.token, exp.notToken, ...(exp.oneOfTokens ?? [])].filter(
    Boolean,
  )) {
    if (tokenVar(t) == null)
      return {
        status: 'fail',
        detail: `token ${t} is not a public token of the final design system`,
      };
  }
  if (exp.token != null && !usesToken(exp.token)) {
    return {
      status: 'fail',
      detail: `${property} is ${got.declared}, expected token ${exp.token}`,
    };
  }
  if (exp.oneOfTokens != null && !exp.oneOfTokens.some(usesToken)) {
    return {
      status: 'fail',
      detail: `${property} is ${got.declared}, expected one of ${exp.oneOfTokens.join(', ')}`,
    };
  }
  if (exp.notToken != null && usesToken(exp.notToken)) {
    return {
      status: 'fail',
      detail: `${property} must not use ${exp.notToken}`,
    };
  }
  if (exp.value != null) {
    if (got.unresolvedVariables.length > 0) {
      return {
        status: 'fail',
        detail: `${property} has unresolved variables ${got.unresolvedVariables.join(',')}`,
      };
    }
    if (normalizeCssValue(got.resolved) !== normalizeCssValue(exp.value)) {
      return {
        status: 'fail',
        detail: `${property} resolves to ${got.resolved}, expected ${exp.value}`,
      };
    }
  }
  return { status: 'pass' };
}

function evaluateRender(check, observed) {
  const rendered = observed.renders?.[check.renderId];
  if (rendered == null) return result('error', 'render was not requested');
  if (rendered.error != null)
    return result('fail', `render failed: ${rendered.error}`);
  let tree;
  try {
    tree = parseHtml(rendered.html);
  } catch (error) {
    return result('error', `rendered markup not parseable: ${error.message}`);
  }
  const matches = select(tree, check.select);
  const expect = check.expect ?? {};
  const failures = [];
  const unmeasured = [];
  const expectedCount = expect.count ?? 1;
  if (matches.length !== expectedCount) {
    return result(
      'fail',
      `selector ${JSON.stringify(check.select)} matched ${matches.length}, expected ${expectedCount}`,
    );
  }
  if (expectedCount === 0) return result('pass', null, { matched: 0 });
  const target = matches[check.index ?? 0];
  const text = textContent(target).trim();
  if (expect.text != null && text !== expect.text)
    failures.push(`text is ${JSON.stringify(text)}`);
  if (
    expect.textMatches != null &&
    !new RegExp(expect.textMatches, 'i').test(text)
  ) {
    failures.push(
      `text ${JSON.stringify(text)} does not match /${expect.textMatches}/i`,
    );
  }
  for (const [name, value] of Object.entries(expect.attributes ?? {})) {
    const has = Object.hasOwn(target.attributes, name);
    if (
      value === null
        ? has
        : !has || (value !== true && target.attributes[name] !== value)
    ) {
      failures.push(
        `attribute ${name}=${JSON.stringify(target.attributes[name] ?? null)}, expected ${JSON.stringify(value)}`,
      );
    }
  }
  let computed = null;
  if (expect.styles != null) {
    computed = computeStyle(
      observed.cssRules,
      elementChain(target),
      check.context ?? {},
    );
    for (const [property, exp] of Object.entries(expect.styles)) {
      const r = evaluateStyleExpectation(
        property,
        exp,
        computed,
        observed.tokenVars ?? {},
      );
      if (r.status === 'fail') failures.push(r.detail);
      if (r.status === 'unmeasured') unmeasured.push(r.detail);
    }
  }
  const evidence = {
    classes: classList(target),
    styles:
      computed == null
        ? undefined
        : Object.fromEntries(
            Object.keys(expect.styles ?? {}).map((p) => [
              p,
              computed.properties[p]?.declared ?? null,
            ]),
          ),
  };
  if (failures.length > 0) return result('fail', failures.join('; '), evidence);
  if (unmeasured.length > 0)
    return result('unmeasured', unmeasured.join('; '), evidence);
  return result('pass', null, evidence);
}

function evaluateDefinitionDiff(check, before, after) {
  if (before?.error || after?.error)
    return result(
      'fail',
      `definition not loadable: ${before?.error ?? after?.error}`,
    );
  const added = Object.keys(after)
    .filter((k) => !Object.hasOwn(before, k))
    .sort();
  const removed = Object.keys(before)
    .filter((k) => !Object.hasOwn(after, k))
    .sort();
  const changed = Object.keys(after)
    .filter((k) => Object.hasOwn(before, k) && before[k] !== after[k])
    .sort();
  const failures = [];
  const compare = (label, actual, patterns = [], allowExtra = false) => {
    const globs = compileGlobs(patterns.map((p) => p.replaceAll('/', '∕')));
    for (const key of actual) {
      if (!allowExtra && globs.match(key.replaceAll('/', '∕')) == null)
        failures.push(`unexpected ${label} ${key}`);
    }
    for (const p of patterns) {
      if (
        !actual.some((key) =>
          matchesAny([p.replaceAll('/', '∕')], key.replaceAll('/', '∕')),
        )
      ) {
        failures.push(`expected ${label} ${p} not found`);
      }
    }
  };
  compare('added', added, check.added ?? [], check.allowExtraAdded === true);
  compare('removed', removed, check.removed ?? []);
  compare('changed', changed, check.changed ?? []);
  const evidence = { added, removed, changed };
  return failures.length > 0
    ? result('fail', failures.join('; '), evidence)
    : result('pass', null, evidence);
}

function sourceFiles(root, exclude) {
  return listFiles(root, { exclude: [...ALWAYS_IGNORED, ...exclude] }).filter(
    (f) => matchesAny([SOURCE_GLOB], f),
  );
}

function evaluateForbidden(check, ctx) {
  const rules = new Set(check.rules);
  const globs = check.files ?? [SOURCE_GLOB];
  const exclude = [
    ctx.project?.outDir ? `${ctx.project.outDir}/**` : '.pandamstyle/**',
    'dist/**',
    '.next/**',
  ];
  const files = sourceFiles(ctx.workspaceDir, exclude).filter((f) =>
    matchesAny(globs, f),
  );
  const introduced = [];
  for (const rel of files) {
    const isDefinition = ctx.project?.definition === rel;
    const after = findConstructs(
      readText(path.join(ctx.workspaceDir, rel)),
      rel,
      { isDefinition },
    ).filter((f) => rules.has(f.rule) || f.rule === 'parse-error');
    if (after.length === 0) continue;
    const baseText = readText(path.join(ctx.baselineDir, rel));
    const baseCounts =
      baseText == null
        ? {}
        : countByRule(findConstructs(baseText, rel, { isDefinition }));
    const afterCounts = countByRule(after);
    for (const [rule, count] of Object.entries(afterCounts)) {
      if (count > (baseCounts[rule] ?? 0)) {
        introduced.push({
          file: rel,
          rule,
          count: count - (baseCounts[rule] ?? 0),
          lines: after.filter((f) => f.rule === rule).map((f) => f.line),
        });
      }
    }
  }
  return introduced.length > 0
    ? result(
        'fail',
        introduced.map((i) => `${i.file}: ${i.rule} x${i.count}`).join('; '),
        introduced,
      )
    : result('pass', null, { filesInspected: files.length });
}

function evaluateHostConfig(check, ctx) {
  const after = readText(path.join(ctx.workspaceDir, check.file));
  if (after == null) return result('fail', `${check.file} not found`);
  const inspected = inspectHostConfig(after, check.file);
  if (!inspected.found)
    return result(
      'fail',
      `no @pandamstyle host integration call in ${check.file}`,
    );
  const call = inspected.calls.find((c) => c.module === check.module) ?? null;
  if (call == null)
    return result(
      'fail',
      `integration is not imported from ${check.module}`,
      inspected.calls,
    );
  const failures = [];
  const options = call.options ?? {};
  for (const [key, expected] of Object.entries(check.expect ?? {})) {
    const actual = options[key];
    const norm = (v) =>
      typeof v === 'string' ? v.replace(/^\.\//, '').replace(/\/$/, '') : v;
    const ok = Array.isArray(expected)
      ? Array.isArray(actual) &&
        actual.length === expected.length &&
        expected.every((e) => actual.map(norm).includes(norm(e)))
      : norm(actual) === norm(expected);
    if (!ok)
      failures.push(
        `${key} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
  }
  for (const key of check.forbidOptions ?? []) {
    if (Object.hasOwn(options, key))
      failures.push(`option ${key} must not be set`);
  }
  if (check.preservePlugins === true) {
    const before = readText(path.join(ctx.baselineDir, check.file));
    const basePlugins =
      before == null ? [] : inspectHostConfig(before, check.file).plugins;
    for (const p of basePlugins) {
      if (!inspected.plugins.includes(p))
        failures.push(`existing plugin ${p} was removed`);
    }
  }
  return failures.length > 0
    ? result('fail', failures.join('; '), {
        options,
        plugins: inspected.plugins,
      })
    : result('pass', null, { options, plugins: inspected.plugins });
}

function evaluatePackageJson(check, ctx) {
  const after = JSON.parse(
    readText(path.join(ctx.workspaceDir, check.file ?? 'package.json')) ??
      'null',
  );
  const before = JSON.parse(
    readText(path.join(ctx.baselineDir, check.file ?? 'package.json')) ??
      'null',
  );
  if (after == null) return result('fail', 'package.json missing');
  const failures = [];
  const sections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  const specOf = (pkg, name) => {
    for (const s of sections)
      if (pkg?.[s]?.[name] != null) return { section: s, spec: pkg[s][name] };
    return null;
  };
  const specs = [];
  for (const req of check.require ?? []) {
    const found = specOf(after, req.name);
    if (found == null) {
      failures.push(`${req.name} is not declared`);
      continue;
    }
    if (req.section != null && found.section !== req.section)
      failures.push(
        `${req.name} is in ${found.section}, expected ${req.section}`,
      );
    if (req.spec != null && !new RegExp(req.spec).test(found.spec))
      failures.push(`${req.name}@${found.spec} does not match /${req.spec}/`);
    specs.push(found.spec);
  }
  if (check.sameSpec === true && new Set(specs).size > 1)
    failures.push(
      `PandamStyle packages use different specs: ${[...new Set(specs)].join(', ')}`,
    );
  for (const name of check.forbid ?? []) {
    if (specOf(after, name) != null)
      failures.push(`${name} must not be declared`);
  }
  if (check.preserveExisting === true && before != null) {
    for (const s of sections) {
      for (const [name, spec] of Object.entries(before[s] ?? {})) {
        const now = specOf(after, name);
        if (now == null || now.spec !== spec)
          failures.push(`existing dependency ${name}@${spec} changed`);
      }
    }
    for (const [name, script] of Object.entries(before.scripts ?? {})) {
      if (
        after.scripts?.[name] !== script &&
        !(check.allowScriptChanges ?? []).includes(name)
      ) {
        failures.push(`existing script ${name} changed`);
      }
    }
  }
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass');
}

function evaluateGenerated(check, ctx, observed) {
  const outDir = ctx.project.outDir;
  if (!observed.compile?.ok) {
    // Without fresh output, only "untouched since the baseline" is provable.
    if (check.mode === 'must-match')
      return result(
        'blocked',
        'fresh compilation failed; generated output cannot be compared',
      );
    const touched = GENERATED_COMPARED.filter((name) => {
      const wsFile = path.join(ctx.workspaceDir, outDir, name);
      const base = path.join(ctx.baselineDir, outDir, name);
      if (!fs.existsSync(wsFile)) return false;
      return !fs.existsSync(base) || fileDigest(base) !== fileDigest(wsFile);
    });
    return touched.length === 0
      ? result('pass', null, {
          note: 'fresh compilation failed; generated output is untouched since the baseline',
        })
      : result(
          'blocked',
          `fresh compilation failed and generated files changed: ${touched.join(', ')}`,
        );
  }
  const mismatches = [];
  for (const name of GENERATED_COMPARED) {
    const wsFile = path.join(ctx.workspaceDir, outDir, name);
    if (!fs.existsSync(wsFile)) {
      if (check.mode === 'must-match') mismatches.push(`${name} missing`);
      continue;
    }
    const fresh = path.join(ctx.scratchWorkspace, outDir, name);
    const base = path.join(ctx.baselineDir, outDir, name);
    const wsDigest = fileDigest(wsFile);
    const matchesFresh = fs.existsSync(fresh) && fileDigest(fresh) === wsDigest;
    const untouched = fs.existsSync(base) && fileDigest(base) === wsDigest;
    if (!matchesFresh && !(check.mode !== 'must-match' && untouched))
      mismatches.push(name);
  }
  return mismatches.length > 0
    ? result(
        'fail',
        `generated output differs from compiler output: ${mismatches.join(', ')}`,
      )
    : result('pass');
}

function evaluateTranscript(check, transcript) {
  if (transcript == null)
    return result(
      'unmeasured',
      'no normalized transcript was supplied by the runner',
    );
  const commands = transcript
    .filter((e) => e.type === 'command')
    .map((e) => e.command ?? '');
  const failures = [];
  for (const pattern of check.forbid ?? []) {
    const re = new RegExp(pattern);
    const hit = commands.find((c) => re.test(c));
    if (hit != null)
      failures.push(`forbidden command /${pattern}/ ran: ${hit.slice(0, 120)}`);
  }
  for (const pattern of check.require ?? []) {
    if (!commands.some((c) => new RegExp(pattern).test(c)))
      failures.push(`required command /${pattern}/ never ran`);
  }
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass', null, { commands: commands.length });
}

function runHostBuild(check, ctx, options) {
  if (options.hostCommands !== true)
    return result('unmeasured', 'host commands disabled for this evaluation');
  const pm = ctx.environment.packageManager ?? 'npm';
  const child = spawnSync(pm, ['run', check.script ?? 'build'], {
    cwd: ctx.hostScratch,
    encoding: 'utf8',
    timeout: (check.timeoutSeconds ?? 300) * 1000,
    env: { ...process.env, CI: '1', NODE_ENV: 'production' },
  });
  return child.status === 0
    ? result('pass', null, { exit: 0 })
    : result(
        'fail',
        `${pm} run ${check.script ?? 'build'} exited ${child.status ?? child.signal}`,
        { tail: `${child.stdout}\n${child.stderr}`.slice(-1500) },
      );
}

function scopeContext(ctx) {
  const ignored = [
    ...ALWAYS_IGNORED,
    ...(ctx.permissions.harnessIgnored ?? []),
  ];
  const before = snapshotTree(ctx.baselineDir, { exclude: ignored });
  const after = snapshotTree(ctx.workspaceDir, { exclude: ignored });
  return diffSnapshots(before, after);
}

function evaluateScopeDiff(check, ctx) {
  const diff = ctx.diff;
  const writable = compileGlobs(ctx.permissions.writable ?? []);
  const protectedGlobs = compileGlobs(ctx.permissions.protected ?? []);
  const violations = [];
  for (const rel of [...diff.added, ...diff.modified]) {
    if (protectedGlobs.match(rel) != null)
      violations.push(`protected path written: ${rel}`);
    else if (writable.match(rel) == null)
      violations.push(`write outside permitted files: ${rel}`);
  }
  for (const rel of diff.deleted) {
    if (
      protectedGlobs.match(rel) != null ||
      !ctx.permissions.allowDelete ||
      writable.match(rel) == null
    ) {
      violations.push(`deleted: ${rel}`);
    }
  }
  const changes =
    diff.added.length + diff.modified.length + diff.deleted.length;
  if (check.expectChanges === 'none' && changes > 0)
    violations.push(`expected no workspace change, found ${changes}`);
  if (check.expectChanges === 'some' && changes === 0)
    violations.push('expected at least one workspace change, found none');
  return violations.length > 0
    ? result('fail', violations.join('; '), diff)
    : result('pass', null, diff);
}

function evaluateUnchanged(check, ctx) {
  const before = snapshotTree(ctx.baselineDir, { exclude: ALWAYS_IGNORED });
  const after = snapshotTree(ctx.workspaceDir, { exclude: ALWAYS_IGNORED });
  const diff = diffSnapshots(before, after);
  const touched = [...diff.added, ...diff.modified, ...diff.deleted].filter(
    (rel) => matchesAny(check.paths, rel),
  );
  return touched.length > 0
    ? result('fail', `changed: ${touched.join(', ')}`)
    : result('pass');
}

function evaluateFileContains(check, ctx) {
  const text = readText(path.join(ctx.workspaceDir, check.path));
  if (check.exists === false)
    return text == null
      ? result('pass')
      : result('fail', `${check.path} must not exist`);
  if (text == null) return result('fail', `${check.path} does not exist`);
  const failures = [];
  for (const p of check.patterns ?? [])
    if (!new RegExp(p, 'm').test(text)) failures.push(`missing /${p}/`);
  for (const p of check.absent ?? [])
    if (new RegExp(p, 'm').test(text)) failures.push(`must not contain /${p}/`);
  return failures.length > 0
    ? result('fail', failures.join('; '))
    : result('pass');
}

function aggregate(statuses) {
  if (statuses.length === 0) return 'not-applicable';
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.includes('unmeasured')) return 'unmeasured';
  return 'pass';
}

/**
 * @param {object} args
 * @param {object} args.task Parsed task definition.
 * @param {object} args.fixture Parsed fixture metadata.
 * @param {string} args.epoch Product/vocabulary epoch to evaluate against.
 * @param {string} args.baselineDir Materialized state the agent started from
 *   (including harness-applied concurrent events).
 * @param {string} args.workspaceDir Final workspace state.
 * @param {string|null} args.responseText Final agent message.
 * @param {Array|null} args.transcript Normalized events or null.
 * @param {object|null} args.observations Runner observations or null.
 */
export async function evaluateTask({
  task,
  fixture,
  epoch,
  baselineDir,
  workspaceDir,
  responseText = null,
  transcript = null,
  observations = null,
  scratchRoot = os.tmpdir(),
  options = {},
}) {
  const base = {
    schema: 'pms-eval-result/v1',
    taskId: task.id,
    split: task.split,
    workflow: task.workflow,
    caseType: task.caseType,
    epoch,
  };
  const expectation = task.expectations?.[epoch];
  if (expectation == null) {
    return {
      ...base,
      verdict: 'not-evaluable',
      reason: `task has no expectation for epoch ${epoch}`,
      checks: [],
      outcomes: {},
    };
  }
  const project = task.project ?? fixture.project ?? null;
  const scratch = fs.mkdtempSync(
    path.join(scratchRoot, `pms-oracle-${task.id}-`),
  );
  const ctx = {
    task,
    project,
    baselineDir,
    workspaceDir,
    permissions: task.permissions,
    environment: task.environment,
    scratchWorkspace: path.join(scratch, 'ws'),
    hostScratch: path.join(scratch, 'host'),
  };
  ctx.diff = scopeContext(ctx);
  const checks = expectation.checks;
  const needsCompile = checks.some((c) =>
    ['compile.project', 'render.styles', 'generated.consistent'].includes(
      c.kind,
    ),
  );
  const needsDefinition = checks.some((c) => c.kind === 'definition.diff');
  const renders = new Map();
  for (const c of checks.filter((c) => c.kind === 'render.styles')) {
    const key = renderKey(c.render);
    if (!renders.has(key))
      renders.set(key, { id: `r${renders.size}`, ...c.render });
    c.renderId = renders.get(key).id;
  }
  let observed = {};
  if ((needsCompile || needsDefinition) && project != null) {
    const outExclude = project.outDir
      ? [`${project.outDir.replace(/^\.\//, '')}/**`]
      : [];
    prepareScratch(workspaceDir, ctx.scratchWorkspace, outExclude);
    let baselineScratch = null;
    if (needsDefinition) {
      baselineScratch = path.join(scratch, 'baseline');
      prepareScratch(baselineDir, baselineScratch, outExclude);
      if (
        !fs.existsSync(path.join(baselineScratch, 'node_modules')) &&
        fs.existsSync(path.join(workspaceDir, 'node_modules'))
      ) {
        fs.symlinkSync(
          path.join(workspaceDir, 'node_modules'),
          path.join(baselineScratch, 'node_modules'),
          'dir',
        );
      }
    }
    const definitionFiles = needsDefinition
      ? {
          before: path.join(baselineScratch, project.definition),
          after: path.join(ctx.scratchWorkspace, project.definition),
        }
      : {};
    observed = runWorker(
      {
        workspaceDir: ctx.scratchWorkspace,
        compile: needsCompile,
        project,
        tokenProbes: collectTokenExpectations(checks),
        renders: [...renders.values()],
        definitionFiles,
      },
      scratch,
      (options.workerTimeoutSeconds ?? 180) * 1000,
    );
    if (observed.css != null) observed.cssRules = parseCss(observed.css);
  }
  if (
    checks.some((c) => c.kind === 'host.build') &&
    options.hostCommands === true
  ) {
    prepareScratch(workspaceDir, ctx.hostScratch);
  }
  const reportExtraction = extractReport(responseText);

  const evaluated = [];
  for (const check of checks) {
    let r;
    try {
      if (
        observed.error != null &&
        [
          'compile.project',
          'render.styles',
          'generated.consistent',
          'definition.diff',
        ].includes(check.kind)
      ) {
        r = result('error', observed.error);
      } else {
        switch (check.kind) {
          case 'scope.diff':
            r = evaluateScopeDiff(check, ctx);
            break;
          case 'scope.unchanged':
            r = evaluateUnchanged(check, ctx);
            break;
          case 'files.contains':
            r = evaluateFileContains(check, ctx);
            break;
          case 'compile.project': {
            const c = observed.compile;
            if (c == null) r = result('error', 'compilation was not observed');
            else {
              const codes = c.diagnostics.map((d) => d.code);
              if (check.expect === 'ok') {
                r = c.ok
                  ? result('pass', null, { coveredModules: c.coveredModules })
                  : result(
                      'fail',
                      `diagnostics: ${codes.join(', ')}`,
                      c.diagnostics,
                    );
              } else {
                const missing = (check.diagnosticCodes ?? []).filter(
                  (code) => !codes.includes(code),
                );
                r =
                  !c.ok && missing.length === 0
                    ? result('pass', null, codes)
                    : result(
                        'fail',
                        c.ok
                          ? 'compilation unexpectedly succeeded'
                          : `missing diagnostics ${missing.join(', ')}`,
                        codes,
                      );
              }
            }
            break;
          }
          case 'render.styles':
            r = observed.compile?.ok
              ? evaluateRender(check, observed)
              : result('blocked', 'compilation failed; nothing was rendered');
            break;
          case 'generated.consistent':
            r = evaluateGenerated(check, ctx, observed);
            break;
          case 'definition.diff':
            r = evaluateDefinitionDiff(
              check,
              observed.vocabulary?.before,
              observed.vocabulary?.after,
            );
            break;
          case 'static.forbidden':
            r = evaluateForbidden(check, ctx);
            break;
          case 'static.host-config':
            r = evaluateHostConfig(check, ctx);
            break;
          case 'static.package-json':
            r = evaluatePackageJson(check, ctx);
            break;
          case 'host.build':
            r = runHostBuild(check, ctx, options);
            break;
          case 'report.final':
            if (reportExtraction.report == null)
              r = result('fail', reportExtraction.error);
            else {
              const failures = checkReport(check, reportExtraction.report);
              r =
                failures.length > 0
                  ? result('fail', failures.join('; '))
                  : result('pass');
            }
            break;
          case 'transcript.commands':
            r = evaluateTranscript(check, transcript);
            break;
          case 'observation.runner': {
            const value = observations?.[check.observation];
            r =
              value === undefined
                ? result(
                    'unmeasured',
                    `runner did not supply observation ${check.observation}`,
                  )
                : JSON.stringify(value) === JSON.stringify(check.expect)
                  ? result('pass', null, value)
                  : result(
                      check.invalidatesRun ? 'error' : 'fail',
                      `observation ${check.observation} is ${JSON.stringify(value)}${check.invalidatesRun ? ' (harness precondition not met: run is invalid)' : ''}`,
                      value,
                    );
            break;
          }
          case 'visual.fidelity': {
            const value = observations?.[`visual:${check.id}`];
            r =
              value == null
                ? result(
                    'unmeasured',
                    'no visual fidelity measurement exists for this epoch; never counted as passed',
                  )
                : result(value === 'pass' ? 'pass' : 'fail', null, value);
            break;
          }
          default:
            r = result('error', `unknown check kind ${check.kind}`);
        }
      }
    } catch (error) {
      r = result('error', String(error?.stack ?? error).slice(0, 1500));
    }
    evaluated.push({
      id: check.id,
      kind: check.kind,
      class: check.class,
      required: check.required,
      ...r,
    });
  }

  const outcomes = {};
  for (const cls of CHECK_CLASSES) {
    outcomes[cls] = aggregate(
      evaluated.filter((c) => c.class === cls).map((c) => c.status),
    );
  }
  const required = evaluated.filter((c) => c.required);
  let verdict = aggregate(required.map((c) => c.status));
  if (verdict === 'blocked') verdict = 'fail';
  if (verdict === 'not-applicable') verdict = 'error';
  if (!options.keepScratch)
    fs.rmSync(scratch, { recursive: true, force: true });
  return {
    ...base,
    classification: expectation.classification,
    intendedOutcome: expectation.intendedOutcome.kind,
    verdict,
    // Application success and correct diagnosis of a gap are scored apart.
    success: {
      application:
        expectation.intendedOutcome.kind === 'application-success' ||
        expectation.intendedOutcome.kind === 'integration-success'
          ? verdict === 'pass'
          : null,
      diagnosis: [
        'capability-gap-diagnosis',
        'vocabulary-gap-diagnosis',
        'conflict-diagnosis',
        'clarification',
        'refusal',
      ].includes(expectation.intendedOutcome.kind)
        ? verdict === 'pass'
        : null,
      report:
        expectation.intendedOutcome.kind === 'read-only-report'
          ? verdict === 'pass'
          : null,
    },
    outcomes,
    scope: ctx.diff,
    compile:
      observed.compile == null
        ? null
        : {
            ok: observed.compile.ok,
            diagnosticCodes: observed.compile.diagnostics.map((d) => d.code),
            compilerVersion: observed.compilerVersion ?? null,
          },
    report:
      reportExtraction.report == null
        ? { present: false, error: reportExtraction.error }
        : {
            present: true,
            outcome: reportExtraction.report.outcome,
            gaps: reportExtraction.report.gaps,
          },
    checks: evaluated,
  };
}
