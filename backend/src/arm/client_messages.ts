// The "arm" — Onda 1 of the automation roadmap. Turns ClickUp tasks sitting in
// status "mandare mex cliente" into client update messages, drafted in Marco's
// tone (checklist Liv. 1), approved on Telegram, sent to the client's WhatsApp
// group, then moves the tasks to "waiting feedback client".
//
// SKELETON: the deterministic plumbing is real; the two points that need the
// live ClickUp token + manual testing are marked TODO. Draft text is built by a
// template here — swap in an LLM micro-turn (runClaude) for nicer tone later.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { query } from '../db/index.js';
import { bus } from '../bus.js';
import { isClickUpConfigured, getTasksByStatus, findPreviewLink, setTaskStatus, type ClickUpTask } from '../clickup/client.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const TRIGGER_STATUS = 'mandare mex cliente';
const DONE_STATUS = 'waiting feedback client';

// ── Client → WhatsApp group mapping ────────────────────────────────────────
type ClientMap = {
  clickup_list_id: string;
  clickup_list_name: string;
  wa_group_name: string | null;
  wa_group_jid: string | null;
  verified: boolean;
};

function loadMap(): ClientMap[] {
  const p = path.resolve(__dirname, '../../config/client-wa-map.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (raw.clients ?? []) as ClientMap[];
}

function resolveClient(listId: string): ClientMap | undefined {
  return loadMap().find((c) => c.clickup_list_id === listId);
}

// ── Draft body (template skeleton; checklist Liv. 1 baked in) ───────────────
// Rules from operativo/checklist-messaggio-cliente.md: saluto col tag solo a
// inizio thread, niente trattini, verbi al participio, link preview + avviso
// admin Shopify, emoji leggera in chiusura. TODO: replace with runClaude micro
// turn for natural tone, feeding the checklist note + task descriptions.
function buildDraftBody(client: ClientMap, tasks: ClickUpTask[], previewLink: string | null): string {
  const changes = tasks
    .map((t) => doneLine(t.name))
    .filter(Boolean);
  const lines: string[] = [];
  lines.push(`Buondi!`); // TODO: tag the client group properly (@) once tone-turn is in
  lines.push('');
  lines.push(tasks.length > 1 ? 'Sistemato quanto richiesto:' : 'Fatto:');
  lines.push('');
  for (const c of changes) lines.push(c);
  lines.push('');
  lines.push('Link preview:');
  lines.push(previewLink ?? '{{incolla qui il link preview}}');
  lines.push('(per vederla, accedi prima al tuo admin Shopify e poi apri il link)');
  lines.push('');
  lines.push('Fatemi sapere se va bene così lo mando live 🔥');
  // Checklist forma: niente trattini generati dall'agente.
  return lines.join('\n').replace(/^[\-—]\s*/gm, '');
}

// Rephrase a task title ("CR | PDP - Abilitare autoplay video") into a short
// done-line. Skeleton: strips known prefixes; the LLM turn will do this better.
function doneLine(taskName: string): string {
  return taskName
    .replace(/^\s*(CR|CR Compliance|Bug Fixing|\[[^\]]+\])\s*[|:]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Propose: scan the pile, build one draft per client ──────────────────────
export async function proposeClientMessages(userId: number): Promise<{ created: number; held: number; skipped: number }> {
  if (!isClickUpConfigured()) throw new Error('CLICKUP_API_TOKEN non configurato — non posso leggere le task');

  const tasks = await getTasksByStatus(TRIGGER_STATUS);
  // Group by ClickUp list (= client).
  const byList = new Map<string, ClickUpTask[]>();
  for (const t of tasks) {
    if (!t.list?.id) continue;
    const arr = byList.get(t.list.id) ?? [];
    arr.push(t);
    byList.set(t.list.id, arr);
  }

  let created = 0, held = 0, skipped = 0;
  for (const [listId, listTasks] of byList) {
    const client = resolveClient(listId);
    if (!client) { skipped++; continue; }

    // Preview link: newest one found across the batched tasks' comments.
    let previewLink: string | null = null;
    for (const t of listTasks) {
      previewLink = await findPreviewLink(t.id).catch(() => null);
      if (previewLink) break;
    }

    const verified = client.verified && !!client.wa_group_jid;
    const body = buildDraftBody(client, listTasks, previewLink);
    const status = verified ? 'pending' : 'held';

    const rows = await query<{ id: number }>(
      `INSERT INTO client_msg_drafts(user_id, clickup_list_id, client_name, wa_group_jid, task_ids, body, preview_link, status)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
      [userId, listId, client.clickup_list_name, client.wa_group_jid, JSON.stringify(listTasks.map((t) => t.id)), body, previewLink, status],
    );
    const id = rows[0]?.id;
    bus.emit('client_msg:created', { userId, id, status });

    if (verified) {
      try {
        const { sendClientMsgKeyboard } = await import('../telegram/bot.js');
        const sent = await sendClientMsgKeyboard(userId, { id, client_name: client.clickup_list_name, body, held: false });
        if (sent) await query(`UPDATE client_msg_drafts SET telegram_message_id=$1, telegram_chat_id=$2 WHERE id=$3`, [sent.message_id, sent.chat_id, id]);
      } catch (e: any) { console.error('[arm] tg send failed', e?.message ?? e); }
      created++;
    } else {
      // Held: tell Marco the mapping is missing so he can fix client-wa-map.json.
      try {
        const { sendClientMsgKeyboard } = await import('../telegram/bot.js');
        await sendClientMsgKeyboard(userId, { id, client_name: client.clickup_list_name, body, held: true });
      } catch {}
      held++;
    }
  }
  return { created, held, skipped };
}

// ── Approve: send to WhatsApp, move ClickUp tasks ───────────────────────────
export async function approveClientMsg(userId: number, id: number, editedBody?: string): Promise<{ ok: boolean; error?: string }> {
  const rows = await query<any>(`SELECT * FROM client_msg_drafts WHERE id=$1 AND user_id=$2`, [id, userId]);
  const d = rows[0];
  if (!d) return { ok: false, error: 'draft non trovata' };
  if (d.status === 'sent') return { ok: true };
  if (d.status !== 'pending') return { ok: false, error: `stato ${d.status}` };
  if (!d.wa_group_jid) return { ok: false, error: 'nessun gruppo WhatsApp mappato' };

  const finalBody = (editedBody ?? d.body) as string;
  if (editedBody && editedBody !== d.body) {
    await query(`UPDATE client_msg_drafts SET body_edited=$1 WHERE id=$2`, [editedBody, id]); // graduation signal
  }

  const { sendWaMessage } = await import('../connectors/builtin/whatsapp/index.js');
  const res = await sendWaMessage(userId, d.wa_group_jid, finalBody, 'agent', 'ai');
  if (!res.ok) {
    await query(`UPDATE client_msg_drafts SET status='error', error=$1 WHERE id=$2`, [res.error ?? 'send failed', id]);
    return { ok: false, error: res.error };
  }

  // Move every batched task to "waiting feedback client". Best-effort per task.
  const taskIds: string[] = Array.isArray(d.task_ids) ? d.task_ids : [];
  for (const tid of taskIds) {
    try { await setTaskStatus(tid, DONE_STATUS); }
    catch (e: any) { console.error(`[arm] setTaskStatus ${tid} failed`, e?.message ?? e); }
  }

  await query(`UPDATE client_msg_drafts SET status='sent', sent_at=now(), decided_at=now() WHERE id=$1`, [id]);
  bus.emit('client_msg:sent', { userId, id });
  return { ok: true };
}

export async function denyClientMsg(userId: number, id: number): Promise<void> {
  await query(`UPDATE client_msg_drafts SET status='denied', decided_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('pending','held')`, [id, userId]);
  bus.emit('client_msg:denied', { userId, id });
}
