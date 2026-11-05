import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: 'src/client',
  plugins: [preact()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    host: true,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:4000', ws: true },
    },
  },
});
