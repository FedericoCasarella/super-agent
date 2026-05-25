import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

// User-scoped setting helpers
export async function getSetting<T = any>(userId: number, key: string): Promise<T | null> {
  const rows = await query<{ value: T }>('SELECT value FROM settings WHERE user_id=$1 AND key=$2', [userId, key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(userId: number, key: string, value: any): Promise<void> {
  if (value === null || value === undefined) {
    await query('DELETE FROM settings WHERE user_id=$1 AND key=$2', [userId, key]);
    return;
  }
  await query(
    `INSERT INTO settings(user_id,key,value) VALUES($1,$2,$3::jsonb)
     ON CONFLICT(user_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [userId, key, JSON.stringify(value)]
  );
}

// List all users that have a telegram chatId configured (for reflection loop, etc.)
export async function listActiveUsers(): Promise<{ id: number; email: string }[]> {
  const rows = await query<{ id: number; email: string }>(
    `SELECT u.id::int, u.email FROM users u
     JOIN settings s ON s.user_id=u.id AND s.key='telegram'
     WHERE (s.value->>'chatId') IS NOT NULL`
  );
  return rows;
}
