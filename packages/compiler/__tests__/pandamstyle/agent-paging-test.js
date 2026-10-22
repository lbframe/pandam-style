/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * AG-01.1 views, pagination and response size (I5, I10, I11, T8, T14, T15,
 * BV-1).
 *
 * Every list with a total is read completely, exactly once and in order, by
 * following the response's own references. Every record kind is attacked with
 * an oversized value: the record is withheld whole, the response stays under
 * its ceiling, and `records.read` returns it byte for byte.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  compiler,
  continuationOf,
  definitionWith,
  follow,
  emptyMutation,
  openAgentProject,
  readRecord,
  readReferenced,
  request,
  sha256,
} = require('./agent-helpers');
const { openProject } = require('./session-helpers');

jest.setTimeout(180000);

const { REGISTRY, validateSchema, canonicalJson, recordInfo } = compiler;
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GENERATED = path.resolve(
  __dirname,
  '../../src/agent/generated/operations.d.ts',
);
const BIG = 'x'.repeat(1200000);
const HEADER =
  "import { create, token } from '../generated/design.pandamstyle';\n";

/** Responses recorded for the type check at the end of the suite. */
const recorded = [];

function record(name, response) {
  recorded.push([name, response]);
  return response;
}

/** The ceiling and schema checks every response must pass. */
function checkResponse(name, response) {
  record(name, response);
  expect(response.limits.responseBytes).toBe(
    Buffer.byteLength(JSON.stringify(response)),
  );
  expect(response.limits.responseBytes).toBeLessThanOrEqual(
    response.limits.maxResponseBytes,
  );
  expect(response.failure?.reason).not.toBe('unbounded-failure-record');
  expect(response.failure?.reason).not.toBe('output-schema-violation');
  expect(response.failure?.reason).not.toBe('response-over-ceiling');
  if (response.result != null)
    expect(
      validateSchema(REGISTRY.byName[name].output, response.result),
    ).toBeNull();
  if (response.result?.document != null) {
    const document = response.result.document;
    expect(document.documentKind).toBe('pandamstyle-diagnostics-result');
    expect(document.diagnosticsTruncated).toBe(
      document.diagnostics.length < document.diagnosticsTotal,
    );
  }
  if (response.result?.page != null) {
    expect(response.result.page.kind).toBe('pandamstyle-agent-page');
    expect(response.result.page.documentKind).toBeUndefined();
  }
  return response;
}

const writePages = (fixture, count, body, prefix = 'gen') => {
  for (let i = 0; i < count; i += 1)
    fs.writeFileSync(
      fixture.src(`src/${prefix}${String(i).padStart(3, '0')}.js`),
      HEADER + body(i),
    );
};
const forbidden = (i) =>
  `export const s${i} = create({ box: { padding: '${i + 1}px' } });\n`;
const clean = (i) =>
  `export const s${i} = create({ box: { padding: token('spacing.md') } });\n`;

/**
 * Reads a whole list by following the operation's paging, reading every
 * withheld record through `records.read`. Returns the records in order.
 */
async function readList(project, operation, input, view, limit) {
  const out = [];
  // Only the first request is built here. Every later page, and every
  // withheld record, is reached by following a reference the response
  // returned (R2).
  let request = {
    operation,
    view,
    input: { ...input, page: { offset: 0, limit } },
  };
  for (let guard = 0; guard < 10000; guard += 1) {
    const response = checkResponse(
      operation,
      await follow(project.dispatch, request),
    );
    expect(['success', 'constraint-violation']).toContain(response.outcome);
    const page = response.result.page ?? null;
    const records = page?.records ?? response.result.document.diagnostics;
    out.push(...records);
    for (const entry of response.withheld) {
      const reference = response.references.find(
        (item) =>
          item.operation === 'records.read' &&
          JSON.stringify(item.input.address) === JSON.stringify(entry.address),
      );
      expect(reference).toBeDefined();
      const read = await readReferenced(project.dispatch, reference);
      expect(read.sha256).toBe(entry.sha256);
      expect(read.text.length).toBe(entry.bytes);
      out.push(JSON.parse(read.text));
    }
    if (response.page.offset < response.page.total)
      expect(response.page.nextOffset ?? response.page.total).toBeGreaterThan(
        response.page.offset,
      );
    expect(response.page.truncated).toBe(response.page.nextOffset != null);
    request = continuationOf(
      response,
      request,
      response.page.nextOffset,
      response.page.limit,
    );
    if (request == null) return out;
  }
  throw new Error('paging did not terminate');
}

describe('AG-01.1 compact and detail (AC #8 required check)', () => {
  test('more than 20 error diagnostics: compact truncates with a reference, detail paging covers each exactly once', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => writePages(fixture, 27, forbidden),
    });
    try {
      const rev = await project.revision();
      const compact = checkResponse(
        'check',
        await project.dispatch('check', { rev }),
      );
      const document = compact.result.document;
      expect(compact.outcome).toBe('constraint-violation');
      expect(document.ok).toBe(false);
      expect(document.diagnosticsTotal).toBe(27);
      expect(document.diagnostics).toHaveLength(20);
      expect(document.diagnosticsTruncated).toBe(true);
      expect(compact.references).toContainEqual({
        operation: 'check',
        view: 'compact',
        input: { rev, page: { offset: 20, limit: 20 } },
      });
      // Followed as returned, the compact continuation completes the list.
      const compactFull = (
        await project.session.agentResult(rev, { candidateLimit: 8 })
      ).diagnostics;
      expect(await readList(project, 'check', { rev }, 'compact', 20)).toEqual(
        compactFull,
      );
      for (const diagnostic of document.diagnostics)
        expect(diagnostic.candidates.length).toBeLessThanOrEqual(8);

      const full = (
        await project.session.agentResult(rev, { candidateLimit: 32 })
      ).diagnostics;
      expect(full).toHaveLength(27);
      for (const limit of [1, 7, 256]) {
        const all = await readList(project, 'check', { rev }, 'detail', limit);
        expect(all).toEqual(full);
      }
      const later = checkResponse(
        'check',
        await project.dispatch(
          'check',
          { rev, page: { offset: 20, limit: 256 } },
          { view: 'detail' },
        ),
      );
      expect(later.result.document).toBeUndefined();
      expect(later.result.page).toMatchObject({
        list: 'diagnostics',
        offset: 20,
        total: 27,
      });
      // The outcome is the complete result's, whatever page is shown (I5).
      expect(later.outcome).toBe(compact.outcome);
      const past = checkResponse(
        'check',
        await project.dispatch(
          'check',
          { rev, page: { offset: 99, limit: 5 } },
          { view: 'detail' },
        ),
      );
      expect(past.page).toEqual({
        offset: 99,
        limit: 5,
        returned: 0,
        nextOffset: null,
        total: 27,
        truncated: false,
      });
      expect(past.outcome).toBe('constraint-violation');
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 exhaustive paging of every list kind (I10, T15)', () => {
  async function affectedEverywhere(project, rev, expectedTotal) {
    const document = (await project.dispatch('check', { rev })).result.document;
    expect(document.affected.total).toBe(expectedTotal);
    for (const [view, limit] of [
      ['compact', 1],
      ['compact', 7],
      ['detail', 256],
    ]) {
      const all = await readList(
        project,
        'diagnostics.affected',
        { rev },
        view,
        limit,
      );
      expect(all).toHaveLength(expectedTotal);
      const files = all.map((entry) => entry.file);
      expect(new Set(files).size).toBe(files.length);
      expect([...files].sort()).toEqual(files);
    }
    const past = checkResponse(
      'diagnostics.affected',
      await project.dispatch('diagnostics.affected', {
        rev,
        page: { offset: expectedTotal + 3, limit: 4 },
      }),
    );
    expect(past.result.page.records).toEqual([]);
    expect(past.page.truncated).toBe(false);
    return readList(project, 'diagnostics.affected', { rev }, 'detail', 256);
  }

  test('affected: 89 on a valid revision, 70 removed, 81 on an invalid one, 0 on a definition failure', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => writePages(fixture, 80, clean),
    });
    try {
      const rev1 = await project.revision();
      const all = await affectedEverywhere(project, rev1, 89);
      expect(all.every((entry) => entry.removed === false)).toBe(true);
      // The inline v1 list is still cut at 64 by the session, untouched.
      const sdk = await project.session.agentResult(rev1);
      expect(sdk.affected.entries).toHaveLength(64);
      expect(sdk.affected.total).toBe(89);

      // 70 removed files: role null, removed true.
      const removed = [];
      for (let i = 0; i < 70; i += 1) {
        const file = `src/gen${String(i).padStart(3, '0')}.js`;
        fs.rmSync(project.fixture.src(file));
        removed.push(file);
      }
      const rev2 = (
        await project.session.applyChanges({
          ...emptyMutation(rev1),
          mode: 'verified-explicit',
          removed,
        })
      ).revision;
      const gone = await affectedEverywhere(project, rev2, 70);
      expect(gone.every((entry) => entry.removed && entry.role === null)).toBe(
        true,
      );

      // A page bound to an older revision is stale.
      const stale = await project.dispatch('diagnostics.affected', {
        rev: rev1,
      });
      expect(stale.outcome).toBe('stale-revision');

      // 81 affected files on an invalid revision.
      writePages(project.fixture, 81, forbidden, 'bad');
      const rev3 = (
        await project.session.applyChanges({
          ...emptyMutation(rev2),
          mode: 'verified-explicit',
          added: Array.from(
            { length: 81 },
            (_, i) => `src/bad${String(i).padStart(3, '0')}.js`,
          ),
        })
      ).revision;
      await affectedEverywhere(project, rev3, 81);

      // A definition failure: nothing was analysed, so nothing is affected.
      const rev4 = (
        await project.session.applyChanges({
          ...emptyMutation(rev3),
          definition: definitionWith(project.fixture, (definition) => {
            definition.tokens.spacing.loopA = { ref: 'spacing.loopB' };
            definition.tokens.spacing.loopB = { ref: 'spacing.loopA' };
          }),
        })
      ).revision;
      await affectedEverywhere(project, rev4, 0);
    } finally {
      await project.close();
    }
  });

  test('candidates: the full domain of every category, by index and by name', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      const first = await project.dispatch('diagnostics.candidates', {
        rev,
        domain: { kind: 'category-index', index: 0 },
      });
      const categoriesTotal = first.result.categoriesTotal;
      expect(categoriesTotal).toBeGreaterThan(3);
      for (let index = 0; index < categoriesTotal; index += 1) {
        const byIndex = await readList(
          project,
          'diagnostics.candidates',
          { rev, domain: { kind: 'category-index', index } },
          'compact',
          2,
        );
        const category = byIndex[0].category;
        const sdk = await project.session.candidateTokens({
          revision: rev,
          category,
          limit: 100000,
        });
        expect(byIndex).toEqual(
          sdk.candidates.map(({ tokenId, category: c }) => ({
            tokenId,
            category: c,
          })),
        );
        const byName = await readList(
          project,
          'diagnostics.candidates',
          { rev, domain: { kind: 'category', category } },
          'detail',
          256,
        );
        expect(byName).toEqual(byIndex);
      }
      const outOfRange = await project.dispatch('diagnostics.candidates', {
        rev,
        domain: { kind: 'category-index', index: categoriesTotal },
      });
      expect(outOfRange.failure.reason).toBe('index-out-of-range');
      // A name outside the enumeration, prototype keys included, is empty.
      for (const category of ['nope', 'constructor', '__proto__', 'toString']) {
        const empty = checkResponse(
          'diagnostics.candidates',
          await project.dispatch('diagnostics.candidates', {
            rev,
            domain: { kind: 'category', category },
          }),
        );
        expect(empty.outcome).toBe('success');
        expect(empty.result.page.total).toBe(0);
        expect(empty.result.categoryIndex).toBeNull();
      }
    } finally {
      await project.close();
    }
  });

  test('candidates of a diagnostic: the v1 candidatesQuery is honoured through from-diagnostic', async () => {
    const base = openProject('neg-forbidden-value');
    const project = await openAgentProject('neg-forbidden-value', {
      definition: definitionWith(base, (definition) => {
        for (let i = 0; i < 20; i += 1)
          definition.tokens.spacing[`extra${i}`] = {
            value: `${i}px`,
            visibility: 'public',
          };
      }),
    });
    try {
      const rev = await project.revision();
      const compact = await project.dispatch('check', { rev });
      const reference = compact.references.find(
        (entry) => entry.operation === 'diagnostics.candidates',
      );
      expect(reference).toBeDefined();
      const diagnostic =
        compact.result.document.diagnostics[reference.input.domain.index];
      expect(diagnostic.candidatesTruncated).toBe(true);
      const all = await readList(
        project,
        'diagnostics.candidates',
        { rev, domain: reference.input.domain },
        'compact',
        3,
      );
      expect(all).toHaveLength(diagnostic.candidatesTotal);
      const sdk = await project.session.candidateTokens({
        revision: rev,
        category: diagnostic.candidatesQuery.category,
        limit: 100000,
      });
      expect(all.map((entry) => entry.tokenId)).toEqual(
        sdk.candidates.map((entry) => entry.tokenId),
      );
    } finally {
      await project.close();
    }
  });

  test('operations: protocol.operations pages the whole registry', async () => {
    const project = await openAgentProject('valid');
    try {
      for (const limit of [1, 7]) {
        const all = await readList(
          project,
          'protocol.operations',
          {},
          'detail',
          limit,
        );
        expect(all.map((entry) => entry.name)).toEqual(REGISTRY.names);
      }
    } finally {
      await project.close();
    }
  });
});

describe('AG-01.1 continuations resume their request (R2)', () => {
  test('discovery: filtered and unfiltered, both views, page sizes 1, 2, 7 and 256', async () => {
    const project = await openAgentProject('valid');
    try {
      const filters = [
        null,
        ['check', 'records.read'],
        ['records.read', 'check'],
        ['check', 'check', 'session.status'],
        ['publish', 'diagnostics.affected', 'query', 'session.close'],
        [REGISTRY.names[REGISTRY.names.length - 1]],
      ];
      for (const names of filters) {
        const expected = REGISTRY.names.filter(
          (name) => names == null || names.includes(name),
        );
        for (const view of ['compact', 'detail']) {
          for (const limit of [1, 2, 7, 256]) {
            const input = {
              protocolVersions: [1],
              ...(names == null ? {} : { names }),
            };
            const all = await readList(
              project,
              'protocol.operations',
              input,
              view,
              limit,
            );
            expect({ names, view, limit, got: all.map((e) => e.name) }).toEqual(
              { names, view, limit, got: expected },
            );
            expect(
              all.every((entry) => (view === 'detail') === 'input' in entry),
            ).toBe(true);
          }
        }
      }
    } finally {
      await project.close();
    }
  });

  test('candidates keep their domain form, affected and check keep their view and limit', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) => writePages(fixture, 30, forbidden),
    });
    try {
      const rev = await project.revision();
      await project.dispatch('check', { rev });
      const full = (
        await project.session.agentResult(rev, { candidateLimit: 32 })
      ).diagnostics;
      for (const limit of [1, 3, 256]) {
        expect(
          await readList(project, 'check', { rev }, 'detail', limit),
        ).toEqual(full);
        const affected = await readList(
          project,
          'diagnostics.affected',
          { rev },
          'compact',
          limit,
        );
        expect(affected).toHaveLength(39);
        for (const domain of [
          { kind: 'category', category: 'spacing' },
          { kind: 'category-index', index: 0 },
          { kind: 'from-diagnostic', index: 3 },
        ]) {
          const all = await readList(
            project,
            'diagnostics.candidates',
            { rev, domain },
            'detail',
            limit,
          );
          const ids = all.map((entry) => entry.tokenId);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeGreaterThan(0);
        }
      }
    } finally {
      await project.close();
    }
  });
});

/**
 * Follows every reference returned, starting from one request, and rebuilds
 * each list by identity (list, index) from pages and from records read in
 * full. Nothing is requested that a response did not return (R3).
 */
async function traverse(dispatch, first) {
  const lists = {
    diagnostics: new Map(),
    affected: new Map(),
    // The v1 document's inline `{ file, role }` projections, by index.
    affectedInline: new Map(),
    candidates: new Map(),
    bootstrap: new Map(),
  };
  const put = (list, index, record, key = null) => {
    const map =
      key == null
        ? lists[list]
        : (lists[list].get(key) ?? lists[list].set(key, new Map()).get(key));
    if (map.has(index)) expect(map.get(index)).toEqual(record);
    map.set(index, record);
  };
  const texts = new Map();
  const seen = new Set();
  const queue = [first];
  let responses = 0;
  while (queue.length > 0) {
    const reference = queue.shift();
    const key = JSON.stringify(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    const response = await follow(dispatch, reference);
    responses += 1;
    expect(response.limits.responseBytes).toBeLessThanOrEqual(
      response.limits.maxResponseBytes,
    );
    // Every withheld record has a read of exactly its address.
    for (const entry of response.withheld) {
      expect(
        response.references.filter(
          (item) =>
            item.operation === 'records.read' &&
            JSON.stringify(item.input.address) ===
              JSON.stringify(entry.address),
        ),
      ).toHaveLength(1);
    }
    const result = response.result;
    if (reference.operation === 'records.read') {
      const address = JSON.stringify(reference.input.address);
      texts.set(address, (texts.get(address) ?? '') + result.chunk);
      if (result.nextOffset == null) {
        const record = JSON.parse(texts.get(address));
        expect(sha256(texts.get(address))).toBe(result.sha256);
        const { kind, index } = reference.input.address;
        if (kind === 'candidate')
          put(
            'candidates',
            index,
            record,
            reference.input.address.domain.index,
          );
        else put(kind === 'diagnostic' ? 'diagnostics' : kind, index, record);
      }
    } else if (result?.document != null) {
      result.document.diagnostics.forEach((record, index) =>
        put('diagnostics', index, record),
      );
      result.document.affected.entries.forEach((record, index) =>
        put('affectedInline', index, record),
      );
    } else if (result?.page != null) {
      const { list, offset, records } = result.page;
      records.forEach((record, index) =>
        put(
          list,
          offset + index,
          record,
          list === 'candidates' ? result.categoryIndex : null,
        ),
      );
    } else if (response.failure?.stage === 'bootstrap') {
      response.diagnostics.forEach((record, index) =>
        put('bootstrap', index, record),
      );
    }
    queue.push(...response.references);
  }
  return { lists, responses };
}

const deepSegments = (initial) =>
  Array.from({ length: 14 }, (_, i) => `${initial}${i}${'é'.repeat(120)}`);

describe('AG-01.1 every withheld record is reachable through references alone (R3)', () => {
  const HUGE = 'x'.repeat(40000);
  const prepare = (fixture) => {
    // Three deep files whose affected entry AND diagnostic are withheld, at
    // the first, a middle and the last position of both lists, with small
    // diagnostics in between.
    for (const initial of ['a', 'm', 'z']) {
      const dir = fixture.src('src', ...deepSegments(initial));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'deep.js'),
        `import { create, token } from '${'../'.repeat(15)}generated/design.pandamstyle';\n` +
          `export const s = create({ a: { padding: token('spacing.${initial}${HUGE}') } });\n`,
      );
    }
    fs.writeFileSync(fixture.src('src/c-err.js'), HEADER + forbidden(1));
    fs.writeFileSync(fixture.src('src/n-err.js'), HEADER + forbidden(2));
  };

  test('diagnostics, affected and candidates of one check, in both views', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      prepare,
      definition: definitionWith(base, (definition) => {
        for (let i = 0; i < 20; i += 1)
          definition.tokens.spacing[`extra${i}`] = {
            value: `${i}px`,
            visibility: 'public',
          };
        definition.tokens.spacing[`w${'w'.repeat(70000)}`] = {
          value: '1px',
          visibility: 'public',
        };
      }),
    });
    try {
      const rev = await project.revision();
      for (const view of ['compact', 'detail']) {
        const first = await project.dispatch('check', { rev }, { view });
        expect(
          first.withheld.map((entry) => entry.address.kind).sort(),
        ).toEqual(
          // An affected path stays under the detail ceiling (note §5.2).
          view === 'compact' ? ['affected', 'diagnostic'] : ['diagnostic'],
        );
        const { lists } = await traverse(project.dispatch, {
          operation: 'check',
          view,
          input: { rev },
        });
        const candidateLimit = view === 'compact' ? 8 : 32;
        const full = (
          await project.session.agentResult(rev, { candidateLimit })
        ).diagnostics;
        expect(full).toHaveLength(5);
        expect([...lists.diagnostics.keys()].sort((a, b) => a - b)).toEqual([
          0, 1, 2, 3, 4,
        ]);
        expect(full.map((_, index) => lists.diagnostics.get(index))).toEqual(
          full,
        );
        const withheldDiagnostics = full
          .map((record, index) => [index, recordInfo(record).bytes])
          .filter(([, bytes]) => bytes > REGISTRY.views[view].recordCeiling)
          .map(([index]) => index);
        // Compact: first, middle and last. Detail: every one, as the small
        // diagnostics' 32-candidate prefix carries the 70,000-character token.
        expect(withheldDiagnostics).toEqual(
          view === 'compact' ? [0, 2, 4] : [0, 1, 2, 3, 4],
        );

        const total = first.result.document.affected.total;
        const reached = new Map(lists.affectedInline);
        for (const [index, entry] of lists.affected) {
          if (reached.has(index))
            expect(reached.get(index).file).toBe(entry.file);
          reached.set(index, entry);
        }
        expect([...reached.keys()].sort((a, b) => a - b)).toEqual(
          Array.from({ length: total }, (_, index) => index),
        );
        const files = [...reached.values()].map((entry) => entry.file);
        expect(new Set(files).size).toBe(total);
        expect(files.filter((file) => file.endsWith('deep.js'))).toHaveLength(
          3,
        );

        const domainTotal = (
          await project.session.candidateTokens({
            revision: rev,
            category: 'spacing',
            limit: 100000,
          })
        ).total;
        const huge = `spacing.w${'w'.repeat(70000)}`;
        if (view === 'compact') {
          // Truncated candidates: the domain is reached from a diagnostic,
          // including its withheld token.
          expect(lists.candidates.size).toBe(1);
          const [domain] = [...lists.candidates.values()];
          const ids = [...domain.values()].map((entry) => entry.tokenId);
          expect(ids).toContain(huge);
          expect(domain.size).toBe(domainTotal);
        } else {
          // 32 candidates per diagnostic: the whole domain is inside each
          // diagnostic record, read in full above, so nothing is truncated.
          const small = lists.diagnostics.get(1);
          expect(small.candidatesTruncated).toBe(false);
          expect(small.candidates).toHaveLength(domainTotal);
          expect(small.candidates.map((entry) => entry.tokenId)).toContain(
            huge,
          );
          expect(lists.candidates.size).toBe(0);
        }
      }
    } finally {
      await project.close();
    }
  });

  test('the candidate domain of a withheld diagnostic is referenced', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        for (let i = 0; i < 20; i += 1)
          definition.tokens.spacing[`extra${i}`] = {
            value: `${i}px`,
            visibility: 'public',
          };
      }),
      prepare: (fixture) =>
        fs.writeFileSync(
          fixture.src('src/zz.js'),
          `${HEADER}export const s = create({ a: { padding: token('spacing.${BIG}') } });\n`,
        ),
    });
    try {
      const rev = await project.revision();
      const first = await project.dispatch('check', { rev });
      expect(first.result.document.diagnostics).toEqual([]);
      expect(first.withheld[0].address).toEqual({
        kind: 'diagnostic',
        index: 0,
      });
      const { lists } = await traverse(project.dispatch, {
        operation: 'check',
        view: 'compact',
        input: { rev },
      });
      expect(lists.diagnostics.get(0).candidatesTruncated).toBe(true);
      const [domain] = [...lists.candidates.values()];
      expect(domain.size).toBe(lists.diagnostics.get(0).candidatesTotal);
    } finally {
      await project.close();
    }
  });

  test('a bootstrap failure list with withheld records at the middle and the end', async () => {
    const fixture = openProject('valid');
    const real = fixture.openPublicSession();
    const record = (payload) =>
      compiler.diagnostic({
        code: 'PMS_INVALID_REVISION',
        phase: 'lifecycle',
        rule: 'session.revision-identity',
        message: 'injected',
        context: { reason: 'output-owned', payload },
      });
    const failure = new compiler.PmsError([
      record('small'),
      record('m'.repeat(70000)),
      record('s'),
      record('z'.repeat(70000)),
    ]);
    const session = Object.create(real, {
      initialize: { value: async () => Promise.reject(failure) },
    });
    const binding = await compiler.createAgentBinding({
      session,
      initialize: true,
    });
    const capability = binding.mintCapability({ grants: ['consult'] });
    const dispatch = (operation, input, extra = {}) =>
      binding.dispatch(request(operation, input, extra), { capability });
    try {
      for (const view of ['compact', 'detail']) {
        const { lists } = await traverse(dispatch, {
          operation: 'session.status',
          view,
          input: {},
        });
        expect([...lists.bootstrap.keys()].sort()).toEqual([0, 1, 2, 3]);
        expect(
          [0, 1, 2, 3].map(
            (index) => lists.bootstrap.get(index).context.payload,
          ),
        ).toEqual(['small', 'm'.repeat(70000), 's', 'z'.repeat(70000)]);
      }
    } finally {
      await real.close();
    }
  });
});

describe('AG-01.1 oversized values inside records (I11, T14)', () => {
  /** Withheld, under the ceiling, and readable in full in both views. */
  async function expectWithheld(project, response, expectedAddress, rev) {
    checkResponse(response.operation, response);
    const entry = response.withheld.find(
      (item) =>
        JSON.stringify(item.address) === JSON.stringify(expectedAddress),
    );
    expect(entry).toBeDefined();
    expect(entry.bytes).toBeGreaterThan(
      REGISTRY.views[response.view].recordCeiling,
    );
    expect(response.references).toContainEqual({
      operation: 'records.read',
      view: response.view,
      input: {
        rev,
        address: entry.address,
        page: { offset: 0, limit: 262144 },
      },
    });
    const read = await readRecord(
      project.dispatch,
      rev,
      entry.address,
      262144,
      response.view,
    );
    expect(read.sha256).toBe(entry.sha256);
    expect(sha256(read.text)).toBe(entry.sha256);
    expect(read.text.length).toBe(entry.bytes);
    // The canonical serialization is ASCII and parses back to the record.
    expect(/^[\x20-\x7e]*$/.test(read.text)).toBe(true);
    const parsed = JSON.parse(read.text);
    expect(canonicalJson(parsed)).toBe(read.text);
    return { entry, parsed };
  }

  test('a diagnostic: an unknown token of 1,200,000 characters', async () => {
    const project = await openAgentProject('valid', {
      prepare: (fixture) =>
        fs.writeFileSync(
          fixture.src('src/zz.js'),
          `${HEADER}export const s = create({ a: { padding: token('spacing.${BIG}') } });\n`,
        ),
    });
    try {
      const rev = await project.revision();
      for (const view of ['compact', 'detail']) {
        const response = await project.dispatch('check', { rev }, { view });
        expect(response.outcome).toBe('constraint-violation');
        const document = response.result.document;
        // The first record is withheld: an empty prefix, the true total.
        expect(document.diagnostics).toEqual([]);
        expect(document.diagnosticsTotal).toBe(1);
        expect(document.diagnosticsTruncated).toBe(true);
        expect(response.page.nextOffset).toBe(null);
        const { entry, parsed } = await expectWithheld(
          project,
          response,
          { kind: 'diagnostic', index: 0 },
          rev,
        );
        expect(entry).toMatchObject({
          code: 'PMS_UNKNOWN_TOKEN',
          severity: 'error',
        });
        const full = (
          await project.session.agentResult(rev, {
            candidateLimit: view === 'compact' ? 8 : 32,
          })
        ).diagnostics[0];
        expect(parsed).toEqual(full);
      }
    } finally {
      await project.close();
    }
  });

  test('a diagnostic: a context array of 256 strings of 16 KiB', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        for (let i = 0; i < 256; i += 1)
          definition.conditions[`c${i}${'y'.repeat(16380)}`] =
            '@media (min-width: 1px)';
      }),
      prepare: (fixture) =>
        fs.writeFileSync(
          fixture.src('src/zz.js'),
          `${HEADER}export const s = create({ a: { padding: { nope: token('spacing.md') } } });\n`,
        ),
    });
    try {
      const rev = await project.revision();
      for (const view of ['compact', 'detail']) {
        const response = await project.dispatch('check', { rev }, { view });
        const { entry } = await expectWithheld(
          project,
          response,
          { kind: 'diagnostic', index: 0 },
          rev,
        );
        expect(entry.code).toBe('PMS_UNKNOWN_CONDITION');
        expect(entry.bytes).toBeGreaterThan(12000000);
      }
    } finally {
      await project.close();
    }
  });

  test('a candidate of 1,200,000 characters in a project with zero diagnostics, by category and by index', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.tokens.spacing[BIG] = { value: '1px', visibility: 'public' };
      }),
    });
    try {
      const rev = await project.revision();
      const check = await project.dispatch('check', { rev });
      expect(check.outcome).toBe('success');
      expect(check.result.document.diagnosticsTotal).toBe(0);
      const spacing = await project.dispatch('diagnostics.candidates', {
        rev,
        domain: { kind: 'category', category: 'spacing' },
      });
      const index = spacing.result.categoryIndex;
      for (const domain of [
        { kind: 'category', category: 'spacing' },
        { kind: 'category-index', index },
      ]) {
        for (const view of ['compact', 'detail']) {
          const all = await readList(
            project,
            'diagnostics.candidates',
            { rev, domain },
            view,
            256,
          );
          expect(all).toHaveLength(7);
          expect(all[6].tokenId).toBe(`spacing.${BIG}`);
          const page = await project.dispatch(
            'diagnostics.candidates',
            { rev, domain, page: { offset: 6, limit: 5 } },
            { view },
          );
          expect(page.result.page.records).toEqual([]);
          await expectWithheld(
            project,
            page,
            {
              kind: 'candidate',
              domain: { kind: 'category-index', index },
              index: 6,
            },
            rev,
          );
        }
      }
    } finally {
      await project.close();
    }
  });

  // BV-1: a candidate domain must be reachable whatever its key's length and
  // whether or not any diagnostic names it.
  test('BV-1: a 257-byte and a 1,200,000-character category with zero, then unrelated, diagnostics', async () => {
    const base = openProject('valid');
    const long = 'k'.repeat(257);
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.tokens[long] = {
          [BIG]: { value: '2px', visibility: 'public' },
        };
        definition.tokens[`m${BIG}`] = {
          a: { value: '3px', visibility: 'public' },
        };
      }),
    });
    try {
      const reachAll = async (rev) => {
        const first = await project.dispatch('diagnostics.candidates', {
          rev,
          domain: { kind: 'category-index', index: 0 },
        });
        const seen = new Set();
        for (let index = 0; index < first.result.categoriesTotal; index += 1) {
          for (const view of ['compact', 'detail']) {
            const all = await readList(
              project,
              'diagnostics.candidates',
              { rev, domain: { kind: 'category-index', index } },
              view,
              256,
            );
            for (const entry of all) seen.add(entry.category);
          }
        }
        expect(seen.has(long)).toBe(true);
        expect(seen.has(`m${BIG}`)).toBe(true);
        // The name form refuses an unbounded key without echoing it.
        const refused = await project.dispatch('diagnostics.candidates', {
          rev,
          domain: { kind: 'category', category: long },
        });
        expect(refused.failure.reason).toBe('schema-max-length');
        expect(JSON.stringify(refused)).not.toContain('kkkkkkkk');
        return first.result.categoriesTotal;
      };
      const rev1 = await project.revision();
      const check = await project.dispatch('check', { rev: rev1 });
      expect(check.outcome).toBe('success');
      expect(check.result.document.diagnosticsTotal).toBe(0);
      const total = await reachAll(rev1);
      // Unrelated diagnostics do not change the enumeration or its reach.
      writePages(project.fixture, 2, forbidden);
      const rev2 = (
        await project.session.applyChanges({
          ...emptyMutation(rev1),
          mode: 'verified-explicit',
          added: ['src/gen000.js', 'src/gen001.js'],
        })
      ).revision;
      const invalid = await project.dispatch('check', { rev: rev2 });
      expect(invalid.result.document.diagnosticsTotal).toBe(2);
      expect(await reachAll(rev2)).toBe(total);
    } finally {
      await project.close();
    }
  });

  test('BV-1: a separate from-diagnostic fixture reaches a withheld candidate of its domain', async () => {
    const base = openProject('neg-forbidden-value');
    const project = await openAgentProject('neg-forbidden-value', {
      definition: definitionWith(base, (definition) => {
        definition.tokens.spacing[BIG] = { value: '1px', visibility: 'public' };
      }),
    });
    try {
      const rev = await project.revision();
      // The diagnostic list exists once the revision is validated.
      expect((await project.dispatch('check', { rev })).outcome).toBe(
        'constraint-violation',
      );
      const all = await readList(
        project,
        'diagnostics.candidates',
        { rev, domain: { kind: 'from-diagnostic', index: 0 } },
        'compact',
        256,
      );
      expect(all.map((entry) => entry.tokenId)).toContain(`spacing.${BIG}`);
      const out = await project.dispatch('diagnostics.candidates', {
        rev,
        domain: { kind: 'from-diagnostic', index: 99 },
      });
      expect(out.failure.reason).toBe('index-out-of-range');
    } finally {
      await project.close();
    }
  });

  test('an affected entry: a deeply nested non-ASCII path (withheld in compact, inline in detail)', async () => {
    const segments = Array.from(
      { length: 14 },
      (_, i) => `${i}${'é'.repeat(120)}`,
    );
    const project = await openAgentProject('valid', {
      prepare: (fixture) => {
        const dir = fixture.src('src', ...segments);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, 'deep.js'),
          `import { create, token } from '${'../'.repeat(15)}generated/design.pandamstyle';\nexport const s = create({ a: { padding: token('spacing.md') } });\n`,
        );
      },
    });
    try {
      const rev = await project.revision();
      expect((await project.dispatch('check', { rev })).outcome).toBe(
        'success',
      );
      const all = await readList(
        project,
        'diagnostics.affected',
        { rev },
        'compact',
        256,
      );
      const deep = all.find((entry) => entry.file.endsWith('deep.js'));
      expect(deep).toBeDefined();
      const index = all.indexOf(deep);
      const page = await project.dispatch('diagnostics.affected', {
        rev,
        page: { offset: index, limit: 5 },
      });
      await expectWithheld(project, page, { kind: 'affected', index }, rev);
      // 1-byte and 7-byte chunks reassemble the same record.
      for (const chunk of [1, 7]) {
        const read = await readRecord(
          project.dispatch,
          rev,
          { kind: 'affected', index },
          chunk,
        );
        expect(read.sha256).toBe(sha256(read.text));
        expect(JSON.parse(read.text)).toEqual(deep);
      }
      const detail = await project.dispatch(
        'diagnostics.affected',
        { rev, page: { offset: index, limit: 1 } },
        { view: 'detail' },
      );
      expect(detail.result.page.records).toEqual([deep]);
      // The inline v1 list of check withholds it too, in compact.
      const check = checkResponse(
        'check',
        await project.dispatch('check', { rev }),
      );
      expect(check.result.document.affected.total).toBe(all.length);
      expect(index).toBeLessThan(16);
      const inline = check.withheld.find(
        (item) => item.address.kind === 'affected',
      );
      expect(inline).toEqual(page.withheld[0]);
      expect(check.result.document.affected.entries).toHaveLength(index);
      expect(check.result.document.affected.truncated).toBe(true);
    } finally {
      await project.close();
    }
  });

  test('a definition failure: a token cycle through a 1,200,000-character name', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.tokens.spacing[BIG] = { ref: 'spacing.loop' };
        definition.tokens.spacing.loop = { ref: `spacing.${BIG}` };
      }),
    });
    try {
      const rev = await project.revision();
      for (const view of ['compact', 'detail']) {
        const response = await project.dispatch('check', { rev }, { view });
        expect(response.failure.stage).toBe('bootstrap');
        const { entry } = await expectWithheld(
          project,
          response,
          { kind: 'diagnostic', index: 0 },
          rev,
        );
        expect(entry.code).toBe('PMS_TOKEN_CYCLE');
      }
    } finally {
      await project.close();
    }
  });

  test('a bootstrap failure record: withheld in compact, inline in detail, readable by index', async () => {
    const fixture = openProject('valid');
    const real = fixture.openPublicSession();
    const oversized = new compiler.PmsError([
      compiler.diagnostic({
        code: 'PMS_INVALID_REVISION',
        phase: 'lifecycle',
        rule: 'session.revision-identity',
        message: 'injected',
        context: { reason: 'output-owned', payload: 'z'.repeat(20000) },
      }),
    ]);
    const session = Object.create(real, {
      initialize: { value: async () => Promise.reject(oversized) },
    });
    const binding = await compiler.createAgentBinding({
      session,
      initialize: true,
    });
    const capability = binding.mintCapability({ grants: ['consult'] });
    const dispatch = (operation, input, extra = {}) =>
      binding.dispatch(request(operation, input, extra), { capability });
    try {
      const compact = checkResponse(
        'session.status',
        await dispatch('session.status', {}),
      );
      expect(compact.outcome).toBe('denied-access');
      expect(compact.diagnostics).toEqual([]);
      expect(compact.diagnosticsTotal).toBe(1);
      expect(compact.diagnosticsTruncated).toBe(true);
      expect(compact.withheld[0].address).toEqual({
        kind: 'bootstrap',
        index: 0,
      });
      const read = await readRecord(
        dispatch,
        null,
        { kind: 'bootstrap', index: 0 },
        262144,
      );
      expect(read.sha256).toBe(compact.withheld[0].sha256);
      expect(JSON.parse(read.text).context.payload).toHaveLength(20000);
      const detail = checkResponse(
        'session.status',
        await dispatch('session.status', {}, { view: 'detail' }),
      );
      expect(detail.diagnostics).toHaveLength(1);
      expect(recordInfo(detail.diagnostics[0]).sha256).toBe(read.sha256);
      const missing = await dispatch('records.read', {
        rev: null,
        address: { kind: 'bootstrap', index: 1 },
        page: { offset: 0, limit: 1 },
      });
      expect(missing.failure.reason).toBe('index-out-of-range');
    } finally {
      await real.close();
    }
  });
});

describe('AG-01.1 progress and bounds outside records (I11)', () => {
  test('1-byte and 7-byte chunks of a withheld candidate reassemble to its digest', async () => {
    const base = openProject('valid');
    const name = 'n'.repeat(8200);
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.tokens.spacing[name] = {
          value: '1px',
          visibility: 'public',
        };
      }),
    });
    try {
      const rev = await project.revision();
      const spacing = await project.dispatch('diagnostics.candidates', {
        rev,
        domain: { kind: 'category', category: 'spacing' },
        page: { offset: 6, limit: 1 },
      });
      const [entry] = spacing.withheld;
      expect(entry).toBeDefined();
      for (const chunk of [1, 7, 262144]) {
        const read = await readRecord(
          project.dispatch,
          rev,
          entry.address,
          chunk,
        );
        expect(read.sha256).toBe(entry.sha256);
        expect(sha256(read.text)).toBe(entry.sha256);
      }
      // A read past the end returns nothing and terminates.
      const past = await project.dispatch('records.read', {
        rev,
        address: entry.address,
        page: { offset: entry.bytes + 10, limit: 5 },
      });
      expect(past.result).toMatchObject({
        chunk: '',
        returned: 0,
        nextOffset: null,
      });
    } finally {
      await project.close();
    }
  });

  test('every page advances: many medium records, and a list where every record is withheld', async () => {
    const base = openProject('valid');
    const project = await openAgentProject('valid', {
      definition: definitionWith(base, (definition) => {
        definition.tokens.medium = {};
        definition.tokens.huge = {};
        for (let i = 0; i < 40; i += 1) {
          definition.tokens.medium[`m${i}${'q'.repeat(7000)}`] = {
            value: '1px',
            visibility: 'public',
          };
          definition.tokens.huge[`h${i}${'w'.repeat(9000)}`] = {
            value: '1px',
            visibility: 'public',
          };
        }
      }),
    });
    try {
      const rev = await project.revision();
      const floor = REGISTRY.views.compact.floor;
      for (const category of ['medium', 'huge']) {
        let offset = 0;
        let pages = 0;
        let seen = 0;
        while (offset != null) {
          const response = checkResponse(
            'diagnostics.candidates',
            await project.dispatch(
              'diagnostics.candidates',
              {
                rev,
                domain: { kind: 'category', category },
                page: { offset, limit: 20 },
              },
              { maxResponseBytes: floor },
            ),
          );
          const advanced = response.page.returned + response.withheld.length;
          expect(advanced).toBeGreaterThanOrEqual(1);
          if (category === 'huge') {
            expect(response.page.returned).toBe(0);
            expect(response.withheld).toHaveLength(1);
          }
          seen += advanced;
          pages += 1;
          offset = response.page.nextOffset;
        }
        expect(seen).toBe(40);
        if (category === 'medium') expect(pages).toBeGreaterThan(2);
        else expect(pages).toBe(40);
      }
    } finally {
      await project.close();
    }
  });

  test('createAgentBinding refuses identities over their bounds', async () => {
    const fixture = openProject('valid');
    const cases = [
      { projectId: 'p'.repeat(1025) },
      { rootDir: `/tmp/${'r'.repeat(4100)}`, roots: [] },
      { outDir: 'o'.repeat(4100) },
    ];
    for (const options of cases) {
      const session = fixture.openPublicSession(options);
      await expect(
        compiler.createAgentBinding({ session, initialize: false }),
      ).rejects.toThrow(/refuses a session whose/);
    }
    const session = fixture.openPublicSession();
    await expect(
      compiler.createAgentBinding({
        session,
        limits: { compact: { maxResponseBytes: 1024 } },
      }),
    ).rejects.toThrow(/at least/);
  });

  test('every non-bootstrap failure source, driven with maximal inputs, stays under the record ceiling', async () => {
    const project = await openAgentProject('valid');
    try {
      const rev = await project.revision();
      const maximal = {
        projectId: '\u0001'.repeat(170),
        sessionId: 's'.repeat(64),
        revisionId: Number.MAX_SAFE_INTEGER,
      };
      const responses = [
        await project.dispatch('check', { rev: maximal }),
        await project.dispatch('check', {
          rev: { ...rev, revisionId: Number.MAX_SAFE_INTEGER },
        }),
        await project.dispatch('diagnostics.affected', { rev }),
        await project.dispatch('records.read', {
          rev,
          address: {
            kind: 'candidate',
            domain: { kind: 'category-index', index: Number.MAX_SAFE_INTEGER },
            index: Number.MAX_SAFE_INTEGER,
          },
          page: { offset: Number.MAX_SAFE_INTEGER, limit: 262144 },
        }),
        await project.dispatch(
          'check',
          { rev, x: 'q'.repeat(4096) },
          { requestId: 'r'.repeat(128) },
        ),
        await project.dispatch('protocol.operations', {
          names: Array.from({ length: 64 }, () => 'z'.repeat(64)),
        }),
        await project.binding.dispatch(request('publish', {}), {}),
        await project.binding.dispatch(request('check', { rev }), {}),
      ];
      for (const response of responses) {
        expect(response.outcome).not.toBe('success');
        for (const diagnostic of response.diagnostics)
          expect(recordInfo(diagnostic).bytes).toBeLessThanOrEqual(
            REGISTRY.views.compact.recordCeiling,
          );
        expect(response.failure.reason).not.toBe('unbounded-failure-record');
      }
    } finally {
      await project.close();
    }
  });

  test('the frame bound: a frame filled to every bound fits frameMax in both views', () => {
    const { maxJsonBytes, envelopeSchema } = compiler;
    const maximalOf = (schema) => {
      if (schema.oneOf != null) {
        const branches = schema.oneOf.map(maximalOf);
        return branches.reduce((a, b) =>
          JSON.stringify(a).length >= JSON.stringify(b).length ? a : b,
        );
      }
      if ('const' in schema) return schema.const;
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const candidates = types.map((type) => {
        switch (type) {
          case 'object':
            return Object.fromEntries(
              Object.entries(schema.properties ?? {}).map(([name, child]) => [
                name,
                maximalOf(child),
              ]),
            );
          case 'array':
            return schema.items.format === 'record'
              ? []
              : Array.from({ length: schema.maxItems }, () =>
                  maximalOf(schema.items),
                );
          case 'string':
            if (schema.enum != null)
              return schema.enum.reduce((a, b) =>
                a.length >= b.length ? a : b,
              );
            if (schema.format === 'chunk') return '';
            return 'a'.repeat(
              schema.maxLength ?? compiler.FORMATS[schema.format].maxLength,
            );
          case 'integer':
            return schema.minimum < 0 ? schema.minimum : schema.maximum;
          case 'boolean':
            return false;
          default:
            return null;
        }
      });
      return candidates.reduce((a, b) =>
        JSON.stringify(a).length >= JSON.stringify(b).length ? a : b,
      );
    };
    let largest = 0;
    for (const entry of REGISTRY.entries.filter(
      (e) => e.status === 'implemented',
    )) {
      const schema = envelopeSchema(entry.output, REGISTRY.names);
      const frame = Buffer.byteLength(JSON.stringify(maximalOf(schema)));
      expect(frame).toBeLessThanOrEqual(maxJsonBytes(schema));
      largest = Math.max(largest, frame);
    }
    for (const view of ['compact', 'detail']) {
      const limits = REGISTRY.views[view];
      expect(largest + limits.recordCeiling).toBeLessThanOrEqual(
        limits.frameMax,
      );
      expect(limits.floor).toBe(limits.frameMax + limits.recordCeiling);
      expect(limits.maxResponseBytes).toBeGreaterThanOrEqual(limits.floor);
    }
  });
});

describe('AG-01.1 recorded responses against the generated types', () => {
  test('every recorded response type-checks against operations.d.ts', () => {
    expect(recorded.length).toBeGreaterThan(20);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-agent-recorded-'));
    try {
      fs.copyFileSync(GENERATED, path.join(root, 'operations.d.ts'));
      const lines = ["import type { AgentResponse } from './operations';"];
      const seen = new Set();
      recorded.forEach(([name, response], index) => {
        // Large records add nothing to a type check.
        const text = JSON.stringify(response);
        if (text.length > 200000 || seen.has(text)) return;
        seen.add(text);
        lines.push(
          `export const r${index}: AgentResponse<${JSON.stringify(name)}> = ${text};`,
        );
      });
      fs.writeFileSync(path.join(root, 'recorded.ts'), lines.join('\n'));
      execFileSync(
        path.join(REPO_ROOT, 'node_modules/.bin/tsc'),
        [
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'ESNext',
          '--moduleResolution',
          'node',
          path.join(root, 'recorded.ts'),
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
