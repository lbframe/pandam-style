/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Corpus loading and validation: JSON Schema conformance plus the semantic
// rules a schema cannot express (coverage, outcome/classification
// consistency, epoch binding, independent scope checks, lock freshness).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, sha256, treeDigest } from './fs-tree.mjs';
import { validate, validateSchemaKeywords } from './json-schema.mjs';

export const CORPUS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const SCHEMA_NAMES = [
  'task',
  'report',
  'fixture',
  'corpus',
  'heldout-manifest',
  'evaluation-result',
];
const DIAGNOSIS_KINDS = new Set([
  'capability-gap-diagnosis',
  'vocabulary-gap-diagnosis',
  'conflict-diagnosis',
  'clarification',
  'refusal',
]);

export function loadSchemas(root = CORPUS_ROOT) {
  const out = {};
  for (const name of SCHEMA_NAMES)
    out[name] = readJson(path.join(root, 'schema', `${name}.schema.json`));
  return out;
}

export function heldoutPaths(root = CORPUS_ROOT) {
  const dir = path.join(root, 'heldout');
  return {
    dir,
    manifest: path.join(dir, 'MANIFEST.json'),
    archive: path.join(dir, 'heldout.tar.gpg'),
    plaintext: path.join(dir, '.plaintext'),
    plaintextTasks: path.join(dir, '.plaintext', 'tasks'),
    unsealed: path.join(dir, '.unsealed'),
  };
}

function loadTaskDirs(tasksDir) {
  if (!fs.existsSync(tasksDir)) return [];
  return fs
    .readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => {
      const dir = path.join(tasksDir, name);
      let task = null;
      let parseError = null;
      try {
        task = readJson(path.join(dir, 'task.json'));
      } catch (error) {
        parseError = error.message;
      }
      return { name, dir, task, parseError };
    });
}

export function loadCorpus(
  root = CORPUS_ROOT,
  { heldoutTasksDir = null } = {},
) {
  const corpus = readJson(path.join(root, 'corpus.json'));
  const fixtures = new Map();
  const fixturesDir = path.join(root, 'fixtures');
  for (const name of fs.readdirSync(fixturesDir).sort()) {
    const dir = path.join(fixturesDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    fixtures.set(name, {
      name,
      dir,
      projectDir: path.join(dir, 'project'),
      meta: readJson(path.join(dir, 'fixture.json')),
    });
  }
  const development = loadTaskDirs(path.join(root, 'tasks'));
  const hp = heldoutPaths(root);
  const heldoutDir =
    heldoutTasksDir ??
    (fs.existsSync(hp.plaintextTasks) ? hp.plaintextTasks : null);
  const heldout = heldoutDir == null ? [] : loadTaskDirs(heldoutDir);
  const manifest = fs.existsSync(hp.manifest) ? readJson(hp.manifest) : null;
  return { root, corpus, fixtures, development, heldout, heldoutDir, manifest };
}

export function findTask(loaded, id) {
  return (
    [...loaded.development, ...loaded.heldout].find((t) => t.name === id) ??
    null
  );
}

export function digestTaskDir(dir) {
  return treeDigest(dir);
}

export function setDigest(entries) {
  return sha256(
    entries
      .map(([id, digest]) => `${id}\0${digest}\n`)
      .sort()
      .join(''),
  );
}

function checkTask(entry, { corpus, fixtures, schemas, split, errors }) {
  const where = `${split}/${entry.name}`;
  const err = (msg) => errors.push(`${where}: ${msg}`);
  if (entry.parseError != null)
    return err(`task.json unreadable: ${entry.parseError}`);
  const task = entry.task;
  for (const e of validate(schemas.task, task)) err(`schema ${e}`);
  if (task.id !== entry.name)
    err(`id ${task.id} does not match directory ${entry.name}`);
  if (task.split !== split) err(`split is ${task.split}, expected ${split}`);
  const promptFile = path.join(entry.dir, task.prompt ?? '');
  if (
    !fs.existsSync(promptFile) ||
    fs.readFileSync(promptFile, 'utf8').trim().length < 40
  ) {
    err(`prompt ${task.prompt} missing or too short`);
  }
  const fixture = fixtures.get(task.workspace?.fixture);
  if (fixture == null) return err(`unknown fixture ${task.workspace?.fixture}`);
  for (const o of [
    ...(task.workspace.overlays ?? []),
    task.workspace.uncommittedOverlay,
  ].filter(Boolean)) {
    if (!fs.existsSync(path.join(entry.dir, o)))
      err(`overlay ${o} does not exist`);
  }
  const steps = [
    ...(task.workspace.prepare ?? []),
    ...(task.workspace.events ?? []).flatMap((e) => e.steps ?? []),
  ];
  for (const s of steps) {
    if (s.step === 'write' && !fs.existsSync(path.join(entry.dir, s.source)))
      err(`step source ${s.source} does not exist`);
  }
  if (
    (task.workspace.prepare ?? []).some((s) => s.step === 'compile') &&
    fixture.meta.project == null &&
    task.project == null
  ) {
    err('prepare compile needs a project');
  }
  if (task.environment?.host !== fixture.meta.host)
    err(
      `environment.host ${task.environment?.host} differs from fixture host ${fixture.meta.host}`,
    );
  const project = task.project ?? fixture.meta.project;
  const caps = task.capabilities ?? { required: [], granted: [], withheld: [] };
  for (const c of caps.required)
    if (!caps.granted.includes(c))
      err(`required capability ${c} is not granted`);
  for (const c of caps.withheld)
    if (caps.granted.includes(c))
      err(`capability ${c} is both granted and withheld`);
  if (!caps.granted.includes('workspace.read'))
    err('workspace.read must be granted');
  if (
    task.environment?.network === 'none' &&
    caps.granted.includes('package.install')
  ) {
    err('package.install granted without network access');
  }
  const expectations = task.expectations ?? {};
  if (!Object.hasOwn(expectations, corpus.referenceEpoch))
    err(`no expectation for reference epoch ${corpus.referenceEpoch}`);
  for (const [epoch, exp] of Object.entries(expectations)) {
    const e = (msg) => err(`[${epoch}] ${msg}`);
    if (!Object.hasOwn(corpus.epochs, epoch)) e(`unknown epoch ${epoch}`);
    const checks = exp.checks ?? [];
    const ids = checks.map((c) => c.id);
    if (new Set(ids).size !== ids.length) e('duplicate check ids');
    const req = checks.filter((c) => c.required);
    const has = (pred) => req.some(pred);
    if (!has((c) => c.kind === 'scope.diff'))
      e(
        'a required scope.diff check is mandatory (restrictions must be checkable independently)',
      );
    for (const c of checks) {
      if (c.kind === 'visual.fidelity' && c.required)
        e(
          `${c.id}: visual.fidelity is unmeasured in this corpus and cannot be required`,
        );
      if (c.kind === 'render.styles' && project != null) {
        const inRoot = project.roots.some((r) =>
          c.render.module.startsWith(
            `${r.replace(/^\.\//, '').replace(/\/$/, '')}/`,
          ),
        );
        if (!inRoot)
          e(
            `${c.id}: render module ${c.render.module} is outside project roots`,
          );
      }
      if (
        [
          'compile.project',
          'render.styles',
          'generated.consistent',
          'definition.diff',
        ].includes(c.kind) &&
        project == null
      ) {
        e(
          `${c.id}: ${c.kind} needs a project (fixture.project or task.project)`,
        );
      }
      if (c.kind === 'render.styles' && c.class === 'behavioral') {
        const ctx = c.context ?? {};
        const stateful =
          (ctx.states ?? []).length > 0 ||
          ctx.viewportWidth != null ||
          ctx.reducedMotion != null ||
          c.render.props != null;
        if (!stateful)
          e(`${c.id}: a behavioral check must vary state, props or viewport`);
      }
    }
    const kind = exp.intendedOutcome?.kind;
    const cls = exp.classification;
    const granted = new Set(caps.granted);
    const reportReq = req.filter((c) => c.kind === 'report.final');
    const requiresGap = (gapKind) =>
      reportReq.some((c) =>
        (c.gaps?.require ?? []).some((g) => g.kind === gapKind),
      );
    if (kind === 'application-success') {
      if (
        !(
          cls === 'expressible' ||
          (cls === 'missing-project-vocabulary' &&
            granted.has('design-system.edit'))
        )
      ) {
        e(
          `application-success requires an expressible task (or a vocabulary gap with design-system.edit granted), got ${cls}`,
        );
      }
      if (!has((c) => c.class === 'rendered' || c.class === 'behavioral')) {
        e(
          'application-success needs a required rendered or behavioral check: compilation alone cannot satisfy an application task',
        );
      }
      if (!has((c) => c.kind === 'compile.project' && c.expect === 'ok'))
        e('application-success needs a required compile.project ok check');
      if (!has((c) => c.kind === 'static.forbidden'))
        e('application-success needs a required static.forbidden check');
    }
    if (kind === 'integration-success') {
      if (cls !== 'expressible')
        e('integration-success requires an expressible task');
      for (const k of ['static.host-config', 'static.package-json'])
        if (!has((c) => c.kind === k))
          e(`integration-success needs a required ${k}`);
      if (!has((c) => c.kind === 'host.build'))
        e('integration-success needs a required host.build');
    }
    if (kind === 'capability-gap-diagnosis') {
      if (cls !== 'missing-product-capability')
        e(
          'capability-gap-diagnosis requires classification missing-product-capability',
        );
      if (
        !requiresGap('missing-product-capability') &&
        !requiresGap('unsupported-environment')
      ) {
        e(
          'capability-gap-diagnosis needs a required report gap of kind missing-product-capability or unsupported-environment',
        );
      }
    }
    if (
      cls === 'missing-product-capability' &&
      kind !== 'capability-gap-diagnosis'
    )
      e(
        'missing-product-capability tasks must expect capability-gap-diagnosis',
      );
    if (kind === 'vocabulary-gap-diagnosis') {
      if (cls !== 'missing-project-vocabulary')
        e(
          'vocabulary-gap-diagnosis requires classification missing-project-vocabulary',
        );
      if (!requiresGap('missing-project-vocabulary'))
        e(
          'vocabulary-gap-diagnosis needs a required missing-project-vocabulary gap',
        );
      if (granted.has('design-system.edit'))
        e('vocabulary-gap-diagnosis must not grant design-system.edit');
      if (
        project != null &&
        !(task.permissions?.protected ?? []).includes(project.definition)
      ) {
        e('vocabulary-gap-diagnosis must protect the design-system definition');
      }
    }
    if (
      cls === 'missing-project-vocabulary' &&
      ![
        'vocabulary-gap-diagnosis',
        'application-success',
        'clarification',
      ].includes(kind)
    ) {
      e(`missing-project-vocabulary cannot expect ${kind}`);
    }
    if (kind === 'clarification') {
      if (!(task.tags ?? []).includes('ambiguous-request'))
        e('clarification tasks must be tagged ambiguous-request');
      if (!requiresGap('ambiguous-request'))
        e('clarification needs a required ambiguous-request gap');
    }
    if (kind === 'conflict-diagnosis' && !requiresGap('conflicting-state'))
      e('conflict-diagnosis needs a required conflicting-state gap');
    if (kind === 'refusal') {
      if (!(task.tags ?? []).some((t) => t.startsWith('adversarial:')))
        e('refusal tasks must carry an adversarial:* tag');
      if (reportReq.length === 0)
        e('refusal needs a required report.final check');
    }
    if (kind === 'read-only-report') {
      if (!has((c) => c.kind === 'scope.diff' && c.expectChanges === 'none'))
        e('read-only-report needs scope.diff expectChanges none');
      if (reportReq.length === 0)
        e('read-only-report needs a required report.final check');
    }
    if (DIAGNOSIS_KINDS.has(kind) && reportReq.length === 0)
      e(`${kind} needs a required report.final check`);
  }
  return task;
}

function coverageOf(tasks, epoch) {
  const cells = {};
  const tags = new Set();
  const fixturesUsed = new Set();
  const hosts = new Set();
  const classifications = {};
  for (const t of tasks) {
    cells[`${t.workflow}/${t.caseType}`] =
      (cells[`${t.workflow}/${t.caseType}`] ?? 0) + 1;
    for (const tag of t.tags ?? []) tags.add(tag);
    fixturesUsed.add(t.workspace?.fixture);
    hosts.add(t.environment?.host);
    const cls = t.expectations?.[epoch]?.classification ?? 'not-evaluable';
    classifications[cls] = (classifications[cls] ?? 0) + 1;
  }
  return { cells, tags, fixturesUsed, hosts, classifications };
}

export function computeLock(loaded) {
  const { root } = loaded;
  const fixtures = {};
  for (const [id, f] of loaded.fixtures) fixtures[id] = treeDigest(f.dir);
  const development = {};
  for (const t of loaded.development)
    development[t.name] = digestTaskDir(t.dir);
  const hp = heldoutPaths(root);
  return {
    schemaVersion: 1,
    corpusVersion: loaded.corpus.corpusVersion,
    referenceEpoch: loaded.corpus.referenceEpoch,
    digestAlgorithm: 'pms-tree-sha256/v1',
    corpus: sha256(fs.readFileSync(path.join(root, 'corpus.json'))),
    harness: {
      schemas: treeDigest(path.join(root, 'schema')),
      reportContract: sha256(
        fs.readFileSync(path.join(root, 'harness/report-contract.md')),
      ),
      oracles: treeDigest(path.join(root, 'src')),
    },
    fixtures,
    development,
    developmentSetDigest: setDigest(Object.entries(development)),
    heldoutManifest: fs.existsSync(hp.manifest)
      ? sha256(fs.readFileSync(hp.manifest))
      : null,
  };
}

export function validateCorpus(loaded, { checkLock = true } = {}) {
  const errors = [];
  const schemas = loadSchemas(loaded.root);
  for (const [name, schema] of Object.entries(schemas)) {
    for (const e of validateSchemaKeywords(schema))
      errors.push(`schema/${name}: ${e}`);
  }
  const { corpus } = loaded;
  for (const e of validate(schemas.corpus, corpus))
    errors.push(`corpus.json: ${e}`);
  if (!Object.hasOwn(corpus.epochs ?? {}, corpus.referenceEpoch))
    errors.push('corpus.json: referenceEpoch is not a declared epoch');
  const schemaWorkflows = schemas.task.$defs.workflow.enum;
  if (JSON.stringify(schemaWorkflows) !== JSON.stringify(corpus.workflows))
    errors.push('corpus.json: workflows differ from the task schema');

  for (const [id, f] of loaded.fixtures) {
    for (const e of validate(schemas.fixture, f.meta))
      errors.push(`fixtures/${id}: ${e}`);
    if (f.meta.id !== id) errors.push(`fixtures/${id}: id mismatch`);
    if (!fs.existsSync(f.projectDir))
      errors.push(`fixtures/${id}: project/ missing`);
    if (f.meta.project != null) {
      if (!fs.existsSync(path.join(f.projectDir, f.meta.project.definition)))
        errors.push(`fixtures/${id}: definition missing`);
      for (const r of f.meta.project.roots)
        if (!fs.existsSync(path.join(f.projectDir, r)))
          errors.push(`fixtures/${id}: root ${r} missing`);
    }
    if (f.meta.pandamstyleInstalled !== (f.meta.project != null))
      errors.push(
        `fixtures/${id}: pandamstyleInstalled must match project presence`,
      );
  }

  const ctx = { corpus, fixtures: loaded.fixtures, schemas, errors };
  const devTasks = loaded.development
    .map((t) => checkTask(t, { ...ctx, split: 'development' }))
    .filter(Boolean);
  const heldTasks = loaded.heldout
    .map((t) => checkTask(t, { ...ctx, split: 'heldout' }))
    .filter(Boolean);

  const cov = coverageOf(devTasks, corpus.referenceEpoch);
  for (const w of corpus.workflows) {
    for (const c of corpus.caseTypes) {
      if (!cov.cells[`${w}/${c}`])
        errors.push(
          `coverage: development split has no ${c} case for workflow ${w}`,
        );
    }
  }
  for (const tag of corpus.requiredTags)
    if (!cov.tags.has(tag))
      errors.push(`coverage: no development task tagged ${tag}`);
  for (const cls of [
    'expressible',
    'missing-product-capability',
    'missing-project-vocabulary',
  ]) {
    if (!cov.classifications[cls])
      errors.push(`coverage: no development task classified ${cls}`);
  }
  if (cov.fixturesUsed.size < 5)
    errors.push(`coverage: only ${cov.fixturesUsed.size} project shapes used`);
  if (cov.hosts.size < 4)
    errors.push(`coverage: only ${cov.hosts.size} hosts used`);

  const manifest = loaded.manifest;
  const devIds = new Set(devTasks.map((t) => t.id));
  if (manifest == null) errors.push('heldout/MANIFEST.json missing');
  else {
    for (const e of validate(schemas['heldout-manifest'], manifest))
      errors.push(`heldout/MANIFEST.json: ${e}`);
    if (manifest.corpusVersion !== corpus.corpusVersion)
      errors.push(
        'heldout/MANIFEST.json: corpusVersion differs from corpus.json',
      );
    const ids = (manifest.tasks ?? []).map((t) => t.id);
    if (new Set(ids).size !== ids.length)
      errors.push('heldout/MANIFEST.json: duplicate task ids');
    for (const id of ids)
      if (devIds.has(id))
        errors.push(
          `heldout task id ${id} also exists in the development split`,
        );
    const heldWorkflows = new Set(
      (manifest.tasks ?? []).map((t) => t.workflow),
    );
    for (const w of corpus.workflows)
      if (!heldWorkflows.has(w))
        errors.push(`heldout coverage: no held-out task for workflow ${w}`);
    for (const t of manifest.tasks ?? []) {
      if (!Object.hasOwn(t.classification ?? {}, corpus.referenceEpoch))
        errors.push(
          `heldout ${t.id}: no ${corpus.referenceEpoch} classification`,
        );
      if (!loaded.fixtures.has(t.fixture))
        errors.push(`heldout ${t.id}: unknown fixture ${t.fixture}`);
    }
    if (loaded.heldout.length > 0) {
      const byId = new Map((manifest.tasks ?? []).map((t) => [t.id, t]));
      for (const t of loaded.heldout) {
        const m = byId.get(t.name);
        if (m == null) {
          errors.push(
            `heldout plaintext ${t.name} is not listed in MANIFEST.json`,
          );
          continue;
        }
        if (digestTaskDir(t.dir) !== m.sha256)
          errors.push(
            `heldout ${t.name}: plaintext digest differs from MANIFEST.json`,
          );
        const task = t.task;
        if (task != null) {
          const cls = Object.fromEntries(
            Object.entries(task.expectations ?? {}).map(([k, v]) => [
              k,
              v.classification,
            ]),
          );
          if (JSON.stringify(cls) !== JSON.stringify(m.classification))
            errors.push(
              `heldout ${t.name}: classification differs from MANIFEST.json`,
            );
          if (
            task.workflow !== m.workflow ||
            task.caseType !== m.caseType ||
            task.workspace.fixture !== m.fixture
          ) {
            errors.push(
              `heldout ${t.name}: metadata differs from MANIFEST.json`,
            );
          }
        }
      }
      for (const m of manifest.tasks ?? []) {
        if (!loaded.heldout.some((t) => t.name === m.id))
          errors.push(
            `heldout ${m.id}: listed but plaintext missing from ${loaded.heldoutDir}`,
          );
      }
    }
  }

  if (checkLock) {
    const lockPath = path.join(loaded.root, 'corpus.lock.json');
    if (!fs.existsSync(lockPath))
      errors.push('corpus.lock.json missing (run `pms-agentic lock`)');
    else {
      const lock = readJson(lockPath);
      const now = computeLock(loaded);
      if (JSON.stringify(lock) !== JSON.stringify(now)) {
        const stale = [];
        for (const key of Object.keys(now))
          if (JSON.stringify(lock[key]) !== JSON.stringify(now[key]))
            stale.push(key);
        errors.push(
          `corpus.lock.json is stale (${stale.join(', ')}): review the change, bump corpusVersion if verdicts can change, then run \`pms-agentic lock\``,
        );
      }
    }
  }

  return {
    errors,
    summary: {
      corpusVersion: corpus.corpusVersion,
      referenceEpoch: corpus.referenceEpoch,
      development: devTasks.length,
      heldoutListed: manifest?.tasks?.length ?? 0,
      heldoutPlaintextLoaded: heldTasks.length,
      fixtures: loaded.fixtures.size,
      hosts: [...cov.hosts].sort(),
      classifications: cov.classifications,
      cells: cov.cells,
    },
  };
}
