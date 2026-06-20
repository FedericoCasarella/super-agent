// Task Supervisor — Step 2b: auto-follow-up al cliente.
// Per le task in `waiting feedback client` ferme da >2gg, manda da solo un
// follow-up al cliente sul suo canale (riusa il braccio), ogni 2 giorni, max 3
// volte, SOLO nella finestra Lun-Ven 9:00-18:30, e avvisa Marco a ogni invio.
// Dopo 3 follow-up senza risposta, la palla torna a Marco (lo fa il nudge).
// Interruttore: setting `autofollowup` (default ON), comando /followups on|off.

import cron from 'node-cron';
import { query, getSetting } from '../db/index.js';
import { getOpenTasks, type ClickUpTask } from '../clickup/client.js';
import { supervised } from './scope.js';
import { trackStatuses } from './nudge.js';
import { resolveClient, sendOnChannel, inSendWindow } from '../arm/client_messages.js';

const FOLLOWUP_DAYS = 2;   // ferma da almeno N giorni
const FOLLOWUP_GAP = 2;    // un follow-up ogni N giorni
const MAX_FOLLOWUPS = 3;   // poi passa la palla a Marco

function topic(taskName: string): string {
  return taskName
    .replace(/^\s*(CR Compliance|CR|Bug Fixing|\[[^\]]+\])\s*[|:]?\s*/i, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Varianti per non mandare sempre lo stesso testo. Tono di Marco: corto, niente
// trattini, emoji leggera.
function followupText(taskName: string, count: number): string {
  const t = topic(taskName);
  const variants = [
    `Ciao! Ti avevo scritto riguardo "${t}", hai avuto modo di dare un'occhiata? 🙂`,
    `Ciao, rimando su "${t}" 🙂 appena puoi fammi sapere se va bene così procedo`,
    `Ciao! Resto in attesa di un tuo ok su "${t}", quando hai un attimo. grazie!`,
  ];
  return variants[Math.min(count, variants.length - 1)];
}

async function isEnabled(userId: number): Promise<boolean> {
  const s = await getSetting<{ enabled?: boolean }>(userId, 'autofollowup');
  return s?.enabled !== false; // default ON
}

type Plan = { task: ClickUpTask; count: number; days: number; text: string; channel: string };

// Candidati da inviare (ignora la finestra — per anteprima/dry-run).
export async function computeFollowups(userId: number): Promise<Plan[]> {
  const all = supervised(await getOpenTasks()).filter((t) => t.status !== 'cancelled' && t.status !== 'completato');
  await trackStatuses(all);
  const waiting = all.filter((t) => t.status === 'waiting feedback client');
  if (!waiting.length) return [];
  const rows = await query<{ task_id: string; since: string; last_followup_at: string | null; followup_count: number }>(
    `SELECT task_id, since, last_followup_at, followup_count FROM task_status_seen WHERE task_id = ANY($1)`,
    [waiting.map((t) => t.id)]);
  const seen = new Map(rows.map((r) => [r.task_id, r]));
  const now = Date.now();
  const out: Plan[] = [];
  for (const t of waiting) {
    const s = seen.get(t.id);
    if (!s) continue;
    const days = Math.floor((now - new Date(s.since).getTime()) / 86400000);
    if (days < FOLLOWUP_DAYS) continue;
    if ((s.followup_count ?? 0) >= MAX_FOLLOWUPS) continue;
    if (s.last_followup_at && (now - new Date(s.last_followup_at).getTime()) < FOLLOWUP_GAP * 86400000) continue;
    const client = resolveClient(t.list.id);
    if (!client || !client.verified || !client.channel) continue; // canale non pronto → lo gestisce il nudge
    if (client.channel === 'whatsapp' && !client.wa_group_jid) continue;
    if (client.channel === 'clickup' && !client.clickup_channel_id) continue;
    out.push({ task: t, count: s.followup_count ?? 0, days, text: followupText(t.name, s.followup_count ?? 0), channel: client.channel });
  }
  return out;
}

export async function sendClientFollowups(userId: number): Promise<{ ok: boolean; sent: number; skipped?: string }> {
  if (!(await isEnabled(userId))) return { ok: true, sent: 0, skipped: 'disabilitato' };
  if (!inSendWindow()) return { ok: true, sent: 0, skipped: 'fuori finestra' };
  const plans = await computeFollowups(userId);
  let sent = 0;
  const { sendTelegram } = await import('../telegram/bot.js');
  for (const p of plans) {
    const client = resolveClient(p.task.list.id)!;
    const r = await sendOnChannel(userId, client, p.text);
    if (!r.ok) { console.error(`[followup] send fail ${p.task.id}`, r.error); continue; }
    const n = p.count + 1;
    await query(`UPDATE task_status_seen SET last_followup_at=now(), followup_count=$2 WHERE task_id=$1`, [p.task.id, n]);
    sent++;
    const tail = n >= MAX_FOLLOWUPS ? ' (ultimo auto — se non risponde tocca a te)' : '';
    await sendTelegram(userId, `📤 Follow-up auto #${n} → ${client.clickup_list_name}: ${topic(p.task.name)}${tail}`, 'task-followup').catch(() => {});
  }
  return { ok: true, sent };
}

let started = false;
export function startFollowupScheduler(): void {
  if (started) return;
  started = true;
  // Una volta al giorno alle 10:00 Lun-Ven; la cadenza 2gg evita doppioni.
  cron.schedule('0 10 * * 1-5', async () => {
    try {
      const users = await query<{ id: number }>(`SELECT id FROM users`);
      for (const u of users) await sendClientFollowups(u.id).catch((e) => console.error('[followup]', e));
    } catch (e) { console.error('[followup] scheduler', e); }
  }, { timezone: 'Europe/Rome' });
  console.log('[supervisor] auto-follow-up scheduler armed (10:00 Lun-Ven Europe/Rome, max 3, finestra invii)');
}
