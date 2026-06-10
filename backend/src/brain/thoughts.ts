// Thought Analyzer core.
// A+C: ogni pensiero viene (A) analizzato — tema, emozione, loop — e (C) trasformato
// in un nodo connesso nel vault con backlink alle sinapsi esistenti.
//
// Principio di robustezza: la CATTURA e' DB-first e deterministica (zero latenza,
// mai dipendente dall'LLM). L'analisi leggera e' un singolo runClaude({useMcp:false})
// asincrono: se fallisce, il pensiero resta in DB (analyzed=false) e il digest serale
// lo recupera comunque. L'ack istantaneo non aspetta mai il modello.

import { query } from '../db/index.js';
import { runClaude } from '../claude/runner.js';
import { writeNote } from './vault.js';

export type ThoughtRow = {
  id: number;
  user_id: number;
  ts: string;
  text: string;
  src: string;
  emotion: string | null;
  themes: string[];
  backlinks: string[];
  vault_path: string | null;
  analyzed: boolean;
  digested_on: string | null;
};

export type LightAnalysis = {
  emotion: string;
  themes: string[];
  backlinks: string[];   // titoli scelti tra i candidati
  loop_hint?: string;    // se il modello nota un possibile ritorno su un tema
};

// ── Cattura (deterministica, instant) ────────────────────────────────────────
export async function captureThought(userId: number, text: string, src = 'telegram'): Promise<{ id: number }> {
  const rows = await query<{ id: number }>(
    `INSERT INTO thoughts(user_id, text, src) VALUES($1, $2, $3) RETURNING id::int`,
    [userId, text.trim(), src],
  );
  return { id: rows[0].id };
}

// ── Candidati backlink (zero LLM: match keyword su brain_index) ───────────────
// Estrae i token significativi del pensiero e cerca note il cui titolo/summary/tag
// li contiene. Ritorna i titoli (max `limit`) — l'analisi sceglie quali tenere.
const STOPWORDS = new Set([
  'che','non','con','per','una','uno','del','della','delle','dei','degli','come','più','piu',
  'sono','essere','questo','questa','quello','quella','anche','ancora','perché','perche','molto',
  'tutto','tutti','fare','faccio','devo','voglio','ho','mi','si','se','ma','le','la','il','lo','gli',
  'the','and','for','that','this','with','have','are','was','but','not','you','your','i','to','of','a','in','is','it',
]);

function keywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-zàèéìòù0-9]+/i)) {
    const w = raw.trim();
    if (w.length < 4 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}

export async function candidateBacklinks(userId: number, text: string, limit = 8): Promise<string[]> {
  const kws = keywords(text);
  if (!kws.length) return [];
  // ILIKE-any over title/summary, plus tag overlap. One query, ranked by hit-count.
  const pattern = kws.map((k) => `%${k}%`);
  const rows = await query<{ title: string; hits: number }>(
    `SELECT title,
            ( (SELECT count(*) FROM unnest($2::text[]) p WHERE coalesce(title,'') ILIKE p)
            + (SELECT count(*) FROM unnest($2::text[]) p WHERE coalesce(summary,'') ILIKE p) ) AS hits
     FROM brain_index
     WHERE user_id=$1 AND title IS NOT NULL AND length(title) > 0
       AND ( coalesce(title,'') ILIKE ANY($2::text[]) OR coalesce(summary,'') ILIKE ANY($2::text[]) )
     ORDER BY hits DESC, length(title) ASC
     LIMIT $3`,
    [userId, pattern, limit],
  );
  return rows.map((r) => r.title).filter(Boolean);
}

// ── Parsing JSON robusto (il CLI a volte avvolge in prosa o ```json) ──────────
function parseJsonLoose<T>(raw: string): T | null {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { return null; }
}

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'pensiero';
}

// Data LOCALE (YYYY-MM-DD) — coerente con lo scheduler (getHours locale) e con
// Postgres now()::date in TZ di sistema. toISOString() darebbe la data UTC, che
// vicino a mezzanotte non combacia con l'ora locale del filename.
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Serializzazione per-utente ────────────────────────────────────────────────
// L'analisi leggera fa spawn di `claude` (pesante). Sotto burst (thought-mode ON +
// piu messaggi rapidi) N spawn paralleli stresserebbero la macchina. Catena 1-per-utente:
// le analisi si accodano, i follow-up arrivano in ordine, la pressione resta limitata.
const analyzeChain = new Map<number, Promise<any>>();

export function analyzeThoughtLight(userId: number, id: number, text: string): Promise<{ ok: boolean; analysis?: LightAnalysis; vaultPath?: string; error?: string }> {
  const prev = analyzeChain.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => analyzeThoughtCore(userId, id, text));
  analyzeChain.set(userId, next.catch(() => {}).finally(() => {
    if (analyzeChain.get(userId) === next) analyzeChain.delete(userId);
  }) as Promise<any>);
  return next;
}

// ── Analisi leggera real-time (1 runClaude, no MCP, degrada con grazia) ───────
async function analyzeThoughtCore(userId: number, id: number, text: string): Promise<{ ok: boolean; analysis?: LightAnalysis; vaultPath?: string; error?: string }> {
  let candidates: string[] = [];
  try { candidates = await candidateBacklinks(userId, text); } catch (e) { console.error('[thoughts] candidates failed', e); }

  const prompt = [
    'Sei un analista di pensieri. Ricevi UN pensiero grezzo e lo classifichi.',
    'Rispondi SOLO con JSON valido, nessun altro testo, in questo schema:',
    '{"emotion":"<una parola/breve frase, es. ansia operativa>","themes":["<1-3 temi brevi>"],"backlinks":["<0-3 titoli SCELTI ESATTAMENTE dalla lista candidati, se pertinenti>"],"loop_hint":"<opzionale: se sembra un ritorno su un tema gia visto, 1 frase, altrimenti ometti>"}',
    '',
    `PENSIERO:\n"""${text.slice(0, 2000)}"""`,
    '',
    candidates.length
      ? `CANDIDATI BACKLINK (scegli solo titoli da qui, copiandoli esatti; [] se nessuno pertinente):\n${candidates.map((c) => `- ${c}`).join('\n')}`
      : 'CANDIDATI BACKLINK: nessuno (usa [] per backlinks).',
  ].join('\n');

  let analysis: LightAnalysis | null = null;
  try {
    const res = await runClaude(userId, prompt, { useMcp: false, timeoutMs: 45_000, kind: 'thought-light', meta: { thoughtId: id } });
    if (res.ok) analysis = parseJsonLoose<LightAnalysis>(res.text);
  } catch (e: any) {
    console.error('[thoughts] analyzeLight runClaude failed', e);
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (!analysis) return { ok: false, error: 'analysis: unparseable' };

  // Sanitize + intersect backlinks con i candidati reali (il modello non inventa note)
  const candSet = new Set(candidates);
  const emotion = (analysis.emotion ?? '').toString().slice(0, 80) || 'neutro';
  const themes = Array.isArray(analysis.themes) ? analysis.themes.map((t) => String(t).slice(0, 60)).slice(0, 3) : [];
  const backlinks = Array.isArray(analysis.backlinks)
    ? analysis.backlinks.map((b) => String(b)).filter((b) => candSet.has(b)).slice(0, 3)
    : [];
  const loopHint = analysis.loop_hint ? String(analysis.loop_hint).slice(0, 200) : undefined;

  // (C) nodo vault connesso
  let vaultPath: string | undefined;
  try {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const day = localDay(now);
    const rel = `thoughts/${day}-${hhmm}-${slugify(themes[0] ?? text)}.md`;
    const related = backlinks.map((b) => `[[${b}]]`);
    const body = [
      text.trim(),
      '',
      '---',
      `**Emozione:** ${emotion}`,
      themes.length ? `**Temi:** ${themes.join(', ')}` : '',
      loopHint ? `**Loop:** ${loopHint}` : '',
      related.length ? `**Collegato a:** ${related.join(' · ')}` : '',
    ].filter(Boolean).join('\n');
    vaultPath = await writeNote(userId, rel, {
      kind: 'thought',
      title: themes[0] ?? text.slice(0, 50),
      source: 'telegram',
      emotion,
      themes,
      related,
      visibility: 'protected',
      ts: now.toISOString(),
    }, body);
    // store relative path (writeNote returns absolute)
    vaultPath = rel;
  } catch (e) {
    console.error('[thoughts] writeNote failed', e);
  }

  await query(
    `UPDATE thoughts SET emotion=$2, themes=$3::jsonb, backlinks=$4::jsonb, vault_path=$5, analyzed=true WHERE id=$1`,
    [id, emotion, JSON.stringify(themes), JSON.stringify(backlinks), vaultPath ?? null],
  );

  return { ok: true, analysis: { emotion, themes, backlinks, loop_hint: loopHint }, vaultPath };
}

// ── Letture ──────────────────────────────────────────────────────────────────
export async function thoughtsToday(userId: number): Promise<ThoughtRow[]> {
  return query<ThoughtRow>(
    `SELECT id::int, user_id::int, ts, text, src, emotion, themes, backlinks, vault_path, analyzed, digested_on
     FROM thoughts WHERE user_id=$1 AND ts::date = now()::date ORDER BY ts ASC`,
    [userId],
  );
}

export async function thoughtsLastDays(userId: number, days = 7): Promise<ThoughtRow[]> {
  return query<ThoughtRow>(
    `SELECT id::int, user_id::int, ts, text, src, emotion, themes, backlinks, vault_path, analyzed, digested_on
     FROM thoughts WHERE user_id=$1 AND ts >= now() - ($2 || ' days')::interval ORDER BY ts ASC`,
    [userId, String(days)],
  );
}

// Compose il follow-up Telegram leggero (1-2 righe).
export function lightReplyLine(a: LightAnalysis): string {
  const parts: string[] = [];
  if (a.themes?.length) parts.push(`Tema: *${a.themes.join(' · ')}*`);
  if (a.emotion) parts.push(`Emozione: _${a.emotion}_`);
  let line = parts.join(' · ');
  if (a.backlinks?.length) line += `\n↳ ${a.backlinks.map((b) => `[[${b}]]`).join(' · ')}`;
  if (a.loop_hint) line += `\n🔁 ${a.loop_hint}`;
  return line || 'Salvato.';
}
