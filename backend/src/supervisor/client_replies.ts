// Task Supervisor — Step 3: cattura "il cliente ha risposto".
// Il buco centrale del blueprint: task in `waiting feedback client`, il cliente
// ha già risposto sul canale, ma Marco non ha visto la chat. Questo modulo
// sorveglia il canale di ogni task in attesa e, quando trova un messaggio del
// cliente DOPO l'ingresso in quello stato, avvisa Marco "palla a te".
//
// Scelte:
// - Solo avviso: NON cambia lo stato ClickUp (lo stato è la verità, lo muove
//   Marco). Nessuna scrittura nel ledger del meter.
// - Dedup per ciclo di attesa via task_status_seen.client_reply_at, azzerato
//   quando la task cambia stato (lo fa trackStatuses in nudge.ts).
// Blueprint: vault operativo/task-supervisor-architecture.md (strato 2 + §"loop").

import cron from 'node-cron';
import { query } from '../db/index.js';
import { getOpenTasks, getChatMessages, type ClickUpTask } from '../clickup/client.js';
import { supervised } from './scope.js';
import { trackStatuses } from './nudge.js';
import { resolveClient } from '../arm/client_messages.js';

const MARCO_CLICKUP_ID = process.env.CLICKUP_ASSIGNEE_ID ?? '84001538';
const SNIPPET = 160;

function clientName(listName: string): string {
  return listName.replace(/^[^\p{L}\p{N}]+/u, '').trim() || listName;
}
function topic(taskName: string): string {
  return taskName.replace(/^\s*(CR Compliance|CR|Bug Fixing|\[[^\]]+\])\s*[|:]?\s*/i, '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
}
function snip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t;
}

type Reply = { task: ClickUpTask; client: string; channel: 'whatsapp' | 'clickup'; text: string; at: number };

// Ultimo messaggio del cliente su WhatsApp dopo `sinceMs` (non from_me).
async function waReply(userId: number, jid: string, sinceMs: number): Promise<{ text: string; at: number } | null> {
  const rows = await query<{ text: string; ts: string }>(
    `SELECT text, ts FROM wa_messages
     WHERE user_id=$1 AND (chat_jid=$2 OR group_jid=$2) AND from_me=false AND text <> '' AND ts > to_timestamp($3/1000.0)
     ORDER BY ts DESC LIMIT 1`,
    [userId, jid, sinceMs],
  );
  if (!rows[0]) return null;
  return { text: rows[0].text, at: new Date(rows[0].ts).getTime() };
}

// Ultimo messaggio del cliente sul canale Chat [EXT] dopo `sinceMs` (autore != Marco).
async function clickupReply(channelId: string, sinceMs: number): Promise<{ text: string; at: number } | null> {
  let msgs;
  try { msgs = await getChatMessages(channelId); }
  catch (e: any) { console.error(`[step3] chat read ${channelId} fail`, e?.message ?? e); return null; }
  const ext = msgs
    .filter((m) => m.authorId !== MARCO_CLICKUP_ID && m.text.trim() && m.dateMs > sinceMs)
    .sort((a, b) => b.dateMs - a.dateMs);
  return ext[0] ? { text: ext[0].text, at: ext[0].dateMs } : null;
}

// Task in attesa cliente con una risposta nuova non ancora segnalata.
export async function computeClientReplies(userId: number): Promise<Reply[]> {
  const all = supervised(await getOpenTasks()).filter((t) => t.status !== 'cancelled' && t.status !== 'completato');
  await trackStatuses(all);
  const waiting = all.filter((t) => t.status === 'waiting feedback client');
  if (!waiting.length) return [];

  const rows = await query<{ task_id: string; since: string; client_reply_at: string | null }>(
    `SELECT task_id, since, client_reply_at FROM task_status_seen WHERE task_id = ANY($1)`,
    [waiting.map((t) => t.id)],
  );
  const seen = new Map(rows.map((r) => [r.task_id, r]));
  const out: Reply[] = [];
  for (const t of waiting) {
    const s = seen.get(t.id);
    if (!s) continue;
    const client = resolveClient(t.list.id);
    if (!client || !client.channel) continue;
    const sinceMs = new Date(s.since).getTime();
    const alertedMs = s.client_reply_at ? new Date(s.client_reply_at).getTime() : 0;

    let reply: { text: string; at: number } | null = null;
    if (client.channel === 'whatsapp' && client.wa_group_jid) reply = await waReply(userId, client.wa_group_jid, sinceMs);
    else if (client.channel === 'clickup' && client.clickup_channel_id) reply = await clickupReply(client.clickup_channel_id, sinceMs);

    // Nuova solo se arrivata dopo l'ultimo alert di questo ciclo di attesa.
    if (!reply || reply.at <= alertedMs) continue;
    out.push({ task: t, client: clientName(t.list.name), channel: client.channel, text: reply.text, at: reply.at });
  }
  return out;
}

export async function alertClientReplies(userId: number): Promise<{ ok: boolean; count: number }> {
  const replies = await computeClientReplies(userId);
  if (!replies.length) return { ok: true, count: 0 };

  const byClient = new Map<string, Reply[]>();
  for (const r of replies) { const a = byClient.get(r.client) ?? []; a.push(r); byClient.set(r.client, a); }
  const lines = [`📨 Il cliente ha risposto — palla a te (${replies.length}):`];
  for (const [c, rs] of [...byClient].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push('', `▸ ${c}`);
    for (const r of rs) {
      const ch = r.channel === 'whatsapp' ? 'WA' : 'ClickUp';
      lines.push(`   ${topic(r.task.name)} [${ch}]`, `   ↳ "${snip(r.text)}"`, `   ${r.task.url}`);
    }
  }
  const { sendTelegram } = await import('../telegram/bot.js');
  await sendTelegram(userId, lines.join('\n'), 'task-client-reply');

  await query(`UPDATE task_status_seen SET client_reply_at=now() WHERE task_id = ANY($1)`, [replies.map((r) => r.task.id)]);
  return { ok: true, count: replies.length };
}

let started = false;
export function startClientReplyScheduler(): void {
  if (started) return;
  started = true;
  // Ogni ora 9-19 Lun-Ven Europe/Rome: la tempestività è il valore dello step 3.
  cron.schedule('0 9-19 * * 1-5', async () => {
    try {
      const users = await query<{ id: number }>(`SELECT id FROM users`);
      for (const u of users) await alertClientReplies(u.id).catch((e) => console.error('[step3]', e));
    } catch (e) { console.error('[step3] scheduler', e); }
  }, { timezone: 'Europe/Rome' });
  console.log('[supervisor] client-reply scheduler armed (ogni ora 9-19 Lun-Ven Europe/Rome)');
}
