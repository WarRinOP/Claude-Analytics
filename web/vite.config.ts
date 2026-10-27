// Dashboard build. Output goes to web/dist, which the Node server serves. Dev server proxies /api to the ledger service.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = 'http://127.0.0.1:47821';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The server's CSP is default-src 'self': fonts and images must be files, never data: URIs.
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // changeOrigin sets the Host header to the target's, which the ledger service requires.
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  preview: { host: '127.0.0.1', port: 4173 },
});
