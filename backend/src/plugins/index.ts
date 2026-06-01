import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import AdmZip from 'adm-zip';
import { query } from '../db/index.js';
import { registerConnector, unregisterConnector } from '../connectors/registry.js';
import type { Connector } from '../connectors/types.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.resolve(__dirname, '../../../plugins');

export type PluginManifest = {
  slug: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  entry: string;             // relative path to JS file inside plugin dir
  permissions?: string[];    // informational
};

export type PluginRow = {
  id: number;
  slug: string;
  version: string | null;
  name: string;
  description: string | null;
  author: string | null;
  install_path: string;
  enabled: boolean;
  manifest: PluginManifest;
  installed_at: string;
};

async function ensureDir() { await fs.mkdir(PLUGINS_DIR, { recursive: true }); }

function isSafeSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,63}$/i.test(s);
}

async function readManifest(dir: string): Promise<PluginManifest> {
  const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  const m = JSON.parse(raw);
  if (!m.slug || !m.name || !m.entry) throw new Error('manifest missing slug/name/entry');
  if (!isSafeSlug(m.slug)) throw new Error(`slug "${m.slug}" non valido (a-z0-9_-, max 64)`);
  return m;
}

async function importPlugin(dir: string, manifest: PluginManifest): Promise<Connector> {
  const entryAbs = path.resolve(dir, manifest.entry);
  if (!entryAbs.startsWith(path.resolve(dir))) throw new Error('entry path escape');
  // Bust cache (Node ESM doesn't support delete, but dynamic import resolves to same module — append ?v= for reload)
  const href = url.pathToFileURL(entryAbs).href + `?v=${Date.now()}`;
  const mod: any = await import(href);
  const conn: Connector = mod.default ?? mod.connector ?? mod;
  if (!conn?.manifest?.name) throw new Error('plugin export missing connector.manifest.name');
  return conn;
}

export async function listPlugins(): Promise<PluginRow[]> {
  return query<PluginRow>(
    `SELECT id::int, slug, version, name, description, author, install_path, enabled, manifest, installed_at
     FROM plugins ORDER BY installed_at DESC`
  );
}

export async function loadAllPlugins(): Promise<void> {
  await ensureDir();
  const rows = await listPlugins();
  for (const p of rows) {
    if (!p.enabled) continue;
    try {
      const conn = await importPlugin(p.install_path, p.manifest);
      registerConnector(conn);
      console.log(`[plugins] loaded ${p.slug} (connector "${conn.manifest.name}")`);
    } catch (e: any) {
      console.error(`[plugins] failed to load ${p.slug}:`, e?.message ?? e);
    }
  }
}

export async function installFromZip(buffer: Buffer): Promise<PluginRow> {
  await ensureDir();
  const zip = new AdmZip(buffer);
  // Find manifest.json (might be at root or nested one level)
  const entries = zip.getEntries();
  const manifestEntry = entries.find((e) => e.entryName === 'manifest.json' || e.entryName.endsWith('/manifest.json') && e.entryName.split('/').length === 2);
  if (!manifestEntry) throw new Error('manifest.json non trovato nel .skill');
  const manifest: PluginManifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  if (!manifest.slug || !manifest.name || !manifest.entry) throw new Error('manifest invalido');
  if (!isSafeSlug(manifest.slug)) throw new Error(`slug non valido: ${manifest.slug}`);

  const targetDir = path.join(PLUGINS_DIR, manifest.slug);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  // Determine prefix (root or nested folder)
  const prefix = manifestEntry.entryName === 'manifest.json' ? '' : manifestEntry.entryName.slice(0, manifestEntry.entryName.length - 'manifest.json'.length);
  for (const e of entries) {
    if (!e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel) continue;
    const dest = path.join(targetDir, rel);
    if (!dest.startsWith(targetDir)) continue; // zip-slip guard
    if (e.isDirectory) {
      await fs.mkdir(dest, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, e.getData());
    }
  }

  // Validate by importing
  await importPlugin(targetDir, manifest);

  // Persist
  const rows = await query<PluginRow>(
    `INSERT INTO plugins(slug, version, name, description, author, install_path, enabled, manifest)
     VALUES($1,$2,$3,$4,$5,$6,true,$7::jsonb)
     ON CONFLICT(slug) DO UPDATE SET
       version=EXCLUDED.version, name=EXCLUDED.name, description=EXCLUDED.description, author=EXCLUDED.author,
       install_path=EXCLUDED.install_path, manifest=EXCLUDED.manifest, updated_at=now()
     RETURNING id::int, slug, version, name, description, author, install_path, enabled, manifest, installed_at`,
    [
      manifest.slug, manifest.version ?? null, manifest.name,
      manifest.description ?? null, manifest.author ?? null,
      targetDir, JSON.stringify(manifest),
    ],
  );
  // Reload into registry
  const conn = await importPlugin(targetDir, manifest);
  registerConnector(conn);
  return rows[0];
}

export async function setEnabled(slug: string, enabled: boolean): Promise<void> {
  const rows = await query<PluginRow>(
    `UPDATE plugins SET enabled=$2, updated_at=now() WHERE slug=$1
     RETURNING id::int, slug, version, name, description, author, install_path, enabled, manifest, installed_at`,
    [slug, enabled],
  );
  if (!rows[0]) throw new Error('plugin non trovato');
  if (enabled) {
    const conn = await importPlugin(rows[0].install_path, rows[0].manifest);
    registerConnector(conn);
  } else {
    unregisterConnector(rows[0].manifest.name);
  }
}

export async function uninstall(slug: string): Promise<void> {
  const rows = await query<PluginRow>(
    `SELECT slug, manifest, install_path FROM plugins WHERE slug=$1`, [slug],
  );
  const p = rows[0];
  if (!p) return;
  unregisterConnector(p.manifest.name);
  try { await fs.rm(p.install_path, { recursive: true, force: true }); } catch {}
  await query(`DELETE FROM plugins WHERE slug=$1`, [slug]);
}

export async function exportToZip(slug: string): Promise<Buffer> {
  const rows = await query<PluginRow>(`SELECT install_path FROM plugins WHERE slug=$1`, [slug]);
  const p = rows[0];
  if (!p) throw new Error('plugin non trovato');
  const zip = new AdmZip();
  zip.addLocalFolder(p.install_path);
  return zip.toBuffer();
}
