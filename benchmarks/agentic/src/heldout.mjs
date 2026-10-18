/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Held-out set custody: manifest, seal, unseal, verify and the tracked
// plaintext guard. See heldout/ACCESS-POLICY.md for who may unseal and when.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  digestTaskDir,
  heldoutPaths,
  loadCorpus,
  setDigest,
  validateCorpus,
} from './corpus.mjs';
import { sha256 } from './fs-tree.mjs';

export const UNSEAL_PURPOSES = [
  'ag-12.2-final-qualification',
  'seal-verification',
];

function passphraseFile() {
  const file = process.env.PMS_HELDOUT_PASSPHRASE_FILE;
  if (file == null || file === '')
    throw new Error('PMS_HELDOUT_PASSPHRASE_FILE is not set');
  if (!fs.existsSync(file))
    throw new Error(`passphrase file ${file} does not exist`);
  return path.resolve(file);
}

function repoRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

function existingAncestor(file) {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  return dir;
}

// A path outside any Git work tree cannot be committed, so it counts as ignored.
function isIgnored(file) {
  const root = repoRoot(existingAncestor(file));
  if (root == null) return true;
  const rel = path.relative(root, file);
  if (rel.startsWith('..')) return true;
  return (
    spawnSync('git', ['check-ignore', '-q', '--no-index', rel], { cwd: root })
      .status === 0
  );
}

export function buildManifest(root) {
  const hp = heldoutPaths(root);
  const loaded = loadCorpus(root, { heldoutTasksDir: hp.plaintextTasks });
  const previous = fs.existsSync(hp.manifest)
    ? JSON.parse(fs.readFileSync(hp.manifest, 'utf8'))
    : null;
  const tasks = loaded.heldout.map((t) => ({
    id: t.task.id,
    workflow: t.task.workflow,
    caseType: t.task.caseType,
    tags: t.task.tags,
    fixture: t.task.workspace.fixture,
    classification: Object.fromEntries(
      Object.entries(t.task.expectations).map(([k, v]) => [
        k,
        v.classification,
      ]),
    ),
    sha256: digestTaskDir(t.dir),
  }));
  const plaintextSetDigest = setDigest(tasks.map((t) => [t.id, t.sha256]));
  const keepSeal =
    previous?.sealed?.plaintextSetDigest === plaintextSetDigest
      ? previous.sealed
      : null;
  return {
    schemaVersion: 1,
    corpusVersion: loaded.corpus.corpusVersion,
    digestAlgorithm: 'pms-tree-sha256/v1',
    encryption: {
      tool: 'gpg',
      cipher: 'AES256',
      mode: 'symmetric',
      archive: 'heldout.tar.gpg',
    },
    sealed: keepSeal,
    tasks,
  };
}

export function writeManifest(root, manifest) {
  fs.writeFileSync(
    heldoutPaths(root).manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/** Validates plaintext, writes the manifest, encrypts a deterministic tar. */
export function seal(root) {
  const hp = heldoutPaths(root);
  const pass = passphraseFile();
  if (!isIgnored(path.join(hp.plaintextTasks, 'x')))
    throw new Error('plaintext staging path is not gitignored');
  const manifest = buildManifest(root);
  writeManifest(root, { ...manifest, sealed: null });
  const loaded = loadCorpus(root, { heldoutTasksDir: hp.plaintextTasks });
  const { errors } = validateCorpus(loaded, { checkLock: false });
  if (errors.length > 0)
    throw new Error(
      `refusing to seal an invalid corpus:\n${errors.join('\n')}`,
    );
  const tar = spawnSync(
    'tar',
    [
      '--sort=name',
      '--mtime=@0',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--format=gnu',
      '-C',
      hp.plaintext,
      '-cf',
      '-',
      'tasks',
    ],
    { maxBuffer: 1 << 30 },
  );
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const tmp = `${hp.archive}.tmp`;
  const gpg = spawnSync(
    'gpg',
    [
      '--batch',
      '--yes',
      '--quiet',
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      pass,
      '--symmetric',
      '--cipher-algo',
      'AES256',
      '--s2k-digest-algo',
      'SHA512',
      '--s2k-mode',
      '3',
      '--s2k-count',
      '65011712',
      '--compress-algo',
      'none',
      '--output',
      tmp,
    ],
    { input: tar.stdout },
  );
  if (gpg.status !== 0) throw new Error(`gpg failed: ${gpg.stderr}`);
  fs.renameSync(tmp, hp.archive);
  const sealedManifest = {
    ...manifest,
    sealed: {
      archiveSha256: sha256(fs.readFileSync(hp.archive)),
      plaintextSetDigest: setDigest(
        manifest.tasks.map((t) => [t.id, t.sha256]),
      ),
    },
  };
  writeManifest(root, sealedManifest);
  return sealedManifest;
}

export function unseal(
  root,
  { dest = null, purpose = process.env.PMS_HELDOUT_PURPOSE } = {},
) {
  if (!UNSEAL_PURPOSES.includes(purpose)) {
    throw new Error(
      `unseal requires PMS_HELDOUT_PURPOSE in ${UNSEAL_PURPOSES.join('|')} (see heldout/ACCESS-POLICY.md)`,
    );
  }
  const hp = heldoutPaths(root);
  const target = path.resolve(dest ?? hp.unsealed);
  if (!isIgnored(path.join(target, 'tasks', 'x')))
    throw new Error(`${target} is inside the repository and not gitignored`);
  const pass = passphraseFile();
  const manifest = JSON.parse(fs.readFileSync(hp.manifest, 'utf8'));
  if (manifest.sealed == null || !fs.existsSync(hp.archive))
    throw new Error('held-out set is not sealed');
  if (sha256(fs.readFileSync(hp.archive)) !== manifest.sealed.archiveSha256)
    throw new Error('archive digest differs from MANIFEST.json');
  const gpg = spawnSync(
    'gpg',
    [
      '--batch',
      '--quiet',
      '--pinentry-mode',
      'loopback',
      '--passphrase-file',
      pass,
      '--decrypt',
      hp.archive,
    ],
    {
      maxBuffer: 1 << 30,
    },
  );
  if (gpg.status !== 0) throw new Error(`gpg decryption failed: ${gpg.stderr}`);
  fs.rmSync(path.join(target, 'tasks'), { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const tar = spawnSync('tar', ['-xf', '-', '-C', target, '--no-same-owner'], {
    input: gpg.stdout,
  });
  if (tar.status !== 0) throw new Error(`tar extraction failed: ${tar.stderr}`);
  const mismatches = manifest.tasks
    .filter((t) => digestTaskDir(path.join(target, 'tasks', t.id)) !== t.sha256)
    .map((t) => t.id);
  if (mismatches.length > 0)
    throw new Error(
      `unsealed tasks differ from MANIFEST.json: ${mismatches.join(', ')}`,
    );
  return path.join(target, 'tasks');
}

/** Integrity checks that need no passphrase. */
export function verify(root) {
  const hp = heldoutPaths(root);
  const problems = [];
  const manifest = JSON.parse(fs.readFileSync(hp.manifest, 'utf8'));
  const computedSet = setDigest(manifest.tasks.map((t) => [t.id, t.sha256]));
  if (manifest.sealed != null) {
    if (!fs.existsSync(hp.archive))
      problems.push('MANIFEST.json says sealed but heldout.tar.gpg is missing');
    else if (
      sha256(fs.readFileSync(hp.archive)) !== manifest.sealed.archiveSha256
    )
      problems.push('archive digest mismatch');
    if (manifest.sealed.plaintextSetDigest !== computedSet)
      problems.push('plaintextSetDigest does not match listed task digests');
  } else if (fs.existsSync(hp.archive)) {
    problems.push('heldout.tar.gpg exists but MANIFEST.json is not sealed');
  }
  if (fs.existsSync(hp.plaintextTasks)) {
    for (const t of manifest.tasks) {
      const dir = path.join(hp.plaintextTasks, t.id);
      if (!fs.existsSync(dir)) problems.push(`plaintext for ${t.id} missing`);
      else if (digestTaskDir(dir) !== t.sha256)
        problems.push(`plaintext for ${t.id} differs from MANIFEST.json`);
    }
  }
  return {
    sealed: manifest.sealed != null,
    tasks: manifest.tasks.length,
    problems,
  };
}

/** Fails if held-out plaintext is tracked or not ignored. */
export function guard(root) {
  const hp = heldoutPaths(root);
  const problems = [];
  const top = repoRoot(root);
  if (top == null)
    return { problems: ['not a git work tree; guard cannot run'] };
  for (const dir of [hp.plaintext, hp.unsealed]) {
    const rel = path.relative(top, dir);
    const tracked = spawnSync('git', ['ls-files', '--cached', '--', rel], {
      cwd: top,
      encoding: 'utf8',
    }).stdout.trim();
    if (tracked !== '')
      problems.push(
        `tracked held-out plaintext under ${rel}: ${tracked.split('\n').slice(0, 5).join(', ')}`,
      );
    if (!isIgnored(path.join(dir, 'tasks', 'probe', 'task.json')))
      problems.push(`${rel} is not gitignored`);
  }
  const manifest = fs.existsSync(hp.manifest)
    ? JSON.parse(fs.readFileSync(hp.manifest, 'utf8'))
    : { tasks: [] };
  const digests = new Set(manifest.tasks.map((t) => t.sha256));
  const ids = new Set(manifest.tasks.map((t) => t.id));
  const tasksDir = path.join(root, 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const name of fs.readdirSync(tasksDir)) {
      if (ids.has(name))
        problems.push(
          `held-out task id ${name} appears in the development split`,
        );
      const dir = path.join(tasksDir, name);
      if (fs.statSync(dir).isDirectory() && digests.has(digestTaskDir(dir))) {
        problems.push(
          `development task ${name} is byte-identical to a held-out task`,
        );
      }
    }
  }
  return { problems };
}
