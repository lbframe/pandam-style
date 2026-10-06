/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

'use strict';

const fs = require('fs');
const {
  TraceMap,
  originalPositionFor,
  eachMapping,
} = require('@jridgewell/trace-mapping');
const { openProject } = require('./session-helpers');

function position(code, marker) {
  const offset = code.indexOf(marker);
  expect(offset).toBeGreaterThanOrEqual(0);
  const before = code.slice(0, offset);
  return {
    line: before.split('\n').length,
    column: offset - before.lastIndexOf('\n') - 1,
  };
}

test('maps compose style rewrites, TypeScript and JSX back to exact original bytes', async () => {
  const fixture = openProject('valid');
  const text =
    "'use client';\nimport { create, props } from '../generated/design.pandamstyle';\nconst styles = create({ root: { display: 'flex' } });\nexport function Broken(value: string) { throw new Error('dx-marker'); }\nexport function View() { return <div {...props(styles.root)}>dx-child</div>; }\n";
  fs.writeFileSync(fixture.src('src/dx.tsx'), text);
  const project = fixture.openPublicSession({ acceptedSnapshotRetention: {} });
  try {
    const initial = await project.initialize();
    const validated = await project.validate(initial.revision);
    expect(validated.ok).toBe(true);
    const artifact = await project.readArtifact(
      validated.revision,
      'src/dx.tsx',
    );
    const map = JSON.parse(artifact.sourceMap);
    expect(map.version).toBe(3);
    expect(map.sources).toEqual(['src/dx.tsx']);
    expect(map.sourcesContent).toEqual([text]);
    expect(artifact.javascript).not.toContain('value: string');
    expect(artifact.javascript).toContain('__pmsProps');
    for (const marker of ['dx-marker', 'dx-child']) {
      const mapped = originalPositionFor(
        new TraceMap(map),
        position(artifact.javascript, marker),
      );
      expect(mapped.source).toBe('src/dx.tsx');
      expect(mapped.line).toBe(position(text, marker).line);
      // Babel anchors a string token at its opening quote.
      expect(mapped.column).toBeLessThanOrEqual(position(text, marker).column);
      expect(position(text, marker).column - mapped.column).toBeLessThanOrEqual(
        1,
      );
    }
    await project.compile(validated.revision);
    const pin = await project.pinAcceptedSnapshot(validated.revision, {
      owner: 'source-map-test',
    });
    const old = await project.readAcceptedArtifact(
      pin,
      'src/dx.tsx',
      artifact.sourceDigest,
    );
    expect(old.sourceMap).toBe(artifact.sourceMap);
    const overlay = '\n\n' + text;
    const changed = await project.applyChanges({
      baseRevision: validated.revision,
      mode: 'verified-explicit',
      changed: ['src/dx.tsx'],
      added: [],
      removed: [],
      renamed: [],
      sourceOverlays: [{ file: 'src/dx.tsx', source: overlay }],
    });
    const next = await project.validate(changed.revision);
    expect(next.ok).toBe(true);
    const newer = await project.readArtifact(next.revision, 'src/dx.tsx');
    expect(JSON.parse(newer.sourceMap).sourcesContent).toEqual([overlay]);
    expect(
      originalPositionFor(
        new TraceMap(JSON.parse(newer.sourceMap)),
        position(newer.javascript, 'dx-marker'),
      ).line,
    ).toBe(position(overlay, 'dx-marker').line);
    expect(
      (
        await project.readAcceptedArtifact(
          pin,
          'src/dx.tsx',
          artifact.sourceDigest,
        )
      ).sourceMap,
    ).toBe(old.sourceMap);
    await project.releaseAcceptedSnapshot(pin);
  } finally {
    await project.close();
  }
});

test('layered and conditional CSS selectors map to real create and pattern calls while config CSS is unmapped', async () => {
  const fixture = openProject('valid');
  const patternSource = [
    "import { patterns, token, themes, props } from '../generated/design.pandamstyle';",
    "const layout = patterns.stack({ gap: token('spacing.md') });",
    'export const patterned = props(themes.dark, layout);',
    '',
  ].join('\n');
  fs.writeFileSync(fixture.src('src/page.js'), patternSource);
  const project = fixture.openPublicSession({
    useCSSLayers: true,
    engineOptions: {
      enableLogicalStylesPolyfill: true,
      styleResolution: 'legacy-expand-shorthands',
    },
  });
  fs.writeFileSync(
    fixture.src('src/rtl.js'),
    "import { create, token } from '../generated/design.pandamstyle';\nexport const styles = create({ root: { marginInlineStart: { base: token('spacing.md'), wide: token('spacing.lg') } } });\n",
  );
  try {
    const initial = await project.initialize();
    const validated = await project.validate(initial.revision);
    expect(validated.ok).toBe(true);
    const artifact = await project.readArtifact(
      validated.revision,
      'src/page.js',
    );
    const css = artifact.css[0];
    expect(css.content).toContain('@layer');
    expect(css.content).toContain('@media');
    expect(css.content).toContain("html[dir='rtl']");
    const map = new TraceMap(JSON.parse(css.sourceMap));
    let mapped = 0;
    let patternMapped = 0;
    eachMapping(map, (mapping) => {
      if (mapping.source == null) return;
      mapped++;
      const original =
        map.sourcesContent[map.sources.indexOf(mapping.source)].split('\n')[
          mapping.originalLine - 1
        ];
      expect(original).toMatch(/create|pmsCreate|patterns\.stack/);
      const generatedLines = css.content.split('\n');
      const generated = generatedLines[mapping.generatedLine - 1].slice(
        mapping.generatedColumn,
      );
      expect(generated).toMatch(/^\.x/);
      if (/patterns\.stack/.test(original)) patternMapped++;
    });
    expect(mapped).toBeGreaterThan(5);
    expect(patternMapped).toBeGreaterThan(0);
    expect(originalPositionFor(map, { line: 1, column: 0 }).source).toBeNull();
  } finally {
    await project.close();
  }
});
