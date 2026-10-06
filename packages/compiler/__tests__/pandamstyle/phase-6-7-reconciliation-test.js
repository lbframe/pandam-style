/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadCompiler, makeCounter, readTree } = require('./session-helpers');

const observations = [];
const compiler = loadCompiler();

function definition() {
  return {
    systemId: 'shared-ui',
    tokens: {
      spacing: {
        z: { value: '8px', visibility: 'public' },
        a: { value: '16px', visibility: 'public' },
        secretSpace: { value: '24px', visibility: 'private' },
      },
      colors: {
        privateInk: { value: '#112233', visibility: 'private' },
        text: { ref: 'colors.privateInk', visibility: 'public' },
      },
    },
    themes: {
      dark: {
        tokens: {
          colors: { privateInk: { value: '#aabbcc', visibility: 'private' } },
        },
      },
    },
    conditions: { hover: ':hover', wide: '@media (min-width: 768px)' },
    recipes: {
      button: {
        visibility: 'public',
        variants: { size: { z: { opacity: 1 }, a: { opacity: 0.5 } } },
        defaultVariants: { size: 'z' },
      },
      privateRecipe: {
        visibility: 'private',
        base: { display: 'block' },
        variants: { hiddenAxis: { hiddenValue: { opacity: 1 } } },
      },
    },
  };
}

function fixture(input = definition(), options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-reconciliation-'));
  const out = path.join(root, 'out');
  fs.mkdirSync(path.join(root, 'src'));
  const page = path.join(root, 'src/page.js');
  fs.writeFileSync(
    page,
    "import { create, token, props } from '../out/design.js';\nconst s = create({ row: { padding: token('spacing.z'), display: 'flex' } });\nexport const result = props(s.row);\n",
  );
  const config = {
    projectId: root,
    rootDir: root,
    roots: ['src'],
    outDir: 'out',
    designSystemFile: 'design.js',
    definition: input,
    ...options,
  };
  return {
    root,
    out,
    page,
    config,
    open: (changes = {}) =>
      compiler.createPublicProjectSession({ ...config, ...changes }),
  };
}

function mutation(revision, extra = {}) {
  return {
    baseRevision: revision,
    mode: 'verified-explicit',
    changed: [],
    added: [],
    removed: [],
    renamed: [],
    ...extra,
  };
}

async function valid(project) {
  const initial = await project.initialize();
  const checked = await project.validate(initial.revision);
  expect(checked.ok).toBe(true);
  return checked.revision;
}

function coherent(out) {
  const metadata = JSON.parse(
    fs.readFileSync(path.join(out, 'artifacts.json'), 'utf8'),
  );
  const contents = Object.fromEntries(
    Object.entries(metadata.artifacts).map(([name, record]) => [
      name,
      fs.readFileSync(path.join(out, record.file), 'utf8'),
    ]),
  );
  expect(compiler.validateArtifactSet(metadata, contents)).toBe(true);
  for (const content of [
    ...Object.values(contents),
    JSON.stringify(metadata),
  ]) {
    expect(content).not.toMatch(
      /secretSpace|privateInk|privateRecipe|hiddenAxis|hiddenValue/,
    );
    expect(content).not.toMatch(
      /projectId|sessionId|revisionId|generationId|artifactRevision|associationRevision/,
    );
  }
  return { metadata, contents };
}

function record(scenario, detail = {}) {
  observations.push({ scenario, result: 'passed', ...detail });
}

afterAll(() => {
  if (process.env.PMS_OUT_DIR == null) return;
  fs.mkdirSync(process.env.PMS_OUT_DIR, { recursive: true });
  const repo = path.resolve(__dirname, '../../../..');
  const report = {
    documentKind: 'pandamstyle-phase-6-7-reconciliation-qualification',
    testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    testedTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim(),
    observations,
  };
  fs.writeFileSync(
    path.join(process.env.PMS_OUT_DIR, 'phase-6-7-qualification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
});

describe('Phase 6 + 7 canonical service reconciliation', () => {
  test.each([
    [
      'recipe-axis',
      "import {recipes,props} from '../out/design.js'; export const result=props(recipes.button({absent:'z'}));",
      'PMS_INVALID_VARIANT_KEY',
      ['size'],
    ],
    [
      'recipe-value',
      "import {recipes,props} from '../out/design.js'; export const result=props(recipes.button({size:'absent'}));",
      'PMS_INVALID_VARIANT_VALUE',
      ['z', 'a'],
    ],
    [
      'condition',
      "import {create,token,props} from '../out/design.js'; const s=create({a:{padding:{absent:token('spacing.z')}}}); export const result=props(s.a);",
      'PMS_UNKNOWN_CONDITION',
      ['hover', 'wide'],
    ],
  ])(
    'structured %s repairs read public canonical domains',
    async (name, source, code, expected) => {
      const f = fixture();
      const p = f.open();
      try {
        fs.writeFileSync(f.page, source);
        const initial = await p.initialize();
        const invalid = await p.validate(initial.revision);
        expect(invalid.ok).toBe(false);
        const result = await p.agentResult(initial.revision);
        const diagnostic = result.diagnostics.find((d) => d.code === code);
        expect(diagnostic.expected.domain).toEqual(expected);
        expect(diagnostic.repair.expected.domain).toEqual(expected);
        expect(JSON.stringify(diagnostic.expected)).not.toMatch(
          /privateRecipe|hiddenAxis|hiddenValue/,
        );
        record(`repair-${name}`, { domain: diagnostic.expected.domain });
      } finally {
        await p.close();
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
  test('public candidates retain canonical declaration order across pages and private queries', async () => {
    const f = fixture();
    const p = f.open();
    try {
      const revision = await valid(p);
      const first = await p.candidateTokens({
        revision,
        category: 'spacing',
        limit: 1,
        allowPrivate: true,
      });
      const second = await p.candidateTokens({
        revision,
        category: 'spacing',
        offset: 1,
        limit: 1,
      });
      expect(first.candidates).toEqual([
        { tokenId: 'spacing.z', category: 'spacing' },
      ]);
      expect(first.total).toBe(2);
      expect(first.truncated).toBe(true);
      expect(second.candidates).toEqual([
        { tokenId: 'spacing.a', category: 'spacing' },
      ]);
      expect(second.truncated).toBe(false);
      await p.compile(revision);
      const set = coherent(f.out);
      record('candidate-order-and-privacy', {
        identity: set.metadata,
        declarationBytes: Buffer.byteLength(set.contents.declarations),
      });
    } finally {
      await p.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test.each([
    ['identical', () => {}, false],
    [
      'token-value',
      (d) => {
        d.tokens.spacing.z.value = '9px';
      },
      true,
    ],
    [
      'declaration-vocabulary-order',
      (d) => {
        const s = d.tokens.spacing;
        d.tokens.spacing = { a: s.a, z: s.z, secretSpace: s.secretSpace };
      },
      true,
    ],
    [
      'recipe-domain',
      (d) => {
        d.recipes.button.variants.size.extra = { opacity: 1 };
      },
      true,
    ],
    [
      'theme',
      (d) => {
        d.themes.dark.tokens.colors.privateInk.value = '#ccddaa';
      },
      true,
    ],
    [
      'condition',
      (d) => {
        d.conditions.wide = '@media (min-width: 900px)';
      },
      true,
    ],
  ])(
    'cold reopen considers the complete canonical set: %s',
    async (name, change, changed) => {
      const input = definition();
      const f = fixture(input);
      const first = f.open();
      let second;
      try {
        const revision = await valid(first);
        const original = await first.compile(revision);
        const before = coherent(f.out);
        const tree = readTree(f.out);
        const pageBefore = await first.readArtifact(revision, 'src/page.js');
        await first.close();
        change(input);
        second = f.open({ definition: input });
        const reopened = await valid(second);
        const artifact = await second.readArtifact(reopened, 'src/page.js');
        expect(artifact.javascript).toBe(pageBefore.javascript);
        const ticket = await second.preparePublication(reopened);
        const receipt = await second.commitPrepared(ticket);
        const after = coherent(f.out);
        if (changed) {
          expect(receipt.generationId).toBeGreaterThan(original.generationId);
          expect(receipt.artifactRevision).toEqual(reopened);
          expect(after.metadata.artifactSetDigest).not.toBe(
            before.metadata.artifactSetDigest,
          );
        } else {
          expect(receipt.generationId).toBe(original.generationId);
          expect(receipt.artifactRevision).toEqual(original.artifactRevision);
          expect(receipt.associationRevision).toEqual(reopened);
          expect(readTree(f.out)).toEqual(tree);
        }
        if (name === 'declaration-vocabulary-order') {
          expect(after.metadata.registryDigest).toBe(
            before.metadata.registryDigest,
          );
          expect(after.contents.declarations).not.toBe(
            before.contents.declarations,
          );
        }
        record(`cold-reopen-${name}`, {
          original,
          receipt,
          before: before.metadata.artifactSetDigest,
          after: after.metadata.artifactSetDigest,
          ticketDigest: ticket.candidateDigest,
        });
      } finally {
        await first.close();
        await second?.close();
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  test.each(['design.d.ts', 'manifest.json', 'artifacts.json'])(
    'failure after staging %s preserves the previous complete generation',
    async (member) => {
      let fail = false;
      const f = fixture(definition(), {
        publishFailAt: (point) => {
          if (fail && point === `after-stage:${member}`)
            throw new Error(`failure after ${member}`);
        },
      });
      const p = f.open();
      try {
        const revision = await valid(p);
        const original = await p.compile(revision);
        const tree = readTree(f.out);
        const nextDefinition = definition();
        nextDefinition.tokens.spacing.z.value = '9px';
        const next = await p.applyChanges(
          mutation(revision, { definition: nextDefinition }),
        );
        expect((await p.validate(next.revision)).ok).toBe(true);
        const ticket = await p.preparePublication(next.revision);
        fail = true;
        await expect(p.commitPrepared(ticket)).rejects.toThrow(
          `failure after ${member}`,
        );
        expect(readTree(f.out)).toEqual(tree);
        expect((await p.current()).generation.generationId).toBe(
          original.generationId,
        );
        await expect(p.commitPrepared(ticket)).rejects.toThrow(/stale/);
        coherent(f.out);
        fail = false;
        const repaired = await p.compile(next.revision);
        expect(repaired.generationId).toBeGreaterThan(original.generationId);
        coherent(f.out);
        record(`publication-failure-after-${member}`, { original, repaired });
      } finally {
        await p.close();
        fs.rmSync(f.root, { recursive: true, force: true });
      }
    },
  );

  test.each([
    'designModule',
    'declarations',
    'manifest',
    'css',
    'metadata-digest',
  ])(
    'the service rejects a foreign staged %s before publication',
    async (member) => {
      let foreign = null;
      let tamper = false;
      const f = fixture(definition(), {
        publishFailAt: (point) => {
          if (!tamper || point !== 'after-stage:artifacts.json') return;
          const staging = path.join(f.root, '.out.pms-staging');
          const metadataFile = path.join(staging, 'artifacts.json');
          const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
          const rel =
            member === 'metadata-digest'
              ? 'artifacts.json'
              : metadata.artifacts[member].file;
          const target = path.join(staging, rel);
          // Unlink first: unchanged staging members can share the current inode.
          fs.unlinkSync(target);
          if (member === 'metadata-digest') {
            metadata.artifactSetDigest = '0'.repeat(64);
            fs.writeFileSync(target, JSON.stringify(metadata));
          } else fs.writeFileSync(target, foreign.contents[member]);
        },
      });
      const foreignFixture = fixture();
      const other = foreignFixture.open({
        definition: { ...definition(), systemId: 'foreign-ui' },
      });
      const p = f.open();
      try {
        await other.compile(await valid(other));
        foreign = coherent(foreignFixture.out);
        const revision = await valid(p);
        const original = await p.compile(revision);
        const tree = readTree(f.out);
        const d = definition();
        d.tokens.spacing.z.value = '9px';
        const next = await p.applyChanges(
          mutation(revision, { definition: d }),
        );
        await p.validate(next.revision);
        tamper = true;
        await expect(
          p.commitPrepared(await p.preparePublication(next.revision)),
        ).rejects.toThrow(/artifact set mismatch/i);
        expect(readTree(f.out)).toEqual(tree);
        expect((await p.current()).generation.generationId).toBe(
          original.generationId,
        );
        coherent(f.out);
        record(`mixed-set-${member}-rejected`);
      } finally {
        await p.close();
        await other.close();
        fs.rmSync(f.root, { recursive: true, force: true });
        fs.rmSync(foreignFixture.root, { recursive: true, force: true });
      }
    },
  );

  test('one DS mutation rebuilds once, revokes tickets and serializes candidate reads', async () => {
    const f = fixture();
    const p = f.open();
    const counter = makeCounter();
    const stop = compiler.installPerfCollector(counter);
    try {
      const revision = await valid(p);
      const old = await p.preparePublication(revision);
      const oldArtifact = await p.readArtifact(revision, 'src/page.js');
      counter.reset();
      const d = definition();
      d.tokens.spacing.newPublic = { value: '32px', visibility: 'public' };
      const beforeQuery = p.candidateTokens({ revision, category: 'spacing' });
      const mutationCall = p.applyChanges(
        mutation(revision, { definition: d }),
      );
      const staleQuery = p.candidateTokens({ revision, category: 'spacing' });
      const [before, next] = await Promise.all([beforeQuery, mutationCall]);
      await expect(staleQuery).rejects.toThrow(/exact current/);
      expect(before.total).toBe(2);
      expect(next.revision.revisionId).toBe(revision.revisionId + 1);
      await expect(p.commitPrepared(old)).rejects.toThrow(/stale/);
      await expect(p.readArtifact(revision, 'src/page.js')).rejects.toThrow(
        /exact current/,
      );
      expect((await p.validate(next.revision)).ok).toBe(true);
      expect(
        (
          await p.candidateTokens({
            revision: next.revision,
            category: 'spacing',
          })
        ).total,
      ).toBe(3);
      await p.compile(next.revision);
      const set = coherent(f.out);
      expect(counter.counts.design_system_builds).toBe(1);
      expect(counter.counts.full_fallback ?? 0).toBe(0);
      expect(counter.counts.generation_materialized).toBe(1);
      expect(oldArtifact.designSystem.registryDigest).not.toBe(
        set.metadata.registryDigest,
      );
      record('ds-mutation-revision-ticket-candidate-concurrency', {
        counters: { ...counter.counts },
        durationsMs: Object.fromEntries(
          Object.entries(counter.durations).map(([k, v]) => [k, v / 1e6]),
        ),
      });
    } finally {
      await p.close();
      stop();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });

  test('same systemId with distinct vocabularies isolates candidates, repairs, types and tickets', async () => {
    const a = fixture();
    const d = definition();
    delete d.tokens.spacing.a;
    d.tokens.spacing.onlyB = { value: '32px', visibility: 'public' };
    const b = fixture(d);
    const left = a.open();
    const right = b.open();
    try {
      const [ra, rb] = await Promise.all([valid(left), valid(right)]);
      const [ca, cb] = await Promise.all([
        left.candidateTokens({ revision: ra }),
        right.candidateTokens({ revision: rb }),
      ]);
      expect(ca.candidates.map((v) => v.tokenId)).not.toContain(
        'spacing.onlyB',
      );
      expect(cb.candidates.map((v) => v.tokenId)).not.toContain('spacing.a');
      const ticket = await left.preparePublication(ra);
      await expect(right.commitPrepared(ticket)).rejects.toThrow(
        /another project or session/,
      );
      await left.commitPrepared(ticket);
      await right.compile(rb);
      const sa = coherent(a.out);
      const sb = coherent(b.out);
      expect(sa.metadata.systemId).toBe(sb.metadata.systemId);
      expect(sa.metadata.registryDigest).not.toBe(sb.metadata.registryDigest);
      expect(sa.contents.declarations).not.toContain('spacing.onlyB');
      expect(sb.contents.declarations).not.toContain('spacing.a');
      await left.close();
      fs.writeFileSync(
        b.page,
        "import {create,props} from '../out/design.js'; const s=create({a:{padding:17}}); export const result=props(s.a);\n",
      );
      const next = await right.applyChanges(
        mutation(rb, { changed: ['src/page.js'] }),
      );
      const invalid = await right.validate(next.revision);
      expect(invalid.ok).toBe(false);
      const result = await right.agentResult(next.revision);
      const repair = result.diagnostics.find(
        (diag) => diag.code === 'PMS_FORBIDDEN_VALUE',
      );
      expect(repair.candidates.map((v) => v.tokenId)).toEqual([
        'spacing.onlyB',
        'spacing.z',
      ]);
      expect(JSON.stringify(repair.repair)).not.toMatch(
        /secretSpace|spacing\.a/,
      );
      await expect(right.preparePublication(next.revision)).rejects.toThrow(
        /Invalid revisions/,
      );
      record('multi-project-canonical-isolation', {
        leftIdentity: sa.metadata,
        rightIdentity: sb.metadata,
        repair,
      });
    } finally {
      await left.close();
      await right.close();
      fs.rmSync(a.root, { recursive: true, force: true });
      fs.rmSync(b.root, { recursive: true, force: true });
    }
  });

  test('cold service initialization recovers a complete canonical set after an interrupted swap', async () => {
    const f = fixture();
    const p = f.open();
    let reopened;
    try {
      const revision = await valid(p);
      const original = await p.compile(revision);
      await p.close();
      const nextDefinition = definition();
      nextDefinition.tokens.spacing.z.value = '9px';
      const ds = compiler.buildDesignSystem(nextDefinition);
      const set = compiler.createArtifactSet(ds.snapshot, {
        designModuleFile: 'design.js',
        declarationsFile: 'design.d.ts',
        designModule: compiler.generateDesignSystemModule({ designSystem: ds }),
        declarations: compiler.generateDesignSystemDeclarations(ds.snapshot),
        manifest: JSON.stringify(ds.snapshot.tooling.manifest, null, 2) + '\n',
        css: compiler.withDesignSystemCssIdentity(
          ds.renderCss(),
          ds.snapshot.identity,
        ),
      });
      const origin = { ...revision, revisionId: revision.revisionId + 1 };
      const gen = compiler.beginGeneration(f.out, {
        mode: 'delta',
        generationId: original.generationId + 1,
        revisionIdentity: origin,
        candidateDigest: 'interrupted-candidate',
        failAt: 'after-swap',
      });
      for (const [name, entry] of Object.entries(set.metadata.artifacts))
        gen.stageArtifact(entry.file, set.contents[name]);
      gen.stageArtifact('artifacts.json', set.text);
      expect(() => gen.commit()).toThrow(/after-swap/);
      // Leave the intent and directory swap as a killed process would.
      reopened = f.open({ definition: nextDefinition });
      await reopened.initialize();
      const current = await reopened.current();
      expect(current.generation.generationId).toBe(original.generationId + 1);
      expect(current.generation.artifactRevision).toEqual(origin);
      const recovered = coherent(f.out);
      expect(recovered.metadata.artifactSetDigest).toBe(
        set.metadata.artifactSetDigest,
      );
      expect(
        fs.existsSync(path.join(f.root, '.out.pms-state.pending.json')),
      ).toBe(false);
      expect(fs.existsSync(path.join(f.root, '.out.pms-backup'))).toBe(false);
      record('canonical-crash-recovery', {
        current,
        artifactSetDigest: recovered.metadata.artifactSetDigest,
      });
    } finally {
      await p.close();
      await reopened?.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
});
