/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Refreshes the comparator identities for CE-00.1 without replacing them.
// It queries npm's primary registry metadata, re-verifies the pinned tarballs
// and source files that were downloaded to isolated directories, and records
// the emission probe results by digest:
//
//   node tests/core-evolution/tools/observe-upstreams.mjs \
//     --evidence docs/research/core-evolution-evidence.json \
//     --pack-root <dir of per-package npm pack directories> \
//     --src-root <dir with stylex/, panda/, bcd/ source checkouts> \
//     --archive-root <dir with the downloaded source archives> \
//     --bcd-data <published data.json> --keys <extraction> \
//     --stylex-probe <file> --panda-probe <file> \
//     --stylex-install <dir> --panda-install <dir> --repo . --out <file>

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileDigest, parseArgs, readJson, run, writeJson } from './lib.mjs';

const options = parseArgs(process.argv.slice(2), [
  'evidence',
  'pack-root',
  'src-root',
  'archive-root',
  'bcd-data',
  'keys',
  'stylex-probe',
  'panda-probe',
  'stylex-install',
  'panda-install',
  'repo',
  'out',
]);
const evidence = readJson(options.evidence);
const PANDA_V1_CORE = { package: '@pandacss/core', version: '1.12.1' };

function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split('-', 2);
    return { parts: core.split('.').map(Number), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if (x.parts[i] !== y.parts[i]) {
      return x.parts[i] - y.parts[i];
    }
  }
  if (x.pre === y.pre) return 0;
  if (x.pre == null) return 1;
  if (y.pre == null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

async function registryObservation({ package: name, version }) {
  const endpoint = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
  const requestedAt = new Date().toISOString();
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${endpoint}: HTTP ${response.status}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const doc = JSON.parse(body.toString('utf8'));
  const latest = doc['dist-tags']?.latest ?? null;
  const pinned = doc.versions?.[version] ?? null;
  const newerStable = Object.keys(doc.versions ?? {})
    .filter((v) => !v.includes('-') && compareVersions(v, version) > 0)
    .sort(compareVersions)
    .map((v) => ({ version: v, publishedAt: doc.time?.[v] ?? null }));
  return {
    package: name,
    metadataEndpoint: endpoint,
    requestedAt,
    respondedAt: new Date().toISOString(),
    responseSha256: `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`,
    registryModifiedAt: doc.time?.modified ?? null,
    distTags: doc['dist-tags'] ?? {},
    latestVersion: latest,
    latestPublishedAt: latest ? (doc.time?.[latest] ?? null) : null,
    pinnedVersion: version,
    pinnedPublishedAt: doc.time?.[version] ?? null,
    pinnedIntegrity: pinned?.dist?.integrity ?? null,
    pinnedTarball: pinned?.dist?.tarball ?? null,
    newerStableVersions: newerStable,
    delta:
      latest == null
        ? 'unknown'
        : latest === version
          ? 'latest-equals-pinned'
          : compareVersions(latest, version) > 0
            ? 'newer-latest-requires-delta-review'
            : 'latest-older-than-pinned',
  };
}

function tarballFacts(pkg) {
  const dir = path.join(
    options['pack-root'],
    `${pkg.package}@${pkg.version}`.replace(/[/@]/g, '_'),
  );
  const file = fs.readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (!file) {
    return { package: pkg.package, version: pkg.version, tarball: null };
  }
  const buffer = fs.readFileSync(path.join(dir, file));
  const sha512 = `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
  return {
    package: pkg.package,
    version: pkg.version,
    tarball: file,
    bytes: buffer.length,
    sha256: `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`,
    integrity: sha512,
    matchesEvidenceLock: sha512 === pkg.integrity,
  };
}

function sourceDigestChecks() {
  const checks = [];
  const roots = { stylex: 'stylex', panda: 'panda' };
  for (const [pin, dir] of Object.entries(roots)) {
    const source = evidence.sourcePins[pin];
    const groups = {
      inspectedFileDigests: source.inspectedFileDigests ?? {},
      baseUtilityFileDigests: source.baseUtilityFileDigests ?? {},
    };
    for (const [group, files] of Object.entries(groups)) {
      for (const [rel, expected] of Object.entries(files)) {
        const file = path.join(options['src-root'], dir, rel);
        const actual = fs.existsSync(file) ? fileDigest(file) : null;
        checks.push({
          pin,
          group,
          file: rel,
          expected,
          actual,
          match: actual === expected,
        });
      }
    }
  }
  const bcdActual = fileDigest(options['bcd-data']);
  checks.push({
    pin: 'bcd',
    group: 'publishedDataDigest',
    file: '@mdn/browser-compat-data@8.1.6/data.json',
    expected: evidence.sourcePins.bcd.publishedDataDigest,
    actual: bcdActual,
    match: bcdActual === evidence.sourcePins.bcd.publishedDataDigest,
  });
  return checks;
}

// The PandamStyle Alpha 1 files the research lock pinned at the baseline.
function baselineDigestChecks() {
  return Object.entries(evidence.baseline.fileDigests).map(
    ([rel, expected]) => {
      const file = path.join(options.repo, rel);
      const actual = fs.existsSync(file) ? fileDigest(file) : null;
      return { file: rel, expected, actual, match: actual === expected };
    },
  );
}

function archives() {
  const out = [];
  for (const dir of fs.readdirSync(options['archive-root']).sort()) {
    for (const file of fs.readdirSync(
      path.join(options['archive-root'], dir),
    )) {
      out.push({
        source: dir,
        archive: file,
        sha256: fileDigest(path.join(options['archive-root'], dir, file)),
      });
    }
  }
  return out;
}

function lockfileVersions(installDir, prefix) {
  const lock = readJson(path.join(installDir, 'package-lock.json'));
  return Object.entries(lock.packages)
    .filter(
      ([key]) =>
        key.startsWith(`node_modules/${prefix}`) ||
        key === 'node_modules/@babel/core',
    )
    .map(([key, value]) => ({
      package: key.slice('node_modules/'.length),
      version: value.version,
      integrity: value.integrity ?? null,
    }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

function probeSummary(file) {
  const probe = readJson(file);
  const kinds = {};
  for (const entry of probe.entries) {
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  }
  return {
    kind: probe.kind,
    comparator: probe.comparator,
    versions: probe.versions,
    entries: probe.entries.length,
    emissionKinds: Object.fromEntries(Object.entries(kinds).sort()),
    digest: fileDigest(file),
  };
}

const packages = [...evidence.packages, PANDA_V1_CORE];
run(async () => {
  const registry = [];
  for (const pkg of packages) {
    const observed = await registryObservation(pkg);
    const locked = evidence.packages.find((p) => p.package === pkg.package);
    registry.push({
      ...observed,
      evidenceLockIntegrity: locked?.integrity ?? null,
      integrityMatchesEvidenceLock:
        locked == null ? null : observed.pinnedIntegrity === locked.integrity,
      role:
        pkg.package === PANDA_V1_CORE.package
          ? 'obsolete-v1-internal-not-the-comparator'
          : 'pinned-comparator',
    });
  }

  const keys = readJson(options.keys);
  await writeJson(options.out, {
    schemaVersion: 1,
    kind: 'upstream-qualification-observation',
    task: 'CE-00.1',
    observedAt: registry[0].requestedAt,
    comparator: {
      stylex: '0.19.1',
      panda: '2.2.0',
      bcd: '8.1.6',
      policy:
        'The pinned comparator is retained. A newer latest tag is recorded as a delta requiring review; it never silently replaces the comparator.',
    },
    previousObservations: [
      {
        file: 'core-evolution-evidence.json',
        digest: fileDigest(options.evidence),
        retrievedAt: evidence.retrievedAt,
      },
    ],
    registry,
    tarballs: evidence.packages.map(tarballFacts),
    sourceArchives: archives(),
    sourceDigestChecks: sourceDigestChecks(),
    baselineDigestChecks: baselineDigestChecks(),
    extraction: {
      digest: fileDigest(options.keys),
      method: keys.method,
      counts: {
        stylexTypeNames: keys.stylex.keys.length,
        pandaTypeNames: keys.pandaTypes.keys.length,
        pandaBaseUtilityKeys: keys.pandaUtilities.keys.length,
        bcdPropertyKeys: keys.bcd.keys.length,
      },
      bcdMeta: { version: keys.bcd.version, timestamp: keys.bcd.timestamp },
    },
    emissionProbes: {
      stylex: {
        ...probeSummary(options['stylex-probe']),
        resolvedPackages: lockfileVersions(
          options['stylex-install'],
          '@stylexjs/',
        ),
      },
      panda: {
        ...probeSummary(options['panda-probe']),
        resolvedPackages: lockfileVersions(
          options['panda-install'],
          '@pandacss/',
        ),
      },
    },
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    limits: [
      'Registry metadata and tarball integrity identify packages; they do not qualify compiler or browser behavior.',
      'Emission probes record upstream extraction/emission for one CSS-wide keyword per entry; they do not establish value-domain, cascade or browser behavior.',
      'GitHub source archives are identified by commit; their archive digests are observations of this download, not upstream-signed artifacts.',
    ],
  });
  process.stdout.write(`observed ${registry.length} packages\n`);
});
