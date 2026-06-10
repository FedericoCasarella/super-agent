import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { query } from '../db/index.js';
import type { Connector, ConnectorContext } from './types.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILTIN_DIR = path.join(__dirname, 'builtin');
// In dev (tsx) questo file è .ts e i connettori sono index.ts; in prod (node dist)
// è .js e i connettori sono index.js. Deriviamo l'estensione dal runtime stesso
// così il loader funziona in entrambi.
const MOD_EXT = path.extname(__filename) || '.js';

const registry = new Map<string, Connector>();

export async function loadConnectors() {
  const entries = await fs.readdir(BUILTIN_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const modPath = path.join(BUILTIN_DIR, e.name, `index${MOD_EXT}`);
    try {
      const mod = await import(url.pathToFileURL(modPath).href);
      const conn: Connector = mod.default ?? mod.connector;
      if (!conn?.manifest) continue;
      registry.set(conn.manifest.name, conn);
      console.log(`[connectors] loaded ${conn.manifest.name}`);
    } catch (err) {
      console.error(`[connectors] load failed ${e.name}`, err);
    }
  }
}

export function registerConnector(conn: Connector) {
  if (!conn?.manifest?.name) throw new Error('connector missing manifest.name');
  registry.set(conn.manifest.name, conn);
}
export function unregisterConnector(name: string) {
  registry.delete(name);
}

export function listConnectors(): Connector[] {
  return [...registry.values()];
}

export function getConnector(name: string): Connector | undefined {
  return registry.get(name);
}

export async function ensureUserConnectorRows(userId: number) {
  for (const c of registry.values()) {
    await query(
      `INSERT INTO connectors(user_id, name) VALUES($1, $2)
       ON CONFLICT(user_id, name) DO NOTHING`,
      [userId, c.manifest.name]
    );
  }
}

export async function buildContext(userId: number, name: string): Promise<ConnectorContext> {
  await ensureUserConnectorRows(userId);
  const rows = await query<{ config: any; state: any }>(
    'SELECT config, state FROM connectors WHERE user_id=$1 AND name=$2',
    [userId, name]
  );
  const row = rows[0] ?? { config: {}, state: {} };
  return {
    userId,
    config: row.config,
    state: row.state,
    saveState: async (next) => {
      await query(
        'UPDATE connectors SET state=$1::jsonb, updated_at=now() WHERE user_id=$2 AND name=$3',
        [JSON.stringify(next ?? {}), userId, name]
      );
    },
    log: (msg, meta) => console.log(`[u${userId}:${name}]`, msg, meta ?? ''),
  };
}
