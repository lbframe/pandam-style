/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Shared helpers for the CE-00.1 inventory tools. Nothing here imports
// upstream code; probes load upstream packages from an explicit install path.

import crypto from 'node:crypto';
import fs from 'node:fs';
import * as prettier from 'prettier';

export function parseArgs(argv, required = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) {
      throw new Error(`Expected --name value pairs, got ${argv[i]}`);
    }
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const name of required) {
    if (!out[name]) {
      throw new Error(`Missing --${name}`);
    }
  }
  return out;
}

// Runs an async tool entry point. The repository's Hermes-based parsers do not
// accept top-level await, so tools keep their asynchronous work in main().
export function run(main) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}

export function sha256(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

export function fileDigest(file) {
  return sha256(fs.readFileSync(file));
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Records are written in the repository's Prettier JSON style so a regenerated
// record is byte-stable and passes `prettier --check`. Minified input lets
// Prettier keep short objects on one line.
export async function writeJson(file, value) {
  const text = await prettier.format(JSON.stringify(value), {
    parser: 'json',
  });
  fs.writeFileSync(file, text);
}

// The research inventory normalization: camelCase to kebab case, vendor prefix
// preserved (`ms` and `Ms` both mean `-ms-`), `cssFloat` to `float`.
export function normalizePropertyName(key) {
  if (key === 'cssFloat') {
    return 'float';
  }
  if (key.startsWith('--') || key.includes('-')) {
    return key;
  }
  const vendor = /^(Webkit|Moz|Ms|ms|O|Khtml)(?=[A-Z])/.exec(key);
  const rest = vendor ? key.slice(vendor[0].length) : key;
  const kebab = rest.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return vendor ? `-${vendor[0].toLowerCase()}${kebab}` : kebab;
}

// Inverse of the inventory normalization, used only when an entry has no
// original key in the probed upstream's own surface.
export function camelCaseKey(name, { msPrefix = 'Ms' } = {}) {
  if (name === 'custom-property') {
    return '--ce001-probe';
  }
  const vendor = /^-(webkit|moz|ms|o|khtml)-/.exec(name);
  const rest = vendor ? name.slice(vendor[0].length) : name;
  const camel = rest.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!vendor) {
    return camel;
  }
  const prefix =
    vendor[1] === 'ms'
      ? msPrefix
      : vendor[1][0].toUpperCase() + vendor[1].slice(1);
  return prefix + camel[0].toUpperCase() + camel.slice(1);
}

// A minimal CSS block parser for compiler output. It honours strings,
// comments and nesting; it is not a general CSS parser.
export function parseCss(css) {
  const root = { type: 'root', children: [] };
  const stack = [root];
  let buffer = '';
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      buffer += c;
      if (c === '\\') {
        buffer += css[++i] ?? '';
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      buffer += c;
    } else if (c === '{') {
      const prelude = buffer.trim();
      const node = prelude.startsWith('@')
        ? {
            type: 'atrule',
            name: prelude.slice(1).split(/[\s(]/, 1)[0],
            params: prelude
              .slice(1)
              .replace(/^[^\s(]+/, '')
              .trim(),
            children: [],
          }
        : { type: 'rule', selector: prelude, children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
      buffer = '';
    } else if (c === ';' || c === '}') {
      const text = buffer.trim();
      if (text) {
        const colon = text.indexOf(':');
        if (colon > 0) {
          let value = text.slice(colon + 1).trim();
          const important = /!\s*important$/i.test(value);
          value = value.replace(/!\s*important$/i, '').trim();
          stack.at(-1).children.push({
            type: 'decl',
            prop: text.slice(0, colon).trim(),
            value,
            important,
          });
        }
      }
      buffer = '';
      if (c === '}' && stack.length > 1) {
        stack.pop();
      }
    } else {
      buffer += c;
    }
  }
  return root;
}

// Summarize emitted CSS into structural facts. The probe value is a CSS-wide
// keyword, so these facts describe property handling, not value domains.
export function summarizeCss(css, expectedProperty) {
  const declarations = [];
  const selectors = new Set();
  const atRules = new Set();
  const walk = (node) => {
    for (const child of node.children) {
      if (child.type === 'decl') {
        declarations.push(child);
      } else {
        if (child.type === 'rule') {
          selectors.add(child.selector);
        } else if (child.name !== 'layer') {
          atRules.add(`@${child.name} ${child.params}`);
        }
        walk(child);
      }
    }
  };
  walk(parseCss(css));
  for (const decl of declarations) {
    decl.property = decl.prop;
  }
  const properties = [...new Set(declarations.map((d) => d.property))];
  const realProperties = properties.filter((p) => !p.startsWith('--'));
  const customProperties = properties.filter((p) => p.startsWith('--'));
  const complexSelector = [...selectors].some((selector) =>
    selector.split(',').some((part) => !/^\s*\.[^\s>+~:[]+\s*$/.test(part)),
  );
  let kind;
  if (declarations.length === 0) {
    kind = 'no-emission';
  } else if (complexSelector) {
    kind = 'selector-helper';
  } else if (atRules.size > 0) {
    kind = 'conditional-helper';
  } else if (
    customProperties.length > 0 &&
    expectedProperty !== 'custom-property'
  ) {
    kind = 'custom-property-composition';
  } else if (
    realProperties.length === 1 &&
    realProperties[0] === expectedProperty
  ) {
    kind = 'passthrough';
  } else if (
    expectedProperty === 'custom-property' &&
    customProperties.length === 1 &&
    realProperties.length === 0
  ) {
    kind = 'passthrough';
  } else if (realProperties.length === 1) {
    kind = 'renamed';
  } else {
    kind = 'expanded';
  }
  return {
    kind,
    properties,
    important: declarations.some((d) => d.important),
    selectors: [...selectors].sort(),
    atRules: [...atRules].sort(),
  };
}
