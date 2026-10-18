/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Pure derivation of the CE-00.1 registry from the authored inputs and the
// recorded per-entry upstream facts. The builder calls it after collecting
// facts from upstream data; the validator calls it again on the committed
// facts and requires the committed registry to be identical. It has no
// dependencies and performs no I/O.

// Fact fields are recorded observations; every other entry field is derived.
export const FACT_FIELDS = [
  'sources',
  'bcd',
  'bcdRelations',
  'alpha1',
  'upstream',
];

const VENDOR = /^-(webkit|moz|ms|o|khtml)-/;
const OBSOLETE_ENGINE = /^-(ms|o|khtml)-/;
const MAJOR = ['chrome', 'firefox', 'safari'];
const NONCANONICAL_OWNERS = new Set(['CE-01', 'CE-02', 'CE-11']);
const REQUIRED_DISPOSITIONS = new Set([
  'canonical-property',
  'scoped-platform-extension',
  'system-resource',
]);
// BCD notes with this vocabulary describe accepted syntax or values. An alias
// whose relating statements carry such a note cannot be audited as a mere
// behavior caveat without an explicit reviewed reason.
export const GRAMMAR_HINT =
  /syntax|draft|value|synonym|unitless|keyword|version of the specification|older/i;

function tally(list, key) {
  const out = {};
  for (const item of list) {
    for (const value of [key(item)].flat()) out[value] = (out[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function parseCoverage(text) {
  const caps = new Map();
  for (const line of text.split('\n')) {
    const m = /^\| (CAP-\d\d) \| (.+?) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(
      line,
    );
    if (m) {
      const lots = m[5]
        .replace(/^CE-/, '')
        .split('/')
        .map((n) => `CE-${n}`);
      caps.set(m[1], {
        capability: m[2],
        alpha1Status: m[3],
        requiredOutcome: m[4],
        work: m[5],
        lots,
      });
    }
  }
  const section = text
    .split('## Initial request traceability')[1]
    .split('## Required proof record')[0];
  const requests = [];
  for (const line of section.split('\n')) {
    const m = /^\| (.+?) \| (.+?) \|$/.exec(line);
    if (m && m[1] !== 'Request' && !m[1].startsWith('---'))
      requests.push({ request: m[1], acceptance: m[2] });
  }
  return { caps, requests };
}

export function deriveRegistry({
  inventory,
  rules,
  profiles,
  capSpec,
  coverageText,
  decisions,
  facts,
}) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const rows = inventory.properties.map((row) =>
    Object.fromEntries(inventory.columns.map((column, i) => [column, row[i]])),
  );
  const names = new Set(rows.map((row) => row.name));
  if (names.size !== rows.length) fail('inventory names are not unique');
  const factsByName = new Map(facts.map((f) => [f.name, f]));
  if (factsByName.size !== facts.length) fail('facts names are not unique');
  for (const name of factsByName.keys())
    if (!names.has(name)) fail(`facts for unknown inventory name ${name}`);
  for (const name of names)
    if (!factsByName.has(name)) fail(`no recorded facts for ${name}`);
  if (errors.length) return { errors, registry: null };
  const fact = (name) => factsByName.get(name);

  // -------------------------------------------------------------------------
  // Classification.

  const curatedGroups = [
    ['incompatibleRuntime', 'incompatible-runtime-requirement', null],
    ['systemResources', 'system-resource', null],
    ['nonCssSyntax', 'non-css-syntax', null],
    ['platformExtensions', 'scoped-platform-extension', null],
    ['aliases', 'normalized-alias', null],
    ['deprecated', 'deprecated-or-experimental', 'deprecated'],
    ['abandonedDraft', 'deprecated-or-experimental', 'abandoned-draft'],
    [
      'unimplementedSpecification',
      'deprecated-or-experimental',
      'unimplemented-specification',
    ],
    ['experimental', 'deprecated-or-experimental', 'experimental'],
    ['nonstandard', 'deprecated-or-experimental', 'nonstandard'],
  ];
  const curated = new Map();
  for (const [group, disposition, subkind] of curatedGroups) {
    for (const [name, record] of Object.entries(rules[group])) {
      if (!names.has(name))
        fail(`curated ${group} entry ${name} is not an inventory name`);
      if (curated.has(name)) fail(`${name} is curated twice`);
      curated.set(name, { group, disposition, subkind, record });
    }
  }
  for (const name of Object.keys(rules.notes)) {
    if (!names.has(name)) fail(`note for unknown inventory name ${name}`);
  }
  const usedAudits = new Set();
  for (const [name, audit] of Object.entries(rules.aliasAudit)) {
    if (!names.has(name))
      fail(`alias audit for unknown inventory name ${name}`);
    if (!['grammar-divergent', 'behavior-caveat-only'].includes(audit.verdict))
      fail(`${name}: unknown alias audit verdict ${audit.verdict}`);
  }

  const memo = new Map();
  function classify(name, stack = []) {
    if (memo.has(name)) return memo.get(name);
    if (stack.includes(name))
      throw new Error(`alias cycle ${[...stack, name].join(' -> ')}`);
    const result = classifyUncached(name, [...stack, name]);
    memo.set(name, result);
    return result;
  }

  // An automatic alias rests on BCD statements relating `name` to `target`.
  // Statements with notes, partial implementation or flags must be audited:
  // grammar or value differences make the name a divergent legacy variant,
  // not another spelling of the canonical property.
  function automaticAlias(name, target, via, relation) {
    const audit = rules.aliasAudit[name];
    const caveats = relation?.caveats ?? [];
    if (caveats.length && !audit) {
      fail(
        `${name}: BCD statements relating it to ${target} carry caveats; add an aliasAudit verdict`,
      );
    }
    if (!audit) {
      return {
        disposition: 'normalized-alias',
        canonical: target,
        aliasKind: via,
        familyKey: target,
        prefixedFormShips: relation?.shipping,
      };
    }
    usedAudits.add(name);
    if (!caveats.length) fail(`${name}: alias audit without BCD caveats`);
    if (audit.verdict === 'grammar-divergent') {
      return {
        disposition: 'deprecated-or-experimental',
        subkind: 'divergent-legacy-variant',
        variantOf: target,
        replacement: target,
        familyKey: target,
        aliasAudit: { verdict: audit.verdict, reason: audit.reason },
        prefixedFormShips: relation.shipping,
        emissionDecision: relation.shipping ? 'D-BP-07' : undefined,
      };
    }
    const hinted = caveats.some((c) =>
      c.notes.some((n) => GRAMMAR_HINT.test(n)),
    );
    if (hinted && !audit.grammarHintReviewed) {
      fail(
        `${name}: BCD notes describe syntax or values; a behavior-caveat-only verdict needs grammarHintReviewed`,
      );
    }
    return {
      disposition: 'normalized-alias',
      canonical: target,
      aliasKind: via,
      familyKey: target,
      aliasAudit: { verdict: audit.verdict, reason: audit.reason },
      prefixedFormShips: relation.shipping,
    };
  }

  function inherit(name, target, via, relation, stack) {
    const base = classify(target, stack);
    if (
      base.disposition === 'canonical-property' ||
      base.disposition === 'scoped-platform-extension'
    ) {
      return automaticAlias(name, target, via, relation);
    }
    if (base.disposition === 'deprecated-or-experimental') {
      return {
        disposition: 'deprecated-or-experimental',
        subkind: base.subkind,
        replacement: base.replacement ?? null,
        variantOf: target,
        basis: via,
        familyKey: base.familyKey ?? target,
      };
    }
    return null;
  }

  function classifyUncached(name, stack) {
    const c = curated.get(name);
    if (c) {
      const r = c.record;
      return {
        disposition: c.disposition,
        subkind: c.subkind ?? undefined,
        basis: `curated:${c.group}`,
        canonical:
          r.canonical && c.disposition === 'normalized-alias'
            ? r.canonical
            : undefined,
        aliasKind: r.aliasKind,
        replacement: r.replacement,
        reason: r.reason ?? r.note ?? r.evidence,
        familyKey: r.family
          ? null
          : r.canonical && c.disposition === 'normalized-alias'
            ? r.canonical
            : (r.replacement ?? name),
        family: r.family,
        curated: r,
      };
    }
    const f = fact(name);
    const status = f.bcd?.status ?? null;
    const relations = f.bcdRelations ?? [];
    if (OBSOLETE_ENGINE.test(name)) {
      const base = name.replace(VENDOR, '');
      const equivalent =
        relations[0]?.target ?? (names.has(base) ? base : null);
      return {
        disposition: 'deprecated-or-experimental',
        subkind: 'obsolete-engine-prefix',
        basis: relations.length
          ? relations.map((a) => a.via).join('+')
          : 'name-prefix',
        replacement: equivalent,
        equivalents:
          relations.length > 1 ? relations.map((a) => a.target) : undefined,
        limitation: 'LIM-05',
        familyKey: equivalent ?? name,
      };
    }
    if (status === 'standard') {
      return {
        disposition: 'canonical-property',
        basis: 'bcd-standard-track',
        familyKey: name,
      };
    }
    if (status) {
      return {
        disposition: 'deprecated-or-experimental',
        subkind: status,
        basis: `bcd-${status}`,
        replacement: relations[0]?.target ?? null,
        familyKey: VENDOR.test(name) ? name.replace(VENDOR, '') : name,
      };
    }
    if (relations.length) {
      const inherited = inherit(
        name,
        relations[0].target,
        relations[0].via,
        relations[0],
        stack,
      );
      if (inherited) return { ...inherited, basis: relations[0].via };
    }
    if (VENDOR.test(name)) {
      const base = name.replace(VENDOR, '');
      if (names.has(base)) {
        const inherited = inherit(
          name,
          base,
          'vendor-prefix-name-derivation',
          null,
          stack,
        );
        if (inherited)
          return { ...inherited, basis: 'vendor-prefix-name-derivation' };
      }
      return {
        disposition: 'deprecated-or-experimental',
        subkind: 'nonstandard',
        basis: 'vendor-only-without-bcd-record',
        familyKey: base,
      };
    }
    fail(`unclassified inventory entry ${name}`);
    return null;
  }

  const familyMatchers = rules.families.map((family) => ({
    ...family,
    regexes: (family.patterns ?? []).map((p) => new RegExp(p)),
  }));
  const familyById = new Map(familyMatchers.map((f) => [f.id, f]));
  function familyFor(result) {
    if (result.family) {
      if (!familyById.has(result.family))
        fail(`unknown family ${result.family}`);
      return familyById.get(result.family);
    }
    const key = result.familyKey;
    return familyMatchers.find(
      (f) =>
        (f.names ?? []).includes(key) || f.regexes.some((r) => r.test(key)),
    );
  }

  const coverage = parseCoverage(coverageText);
  if (coverage.caps.size !== 48)
    fail(
      `coverage matrix has ${coverage.caps.size} capability rows, expected 48`,
    );
  const lotIssues = capSpec.lotIssues;
  const capById = new Map(capSpec.capabilities.map((c) => [c.id, c]));
  const profileIds = profiles.profiles.map((p) => p.id);
  const decisionIds = new Set(decisions.decisions.map((d) => d.id));
  const applicationProfiles = new Set(
    profiles.profiles.filter((p) => p.kind === 'application').map((p) => p.id),
  );

  // -------------------------------------------------------------------------
  // Entries.

  const entries = [];
  const reconciliation = {
    sourceFlagMismatches: [],
    bcdStatusMismatches: [],
    alpha1Mismatches: [],
  };
  for (const row of rows) {
    const name = row.name;
    const f = fact(name);
    const result = classify(name);
    if (!result) continue;
    const family = familyFor(result);
    if (!family) {
      fail(`no family matches ${name} (key ${result.familyKey})`);
      continue;
    }
    const record = result.curated ?? {};
    const capability = record.requirementCarrier ?? family.cap;
    let owner = record.owner;
    if (!owner && result.disposition === 'normalized-alias')
      owner = rules.aliasOwner;
    if (!owner && result.disposition === 'incompatible-runtime-requirement')
      owner = 'CE-02';
    if (!owner && result.subkind) owner = rules.ownerBySubkind[result.subkind];
    if (!owner) owner = family.owner;
    const capRow = coverage.caps.get(capability);
    if (!capRow) {
      fail(`${name}: unknown capability ${capability}`);
      continue;
    }
    const ownerAllowed =
      capRow.lots.includes(owner) ||
      capability === 'CAP-01' ||
      (result.disposition !== 'canonical-property' &&
        NONCANONICAL_OWNERS.has(owner));
    if (!ownerAllowed)
      fail(
        `${name}: owner ${owner} is not a Work lot of ${capability} (${capRow.work})`,
      );

    // The recorded facts must agree with the pinned inventory row.
    const flags = {
      stylexTypeOccurrence: Boolean(f.sources.stylexType),
      pandaTypeOccurrence: Boolean(f.sources.pandaType),
      pandaBaseUtilityOccurrence: Boolean(f.sources.pandaUtility),
    };
    for (const [column, actual] of Object.entries(flags)) {
      if (row[column] !== actual)
        reconciliation.sourceFlagMismatches.push({ name, column });
    }
    if (Boolean(f.sources.bcd) !== (f.bcd != null))
      reconciliation.bcdStatusMismatches.push({ name, field: 'sources.bcd' });
    if (row.bcdStatus !== (f.bcd?.status ?? null))
      reconciliation.bcdStatusMismatches.push({ name });
    const alpha1Kind =
      f.alpha1.kind === 'rejected-composite-form'
        ? 'unsupported'
        : f.alpha1.kind;
    if (
      row.alpha1DomainKind !== alpha1Kind ||
      (row.alpha1TokenCategory ?? null) !== (f.alpha1.category ?? null)
    ) {
      reconciliation.alpha1Mismatches.push({ name });
    }

    let requiredIn = [];
    if (REQUIRED_DISPOSITIONS.has(result.disposition)) {
      requiredIn = [
        ...(record.requiredIn ??
          (result.disposition === 'canonical-property'
            ? family.requiredIn
            : [])),
      ];
    }
    if (
      result.disposition === 'canonical-property' &&
      requiredIn.some((p) => applicationProfiles.has(p))
    ) {
      for (const [overlay, rule] of Object.entries(rules.overlayRequirements)) {
        const hit =
          rule.names.includes(name) ||
          rule.patterns.some((p) => new RegExp(p).test(name));
        if (hit && !requiredIn.includes(overlay)) requiredIn.push(overlay);
      }
    }
    requiredIn.sort((a, b) => profileIds.indexOf(a) - profileIds.indexOf(b));
    for (const id of requiredIn)
      if (!profileIds.includes(id)) fail(`${name}: unknown profile ${id}`);

    const engines = f.bcd?.engines ?? null;
    let targetDecision = null;
    if (requiredIn.length) {
      if (result.disposition === 'scoped-platform-extension') {
        targetDecision = {
          decision: 'D-BP-03',
          reason: 'platform-scoped extension; exact engine evidence required',
        };
      } else if (!engines) {
        targetDecision = {
          decision: 'D-BP-06',
          enginesWithoutUnprefixedRelease: MAJOR,
          reason: 'no BCD record',
        };
      } else {
        const missing = MAJOR.filter(
          (engine) => !/^\d[\d.]*( partial)?$/.test(String(engines[engine])),
        );
        const partial = MAJOR.filter((engine) =>
          / partial$/.test(String(engines[engine])),
        );
        if (missing.length || partial.length) {
          targetDecision = {
            decision: MAJOR.some((engine) =>
              / via /.test(String(engines[engine])),
            )
              ? 'D-BP-07'
              : 'D-BP-06',
            enginesWithoutUnprefixedRelease: missing,
            partialEngines: partial.length ? partial : undefined,
          };
        }
      }
    }
    if (targetDecision && !decisionIds.has(targetDecision.decision))
      fail(`${name}: unknown decision ${targetDecision.decision}`);

    let requirement;
    if (requiredIn.length) {
      requirement =
        alpha1Kind === 'unsupported'
          ? 'required-gap'
          : 'required-requalification-and-expansion';
    } else if (record.requirementCarrier) {
      requirement = 'carried-by-capability';
    } else {
      requirement = 'disposition-only';
    }

    let evidence;
    if (requiredIn.length) evidence = ['E2', 'E3', 'E4'];
    else if (
      result.disposition === 'normalized-alias' ||
      result.disposition === 'non-css-syntax' ||
      result.disposition === 'system-resource'
    )
      evidence = ['E2', 'E3'];
    else if (result.subkind === 'experimental') evidence = ['E1', 'E2'];
    // A divergent variant that still ships may be emitted by the CE-01
    // transformation; that emission must be proven on the shared value subset.
    else if (result.emissionDecision) evidence = ['E2', 'E3'];
    else evidence = ['E2'];

    const divergence = [];
    if (result.disposition === 'canonical-property') {
      if (f.upstream.stylex.emission !== 'passthrough')
        divergence.push(`stylex:${f.upstream.stylex.emission}`);
      if (f.upstream.panda.emission !== 'passthrough')
        divergence.push(`panda:${f.upstream.panda.emission}`);
    }

    entries.push({
      name,
      disposition: result.disposition,
      ...(result.subkind ? { subkind: result.subkind } : {}),
      basis: result.basis,
      ...(result.canonical
        ? { canonical: result.canonical, aliasKind: result.aliasKind }
        : {}),
      ...(result.replacement ? { replacement: result.replacement } : {}),
      ...(result.variantOf ? { variantOf: result.variantOf } : {}),
      ...(result.equivalents ? { equivalents: result.equivalents } : {}),
      ...(result.aliasAudit ? { aliasAudit: result.aliasAudit } : {}),
      ...(result.prefixedFormShips != null
        ? { prefixedFormShips: result.prefixedFormShips }
        : {}),
      ...(result.emissionDecision
        ? { emissionDecision: result.emissionDecision }
        : {}),
      ...(record.resourceKind ? { resourceKind: record.resourceKind } : {}),
      ...(record.canonical && result.disposition !== 'normalized-alias'
        ? { canonicalProperties: record.canonical }
        : {}),
      ...(record.syntaxKind
        ? { syntaxKind: record.syntaxKind, equivalent: record.equivalent }
        : {}),
      ...(record.platform
        ? { platform: record.platform, scope: record.scope }
        : {}),
      ...(result.limitation || record.limitation
        ? { limitation: result.limitation ?? record.limitation }
        : {}),
      family: family.id,
      capability,
      owner,
      requiredIn,
      requirement,
      ...(record.requirementCarrier
        ? { carriedBy: record.requirementCarrier }
        : {}),
      ...(targetDecision ? { targetDecision } : {}),
      proof: {
        fixtureId: `CE-FX-PROP-${name.replace(/^-+/, '')}`,
        evidenceClasses: evidence,
      },
      sources: f.sources,
      bcd: f.bcd,
      ...(f.bcdRelations?.length ? { bcdRelations: f.bcdRelations } : {}),
      alpha1: f.alpha1,
      upstream: f.upstream,
      ...(divergence.length ? { upstreamDivergence: divergence } : {}),
      ...(rules.notes[name] || result.reason
        ? { note: rules.notes[name] ?? result.reason }
        : {}),
    });
  }
  for (const name of Object.keys(rules.aliasAudit)) {
    if (!usedAudits.has(name))
      fail(`${name}: alias audit does not apply to an automatic alias`);
  }
  for (const [field, list] of Object.entries(reconciliation)) {
    if (list.length)
      fail(`reconciliation ${field}: ${JSON.stringify(list.slice(0, 5))}`);
  }
  if (entries.length !== rows.length)
    fail(
      `registry has ${entries.length} entries for ${rows.length} inventory rows`,
    );

  // -------------------------------------------------------------------------
  // Capabilities, limitations, profiles and decisions.

  const limitationIds = new Set(capSpec.limitations.map((l) => l.id));
  for (const entry of entries) {
    if (entry.limitation && !limitationIds.has(entry.limitation))
      fail(`${entry.name}: unknown limitation ${entry.limitation}`);
  }
  const capabilities = [];
  for (const [id, row] of coverage.caps) {
    const spec = capById.get(id);
    if (!spec) {
      fail(`capability ${id} has no authored disposition`);
      continue;
    }
    if (!row.lots.includes(spec.primaryOwner))
      fail(`${id}: primary owner ${spec.primaryOwner} not in Work ${row.work}`);
    if (!row.lots.includes(spec.closingLot))
      fail(`${id}: closing lot ${spec.closingLot} not in Work ${row.work}`);
    const existing = /^Existing\b|^Vite, Next|^Alpha 1 package/.test(
      row.alpha1Status,
    );
    if ((spec.disposition === 'existing-requalification') !== existing) {
      fail(
        `${id}: disposition ${spec.disposition} disagrees with Alpha 1 status "${row.alpha1Status}"`,
      );
    }
    for (const lim of spec.limitations)
      if (!limitationIds.has(lim)) fail(`${id}: unknown limitation ${lim}`);
    const requiredBy = profiles.profiles
      .filter((p) => p.requiredCapabilities.includes(id))
      .map((p) => p.id);
    if (!requiredBy.length) fail(`${id} is required by no profile`);
    const mapped = entries.filter((e) => e.capability === id);
    capabilities.push({
      id,
      ...row,
      disposition: spec.disposition,
      primaryOwner: spec.primaryOwner,
      closingLot: spec.closingLot,
      issues: [
        ...new Set(row.lots.flatMap((lot) => lotIssues[lot] ?? [])),
      ].sort((a, b) => a - b),
      requiredByProfiles: requiredBy,
      limitations: spec.limitations,
      proofRecord: spec.proofRecord,
      inventoryEntries: id === 'CAP-01' ? entries.length : mapped.length,
      requiredInventoryEntries: (id === 'CAP-01' ? entries : mapped).filter(
        (e) => e.requiredIn.length,
      ).length,
      requestCases: capSpec.requestCases
        .filter((r) => r.capabilities.includes(id))
        .map((r) => r.id),
    });
  }
  for (const id of capById.keys())
    if (!coverage.caps.has(id))
      fail(`authored capability ${id} is not in the coverage matrix`);

  if (capSpec.requestCases.length !== coverage.requests.length) {
    fail(
      `request cases ${capSpec.requestCases.length} vs coverage rows ${coverage.requests.length}`,
    );
  }
  const requestCases = capSpec.requestCases.map((req, i) => {
    const row = coverage.requests[i];
    if (!row || row.request !== req.request)
      fail(`request case ${req.id} text differs from coverage row ${i + 1}`);
    for (const lot of req.lots)
      if (
        !row?.acceptance.includes(lot.slice(3)) &&
        !row?.acceptance.includes(lot)
      )
        fail(`${req.id}: lot ${lot} not named in "${row?.acceptance}"`);
    return { ...req, acceptance: row?.acceptance ?? null };
  });

  for (const profile of profiles.profiles) {
    for (const id of profile.requiredCapabilities)
      if (!coverage.caps.has(id)) fail(`${profile.id}: unknown ${id}`);
    for (const d of [
      profile.browserTargetDecision,
      ...profile.additionalBrowserDecisions,
      ...profile.sourceFormatDecisions,
    ]) {
      if (d !== 'inherits-application-profile' && !decisionIds.has(d))
        fail(`${profile.id}: unknown decision ${d}`);
    }
  }
  for (const decision of decisions.decisions) {
    for (const p of decision.affects.profiles)
      if (!profileIds.includes(p)) fail(`${decision.id}: unknown profile ${p}`);
    for (const c of decision.affects.capabilities)
      if (!coverage.caps.has(c)) fail(`${decision.id}: unknown ${c}`);
  }

  // -------------------------------------------------------------------------
  // Counts. These are tracking denominators, never support scores.

  const counts = {
    entries: entries.length,
    byDisposition: tally(entries, (e) => e.disposition),
    bySubkind: tally(
      entries.filter((e) => e.subkind),
      (e) => `${e.disposition}/${e.subkind}`,
    ),
    byOwner: tally(entries, (e) => e.owner),
    byCapability: tally(entries, (e) => e.capability),
    byFamily: tally(entries, (e) => e.family),
    byRequirement: tally(entries, (e) => e.requirement),
    requiredByProfile: Object.fromEntries(
      profileIds.map((p) => [
        p,
        entries.filter((e) => e.requiredIn.includes(p)).length,
      ]),
    ),
    requiredGapsByProfile: Object.fromEntries(
      profileIds.map((p) => [
        p,
        entries.filter(
          (e) => e.requiredIn.includes(p) && e.requirement === 'required-gap',
        ).length,
      ]),
    ),
    targetDecisions: tally(
      entries.filter((e) => e.targetDecision),
      (e) => e.targetDecision.decision,
    ),
    aliasAudits: tally(
      entries.filter((e) => e.aliasAudit),
      (e) => e.aliasAudit.verdict,
    ),
    alpha1: tally(entries, (e) => e.alpha1.kind),
    sources: {
      stylexTypeNames: entries.filter((e) => e.sources.stylexType).length,
      pandaTypeNames: entries.filter((e) => e.sources.pandaType).length,
      pandaBaseUtilityKeys: entries.filter((e) => e.sources.pandaUtility)
        .length,
      bcdPropertyKeys: entries.filter((e) => e.sources.bcd).length,
      alpha1AdmittedPropertyNames: entries.filter(
        (e) =>
          !['unsupported', 'rejected-composite-form'].includes(e.alpha1.kind),
      ).length,
    },
    stylexEmission: tally(entries, (e) => e.upstream.stylex.emission),
    pandaEmission: tally(entries, (e) => e.upstream.panda.emission),
    canonicalWithUpstreamDivergence: entries.filter((e) => e.upstreamDivergence)
      .length,
  };
  for (const [field, expected] of Object.entries(inventory.counts)) {
    const actual =
      field === 'propertyEntries' ? counts.entries : counts.sources[field];
    if (actual !== expected)
      fail(`count ${field}: registry ${actual}, inventory ${expected}`);
  }

  const registry = {
    schemaVersion: 1,
    kind: 'core-evolution-registry',
    registryVersion: '1.1.0',
    task: 'CE-00.1',
    status: 'scope-contract-not-qualification',
    generatedBy: 'tests/core-evolution/tools/build-registry.mjs',
    baselineCommit: inventory.baselineCommit,
    comparator: { stylex: '0.19.1', panda: '2.2.0', bcd: '8.1.6' },
    // Input digests are file facts; the builder fills them and the validator
    // checks them against the committed files separately.
    inputs: null,
    lotIssues,
    proofStatus:
      'All entry fixtures and capability proof records are planned; none was executed by CE-00.1.',
    policy: [
      'Every one of the 1,108 research-inventory entries has exactly one disposition, one owner lot, one capability family and a proof-fixture requirement. No entry leaves the denominator.',
      'Counts are tracking denominators. No support percentage is derived from type occurrence, registry or profile counts.',
      'A required entry is stable in-profile work until its proof record closes with the listed evidence classes. Upstream emission observations are comparator evidence (E1), not PandamStyle qualification.',
      'Runtime-unbounded needs and unsupported platforms stay visible as limitations.',
      `Entry fields ${FACT_FIELDS.join(', ')} are recorded upstream facts; every other field and section is derived from them and the authored inputs by tests/core-evolution/tools/derive-registry.mjs, and the validator re-derives and compares the whole registry.`,
    ],
    dispositions: rules.dispositionDefinitions,
    procedure: rules.procedure,
    evidenceClasses: profiles.evidenceClasses,
    counts,
    reconciliation: {
      inventoryEntries: rows.length,
      registryEntries: entries.length,
      inventoryCounts: inventory.counts,
      derivedSourceCounts: counts.sources,
      sourceFlagMismatches: reconciliation.sourceFlagMismatches.length,
      bcdStatusMismatches: reconciliation.bcdStatusMismatches.length,
      alpha1Mismatches: reconciliation.alpha1Mismatches.length,
      method:
        'Each inventory row is compared with the recorded facts, which the builder re-derives from the pinned StyleX, Panda and BCD sources and the Alpha 1 policy tables parsed from source. Any mismatch fails the build and the validator.',
    },
    capabilities,
    limitations: capSpec.limitations,
    requestCases,
    entries,
  };
  return { errors, registry };
}
