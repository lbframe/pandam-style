/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Shared fixtures for the AG-03.1 metadata suites (design note §5). The
 * compiler is the built private inspection bundle, like the session suites.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function loadCompiler() {
  // eslint-disable-next-line
  return require(
    path.resolve(
      __dirname,
      '../../../../.pms-test-support/compiler-inspection.cjs',
    ),
  );
}

const compiler = loadCompiler();
const T = compiler.token;

/** A definition with every entity kind and no metadata. */
function baseDefinition() {
  return {
    systemId: 'meta-fixture@1',
    tokens: {
      spacing: { sm: { value: '8px' }, md: { value: '16px' } },
      colors: {
        ink: { value: '#172033', visibility: 'private' },
        paper: { value: '#ffffff' },
        text: { primary: { ref: 'colors.ink' }, muted: { ref: 'colors.ink' } },
      },
    },
    conditions: {
      wide: { atRule: '@media (min-width: 48rem)' },
      hover: ':is(:hover, [data-hover])',
    },
    themes: { dark: { tokens: {} }, contrast: { tokens: {} } },
    recipes: {
      button: {
        base: { color: T('colors.text.primary') },
        variants: {
          tone: { neutral: {}, danger: {} },
          size: { sm: {}, md: {} },
        },
      },
      card: {
        slots: ['root', 'label'],
        base: { root: {}, label: {} },
        variants: { density: { compact: {}, loose: {} } },
      },
      zzsecret: {
        visibility: 'private',
        slots: ['inner'],
        base: { inner: { color: T('colors.ink') } },
        variants: { mood: { calm: {} } },
      },
    },
    propertyDomains: { width: { values: ['auto', '100%'] } },
  };
}

/** Every field of a kind at a valid, non-trivial value (no references). */
function fullMeta(kind, label = kind) {
  const meta = {
    description: `The ${label} entity, described.`,
    usage: ['Use it on default surfaces.', 'Prefer it in lists.'],
    restrictions: ['Avoid it on dark backgrounds.'],
    terms: ['alpha', 'beta-term'],
  };
  if (kind !== 'system') meta.semanticRole = 'primary-role';
  return meta;
}

/** Builds, or returns the thrown diagnostics. */
function attempt(definition) {
  try {
    return { ds: compiler.buildDesignSystem(definition) };
  } catch (error) {
    if (error?.diagnostics == null) throw error;
    return { diagnostics: error.diagnostics };
  }
}

/** The diagnostics of a definition that must fail, as `[code, rule]`. */
function failures(definition) {
  const result = attempt(definition);
  if (result.ds != null) throw new Error('expected the definition to fail');
  return result.diagnostics;
}

/** A fresh project directory with one plain source file. */
function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pms-meta-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/page.js'), 'export const x = 1;\n');
  return root;
}

/** Opens a public session on a temp project. */
function openSession(definition, root = tempProject()) {
  return compiler.createPublicProjectSession({
    rootDir: root,
    roots: [path.join(root, 'src')],
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pms-meta-out-')),
    definition,
  });
}

/** `{ ok, diagnostics, files }` of a definition through the public session. */
async function sessionResult(definition) {
  const session = openSession(definition);
  try {
    const init = await session.initialize();
    const validation = await session.validate(init.revision);
    const files = validation.ok
      ? Object.fromEntries(
          (await session.readGeneratedArtifacts(validation.revision)).files.map(
            (f) => [f.kind, f.content],
          ),
        )
      : null;
    return { ok: validation.ok, diagnostics: validation.diagnostics, files };
  } finally {
    await session.close();
  }
}

/** JSON with sorted keys: the round-trip comparison form. */
function canonical(value) {
  return JSON.stringify(value, (key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((k) => [k, item[k]]),
        )
      : item,
  );
}

const clone = (value) => {
  // structuredClone drops token() marks; rebuild them.
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    const path = compiler.tokenPathOf(v, 'author');
    if (path != null) return T(path);
    if (Array.isArray(v)) return v.map(walk);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  return walk(value);
};

module.exports = {
  compiler,
  T,
  attempt,
  baseDefinition,
  canonical,
  clone,
  failures,
  fullMeta,
  openSession,
  sessionResult,
  tempProject,
};
