/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CE-02.2 (#47) PR A, note §2.1: independent evidence for every grammar
 * branch that grants admission.
 *
 * `@webref/css` (pinned exactly, a root devDependency, never shipped) holds
 * the value definitions extracted from the CSS specifications. For every
 * admitted descriptor:
 *
 *   - every keyword branch of its grammar occurs in the webref value syntax
 *     of the property (property references and non-numeric types expanded);
 *   - every numeric branch's type occurs there with bounds at least as tight
 *     as webref's range notation;
 *   - every scalar constraint (token values, §3.5) does too.
 *
 * Opaque branches admit only exact, compiler-reviewed values and are not
 * checked here. The compiler never imports `@webref/css`: a structural check
 * covers src/ and the built lib/.
 */

const fs = require('fs');
const path = require('path');
const { loadCompiler } = require('./session-helpers');

const compiler = loadCompiler();
const REPO = path.resolve(__dirname, '../../../..');
const WEBREF_VERSION = '8.7.7';
const webref = require('@webref/css/css.json');

const NUMERIC = new Set([
  'length',
  'percentage',
  'length-percentage',
  'number',
  'integer',
  'time',
]);

const propertySyntax = new Map();
for (const p of webref.properties) {
  if (typeof p.syntax === 'string' && !propertySyntax.has(p.name)) {
    propertySyntax.set(p.name, p.syntax);
  }
}
const typeSyntax = new Map();
for (const t of webref.types) {
  // A type defined for one property only keeps its first general definition.
  if (typeof t.syntax === 'string' && !typeSyntax.has(t.name)) {
    typeSyntax.set(t.name, t.syntax);
  }
}

/** A property's syntax with property references and non-numeric types expanded. */
function expanded(name, depth = 0, seen = new Set()) {
  const syntax = propertySyntax.get(name);
  if (syntax == null) return null;
  return expandText(syntax, depth, seen);
}

function expandText(text, depth, seen) {
  if (depth > 8) return text;
  return text.replace(/<'([a-z-]+)'>|<([a-z-]+)>/g, (whole, property, type) => {
    if (property != null) {
      if (seen.has(`p:${property}`)) return whole;
      const inner = propertySyntax.get(property);
      if (inner == null) return whole;
      return `[ ${expandText(inner, depth + 1, new Set([...seen, `p:${property}`]))} ]`;
    }
    if (NUMERIC.has(type) || seen.has(`t:${type}`)) return whole;
    const inner = typeSyntax.get(type);
    if (inner == null) return whole;
    return `[ ${expandText(inner, depth + 1, new Set([...seen, `t:${type}`]))} ]`;
  });
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasKeyword = (text, keyword) =>
  new RegExp(`(^|[\\s\\[|(])${escape(keyword)}($|[\\s\\]|)?#{,*+!])`).test(
    text,
  );

function bound(text) {
  if (text === '∞' || text === '+∞' || text === '-∞') return null;
  const m = /^(-?\d+(?:\.\d+)?)(s|ms)?$/.exec(text);
  if (m == null) throw new Error(`webref bound ${text}`);
  return Number(m[1]) * (m[2] === 'ms' ? 0.001 : 1);
}

/** Whether `text` holds the numeric type of `c` with bounds at least as wide. */
function hasNumeric(text, c) {
  const re = new RegExp(
    `<${escape(c.type)}(?:\\s*\\[\\s*([^,\\]]+?)\\s*,\\s*([^\\]]+?)\\s*\\])?>`,
    'g',
  );
  for (const m of text.matchAll(re)) {
    const min = m[1] == null ? null : bound(m[1]);
    const max = m[2] == null ? null : bound(m[2]);
    const minOk = min == null || (c.min != null && c.min >= min);
    const maxOk = max == null || (c.max != null && c.max <= max);
    if (minOk && maxOk) return true;
  }
  return false;
}

const admitted = compiler
  .descriptorKeys()
  .map((key) => compiler.descriptorOf(key))
  .filter((d) => d.standard != null);

describe('the pinned evidence', () => {
  test(`@webref/css is pinned at ${WEBREF_VERSION}, as a devDependency only`, () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
    );
    expect(pkg.devDependencies['@webref/css']).toBe(WEBREF_VERSION);
    expect(pkg.dependencies?.['@webref/css']).toBeUndefined();
    const compilerPkg = JSON.parse(
      fs.readFileSync(
        path.join(REPO, 'packages/compiler/package.json'),
        'utf8',
      ),
    );
    expect(JSON.stringify(compilerPkg)).not.toContain('@webref');
    expect(require('@webref/css/package.json').version).toBe(WEBREF_VERSION);
  });

  test('the compiler sources never import it', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(m?js|json)$/.test(entry.name)) {
          if (fs.readFileSync(file, 'utf8').includes('@webref')) {
            offenders.push(path.relative(REPO, file));
          }
        }
      }
    };
    walk(path.join(REPO, 'packages/compiler/src'));
    expect(offenders).toEqual([]);
  });

  test('the built lib/ ships none of it', () => {
    const lib = path.join(REPO, 'packages/compiler/lib');
    const files = fs.readdirSync(lib);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = fs.readFileSync(path.join(lib, file), 'utf8');
      expect({ file, webref: text.includes('@webref') }).toEqual({
        file,
        webref: false,
      });
      // A field only webref's css.json has.
      expect({ file, extract: text.includes('"canonicalOrder"') }).toEqual({
        file,
        extract: false,
      });
    }
  });
});

describe('admitting grammar branches against @webref/css', () => {
  test.each(admitted.map((d) => [d.key, d]))('%s', (_, d) => {
    const text = expanded(d.css);
    expect({ property: d.css, inWebref: text != null }).toEqual({
      property: d.css,
      inWebref: true,
    });
    const grammar = compiler.grammarOf(d.key);
    for (const keyword of grammar.keywords) {
      expect({
        property: d.css,
        keyword,
        found: hasKeyword(text, keyword),
      }).toEqual({
        property: d.css,
        keyword,
        found: true,
      });
    }
    for (const c of grammar.numeric) {
      expect({
        property: d.css,
        numeric: [c.type, c.min, c.max],
        found: hasNumeric(text, c),
      }).toEqual({
        property: d.css,
        numeric: [c.type, c.min, c.max],
        found: true,
      });
    }
    if (d.scalar != null) {
      for (const c of d.scalar.constraints) {
        expect({
          property: d.css,
          scalar: [c.type, c.min, c.max],
          found: hasNumeric(text, c),
        }).toEqual({
          property: d.css,
          scalar: [c.type, c.min, c.max],
          found: true,
        });
      }
    }
  });

  // The check itself refuses what webref does not grant.
  test.each([
    ['padding-top', { type: 'length-percentage', min: null, max: null }],
    ['opacity', { type: 'length', min: null, max: null }],
    ['flex-grow', { type: 'number', min: -1, max: null }],
    ['font-weight', { type: 'number', min: 0, max: 1000 }],
    ['transition-duration', { type: 'time', min: -1, max: null }],
  ])('%s does not grant %j', (property, c) => {
    expect(hasNumeric(expanded(property), c)).toBe(false);
  });

  test.each([
    ['flex-direction', 'diagonal'],
    ['width', 'stretchy'],
    ['margin-top', 'none'],
  ])('%s has no keyword %s', (property, keyword) => {
    expect(hasKeyword(expanded(property), keyword)).toBe(false);
  });
});
