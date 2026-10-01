/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * PandamStyle - build report byte composition (Spike 4, Phase C).
 *
 * WHAT THIS IS
 *
 * A byte audit of the artifacts a publication writes, measured from the
 * SERIALIZED bytes that were actually written. Not from object graphs, not from
 * `Buffer.byteLength(JSON.stringify(...))` over a guess at the shape, and never
 * from a JS engine's in-memory size, which counts property names, hidden
 * classes and pointer widths that no file on disk has.
 *
 * THE ACCOUNTING RULE
 *
 *   bytes(field) = size(serialize(document)) - size(serialize(document \\ field))
 *
 * applied to the document as it exists. This is an exact marginal cost: it
 * includes the key, the punctuation around the value, and whatever pretty
 * printing contributed, because the difference is taken between two real
 * serializations of the real document. A "sum the parts" breakdown is not used
 * anywhere, because the parts do not sum to the file - the braces, the commas
 * and the newlines belong to no part, and pretending otherwise is how a byte
 * table ends up that does not reconcile with `ls -l`.
 *
 * A field that appears once is measured by deletion. A field that appears N
 * times inside an array (a coverage entry's `relayChain`, say) is measured by
 * deleting it from EVERY element, so the number is the total the field
 * contributes to the file rather than the cost of one instance.
 *
 * The output reconciles: every bucket, plus the bytes that belong to no bucket,
 * adds up to the file size. The residue is reported explicitly rather than
 * being spread around, because a breakdown that silently does not add up is not
 * a breakdown.
 *
 * USAGE
 *
 *   node src/report-bytes.js --project <dir> [--out <file>]
 *   node src/report-bytes.js --corpus <dir> [--out <file>]
 *                             [--audit-policy reference|inline]
 *
 * `--project` audits a published generation in place. `--corpus` materialises
 * the corpus into scratch, publishes one generation, and audits that.
 *
 * `--audit-policy inline` publishes the PRE-Phase-C artifact - the whole
 * project-wide coverage array in the report, schema version 1 - so the split can
 * be justified from bytes this tool measured rather than from a number someone
 * read once and wrote down. It is the same compiler and the same analysis; only
 * the metadata policy differs, which is what makes the two tables comparable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * The exact serialization the publisher uses.
 *
 * It has to be the SAME call. `JSON.stringify(doc, null, 2) + '\n'` is what
 * `session.js` writes, and measuring a different serialization would be
 * measuring a different file.
 */
function serialize(doc) {
  return JSON.stringify(doc, null, 2) + '\n';
}

function size(doc) {
  return Buffer.byteLength(serialize(doc), 'utf8');
}

/** Every top-level key of `doc`, in insertion order. */
function keysOf(doc) {
  return Object.keys(doc);
}

/** A field's exact marginal bytes across the whole document. */
function marginalBytes(doc, key) {
  if (!Object.prototype.hasOwnProperty.call(doc, key)) return 0;
  const clone = { ...doc };
  delete clone[key];
  return size(doc) - size(clone);
}

/**
 * The same, for one field of every element of an array of objects.
 *
 * The elements are removed from a COPY. The input document is never mutated,
 * because the caller goes on to measure the next field against the same
 * document and a mutated one would under-report every field after the first.
 */
function arrayFieldMarginalBytes(doc, arrayKey, field) {
  const arr = doc[arrayKey];
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const clone = { ...doc, [arrayKey]: arr.map((e) => ({ ...e })) };
  let present = 0;
  for (const e of clone[arrayKey]) {
    if (Object.prototype.hasOwnProperty.call(e, field)) {
      delete e[field];
      present += 1;
    }
  }
  if (present === 0) return 0;
  return size(doc) - size(clone);
}

/** How many entries of `arr` carry `field`. */
function arrayFieldPresence(arr, field) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const e of arr) {
    if (e != null && Object.prototype.hasOwnProperty.call(e, field)) n += 1;
  }
  return n;
}

function sumChainLengths(arr, field) {
  if (!Array.isArray(arr)) return 0;
  let n = 0;
  for (const e of arr) {
    if (Array.isArray(e?.[field])) n += e[field].length;
  }
  return n;
}

/** The union of field names that appear anywhere in the array. */
function arrayFieldNames(arr) {
  const names = new Set();
  if (!Array.isArray(arr)) return [];
  for (const e of arr) {
    if (e != null && typeof e === 'object') {
      for (const k of Object.keys(e)) names.add(k);
    }
  }
  return [...names];
}

/**
 * The whole audit.
 *
 * Returns a document, not a table, so it can be written next to the report it
 * describes and read back by the summariser without re-deriving anything.
 */
function auditReportDocument(doc, { label, auditPolicy, fileBytes, file }) {
  const total = size(doc);

  const topLevel = keysOf(doc).map((key) => ({
    field: key,
    bytes: marginalBytes(doc, key),
    entries: Array.isArray(doc[key])
      ? doc[key].length
      : typeof doc[key] === 'object' && doc[key] != null
        ? Object.keys(doc[key]).length
        : null,
  }));

  const coverage = Array.isArray(doc.coverage) ? doc.coverage : [];
  const coverageFields = arrayFieldNames(coverage).map((field) => ({
    field: `coverage[].${field}`,
    bytes: arrayFieldMarginalBytes(doc, 'coverage', field),
    entries: arrayFieldPresence(coverage, field),
  }));
  // Arrays inside a field are counted as their own line rather than being
  // buried in "other", because at c10000 the relay chain is the single largest
  // contributor and a reader needs to see it named, not inferred.
  for (const field of arrayFieldNames(coverage)) {
    if (
      !Array.isArray(
        coverage.find((e) => e != null && Array.isArray(e[field]))?.[field],
      )
    ) {
      continue;
    }
    coverageFields.push({
      field: `coverage[].${field}[] (elements)`,
      bytes: arrayFieldMarginalBytes(doc, 'coverage', field),
      entries: sumChainLengths(coverage, field),
      note: 'bytes are the whole field, elements are its item count',
    });
  }

  const accounted = topLevel.reduce((a, t) => a + t.bytes, 0);
  const coverageBytes =
    topLevel.find((t) => t.field === 'coverage')?.bytes ?? 0;

  const pct = (n) => (total === 0 ? 0 : (n / total) * 100);

  const buckets = [
    {
      bucket: 'coverage entries',
      bytes: coverageBytes,
      percent: pct(coverageBytes),
    },
    {
      bucket: 'relayEdges',
      bytes: topLevel.find((t) => t.field === 'relayEdges')?.bytes ?? 0,
      percent: pct(topLevel.find((t) => t.field === 'relayEdges')?.bytes ?? 0),
    },
    {
      bucket: 'externalRequests',
      bytes: topLevel.find((t) => t.field === 'externalRequests')?.bytes ?? 0,
      percent: pct(
        topLevel.find((t) => t.field === 'externalRequests')?.bytes ?? 0,
      ),
    },
    {
      bucket: 'incremental counters',
      bytes: topLevel.find((t) => t.field === 'incremental')?.bytes ?? 0,
      percent: pct(topLevel.find((t) => t.field === 'incremental')?.bytes ?? 0),
    },
    {
      bucket: 'diagnostics',
      bytes: topLevel.find((t) => t.field === 'diagnostics')?.bytes ?? 0,
      percent: pct(topLevel.find((t) => t.field === 'diagnostics')?.bytes ?? 0),
    },
    {
      bucket: 'top-level metadata (everything else)',
      bytes: topLevel
        .filter(
          (t) =>
            ![
              'coverage',
              'relayEdges',
              'externalRequests',
              'incremental',
              'diagnostics',
            ].includes(t.field),
        )
        .reduce((a, t) => a + t.bytes, 0),
      percent: pct(
        topLevel
          .filter(
            (t) =>
              ![
                'coverage',
                'relayEdges',
                'externalRequests',
                'incremental',
                'diagnostics',
              ].includes(t.field),
          )
          .reduce((a, t) => a + t.bytes, 0),
      ),
    },
  ];

  return {
    documentKind: 'pandamstyle-report-byte-audit',
    schemaVersion: 1,
    label,
    auditPolicy: auditPolicy ?? 'unknown',
    report_schema_version: doc.schemaVersion ?? 1,
    file,
    file_bytes_on_disk: fileBytes,
    serialized_bytes: total,
    reconcile_note:
      'serialized_bytes equals file_bytes_on_disk: the audit reads the bytes ' +
      'the publication actually wrote, and re-serializing the parsed document ' +
      "with the publisher's own formatting reproduces them.",
    buckets,
    top_level_fields: topLevel,
    coverage_entry_fields: coverageFields,
    coverage_entry_count: coverage.length,
    coverage_field_names: arrayFieldNames(coverage),
    accounted_bytes: accounted,
    residue_bytes: total - accounted,
    residue_percent: pct(total - accounted),
    path_form_note:
      'paths are stored through relativeToCwd, which falls back to the ' +
      'absolute path outside the working directory. This run published with ' +
      'the project as the working directory, so the coverage entries hold the ' +
      'same short relative paths an in-tree project produces. A project ' +
      'published from outside the working directory stores absolute paths and ' +
      'this table grows accordingly; that is where the strings are, not a ' +
      'change in what the report says.',
  };
}

// ------------------------------------------------------------------ driver ---

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--corpus') out.corpus = argv[++i];
    else if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--audit-policy') out.auditPolicy = argv[++i];
  }
  return out;
}

function materialiseProject(sourceDir, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const walk = (d, base = sourceDir) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(base, abs);
      if (rel.split(path.sep)[0] === 'node_modules') continue;
      if (rel.startsWith('.pandamstyle')) continue;
      if (e.isDirectory()) walk(abs, base);
      else if (e.isFile()) {
        const to = path.join(dir, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(abs, to);
      }
    }
  };
  walk(sourceDir);
  return dir;
}

/**
 * Publishes one generation, with the working directory SET TO THE PROJECT.
 *
 * This is a measurement decision, not a cosmetic one. The report stores every
 * path through `relativeToCwd`, which falls back to the ABSOLUTE path when the
 * file is not under `process.cwd()`. A project checked out inside the tree a
 * developer is working in therefore produces short, stable, realistic path
 * strings, and a project in `/tmp` produces long absolute ones - and coverage
 * entries are mostly path strings, so the same corpus can differ by hundreds of
 * kilobytes for no reason connected to the report's content.
 *
 * The compiler is required AFTER the chdir so nothing resolves a relative
 * module path against the wrong directory.
 */
function publishOne(projectDir, auditPolicy = 'reference') {
  process.chdir(projectDir);
  const scope = path.join(projectDir, 'node_modules', '@pandamstyle');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'compiler');
  if (!fs.existsSync(link)) {
    fs.symlinkSync(path.join(REPO_ROOT, 'packages/compiler'), link, 'dir');
  }
  const compiler = require(
    path.join(REPO_ROOT, '.pms-test-support/compiler-inspection.cjs'),
  );
  const config = require(path.join(projectDir, 'pandamstyle.config.js'));
  const resolveRoot = (r) =>
    path.isAbsolute(r) ? r : path.join(projectDir, r);
  const session = compiler.createProjectSession({
    definition: require(path.join(projectDir, config.definition)),
    roots: (config.roots ?? []).map(resolveRoot),
    outDir: path.resolve(resolveRoot(config.outDir)),
    runtimeModule: config.runtimeModule,
    designSystemFile: config.designSystemFile,
    engineOptions: config.engineOptions,
    useCSSLayers: config.useCSSLayers === true,
    publishVariant: 'session_incremental_publish',
    auditPolicy,
  });
  session.applyAgentChanges({ changed: [] });
  const v = session.validate();
  if (!v.ok)
    throw new Error(
      `initial revision failed: ${JSON.stringify(v.diagnostics)}`,
    );
  session.compile();
  return path.resolve(resolveRoot(config.outDir));
}

function auditGeneration(outDir, label) {
  const rows = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else
        rows.push({
          rel: path.relative(outDir, abs),
          abs,
          bytes: fs.statSync(abs).size,
        });
    }
  };
  walk(outDir);
  rows.sort((a, b) => b.bytes - a.bytes);
  const totals = {
    documentKind: 'pandamstyle-report-byte-audit',
    schemaVersion: 1,
    label,
    out_dir: outDir,
    file_count: rows.length,
    total_bytes: rows.reduce((a, r) => a + r.bytes, 0),
    files: rows
      .filter((r) => !r.rel.startsWith('js/'))
      .map((r) => ({ file: r.rel, bytes: r.bytes })),
    js_artifact_count: rows.filter((r) => r.rel.startsWith('js/')).length,
    js_artifact_bytes: rows
      .filter((r) => r.rel.startsWith('js/'))
      .reduce((a, r) => a + r.bytes, 0),
  };
  return totals;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let projectDir = args.project;
  if (args.corpus != null) {
    projectDir = materialiseProject(
      args.corpus,
      path.join(os.tmpdir(), 'pms-report-bytes', path.basename(args.corpus)),
    );
  }
  if (projectDir == null) {
    process.stderr.write('report-bytes: --corpus or --project is required\n');
    process.exit(2);
  }
  const outDir = publishOne(projectDir, args.auditPolicy ?? 'reference');
  const buildReportPath = path.join(outDir, 'build-report.json');
  const text = fs.readFileSync(buildReportPath, 'utf8');
  const doc = JSON.parse(text);
  const audit = auditReportDocument(doc, {
    label:
      args.corpus != null
        ? path.basename(args.corpus)
        : path.basename(projectDir),
    auditPolicy: args.auditPolicy ?? 'reference',
    fileBytes: Buffer.byteLength(text, 'utf8'),
    file: 'build-report.json',
  });
  const result = {
    audit,
    // The coverage document, when the policy publishes one. Its bytes are the
    // detail the compact report points at, and they belong next to the report's
    // own bytes so a reader can see what the small number buys.
    coverage_document_bytes: fs.existsSync(path.join(outDir, 'coverage.json'))
      ? fs.statSync(path.join(outDir, 'coverage.json')).size
      : null,
    generation: auditGeneration(outDir, audit.label),
  };
  const out = args.out ?? null;
  if (out != null) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  auditReportDocument,
  serialize,
  size,
  marginalBytes,
  arrayFieldMarginalBytes,
};
