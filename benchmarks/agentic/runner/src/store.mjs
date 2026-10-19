/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Product build binding (DESIGN.md section 4.8). The runner reads only from
// a verified COPY of the CE baseline store, never from the original, and
// verifies itself the sha256 of every artifact it consumes. It binds only the
// product tarballs, the Node runtime and the source archive (agent docs);
// never the CE closure or npm cache.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { treeDigest } from '../../src/fs-tree.mjs';
import { digestJson, fileSha256, isInside, readJson, sha256 } from './util.mjs';

export const BINDING_SCHEMA = 'pms-agentic-product-build/v1';
export const DEFAULT_ORIGINAL_STORE = path.join(
  os.homedir(),
  '.local/share/pandamstyle-baselines/alpha1',
);

const AGENT_DOC_PATHS = [
  'docs/agent-*.md',
  'docs/reference/',
  'benchmarks/alpha1-reference.json',
];

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Refuses any path that is, contains or lies inside the original store. */
export function assertNotOriginal(
  copyDir,
  originalDir = DEFAULT_ORIGINAL_STORE,
) {
  const c = real(copyDir);
  const o = real(originalDir);
  if (isInside(o, c) || isInside(c, o))
    throw coded(
      'original-store',
      `refusing to use the original store (${originalDir}); use a verified copy`,
    );
}

function coded(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Copies the original store to `dest` (cp -a); never writes the original. */
export function copyStore({ original = DEFAULT_ORIGINAL_STORE, dest }) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0)
    throw new Error(`refusing to copy into non-empty ${dest}`);
  assertNotOriginal(dest, original);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync('cp', ['-a', '--', `${original}/.`, dest], {
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`);
  return dest;
}

/**
 * Verifies the consumed artifacts of a store copy against the CE manifest and
 * returns the product build binding.
 */
export function bindProductBuild({
  storeCopy,
  manifestPath,
  manifestSource,
  expectedManifestSha256 = null,
  originalStore = DEFAULT_ORIGINAL_STORE,
  corpus,
  archiveVerify = null,
  extractDocs = true,
}) {
  assertNotOriginal(storeCopy, originalStore);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifestSha256 = sha256(manifestBytes);
  if (
    expectedManifestSha256 != null &&
    manifestSha256 !== expectedManifestSha256
  )
    throw coded(
      'manifest',
      `manifest sha256 ${manifestSha256} differs from the pinned value`,
    );
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const epoch = manifest.epoch;
  const epochDecl = corpus?.epochs?.[epoch];
  if (epochDecl == null)
    throw coded('epoch', `epoch ${epoch} is not declared by corpus.json`);
  if (!(epochDecl.product?.commits ?? []).includes(manifest.source.commit))
    throw coded(
      'epoch',
      `epoch ${epoch} does not list source commit ${manifest.source.commit}`,
    );

  const verified = [];
  const check = (rel, expected) => {
    const abs = path.join(storeCopy, rel);
    if (!fs.existsSync(abs)) throw coded('artifact', `missing artifact ${rel}`);
    const st = fs.lstatSync(abs);
    if (!st.isFile())
      throw coded('artifact', `artifact ${rel} is not a regular file`);
    const got = fileSha256(abs);
    if (got !== expected) throw coded('artifact', `sha256 mismatch for ${rel}`);
    verified.push({ file: rel, sha256: got });
  };
  for (const p of manifest.packages) check(p.registry.file, p.registry.sha256);
  const nodeEntry =
    manifest.node.find(
      (n) => n.version === manifest.measurementNode?.version,
    ) ?? manifest.node[0];
  check(nodeEntry.file, nodeEntry.sha256);
  check(manifest.source.archive.file, manifest.source.archive.sha256);

  let agentDocs = {
    from: 'source-archive',
    paths: AGENT_DOC_PATHS,
    treeDigest: null,
  };
  if (extractDocs) {
    const dir = extractAgentDocs({ storeCopy, manifest });
    agentDocs = { ...agentDocs, dir, treeDigest: treeDigest(dir) };
  }

  const binding = {
    schema: BINDING_SCHEMA,
    epoch,
    source: {
      commit: manifest.source.commit,
      tree: manifest.source.tree,
      archiveFile: manifest.source.archive.file,
      archiveSha256: manifest.source.archive.sha256,
      version: manifest.source.release?.version ?? null,
    },
    packages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      file: p.registry.file,
      sha256: p.registry.sha256,
      integrity: p.registry.integrity,
    })),
    node: {
      version: nodeEntry.version,
      file: nodeEntry.file,
      sha256: nodeEntry.sha256,
    },
    agentDocs: {
      from: agentDocs.from,
      paths: agentDocs.paths,
      treeDigest: agentDocs.treeDigest,
    },
    provenance: {
      kind: 'ce-baseline-manifest',
      manifestSha256,
      manifestSource,
    },
    storeCopy: {
      path: storeCopy.replace(os.homedir(), '~'),
      verifiedArtifacts: verified,
      archiveVerify,
    },
  };
  binding.digest = digestJson(binding);
  return { binding, agentDocsDir: agentDocs.dir ?? null };
}

/** Extracts the agent docs of the product build from its source archive. */
export function extractAgentDocs({ storeCopy, manifest, dest = null }) {
  const out = dest ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pms-agent-docs-'));
  const archive = path.join(storeCopy, manifest.source.archive.file);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-src-'));
  try {
    const r = spawnSync(
      'tar',
      ['-xzf', archive, '-C', tmp, '--no-same-owner'],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
    const [top] = fs.readdirSync(tmp);
    const root = path.join(tmp, top);
    const docs = path.join(root, 'docs');
    for (const f of fs.existsSync(docs) ? fs.readdirSync(docs) : [])
      if (/^agent-.*\.md$/.test(f))
        copyNoFollow(path.join(docs, f), path.join(out, 'docs', f));
    if (fs.existsSync(path.join(docs, 'reference')))
      copyNoFollow(
        path.join(docs, 'reference'),
        path.join(out, 'docs/reference'),
      );
    const ref = path.join(root, 'benchmarks/alpha1-reference.json');
    if (fs.existsSync(ref))
      copyNoFollow(ref, path.join(out, 'benchmarks/alpha1-reference.json'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function copyNoFollow(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src))
      copyNoFollow(path.join(src, name), path.join(dest, name));
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function readManifest(file) {
  return readJson(file);
}
