// Task Supervisor — Step 2a: nudge engine (alert a Marco).
// Traccia da quanti giorni una task è ferma nel suo stato e avvisa Marco quando
// supera la soglia. Tutti gli alert vanno a Marco su Telegram — nessun invio
// automatico al cliente (quello è lo step 2b). Soglie dalla call.
// Blueprint: vault operativo/task-supervisor-architecture.md.

import cron from 'node-cron';
import { query } from '../db/index.js';
import { isClickUpConfigured, getOpenTasks, type ClickUpTask } from '../clickup/client.js';
import { supervised } from './scope.js';

// Soglia in giorni + testo dell'alert per stato. standby/te-states esclusi.
const NUDGE: Record<string, { days: number; msg: (d: number) => string }> = {
  'waiting feedback client':   { days: 2, msg: (d) => `cliente fermo da ${d}gg → sollecita (o /comunica per il follow-up)` },
  'waiting feedback internal': { days: 2, msg: (d) => `Luca/interni fermi da ${d}gg → sollecita` },
  'waiting feedback 3rd part': { days: 2, msg: (d) => `assistenza ferma da ${d}gg → manda follow-up all'app` },
  'in progress':               { days: 4, msg: (d) => `in lavorazione da ${d}gg → chiudila` },
};
const RENUDGE_DAYS = 2; // non ripetere lo stesso nudge più spesso di così

function clientName(listName: string): string {
  return listName.replace(/^[^\p{L}\p{N}]+/u, '').trim() || listName;
}
function daysBetween(a: number, b: number): number {
  return Math.floor((a - b) / 86400000);
}

// Upsert dello stato osservato: rileva le transizioni (status cambiato → since
// = ora, reset del nudge). Seed iniziale di `since` con date_updated.
async function trackStatuses(tasks: ClickUpTask[]): Promise<void> {
  const ids = tasks.map((t) => t.id);
  if (!ids.length) return;
  const existing = await query<{ task_id: string; status: string }>(
    `SELECT task_id, status FROM task_status_seen WHERE task_id = ANY($1)`, [ids]);
  const map = new Map(existing.map((r) => [r.task_id, r.status]));
  for (const t of tasks) {
    const prev = map.get(t.id);
    if (prev === undefined) {
      const since = t.updatedAt ? new Date(t.updatedAt) : new Date();
      await query(
        `INSERT INTO task_status_seen(task_id,status,since,last_seen) VALUES($1,$2,$3,now())
         ON CONFLICT(task_id) DO NOTHING`, [t.id, t.status, since]);
    } else if (prev !== t.status) {
      await query(
        `UPDATE task_status_seen SET status=$2, since=now(), last_seen=now(), last_nudged_at=NULL WHERE task_id=$1`,
        [t.id, t.status]);
    } else {
      await query(`UPDATE task_status_seen SET last_seen=now() WHERE task_id=$1`, [t.id]);
    }
  }
}

type Nudge = { task: ClickUpTask; days: number; text: string };

export async function computeNudges(userId: number): Promise<Nudge[]> {
  const tasks = supervised(await getOpenTasks()).filter((t) => t.status !== 'cancelled' && t.status !== 'completato');
  await trackStatuses(tasks);
  const ids = tasks.map((t) => t.id);
  const rows = await query<{ task_id: string; since: string; last_nudged_at: string | null }>(
    `SELECT task_id, since, last_nudged_at FROM task_status_seen WHERE task_id = ANY($1)`, [ids]);
  const seen = new Map(rows.map((r) => [r.task_id, r]));
  const now = Date.now();
  const out: Nudge[] = [];
  for (const t of tasks) {
    const rule = NUDGE[t.status];
    const s = seen.get(t.id);
    if (!rule || !s) continue;
    const days = daysBetween(now, new Date(s.since).getTime());
    if (days < rule.days) continue;
    if (s.last_nudged_at && daysBetween(now, new Date(s.last_nudged_at).getTime()) < RENUDGE_DAYS) continue;
    out.push({ task: t, days, text: rule.msg(days) });
  }
  return out;
}

export async function sendNudges(userId: number): Promise<{ ok: boolean; count: number }> {
  if (!isClickUpConfigured()) return { ok: false, count: 0 };
  const nudges = await computeNudges(userId);
  if (!nudges.length) return { ok: true, count: 0 };

  // Raggruppa per cliente.
  const byClient = new Map<string, Nudge[]>();
  for (const n of nudges) {
    const c = clientName(n.task.list.name);
    const a = byClient.get(c) ?? [];
    a.push(n);
    byClient.set(c, a);
  }
  const lines: string[] = [`🔔 Task ferme da troppo (${nudges.length}):`];
  for (const [c, ns] of [...byClient].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('', `▸ ${c}`);
    for (const n of ns) lines.push(`   [${n.task.status}] ${n.task.name} — ${n.text}`);
  }
  const { sendTelegram } = await import('../telegram/bot.js');
  await sendTelegram(userId, lines.join('\n'), 'task-nudge');

  // Segna come nudgiate (cadenza).
  await query(`UPDATE task_status_seen SET last_nudged_at=now() WHERE task_id = ANY($1)`,
    [nudges.map((n) => n.task.id)]);
  return { ok: true, count: nudges.length };
}

let started = false;
export function startNudgeScheduler(): void {
  if (started) return;
  started = true;
  // 9:00 e 15:00 Lun-Ven Europe/Rome.
  cron.schedule('0 9,15 * * 1-5', async () => {
    try {
      const users = await query<{ id: number }>(`SELECT id FROM users`);
      for (const u of users) await sendNudges(u.id).catch((e) => console.error('[supervisor] nudge', e));
    } catch (e) { console.error('[supervisor] nudge scheduler', e); }
  }, { timezone: 'Europe/Rome' });
  console.log('[supervisor] nudge scheduler armed (9:00+15:00 Lun-Ven Europe/Rome)');
}
