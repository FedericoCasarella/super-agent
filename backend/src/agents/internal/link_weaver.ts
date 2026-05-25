import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { getVaultRoot } from '../../brain/vault.js';
import type { InternalAgent, AgentReport } from './types.js';

// Improves connectivity of the brain graph:
// - For each note, finds candidate related notes via shared tags, shared person/project mentions,
//   and folder co-locality. Adds them to frontmatter `related: [...]` (deduped).
// - Skips Strategy/etc explicitly marked do_not_link.
// Deterministic, zero LLM cost.

type NoteMeta = {
  path: string;
  full: string;
  data: any;
  content: string;
  tags: Set<string>;
  mentions: Set<string>; // wikilink targets already present
  basename: string;
};

const STOPWORDS = new Set(['inbox', 'people', 'projects', 'daily', 'meta', 'email']);

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await rec(full); continue; }
      if (e.name.endsWith('.md')) out.push(path.relative(root, full));
    }
  }
  await rec(root);
  return out;
}

function basenameNoExt(p: string) { return path.basename(p).replace(/\.md$/, ''); }

function extractMentions(content: string): Set<string> {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(content)) !== null) out.add(m[1].trim());
  return out;
}

function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function candidatesFor(target: NoteMeta, all: NoteMeta[]): { path: string; score: number; reasons: string[] }[] {
  const folder = path.dirname(target.path);
  const out: { path: string; score: number; reasons: string[] }[] = [];
  for (const other of all) {
    if (other.path === target.path) continue;
    if (target.mentions.has(other.path) || target.mentions.has(other.path.replace(/\.md$/, ''))) continue;
    const otherBase = basenameNoExt(other.path);
    if (target.mentions.has(otherBase)) continue;

    const reasons: string[] = [];
    let score = 0;

    // Shared tags
    const tagOverlap = jaccard(target.tags, other.tags);
    if (tagOverlap > 0) { score += tagOverlap * 1.2; reasons.push(`tags ${(tagOverlap * 100).toFixed(0)}%`); }

    // Same folder bonus (low) — people↔people, projects↔projects
    if (folder === path.dirname(other.path) && !STOPWORDS.has(folder)) {
      score += 0.15; reasons.push(`folder ${folder}`);
    }

    // Mentioned-by: if target body contains other's basename token
    const tokenRe = new RegExp(`\\b${otherBase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (tokenRe.test(target.content)) {
      score += 0.6; reasons.push('body mention');
    }

    // Reciprocal: if other mentions target's basename
    const targetBase = basenameNoExt(target.path);
    const reverseRe = new RegExp(`\\b${targetBase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (reverseRe.test(other.content)) {
      score += 0.5; reasons.push('reverse mention');
    }

    // Email-to-person inference: if target is an email and other is a person whose email matches `to`/`from`/`cc`
    if (target.data?.kind === 'email' && other.data?.kind === 'person') {
      const emails: string[] = [
        ...(target.data.from ?? []),
        ...(target.data.to ?? []),
        ...(target.data.cc ?? []),
      ].map(String).map((s) => s.toLowerCase());
      const personEmails: string[] = (other.data.emails ?? []).map((s: string) => s.toLowerCase());
      if (emails.some((e) => personEmails.includes(e))) {
        score += 1.0; reasons.push('email contact');
      }
    }

    if (score >= 0.35) out.push({ path: other.path, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 6);
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { scanned: 0, error: 'vault not configured' };

  const paths = await walk(root);
  const notes: NoteMeta[] = [];
  for (const rel of paths) {
    try {
      const full = path.join(root, rel);
      const raw = await fs.readFile(full, 'utf8');
      const parsed = matter(raw);
      const tags = new Set<string>(Array.isArray(parsed.data.tags) ? parsed.data.tags : []);
      const existing = new Set<string>();
      const related: any[] = Array.isArray(parsed.data.related) ? parsed.data.related : [];
      for (const r of related) {
        const t = typeof r === 'string' ? r.replace(/^\[\[|\]\]$/g, '').trim() : '';
        if (t) existing.add(t);
      }
      for (const m of extractMentions(parsed.content)) existing.add(m);
      notes.push({ path: rel, full, data: parsed.data, content: parsed.content, tags, mentions: existing, basename: basenameNoExt(rel) });
    } catch {}
  }

  let scanned = 0;
  let updated = 0;
  let linksAdded = 0;
  let skipped = 0;
  let errors = 0;
  const sample: any[] = [];

  for (const n of notes) {
    scanned++;
    if (n.data?.do_not_link === true) { skipped++; continue; }
    const cands = candidatesFor(n, notes);
    if (!cands.length) { skipped++; continue; }

    const current: any[] = Array.isArray(n.data.related) ? n.data.related : [];
    const currentSet = new Set(current.map((r) => typeof r === 'string' ? r.replace(/^\[\[|\]\]$/g, '').trim() : ''));
    const toAdd: string[] = [];
    for (const c of cands) {
      const wiki = c.path.replace(/\.md$/, '');
      if (currentSet.has(wiki) || currentSet.has(c.path)) continue;
      toAdd.push(wiki);
    }
    if (!toAdd.length) { skipped++; continue; }

    n.data.related = [...current, ...toAdd.map((w) => `[[${w}]]`)];
    try {
      const newRaw = matter.stringify(n.content.trimEnd() + '\n', n.data);
      await fs.writeFile(n.full, newRaw, 'utf8');
      updated++;
      linksAdded += toAdd.length;
      if (sample.length < 25) sample.push({ path: n.path, added: toAdd, reasons: cands.slice(0, toAdd.length).map((c) => c.reasons) });
    } catch (e) {
      errors++;
      console.error('[link_weaver]', n.path, e);
    }
  }

  return {
    scanned,
    classified: updated,         // reuse field name for UI grid
    protected: 0, public: 0,     // not relevant
    skipped, errors,
    linksAdded,
    details: sample,
    durationMs: Date.now() - started,
  };
}

const agent: InternalAgent = {
  name: 'link_weaver',
  title: 'Link Weaver',
  description: 'Boosts brain connectivity. For each note, finds 1–6 best related notes by shared tags, body mentions, folder co-locality, and email↔person matches. Adds them to frontmatter `related:`. Skips notes marked `do_not_link: true`. Deterministic, no LLM cost.',
  defaultHour: 4,
  defaultMinute: 15,
  run,
  humanize(r, lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🧠 *Link Weaver* — non sono riuscito a tessere collegamenti: ${r?.error ?? 'errore sconosciuto'}.`
        : `🧠 *Link Weaver* — failed to weave connections: ${r?.error ?? 'unknown error'}.`;
    }
    const links = r.linksAdded ?? 0;
    const updated = r.classified ?? 0;
    if (lang === 'it') {
      if (!links) {
        return `🧠 *Link Weaver* — il tuo brain è già ben collegato, nessun nuovo legame da aggiungere.`;
      }
      return `🧠 *Link Weaver* — ho rafforzato il tuo brain: ${links} nuovi collegamenti aggiunti su ${updated} note. La rete dei tuoi pensieri diventa più ricca.`;
    }
    if (!links) {
      return `🧠 *Link Weaver* — your brain is already well-connected, no new links needed.`;
    }
    return `🧠 *Link Weaver* — strengthened your brain: ${links} new connections across ${updated} notes. Your thought network just got richer.`;
  },
};

export default agent;
