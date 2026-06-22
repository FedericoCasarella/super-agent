import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { getVaultRoot } from './vault.js';
import { listVaults } from './vaults.js';

export type GraphNode = {
  id: string;
  title: string;
  kind: string;
  tags: string[];
  size: number;
  visibility: 'protected' | 'public' | null;
  origin_user_id: number | null;
  origin_email: string | null;
  vault: string;
  cluster: string;
};
export type GraphLink = { source: string; target: string };

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

// Cluster key = top folder of the relative path. MUST match the client's
// clusterOf() in BrainGraph3DConstellation so server-side link reduction and
// client clustering agree. "agents/foo.md" → "agents", root file → "_misc".
export function clusterForRel(rel: string): string {
  const parts = rel.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0].toLowerCase() : '_misc';
}

// O(1) target resolution using a prebuilt basename index, instead of scanning
// every path per wikilink (the old O(targets × paths) hot loop that dominated
// build time on large vaults).
function normalizeTarget(target: string, allPaths: Set<string>, baseIndex: Map<string, string>): string | null {
  const t = target.trim().replace(/^\.\//, '');
  if (allPaths.has(t)) return t;
  const withMd = t.endsWith('.md') ? t : `${t}.md`;
  if (allPaths.has(withMd)) return withMd;
  const base = path.basename(t).replace(/\.md$/, '');
  return baseIndex.get(base) ?? null;
}

// Bounded-concurrency map — parallelize the disk-bound file reads instead of
// awaiting them one at a time.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

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

export type BuiltGraph = { nodes: GraphNode[]; links: GraphLink[]; vaults: string[] };

// In-memory cache. Building the graph means reading every .md file in the
// vault (thousands), so it costs seconds — far too slow to redo on every page
// load / nav / filter change. Cache per (userId, vaultFilter) with a short TTL;
// note writes call invalidateGraphCache() for immediate freshness.
const graphCache = new Map<string, { ts: number; data: BuiltGraph }>();
const GRAPH_TTL_MS = 60_000;
export function invalidateGraphCache(userId?: number): void {
  if (userId == null) { graphCache.clear(); return; }
  for (const k of graphCache.keys()) if (k.startsWith(`${userId}:`)) graphCache.delete(k);
}

export async function buildGraph(userId: number, opts: { vaultFilter?: string } = {}): Promise<BuiltGraph> {
  const cacheKey = `${userId}:${opts.vaultFilter ?? 'all'}`;
  const hit = graphCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < GRAPH_TTL_MS) return hit.data;

  let vaults = await listVaults(userId);
  if (vaults.length === 0) {
    // Fallback to legacy single vault
    const root = await getVaultRoot(userId);
    if (!root) return { nodes: [], links: [], vaults: [] };
    vaults = [{ id: 0, user_id: userId, name: 'main', path: root, is_primary: true, created_at: '' }];
  }
  const targetVaults = opts.vaultFilter && opts.vaultFilter !== 'all'
    ? vaults.filter((v) => v.name === opts.vaultFilter)
    : vaults;

  const nodes = new Map<string, GraphNode>();
  const links: GraphLink[] = [];

  for (const v of targetVaults) {
    const paths = await walk(v.path);
    const pathSet = new Set(paths);
    // basename → path index for O(1) wikilink resolution (last-wins on dup
    // basenames, same as the old scan which returned the last match).
    const baseIndex = new Map<string, string>();
    for (const p of paths) baseIndex.set(path.basename(p).replace(/\.md$/, ''), p);

    // Read + parse files in parallel (disk-bound) instead of serially.
    const parsed = await mapPool(paths, 48, async (rel) => {
      try {
        const raw = await fs.readFile(path.join(v.path, rel), 'utf8');
        const { data, content } = matter(raw);
        return { rel, data, content };
      } catch { return null; }
    });

    for (const item of parsed) {
      if (!item) continue;
      const { rel, data, content } = item;
      const originUser = data.origin?.user_id ?? null;
      const originEmail = data.origin?.user_email ?? null;
      const id = `${v.name}::${rel}`;
      nodes.set(id, {
        id,
        title: data.title || path.basename(rel, '.md'),
        kind: data.kind || 'note',
        tags: data.tags ?? [],
        size: 1,
        visibility: (data.visibility === 'protected' || data.visibility === 'public') ? data.visibility : null,
        origin_user_id: typeof originUser === 'number' ? originUser : null,
        origin_email: typeof originEmail === 'string' ? originEmail : null,
        vault: v.name,
        cluster: clusterForRel(rel),
      });
      const targets = new Set<string>();
      const related = data.related;
      if (Array.isArray(related)) {
        for (const r of related) {
          const t = typeof r === 'string' ? r.replace(/^\[\[|\]\]$/g, '') : null;
          if (t) targets.add(t);
        }
      }
      for (const m of content.matchAll(WIKILINK_RE)) targets.add(m[1]);
      for (const t of targets) {
        const tgt = normalizeTarget(t, pathSet, baseIndex);
        if (tgt && tgt !== rel) links.push({ source: id, target: `${v.name}::${tgt}` });
      }
    }
  }

  const deg = new Map<string, number>();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  for (const [id, n] of nodes) n.size = 1 + Math.min(10, deg.get(id) ?? 0);
  const data: BuiltGraph = { nodes: [...nodes.values()], links, vaults: vaults.map((v) => v.name) };
  graphCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}
