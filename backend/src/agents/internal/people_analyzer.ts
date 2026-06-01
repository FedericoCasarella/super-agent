import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../db/index.js';
import { getVaultRoot, readNote, writeNote } from '../../brain/vault.js';
import { runClaude } from '../../claude/runner.js';
import { buildGraph } from '../../brain/graph.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

const PSY_SUFFIX = '.psy-profile.md'; // sibling: people/<slug>.psy-profile.md

function psyPathForSlug(slug: string): string {
  return `people/${slug}${PSY_SUFFIX}`;
}

async function fileExists(root: string, rel: string): Promise<boolean> {
  try { await fs.stat(path.join(root, rel)); return true; } catch { return false; }
}

// Gather all note contents linked (1-hop) to a person, used as context.
async function collectLinkedContent(userId: number, slug: string): Promise<{ count: number; corpus: string }> {
  const g = await buildGraph(userId, {});
  const centerId = (g.nodes as any[]).find((n) =>
    n.id?.endsWith(`::people/${slug}.md`) || n.id === `people/${slug}.md`,
  )?.id;
  if (!centerId) return { count: 0, corpus: '' };
  const linked = new Set<string>();
  for (const l of g.links as any[]) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === centerId) linked.add(t);
    else if (t === centerId) linked.add(s);
  }
  let corpus = '';
  let count = 0;
  for (const id of linked) {
    const rel = id.includes('::') ? id.split('::', 2)[1] : id;
    try {
      const n = await readNote(userId, rel);
      if (!n?.content) continue;
      const snippet = n.content.slice(0, 3000);
      corpus += `\n\n--- ${rel} ---\n${snippet}`;
      count++;
      if (corpus.length > 80_000) break; // cap
    } catch {}
  }
  return { count, corpus };
}

function buildPrompt(personName: string, personNote: string, linkedCorpus: string): string {
  return [
    `Sei un analista comportamentale. Costruisci il PROFILO PSICOLOGICO di ${personName} basandoti SOLO sulle informazioni fornite.`,
    'Output: file markdown italiano, ben strutturato, max 600 parole. NIENTE preamboli tipo "Ecco il profilo". Inizia direttamente con frontmatter YAML poi titolo.',
    '',
    'STRUTTURA:',
    '```',
    '---',
    `title: ${personName} — Profilo psicologico`,
    'kind: psy-profile',
    'tags: [psy-profile]',
    `person: ${personName}`,
    'generated_at: <ISO timestamp>',
    'visibility: protected',
    '---',
    '',
    `# ${personName} — Profilo psicologico`,
    '',
    '## Tratti dominanti',
    '- elenco 3-5 tratti chiave evidence-based (cita pattern dalle note tra parentesi)',
    '',
    '## Paure & vulnerabilità',
    '- ciò che teme, ciò che lo destabilizza',
    '',
    '## Stile relazionale',
    '- come si approccia agli altri, registro, tono, trigger',
    '',
    '## Bisogni e leve motivazionali',
    '- cosa cerca davvero, cosa lo motiva ad agire',
    '',
    '## Come comunicare al meglio con lui/lei',
    '- tono consigliato',
    '- timing & canali',
    '- frasi/parole che funzionano vs da evitare',
    '- escalation strategy se la conversazione si rompe',
    '',
    '## Bandiere da monitorare',
    '- segnali che indicano stress / disengagement',
    '```',
    '',
    'REGOLE:',
    '- Se le info sono scarse → dichiara "DATI INSUFFICIENTI" e lista cosa servirebbe.',
    '- Niente diagnosi clinica. Linguaggio professionale ma asciutto.',
    '- Cita pattern dalle note (es. "ha rifiutato 2 proposte di pricing — sensibilità su costi").',
    '- Scopo: migliorare le interazioni, NON giudicare.',
    '',
    '=== NOTA PERSONA ===',
    personNote || '(nessuna nota base)',
    '',
    '=== CONTESTO COLLEGATO ===',
    linkedCorpus || '(nessuna nota collegata)',
    '',
    'OUTPUT: solo il contenuto markdown del file profilo, niente altro.',
  ].join('\n');
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { error: 'vault not configured', durationMs: Date.now() - started };

  const people = await query<{ slug: string; name: string }>(
    `SELECT slug, name FROM people WHERE user_id=$1 ORDER BY updated_at DESC`, [userId],
  );

  let analyzed = 0, skipped = 0, errors = 0;
  const details: any[] = [];

  for (const p of people) {
    const psyRel = psyPathForSlug(p.slug);
    if (await fileExists(root, psyRel)) { skipped++; continue; }
    try {
      const personNote = await readNote(userId, `people/${p.slug}.md`);
      const { count, corpus } = await collectLinkedContent(userId, p.slug);
      const prompt = buildPrompt(p.name, personNote?.content ?? '', corpus);
      const res = await runClaude(userId, prompt, {
        cwd: root, timeoutMs: 300_000, kind: 'people-analyzer',
        meta: { slug: p.slug, name: p.name, linkedCount: count },
      });
      if (!res.ok) { errors++; details.push({ slug: p.slug, error: res.stderr?.slice(0, 200) ?? 'failed' }); continue; }
      const body = res.text.trim();
      if (!body || /DATI INSUFFICIENTI/i.test(body.slice(0, 200))) {
        details.push({ slug: p.slug, note: 'insufficient data, skipped write' });
        skipped++; continue;
      }
      await writeNote(userId, psyRel, {
        kind: 'psy-profile',
        title: `${p.name} — Profilo psicologico`,
        person: p.slug,
        visibility: 'protected',
        tags: ['psy-profile', `person/${p.slug}`],
        generated_at: new Date().toISOString(),
      }, body);
      analyzed++;
      details.push({ slug: p.slug, ok: true, linked: count, cost: res.costUsd ?? null });
    } catch (e: any) {
      errors++;
      details.push({ slug: p.slug, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  return {
    total_people: people.length,
    analyzed, skipped, errors,
    details: details.slice(0, 30),
    durationMs: Date.now() - started,
  };
}

const people_analyzer: InternalAgent = {
  name: 'people_analyzer',
  title: 'People Analyzer',
  description: 'Cicla ogni giorno tra le persone in People e costruisce un profilo psicologico (paure, vulnerabilità, stile relazionale, leve di comunicazione) partendo da tutti i nodi del cervello collegati a quella persona. Output: people/<slug>.psy-profile.md. Le persone già analizzate vengono saltate.',
  defaultHour: 3,
  defaultMinute: 30,
  run,
  humanize: (report: AgentReport, lang: Lang, status: 'ok' | 'error') => {
    if (status === 'error') return lang === 'it'
      ? `**People Analyzer** — esecuzione fallita: ${String(report?.error ?? 'errore')}`
      : `**People Analyzer** — run failed: ${String(report?.error ?? 'error')}`;
    if (lang === 'it') return `**People Analyzer** — analizzati ${report.analyzed ?? 0} (skip ${report.skipped ?? 0}, errori ${report.errors ?? 0}) su ${report.total_people ?? 0} persone.`;
    return `**People Analyzer** — analyzed ${report.analyzed ?? 0} (skip ${report.skipped ?? 0}, errors ${report.errors ?? 0}) of ${report.total_people ?? 0} people.`;
  },
};

export default people_analyzer;
