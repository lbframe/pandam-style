/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Derives the frozen CE-00.2 corpus workload record:
//
//   node tools/baselines/derive-ce-corpus.mjs --closure <alpha1 closure dir>
//
// Input: the CE-00.2 accounting record and the Alpha 1 property policy, both
// read as Git objects at pinned commits, so later corpus or compiler changes
// cannot move this workload. Every baseline declaration the pinned policy
// classifies as expressible is a candidate. Category values become public
// tokens; structural values stay literal (numeric-range properties as
// numbers). The candidate project is then compiled by the Alpha 1 compiler of
// the given closure; each declaration the compiler rejects is excluded with
// its diagnostic code, and compilation repeats until it is clean. The record
// therefore lists exactly the corpus declarations Alpha 1 compiles.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BENCH, gitBlob, sha256, writeJson } from './lib.mjs';
import { ALPHA1_POLICY, camel } from '../coverage/classify.mjs';
import { buildFiles, OUT_DIR, DESIGN_MODULE } from './workloads.mjs';

export const RECORD = 'workloads/ce-corpus.v1.json';
export const CORPUS_COMMIT = '20ce741b8cdd1616560af7cd8be1420024414409';
export const POLICY_COMMIT = '415e05539fcb5d36a78226112b5cf488b200b1aa';
export const ACCOUNTING = 'tests/core-evolution/corpus/accounting.v1.json';

export async function loadPolicy() {
  const bytes = gitBlob(POLICY_COMMIT, ALPHA1_POLICY.path);
  if (sha256(bytes) !== ALPHA1_POLICY.sha256)
    throw new Error('the Alpha 1 policy blob does not match its pinned digest');
  return import(`data:text/javascript;base64,${bytes.toString('base64')}`);
}

export function candidates(accounting, policy) {
  const tokens = {};
  const stylesheets = [];
  for (const sheet of accounting.stylesheets) {
    const slug = sheet.path.split('/').at(-2);
    const declarations = [];
    for (const record of sheet.declarations) {
      if (record.denominator !== 'alpha1-baseline') continue;
      if (record.alpha1.outcome !== 'expressible') continue;
      const property = camel(record.property);
      const value = record.value.trim();
      const entry = { id: record.id, property };
      if (record.alpha1.bucket === 'category') {
        const category = policy.propertyCategory(property);
        tokens[category] ??= new Set();
        tokens[category].add(value);
        entry.token = { category, value };
      } else if (policy.structuralAllowed(property, value)) {
        entry.literal = value;
      } else if (policy.structuralAllowed(property, Number(value))) {
        entry.literal = Number(value);
      } else {
        throw new Error(
          `${record.id} is not expressible under the pinned policy`,
        );
      }
      declarations.push(entry);
    }
    stylesheets.push({
      fixtureId: sheet.fixtureId,
      slug,
      path: sheet.path,
      declarations,
    });
  }
  // Token names are ordinals of the distinct values of each category in
  // code-unit order, so they depend on the value set only.
  const names = {};
  const named = {};
  for (const [category, values] of Object.entries(tokens)) {
    named[category] = {};
    [...values].sort().forEach((value, index) => {
      const name = `t${String(index).padStart(3, '0')}`;
      names[`${category}\0${value}`] = `${category}.${name}`;
      named[category][name] = value;
    });
  }
  for (const sheet of stylesheets)
    for (const entry of sheet.declarations)
      if (entry.token != null)
        entry.token = names[`${entry.token.category}\0${entry.token.value}`];
  return { tokens: named, stylesheets };
}

// Keeps only tokens still referenced, in sorted order.
export function prune(derivation) {
  const used = new Set();
  for (const sheet of derivation.stylesheets)
    for (const d of sheet.declarations) if (d.token != null) used.add(d.token);
  const tokens = {};
  for (const category of Object.keys(derivation.tokens).sort())
    for (const name of Object.keys(derivation.tokens[category]).sort())
      if (used.has(`${category}.${name}`)) {
        tokens[category] ??= {};
        tokens[category][name] = derivation.tokens[category][name];
      }
  return { ...derivation, tokens };
}

async function compileOnce(closure, derivation) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce003-derive-'));
  const recordFile = path.join(BENCH, 'workloads/.derive-candidate.json');
  writeJson(recordFile, derivation);
  try {
    const files = buildFiles({
      source: { kind: 'ce-corpus', record: 'workloads/.derive-candidate.json' },
    });
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    fs.symlinkSync(
      path.join(closure, 'node_modules'),
      path.join(dir, 'node_modules'),
    );
    const compiler = await import(
      pathToFileURL(
        path.join(closure, 'node_modules/@pandamstyle/compiler/lib/index.mjs'),
      ).href
    );
    const definition = (
      await import(pathToFileURL(path.join(dir, 'design.mjs')).href)
    ).default;
    const session = compiler.createProjectSession({
      rootDir: dir,
      definition,
      roots: ['src'],
      outDir: path.join(dir, OUT_DIR),
      designSystemFile: DESIGN_MODULE,
    });
    try {
      let init;
      try {
        init = await session.initialize();
      } catch (error) {
        return { definitionErrors: error.diagnostics ?? [error], files, dir };
      }
      const validation = await session.validate(init.revision);
      const errors = (validation.diagnostics ?? []).filter(
        (d) => d.severity === 'error',
      );
      if (errors.length === 0) await session.compile(init.revision);
      return { errors, files, dir };
    } finally {
      await session.close();
    }
  } finally {
    fs.rmSync(recordFile, { force: true });
  }
}

// Maps a diagnostic to the declaration on its source line (each declaration
// sits on its own line and ends with a comment naming its id).
function declarationOf(diagnostic, files, dir) {
  const file = diagnostic.source?.file ?? diagnostic.file;
  const line = diagnostic.source?.line ?? diagnostic.line;
  if (file == null || line == null) return null;
  const rel = path.isAbsolute(file) ? path.relative(dir, file) : file;
  const text = files[rel.split(path.sep).join('/')];
  if (text == null) return null;
  return /\/\/ (\S+)$/.exec(text.split('\n')[line - 1] ?? '')?.[1] ?? null;
}

async function main() {
  const index = process.argv.indexOf('--closure');
  if (index < 0) throw new Error('usage: derive-ce-corpus.mjs --closure <dir>');
  const closure = path.resolve(process.argv[index + 1]);
  const policy = await loadPolicy();
  const accountingBytes = gitBlob(CORPUS_COMMIT, ACCOUNTING);
  let derivation = prune(candidates(JSON.parse(accountingBytes), policy));
  const excluded = [];
  for (let round = 0; ; round++) {
    if (round > 20) throw new Error('exclusion did not converge');
    const result = await compileOnce(closure, derivation);
    fs.rmSync(result.dir, { recursive: true, force: true });
    if (result.definitionErrors != null) {
      const bad = new Set();
      for (const d of result.definitionErrors) {
        const text = `${d.message ?? ''} ${JSON.stringify(d.details ?? d.context ?? {})}`;
        for (const [category, names] of Object.entries(derivation.tokens))
          for (const name of Object.keys(names))
            if (text.includes(`${category}.${name}`))
              bad.add(`${category}.${name}`);
        if (bad.size === 0)
          throw new Error(`unmapped definition diagnostic: ${text}`);
        for (const sheet of derivation.stylesheets)
          sheet.declarations = sheet.declarations.filter((decl) => {
            if (!bad.has(decl.token)) return true;
            excluded.push({
              id: decl.id,
              stage: 'definition',
              code: d.code ?? null,
            });
            return false;
          });
      }
      derivation = prune(derivation);
      continue;
    }
    if (result.errors.length === 0) break;
    const ids = new Map();
    for (const d of result.errors) {
      const id = declarationOf(d, result.files, result.dir);
      if (id == null)
        throw new Error(`unmapped diagnostic ${d.code}: ${d.message}`);
      if (!ids.has(id)) ids.set(id, d.code);
    }
    for (const sheet of derivation.stylesheets)
      sheet.declarations = sheet.declarations.filter((decl) => {
        if (!ids.has(decl.id)) return true;
        excluded.push({ id: decl.id, stage: 'source', code: ids.get(decl.id) });
        return false;
      });
    derivation = prune(derivation);
  }
  const included = derivation.stylesheets.reduce(
    (n, s) => n + s.declarations.length,
    0,
  );
  const record = {
    schemaVersion: 1,
    kind: 'pandamstyle-ce003-ce-corpus-workload',
    generatedBy:
      'node tools/baselines/derive-ce-corpus.mjs --closure <alpha1 closure>',
    inputs: {
      accounting: {
        commit: CORPUS_COMMIT,
        path: ACCOUNTING,
        sha256: sha256(accountingBytes),
      },
      policy: { commit: POLICY_COMMIT, ...ALPHA1_POLICY },
      compiler: '@pandamstyle/compiler@0.1.0-alpha.1 (alpha1 closure)',
    },
    rules: [
      'Candidates: alpha1-baseline declarations the pinned policy classifies as expressible.',
      'Category values become public tokens named t<NNN>: the ordinal of the value among the distinct values of its category in code-unit order.',
      'Structural values stay literal; a value admitted only as a number is emitted as a number.',
      'Selector and at-rule contexts are flattened into the base style: compile-cost workload, not fidelity.',
      'A namespace closes when a property repeats, preserving declaration order.',
      'Declarations rejected by the Alpha 1 compiler are excluded with their diagnostic code.',
    ],
    totals: {
      candidates: included + excluded.length,
      included,
      excluded: excluded.length,
      tokens: Object.values(derivation.tokens).reduce(
        (n, t) => n + Object.keys(t).length,
        0,
      ),
    },
    excluded: excluded.sort((a, b) => (a.id < b.id ? -1 : 1)),
    tokens: derivation.tokens,
    stylesheets: derivation.stylesheets,
  };
  writeJson(path.join(BENCH, RECORD), record);
  console.log(JSON.stringify(record.totals));
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  });
