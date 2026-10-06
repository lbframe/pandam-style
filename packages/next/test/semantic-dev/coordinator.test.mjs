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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createCoordinator } from '../../src/coordinator.js';
import {
  fixture,
  definition,
  source,
  hash,
  request,
  current,
  status,
  canonical,
} from './coordinator-fixture.mjs';

const codeOf = (error) => error.code ?? error.diagnostics?.[0]?.code;

test('one exact accepted descriptor binds SDK source, five bytes, JS/CSS, diagnostics and duplicate requests', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    const first = current(owner);
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () => owner.transform(request(owner, item))),
    );
    assert.ok(
      outputs.every(
        (output) => output.descriptor.snapshotId === first.snapshotId,
      ),
    );
    const output = outputs[0];
    assert.equal(
      output.artifact.sourceDigest,
      hash(fs.readFileSync(item.file('semantic/page.js'))),
    );
    assert.equal(
      output.artifact.provenance.canonicalSetDigest,
      first.canonicalSetDigest,
    );
    assert.ok(output.dependencies.includes(owner.statusFile));
    assert.ok(output.dependencies.includes(first.descriptorFile));
    assert.equal(first.files.length, 5);
    for (const member of first.files) {
      assert.equal(hash(fs.readFileSync(member.path)), member.sha256);
      assert.deepEqual(
        fs.readFileSync(member.path),
        fs.readFileSync(item.file('generated/' + member.file)),
      );
    }
    const stats = await owner.snapshotStats();
    assert.equal(stats.compiler.pins, 1);
    assert.equal(stats.transport.snapshots, 1);
    assert.equal(stats.pins, 1);
    assert.ok(
      owner.events.some(
        (event) => event.type === 'diagnostics' && event.result.ok,
      ),
    );
    assert.ok(!owner.events.some((event) => event.type === 'host-settled'));
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('semantic error retains canonical bytes, fails loader input and recovers on repaired exact source', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    const before = canonical(item);
    const beforeDescriptor = current(owner);
    fs.writeFileSync(item.file('semantic/page.js'), source('missing'));
    await assert.rejects(
      owner.transform(request(owner, item)),
      (error) => error.diagnostics?.length > 0,
    );
    assert.deepEqual(canonical(item), before);
    assert.equal(current(owner).snapshotId, beforeDescriptor.snapshotId);
    assert.equal(status(owner).state, 'semantic-invalid');
    const invalid = status(owner).revision;
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const repaired = await owner.transform(request(owner, item));
    assert.ok(repaired.revision.revisionId > invalid.revisionId);
    assert.equal(status(owner).state, 'ready');
    assert.notEqual(
      repaired.descriptor.snapshotId,
      beforeDescriptor.snapshotId,
    );
    assert.notDeepEqual(canonical(item), before);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('a Next-only edit passes through without fabricating a revision or blocking semantic publication', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    fs.writeFileSync(
      item.file('app/page.jsx'),
      "import absent from './absent'; export default function Page(){ return absent; }\n",
    );
    const first = current(owner);
    const raw = await owner.transform(request(owner, item, 'app/page.jsx'));
    assert.equal(raw.passthrough, true);
    assert.deepEqual(raw.revision, first.associationRevision);
    assert.equal(current(owner).snapshotId, first.snapshotId);
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const changed = await owner.transform(request(owner, item));
    assert.notEqual(changed.descriptor.snapshotId, first.snapshotId);
    assert.equal(status(owner).state, 'ready');
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('old source input rejects and cannot overwrite newer disk or accepted compiler source', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    const old = request(owner, item);
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const fresh = await owner.transform(request(owner, item));
    await assert.rejects(
      owner.transform(old),
      (error) => codeOf(error) === 'PMS_STALE_REVISION',
    );
    assert.equal(
      fs.readFileSync(item.file('semantic/page.js'), 'utf8'),
      source('accent'),
    );
    assert.equal(current(owner).snapshotId, fresh.descriptor.snapshotId);
    assert.equal(
      (await owner.transform(request(owner, item))).artifact.sourceDigest,
      hash(source('accent')),
    );
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('historical reads require explicit retained snapshot and exact digest; current requests reject old identity', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    const oldInput = request(owner, item);
    const first = await owner.transform(oldInput);
    const bytes = fs.readFileSync(first.descriptor.stylesCSS);
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const next = await owner.transform(request(owner, item));
    await assert.rejects(
      owner.transform({ ...oldInput, snapshotId: first.descriptor.snapshotId }),
      (error) => codeOf(error) === 'PMS_STALE_REVISION',
    );
    const historical = await owner.transform({
      ...oldInput,
      snapshotId: first.descriptor.snapshotId,
      allowHistorical: true,
    });
    assert.equal(
      historical.artifact.provenance.snapshotId,
      first.descriptor.snapshotId,
    );
    assert.deepEqual(fs.readFileSync(first.descriptor.stylesCSS), bytes);
    assert.equal(current(owner).snapshotId, next.descriptor.snapshotId);
    await assert.rejects(
      owner.transform({
        ...oldInput,
        snapshotId: first.descriptor.snapshotId,
        allowHistorical: true,
        sourceDigest: hash(source('accent')),
      }),
      (error) => codeOf(error) === 'PMS_STALE_REVISION',
    );
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('invalid external transitive dependency then repair to old exact bytes revalidates unchanged consumer', async () => {
  const item = fixture();
  fs.mkdirSync(item.file('shared'));
  const dependency =
    "import { create, token, props } from '../generated/design.js'; const styles = create({ box: { color: token('colors.ink') } }); export const box = props(styles.box);\n";
  const consumer = "export { box } from '../shared/styles.js';\n";
  fs.writeFileSync(item.file('shared/styles.js'), dependency);
  fs.writeFileSync(item.file('semantic/page.js'), consumer);
  const owner = await item.owner();
  try {
    const first = current(owner);
    const before = canonical(item);
    assert.equal((await owner.snapshotStats()).externalInputObservations, 1);
    const firstCSS = fs.readFileSync(first.stylesCSS);
    const firstDesign = fs.readFileSync(first.designJS);
    fs.writeFileSync(
      item.file('shared/styles.js'),
      dependency.replace('colors.ink', 'colors.missing'),
    );
    await assert.rejects(
      owner.transform(request(owner, item)),
      (error) => error.diagnostics?.length > 0,
    );
    assert.deepEqual(canonical(item), before);
    const invalid = status(owner).revision;
    fs.writeFileSync(item.file('shared/styles.js'), dependency);
    const repaired = await owner.transform(request(owner, item));
    assert.equal(
      fs.readFileSync(item.file('semantic/page.js'), 'utf8'),
      consumer,
    );
    assert.ok(repaired.revision.revisionId > invalid.revisionId);
    const committed = owner.events
      .filter((event) => event.type === 'semantic-committed')
      .at(-1).receipt;
    assert.equal(repaired.descriptor.generationId, committed.generationId);
    assert.equal(status(owner).state, 'ready');
    assert.deepEqual(
      repaired.descriptor.artifactRevision,
      committed.artifactRevision,
    );
    assert.deepEqual(fs.readFileSync(repaired.descriptor.stylesCSS), firstCSS);
    assert.deepEqual(
      fs.readFileSync(repaired.descriptor.designJS),
      firstDesign,
    );
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('definition import failure has its own observation revision and repairs without consumer edit', async () => {
  const item = fixture();
  const entry = item.file('definition.mjs');
  const valid = 'export default ' + JSON.stringify(definition) + ';\n';
  fs.writeFileSync(entry, valid);
  const owner = await item.owner({ definition: 'definition.mjs' });
  try {
    const first = current(owner);
    const before = canonical(item);
    fs.writeFileSync(entry, 'export default {\n');
    await assert.rejects(
      owner.synchronize(),
      (error) =>
        error.code === 'PMS_INVALID_DEFINITION' &&
        error.details.owner === 'coordinator-definition-input',
    );
    assert.deepEqual(canonical(item), before);
    assert.equal(status(owner).state, 'definition-error');
    assert.ok(
      status(owner).revision.revisionId > first.associationRevision.revisionId,
    );
    assert.equal(
      status(owner).error.details.digest,
      hash('export default {\n'),
    );
    fs.writeFileSync(entry, valid.replace('#123456', '#111111'));
    const repaired = await owner.transform(request(owner, item));
    assert.equal(status(owner).state, 'ready');
    assert.notEqual(
      repaired.descriptor.designSystem.registryDigest,
      first.designSystem.registryDigest,
    );
    assert.ok(
      owner.events.some((event) => event.type === 'definition-input-error'),
    );
    assert.ok(!owner.events.some((event) => event.type === 'semantic-invalid'));
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('parsed invalid definition uses compiler diagnostics and retains previous canonical generation', async () => {
  const item = fixture();
  const entry = item.file('definition.mjs');
  fs.writeFileSync(entry, 'export default ' + JSON.stringify(definition) + ';');
  const owner = await item.owner({ definition: 'definition.mjs' });
  try {
    const before = canonical(item);
    fs.writeFileSync(
      entry,
      'export default ' + JSON.stringify({ ...definition, tokens: {} }) + ';',
    );
    await assert.rejects(
      owner.synchronize(),
      (error) => error.diagnostics?.length > 0,
    );
    assert.deepEqual(canonical(item), before);
    assert.equal(status(owner).state, 'semantic-invalid');
    fs.writeFileSync(
      entry,
      'export default ' + JSON.stringify(definition) + ';',
    );
    const repaired = await owner.transform(request(owner, item));
    assert.equal(repaired.artifact.sourceDigest, hash(source()));
    assert.equal(status(owner).state, 'ready');
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('retention exhaustion preserves every offered byte and pointer after valid canonical commit', async () => {
  const item = fixture();
  const owner = await item.owner({
    acceptedSnapshotRetention: {
      maxSnapshots: 2,
      maxBytes: 1024 * 1024,
      maxPins: 8,
    },
  });
  try {
    const first = current(owner);
    const bytes = fs.readFileSync(first.stylesCSS);
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const second = await owner.transform(request(owner, item));
    const before = canonical(item);
    fs.writeFileSync(
      item.file('semantic/page.js'),
      source().replace(
        'export const box',
        '// a new exact source association\nexport const box',
      ),
    );
    await assert.rejects(
      owner.transform(request(owner, item)),
      (error) =>
        error.diagnostics?.[0]?.context?.reason === 'retention-limit' ||
        error.code === 'PMS_TRANSPORT_RETENTION_LIMIT',
    );
    assert.equal(current(owner).snapshotId, second.descriptor.snapshotId);
    assert.deepEqual(fs.readFileSync(first.stylesCSS), bytes);
    assert.notDeepEqual(canonical(item), before);
    assert.equal(status(owner).state, 'transport-error');
    assert.ok(
      owner.events.some(
        (event) =>
          event.type === 'semantic-committed' &&
          event.receipt.associationRevision.revisionId ===
            status(owner).revision.revisionId,
      ),
    );
    assert.equal((await owner.snapshotStats()).compiler.pins, 2);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('tampered current immutable member or descriptor fails instead of rewriting accepted bytes', async () => {
  const item = fixture();
  const owner = await item.owner();
  try {
    const first = current(owner);
    const before = canonical(item);
    fs.chmodSync(first.stylesCSS, 0o600);
    fs.writeFileSync(first.stylesCSS, 'corruption');
    await assert.rejects(
      owner.transform(request(owner, item)),
      (error) => error.code === 'PMS_TRANSPORT_CORRUPT',
    );
    assert.equal(fs.readFileSync(first.stylesCSS, 'utf8'), 'corruption');
    assert.deepEqual(canonical(item), before);
    assert.equal(status(owner).state, 'transport-error');
    assert.equal(current(owner).snapshotId, first.snapshotId);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('strict production preview cannot commit until explicit public completion and rejects dev completion', async () => {
  const item = fixture();
  const owner = await item.owner(
    { publicationMode: 'strict' },
    { command: 'build' },
  );
  try {
    const preview = current(owner);
    assert.equal(preview.accepted, false);
    assert.equal(preview.canonicalSetDigest, undefined);
    assert.equal(preview.generationId, undefined);
    assert.equal(preview.artifactDigest, undefined);
    assert.ok(preview.candidateDigest);
    assert.equal(fs.existsSync(item.file('generated/artifacts.json')), false);
    const transformed = await owner.transform(request(owner, item));
    assert.equal(transformed.descriptor.snapshotId, preview.snapshotId);
    fs.writeFileSync(
      item.file('app/page.jsx'),
      "import no from './missing'; export default no;\n",
    );
    assert.equal(
      (await owner.transform(request(owner, item, 'app/page.jsx'))).passthrough,
      true,
    );
    const receipt = await owner.finishProduction();
    assert.equal(
      receipt.associationRevision.revisionId,
      preview.associationRevision.revisionId,
    );
    assert.equal(current(owner).accepted, true);
    assert.equal(current(owner).candidateDigest, preview.candidateDigest);
    assert.equal(fs.existsSync(item.file('generated/artifacts.json')), true);
  } finally {
    await owner.close();
    item.cleanup();
  }
  const devFixture = fixture();
  const dev = await devFixture.owner();
  try {
    await assert.rejects(
      dev.finishProduction(),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
  } finally {
    await dev.close();
    devFixture.cleanup();
  }
});

test('strict completion observes an immediate consumed-source mutation and retains the previous canonical set', async () => {
  const item = fixture();
  let owner = await item.owner();
  const before = canonical(item);
  await owner.close();
  owner = await item.owner({ publicationMode: 'strict' }, { command: 'build' });
  try {
    const consumed = await owner.transform(request(owner, item));
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    await owner.recordProductionBoundary();
    // No wait for an OS notification: exact consumed input observations must
    // become a real Service revision before the old candidate can commit.
    await assert.rejects(owner.finishProduction(), (error) =>
      ['PMS_STALE_REVISION', 'PMS_STALE_PUBLICATION'].includes(codeOf(error)),
    );
    assert.ok(
      owner.events.some(
        (event) =>
          event.type === 'revision-accepted' &&
          event.revision.revisionId > consumed.revision.revisionId,
      ),
    );
    assert.deepEqual(canonical(item), before);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('two projects isolate bytes and identities, foreign sessions reject, and one output rejects another owner', async () => {
  const leftItem = fixture();
  const rightItem = fixture();
  const left = await leftItem.owner();
  const right = await rightItem.owner();
  try {
    assert.notEqual(left.projectId, right.projectId);
    assert.notEqual(left.sessionId, right.sessionId);
    assert.notEqual(current(left).directory, current(right).directory);
    assert.throws(
      () =>
        left.transform({
          ...request(left, leftItem),
          sessionId: right.sessionId,
        }),
      (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
    );
    await assert.rejects(
      leftItem.owner(),
      (error) => error.code === 'PMS_OUTPUT_OWNED',
    );
    assert.deepEqual(
      (await left.transform(request(left, leftItem))).revision,
      current(left).associationRevision,
    );
  } finally {
    await left.close();
    await right.close();
    leftItem.cleanup();
    rightItem.cleanup();
  }
});

test('OS output lease excludes another process, dies with crashed owner and restart rejects retired session', async () => {
  const item = fixture();
  const coordinatorURL = new URL('../../src/coordinator.js', import.meta.url)
    .href;
  const script = `import { createCoordinator } from ${JSON.stringify(coordinatorURL)}; const owner = await createCoordinator(${JSON.stringify(item.root)}, ${JSON.stringify(item.options)}); process.stdout.write(JSON.stringify(owner.registerDescription())+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childError = '';
  child.stderr.on('data', (bytes) => {
    childError += String(bytes);
  });
  let retired;
  try {
    retired = await new Promise((resolve, reject) => {
      let text = '';
      child.stdout.on('data', (bytes) => {
        text += String(bytes);
        if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]));
      });
      child.once('exit', (code) =>
        reject(new Error(`Child owner exited ${code}: ${childError}`)),
      );
    });
    await assert.rejects(
      item.owner(),
      (error) => error.code === 'PMS_OUTPUT_OWNED',
    );
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    fs.writeFileSync(item.file('semantic/page.js'), source('accent'));
    const restarted = await item.owner();
    try {
      assert.notEqual(restarted.sessionId, retired.sessionId);
      assert.equal(
        fs.existsSync(
          path.join(
            retired.hostDir,
            'sessions',
            retired.sessionId,
            retired.snapshotId,
          ),
        ),
        false,
      );
      assert.equal(fs.existsSync(retired.eventsFile), true);
      assert.throws(
        () =>
          restarted.transform({
            ...request(restarted, item),
            sessionId: retired.sessionId,
          }),
        (error) => error.code === 'PMS_TRANSPORT_FOREIGN_SESSION',
      );
      assert.equal(
        (await restarted.transform(request(restarted, item))).artifact
          .sourceDigest,
        hash(source('accent')),
      );
    } finally {
      await restarted.close();
    }
  } finally {
    if (child.exitCode == null && child.signalCode == null)
      child.kill('SIGKILL');
    item.cleanup();
  }
});

test('mode/backend restrictions are explicit and no unsupported source path acquires semantic authority', async () => {
  const item = fixture();
  try {
    await assert.rejects(
      createCoordinator(
        item.root,
        { ...item.options, publicationMode: 'semantic-dev' },
        { command: 'build' },
      ),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
    await assert.rejects(
      item.owner({ backend: 'webpack' }),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
    await assert.rejects(
      item.owner({ publicationMode: 'strict' }),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
    await assert.rejects(
      item.owner({ publicationMode: 'invented' }),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
    await assert.rejects(
      item.owner({ outDir: 'semantic/generated' }),
      (error) => error.code === 'PMS_UNSUPPORTED_FEATURE',
    );
  } finally {
    item.cleanup();
  }
});

test(
  'byte-identical disk events do not fabricate a compiler revision or generation',
  { timeout: 5000 },
  async () => {
    const item = fixture();
    const owner = await item.owner();
    let observed;
    const changed = new Promise((resolve) => {
      observed = fs.watch(item.file('semantic'), () => {
        observed.close();
        resolve();
      });
    });
    try {
      const first = current(owner);
      fs.writeFileSync(item.file('semantic/page.js'), source());
      await changed;
      await owner.synchronize();
      const second = current(owner);
      assert.deepEqual(second.associationRevision, first.associationRevision);
      assert.equal(second.generationId, first.generationId);
      assert.deepEqual(second.artifactRevision, first.artifactRevision);
      assert.equal(second.artifactDigest, first.artifactDigest);
      assert.equal(second.canonicalSetDigest, first.canonicalSetDigest);
      assert.equal(second.snapshotId, first.snapshotId);
    } finally {
      observed.close();
      await owner.close();
      item.cleanup();
    }
  },
);

test('directive and compiler-owned generated-import offsets retain exact original-source provenance', async () => {
  const item = fixture();
  const text = "'use client';\n" + source();
  fs.writeFileSync(item.file('semantic/page.js'), text);
  const owner = await item.owner();
  try {
    const output = await owner.transform(request(owner, item));
    assert.match(output.artifact.javascript, /^['"]use client['"];?/);
    assert.equal(output.artifact.sourceDigest, hash(text));
    assert.equal(
      output.artifact.provenance.associationRevision.sessionId,
      owner.sessionId,
    );
    for (const reference of output.artifact.generatedImports) {
      assert.equal(reference.kind, 'design-module');
      assert.match(
        output.artifact.javascript.slice(reference.start, reference.end),
        /^['"].*design(?:\.js)?['"]$/,
      );
    }
    const map = JSON.parse(output.artifact.sourceMap);
    assert.equal(map.version, 3);
    assert.deepEqual(map.sources, [output.artifact.source]);
    assert.ok(map.mappings.length > 0);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('close reports status write failure while releasing every snapshot and both output owners', async () => {
  const item = fixture();
  const owner = await item.owner();
  const descriptor = current(owner);
  fs.rmSync(owner.statusFile);
  fs.mkdirSync(owner.statusFile);
  try {
    await assert.rejects(owner.close(), (error) => error.code === 'EISDIR');
    assert.equal(fs.existsSync(descriptor.directory), false);
    assert.equal(
      owner.events.find((event) => event.type === 'coordinator-closed').error
        .code,
      'EISDIR',
    );
    fs.rmSync(owner.statusFile, { recursive: true });
    const restarted = await item.owner();
    try {
      assert.notEqual(restarted.sessionId, owner.sessionId);
      assert.equal(status(restarted).state, 'ready');
    } finally {
      await restarted.close();
    }
  } finally {
    item.cleanup();
  }
});

test('successful strict commit remains successful when accepted transport exposure exhausts retention', async () => {
  const item = fixture();
  const owner = await item.owner(
    {
      publicationMode: 'strict',
      acceptedSnapshotRetention: { maxSnapshots: 1 },
    },
    { command: 'build' },
  );
  try {
    const preview = current(owner);
    assert.equal(preview.accepted, false);
    const boundary = await owner.recordProductionBoundary();
    assert.deepEqual(boundary.revision, preview.associationRevision);
    assert.equal(boundary.snapshotId, preview.snapshotId);
    assert.equal(fs.existsSync(item.file('generated/artifacts.json')), false);
    assert.equal(
      owner.events.some((event) => event.type === 'semantic-committed'),
      false,
    );
    const receipt = await owner.finishProduction();
    assert.equal(
      owner.events.find((event) => event.type === 'semantic-prepared').ticket
        .candidateDigest,
      preview.candidateDigest,
    );
    assert.deepEqual(receipt.associationRevision, preview.associationRevision);
    assert.equal(fs.existsSync(item.file('generated/artifacts.json')), true);
    assert.deepEqual(current(owner), preview);
    assert.equal(status(owner).state, 'production-complete-transport-error');
    assert.equal(status(owner).error.code, 'PMS_TRANSPORT_RETENTION_LIMIT');
    assert.equal(status(owner).receipt.generationId, receipt.generationId);
    assert.equal(
      owner.events.find((event) => event.type === 'transport-failed').authority,
      'completed-production-observation',
    );
    assert.deepEqual(await owner.finishProduction(), receipt);
  } finally {
    await owner.close();
    item.cleanup();
  }
});

test('durable event write failure cannot reject a successful strict receipt and remains explicit to observers', async () => {
  const item = fixture();
  const observed = [];
  const owner = await item.owner(
    { publicationMode: 'strict', onEvent: (event) => observed.push(event) },
    { command: 'build' },
  );
  fs.renameSync(owner.eventsFile, owner.eventsFile + '.saved');
  fs.mkdirSync(owner.eventsFile);
  try {
    const receipt = await owner.finishProduction();
    assert.equal(status(owner).receipt.generationId, receipt.generationId);
    assert.equal(status(owner).state, 'ready');
    const committed = observed.find(
      (event) => event.type === 'semantic-committed',
    );
    assert.deepEqual(committed.receipt, receipt);
    assert.equal(committed.durableLogError.code, 'EISDIR');
    assert.equal(committed.durableLogError.owner, 'coordinator-observability');
    assert.equal(
      observed.some((event) => event.type === 'semantic-rejected'),
      false,
    );
    assert.equal(fs.existsSync(item.file('generated/artifacts.json')), true);
  } finally {
    await owner.close();
    item.cleanup();
  }
});
