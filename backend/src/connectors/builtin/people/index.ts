import type { Connector } from '../../types.js';
import { query } from '../../../db/index.js';
import { writeNote, readNote } from '../../../brain/vault.js';

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
      name: 'dedupe_run',
      description: 'Lancia un sub-agent che trova e unifica duplicati People (DB + note brain). Esecuzione tracciata in /agents. NESSUNA conferma utente — è async. Ritorna sub_agent_id.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async (ctx) => {
        const { spawnSubAgent } = await import('../../../sub_agents/index.js');
        const prompt = `=== BONIFICA DUPLICATI PEOPLE ===

Compito: trova e unifica i duplicati nella tabella People del DB e nelle note del second brain.

PROCEDURA:
1. Leggi tutti i record People via tool people_list (paginato).
2. Identifica gruppi di duplicati: stesso name normalizzato, email comune, phone comune, slug similar.
3. Per ogni gruppo: scegli canonical (più dati), merge via people_upsert, append note nel canonical e elimina vecchie, aggiorna riferimenti [[old]].
4. Output: 1 paragrafo riepilogo (gruppi, merge, skip, errori). Niente Telegram.
VIETATO chiamare people_dedupe_run: TU SEI il dedupe runner.`;
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
