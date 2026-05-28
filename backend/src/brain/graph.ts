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
};
export type GraphLink = { source: string; target: string };

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

function normalizeTarget(target: string, allPaths: Set<string>): string | null {
  const t = target.trim().replace(/^\.\//, '');
  const candidates = [t, `${t}.md`, t.endsWith('.md') ? t : `${t}.md`];
  for (const c of candidates) if (allPaths.has(c)) return c;
  const base = path.basename(t).replace(/\.md$/, '');
  for (const p of allPaths) {
    const pb = path.basename(p).replace(/\.md$/, '');
    if (pb === base) return p;
  }
  return null;
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

export async function buildGraph(userId: number, opts: { vaultFilter?: string } = {}): Promise<{ nodes: GraphNode[]; links: GraphLink[]; vaults: string[] }> {
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
    for (const rel of paths) {
      try {
        const raw = await fs.readFile(path.join(v.path, rel), 'utf8');
        const { data, content } = matter(raw);
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
          const tgt = normalizeTarget(t, pathSet);
          if (tgt && tgt !== rel) links.push({ source: id, target: `${v.name}::${tgt}` });
        }
      } catch {}
    }
  }

  const deg = new Map<string, number>();
  for (const l of links) {
    deg.set(l.source, (deg.get(l.source) ?? 0) + 1);
    deg.set(l.target, (deg.get(l.target) ?? 0) + 1);
  }
  for (const [id, n] of nodes) n.size = 1 + Math.min(10, deg.get(id) ?? 0);
  return { nodes: [...nodes.values()], links, vaults: vaults.map((v) => v.name) };
}
