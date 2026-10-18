/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Trusted child process that observes a project through the public compiler
// SDK.
//
// Usage: node project-worker.mjs <request.json> <response.json>
//
// It never imports code written by the evaluated agent. The design-system
// definition arrives as data produced by the sandbox (sandbox.mjs); token
// references are re-minted with the trusted compiler's own `token()`.
// Application modules are only compiled here, never executed: rendering
// happens in the sandbox. Nothing derived from agent input is executed here:
// the vocabulary probe is compiled here and run in the sandbox.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE = /\.(jsx?|tsx?|mjs)$/;
const PROBE_PROPERTY = {
  colors: 'color',
  spacing: 'paddingTop',
  radii: 'borderRadius',
  fontFamilies: 'fontFamily',
  fontSizes: 'fontSize',
  fontWeights: 'fontWeight',
  lineHeights: 'lineHeight',
  letterSpacings: 'letterSpacing',
  shadows: 'boxShadow',
  durations: 'transitionDuration',
  easings: 'transitionTimingFunction',
};

function findPackage(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function loadCompiler(workspaceDir) {
  const manifestPath = findPackage(workspaceDir, '@pandamstyle/compiler');
  if (manifestPath == null) {
    throw new Error(
      'PMS_ORACLE_NO_COMPILER: @pandamstyle/compiler is not resolvable from the trusted dependency tree',
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const dir = path.dirname(manifestPath);
  const entry = manifest.exports?.['.']?.import ?? manifest.module;
  const configEntry = manifest.exports?.['./config']?.import;
  const compiler = await import(pathToFileURL(path.join(dir, entry)).href);
  const config = await import(pathToFileURL(path.join(dir, configEntry)).href);
  return { compiler, config, version: manifest.version };
}

// Rebuilds a definition from sandbox data with trusted token references.
function reviveDefinition(data, token) {
  if (Array.isArray(data)) return data.map((v) => reviveDefinition(v, token));
  if (data != null && typeof data === 'object') {
    if (typeof data.$pmsTokenRef === 'string') return token(data.$pmsTokenRef);
    const out = {};
    for (const [key, value] of Object.entries(data))
      out[key] = reviveDefinition(value, token);
    return out;
  }
  return data;
}

function listSources(root) {
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (
        entry.isFile() &&
        SOURCE.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(abs);
      }
    }
  }
  walk(root);
  return out.sort();
}

function normalizeDiagnostic(d) {
  return {
    code: d.code ?? null,
    severity: d.severity ?? null,
    message: d.message ?? null,
    source:
      typeof d.source === 'object' && d.source != null
        ? d.source
        : (d.source ?? null),
  };
}

async function compileProject(
  compiler,
  { rootDir, definition, roots, outDir },
) {
  const session = compiler.createProjectSession({
    projectId: rootDir,
    rootDir,
    definition,
    roots,
    outDir,
  });
  try {
    const initial = await session.initialize();
    const validated = await session.validate(initial.revision);
    if (!validated.ok) {
      const diagnostics =
        validated.agentResult?.diagnostics ?? validated.diagnostics ?? [];
      return {
        ok: false,
        diagnostics: diagnostics.map(normalizeDiagnostic),
        session,
      };
    }
    await session.compile(validated.revision);
    return { ok: true, diagnostics: [], session, revision: validated.revision };
  } catch (error) {
    const diagnostics = Array.isArray(error?.diagnostics)
      ? error.diagnostics
      : [];
    if (diagnostics.length === 0) throw error;
    return {
      ok: false,
      diagnostics: diagnostics.map(normalizeDiagnostic),
      session,
    };
  }
}

async function probeVocabulary(compiler, request, definition, tokens, themes) {
  const probeRoot = path.join(request.workspaceDir, '.pms-oracle-probe');
  const probeOut = path.join(request.workspaceDir, '.pms-oracle-probe-out');
  fs.rmSync(probeRoot, { recursive: true, force: true });
  fs.mkdirSync(probeRoot, { recursive: true });
  const probeFile = path.join(probeRoot, 'probe.js');
  const write = (list) => {
    const lines = list.map((t, i) => {
      const category = t.split('.')[0];
      const property = PROBE_PROPERTY[category] ?? 'color';
      return `  t${i}: { ${property}: token(${JSON.stringify(t)}) },`;
    });
    fs.writeFileSync(
      probeFile,
      [
        "import { create, token, props, themes } from '../.pms-oracle-probe-out/design.pandamstyle.js';",
        'const s = create({',
        ...lines,
        "  zz: { display: 'block' },",
        '});',
        'export const tokenClasses = {',
        ...list.map((_t, i) => `  t${i}: props(s.t${i}).className,`),
        '};',
        'export const themeClasses = {',
        ...themes.map(
          (name) =>
            `  ${JSON.stringify(name)}: props(themes[${JSON.stringify(name)}]).className,`,
        ),
        '};',
        'export { s as __probe };',
        '',
      ].join('\n'),
    );
  };
  const run = async (list) => {
    write(list);
    const result = await compileProject(compiler, {
      rootDir: request.workspaceDir,
      definition,
      roots: [probeRoot],
      outDir: probeOut,
    });
    if (!result.ok) {
      await result.session.close();
      return null;
    }
    const artifact = await result.session.readArtifact(
      result.revision,
      '.pms-oracle-probe/probe.js',
    );
    await result.session.close();
    return { javascript: artifact.javascript, list };
  };
  let accepted = tokens;
  let probe = await run(accepted);
  const rejected = [];
  if (probe == null) {
    accepted = [];
    for (const t of tokens) {
      if ((await run([t])) != null) accepted.push(t);
      else rejected.push(t);
    }
    probe = await run(accepted);
  }
  if (probe == null)
    return {
      tokenVars: {},
      themeClasses: {},
      rejected: tokens,
      probeUrl: null,
    };
  return {
    probeUrl: pathToFileURL(probeFile).href,
    probeJs: probe.javascript,
    probeCss: fs.readFileSync(path.join(probeOut, 'styles.css'), 'utf8'),
    accepted,
    rejected,
  };
}

async function main() {
  const [requestPath, responsePath] = process.argv.slice(2);
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const response = {
    compile: null,
    tokenVars: {},
    themeClasses: {},
    overrides: {},
  };
  const ws = request.workspaceDir;
  const { compiler, config, version } = await loadCompiler(ws);
  response.compilerVersion = version;
  const roots = request.project.roots.map((r) => path.resolve(ws, r));
  const outDir = path.resolve(ws, request.project.outDir);
  if (request.definitionError != null) {
    response.compile = {
      ok: false,
      diagnostics: [
        {
          code: 'PMS_ORACLE_DEFINITION_UNLOADABLE',
          message: request.definitionError,
        },
      ],
    };
    fs.writeFileSync(responsePath, JSON.stringify(response));
    return;
  }
  const definition = reviveDefinition(request.definitionData, config.token);
  const result = await compileProject(compiler, {
    rootDir: ws,
    definition,
    roots,
    outDir,
  });
  response.compile = { ok: result.ok, diagnostics: result.diagnostics };
  if (!result.ok) {
    await result.session.close();
    fs.writeFileSync(responsePath, JSON.stringify(response));
    return;
  }
  const generated = await result.session.readGeneratedArtifacts(
    result.revision,
  );
  response.compile.generatedFiles = generated.files.map(
    (f) => f.path ?? f.file ?? f.name,
  );
  response.css = fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8');
  const uncovered = [];
  for (const root of roots) {
    for (const abs of listSources(root)) {
      const rel = path.relative(ws, abs).split(path.sep).join('/');
      try {
        const artifact = await result.session.readArtifact(
          result.revision,
          rel,
        );
        response.overrides[pathToFileURL(abs).href] = artifact.javascript;
      } catch (error) {
        uncovered.push({ file: rel, reason: String(error?.message ?? error) });
      }
    }
  }
  response.compile.coveredModules = Object.keys(response.overrides).length;
  response.compile.uncovered = uncovered;
  await result.session.close();
  if (request.probe !== false) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
    );
    const probe = await probeVocabulary(
      compiler,
      request,
      definition,
      request.tokenProbes ?? [],
      manifest.themes ?? [],
    );
    // The probe is compiled here but executed by the parent in the sandbox:
    // this process never runs code derived from agent input.
    response.probe = {
      url: probe.probeUrl,
      javascript: probe.probeJs ?? null,
      css: probe.probeCss ?? null,
      accepted: probe.accepted ?? [],
      rejected: probe.rejected ?? [],
    };
  }
  fs.writeFileSync(responsePath, JSON.stringify(response));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
