import cron from 'node-cron';
import { listConnectors, buildContext, getConnector } from '../connectors/registry.js';
import { query, getSetting, setSetting, listActiveUsers } from '../db/index.js';
import { bus } from '../bus.js';
import { runClaude } from '../claude/runner.js';
import { buildProactivePrompt } from '../claude/prompts.js';
import { sendTelegram } from '../telegram/bot.js';
import { getVaultRoot } from '../brain/vault.js';
import { runReflectionForUser, runReflectionAllUsers } from '../agent/reflection.js';
import { refreshTasks as refreshScheduledTasks } from './tasks.js';
import { startInternalAgentsScheduler } from '../agents/internal/registry.js';
// seedDefaultTasksAllUsers removed from boot — re-seeded deleted/disabled user tasks.
// Defaults now seeded ONLY at register time (auth/routes.ts).

function cronIntervalMinutes(expr: string): number {
  const m = expr.trim().match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return Math.max(1, Number(m[1]));
  if (/^\d+\s+\*\s+\*\s+\*\s+\*$/.test(expr)) return 60;
  return 5;
}

async function catchUpOnBoot() {
  const users = await listActiveUsers();
  for (const u of users) {
    try {
      const quiet = await getSetting<any>(u.id, 'agent_quiet_until');
      const sleep = await getSetting<any>(u.id, 'agent_next_reflection_at');
      const now = Date.now();
      const quietActive = quiet?.until && new Date(quiet.until).getTime() > now;
      const sleepActive = sleep?.until && new Date(sleep.until).getTime() > now;
      if (quietActive || sleepActive) continue;
      const last = await getSetting<string>(u.id, 'last_reflection_at');
      const elapsedMin = last ? (now - new Date(last).getTime()) / 60000 : Infinity;
      if (elapsedMin >= 2) {
        console.log(`[catchup:u${u.id}] reflection missed → firing`);
        setTimeout(() => runReflectionForUser(u.id).catch((e) => console.error('[catchup]', e)), 2500);
      }
    } catch (e) { console.error('[catchup] reflection check failed', e); }
  }

  try {
    const rows = await query<{ user_id: number; name: string; enabled: boolean; state: any }>(
      'SELECT user_id::int, name, enabled, state FROM connectors WHERE user_id IS NOT NULL'
    );
    for (const r of rows) {
      if (!r.enabled) continue;
      const conn = getConnector(r.name);
      if (!conn?.onTick || !conn.manifest.schedule) continue;
      const intervalMin = cronIntervalMinutes(conn.manifest.schedule);
      const lastTickAt = r.state?.lastTickAt ? new Date(r.state.lastTickAt).getTime() : 0;
      const elapsedMin = (Date.now() - lastTickAt) / 60000;
      if (elapsedMin >= intervalMin) {
        console.log(`[catchup:u${r.user_id}:${r.name}] missed → firing`);
        setTimeout(() => runTick(r.user_id, r.name).catch((e) => console.error('[catchup]', e)), 3500);
      }
    }
  } catch (e) { console.error('[catchup] connectors check failed', e); }
}

const connectorTasks = new Map<string, cron.ScheduledTask>(); // `${userId}:${name}` → task

export async function startScheduler() {
  // Per-user connector tick cron — runs every minute, dispatches enabled connectors
  for (const conn of listConnectors()) {
    const schedule = conn.manifest.schedule;
    if (!schedule || !conn.onTick) continue;
    // Universal cron: at fire time, query all users with this connector enabled and tick
    const task = cron.schedule(schedule, async () => {
      const rows = await query<{ user_id: number }>(
        `SELECT user_id::int FROM connectors WHERE name=$1 AND enabled=true AND user_id IS NOT NULL`,
        [conn.manifest.name]
      );
      for (const r of rows) await runTick(r.user_id, conn.manifest.name).catch((e) => console.error('[tick]', e));
    });
    connectorTasks.set(`*:${conn.manifest.name}`, task);
  }

  bus.removeAllListeners('connector:event');
  bus.on('connector:event', onConnectorEvent);

  let reflecting = false;
  cron.schedule('*/2 * * * *', async () => {
    if (reflecting) return;
    reflecting = true;
    try { await runReflectionAllUsers(); } catch (e) { console.error('[reflection]', e); }
    finally { reflecting = false; }
  });
  console.log('[scheduler] reflection loop armed (every 2m, all users)');

  await refreshScheduledTasks();
  console.log('[scheduler] user-defined tasks loaded');
  startInternalAgentsScheduler();

  await catchUpOnBoot();

}

export async function runTick(userId: number, name: string) {
  const conn = getConnector(name);
  if (!conn?.onTick) return;
  const rows = await query<{ enabled: boolean }>('SELECT enabled FROM connectors WHERE user_id=$1 AND name=$2', [userId, name]);
  if (!rows[0]?.enabled) return;
  const ctx = await buildContext(userId, name);
  try {
    await conn.onTick(ctx);
  } catch (e) {
    console.error(`[scheduler:u${userId}:${name}] tick error`, e);
  } finally {
    try {
      const cur = await query<{ state: any }>('SELECT state FROM connectors WHERE user_id=$1 AND name=$2', [userId, name]);
      const merged = { ...(cur[0]?.state ?? {}), lastTickAt: new Date().toISOString() };
      await query('UPDATE connectors SET state=$1::jsonb, updated_at=now() WHERE user_id=$2 AND name=$3', [JSON.stringify(merged), userId, name]);
    } catch {}
  }
}

async function onConnectorEvent(ev: { userId: number; connector: string; kind: string; payload: any }) {
  const vault = await getVaultRoot(ev.userId);
  const prompt = await buildProactivePrompt(ev.userId, `${ev.connector}:${ev.kind}`, ev.payload);
  const res = await runClaude(ev.userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 120_000, kind: 'proactive', meta: { trigger: `${ev.connector}:${ev.kind}` } });
  if (!res.ok) return;
  const out = res.text.trim();
  if (!out || out === 'SKIP') return;
  try { await sendTelegram(ev.userId, out); } catch (e) { console.error('[scheduler] sendTelegram', e); }
}
