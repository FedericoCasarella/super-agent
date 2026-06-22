// File ingestion — upload da UI con un prompt. Il file viene salvato su disco
// (streaming, niente limite Telegram 20MB), poi un run Claude lo legge dal path
// e lo elabora secondo il prompt. A fine invia un messaggio Telegram così la
// conversazione prosegue lì.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { getVaultRoot } from '../brain/vault.js';
import { sendTelegram } from '../telegram/bot.js';

export const INGEST_ROOT = path.join(os.homedir(), 'super-agent-ingest');

export async function ensureIngestRoot(): Promise<string> {
  await fs.mkdir(INGEST_ROOT, { recursive: true });
  return INGEST_ROOT;
}

export type Ingestion = {
  id: number; filename: string; path: string; size_bytes: number;
  prompt: string; status: 'processing' | 'done' | 'error'; result: string | null;
  error: string | null; created_at: string; done_at: string | null;
};

export async function listIngestions(userId: number): Promise<Ingestion[]> {
  return await query<Ingestion>(
    `SELECT id::int, filename, path, size_bytes::bigint, prompt, status, result, error, created_at, done_at
     FROM file_ingestions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );
}

// Create the row + kick off async processing. Returns immediately.
export async function createIngestion(userId: number, opts: { filename: string; absPath: string; sizeBytes: number; prompt: string }): Promise<Ingestion> {
  const rows = await query<Ingestion>(
    `INSERT INTO file_ingestions(user_id, filename, path, size_bytes, prompt, status)
     VALUES($1,$2,$3,$4,$5,'processing')
     RETURNING id::int, filename, path, size_bytes::bigint, prompt, status, result, error, created_at, done_at`,
    [userId, opts.filename, opts.absPath, opts.sizeBytes, opts.prompt],
  );
  const ing = rows[0];
  // Fire-and-forget — the HTTP response returns now, processing continues.
  void processIngestion(userId, ing.id).catch((e) => console.error('[ingest] process error', e));
  return ing;
}

async function processIngestion(userId: number, id: number): Promise<void> {
  const rows = await query<Ingestion>(`SELECT id::int, filename, path, prompt FROM file_ingestions WHERE id=$1 AND user_id=$2`, [id, userId]);
  const ing = rows[0];
  if (!ing) return;
  const vault = await getVaultRoot(userId);
  const mb = 0;
  const prompt = [
    `Hai un FILE caricato dall'utente da elaborare. NON è su Telegram (troppo grande), è sul disco.`,
    `File: ${ing.filename}`,
    `Percorso assoluto: ${ing.path}`,
    ``,
    `ISTRUZIONI DELL'UTENTE:`,
    ing.prompt,
    ``,
    `Come procedere:`,
    `- Leggi il file dal percorso assoluto con lo strumento Read (PDF e testo sono nativi). Se è enorme, usa Bash (pdftotext, head, grep, python) per estrarne il testo a chunk invece di caricarlo tutto in una volta.`,
    `- Esegui ciò che chiede l'utente. Se ha senso, scrivi i risultati come nota/e nel brain (markdown, collega con related:).`,
    `- Alla fine restituisci SOLO un riepilogo conciso (3-6 righe) di cosa hai fatto e dove (path note brain). Questo riepilogo va all'utente su Telegram.`,
  ].join('\n');
  let status: 'done' | 'error' = 'done';
  let result = '';
  let errMsg: string | null = null;
  try {
    const res = await runClaude(userId, prompt, { cwd: vault ?? process.cwd(), timeoutMs: 1_800_000, kind: 'file-ingest', meta: { ingestionId: id, file: ing.filename } });
    if (!res.ok) { status = 'error'; errMsg = res.stderr?.slice(0, 800) || 'agent error'; }
    else result = (res.text ?? '').trim();
  } catch (e: any) {
    status = 'error'; errMsg = String(e?.message ?? e).slice(0, 800);
  }
  await query(
    `UPDATE file_ingestions SET status=$3, result=$4, error=$5, done_at=now() WHERE id=$1 AND user_id=$2`,
    [id, userId, status, result || null, errMsg],
  );
  // Telegram notify — la conversazione prosegue lì.
  try {
    if (status === 'done') {
      await sendTelegram(userId, `📥 *File ingerito:* ${ing.filename}\n\n${result || 'Fatto.'}\n\nContinuiamo qui — dimmi cosa vuoi farci.`, 'ingest');
    } else {
      await sendTelegram(userId, `📥 *Ingestion fallita:* ${ing.filename}\n${errMsg ?? 'errore'}`, 'ingest');
    }
  } catch (e) { console.error('[ingest] telegram notify failed', e); }
}
