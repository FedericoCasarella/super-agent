// Brain Consolidator — il vault si riscrive da solo, ma decide l'utente.
// Loop notturno (default 03:30) che analizza il second brain e genera PROPOSTE
// in brain_proposals (mai azioni dirette):
//   🔁 merge   — note quasi-duplicate → 1 nota consolidata, sorgenti in archive/
//   🧪 distill — N note episodiche sulla stessa entità → 1 profilo distillato
//   ✂️ prune   — note morte (orfane+stub+stale) → archive/
//   🔗 link    — note affini scollegate → frontmatter `related:`
// L'utente approva/scarta dal pannello in /brain. Apply = brain/proposals.ts
// (con snapshot di sicurezza automatico).

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../db/index.js';
import { getVaultRoot, readNote } from '../../brain/vault.js';
import { buildGraph } from '../../brain/graph.js';
import { runClaude } from '../../claude/runner.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

type IdxRow = { path: string; kind: string | null; title: string | null; tags: string[] | null; updated_at: string };

const SKIP_RE = /^(archive|garden|library|dreams|thoughts)\//;

function normTitle(s: string): string {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function loadIndex(userId: number): Promise<IdxRow[]> {
  return await query<IdxRow>(
    `SELECT path, kind, title, tags, updated_at FROM brain_index WHERE user_id=$1`,
    [userId],
  );
}

// Skip groups already proposed and still pending/rejected — don't re-propose
// what the user has already seen.
async function alreadyProposed(userId: number, kind: string, key: string): Promise<boolean> {
  const rows = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM brain_proposals
     WHERE user_id=$1 AND kind=$2 AND payload->>'group_key'=$3 AND status IN ('pending','rejected')`,
    [userId, kind, key],
  );
  return (rows[0]?.c ?? 0) > 0;
}

async function insertProposal(userId: number, kind: string, title: string, description: string, payload: any): Promise<void> {
  await query(
    `INSERT INTO brain_proposals(user_id, kind, title, description, payload) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [userId, kind, title, description, JSON.stringify(payload)],
  );
}

// ── Candidate detection (deterministic, no LLM) ────────────────────────────

// MERGE: notes with the same normalized title in different paths.
function findDupGroups(idx: IdxRow[]): { key: string; paths: string[] }[] {
  const byTitle = new Map<string, string[]>();
  for (const r of idx) {
    if (SKIP_RE.test(r.path)) continue;
    const t = normTitle(r.title ?? '');
    if (t.length < 4) continue;
    byTitle.set(t, [...(byTitle.get(t) ?? []), r.path]);
  }
  return [...byTitle.entries()]
    .filter(([, paths]) => paths.length >= 2)
    .map(([key, paths]) => ({ key, paths: paths.slice(0, 5) }))
    .slice(0, 5);
}

// DISTILL: ≥3 episodic notes mentioning the same person (people table slugs).
async function findDistillGroups(userId: number, idx: IdxRow[]): Promise<{ key: string; slug: string; name: string; paths: string[] }[]> {
  const people = await query<{ slug: string; name: string }>(
    `SELECT slug, name FROM people WHERE user_id=$1`,
    [userId],
  );
  const out: { key: string; slug: string; name: string; paths: string[] }[] = [];
  for (const p of people) {
    const nameNorm = normTitle(p.name);
    if (nameNorm.length < 4) continue;
    const hits = idx.filter((r) => {
      if (SKIP_RE.test(r.path) || r.path.startsWith('people/')) return false;
      const hay = normTitle(`${r.title ?? ''} ${r.path}`);
      return hay.includes(nameNorm) || hay.includes(p.slug.replace(/-/g, ' '));
    }).map((r) => r.path);
    if (hits.length >= 3) out.push({ key: `distill:${p.slug}`, slug: p.slug, name: p.name, paths: hits.slice(0, 8) });
  }
  return out.slice(0, 4);
}

// PRUNE: orphan + stub + stale (2+ signals), proposal-only version of gardener.
async function findPruneCandidates(userId: number, idx: IdxRow[], root: string): Promise<{ path: string; reason: string }[]> {
  const g = await buildGraph(userId, {});
  const linked = new Set<string>();
  for (const l of g.links as any[]) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    linked.add(s); linked.add(t);
  }
  const now = Date.now();
  const out: { path: string; reason: string }[] = [];
  for (const r of idx) {
    if (SKIP_RE.test(r.path) || r.path.startsWith('people/')) continue;
    let stat: any;
    try { stat = await fs.stat(path.join(root, r.path)); } catch { continue; }
    const ageDays = Math.floor((now - new Date(r.updated_at).getTime()) / 86_400_000);
    const reasons: string[] = [];
    if (!linked.has(`default::${r.path}`) && !linked.has(r.path)) reasons.push('orfana');
    if (stat.size < 400) reasons.push('stub');
    if (ageDays > 180) reasons.push(`ferma da ${ageDays}gg`);
    if (!r.kind && (!r.tags || r.tags.length === 0)) reasons.push('senza metadati');
    if (reasons.length >= 2) out.push({ path: r.path, reason: reasons.join(', ') });
  }
  return out.slice(0, 20);
}

// LINK: pairs sharing ≥2 tags but not connected in the graph.
// `root` = primary vault — brain_index spans multiple vaults and stale rows,
// so every candidate path must exist on disk under the primary root (the
// apply engine resolves paths there).
async function findLinkCandidates(userId: number, idx: IdxRow[], root: string): Promise<{ path: string; related: string[]; why: string }[]> {
  const g = await buildGraph(userId, {});
  const connected = new Set<string>();
  for (const l of g.links as any[]) {
    const s = (typeof l.source === 'object' ? l.source.id : l.source).replace(/^default::/, '');
    const t = (typeof l.target === 'object' ? l.target.id : l.target).replace(/^default::/, '');
    connected.add(`${s}|${t}`); connected.add(`${t}|${s}`);
  }
  const taggedRaw = idx.filter((r) => !SKIP_RE.test(r.path) && (r.tags?.length ?? 0) >= 2);
  const tagged: IdxRow[] = [];
  for (const r of taggedRaw) {
    try { await fs.stat(path.join(root, r.path)); tagged.push(r); } catch {}
  }
  const out: { path: string; related: string[]; why: string }[] = [];
  const used = new Set<string>();
  for (const a of tagged) {
    if (used.has(a.path)) continue;
    const rel: string[] = [];
    let sharedTags: string[] = [];
    for (const b of tagged) {
      if (a.path === b.path || connected.has(`${a.path}|${b.path}`)) continue;
      const shared = (a.tags ?? []).filter((t) => (b.tags ?? []).includes(t));
      if (shared.length >= 2) { rel.push(b.path); sharedTags = shared; }
      if (rel.length >= 3) break;
    }
    if (rel.length >= 2) {
      out.push({ path: a.path, related: rel, why: `tag condivisi: ${sharedTags.slice(0, 3).join(', ')}` });
      used.add(a.path); rel.forEach((p) => used.add(p));
    }
    if (out.length >= 10) break;
  }
  return out;
}

// ── LLM pass: produce merged/distilled CONTENT for the proposals ──────────

async function readCapped(userId: number, rel: string, cap = 2200): Promise<string> {
  try {
    const n = await readNote(userId, rel);
    return n?.content ? n.content.slice(0, cap) : '';
  } catch { return ''; }
}

type LlmOut = { content: string; title: string } | null;

async function llmConsolidate(userId: number, kindLabel: 'merge' | 'distill', subject: string, notes: { path: string; content: string }[]): Promise<LlmOut> {
  const prompt = [
    kindLabel === 'merge'
      ? `Queste note del second brain sono quasi-duplicate ("${subject}"). Fondile in UNA nota consolidata: zero ripetizioni, mantieni TUTTE le informazioni uniche, struttura pulita con heading.`
      : `Queste note episodiche riguardano "${subject}". Distillale in UN profilo semantico: cosa è importante sapere in modo stabile (fatti, pattern, decisioni, stato relazione), NON la cronaca. Includi una sezione finale "Fonti" con i wikilink alle note originali.`,
    `Rispondi SOLO con JSON valido: {"title":"<titolo nota>","content":"<markdown completo della nota, \\n per newline>"}`,
    '',
    ...notes.map((n, i) => `--- NOTA ${i + 1}: ${n.path} ---\n${n.content}`),
    ...(kindLabel === 'distill' ? [``, `Wikilink fonti da usare: ${notes.map((n) => `[[${n.path.replace(/\.md$/, '')}]]`).join(' ')}`] : []),
  ].join('\n');
  try {
    const res = await runClaude(userId, prompt, { useMcp: false, timeoutMs: 120_000, kind: 'brain-consolidator' });
    if (!res.ok) return null;
    let s = (res.text ?? '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    const parsed = JSON.parse(s.slice(a, b + 1));
    if (!parsed?.content) return null;
    return { content: String(parsed.content), title: String(parsed.title ?? subject) };
  } catch { return null; }
}

// ── Run ────────────────────────────────────────────────────────────────────

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { skipped: 1, error: 'vault non configurato', durationMs: Date.now() - started };
  const idx = await loadIndex(userId);
  if (idx.length < 10) return { skipped: 1, scanned: idx.length, durationMs: Date.now() - started };

  let merges = 0, distills = 0, prunes = 0, links = 0;

  // MERGE proposals (LLM content)
  for (const g of findDupGroups(idx)) {
    if (await alreadyProposed(userId, 'merge', g.key)) continue;
    const notes = (await Promise.all(g.paths.map(async (p) => ({ path: p, content: await readCapped(userId, p) }))))
      .filter((n) => n.content);
    if (notes.length < 2) continue;
    const out = await llmConsolidate(userId, 'merge', g.key, notes);
    if (!out) continue;
    await insertProposal(userId, 'merge',
      `Unisci ${notes.length} duplicati: "${out.title}"`,
      `Note quasi-identiche (${notes.map((n) => n.path).join(', ')}) → 1 nota consolidata. Le sorgenti finiscono in archive/.`,
      { group_key: g.key, sources: notes.map((n) => n.path), target_path: notes[0].path, title: out.title, content: out.content });
    merges++;
  }

  // DISTILL proposals (LLM content)
  for (const g of await findDistillGroups(userId, idx)) {
    if (await alreadyProposed(userId, 'distill', g.key)) continue;
    const notes = (await Promise.all(g.paths.map(async (p) => ({ path: p, content: await readCapped(userId, p, 1500) }))))
      .filter((n) => n.content);
    if (notes.length < 3) continue;
    const out = await llmConsolidate(userId, 'distill', g.name, notes);
    if (!out) continue;
    await insertProposal(userId, 'distill',
      `Distilla ${notes.length} note su ${g.name}`,
      `Le note episodiche restano; nasce people/${g.slug}.distilled.md con la conoscenza stabile + wikilink alle fonti.`,
      { group_key: g.key, sources: notes.map((n) => n.path), target_path: `people/${g.slug}.distilled.md`, title: out.title, content: out.content });
    distills++;
  }

  // PRUNE proposals (no LLM) — one proposal per batch of dead notes
  const pruneCands = await findPruneCandidates(userId, idx, root);
  if (pruneCands.length >= 3) {
    const key = `prune:${pruneCands.map((c) => c.path).join('|').slice(0, 200)}`;
    if (!(await alreadyProposed(userId, 'prune', key))) {
      await insertProposal(userId, 'prune',
        `Archivia ${pruneCands.length} note morte`,
        pruneCands.map((c) => `${c.path} (${c.reason})`).join('\n'),
        { group_key: key, sources: pruneCands.map((c) => c.path) });
      prunes++;
    }
  }

  // LINK proposals (no LLM)
  for (const c of await findLinkCandidates(userId, idx, root)) {
    const key = `link:${c.path}`;
    if (await alreadyProposed(userId, 'link', key)) continue;
    await insertProposal(userId, 'link',
      `Collega "${c.path.split('/').pop()}" a ${c.related.length} note affini`,
      `${c.why} → aggiunge ${c.related.join(', ')} al frontmatter related: di ${c.path}`,
      { group_key: key, path: c.path, related: c.related });
    links++;
  }

  const total = merges + distills + prunes + links;
  return { scanned: idx.length, merges, distills, prunes, links, proposals: total, durationMs: Date.now() - started };
}

const agent: InternalAgent = {
  name: 'brain_consolidator',
  title: 'Brain Consolidator',
  description: 'Di notte analizza il vault e PROPONE consolidamenti (mai azioni dirette): unione duplicati, distillazione di note episodiche in profili semantici, archiviazione note morte, link tra note affini. Approvi o scarti ogni proposta dal pannello in /brain — prima di ogni apply viene creato uno snapshot di sicurezza.',
  defaultHour: 3,
  defaultMinute: 30,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🧠 *Brain Consolidator* — giro fallito: ${r?.error ?? 'errore'}.`
        : `🧠 *Brain Consolidator* — run failed: ${r?.error ?? 'error'}.`;
    }
    if (r.skipped || !r.proposals) {
      return lang === 'it'
        ? `🧠 *Brain Consolidator* — vault in ordine, nessuna proposta stanotte.`
        : `🧠 *Brain Consolidator* — vault clean, no proposals tonight.`;
    }
    const parts: string[] = [];
    if (r.merges) parts.push(`${r.merges} unioni duplicati`);
    if (r.distills) parts.push(`${r.distills} distillazioni`);
    if (r.prunes) parts.push(`${r.prunes} potature`);
    if (r.links) parts.push(`${r.links} collegamenti`);
    return lang === 'it'
      ? `🧠 *Brain Consolidator* — ${r.proposals} proposte pronte: ${parts.join(', ')}.\n\nApprova o scarta dal pannello Brain → Proposte.`
      : `🧠 *Brain Consolidator* — ${r.proposals} proposals ready: ${parts.join(', ')}.\n\nReview them in Brain → Proposals.`;
  },
};

export default agent;
