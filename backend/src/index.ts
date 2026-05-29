import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import { config } from './config.js';
import { query } from './db/index.js';
import { router } from './api/routes.js';
import { authRouter } from './auth/routes.js';
import { attachWs } from './api/ws.js';
import { loadConnectors } from './connectors/registry.js';
import { startScheduler } from './scheduler/index.js';
import { startAllTelegramBots } from './telegram/bot.js';
import { startOrchestrator } from './agent/orchestrator.js';
import { writeMcpConfig } from './mcp/config.js';
import { refreshExternalMcps } from './claude/external_mcps.js';

const bootedAt = Date.now();

// Resilience (sess.2939): a backend that dies silently while its supervisor still
// sees a live PID is the worst failure mode (login outage RCA). Surface fatal errors
// and EXIT so the supervisor (watchdog / launchd KeepAlive) restarts a fresh process,
// instead of lingering in an undefined state. fail-fast + auto-recover.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException — exiting for supervisor restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection — exiting for supervisor restart:', reason);
  process.exit(1);
});

async function main() {
  const app = express();
  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/api/auth', authRouter);
  app.use('/api', router);
  // Liveness probe for the watchdog: verifies the process AND its DB link are alive,
  // not just that the port answers. Never throws — returns 503 so the supervisor can act.
  app.get('/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ ok: true, uptimeMs: Date.now() - bootedAt });
    } catch {
      res.status(503).json({ ok: false, error: 'db_unreachable', uptimeMs: Date.now() - bootedAt });
    }
  });

  const server = http.createServer(app);
  attachWs(server);

  await loadConnectors();
  const mcpPath = await writeMcpConfig();
  console.log(`[mcp] config written: ${mcpPath}`);
  await refreshExternalMcps();
  setInterval(() => { refreshExternalMcps().catch(() => {}); }, 60 * 60_000);

  startOrchestrator();
  await startScheduler();
  await startAllTelegramBots();

  server.listen(config.port, config.host, () => {
    console.log(`[backend] http://${config.host}:${config.port}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
