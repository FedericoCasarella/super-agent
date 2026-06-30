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

  // WA watchdog: every 60s scan active users and restart any WA session that
  // is missing or in a stale 'closed' state. Prevents the agent from sitting
  // on `status=idle` after a backend restart, network drop, or phone-side
  // disconnect (Baileys' own auto-retry path doesn't fire on every disconnect
  // reason).
  let waWatchRunning = false;
  cron.schedule('* * * * *', async () => {
    if (waWatchRunning) return;
    waWatchRunning = true;
    try {
      const wa = await import('../connectors/builtin/whatsapp/index.js');
      const users = await listActiveUsers();
      for (const u of users) {
        try {
          const st = wa.getWaStatus(u.id);
          if (st.status === 'starting' || st.status === 'closed' || st.status === 'idle') {
            await wa.startWaForUser(u.id).catch(() => {});
          }
        } catch {}
      }
    } catch (e) { console.error('[wa-watchdog]', e); }
    finally { waWatchRunning = false; }
  });
  console.log('[scheduler] wa-watchdog armed (every 1m)');

  // Mail auto-sync: react to `mail:new` events. When the IMAP cron's
  // persistInbound fires for an account the user flagged `mail.autoSync=true`,
  // immediately bonifica that single message (brain note + people linking).
  // Per-message, NOT a polling loop.
  bus.on('mail:new', async (m: any) => {
    if (!m?.userId || !m?.account || !m?.id) return;
    try {
      const pref = await getSetting<{ enabled: boolean }>(m.userId, `mail.autoSync.${m.account}`);
      if (!pref?.enabled) return;
      bus.emit('mail:autosync', { userId: m.userId, account: m.account, mailId: m.id, phase: 'started' });
      const { bonifyOne } = await import('../mail/service.js');
      const r = await bonifyOne(m.userId, m.id, false);
      bus.emit('mail:autosync', {
        userId: m.userId, account: m.account, mailId: m.id,
        phase: r.ok ? 'done' : 'error',
        skipped: r.skipped, subj: r.subj, error: r.error,
      });
    } catch (e: any) {
      bus.emit('mail:autosync', { userId: m.userId, account: m.account, mailId: m.id, phase: 'error', error: String(e?.message ?? e) });
    }
  });
  console.log('[scheduler] mail auto-sync armed (per-message, on mail:new)');

  // Brain snapshots: 00:00 nightly per-user vault copy + counts.
  // Pin to Europe/Rome so it fires at midnight LOCAL regardless of system TZ
  // (default would be process TZ — if running in UTC container, "00:00" =
  // 02:00 CEST and the user thinks it's broken).
  let snapRunning = false;
  async function runSnapshotSweep(label: string) {
    if (snapRunning) return;
    snapRunning = true;
    try {
      const { createSnapshots } = await import('../brain/snapshots.js');
      const users = await listActiveUsers();
      for (const u of users) {
        try { const r = await createSnapshots(u.id, 'cron'); console.log(`[snapshots:${label}:u${u.id}] ${r.length} vaults snapshotted`); }
        catch (e) { console.error(`[snapshots:${label}:u${u.id}]`, e); }
      }
    } finally { snapRunning = false; }
  }
  cron.schedule('0 0 * * *', () => { runSnapshotSweep('cron').catch(() => {}); }, { timezone: 'Europe/Rome' });
  console.log('[scheduler] brain-snapshot loop armed (daily 00:00 Europe/Rome)');

  // Automation meter: 09:05 Europe/Rome ricalcola il rate rolling-7gg "% task
  // auto-chiuse" e lo appende allo storico KPI del goal "automazione 70%".
  let meterRunning = false;
  cron.schedule('5 9 * * *', async () => {
    if (meterRunning) return;
    meterRunning = true;
    try {
      const { updateAutoCloseKpi } = await import('../supervisor/meter.js');
      const users = await listActiveUsers();
      for (const u of users) {
        try { await updateAutoCloseKpi(u.id); }
        catch (e) { console.error(`[meter:u${u.id}]`, e); }
      }
    } catch (e) { console.error('[meter] sweep failed', e); }
    finally { meterRunning = false; }
  }, { timezone: 'Europe/Rome' });
  console.log('[scheduler] automation-meter loop armed (daily 09:05 Europe/Rome)');

  // Catch-up: backend was down at midnight, or process restarted mid-sweep.
  // On boot, check whether a cron snapshot for TODAY already exists per user;
  // if not, run one now. Guarantees daily coverage even with frequent restarts.
  (async () => {
    try {
      const { createSnapshots } = await import('../brain/snapshots.js');
      const users = await listActiveUsers();
      for (const u of users) {
        try {
          const r = await query<{ c: number }>(
            `SELECT count(*)::int AS c FROM brain_snapshots
             WHERE user_id=$1 AND trigger='cron' AND created_at::date = (now() AT TIME ZONE 'Europe/Rome')::date`,
            [u.id],
          );
          if ((r[0]?.c ?? 0) > 0) continue;
          console.log(`[snapshots:catchup:u${u.id}] no cron snapshot for today — running now`);
          const out = await createSnapshots(u.id, 'cron');
          console.log(`[snapshots:catchup:u${u.id}] ${out.length} vaults snapshotted`);
        } catch (e) { console.error(`[snapshots:catchup:u${u.id}]`, e); }
      }
    } catch (e) { console.error('[snapshots:catchup]', e); }
  })().catch(() => {});

// Auto-bonify loop: every 5 minutes, find chats with auto_bonify=true that have pending
  // wa_messages and run bonifyWaMessages(onlyChat=jid). Skips quiet/disabled.
  let bonifyRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (bonifyRunning) return;
    bonifyRunning = true;
    try {
      const wa = await import('../connectors/builtin/whatsapp/index.js');
      const rows = await query<{ user_id: number; jid: string; pending: number }>(
        `SELECT c.user_id::int, c.jid,
                (SELECT count(*)::int FROM wa_messages m
                 WHERE m.user_id=c.user_id AND m.chat_jid=c.jid
                   AND m.processed_at IS NULL AND m.msg_id NOT LIKE 'chat:%' AND m.text <> '') AS pending
         FROM wa_contacts c
         WHERE c.auto_bonify=true`,
      );
      for (const r of rows) {
        if (!r.pending || r.pending <= 0) continue;
        // Drain pending in batches (up to 5 cycles per tick) to clear large backlogs fast.
        // bonifyWaMessages cap per call = 500; 5 cycles → max 2500 messages per tick per chat.
        let remaining = r.pending;
        let cycles = 0;
        while (remaining > 0 && cycles < 5) {
          const limit = Math.min(remaining, 500);
          console.log(`[wa-auto-bonify:u${r.user_id}] ${r.jid} cycle ${cycles+1}/5 pending=${remaining} → running ${limit}`);
          try { const res = await wa.bonifyWaMessages(r.user_id, { onlyChat: r.jid, limit }); remaining -= res.processed ?? limit; }
          catch (e) { console.error('[wa-auto-bonify]', e); break; }
          cycles++;
        }
      }
    } catch (e) { console.error('[wa-auto-bonify] loop error', e); }
    finally { bonifyRunning = false; }
  });
  console.log('[scheduler] wa auto-bonify loop armed (every 5m, per-chat opt-in)');

  // IG auto-bonify loop — same pattern as WA but on ig_messages/ig_threads.
  let igBonifyRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (igBonifyRunning) return;
    igBonifyRunning = true;
    try {
      const ig = await import('../connectors/builtin/instagram/index.js');
      const rows = await query<{ user_id: number; thread_id: string; pending: number }>(
        `SELECT t.user_id::int, t.thread_id,
                (SELECT count(*)::int FROM ig_messages m
                 WHERE m.user_id=t.user_id AND m.thread_id=t.thread_id
                   AND m.processed_at IS NULL AND m.text <> '' AND NOT m.from_me) AS pending
         FROM ig_threads t WHERE t.auto_bonify=true`,
      );
      for (const r of rows) {
        if (!r.pending || r.pending <= 0) continue;
        let remaining = r.pending;
        let cycles = 0;
        while (remaining > 0 && cycles < 5) {
          const limit = Math.min(remaining, 500);
          console.log(`[ig-auto-bonify:u${r.user_id}] ${r.thread_id} cycle ${cycles+1}/5 pending=${remaining} → running ${limit}`);
          try { const res = await ig.bonifyIgMessages(r.user_id, { onlyThread: r.thread_id, limit }); remaining -= res.processed ?? limit; }
          catch (e) { console.error('[ig-auto-bonify]', e); break; }
          cycles++;
        }
      }
    } catch (e) { console.error('[ig-auto-bonify] loop error', e); }
    finally { igBonifyRunning = false; }
  });
  console.log('[scheduler] ig auto-bonify loop armed (every 5m, per-thread opt-in)');

  // IG follow-up tick — every minute walks ig_threads with follow_up_at <= now
  // and fires runFollowUp via the connector.
  let igFollowUpRunning = false;
  cron.schedule('* * * * *', async () => {
    if (igFollowUpRunning) return;
    igFollowUpRunning = true;
    try {
      const ig = await import('../connectors/builtin/instagram/index.js');
      await ig.tickIgFollowUps();
    } catch (e) { console.error('[ig-followup] loop error', e); }
    finally { igFollowUpRunning = false; }
  });
  console.log('[scheduler] ig follow-up loop armed (every 1m)');

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

// Dedup: skip events whose stable key was already processed in the recent
// past. Without this, a duplicate IMAP poller (e.g. two backend instances
// fighting over the same session, or rapid restarts that re-fetch the same
// UID) would fire onConnectorEvent N times → N Telegram pings for one email.
const recentEventKeys = new Map<string, number>();
const EVENT_DEDUP_MS = 10 * 60_000;
// Per-user mutex so two near-simultaneous events (email + WS push) can't
// spawn two Claude runs in parallel that both reply.
const proactiveInFlight = new Set<number>();

function eventKey(ev: { userId: number; connector: string; kind: string; payload: any }): string {
  const p = ev.payload ?? {};
  // Best-effort stable id: account+uid for emails, otherwise channel+msg_id.
  const id = p.uid ?? p.id ?? p.msg_id ?? p.subj ?? JSON.stringify(p).slice(0, 80);
  return `${ev.userId}:${ev.connector}:${ev.kind}:${p.account ?? ''}:${id}`;
}

async function onConnectorEvent(ev: { userId: number; connector: string; kind: string; payload: any }) {
  const now = Date.now();
  // Sweep expired
  for (const [k, ts] of recentEventKeys) if (now - ts > EVENT_DEDUP_MS) recentEventKeys.delete(k);
  const key = eventKey(ev);
  if (recentEventKeys.has(key)) {
    console.log(`[scheduler] skip dup event ${key}`);
    return;
  }
  recentEventKeys.set(key, now);
  if (proactiveInFlight.has(ev.userId)) {
    console.log(`[scheduler:u${ev.userId}] proactive turn in-flight — skipping ${ev.connector}:${ev.kind}`);
    return;
  }
  proactiveInFlight.add(ev.userId);
  try {
    const vault = await getVaultRoot(ev.userId);
    const prompt = await buildProactivePrompt(ev.userId, `${ev.connector}:${ev.kind}`, ev.payload);
    const res = await runClaude(ev.userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 60_000, kind: 'proactive', meta: { trigger: `${ev.connector}:${ev.kind}` } });
    if (!res.ok) return;
    const out = res.text.trim();
    if (!out || out === 'SKIP') return;
    try { await sendTelegram(ev.userId, out); } catch (e) { console.error('[scheduler] sendTelegram', e); }
  } finally { proactiveInFlight.delete(ev.userId); }
}
