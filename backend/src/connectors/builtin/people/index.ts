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
  ],
};

export default connector;
