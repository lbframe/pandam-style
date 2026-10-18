import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pandamstyle } from '@pandamstyle/vite';

export default defineConfig({
  plugins: [
    react(),
    pandamstyle({
      definition: './pandamstyle/system.js',
      roots: ['./src'],
      outDir: './pandamstyle/generated',
    }),
  ],
});
