/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createOwner, transportSource, wireCompiler } from '../src/state.js';
import {
  assertReactCompilerQualification,
  REACT_COMPILER_QUALIFICATION,
} from '../src/react-compiler-contract.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');

function hook() {
  const callbacks = [];
  return {
    tap(_name, callback) {
      callbacks.push(callback);
    },
    tapPromise(_name, callback) {
      callbacks.push(callback);
    },
    async call(...args) {
      for (const callback of callbacks) await callback(...args);
    },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-next-phase13-'));
  const route = path.join(
    root,
    'src/app/(main)/dashboard/pandamstyle-qualification/[slug]',
  );
  fs.mkdirSync(route, { recursive: true });
  const source =
    'export default function QualificationLayout({ children }) { return children; }\n';
  const layout = path.join(route, 'layout.tsx');
  fs.writeFileSync(layout, source);
  const revision = {
    projectId: `phase13-${randomUUID()}`,
    sessionId: randomUUID(),
    revisionId: 1,
  };
  const events = [];
  const owner = createOwner(
    root,
    {
      backend: 'webpack',
      roots: ['src/app/(main)/dashboard/pandamstyle-qualification/[slug]'],
      outDir: '.pandamstyle',
      onEvent: (event) => events.push(event),
    },
    true,
    '.next',
  );
  owner.revision = revision;
  owner.validatedRevision = revision;
  owner.project = {
    async current() {
      return { revision };
    },
    async close() {},
  };
  owner.watcher = {
    async flush() {},
    close() {},
  };
  owner.host = {
    async readGeneratedArtifacts() {
      return {
        revision,
        files: [
          {
            kind: 'design-module',
            content: 'export const props = () => ({});\n',
          },
          { kind: 'css', content: '.pms { color: red; }\n' },
        ],
      };
    },
    async readArtifact(_revision, relative) {
      const file = path.join(root, relative);
      const code = fs.readFileSync(file, 'utf8');
      return {
        sourceDigest: digest(code),
        javascript: code,
        dependencies: [],
      };
    },
    async preparePublication() {
      counters.prepared += 1;
      return counters.prepared;
    },
    async abortPrepared() {},
    async commitPrepared() {
      counters.committed += 1;
      return { artifactRevision: revision };
    },
  };
  const counters = { prepared: 0, committed: 0 };
  return { root, layout, source, revision, events, owner, counters };
}

function compiler(name = 'client') {
  return {
    name,
    hooks: {
      beforeCompile: hook(),
      thisCompilation: hook(),
      done: hook(),
      failed: hook(),
      watchClose: hook(),
    },
    watching: { invalidate() {} },
  };
}

test('React Compiler opt-in is restricted to the exact Next/React stack and public config field', () => {
  const config = { reactCompiler: true };
  const versions = { next: '16.3.8', react: '19.3.0', reactDom: '19.3.0' };
  assert.equal(REACT_COMPILER_QUALIFICATION, 'next-16.3.8-react-19.3.0');
  assert.doesNotThrow(() =>
    assertReactCompilerQualification(
      config,
      REACT_COMPILER_QUALIFICATION,
      versions,
    ),
  );
  assert.throws(
    () => assertReactCompilerQualification(config, undefined, versions),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  assert.throws(
    () =>
      assertReactCompilerQualification(
        config,
        'next-16.3.9-react-19.3.0',
        versions,
      ),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  assert.throws(
    () =>
      assertReactCompilerQualification(config, REACT_COMPILER_QUALIFICATION, {
        ...versions,
        react: '19.2.0',
      }),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
  assert.throws(
    () =>
      assertReactCompilerQualification(
        { experimental: { reactCompiler: true } },
        REACT_COMPILER_QUALIFICATION,
        versions,
      ),
    { code: 'PMS_UNSUPPORTED_FEATURE' },
  );
});

test('webpack commits a single generated set for repeated successful compilations of one revision', async (t) => {
  const item = fixture();
  t.after(async () => {
    item.owner.compilers.clear();
    item.owner.closed = true;
    item.owner.watcher.close();
    await item.owner.project.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  });

  const target = compiler();
  wireCompiler(item.owner, target);
  const artifactRevision = {
    ...item.revision,
    sessionId: `artifact-${item.revision.sessionId}`,
  };
  item.owner.host.commitPrepared = async () => {
    item.counters.committed += 1;
    return {
      revision: item.revision,
      associationRevision: item.revision,
      artifactRevision,
    };
  };
  const compilation = {
    errors: [],
    contextDependencies: { add() {} },
    fileDependencies: { add() {} },
  };
  const stats = { hasErrors: () => false, compilation: { errors: [] } };
  for (let index = 0; index < 2; index += 1) {
    await target.hooks.beforeCompile.call();
    await target.hooks.thisCompilation.call(compilation);
    await target.hooks.done.call(stats);
  }

  assert.equal(item.counters.prepared, 1);
  assert.equal(item.counters.committed, 1);
  assert.equal(
    item.events.filter((event) => event.type === 'committed').length,
    1,
  );
  assert.deepEqual(item.owner.publishedRevision, item.revision);
});

test('webpack app-router nested layouts receive the generated PandamStyle stylesheet import', async (t) => {
  const item = fixture();
  t.after(async () => {
    item.owner.compilers.clear();
    item.owner.closed = true;
    item.owner.watcher.close();
    await item.owner.project.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  });

  const code = await transportSource({
    id: item.owner.id,
    kind: 'source',
    file: item.layout,
    source: item.source,
    addDependency() {},
    addContextDependency() {},
  });
  assert.equal(
    code,
    `${item.source}\nimport ${JSON.stringify(path.join(item.owner.hostDir, 'styles.css'))};\n`,
  );
});
