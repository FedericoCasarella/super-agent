// Brain Proposals — apply/reject engine per le proposte del Brain Consolidator.
// Le proposte sono generate dal perk notturno (agents/internal/brain_consolidator.ts)
// e restano `pending` finché l'utente non le approva/scarta dal pannello /brain.
// Ogni sessione di apply crea PRIMA uno snapshot di sicurezza (riusa il sistema
// brain_snapshots) → rollback sempre possibile.

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { getVaultRoot, readNote, writeNote } from './vault.js';

export type Proposal = {
  id: number;
  kind: 'merge' | 'distill' | 'prune' | 'link';
  title: string;
  description: string | null;
  payload: any;
  status: 'pending' | 'applied' | 'rejected';
  created_at: string;
  resolved_at: string | null;
};

function ymd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function listProposals(userId: number, status: string = 'pending'): Promise<Proposal[]> {
  return await query<Proposal>(
    `SELECT id::int, kind, title, description, payload, status, created_at, resolved_at
     FROM brain_proposals WHERE user_id=$1 AND ($2='all' OR status=$2)
     ORDER BY created_at DESC LIMIT 200`,
    [userId, status],
  );
}

export async function rejectProposal(userId: number, id: number): Promise<{ ok: boolean }> {
  await query(
    `UPDATE brain_proposals SET status='rejected', resolved_at=now() WHERE user_id=$1 AND id=$2 AND status='pending'`,
    [userId, id],
  );
  return { ok: true };
}

// Move a note to archive/<date>/<rel> (copy + delete original + drop index row).
async function archiveNote(userId: number, root: string, rel: string): Promise<string | null> {
  try {
    const orig = await readNote(userId, rel);
    if (!orig) return null;
    const dest = `archive/${ymd()}/${rel}`;
    await writeNote(userId, dest, {
      ...(orig.data ?? {}),
      archived_from: rel,
      archived_at: new Date().toISOString(),
      kind: 'archived',
    }, orig.content);
    try { await fs.unlink(path.join(root, rel)); } catch {}
    await query(`DELETE FROM brain_index WHERE user_id=$1 AND path=$2`, [userId, rel]);
    return dest;
  } catch { return null; }
}

// Per-user snapshot throttle: one safety snapshot per 10-minute apply session,
// not one per proposal (bulk-apply of 20 proposals = 1 snapshot). DB-based so
// it survives backend restarts (in-memory would reset on every dev reload).
async function ensureSafetySnapshot(userId: number): Promise<void> {
  try {
    const recent = await query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain_snapshots
       WHERE user_id=$1 AND created_at > now() - interval '10 minutes'`,
      [userId],
    );
    if ((recent[0]?.c ?? 0) > 0) return;
    const { createSnapshots } = await import('./snapshots.js');
    await createSnapshots(userId, 'manual');
  } catch (e) { console.error('[proposals] safety snapshot failed', e); }
}

export async function applyProposal(userId: number, id: number): Promise<{ ok: boolean; error?: string; result?: any }> {
  const rows = await query<Proposal>(
    `SELECT id::int, kind, title, description, payload, status FROM brain_proposals WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  const p = rows[0];
  if (!p) return { ok: false, error: 'proposta non trovata' };
  if (p.status !== 'pending') return { ok: false, error: `proposta già ${p.status}` };
  const root = await getVaultRoot(userId);
  if (!root) return { ok: false, error: 'vault non configurato' };

  await ensureSafetySnapshot(userId);

  const pl = p.payload ?? {};
  let result: any = {};
  try {
    if (p.kind === 'merge' || p.kind === 'distill') {
      const target = String(pl.target_path ?? '');
      const content = String(pl.content ?? '');
      if (!target || !content) return { ok: false, error: 'payload incompleto (target_path/content)' };
      const fm = {
        kind: p.kind === 'merge' ? 'note' : 'profile',
        title: pl.title ?? p.title,
        consolidated_from: pl.sources ?? [],
        consolidated_at: new Date().toISOString(),
        ...(pl.frontmatter ?? {}),
      };
      await writeNote(userId, target, fm, content);
      result.written = target;
      // merge = sources replaced → archive them. distill = sources kept (the
      // distilled profile links them), nothing else to do.
      if (p.kind === 'merge') {
        const archived: string[] = [];
        for (const s of (pl.sources ?? []) as string[]) {
          if (s === target) continue;
          const dest = await archiveNote(userId, root, s);
          if (dest) archived.push(dest);
        }
        result.archived = archived;
      }
    } else if (p.kind === 'prune') {
      const archived: string[] = [];
      for (const s of (pl.sources ?? []) as string[]) {
        const dest = await archiveNote(userId, root, s);
        if (dest) archived.push(dest);
      }
      result.archived = archived;
    } else if (p.kind === 'link') {
      const rel = String(pl.path ?? '');
      const note = await readNote(userId, rel);
      if (!note) return { ok: false, error: `nota non trovata: ${rel}` };
      const existing: string[] = Array.isArray(note.data?.related) ? note.data.related : [];
      const merged = [...new Set([...existing, ...((pl.related ?? []) as string[])])];
      await writeNote(userId, rel, { ...(note.data ?? {}), related: merged }, note.content);
      result.linked = { path: rel, related: merged };
    } else {
      return { ok: false, error: `kind sconosciuto: ${p.kind}` };
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  await query(
    `UPDATE brain_proposals SET status='applied', resolved_at=now() WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return { ok: true, result };
}
