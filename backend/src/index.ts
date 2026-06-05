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

  server.listen(config.port, config.host, () => {
    console.log(`[backend] http://${config.host}:${config.port}`);
  });

  // Graceful shutdown — tsx watch sends SIGINT/SIGTERM on reload + concurrently
  // does the same when the user hits ^C. Without explicit teardown of HTTP
  // server, Playwright contexts, IMAP polls, cron timers etc. the event loop
  // stays alive and tsx force-kills after timeout, spamming the console.
  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — closing connections…`);
    // Hard deadline: if anything hangs, exit anyway after 4s so tsx doesn't have to kill us.
    const hardKill = setTimeout(() => {
      console.warn('[shutdown] hard exit after 4s timeout');
      process.exit(0);
    }, 4000);
    hardKill.unref();
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
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => { console.error(e); process.exit(1); });
