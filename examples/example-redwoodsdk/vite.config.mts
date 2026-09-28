/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 *
 */

import { defineConfig } from 'vite';
import { redwood } from 'rwsdk/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import stylex from '@stylexjs/unplugin';

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'worker' },
    }),
    redwood(),
    // @ts-ignore
    stylex.vite({
      // Keep transforms on in dev, but only expose the CSS endpoint (no runtime/HTML injection)
      devMode: 'css-only',
      devPersistToDisk: true,
      dev: process.env.NODE_ENV === 'development',
      runtimeInjection: false,
    }),
  ],
});
