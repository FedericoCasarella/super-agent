import { getVaultRoot, readNote, writeNote } from '../../brain/vault.js';
import { runClaude } from '../../claude/runner.js';
import { getSetting, query } from '../../db/index.js';
import crypto from 'node:crypto';
import type { InternalAgent, AgentReport, Lang } from './types.js';

// Vault Librarian — fetches sector-relevant knowledge every 3h and curates it in the vault.
// Sources:
//   1. RSS feeds (sector + market news)
//   2. GitHub public repos (search by sector keywords, last week)
//   3. Optional: viral social posts (deferred — requires API keys not in scope here)
// Output: library/<YYYY-MM-DD>/<source>-<slug>.md, dedup by canonical URL hash.

function ymd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function slugify(s: string): string {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

function urlHash(url: string): string {
  return crypto.createHash('sha1').update(url.trim().toLowerCase()).digest('hex').slice(0, 12);
}

// Minimal RSS/Atom XML extractor — no external dep. Handles <item>/<entry> blocks.
type FeedItem = { title: string; link: string; description: string; pubDate: string | null; source: string };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFeed(xml: string, sourceName: string): FeedItem[] {
  const out: FeedItem[] = [];
  const itemBlocks = xml.match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi) ?? [];
  for (const block of itemBlocks.slice(0, 15)) {
    const title = decode((block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''));
    // RSS: <link>url</link>; Atom: <link href="url"/>
    let link = (block.match(/<link[^>]*href=["']([^"']+)["']/i)?.[1])
      ?? decode(block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? '');
    link = link.trim();
    const description = decode(
      block.match(/<(content|description|summary)[^>]*>([\s\S]*?)<\/(content|description|summary)>/i)?.[2] ?? ''
    ).slice(0, 600);
    const pubDate = (block.match(/<(pubDate|published|updated)[^>]*>([\s\S]*?)<\/(pubDate|published|updated)>/i)?.[2])?.trim() ?? null;
    if (title && link) out.push({ title, link, description, pubDate, source: sourceName });
  }
  return out;
}

async function fetchRss(url: string, sourceName: string): Promise<FeedItem[]> {
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'super-agent-vault-librarian/1.0' } });
    clearTimeout(to);
    if (!r.ok) return [];
    const xml = await r.text();
    return parseFeed(xml, sourceName);
  } catch { return []; }
}

type GhItem = { full_name: string; html_url: string; description: string; stargazers_count: number; language: string | null; pushed_at: string };

async function fetchGithubRepos(keyword: string, days = 7, perPage = 5): Promise<GhItem[]> {
  try {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const q = encodeURIComponent(`${keyword} pushed:>${since}`);
    const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}`;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'super-agent-vault-librarian/1.0' };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(url, { headers, signal: ac.signal });
    clearTimeout(to);
    if (!r.ok) return [];
    const j: any = await r.json();
    return (j.items ?? []) as GhItem[];
  } catch { return []; }
}

// Default RSS feeds (sector-neutral tech/business/AI seed). Per-user override
// via setting `vault_librarian_config = { feeds: [...], keywords: [...] }`.
const DEFAULT_FEEDS = [
  { name: 'TechCrunch',       url: 'https://techcrunch.com/feed/' },
  { name: 'Hacker News',      url: 'https://hnrss.org/frontpage' },
  { name: 'The Verge',        url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'MIT Tech Review',  url: 'https://www.technologyreview.com/feed/' },
  { name: 'Wired',            url: 'https://www.wired.com/feed/rss' },
];

async function getConfig(userId: number): Promise<{ feeds: { name: string; url: string }[]; keywords: string[] }> {
  const cfg = (await getSetting<any>(userId, 'vault_librarian_config')) ?? {};
  const business = (await getSetting<any>(userId, 'business')) ?? {};
  const inferredKeywords = [business.what, business.company, business.sector, business.niche]
    .filter(Boolean).map((s: string) => String(s).slice(0, 60));
  return {
    feeds: Array.isArray(cfg.feeds) && cfg.feeds.length ? cfg.feeds : DEFAULT_FEEDS,
    keywords: Array.isArray(cfg.keywords) && cfg.keywords.length ? cfg.keywords : (inferredKeywords.length ? inferredKeywords : ['ai', 'productivity']),
  };
}

async function existingHashes(userId: number): Promise<Set<string>> {
  // Read all library cards from brain_index, extract url_hash from frontmatter JSON in refs/summary.
  // Simpler: scan refs->url_hash if stored. We store it as a key in our writeNote frontmatter,
  // which `writeNote` persists into the markdown file but NOT into brain_index columns.
  // So fall back to scanning the file system. Vault path = getVaultRoot.
  const root = await getVaultRoot(userId);
  if (!root) return new Set();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const set = new Set<string>();
  // Index by SELECT from brain_index to enumerate library/*.md paths quickly
  const rows = await query<{ path: string }>(
    `SELECT path FROM brain_index WHERE user_id=$1 AND path LIKE 'library/%' ORDER BY updated_at DESC LIMIT 2000`,
    [userId],
  );
  for (const r of rows) {
    try {
      const raw = await fs.readFile(path.join(root, r.path), 'utf8');
      const m = raw.match(/^url_hash:\s*([a-f0-9]+)/m);
      if (m) set.add(m[1]);
    } catch {}
  }
  return set;
}

function buildSummaryPrompt(items: { title: string; link: string; description: string; source: string }[], keywords: string[]): string {
  const list = items.map((it, i) => `[${i + 1}] (${it.source}) ${it.title}\n${it.link}\n${it.description}`).join('\n\n');
  return [
    `Sei il "Vault Librarian" — bibliotecario della knowledge base personale.`,
    `Settore/parole-chiave dell'utente: ${keywords.join(', ')}.`,
    '',
    `Per OGNI item qui sotto, valuta rilevanza per il settore e, se ≥ 6/10, produci una scheda markdown:`,
    '',
    `--- FORMATO SCHEDA (ripeti per ogni item rilevante, separato da "===") ---`,
    `INDEX: <numero originale>`,
    `RELEVANCE: <0-10>`,
    `CARD:`,
    `---`,
    `title: <titolo conciso>`,
    `kind: library-card`,
    `source: <source name>`,
    `source_url: <link>`,
    `tags: [library, <tag-tematici>]`,
    `relevance: <0-10>`,
    `visibility: public`,
    `---`,
    ``,
    `# <titolo>`,
    ``,
    `**Fonte**: [\`<source>\`](<link>)`,
    ``,
    `## TL;DR`,
    `2-3 righe: cos'è, perché interessa al settore.`,
    ``,
    `## Punti chiave`,
    `- ...`,
    `- ...`,
    ``,
    `## Applicazione`,
    `Come puoi usarlo nel tuo lavoro/business (concreto).`,
    `=== fine scheda ===`,
    ``,
    `REGOLE:`,
    `- Italiano. Asciutto, no fluff.`,
    `- Salta item < 6/10 (NON produrre la sua scheda).`,
    `- Se NESSUN item rilevante: rispondi solo "NESSUNA RELEVANCE".`,
    ``,
    `=== ITEMS ===`,
    list,
  ].join('\n');
}

function splitCards(response: string): { index: number; relevance: number; body: string }[] {
  if (/NESSUNA RELEVANCE/i.test(response.slice(0, 200))) return [];
  const blocks = response.split(/^===\s*fine scheda\s*===\s*$/im).map((b) => b.trim()).filter(Boolean);
  const cards: { index: number; relevance: number; body: string }[] = [];
  for (const b of blocks) {
    const idxM = b.match(/^INDEX:\s*(\d+)/m);
    const relM = b.match(/^RELEVANCE:\s*(\d+)/m);
    const cardM = b.match(/^CARD:\s*\n([\s\S]+)$/m);
    if (!idxM || !cardM) continue;
    const index = parseInt(idxM[1], 10);
    const relevance = relM ? parseInt(relM[1], 10) : 0;
    const body = cardM[1].trim();
    if (relevance >= 6) cards.push({ index, relevance, body });
  }
  return cards;
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { error: 'vault not configured', durationMs: Date.now() - started };

  const { feeds, keywords } = await getConfig(userId);
  const seen = await existingHashes(userId);

  // 1. Fetch RSS feeds in parallel (cap concurrency = serial since few feeds).
  const allItems: FeedItem[] = [];
  for (const f of feeds.slice(0, 8)) {
    const items = await fetchRss(f.url, f.name);
    allItems.push(...items.slice(0, 5)); // cap 5 per feed
  }

  // 2. GitHub: query top keyword, last 7 days.
  const ghItems: GhItem[] = [];
  for (const kw of keywords.slice(0, 2)) {
    const repos = await fetchGithubRepos(kw, 7, 3);
    ghItems.push(...repos);
  }

  // Dedup by url hash vs vault
  const candidates: { title: string; link: string; description: string; source: string }[] = [];
  for (const it of allItems) {
    const h = urlHash(it.link);
    if (seen.has(h)) continue;
    seen.add(h);
    candidates.push({ title: it.title, link: it.link, description: it.description, source: it.source });
  }
  for (const r of ghItems) {
    const h = urlHash(r.html_url);
    if (seen.has(h)) continue;
    seen.add(h);
    candidates.push({
      title: `${r.full_name}${r.language ? ` (${r.language})` : ''} — ⭐ ${r.stargazers_count}`,
      link: r.html_url,
      description: r.description ?? '',
      source: 'GitHub',
    });
  }

  if (candidates.length === 0) {
    return { sources: feeds.length + 1, fetched: allItems.length + ghItems.length, saved: 0, reason: 'no new items', durationMs: Date.now() - started };
  }

  // Process in batches of 8 to keep prompts focused.
  const BATCH = 8;
  let saved = 0;
  const details: any[] = [];
  const created_paths: string[] = [];
  for (let i = 0; i < candidates.length && i < 24; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const prompt = buildSummaryPrompt(batch, keywords);
    const res = await runClaude(userId, prompt, {
      cwd: root, timeoutMs: 240_000, kind: 'vault-librarian',
      meta: { batch: i / BATCH, items: batch.length },
    });
    if (!res.ok) { details.push({ batch: i / BATCH, error: res.stderr?.slice(0, 200) ?? 'failed' }); continue; }
    const cards = splitCards(res.text);
    for (const c of cards) {
      const item = batch[c.index - 1];
      if (!item) continue;
      const slug = slugify(item.title);
      const rel = `library/${ymd()}/${slugify(item.source)}-${slug}.md`;
      try {
        const existing = await readNote(userId, rel).catch(() => null);
        if (existing) continue; // path collision — skip
        await writeNote(userId, rel, {
          kind: 'library-card',
          title: item.title,
          source: item.source,
          source_url: item.link,
          url_hash: urlHash(item.link),
          relevance: c.relevance,
          visibility: 'public',
          tags: ['library', `source/${slugify(item.source)}`],
          generated_at: new Date().toISOString(),
        }, c.body);
        saved++;
        created_paths.push(rel);
        details.push({ source: item.source, title: item.title.slice(0, 80), relevance: c.relevance, path: rel });
      } catch (e: any) {
        details.push({ source: item.source, title: item.title.slice(0, 80), error: String(e?.message ?? e).slice(0, 150) });
      }
    }
  }

  return {
    sources: feeds.length + (ghItems.length ? 1 : 0),
    fetched: allItems.length + ghItems.length,
    candidates: candidates.length,
    saved,
    created_paths,
    details: details.slice(0, 30),
    keywords,
    durationMs: Date.now() - started,
  };
}

const vault_librarian: InternalAgent = {
  name: 'vault_librarian',
  title: 'Vault Librarian',
  description: 'Bibliotecario della knowledge: ogni 3 ore raccoglie le migliori "scritture" sul tuo settore — repo GitHub pubbliche (top stars ultima settimana), feed RSS live di mercato/tech, e (in futuro) post virali. Filtra per rilevanza ≥ 6/10, dedup per URL, salva schede markdown in library/<data>/<source>-<slug>.md.',
  defaultHour: 6,
  defaultMinute: 0,
  defaultIntervalHours: 3,
  run,
  humanize: (report: AgentReport, lang: Lang, status: 'ok' | 'error') => {
    if (status === 'error') return lang === 'it'
      ? `**Vault Librarian** — esecuzione fallita: ${String(report?.error ?? 'errore')}`
      : `**Vault Librarian** — run failed: ${String(report?.error ?? 'error')}`;
    if (lang === 'it') return `📚 **Vault Librarian** — ${report.saved ?? 0} schede salvate (${report.fetched ?? 0} item da ${report.sources ?? 0} fonti, ${report.candidates ?? 0} nuovi).`;
    return `📚 **Vault Librarian** — ${report.saved ?? 0} cards saved (${report.fetched ?? 0} items from ${report.sources ?? 0} sources, ${report.candidates ?? 0} new).`;
  },
};

export default vault_librarian;
