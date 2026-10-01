/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/compiler/vite';

/**
 * Pilot build configuration.
 *
 * The PandamStyle plugin is the only style transform in this pipeline: it
 * compiles the covered roots with the fork's engine and injects the static CSS
 * it collected. No upstream StyleX plugin is involved.
 */
export default defineConfig({
  plugins: [
    react(),
    pandamstyle({
      designSystem: './design.pandamstyle.config.js',
      roots: ['./src/pages'],
      outDir: './.pandamstyle',
      role: 'page',
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
