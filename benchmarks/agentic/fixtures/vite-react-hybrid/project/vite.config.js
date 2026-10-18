import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/vite';

export default defineConfig({
  plugins: [
    pandamstyle({
      definition: './design/system.mjs',
      roots: ['./src/ui'],
      outDir: './.pandamstyle',
    }),
    react(),
  ],
});
