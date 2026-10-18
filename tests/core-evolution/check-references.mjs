/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Renders the authored CE-00.2 reference pages in Chromium and evaluates
// their layout, text, state, keyboard, accessibility and CSP assertions, plus
// the negative controls that can be applied to a reference page. It checks
// the reference outcomes only; it is not product qualification and never
// touches the compiler.
//
//   node tests/core-evolution/check-references.mjs \
//     --playwright <directory containing node_modules/playwright-core> \
//     [--report <file>]
//
// Playwright is untrusted tooling installed outside the repository, for
// example `npm install --ignore-scripts --save-exact playwright-core@1.60.0`
// in its own directory; its Chromium 148.0.7778.96 build must be installed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const CORPUS = 'tests/core-evolution/corpus/corpus.v1.json';
const ORACLES = 'tests/core-evolution/corpus/oracles.v1.json';
export const CHECKER = 'tests/core-evolution/check-references.mjs';
// A focus indicator must change at least this many pixels around the
// focused element (a text caret alone changes fewer).
export const INDICATOR_MIN_PIXELS = 40;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const TOLERANCE = 0.5;
const BROWSER_ORACLES = new Set([
  'ORC-LAYOUT',
  'ORC-TEXT',
  'ORC-STATE',
  'ORC-KEYBOARD',
  'ORC-A11Y',
  'ORC-CSP',
]);

// ---------------------------------------------------------------------------
// Static server: serves one fixture directory with the fixture CSP header and
// optional in-memory overrides (negative-control mutations).

export function serve(dir, csp, overrides) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(
      new URL(req.url, 'http://x').pathname,
    ).slice(1);
    const file = path.join(dir, name);
    if (!file.startsWith(dir) || (!overrides[name] && !fs.existsSync(file))) {
      res.writeHead(404).end();
      return;
    }
    const type = name.endsWith('.css')
      ? 'text/css'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html; charset=utf-8';
    res.writeHead(200, {
      'content-type': type,
      'content-security-policy': csp,
      'cache-control': 'no-store',
    });
    res.end(overrides[name] ?? fs.readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Mutations of a reference page (negative controls).

function mutate(postcss, files, mutation) {
  const out = {};
  const css = (name, change) => {
    const root = postcss.parse(files[name]);
    change(root);
    out[name] = root.toString();
  };
  const rule = (root) => {
    let found = null;
    root.walkRules((r) => {
      if (found == null && r.selector === mutation.selector) found = r;
    });
    return found;
  };
  switch (mutation.kind) {
    case 'remove-declaration':
      css(mutation.file, (root) =>
        rule(root)
          .nodes.filter((n) => n.prop === mutation.property)
          .forEach((n) => n.remove()),
      );
      return out;
    case 'replace-value':
      css(mutation.file, (root) =>
        rule(root)
          .nodes.filter((n) => n.prop === mutation.property)
          .forEach((n) => {
            n.value = mutation.value;
          }),
      );
      return out;
    case 'remove-rule':
      css(mutation.file, (root) => rule(root).remove());
      return out;
    case 'append-css':
      out[mutation.file] = `${files[mutation.file]}\n${mutation.css}\n`;
      return out;
    case 'set-attribute':
      out[mutation.file] = files[mutation.file].replace(
        new RegExp(`(data-testid="${mutation.target}")`),
        `$1 ${mutation.attribute}="${mutation.value}"`,
      );
      return out;
    case 'inject-style-element':
      out[mutation.file] = files[mutation.file].replace(
        '</head>',
        '<style>body { color: red; }</style>\n  </head>',
      );
      return out;
    default:
      return null; // not applicable to a reference page
  }
}

// ---------------------------------------------------------------------------
// In-page measurement helpers (serialized into the page).

const PAGE_HELPERS = `
window.__ce = {
  el(id) { return document.querySelector('[data-testid="' + id + '"]'); },
  rect(id) { const r = this.el(id).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom }; },
  lines(id) {
    const el = this.el(id); const range = document.createRange(); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const vertical = getComputedStyle(el).writingMode.startsWith('vertical');
    const keys = new Map();
    for (const r of rects) { const k = Math.round(vertical ? r.left : r.top); keys.set(k, Math.max(keys.get(k) || 0, vertical ? r.height : r.width)); }
    return [...keys.values()];
  },
  columns(id) {
    const el = this.el(id); const range = document.createRange(); range.selectNodeContents(el);
    // Line-start lefts of real text fragments (hyphen fragments excluded),
    // clustered; a column needs at least two lines.
    const lefts = [...range.getClientRects()].filter((r) => r.width > 20).map((r) => Math.round(r.left)).sort((a, b) => a - b);
    const clusters = []; for (const l of lefts) { const last = clusters[clusters.length - 1]; if (last && l - last.at <= 40) last.n += 1; else clusters.push({ at: l, n: 1 }); }
    return clusters.filter((c) => c.n >= 2).length;
  },
  // Every author line break must start a new line box.
  breaks(id) {
    const el = this.el(id); const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = [];
    const top = (node, i) => { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 1); const b = r.getBoundingClientRect(); return b.top; };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.data;
      for (let i = t.indexOf('\\n'); i >= 0; i = t.indexOf('\\n', i + 1)) {
        let k = i - 1; while (k >= 0 && /\\s/.test(t[k])) k--;
        let j = i + 1; while (j < t.length && /\\s/.test(t[j])) j++;
        if (k >= 0 && j < t.length) out.push(top(n, j) > top(n, k) + 1);
      }
    }
    return out;
  },
};`;

// ---------------------------------------------------------------------------

function near(actual, expected, tolerance = TOLERANCE) {
  return Math.abs(actual - expected) <= tolerance;
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const AX_ROLE = { img: 'image' };

// Minimal PNG decoder for Chromium screenshots (8-bit RGB or RGBA,
// non-interlaced): returns { width, height, channels, pixels }.
export function decodePng(buffer) {
  let offset = 8;
  let header = null;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR')
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        color: body[9],
        interlace: body[12],
      };
    else if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  if (
    header.depth !== 8 ||
    header.interlace !== 0 ||
    ![2, 6].includes(header.color)
  )
    throw new Error('unsupported PNG layout');
  const channels = header.color === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c =
        x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[y * stride + x] = v & 255;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

export function changedPixels(before, after) {
  const a = decodePng(before);
  const b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let changed = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    for (let k = 0; k < 3; k++) {
      if (
        Math.abs(a.pixels[i * a.channels + k] - b.pixels[i * b.channels + k]) >
        24
      ) {
        changed += 1;
        break;
      }
    }
  }
  return changed;
}

// Computed indicator styles of the focused element and, when it is visually
// hidden (a styled sibling carries its indicator), of its next sibling.
const INDICATOR_SNAPSHOT = `(() => {
  const el = window.__ceFocused;
  const r = el.getBoundingClientRect();
  const hidden = r.width <= 1 && r.height <= 1;
  const nodes = [el, ...(hidden && el.nextElementSibling ? [el.nextElementSibling] : [])];
  const box = nodes.map((n) => n.getBoundingClientRect()).reduce((u, b) => ({
    left: Math.min(u.left, b.left), top: Math.min(u.top, b.top),
    right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const style = (n) => { const s = getComputedStyle(n); return {
    outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow,
    border: ['Top', 'Right', 'Bottom', 'Left'].map((side) => s['border' + side + 'Style'] + ' ' + s['border' + side + 'Width'] + ' ' + s['border' + side + 'Color']).join('|') }; };
  const pad = 8;
  return { styles: nodes.map(style),
    clip: { x: Math.max(0, box.left - pad), y: Math.max(0, box.top - pad),
      width: Math.min(document.documentElement.clientWidth, box.right + pad) - Math.max(0, box.left - pad),
      height: Math.min(document.documentElement.clientHeight, box.bottom + pad) - Math.max(0, box.top - pad) } };
})()`;

// A painted indicator: a non-none outline of non-zero width, a box shadow, or
// a changed non-zero border on the focused element (or its styled sibling),
// and at least INDICATOR_MIN_PIXELS changed pixels against the unfocused page.
async function paintedIndicator(page) {
  await page.evaluate(() => {
    window.__ceFocused = document.activeElement;
  });
  const focused = await page.evaluate(INDICATOR_SNAPSHOT);
  const clip = focused.clip;
  const shotFocused = await page.screenshot({
    clip,
    animations: 'disabled',
    caret: 'hide',
  });
  await page.evaluate(() => window.__ceFocused.blur());
  const unfocused = await page.evaluate(INDICATOR_SNAPSHOT);
  const shotUnfocused = await page.screenshot({
    clip,
    animations: 'disabled',
    caret: 'hide',
  });
  await page.evaluate(() => window.__ceFocused.focus());
  const styled = focused.styles.some((f, i) => {
    const u = unfocused.styles[i];
    const outline = f.outlineStyle !== 'none' && parseFloat(f.outlineWidth) > 0;
    const shadow = f.boxShadow !== 'none' && f.boxShadow !== u.boxShadow;
    const border = f.border !== u.border && !/^none 0px/.test(f.border);
    return outline || shadow || border;
  });
  const pixels = changedPixels(shotFocused, shotUnfocused);
  return {
    ok: styled && pixels >= INDICATOR_MIN_PIXELS,
    styled,
    changedPixels: pixels,
    outline: focused.styles.map((x) => `${x.outlineStyle} ${x.outlineWidth}`),
  };
}

export async function evaluateAssertion(ctx, a) {
  const { page, cdp } = ctx;
  const expect = a.expect;
  const results = [];
  const record = (kind, ok, measured, note) =>
    results.push({ kind, ok, measured, ...(note ? { note } : {}) });
  for (const [kind, want] of Object.entries(expect)) {
    if (kind === 'on' || kind === 'pseudoElement') continue;
    switch (kind) {
      case 'box':
      case 'minBox':
      case 'maxBox': {
        const r = await page.evaluate((id) => __ce.rect(id), a.target);
        const ok = Object.entries(want).every(([dim, v]) =>
          kind === 'box'
            ? near(r[dim], v)
            : kind === 'minBox'
              ? r[dim] >= v - TOLERANCE
              : r[dim] <= v + TOLERANCE,
        );
        record(kind, ok, { width: r.width, height: r.height });
        break;
      }
      case 'noHorizontalOverflow': {
        const m = await page.evaluate((id) => {
          const e = __ce.el(id);
          return { scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
        }, a.target);
        record(kind, m.scrollWidth <= m.clientWidth + 1, m);
        break;
      }
      case 'scrollable': {
        const m = await page.evaluate((id) => {
          const e = __ce.el(id);
          const s = getComputedStyle(e);
          return {
            x: e.scrollWidth > e.clientWidth && /auto|scroll/.test(s.overflowX),
            y:
              e.scrollHeight > e.clientHeight &&
              /auto|scroll/.test(s.overflowY),
          };
        }, a.target);
        const ok = want === 'both' ? m.x && m.y : m[want];
        record(kind, ok, m);
        break;
      }
      case 'stuckAfterScroll': {
        const m = await page.evaluate(
          ({ id, w }) => {
            const c = __ce.el(w.container);
            if (w.axis === 'x') c.scrollLeft = w.offset;
            else c.scrollTop = w.offset;
            const cr = c.getBoundingClientRect();
            const t = __ce.el(id).getBoundingClientRect();
            return {
              scrolled: w.axis === 'x' ? c.scrollLeft : c.scrollTop,
              offset:
                w.edge === 'left'
                  ? t.left - cr.left - c.clientLeft
                  : t.top - cr.top - c.clientTop,
            };
          },
          { id: a.target, w: want },
        );
        record(kind, m.scrolled > 0 && near(m.offset, want.value), m);
        break;
      }
      case 'fixedToViewport': {
        const m = await page.evaluate((id) => {
          const r = __ce.el(id).getBoundingClientRect();
          return {
            right: document.documentElement.clientWidth - r.right,
            bottom: document.documentElement.clientHeight - r.bottom,
          };
        }, a.target);
        record(
          kind,
          near(m.right, want.right) && near(m.bottom, want.bottom),
          m,
        );
        break;
      }
      case 'topmostAt': {
        const m = await page.evaluate(
          ({ id, w }) => {
            const c = __ce.el(w.container);
            c.scrollLeft = w.scrollX;
            c.scrollTop = w.scrollY;
            const t = __ce.el(id);
            const r = t.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return {
              hit: t.contains(hit),
              scrolled: [c.scrollLeft, c.scrollTop],
            };
          },
          { id: a.target, w: want },
        );
        record(kind, m.hit, m);
        break;
      }
      case 'columns': {
        const n = await page.evaluate((id) => __ce.columns(id), a.target);
        record(kind, n === want, n);
        break;
      }
      case 'edgeOffset': {
        const m = await page.evaluate(
          ({ id, w }) => {
            const t = __ce.el(id).getBoundingClientRect();
            const o = __ce.el(w.of).getBoundingClientRect();
            return w.edge === 'left'
              ? t.left - o.left
              : w.edge === 'right'
                ? o.right - t.right
                : w.edge === 'top'
                  ? t.top - o.top
                  : o.bottom - t.bottom;
          },
          { id: a.target, w: want },
        );
        record(kind, near(m, want.value), m);
        break;
      }
      case 'lineCount': {
        const lines = await page.evaluate((id) => __ce.lines(id), a.target);
        const ok =
          typeof want === 'number'
            ? lines.length === want
            : lines.length >= want.min;
        record(kind, ok, lines.length);
        break;
      }
      case 'preservesBreaks': {
        const lines = await page.evaluate((id) => __ce.lines(id), a.target);
        const breaks = await page.evaluate((id) => __ce.breaks(id), a.target);
        record(
          kind,
          lines.length >= want.minLines &&
            breaks.length > 0 &&
            breaks.every(Boolean),
          { lines: lines.length, authorBreaksHonored: breaks },
        );
        break;
      }
      case 'balancedLines': {
        const lines = await page.evaluate((id) => __ce.lines(id), a.target);
        const ratio =
          lines.length > 1 ? Math.min(...lines) / Math.max(...lines) : 1;
        record(
          kind,
          lines.length > 1 && ratio >= 0.6,
          { lines: lines.length, ratio: Number(ratio.toFixed(3)) },
          'balanced: the shortest line is at least 60% of the longest',
        );
        break;
      }
      case 'truncated': {
        const m = await page.evaluate((id) => {
          const e = __ce.el(id);
          return {
            overflow: e.scrollWidth > e.clientWidth,
            textOverflow: getComputedStyle(e).textOverflow,
          };
        }, a.target);
        record(kind, m.overflow === want && m.textOverflow === 'ellipsis', m);
        break;
      }
      case 'noOverflow': {
        const m = await page.evaluate((id) => {
          const e = __ce.el(id);
          const r = e.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(e);
          const rects = [...range.getClientRects()];
          return {
            scrollWidth: e.scrollWidth,
            clientWidth: e.clientWidth,
            textRight: Math.max(...rects.map((x) => x.right)),
            right: r.right,
          };
        }, a.target);
        record(
          kind,
          m.scrollWidth <= m.clientWidth + 1 && m.textRight <= m.right + 1,
          m,
        );
        break;
      }
      case 'writingMode':
      case 'direction': {
        const prop = kind === 'writingMode' ? 'writingMode' : 'direction';
        const v = await page.evaluate(
          ({ id, prop }) => getComputedStyle(__ce.el(id))[prop],
          { id: a.target, prop },
        );
        record(kind, v === want, v);
        break;
      }
      case 'computed': {
        const m = await page.evaluate(
          ({ id, props, on, pseudo }) => {
            const t = __ce.el(id);
            const els =
              on === 'cells' ? [...t.querySelectorAll('td, th')] : [t];
            return els.map((e) =>
              Object.fromEntries(
                props.map((p) => [
                  p,
                  getComputedStyle(e, pseudo || null).getPropertyValue(p),
                ]),
              ),
            );
          },
          {
            id: a.target,
            props: Object.keys(want),
            on: expect.on,
            pseudo: expect.pseudoElement,
          },
        );
        const ok = m.every((values) =>
          Object.entries(want).every(([p, v]) => values[p] === v),
        );
        record(kind, ok, m.length === 1 ? m[0] : m[0]);
        break;
      }
      case 'animationNone': {
        const names = await page.evaluate(
          ({ id, desc }) => {
            const t = __ce.el(id);
            return (desc ? [...t.querySelectorAll('*')] : [t]).map(
              (e) => getComputedStyle(e).animationName,
            );
          },
          { id: a.target, desc: want === 'descendants' },
        );
        record(
          kind,
          names.length > 0 && names.every((n) => n === 'none'),
          names,
        );
        break;
      }
      case 'computedUnchanged':
      case 'sameBoxAsReference':
        record(
          kind,
          null,
          null,
          'not applicable to the reference page itself: it compares a build with this reference',
        );
        break;
      case 'focusOrder': {
        const order = [];
        const visible = [];
        await page.evaluate(
          () => document.activeElement && document.activeElement.blur(),
        );
        const painted = [];
        for (let i = 0; i < want.length; i++) {
          await page.keyboard.press('Tab');
          const m = await page.evaluate(() => ({
            id:
              document.activeElement?.getAttribute('data-testid') ??
              document.activeElement?.tagName,
            fv: document.activeElement?.matches(':focus-visible'),
          }));
          order.push(m.id);
          visible.push(m.fv);
          if (expect.focusVisible && m.id !== 'BODY')
            painted.push(await paintedIndicator(page));
        }
        record(kind, JSON.stringify(order) === JSON.stringify(want), order);
        if (expect.focusVisible) {
          record('focusVisible', visible.every(Boolean), visible);
          record(
            'paintedIndicator',
            painted.length === want.length && painted.every((p) => p.ok),
            painted,
            `computed outline, shadow or border change and at least ${INDICATOR_MIN_PIXELS} changed pixels at every stop`,
          );
        }
        break;
      }
      case 'focusVisible':
        if (!('focusOrder' in expect))
          record(kind, null, null, 'evaluated with focusOrder');
        break;
      case 'activates': {
        await page.focus(`[data-testid="${want.target}"]`);
        for (const key of want.keys) await page.keyboard.press(key);
        const m = await page.evaluate(
          ({ w }) => ({
            checked: __ce.el(w.target).checked,
            computed: Object.fromEntries(
              Object.keys(w.then.computed).map((p) => [
                p,
                getComputedStyle(__ce.el(w.then.computedOn)).getPropertyValue(
                  p,
                ),
              ]),
            ),
          }),
          { w: want },
        );
        const ok =
          m.checked === want.then.checked &&
          Object.entries(want.then.computed).every(
            ([p, v]) => m.computed[p] === v,
          );
        record(
          kind,
          ok,
          m,
          'focus is moved with element.focus(); the key press itself goes through the keyboard pipeline',
        );
        break;
      }
      case 'scrollsWithKeys': {
        await page.evaluate(
          () => document.activeElement && document.activeElement.blur(),
        );
        let focused = null;
        for (let i = 0; i < 10 && focused !== want.target; i++) {
          await page.keyboard.press('Tab');
          focused = await page.evaluate(() =>
            document.activeElement?.getAttribute('data-testid'),
          );
        }
        const before = await page.evaluate(
          (id) => [__ce.el(id).scrollLeft, __ce.el(id).scrollTop],
          want.target,
        );
        for (const key of want.keys) await page.keyboard.press(key);
        await page.waitForTimeout(300);
        const after = await page.evaluate(
          (id) => [__ce.el(id).scrollLeft, __ce.el(id).scrollTop],
          want.target,
        );
        record(
          kind,
          focused === want.target &&
            after[0] > before[0] &&
            after[1] > before[1],
          { focused, before, after },
        );
        break;
      }
      case 'role':
      case 'name': {
        const ax = await axNode(cdp, a.target);
        const actual = kind === 'role' ? ax.role : ax.name;
        const expected = kind === 'role' ? (AX_ROLE[want] ?? want) : want;
        record(kind, actual === expected, actual);
        break;
      }
      case 'contrastMin': {
        const m = await page.evaluate((id) => {
          const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
          const e = __ce.el(id);
          const fg = parse(getComputedStyle(e).color);
          let bg = null;
          let image = false;
          for (let n = e; n && !bg; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (s.backgroundImage !== 'none') image = true;
            const c = parse(s.backgroundColor);
            if (c.length === 3 || (c.length === 4 && c[3] > 0))
              bg = c.slice(0, 3);
          }
          return { fg: fg.slice(0, 3), bg: bg || [255, 255, 255], image };
        }, a.target);
        const l1 = luminance(m.fg);
        const l2 = luminance(m.bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        record(kind, ratio >= want && !m.image, {
          ratio: Number(ratio.toFixed(2)),
          ...m,
        });
        break;
      }
      case 'targetSizeMin': {
        const r = await page.evaluate((id) => __ce.rect(id), a.target);
        record(
          kind,
          r.width >= want - TOLERANCE && r.height >= want - TOLERANCE,
          { width: r.width, height: r.height },
        );
        break;
      }
      case 'visuallyHiddenButExposed': {
        const r = await page.evaluate((id) => __ce.rect(id), a.target);
        const ax = await axNode(cdp, a.target);
        record(kind, r.width <= 1 && r.height <= 1 && !ax.ignored, {
          width: r.width,
          height: r.height,
          ignored: ax.ignored,
        });
        break;
      }
      case 'forcedColorsVisible':
        record(
          kind,
          null,
          null,
          'not evaluated: needs a pixel comparison of the forced-colors rendering',
        );
        break;
      case 'violations':
        record(
          kind,
          ctx.violations.length === want,
          ctx.violations.slice(0, 3),
        );
        break;
      case 'styleElements':
      case 'styleAttributes':
      case 'runtimeStyleInsertions':
      case 'inlineCustomProperties': {
        const m = await page.evaluate(() => ({
          styleElements: document.querySelectorAll('style').length,
          styleAttributes: document.querySelectorAll('[style]').length,
          runtimeStyleInsertions:
            [...document.styleSheets].filter((s) => !s.href).length +
            document.adoptedStyleSheets.length,
          inlineCustomProperties: [
            ...document.querySelectorAll('[style]'),
          ].filter((e) => e.getAttribute('style').includes('--')).length,
        }));
        record(kind, m[kind] === want, m[kind]);
        break;
      }
      case 'completeFirstPaint': {
        const m = await page.evaluate(() => ({
          links: document.querySelectorAll('link[rel=stylesheet]').length,
          loaded: [...document.styleSheets].filter(
            (s) => s.href && s.cssRules.length > 0,
          ).length,
          scripts: document.scripts.length,
        }));
        record(
          kind,
          m.links > 0 && m.loaded === m.links && m.scripts === 0,
          m,
          'the reference page has no scripts; every linked stylesheet is applied',
        );
        break;
      }
      default:
        record(kind, false, null, 'unknown assertion kind');
    }
  }
  return results;
}

async function axNode(cdp, id) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: `[data-testid="${id}"]`,
  });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', {
    nodeId,
    fetchRelatives: false,
  });
  const node = nodes[0];
  return {
    role: node?.role?.value,
    name: node?.name?.value,
    ignored: node?.ignored ?? true,
  };
}

// Opens the page holding the assertion's targets in the assertion's state.
export async function openState(browser, origin, fixture, a, page) {
  const viewport =
    fixture.viewports.find((v) => v.id === a.viewport) ?? fixture.viewports[0];
  const state = a.state ?? 'rest';
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: state === 'touch',
    javaScriptEnabled: true,
  });
  const p = await context.newPage();
  const cdp = await context.newCDPSession(p);
  const violations = [];
  p.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text()))
      violations.push(m.text().split(origin).join('<origin>').slice(0, 200));
  });
  const media = {};
  if (state === 'high-contrast') media.forcedColors = 'active';
  if (state === 'reduced-motion') media.reducedMotion = 'reduce';
  if (state === 'print') media.media = 'print';
  await p.emulateMedia(media);
  if (state === 'increased-contrast')
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-contrast', value: 'more' }],
    });
  await p.goto(`${origin}/${page}`);
  // Helpers are installed through the DevTools protocol, which the page CSP
  // does not govern, so they cause no violation.
  await p.evaluate(PAGE_HELPERS);
  await p.evaluate(() => document.fonts.ready);
  if (a.target && ['pointer-hover', 'pointer-active'].includes(state)) {
    await p.hover(`[data-testid="${a.target}"]`, { force: true });
    if (state === 'pointer-active') await p.mouse.down();
  }
  if (a.target && state === 'touch' && a.oracle === 'ORC-STATE')
    await p.tap(`[data-testid="${a.target}"]`, { force: true });
  if (a.target && state === 'keyboard-focus' && a.oracle !== 'ORC-KEYBOARD') {
    for (let i = 0; i < 40; i++) {
      await p.keyboard.press('Tab');
      if (
        await p.evaluate(
          (id) => document.activeElement?.getAttribute('data-testid') === id,
          a.target,
        )
      )
        break;
    }
  }
  await p.waitForTimeout(
    state === 'pointer-hover' || state === 'touch' ? 250 : 50,
  );
  return { context, page: p, cdp, violations };
}

function pageFor(fixture, a, pages) {
  const ids = [
    a.target,
    ...Object.values(a.expect ?? {}).flatMap((v) =>
      Array.isArray(v) ? v : typeof v === 'object' && v ? Object.values(v) : [],
    ),
  ].filter((x) => typeof x === 'string');
  return (
    pages.find((p) =>
      ids.some((id) => p.text.includes(`data-testid="${id}"`)),
    ) ?? pages[0]
  ).name;
}

/** Row status from its results; the validator recomputes it. */
export function rowStatus(assertionCase, results) {
  const evaluated = results.filter((r) => r.ok !== null);
  if (evaluated.length === 0) return 'not-evaluated';
  const allPass = evaluated.every((r) => r.ok === true);
  if (assertionCase === 'negative') return allPass ? 'fail' : 'pass';
  return allPass ? 'pass' : 'fail';
}

// Canonical JSON: sorted keys at every depth.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Digest of everything one row verifies: the assertion (and, for a negative
 * control, the assertion it must fail), the fixture's viewports, states, CSP
 * and pinned inputs.
 */
export function assertionDigest(fixture, a) {
  const target =
    a.case === 'negative'
      ? fixture.assertions.find((x) => x.id === a.mustFail)
      : null;
  return sha256(
    canonical({
      fixture: fixture.id,
      assertion: a,
      target,
      viewports: fixture.viewports,
      states: fixture.states,
      csp: fixture.csp,
      inputs: fixture.inputs,
    }),
  );
}

/** Binding of a whole report to its verification inputs. */
export function computeBinding({ corpus, oracles, checkerSource, engine }) {
  const browserOracles = oracles.oracles.filter((o) =>
    BROWSER_ORACLES.has(o.id),
  );
  const parts = {
    fixtures: Object.fromEntries(
      corpus.fixtures.map((f) => [
        f.id,
        sha256(
          canonical({
            assertions: f.assertions.filter((a) =>
              BROWSER_ORACLES.has(a.oracle),
            ),
            viewports: f.viewports,
            states: f.states,
            csp: f.csp,
            inputs: f.inputs,
          }),
        ),
      ]),
    ),
    oracles: sha256(
      canonical({
        oracles: browserOracles,
        states: oracles.states,
        requiredInteractionStates: oracles.requiredInteractionStates,
      }),
    ),
    checker: sha256(checkerSource),
    engine,
  };
  return { ...parts, verificationSha256: sha256(canonical(parts)) };
}

export function loadBindingInputs() {
  return {
    corpus: JSON.parse(fs.readFileSync(path.join(repo, CORPUS), 'utf8')),
    oracles: JSON.parse(fs.readFileSync(path.join(repo, ORACLES), 'utf8')),
    checkerSource: fs.readFileSync(path.join(repo, CHECKER)),
  };
}

async function checkFixture(browser, postcss, fixture) {
  const dir = path.join(repo, path.dirname(fixture.inputs[0].path));
  const files = Object.fromEntries(
    fixture.inputs.map((i) => [
      path.basename(i.path),
      fs.readFileSync(path.join(repo, i.path), 'utf8'),
    ]),
  );
  const pages = fixture.inputs
    .filter((i) => i.role === 'reference-page')
    .map((i) => ({
      name: path.basename(i.path),
      text: files[path.basename(i.path)],
    }));
  const rows = [];
  const byId = new Map(fixture.assertions.map((a) => [a.id, a]));
  for (const a of fixture.assertions) {
    if (!BROWSER_ORACLES.has(a.oracle)) continue;
    let target = a;
    let overrides = {};
    if (a.case === 'negative') {
      target = byId.get(a.mustFail);
      overrides = mutate(postcss, files, a.mutation);
      if (overrides == null) {
        rows.push({
          id: a.id,
          fixture: fixture.id,
          oracle: a.oracle,
          case: a.case,
          assertionSha256: assertionDigest(fixture, a),
          status: 'not-evaluated',
          results: [
            {
              kind: 'mutation',
              ok: null,
              measured: null,
              note: `mutation ${a.mutation.kind} needs a build`,
            },
          ],
        });
        continue;
      }
    }
    const { server, origin } = await serve(dir, fixture.csp, overrides);
    const page = pageFor(fixture, target, pages);
    const session = await openState(browser, origin, fixture, target, page);
    let results;
    try {
      results = await evaluateAssertion(session, target);
    } catch (error) {
      results = [
        { kind: 'error', ok: false, measured: error.message.split('\n')[0] },
      ];
    }
    await session.context.close();
    server.close();
    const status = rowStatus(a.case, results);
    rows.push({
      id: a.id,
      fixture: fixture.id,
      oracle: a.oracle,
      case: a.case,
      page,
      state: target.state ?? 'rest',
      viewport: target.viewport,
      assertionSha256: assertionDigest(fixture, a),
      status,
      ...(a.case === 'negative'
        ? { mutation: a.mutation.kind, mustFail: a.mustFail }
        : {}),
      results,
    });
  }
  return rows;
}

async function main() {
  const index = process.argv.indexOf('--playwright');
  if (index < 0) {
    console.error(
      'Usage: check-references.mjs --playwright <dir> [--report <file>]',
    );
    process.exit(2);
  }
  const requireFrom = createRequire(
    path.join(path.resolve(process.argv[index + 1]), 'package.json'),
  );
  const { chromium } = requireFrom('playwright-core');
  const playwrightVersion = requireFrom('playwright-core/package.json').version;
  const postcss = createRequire(import.meta.url)('postcss');
  const corpus = JSON.parse(fs.readFileSync(path.join(repo, CORPUS), 'utf8'));
  const browser = await chromium.launch();
  const engine = {
    browser: 'chromium',
    version: browser.version(),
    playwrightCore: playwrightVersion,
  };
  const rows = [];
  try {
    for (const fixture of corpus.fixtures) {
      for (const row of await checkFixture(browser, postcss, fixture)) {
        rows.push(row);
        console.log(
          `${row.status.padEnd(14)} ${fixture.id} ${row.id} ${row.oracle} ${row.case}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  const tally = {};
  for (const r of rows) tally[r.status] = (tally[r.status] ?? 0) + 1;
  const report = {
    schemaVersion: 1,
    kind: 'core-evolution-reference-check',
    task: 'CE-00.2',
    statement:
      'Reference pages only: the authored outcomes rendered in Chromium. Not compiler, build or product qualification.',
    engine,
    binding: computeBinding({ ...loadBindingInputs(), engine }),
    inputs: Object.fromEntries(
      corpus.fixtures
        .flatMap((f) => f.inputs)
        .map((i) => [i.path, sha256(fs.readFileSync(path.join(repo, i.path)))]),
    ),
    tally,
    rows,
  };
  const out = process.argv.indexOf('--report');
  if (out > 0)
    fs.writeFileSync(
      process.argv[out + 1],
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log(JSON.stringify(tally));
  if (tally.fail) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
