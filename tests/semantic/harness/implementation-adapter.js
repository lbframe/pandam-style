/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';

// TEST ONLY. This is the sole implementation-dependent boundary in this oracle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const babel = require('@babel/core');
const postcss = require('postcss');
const crypto = require('crypto');
const compiler = require('../../../.pms-test-support/compiler-inspection.cjs');
const hasClass = (selector, name) =>
  [...selector.matchAll(/\.([\w-]+)/g)].some((match) => match[1] === name);

function definition(value) {
  if (Array.isArray(value)) return value.map(definition);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && value.$token)
      return compiler.token(value.$token);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, definition(v)]),
    );
  }
  return value;
}

function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function mutate(root, step) {
  for (const [name, text] of Object.entries(step.write ?? {}))
    write(root, name, text);
  for (const name of step.remove ?? []) fs.rmSync(path.join(root, name));
  for (const [from, to] of step.rename ?? []) {
    fs.mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
    fs.renameSync(path.join(root, from), path.join(root, to));
  }
}

function relative(root, value) {
  if (typeof value !== 'string') return value;
  return value.replaceAll(root + path.sep, '');
}

function portable(root, value, sessionId = null) {
  if (typeof value === 'string') {
    if (sessionId != null && value === sessionId) return 'oracle-session';
    return relative(root, value);
  }
  if (Array.isArray(value))
    return value.map((v) => portable(root, v, sessionId));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, portable(root, v, sessionId)]),
    );
  return value;
}

function tree(root) {
  const result = {};
  if (!fs.existsSync(root)) return result;
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else result[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
    }
  }
  walk(root);
  return result;
}

function cssProjection(css, system) {
  const variables = {};
  for (const [id, value] of Object.entries(system?.varsByToken ?? {})) {
    variables[value.slice(4, -1)] = id;
  }
  const themes = {};
  for (const [id, value] of Object.entries(system?.themeClasses ?? {})) {
    (themes[value.split(' ')[0]] ??= []).push(id);
  }
  const rules = [];
  const ast = postcss.parse(css);
  ast.walkRules((node) => {
    const conditions = [];
    for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule')
        conditions.unshift('@' + p.name + ' ' + p.params);
    }
    const declarations = [];
    node.walkDecls((d) => declarations.push([d.prop, d.value]));
    rules.push({ selector: node.selector, conditions, declarations });
  });
  return { rules, variables, themes };
}

// Evaluate the actual transformed modules; do not reimplement composition.
function evaluate(root, out, entry) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const text = fs.readFileSync(file, 'utf8');
    const { code } = babel.transformSync(text, {
      configFile: false,
      babelrc: false,
      plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
    });
    const mod = { exports: {} };
    cache.set(file, mod);
    const req = (request) => {
      if (request === '@pandamstyle/core') {
        return load(
          path.resolve(__dirname, '../../../packages/core/src/index.js'),
        );
      }
      if (!request.startsWith('.')) return require(request);
      const base = path.resolve(path.dirname(file), request);
      const candidates = [
        base,
        base + '.js',
        base + '.jsx',
        base + '.ts',
        base + '.tsx',
        path.join(base, 'index.js'),
      ];
      // Compiled sources retain the original design-module relative request.
      const generated = path.join(out, 'design.pandamstyle.js');
      if (request.includes('generated/design.pandamstyle'))
        return load(generated);
      const found = candidates.find(
        (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
      );
      if (!found)
        throw new Error('Oracle evaluation cannot resolve ' + request);
      return load(found);
    };
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
    return mod.exports;
  }
  return load(
    entry === '@design'
      ? path.join(out, 'design.pandamstyle.js')
      : path.join(out, 'js', entry),
  );
}

function observe(
  root,
  out,
  validation,
  session,
  spec,
  system,
  publicResult,
  publicSession,
  publicRoot,
) {
  const artifacts = tree(out);
  const manifest = artifacts['manifest.json']
    ? JSON.parse(artifacts['manifest.json'])
    : null;
  const css = cssProjection(artifacts['styles.css'] ?? '', system);
  const result = {
    accepted: validation.ok,
    diagnostics: portable(root, validation.diagnostics ?? []),
    codes: (validation.diagnostics ?? []).map((d) => d.code).sort(),
    revisionId: session ? validation.revisionId : null,
    current: session?.current() ?? null,
    publication: {
      exists: fs.existsSync(out),
      artifacts: Object.keys(artifacts).sort(),
    },
    publicationDigests: Object.fromEntries(
      Object.entries(artifacts).map(([p, text]) => [
        p,
        crypto.createHash('sha256').update(text).digest('hex'),
      ]),
    ),
    css,
    manifest: portable(root, manifest),
    agent:
      publicResult == null
        ? null
        : portable(publicRoot, publicResult, publicSession?.sessionId ?? null),
    counters: validation.counters ?? null,
    negativeResolutionCount: session
      ? session.stats().negativeResolutionCount
      : validation.negativeResolutionCount,
    publicationError: validation.publicationError ?? null,
  };
  if (spec.observe?.coverage) {
    // These accessors are already classified TEST ONLY in Phase 0's module map.
    const coverage = session ? session.coverageOrder() : validation.coverage;
    result.coverage = coverage.map(([file, origin]) => ({
      file: relative(root, file),
      origin,
    }));
  }
  if (spec.observe?.forwarding) {
    const file = path.join(root, spec.observe.forwarding);
    if (session)
      result.forwarding = portable(root, session.inspectForwarding(file));
    else result.forwarding = portable(root, validation.forwarding);
  }
  if (validation.ok && spec.observe?.runtime) {
    const exports = evaluate(root, out, spec.observe.runtime.file);
    result.runtime = {};
    for (const name of spec.observe.runtime.exports) {
      let value = spec.observe.runtime.styleRef
        ? evaluate(root, out, '@design').props(
            exports[spec.observe.runtime.styleRef.export][
              spec.observe.runtime.styleRef.key
            ],
          )
        : exports[name];
      if (spec.observe.runtime.compiledCancellation) {
        const { export: exportName, key } =
          spec.observe.runtime.compiledCancellation;
        const original = exports[exportName][key];
        // TEST ONLY compiled-ref format translation. The source validator does
        // not admit arbitrary tombstone objects; this independent core vector
        // exercises the actual runtime using the compiler's own conflict keys.
        const cancellation = {
          kind: 'pandamstyle-style-ref',
          abiVersion: 1,
          systemId: original.systemId,
          entries: original.entries.map(([conflict]) => [conflict, null]),
        };
        value = evaluate(root, out, '@design').props(original, cancellation);
      }
      const classes = value?.className?.split(/\s+/).filter(Boolean) ?? [];
      result.runtime[name] = {
        keys:
          value && typeof value === 'object' ? Object.keys(value).sort() : [],
        classes,
        rules: css.rules.filter((r) =>
          classes.some((c) => hasClass(r.selector, c)),
        ),
      };
    }
    if (spec.observe.browser)
      result.browser = require('./browser-adapter').observeBrowser(
        root,
        out,
        spec,
        exports,
        artifacts['styles.css'],
      );
  }
  result.artifactBytes = Object.fromEntries(
    Object.entries(artifacts)
      .filter(([p]) => !['build-report.json', 'coverage.json'].includes(p))
      .map(([p, text]) => [
        p,
        p === 'manifest.json' ? text.replaceAll(root + path.sep, '') : text,
      ]),
  );
  if (session && spec.observe?.ownership) result.ownership = session.cssState();
  if (validation.ok && spec.observe?.runtimeGuard) {
    try {
      const generated = evaluate(root, out, '@design');
      generated.props(spec.observe.runtimeGuard);
      result.runtimeGuard = { rejected: false, code: null };
    } catch (error) {
      result.runtimeGuard = {
        rejected: true,
        code: error.code ?? error.diagnostic?.code ?? null,
      };
    }
  }
  return result;
}

async function run(spec, lane) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-semantic-'));
  const root = path.join(parent, 'project');
  const out = path.join(root, 'generated');
  const publicRoot = path.join(parent, 'protocol-project');
  const publicOut = path.join(publicRoot, 'generated');
  for (const [name, text] of Object.entries(spec.files))
    write(root, name, text);
  for (const [name, text] of Object.entries(spec.files))
    write(publicRoot, name, text);
  let input = structuredClone(spec.designSystem);
  let failurePoint = null;
  function injected(point) {
    if (failurePoint == null || failurePoint !== point) return;
    const err = new Error('test-only staged publication failure');
    err.code = 'PMS_INJECTED_PUBLICATION_FAILURE';
    throw err;
  }
  const args = () => ({
    projectId: 'oracle-project',
    definition: definition(input),
    roots: spec.roots.map((p) => path.join(root, p)),
    outDir: out,
    ...(lane === 'incremental'
      ? {
          publishVariant: 'session_incremental_publish_css',
          publishFailAt: injected,
        }
      : { onStage: () => injected(failurePoint) }),
  });
  const session =
    lane === 'incremental' ? compiler.createProjectSession(args()) : null;
  const publicArgs = () => ({
    projectId: 'oracle-project',
    definition: definition(input),
    rootDir: publicRoot,
    roots: spec.roots.map((p) => path.join(publicRoot, p)),
    outDir: publicOut,
    publishVariant: 'session_incremental_publish_css',
    publishFailAt: injected,
  });
  const incrementalPublicSession =
    lane === 'incremental'
      ? compiler.createPublicProjectSession(publicArgs())
      : null;
  const ephemeralPublicSessions = [];
  let publicRevision = null;
  const results = [];
  try {
    for (const [index, step] of spec.revisions.entries()) {
      mutate(root, step);
      mutate(publicRoot, step);
      if (step.designSystem) input = structuredClone(step.designSystem);
      failurePoint = step.publicationFailure ?? null;
      const publicSession =
        incrementalPublicSession ??
        compiler.createPublicProjectSession(publicArgs());
      if (publicSession !== incrementalPublicSession)
        ephemeralPublicSessions.push(publicSession);
      if (lane === 'fresh' || index === 0) {
        const initialized = await publicSession.initialize();
        publicRevision = initialized.revision;
      } else {
        const applied = await publicSession.applyChanges({
          baseRevision: publicRevision,
          mode: 'full-discovery',
          changed: [],
          added: [],
          removed: [],
          renamed: [],
          definition: definition(input),
        });
        publicRevision = applied.revision;
      }
      const publicValidation = await publicSession.validate(publicRevision);
      if (publicValidation.ok && step.publish !== false) {
        try {
          await publicSession.compile(publicRevision);
        } catch (error) {
          if (error.code !== 'PMS_INJECTED_PUBLICATION_FAILURE') throw error;
        }
      }
      const publicResult = await publicSession.agentResult(
        publicRevision,
        spec.observe?.agentOptions ?? {},
      );
      let validation;
      if (session) {
        session.applyChanges({
          initial: index === 0,
          definition: definition(input),
        });
        validation = session.validate();
        if (validation.ok && step.publish !== false) {
          try {
            session.compile();
          } catch (error) {
            if (error.code !== 'PMS_INJECTED_PUBLICATION_FAILURE') throw error;
            validation.publicationError = error.code;
          }
        }
      } else {
        fs.rmSync(out, { recursive: true, force: true });
        compiler.clearModuleCache();
        // The fresh resolver needs the same virtual generated module that the
        // one-shot build supplies. This separate rollback-only probe records
        // its own fresh closure and binding answers before publication.
        const probe = compiler.beginGeneration(out);
        const cold = compiler.createCompilerSession({
          ...args(),
          generation: probe,
        });
        const coverage = [...cold.coverage];
        const negativeResolutionCount = cold.unresolved.length;
        let forwarding = [];
        if (spec.observe?.forwarding) {
          const file = path.join(root, spec.observe.forwarding);
          forwarding = cold._withGraphContext(() =>
            compiler
              .moduleEdgesOf(file)
              .edges.filter((e) => e.form === 'import')
              .map((e) => {
                const info = compiler.resolveDesignSystemModule(
                  file,
                  e.request,
                );
                return {
                  source: e.request,
                  bindings: info?.exportsOfRelay ?? [],
                  issues: info?.issues ?? [],
                };
              }),
          );
        }
        probe.rollback();
        try {
          compiler.buildProject(args());
          validation = { ok: true, diagnostics: [] };
        } catch (error) {
          if (error.code === 'PMS_INJECTED_PUBLICATION_FAILURE')
            validation = {
              ok: true,
              diagnostics: [],
              publicationError: error.code,
            };
          else {
            if (!error.diagnostics) throw error;
            validation = { ok: false, diagnostics: error.diagnostics };
          }
        }
        validation.coverage = coverage;
        validation.forwarding = forwarding;
        validation.negativeResolutionCount = negativeResolutionCount;
      }
      const system = compiler.buildDesignSystem(definition(input));
      const observed = observe(
        root,
        out,
        validation,
        session,
        spec,
        system,
        publicResult ?? publicValidation.agentResult,
        publicSession,
        publicRoot,
      );
      results.push(observed);
      if (publicSession !== incrementalPublicSession) {
        await publicSession.close();
        ephemeralPublicSessions.splice(
          ephemeralPublicSessions.indexOf(publicSession),
          1,
        );
      }
    }
    return results;
  } finally {
    session?.close();
    await Promise.all(
      [
        ...(incrementalPublicSession ? [incrementalPublicSession] : []),
        ...ephemeralPublicSessions,
      ].map((publicSession) => publicSession.close()),
    );
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

module.exports = { run, cssProjection, portable };
