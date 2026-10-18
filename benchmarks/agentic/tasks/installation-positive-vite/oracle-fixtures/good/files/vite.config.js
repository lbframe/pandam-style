import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/vite';

export default defineConfig({
  plugins: [
    react(),
    pandamstyle({
      definition: './design.pandamstyle.config.js',
      roots: ['./src/pandamstyle'],
      outDir: './.pandamstyle',
    }),
  ],
  server: { port: 5173 },
});
