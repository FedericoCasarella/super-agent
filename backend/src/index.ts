import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { config } from './config.js';
import { router } from './api/routes.js';
import { authRouter } from './auth/routes.js';
import { attachWs } from './api/ws.js';
import { loadConnectors } from './connectors/registry.js';
import { startScheduler } from './scheduler/index.js';
import { startAllTelegramBots } from './telegram/bot.js';
import { startOrchestrator } from './agent/orchestrator.js';
import { writeMcpConfig } from './mcp/config.js';
import { refreshExternalMcps } from './claude/external_mcps.js';

async function main() {
  const app = express();
  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api', router);
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  attachWs(server);

  await loadConnectors();
  try { const { loadAllPlugins } = await import('./plugins/index.js'); await loadAllPlugins(); } catch (e) { console.error('[plugins] boot load failed', e); }
  const mcpPath = await writeMcpConfig();
  console.log(`[mcp] config written: ${mcpPath}`);
  await refreshExternalMcps();
  setInterval(() => { refreshExternalMcps().catch(() => {}); }, 60 * 60_000);

  startOrchestrator();
  await startScheduler();
  const flows = await import('./flows/index.js');
  flows.attachFlowDispatchers();
  flows.startFlowScheduler();
  await startAllTelegramBots();
  // Auto-restart WhatsApp sessions for users with existing creds on disk
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = path.join(os.homedir(), '.super-agent', 'wa-sessions');
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    const wa = await import('./connectors/builtin/whatsapp/index.js');
    for (const e of entries) {
      const m = e.match(/^u(\d+)$/);
      if (!m) continue;
      const uid = Number(m[1]);
      try { await wa.startWaForUser(uid); } catch (err) { console.error(`[wa:u${uid}] boot start failed`, err); }
    }
  } catch (e) { console.error('[wa] boot scan failed', e); }

  // Auto-restore Instagram sessions for users with persisted state.json
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = path.join(os.homedir(), '.super-agent', 'ig-sessions');
    const entries = await fs.readdir(root).catch(() => [] as string[]);
    const ig = await import('./connectors/builtin/instagram/index.js');
    for (const e of entries) {
      const m = e.match(/^u(\d+)$/);
      if (!m) continue;
      const uid = Number(m[1]);
      try { await ig.startIgForUser(uid); } catch (err) { console.error(`[ig:u${uid}] boot start failed`, err); }
    }
  } catch (e) { console.error('[ig] boot scan failed', e); }

  if (config.devAutoLogin) {
    console.warn('⚠️  [auth] DEV_AUTOLOGIN attivo — login BYPASSATO, auto-auth come utente locale. NON usare in produzione/distribuzione.');
  }

  // Listen with retry on EADDRINUSE — common during hot-reload bursts when the
  // previous child's TIME_WAIT socket hasn't released the port yet. Without
  // this, EADDRINUSE hits uncaughtException → exit(1) → respawn → same error
  // → respawn loop (the "dead loop" symptom).
  function listenWithRetry(attempt = 0): void {
    const onErr = (err: any) => {
      if (err?.code === 'EADDRINUSE' && attempt < 12) {
        const delay = Math.min(3000, 250 * 2 ** attempt);
        console.warn(`[backend] port ${config.port} busy — retry in ${delay}ms (attempt ${attempt + 1})`);
        setTimeout(() => listenWithRetry(attempt + 1), delay);
      } else {
        console.error('[backend] listen failed', err);
        process.exit(1);
      }
    };
    server.once('error', onErr);
    server.listen(config.port, config.host, () => {
      server.off('error', onErr);
      console.log(`[backend] http://${config.host}:${config.port}`);
    });
  }
  listenWithRetry();

  // Graceful shutdown — tsx watch sends SIGINT/SIGTERM on reload + concurrently
  // does the same when the user hits ^C. Without explicit teardown of HTTP
  // server, Playwright contexts, IMAP polls, cron timers etc. the event loop
  // stays alive and tsx force-kills after timeout, spamming the console.
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — closing connections…`);
    // Hard deadline: if anything hangs, exit anyway after 2.5s. tsx watch and
    // scripts/dev-loop.mjs only wait ~5s before SIGKILL — we MUST exit first
    // so the parent can respawn cleanly and not leave port 8787 detached.
    const hardKill = setTimeout(() => {
      console.warn('[shutdown] hard exit after 2.5s timeout');
      process.exit(0);
    }, 2500);
    // Don't unref — we WANT this timer to keep the event loop alive long
    // enough to actually fire even if everything else hangs.
    try { server.closeAllConnections?.(); } catch {} // force-drop keep-alive sockets
    try { await new Promise<void>((res) => server.close(() => res())); } catch {}
    // Stop Instagram Playwright contexts
    try {
      const ig = await import('./connectors/builtin/instagram/index.js');
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const path = await import('node:path');
      const root = path.join(os.homedir(), '.super-agent', 'ig-sessions');
      const entries = await fs.readdir(root).catch(() => [] as string[]);
      for (const e of entries) {
        const m = e.match(/^u(\d+)$/);
        if (m) { try { await ig.stopIgForUser(Number(m[1])); } catch {} }
      }
    } catch {}
    // Close pg pool
    try { const { pool } = await import('./db/index.js'); await pool.end(); } catch {}
    console.log('[shutdown] done');
    process.exit(0);
  }
  // Dev mode: SIGTERM = restart from dev-loop. Skip slow graceful cleanup
  // (server.close waiting for telegram polling, baileys sockets, playwright
  // contexts, pg pool drain — each can hang 5+s). Just drop the listener and
  // exit. Prod still does the graceful path.
  const isDev = process.env.NODE_ENV !== 'production';
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => {
    if (isDev) {
      console.log('[shutdown] SIGTERM (dev) — stopping Telegram polling then exit');
      // Stop Telegraf polling so outstanding getUpdates is cancelled WITH ack
      // of the last delivered batch. Without this, dev-loop restarts mid-turn
      // leave updates un-acked → Telegram re-delivers → user gets N replies.
      // Hard deadline 1.5s so port doesn't linger.
      const hardKill = setTimeout(() => { console.warn('[shutdown] hard exit after 1.5s'); process.exit(0); }, 1500);
      (async () => {
        try { const tg = await import('./telegram/bot.js'); await tg.stopAllTelegramBots?.(); } catch {}
        try { server.closeAllConnections?.(); } catch {}
        try { server.close(); } catch {}
        clearTimeout(hardKill);
        process.exit(0);
      })();
      return;
    }
    void shutdown('SIGTERM');
  });

  // Log only — do NOT exit. Baileys, IG playwright, IMAP all throw transient
  // unhandledRejections (timeouts, socket drops) we want to absorb silently.
  // Exiting here caused a respawn loop on every WhatsApp image / reconnect.
  process.on('unhandledRejection', (reason: any) => {
    console.warn('[warn] unhandledRejection', reason?.message ?? reason);
  });
  process.on('uncaughtException', (err: any) => {
    console.warn('[warn] uncaughtException', err?.message ?? err);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
