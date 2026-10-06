/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const timestamp = (event) => Date.parse(event.time);
const revisionKey = (revision) =>
  JSON.stringify([
    revision?.projectId,
    revision?.sessionId,
    revision?.revisionId,
  ]);

async function eventFiles(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await eventFiles(file)));
    else if (entry.name === 'events.jsonl') found.push(file);
  }
  return found;
}

function observations(value, location = 'observations') {
  if (value == null || typeof value !== 'object') return [];
  if (value.selector && Number.isFinite(value.observedAt))
    return [{ location, ...value }];
  return Object.entries(value).flatMap(([key, child]) =>
    ['previous', 'historical', 'oldBrowser', 'offlineHistorical'].includes(key)
      ? []
      : observations(child, location + '.' + key),
  );
}

function chain(events, committed, row) {
  const revision = committed.receipt.associationRevision;
  const matching = events.filter(
    (event) =>
      event.sessionId === committed.sessionId &&
      revisionKey(event.revision) === revisionKey(revision),
  );
  const completed = matching.find(
    (event) =>
      event.type === 'transport-complete' &&
      event.descriptor.accepted === true &&
      revisionKey(event.descriptor.associationRevision) ===
        revisionKey(revision),
  );
  const offered = matching.find(
    (event) =>
      event.type === 'transport-offered' &&
      event.descriptor.snapshotId === completed?.descriptor.snapshotId,
  );
  assert(completed && offered, 'Accepted publication lacks complete transport');
  assert(committed.sequence < completed.sequence);
  assert(completed.sequence < offered.sequence);
  const mutation = (row.mutations ?? [])
    .filter(
      (value) =>
        Number.isFinite(value.writtenAt) &&
        value.writtenAt <= timestamp(committed) &&
        (value.file?.startsWith('semantic/') ||
          value.file?.startsWith('external/') ||
          value.file === 'definition.mjs'),
    )
    .at(-1);
  const rowBrowserObservations = observations(row.observations).filter(
    (value) => value.observedAt >= timestamp(offered),
  );
  const browser = rowBrowserObservations
    .filter((value) =>
      value.stylesheets?.some(
        (url) =>
          typeof url === 'string' &&
          decodeURIComponent(new URL(url).pathname).includes(
            completed.descriptor.snapshotId,
          ),
      ),
    )
    .sort((a, b) => a.observedAt - b.observedAt)[0];
  for (const milliseconds of [
    completed.elapsedMs - committed.elapsedMs,
    offered.elapsedMs - completed.elapsedMs,
    ...(mutation ? [timestamp(committed) - mutation.writtenAt] : []),
    ...(browser ? [browser.observedAt - timestamp(offered)] : []),
  ])
    assert(Number.isFinite(milliseconds) && milliseconds >= 0);
  return {
    projectId: committed.projectId,
    sessionId: committed.sessionId,
    associationRevision: revision,
    artifactRevision: committed.receipt.artifactRevision,
    generationId: committed.receipt.generationId,
    snapshotId: completed.descriptor.snapshotId,
    canonicalSetDigest: completed.descriptor.canonicalSetDigest,
    memberHashes: completed.descriptor.files,
    eventSequences: {
      committed: committed.sequence,
      completed: completed.sequence,
      offered: offered.sequence,
    },
    input: mutation ?? null,
    semanticPublicationMs: mutation
      ? timestamp(committed) - mutation.writtenAt
      : null,
    transportCompletionMs: completed.elapsedMs - committed.elapsedMs,
    transportOfferMs: offered.elapsedMs - completed.elapsedMs,
    nextBrowserObservationMs: browser
      ? browser.observedAt - timestamp(offered)
      : null,
    browser: browser ?? null,
    browserBinding: browser
      ? 'Row-asserted computed style with the full compiler snapshot ID in its loaded stylesheet resource URL; exact transport bytes are verified by the matrix.'
      : 'No exact-snapshot timing claimed; row browser observations retained separately.',
    rowBrowserObservations,
  };
}

/** Reduce actual identity-linked traces; never infer settlement from a delay. */
export async function writeSemanticDevPerformance(matrixFile, outputFile) {
  const matrixBytes = await fs.readFile(matrixFile);
  const matrix = JSON.parse(matrixBytes);
  assert.equal(matrix.pass, true, 'Performance requires a passing full matrix');
  const base = path.dirname(matrixFile);
  const report = {
    schemaVersion: 1,
    scope: 'pandamstyle-next-host-observed-performance',
    matrixReport: matrixFile,
    matrixSha256: sha256(matrixBytes),
    measurement: {
      semanticPublication:
        'Completed disk write to exact Service receipt; includes watcher admission and validation.',
      transport:
        'Same-owner monotonic event clocks, commit to complete copy to atomic offer.',
      browser:
        'Atomic transport offer to a row-asserted computed style whose stylesheet resource URL carries that exact full snapshot ID on the same machine. Unbound observations do not supply this latency.',
      production:
        'Actual supervised installed Next command duration, with public completion/exit/commit order recorded separately. Strict preview transport events are both emitted after atomic offer; their deltas do not isolate copy or offer duration.',
      resolution:
        'Disk/browser timestamps and event UTC are milliseconds; transport uses performance.now().',
      limitations:
        'Polling, instrumentation, browser automation and fixture setup contribute overhead. Samples are individual observations, not benchmarks or speedup claims. Historical clients and unrelated Next failures are not successful current-route settlement.',
    },
    lanes: [],
    pass: false,
  };
  for (const lane of matrix.lanes) {
    const laneFile = path.resolve(base, lane.reportFile);
    const laneBytes = await fs.readFile(laneFile);
    const raw = JSON.parse(laneBytes);
    assert.equal(raw.pass, true);
    const directory = path.dirname(laneFile);
    const traces = [];
    const events = [];
    for (const file of await eventFiles(
      path.join(directory, 'coordinator-events'),
    )) {
      const bytes = await fs.readFile(file);
      traces.push({
        file: path.relative(directory, file),
        sha256: sha256(bytes),
      });
      events.push(
        ...bytes.toString().split('\n').filter(Boolean).map(JSON.parse),
      );
    }
    const loaderOutcomes = new Map();
    for (const command of raw.commands.filter((entry) =>
      entry.label.startsWith('public-loader-'),
    )) {
      try {
        const response = JSON.parse(
          await fs.readFile(
            path.join(directory, command.label + '.json'),
            'utf8',
          ),
        );
        loaderOutcomes.set(
          command.label,
          response.ok ? 'transformed' : 'refused',
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        loaderOutcomes.set(command.label, 'no-response-file');
      }
    }
    const row = (id) => {
      const value = raw.rows.find((entry) => entry.id === id);
      assert.equal(value?.status, 'PASS');
      return value;
    };
    const publication = (id) => {
      const value = row(id);
      const commits = events.filter(
        (event) =>
          event.type === 'semantic-committed' &&
          event.authority !==
            'supervisor-next-exit-zero-after-public-completion' &&
          timestamp(event) >= value.startedAt &&
          timestamp(event) <= value.finishedAt,
      );
      assert(commits.length > 0, id + ' has no observed semantic publication');
      return {
        row: id,
        samples: commits.map((event) => chain(events, event, value)),
      };
    };
    const start = (id) => {
      const value = row(id);
      const launch = raw.devLaunches.find(
        (entry) => entry.at >= value.startedAt && entry.at <= value.finishedAt,
      );
      assert(launch, id + ' has no actual dev launch');
      const command = raw.commands.find(
        (entry) => entry.label === launch.label,
      );
      const publications = publication(id);
      const first = events.find(
        (event) =>
          event.type === 'module-transformed' &&
          event.sessionId === publications.samples[0].sessionId,
      );
      assert(first, id + ' has no actual source transform');
      assert(Number.isFinite(launch.nextReadyObservedAt));
      assert(Number.isFinite(launch.httpReadyObservedAt));
      const loader = raw.commands.find(
        (entry) =>
          entry.label.startsWith('public-loader-') &&
          Date.parse(entry.startedAt) >= value.startedAt &&
          Date.parse(entry.startedAt) <= value.finishedAt,
      );
      return {
        row: id,
        cacheRetained: launch.cacheRetained,
        supervisorStartedAt: command.startedAt,
        nextReadyObservedAt: launch.nextReadyObservedAt,
        nextBannerReadyMs:
          launch.nextReadyObservedAt - Date.parse(command.startedAt),
        matchedOwnerAndHTTP200ObservedAt: launch.httpReadyObservedAt,
        coldCoordinatorAndNextReadyMs:
          launch.httpReadyObservedAt - Date.parse(command.startedAt),
        firstSourceTransformFromLaunchMs:
          timestamp(first) - Date.parse(command.startedAt),
        firstTransform: {
          sequence: first.sequence,
          file: first.file,
          sourceDigest: first.sourceDigest,
          sessionId: first.sessionId,
          snapshotId: first.snapshotId,
        },
        ...publications,
        firstPublicLoaderRequestMs: loader?.elapsedMs ?? null,
        firstPublicLoaderCommand: loader?.label ?? null,
        firstPublicLoaderOutcome: loader
          ? loaderOutcomes.get(loader.label)
          : null,
      };
    };
    const production = raw.production.map((value) => {
      assert.equal(value.pass, true);
      const result = value.result ?? value.attempts?.at(-1)?.result;
      const command = result?.outcome;
      assert(command);
      const trace = result.events;
      const prepared = trace.find(
        (event) => event.type === 'semantic-prepared',
      );
      const transported = trace.find(
        (event) =>
          event.type === 'transport-complete' &&
          event.descriptor.accepted === false,
      );
      const offered = trace.find(
        (event) =>
          event.type === 'transport-offered' &&
          event.descriptor.accepted === false,
      );
      const boundary = trace.find(
        (event) => event.type === 'framework-build-complete',
      );
      const exited = trace.find(
        (event) => event.type === 'installed-next-exited',
      );
      const committed = trace.find(
        (event) => event.type === 'semantic-committed',
      );
      if (command.code === 0) {
        assert(
          prepared && transported && offered && boundary && exited && committed,
        );
        assert.equal(boundary.authority, 'public-next-onBuildComplete');
        assert.equal(exited.exitCode, 0);
        assert.equal(exited.signal, null);
        assert.equal(
          committed.authority,
          'supervisor-next-exit-zero-after-public-completion',
        );
        assert.equal(
          revisionKey(prepared.ticket.revision),
          revisionKey(committed.receipt.associationRevision),
        );
        assert.equal(
          revisionKey(boundary.preparedRevision),
          revisionKey(committed.receipt.associationRevision),
        );
      } else
        assert.equal(
          committed,
          undefined,
          'Failed Next command published a generation',
        );
      const delta = (from, to) => {
        if (!from || !to) return null;
        assert.equal(from.projectId, to.projectId);
        assert.equal(from.sessionId, to.sessionId);
        assert(from.sequence < to.sequence);
        const milliseconds = to.elapsedMs - from.elapsedMs;
        assert(Number.isFinite(milliseconds) && milliseconds >= 0);
        return milliseconds;
      };
      return {
        name: value.name,
        commandMs: command.elapsedMs,
        commandStartedAt: command.startedAt,
        exitCode: command.code,
        publicCompletion: boundary ?? null,
        installedNextExit: exited ?? null,
        semanticCommit: committed ?? null,
        phaseTimings: {
          preparedToPostOfferObservationMs: delta(prepared, transported),
          postOfferEventEmissionMs: delta(transported, offered),
          isolatedTransportCompletionMs: null,
          isolatedTransportOfferMs: null,
          nextPublicCompletionAfterOfferMs: delta(offered, boundary),
          actualNextExitAfterPublicCompletionMs: delta(boundary, exited),
          guardedSemanticCommitAfterNextExitMs: delta(exited, committed),
        },
        preparedTransport: result.snapshots.map((snapshot) => ({
          snapshotId: snapshot.snapshotId,
          accepted: snapshot.accepted,
          capturedAt: snapshot.capturedAt,
        })),
        browser: observations(value.browser),
        canonicalRetained: value.canonicalRetained ?? null,
        attemptCommands:
          value.attempts?.map((attempt) => attempt.result.outcome) ?? [],
      };
    });
    for (const name of [
      'strict-clean',
      'strict-repeat-1',
      'strict-repeat-2',
      'strict-source-definition',
    ])
      assert(
        production.some((value) => value.name === name && value.exitCode === 0),
      );
    const samples = {
      coldReadyAndFirstTransform: start('T01'),
      localStyleCommitTransportAndBrowser: publication('T02'),
      ownedDependencyInvalidAndRepair: publication('T08'),
      importAndReexportEdits: publication('T14'),
      invalidToRepair: {
        invalidInput: row('T04').mutations.find(
          (value) => value.file === 'semantic/Server.jsx',
        ),
        ...publication('T05'),
      },
      definitionMutation: publication('T15'),
      lazyFirstConsumption: {
        row: 'T20',
        consumptionStartedAt: row('T20').observations.consumptionStartedAt,
        browser: observations(row('T20').observations),
        rowTotalMs: row('T20').elapsedMs,
        navigationToFirstAssertedBrowserMs:
          row('T20').observations.browser.observedAt -
          row('T20').observations.consumptionStartedAt,
      },
      persistentCacheRestart: start('T25'),
      production,
    };
    assert(Number.isFinite(samples.lazyFirstConsumption.consumptionStartedAt));
    assert(samples.lazyFirstConsumption.browser.length > 0);
    for (const id of [
      'localStyleCommitTransportAndBrowser',
      'definitionMutation',
    ]) {
      assert(
        samples[id].samples.some(
          (value) =>
            value.semanticPublicationMs !== null &&
            value.nextBrowserObservationMs !== null,
        ),
      );
    }
    report.lanes.push({
      node: lane.node,
      laneReport: laneFile,
      laneSha256: sha256(laneBytes),
      traces,
      samples,
    });
  }
  assert.equal(report.lanes.length, 2);
  report.pass = true;
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2) + '\n');
  const sortedLanes = [...matrix.lanes].sort((a, b) =>
    a.node.localeCompare(b.node),
  );
  const summary = [
    '# Packed Next Turbopack qualification',
    '',
    'Next 16.3.8, React/React DOM 19.2.8, JSX App Router, Linux, default output.',
    'Both lanes ran the actual consumer-installed public Next command from reproducible package tarballs.',
    '',
    '| Case | Scenario | ' +
      sortedLanes.map((lane) => 'Node ' + lane.node).join(' | ') +
      ' |',
    '| --- | --- | ' + sortedLanes.map(() => '---').join(' | ') + ' |',
    ...sortedLanes[0].matrix.rows.map(
      (entry, index) =>
        '| ' +
        entry.id +
        ' | ' +
        entry.scenario +
        ' | ' +
        sortedLanes.map((lane) => lane.matrix.rows[index].status).join(' | ') +
        ' |',
    ),
    '',
    'All 80 dev rows and both independent strict production lanes passed. Strict production requires the public completion event, actual installed Next exit zero, and then the original guarded compiler commit.',
    '',
    'The client-edit row records actual refresh behavior per lane; historical-client rows scope disconnected retention and deliberate reload separately. Compiler source maps remain null. These results do not qualify TypeScript applications, Pages Router, React Compiler, additional Next versions or non-default output modes.',
    '',
    'See [raw matrix report](report.json) and [separate phase timings](performance.json). The repository delivery verdict still requires the clean eleven-step official verifier.',
    '',
  ].join('\n');
  await fs.writeFile(
    path.join(path.dirname(outputFile), 'matrix-summary.md'),
    summary,
  );
  return report;
}
