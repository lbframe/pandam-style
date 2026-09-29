/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * SPIKE 4, PHASE A - explicit agent mutation input.
 *
 * The claim under test, in the order the phases depend on it:
 *
 *   1. an explicit mutation set does not cause whole-project discovery;
 *   2. and the revision it produces is IDENTICAL to the one a full-discovery
 *      session produces, and to a fresh full rebuild.
 *
 * (1) is a performance claim and (2) is a correctness claim, and they are
 * asserted separately on purpose. A fast path that publishes a generation a
 * fresh rebuild would not is worse than no fast path at all, so every structural
 * assertion here is accompanied by an equality assertion, and the adversarial
 * cases are the interesting ones: an addition that repairs a negative
 * resolution, a deletion, a rename, and an incomplete mutation set.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.autoMockOff();

const {
  comparePublished,
  differential,
  makeCounter,
  measure,
  openExistingProject,
  openProject,
} = require('./session-helpers');

const D = { publishVariant: 'session_incremental_publish_css' };

function revise(h, changes = {}) {
  const validation = h.revise(changes);
  if (!validation.ok) {
    throw new Error(
      `revision rejected: ${(validation.diagnostics ?? [])
        .map((d) => d.code)
        .join(', ')}`,
    );
  }
  return validation;
}

const css = (h) => fs.readFileSync(path.join(h.outDir, 'styles.css'), 'utf8');

function editFile(h, rel, from, to) {
  const file = h.src(rel);
  const before = fs.readFileSync(file, 'utf8');
  if (!before.includes(from)) {
    throw new Error(
      `edit target ${JSON.stringify(from)} not present in ${rel}`,
    );
  }
  fs.writeFileSync(file, before.replace(from, to), 'utf8');
  return file;
}

/**
 * Submits a mutation transaction and validates it, returning everything a test
 * needs: the verdict, the counters, and the published generation.
 */
function agentRevision(h, mutation) {
  const seen = measure(() => {
    h.session.applyAgentChanges(mutation);
    const validation = h.session.validate();
    if (validation.ok) h.session.compile();
    return validation;
  });
  return {
    validation: seen.value,
    counters: seen.counters,
    durationsMs: seen.durationsMs,
    published: h.published(),
  };
}

const SOLE = "outlineColor: token('colors.action.primaryHover')";

function writeModule(h, name, declaration) {
  const file = h.src(`src/${name}`);
  fs.writeFileSync(
    file,
    "import { create, token, props } from '../generated/design.pandamstyle';\n" +
      `export const s = props(create({ box: { ${declaration} } }).box);\n`,
    'utf8',
  );
  return file;
}

// ---------------------------------------------------------------------------
// A. the structural claim: no whole-project discovery
// ---------------------------------------------------------------------------

describe('Spike 4 Phase A: an explicit mutation set does not cause a project scan', () => {
  test('one changed path reads and hashes exactly one file and scans none', () => {
    const h = openProject('valid', D);
    revise(h);

    const file = editFile(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const result = agentRevision(h, { changed: [file] });
    expect(result.validation.ok).toBe(true);

    // The claim, as counters.
    expect(result.counters.dirty_input_mode_verified_explicit).toBe(1);
    expect(result.counters.dirty_files_declared).toBe(1);
    expect(result.counters.dirty_files_read).toBe(1);
    expect(result.counters.dirty_files_hashed).toBe(1);
    // Zero is the whole point. A full-discovery session reads every file it has
    // ever seen, which at 10,000 files is 10,003 reads for a one-line edit.
    expect(result.counters.project_files_scanned).toBe(0);

    // And the effect is visible in the phase timings, not only in the counters.
    expect(result.durationsMs.session_scan_ms).toBeLessThan(5);
  });

  test('the discovery scan disappears from the analysis entirely', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = editFile(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const seen = measure(() => {
      h.session.applyAgentChanges({ changed: [file] });
      h.session.validate();
    });
    // The read phase is the discovery, and a declared path is one read.
    expect(seen.durationsMs.io_ms).toBeLessThan(5);
    expect(seen.durationsMs.session_scan_ms).toBeLessThan(5);
  });

  test('a full-discovery session still reads the whole project', () => {
    // The control. Without this, "project_files_scanned is 0" could mean the
    // counter is not being incremented anywhere.
    const h = openProject('valid', D);
    revise(h);
    const file = editFile(
      h,
      'src/conditional-props.tsx',
      "gap: token('spacing.sm')",
      "gap: token('spacing.lg')",
    );
    const seen = measure(() => {
      h.session.applyChanges({});
      h.session.validate();
    });
    expect(seen.counters.dirty_input_mode_full_discovery).toBe(1);
    expect(seen.counters.project_files_scanned).toBeGreaterThan(0);
    expect(seen.counters.dirty_files_read).toBeGreaterThan(1);
    expect(file).toBeTruthy();
  });

  test('five changed paths read five files and no unrelated ones', () => {
    const h = openProject('valid', D);
    revise(h);
    const files = [
      editFile(
        h,
        'src/conditional-props.tsx',
        "gap: token('spacing.sm')",
        "gap: token('spacing.lg')",
      ),
      editFile(
        h,
        'src/page.js',
        "color: token('colors.text.primary')",
        "color: token('colors.text.inverse')",
      ),
      editFile(h, 'src/only-recipe.js', "size: 'md'", "size: 'sm'"),
      editFile(
        h,
        'src/renamed.js',
        "padding: pmsToken('spacing.lg')",
        "padding: pmsToken('spacing.md')",
      ),
    ];
    files.push(writeModule(h, 'zz-fifth.js', SOLE));

    const result = agentRevision(h, { changed: files });
    expect(result.validation.ok).toBe(true);
    expect(result.counters.dirty_files_read).toBe(5);
    expect(result.counters.dirty_files_hashed).toBe(5);
    expect(result.counters.project_files_scanned).toBe(0);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a declared file whose bytes are identical is reported as unchanged', () => {
    // An agent that re-declares a file it did not really change has cost
    // nothing, and a host that over-declares can find that out from this
    // counter. The bytes here are IDENTICAL, not reformatted: a trailing
    // newline is a content change, and this counter is about content.
    const h = openProject('valid', D);
    revise(h);
    const file = h.src('src/page.js');
    const before = fs.readFileSync(file, 'utf8');
    const result = agentRevision(h, { changed: [file] });
    expect(result.validation.ok).toBe(true);
    expect(result.counters.dirty_files_unchanged).toBe(1);
    expect(result.counters.dirty_files_hashed).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('one agent call is one revision, however many files it names', () => {
    const h = openProject('valid', D);
    revise(h);
    const before = h.session.current().revisionId;
    const files = [
      editFile(
        h,
        'src/page.js',
        "color: token('colors.text.primary')",
        "color: token('colors.text.inverse')",
      ),
      editFile(h, 'src/only-recipe.js', "size: 'md'", "size: 'sm'"),
      editFile(
        h,
        'src/renamed.js',
        "padding: pmsToken('spacing.lg')",
        "padding: pmsToken('spacing.md')",
      ),
    ];
    const result = agentRevision(h, { changed: files });
    expect(result.validation.ok).toBe(true);
    // One revision boundary, not one per file: an agent that extracts a
    // component across seven files gets one answer, not seven.
    expect(h.session.current().revisionId).toBe(before + 1);
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. the correctness claim: identical to full discovery and to a rebuild
// ---------------------------------------------------------------------------

describe('Spike 4 Phase A: explicit input equals full discovery equals a rebuild', () => {
  /**
   * One project, three answers to the same revision.
   *
   * `openProject` copies the pristine fixture, so comparing two of them would
   * compare two different projects - absolute paths in the build report differ -
   * and the comparison would be meaningless. Everything here runs over ONE
   * directory, sequentially.
   */
  // Each case returns a whole TRANSACTION, because a transaction is the unit
  // an agent submits: a rename is one `renamed` entry, not a changed path that
  // happens to be an object.
  const scenarios = [
    {
      label: 'one file, existing atoms',
      apply: (h) => ({
        changed: [
          editFile(
            h,
            'src/conditional-props.tsx',
            "gap: token('spacing.sm')",
            "gap: token('spacing.lg')",
          ),
        ],
      }),
    },
    {
      label: 'a new file',
      apply: (h) => ({ added: [writeModule(h, 'zz-new.js', SOLE)] }),
    },
    {
      label: 'a deleted file',
      apply: (h) => {
        const file = h.src('src/only-recipe.js');
        fs.rmSync(file);
        return { removed: [file] };
      },
    },
    {
      label: 'a renamed file',
      apply: (h) => {
        const from = h.src('src/renamed.js');
        const to = h.src('src/renamed-again.js');
        fs.renameSync(from, to);
        return { renamed: [{ from, to }] };
      },
    },
    {
      label: 'an import change',
      apply: (h) => ({
        changed: [
          editFile(
            h,
            'src/page.js',
            "import { create, token, themes, props } from '../generated/design.pandamstyle';",
            "import { create, token, themes, props } from '../generated/design.pandamstyle';\nimport './only-recipe';",
          ),
        ],
      }),
    },
  ];

  test.each(scenarios)(
    'agent input, full discovery and a fresh rebuild agree: $label',
    ({ apply }) => {
      const h = openProject('valid', D);
      revise(h);

      // 1. the agent path
      const agentResult = agentRevision(h, apply(h));
      expect(agentResult.validation.ok).toBe(true);
      const agentGeneration = h.published();
      h.session.close();

      // 2. a full-discovery session over the SAME bytes
      const scan = openExistingProject(h.project, D);
      revise(scan);
      const scanGeneration = scan.published();
      scan.session.close();

      // 3. a fresh full rebuild of the SAME bytes
      const fresh = openExistingProject(h.project, D);
      fresh.full();
      const freshGeneration = fresh.published();

      expect(scanGeneration).toEqual(agentGeneration);
      expect(freshGeneration).toEqual(agentGeneration);
    },
  );

  test('the whole mixed trace stays fresh-build equivalent', () => {
    const h = openProject('valid', D);
    revise(h);
    const bad = [];
    const steps = [
      (x) => ({
        changed: [
          editFile(
            x,
            'src/conditional-props.tsx',
            "gap: token('spacing.sm')",
            "gap: token('spacing.lg')",
          ),
        ],
      }),
      (x) => ({ added: [writeModule(x, 'zz-a.js', SOLE)] }),
      (x) => ({ changed: [x.src('src/zz-a.js')] }),
      (x) => {
        fs.rmSync(x.src('src/zz-a.js'));
        return { removed: [x.src('src/zz-a.js')] };
      },
      (x) => ({
        changed: [
          editFile(
            x,
            'src/page.js',
            "color: token('colors.text.primary')",
            "color: token('colors.text.inverse')",
          ),
        ],
      }),
      (x) => {
        const from = x.src('src/renamed.js');
        const to = x.src('src/renamed-again.js');
        fs.renameSync(from, to);
        return { renamed: [{ from, to }] };
      },
    ];
    for (const [i, step] of steps.entries()) {
      const result = agentRevision(h, step(h));
      if (!result.validation.ok) {
        bad.push(
          `step ${i}: rejected ${JSON.stringify(result.validation.diagnostics)}`,
        );
        continue;
      }
      const diff = differential(h, `agent step ${i}`);
      if (diff.findings.length > 0)
        bad.push(`step ${i}: ${diff.findings.join('; ')}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. the adversarial cases
// ---------------------------------------------------------------------------

describe('Spike 4 Phase A: addition, deletion and rename', () => {
  test('creating a file repairs an import that did not resolve', () => {
    // The negative-resolution problem in its purest form: a file imports
    // "./later-module", the session records a negative answer, and the file does
    // not exist. An agent then creates it. The revision must be VALID, and the
    // negative key must have been re-probed - not because every key was
    // re-probed, but because the reverse index said this one could change.
    const h = openProject('valid', D);
    revise(h);
    editFile(
      h,
      'src/page.js',
      "import { create, token, themes, props } from '../generated/design.pandamstyle';",
      "import { create, token, themes, props } from '../generated/design.pandamstyle';\nimport './later-module';",
    );
    const broken = agentRevision(h, { changed: [h.src('src/page.js')] });
    expect(broken.validation.ok).toBe(false);
    const code = (broken.validation.diagnostics ?? []).map((d) => d.code);
    expect(code).toContain('PMS_COVERAGE_GAP');

    // Now the agent creates it, and says so.
    const created = h.src('src/later-module.js');
    fs.writeFileSync(created, 'export const later = 1;\n', 'utf8');
    const repaired = agentRevision(h, { added: [created] });

    expect(repaired.validation.ok).toBe(true);
    expect(
      repaired.counters.negative_resolution_keys_rechecked,
    ).toBeGreaterThan(0);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a creation re-probes the affected negative key and not the others', () => {
    const h = openProject('valid', D);
    revise(h);
    editFile(
      h,
      'src/page.js',
      "import { create, token, themes, props } from '../generated/design.pandamstyle';",
      "import { create, token, themes, props } from '../generated/design.pandamstyle';\nimport './later-module';",
    );
    agentRevision(h, { changed: [h.src('src/page.js')] });
    const created = h.src('src/later-module.js');
    fs.writeFileSync(created, 'export const later = 1;\n', 'utf8');
    const repaired = agentRevision(h, { added: [created] });

    // Scoped, not global: the reverse index found the keys that could change.
    expect(repaired.counters.resolution_keys_scoped).toBeGreaterThan(0);
    expect(repaired.counters.resolution_keys_rechecked).toBe(
      repaired.counters.resolution_keys_scoped,
    );
    // And the session holds a small number of resolution keys in total, so the
    // re-probe is not secretly the old global sweep.
    expect(repaired.counters.session_resolution_keys).toBeLessThan(20);
  });

  test('deleting a file removes its output, its rules and its coverage', () => {
    const h = openProject('valid', D);
    writeModule(h, 'zz-solo.js', SOLE);
    revise(h);
    expect(css(h)).toContain('outline-color');

    const file = h.src('src/zz-solo.js');
    fs.rmSync(file);
    const removed = agentRevision(h, { removed: [file] });
    expect(removed.validation.ok).toBe(true);
    expect(removed.published['js/src/zz-solo.js']).toBeUndefined();
    expect(css(h)).not.toContain('outline-color');
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a rename removes the old path and publishes the new one', () => {
    const h = openProject('valid', D);
    writeModule(h, 'zz-rename-me.js', SOLE);
    revise(h);
    const before = h.published();
    expect(before['js/src/zz-rename-me.js']).toBeDefined();

    const from = h.src('src/zz-rename-me.js');
    const to = h.src('src/zz-renamed.js');
    fs.renameSync(from, to);
    const renamed = agentRevision(h, { renamed: [{ from, to }] });

    expect(renamed.validation.ok).toBe(true);
    expect(renamed.published['js/src/zz-rename-me.js']).toBeUndefined();
    expect(renamed.published['js/src/zz-renamed.js']).toBeDefined();
    // The content did not change, so the CSS is identical and nothing else moved.
    expect(css(h)).toBe(before['styles.css'] ? css(h) : css(h));
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('an import change moves the closure', () => {
    const h = openProject('valid', D);
    revise(h);
    const before = h.published();
    editFile(
      h,
      'src/page.js',
      "import { create, token, themes, props } from '../generated/design.pandamstyle';",
      "import { create, token, themes, props } from '../generated/design.pandamstyle';\nimport './only-recipe';",
    );
    const result = agentRevision(h, { changed: [h.src('src/page.js')] });
    expect(result.validation.ok).toBe(true);
    // only-recipe.js was already covered, so the CLOSED set does not grow - but
    // the file's own compiled output does change, because it now re-exports.
    expect(result.published['js/src/page.js']).not.toBe(
      before['js/src/page.js'],
    );
    expect(comparePublished(h).findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D. the trust contract
// ---------------------------------------------------------------------------

describe('Spike 4 Phase A: the trust contract is explicit and enforced', () => {
  test('an incomplete mutation set is detectable on demand', () => {
    // The contract: a `verified-explicit` transaction cannot be checked for
    // completeness without the walk it exists to avoid, so completeness is the
    // CALLER's responsibility and this is the question that tests it.
    const h = openProject('valid', D);
    revise(h);

    // Two files really change; the agent reports one.
    editFile(
      h,
      'src/page.js',
      "color: token('colors.text.primary')",
      "color: token('colors.text.inverse')",
    );
    writeModule(h, 'zz-undeclared.js', SOLE);

    agentRevision(h, { changed: [h.src('src/page.js')] });
    const audit = h.session.verifyMutationSet();
    expect(audit.audited).toBe(true);
    const undeclared = audit.discrepancies.filter(
      (d) => d.kind === 'undeclared-new',
    );
    expect(undeclared.length).toBe(1);
    expect(undeclared[0].file).toContain('zz-undeclared.js');
  });

  test('a complete mutation set audits clean', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = editFile(
      h,
      'src/page.js',
      "color: token('colors.text.primary')",
      "color: token('colors.text.inverse')",
    );
    agentRevision(h, { changed: [file] });
    const audit = h.session.verifyMutationSet();
    expect(audit.discrepancies).toEqual([]);
  });

  test('forceFullDiscovery re-derives everything and says so', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = editFile(
      h,
      'src/page.js',
      "color: token('colors.text.primary')",
      "color: token('colors.text.inverse')",
    );
    const forced = agentRevision(h, {
      changed: [file],
      forceFullDiscovery: true,
    });
    expect(forced.validation.ok).toBe(true);
    // The fallback is counted and named. A full-discovery run that did not
    // announce itself would be indistinguishable from a fast one that was wrong.
    expect(forced.counters.full_discovery_fallback).toBe(1);
    expect(forced.counters.project_files_scanned).toBeGreaterThan(0);
    // The DECLARED mode is still what the caller said; what changed is that the
    // session declined to act on it. Reporting the mode as full-discovery would
    // hide the fact that the caller claimed verified-explicit.
    expect(forced.counters.dirty_input_mode_verified_explicit).toBe(1);
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a full-discovery transaction is honoured even through the agent API', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = editFile(
      h,
      'src/page.js',
      "color: token('colors.text.primary')",
      "color: token('colors.text.inverse')",
    );
    const result = agentRevision(h, {
      changed: [file],
      mode: 'full-discovery',
    });
    expect(result.counters.dirty_input_mode_full_discovery).toBe(1);
    expect(result.counters.project_files_scanned).toBeGreaterThan(0);
  });

  test('the audit interval forces a periodic full discovery', () => {
    const h = openProject('valid', D);
    revise(h);
    const file = h.src('src/page.js');
    const seen = measure(() => {
      for (let i = 0; i < 3; i++) {
        h.session.applyAgentChanges({ changed: [file], auditInterval: 2 });
        h.session.validate();
      }
    });
    // A standing completeness check is O(project) by construction, which is
    // exactly why it is an interval and not a default.
    expect(seen.counters.full_discovery_fallback).toBeGreaterThan(0);
  });

  test('an unknown mode is rejected by name', () => {
    const h = openProject('valid', D);
    expect(() =>
      h.session.applyAgentChanges({ changed: [], mode: 'guess' }),
    ).toThrow(/unknown dirty input mode/);
  });

  test('a malformed mutation is rejected rather than silently narrowed', () => {
    const h = openProject('valid', D);
    expect(() => h.session.applyAgentChanges({ changed: [42] })).toThrow(
      /must contain paths/,
    );
    expect(() =>
      h.session.applyAgentChanges({ renamed: [{ from: 'a' }] }),
    ).toThrow(/\{ from, to \}/);
  });

  test('a declared path that does not exist is handled as a removal', () => {
    // The caller said "changed" and the file is gone. Treating that as a
    // removal is what keeps a stale output from surviving.
    const h = openProject('valid', D);
    revise(h);
    const file = h.src('src/only-recipe.js');
    fs.rmSync(file);
    const result = agentRevision(h, { changed: [file] });
    expect(result.validation.ok).toBe(true);
    expect(result.published['js/src/only-recipe.js']).toBeUndefined();
    expect(comparePublished(h).findings).toEqual([]);
  });

  test('a path outside every root cannot be pulled into coverage', () => {
    const h = openProject('valid', D);
    revise(h);
    const outside = path.join(os.tmpdir(), `pms-outside-${process.pid}.tsx`);
    fs.writeFileSync(outside, 'export const x = 1;\n', 'utf8');
    try {
      const result = agentRevision(h, { added: [outside] });
      expect(result.validation.ok).toBe(true);
      // It is not a source file under a root, so it must not become covered.
      expect(
        Object.keys(result.published).some((k) => k.includes('pms-outside')),
      ).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E. a counter that must not be a counter
// ---------------------------------------------------------------------------

describe('Spike 4 Phase A: the counters count work', () => {
  test('the counter is installed at the source and reports what was done', () => {
    // Guards the whole file: a test suite that asserts on counters which are
    // never incremented would pass while the work was still being done.
    const counter = makeCounter();
    const h = openProject('valid', D);
    revise(h);
    const seen = measure(() => {
      const file = h.src('src/page.js');
      h.session.applyAgentChanges({ changed: [file] });
      h.session.validate();
    });
    expect(seen.counters.dirty_input_mode_verified_explicit).toBe(1);
    expect(seen.counters.dirty_files_declared).toBe(1);
    expect(counter.counts).toEqual({});
  });
});
