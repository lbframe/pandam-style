/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
'use strict';
// TEST ONLY browser transport. It consumes the actual compiled artifact bytes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');
const React = require('react');
const { renderToString } = require('react-dom/server');

function observeBrowser(root, out, spec, exports, css) {
  const browser = spec.observe.browser;
  const parity = browser.hydration === true;
  // Snap Chromium has a private /tmp. A visible, isolated home directory keeps
  // the browser sandbox enabled and lets it read its own test input.
  const scratch = fs.mkdtempSync(
    path.join(os.homedir(), 'pms-oracle-browser-'),
  );
  const htmlPath = path.join(scratch, 'oracle-browser.html');
  let markup;
  let script;
  if (parity) {
    markup = renderToString(React.createElement(exports.App));
    // The generated artifact preserves source-relative facade requests. This
    // test-only loader relocation is also used by the Node evaluator.
    fs.mkdirSync(path.join(out, 'js'), { recursive: true });
    const generatedLink = path.join(out, 'js/generated');
    if (!fs.existsSync(generatedLink))
      fs.symlinkSync(out, generatedLink, 'dir');
    const entry = path.join(out, 'js', spec.observe.runtime.file);
    const bundle = esbuild.buildSync({
      stdin: {
        contents: `import React from 'react';import {hydrateRoot} from 'react-dom/client';import {App} from ${JSON.stringify(entry)};const errors=[];hydrateRoot(document.getElementById('mount'),React.createElement(App),{onRecoverableError:e=>errors.push(e.message)});window.__oracleErrors=errors;`,
        resolveDir: path.resolve(__dirname, '../../..'),
      },
      nodePaths: [path.resolve(__dirname, '../../../node_modules')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    script = bundle.outputFiles[0].text;
  } else {
    const classes = exports.result.className ?? '';
    markup = `<div id="probe" class="${classes}"></div>`;
    script = '';
  }
  const probe = parity
    ? 'document.querySelector("[data-probe]")'
    : 'document.getElementById("probe")';
  const read = `setTimeout(()=>{const el=${probe};const style=getComputedStyle(el);const values=Object.fromEntries(${JSON.stringify(browser.properties)}.map(p=>[p,style.getPropertyValue(p)]));document.title='PMS_RESULT_'+btoa(JSON.stringify({values,hydrationErrors:window.__oracleErrors??[],className:el.className}));},250);`;
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><style>${css}</style></head><body><div id="mount">${markup}</div><script>${script.replaceAll('</script', '<\\/script')}${read}</script></body></html>`,
  );
  const child = spawnSync(
    process.env.PMS_CHROMIUM ?? 'chromium',
    [
      '--headless',
      '--disable-gpu',
      '--window-size=1280,800',
      '--virtual-time-budget=1500',
      `--user-data-dir=${path.join(scratch, 'browser-profile')}`,
      '--dump-dom',
      'file://' + htmlPath,
    ],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 * 8 },
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  if (child.status !== 0)
    throw new Error(
      'Semantic browser execution failed: ' + child.stderr.slice(-1200),
    );
  const encoded = child.stdout.match(
    /<title>PMS_RESULT_([A-Za-z0-9+/=]+)<\/title>/,
  )?.[1];
  if (!encoded)
    throw new Error(
      'Semantic browser produced no result: ' + child.stderr.slice(-1200),
    );
  const result = JSON.parse(Buffer.from(encoded, 'base64').toString());
  return {
    values: result.values,
    hydrationErrors: result.hydrationErrors,
    ssrClassMatchesBrowser: parity
      ? markup.includes(`class="${result.className}"`)
      : null,
  };
}
module.exports = { observeBrowser };
