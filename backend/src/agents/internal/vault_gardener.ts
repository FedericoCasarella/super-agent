import fs from 'node:fs/promises';
import path from 'node:path';
import { getVaultRoot, readNote, writeNote } from '../../brain/vault.js';
import { runClaude } from '../../claude/runner.js';
import { query } from '../../db/index.js';
import { buildGraph } from '../../brain/graph.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

// Vault Gardener — keeps the second brain healthy:
//   🌿 Potatura (prune):  detects orphan/stub/stale notes → archives to archive/<date>/...
//   💧 Annaffia (enrich): central but thin notes → expands content via Claude
//   🌱 Semi (seed):       emerging tag clusters without MOC → creates new seed/MOC notes
// Output: garden/<YYYY-MM-DD>.md log of actions. Never destructive (archive instead of delete).

function ymd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function slugify(s: string): string {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

type IdxRow = { path: string; kind: string | null; title: string | null; tags: string[] | null; visibility: string | null; updated_at: string; refs: any };

async function loadIndex(userId: number): Promise<IdxRow[]> {
  return await query<IdxRow>(
    `SELECT path, kind, title, tags, visibility, updated_at, refs FROM brain_index WHERE user_id=$1`,
    [userId],
  );
}

// ──────────────────────────────────────────────────────────────────────
// PRUNE: candidates = orphan + short + old + low-value (no kind/tags)
// ──────────────────────────────────────────────────────────────────────
type PruneCandidate = { path: string; reason: string; size: number; ageDays: number };

async function findPruneCandidates(userId: number, idx: IdxRow[], root: string): Promise<PruneCandidate[]> {
  const g = await buildGraph(userId, {});
  const linked = new Set<string>();
  for (const l of g.links as any[]) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    linked.add(s); linked.add(t);
  }
  const now = Date.now();
  const out: PruneCandidate[] = [];
  for (const r of idx) {
    // Skip protected vaults: people/, dreams/, library/ (these have their own lifecycle)
    if (/^(people|dreams|library|archive|garden)\//.test(r.path)) continue;
    const id = `default::${r.path}`;
    const fp = path.join(root, r.path);
    let stat: any;
    try { stat = await fs.stat(fp); } catch { continue; }
    const size = stat.size;
    const ageDays = Math.floor((now - new Date(r.updated_at).getTime()) / 86_400_000);
    const isOrphan = !linked.has(id) && !linked.has(r.path);
    const isStub = size < 400;
    const isStale = ageDays > 180;
    const noMeta = !r.kind && (!r.tags || r.tags.length === 0);
    const reasons: string[] = [];
    if (isOrphan) reasons.push('orphan');
    if (isStub) reasons.push('stub');
    if (isStale) reasons.push(`stale-${ageDays}d`);
    if (noMeta) reasons.push('no-metadata');
    // Need 2+ signals for prune candidacy (avoid pruning short-but-valuable atomic notes)
    if (reasons.length >= 2) out.push({ path: r.path, reason: reasons.join(','), size, ageDays });
  }
  // Cap to keep batch focused
  return out.slice(0, 25);
}

async function archiveNote(userId: number, root: string, rel: string): Promise<string | null> {
  try {
    const orig = await readNote(userId, rel);
    if (!orig) return null;
    const dest = `archive/${ymd()}/${rel}`;
    await writeNote(userId, dest, {
      ...(orig.data ?? {}),
      archived_from: rel,
      archived_at: new Date().toISOString(),
      kind: 'archived',
    }, orig.content);
    // Remove original file from disk + brain_index
    try { await fs.unlink(path.join(root, rel)); } catch {}
    await query(`DELETE FROM brain_index WHERE user_id=$1 AND path=$2`, [userId, rel]);
    return dest;
  } catch { return null; }
}

// ──────────────────────────────────────────────────────────────────────
// ENRICH: thin (small content) BUT central (high in-degree) notes
// ──────────────────────────────────────────────────────────────────────
type EnrichCandidate = { path: string; title: string; size: number; inDegree: number; content: string };

async function findEnrichCandidates(userId: number, idx: IdxRow[], root: string): Promise<EnrichCandidate[]> {
  const g = await buildGraph(userId, {});
  const inDeg = new Map<string, number>();
  for (const l of g.links as any[]) {
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }
  const out: EnrichCandidate[] = [];
  for (const r of idx) {
    if (/^(archive|garden|library)\//.test(r.path)) continue;
    const fp = path.join(root, r.path);
    let stat: any;
    try { stat = await fs.stat(fp); } catch { continue; }
    const size = stat.size;
    if (size > 2000) continue; // not thin
    const id = `default::${r.path}`;
    const d = inDeg.get(id) ?? inDeg.get(r.path) ?? 0;
    if (d < 2) continue; // not central
    try {
      const note = await readNote(userId, r.path);
      if (!note?.content) continue;
      out.push({ path: r.path, title: r.title ?? r.path, size, inDegree: d, content: note.content });
    } catch {}
  }
  // Top 8 by inDegree (most valuable first)
  return out.sort((a, b) => b.inDegree - a.inDegree).slice(0, 8);
}

// ──────────────────────────────────────────────────────────────────────
// SEED: tag clusters ≥3 notes WITHOUT a MOC note (no `moc/<tag>.md`)
// ──────────────────────────────────────────────────────────────────────
type SeedCandidate = { tag: string; count: number; samplePaths: string[] };

function findSeedCandidates(idx: IdxRow[]): SeedCandidate[] {
  const byTag = new Map<string, string[]>();
  const mocs = new Set<string>();
  for (const r of idx) {
    if (r.path.startsWith('moc/')) {
      const tag = r.path.replace(/^moc\//, '').replace(/\.md$/, '');
      mocs.add(tag);
    }
    for (const t of r.tags ?? []) {
      if (!t || typeof t !== 'string') continue;
      const key = t.toLowerCase();
      if (key.startsWith('person/') || key === 'library' || key === 'archived' || key === 'dream') continue;
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push(r.path);
    }
  }
  const out: SeedCandidate[] = [];
  for (const [tag, paths] of byTag) {
    if (paths.length < 3) continue;
    if (mocs.has(slugify(tag))) continue;
    out.push({ tag, count: paths.length, samplePaths: paths.slice(0, 6) });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 5);
}

// ──────────────────────────────────────────────────────────────────────
// CLAUDE: enrich + seed prompts
// ──────────────────────────────────────────────────────────────────────
function buildEnrichPrompt(c: EnrichCandidate): string {
  return [
    `Sei il "Vault Gardener". Devi ANNAFFIARE questa nota: arricchirla mantenendo coerenza.`,
    ``,
    `Path: ${c.path}`,
    `Titolo: ${c.title}`,
    `Linkata da ${c.inDegree} note (= nodo centrale, merita più sostanza).`,
    ``,
    `=== CONTENUTO ATTUALE ===`,
    c.content,
    `=== FINE ===`,
    ``,
    `COMPITO: riscrivi il body della nota espandendo i punti chiave, aggiungendo contesto utile, esempi, distinzioni concettuali. Mantieni il frontmatter ORIGINALE invariato (te lo riallego io). Lunghezza target: 400-900 parole.`,
    ``,
    `REGOLE:`,
    `- Italiano. Asciutto, professionale.`,
    `- NON inventare fatti. Se mancano informazioni → segnalalo con sezione "## Da approfondire".`,
    `- Mantieni link wiki esistenti [[...]]. Aggiungine di nuovi solo se PERTINENTI.`,
    `- Output: solo markdown body (senza frontmatter). Niente preamboli.`,
  ].join('\n');
}

function buildSeedPrompt(c: SeedCandidate, samples: { path: string; snippet: string }[]): string {
  const sampleText = samples.map((s) => `--- ${s.path} ---\n${s.snippet}`).join('\n\n');
  return [
    `Sei il "Vault Gardener". Devi piantare un SEME: una MOC (Map of Content) per il tag "${c.tag}".`,
    `Ci sono già ${c.count} note che usano questo tag ma non esiste una nota-mappa che le orchestri.`,
    ``,
    `=== ESTRATTI DALLE NOTE TAGGED ===`,
    sampleText,
    `=== FINE ===`,
    ``,
    `OUTPUT (markdown body, senza frontmatter):`,
    ``,
    `# ${c.tag} — MOC`,
    ``,
    `*Mappa di contenuto. Genesi automatica dal Vault Gardener il ${ymd()}.*`,
    ``,
    `## Cos'è`,
    `2-3 paragrafi che definiscono il concetto/area emersa dalle note.`,
    ``,
    `## Note correlate`,
    `Lista wikilink alle note pertinenti (usa i path forniti).`,
    ``,
    `## Domande aperte`,
    `3-5 domande che guideranno l'esplorazione futura del tema.`,
    ``,
    `REGOLE: Italiano. Asciutto. NON inventare connessioni. Solo wikilink ai path reali forniti.`,
  ].join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// RUN
// ──────────────────────────────────────────────────────────────────────
async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { error: 'vault not configured', durationMs: Date.now() - started };

  const idx = await loadIndex(userId);
  const created_paths: string[] = [];
  const modified_paths: string[] = [];
  const archived: string[] = [];
  const enriched: string[] = [];
  const seeded: string[] = [];

  // 1️⃣ PRUNE
  const pruneList = await findPruneCandidates(userId, idx, root);
  for (const p of pruneList) {
    const dest = await archiveNote(userId, root, p.path);
    if (dest) { archived.push(p.path); created_paths.push(dest); }
  }

  // 2️⃣ ENRICH
  const enrichList = await findEnrichCandidates(userId, idx, root);
  for (const c of enrichList) {
    try {
      const prompt = buildEnrichPrompt(c);
      const res = await runClaude(userId, prompt, {
        cwd: root, timeoutMs: 180_000, kind: 'vault-gardener-enrich',
        meta: { path: c.path, inDegree: c.inDegree },
      });
      if (!res.ok) continue;
      const body = res.text.trim();
      if (!body || body.length < c.size * 1.3) continue; // require meaningful expansion
      const orig = await readNote(userId, c.path);
      await writeNote(userId, c.path, {
        ...(orig?.data ?? {}),
        gardener_enriched_at: new Date().toISOString(),
      }, body);
      enriched.push(c.path);
      modified_paths.push(c.path);
    } catch {}
  }

  // 3️⃣ SEED
  const seedList = findSeedCandidates(idx);
  for (const s of seedList) {
    try {
      const samples: { path: string; snippet: string }[] = [];
      for (const p of s.samplePaths) {
        const n = await readNote(userId, p);
        if (n?.content) samples.push({ path: p, snippet: n.content.slice(0, 800) });
      }
      if (samples.length < 2) continue;
      const prompt = buildSeedPrompt(s, samples);
      const res = await runClaude(userId, prompt, {
        cwd: root, timeoutMs: 180_000, kind: 'vault-gardener-seed',
        meta: { tag: s.tag, count: s.count },
      });
      if (!res.ok) continue;
      const body = res.text.trim();
      if (!body) continue;
      const rel = `moc/${slugify(s.tag)}.md`;
      await writeNote(userId, rel, {
        kind: 'moc',
        title: `${s.tag} — MOC`,
        tags: ['moc', `topic/${slugify(s.tag)}`],
        visibility: 'public',
        gardener_seeded_at: new Date().toISOString(),
        seed_note_count: s.count,
      }, body);
      seeded.push(rel);
      created_paths.push(rel);
    } catch {}
  }

  // 4️⃣ LOG (always written, summarizes the gardening session)
  const logRel = `garden/${ymd()}.md`;
  const logBody = [
    `# 🌿 Vault Gardener — ${ymd()}`,
    ``,
    `*Sessione di manutenzione del second brain.*`,
    ``,
    `## 🌿 Potatura (${archived.length})`,
    archived.length ? archived.map((p) => `- \`${p}\` → archiviata`).join('\n') : '_Nessuna nota da potare._',
    ``,
    `## 💧 Annaffiatura (${enriched.length})`,
    enriched.length ? enriched.map((p) => `- [[${p}]] arricchita`).join('\n') : '_Nessuna nota da annaffiare._',
    ``,
    `## 🌱 Semi piantati (${seeded.length})`,
    seeded.length ? seeded.map((p) => `- [[${p}]] nuova MOC`).join('\n') : '_Nessun nuovo seme._',
    ``,
    `---`,
    `_Durata: ${Math.round((Date.now() - started) / 1000)}s · ${idx.length} note totali esaminate._`,
  ].join('\n');
  try {
    await writeNote(userId, logRel, {
      kind: 'garden-log',
      title: `Vault Gardener — ${ymd()}`,
      visibility: 'protected',
      tags: ['garden-log'],
      generated_at: new Date().toISOString(),
      counts: { pruned: archived.length, enriched: enriched.length, seeded: seeded.length },
    }, logBody);
    created_paths.push(logRel);
  } catch {}

  return {
    total_notes: idx.length,
    pruned: archived.length,
    enriched: enriched.length,
    seeded: seeded.length,
    created_paths,
    modified_paths,
    details: [
      ...archived.slice(0, 20).map((p) => ({ action: 'archived', path: p })),
      ...enriched.slice(0, 20).map((p) => ({ action: 'enriched', path: p })),
      ...seeded.slice(0, 20).map((p) => ({ action: 'seeded', path: p })),
    ],
    durationMs: Date.now() - started,
  };
}

const vault_gardener: InternalAgent = {
  name: 'vault_gardener',
  title: 'Vault Gardener',
  description: 'Giardiniere del second brain: 🌿 POTA note orfane/stub/stale (archiviate in archive/<data>/, mai cancellate), 💧 ANNAFFIA note centrali ma sottili (espande contenuto via LLM), 🌱 PIANTA SEMI (MOC) per cluster di tag senza nota-mappa. Output: garden/<data>.md con log azioni.',
  defaultHour: 5,
  defaultMinute: 0,
  run,
  humanize: (report: AgentReport, lang: Lang, status: 'ok' | 'error') => {
    if (status === 'error') return lang === 'it'
      ? `**Vault Gardener** — manutenzione fallita: ${String(report?.error ?? 'errore')}`
      : `**Vault Gardener** — failed: ${String(report?.error ?? 'error')}`;
    if (lang === 'it') return `🌿 **Vault Gardener** — potate ${report.pruned ?? 0}, annaffiate ${report.enriched ?? 0}, semi piantati ${report.seeded ?? 0} (su ${report.total_notes ?? 0} note).`;
    return `🌿 **Vault Gardener** — pruned ${report.pruned ?? 0}, watered ${report.enriched ?? 0}, seeds planted ${report.seeded ?? 0} (of ${report.total_notes ?? 0} notes).`;
  },
};

export default vault_gardener;
