/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47): manifest schema version 3, and what a frozen version 2 reader
 * does with it.
 *
 * Design note D2 kept version 2, on the premise that `range` was optional.
 * The CE-02.1 generated declarations require `range` on `opacity`, `flex`,
 * `flexGrow` and `flexShrink` (TS2741 on a CE-02.2 entry), so the premise is
 * false: the orchestrator decided version 3. This suite proves the contract
 * with frozen CE-02.1 artifacts:
 *
 *   - fixtures/ce022-manifest-v2/ce021-artifact-set.json: an artifact set the
 *     CE-02.1 compiler (8d8f3b7) generated with generate.cjs;
 *   - fixtures/ce022-manifest-v2/ce021-reader.bundle.txt: the CE-02.1 reader,
 *     `validateArtifactSet` of 8d8f3b7, bundled verbatim (esbuild, CommonJS,
 *     see FROZEN_READER below);
 *   - CE-02.1-typed code (its generated `.d.ts`) accepts a v2 manifest and
 *     rejects a v3 one, at runtime and with tsc; the CE-02.2 reader accepts
 *     v3 and refuses a newer version explicitly.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadCompiler } = require('./session-helpers');

const compiler = loadCompiler();
const REPO = path.resolve(__dirname, '../../../..');
const FIXTURE = path.join(__dirname, 'fixtures/ce022-manifest-v2');
const CE021_COMMIT = '8d8f3b7847f70602d866d98234c73c4fc5b07402';
// The frozen CE-02.1 reader: in a checkout of CE021_COMMIT,
//   esbuild packages/compiler/src/artifacts/metadata/artifact-set.js --bundle \
//     --platform=node --format=cjs --legal-comments=none
// (esbuild 0.27.7). Its source file has sha256 d1d6b03e…79b1 at that commit.
const FROZEN_READER = {
  file: 'ce021-reader.bundle.txt',
  sha256: '0f5758b55a2b1c167e4ec96a46fa5022d37658e31dcdcf14ea9bed4e8fb3805c',
};

const ce021 = JSON.parse(
  fs.readFileSync(path.join(FIXTURE, 'ce021-artifact-set.json'), 'utf8'),
);
const definition = require('./fixtures/ce022-manifest-v2/definition.cjs');

function loadFrozenReader() {
  const text = fs.readFileSync(path.join(FIXTURE, FROZEN_READER.file), 'utf8');
  expect(crypto.createHash('sha256').update(text).digest('hex')).toBe(
    FROZEN_READER.sha256,
  );
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', text)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}
const frozen = loadFrozenReader();

function ce022Set() {
  const ds = compiler.buildDesignSystem(definition);
  return compiler.createArtifactSet(ds.snapshot, {
    designModuleFile: 'design.pandamstyle.js',
    declarationsFile: 'design.pandamstyle.d.ts',
    designModule: compiler.generateDesignSystemModule({ designSystem: ds }),
    declarations: compiler.generateDesignSystemDeclarations(ds.snapshot),
    manifest: `${JSON.stringify(ds.snapshot.tooling.manifest, null, 2)}\n`,
    css: compiler.withDesignSystemCssIdentity(
      ds.renderCss(),
      ds.snapshot.identity,
    ),
  });
}
const ce022 = ce022Set();
const v2Manifest = JSON.parse(ce021.contents.manifest);
const v3Manifest = JSON.parse(ce022.contents.manifest);

describe('the fixtures', () => {
  test('are CE-02.1 output and the CE-02.2 set is version 3', () => {
    expect(ce021.provenance.sourceCommit).toBe(CE021_COMMIT);
    expect(v2Manifest.manifestSchemaVersion).toBe(2);
    expect(v2Manifest.properties.catalogVersion).toBe(1);
    expect(v2Manifest.properties.byProperty.opacity).toEqual({
      range: { min: 0, max: 1, legacy: true },
    });
    expect(v3Manifest.manifestSchemaVersion).toBe(3);
    expect(ce022.metadata.manifestSchemaVersion).toBe(3);
    expect(v3Manifest.properties.catalogVersion).toBe(2);
    expect(ce022.contents.manifest).not.toMatch(/"range"/);
    expect(v3Manifest.properties.byProperty.opacity.values).toHaveLength(21);
  });

  test('describe the same system', () => {
    for (const field of ['systemId', 'registryDigest', 'abiVersion']) {
      expect({ field, value: ce022.metadata[field] }).toEqual({
        field,
        value: ce021.metadata[field],
      });
    }
  });
});

describe('the frozen CE-02.1 reader (manifest version 2)', () => {
  test('accepts the CE-02.1 artifact set', () => {
    expect(frozen.validateArtifactSet(ce021.metadata, ce021.contents)).toBe(
      true,
    );
  });

  test('refuses the CE-02.2 artifact set on its schema version', () => {
    expect(() =>
      frozen.validateArtifactSet(ce022.metadata, ce022.contents),
    ).toThrow(/unsupported schema or compiler identity/);
  });

  test('still refuses a tampered CE-02.1 set', () => {
    const contents = {
      ...ce021.contents,
      manifest: ce021.contents.manifest.replace(
        '"legacy": true',
        '"legacy": false',
      ),
    };
    expect(contents.manifest).not.toBe(ce021.contents.manifest);
    expect(() => frozen.validateArtifactSet(ce021.metadata, contents)).toThrow(
      /manifest/,
    );
  });
});

describe('the CE-02.2 reader (manifest version 3)', () => {
  test('accepts the CE-02.2 artifact set', () => {
    expect(compiler.validateArtifactSet(ce022.metadata, ce022.contents)).toBe(
      true,
    );
  });

  test('refuses the version 2 artifact set', () => {
    expect(() =>
      compiler.validateArtifactSet(ce021.metadata, ce021.contents),
    ).toThrow(/unsupported schema or compiler identity/);
  });

  test('refuses a newer version explicitly', () => {
    const metadata = { ...ce022.metadata, manifestSchemaVersion: 4 };
    expect(() =>
      compiler.validateArtifactSet(metadata, ce022.contents),
    ).toThrow(
      /manifest schema version 4 is newer than this reader's version 3/,
    );
  });
});

// ---------------------------------------------------------------------------
// The same contract for typed readers: the CE-02.1 and CE-02.2 generated
// declarations of one system, checked by tsc.

function typecheck(files) {
  const outputRoot = path.join(REPO, 'out-pandamstyle');
  fs.mkdirSync(outputRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(outputRoot, 'ce022-manifest-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), text);
    }
    const result = spawnSync(
      path.join(REPO, 'node_modules/.bin/tsc'),
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'node',
        path.join(root, 'probe.ts'),
      ],
      { cwd: REPO, encoding: 'utf8' },
    );
    return `${result.stdout}${result.stderr}`
      .split('\n')
      .filter((line) => line.includes('probe.ts('))
      .map((line) => line.slice(line.indexOf('probe.ts(')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('typed readers (tsc)', () => {
  const lit = (value) => JSON.stringify(value);
  const lines = [
    "import { manifest as ce021 } from './ce021-design';",
    "import { manifest as ce022 } from './ce022-design';",
    'type V2 = typeof ce021;',
    'type V3 = typeof ce022;',
    // A CE-02.1 defect, kept by its frozen types: the manifest's own
    // `schemaVersion` is typed 1 while the manifest carries 2. CE-02.2 types
    // it from the manifest (line 6 reads the whole v3 manifest).
    `const { schemaVersion: _v2Schema, ...v2Rest } = ${lit(v2Manifest)} as const;`,
    `export const v2ReadsV2: Omit<V2, ${lit('schemaVersion')}> = v2Rest;`,
    `export const v3ReadsV3: V3 = ${lit(v3Manifest)};`,
    `export const v2ReadsV3Version: V2['manifestSchemaVersion'] = ${lit(v3Manifest.manifestSchemaVersion)};`,
    `const v3Opacity = ${lit(v3Manifest.properties.byProperty.opacity)} as const;`,
    `export const v2ReadsV3Opacity: V2[${lit('properties')}][${lit('byProperty')}][${lit('opacity')}] = v3Opacity;`,
    `export const v3ReadsV2Version: V3['manifestSchemaVersion'] = ${lit(v2Manifest.manifestSchemaVersion)};`,
    `export const v2SchemaField: V2['schemaVersion'] = ${lit(v2Manifest.schemaVersion)};`,
    '',
  ];
  const errors = typecheck({
    'ce021-design.d.ts': ce021.contents.declarations,
    'ce022-design.d.ts': ce022.contents.declarations,
    'probe.ts': lines.join('\n'),
  });
  const lineOf = (name) =>
    lines.findIndex((l) => l.includes(`const ${name}`)) + 1;
  const at = (name) =>
    errors.filter((e) => e.startsWith(`probe.ts(${lineOf(name)},`));

  test('each reader reads its own version', () => {
    expect(at('v2ReadsV2')).toEqual([]);
    expect(at('v3ReadsV3')).toEqual([]);
  });

  test('the CE-02.1 types refuse version 3 explicitly', () => {
    expect(at('v2ReadsV3Version').join('\n')).toMatch(
      /TS2322: Type '3' is not assignable to type '2'/,
    );
  });

  test('the CE-02.1 types require range on a former range row', () => {
    expect(at('v2ReadsV3Opacity').join('\n')).toMatch(
      /TS2741: Property 'range' is missing/,
    );
  });

  test('the CE-02.2 types refuse version 2', () => {
    expect(at('v3ReadsV2Version').join('\n')).toMatch(
      /TS2322: Type '2' is not assignable to type '3'/,
    );
  });

  test('the CE-02.1 schemaVersion defect is pinned', () => {
    expect(at('v2SchemaField').join('\n')).toMatch(
      /TS2322: Type '2' is not assignable to type '1'/,
    );
  });

  test('no other error', () => {
    const expected = [
      'v2ReadsV3Version',
      'v2ReadsV3Opacity',
      'v3ReadsV2Version',
      'v2SchemaField',
    ].map(lineOf);
    expect(
      errors.filter(
        (e) => !expected.some((line) => e.startsWith(`probe.ts(${line},`)),
      ),
    ).toEqual([]);
  });
});
