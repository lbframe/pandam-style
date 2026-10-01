/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

jest.autoMockOff();

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { freshCopyOf, runBuild } = require('./pms-helpers');

const build = require(
  path.resolve(
    __dirname,
    '../../../../.pms-test-support/compiler-inspection.cjs',
  ),
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** path -> sha256, for every file below `dir`. */
function digestTree(dir) {
  if (!fs.existsSync(dir)) return { exists: false, files: {} };
  const files = {};
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, key);
      else if (entry.isFile()) {
        files[key] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir, '');
  return { exists: true, files };
}

/** Artifacts the brief names explicitly, checked one by one. */
const NAMED_ARTIFACTS = [
  'design.pandamstyle.js',
  'design.pandamstyle.d.ts',
  'artifacts.json',
  'manifest.json',
  'build-report.json',
  'styles.css',
];

function namedArtifactState(dir) {
  const out = {};
  for (const name of NAMED_ARTIFACTS) {
    const full = path.join(dir, name);
    out[name] = fs.existsSync(full)
      ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
      : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// BC-5 - the shared mechanism
// ---------------------------------------------------------------------------

describe('BC-5: the transaction itself', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-gen-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a rollback on a first build leaves nothing published', () => {
    const out = path.join(dir, 'out');
    const gen = build.beginGeneration(out, { label: 'test' });
    gen.stage('design.pandamstyle.js', 'module v1');
    gen.stage('styles.css', 'css v1');
    gen.stage('manifest.json', '{"v":1}');
    // Staging is invisible: the output directory does not exist at all until
    // commit. This is the property that makes a failed build unobservable in
    // the published generation.
    expect(fs.existsSync(out)).toBe(false);
    gen.rollback();
    expect(fs.existsSync(out)).toBe(false);
  });

  test('a rollback restores the previous generation byte for byte', () => {
    const out = path.join(dir, 'out');
    const first = build.beginGeneration(out, { label: 'test' });
    first.stage('design.pandamstyle.js', 'module v1');
    first.stage('styles.css', 'css v1');
    first.stage('js/a.js', 'js v1');
    first.stage('manifest.json', '{"v":1}');
    first.commit();
    const before = digestTree(out);

    const second = build.beginGeneration(out, { label: 'test' });
    second.stage('design.pandamstyle.js', 'module v2 HALF');
    second.stage('styles.css', 'css v2 HALF');
    second.stage('js/b.js', 'js v2 only');
    second.stage('manifest.json', '{"v":2}');
    // Still nothing written: a second generation in progress cannot be seen.
    expect(digestTree(out)).toEqual(before);
    second.rollback();

    expect(digestTree(out)).toEqual(before);
  });

  test('a crash between snapshot and commit is recovered by the next run', () => {
    const out = path.join(dir, 'out');
    const first = build.beginGeneration(out, { label: 'test' });
    first.stage('manifest.json', '{"v":1}');
    first.stage('styles.css', 'css v1');
    first.commit();

    // A second generation starts: it takes a snapshot, so a backup now exists.
    // The process then dies mid-generation, leaving a partially published output
    // directory and the backup on disk. Neither commit nor rollback ran.
    const crashed = build.beginGeneration(out, { label: 'test' });
    crashed.stage('styles.css', 'css v2');
    crashed.stage('manifest.json', '{"v":2}');
    fs.writeFileSync(path.join(out, 'styles.css'), 'HALF WRITTEN', 'utf8');

    const next = build.beginGeneration(out, { label: 'test' });
    expect(next.recoveredFromCrash).toBe(true);
    // The good generation is back, not the half-written one.
    expect(fs.readFileSync(path.join(out, 'styles.css'), 'utf8')).toBe(
      'css v1',
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).v,
    ).toBe(1);
    next.rollback();
  });

  test('a rollback restores a file the failed generation deleted', () => {
    const out = path.join(dir, 'out');
    const first = build.beginGeneration(out, { label: 'test' });
    first.stage('stale.js', 'from generation 1');
    first.stage('manifest.json', '{"v":1}');
    first.commit();
    const before = digestTree(out);

    const second = build.beginGeneration(out, { label: 'test' });
    fs.rmSync(path.join(out, 'stale.js'));
    second.rollback();

    // Not merely "the new files are gone": the old ones are BACK.
    expect(digestTree(out)).toEqual(before);
  });

  test('the commit marker is published last', () => {
    const out = path.join(dir, 'out');
    const gen = build.beginGeneration(out, { label: 'test' });
    gen.stage('manifest.json', '{"v":1}');
    gen.stage('styles.css', 'css');
    gen.stage('js/a.js', 'js');
    const published = gen.commit();
    expect(published.published[published.published.length - 1]).toBe(
      'manifest.json',
    );
  });

  test('withGeneration publishes on success', () => {
    const out = path.join(dir, 'out');
    build.withGeneration(
      out,
      (gen) => {
        gen.stage('styles.css', 'css');
        gen.stage('manifest.json', '{"v":1}');
      },
      { label: 'test' },
    );
    expect(fs.readFileSync(path.join(out, 'styles.css'), 'utf8')).toBe('css');
  });

  test('withGeneration rolls back on a throw, and rethrows', () => {
    const out = path.join(dir, 'out');
    expect(() =>
      build.withGeneration(
        out,
        (gen) => {
          gen.stage('styles.css', 'css that must not appear');
          throw new Error('injected internal failure');
        },
        { label: 'test' },
      ),
    ).toThrow('injected internal failure');
    expect(fs.existsSync(path.join(out, 'styles.css'))).toBe(false);
  });

  test('withGeneration rolls back when the callback rejects', async () => {
    const out = path.join(dir, 'out');
    await expect(
      build.withGeneration(
        out,
        async (gen) => {
          gen.stage('styles.css', 'css that must not appear');
          throw new Error('injected async failure');
        },
        { label: 'test' },
      ),
    ).rejects.toThrow('injected async failure');
    expect(fs.existsSync(path.join(out, 'styles.css'))).toBe(false);
  });

  test('a committed transaction cannot be reused', () => {
    const out = path.join(dir, 'out');
    const gen = build.beginGeneration(out, { label: 'test' });
    gen.commit();
    expect(() => gen.stage('x', 'y')).toThrow(/already committed/);
  });
});

// ---------------------------------------------------------------------------
// BC-5 - the CLI, through a real process
// ---------------------------------------------------------------------------

describe('BC-5/BC-9: a failing CLI build publishes no mix', () => {
  test('a valid build publishes the full artifact set', () => {
    const project = freshCopyOf('valid');
    const result = runBuild(project);
    expect(result.status).toBe(0);
    const out = path.join(project, 'generated');
    for (const name of NAMED_ARTIFACTS) {
      expect(fs.existsSync(path.join(out, name))).toBe(true);
    }
    expect(fs.existsSync(path.join(out, 'js'))).toBe(true);
  });

  /**
   * Each scenario: build a VALID generation, digest every artifact, then fail
   * the next build in a different way, and require byte identity afterwards.
   *
   * The failure is introduced by adding or corrupting a file in the SAME project
   * and the SAME output directory, so the question under test is purely "did the
   * failed generation touch anything that was current?".
   */
  const scenarios = [
    {
      label: 'a policy error',
      extraArgs: [],
      breakIt(project) {
        fs.writeFileSync(
          path.join(project, 'src/zz-policy.js'),
          [
            "import { create, token } from '../generated/design.pandamstyle';",
            "export const s = create({ box: { padding: token('spacing.md'), margin: '17px' } });",
            '',
          ].join('\n'),
          'utf8',
        );
      },
    },
    {
      label: 'a coverage error',
      extraArgs: [],
      breakIt(project) {
        fs.writeFileSync(
          path.join(project, 'src/zz-coverage.js'),
          "import './no-such-module';\nexport const x = 1;\n",
          'utf8',
        );
      },
    },
    {
      label: 'a provenance error',
      extraArgs: [],
      breakIt(project) {
        fs.writeFileSync(
          path.join(project, 'src/zz-provenance.js'),
          [
            "import { props } from '../generated/design.pandamstyle';",
            "export const raw = props({ padding: '17px' });",
            '',
          ].join('\n'),
          'utf8',
        );
      },
    },
    {
      label: 'a parse error',
      extraArgs: [],
      breakIt(project) {
        fs.appendFileSync(
          path.join(project, 'src/page.js'),
          '\nfunction ( { unbalanced\n',
          'utf8',
        );
      },
    },
    {
      label: 'an internal error injected during publication staging',
      extraArgs: ['--inject-failure=after-compile'],
      breakIt(project) {
        const page = path.join(project, 'src/page.js');
        const before = fs.readFileSync(page, 'utf8');
        fs.writeFileSync(
          page,
          before.replace(
            "gap: token('spacing.sm'),",
            "gap: token('spacing.xl'),",
          ),
          'utf8',
        );
      },
    },
    {
      // The design system CHANGES, so generation N+1 has a different
      // registryDigest. A staging failure must leave every prior artifact in N.
      label: 'a changed design system plus an internal failure during staging',
      extraArgs: ['--inject-failure=after-compile'],
      breakIt(project) {
        const def = path.join(
          path.dirname(project),
          '_shared',
          'design.pms.config.mjs',
        );
        const before = fs.readFileSync(def, 'utf8');
        fs.writeFileSync(
          def,
          before.replace(
            "zero: { value: '0', visibility: 'public' },",
            "zero: { value: '0.5px', visibility: 'public' },",
          ),
          'utf8',
        );
      },
    },
  ];

  test.each(scenarios)(
    '$label leaves generation N byte-identical',
    ({ extraArgs, breakIt }) => {
      const project = freshCopyOf('valid');
      expect(runBuild(project).status).toBe(0);
      const out = path.join(project, 'generated');
      const beforeTree = digestTree(out);
      const beforeNamed = namedArtifactState(out);
      expect(beforeNamed['manifest.json']).not.toBeNull();

      breakIt(project);
      const result = runBuild(project, extraArgs);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('build ok');

      // Artifact by artifact, then the whole tree including the compiled JS.
      expect(namedArtifactState(out)).toEqual(beforeNamed);
      expect(digestTree(out)).toEqual(beforeTree);
    },
  );

  test('the injected failure is a real diagnostic on a real process', () => {
    const project = freshCopyOf('valid');
    expect(runBuild(project).status).toBe(0);
    const page = path.join(project, 'src/page.js');
    const before = fs.readFileSync(page, 'utf8');
    fs.writeFileSync(
      page,
      before.replace("gap: token('spacing.sm'),", "gap: token('spacing.xl'),"),
      'utf8',
    );
    const result = runBuild(project, ['--inject-failure=after-compile']);
    expect(result.status).toBe(1);
    expect(result.codes).toContain('PMS_INJECTED_FAILURE');
    expect(result.stderr).not.toContain('unexpected build error');
  });

  test('after a failed generation every artifact still carries the same digest', () => {
    // The strongest form of "no mix": the design system changes, the build then
    // fails inside the publication window, and all three artifacts that embed a
    // registryDigest must still agree on the OLD one. A build that wrote the
    // design-system module during the build would leave the new digest there and
    // the old one in the manifest.
    const project = freshCopyOf('valid');
    expect(runBuild(project).status).toBe(0);
    const out = path.join(project, 'generated');
    const beforeDigest = JSON.parse(
      fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'),
    ).registryDigest;

    const def = path.join(
      path.dirname(project),
      '_shared',
      'design.pms.config.mjs',
    );
    fs.writeFileSync(
      def,
      fs
        .readFileSync(def, 'utf8')
        .replace(
          "zero: { value: '0', visibility: 'public' },",
          "zero: { value: '0.5px', visibility: 'public' },",
        ),
      'utf8',
    );

    const failed = runBuild(project, ['--inject-failure=after-compile']);
    expect(failed.status).toBe(1);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'),
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(out, 'build-report.json'), 'utf8'),
    );
    const moduleSource = fs.readFileSync(
      path.join(out, 'design.pandamstyle.js'),
      'utf8',
    );
    const marker = JSON.parse(
      moduleSource.match(/__pandamstyle = (\{[\s\S]*?\n\});/)[1],
    );

    expect(manifest.registryDigest).toBe(beforeDigest);
    expect(report.registryDigest).toBe(beforeDigest);
    expect(marker.designSystem.registryDigest).toBe(beforeDigest);
    // And the stylesheet still describes the same generation.
    expect(fs.readFileSync(path.join(out, 'styles.css'), 'utf8')).toContain(
      '--x',
    );
  });

  test('a failing FIRST build publishes nothing at all', () => {
    const project = freshCopyOf('neg-forbidden-value');
    const result = runBuild(project);
    expect(result.status).toBe(1);
    const out = path.join(project, 'generated');
    // No manifest, so no generation claims to be current.
    expect(fs.existsSync(path.join(out, 'manifest.json'))).toBe(false);
  });

  test('a failing build leaves no staging or backup directory behind', () => {
    const project = freshCopyOf('neg-forbidden-value');
    runBuild(project);
    const parent = path.dirname(path.join(project, 'generated'));
    const strays = fs
      .readdirSync(parent)
      .filter((n) => n.includes('.staging-') || n.includes('.backup-'));
    expect(strays).toEqual([]);
  });

  test('a successful build leaves no staging or backup directory behind', () => {
    const project = freshCopyOf('valid');
    expect(runBuild(project).status).toBe(0);
    const parent = path.dirname(path.join(project, 'generated'));
    const strays = fs
      .readdirSync(parent)
      .filter((n) => n.includes('.staging-') || n.includes('.backup-'));
    expect(strays).toEqual([]);
  });

  test('two consecutive valid builds are byte-identical', () => {
    const project = freshCopyOf('valid');
    expect(runBuild(project).status).toBe(0);
    const first = digestTree(path.join(project, 'generated'));
    expect(runBuild(project).status).toBe(0);
    expect(digestTree(path.join(project, 'generated'))).toEqual(first);
  });
});
