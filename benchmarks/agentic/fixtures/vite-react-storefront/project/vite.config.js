import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/vite';

export default defineConfig({
  plugins: [
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src'],
      outDir: './.pandamstyle',
    }),
    react(),
  ],
});
