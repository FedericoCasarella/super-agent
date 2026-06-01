import { getVaultRoot, readNote, writeNote } from '../../brain/vault.js';
import { runClaude } from '../../claude/runner.js';
import { buildGraph } from '../../brain/graph.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

// Vault Dreamer — runs late at night, when no human stimulus reaches the agent.
// Samples distant, semi-random nodes across vaults and asks Claude to surface
// emergent / unexpected connections (serendipity engine). Output: dreams/<date>.md.

function isoDate(d = new Date()): string {
  // YYYY-MM-DD in local time
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Deterministic pseudo-shuffle (seedable via current date so multiple sub-runs differ).
function shuffleSeeded<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed | 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Pick = { id: string; rel: string; title: string; vault: string; kind: string; snippet: string };

async function pickDistantSample(userId: number, n = 24): Promise<Pick[]> {
  const g = await buildGraph(userId, {});
  // Build adjacency to bias against tightly-clustered nodes (we want distance).
  const deg = new Map<string, number>();
  for (const l of g.links as any[]) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    deg.set(s, (deg.get(s) ?? 0) + 1);
    deg.set(t, (deg.get(t) ?? 0) + 1);
  }
  // Score: prefer lower degree (less linked = more potential for novel connection).
  const nodes = (g.nodes as any[]).map((n) => ({
    n,
    score: 1 / (1 + (deg.get(n.id) ?? 0)),
  }));
  // Group by vault then round-robin → ensures cross-vault diversity.
  const byVault = new Map<string, typeof nodes>();
  for (const x of nodes) {
    const v = String(x.n.vault ?? 'default');
    if (!byVault.has(v)) byVault.set(v, []);
    byVault.get(v)!.push(x);
  }
  // Seed = day-of-year so each night picks a different cohort.
  const seed = Math.floor(Date.now() / 86_400_000);
  const buckets = Array.from(byVault.values()).map((b) => shuffleSeeded(b, seed));
  const out: Pick[] = [];
  let i = 0;
  while (out.length < n && buckets.some((b) => b.length > 0)) {
    const bucket = buckets[i % buckets.length];
    i++;
    const next = bucket.shift();
    if (!next) continue;
    const rel = String(next.n.id).includes('::') ? String(next.n.id).split('::', 2)[1] : String(next.n.id);
    try {
      const note = await readNote(userId, rel);
      if (!note?.content) continue;
      out.push({
        id: next.n.id,
        rel,
        title: next.n.title ?? rel,
        vault: String(next.n.vault ?? 'default'),
        kind: String(next.n.kind ?? ''),
        snippet: note.content.slice(0, 1200),
      });
    } catch {}
  }
  return out;
}

function buildPrompt(picks: Pick[]): string {
  const corpus = picks
    .map((p, i) => `--- [${i + 1}] ${p.title}  (vault=${p.vault}, kind=${p.kind}, path=${p.rel}) ---\n${p.snippet}`)
    .join('\n\n');
  return [
    'Sei il "Vault Dreamer" — un agente notturno che cerca connessioni inaspettate, pattern emergenti e analogie nascoste tra note del second brain.',
    'Lavori mentre l\'umano dorme. Nessuno ti sta guardando. Pensa in modo divergente, associativo, quasi onirico.',
    '',
    'INPUT: 20-30 note campionate cross-vault con bias verso nodi POCO collegati (massima distanza concettuale).',
    '',
    'IL TUO COMPITO:',
    '1. Identifica 3-7 CONNESSIONI NON-OVVIE tra coppie/triple di note.',
    '   - NON cose già esplicite (link già presenti, tag condivisi, stesso autore).',
    '   - SÌ pattern latenti: temi ricorrenti, paradossi, analogie strutturali, cicli, contraddizioni illuminanti.',
    '2. Per ogni connessione:',
    '   - Titolo evocativo (1 frase)',
    '   - Note coinvolte: cita per path es. `[[people/mario.md]]`',
    '   - Insight: 2-4 frasi che spiegano il pattern emergente',
    '   - Azione suggerita: 1 wikilink da aggiungere, 1 nuova nota MOC da creare, 1 tag cluster da introdurre',
    '3. Una sezione finale "## Domande aperte" — 3 domande provocatorie che potrebbero guidare future esplorazioni.',
    '',
    'STILE:',
    '- Italiano. Lirico ma preciso. Non new-age.',
    '- Non chiedere conferme, non fare preamboli. Inizia direttamente con frontmatter + titolo.',
    '- Se le note sono troppo eterogenee per qualunque collegamento sensato, scrivi solo "## Nessuna connessione significativa trovata" + 1 paragrafo sul perché.',
    '',
    'OUTPUT (markdown puro):',
    '```',
    '---',
    `title: Sogni del vault — ${isoDate()}`,
    'kind: dream',
    'tags: [dream, serendipity]',
    `generated_at: ${new Date().toISOString()}`,
    'visibility: protected',
    '---',
    '',
    `# 🌙 Sogni del vault — ${isoDate()}`,
    '',
    '*N note campionate, M connessioni emerse.*',
    '',
    '## Connessioni emergenti',
    '',
    '### 1. <titolo evocativo>',
    '- **Note**: [[path1]] · [[path2]] · [[path3]]',
    '- **Insight**: ...',
    '- **Azione**: ...',
    '',
    '## Domande aperte',
    '- ...',
    '```',
    '',
    '=== NOTE CAMPIONATE ===',
    corpus,
    '',
    'OUTPUT: solo markdown del file sogno, niente altro.',
  ].join('\n');
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { error: 'vault not configured', durationMs: Date.now() - started };

  const picks = await pickDistantSample(userId, 24);
  if (picks.length < 4) {
    return { sampled: picks.length, written: 0, reason: 'too few notes', durationMs: Date.now() - started };
  }
  const prompt = buildPrompt(picks);
  const res = await runClaude(userId, prompt, {
    cwd: root, timeoutMs: 300_000, kind: 'vault-dreamer',
    meta: { sampleCount: picks.length },
  });
  if (!res.ok) {
    return { sampled: picks.length, written: 0, error: res.stderr?.slice(0, 300) ?? 'failed', durationMs: Date.now() - started };
  }
  const body = res.text.trim();
  if (!body) return { sampled: picks.length, written: 0, error: 'empty response', durationMs: Date.now() - started };

  const rel = `dreams/${isoDate()}.md`;
  await writeNote(userId, rel, {
    kind: 'dream',
    title: `Sogni del vault — ${isoDate()}`,
    visibility: 'protected',
    tags: ['dream', 'serendipity'],
    generated_at: new Date().toISOString(),
    sample_count: picks.length,
  }, body);

  return {
    sampled: picks.length,
    written: 1,
    path: rel,
    cost: res.costUsd ?? null,
    durationMs: Date.now() - started,
  };
}

const vault_dreamer: InternalAgent = {
  name: 'vault_dreamer',
  title: 'Vault Dreamer',
  description: 'Durante la notte, mentre nessuno scrive prompt, campiona note distanti dal second brain e cerca connessioni inaspettate, pattern emergenti, analogie nascoste. Output: dreams/<data>.md con insights e domande aperte. Serendipity engine — sogna per te.',
  defaultHour: 4,
  defaultMinute: 15,
  run,
  humanize: (report: AgentReport, lang: Lang, status: 'ok' | 'error') => {
    if (status === 'error') return lang === 'it'
      ? `**Vault Dreamer** — sogno interrotto: ${String(report?.error ?? 'errore')}`
      : `**Vault Dreamer** — dream failed: ${String(report?.error ?? 'error')}`;
    if (report.written === 0) {
      return lang === 'it'
        ? `**Vault Dreamer** — campionate ${report.sampled ?? 0} note, nessun sogno scritto (${report.reason ?? report.error ?? 'nothing emerged'}).`
        : `**Vault Dreamer** — sampled ${report.sampled ?? 0} notes, no dream written.`;
    }
    return lang === 'it'
      ? `🌙 **Vault Dreamer** — ho sognato. ${report.sampled} note campionate → \`${report.path}\``
      : `🌙 **Vault Dreamer** — dreamed. ${report.sampled} notes sampled → \`${report.path}\``;
  },
};

export default vault_dreamer;
