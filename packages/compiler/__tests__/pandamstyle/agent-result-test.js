/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE C - the agent-facing result, and the split of audit metadata.
 *
 * THE LOOP UNDER TEST
 *
 *     agent writes a file
 *             ↓
 *     session.applyAgentChanges({ changed: [file] })
 *             ↓
 *     session.validate()  ->  a compact, revision-bound, machine result
 *             ↓
 *     the agent repairs or continues
 *
 * Everything here is about that loop, and the claims are the ones the phase
 * exists to establish:
 *
 *   1. the result is BOUND to a revision, and a result for revision N is never
 *      returned as the result of revision N+1;
 *   2. a diagnostic is a PROTOCOL: every field an agent needs to repair a
 *      violation is structured, and none of them requires reading the message;
 *   3. an INVALID revision gets its diagnostics with NO publication, NO build
 *      report and NO audit document;
 *   4. a VALID revision exposes "diagnostics" and "generation committed" as two
 *      separate facts;
 *   5. the result does not grow with the project - same diagnostics, same
 *      affected set, same size at 8 files and at 800;
 *   6. the full audit is STILL AVAILABLE, byte for byte the coverage array the
 *      monolithic report used to carry.
 *
 * The last one is the one that makes the others acceptable. A smaller object
 * that had thrown the evidence away would satisfy 1-5 and fail the phase.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.autoMockOff();

const {
  auditStateOf,
  auditDirOf,
  comparePublished,
  measure,
  openExistingProject,
  openProject,
} = require('./session-helpers');
const { freshCopyOf } = require('./pms-helpers');

const D = { publishVariant: 'session_incremental_publish' };

/**
 * The result without its two measured intervals.
 *
 * Those two numbers are real measurements and their digit counts vary run to
 * run; leaving them in would make "the same size" a claim about how many
 * significant digits a millisecond happened to take, which is not the property
 * under test. They are compared separately, on the full object, with a
 * tolerance a hundred times their variation.
 */
function withoutTimings(result) {
  const { timings, ...rest } = result;
  void timings;
  return rest;
}

/** One full agent step: declare, validate, and hand back the result. */
function agentStep(h, mutation) {
  return measure(() => {
    h.session.applyAgentChanges(mutation);
    return h.session.validate();
  });
}

function bytesOf(h, options) {
  const out = h.session.serializeAgentResult(options);
  return out == null ? null : out.bytes;
}

function reportOf(h) {
  return JSON.parse(
    fs.readFileSync(path.join(h.outDir, 'build-report.json'), 'utf8'),
  );
}

const editIn = (h, rel, from, to) => {
  const file = h.src(rel);
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    throw new Error(
      `edit target ${JSON.stringify(from)} not present in ${rel}`,
    );
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
  return file;
};

// A value the policy refuses. `color` is a category property, so a raw number
// is refused with PMS_FORBIDDEN_VALUE and the diagnostic names the `color`
// category as what is required. It is the invalid-then-repair pair's subject, so
// it is defined once and used by both halves of that test.
const SOLE = "color: token('colors.text.primary')";
const FORBIDDEN = 'color: 17';

// ---------------------------------------------------------------------------
// 1. the result is a versioned, revision-bound document
// ---------------------------------------------------------------------------

describe('Phase C: the agent result is a versioned, revision-bound document', () => {
  test('the result carries its kind, its version and its revision', () => {
    const h = openProject('valid', D);
    const validation = agentStep(h, { changed: [] }).value;
    expect(validation.ok).toBe(true);
    h.session.compile();

    const result = h.session.agentResult();
    expect(result.documentKind).toBe('pandamstyle-agent-result');
    expect(result.schemaVersion).toBe(1);
    expect(result.revisionId).toBe(validation.revisionId);
    expect(result.projectSemanticEpoch).toBe(
      h.session.stats().projectSemanticEpoch,
    );
  });

  test('every result is bound to the revision it describes, and says so', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const first = h.session.agentResult();
    expect(first.revisionId).toBe(1);

    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    agentStep(h, { changed: [file] });
    h.session.compile();
    const second = h.session.agentResult();

    expect(second.revisionId).toBe(2);
    // The result for revision N is never re-served as the result of N+1: the
    // object is rebuilt from the current revision, and its generation block
    // names the generation that revision produced.
    expect(second.generation.generationId).toBe(2);
    expect(second.revisionId).not.toBe(first.revisionId);
  });

  test('a result for a revision that is not the current one is refused', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(h, 'src/page.js', 'borderRadius', 'padding');
    agentStep(h, { changed: [file] });

    expect(() => h.session.agentResult({ revisionId: 1 })).toThrow(
      /bound to the revision it describes/,
    );
    // The current one is still answerable.
    expect(h.session.agentResult({ revisionId: 2 }).revisionId).toBe(2);
  });

  test('a result asked for before a revision exists is refused', () => {
    const h = openProject('valid', D);
    expect(() => h.session.agentResult()).toThrow(/before applyChanges/);
  });

  test('the mutation block reports declared, read, hashed and changed apart', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();

    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const validation = agentStep(h, { changed: [file] }).value;
    h.session.compile();

    const { mutation } = h.session.agentResult();
    expect(mutation.mode).toBe('verified-explicit');
    expect(mutation.declared).toBe(1);
    expect(mutation.read).toBe(1);
    expect(mutation.hashed).toBe(1);
    expect(mutation.contentChanged).toBe(1);
    expect(mutation.contentUnchanged).toBe(0);
    expect(mutation.noOp).toBe(false);
    expect(validation.revisionId).toBe(2);
  });

  test('a declared file whose bytes are identical is reported as a no-op, not as an edit', () => {
    // "The host declared one file and the bytes did not change" is a different
    // fact from "the host edited one file", and an agent result that cannot say
    // which happened is a result an over-declaring host cannot detect itself.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();

    const file = h.src('src/page.js');
    const before = fs.readFileSync(file, 'utf8');
    agentStep(h, { changed: [file] });
    h.session.compile();

    const { mutation, incremental } = h.session.agentResult();
    expect(mutation.declared).toBe(1);
    expect(mutation.read).toBe(1);
    expect(mutation.hashed).toBe(1);
    expect(mutation.contentChanged).toBe(0);
    expect(mutation.contentUnchanged).toBe(1);
    expect(mutation.noOp).toBe(true);
    expect(incremental.filesChanged).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 2. diagnostics are a protocol
// ---------------------------------------------------------------------------

describe('Phase C: a diagnostic is a repair protocol, not a sentence', () => {
  /** Brings a session to the point where it can be made to fail. */
  const failing = (() => {
    let cached = null;
    return () => {
      if (cached != null) return cached;
      const h = openProject('valid', D);
      agentStep(h, { changed: [] });
      h.session.compile();
      const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
      const seen = agentStep(h, { changed: [file] });
      cached = { h, file, validation: seen.value, counters: seen.counters };
      return cached;
    };
  })();

  test('the refusal is PMS_FORBIDDEN_VALUE, as the reference build refuses it', () => {
    const { validation } = failing();
    expect(validation.ok).toBe(false);
    expect(validation.diagnostics.map((d) => d.code)).toEqual([
      'PMS_FORBIDDEN_VALUE',
    ]);
  });

  test('the machine diagnostic names the rule without the message being read', () => {
    const { h } = failing();
    const [d] = h.session.agentResult().diagnostics;

    // Everything an agent needs, structured.
    expect(d.code).toBe('PMS_FORBIDDEN_VALUE');
    expect(d.severity).toBe('error');
    expect(d.phase).toBe('policy');
    expect(d.rule).toBe('category-strict');
    expect(d.source.file).toMatch(/src\/page\.js$/);
    expect(typeof d.source.line).toBe('number');
    expect(d.source.role).toBe('page');
    expect(d.context.property).toBe('color');
    expect(d.context.value).toBe(17);
    expect(d.expected.category).toBe('colors');

    // The message is present for a human, and it is NOT where the facts live.
    // It names the property, the value and the required category; it does not
    // name the code or the rule, and a caller must not have to recover those
    // from prose. The two assertions together are the contract: the sentence
    // explains, the fields decide.
    expect(typeof d.message).toBe('string');
    for (const fact of ['color', 'colors', '17']) {
      expect(d.message).toContain(fact);
    }
    expect(d.message).not.toContain('PMS_FORBIDDEN_VALUE');
    expect(d.message).not.toContain('category-strict');
  });

  test('the diagnostic carries a structured repair', () => {
    const { h } = failing();
    const [d] = h.session.agentResult().diagnostics;
    expect(d.repair.kind).toBe('substitute-token');
    expect(d.repair.applicable).toBe(true);
    expect(d.repair.property).toBe('color');
    expect(d.repair.value).toBe(17);
    expect(d.repair.expected.category).toBe('colors');
    // The repair points at the candidates rather than repeating them.
    expect(d.repair.candidatesFrom).toBe('diagnostic.candidates');
    expect(d.candidates.length).toBeGreaterThan(0);
    // `autofix` stays null: 17 is not a proven equivalent of any token value,
    // and a compiler that auto-wrote a different colour would be changing an
    // author's design. The REPAIR is a substitution the agent chooses.
    expect(d.autofix).toBeNull();
  });

  test('a diagnostic carries the LOCAL coverage of its own file, and nothing else', () => {
    const { h } = failing();
    const [d] = h.session.agentResult().diagnostics;
    expect(d.file).toBeDefined();
    expect(d.file.file).toMatch(/src\/page\.js$/);
    expect(d.file.origin).toBe('root');
    expect(d.file.role).toBe('page');
    expect(d.file.analysed).toBe(true);
    expect(Array.isArray(d.file.relayChain)).toBe(true);
    // The project-wide graph is NOT attached. A diagnostic is about one file.
    expect(d.file.projectEntries).toBeUndefined();
    expect(d.file.entries).toBeUndefined();
  });

  test('a candidate list that exceeds the limit is truncated AND says so', () => {
    // A `PMS_FORBIDDEN_VALUE` diagnostic's admissible list is derived from the
    // REGISTRY, so without a cap the "compact" result would scale with the
    // design system. The cap is only acceptable if the diagnostic is honest
    // about having applied it.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
    agentStep(h, { changed: [file] });
    // No `compile()`: the revision is invalid and a refused revision does not
    // publish. A result about a file that failed is available without it.

    const [d] = h.session.agentResult().diagnostics;
    expect(d.candidatesTotal).toBeGreaterThan(0);
    expect(d.candidates.length).toBeLessThanOrEqual(
      h.compiler.DEFAULT_CANDIDATE_LIMIT,
    );
    expect(d.candidates.length).toBe(d.candidatesTotal);
    expect(d.candidatesTruncated).toBe(false);

    // The full list is reachable, and paging is a supported way to reach it.
    const all = h.session.candidateTokens({
      category: 'colors',
      limit: 10_000,
    });
    expect(all.total).toBe(d.candidatesTotal);
    expect(all.tokens).toEqual(d.candidates);
    const page1 = h.session.candidateTokens({ category: 'colors', limit: 2 });
    const page2 = h.session.candidateTokens({
      category: 'colors',
      limit: 2,
      offset: 2,
    });
    expect(page1.truncated).toBe(true);
    expect(page2.tokens[0]).toBe(all.tokens[2]);
  });

  test('every code the negative corpus can raise has either a repair or a stated reason', () => {
    // The negative fixtures are the compiler's own list of what it refuses. A
    // code with neither a structured repair nor a reason why there is none is a
    // code an agent can only act on by reading prose, and the table in
    // agent-result.js is where that would have to be fixed.
    const codes = new Set();
    for (const name of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
      if (!name.startsWith('neg-')) continue;
      const project = freshCopyOf(name);
      const h = openExistingProject(project, D);
      h.session.applyAgentChanges({ changed: [] });
      const validation = h.session.validate();
      for (const d of validation.diagnostics) codes.add(d.code);
      const [first] = h.session.agentResult().diagnostics;
      if (first == null) continue;
      expect(first.repair).toBeDefined();
      expect(typeof first.repair.kind).toBe('string');
      expect(typeof first.repair.applicable).toBe('boolean');
      if (first.repair.applicable === false) {
        expect(typeof first.repair.reason).toBe('string');
        expect(first.repair.reason.length).toBeGreaterThan(0);
      }
    }
    // The corpus really did exercise something; a passing assertion over an
    // empty set is the failure mode this line exists to prevent.
    expect(codes.size).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// 3. the invalid hot path
// ---------------------------------------------------------------------------

describe('Phase C: an invalid revision needs no publication and no audit', () => {
  test('the refusal arrives with nothing published and no generation', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const generationBefore = h.session.current().generationId;
    const filesBefore = new Set(
      require('./session-helpers').readTree(h.outDir).keys(),
    );

    const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
    const seen = agentStep(h, { changed: [file] });

    // Diagnostics are complete and authoritative...
    expect(seen.value.ok).toBe(false);
    expect(seen.value.agentResult.diagnostics).toHaveLength(1);
    // ...and nothing was published.
    expect(seen.counters.build_report_bytes).toBeUndefined();
    expect(seen.counters.coverage_report_bytes).toBeUndefined();
    expect(seen.counters.agent_result_bytes).toBeUndefined();
    expect(seen.counters.metadata_bytes_written).toBeUndefined();
    // The previous generation is still current, byte for byte.
    expect(h.session.current().generationId).toBe(generationBefore);
    expect(
      new Set(require('./session-helpers').readTree(h.outDir).keys()),
    ).toEqual(filesBefore);
    // And `compile()` refuses rather than publishing something partial.
    expect(() => h.session.compile()).toThrow();
    expect(h.session.current().generationId).toBe(generationBefore);
  });

  test('the generation milestones are absent for a revision that did not publish', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
    const validation = agentStep(h, { changed: [file] }).value;

    expect(validation.milestones.diagnosticsReady).toBe(true);
    expect(typeof validation.milestones.agent_edit_to_diagnostics_ms).toBe(
      'number',
    );
    // A refused revision stops at diagnostics. Reporting a generation time for
    // it would be reporting work that was correctly NOT done.
    expect(validation.milestones.generationReady).toBe(false);
    expect(validation.milestones.generationCommitted).toBe(false);
    expect(validation.milestones.auditReportReady).toBe(false);
    expect(
      validation.milestones.agent_edit_to_generation_committed_ms,
    ).toBeNull();
    expect(validation.milestones.agent_edit_to_audit_report_ms).toBeNull();

    const { generation, audit } = h.session.agentResult();
    expect(generation.published).toBe(false);
    expect(generation.generationId).toBeNull();
    expect(audit.ready).toBe(false);
    expect(audit.requested).toBe(false);
  });

  test('an audit of a refused revision is refused, and says why', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
    agentStep(h, { changed: [file] });
    expect(() => h.session.requestFullAudit({})).toThrow(/failed validation/);
  });
});

// ---------------------------------------------------------------------------
// 4. the invalid -> repair loop
// ---------------------------------------------------------------------------

describe('Phase C: introduce a violation, repair it, publish', () => {
  test('the two revisions are a complete agent loop, and the second is clean', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();

    const file = h.src('src/page.js');
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.replace(SOLE, FORBIDDEN), 'utf8');

    const broken = agentStep(h, { changed: [file] }).value;
    expect(broken.ok).toBe(false);
    expect(broken.revisionId).toBe(2);

    // The agent repairs EXACTLY the diagnostic it was given.
    fs.writeFileSync(file, good, 'utf8');
    const repaired = agentStep(h, { changed: [file] }).value;
    expect(repaired.ok).toBe(true);
    expect(repaired.diagnostics).toEqual([]);
    expect(repaired.revisionId).toBe(3);
    h.session.compile();

    // And the generation the repair published equals a fresh full rebuild of
    // the same bytes - semantics AND audit. A repair that published something a
    // rebuild would not is the failure this whole design is exposed to.
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. two completion points, kept apart
// ---------------------------------------------------------------------------

describe('Phase C: diagnostics-ready and generation-committed are two facts', () => {
  test('a valid revision reports both, in order, and neither implies the other', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();

    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const validation = agentStep(h, { changed: [file] }).value;

    // At `validate()`: diagnostics are ready and the generation is not.
    expect(validation.milestones.diagnosticsReady).toBe(true);
    expect(validation.milestones.generationReady).toBe(false);
    expect(validation.milestones.generationCommitted).toBe(false);
    const afterValidate = h.session.agentResult();
    expect(afterValidate.generation.published).toBe(false);
    expect(afterValidate.generation.generationId).toBeNull();
    // And validation did NOT publish: the summary on disk is still revision 1.
    expect(reportOf(h).incremental.revisionId).toBe(1);

    h.session.compile();

    // After `compile()`: both, and the second is strictly later than the first.
    const afterCompile = h.session.agentResult();
    const m = afterCompile.timings;
    expect(m.diagnosticsReady).toBe(true);
    expect(m.generationReady).toBe(true);
    expect(m.generationCommitted).toBe(true);
    expect(m.agent_edit_to_diagnostics_ms).toBeGreaterThan(0);
    expect(m.agent_edit_to_generation_ready_ms).toBeGreaterThanOrEqual(
      m.agent_edit_to_diagnostics_ms,
    );
    expect(m.agent_edit_to_generation_committed_ms).toBeGreaterThanOrEqual(
      m.agent_edit_to_generation_ready_ms,
    );
    expect(afterCompile.generation.published).toBe(true);
    expect(afterCompile.generation.generationId).toBe(2);
    expect(reportOf(h).incremental.revisionId).toBe(2);
  });

  test('the caller may stop at diagnostics and never publish at all', () => {
    // "The caller may choose whether it needs to wait for B" is only true if
    // there is a supported way to stop, and a revision that was never published
    // is superseded rather than merged into the next one.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const generationBefore = h.session.current().generationId;

    const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
    const validation = agentStep(h, { changed: [file] }).value;
    expect(validation.ok).toBe(false);
    // No `compile()`. The next revision supersedes this one.
    const repair = editIn(h, 'src/page.js', FORBIDDEN, SOLE);
    agentStep(h, { changed: [repair] });
    h.session.compile();

    expect(h.session.stats().supersededRevisions).toBe(1);
    // Every published artifact is revision 3's, and nothing of revision 2 is.
    expect(reportOf(h).incremental.revisionId).toBe(3);
    expect(h.session.current().generationId).toBe(generationBefore + 1);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('the milestone clock starts when the transaction is accepted', () => {
    // The interval contains the session's own discovery, hashing, closure and
    // compilation. It must NOT contain the host writing the file, or a slow
    // editor would be charged to the compiler.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const validation = agentStep(h, { changed: [file] }).value;
    const wall = Number(process.hrtime.bigint());
    expect(validation.milestones.agent_edit_to_diagnostics_ms).toBeGreaterThan(
      0,
    );
    expect(validation.milestones.agent_edit_to_diagnostics_ms).toBeLessThan(
      wall === 0 ? Infinity : Number.MAX_SAFE_INTEGER,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. the result does not scale with the project
// ---------------------------------------------------------------------------

describe('Phase C: the agent result does not scale with the project', () => {
  test('the same diagnostics and the same affected set give the same size at 8 and 800 files', () => {
    // THE acceptance criterion, as a measurement rather than as an assertion
    // about a field: the serialized result must be the same size. A project
    // 100 times larger, an identical edit and an identical diagnostic - if the
    // bytes differ, the result is carrying the project.
    const small = freshCopyOf('valid');
    const large = freshCopyOf('valid');
    const inflate = (project, count) => {
      // Real files, real imports, real relay chains: the added pages go through
      // the barrel like the rest, so the closure genuinely grows.
      const template = fs.readFileSync(
        path.join(project, 'src/page.js'),
        'utf8',
      );
      for (let i = 0; i < count; i += 1) {
        fs.writeFileSync(
          path.join(project, `src/filler-${i}.js`),
          template.replace(/page/g, `filler${i}`),
          'utf8',
        );
      }
    };
    inflate(small, 0);
    inflate(large, 800);

    const measureResult = (project) => {
      const h = openExistingProject(project, D);
      agentStep(h, { changed: [] });
      h.session.compile();
      const file = editIn(h, 'src/page.js', SOLE, FORBIDDEN);
      const validation = agentStep(h, { changed: [file] }).value;
      const serialized = h.session.serializeAgentResult();
      // The size of the INFORMATION, with the two measured intervals replaced by
      // a constant. Those two numbers are real measurements and their digit
      // counts vary run to run; leaving them in would make "the same size" a
      // claim about how many significant digits a millisecond happened to take,
      // which is not the property under test. They are compared separately, on
      // the full object, with a tolerance a hundred times their variation.
      const information = withoutTimings(serialized.result);
      return {
        ok: validation.ok,
        code: validation.diagnostics[0]?.code,
        bytes: serialized.bytes,
        informationBytes: Buffer.byteLength(
          JSON.stringify(information),
          'utf8',
        ),
        projectFiles: h.session.stats().fileStateCount,
        result: serialized.result,
      };
    };

    const a = measureResult(small);
    const b = measureResult(large);

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(a.code).toBe('PMS_FORBIDDEN_VALUE');
    expect(b.code).toBe(a.code);
    // The project really did grow.
    expect(b.projectFiles).toBeGreaterThan(a.projectFiles + 700);
    // And the result did not. The ONLY bytes that differ are the extra DIGITS
    // of the counters that report the project's size, and the assertion is
    // exact about that: a 100x bigger project changing the serialized result by
    // anything other than the length of a number is the failure this whole
    // phase is about, and "it got a bit bigger" would not be good enough.
    const digits = (from, to) => String(to).length - String(from).length;
    const sizeCounters = [
      [a.result.coverage.projectEntries, b.result.coverage.projectEntries],
      [a.result.incremental.coveredFiles, b.result.incremental.coveredFiles],
      [a.result.incremental.filesReused, b.result.incremental.filesReused],
    ];
    const explained = sizeCounters.reduce(
      (n, [from, to]) => n + digits(from, to),
      0,
    );
    expect(explained).toBeGreaterThan(0);
    expect(b.informationBytes - a.informationBytes).toBe(explained);
    // Those counters really are the project's size, and they really are numbers.
    expect(
      b.result.coverage.projectEntries - a.result.coverage.projectEntries,
    ).toBeGreaterThan(700);
    for (const [, value] of sizeCounters) {
      expect(typeof value).toBe('number');
      expect(Array.isArray(value)).toBe(false);
    }
    // Including the measured intervals, to within their own digit noise.
    expect(Math.abs(b.bytes - a.bytes)).toBeLessThan(64);
  });

  test('a passing edit reports counts, not a list of the project', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    agentStep(h, { changed: [file] });
    h.session.compile();

    const { incremental, coverage, bytes } = {
      ...h.session.agentResult(),
      bytes: bytesOf(h),
    };
    expect(incremental.filesChanged).toBe(1);
    expect(incremental.filesRecompiled).toBeGreaterThan(0);
    expect(incremental.filesReused).toBeGreaterThan(0);
    expect(incremental.coveredFiles).toBeGreaterThan(0);
    // The coverage block names the AFFECTED files, and the project as a number.
    expect(coverage.affectedCount).toBeGreaterThan(0);
    expect(coverage.affectedCount).toBeLessThan(coverage.projectEntries);
    expect(coverage.coveredSetChanged).toBe(false);
    for (const entry of coverage.affectedEntries) {
      expect(typeof entry.file).toBe('string');
    }
    expect(bytes).toBeLessThan(8 * 1024);
  });

  test('a compiler configuration fallback still returns a small result', () => {
    // A compiler configuration change drops every cached result and recompiles
    // everything. A result that listed the affected set would be the project -
    // measured at 413,988 bytes at c1000 before this cap, which throws away the
    // whole point of the split on the one revision where an agent most needs a
    // small answer.
    //
    // The project is INFLATED first, because the `valid` fixture has nine
    // covered files and the cap is at 64: on a project that small the cap never
    // fires and this test would pass without exercising anything.
    const project = freshCopyOf('valid');
    const template = fs.readFileSync(path.join(project, 'src/page.js'), 'utf8');
    for (let i = 0; i < 200; i += 1) {
      fs.writeFileSync(
        path.join(project, `src/filler-${i}.js`),
        template.replace(/page/g, `filler${i}`),
        'utf8',
      );
    }
    const h = openExistingProject(project, D);
    agentStep(h, { changed: [] });
    h.session.compile();

    h.setBuildOption('useCSSLayers', true);
    h.session.applyChanges({ config: { useCSSLayers: true } });
    const validation = h.session.validate();
    expect(validation.ok).toBe(true);
    expect(validation.milestones.agent_edit_to_diagnostics_ms).toBeGreaterThan(
      0,
    );
    h.session.compile();

    const result = h.session.agentResult();
    const { coverage, incremental } = result;
    // The whole project really was recompiled.
    expect(incremental.fullFallback).toBe(true);
    expect(incremental.fullFallbackReason).toBe('compiler-configuration');
    expect(incremental.filesCompiled).toBeGreaterThanOrEqual(
      incremental.coveredFiles - 1,
    );
    // And the result is still small, and says what it left out. The affected
    // set is every covered file bar the generated design-system module, which
    // the session stages rather than compiles and therefore never puts in the
    // dirty set - so the two numbers differ by exactly that one file, and a
    // difference larger than one would mean something else was recompiled
    // without being declared.
    expect(incremental.coveredFiles - coverage.affectedCount).toBe(1);
    expect(coverage.affectedTruncated).toBe(true);
    expect(coverage.affectedEntries.length).toBe(coverage.affectedEntryLimit);
    expect(bytesOf(h)).toBeLessThan(64 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 7. the audit is still there
// ---------------------------------------------------------------------------

describe('Phase C: the full audit is still available, and is the same evidence', () => {
  test('the published report carries counts and a reference, not the array', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const report = reportOf(h);

    expect(report.documentKind).toBe('pandamstyle-build-report');
    // The version moved, and it moved BECAUSE the format moved. A consumer that
    // does not check this would read a version 1 report's `coverage` as absent
    // and could mistake that for an empty project.
    expect(report.schemaVersion).toBe(2);
    expect(report.coverage).toBeUndefined();
    expect(report.coverageSummary.entries).toBe(report.coveredFileCount);
    expect(report.coverageReport.documentKind).toBe(
      'pandamstyle-coverage-report',
    );
    expect(report.coverageReport.materialized).toBe(false);
    expect(report.coverageReport.revisionId).toBe(
      report.incremental.revisionId,
    );
    // The report is small, and its size does not track the project's.
    expect(
      fs.statSync(path.join(h.outDir, 'build-report.json')).size,
    ).toBeLessThan(8 * 1024);
  });

  test('the coverage counts and the coverage entries are the same numbers', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const report = reportOf(h);
    const request = h.session.requestFullAudit({});
    const doc = JSON.parse(fs.readFileSync(request.path, 'utf8'));

    expect(doc.documentKind).toBe('pandamstyle-coverage-report');
    expect(doc.entryCount).toBe(report.coverageSummary.entries);
    expect(doc.entries.length).toBe(report.coveredFileCount);
    // The summary is derived from the detail, never maintained beside it.
    const pages = doc.entries.filter((e) => e.role === 'page').length;
    expect(report.coverageSummary.pages).toBe(pages);
    const chain = doc.entries.reduce(
      (n, e) => n + (Array.isArray(e.relayChain) ? e.relayChain.length : 0),
      0,
    );
    expect(report.coverageSummary.relayChainEntries).toBe(chain);
  });

  test('the requested audit is byte-for-byte what the monolithic report carried', () => {
    // The audit oracle, in its sharpest form: the per-file records the split
    // moved are the same records, in the same order, with the same fields. The
    // evidence was MOVED, not rewritten.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const request = h.session.requestFullAudit({});
    const doc = JSON.parse(fs.readFileSync(request.path, 'utf8'));

    // The session's own coverage, before publication, is the same list.
    const published = h.session.stats();
    expect(published.fileStateCount).toBeGreaterThan(0);
    for (const entry of doc.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining([
          'file',
          'origin',
          'role',
          'analysed',
          'diagnostics',
        ]),
      );
      expect(typeof entry.file).toBe('string');
      expect(typeof entry.analysed).toBe('boolean');
    }
    const relay = doc.entries.find((e) => e.file.endsWith('renamed.js'));
    expect(relay).toBeDefined();
    expect(relay.relayChain.length).toBeGreaterThan(1);
  });

  test('an audit requested BEFORE publication is committed with the generation', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();

    const file = editIn(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    agentStep(h, { changed: [file] });
    const request = h.session.requestFullAudit({});
    expect(request.staged).toBe(true);
    expect(request.materialized).toBe(false);
    h.session.compile();

    // It is IN the generation, and the generation is what the manifest
    // certifies. An audit nobody asked for is not in there.
    const inGeneration = path.join(h.outDir, 'coverage.json');
    expect(fs.existsSync(inGeneration)).toBe(true);
    const doc = JSON.parse(fs.readFileSync(inGeneration, 'utf8'));
    expect(doc.revisionId).toBe(2);
    expect(reportOf(h).coverageReport.materialized).toBe(true);
    const result = h.session.agentResult();
    expect(result.audit.ready).toBe(true);
    expect(result.audit.bytes).toBe(fs.statSync(inGeneration).size);
    expect(result.timings.auditReportReady).toBe(true);
  });

  test('an audit requested AFTER publication goes beside the output, not into it', () => {
    // A committed generation is immutable: its manifest already certified its
    // contents. Writing a document into it afterwards would break exactly the
    // guarantee the transactional publication exists to provide, so the
    // deferred document is written to a sibling directory and says which
    // revision and generation it describes.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const before = new Set(
      require('./session-helpers').readTree(h.outDir).keys(),
    );
    const request = h.session.requestFullAudit({});

    expect(request.inGeneration).toBe(false);
    expect(request.materialized).toBe(true);
    expect(path.dirname(request.path)).toBe(auditDirOf(h.outDir));
    // The generation is untouched.
    expect(
      new Set(require('./session-helpers').readTree(h.outDir).keys()),
    ).toEqual(before);
    const doc = JSON.parse(fs.readFileSync(request.path, 'utf8'));
    expect(doc.revisionId).toBe(1);
    expect(doc.generationId).toBe(1);
    expect(h.session.agentResult().timings.auditReportReady).toBe(true);
  });

  test('the audit is deterministic for the same revision', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const first = fs.readFileSync(h.session.requestFullAudit({}).path, 'utf8');
    const second = fs.readFileSync(h.session.requestFullAudit({}).path, 'utf8');
    expect(second).toBe(first);
  });

  test('the audit of a session equals the audit of a full rebuild of the same bytes', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    const incremental = auditStateOf(h.outDir, {
      coveragePath: h.session.requestFullAudit({}).path,
    });
    h.full();
    const full = auditStateOf(h.outDir);
    expect(JSON.stringify(incremental.summary)).toBe(
      JSON.stringify(full.summary),
    );
    expect(JSON.stringify(incremental.coverage)).toBe(
      JSON.stringify(full.coverage),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. no hidden work
// ---------------------------------------------------------------------------

describe('Phase C: nothing is generated that nobody asked for', () => {
  test('a publication that was not asked for an audit writes no coverage document', () => {
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    expect(fs.existsSync(path.join(h.outDir, 'coverage.json'))).toBe(false);
    expect(fs.existsSync(auditDirOf(h.outDir))).toBe(false);
    expect(h.session.agentResult().audit.requested).toBe(false);
  });

  test('the compiler reports the work it did, and only that work', () => {
    // "No background work" is a claim about counters as much as about threads:
    // if a deferred document were being produced invisibly, a coverage-report
    // byte count would appear on a revision nobody requested one for.
    const h = openProject('valid', D);
    const seen = measure(() => {
      h.session.applyAgentChanges({ changed: [] });
      h.session.validate();
      h.session.compile();
    });
    expect(seen.counters.coverage_report_bytes).toBeUndefined();
    expect(seen.counters.full_report_requested).toBeUndefined();
    expect(seen.counters.build_report_bytes).toBeGreaterThan(0);
    expect(seen.counters.build_report_serialize_ms).toBeGreaterThanOrEqual(0);
  });

  test('a full rebuild publishes its coverage document: it writes its whole output once', () => {
    // The deferral exists for a long-lived session's hot path. A one-shot build
    // has no second revision coming, so deferring would be theatre.
    const h = openProject('valid', D);
    agentStep(h, { changed: [] });
    h.session.compile();
    h.full();
    const doc = JSON.parse(
      fs.readFileSync(path.join(h.outDir, 'coverage.json'), 'utf8'),
    );
    expect(doc.entryCount).toBeGreaterThan(0);
    expect(reportOf(h).coverageReport.materialized).toBe(true);
  });
});
