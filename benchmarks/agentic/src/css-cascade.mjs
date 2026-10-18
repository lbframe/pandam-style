/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Static cascade evaluation over compiler-emitted CSS.
//
// This resolves, for one element of a server-rendered tree, which declaration
// wins for a property in a stated context (viewport width, simulated
// interaction states) and what its custom properties resolve to. It is an
// oracle for the compiler's own output shape (class and attribute selectors,
// `:is()`, the `:not(#\#)` specificity booster, `:root`, simple media
// queries). Any selector or media feature outside that shape is never
// guessed: a property it could affect is reported as unmeasured.

const STATE_PSEUDOS = new Set([
  'hover',
  'focus',
  'focus-visible',
  'focus-within',
  'active',
  'visited',
  'checked',
]);
const FORM_ELEMENTS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'fieldset',
  'option',
]);

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote != null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseDeclarations(body) {
  const out = [];
  for (const decl of splitTopLevel(body, ';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const property = decl.slice(0, colon).trim();
    let value = decl.slice(colon + 1).trim();
    const important = /!important$/i.test(value);
    if (important) value = value.replace(/\s*!important$/i, '');
    out.push({ property, value, important });
  }
  return out;
}

/** Parses a block list into `{ media: string[], selectors, declarations, order }`. */
export function parseCss(source) {
  const css = stripComments(source);
  const rules = [];
  let order = 0;
  function parseBlock(text, media) {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open === -1) break;
      const prelude = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const body = text.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) {
        parseBlock(body, [...media, prelude.slice('@media'.length).trim()]);
      } else if (prelude.startsWith('@')) {
        rules.push({
          media,
          atRule: prelude,
          selectors: [],
          declarations: [],
          order: order++,
          unsupported: `at-rule ${prelude.split(/\s/)[0]}`,
        });
      } else {
        rules.push({
          media,
          selectors: splitTopLevel(prelude, ',').map(parseSelector),
          declarations: parseDeclarations(body),
          order: order++,
        });
      }
      i = j;
    }
  }
  parseBlock(css, []);
  return rules;
}

// A compound selector is a list of simple selectors with no combinator.
function parseSelector(text) {
  const parts = [];
  let i = 0;
  const unsupported = (why) => ({ text, parts: [], unsupported: why });
  while (i < text.length) {
    const ch = text[i];
    if (/\s|>|\+|~/.test(ch)) return unsupported('combinator');
    if (ch === '.') {
      const m = /^\.((?:\\.|[\w-])+)/.exec(text.slice(i));
      if (m == null) return unsupported('class');
      parts.push({ type: 'class', name: m[1].replace(/\\(.)/g, '$1') });
      i += m[0].length;
    } else if (ch === '[') {
      const end = text.indexOf(']', i);
      const m =
        /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\s*\]$/.exec(
          text.slice(i, end + 1),
        );
      if (m == null) return unsupported('attribute');
      parts.push({
        type: 'attribute',
        name: m[1],
        value: m[2] ?? m[3] ?? m[4] ?? null,
      });
      i = end + 1;
    } else if (text.startsWith(':not(#\\#)', i)) {
      parts.push({ type: 'booster' });
      i += ':not(#\\#)'.length;
    } else if (text.startsWith(':is(', i) || text.startsWith(':where(', i)) {
      const isWhere = text.startsWith(':where(', i);
      const start = text.indexOf('(', i);
      let depth = 1;
      let j = start + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth += 1;
        else if (text[j] === ')') depth -= 1;
        j += 1;
      }
      const inner = splitTopLevel(text.slice(start + 1, j - 1), ',').map(
        parseSelector,
      );
      if (inner.some((s) => s.unsupported != null))
        return unsupported('nested');
      parts.push({ type: 'is', options: inner, zeroSpecificity: isWhere });
      i = j;
    } else if (text.startsWith('::', i)) {
      return unsupported('pseudo-element');
    } else if (ch === ':') {
      const m = /^:([\w-]+)/.exec(text.slice(i));
      if (m == null) return unsupported('pseudo');
      const name = m[1];
      if (name === 'root') parts.push({ type: 'root' });
      else if (STATE_PSEUDOS.has(name)) parts.push({ type: 'state', name });
      else if (name === 'disabled' || name === 'enabled')
        parts.push({ type: name });
      else return unsupported(`pseudo-class :${name}`);
      i += m[0].length;
    } else if (/[a-zA-Z]/.test(ch)) {
      const m = /^[a-zA-Z][\w-]*/.exec(text.slice(i));
      parts.push({ type: 'tag', name: m[0].toLowerCase() });
      i += m[0].length;
    } else {
      return unsupported(`token ${ch}`);
    }
  }
  return { text, parts };
}

function specificityOf(selector) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (const part of selector.parts) {
    if (part.type === 'booster') a += 1;
    else if (part.type === 'tag') c += 1;
    else if (part.type === 'is') {
      if (part.zeroSpecificity) continue;
      const best = part.options
        .map(specificityOf)
        .sort((x, y) => compareSpecificity(y, x))[0] ?? [0, 0, 0];
      a += best[0];
      b += best[1];
      c += best[2];
    } else b += 1;
  }
  return [a, b, c];
}

function compareSpecificity(x, y) {
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

function matchesSelector(selector, element, context) {
  return selector.parts.every((part) => {
    switch (part.type) {
      case 'class':
        return (element.classes ?? []).includes(part.name);
      case 'tag':
        return element.tag === part.name;
      case 'attribute':
        return (
          Object.hasOwn(element.attributes ?? {}, part.name) &&
          (part.value == null || element.attributes[part.name] === part.value)
        );
      case 'booster':
        return true;
      case 'root':
        return element.isRoot === true;
      case 'state':
        return (context.states ?? []).includes(part.name);
      case 'disabled':
        return (
          FORM_ELEMENTS.has(element.tag) &&
          Object.hasOwn(element.attributes ?? {}, 'disabled')
        );
      case 'enabled':
        return (
          FORM_ELEMENTS.has(element.tag) &&
          !Object.hasOwn(element.attributes ?? {}, 'disabled')
        );
      case 'is':
        return part.options.some((option) =>
          matchesSelector(option, element, context),
        );
      default:
        return false;
    }
  });
}

function toPx(value) {
  const m = /^(-?\d*\.?\d+)(px|rem|em)$/.exec(value.trim());
  if (m == null) return null;
  const n = Number(m[1]);
  return m[2] === 'px' ? n : n * 16;
}

/** Returns true, false or null (unknown media feature). */
export function evaluateMedia(query, context) {
  const width = context.viewportWidth ?? 1280;
  const alternatives = splitTopLevel(query, ',');
  let unknown = false;
  for (const alternative of alternatives) {
    const clauses = alternative
      .replace(/^only\s+/, '')
      .split(/\s+and\s+/)
      .map((s) => s.trim());
    let all = true;
    for (const clause of clauses) {
      if (clause === 'screen' || clause === 'all') continue;
      const m = /^\(\s*([\w-]+)\s*:\s*([^)]+)\)$/.exec(clause);
      if (m == null) {
        unknown = true;
        all = false;
        break;
      }
      const [, feature, raw] = m;
      const value = raw.trim();
      let result;
      if (feature === 'min-width' && toPx(value) != null)
        result = width >= toPx(value);
      else if (feature === 'max-width' && toPx(value) != null)
        result = width <= toPx(value);
      else if (feature === 'prefers-reduced-motion') {
        result = (context.reducedMotion ? 'reduce' : 'no-preference') === value;
      } else if (feature === 'prefers-color-scheme') {
        result = (context.colorScheme ?? 'light') === value;
      } else {
        unknown = true;
        result = false;
      }
      if (!result) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return unknown ? null : false;
}

function applicableDeclarations(rules, element, context) {
  const out = [];
  const unmeasured = [];
  for (const rule of rules) {
    if (rule.unsupported != null) continue;
    let mediaState = true;
    for (const media of rule.media) {
      const r = evaluateMedia(media, context);
      if (r === false) {
        mediaState = false;
        break;
      }
      if (r === null) mediaState = null;
    }
    if (mediaState === false) continue;
    for (const selector of rule.selectors) {
      if (selector.unsupported != null) {
        // Only an unsupported selector that mentions one of the element's
        // classes could plausibly match it.
        const classes = element.classes ?? [];
        if (classes.some((c) => selector.text.includes(`.${c}`))) {
          for (const d of rule.declarations) {
            unmeasured.push({
              property: d.property,
              reason: selector.unsupported,
            });
          }
        }
        continue;
      }
      if (!matchesSelector(selector, element, context)) continue;
      for (const d of rule.declarations) {
        if (mediaState === null) {
          unmeasured.push({
            property: d.property,
            reason: 'unknown media feature',
          });
          continue;
        }
        out.push({
          ...d,
          specificity: specificityOf(selector),
          order: rule.order,
          selector: selector.text,
        });
      }
    }
  }
  return { declarations: out, unmeasured };
}

function winners(declarations) {
  const byProperty = new Map();
  for (const d of declarations) {
    const prev = byProperty.get(d.property);
    if (
      prev == null ||
      (d.important && !prev.important) ||
      (d.important === prev.important &&
        (compareSpecificity(d.specificity, prev.specificity) > 0 ||
          (compareSpecificity(d.specificity, prev.specificity) === 0 &&
            d.order >= prev.order)))
    ) {
      byProperty.set(d.property, d);
    }
  }
  return byProperty;
}

function resolveVars(value, variables, depth = 0) {
  if (depth > 20) return { value, unresolved: ['cycle'] };
  const unresolved = [];
  const out = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
    (m, name, fallback) => {
      if (variables.has(name)) {
        const inner = resolveVars(variables.get(name), variables, depth + 1);
        unresolved.push(...inner.unresolved);
        return inner.value;
      }
      if (fallback != null) return fallback.trim();
      unresolved.push(name);
      return m;
    },
  );
  return { value: out, unresolved };
}

/**
 * Computes the cascaded declarations for `target`, given its ancestor chain
 * (outermost first, the last entry is the target). Each chain entry is
 * `{ tag, classes, attributes, isRoot }`.
 */
export function computeStyle(rules, chain, context = {}) {
  const variables = new Map();
  let targetResult = null;
  chain.forEach((element, index) => {
    const { declarations, unmeasured } = applicableDeclarations(
      rules,
      element,
      context,
    );
    const won = winners(declarations);
    for (const [property, d] of won) {
      if (property.startsWith('--')) variables.set(property, d.value);
    }
    if (index === chain.length - 1) targetResult = { won, unmeasured };
  });
  const properties = {};
  for (const [property, d] of targetResult.won) {
    if (property.startsWith('--')) continue;
    const resolved = resolveVars(d.value, variables);
    properties[property] = {
      declared: d.value,
      resolved: resolved.value,
      unresolvedVariables: resolved.unresolved,
      selector: d.selector,
    };
  }
  const unmeasuredProperties = {};
  for (const u of targetResult.unmeasured) {
    unmeasuredProperties[u.property] ??= u.reason;
  }
  return {
    properties,
    unmeasuredProperties,
    variables: Object.fromEntries(variables),
  };
}
