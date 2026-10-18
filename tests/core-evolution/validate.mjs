/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Validates the CE-00.1 registry, profiles, capability dispositions, scope
// decisions and upstream observation against their JSON Schemas, then checks
// the cross-record invariants of the scope contract. It has no dependencies
// and reads committed files only:
//
//   node tests/core-evolution/validate.mjs
//
// It exits non-zero with every failure listed. A pass proves record shape and
// consistency, not that any capability works.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const read = (p) => fs.readFileSync(path.join(repo, p));
const json = (p) => JSON.parse(read(p).toString('utf8'));
const digest = (p) =>
  `sha256:${crypto.createHash('sha256').update(read(p)).digest('hex')}`;
const failures = [];
const fail = (message) => failures.push(message);
let checks = 0;
const check = (condition, message) => {
  checks += 1;
  if (!condition) fail(message);
};

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
for (const [file, sha] of Object.entries(FROZEN)) {
  check(
    digest(file) === `sha256:${sha}`,
    `${file} changed; reviewed/pinned bytes must stay identical`,
  );
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema (2020-12 subset) validator for the shipped schemas.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}
function validate(schema, value, where, out) {
  checks += 1;
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
        validate(schema.items, item, `${where}[${i}]`, out),
      );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? [])
      if (!(key in value)) out.push(`${where}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        validate(schema.properties[key], item, `${where}.${key}`, out);
      } else if (schema.additionalProperties === false) {
        out.push(`${where}: unexpected property ${key}`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
      ) {
        validate(schema.additionalProperties, item, `${where}.${key}`, out);
      }
    }
  }
}

const DOCS = {
  registry: [
    'docs/research/core-evolution-registry.v1.json',
    'core-evolution-registry.v1.schema.json',
  ],
  observations: [
    'docs/research/core-evolution-upstream-observations.v1.json',
    'core-evolution-upstream-observations.v1.schema.json',
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
const doc = {};
for (const [name, [file, schemaFile]] of Object.entries(DOCS)) {
  doc[name] = json(file);
  const out = [];
  validate(
    json(`tests/core-evolution/schema/${schemaFile}`),
    doc[name],
    name,
    out,
  );
  out.slice(0, 20).forEach(fail);
  if (out.length > 20)
    fail(`${name}: ${out.length - 20} further schema failures`);
}
const { registry, observations, profiles, capabilities, decisions } = doc;
const inventory = json('docs/research/core-evolution-inventory.json');

// ---------------------------------------------------------------------------
// Registry against the pinned inventory: same names, same denominator.

const entries = registry.entries;
const byName = new Map(entries.map((e) => [e.name, e]));
check(byName.size === entries.length, 'registry entry names are not unique');
check(
  entries.length === inventory.properties.length,
  'registry and inventory sizes differ',
);
check(
  inventory.counts.propertyEntries === 1108 && entries.length === 1108,
  'denominator is not 1,108 entries',
);
const COLUMNS = inventory.columns;
for (const raw of inventory.properties) {
  const row = Object.fromEntries(COLUMNS.map((c, i) => [c, raw[i]]));
  const e = byName.get(row.name);
  if (!e) {
    fail(`inventory entry ${row.name} has no registry disposition`);
    continue;
  }
  check(
    Boolean(e.sources.stylexType) === row.stylexTypeOccurrence,
    `${row.name}: StyleX source flag differs`,
  );
  check(
    Boolean(e.sources.pandaType) === row.pandaTypeOccurrence,
    `${row.name}: Panda type source flag differs`,
  );
  check(
    Boolean(e.sources.pandaUtility) === row.pandaBaseUtilityOccurrence,
    `${row.name}: Panda utility source flag differs`,
  );
  check(
    (e.bcd?.status ?? null) === row.bcdStatus,
    `${row.name}: BCD status differs`,
  );
  const alpha1 =
    e.alpha1.kind === 'rejected-composite-form' ? 'unsupported' : e.alpha1.kind;
  check(
    alpha1 === row.alpha1DomainKind,
    `${row.name}: Alpha 1 domain kind differs`,
  );
  check(
    (e.alpha1.category ?? null) === row.alpha1TokenCategory,
    `${row.name}: Alpha 1 token category differs`,
  );
}
const sourceCounts = {
  propertyEntries: entries.length,
  stylexTypeNames: entries.filter((e) => e.sources.stylexType).length,
  pandaTypeNames: entries.filter((e) => e.sources.pandaType).length,
  pandaBaseUtilityKeys: entries.filter((e) => e.sources.pandaUtility).length,
  bcdPropertyKeys: entries.filter((e) => e.sources.bcd).length,
  alpha1AdmittedPropertyNames: entries.filter(
    (e) => !['unsupported', 'rejected-composite-form'].includes(e.alpha1.kind),
  ).length,
};
for (const [key, value] of Object.entries(inventory.counts)) {
  check(
    sourceCounts[key] === value,
    `count ${key}: registry ${sourceCounts[key]}, inventory ${value}`,
  );
}

// Recorded counts must be recomputable from the entries.
const tally = (key) => {
  const out = {};
  for (const e of entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
  return out;
};
const same = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());
check(
  same(
    tally((e) => e.disposition),
    registry.counts.byDisposition,
  ),
  'counts.byDisposition is stale',
);
check(
  same(
    tally((e) => e.owner),
    registry.counts.byOwner,
  ),
  'counts.byOwner is stale',
);
check(
  same(
    tally((e) => e.capability),
    registry.counts.byCapability,
  ),
  'counts.byCapability is stale',
);
check(
  same(
    tally((e) => e.requirement),
    registry.counts.byRequirement,
  ),
  'counts.byRequirement is stale',
);
check(
  Object.values(registry.counts.byDisposition).reduce((a, b) => a + b, 0) ===
    1108,
  'dispositions do not sum to 1,108',
);

// Input digests recorded by the builder must match the committed files.
for (const [key, ref] of Object.entries(registry.inputs)) {
  if (ref.path)
    check(
      digest(ref.path) === ref.sha256,
      `registry input ${key} (${ref.path}) changed since the registry was built`,
    );
}

// ---------------------------------------------------------------------------
// Entry invariants.

const profileIds = profiles.profiles.map((p) => p.id);
check(
  JSON.stringify(profileIds) ===
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
const capIds = registry.capabilities.map((c) => c.id);
const expectedCaps = Array.from(
  { length: 48 },
  (_, i) => `CAP-${String(i + 1).padStart(2, '0')}`,
);
check(
  JSON.stringify(capIds) === JSON.stringify(expectedCaps),
  'registry capabilities must be CAP-01..CAP-48 in order',
);
const capSet = new Set(capIds);
const decisionIds = new Set(decisions.decisions.map((d) => d.id));
check(
  decisionIds.size === decisions.decisions.length,
  'decision ids are not unique',
);
const limitationIds = new Set(registry.limitations.map((l) => l.id));
const fixtureIds = new Set();
for (const e of entries) {
  check(
    capSet.has(e.capability),
    `${e.name}: unknown capability ${e.capability}`,
  );
  check(
    registry.lotIssues[e.owner]?.length > 0,
    `${e.name}: owner ${e.owner} has no issues`,
  );
  check(
    !fixtureIds.has(e.proof.fixtureId),
    `${e.name}: duplicate fixture id ${e.proof.fixtureId}`,
  );
  fixtureIds.add(e.proof.fixtureId);
  check(
    (e.subkind != null) === (e.disposition === 'deprecated-or-experimental'),
    `${e.name}: subkind must exist exactly for deprecated-or-experimental`,
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
      e.requiredIn.length === 0,
      `${e.name}: an alias cannot carry a requirement`,
    );
  }
  if (
    [
      'deprecated-or-experimental',
      'non-css-syntax',
      'incompatible-runtime-requirement',
      'normalized-alias',
    ].includes(e.disposition)
  ) {
    check(
      e.requiredIn.length === 0,
      `${e.name}: ${e.disposition} cannot be required`,
    );
  }
  if (e.disposition === 'incompatible-runtime-requirement')
    check(
      limitationIds.has(e.limitation),
      `${e.name}: incompatible entry needs a limitation`,
    );
  if (e.subkind === 'obsolete-engine-prefix')
    check(
      e.limitation === 'LIM-05',
      `${e.name}: obsolete engine entry must cite LIM-05`,
    );
  if (e.limitation)
    check(
      limitationIds.has(e.limitation),
      `${e.name}: unknown limitation ${e.limitation}`,
    );
  if (e.carriedBy)
    check(
      capSet.has(e.carriedBy),
      `${e.name}: unknown carrying capability ${e.carriedBy}`,
    );
  if (e.requiredIn.length) {
    check(
      ['required-gap', 'required-requalification-and-expansion'].includes(
        e.requirement,
      ),
      `${e.name}: required entry has requirement ${e.requirement}`,
    );
    check(
      ['E2', 'E3', 'E4'].every((c) => e.proof.evidenceClasses.includes(c)),
      `${e.name}: required entry needs E2, E3 and E4 proof`,
    );
    const isAlpha1 = !['unsupported', 'rejected-composite-form'].includes(
      e.alpha1.kind,
    );
    check(
      (e.requirement === 'required-gap') === !isAlpha1,
      `${e.name}: required gap status disagrees with Alpha 1 support`,
    );
  } else {
    check(
      !e.requirement.startsWith('required'),
      `${e.name}: not required but marked ${e.requirement}`,
    );
  }
  if (e.targetDecision)
    check(
      decisionIds.has(e.targetDecision.decision),
      `${e.name}: unknown target decision ${e.targetDecision.decision}`,
    );
}
// Alpha 1 admitted names stay in the denominator and remain required work.
for (const e of entries.filter(
  (x) => !['unsupported', 'rejected-composite-form'].includes(x.alpha1.kind),
)) {
  check(
    e.disposition === 'canonical-property' && e.requiredIn.length > 0,
    `${e.name}: Alpha 1 admitted property must stay a required canonical property`,
  );
}

// ---------------------------------------------------------------------------
// Capability families, profiles, limitations and decisions.

const specById = new Map(capabilities.capabilities.map((c) => [c.id, c]));
const requiredSomewhere = new Set(
  profiles.profiles.flatMap((p) => p.requiredCapabilities),
);
for (const cap of registry.capabilities) {
  const spec = specById.get(cap.id);
  check(
    spec &&
      spec.disposition === cap.disposition &&
      spec.primaryOwner === cap.primaryOwner,
    `${cap.id}: registry differs from authored disposition`,
  );
  check(
    cap.lots.includes(cap.primaryOwner) && cap.lots.includes(cap.closingLot),
    `${cap.id}: owners are outside its coverage Work lots`,
  );
  check(
    cap.proofRecord.id === `CE-PROOF-${cap.id}` &&
      cap.proofRecord.plannedPath ===
        `tests/core-evolution/proofs/${cap.id}.json`,
    `${cap.id}: proof record identity`,
  );
  check(
    cap.proofRecord.fixtureSets.every((f) => f.startsWith(`CE-FX-${cap.id}-`)),
    `${cap.id}: fixture sets must be scoped to the capability`,
  );
  check(requiredSomewhere.has(cap.id), `${cap.id}: no profile requires it`);
  const expectedProfiles = profiles.profiles
    .filter((p) => p.requiredCapabilities.includes(cap.id))
    .map((p) => p.id);
  check(
    JSON.stringify(expectedProfiles) === JSON.stringify(cap.requiredByProfiles),
    `${cap.id}: requiredByProfiles is stale`,
  );
  const expectedIssues = [
    ...new Set(cap.lots.flatMap((lot) => registry.lotIssues[lot])),
  ].sort((a, b) => a - b);
  check(
    JSON.stringify(expectedIssues) === JSON.stringify(cap.issues),
    `${cap.id}: issues do not match its lots`,
  );
  for (const lim of cap.limitations)
    check(limitationIds.has(lim), `${cap.id}: unknown limitation ${lim}`);
}
check(
  requiredSomewhere.size === 48,
  'the profiles together must require all 48 capability families',
);
for (const lim of registry.limitations) {
  check(
    registry.capabilities.some((c) => c.limitations.includes(lim.id)) ||
      entries.some((e) => e.limitation === lim.id),
    `${lim.id} is referenced by nothing`,
  );
}
const requests = registry.requestCases;
check(
  requests.length === 16,
  'the original Alpha 2 request has 16 traceability rows',
);
for (const req of requests) {
  for (const cap of req.capabilities)
    check(
      registry.capabilities
        .find((c) => c.id === cap)
        ?.requestCases.includes(req.id),
      `${req.id}: not traced from ${cap}`,
    );
}
for (const profile of profiles.profiles) {
  for (const d of [
    profile.browserTargetDecision,
    ...profile.additionalBrowserDecisions,
    ...profile.sourceFormatDecisions,
  ]) {
    if (d !== 'inherits-application-profile')
      check(decisionIds.has(d), `${profile.id}: unknown decision ${d}`);
  }
}
for (const decision of decisions.decisions) {
  const expectedKind = decision.id.startsWith('D-SF-')
    ? 'source-format'
    : 'browser-profile';
  check(
    decision.kind === expectedKind,
    `${decision.id}: kind ${decision.kind}`,
  );
  check(
    ['CE-01', 'CE-13'].includes(decision.closingLot),
    `${decision.id}: must close in CE-01 or CE-13`,
  );
  if (decision.kind === 'source-format')
    check(
      decision.closingLot === 'CE-13',
      `${decision.id}: source formats close in CE-13`,
    );
}
check(
  decisions.decisions.some((d) => d.kind === 'source-format') &&
    decisions.decisions.some((d) => d.kind === 'browser-profile'),
  'both decision kinds are required',
);

// ---------------------------------------------------------------------------
// Upstream observation: comparator retained, deltas explicit, digests matched.

const lock = json('docs/research/core-evolution-evidence.json');
for (const pkg of lock.packages) {
  const observed = observations.registry.find((r) => r.package === pkg.package);
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
  check(
    observed.delta === 'latest-equals-pinned' ||
      observed.delta === 'newer-latest-requires-delta-review',
    `${pkg.package}: unexpected delta ${observed.delta}`,
  );
  const tarball = observations.tarballs.find((t) => t.package === pkg.package);
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
check(
  registry.inputs.observations.sha256 ===
    digest('docs/research/core-evolution-upstream-observations.v1.json'),
  'registry was built from a different observation',
);
check(
  registry.inputs.stylexEmissionProbe.sha256 ===
    observations.emissionProbes.stylex.digest,
  'StyleX probe digest differs between registry and observation',
);
check(
  registry.inputs.pandaEmissionProbe.sha256 ===
    observations.emissionProbes.panda.digest,
  'Panda probe digest differs between registry and observation',
);
check(
  registry.inputs.upstreamKeyExtraction.sha256 ===
    observations.extraction.digest,
  'extraction digest differs between registry and observation',
);

// ---------------------------------------------------------------------------
// No support percentage anywhere in the contract.

function noScores(value, where) {
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
}
for (const [name, value] of Object.entries(doc)) noScores(value, name);

if (failures.length) {
  process.stderr.write(
    `core-evolution validation FAILED (${failures.length} of ${checks} checks)\n${failures.map((f) => `- ${f}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `core-evolution validation passed: ${checks} checks; ${entries.length} entries, ${registry.capabilities.length} capabilities, ${profileIds.length} profiles, ${decisions.decisions.length} decisions\n`,
);
