/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Validates the CE-00.1 scope contract. It has no dependencies and reads
// committed files only:
//
//   node tests/core-evolution/validate.mjs              validate the records
//   node tests/core-evolution/validate.mjs --self-test  also prove that drift fails
//
// Validation checks every record against its JSON Schema, re-derives the whole
// registry from the authored inputs and the recorded upstream facts with
// tools/derive-registry.mjs and requires deep equality, then checks
// independent invariants, input digests and the comparator observation. The
// self-test applies known drift mutations in memory and requires each to fail.
// A pass proves record shape and consistency, not that any capability works.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACT_FIELDS, deriveRegistry } from './tools/derive-registry.mjs';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (p) => fs.readFileSync(path.join(repo, p));
const json = (p) => JSON.parse(read(p).toString('utf8'));
const digest = (p) =>
  `sha256:${crypto.createHash('sha256').update(read(p)).digest('hex')}`;
const clone = (value) => JSON.parse(JSON.stringify(value));

// The reviewed planning artifacts and pinned research inputs are byte-frozen.
const FROZEN = {
  'docs/architecture/core-evolution-plan.md':
    'b2e6778082f30a11b8a45e08737f416fba97082f81d70db48d9a0dc2aa5b4a65',
  'docs/architecture/core-evolution-review.md':
    'c5fe3e2f6f3853e4648852114aef91bb7edc96aaf714c0717663540a8ad2bf73',
  'docs/architecture/core-evolution-coverage.md':
    '836862300daed926ab3cffd7c40dc17f0774c68e10b9619fe053edec6fa11381',
  'docs/architecture/agentic-optimizations-plan.md':
    '25128f625a68b42d94371ab434aa67f97fa19e82992beeb41e9f667bfca8a41d',
  'docs/architecture/agentic-optimizations-review.md':
    'c9509d93881b6463d3082d20bee970c506bf455a32f75826072ddc9f599e6ffe',
  'docs/research/core-evolution-inventory.json':
    '34608bd41f3c05b3c1e81fd039416d4e7bb91b248b36d79848941e2e33557526',
  'docs/research/core-evolution-evidence.json':
    'ef6fa57627bba9f301e223fcaf6ee867d594dbb4a78e1b2a1ad405d0f836ba7a',
  'docs/research/core-evolution-review-evidence.json':
    'c9540f0ba2cfbb6898171df0e524ba63d1990a0dad538f5b2bddc5a1527f2858',
  'docs/research/core-evolution-upstreams.md':
    'dd13310283d52f707ec272f814fc609728ff4e83c695514e185c68ef3c387716',
};

// The repository inputs the registry must cite, with their fixed paths. A
// missing, extra or redirected path fails, so no digest check can be skipped.
const INPUT_PATHS = {
  inventory: 'docs/research/core-evolution-inventory.json',
  evidenceLock: 'docs/research/core-evolution-evidence.json',
  reviewEvidence: 'docs/research/core-evolution-review-evidence.json',
  observations: 'docs/research/core-evolution-upstream-observations.v1.json',
  plan: 'docs/architecture/core-evolution-plan.md',
  coverage: 'docs/architecture/core-evolution-coverage.md',
  review: 'docs/architecture/core-evolution-review.md',
  alpha1Policy: 'packages/compiler/src/design-system/policy/properties.js',
  rules: 'tests/core-evolution/classification-rules.v1.json',
  profiles: 'tests/core-evolution/profiles.v1.json',
  capabilities: 'tests/core-evolution/capabilities.v1.json',
  decisions: 'tests/core-evolution/scope-decisions.v1.json',
};
// Raw upstream outputs are not committed; their digests are bound to the
// observation record or the evidence lock.
const RAW_INPUTS = [
  'upstreamKeyExtraction',
  'stylexEmissionProbe',
  'pandaEmissionProbe',
  'bcdData',
];
const VENDOR = /^-(webkit|moz|ms|o|khtml)-/;
const CLOSING_LOT = (id) =>
  id.startsWith('D-SF-') || id === 'D-BP-12' ? 'CE-13' : 'CE-01';

// Validated documents: [path, schema file].
const DOCS = {
  registry: [
    'docs/research/core-evolution-registry.v1.json',
    'core-evolution-registry.v1.schema.json',
  ],
  observations: [
    'docs/research/core-evolution-upstream-observations.v1.json',
    'core-evolution-upstream-observations.v1.schema.json',
  ],
  rules: [
    'tests/core-evolution/classification-rules.v1.json',
    'core-evolution-classification-rules.v1.schema.json',
  ],
  profiles: [
    'tests/core-evolution/profiles.v1.json',
    'core-evolution-profiles.v1.schema.json',
  ],
  capabilities: [
    'tests/core-evolution/capabilities.v1.json',
    'core-evolution-capabilities.v1.schema.json',
  ],
  decisions: [
    'tests/core-evolution/scope-decisions.v1.json',
    'core-evolution-scope-decisions.v1.schema.json',
  ],
};
const SCHEMAS = Object.fromEntries(
  Object.entries(DOCS).map(([name, [, schema]]) => [
    name,
    json(`tests/core-evolution/schema/${schema}`),
  ]),
);

function loadDocs() {
  return {
    ...Object.fromEntries(
      Object.entries(DOCS).map(([name, [file]]) => [name, json(file)]),
    ),
    inventory: json('docs/research/core-evolution-inventory.json'),
    evidenceLock: json('docs/research/core-evolution-evidence.json'),
    coverageText: read('docs/architecture/core-evolution-coverage.md').toString(
      'utf8',
    ),
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema (2020-12 subset) validator for the shipped schemas.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function validateSchema(schema, value, where, out) {
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
    if (schema.maxItems != null && value.length > schema.maxItems)
      out.push(`${where}: more than ${schema.maxItems} items`);
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

// Paths where two JSON values differ, bounded for readable failures.
function differences(a, b, where, out, limit = 12) {
  if (out.length >= limit) return;
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const bothObjects = a && b && typeof a === 'object' && typeof b === 'object';
  if (!bothObjects || Array.isArray(a) !== Array.isArray(b)) {
    out.push(
      `${where}: committed ${JSON.stringify(a)?.slice(0, 120)}, derived ${JSON.stringify(b)?.slice(0, 120)}`,
    );
    return;
  }
  if (Array.isArray(a) && a.length !== b.length) {
    out.push(`${where}: committed ${a.length} items, derived ${b.length}`);
  }
  const keys = Array.isArray(a)
    ? [...Array(Math.min(a.length, b.length)).keys()]
    : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  if (!Array.isArray(a)) {
    const order = (o) => JSON.stringify(Object.keys(o));
    if (
      order(a) !== order(b) &&
      Object.keys(a).length === Object.keys(b).length
    )
      out.push(`${where}: key order differs`);
  }
  for (const key of keys) {
    const label = Array.isArray(a)
      ? `${where}[${a[key]?.name ?? a[key]?.id ?? key}]`
      : `${where}.${key}`;
    differences(a[key], b[key], label, out, limit);
  }
}

// ---------------------------------------------------------------------------
// Validation of one set of documents.

function validateDocs(docs) {
  const failures = [];
  let checks = 0;
  const check = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };

  for (const [file, sha] of Object.entries(FROZEN)) {
    check(
      digest(file) === `sha256:${sha}`,
      `${file} changed; reviewed/pinned bytes must stay identical`,
    );
  }
  for (const name of Object.keys(DOCS)) {
    const out = [];
    validateSchema(SCHEMAS[name], docs[name], name, out);
    checks += 1;
    out.slice(0, 20).forEach((f) => failures.push(f));
    if (out.length > 20)
      failures.push(`${name}: ${out.length - 20} further schema failures`);
  }
  const {
    registry,
    observations,
    rules,
    profiles,
    capabilities,
    decisions,
    inventory,
  } = docs;
  const entries = registry.entries ?? [];

  // Re-derive the whole registry from the authored inputs and the recorded
  // facts; the committed record must be identical apart from file digests.
  const facts = entries.map((entry) => ({
    name: entry.name,
    ...Object.fromEntries(
      FACT_FIELDS.map((field) => [
        field,
        field === 'bcdRelations' ? (entry[field] ?? []) : entry[field],
      ]),
    ),
  }));
  let derived = null;
  try {
    derived = deriveRegistry({
      inventory,
      rules,
      profiles,
      capSpec: capabilities,
      decisions,
      coverageText: docs.coverageText,
      facts,
    });
  } catch (error) {
    failures.push(`derivation threw: ${error.message}`);
  }
  if (derived) {
    checks += 1;
    derived.errors.forEach((e) => failures.push(`derivation: ${e}`));
    if (derived.registry) {
      const committed = { ...registry, inputs: null };
      const out = [];
      differences(committed, derived.registry, 'registry', out);
      checks += 1;
      out.forEach((d) =>
        failures.push(`generated registry drifted from its derivation: ${d}`),
      );
    }
  }

  // Independent invariants, so a defect in the derivation is also caught.
  const byName = new Map(entries.map((e) => [e.name, e]));
  check(
    entries.length === 1108 &&
      inventory.properties.length === 1108 &&
      byName.size === 1108,
    'denominator is not 1,108 unique entries',
  );
  for (const raw of inventory.properties) {
    check(byName.has(raw[0]), `inventory entry ${raw[0]} has no disposition`);
  }
  const caps = new Map((registry.capabilities ?? []).map((c) => [c.id, c]));
  const expectedCaps = Array.from(
    { length: 48 },
    (_, i) => `CAP-${String(i + 1).padStart(2, '0')}`,
  );
  check(
    JSON.stringify([...caps.keys()]) === JSON.stringify(expectedCaps),
    'registry capabilities must be CAP-01..CAP-48 in order',
  );
  const specs = new Map(capabilities.capabilities.map((c) => [c.id, c]));
  // Proof identity belongs to its own capability, in authored and generated
  // records alike; source inspection alone is never a proof.
  const proofIdentity = (id, proof, where) => {
    check(
      proof?.id === `CE-PROOF-${id}` &&
        proof?.plannedPath === `tests/core-evolution/proofs/${id}.json`,
      `${where} ${id}: proof id and planned path must be CE-PROOF-${id} and tests/core-evolution/proofs/${id}.json`,
    );
    check(
      Array.isArray(proof?.fixtureSets) &&
        proof.fixtureSets.length > 0 &&
        proof.fixtureSets.every((f) => f.startsWith(`CE-FX-${id}-`)),
      `${where} ${id}: every fixture set must be scoped CE-FX-${id}-*`,
    );
    check(
      Array.isArray(proof?.evidenceClasses) &&
        proof.evidenceClasses.some((c) => c !== 'E1'),
      `${where} ${id}: a proof record needs an evidence class beyond source inspection (E1)`,
    );
  };
  for (const spec of capabilities.capabilities)
    proofIdentity(spec.id, spec.proofRecord, 'authored');
  for (const cap of caps.values()) {
    proofIdentity(cap.id, cap.proofRecord, 'registry');
    const spec = specs.get(cap.id);
    check(
      spec &&
        JSON.stringify(cap.proofRecord) === JSON.stringify(spec.proofRecord),
      `${cap.id}: proof record differs from its authored definition`,
    );
    check(
      spec &&
        cap.disposition === spec.disposition &&
        cap.primaryOwner === spec.primaryOwner &&
        cap.closingLot === spec.closingLot &&
        JSON.stringify(cap.limitations) === JSON.stringify(spec.limitations),
      `${cap.id}: disposition, owners or limitations differ from the authored definition`,
    );
  }
  for (const e of entries) {
    check(
      e.proof?.fixtureId === `CE-FX-PROP-${e.name.replace(/^-+/, '')}`,
      `${e.name}: fixture id must be derived from the entry name`,
    );
    const cap = caps.get(e.capability);
    check(cap, `${e.name}: unknown capability ${e.capability}`);
    if (!cap) continue;
    check(
      cap.lots.includes(e.owner) ||
        e.capability === 'CAP-01' ||
        (e.disposition !== 'canonical-property' &&
          ['CE-01', 'CE-02', 'CE-11'].includes(e.owner)),
      `${e.name}: owner ${e.owner} is outside the Work lots of ${e.capability}`,
    );
    if (e.disposition === 'normalized-alias') {
      const target = byName.get(e.canonical);
      check(
        target &&
          ['canonical-property', 'scoped-platform-extension'].includes(
            target.disposition,
          ),
        `${e.name}: alias target ${e.canonical} is not canonical`,
      );
      check(
        !VENDOR.test(e.name),
        `${e.name}: a vendor-prefixed name cannot be a normalized alias`,
      );
      check(
        e.equivalence?.statement &&
          e.equivalence.sources?.length > 0 &&
          e.equivalence.sources.every((src) => src.kind && src.ref),
        `${e.name}: a normalized alias needs a positive equivalence statement with sources`,
      );
      check(
        !e.bcdRelations?.length || e.aliasAudit?.verdict === 'equivalent',
        `${e.name}: a BCD-related alias needs an equivalent audit verdict`,
      );
    }
    if (
      [
        'divergent-legacy-variant',
        'vendor-legacy-variant',
        'superseded-name',
      ].includes(e.subkind)
    ) {
      check(
        byName.get(e.replacement)?.disposition === 'canonical-property' ||
          byName.get(e.replacement)?.disposition ===
            'scoped-platform-extension',
        `${e.name}: a legacy variant must point at a canonical replacement`,
      );
      check(
        !e.prefixedFormShips ||
          (e.emissionDecision === 'D-BP-07' &&
            e.proof.evidenceClasses.includes('E3')) ||
          e.subkind === 'superseded-name',
        `${e.name}: a shipping prefixed form needs D-BP-07 and E3 proof`,
      );
    }
    if (e.subkind === 'divergent-legacy-variant') {
      check(
        e.aliasAudit?.verdict === 'grammar-divergent' &&
          e.aliasAudit.sources?.length > 0,
        `${e.name}: a divergent variant needs a sourced grammar-divergent audit`,
      );
    }
    if (
      ![
        'canonical-property',
        'scoped-platform-extension',
        'system-resource',
      ].includes(e.disposition)
    ) {
      check(
        e.requiredIn.length === 0,
        `${e.name}: ${e.disposition} cannot be required`,
      );
    }
    if (e.requiredIn.length) {
      check(
        ['E2', 'E3', 'E4'].every((c) => e.proof.evidenceClasses.includes(c)),
        `${e.name}: required entry needs E2, E3 and E4 proof`,
      );
    }
  }
  for (const e of entries.filter(
    (x) => !['unsupported', 'rejected-composite-form'].includes(x.alpha1.kind),
  )) {
    check(
      e.disposition === 'canonical-property' && e.requiredIn.length > 0,
      `${e.name}: Alpha 1 admitted property must stay a required canonical property`,
    );
    // Accepted Alpha 1 input is never silently dropped; a vendor-prefixed
    // admitted name would need an explicit migration record.
    check(
      !VENDOR.test(e.name) || Boolean(e.migration),
      `${e.name}: a vendor-prefixed Alpha 1 name needs a migration record`,
    );
  }
  // Every variant or alias resolves to an existing inventory target.
  for (const e of entries.filter((x) => x.variantOf || x.canonical)) {
    const target = byName.get(e.variantOf ?? e.canonical);
    check(target, `${e.name}: unknown target ${e.variantOf ?? e.canonical}`);
  }
  const requiredSomewhere = new Set(
    profiles.profiles.flatMap((p) => p.requiredCapabilities),
  );
  check(
    requiredSomewhere.size === 48,
    'the profiles together must require all 48 capability families',
  );
  check(
    JSON.stringify(profiles.profiles.map((p) => p.id)) ===
      JSON.stringify([
        'web',
        'desktop-renderer',
        'content',
        'forms',
        'data',
        'rtl',
        'svg-media',
        'ssr',
        'reusable-package',
      ]),
    'profiles must be exactly the nine accepted CE-00.1 profiles',
  );
  const count = (key) => {
    const out = {};
    for (const e of entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
    return JSON.stringify(Object.entries(out).sort());
  };
  const stored = (o) => JSON.stringify(Object.entries(o ?? {}).sort());
  check(
    count((e) => e.disposition) === stored(registry.counts?.byDisposition),
    'counts.byDisposition does not match the entries',
  );
  check(
    count((e) => e.owner) === stored(registry.counts?.byOwner),
    'counts.byOwner does not match the entries',
  );
  check(
    count((e) => e.requirement) === stored(registry.counts?.byRequirement),
    'counts.byRequirement does not match the entries',
  );
  for (const p of profiles.profiles) {
    check(
      registry.counts?.requiredByProfile?.[p.id] ===
        entries.filter((e) => e.requiredIn.includes(p.id)).length,
      `counts.requiredByProfile.${p.id} does not match the entries`,
    );
  }
  // Decision kind and closing lot follow from the decision identity.
  for (const decision of decisions.decisions) {
    const kind = decision.id.startsWith('D-SF-')
      ? 'source-format'
      : 'browser-profile';
    check(
      decision.kind === kind,
      `${decision.id}: kind must be ${kind} from its identifier`,
    );
    check(
      decision.closingLot === CLOSING_LOT(decision.id),
      `${decision.id}: must close in ${CLOSING_LOT(decision.id)}`,
    );
  }

  // Input digests: the fixed key set, exact paths and matching digests.
  const recordedInputs = registry.inputs ?? {};
  check(
    JSON.stringify(Object.keys(recordedInputs).sort()) ===
      JSON.stringify([...Object.keys(INPUT_PATHS), ...RAW_INPUTS].sort()),
    'registry inputs must be exactly the fixed repository and raw input keys',
  );
  for (const [key, file] of Object.entries(INPUT_PATHS)) {
    const ref = recordedInputs[key];
    check(
      ref?.path === file,
      `registry input ${key} must cite ${file}, not ${ref?.path}`,
    );
    check(
      /^sha256:[0-9a-f]{64}$/.test(ref?.sha256 ?? '') &&
        digest(file) === ref.sha256,
      `registry input ${key} (${file}) digest is missing or stale`,
    );
  }
  check(
    recordedInputs.bcdData?.sha256 ===
      docs.evidenceLock.sourcePins.bcd.publishedDataDigest,
    'registry bcdData digest differs from the evidence lock',
  );

  // Upstream observation: comparator retained, deltas explicit, digests matched.
  for (const pkg of docs.evidenceLock.packages) {
    const observed = observations.registry.find(
      (r) => r.package === pkg.package,
    );
    check(observed, `${pkg.package}: no refreshed registry observation`);
    if (!observed) continue;
    check(
      observed.pinnedVersion === pkg.version,
      `${pkg.package}: comparator version replaced`,
    );
    check(
      observed.integrityMatchesEvidenceLock === true,
      `${pkg.package}: registry integrity differs from the lock`,
    );
    const tarball = observations.tarballs.find(
      (t) => t.package === pkg.package,
    );
    check(
      tarball?.matchesEvidenceLock === true,
      `${pkg.package}: downloaded tarball integrity differs from the lock`,
    );
  }
  check(
    observations.registry.some(
      (r) =>
        r.package === '@pandacss/core' &&
        r.role === 'obsolete-v1-internal-not-the-comparator',
    ),
    'obsolete Panda core must be recorded as non-comparator',
  );
  check(
    observations.sourceDigestChecks.every((c) => c.match),
    'an upstream source digest differs from the lock',
  );
  check(
    observations.baselineDigestChecks.every((c) => c.match),
    'a PandamStyle baseline digest differs from the lock',
  );
  const inputs = registry.inputs ?? {};
  check(
    inputs.stylexEmissionProbe?.sha256 ===
      observations.emissionProbes.stylex.digest &&
      inputs.pandaEmissionProbe?.sha256 ===
        observations.emissionProbes.panda.digest &&
      inputs.upstreamKeyExtraction?.sha256 === observations.extraction.digest,
    'raw probe/extraction digests differ between registry and observation',
  );

  // No support percentage anywhere in the contract.
  const noScores = (value, where) => {
    if (Array.isArray(value))
      value.forEach((v, i) => noScores(v, `${where}[${i}]`));
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        check(
          !/percent|score|^ratio$|[a-z]Ratio$|coverageRate|supportRate/i.test(
            key,
          ),
          `${where}.${key}: support percentages and scores are not allowed`,
        );
        noScores(item, `${where}.${key}`);
      }
    }
  };
  for (const name of Object.keys(DOCS)) noScores(docs[name], name);

  return { failures, checks };
}

// Totals that make an authored weakening visible in review output.
function summary(registry) {
  const entries = registry.entries;
  const classes = (list) => {
    const out = {};
    for (const c of list.flat()) out[c] = (out[c] ?? 0) + 1;
    return Object.entries(out)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  };
  return [
    `required entries by profile: ${Object.entries(
      registry.counts.requiredByProfile,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    `requirements: ${Object.entries(registry.counts.byRequirement)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
    `entry proof classes: ${classes(entries.map((e) => e.proof.evidenceClasses))}`,
    `capability proof classes: ${classes(registry.capabilities.map((c) => c.proofRecord.evidenceClasses))}`,
    `capabilities required by profile: ${registry.capabilities.reduce((n, c) => n + c.requiredByProfiles.length, 0)} profile links`,
  ];
}

// ---------------------------------------------------------------------------
// Self-test: each mutation is drift that validation must reject.

function recount(registry, field, key) {
  const out = {};
  for (const e of registry.entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
  registry.counts[field] = Object.fromEntries(Object.entries(out).sort());
}
const entry = (registry, name) => registry.entries.find((e) => e.name === name);
// Re-derives the registry after an authored mutation, keeping the recorded
// input digests, so the mutation is internally consistent like a careful edit.
function rederive(d) {
  const facts = d.registry.entries.map((e) => ({
    name: e.name,
    ...Object.fromEntries(
      FACT_FIELDS.map((f) => [f, f === 'bcdRelations' ? (e[f] ?? []) : e[f]]),
    ),
  }));
  const derived = deriveRegistry({
    inventory: d.inventory,
    rules: d.rules,
    profiles: d.profiles,
    capSpec: d.capabilities,
    decisions: d.decisions,
    coverageText: d.coverageText,
    facts,
  });
  if (derived.registry) {
    // Round-trip through JSON so the record has exactly its committed shape.
    d.registry = { ...clone(derived.registry), inputs: d.registry.inputs };
  }
}
const MUTATIONS = [
  [
    'registry: drop an entry',
    /fewer than 1108 items/,
    (d) => d.registry.entries.pop(),
  ],
  [
    'registry: redirect alias start to the physical left',
    /entries\[start\]\.canonical/,
    (d) => {
      entry(d.registry, 'start').canonical = 'left';
    },
  ],
  [
    'registry: remove the aspect-ratio requirement and recount',
    /drifted/,
    (d) => {
      const e = entry(d.registry, 'aspect-ratio');
      e.requiredIn = [];
      e.requirement = 'disposition-only';
      recount(d.registry, 'byRequirement', (x) => x.requirement);
    },
  ],
  [
    'registry: assign aspect-ratio to CE-15 and recount',
    /drifted|outside the Work lots/,
    (d) => {
      entry(d.registry, 'aspect-ratio').owner = 'CE-15';
      recount(d.registry, 'byOwner', (x) => x.owner);
    },
  ],
  [
    'registry: replace CAP-01 proof classes with E1',
    /CAP-01/,
    (d) => {
      d.registry.capabilities[0].proofRecord.evidenceClasses = ['E1'];
    },
  ],
  [
    'registry: set the web required-entry count to 0',
    /requiredByProfile/,
    (d) => {
      d.registry.counts.requiredByProfile.web = 0;
    },
  ],
  [
    'registry: turn the grammar-divergent -webkit-ruby-position into an alias',
    /-webkit-ruby-position|drifted/,
    (d) => {
      const e = entry(d.registry, '-webkit-ruby-position');
      e.disposition = 'normalized-alias';
      delete e.subkind;
      e.canonical = 'ruby-position';
      e.aliasKind = 'bcd-prefix';
      delete e.aliasAudit;
      recount(d.registry, 'byDisposition', (x) => x.disposition);
    },
  ],
  [
    'rules: drop the alias audit of -webkit-scroll-snap-type',
    /-webkit-scroll-snap-type: BCD statements/,
    (d) => {
      delete d.rules.aliasAudit['-webkit-scroll-snap-type'];
    },
  ],
  [
    'rules: audit -webkit-mask as a behavior caveat only',
    /-webkit-mask: BCD notes describe syntax/,
    (d) => {
      d.rules.aliasAudit['-webkit-mask'].verdict = 'behavior-caveat-only';
    },
  ],
  [
    'rules: add a stale alias audit for width',
    /aliasAudit\.width|width: alias audit/,
    (d) => {
      d.rules.aliasAudit.width = {
        verdict: 'behavior-caveat-only',
        reason: 'stale',
      };
    },
  ],
  [
    'rules: give the tables family an owner outside its capability lots',
    /owner CE-15 is not a Work lot/,
    (d) => {
      d.rules.families.find((f) => f.id === 'tables').owner = 'CE-15';
    },
  ],
  [
    'capabilities: drop E4 from the authored CAP-04 proof record only',
    /CAP-04/,
    (d) => {
      d.capabilities.capabilities[3].proofRecord.evidenceClasses = ['E2', 'E3'];
    },
  ],
  [
    'registry: delete the rules input path after an authored alias change',
    /inputs\.rules: missing path|input rules must cite/,
    (d) => {
      d.rules.aliases.start.canonical = 'left';
      rederive(d);
      delete d.registry.inputs.rules.path;
    },
  ],
  [
    'registry: redirect the rules input to the profiles file and digest',
    /input rules must cite/,
    (d) => {
      d.registry.inputs.rules = { ...d.registry.inputs.profiles };
    },
  ],
  [
    'registry: drop the decisions input entirely',
    /missing decisions|exactly the fixed/,
    (d) => {
      delete d.registry.inputs.decisions;
    },
  ],
  [
    'authored+generated: give CAP-01 the proof identity of CAP-02',
    /CAP-01: proof id and planned path/,
    (d) => {
      const proof = d.capabilities.capabilities[0].proofRecord;
      proof.id = 'CE-PROOF-CAP-02';
      proof.plannedPath = 'tests/core-evolution/proofs/CAP-02.json';
      proof.fixtureSets = ['CE-FX-CAP-02-unrelated'];
      rederive(d);
    },
  ],
  [
    'authored+generated: reduce the CAP-04 proof record to E1',
    /CAP-04: a proof record needs an evidence class beyond/,
    (d) => {
      d.capabilities.capabilities[3].proofRecord.evidenceClasses = ['E1'];
      rederive(d);
    },
  ],
  [
    'authored+generated: relabel D-BP-01 as a source-format decision closing in CE-13',
    /D-BP-01: kind must be browser-profile/,
    (d) => {
      const decision = d.decisions.decisions.find((x) => x.id === 'D-BP-01');
      decision.kind = 'source-format';
      decision.closingLot = 'CE-13';
      rederive(d);
    },
  ],
  [
    'authored+generated: curate the vendor-prefixed -webkit-border-radius as an alias',
    /vendor-prefixed names cannot be curated aliases/,
    (d) => {
      delete d.rules.aliasAudit['-webkit-border-radius'];
      d.rules.aliases['-webkit-border-radius'] = {
        canonical: 'border-radius',
        aliasKind: 'legacy-name',
        equivalence: 'claimed',
        sources: [{ kind: 'bcd', ref: 'claimed' }],
      };
      rederive(d);
    },
  ],
  [
    'authored+generated: drop the sources of the grid-gap equivalence',
    /grid-gap/,
    (d) => {
      d.rules.aliases['grid-gap'].sources = [];
      rederive(d);
    },
  ],
  [
    'authored+generated: drop the equivalent verdict of word-wrap',
    /word-wrap: an unprefixed BCD alternative name needs/,
    (d) => {
      delete d.rules.aliasAudit['word-wrap'];
      rederive(d);
    },
  ],
  [
    'registry: relabel the vendor variant -webkit-transform as an alias',
    /-webkit-transform: a vendor-prefixed name cannot be a normalized alias/,
    (d) => {
      const e = entry(d.registry, '-webkit-transform');
      e.disposition = 'normalized-alias';
      delete e.subkind;
      e.canonical = 'transform';
      e.aliasKind = 'bcd-prefix';
      recount(d.registry, 'byDisposition', (x) => x.disposition);
    },
  ],
  [
    'facts: drop the Panda type key of accent-color',
    /sourceFlagMismatches/,
    (d) => {
      delete entry(d.registry, 'accent-color').sources.pandaType;
    },
  ],
];

function selfTest() {
  const base = loadDocs();
  const results = [];
  const baseline = validateDocs(clone(base));
  results.push({
    case: 'baseline (unmutated)',
    expected: 'pass',
    passed: baseline.failures.length === 0,
    detail: baseline.failures[0] ?? `${baseline.checks} checks`,
  });
  for (const [name, expected, mutate] of MUTATIONS) {
    const docs = clone(base);
    mutate(docs);
    const outcome = validateDocs(docs);
    // A mutation must fail for its intended reason, not an incidental one.
    const hit = outcome.failures.find((f) => expected.test(f));
    results.push({
      case: name,
      expected: `fail matching ${expected}`,
      passed: Boolean(hit),
      detail: hit ?? outcome.failures[0] ?? 'validation passed',
    });
  }
  for (const r of results) {
    process.stdout.write(
      `${r.passed ? 'ok  ' : 'FAIL'} ${r.case} (expected ${r.expected}): ${r.detail}\n`,
    );
  }
  const bad = results.filter((r) => !r.passed);
  process.stdout.write(
    `core-evolution self-test ${bad.length ? 'FAILED' : 'passed'}: ${results.length - bad.length}/${results.length} cases\n`,
  );
  return bad.length === 0;
}

const { failures, checks } = validateDocs(loadDocs());
if (failures.length) {
  process.stderr.write(
    `core-evolution validation FAILED (${failures.length} of ${checks} checks)\n${failures.map((f) => `- ${f}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `core-evolution validation passed: ${checks} checks, registry re-derived and identical\n${summary(
      loadDocs().registry,
    )
      .map((line) => `  ${line}\n`)
      .join('')}`,
  );
}
if (process.argv.includes('--self-test') && !selfTest()) process.exitCode = 1;
