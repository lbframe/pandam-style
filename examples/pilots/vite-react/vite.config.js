/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/vite';

/**
 * Pilot build configuration.
 *
 * The PandamStyle plugin is the only style transform in this pipeline: it
 * compiles the covered roots with the fork's engine and injects the static CSS
 * it collected. No upstream StyleX plugin is involved.
 */
export default defineConfig({
  plugins: [
    {
      name: 'pandamstyle-pilot-transform-delay',
      enforce: 'pre',
      async transform(_code, id) {
        if (
          process.env.PMS_VITE_DELAY_APP_TRANSFORM === '1' &&
          id.split('?')[0].endsWith('/src/pages/App.jsx')
        ) {
          globalThis.__PMS_VITE_DELAY_APP_TRANSFORM_ENTERED__ = true;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      },
    },
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src'],
      outDir: './.pandamstyle',
    }),
    react(),
    {
      name: 'pandamstyle-pilot-failure-injection',
      enforce: 'post',
      transform(_code, id) {
        if (
          process.env.PMS_VITE_FAIL_AT === 'transform' &&
          id.endsWith('/src/pages/App.jsx')
        ) {
          throw new Error('PMS_INJECTED_TRANSFORM_FAILURE');
        }
      },
      renderStart() {
        if (process.env.PMS_VITE_FAIL_AT === 'renderStart') {
          throw new Error('PMS_INJECTED_RENDERSTART_FAILURE');
        }
      },
      generateBundle() {
        if (process.env.PMS_VITE_FAIL_AT === 'generateBundle') {
          throw new Error('PMS_INJECTED_GENERATEBUNDLE_FAILURE');
        }
      },
      writeBundle: {
        order: 'pre',
        handler() {
          if (process.env.PMS_VITE_FAIL_AT === 'writeBundle') {
            throw new Error('PMS_INJECTED_WRITEBUNDLE_FAILURE');
          }
        },
      },
      closeServer({ reason }) {
        globalThis.__PMS_VITE_CLOSE_SERVER_REASONS__ ??= [];
        globalThis.__PMS_VITE_CLOSE_SERVER_REASONS__.push(reason);
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    write: process.env.PMS_VITE_WRITE_FALSE !== '1',
    ...(process.env.PMS_VITE_MULTI_OUTPUT === '1'
      ? { rolldownOptions: { output: [{ format: 'es' }, { format: 'cjs' }] } }
      : {}),
  },
});
