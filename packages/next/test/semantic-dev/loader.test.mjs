/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import loader from '../../src/turbopack-loader.cjs';
import { createCoordinator } from '../../src/coordinator.js';
import { createSupervisor } from '../../src/supervisor.js';
import transport from '../../src/transport-client.cjs';
import {
  fixture,
  definition,
  source,
  hash,
  canonical,
  current,
  status,
} from './coordinator-fixture.mjs';

const { request } = transport;
const loaderFile = fileURLToPath(
  new URL('../../src/turbopack-loader.cjs', import.meta.url),
);
const codeOf = (error) => error.code ?? error.diagnostics?.[0]?.code;

/** Public loader context only. Timeout is a test failure guard. */
function invoke(file, input, options, inputMap = null) {
  const dependencies = new Set();
  const contexts = new Set();
  const cacheable = [];
  const result = { dependencies, contexts, cacheable, callbacks: 0 };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error('Loader did not invoke its public async callback.')),
      5000,
    );
    const context = {
      resourcePath: file,
      rootContext: path.dirname(file),
      getOptions: () => options,
      addDependency: (dependency) => dependencies.add(dependency),
      addContextDependency: (directory) => contexts.add(directory),
      cacheable: (value) => cacheable.push(value),
      async: () => (error, code, map) => {
        clearTimeout(timer);
        result.callbacks += 1;
        Object.assign(result, { error, code, map });
        resolve(result);
      },
    };
    try {
      loader.call(context, input, inputMap);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function supervised(t, item, options, createOwner, command = 'dev') {
  const supervisor = await createSupervisor(item.root, {
    command,
    createOwner,
  });
  t.after(async () => {
    try {
      await supervisor.close();
    } finally {
      item.cleanup();
    }
  });
  const registered = await request(supervisor.credentialFile, 'register', {
    root: item.root,
    command,
    options,
    distDir: '.next',
  });
  return {
    item,
    supervisor,
    options: {
      protocolVersion: 1,
      credentialFile: supervisor.credentialFile,
      projectId: registered.projectId,
      sessionId: registered.sessionId,
      statusFile: registered.statusFile,
      currentFile: registered.currentFile,
      roots: registered.roots,
      definitionPath: registered.definitionPath,
    },
    get owner() {
      return supervisor.owner;
    },
    run(relative = 'semantic/page.js', input, map) {
      const file = item.file(relative);
      return invoke(
        file,
        input ?? fs.readFileSync(file, 'utf8'),
        this.options,
        map,
      );
    },
  };
}

async function realFixture(t, { prepare, options = {}, command = 'dev' } = {}) {
  const item = fixture();
  prepare?.(item);
  return supervised(
    t,
    item,
    {
      ...item.options,
      publicationMode: command === 'dev' ? 'semantic-dev' : 'strict',
      ...options,
    },
    createCoordinator,
    command,
  );
}

/** Explicit UNIT owner: exercises hostile transport pairs, not compiler behavior. */
async function unitFixture(
  t,
  { javascript, generatedImports = [], respond } = {},
) {
  const item = fixture();
  const projectId = 'loader-unit:' + path.basename(item.root);
  const sessionId = randomUUID();
  const revision = { projectId, sessionId, revisionId: 1 };
  const directory = item.file('unit-immutable-snapshot');
  fs.mkdirSync(directory);
  const descriptor = {
    schemaVersion: 1,
    protocolVersion: 1,
    accepted: true,
    projectId,
    sessionId,
    snapshotId: 'unit-immutable-snapshot',
    associationRevision: revision,
    artifactRevision: revision,
    generationId: 1,
    canonicalSetDigest: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64),
    artifactSetDigest: 'c'.repeat(64),
    candidateDigest: 'd'.repeat(64),
    designSystem: { systemId: 'loader-unit', registryDigest: 'e'.repeat(64) },
    abiVersion: 1,
    directory,
    descriptorFile: path.join(directory, 'descriptor.json'),
    designJS: path.join(directory, 'design.js'),
    stylesCSS: path.join(directory, 'styles.css'),
  };
  descriptor.files = [
    ['design.js', 'design-module', 'export const x = 1;\n'],
    ['design.d.ts', 'declarations', 'export declare const x: number;\n'],
    ['manifest.json', 'manifest', '{}\n'],
    ['styles.css', 'css', '.unit { color: blue; }\n'],
    ['artifacts.json', 'artifact-metadata', '{}\n'],
  ].map(([file, kind, content]) => {
    const target = path.join(directory, file);
    fs.writeFileSync(target, content);
    return {
      file,
      kind,
      path: target,
      sha256: hash(content),
      bytes: Buffer.byteLength(content),
    };
  });
  fs.writeFileSync(
    descriptor.descriptorFile,
    JSON.stringify(descriptor) + '\n',
  );
  const requests = [];
  let nextResponse;
  const unit = await supervised(t, item, item.options, async () => ({
    projectId,
    sessionId,
    registerDescription: () => ({
      projectId,
      sessionId,
      roots: [item.file('semantic')],
      statusFile: item.file('unit-status.json'),
      currentFile: item.file('unit-current.json'),
      definitionPath: item.file('unit-definition.mjs'),
    }),
    async transform(payload) {
      requests.push(payload);
      const result = {
        descriptor,
        snapshot: descriptor,
        revision,
        dependencies: [descriptor.descriptorFile, item.file('unit-extra.js')],
        artifact: {
          source: 'semantic/page.js',
          sourceDigest: payload.sourceDigest,
          revision,
          javascript: javascript ?? 'export const unit = 1;\n',
          sourceMap: null,
          css: '.unit { color: blue; }\n',
          designSystem: descriptor.designSystem,
          abiVersion: descriptor.abiVersion,
          dependencies: ['unit-extra.js'],
          generatedImports,
          provenance: {
            projectId,
            sessionId,
            snapshotId: descriptor.snapshotId,
            associationRevision: revision,
            artifactRevision: revision,
            transformedRevision: revision,
            generationId: descriptor.generationId,
            canonicalSetDigest: descriptor.canonicalSetDigest,
            artifactDigest: descriptor.artifactDigest,
            candidateDigest: descriptor.candidateDigest,
          },
        },
      };
      return (nextResponse ?? respond)?.(result, payload) ?? result;
    },
    close: async () => {},
  }));
  return {
    ...unit,
    descriptor,
    requests,
    setResponse(value) {
      nextResponse = value;
    },
  };
}

function earlyDependencies(result, options) {
  for (const file of [
    options.credentialFile,
    options.statusFile,
    options.currentFile,
    options.definitionPath,
  ])
    if (file != null) assert.equal(result.dependencies.has(file), true, file);
  for (const directory of options.roots)
    assert.equal(result.contexts.has(directory), true, directory);
}

function snapshotImports(code, file, descriptor) {
  const literals = [...code.matchAll(/"(?:[^"\\]|\\.)*"/g)]
    .map(([literal]) => JSON.parse(literal))
    .filter((value) => /^(?:\.\/|\.\.\/)/.test(value));
  const references = {};
  for (const field of ['designJS', 'stylesCSS']) {
    const specifiers = literals.filter(
      (specifier) =>
        path.resolve(path.dirname(file), specifier) === descriptor[field],
    );
    assert.ok(specifiers.length > 0, field);
    for (const specifier of specifiers) {
      assert.equal(path.isAbsolute(specifier), false);
      assert.equal(specifier.includes('\\'), false);
    }
    references[field] = specifiers[0];
  }
  return references;
}

test('real SDK output preserves client directive, compiler map and one immutable JS/CSS snapshot', async (t) => {
  const text =
    "'use client';\n" + source() + "export * from '../generated/design.js';\n";
  const f = await realFixture(t, {
    prepare: (item) => fs.writeFileSync(item.file('semantic/page.js'), text),
  });
  const result = await f.run('semantic/page.js', text, {
    version: 3,
    sources: ['original.js'],
  });
  assert.equal(result.error, null);
  assert.equal(result.callbacks, 1);
  assert.equal(result.map.version, 3);
  assert.deepEqual(result.map.sourcesContent, [text]);
  assert.match(result.code, /^['"]use client['"];?/);
  const descriptor = current(f.owner);
  snapshotImports(result.code, f.item.file('semantic/page.js'), descriptor);
  assert.equal(result.dependencies.has(descriptor.descriptorFile), true);
  earlyDependencies(result, f.options);
});

test('real uncovered Next source passes through original bytes and original map', async (t) => {
  const f = await realFixture(t);
  const text = "'use client';\nexport const label = '🧪 untouched';\n";
  fs.writeFileSync(f.item.file('app/page.jsx'), text);
  const originalMap = {
    version: 3,
    sources: ['app/page.jsx'],
    names: [],
    mappings: '',
  };
  const before = current(f.owner);
  const result = await f.run('app/page.jsx', text, originalMap);
  assert.equal(result.error, null);
  assert.equal(result.code, text);
  assert.equal(result.map, originalMap);
  assert.equal(current(f.owner).snapshotId, before.snapshotId);
  earlyDependencies(result, f.options);
});

test('UNIT node_modules resource passes through original bytes and map without IPC or dependency registration', async (t) => {
  const item = fixture();
  t.after(() => item.cleanup());
  const resource = item.file('node_modules/unit-vendor/component.jsx');
  fs.mkdirSync(path.dirname(resource), { recursive: true });
  const sourceBytes = "'use client';\nexport const vendor = '🧪 untouched';\n";
  fs.writeFileSync(resource, sourceBytes);
  const inputMap = {
    version: 3,
    sources: ['component.jsx'],
    names: [],
    mappings: 'AAAA',
  };
  const result = await invoke(
    resource,
    sourceBytes,
    {
      protocolVersion: 999,
      credentialFile: item.file('nonexistent-credential.json'),
      statusFile: item.file('status-must-not-be-registered.json'),
      currentFile: item.file('current-must-not-be-registered.json'),
      definitionPath: item.file('definition-must-not-be-registered.mjs'),
      roots: [item.file('semantic')],
    },
    inputMap,
  );
  assert.equal(result.error, null);
  assert.equal(result.callbacks, 1);
  assert.equal(result.code, sourceBytes);
  assert.equal(result.map, inputMap);
  assert.equal(result.dependencies.size, 0);
  assert.equal(result.contexts.size, 0);
  assert.deepEqual(result.cacheable, []);
  assert.equal(fs.existsSync(item.file('nonexistent-credential.json')), false);
});

test('real strict preview transports prepared JS/CSS without canonical publication or invented source maps', async (t) => {
  const text = source() + "export * from '../generated/design.js';\n";
  const f = await realFixture(t, {
    command: 'build',
    prepare: (item) => fs.writeFileSync(item.file('semantic/page.js'), text),
  });
  assert.equal(fs.existsSync(f.item.file('generated/design.js')), false);
  const result = await f.run();
  assert.equal(result.error, null);
  assert.equal(result.map.version, 3);
  const descriptor = current(f.owner);
  assert.equal(descriptor.accepted, false);
  snapshotImports(result.code, f.item.file('semantic/page.js'), descriptor);
  assert.equal(fs.existsSync(f.item.file('generated/design.js')), false);
});

test('real semantic failure retains canonical generation, tracks error dependencies and repairs exact input', async (t) => {
  const f = await realFixture(t);
  const before = canonical(f.item);
  const beforeDescriptor = current(f.owner);
  fs.writeFileSync(f.item.file('semantic/page.js'), source('missing'));
  const invalid = await f.run();
  assert.ok(
    invalid.error.diagnostics.some(
      (diagnostic) => diagnostic.code === 'PMS_UNKNOWN_TOKEN',
    ),
  );
  assert.equal(invalid.code, undefined);
  assert.deepEqual(canonical(f.item), before);
  assert.equal(current(f.owner).snapshotId, beforeDescriptor.snapshotId);
  earlyDependencies(invalid, f.options);
  fs.writeFileSync(f.item.file('semantic/page.js'), source('accent'));
  const repaired = await f.run();
  assert.equal(repaired.error, null);
  assert.notEqual(current(f.owner).snapshotId, beforeDescriptor.snapshotId);
  assert.notDeepEqual(canonical(f.item), before);
});

test('real compiler policy rejects raw CSS without publishing invalid output', async (t) => {
  const f = await realFixture(t);
  const before = canonical(f.item);
  fs.writeFileSync(
    f.item.file('semantic/page.js'),
    source().replace("token('colors.ink')", "'red'"),
  );
  const result = await f.run();
  assert.ok(
    result.error.diagnostics.some(
      (diagnostic) => diagnostic.code === 'PMS_FORBIDDEN_VALUE',
    ),
  );
  assert.equal(result.code, undefined);
  assert.deepEqual(canonical(f.item), before);
  earlyDependencies(result, f.options);
});

test('real compiler rejects private consumer tokens and preserves the accepted generation', async (t) => {
  const f = await realFixture(t, {
    options: {
      definition: {
        ...definition,
        tokens: {
          ...definition.tokens,
          colors: {
            ...definition.tokens.colors,
            secret: { value: '#abcdef', visibility: 'private' },
          },
        },
      },
    },
  });
  const before = canonical(f.item);
  fs.writeFileSync(f.item.file('semantic/page.js'), source('secret'));
  const result = await f.run();
  assert.ok(
    result.error.diagnostics.some(
      (diagnostic) => diagnostic.code === 'PMS_TOKEN_NOT_PUBLIC',
    ),
  );
  assert.equal(result.code, undefined);
  assert.deepEqual(canonical(f.item), before);
  earlyDependencies(result, f.options);
});

test('old loader source digest cannot overlay newer disk or compiler output', async (t) => {
  const f = await realFixture(t);
  const original = source();
  const fresh = source('accent');
  fs.writeFileSync(f.item.file('semantic/page.js'), fresh);
  assert.equal((await f.run()).error, null);
  const before = canonical(f.item);
  const descriptor = current(f.owner);
  const stale = await f.run('semantic/page.js', original);
  assert.equal(codeOf(stale.error), 'PMS_STALE_REVISION');
  assert.equal(stale.code, undefined);
  assert.deepEqual(stale.cacheable, [false]);
  assert.equal(fs.readFileSync(f.item.file('semantic/page.js'), 'utf8'), fresh);
  assert.deepEqual(canonical(f.item), before);
  assert.equal(current(f.owner).snapshotId, descriptor.snapshotId);
  earlyDependencies(stale, f.options);
});

test('real imported dependency outside semantic roots can invalidate an unchanged consumer and repair', async (t) => {
  const dependency = source();
  const consumer = "export { box } from '../shared/styles.js';\n";
  const f = await realFixture(t, {
    prepare(item) {
      fs.mkdirSync(item.file('shared'));
      fs.writeFileSync(item.file('shared/styles.js'), dependency);
      fs.writeFileSync(item.file('semantic/page.js'), consumer);
    },
  });
  const first = await f.run();
  assert.equal(first.error, null);
  assert.equal(first.dependencies.has(f.item.file('shared/styles.js')), true);
  const before = canonical(f.item);
  fs.writeFileSync(
    f.item.file('shared/styles.js'),
    dependency.replace('colors.ink', 'colors.missing'),
  );
  const invalid = await f.run();
  assert.ok(
    invalid.error.diagnostics.some(
      (diagnostic) => diagnostic.code === 'PMS_UNKNOWN_TOKEN',
    ),
  );
  assert.deepEqual(canonical(f.item), before);
  assert.equal(invalid.dependencies.has(f.item.file('shared/styles.js')), true);
  assert.ok(
    invalid.error.dependencies.includes(f.item.file('shared/styles.js')),
  );
  fs.writeFileSync(f.item.file('shared/styles.js'), dependency);
  const repaired = await f.run();
  assert.equal(repaired.error, null);
  assert.equal(
    repaired.dependencies.has(f.item.file('shared/styles.js')),
    true,
  );
  assert.equal(
    fs.readFileSync(f.item.file('semantic/page.js'), 'utf8'),
    consumer,
  );
});

test('definition entry failure registers its dependency before error and repairs without consumer edits', async (t) => {
  const valid = 'export default ' + JSON.stringify(definition) + ';\n';
  const f = await realFixture(t, {
    prepare: (item) => fs.writeFileSync(item.file('definition.mjs'), valid),
    options: { definition: 'definition.mjs' },
  });
  const before = canonical(f.item);
  fs.writeFileSync(
    f.item.file('definition.mjs'),
    "throw new Error('unit entry failure');\n",
  );
  const invalid = await f.run();
  assert.equal(codeOf(invalid.error), 'PMS_INVALID_DEFINITION');
  assert.equal(invalid.error.details.owner, 'coordinator-definition-input');
  assert.equal(invalid.error.details.file, f.item.file('definition.mjs'));
  assert.equal(
    invalid.error.details.digest,
    hash(fs.readFileSync(f.item.file('definition.mjs'))),
  );
  assert.deepEqual(invalid.error.details.revision, status(f.owner).revision);
  assert.equal(invalid.error.details.revision.projectId, f.owner.projectId);
  assert.equal(invalid.error.details.revision.sessionId, f.owner.sessionId);
  assert.equal(invalid.dependencies.has(f.item.file('definition.mjs')), true);
  assert.deepEqual(canonical(f.item), before);
  earlyDependencies(invalid, f.options);
  fs.writeFileSync(f.item.file('definition.mjs'), valid);
  const repaired = await f.run();
  assert.equal(repaired.error, null);
  assert.equal(
    fs.readFileSync(f.item.file('semantic/page.js'), 'utf8'),
    source(),
  );
});

test('UNIT compiler-owned literal offsets rewrite only intended references, including UTF16 positions', async (t) => {
  let javascript =
    "'use client';\nconst emoji = '🧪';\n// import '../generated/design.js';\nconst lookalike = \"import '../generated/design.js'\";\nfunction shadowed(require) { return require('../generated/design.js'); }\n";
  const generatedImports = [];
  for (const [before, after] of [
    ['import { x } from ', ';\n'],
    ['export { x as y } from ', ';\n'],
    ['export async function dynamic() { return import(', '); }\n'],
    ['const cjs = require(', ');\n'],
  ]) {
    javascript += before;
    const start = javascript.length;
    javascript += "'../generated/design.js'";
    generatedImports.push({
      start,
      end: javascript.length,
      kind: 'design-module',
    });
    javascript += after;
  }
  const f = await unitFixture(t, { javascript, generatedImports });
  const text = fs.readFileSync(f.item.file('semantic/page.js'), 'utf8');
  const result = await f.run('semantic/page.js', text);
  assert.equal(result.error, null);
  const references = snapshotImports(
    result.code,
    f.item.file('semantic/page.js'),
    f.descriptor,
  );
  let expected = javascript;
  for (const { start, end } of [...generatedImports].reverse())
    expected =
      expected.slice(0, start) +
      JSON.stringify(references.designJS) +
      expected.slice(end);
  assert.equal(result.code.startsWith(expected), true);
  assert.equal(
    result.code.slice(expected.length),
    '\nimport ' + JSON.stringify(references.stylesCSS) + ';\n',
  );
  assert.ok(
    result.code.includes(
      "function shadowed(require) { return require('../generated/design.js'); }",
    ),
  );
  assert.equal(result.map, null);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].file, f.item.file('semantic/page.js'));
  assert.equal(f.requests[0].sourceDigest, hash(text));
  assert.equal(f.requests[0].snapshotId, null);
});

test('UNIT mismatched artifact digest, session, revision and snapshot provenance cannot emit code', async (t) => {
  const f = await unitFixture(t);
  for (const [label, mutate] of [
    [
      'source digest',
      (value) => {
        value.artifact.sourceDigest = 'f'.repeat(64);
      },
    ],
    [
      'artifact session',
      (value) => {
        value.artifact.revision = {
          ...value.artifact.revision,
          sessionId: 'old-session',
        };
      },
    ],
    [
      'descriptor session',
      (value) => {
        value.descriptor.sessionId = 'old-session';
      },
    ],
    [
      'association revision',
      (value) => {
        value.artifact.provenance.associationRevision = {
          ...value.artifact.provenance.associationRevision,
          revisionId: 2,
        };
      },
    ],
    [
      'snapshot',
      (value) => {
        value.artifact.provenance.snapshotId = 'other-snapshot';
      },
    ],
    [
      'canonical digest',
      (value) => {
        value.artifact.provenance.canonicalSetDigest = 'f'.repeat(64);
      },
    ],
    [
      'generation',
      (value) => {
        value.artifact.provenance.generationId += 1;
      },
    ],
    [
      'artifact digest',
      (value) => {
        value.artifact.provenance.artifactDigest = 'f'.repeat(64);
      },
    ],
    [
      'candidate digest',
      (value) => {
        value.artifact.provenance.candidateDigest = 'f'.repeat(64);
      },
    ],
    [
      'artifact revision',
      (value) => {
        value.artifact.provenance.artifactRevision = {
          ...value.artifact.provenance.artifactRevision,
          revisionId: 2,
        };
      },
    ],
    [
      'source identity',
      (value) => {
        value.artifact.source = 'semantic/other.js';
      },
    ],
    [
      'system identity',
      (value) => {
        value.artifact.designSystem = {
          ...value.artifact.designSystem,
          systemId: 'other-system',
        };
      },
    ],
    [
      'registry identity',
      (value) => {
        value.artifact.designSystem = {
          ...value.artifact.designSystem,
          registryDigest: 'f'.repeat(64),
        };
      },
    ],
    [
      'ABI identity',
      (value) => {
        value.artifact.abiVersion += 1;
      },
    ],
    [
      'provenance project',
      (value) => {
        value.artifact.provenance.projectId = 'another-project';
      },
    ],
    [
      'provenance session',
      (value) => {
        value.artifact.provenance.sessionId = 'another-session';
      },
    ],
  ]) {
    f.setResponse((result) => {
      const hostile = structuredClone(result);
      mutate(hostile);
      return hostile;
    });
    const result = await f.run();
    assert.ok(result.error, label);
    assert.equal(result.code, undefined, label);
    earlyDependencies(result, f.options);
  }
});

test('UNIT JavaScript and CSS addresses from different snapshot descriptors refuse mixed output', async (t) => {
  const f = await unitFixture(t);
  for (const member of ['design-module', 'css']) {
    f.setResponse((result) => {
      const hostile = structuredClone(result);
      const target = hostile.descriptor.files.find(
        (file) => file.kind === member,
      );
      target.path = f.item.file('another-snapshot/' + target.file);
      hostile.descriptor[member === 'css' ? 'stylesCSS' : 'designJS'] =
        target.path;
      return hostile;
    });
    const result = await f.run();
    assert.equal(codeOf(result.error), 'PMS_TRANSPORT_MIXED_PAIR');
    assert.equal(result.code, undefined);
  }
});

test('UNIT original Buffer bytes are hashed exactly and compiler source maps are rebased for transport', async (t) => {
  const compilerMap = {
    version: 3,
    sources: ['original.jsx'],
    names: [],
    mappings: 'AAAA',
  };
  const f = await unitFixture(t, {
    respond: (result) => ({
      ...result,
      artifact: { ...result.artifact, sourceMap: compilerMap },
    }),
  });
  const bytes = Buffer.from(
    "'use client';\nexport const label = '🧪 original';\n",
    'utf8',
  );
  const result = await f.run('semantic/page.js', bytes, {
    version: 3,
    mappings: 'OTHER',
  });
  assert.equal(result.error, null);
  assert.equal(f.requests[0].sourceDigest, hash(bytes));
  assert.deepEqual(result.map.sources, [f.item.file('original.jsx')]);
  assert.equal(result.map.version, compilerMap.version);
  assert.ok(result.map.mappings.startsWith(compilerMap.mappings));
});

test('UNIT unsupported loader protocol refuses before IPC with dependencies registered', async (t) => {
  const f = await unitFixture(t);
  const result = await invoke(f.item.file('semantic/page.js'), source(), {
    ...f.options,
    protocolVersion: 999,
  });
  assert.equal(codeOf(result.error), 'PMS_TRANSPORT_PROTOCOL');
  assert.equal(f.requests.length, 0);
  assert.equal(result.code, undefined);
  earlyDependencies(result, f.options);
});

test('UNIT malformed or overlapping compiler import offsets refuse output', async (t) => {
  const f = await unitFixture(t, {
    javascript: "import { x } from '../generated/design.js';\n",
  });
  for (const generatedImports of [
    [{ start: -1, end: 9, kind: 'design-module' }],
    [{ start: 18, end: 999, kind: 'design-module' }],
    [{ start: 18, end: 41, kind: 'unknown-member' }],
    [
      { start: 18, end: 41, kind: 'design-module' },
      { start: 20, end: 40, kind: 'design-module' },
    ],
  ]) {
    f.setResponse((result) => ({
      ...result,
      artifact: { ...result.artifact, generatedImports },
    }));
    const result = await f.run();
    assert.ok(result.error);
    assert.equal(result.code, undefined);
  }
});

test('UNIT early IPC error retains bootstrap dependencies and the same loader request can recover', async (t) => {
  let failing = true;
  const f = await unitFixture(t, {
    respond(result) {
      if (!failing) return result;
      const error = new Error(
        'PMS_COORDINATOR_UNAVAILABLE: unit owner unavailable',
      );
      error.code = 'PMS_COORDINATOR_UNAVAILABLE';
      throw error;
    },
  });
  const failed = await f.run();
  assert.equal(codeOf(failed.error), 'PMS_COORDINATOR_UNAVAILABLE');
  assert.equal(failed.code, undefined);
  earlyDependencies(failed, f.options);
  failing = false;
  const repaired = await f.run();
  assert.equal(repaired.error, null);
  assert.equal(repaired.dependencies.has(f.item.file('unit-extra.js')), true);
  earlyDependencies(repaired, f.options);
});

test('loader source contains transport only and cannot construct a compiler or parse private compiler syntax', () => {
  const text = fs.readFileSync(loaderFile, 'utf8');
  assert.doesNotMatch(
    text,
    /@pandamstyle\/compiler|createProjectSession|createHostBridge|@babel\/parser|next\/dist|require\(['"]\.\/coordinator/,
  );
});
