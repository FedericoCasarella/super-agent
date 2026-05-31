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

  server.listen(config.port, config.host, () => {
    console.log(`[backend] http://${config.host}:${config.port}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
