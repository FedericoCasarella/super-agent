// Tone Mirror — routine di FINE GIORNATA (non è un perk). Ogni sera rilegge la
// conversazione del giorno e aggiorna AUTONOMAMENTE il proprio tono di voce per
// somigliare sempre più all'utente. Aggiorna `meta/user-profile.md`, che
// buildSystemContext inietta come "LIVE USER BEHAVIORAL PROFILE (MIRROR this
// tone)". Nessun messaggio all'utente: è auto-tuning silenzioso.

import { query } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { getVaultRoot, readNote } from '../brain/vault.js';

const MIN_USER_MSGS = 4; // sotto questa soglia la giornata non ha abbastanza segnale

export async function runToneMirror(userId: number): Promise<{ ok: boolean; updated?: boolean; reason?: string; error?: string }> {
  const vault = await getVaultRoot(userId);
  if (!vault) return { ok: false, error: 'no vault' };

  // Messaggi di OGGI (fuso Europe/Rome), in ordine.
  const msgs = await query<{ direction: string; content: string }>(
    `SELECT direction, content FROM messages
     WHERE user_id=$1 AND channel='telegram'
       AND ts AT TIME ZONE 'Europe/Rome' >= (now() AT TIME ZONE 'Europe/Rome')::date
     ORDER BY id ASC`,
    [userId],
  );
  const userMsgs = msgs.filter((m) => m.direction === 'in');
  if (userMsgs.length < MIN_USER_MSGS) return { ok: true, updated: false, reason: 'pochi messaggi oggi' };

  // Trascritto del giorno (cap a ~10k char dai più recenti).
  let convo = msgs.map((m) => `${m.direction === 'in' ? 'UTENTE' : 'TU'}: ${m.content}`).join('\n');
  if (convo.length > 10_000) convo = convo.slice(convo.length - 10_000);

  const current = (await readNote(userId, 'meta/user-profile.md').catch(() => null))?.content?.trim() ?? '';

  const prompt = [
    `Sei l'AI advisor dell'utente. Fai il TONE MIRROR di fine giornata: rendi il TUO modo di parlare sempre più simile a quello dell'utente.`,
    ``,
    `=== PROFILO TONO ATTUALE (meta/user-profile.md) ===`,
    current || '(vuoto — è la prima analisi)',
    ``,
    `=== CONVERSAZIONE DI OGGI ===`,
    convo,
    ``,
    `FAI:`,
    `1) Analizza il TONO DI VOCE dell'UTENTE: lessico ricorrente, lunghezza tipica delle frasi, uso (o no) di emoji, slang/dialetto, livello di formalità, punteggiatura, energia, modi di dire, come apre/chiude i messaggi, parolacce/ironia.`,
    `2) AGGIORNA il file \`meta/user-profile.md\` con la sezione "## Tone of voice" che descriva COME parla l'utente, con esempi concreti di parole e formati che usa, così da rispecchiarlo nelle tue risposte. Raffina/integra ciò che già c'è (NON cancellare info utili di altre sezioni). Evolvi gradualmente: piccoli aggiustamenti basati su oggi, non stravolgere.`,
    `3) Scrivi il file con il tool Write (path esatto: meta/user-profile.md).`,
    ``,
    `NON scrivere NULLA all'utente su Telegram. Output finale: il token \`SKIP\` e nulla più.`,
  ].join('\n');

  const res = await runClaude(userId, prompt, { cwd: vault, timeoutMs: 180_000, kind: 'tone-mirror' });
  if (!res.ok) return { ok: false, error: res.stderr || 'agent error' };
  return { ok: true, updated: true };
}
