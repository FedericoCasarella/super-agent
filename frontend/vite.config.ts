import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Throttle proxy-error logs so a backend restart doesn't spam the dev console.
// Browser-side WS auto-reconnects with backoff (see frontend/src/ws.ts) — the
// proxy errors are just transient noise during that window.
let lastApiLog = 0;
let lastWsLog = 0;
const LOG_EVERY_MS = 15_000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err: any, _req: any, res: any) => {
            const now = Date.now();
            if (now - lastApiLog > LOG_EVERY_MS) {
              lastApiLog = now;
              console.warn(`[vite] api proxy down (${err?.code ?? err?.message}) — backend not reachable on :8787`);
            }
            // Reply with a JSON 503 so the FE fetch resolves instead of hanging
            // until proxy timeout. Suppresses cryptic "fetch failed" toasts.
            try {
              if (res && !res.headersSent) {
                res.writeHead(503, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'backend_unreachable' }));
              }
            } catch {}
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err: any) => {
            const now = Date.now();
            if (now - lastWsLog > LOG_EVERY_MS) {
              lastWsLog = now;
              console.warn(`[vite] ws proxy down (${err?.code ?? err?.message}) — browser will auto-reconnect`);
            }
          });
        },
      },
    },
  },
});
