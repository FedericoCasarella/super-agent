import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { query, getSetting } from '../db/index.js';
import { listVaults } from './vaults.js';
import { buildGraph } from './graph.js';

export type Snapshot = {
  id: number;
  user_id: number;
  vault_name: string;
  vault_path: string;
  snapshot_dir: string;
  file_count: number;
  size_bytes: number;
  neurons_count: number;
  links_count: number;
  duration_ms: number;
  trigger: 'cron' | 'manual';
  status: 'ok' | 'error';
  error: string | null;
  created_at: string;
};

// Resolve the user-configured snapshot root. Falls back to
// ~/.super-agent/snapshots/u<userId>. Setting key: `brain_snapshot_dir`.
export async function getSnapshotRoot(userId: number): Promise<string> {
  const cfg = await getSetting<{ dir: string }>(userId, 'brain_snapshot_dir');
  const base = cfg?.dir?.trim() || path.join(os.homedir(), '.super-agent', 'snapshots');
  return path.join(base, `u${userId}`);
}

export async function setSnapshotRoot(userId: number, dir: string): Promise<void> {
  const { setSetting } = await import('../db/index.js');
  await setSetting(userId, 'brain_snapshot_dir', { dir: dir.trim() });
}

// Recursively copy a directory tree. Skips dot-folders + node_modules.
// Returns aggregated file count and byte size for the copy.
async function copyTree(src: string, dst: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  await fs.mkdir(dst, { recursive: true });
  let entries: any[] = [];
  try { entries = await fs.readdir(src, { withFileTypes: true }); }
  catch { return { files, bytes }; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const a = path.join(src, e.name);
    const b = path.join(dst, e.name);
    if (e.isDirectory()) {
      const sub = await copyTree(a, b);
      files += sub.files; bytes += sub.bytes;
    } else if (e.isFile()) {
      try {
        await fs.copyFile(a, b);
        const st = await fs.stat(a);
        bytes += st.size;
        files += 1;
      } catch {}
    }
  }
  return { files, bytes };
}

// Build one snapshot per vault and persist a row each. Cron + manual trigger
// both call this. Returns the inserted Snapshot rows.
export async function createSnapshots(userId: number, trigger: 'cron' | 'manual' = 'cron'): Promise<Snapshot[]> {
  const vaults = await listVaults(userId);
  if (!vaults.length) return [];
  const root = await getSnapshotRoot(userId);
  await fs.mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out: Snapshot[] = [];

  // Compute graph once for the whole user so we can attribute counts per vault.
  let allNodes: any[] = [];
  let allLinks: any[] = [];
  try {
    const g = await buildGraph(userId, {});
    allNodes = g.nodes as any[];
    allLinks = g.links as any[];
  } catch {}
  function countsFor(vaultName: string) {
    const ids = new Set<string>();
    for (const n of allNodes) if (n.vault === vaultName) ids.add(n.id);
    const neurons = ids.size;
    let links = 0;
    for (const l of allLinks) {
      const s = typeof l.source === 'object' ? l.source.id : l.source;
      const t = typeof l.target === 'object' ? l.target.id : l.target;
      if (ids.has(s) && ids.has(t)) links++;
    }
    return { neurons, links };
  }

  for (const v of vaults) {
    const t0 = Date.now();
    const snapDir = path.join(root, v.name, stamp);
    let status: 'ok' | 'error' = 'ok';
    let err: string | null = null;
    let res = { files: 0, bytes: 0 };
    try { res = await copyTree(v.path, snapDir); }
    catch (e: any) { status = 'error'; err = String(e?.message ?? e).slice(0, 500); }
    const { neurons, links } = countsFor(v.name);
    const rows = await query<Snapshot>(
      `INSERT INTO brain_snapshots(user_id, vault_name, vault_path, snapshot_dir, file_count, size_bytes,
        neurons_count, links_count, duration_ms, trigger, status, error)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [userId, v.name, v.path, snapDir, res.files, res.bytes, neurons, links, Date.now() - t0, trigger, status, err],
    );
    out.push(rows[0]);
  }

  // Telegram heads-up so every snapshot (cron 00:00 or manual run) leaves a
  // visible trail. Aggregate stats; one message per run, not per vault.
  try {
    // pg returns bigint columns as STRING. Forcing Number() avoids
    // string-concat bugs in reduce ("0" + "765625" + "2831000" → 7.6e12).
    const num = (v: any) => (typeof v === 'number' ? v : Number(v ?? 0)) || 0;
    const okCount = out.filter((s) => s.status === 'ok').length;
    const errCount = out.length - okCount;
    const totalBytes = out.reduce((a, s) => a + num(s.size_bytes), 0);
    const totalFiles = out.reduce((a, s) => a + num(s.file_count), 0);
    const totalNeurons = out.reduce((a, s) => a + num(s.neurons_count), 0);
    const totalLinks = out.reduce((a, s) => a + num(s.links_count), 0);
    const head = errCount
      ? `⚠️ Snapshot ${trigger} — ${okCount} ok, ${errCount} errore`
      : `📦 Snapshot ${trigger} — ${okCount} cervell${okCount === 1 ? 'o' : 'i'}`;
    const lines = out.map((s) =>
      s.status === 'ok'
        ? `• ${s.vault_name} · ${num(s.neurons_count)} neuroni · ${num(s.links_count)} link · ${fmtBytes(num(s.size_bytes))}`
        : `• ${s.vault_name} · ❌ ${s.error ?? 'errore'}`,
    );
    const tail = `Tot: ${totalNeurons} neuroni · ${totalLinks} link · ${totalFiles} file · ${fmtBytes(totalBytes)}`;
    const msg = [head, '', ...lines, '', tail].join('\n');
    const { sendTelegram } = await import('../telegram/bot.js');
    await sendTelegram(userId, msg, 'snapshot');
  } catch (e) { console.error('[snapshots] telegram notify failed', e); }

  return out;
}

function fmtBytes(n: number): string {
  if (!n || n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export async function listSnapshots(userId: number, opts: { vault?: string; limit?: number; offset?: number } = {}): Promise<{ rows: Snapshot[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: string[] = ['user_id=$1'];
  const params: any[] = [userId];
  if (opts.vault) { params.push(opts.vault); where.push(`vault_name=$${params.length}`); }
  const totalRows = await query<{ c: number }>(`SELECT count(*)::int AS c FROM brain_snapshots WHERE ${where.join(' AND ')}`, params);
  params.push(limit, offset);
  const rows = await query<Snapshot>(
    `SELECT * FROM brain_snapshots WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: totalRows[0]?.c ?? 0 };
}

// Restore a snapshot back into its vault. Auto-creates a safety snapshot of
// the CURRENT state first so the user can undo. Vault `.md` tree is wiped
// then the snapshot is copied over. Other vaults untouched.
export async function restoreSnapshot(userId: number, id: number): Promise<{ ok: boolean; restored?: number; safety_snapshot_id?: number; error?: string }> {
  const rows = await query<{ vault_name: string; vault_path: string; snapshot_dir: string }>(
    `SELECT vault_name, vault_path, snapshot_dir FROM brain_snapshots WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  if (!rows[0]) return { ok: false, error: 'snapshot non trovato' };
  const { vault_name, vault_path, snapshot_dir } = rows[0];
  // Sanity: the snapshot dir must still exist on disk.
  try { await fs.access(snapshot_dir); }
  catch { return { ok: false, error: 'cartella snapshot non più presente su disco' }; }

  // 1. Take a safety snapshot of the CURRENT vault state so the user can roll
  //    forward again if the restore is wrong. We only snapshot this one vault.
  const t0 = Date.now();
  const root = await getSnapshotRoot(userId);
  await fs.mkdir(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-pre-restore';
  const safetyDir = path.join(root, vault_name, stamp);
  let safetyId: number | undefined;
  try {
    const safety = await copyTree(vault_path, safetyDir);
    const safetyRows = await query<{ id: number }>(
      `INSERT INTO brain_snapshots(user_id, vault_name, vault_path, snapshot_dir, file_count, size_bytes,
        neurons_count, links_count, duration_ms, trigger, status)
       VALUES($1,$2,$3,$4,$5,$6,0,0,$7,'manual','ok') RETURNING id`,
      [userId, vault_name, vault_path, safetyDir, safety.files, safety.bytes, Date.now() - t0],
    );
    safetyId = safetyRows[0]?.id;
  } catch (e: any) {
    return { ok: false, error: `safety snapshot fallito: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  // 2. Wipe current vault content (keep the root dir itself). Only .md files +
  //    sub-dirs that don't start with '.'.
  async function wipe(dir: string) {
    let entries: any[] = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) await fs.rm(p, { recursive: true, force: true });
        else if (e.isFile()) await fs.unlink(p);
      } catch {}
    }
  }
  await wipe(vault_path);

  // 3. Copy snapshot tree back into vault root.
  const restored = await copyTree(snapshot_dir, vault_path);
  return { ok: true, restored: restored.files, safety_snapshot_id: safetyId };
}

export async function deleteSnapshot(userId: number, id: number): Promise<{ ok: boolean }> {
  const rows = await query<{ snapshot_dir: string }>(`SELECT snapshot_dir FROM brain_snapshots WHERE user_id=$1 AND id=$2`, [userId, id]);
  if (!rows[0]) return { ok: false };
  try { await fs.rm(rows[0].snapshot_dir, { recursive: true, force: true }); } catch {}
  await query(`DELETE FROM brain_snapshots WHERE user_id=$1 AND id=$2`, [userId, id]);
  return { ok: true };
}
