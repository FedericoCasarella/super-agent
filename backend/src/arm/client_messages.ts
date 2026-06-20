// The "arm" — Onda 1 of the automation roadmap. Turns ClickUp tasks sitting in
// status "mandare mex cliente" into client update messages, drafted in Marco's
// tone (checklist Liv. 1), approved on Telegram, sent to the client's WhatsApp
// group, then moves the tasks to "waiting feedback client".
//
// SKELETON: the deterministic plumbing is real; the two points that need the
// live ClickUp token + manual testing are marked TODO. Draft text is built by a
// template here — swap in an LLM micro-turn (runClaude) for nicer tone later.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import cron from 'node-cron';
import { query } from '../db/index.js';
import { bus } from '../bus.js';
import { runClaude } from '../claude/runner.js';
import { getVaultRoot } from '../brain/vault.js';
import { isClickUpConfigured, getTasksByStatus, findPreviewLink, setTaskStatus, type ClickUpTask } from '../clickup/client.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const PREVIEW_PLACEHOLDER = '{{incolla qui il link preview}}';

// Few-shot: messaggi VERI di Marco (anonimizzati) per trasmettere il registro
// reale — corto, sbrigativo, energico — che la sola checklist non passa.
const TONE_EXAMPLES = `Esempio A:
Buondi @cliente! Abbiamo corretto i bug che ci hai segnalato

Link anteprima:
https://...shopifypreview.com/pages/sillage

Fatemi sapere se va bene

Esempio B:
Abbiamo corretto su questo link:
Icona ricerca su mobile
Prezzo in rosso nelle pagine gender
https://...shopifypreview.com

Esempio C:
Buondi @cliente! qui l'anteprima del banner informativo, visibile su tutti i prodotti tranne quelli col checkbox. Fatemi sapere se va bene così lo mando live 🔥
https://...shopifypreview.com`;

// Read the live checklist from Marco's vault so he can tune the tone there
// without touching code. Falls back to null if the note is missing.
async function loadChecklist(userId: number): Promise<string | null> {
  try {
    const root = await getVaultRoot(userId);
    if (!root) return null;
    return await fsp.readFile(path.join(root, 'operativo/checklist-messaggio-cliente.md'), 'utf8');
  } catch { return null; }
}

// Generate the message in Marco's tone via a focused Claude turn. Self-contained
// prompt (no tools, no vault cwd) — just the checklist + task data in, message
// text out. Throws on empty/failed output so the caller can fall back to the
// deterministic template.
// Deterministic check: does the task text actually describe the change, or is
// it empty / just an external link (e.g. a Google Doc with the real details)?
// Strips boilerplate + URLs; if little prose remains, there's nothing concrete
// to report and the model must NOT invent.
function taskForPrompt(t: ClickUpTask, idx: number): string {
  const raw = (t.text_content ?? '').trim();
  const prose = raw
    .replace(/descrizione task/gi, '')
    .replace(/documento con[^\n]*/gi, '')
    .replace(/google doc/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (prose.length < 25) {
    return `Task ${idx + 1}: ${t.name}\n[SENZA descrizione concreta — solo titolo o link esterno. NON inventare la modifica: scrivi {{descrivi le modifiche}}]`;
  }
  return `Task ${idx + 1}: ${t.name}\n${raw.slice(0, 800)}`;
}

async function draftBodyLLM(userId: number, client: ClientMap, tasks: ClickUpTask[], previewLink: string | null): Promise<string> {
  const checklist = await loadChecklist(userId);
  const taskBlock = tasks.map((t, i) => taskForPrompt(t, i)).join('\n\n');
  const prompt = [
    'Sei l\'assistente di Marco Orsi (Shopify dev). Scrivi UN messaggio WhatsApp di update per il cliente, riformulando le richieste come LAVORO COMPLETATO.',
    '',
    checklist ? `Segui ALLA LETTERA questa checklist:\n\n${checklist}` : 'Regole: niente trattini, verbi al participio, link preview con avviso admin Shopify, una emoji leggera in chiusura, saluto solo a inizio thread.',
    '',
    'IMITA ESATTAMENTE il registro di questi messaggi veri di Marco: corto, diretto, sbrigativo, energico. VIETATO suonare formali o impostati — niente "Ti informo che", "abbiamo provveduto a", "restiamo a disposizione", niente frasi lunghe o educate. Scrivi come scrive lui.',
    '',
    TONE_EXAMPLES,
    '',
    `Cliente: ${client.clickup_list_name}. Numero di modifiche: ${tasks.length}.`,
    `Link preview da usare: ${previewLink ?? PREVIEW_PLACEHOLDER}`,
    '',
    'Dati delle task (la "Richiesta" descrive cosa fare → riformulala come fatto, NON inventare nulla che non sia qui):',
    taskBlock,
    '',
    'REGOLA ANTI-INVENZIONE (critica): se una task ha descrizione vuota o troppo generica per sapere COSA CONCRETAMENTE è stato fatto (es. "ottimizzazioni CRO settimanali"), NON inventare la modifica. Al suo posto scrivi il segnaposto {{descrivi le modifiche}} e basta. Meglio un segnaposto che Marco compila, che un messaggio sicuro ma sbagliato.',
    '',
    'Output: SOLO il testo del messaggio, pronto da inviare. Nessun preambolo, nessun markdown, nessuna spiegazione.',
    'Il messaggio FINISCE con la riga di chiusura. NON aggiungere dopo: separatori (---), note per Marco, commenti o spiegazioni. Quello che scrivi va dritto al cliente.',
  ].join('\n');

  const res = await runClaude(userId, prompt, { kind: 'client-msg-draft', timeoutMs: 120_000 });
  let text = (res.text ?? '').trim();
  if (!res.ok || !text || text === 'SKIP') throw new Error(`draft LLM vuoto (ok=${res.ok})`);
  // Strip any model meta-commentary appended after the message (a "---" rule or
  // a "Nota:" block addressed to Marco) — it must never reach the client.
  text = text.split(/\n\s*---\s*\n/)[0];
  text = text.replace(/\n+\**\s*(nota|note|n\.b\.?)\b[\s\S]*$/i, '');
  // Safety net for the checklist form rules even if the model slips.
  return text.replace(/^[\-—]\s*/gm, '').trim();
}

const TRIGGER_STATUS = 'mandare mex cliente';
const DONE_STATUS = 'waiting feedback client';

// ── Finestra di invio: Lun-Ven 9:00-18:30 Europe/Rome ───────────────────────
const TZ = 'Europe/Rome';
const OPEN_MIN = 9 * 60;        // 09:00
const CLOSE_MIN = 18 * 60 + 30; // 18:30
const DAY_IT = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];

// Rome-local weekday (0=Mon..6=Sun) and minutes-of-day for a given instant.
function romeNow(d = new Date()): { dow: number; min: number } {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const wd = p.find((x) => x.type === 'weekday')?.value ?? 'Mon';
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
  const hh = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
  const mm = Number(p.find((x) => x.type === 'minute')?.value ?? 0);
  return { dow, min: hh * 60 + mm };
}

export function inSendWindow(d = new Date()): boolean {
  const { dow, min } = romeNow(d);
  return dow <= 4 && min >= OPEN_MIN && min <= CLOSE_MIN;
}

// Human label for when a queued message will go out (the flusher opens at 9:00).
function nextOpenLabel(d = new Date()): string {
  const { dow, min } = romeNow(d);
  if (dow <= 4 && min < OPEN_MIN) return 'oggi alle 9:00';
  for (let i = 1; i <= 7; i++) {
    const nd = (dow + i) % 7;
    if (nd <= 4) return `${DAY_IT[nd]} alle 9:00`;
  }
  return 'lunedì alle 9:00';
}

// ── Client → WhatsApp group mapping ────────────────────────────────────────
export type ClientMap = {
  clickup_list_id: string;
  clickup_list_name: string;
  channel: 'whatsapp' | 'clickup' | null;
  clickup_channel_id?: string | null;
  wa_group_name: string | null;
  wa_group_jid: string | null;
  verified: boolean;
};

// Is this client ready for real sending? WhatsApp needs a group jid; ClickUp
// needs the [EXT] chat channel id.
function isReady(c: ClientMap): boolean {
  if (!c.verified) return false;
  if (c.channel === 'whatsapp') return !!c.wa_group_jid;
  if (c.channel === 'clickup') return !!c.clickup_channel_id;
  return false;
}

function loadMap(): ClientMap[] {
  const p = path.resolve(__dirname, '../../config/client-wa-map.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (raw.clients ?? []) as ClientMap[];
}

export function resolveClient(listId: string): ClientMap | undefined {
  return loadMap().find((c) => c.clickup_list_id === listId);
}

// Invia un testo sul canale del cliente (WhatsApp o ClickUp Chat [EXT]).
// Riusato sia dal braccio sia dall'auto-follow-up del supervisore.
export async function sendOnChannel(userId: number, client: ClientMap, text: string): Promise<{ ok: boolean; error?: string }> {
  if (client.channel === 'whatsapp') {
    if (!client.wa_group_jid) return { ok: false, error: 'nessun gruppo WhatsApp' };
    const { sendWaMessage } = await import('../connectors/builtin/whatsapp/index.js');
    return sendWaMessage(userId, client.wa_group_jid, text, 'agent', 'ai');
  }
  if (client.channel === 'clickup') {
    if (!client.clickup_channel_id) return { ok: false, error: 'nessun canale Chat ClickUp' };
    const { createChatMessage } = await import('../clickup/client.js');
    try { await createChatMessage(client.clickup_channel_id, text); return { ok: true }; }
    catch (e: any) { return { ok: false, error: e?.message ?? 'chat failed' }; }
  }
  return { ok: false, error: 'canale non configurato' };
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
  lines.push(previewLink ?? PREVIEW_PLACEHOLDER);
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

    const ready = isReady(client);
    // Tone via Claude; deterministic template as fallback if the turn fails.
    const body = await draftBodyLLM(userId, client, listTasks, previewLink)
      .catch((e) => { console.error('[arm] draftBodyLLM fallback', e?.message ?? e); return buildDraftBody(client, listTasks, previewLink); });
    const status = ready ? 'pending' : 'held';

    const rows = await query<{ id: number }>(
      `INSERT INTO client_msg_drafts(user_id, clickup_list_id, client_name, wa_group_jid, task_ids, body, preview_link, status)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
      [userId, listId, client.clickup_list_name, client.wa_group_jid, JSON.stringify(listTasks.map((t) => t.id)), body, previewLink, status],
    );
    const id = rows[0]?.id;
    bus.emit('client_msg:created', { userId, id, status });

    const dest = client.channel === 'clickup' ? 'commento ClickUp' : client.channel === 'whatsapp' ? (client.wa_group_name ?? 'WhatsApp') : null;
    try {
      const { sendClientMsgKeyboard } = await import('../telegram/bot.js');
      const sent = await sendClientMsgKeyboard(userId, { id, client_name: client.clickup_list_name, body, held: !ready, dest });
      if (sent && ready) await query(`UPDATE client_msg_drafts SET telegram_message_id=$1, telegram_chat_id=$2 WHERE id=$3`, [sent.message_id, sent.chat_id, id]);
    } catch (e: any) { console.error('[arm] tg send failed', e?.message ?? e); }
    if (ready) created++; else held++;
  }
  return { created, held, skipped };
}

// ── Send (shared by approve-in-window and the queue flusher) ────────────────
async function dispatchSend(userId: number, d: any, finalBody: string): Promise<{ ok: boolean; error?: string }> {
  const client = resolveClient(d.clickup_list_id);
  const channel = client?.channel ?? (d.wa_group_jid ? 'whatsapp' : null);
  const taskIds: string[] = Array.isArray(d.task_ids) ? d.task_ids : [];

  if (channel === 'whatsapp') {
    if (!d.wa_group_jid) return { ok: false, error: 'nessun gruppo WhatsApp mappato' };
    const { sendWaMessage } = await import('../connectors/builtin/whatsapp/index.js');
    const res = await sendWaMessage(userId, d.wa_group_jid, finalBody, 'agent', 'ai');
    if (!res.ok) {
      await query(`UPDATE client_msg_drafts SET status='error', error=$1 WHERE id=$2`, [res.error ?? 'send failed', d.id]);
      return { ok: false, error: res.error };
    }
  } else if (channel === 'clickup') {
    const channelId = client?.clickup_channel_id;
    if (!channelId) return { ok: false, error: 'nessun canale Chat ClickUp mappato' };
    const { createChatMessage } = await import('../clickup/client.js');
    try { await createChatMessage(channelId, finalBody); }
    catch (e: any) {
      await query(`UPDATE client_msg_drafts SET status='error', error=$1 WHERE id=$2`, [e?.message ?? 'chat failed', d.id]);
      return { ok: false, error: e?.message ?? 'chat failed' };
    }
  } else {
    return { ok: false, error: 'canale non configurato' };
  }

  // Move every batched task to "waiting feedback client". Best-effort per task.
  for (const tid of taskIds) {
    try { await setTaskStatus(tid, DONE_STATUS); }
    catch (e: any) { console.error(`[arm] setTaskStatus ${tid} failed`, e?.message ?? e); }
  }
  await query(`UPDATE client_msg_drafts SET status='sent', sent_at=now(), decided_at=COALESCE(decided_at, now()) WHERE id=$1`, [d.id]);
  bus.emit('client_msg:sent', { userId, id: d.id });
  return { ok: true };
}

// ── Approve: invia subito se in finestra, altrimenti metti in coda ──────────
export async function approveClientMsg(userId: number, id: number, editedBody?: string): Promise<{ ok: boolean; error?: string; queued?: boolean; when?: string }> {
  const rows = await query<any>(`SELECT * FROM client_msg_drafts WHERE id=$1 AND user_id=$2`, [id, userId]);
  const d = rows[0];
  if (!d) return { ok: false, error: 'draft non trovata' };
  if (d.status === 'sent') return { ok: true };
  if (d.status !== 'pending' && d.status !== 'queued') return { ok: false, error: `stato ${d.status}` };

  const finalBody = (editedBody ?? d.body) as string;
  if (editedBody && editedBody !== d.body) {
    // Persisti la modifica (la usa anche il flusher) + segnale di graduazione.
    await query(`UPDATE client_msg_drafts SET body=$1, body_edited=$1 WHERE id=$2`, [editedBody, id]);
    d.body = editedBody;
  }

  // Fuori dalla finestra Lun-Ven 9:00-18:30 → coda, parte all'apertura.
  if (!inSendWindow()) {
    await query(`UPDATE client_msg_drafts SET status='queued', decided_at=now() WHERE id=$1`, [id]);
    bus.emit('client_msg:queued', { userId, id });
    return { ok: true, queued: true, when: nextOpenLabel() };
  }
  return dispatchSend(userId, d, finalBody);
}

// ── Queue flusher: svuota la coda quando la finestra è aperta ────────────────
export async function flushQueued(userId: number): Promise<number> {
  if (!inSendWindow()) return 0;
  const rows = await query<any>(`SELECT * FROM client_msg_drafts WHERE user_id=$1 AND status='queued' ORDER BY id`, [userId]);
  let sent = 0;
  for (const d of rows) {
    const r = await dispatchSend(userId, d, d.body);
    if (r.ok) {
      sent++;
      try {
        const { sendTelegram } = await import('../telegram/bot.js');
        await sendTelegram(userId, `📤 Inviato (era in coda): ${d.client_name}`);
      } catch {}
    }
  }
  return sent;
}

let cronStarted = false;
export function startClientMsgScheduler(): void {
  if (cronStarted) return;
  cronStarted = true;
  // Ogni 10 minuti; agisce solo dentro la finestra Lun-Ven 9:00-18:30 Europe/Rome.
  cron.schedule('*/10 * * * *', async () => {
    if (!inSendWindow()) return;
    try {
      const users = await query<{ user_id: number }>(`SELECT DISTINCT user_id FROM client_msg_drafts WHERE status='queued'`);
      for (const u of users) await flushQueued(u.user_id).catch((e) => console.error('[arm] flush', e));
    } catch (e) { console.error('[arm] scheduler', e); }
  });
  console.log('[arm] client-message scheduler armed (flush coda, finestra Lun-Ven 9:00-18:30 Europe/Rome)');
}

export async function denyClientMsg(userId: number, id: number): Promise<void> {
  await query(`UPDATE client_msg_drafts SET status='denied', decided_at=now() WHERE id=$1 AND user_id=$2 AND status IN ('pending','held')`, [id, userId]);
  bus.emit('client_msg:denied', { userId, id });
}
