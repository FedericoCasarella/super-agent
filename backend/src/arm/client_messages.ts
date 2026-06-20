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

    const verified = client.verified && !!client.wa_group_jid;
    // Tone via Claude; deterministic template as fallback if the turn fails.
    const body = await draftBodyLLM(userId, client, listTasks, previewLink)
      .catch((e) => { console.error('[arm] draftBodyLLM fallback', e?.message ?? e); return buildDraftBody(client, listTasks, previewLink); });
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
