/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - the agent-facing result, and the split of audit metadata
 * (Spike 4, Phase C).
 *
 * WHY THIS MODULE EXISTS
 *
 * A publication used to answer two unrelated questions with one document.
 *
 *   "Is this revision good, and if not, what exactly do I change?"  an agent,
 *                                                                   per edit,
 *                                                                   needs this
 *                                                                   now
 *   "What is the complete state of this project?"                  CI, forensics,
 *                                                                   debugging and
 *                                                                   long-term
 *                                                                   evidence need
 *                                                                   this
 *
 * At c10000 those are 1.7 KB and 3.25 MB, and the second one was on the critical
 * path of the first. The measured breakdown is in `benchmarks/pandamstyle/src/
 * report-bytes.js`: 99.95% of `build-report.json` is the `coverage` array, and
 * `relayChain` alone is 26% of the whole file. Making an agent wait for 3.25 MB
 * of project-wide metadata to learn that its own file has a bad padding value
 * is the waste Phase C removes - and the waste is removed by SPLITTING, not by
 * deleting: every byte the old report carried is still reachable, through
 * `requestFullAudit()`.
 *
 * THE THREE DOCUMENTS, AND WHY THEY ARE SEPARATE SCHEMAS
 *
 *   pandamstyle-agent-result    compact, revision-bound, machine-authoritative
 *   pandamstyle-build-report    the revision/build summary, now small
 *   pandamstyle-coverage-report the project-wide coverage snapshot
 *
 * One schema for all three would mean one version number moving whenever any of
 * the three changes, and a consumer could not tell which document it is holding.
 * They have genuinely different lifecycles - the agent result is consumed and
 * discarded per edit, the build report is read by a build tool, the coverage
 * report is read by an auditor - so they are versioned separately.
 *
 * COMPACTNESS IS A CONTRACT, NOT AN ASPIRATION
 *
 * The agent result must not scale with project size. That rules out the
 * coverage array, and it also rules out something less obvious: the admissible
 * token list a `PMS_FORBIDDEN_VALUE` diagnostic carries is derived from the
 * REGISTRY, so at a 10,000-token design system it is a 10,000-element array in
 * every one of those diagnostics. It is therefore capped here, with the true
 * count and a truncation flag beside it, and the full list is available through
 * `session.candidateTokens()`. A cap that silently dropped the tail would make
 * the diagnostic non-authoritative, which is worse than a large one.
 *
 * NO BACKGROUND WORK
 *
 * Nothing here schedules work. A caller that wants the full audit asks for it
 * and waits for it. The compiler does not claim to have produced a document it
 * has not written, and it does not start a write the caller cannot observe.
 */

import { Codes } from './diagnostics';

/** Machine result, per agent edit. Compact. */
export const AGENT_RESULT_KIND = 'pandamstyle-agent-result';
export const AGENT_RESULT_SCHEMA_VERSION = 1;
export const DIAGNOSTICS_RESULT_KIND = 'pandamstyle-diagnostics-result';
export const DIAGNOSTICS_RESULT_SCHEMA_VERSION = 1;
export const COMPILER_ABI_VERSION = 1;

/** The revision/build summary a publication writes. */
export const BUILD_REPORT_KIND = 'pandamstyle-build-report';
/**
 * 2, not 1.
 *
 * Version 1 carried the project-wide `coverage` array inline. Version 2 replaces
 * it with a `coverageSummary` (counts) and a `coverageReport` REFERENCE. A
 * consumer of a version 1 report that silently reads a version 2 report would
 * find `coverage` absent and could mistake that for "no files were covered", so
 * the version is a REQUIRED field rather than an optional one: a reader that
 * does not check it is not reading this format.
 */
export const BUILD_REPORT_SCHEMA_VERSION = 2;

/** The project-wide coverage snapshot, materialized on request. */
export const COVERAGE_REPORT_KIND = 'pandamstyle-coverage-report';
export const COVERAGE_REPORT_SCHEMA_VERSION = 1;

/** The file name of the coverage artifact, inside a generation or the audit dir. */
export const COVERAGE_REPORT_FILE = 'coverage.json';

/**
 * How many admissible token ids a diagnostic may carry inline.
 *
 * Chosen so that the common case - a `spacing` or `color` violation against a
 * design system with hundreds of tokens in that category - is fully answered by
 * the diagnostic itself, while a 10,000-token registry does not put a
 * 10,000-element array into an object whose entire job is to be small.
 */
export const DEFAULT_CANDIDATE_LIMIT = 32;

/**
 * How many coverage entries the agent result may carry inline.
 *
 * The affected set is small on a normal revision - it is what the agent just
 * wrote - and the cap is never reached. It exists for the ONE case where the
 * affected set IS the project: a global fallback drops every cached result and
 * recompiles everything, so "the files this revision touched" is ten thousand
 * files, and a result that listed them would be the project. Measured: a
 * `token_value` fallback at c1000 produced a 413,988-byte agent result, which
 * is the whole compact-report saving thrown away on the one revision where an
 * agent most needs a small answer.
 *
 * So the list is capped, the TRUE count and a truncation flag sit beside it, and
 * the rest is where it has always been: the coverage document, on request.
 */
export const DEFAULT_AFFECTED_ENTRY_LIMIT = 64;

// ------------------------------------------------------------------ repair ---

/**
 * The structured repair for each diagnostic code, when the diagnostic carries
 * enough structure to state one.
 *
 * This is the part that makes a diagnostic a PROTOCOL rather than prose. An agent
 * asking "what do I change here" must not have to read a French sentence about
 * a token category to learn that it needs a `spacing` token. Where a code cannot
 * be repaired mechanically, the answer says so in a field, rather than leaving
 * the agent to infer it from the absence of one.
 *
 * `kind` values are stable identifiers, not prose. A host switches on them.
 */
const REPAIR_BY_CODE = {
  [Codes.UNKNOWN_PATTERN]: ({ context }) => ({
    kind: 'use-declared-pattern',
    applicable: true,
    target: { patternId: context.patternId },
    expected: { admitted: context.admitted },
    how: 'replace the pattern name with one of the admitted pattern IDs',
  }),
  [Codes.INVALID_PATTERN_PARAMETER]: ({ context }) => ({
    kind: 'use-pattern-parameter-domain',
    applicable: true,
    target: { patternId: context.patternId, parameter: context.parameter },
    expected: { admitted: context.admitted },
    how: 'use the constrained parameter and its admitted value domain',
  }),
  [Codes.FORBIDDEN_VALUE]: ({ context }) => {
    // A value refused because the property needs a token of a category. The
    // repair is a substitution and the compiler can say what it accepts.
    if (context.category != null) {
      return {
        kind: 'substitute-token',
        applicable: true,
        property: context.property ?? null,
        value: context.value ?? null,
        expected: { category: context.category },
        // The admissible list is a DIAGNOSTIC field, not a repair field, so
        // that a caller reads the candidates once and not once per suggested
        // fix. The repair says where they are instead of duplicating them.
        candidatesFrom: 'diagnostic.candidates',
        how:
          'replace the value with a token reference drawn from ' +
          'diagnostic.candidates, whose category is the expected one; P0 ' +
          'admits no other form for this property',
      };
    }
    // A value refused because it is outside an admitted structural domain.
    if (context.admitted != null) {
      return {
        kind: 'substitute-in-domain',
        applicable: true,
        property: context.property ?? null,
        value: context.value ?? null,
        expected: { admitted: context.admitted },
        how:
          'replace the value with a structurally admitted one for this ' +
          'property; the admitted shapes are in `expected.admitted`',
      };
    }
    return {
      kind: 'substitute-token',
      applicable: false,
      reason:
        'this diagnostic does not name a category or an admitted domain, so ' +
        'there is no mechanical substitution to suggest',
    };
  },
  [Codes.UNKNOWN_TOKEN]: ({ context }) => ({
    kind: 'use-declared-token',
    applicable: true,
    property: context.property ?? null,
    tokenId: context.tokenId ?? null,
    expected: { declared: true },
    how: 'replace the token path with one the design system declares',
  }),
  [Codes.INVALID_TOKEN_CATEGORY]: ({ context }) => ({
    kind: 'use-token-of-category',
    applicable: true,
    property: context.property ?? null,
    tokenId: context.tokenId ?? null,
    expected: { category: context.category ?? null },
    how: 'use a token declared in the category the property requires',
  }),
  [Codes.TOKEN_NOT_PUBLIC]: ({ context }) => ({
    kind: 'use-public-token',
    applicable: true,
    tokenId: context.tokenId ?? null,
    expected: { visibility: 'public' },
    how:
      'replace the private token with a public one, or import this page with ' +
      'the private channel explicitly allowed',
  }),
  [Codes.DUPLICATE_TOKEN]: ({ context }) => ({
    kind: 'rename-token',
    applicable: true,
    tokenId: context.tokenId ?? null,
    expected: { unique: true },
    how: 'declare the token at one path only',
  }),
  [Codes.TOKEN_CYCLE]: () => ({
    kind: 'break-cycle',
    applicable: false,
    reason:
      'a token cycle is a property of the design system, not of one ' +
      'declaration, and no local edit repairs it',
  }),
  [Codes.UNSUPPORTED_PROPERTY]: ({ context }) => ({
    kind: 'use-supported-property',
    applicable: true,
    property: context.property ?? null,
    expected: { supported: true },
    how: 'replace the property with one the profile supports',
  }),
  [Codes.UNSUPPORTED_PROPERTY_FORM]: ({ context }) => ({
    kind: 'use-longhand',
    applicable: true,
    property: context.property ?? null,
    expected: { form: 'longhand' },
    how: 'replace the composite property with its longhand equivalents',
  }),
  [Codes.UNKNOWN_CONDITION]: ({ context }) => ({
    kind: 'use-declared-condition',
    applicable: true,
    condition: context.condition ?? context.request ?? null,
    expected: { declared: true },
    how: 'use a condition the design system declares',
  }),
  [Codes.INVALID_VARIANT_KEY]: ({ context }) => ({
    kind: 'use-declared-variant',
    applicable: true,
    key: context.key ?? context.variant ?? null,
    expected: { declared: true },
    how: 'use a variant key the recipe declares',
  }),
  [Codes.INVALID_VARIANT_VALUE]: ({ context }) => ({
    kind: 'use-declared-variant-value',
    applicable: true,
    key: context.key ?? null,
    value: context.value ?? null,
    expected: { declared: true },
    how: 'use a variant value the recipe declares for that key',
  }),
  [Codes.NON_STATIC_VALUE]: ({ context }) => ({
    kind: 'inline-the-value',
    applicable: true,
    property: context.property ?? null,
    expected: { static: true },
    how:
      'replace the computed value with a literal or a token reference; P0 ' +
      'admits no runtime-computed style value',
  }),
  [Codes.FORBIDDEN_STYLE_CHANNEL]: () => ({
    kind: 'remove-the-channel',
    applicable: true,
    expected: { allowedChannels: ['tokens', 'recipes'] },
    how:
      'remove the closed-profile style channel and express the style through ' +
      'tokens or a recipe',
  }),
  [Codes.FORBIDDEN_IMPORT]: ({ context }) => ({
    kind: 'remove-the-import',
    applicable: true,
    request: context.request ?? null,
    expected: { forbidden: true },
    how: 'remove the forbidden import',
  }),
  [Codes.UNVERIFIED_JSX_SPREAD]: () => ({
    kind: 'admit-the-provenance',
    applicable: false,
    reason:
      'the spread must be proven by binding-based provenance; the compiler ' +
      'cannot suggest the binding from the diagnostic alone',
  }),
  [Codes.UNVERIFIED_PROPS_SOURCE]: () => ({
    kind: 'admit-the-provenance',
    applicable: false,
    reason:
      'the props() argument is raw; the compiler cannot suggest which binding ' +
      'to pass from the diagnostic alone',
  }),
  [Codes.UNVERIFIED_PROVENANCE]: () => ({
    kind: 'admit-the-provenance',
    applicable: false,
    reason:
      'a proven value was written to or escaped into an unrecognized call; the ' +
      'compiler cannot suggest the repair from the diagnostic alone',
  }),
  [Codes.ROLE_VIOLATION]: ({ context }) => ({
    kind: 'correct-the-role',
    applicable: true,
    expected: { role: context.role ?? null },
    how: 'declare the file with the role its contents require',
  }),
  [Codes.COVERAGE_GAP]: ({ context }) => ({
    kind: 'resolve-the-reference',
    applicable: true,
    request: context.request ?? null,
    from: context.from ?? null,
    form: context.form ?? null,
    expected: { resolvable: true },
    how:
      'create the module the reference names, or correct the reference; an ' +
      'unresolved local edge is a coverage gap, not a skipped file',
  }),
};

/** A repair for a code this table does not know. Never a fabricated fix. */
function unknownRepair(code) {
  return {
    kind: 'unknown',
    applicable: false,
    reason:
      `no structured repair is defined for ${code}; the message is the ` +
      'authority for this one',
  };
}

/**
 * Truncates a candidate list without making the diagnostic a lie.
 *
 * `candidatesTotal` and `candidatesTruncated` are part of the answer: an agent
 * that sees 32 of 400 candidates knows it is seeing 32, and `how` says the rest
 * is queryable. A silently shortened list would be indistinguishable from a
 * registry of 32.
 */
function candidateBlock(candidates, limit) {
  if (!Array.isArray(candidates)) return null;
  const sliced = candidates.slice(0, limit);
  return {
    candidates: sliced,
    candidatesTotal: candidates.length,
    candidatesTruncated: candidates.length > sliced.length,
    candidatesQuery: 'session.candidateTokens({ category, limit, offset })',
  };
}

// -------------------------------------------------------------- diagnostic ---

/**
 * The machine-authoritative form of one diagnostic.
 *
 * This is an ADDITIVE view, not a replacement. `diagnostics.js` still produces
 * schema version 1 and every existing consumer of it is unchanged; this is the
 * view an AGENT reads, and it exists because the two readers want different
 * things. A human wants the sentence. An agent wants the fields, and must never
 * have to recover a rule violation out of prose to act on it.
 *
 * What changes relative to the v1 shape:
 *
 *   `source`    v1 collapses file and role into one string, `"a.tsx (page)"`.
 *               Parsing that back into a file and a role is a regular
 *               expression against an author's file name, and a file whose name
 *               contains " (page)" breaks it. Here `source` is the same object
 *               v1 keeps in `location`, with `label` beside it for display.
 *   `expected`  the admissible value category or domain, lifted out of `context`
 *               and named, so a host switches on it rather than on a key that
 *               happens to be present.
 *   `repair`    a structured suggestion, or a stated reason there is none.
 *   `file`      the LOCAL coverage record of the file the diagnostic is about.
 *
 * `context` is passed through in full. It is already structured, it already
 * carries the token paths, condition paths and candidate lists, and dropping the
 * keys a particular PandamStyle version happened not to know about would make
 * the result lossy in a way no later version could repair.
 */
export function machineDiagnostic(
  diag,
  { coverageByFile = null, candidateLimit = DEFAULT_CANDIDATE_LIMIT } = {},
) {
  const context = diag?.context ?? {};
  const location = diag?.location ?? null;
  const file = location?.file ?? null;

  // A diagnostic's own context, minus the two keys that are re-exposed as
  // first-class fields. Duplicating them would make the object bigger for no
  // reader, and a reader that found the same fact in two places would have no
  // way to know which one is authoritative.
  const rest = { ...context };
  delete rest.candidates;
  delete rest.category;

  const machine = {
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    code: diag?.code ?? null,
    severity: diag?.severity ?? 'error',
    phase: diag?.phase ?? null,
    rule: diag?.rule ?? null,
    message: diag?.message ?? '',
    source: {
      file,
      line: location?.line ?? null,
      column: location?.column ?? null,
      role: location?.role ?? null,
      label: diag?.source ?? null,
    },
    context: rest,
    expected: {
      category: context.category ?? null,
      admitted: context.admitted ?? null,
    },
    repair: null,
    autofix: diag?.autofix ?? null,
  };

  const candidates = candidateBlock(context.candidates, candidateLimit);
  if (candidates != null) Object.assign(machine, candidates);

  const repairFor = REPAIR_BY_CODE[diag?.code];
  machine.repair =
    repairFor != null ? repairFor({ context }) : unknownRepair(diag?.code);

  // LOCAL context only. The file the diagnostic is about, and nothing else: a
  // diagnostic about `Button.tsx` gets `Button.tsx`'s own coverage record, never
  // the project's. Attaching the whole coverage graph would defeat the entire
  // split - one diagnostic would drag the 3.25 MB back into the agent result.
  if (coverageByFile != null && file != null) {
    const entry = coverageByFile.get(file);
    if (entry != null) {
      machine.file = {
        file: entry.file,
        origin: entry.origin,
        role: entry.role,
        analysed: entry.analysed === true,
        usedDesignSystem: entry.usedDesignSystem === true,
        usedPmsHelpers: entry.usedPmsHelpers === true,
        ruleCount: entry.ruleCount ?? null,
        relayChain: entry.relayChain ?? [],
        failed: entry.failed === true,
        codes: entry.codes ?? null,
      };
    }
  }
  return machine;
}

// ---------------------------------------------------------------- coverage ---

/**
 * The project-wide coverage SNAPSHOT, as a document of its own.
 *
 * Byte-for-byte the array version 1 of the build report carried inline, under
 * `entries`. It is separated, not rewritten: `entries` is the same list of the
 * same objects, so an auditor comparing the two formats compares them directly
 * and the audit oracle needs no semantic translation to run.
 */
export function buildCoverageReport({
  contractVersion,
  systemId,
  registryDigest,
  revisionId,
  generationId,
  coveredRoots,
  entries,
}) {
  return {
    documentKind: COVERAGE_REPORT_KIND,
    schemaVersion: COVERAGE_REPORT_SCHEMA_VERSION,
    contractVersion,
    systemId,
    registryDigest,
    revisionId,
    generationId,
    coveredRoots,
    entryCount: entries.length,
    entries,
  };
}

/**
 * The coverage COUNTS, which are what belong in a summary.
 *
 * Every number here is derived from the same `entries` array the detail document
 * carries, so the summary can never disagree with the detail: there is one
 * source and two renderings of it. `relayChainEntries` is here because the
 * chain is the single largest contributor to the detail document's size, and a
 * reader deciding whether to open that document needs to know how much is in
 * it before deciding.
 */
export function coverageSummary(entries) {
  const summary = {
    entries: entries.length,
    pages: 0,
    designSystem: 0,
    failed: 0,
    withDiagnostics: 0,
    usedDesignSystem: 0,
    usedPmsHelpers: 0,
    ruleTotal: 0,
    relayChainEntries: 0,
    maxRelayChain: 0,
  };
  for (const entry of entries) {
    if (entry.role === 'design-system') summary.designSystem += 1;
    else summary.pages += 1;
    if (entry.failed === true) summary.failed += 1;
    if ((entry.diagnostics ?? 0) > 0) summary.withDiagnostics += 1;
    if (entry.usedDesignSystem === true) summary.usedDesignSystem += 1;
    if (entry.usedPmsHelpers === true) summary.usedPmsHelpers += 1;
    summary.ruleTotal += entry.ruleCount ?? 0;
    const chain = entry.relayChain;
    if (Array.isArray(chain) && chain.length > 0) {
      summary.relayChainEntries += chain.length;
      if (chain.length > summary.maxRelayChain)
        summary.maxRelayChain = chain.length;
    }
  }
  return summary;
}

/**
 * The compact report's coverage block: the counts, plus a REFERENCE to the
 * detail.
 *
 * `materialized: false` is a statement about the filesystem, not an intention.
 * It is true only if the document has actually been written for this revision,
 * and it is set by whoever wrote it.
 */
export function coverageReference({
  revisionId,
  summary,
  materialized,
  document = COVERAGE_REPORT_FILE,
  materializedAt = null,
  bytes = null,
}) {
  return {
    documentKind: COVERAGE_REPORT_KIND,
    schemaVersion: COVERAGE_REPORT_SCHEMA_VERSION,
    document,
    revisionId,
    entries: summary.entries,
    materialized: materialized === true,
    materializedAt,
    bytes,
    note:
      'the per-file coverage snapshot is not in this report; request it with ' +
      'session.requestFullAudit() for this revision, or read it from a ' +
      'generation that published it',
  };
}

// ------------------------------------------------------------ agent result ---

/**
 * The compact, revision-bound, machine-readable result of one mutation
 * transaction.
 *
 * FOUR COMPLETION POINTS, AND THEY ARE NOT ONE
 *
 *   diagnosticsReady   the verdict for this revision exists. Set for a FAILED
 *                      revision too - a refused revision is a complete answer,
 *                      and it is the answer the agent needs.
 *   generationReady    every artifact for this revision is staged. False until
 *                      `compile()` runs, and false forever if the revision
 *                      failed: a failed revision does not publish.
 *   generationCommitted the commit marker is on disk.
 *   auditReportReady   the full audit for this revision exists. False unless it
 *                      was requested, and the timings say why.
 *
 * A caller that only needs to know whether to keep editing reads the first. A
 * caller that needs the output waits for the third. Merging them is the mistake
 * this shape exists to prevent: "validation succeeded" and "the generation is
 * on disk" are different facts, and an agent that has been told the second when
 * only the first happened will read files that are not there yet.
 */
export function buildAgentResult({
  revisionId,
  ok,
  diagnostics,
  mutation,
  incremental,
  generation,
  coverage,
  audit,
  timings,
  projectSemanticEpoch = null,
}) {
  return {
    documentKind: AGENT_RESULT_KIND,
    schemaVersion: AGENT_RESULT_SCHEMA_VERSION,
    revisionId,
    ok,
    projectSemanticEpoch,
    diagnostics,
    mutation,
    incremental,
    coverage,
    generation,
    audit,
    timings,
  };
}

/**
 * The mutation block.
 *
 * `declared`, `read`, `hashed` and `contentChanged` are four different numbers
 * and are reported as four. A host that declared one file and whose bytes were
 * unchanged has not made a one-file edit; it has made a no-op that cost a read
 * and a hash. Collapsing those into "1 file changed" is how a benchmark comes
 * to report a cache hit as edit latency, and it is the single most misleading
 * thing this object could say.
 */
export function mutationBlock({ mode, transaction, counters }) {
  const declaredPaths = new Set();
  if (transaction != null) {
    for (const p of transaction.changed) declaredPaths.add(p);
    for (const p of transaction.added) declaredPaths.add(p);
    for (const p of transaction.removed) declaredPaths.add(p);
    for (const r of transaction.renamed) {
      declaredPaths.add(r.from);
      declaredPaths.add(r.to);
    }
  }
  const unchanged = counters?.dirtyFilesUnchanged ?? 0;
  return {
    mode,
    declared: declaredPaths.size,
    read: counters?.dirtyFilesRead ?? 0,
    hashed: counters?.dirtyFilesHashed ?? 0,
    contentChanged: counters?.filesChanged ?? 0,
    contentUnchanged: unchanged,
    changed: counters?.filesChanged ?? 0,
    added: counters?.filesAdded ?? 0,
    removed: counters?.filesRemoved ?? 0,
    renamed: transaction?.renamed?.length ?? 0,
    // The honest label for "the host said these paths moved and the bytes said
    // otherwise". It is not a failure, and it is not silently folded into the
    // changed count.
    noOp:
      declaredPaths.size > 0 &&
      (counters?.filesChanged ?? 0) === 0 &&
      (counters?.filesAdded ?? 0) === 0 &&
      (counters?.filesRemoved ?? 0) === 0,
  };
}

/**
 * The incremental block: how much work this revision actually did.
 *
 * Deliberately counts, not lists. `filesReused: 10001` is a number that costs
 * nothing to carry and says the important thing - the project's size is not in
 * this object - while a list of 10,001 file names would make the agent result
 * scale with the thing Phase C exists to stop it scaling with.
 */
export function incrementalBlock({
  counters,
  mode,
  fullDiscovery,
  fullFallbackReason,
}) {
  return {
    filesChanged: counters?.filesChanged ?? 0,
    filesAdded: counters?.filesAdded ?? 0,
    filesRemoved: counters?.filesRemoved ?? 0,
    // What the analysis compiled, and what it replaced. On a healthy revision
    // they agree; when they do not, files were compiled and did not produce a
    // contribution, which is what a failure or a removal looks like from here.
    filesCompiled: counters?.filesCompiled ?? counters?.filesRecompiled ?? 0,
    filesRecompiled: counters?.filesRecompiled ?? 0,
    filesReused: counters?.filesReused ?? 0,
    coveredFiles: counters?.coveredFileCount ?? 0,
    dirtyInputMode: mode,
    fullDiscovery: fullDiscovery === true,
    fullFallback: (counters?.fullFallback ?? 0) > 0,
    fullFallbackReason: fullFallbackReason ?? null,
  };
}

/**
 * The generation block.
 *
 * `published` and `committed` are separate because they are separate. Between
 * the staging callback returning and the commit marker landing there is a real
 * window in which every artifact exists and the previous generation is still
 * current, and a caller that reads the output directory in that window is
 * reading the wrong bytes. `generationId` is null until there is a generation to
 * name, and `revisionId` is always present, so a result can never be mistaken
 * for one that belongs to a different revision.
 */
export function generationBlock({
  published,
  generationId,
  generationReused,
  mode,
  outputsWritten = 0,
  outputsReused = 0,
  bytesWritten = 0,
}) {
  return {
    published: published === true,
    generationId: generationId ?? null,
    generationReused: generationReused === true,
    mode: mode ?? null,
    outputsWritten,
    outputsReused,
    bytesWritten,
  };
}

/**
 * The audit block.
 *
 * Says which artifacts exist for this revision, honestly. `requested` and
 * `ready` are separate because a request that has not completed yet is a real
 * state and reporting it as ready would be a claim about work that has not
 * happened.
 */
export function auditBlock({
  requested,
  ready,
  document = null,
  bytes = null,
  reason = null,
}) {
  return {
    requested: requested === true,
    ready: ready === true,
    document,
    bytes,
    reason,
    request: 'session.requestFullAudit()',
  };
}
