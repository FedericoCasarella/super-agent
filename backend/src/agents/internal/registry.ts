import cron from 'node-cron';
import { query, listActiveUsers, getSetting } from '../../db/index.js';
import type { InternalAgent, Lang } from './types.js';
import brainClassifier from './brain_classifier.js';
import linkWeaver from './link_weaver.js';
import peopleAnalyzer from './people_analyzer.js';
import { sendTelegram } from '../../telegram/bot.js';

const REGISTRY: InternalAgent[] = [brainClassifier, linkWeaver, peopleAnalyzer];

export function listInternalAgents(): InternalAgent[] {
  return REGISTRY;
}
export function getInternalAgent(name: string): InternalAgent | undefined {
  return REGISTRY.find((a) => a.name === name);
}

export async function ensureUserAgentRows(userId: number) {
  for (const a of REGISTRY) {
    await query(
      `INSERT INTO internal_agents(user_id, name, hour, minute)
       VALUES($1, $2, $3, $4) ON CONFLICT(user_id, name) DO NOTHING`,
      [userId, a.name, a.defaultHour, a.defaultMinute]
    );
  }
}

export async function listUserAgents(userId: number) {
  await ensureUserAgentRows(userId);
  const rows = await query<any>(
    `SELECT id::int, name, enabled, hour, minute, notify_on_run, last_run_at, last_status, last_report
     FROM internal_agents WHERE user_id=$1 ORDER BY name`,
    [userId]
  );
  return rows.map((r) => {
    const meta = REGISTRY.find((a) => a.name === r.name);
    return { ...r, title: meta?.title ?? r.name, description: meta?.description ?? '' };
  });
}

function fallbackHumanize(title: string, report: any, lang: Lang, status: 'ok' | 'error'): string {
  if (status === 'error') {
    return lang === 'it'
      ? `**${title}** — esecuzione fallita: ${String(report?.error ?? 'errore sconosciuto')}`
      : `**${title}** — run failed: ${String(report?.error ?? 'unknown error')}`;
  }
  return lang === 'it' ? `**${title}** — completato.` : `**${title}** — done.`;
}

export async function runInternalAgent(userId: number, name: string) {
  const agent = getInternalAgent(name);
  if (!agent) throw new Error(`unknown agent: ${name}`);
  let report: any;
  let status = 'ok';
  try {
    report = await agent.run(userId);
  } catch (e: any) {
    status = 'error';
    report = { error: String(e?.message ?? e) };
  }
  await query(
    `UPDATE internal_agents SET last_run_at=now(), last_status=$3, last_report=$4::jsonb, updated_at=now()
     WHERE user_id=$1 AND name=$2`,
    [userId, name, status, JSON.stringify(report ?? {})]
  );
  // Telegram notify if enabled
  try {
    const rows = await query<{ notify_on_run: boolean }>(
      `SELECT notify_on_run FROM internal_agents WHERE user_id=$1 AND name=$2`,
      [userId, name]
    );
    console.log(`[internal-agents:u${userId}:${name}] notify_on_run=${rows[0]?.notify_on_run}`);
    if (rows[0]?.notify_on_run) {
      const lang = ((await getSetting<string>(userId, 'language')) ?? 'it') as Lang;
      const msg = agent.humanize
        ? agent.humanize(report, lang, status as 'ok' | 'error')
        : fallbackHumanize(agent.title, report, lang, status as 'ok' | 'error');
      console.log(`[internal-agents:u${userId}:${name}] sending telegram (${lang})`);
      await sendTelegram(userId, msg);
      console.log(`[internal-agents:u${userId}:${name}] telegram sent`);
    }
  } catch (e) { console.error(`[internal-agents:u${userId}:${name}] notify failed`, e); }
  return { status, report };
}

export async function updateAgentSchedule(userId: number, name: string, p: { hour?: number; minute?: number; enabled?: boolean; notify_on_run?: boolean }) {
  const fields: string[] = [];
  const vals: any[] = [];
  let i = 2;
  if (p.hour !== undefined)          { fields.push(`hour=$${++i}`); vals.push(Math.max(0, Math.min(23, p.hour))); }
  if (p.minute !== undefined)        { fields.push(`minute=$${++i}`); vals.push(Math.max(0, Math.min(59, p.minute))); }
  if (p.enabled !== undefined)       { fields.push(`enabled=$${++i}`); vals.push(!!p.enabled); }
  if (p.notify_on_run !== undefined) { fields.push(`notify_on_run=$${++i}`); vals.push(!!p.notify_on_run); }
  if (!fields.length) return;
  await query(
    `UPDATE internal_agents SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND name=$2`,
    [userId, name, ...vals]
  );
}

// Catch-up: if scheduled time today passed and last_run_at < that time → fire now.
// Survives app downtime — daily agents will fire on next boot.
async function catchUpInternalAgents() {
  const users = await listActiveUsers();
  const now = new Date();
  for (const u of users) {
    await ensureUserAgentRows(u.id);
    const rows = await query<{ name: string; enabled: boolean; hour: number; minute: number; last_run_at: string | null }>(
      `SELECT name, enabled, hour, minute, last_run_at FROM internal_agents WHERE user_id=$1`,
      [u.id],
    );
    for (const r of rows) {
      if (!r.enabled) continue;
      const sched = new Date(now);
      sched.setHours(r.hour, r.minute, 0, 0);
      const passed = now >= sched;
      const lastRun = r.last_run_at ? new Date(r.last_run_at) : null;
      const missedToday = passed && (!lastRun || lastRun < sched);
      if (missedToday) {
        const ageH = lastRun ? Math.floor((now.getTime() - lastRun.getTime()) / 3_600_000) : null;
        console.log(`[internal-agents:u${u.id}:${r.name}] catch-up: scheduled ${r.hour}:${String(r.minute).padStart(2,'0')}, last_run ${ageH != null ? `${ageH}h ago` : 'never'} → firing`);
        setTimeout(() => runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents:catchup]', e)), 4000 + Math.random() * 3000);
      }
    }
  }
}

// Daily 1-minute tick — fires any user-agent whose hour/minute match current time
export function startInternalAgentsScheduler() {
  catchUpInternalAgents().catch((e) => console.error('[internal-agents] catch-up failed', e));
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    try {
      const users = await listActiveUsers();
      for (const u of users) {
        const rows = await query<{ name: string; enabled: boolean }>(
          `SELECT name, enabled FROM internal_agents WHERE user_id=$1 AND hour=$2 AND minute=$3`,
          [u.id, h, m]
        );
        for (const r of rows) {
          if (!r.enabled) continue;
          console.log(`[internal-agents:u${u.id}] firing ${r.name}`);
          runInternalAgent(u.id, r.name).catch((e) => console.error('[internal-agents]', e));
        }
      }
    } catch (e) { console.error('[internal-agents] tick error', e); }
  });
  console.log('[internal-agents] scheduler armed (1-min tick, fires at user-set hour:minute)');
}
