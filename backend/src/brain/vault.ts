import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { getSetting, setSetting, query } from '../db/index.js';

export type VaultNote = {
  path: string;
  title?: string;
  tags: string[];
  data: Record<string, any>;
  content: string;
};

export async function getVaultRoot(userId: number): Promise<string | null> {
  const s = await getSetting<{ vaultPath: string }>(userId, 'vault');
  return s?.vaultPath ?? null;
}

export async function setVaultRoot(userId: number, vaultPath: string): Promise<void> {
  await fs.mkdir(vaultPath, { recursive: true });
  for (const sub of ['inbox', 'people', 'projects', 'daily', 'meta']) {
    await fs.mkdir(path.join(vaultPath, sub), { recursive: true });
  }
  await setSetting(userId, 'vault', { vaultPath });
}

export async function writeNote(userId: number, relPath: string, frontmatter: Record<string, any>, body: string): Promise<string> {
  const root = await getVaultRoot(userId);
  if (!root) throw new Error('vault not configured');
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const fm = matter.stringify(body.trimEnd() + '\n', frontmatter);
  await fs.writeFile(full, fm, 'utf8');
  await indexNote(userId, relPath, frontmatter, body);
  return full;
}

export async function appendNote(userId: number, relPath: string, line: string, frontmatterDefaults: Record<string, any> = {}): Promise<string> {
  const root = await getVaultRoot(userId);
  if (!root) throw new Error('vault not configured');
  const full = path.join(root, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  let existing = '';
  try { existing = await fs.readFile(full, 'utf8'); } catch {}
  if (!existing) {
    const fm = matter.stringify(line + '\n', { created: new Date().toISOString(), ...frontmatterDefaults });
    await fs.writeFile(full, fm, 'utf8');
  } else {
    await fs.appendFile(full, '\n' + line + '\n', 'utf8');
  }
  return full;
}

export async function readNote(userId: number, relPath: string): Promise<VaultNote | null> {
  const root = await getVaultRoot(userId);
  if (!root) return null;
  try {
    const raw = await fs.readFile(path.join(root, relPath), 'utf8');
    const parsed = matter(raw);
    return {
      path: relPath,
      title: parsed.data.title,
      tags: parsed.data.tags ?? [],
      data: parsed.data,
      content: parsed.content,
    };
  } catch {
    return null;
  }
}

export async function searchNotes(userId: number, q: string, limit = 20): Promise<VaultNote[]> {
  const root = await getVaultRoot(userId);
  if (!root) return [];
  const vaultRoot: string = root;
  const out: VaultNote[] = [];
  const term = q.toLowerCase();
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.name.endsWith('.md')) continue;
      const raw = await fs.readFile(full, 'utf8');
      if (!raw.toLowerCase().includes(term)) continue;
      const parsed = matter(raw);
      out.push({
        path: path.relative(vaultRoot, full),
        title: parsed.data.title,
        tags: parsed.data.tags ?? [],
        data: parsed.data,
        content: parsed.content,
      });
      if (out.length >= limit) return;
    }
  }
  await walk(vaultRoot);
  return out;
}

async function indexNote(userId: number, relPath: string, fm: Record<string, any>, content: string) {
  await query(
    `INSERT INTO brain_index(user_id,path,kind,title,tags,summary,refs,visibility,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT(user_id,path) DO UPDATE SET kind=EXCLUDED.kind, title=EXCLUDED.title,
       tags=EXCLUDED.tags, summary=EXCLUDED.summary, refs=EXCLUDED.refs,
       visibility=COALESCE(EXCLUDED.visibility, brain_index.visibility), updated_at=now()`,
    [
      userId,
      relPath,
      fm.kind ?? 'note',
      fm.title ?? null,
      fm.tags ?? [],
      content.slice(0, 280),
      fm.refs ?? {},
      fm.visibility ?? null,
    ]
  );
}
