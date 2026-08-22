import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const SERVER = process.env.SERVER_ORIGIN ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the workspace package straight to source so Vite compiles the
      // shared types with the app rather than trying to pre-bundle raw TS.
      '@receipts/shared': fileURLToPath(
        new URL('../shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // Keeps API keys server-side and lets EventSource use a same-origin URL.
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
    },
  },
});
