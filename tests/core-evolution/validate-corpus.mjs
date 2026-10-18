/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Validates the CE-00.2 proof corpus and classifier calibration:
//
//   node tests/core-evolution/validate-corpus.mjs              validate
//   node tests/core-evolution/validate-corpus.mjs --self-test  also prove that drift fails
//
// It needs the repository install (postcss, through the lockfile) because it
// re-derives every declaration with tools/coverage. It checks the records
// against their schemas, input digests, profile/capability/oracle bindings,
// coverage of profiles, fixture classes, interaction states, oracle cases and
// negative categories, assertion targets and mutations, the corpus accounting,
// the calibration against the reported consumer baseline and the publication
// rules of the consumer declaration sets. A pass proves record consistency,
// not that any oracle has run or any capability works.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildAccounting } from '../../tools/coverage/accounting.mjs';
import {
  calibrate,
  recheckSet,
  APPROVED_IDENTIFIERS,
  BASELINE_RECORD,
} from '../../tools/coverage/cli.mjs';
import {
  classifyAlpha1,
  loadAlpha1Policy,
  loadRegistry,
  compositeAccounting,
} from '../../tools/coverage/classify.mjs';
import {
  extractDeclarations,
  redactValue,
  selectorState,
} from '../../tools/coverage/declarations.mjs';
import {
  applyIdentifierPolicy,
  checkPublishedDeclaration,
  identifiersOf,
  loadApproved,
  textProblems,
} from '../../tools/coverage/publication.mjs';

const require = createRequire(import.meta.url);
const postcss = require('postcss');

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (p) => fs.readFileSync(path.join(repo, p));
const json = (p) => JSON.parse(read(p).toString('utf8'));
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

const SCHEMA_DIR = 'tests/core-evolution/schema';
const FILES = {
  corpus: [
    'tests/core-evolution/corpus/corpus.v1.json',
    'core-evolution-corpus.v1',
  ],
  oracles: [
    'tests/core-evolution/corpus/oracles.v1.json',
    'core-evolution-oracles.v1',
  ],
  accounting: [
    'tests/core-evolution/corpus/accounting.v1.json',
    'core-evolution-corpus-accounting.v1',
  ],
  baseline: [BASELINE_RECORD, 'core-evolution-classifier-calibration.v1'],
  approved: [APPROVED_IDENTIFIERS, 'core-evolution-approved-identifiers.v1'],
  findings: [
    'tests/core-evolution/corpus/scope-findings.v1.json',
    'core-evolution-scope-findings.v1',
  ],
};
const REFERENCE_CHECK = 'tests/core-evolution/corpus/reference-check.v1.json';
const BROWSER_ORACLES = new Set([
  'ORC-LAYOUT',
  'ORC-TEXT',
  'ORC-STATE',
  'ORC-KEYBOARD',
  'ORC-A11Y',
  'ORC-CSP',
]);
// Free text in the calibration record may name these and nothing else.
const BASELINE_ALLOWED = {
  urls: ['https://github.com/lbframe/wacando'],
  paths: [
    'tests/core-evolution/corpus/calibration/w-util-343.declarations.v1.json',
    'tests/core-evolution/corpus/calibration/w-mockup-1559.declarations.v1.json',
    'packages/compiler/src/design-system/policy/properties.js',
    'tools/coverage/cli.mjs',
    'tools/coverage/',
  ],
};
// Declaration-set headers may name the extraction tool and the calibration
// record, nothing else.
const SET_HEADER_ALLOWED = {
  paths: ['tools/coverage/cli.mjs', 'baseline.v1.json'],
};
const SET_SCHEMA = 'core-evolution-declaration-set.v1';

const NEGATIVE_CATEGORIES = [
  'wrong-category',
  'private-resource',
  'unknown-selector',
  'raw-style',
  'runtime-value',
  'mixed-design-system',
];
const SUCCESS_ORACLES = [
  'ORC-VOCAB',
  'ORC-CSS',
  'ORC-LAYOUT',
  'ORC-TEXT',
  'ORC-STATE',
  'ORC-KEYBOARD',
  'ORC-A11Y',
  'ORC-CSP',
];
const EXPECT_MODIFIERS = new Set(['on', 'pseudoElement']);

// ---------------------------------------------------------------------------
// Minimal JSON Schema subset, matching the shipped schemas.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function validateSchema(schema, value, where, out) {
  if (out.length > 40) return;
  if (
    schema.const !== undefined &&
    JSON.stringify(schema.const) !== JSON.stringify(value)
  ) {
    out.push(`${where}: expected ${JSON.stringify(schema.const)}`);
    return;
  }
  if (
    schema.enum &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  ) {
    out.push(`${where}: ${JSON.stringify(value)} not in enum`);
    return;
  }
  if (schema.type) {
    const types = [schema.type].flat();
    const actual = typeOf(value);
    if (
      !types.includes(actual) &&
      !(actual === 'integer' && types.includes('number'))
    ) {
      out.push(`${where}: expected ${types.join('|')}, got ${actual}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength)
      out.push(`${where}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      out.push(`${where}: ${value} does not match ${schema.pattern}`);
  }
  if (
    typeof value === 'number' &&
    schema.minimum != null &&
    value < schema.minimum
  )
    out.push(`${where}: below minimum`);
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems)
      out.push(`${where}: fewer than ${schema.minItems} items`);
    if (
      schema.uniqueItems &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      out.push(`${where}: duplicate items`);
    if (schema.items)
      value.forEach((item, i) =>
        validateSchema(schema.items, item, `${where}[${i}]`, out),
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) out.push(`${where}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validateSchema(schema.properties[key], item, `${where}.${key}`, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${where}: unexpected property ${key}`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        validateSchema(
          schema.additionalProperties,
          item,
          `${where}.${key}`,
          out,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Loading.

function loadDocs() {
  const docs = Object.fromEntries(
    Object.entries(FILES).map(([name, [file]]) => [name, json(file)]),
  );
  docs.sets = Object.fromEntries(
    docs.baseline.sets.map((s) => [s.inputId, json(s.declarationSet)]),
  );
  docs.referenceCheck = json(REFERENCE_CHECK);
  docs.profiles = json('tests/core-evolution/profiles.v1.json');
  docs.capabilities = json('tests/core-evolution/capabilities.v1.json');
  return docs;
}

const SCHEMAS = Object.fromEntries(
  [...Object.values(FILES).map(([, s]) => s), SET_SCHEMA].map((s) => [
    s,
    json(`${SCHEMA_DIR}/${s}.schema.json`),
  ]),
);

function fileText(file, docs) {
  return docs.fileOverrides?.[file] ?? read(file).toString('utf8');
}

function testIds(fixture, docs) {
  const ids = new Set();
  for (const input of fixture.inputs) {
    if (input.role !== 'reference-page') continue;
    for (const m of fileText(input.path, docs).matchAll(
      /data-testid="([^"]+)"/g,
    ))
      ids.add(m[1]);
  }
  return ids;
}

// Every testid named inside an expectation value.
function namedTargets(expect) {
  const out = [];
  const visit = (key, value) => {
    if (
      ['container', 'of', 'target', 'computedOn'].includes(key) &&
      typeof value === 'string'
    )
      out.push(value);
    else if (key === 'focusOrder' && Array.isArray(value)) out.push(...value);
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) visit(k, v);
  };
  for (const [k, v] of Object.entries(expect ?? {})) visit(k, v);
  return out;
}

function cssRule(css, selector) {
  let found = null;
  postcss.parse(css).walkRules((rule) => {
    if (found == null && rule.selector === selector) found = rule;
  });
  return found;
}

// ---------------------------------------------------------------------------
// Validation.

function validateDocs(docs, env) {
  const failures = [];
  let checks = 0;
  const check = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };

  // Schemas.
  for (const [name, [file, schema]] of Object.entries(FILES)) {
    const out = [];
    validateSchema(SCHEMAS[schema], docs[name], file, out);
    check(out.length === 0, `schema: ${out.slice(0, 5).join('; ')}`);
  }
  for (const [id, set] of Object.entries(docs.sets)) {
    const out = [];
    validateSchema(SCHEMAS[SET_SCHEMA], set, id, out);
    check(out.length === 0, `schema: ${out.slice(0, 5).join('; ')}`);
  }

  const { corpus, oracles, profiles, capabilities } = docs;
  const profileById = new Map(profiles.profiles.map((p) => [p.id, p]));
  const capabilitySets = new Set(
    capabilities.capabilities.flatMap((c) => c.proofRecord.fixtureSets),
  );
  const oracleById = new Map(oracles.oracles.map((o) => [o.id, o]));
  const stateNames = new Set(Object.keys(oracles.states));

  // Oracles.
  for (const cls of [
    'accepted-vocabulary',
    'expected-css',
    'layout',
    'text',
    'state',
    'keyboard',
    'accessibility',
    'csp',
  ])
    check(
      oracles.oracles.filter((o) => o.class === cls).length === 1,
      `oracle class ${cls} must be defined exactly once`,
    );
  check(
    oracleById.size === oracles.oracles.length,
    'oracle ids must be unique',
  );
  for (const [group, states] of Object.entries(
    oracles.requiredInteractionStates,
  ))
    for (const s of states)
      check(
        stateNames.has(s),
        `interaction state group ${group}: unknown state ${s}`,
      );

  // Fixture inputs, bindings and success criteria.
  const assertionIds = new Set();
  const classCover = new Set();
  const stateCover = new Set();
  const profileCases = new Map(
    [...profileById.keys()].map((p) => [p, new Set()]),
  );
  const oracleCases = new Map(oracles.oracles.map((o) => [o.id, new Set()]));
  for (const fixture of corpus.fixtures) {
    const where = fixture.id;
    for (const input of fixture.inputs) {
      const exists = fs.existsSync(path.join(repo, input.path));
      check(exists, `${where}: missing input ${input.path}`);
      if (exists)
        check(
          sha256(docs.fileOverrides?.[input.path] ?? read(input.path)) ===
            input.sha256,
          `${where}: input digest differs for ${input.path}`,
        );
    }
    const inputPaths = new Set(fixture.inputs.map((i) => i.path));
    for (const sheet of fixture.expectedCss.stylesheets)
      check(
        inputPaths.has(sheet),
        `${where}: expected stylesheet ${sheet} is not a pinned input`,
      );
    for (const input of fixture.inputs.filter(
      (i) => i.role === 'reference-page',
    ))
      check(
        fileText(input.path, docs).includes(`content="${fixture.csp}"`),
        `${where}: ${input.path} does not declare the fixture CSP`,
      );
    for (const p of fixture.profiles) {
      check(profileById.has(p), `${where}: unknown profile ${p}`);
      profileCases.get(p)?.add('positive-fixture');
    }
    const declaredBy = fixture.profiles.filter((p) =>
      (profileById.get(p)?.corpusFixtureClasses ?? []).some(
        (c) => c.split(':')[0] === fixture.fixtureClass,
      ),
    );
    check(
      declaredBy.length > 0,
      `${where}: no bound profile declares fixture class ${fixture.fixtureClass}`,
    );
    for (const p of declaredBy) classCover.add(`${p}|${fixture.fixtureClass}`);
    for (const set of fixture.capabilityFixtureSets)
      check(
        capabilitySets.has(set),
        `${where}: unknown capability fixture set ${set}`,
      );
    for (const s of fixture.states) {
      check(stateNames.has(s), `${where}: unknown state ${s}`);
      stateCover.add(s);
    }
    const vocab = fixture.acceptedVocabulary;
    check(
      vocab.tokens.length + vocab.conditions.length + vocab.resources.length >
        0,
      `${where}: empty accepted vocabulary`,
    );
    const ids = testIds(fixture, docs);
    const viewports = new Set(fixture.viewports.map((v) => v.id));
    const byId = new Map(fixture.assertions.map((a) => [a.id, a]));
    for (const oracle of SUCCESS_ORACLES)
      check(
        fixture.assertions.some(
          (a) => a.oracle === oracle && a.case !== 'negative',
        ),
        `${where}: missing ${oracle} success criterion`,
      );
    for (const a of fixture.assertions) {
      const at = `${where}/${a.id}`;
      check(!assertionIds.has(a.id), `${at}: duplicate assertion id`);
      assertionIds.add(a.id);
      const oracle = oracleById.get(a.oracle);
      check(oracle != null, `${at}: unknown oracle ${a.oracle}`);
      if (oracle == null) continue;
      oracleCases.get(a.oracle).add(a.case);
      const scope = a.profiles ?? fixture.profiles;
      for (const p of scope) {
        check(
          fixture.profiles.includes(p),
          `${at}: profile ${p} not bound to the fixture`,
        );
        if (a.case === 'boundary')
          profileCases.get(p)?.add('boundary-assertion');
      }
      if (a.case === 'negative') {
        check(
          a.mutation != null && a.mustFail != null,
          `${at}: negative case needs a mutation and mustFail`,
        );
        const target = byId.get(a.mustFail);
        check(
          target != null &&
            target.oracle === a.oracle &&
            target.case !== 'negative',
          `${at}: mustFail must name a non-negative ${a.oracle} assertion of the same fixture`,
        );
        const m = a.mutation ?? {};
        if (
          ['remove-declaration', 'replace-value', 'remove-rule'].includes(
            m.kind,
          )
        ) {
          const file = [...inputPaths].find((p) => p.endsWith(`/${m.file}`));
          const rule = file ? cssRule(fileText(file, docs), m.selector) : null;
          check(
            rule != null,
            `${at}: mutation selector ${m.selector} not found in ${m.file}`,
          );
          if (rule && m.kind !== 'remove-rule')
            check(
              rule.nodes.some(
                (n) => n.type === 'decl' && n.prop === m.property,
              ),
              `${at}: mutation property ${m.property} not declared by ${m.selector}`,
            );
        } else if (m.kind === 'set-attribute') {
          check(
            ids.has(m.target),
            `${at}: mutation target ${m.target} not in the reference page`,
          );
        } else if (m.kind === 'withdraw-vocabulary') {
          check(
            vocab.tokens.some((t) => `${t.category}.${t.name}` === m.item),
            `${at}: withdrawn item ${m.item} is not accepted vocabulary`,
          );
        } else if (m.kind === 'remove-emitted-declaration') {
          check(
            fixture.expectedCss.stylesheets.some((s) => {
              const rule = cssRule(fileText(s, docs), m.selector);
              return rule?.nodes.some(
                (n) => n.type === 'decl' && n.prop === m.property,
              );
            }),
            `${at}: emitted declaration ${m.selector} ${m.property} is not in the reference`,
          );
        }
        continue;
      }
      check(a.expect != null, `${at}: missing expectation`);
      const kinds = Object.keys(a.expect ?? {}).filter(
        (k) => !EXPECT_MODIFIERS.has(k),
      );
      for (const k of kinds)
        check(
          oracle.assertionKinds.includes(k),
          `${at}: ${k} is not an ${a.oracle} assertion kind`,
        );
      if (oracle.evidenceClass === 'E4') {
        check(
          viewports.has(a.viewport),
          `${at}: unknown viewport ${a.viewport}`,
        );
        check(
          fixture.states.includes(a.state),
          `${at}: state ${a.state} not declared by the fixture`,
        );
      }
      for (const t of [a.target, ...namedTargets(a.expect)].filter(Boolean))
        check(ids.has(t), `${at}: target ${t} not in the reference page`);
    }
  }

  // Coverage.
  for (const p of profiles.profiles)
    for (const c of p.corpusFixtureClasses)
      check(
        classCover.has(`${p.id}|${c.split(':')[0]}`),
        `coverage: profile ${p.id} has no fixture of class ${c.split(':')[0]}`,
      );
  for (const [group, states] of Object.entries(
    oracles.requiredInteractionStates,
  ))
    check(
      states.some((s) => stateCover.has(s)),
      `coverage: interaction state ${group} is not exercised by any fixture`,
    );
  for (const [oracle, cases] of oracleCases)
    for (const c of ['positive', 'boundary', 'negative'])
      check(cases.has(c), `coverage: ${oracle} has no ${c} case`);

  // Negative fixtures: intended rejection and executed Alpha 1 observation.
  const negativeIds = new Set();
  const findingById = new Map(docs.findings.findings.map((f) => [f.id, f]));
  const unmetProfiles = new Set();
  for (const n of corpus.negativeFixtures) {
    const at = n.id;
    check(!negativeIds.has(n.id), `${at}: duplicate negative fixture id`);
    negativeIds.add(n.id);
    check(sha256(n.source) === n.sourceSha256, `${at}: source digest differs`);
    for (const def of [n.definition, n.secondSystem?.definition].filter(
      Boolean,
    )) {
      const exists = fs.existsSync(path.join(repo, def.path));
      check(
        exists && sha256(read(def.path)) === def.sha256,
        `${at}: definition digest differs for ${def.path}`,
      );
    }
    for (const p of n.profiles) {
      check(profileById.has(p), `${at}: unknown profile ${p}`);
      profileCases.get(p)?.add('negative-fixture');
    }
    for (const set of n.capabilityFixtureSets)
      check(
        capabilitySets.has(set),
        `${at}: unknown capability fixture set ${set}`,
      );
    const intended = n.expected.intended;
    const observed = n.expected.observedAlpha1;
    const inspected = intended.sourceInspection;
    check(
      fs.existsSync(path.join(repo, inspected.site)) &&
        read(inspected.site).toString('utf8').includes(inspected.rule),
      `${at}: rule ${inspected.rule} not found at ${inspected.site}`,
    );
    const rejected = observed.outcome !== 'compiler-accepted';
    check(
      rejected === observed.codes.length > 0 &&
        rejected === (observed.rule != null) &&
        rejected === (observed.phase != null),
      `${at}: observed outcome, codes, rule and phase disagree`,
    );
    if (/import/.test(n.source) && /\.pandamstyle\/vendor/.test(n.source))
      check(
        n.secondSystem != null,
        `${at}: imports a second system without pinning it`,
      );
    if (n.category === 'mixed-design-system')
      check(
        n.secondSystem != null &&
          observed.runtimeProbe?.outcome === 'runtime-rejected',
        `${at}: a mixed-system fixture needs a pinned second system and a runtime probe`,
      );
    if (!rejected) {
      const finding = findingById.get(observed.defect?.scopeFinding);
      check(
        finding != null &&
          finding.kind === 'compiler-defect' &&
          finding.owner === observed.defect.owner &&
          finding.issue === observed.defect.issue,
        `${at}: an accepted negative needs a compiler-defect scope finding`,
      );
      for (const p of n.profiles) unmetProfiles.add(p);
    }
  }
  // A profile whose negatives are all accepted today must say so.
  for (const p of unmetProfiles) {
    const met = corpus.negativeFixtures.some(
      (n) =>
        n.profiles.includes(p) &&
        n.expected.observedAlpha1.outcome !== 'compiler-accepted',
    );
    if (!met)
      check(
        docs.findings.findings.some((f) => (f.profileImpact ?? []).includes(p)),
        `coverage: profile ${p} has no executed rejection and no scope finding states it`,
      );
  }
  // Scope findings bind to real lots and issues.
  const lotIssues = capabilities.lotIssues;
  for (const f of docs.findings.findings) {
    const lot = f.owner.split('.')[0];
    check(
      (lotIssues[lot] ?? []).includes(f.issue),
      `${f.id}: issue ${f.issue} is not an issue of ${lot}`,
    );
  }
  check(
    docs.sets['W-MOCKUP-1559']?.declarations.some(
      (d) => d.property === 'font-display' && d.registry.entry == null,
    ) && findingById.get('SF-01')?.owner === 'CE-09.1',
    'SF-01: the unregistered font-display descriptor needs its CE-09.1 handoff',
  );
  for (const c of NEGATIVE_CATEGORIES)
    check(
      corpus.negativeFixtures.some((n) => n.category === c),
      `coverage: no negative fixture of category ${c}`,
    );
  for (const [p, cases] of profileCases)
    for (const c of [
      'positive-fixture',
      'boundary-assertion',
      'negative-fixture',
    ])
      check(cases.has(c), `coverage: profile ${p} has no ${c}`);

  // Corpus accounting: re-derive from the pinned stylesheets.
  const derived = buildAccounting(
    { fixtures: corpus.fixtures.map((f) => ({ ...f })) },
    env.policy,
    env.registry,
    docs.fileOverrides,
  );
  check(
    JSON.stringify(derived) === JSON.stringify(docs.accounting),
    'accounting: committed accounting.v1.json differs from re-derivation (run node tools/coverage/cli.mjs corpus)',
  );
  for (const s of docs.accounting.stylesheets) {
    const c = s.counts;
    const sum = Object.values(c.byOutcome).reduce((a, b) => a + b, 0);
    const excluded = Object.values(c.excluded).reduce((a, b) => a + b, 0);
    check(
      sum === c.baseline,
      `accounting: ${s.path} outcomes do not sum to its baseline`,
    );
    check(
      c.baseline + excluded === c.all,
      `accounting: ${s.path} declarations unaccounted`,
    );
    check(
      s.declarations.every(
        (d) => d.registry.entry != null || d.registry.unregisteredReason,
      ),
      `accounting: ${s.path} has a declaration without registry accounting`,
    );
    check(
      s.declarations
        .filter((d) => d.alpha1?.outcome === 'composite-rewrite')
        .every((d) => d.composite != null),
      `accounting: ${s.path} has a composite without longhand accounting`,
    );
  }

  // Calibration.
  const { baseline, sets } = docs;
  for (const entry of baseline.sets) {
    const set = sets[entry.inputId];
    const { problems } = recheckSet(set, env.policy, env.registry);
    check(
      problems.length === 0,
      `calibration: ${entry.inputId} re-derivation: ${problems.slice(0, 3).join('; ')}`,
    );
    check(
      set.inputId === entry.inputId,
      `calibration: ${entry.inputId} set id differs`,
    );
    check(
      set.input.positionMapSha256 === entry.input.positionMapSha256 &&
        set.input.sha256 === entry.input.sha256,
      `calibration: ${entry.inputId} input or position-map digest differs from the set`,
    );
    for (const p of entry.profiles)
      check(
        profileById.has(p),
        `calibration: ${entry.inputId} unknown profile ${p}`,
      );
    const c = set.counts;
    const excluded = Object.values(c.excluded).reduce((a, b) => a + b, 0);
    check(
      c.baseline + excluded === c.all,
      `calibration: ${entry.inputId} declarations unaccounted`,
    );
    const r = entry.reported;
    check(
      r.expressible + r.compositeRewrite + r.gap === r.total &&
        r.absentProperty + r.outOfDomain === r.gap,
      `calibration: ${entry.inputId} reported categories do not add up`,
    );
    const run = baseline.originalClassifier.recordedRuns.find(
      (x) => x.inputId === entry.inputId,
    );
    const map = baseline.originalClassifier.bucketMapping;
    const sumOf = (buckets) =>
      buckets.reduce((a, b) => a + (run?.buckets[b] ?? 0), 0);
    check(
      run != null &&
        run.total === r.total &&
        sumOf(map.expressible) === r.expressible &&
        sumOf(map.compositeRewrite) === r.compositeRewrite &&
        sumOf(map.absentProperty) === r.absentProperty &&
        sumOf(map.outOfDomain) === r.outOfDomain,
      `calibration: ${entry.inputId} recorded original run does not map to the reported counts`,
    );
    check(
      JSON.stringify(set.counts.byBucket) ===
        JSON.stringify(
          Object.fromEntries(Object.entries(run?.buckets ?? {}).sort()),
        ),
      `calibration: ${entry.inputId} buckets differ from the recorded original run`,
    );
  }
  for (const r of calibrate(baseline, sets))
    check(
      r.mismatches.length === 0,
      `calibration: reported baseline: ${r.mismatches.join('; ')}`,
    );
  for (const limit of baseline.calibrationLimits) {
    if (!limit.measure) continue;
    for (const [id, value] of Object.entries(limit.values)) {
      const c = sets[id]?.counts;
      const measured =
        limit.measure.key == null
          ? c?.[limit.measure.counter]
          : (c?.[limit.measure.counter]?.[limit.measure.key] ?? 0);
      check(
        measured === value,
        `calibration: ${limit.id} ${id} records ${value}, sets measure ${measured}`,
      );
    }
  }
  check(
    baseline.originalClassifier.policyModule.sha256 ===
      env.policyIdentity.sha256 &&
      baseline.originalClassifier.policyModule.gitBlob ===
        env.policyIdentity.gitBlob,
    'calibration: policy identity differs from the classifier pin',
  );
  check(
    sets['W-UTIL-343'] && sets['W-MOCKUP-1559'],
    'calibration: both reported baselines need a declaration set',
  );

  // Publication rules: every published field of the consumer sets, the
  // calibration record and the corpus accounting.
  const approved = loadApproved(docs.approved);
  check(
    approved.size === docs.approved.identifiers.length,
    'privacy: approved identifiers must be unique',
  );
  const used = new Set();
  for (const [id, set] of Object.entries(sets)) {
    for (const problem of textProblems(
      JSON.stringify({ ...set, declarations: [] }),
      SET_HEADER_ALLOWED,
    ))
      check(false, `privacy: ${id} header carries ${problem}`);
    for (const d of set.declarations) {
      const problems = checkPublishedDeclaration(d, id, approved);
      check(
        problems.length === 0,
        `privacy: ${id} ${problems.slice(0, 2).join('; ')}`,
      );
      for (const i of [
        d.property,
        d.context?.layer,
        ...identifiersOf(d.value ?? ''),
      ])
        if (approved.has(i)) used.add(i);
    }
  }
  for (const identifier of approved.keys())
    check(
      used.has(identifier),
      `privacy: approved identifier ${identifier} is never published`,
    );
  const walk = (value, at, visit) => {
    if (typeof value === 'string') visit(value, at);
    else if (value && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, `${at}.${k}`, visit);
  };
  walk(baseline, 'baseline', (text, at) => {
    for (const problem of textProblems(text, BASELINE_ALLOWED))
      check(false, `privacy: ${at} carries ${problem}`);
  });
  for (const s of docs.accounting.stylesheets) {
    check(
      /^tests\/core-evolution\/corpus\/fixtures\/[a-z-]+\/[a-z-]+\.css$/.test(
        s.path,
      ),
      `privacy: accounting path ${s.path} is not a corpus stylesheet`,
    );
    const inputId = `${s.fixtureId}:${path.basename(s.path, '.css')}`;
    for (const d of s.declarations) {
      check(
        new RegExp(`^${inputId}#[0-9]{3}$`).test(d.id) &&
          !('location' in d) &&
          textProblems(
            d.value.replace(/url\(<redacted:url:sha256:[0-9a-f]{64}>\)/g, ''),
          ).length === 0 &&
          textProblems(JSON.stringify(d.context)).length === 0,
        `privacy: accounting ${d.id} carries a path, location, URL or non-ASCII text`,
      );
    }
  }

  // Reference check: recorded against the current pinned inputs.
  const report = docs.referenceCheck;
  const currentInputs = Object.fromEntries(
    corpus.fixtures.flatMap((f) => f.inputs).map((i) => [i.path, i.sha256]),
  );
  check(
    JSON.stringify(report.inputs) === JSON.stringify(currentInputs),
    'reference check: recorded against different inputs; rerun check-references.mjs',
  );
  check(
    report.engine?.version === '148.0.7778.96' &&
      report.engine?.playwrightCore === '1.60.0',
    'reference check: engine identity is not the pinned Chromium 148.0.7778.96 / playwright-core 1.60.0',
  );
  const rows = new Map(report.rows.map((r) => [r.id, r]));
  for (const f of corpus.fixtures)
    for (const a of f.assertions.filter((x) => BROWSER_ORACLES.has(x.oracle))) {
      const row = rows.get(a.id);
      check(row != null, `reference check: ${a.id} has no recorded result`);
      if (row == null) continue;
      check(
        row.status !== 'fail',
        `reference check: ${a.id} fails on the reference page`,
      );
      if (row.status === 'not-evaluated' || row.status === 'not-applicable')
        check(
          (row.results ?? [{ note: row.note }]).every((r) => r.note),
          `reference check: ${a.id} is not evaluated without a stated reason`,
        );
    }

  return { failures, checks };
}

// ---------------------------------------------------------------------------
// Focused classifier and parser fixtures.

function parserFixtures(policy) {
  const failures = [];
  const expect = (condition, message) => {
    if (!condition) failures.push(`parser fixture: ${message}`);
  };
  const one = (css, options) => extractDeclarations(css, options);

  let d = one('a:hover { color: red }')[0];
  expect(
    d.context.state.pseudoClasses.join() === ':hover',
    'pseudo-class context',
  );
  d = one('.hover\\:bg_x:is(:hover,[data-hover]) { background: red }')[0];
  expect(
    d.context.state.pseudoClasses.join() === ':hover,:is' &&
      d.context.state.attributes.join() === 'data-hover' &&
      !JSON.stringify(d).includes('bg_x'),
    'escaped utility selector reduces to its state context',
  );
  d = one('[data-product-flag] .x { color: red }')[0];
  expect(
    d.context.state.redactedAttributes === 1 &&
      !JSON.stringify(d).includes('product'),
    'unknown attribute name is redacted',
  );
  d = one('.x::before { content: "Hello there" }')[0];
  const r = redactValue(d.value);
  expect(
    d.context.state.pseudoElements.join() === '::before' &&
      r.redactions[0]?.kind === 'string' &&
      !r.value.includes('Hello'),
    'string content is redacted',
  );
  expect(
    redactValue("url('https://cdn.example/x.png')").redactions[0]?.kind ===
      'url',
    'url is redacted',
  );
  expect(
    redactValue('var(--colors-border-strong-hover-state)').redactions.length ===
      0,
    'long kebab identifier is kept',
  );
  expect(
    redactValue('X9Q7W2M8P4L1R6T3Z5V0N8K2D7H4').redactions[0]?.kind ===
      'opaque',
    'opaque token is redacted',
  );
  const all = one(
    '@keyframes k { from { opacity: 1 } } :root { --x: 1 } @layer utilities { .a { color: red } } .b { color: blue }',
    { baselineLayer: 'utilities' },
  );
  expect(
    all.map((x) => x.excludedReason).join() ===
      'keyframes-frame,custom-property,,layer-outside-measured-input',
    'denominator exclusions',
  );
  const cls = (property, value) =>
    classifyAlpha1({ property, value, context: {} }, policy);
  expect(
    cls('padding', '4px').bucket === 'category',
    'category-bound property',
  );
  const opacity = cls('opacity', '0.5');
  expect(
    opacity.bucket === 'structural-ok' && opacity.numericCoercion,
    'numeric coercion',
  );
  expect(
    cls('opacity', '2').bucket === 'structural-forbidden',
    'numeric range',
  );
  expect(
    cls('display', 'inline-grid').gapKind === 'out-of-domain',
    'out-of-domain value',
  );
  expect(
    cls('cursor', 'pointer').gapKind === 'absent-property',
    'absent property',
  );
  expect(
    cls('-webkit-user-select', 'none').bucket === 'unsupported',
    'vendor name camelCase',
  );
  expect(
    cls('border', '1px solid red').outcome === 'composite-rewrite',
    'composite form',
  );
  const custom = new Map([
    ['--brand', ['#3e563f', 'rgb(1, 2, 3)']],
    ['--gap', ['4px']],
  ]);
  const bg = (value) =>
    compositeAccounting({ property: 'background', value }, policy, custom)
      .rewrite;
  expect(
    [
      '#fff',
      'white',
      'currentColor',
      'transparent',
      'Canvas',
      'oklch(22% 0.02 240/0.35)',
      'var(--brand)',
    ].every((v) => bg(v) === 'background-color-only'),
    'background colors rewrite to background-color',
  );
  expect(
    [
      'none',
      'url(x) no-repeat',
      'inherit',
      'var(--gap)',
      'var(--undefined)',
      'nonecolor',
    ].every((v) => bg(v) === 'full-longhand-reset'),
    'a non-color background needs the full longhand reset',
  );
  expect(
    !('location' in one('.a { color: red }')[0]) &&
      'position' in one('.a { color: red }')[0],
    'positions are separate from records',
  );
  const approvedFixture = new Map([
    ['--ok', {}],
    ['Brand', {}],
  ]);
  const policed = applyIdentifierPolicy(
    {
      id: 'X#001',
      property: '--secret-name',
      value: 'AcmeSans, Brand, sans-serif',
      context: {
        layer: 'acme-layer',
        atRules: ['@media (min-width: 1px) and (acme: 1)'],
        state: { pseudoClasses: [':hover', ':acme'] },
      },
      redactions: [],
    },
    approvedFixture,
  );
  expect(
    !JSON.stringify(policed).includes('cme') &&
      !JSON.stringify(policed).includes('secret') &&
      policed.value.includes('Brand') &&
      policed.context.state.pseudoClasses.join() === ':hover' &&
      policed.context.state.redactedSelectorParts === 1,
    'identifier policy redacts unapproved identifiers in every field',
  );
  d = one('.a { color: red !important }')[0];
  expect(
    d.important === true && d.value === 'red',
    '!important is separated from the value',
  );
  d = one('@font-face { font-display: swap }')[0];
  expect(d.context.descriptor === 'font-face', 'font-face descriptor context');
  const nested = selectorState('.a:not(.b):has(> [aria-expanded="true"])');
  expect(
    nested.attributes.has('aria-expanded') &&
      nested.pseudoClasses.has(':not') &&
      nested.pseudoClasses.has(':has') &&
      nested.compoundSelectors === 2,
    'nested selector arguments',
  );
  return failures;
}

// The recovered measurement extracted declarations with a regular expression.
// On every corpus stylesheet the parser must yield the same baseline multiset.
function regexParity(docs) {
  const failures = [];
  for (const fixture of docs.corpus.fixtures) {
    for (const file of fixture.expectedCss.stylesheets) {
      const css = fileText(file, docs);
      const stripped = css
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
      const a = [];
      for (const m of stripped.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g))
        if (!m[1].startsWith('--'))
          a.push(`${m[1]}: ${m[2].replace(/!important/, '').trim()}`);
      const b = extractDeclarations(css)
        .filter((x) => x.denominator === 'alpha1-baseline')
        .map((x) => `${x.property}: ${x.value}`);
      const key = (list) => JSON.stringify([...list].sort());
      if (key(a) !== key(b))
        failures.push(
          `regex parity: ${file} differs between the regular expression and the parser`,
        );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Self-test mutations: each must fail for its stated reason.

const MUTATIONS = [
  [
    'an input digest drifts',
    /input digest differs/,
    (d) => {
      d.corpus.fixtures[0].inputs[0].sha256 = '0'.repeat(64);
    },
  ],
  [
    'a pinned stylesheet changes',
    /input digest differs|accounting/,
    (d) => {
      const f = d.corpus.fixtures[0].expectedCss.stylesheets[0];
      d.fileOverrides = {
        [f]: `${read(f).toString('utf8')}\n.extra { color: red; }\n`,
      };
    },
  ],
  [
    'a negative category disappears',
    /no negative fixture of category raw-style/,
    (d) => {
      d.corpus.negativeFixtures = d.corpus.negativeFixtures.filter(
        (n) => n.category !== 'raw-style',
      );
    },
  ],
  [
    'a profile loses its negative fixture',
    /profile rtl has no negative-fixture/,
    (d) => {
      for (const n of d.corpus.negativeFixtures)
        n.profiles = n.profiles
          .filter((p) => p !== 'rtl')
          .concat(
            n.profiles.length === 1 && n.profiles[0] === 'rtl' ? ['web'] : [],
          );
    },
  ],
  [
    'a profile loses its boundary case',
    /profile ssr has no boundary-assertion/,
    (d) => {
      for (const f of d.corpus.fixtures)
        if (f.profiles.includes('ssr'))
          for (const a of f.assertions)
            if (a.case === 'boundary') a.case = 'positive';
    },
  ],
  [
    'an oracle loses its boundary case',
    /ORC-TEXT has no boundary case/,
    (d) => {
      for (const f of d.corpus.fixtures)
        for (const a of f.assertions)
          if (a.oracle === 'ORC-TEXT' && a.case === 'boundary')
            a.case = 'positive';
    },
  ],
  [
    'an oracle loses its negative control',
    /ORC-CSP has no negative case/,
    (d) => {
      for (const f of d.corpus.fixtures)
        f.assertions = f.assertions.filter(
          (a) => !(a.oracle === 'ORC-CSP' && a.case === 'negative'),
        );
    },
  ],
  [
    'a fixture loses a success criterion',
    /missing ORC-KEYBOARD success criterion/,
    (d) => {
      d.corpus.fixtures[1].assertions = d.corpus.fixtures[1].assertions.filter(
        (a) => a.oracle !== 'ORC-KEYBOARD',
      );
    },
  ],
  [
    'an interaction state is no longer exercised',
    /interaction state loading/,
    (d) => {
      for (const f of d.corpus.fixtures) {
        f.states = f.states.filter((s) => s !== 'loading');
        f.assertions = f.assertions.filter((a) => a.state !== 'loading');
      }
    },
  ],
  [
    'a fixture class loses its profile binding',
    /profile reusable-package has no fixture of class component-library/,
    (d) => {
      const f = d.corpus.fixtures.find(
        (x) => x.fixtureClass === 'component-library',
      );
      f.profiles = f.profiles.filter((p) => p !== 'reusable-package');
    },
  ],
  [
    'an assertion targets a missing element',
    /target nowhere not in the reference page/,
    (d) => {
      d.corpus.fixtures[0].assertions.find((a) => a.target).target = 'nowhere';
    },
  ],
  [
    'a negative control names another oracle',
    /mustFail must name/,
    (d) => {
      const a = d.corpus.fixtures[0].assertions.find(
        (x) => x.case === 'negative' && x.oracle === 'ORC-LAYOUT',
      );
      a.mustFail = 'SHELL-T1';
    },
  ],
  [
    'a mutation names an undeclared property',
    /mutation property/,
    (d) => {
      const a = d.corpus.fixtures[0].assertions.find(
        (x) => x.mutation?.kind === 'remove-declaration',
      );
      a.mutation.property = 'grid-template-areas';
    },
  ],
  [
    'an unknown capability fixture set',
    /unknown capability fixture set/,
    (d) => {
      d.corpus.fixtures[0].capabilityFixtureSets.push('CE-FX-CAP-05-invented');
    },
  ],
  [
    'an assertion kind outside its oracle',
    /is not an ORC-LAYOUT assertion kind/,
    (d) => {
      d.corpus.fixtures[0].assertions.find(
        (a) => a.oracle === 'ORC-LAYOUT' && a.case === 'positive',
      ).expect = { contrastMin: 4.5 };
    },
  ],
  [
    'a negative fixture source drifts',
    /source digest differs/,
    (d) => {
      d.corpus.negativeFixtures[0].source += '\n';
    },
  ],
  [
    'an Alpha 1 rule that does not exist',
    /not found at/,
    (d) => {
      d.corpus.negativeFixtures[0].expected.intended.sourceInspection.rule =
        'invented-rule';
    },
  ],
  [
    'accounting drifts',
    /accounting/,
    (d) => {
      d.accounting.stylesheets[0].declarations[0].alpha1 = {
        bucket: 'category',
        outcome: 'expressible',
      };
      d.accounting.stylesheets[0].declarations[0].property = 'padding';
    },
  ],
  [
    'a calibration record is relabeled',
    /re-derivation/,
    (d) => {
      const rec = d.sets['W-UTIL-343'].declarations.find(
        (x) => x.alpha1?.outcome === 'gap',
      );
      rec.alpha1 = { bucket: 'category', outcome: 'expressible' };
    },
  ],
  [
    'a reported baseline count is changed',
    /reported baseline|recorded original run/,
    (d) => {
      d.baseline.sets[0].reported.expressible = 211;
      d.baseline.sets[0].reported.gap = 95;
      d.baseline.sets[0].reported.absentProperty = 48;
    },
  ],
  [
    'a calibration limit value is changed',
    /CAL-01/,
    (d) => {
      d.baseline.calibrationLimits[0].values['W-UTIL-343'] = 4;
    },
  ],
  [
    'a consumer URL is published unredacted',
    /privacy/,
    (d) => {
      d.sets['W-MOCKUP-1559'].declarations[0].value =
        'url(https://cdn.example/font.ttf)';
    },
  ],
  [
    'a consumer selector is published',
    /privacy|schema/,
    (d) => {
      d.sets['W-UTIL-343'].declarations[0].context.selector = '.consumer-panel';
    },
  ],
  [
    'the original classifier is claimed as published',
    /schema/,
    (d) => {
      d.baseline.originalClassifier.published = true;
    },
  ],
  // Publication bypasses found in the CE-00.2 review, and their neighbours.
  [
    'a private URL inside a media condition',
    /privacy/,
    (d) => {
      d.sets['W-MOCKUP-1559'].declarations.find(
        (x) => x.context.atRules?.length,
      ).context.atRules = [
        '@media (min-width: 1px) and (url: https://assets.internal.example/x)',
      ];
    },
  ],
  [
    'a clear path in a layer name',
    /privacy: .*layer/,
    (d) => {
      d.sets['W-UTIL-343'].declarations.find(
        (x) => x.context.layer,
      ).context.layer = 'project/src/panel';
    },
  ],
  [
    'a path-like declaration id',
    /privacy: .*id is not an ordinal/,
    (d) => {
      d.sets['W-UTIL-343'].declarations[3].id =
        'W-UTIL-343#project/src/styles.css:12';
    },
  ],
  [
    'a state attribute outside the allow-list',
    /privacy: .*attribute data-account-id is not allow-listed/,
    (d) => {
      d.sets['W-UTIL-343'].declarations[5].context.state = {
        attributes: ['data-account-id'],
      };
    },
  ],
  [
    'an unapproved custom-property name',
    /privacy: .*custom property --acme-billing-tier is neither approved nor redacted/,
    (d) => {
      d.sets['W-UTIL-343'].declarations.find((x) =>
        x.property.startsWith('--'),
      ).property = '--acme-billing-tier';
    },
  ],
  [
    'an unapproved font identifier in a value',
    /privacy: .*value identifier AcmeCorpSans is not approved/,
    (d) => {
      d.sets['W-MOCKUP-1559'].declarations.find(
        (x) => x.property === 'font-family',
      ).value = 'AcmeCorpSans, sans-serif';
    },
  ],
  [
    'an unapproved animation name',
    /privacy: .*value identifier acme-checkout-in is not approved/,
    (d) => {
      d.sets['W-MOCKUP-1559'].declarations.find(
        (x) => x.property === 'animation',
      ).value = 'acme-checkout-in .2s ease-out';
    },
  ],
  [
    'an unknown pseudo-class',
    /privacy: .*pseudo-class :acme-open is not allow-listed/,
    (d) => {
      d.sets['W-UTIL-343'].declarations[7].context.state = {
        pseudoClasses: [':acme-open'],
      };
    },
  ],
  [
    'a location digest is published again',
    /privacy: .*unexpected field location|schema: .*location/,
    (d) => {
      d.sets['W-UTIL-343'].declarations[0].location = 'a'.repeat(64);
    },
  ],
  [
    'non-ASCII text in a consumer value',
    /privacy: .*non-ASCII/,
    (d) => {
      d.sets['W-MOCKUP-1559'].declarations[9].value = 'na\u00efve';
    },
  ],
  [
    'an e-mail address in the calibration record',
    /privacy: baseline.* carries e-mail address/,
    (d) => {
      d.baseline.status += ' Contact someone@example.org.';
    },
  ],
  [
    'a private URL in the calibration record',
    /privacy: baseline.* carries URL/,
    (d) => {
      d.baseline.sets[0].input.recovery +=
        ' https://assets.internal.example/build';
    },
  ],
  [
    'a consumer file path in the calibration record',
    /privacy: baseline.* carries file path/,
    (d) => {
      d.baseline.sets[0].description += ' (project/build/main.css)';
    },
  ],
  [
    'a path-like accounting id',
    /privacy: accounting/,
    (d) => {
      d.accounting.stylesheets[0].declarations[0].id =
        'tests/core-evolution/corpus/fixtures/app-shell/reference.css#001';
    },
  ],
  [
    'an unused approval',
    /approved identifier --never-used is never published/,
    (d) => {
      d.approved.identifiers.push({
        identifier: '--never-used',
        kind: 'custom-property',
        reason: 'test',
      });
    },
  ],
  [
    'an unkeyed (reversible) placeholder digest',
    /privacy: .*not keyed/,
    (d) => {
      const rec = d.sets['W-UTIL-343'].declarations.find(
        (x) => x.redactions?.length,
      );
      rec.value = rec.value.replace(/hmac-sha256/g, 'sha256');
      rec.redactions = rec.redactions.map((r) => ({
        ...r,
        digest: r.digest.replace('hmac-', ''),
      }));
    },
  ],
  // Negative baselines and their findings.
  [
    'an accepted negative without a defect finding',
    /accepted negative needs a compiler-defect scope finding/,
    (d) => {
      delete d.corpus.negativeFixtures.find(
        (n) => n.expected.observedAlpha1.outcome === 'compiler-accepted',
      ).expected.observedAlpha1.defect;
    },
  ],
  [
    'an unmet profile rejection that no finding states',
    /profile rtl has no executed rejection/,
    (d) => {
      for (const f of d.findings.findings) delete f.profileImpact;
    },
  ],
  [
    'a mixed-system fixture without its second system',
    /needs a pinned second system/,
    (d) => {
      delete d.corpus.negativeFixtures.find(
        (n) => n.category === 'mixed-design-system',
      ).secondSystem;
    },
  ],
  [
    'an observed rejection without its codes',
    /observed outcome, codes, rule and phase disagree/,
    (d) => {
      d.corpus.negativeFixtures[0].expected.observedAlpha1.codes = [];
    },
  ],
  [
    'a scope finding bound to another lot',
    /SF-02: issue 54 is not an issue of CE-09/,
    (d) => {
      d.findings.findings.find((f) => f.id === 'SF-02').owner = 'CE-09.1';
    },
  ],
  // Reference check.
  [
    'a failing reference assertion',
    /reference check: GRID-L1 fails/,
    (d) => {
      d.referenceCheck.rows.find((r) => r.id === 'GRID-L1').status = 'fail';
    },
  ],
  [
    'a reference check recorded against other inputs',
    /reference check: recorded against different inputs/,
    (d) => {
      d.corpus.fixtures[3].inputs[1].sha256 = 'f'.repeat(64);
    },
  ],
  [
    'a browser assertion without a recorded result',
    /reference check: SHELL-L1 has no recorded result/,
    (d) => {
      d.referenceCheck.rows = d.referenceCheck.rows.filter(
        (r) => r.id !== 'SHELL-L1',
      );
    },
  ],
  // Composite accounting.
  [
    'background: none relabeled as a background-color rewrite',
    /re-derivation/,
    (d) => {
      const rec = d.sets['W-UTIL-343'].declarations.find(
        (x) => x.composite?.basis === 'none-keyword',
      );
      rec.composite = {
        rewrite: 'background-color-only',
        basis: 'color',
        longhands: ['background-color'],
        longhandsNotAdmitted: [],
      };
    },
  ],
];

// ---------------------------------------------------------------------------

async function main() {
  const { policy, identity } = await loadAlpha1Policy();
  const registry = loadRegistry();
  const env = { policy, registry, policyIdentity: identity };
  const docs = loadDocs();
  const base = validateDocs(docs, env);
  const extra = [...parserFixtures(policy), ...regexParity(docs)];
  const failures = [...base.failures, ...extra];
  if (failures.length) {
    console.error(`FAIL: ${failures.length} problem(s)`);
    for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
    process.exit(1);
  }
  const t = docs.accounting.totals;
  console.log(
    `PASS: ${base.checks} checks; ${docs.corpus.fixtures.length} positive fixtures, ` +
      `${docs.corpus.negativeFixtures.length} negative fixtures, ` +
      `${docs.corpus.fixtures.reduce((a, f) => a + f.assertions.length, 0)} assertions; ` +
      `corpus declarations ${t.all} (baseline ${t.baseline}); calibration ` +
      Object.values(docs.sets)
        .map((s) => `${s.inputId} ${s.counts.baseline}/${s.counts.all}`)
        .join(', '),
  );
  if (!process.argv.includes('--self-test')) return;
  let bad = 0;
  for (const [name, expected, mutate] of MUTATIONS) {
    const mutated = clone(docs);
    mutate(mutated);
    const { failures: got } = validateDocs(mutated, env);
    const ok = got.some((f) => expected.test(f));
    if (!ok) {
      bad += 1;
      console.error(
        `  mutation not detected for its reason: ${name}\n    got: ${got.slice(0, 3).join(' | ') || 'no failure'}`,
      );
    }
  }
  if (bad) {
    console.error(
      `SELF-TEST FAIL: ${bad} of ${MUTATIONS.length} mutations passed or failed for another reason`,
    );
    process.exit(1);
  }
  console.log(
    `SELF-TEST PASS: ${MUTATIONS.length} mutations each fail for their stated reason`,
  );
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
