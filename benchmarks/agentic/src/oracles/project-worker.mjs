/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Child process that observes a project through the public compiler SDK.
//
// Usage: node project-worker.mjs <request.json> <response.json>
//
// It runs in its own process so that definition modules, compiled
// application modules and React state never leak between evaluations, and so
// a crashing or hanging application module cannot take the harness down.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire, register } from 'node:module';
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
      'PMS_ORACLE_NO_COMPILER: @pandamstyle/compiler is not resolvable from the workspace',
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.exports?.['.']?.import ?? manifest.module;
  const compiler = await import(
    pathToFileURL(path.join(path.dirname(manifestPath), entry)).href
  );
  return { compiler, version: manifest.version };
}

async function importDefault(file) {
  const ns = await import(pathToFileURL(file).href);
  return Object.hasOwn(ns, 'default') ? ns.default : ns;
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
  { rootDir, definitionPath, roots, outDir },
) {
  const definition = await importDefault(definitionPath);
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

function flattenDefinition(definition) {
  const out = {};
  const json = (v) => JSON.stringify(v);
  function tokens(node, prefix) {
    for (const [key, value] of Object.entries(node ?? {})) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (
        value != null &&
        typeof value === 'object' &&
        ('value' in value || 'ref' in value)
      ) {
        out[`token:${p}`] = json(value);
      } else if (value != null && typeof value === 'object') {
        tokens(value, p);
      }
    }
  }
  out['system:id'] = json(definition?.systemId ?? null);
  tokens(definition?.tokens, '');
  for (const [name, value] of Object.entries(definition?.conditions ?? {})) {
    out[`condition:${name}`] = json(value);
  }
  for (const [name, value] of Object.entries(definition?.themes ?? {})) {
    out[`theme:${name}`] = json(value);
  }
  for (const [id, recipe] of Object.entries(definition?.recipes ?? {})) {
    out[`recipe:${id}`] = json(recipe?.base ?? null);
    for (const slot of recipe?.slots ?? [])
      out[`slot:${id}.${slot}`] = json(true);
    for (const [axis, branches] of Object.entries(recipe?.variants ?? {})) {
      for (const [value, branch] of Object.entries(branches ?? {})) {
        out[`variant:${id}.${axis}.${value}`] = json(branch);
      }
    }
    for (const [axis, value] of Object.entries(recipe?.defaultVariants ?? {})) {
      out[`default:${id}.${axis}`] = json(value);
    }
    (recipe?.compoundVariants ?? []).forEach((compound, i) => {
      out[`compound:${id}#${i}`] = json(compound);
    });
  }
  return out;
}

async function probeVocabulary(compiler, request, tokens, themes) {
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
      definitionPath: path.join(
        request.workspaceDir,
        request.project.definition,
      ),
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
    vocabulary: {},
    renders: {},
    tokenVars: {},
    themeClasses: {},
  };
  const ws = request.workspaceDir;

  for (const [label, file] of Object.entries(request.definitionFiles ?? {})) {
    try {
      response.vocabulary[label] = flattenDefinition(await importDefault(file));
    } catch (error) {
      response.vocabulary[label] = { error: String(error?.message ?? error) };
    }
  }

  if (request.compile) {
    const { compiler, version } = await loadCompiler(ws);
    response.compilerVersion = version;
    const roots = request.project.roots.map((r) => path.resolve(ws, r));
    const outDir = path.resolve(ws, request.project.outDir);
    const definitionPath = path.resolve(ws, request.project.definition);
    if (!fs.existsSync(definitionPath)) {
      response.compile = {
        ok: false,
        diagnostics: [
          {
            code: 'PMS_ORACLE_DEFINITION_MISSING',
            message: request.project.definition,
          },
        ],
      };
    } else {
      const result = await compileProject(compiler, {
        rootDir: ws,
        definitionPath,
        roots,
        outDir,
      });
      response.compile = { ok: result.ok, diagnostics: result.diagnostics };
      if (result.ok) {
        const generated = await result.session.readGeneratedArtifacts(
          result.revision,
        );
        response.compile.generatedFiles = generated.files.map(
          (f) => f.path ?? f.file ?? f.name,
        );
        response.css = fs.readFileSync(path.join(outDir, 'styles.css'), 'utf8');
        const overrides = {};
        const uncovered = [];
        for (const root of roots) {
          for (const abs of listSources(root)) {
            const rel = path.relative(ws, abs).split(path.sep).join('/');
            try {
              const artifact = await result.session.readArtifact(
                result.revision,
                rel,
              );
              overrides[pathToFileURL(abs).href] = artifact.javascript;
            } catch (error) {
              uncovered.push({
                file: rel,
                reason: String(error?.message ?? error),
              });
            }
          }
        }
        response.compile.coveredModules = Object.keys(overrides).length;
        response.compile.uncovered = uncovered;
        await result.session.close();

        if (request.probe === false) {
          fs.writeFileSync(responsePath, JSON.stringify(response));
          return;
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'),
        );
        const themes = manifest.themes ?? [];
        const probe = await probeVocabulary(
          compiler,
          request,
          request.tokenProbes ?? [],
          themes,
        );
        if (probe.probeUrl != null) overrides[probe.probeUrl] = probe.probeJs;
        register(new URL('./loader-hooks.mjs', import.meta.url), {
          data: { overrides, workspaceUrl: pathToFileURL(ws + path.sep).href },
        });
        if (probe.probeUrl != null) {
          const mod = await import(probe.probeUrl);
          response.themeClasses = mod.themeClasses;
          const { parseCss } = await import('../css-cascade.mjs');
          const rules = parseCss(probe.probeCss);
          probe.accepted.forEach((t, i) => {
            const classes = mod.tokenClasses[`t${i}`].split(/\s+/);
            let variable = null;
            for (const rule of rules) {
              for (const selector of rule.selectors) {
                const cls = selector.parts?.find(
                  (p) => p.type === 'class',
                )?.name;
                if (cls != null && classes.includes(cls)) {
                  const m = /^var\((--[\w-]+)\)$/.exec(
                    rule.declarations[0]?.value ?? '',
                  );
                  if (m) variable = m[1];
                }
              }
            }
            response.tokenVars[t] = variable;
          });
        }
        for (const t of probe.rejected ?? []) response.tokenVars[t] = null;

        const requireFromWs = createRequire(path.join(ws, 'package.json'));
        let React;
        let server;
        try {
          React = requireFromWs('react');
          server = requireFromWs('react-dom/server');
        } catch (error) {
          for (const r of request.renders ?? []) {
            response.renders[r.id] = {
              error: `PMS_ORACLE_NO_REACT: ${error.message}`,
            };
          }
        }
        for (const r of React != null ? (request.renders ?? []) : []) {
          try {
            const url = pathToFileURL(path.resolve(ws, r.module)).href;
            if (!Object.hasOwn(overrides, url)) {
              throw new Error(`PMS_ORACLE_UNCOVERED_MODULE: ${r.module}`);
            }
            const mod = await import(url);
            const Component = mod[r.export ?? 'default'];
            if (typeof Component !== 'function') {
              throw new Error(
                `PMS_ORACLE_MISSING_EXPORT: ${r.module}#${r.export ?? 'default'}`,
              );
            }
            let element = React.createElement(Component, r.props ?? {});
            if (r.theme != null) {
              const className = response.themeClasses[r.theme];
              if (className == null)
                throw new Error(`PMS_ORACLE_UNKNOWN_THEME: ${r.theme}`);
              element = React.createElement(
                'div',
                { className, 'data-pms-oracle-theme': r.theme },
                element,
              );
            }
            response.renders[r.id] = {
              html: server.renderToStaticMarkup(element),
            };
          } catch (error) {
            response.renders[r.id] = { error: String(error?.message ?? error) };
          }
        }
      } else {
        await result.session.close();
      }
    }
  }
  fs.writeFileSync(responsePath, JSON.stringify(response));
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
