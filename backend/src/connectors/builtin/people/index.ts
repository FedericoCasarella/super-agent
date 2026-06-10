import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';
import { writeNote, readNote, getVaultRoot } from '../../../brain/vault.js';
import fs from 'node:fs/promises';
import path from 'node:path';

// Recursively walk vault for .md files. Used by delete/merge to rewrite or
// strip [[slug]] / [[people/slug]] / [[people/slug|alias]] wiki-links so the
// brain graph stays consistent after a Person disappears or is merged.
async function walkVault(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        await rec(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  }
  await rec(root);
  return out;
}

// Replace or strip [[old-slug]] refs across the vault. `replacement` null = strip.
async function rewriteRefs(userId: number, oldSlugs: string[], replacement: { slug: string; name: string } | null): Promise<number> {
  const root = await getVaultRoot(userId);
  if (!root) return 0;
  const files = await walkVault(root);
  // Match [[slug]] or [[people/slug]] or [[slug|alias]] (alias preserved on merge).
  const patterns = oldSlugs.map((s) => {
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\[\\[(?:people/)?${esc}(\\|[^\\]]+)?\\]\\]`, 'g');
  });
  let touched = 0;
  for (const f of files) {
    let txt: string;
    try { txt = await fs.readFile(f, 'utf8'); } catch { continue; }
    let next = txt;
    for (const re of patterns) {
      next = next.replace(re, (_m, alias) => {
        if (!replacement) return alias ? alias.slice(1) : ''; // strip link, keep alias text
        return `[[people/${replacement.slug}${alias ?? `|${replacement.name}`}]]`;
      });
    }
    if (next !== txt) {
      try { await fs.writeFile(f, next); touched++; } catch {}
    }
  }
  return touched;
}

function slugify(name: string) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function upsertPerson(userId: number, input: { name: string; aliases?: string[]; emails?: string[]; phones?: string[]; note?: string }) {
  const slug = slugify(input.name);
  const notePath = `people/${slug}.md`;
  const existing = await readNote(userId, notePath);
  const body = existing
    ? `${existing.content.trimEnd()}\n\n## ${new Date().toISOString().slice(0,10)}\n${input.note ?? ''}`
    : `# ${input.name}\n\n## ${new Date().toISOString().slice(0,10)}\n${input.note ?? ''}`;

  await writeNote(userId, notePath, {
    kind: 'person',
    title: input.name,
    aliases: input.aliases ?? existing?.data.aliases ?? [],
    emails: input.emails ?? existing?.data.emails ?? [],
    phones: input.phones ?? existing?.data.phones ?? [],
    tags: ['person'],
  }, body);

  await query(
    `INSERT INTO people(user_id,slug,name,aliases,emails,phones,note_path)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(user_id,slug) DO UPDATE SET
       name=EXCLUDED.name,
       aliases=ARRAY(SELECT DISTINCT UNNEST(people.aliases || EXCLUDED.aliases)),
       emails=ARRAY(SELECT DISTINCT UNNEST(people.emails || EXCLUDED.emails)),
       phones=ARRAY(SELECT DISTINCT UNNEST(people.phones || EXCLUDED.phones)),
       updated_at=now()`,
    [userId, slug, input.name, input.aliases ?? [], input.emails ?? [], input.phones ?? [], notePath]
  );
  return { slug, notePath };
}

export async function findPersonByPhone(userId: number, phone: string): Promise<{ slug: string; name: string } | null> {
  const norm = phone.replace(/\D/g, '');
  const rows = await query<{ slug: string; name: string }>(
    `SELECT slug, name FROM people WHERE user_id=$1 AND EXISTS (SELECT 1 FROM unnest(phones) p WHERE regexp_replace(p, '\\D', '', 'g') = $2) LIMIT 1`,
    [userId, norm],
  );
  return rows[0] ?? null;
}

// Hard delete a Person: DB row, .md file, and (optionally) [[slug]] refs.
// Also null-outs wa_contacts.linked_person_slug so the WA chat list doesn't
// keep an orphan pointer.
export async function deletePerson(userId: number, slug: string, opts: { keep_note?: boolean; keep_refs?: boolean } = {}) {
  const cur = await query<{ note_path: string | null }>(
    `SELECT note_path FROM people WHERE user_id=$1 AND slug=$2`, [userId, slug],
  );
  if (!cur[0]) throw new Error(`person ${slug} not found`);
  await query(`UPDATE wa_contacts SET linked_person_slug=NULL WHERE user_id=$1 AND linked_person_slug=$2`, [userId, slug]);
  await query(`DELETE FROM people WHERE user_id=$1 AND slug=$2`, [userId, slug]);
  let note_removed = false;
  if (!opts.keep_note) {
    try {
      const root = await getVaultRoot(userId);
      if (root) {
        const full = path.join(root, cur[0].note_path ?? `people/${slug}.md`);
        await fs.unlink(full); note_removed = true;
      }
    } catch {}
  }
  const refs_touched = opts.keep_refs ? 0 : await rewriteRefs(userId, [slug], null);
  return { ok: true, slug, note_removed, refs_touched };
}

// Merge N dup Persons into a canonical one. Union arrays, append note bodies,
// repoint WA links, rewrite vault refs, delete dups.
export async function mergePeople(userId: number, canonical_slug: string, dup_slugs: string[]) {
  if (!Array.isArray(dup_slugs) || !dup_slugs.length) throw new Error('dup_slugs empty');
  if (dup_slugs.includes(canonical_slug)) throw new Error('canonical cannot be in dup_slugs');
  const canon = await query<any>(`SELECT * FROM people WHERE user_id=$1 AND slug=$2`, [userId, canonical_slug]);
  if (!canon[0]) throw new Error(`canonical ${canonical_slug} not found`);
  const dups = await query<any>(`SELECT * FROM people WHERE user_id=$1 AND slug = ANY($2::text[])`, [userId, dup_slugs]);
  if (!dups.length) return { ok: true, canonical_slug, merged: 0, note: 'no dup rows found' };
  const aliases = Array.from(new Set([...(canon[0].aliases ?? []), ...dups.flatMap((d) => d.aliases ?? []), ...dups.map((d) => d.name)]));
  const emails = Array.from(new Set([...(canon[0].emails ?? []), ...dups.flatMap((d) => d.emails ?? [])]));
  const phones = Array.from(new Set([...(canon[0].phones ?? []), ...dups.flatMap((d) => d.phones ?? [])]));
  await query(`UPDATE people SET aliases=$3, emails=$4, phones=$5, updated_at=now() WHERE user_id=$1 AND slug=$2`,
    [userId, canonical_slug, aliases, emails, phones]);
  const canonNote = await readNote(userId, `people/${canonical_slug}.md`);
  let mergedBody = canonNote?.content ?? `# ${canon[0].name}\n`;
  for (const d of dups) {
    try {
      const dn = await readNote(userId, d.note_path ?? `people/${d.slug}.md`);
      if (dn?.content?.trim()) mergedBody += `\n\n## merged from ${d.slug}\n${dn.content.trim()}`;
    } catch {}
  }
  if (canonNote) {
    await writeNote(userId, `people/${canonical_slug}.md`, { ...canonNote.data, aliases, emails, phones }, mergedBody);
  }
  await query(`UPDATE wa_contacts SET linked_person_slug=$3 WHERE user_id=$1 AND linked_person_slug = ANY($2::text[])`,
    [userId, dup_slugs, canonical_slug]);
  const dupSlugList = dups.map((d) => d.slug);
  await query(`DELETE FROM people WHERE user_id=$1 AND slug = ANY($2::text[])`, [userId, dupSlugList]);
  const root = await getVaultRoot(userId);
  let files_removed = 0;
  if (root) {
    for (const d of dups) {
      try { await fs.unlink(path.join(root, d.note_path ?? `people/${d.slug}.md`)); files_removed++; } catch {}
    }
  }
  const refs_touched = await rewriteRefs(userId, dupSlugList, { slug: canonical_slug, name: canon[0].name });
  return { ok: true, canonical_slug, merged: dups.length, dup_slugs: dupSlugList, files_removed, refs_touched };
}

// DB ↔ Vault resync: rebuild the people DB table from .md files under <vault>/people/.
// Use when the DB drifted (manual file edits, broken dedupe, leftover rows).
// MODES:
//   prune=true  → delete DB rows whose .md no longer exists (full mirror).
//   prune=false → only upsert what's on disk; leave extras alone (safe default).
export async function resyncPeopleFromVault(userId: number, opts: { prune?: boolean } = {}) {
  const matter = (await import('gray-matter')).default;
  const root = await getVaultRoot(userId);
  if (!root) throw new Error('vault not configured');
  const dir = path.join(root, 'people');
  let entries: string[] = [];
  try { entries = await fs.readdir(dir); } catch { return { ok: true, scanned: 0, upserted: 0, pruned: 0 }; }
  const seen: string[] = [];
  let upserted = 0;
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const slug = f.replace(/\.md$/, '');
    seen.push(slug);
    let raw: string;
    try { raw = await fs.readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    const parsed = matter(raw);
    const fm = parsed.data ?? {};
    const name = String(fm.title ?? slug);
    const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
    const emails = Array.isArray(fm.emails) ? fm.emails : [];
    const phones = Array.isArray(fm.phones) ? fm.phones : [];
    await query(
      `INSERT INTO people(user_id, slug, name, aliases, emails, phones, note_path)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(user_id, slug) DO UPDATE SET
         name=EXCLUDED.name,
         aliases=EXCLUDED.aliases,
         emails=EXCLUDED.emails,
         phones=EXCLUDED.phones,
         updated_at=now()`,
      [userId, slug, name, aliases, emails, phones, `people/${slug}.md`],
    );
    upserted++;
  }
  let pruned = 0;
  if (opts.prune) {
    const orphan = await query<{ slug: string }>(
      `SELECT slug FROM people WHERE user_id=$1 AND NOT (slug = ANY($2::text[]))`,
      [userId, seen],
    );
    for (const o of orphan) {
      await query(`UPDATE wa_contacts SET linked_person_slug=NULL WHERE user_id=$1 AND linked_person_slug=$2`, [userId, o.slug]);
    }
    const del = await query<{ c: number }>(
      `WITH d AS (DELETE FROM people WHERE user_id=$1 AND NOT (slug = ANY($2::text[])) RETURNING 1) SELECT count(*)::int AS c FROM d`,
      [userId, seen],
    );
    pruned = del[0]?.c ?? 0;
  }
  return { ok: true, scanned: seen.length, upserted, pruned };
}

const connector: Connector = {
  manifest: {
    name: 'people',
    title: 'People Intelligence',
    description: 'Tracks people mentioned by the user, stores rolling notes per contact.',
    configSchema: [],
  },
  tools: [
    {
      name: 'search',
      description: 'Search people by name, alias, or email substring.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'number', default: 20 } },
        required: ['q'],
        additionalProperties: false,
      },
      handler: async (ctx, { q, limit = 20 }) => {
        const rows = await query(
          `SELECT slug, name, aliases, emails, note_path, updated_at FROM people
           WHERE user_id=$2 AND (
                name ILIKE $1
             OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $1)
             OR EXISTS (SELECT 1 FROM unnest(emails) e WHERE e ILIKE $1))
           ORDER BY updated_at DESC LIMIT $3`,
          [`%${q}%`, ctx.userId, limit]
        );
        return rows;
      },
    },
    {
      name: 'get',
      description: 'Get a person\'s record + note content by slug.',
      inputSchema: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
        additionalProperties: false,
      },
      handler: async (ctx, { slug }) => {
        const rows = await query<{ slug: string; name: string; aliases: string[]; emails: string[]; note_path: string }>(
          `SELECT slug, name, aliases, emails, note_path FROM people WHERE user_id=$1 AND slug=$2`, [ctx.userId, slug]
        );
        if (!rows[0]) return null;
        const note = rows[0].note_path ? await readNote(ctx.userId, rows[0].note_path) : null;
        return { ...rows[0], note };
      },
    },
    {
      name: 'upsert',
      description: 'Create or update a person (append note).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          emails: { type: 'array', items: { type: 'string' } },
          phones: { type: 'array', items: { type: 'string' }, description: 'Numeri telefono (con o senza prefisso, solo digits).' },
          note: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      handler: async (ctx, input) => upsertPerson(ctx.userId, input),
    },
    {
      name: 'list',
      description: 'List people with pagination + filtri (uguale al backend della pagina /people).',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Match su name/slug/aliases/emails/phones' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 },
          sort: { type: 'string', enum: ['name', 'slug', 'updated'], default: 'updated' },
          dir: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
        additionalProperties: false,
      },
      handler: async (ctx, { q, limit = 50, offset = 0, sort = 'updated', dir = 'desc' }) => {
        const sortMap: Record<string, string> = { name: 'name', slug: 'slug', updated: 'updated_at' };
        const sortCol = sortMap[sort] ?? 'updated_at';
        const sortDir = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const where: string[] = ['user_id=$1'];
        const params: any[] = [ctx.userId];
        if (q) {
          params.push(`%${q}%`);
          const i = params.length;
          where.push(`(name ILIKE $${i} OR slug ILIKE $${i}
            OR EXISTS(SELECT 1 FROM unnest(aliases) a WHERE a ILIKE $${i})
            OR EXISTS(SELECT 1 FROM unnest(emails) e WHERE e ILIKE $${i})
            OR EXISTS(SELECT 1 FROM unnest(phones) p WHERE p ILIKE $${i}))`);
        }
        const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM people WHERE ${where.join(' AND ')}`, params);
        const lim = Math.min(Math.max(Number(limit), 1), 200);
        const off = Math.max(Number(offset), 0);
        params.push(lim, off);
        const rows = await query<any>(
          `SELECT slug, name, aliases, emails, phones, note_path, updated_at FROM people
           WHERE ${where.join(' AND ')}
           ORDER BY ${sortCol} ${sortDir} NULLS LAST, id DESC
           LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        );
        return { rows, total: totalRows[0]?.c ?? 0, limit: lim, offset: off };
      },
    },
    {
      name: 'graph',
      description: 'Grafo cervello centrato su una persona — restituisce sub-tree (nodes + tree links) entro N hops. Stesso endpoint della modale People → Mini mappa 3D.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          hops: { type: 'number', default: 2, description: '1-4' },
        },
        required: ['slug'], additionalProperties: false,
      },
      handler: async (ctx, { slug, hops = 2 }) => {
        const h = Math.min(Math.max(Number(hops), 1), 4);
        const { buildGraph } = await import('../../../brain/graph.js');
        const g = await buildGraph(ctx.userId, {});
        const center = (g.nodes as any[]).find((n) => n.id?.endsWith(`::people/${slug}.md`) || n.id === `people/${slug}.md`);
        if (!center) return { nodes: [], links: [], center: null };
        const adj = new Map<string, Set<string>>();
        for (const l of g.links as any[]) {
          const s = typeof l.source === 'object' ? l.source.id : l.source;
          const t = typeof l.target === 'object' ? l.target.id : l.target;
          if (!adj.has(s)) adj.set(s, new Set());
          if (!adj.has(t)) adj.set(t, new Set());
          adj.get(s)!.add(t); adj.get(t)!.add(s);
        }
        const keep = new Set<string>([center.id]);
        let frontier = new Set<string>([center.id]);
        for (let i = 0; i < h; i++) {
          const next = new Set<string>();
          for (const id of frontier) for (const nb of adj.get(id) ?? []) {
            if (!keep.has(nb)) { keep.add(nb); next.add(nb); }
          }
          frontier = next;
          if (!frontier.size) break;
        }
        const level = new Map<string, number>([[center.id, 0]]);
        const parent = new Map<string, string>();
        const q: string[] = [center.id];
        while (q.length) {
          const id = q.shift()!; const lvl = level.get(id)!;
          for (const nb of adj.get(id) ?? []) {
            if (!keep.has(nb) || level.has(nb)) continue;
            level.set(nb, lvl + 1); parent.set(nb, id); q.push(nb);
          }
        }
        const nodes = (g.nodes as any[]).filter((n) => keep.has(n.id)).map((n) => ({ id: n.id, title: n.title, kind: n.kind, level: level.get(n.id) ?? 0 }));
        const links = [...parent].map(([child, par]) => ({ source: par, target: child }));
        return { nodes, links, center: center.id };
      },
    },
    {
      name: 'update',
      description: 'Update a Person REPLACING fields (vs upsert which only appends). Pass only fields you want to overwrite. Omit a field to leave it untouched. Updates DB + frontmatter on the note.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Person slug (canonical key).' },
          name: { type: 'string' },
          aliases: { type: 'array', items: { type: 'string' } },
          emails: { type: 'array', items: { type: 'string' } },
          phones: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug'],
        additionalProperties: false,
      },
      handler: async (ctx, { slug, name, aliases, emails, phones }) => {
        const cur = await query<any>(`SELECT * FROM people WHERE user_id=$1 AND slug=$2`, [ctx.userId, slug]);
        if (!cur[0]) throw new Error(`person ${slug} not found`);
        const sets: string[] = []; const params: any[] = [ctx.userId, slug]; let i = 2;
        if (name !== undefined) { sets.push(`name=$${++i}`); params.push(name); }
        if (aliases !== undefined) { sets.push(`aliases=$${++i}`); params.push(aliases); }
        if (emails !== undefined) { sets.push(`emails=$${++i}`); params.push(emails); }
        if (phones !== undefined) { sets.push(`phones=$${++i}`); params.push(phones); }
        if (!sets.length) return { slug, changed: 0 };
        sets.push(`updated_at=now()`);
        await query(`UPDATE people SET ${sets.join(', ')} WHERE user_id=$1 AND slug=$2`, params);
        // Mirror to note frontmatter so vault stays in sync.
        try {
          const note = await readNote(ctx.userId, `people/${slug}.md`);
          if (note) {
            await writeNote(ctx.userId, `people/${slug}.md`, {
              ...note.data,
              title: name ?? note.data.title,
              aliases: aliases ?? note.data.aliases ?? [],
              emails: emails ?? note.data.emails ?? [],
              phones: phones ?? note.data.phones ?? [],
            }, note.content);
          }
        } catch (e) { console.warn('[people.update] frontmatter mirror failed', e); }
        return { slug, changed: sets.length - 1 };
      },
    },
    {
      name: 'delete',
      description: 'Delete a Person from DB. Also deletes the note file and (by default) strips [[slug]] refs from the rest of the vault. PERMANENT. Use merge() if the goal is dedup — delete is for true removal.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          keep_note: { type: 'boolean', default: false, description: 'If true, leave the .md file on disk (only delete DB row).' },
          keep_refs: { type: 'boolean', default: false, description: 'If true, do NOT rewrite [[slug]] refs in other notes.' },
        },
        required: ['slug'], additionalProperties: false,
      },
      handler: async (ctx, { slug, keep_note = false, keep_refs = false }) =>
        deletePerson(ctx.userId, slug, { keep_note, keep_refs }),
    },
    {
      name: 'merge',
      description: 'Merge N duplicate People into a canonical one. Unions aliases/emails/phones into canonical, appends each dup note body under a "## merged from <slug>" section, deletes dup rows + .md files, rewrites [[dup-slug]] refs across the vault to point at canonical. Idempotent.',
      inputSchema: {
        type: 'object',
        properties: {
          canonical_slug: { type: 'string', description: 'Surviving Person.' },
          dup_slugs: { type: 'array', items: { type: 'string' }, description: 'Slugs to merge into canonical and delete.' },
        },
        required: ['canonical_slug', 'dup_slugs'], additionalProperties: false,
      },
      handler: async (ctx, { canonical_slug, dup_slugs }) => mergePeople(ctx.userId, canonical_slug, dup_slugs),
    },
    {
      name: 'resync_from_vault',
      description: 'Rebuild People DB rows from .md files under <vault>/people/. Use when DB drifted. prune=true also deletes DB rows whose .md no longer exists.',
      inputSchema: { type: 'object', properties: { prune: { type: 'boolean', default: false } }, additionalProperties: false },
      handler: async (ctx, { prune = false }) => resyncPeopleFromVault(ctx.userId, { prune }),
    },
    {
      name: 'dedupe_run',
      description: 'Lancia un sub-agent che trova e unifica duplicati People (DB + note brain). Esecuzione tracciata in /agents. NESSUNA conferma utente — è async. Ritorna sub_agent_id.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const { spawnSubAgent } = await import('../../../sub_agents/index.js');
        const prompt = `=== BONIFICA DUPLICATI PEOPLE ===

Compito: trova e unifica i duplicati nella tabella People del DB e nelle note del second brain.

PROCEDURA:
1. Leggi tutti i record People via tool people_list (paginato, limit 200).
2. Identifica gruppi di duplicati: stesso name normalizzato, email comune, phone comune, slug similar (Levenshtein < 3).
3. Per ogni gruppo:
   a. Scegli canonical = record con più dati (aliases+emails+phones più ricco, oppure quello linked in wa_contacts).
   b. Chiama people_merge({canonical_slug, dup_slugs}) — fa TUTTO: union arrays, append note bodies, delete dup rows + .md, repoint wa_contacts.linked_person_slug, rewrite [[dup-slug]] refs in tutto il vault.
   c. Se sicuro che un record è 100% spurio (no merge utile), usa people_delete({slug}).
4. Output finale: 1 paragrafo riepilogo (gruppi trovati, merged, deleted, errori). Niente Telegram.

VIETATO chiamare people_dedupe_run: TU SEI il dedupe runner. Usa people_merge/people_delete direttamente.`;
        const sa = await spawnSubAgent(ctx.userId, {
          title: 'Bonifica duplicati People',
          brief: 'Trova duplicati in People (name/email/phone) e unifica record + note brain.',
          prompt,
        });
        return { ok: true, sub_agent_id: sa.id };
      },
    },
  ],
};

export default connector;
