// Multi-vault management. A user can connect N folders as separate "brains".
// One is `is_primary` = the cwd for chat turns; the others are accessible by
// absolute path (Claude can Read/Write them too).
import path from 'node:path';
import fs from 'node:fs/promises';
import { query, getSetting, setSetting } from '../db/index.js';

export type Vault = { id: number; user_id: number; name: string; path: string; is_primary: boolean; created_at: string };

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function ensureDirs(root: string, seed: boolean) {
  await fs.mkdir(root, { recursive: true });
  if (seed) {
    for (const sub of ['inbox', 'people', 'projects', 'daily', 'meta']) {
      await fs.mkdir(path.join(root, sub), { recursive: true });
    }
  }
}

/** Migrate legacy single-vault setting into the vaults table on demand. */
export async function ensureVaultRowsForUser(userId: number) {
  const rows = await query<{ c: number }>('SELECT count(*)::int AS c FROM vaults WHERE user_id=$1', [userId]);
  if ((rows[0]?.c ?? 0) > 0) return;
  const legacy = await getSetting<{ vaultPath: string }>(userId, 'vault');
  if (!legacy?.vaultPath) return;
  await query(
    `INSERT INTO vaults(user_id, name, path, is_primary) VALUES($1, $2, $3, true)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId, 'main', legacy.vaultPath]
  );
}

export async function listVaults(userId: number): Promise<Vault[]> {
  await ensureVaultRowsForUser(userId);
  return query<Vault>(
    `SELECT id::int, user_id::int, name, path, is_primary, created_at
     FROM vaults WHERE user_id=$1 ORDER BY is_primary DESC, id ASC`,
    [userId]
  );
}

export async function getPrimaryVault(userId: number): Promise<Vault | null> {
  await ensureVaultRowsForUser(userId);
  const rows = await query<Vault>(
    `SELECT id::int, user_id::int, name, path, is_primary, created_at
     FROM vaults WHERE user_id=$1 AND is_primary=true LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function getVaultById(userId: number, vaultId: number): Promise<Vault | null> {
  const rows = await query<Vault>(
    `SELECT id::int, user_id::int, name, path, is_primary, created_at
     FROM vaults WHERE user_id=$1 AND id=$2`,
    [userId, vaultId]
  );
  return rows[0] ?? null;
}

export async function createVault(userId: number, name: string, vaultPath: string, opts: { seed?: boolean; makePrimary?: boolean } = {}): Promise<Vault> {
  const cleanName = slugify(name) || `vault-${Date.now()}`;
  const seed = opts.seed !== false;
  await ensureDirs(vaultPath, seed);
  const isFirst = (await listVaults(userId)).length === 0;
  const primary = opts.makePrimary || isFirst;
  if (primary) {
    await query('UPDATE vaults SET is_primary=false WHERE user_id=$1', [userId]);
  }
  const rows = await query<Vault>(
    `INSERT INTO vaults(user_id, name, path, is_primary) VALUES($1, $2, $3, $4)
     RETURNING id::int, user_id::int, name, path, is_primary, created_at`,
    [userId, cleanName, vaultPath, primary]
  );
  // Keep legacy `settings.vault` in sync with primary (for any code still reading it)
  if (primary) await setSetting(userId, 'vault', { vaultPath });
  return rows[0];
}

export async function setPrimaryVault(userId: number, vaultId: number) {
  const v = await getVaultById(userId, vaultId);
  if (!v) throw new Error('vault not found');
  await query('UPDATE vaults SET is_primary=false WHERE user_id=$1', [userId]);
  await query('UPDATE vaults SET is_primary=true WHERE user_id=$1 AND id=$2', [userId, vaultId]);
  await setSetting(userId, 'vault', { vaultPath: v.path });
}

export async function deleteVault(userId: number, vaultId: number) {
  const v = await getVaultById(userId, vaultId);
  if (!v) return;
  if (v.is_primary) {
    const others = (await listVaults(userId)).filter((x) => x.id !== vaultId);
    if (others.length === 0) throw new Error('cannot remove the only vault');
    // Promote the next vault to primary BEFORE deletion
    await setPrimaryVault(userId, others[0].id);
  }
  await query('DELETE FROM vaults WHERE user_id=$1 AND id=$2', [userId, vaultId]);
}
