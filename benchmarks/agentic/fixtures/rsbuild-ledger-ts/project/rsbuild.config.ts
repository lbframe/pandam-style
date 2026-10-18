import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pandamstyle } from '@pandamstyle/rsbuild';

export default defineConfig({
  plugins: [
    pluginReact(),
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src'],
      outDir: './.pandamstyle',
    }),
  ],
  html: { title: 'Ledger' },
});
