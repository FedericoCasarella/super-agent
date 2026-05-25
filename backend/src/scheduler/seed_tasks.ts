import { query } from '../db/index.js';
import { listActiveUsers } from '../db/index.js';
import { refreshTasks } from './tasks.js';

// Default daily anchor tasks per user. Created once (name-keyed), never overwritten.
const DEFAULTS = [
  {
    name: 'daily-kickoff',
    cron: '0 9 * * *', // 09:00 daily
    action_type: 'prompt' as const,
    action_payload: {
      prompt: [
        'Esegui il MORNING KICKOFF.',
        '1) Leggi `meta/business-roadmap.md`.',
        '2) Identifica l\'item Discovery/Strategy/Execution PIÙ leva oggi.',
        '3) Scrivi all\'utente UN solo messaggio breve in italiano:',
        '   - frase 1: dove siamo (1 riga, basata sulla roadmap).',
        '   - frase 2: la UNA domanda/azione chiave per oggi.',
        '   - chiusura: "Su cosa vuoi muoverti per primo?"',
        'Se non c\'è nulla di nuovo o user in quiet mode → SKIP.',
      ].join('\n'),
    },
  },
  {
    name: 'evening-commit',
    cron: '0 19 * * *', // 19:00 daily
    action_type: 'prompt' as const,
    action_payload: {
      prompt: [
        'Esegui la EVENING REVIEW.',
        '1) Leggi `meta/business-roadmap.md` + ultime 30 conversazioni.',
        '2) Identifica cosa è stato chiuso oggi e cosa è rimasto aperto.',
        '3) Scrivi UN solo messaggio breve in italiano:',
        '   - 1 linea: cosa abbiamo chiuso oggi.',
        '   - 1 linea: cosa resta aperto (il top blocker).',
        '   - chiusura: chiedi 1 commitment concreto per domani (cosa farai + entro quando).',
        'Aggiorna roadmap con eventuali tick `roadmap_set_status`. Se giornata vuota → SKIP.',
      ].join('\n'),
    },
  },
];

export async function seedDefaultTasksForUser(userId: number) {
  let created = 0;
  for (const def of DEFAULTS) {
    const existing = await query<{ id: number }>(
      `SELECT id::int FROM scheduled_tasks WHERE user_id=$1 AND name=$2`,
      [userId, def.name]
    );
    if (existing.length) continue;
    await query(
      `INSERT INTO scheduled_tasks(user_id, name, cron, action_type, action_payload, enabled)
       VALUES($1, $2, $3, $4, $5::jsonb, true)`,
      [userId, def.name, def.cron, def.action_type, JSON.stringify(def.action_payload)]
    );
    created++;
  }
  if (created) console.log(`[seed-tasks:u${userId}] created ${created} default task(s)`);
  return created;
}

export async function seedDefaultTasksAllUsers() {
  const users = await listActiveUsers();
  let total = 0;
  for (const u of users) total += await seedDefaultTasksForUser(u.id);
  if (total) await refreshTasks();
  return total;
}
