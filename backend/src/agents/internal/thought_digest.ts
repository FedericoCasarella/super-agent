// Thought Digest — internal agent (sess.8266).
// Il livello 3 del Thought Analyzer: la sera aggrega i pensieri del giorno e trova
// il pattern che nei singoli pensieri non si vede (emozione dominante, loop ricorrente,
// contraddizione viva, una domanda per domani). Scrive un nodo digest nel vault e
// notifica via Telegram tramite il pipeline runInternalAgent esistente.
//
// Input deterministico: i pensieri (ultimi 7gg) arrivano nel prompt come testo dal DB,
// quindi runClaude gira con useMcp:false (nessun filesystem/tool) → veloce e riproducibile.

import { query } from '../../db/index.js';
import { runClaude } from '../../claude/runner.js';
import { writeNote } from '../../brain/vault.js';
import { thoughtsToday, thoughtsLastDays } from '../../brain/thoughts.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

type DigestJson = {
  dominant_emotion: string;
  loop: string;            // il loop ricorrente del giorno (1-2 frasi)
  contradiction?: string;  // contraddizione viva, se presente
  question: string;        // una domanda per domani
  summary: string;         // 1 frase di sintesi
};

function fmtThought(t: { ts: string; text: string; emotion: string | null; themes: string[] }): string {
  const hhmm = new Date(t.ts).toISOString().slice(11, 16);
  const day = new Date(t.ts).toISOString().slice(0, 10);
  const meta = [t.emotion, (t.themes ?? []).join('/')].filter(Boolean).join(' · ');
  return `[${day} ${hhmm}] ${t.text.slice(0, 400)}${meta ? `  (${meta})` : ''}`;
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const today = await thoughtsToday(userId);
  if (!today.length) return { skipped: 1, scanned: 0, durationMs: Date.now() - started };

  const week = await thoughtsLastDays(userId, 7);

  const prompt = [
    'Sei l\'analista del diario cognitivo di Mattia. Ricevi i pensieri di OGGI piu il contesto',
    'degli ultimi 7 giorni. Trova il PATTERN che nei singoli pensieri non si vede.',
    'Rispondi SOLO con JSON valido in questo schema (niente altro testo):',
    '{"dominant_emotion":"<emozione dominante di oggi>","loop":"<il loop ricorrente: il tema su cui Mattia torna piu volte, 1-2 frasi>","contradiction":"<opzionale: due pensieri che si tirano contro, altrimenti ometti>","question":"<UNA domanda secca e utile per domani>","summary":"<1 frase di sintesi della giornata>"}',
    '',
    `PENSIERI DI OGGI (${today.length}):`,
    today.map(fmtThought).join('\n'),
    '',
    `CONTESTO ULTIMI 7 GIORNI (${week.length}, per vedere i ritorni):`,
    week.map(fmtThought).join('\n'),
  ].join('\n');

  let d: DigestJson | null = null;
  let rawTail = '';
  try {
    const res = await runClaude(userId, prompt, { useMcp: false, timeoutMs: 90_000, kind: 'thought-digest' });
    rawTail = (res.text ?? '').slice(-400);
    let s = (res.text ?? '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a !== -1 && b > a) { try { d = JSON.parse(s.slice(a, b + 1)); } catch {} }
  } catch (e: any) {
    return { error: String(e?.message ?? e), durationMs: Date.now() - started };
  }
  if (!d) return { error: 'digest: unparseable', rawTail, durationMs: Date.now() - started };

  // Nodo digest nel vault, collegato ai pensieri del giorno + ai loro backlink.
  const day = new Date().toISOString().slice(0, 10);
  const rel = `thoughts/digests/${day}.md`;
  const dayLinks = today.map((t) => (t.vault_path ? `[[${t.vault_path.replace(/^thoughts\//, '').replace(/\.md$/, '')}]]` : null)).filter(Boolean) as string[];
  const backlinkSet = new Set<string>();
  for (const t of today) for (const b of (t.backlinks ?? [])) backlinkSet.add(b);
  const related = [...new Set([...dayLinks, ...[...backlinkSet].map((b) => `[[${b}]]`)])];

  const body = [
    `# Digest — ${day}`,
    '',
    `**${today.length} pensieri** · emozione dominante → *${d.dominant_emotion}*`,
    '',
    `**Loop ricorrente:** ${d.loop}`,
    d.contradiction ? `\n**Contraddizione viva:** ${d.contradiction}` : '',
    '',
    `**Una domanda per domani:** ${d.question}`,
    '',
    `_${d.summary}_`,
    related.length ? `\n---\n**Pensieri del giorno:** ${related.join(' · ')}` : '',
  ].filter(Boolean).join('\n');

  let createdPath: string | undefined;
  try {
    await writeNote(userId, rel, {
      kind: 'thought-digest',
      title: `Digest pensieri ${day}`,
      emotion: d.dominant_emotion,
      related,
      visibility: 'protected',
      date: day,
    }, body);
    createdPath = rel;
  } catch (e) { console.error('[thought_digest] writeNote failed', e); }

  // Marca i pensieri di oggi come digeriti.
  try {
    await query(`UPDATE thoughts SET digested_on=now()::date WHERE user_id=$1 AND ts::date = now()::date`, [userId]);
  } catch (e) { console.error('[thought_digest] mark digested failed', e); }

  return {
    scanned: today.length,
    dominant_emotion: d.dominant_emotion,
    loop: d.loop,
    contradiction: d.contradiction ?? null,
    question: d.question,
    summary: d.summary,
    created_paths: createdPath ? [createdPath] : [],
    durationMs: Date.now() - started,
  };
}

const agent: InternalAgent = {
  name: 'thought_digest',
  title: 'Thought Digest',
  description: 'Ogni sera aggrega i pensieri del giorno (tabella thoughts) e trova il pattern cross-pensiero: emozione dominante, loop ricorrente, contraddizione viva, una domanda per domani. Scrive un nodo digest nel vault collegato ai pensieri del giorno. Livello 3 del Thought Analyzer.',
  defaultHour: 21,
  defaultMinute: 0,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🐙 *Thought Digest* — non sono riuscito a chiudere il digest: ${r?.error ?? 'errore'}.`
        : `🐙 *Thought Digest* — couldn't close the digest: ${r?.error ?? 'error'}.`;
    }
    if (r.skipped) {
      return lang === 'it'
        ? `🐙 *Thought Digest* — oggi nessun pensiero da aggregare.`
        : `🐙 *Thought Digest* — no thoughts to aggregate today.`;
    }
    const lines = [
      `🐙 *Digest serale* — ${r.scanned} pensieri · emozione dominante → *${r.dominant_emotion}*`,
      ``,
      `🔁 *Loop:* ${r.loop}`,
    ];
    if (r.contradiction) lines.push(`⚔️ *Contraddizione:* ${r.contradiction}`);
    lines.push(``, `❓ *Per domani:* ${r.question}`);
    return lines.join('\n');
  },
};

export default agent;
