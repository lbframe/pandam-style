/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { qualifyStart } from './qualify-rsbuild-start.mjs';

async function main() {
  const report = { node: process.version, start: {}, events: [] };
  const hash = (text) => createHash('sha256').update(text).digest('hex');
  const browser = await chromium.launch({
    executablePath: process.env.PMS_CHROMIUM ?? '/opt/google/chrome/chrome',
    headless: true,
    chromiumSandbox: true,
  });
  try {
    await qualifyStart({
      base: path.join(process.cwd(), 'node22-boundary'),
      browser,
      report,
      async until(predicate, label) {
        const started = performance.now();
        while (performance.now() - started < 20000) {
          try {
            if (await predicate()) return;
          } catch (error) {
            if (
              !/Execution context was destroyed|Cannot find context with specified id/.test(
                error.message,
              )
            )
              throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        throw new Error(`Timed out: ${label}`);
      },
      async canonical(root) {
        const files = {};
        for (const name of [
          'design.pandamstyle.js',
          'design.pandamstyle.d.ts',
          'styles.css',
          'manifest.json',
          'artifacts.json',
        ])
          files[name] = await fs.readFile(
            path.join(root, '.pandamstyle', name),
            'utf8',
          );
        for (const record of Object.values(
          JSON.parse(files['artifacts.json']).artifacts,
        ))
          assert.equal(hash(files[record.file]), record.sha256);
        return {
          files,
          digest: hash(JSON.stringify(files)),
          cssDigest: hash(files['styles.css']),
        };
      },
    });
    assert.equal(report.start.dev.pass, true);
    assert.equal(report.start.production.pass, true);
  } finally {
    await browser.close();
    await fs.writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
