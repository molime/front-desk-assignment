import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Friendly one-liner instead of a stack trace when the backend isn't up yet.
const quietProxyError = (proxy) =>
  proxy.on('error', () =>
    console.log('[vite] backend unreachable on :8080 — start it with "npm run dev" from the repo root (it runs both).'));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', configure: quietProxyError },
      '/ws': { target: 'ws://localhost:8080', ws: true, configure: quietProxyError },
    },
  },
});
