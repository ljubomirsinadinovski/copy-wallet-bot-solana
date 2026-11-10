import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The manual trading page. It imports the main app's components and styles from ../../web/src.
const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5174,
    host: '127.0.0.1',
    fs: { allow: [repo] },
    proxy: { '/api': `http://127.0.0.1:${process.env.MANUAL_PORT ?? 8790}` },
  },
});
