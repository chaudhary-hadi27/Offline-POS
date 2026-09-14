import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  base: './', // relative asset paths - required for Electron's file:// loading
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
