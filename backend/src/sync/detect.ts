// Brain Sync — Step 2: detection deterministica + emissione proposte.
//
// Consuma i fatti dello step 1 (facts.ts), trova le incoerenze tra i 3 cervelli
// e le emette come proposte in brain_proposals (pattern brain_consolidator:
// l'utente approva/scarta da /brain, nessuna azione diretta). Nessuna pass LLM
// qui: tutto deterministico. La pass LLM e gli apply handler arrivano nello step 3.
//
// Tipi prodotti in questo step:
//  - sync-conflict : stessa entità con valori divergenti (pilota: date target 70%)
//  - sync-pointer  : puntatore "fonte di verità" il cui target non esiste in nessun brain
// (sync-missing è rimandato: richiede l'estrazione dei fatti-cliente, vedi facts.ts)

import { query } from '../db/index.js';
import { getPrimaryVault } from '../brain/vaults.js';
import { collectAllFacts, listMdPaths, CLAUDE_MEMORY_ROOT, type Fact } from './facts.js';
import fs from 'node:fs/promises';

export type SyncProposalKind = 'sync-pointer' | 'sync-conflict';

export type SyncCandidate = {
  kind: SyncProposalKind;
  groupKey: string;
  title: string;
  description: string;
  payload: any;
};

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

// Zone a segnale debole / auto-generate: non sono fonti autorevoli (vedi
// CLAUDE.md del vault). I loro contenuti non vanno trattati come conflitti.
const SKIP_ZONE = /^(dreams|garden|library|archive|_log|thoughts)\//;
function inSkipZone(p?: string): boolean {
  return !!p && (SKIP_ZONE.test(p) || p.includes('daily-logs/'));
}

// Una data ISO (YYYY-MM-DD) è quasi sempre un timestamp di log/changelog, non
// un target concorrente. I target reali sono espressi come "<mese> <anno>".
function isTargetDate(v: string): boolean {
  return !/^\d{4}-\d{2}-\d{2}$/.test(v);
}

// ── Conflitti: stessa key, ≥2 valori-target distinti su righe diverse ────────
// Step 2 limita i conflitti alle date (il caso pilota). Gli stati task e gli
// agenti vivono in un solo store, quindi non confliggono da soli: lo step 2b li
// confronterà con le citazioni nei file.
function detectConflicts(facts: Fact[]): SyncCandidate[] {
  const byKey = new Map<string, Fact[]>();
  for (const f of facts) {
    if (f.kind !== 'date') continue;
    if (inSkipZone(f.path)) continue;
    if (!isTargetDate(f.value)) continue; // scarta le date ISO (log)
    byKey.set(f.key, [...(byKey.get(f.key) ?? []), f]);
  }
  const out: SyncCandidate[] = [];
  for (const [key, group] of byKey) {
    const values = uniq(group.map((f) => f.value));
    if (values.length < 2) continue;
    // I valori devono divergere su RIGHE diverse: se le due date compaiono nella
    // stessa riga, quella riga sta descrivendo il conflitto, non incarnandolo.
    const contexts = uniq(group.map((f) => f.raw?.context ?? ''));
    if (contexts.length < 2) continue;
    const stores = group.map((f) => ({
      store: f.store,
      path: f.path,
      value: f.value,
      context: f.raw?.context ?? null,
      updated_at: f.updatedAt,
    }));
    const where = group[0].path ?? key;
    out.push({
      kind: 'sync-conflict',
      groupKey: `conflict:${key}`,
      title: `Date target divergenti in ${where}: ${values.join(' vs ')}`,
      description:
        `${where} contiene ${values.length} date target diverse. Owner = vault. ` +
        `Scegli quella corretta; lo step 3 propagherà la decisione agli altri brain.\n\n` +
        stores.map((s) => `• ${s.value} — "${s.context ?? ''}"`).join('\n'),
      payload: {
        group_key: `conflict:${key}`,
        entity: key,
        owner: 'vault',
        values,
        stores,
        recommended_value: null,
        direction: 'review',
      },
    });
  }
  return out;
}

// ── Puntatori rotti: target inesistente in QUALSIASI brain noto ──────────────
// Un puntatore in .claude che cita un file del vault è legittimo (cross-store),
// quindi è "rotto" solo se il target non si trova né nel vault né nella memory.
function normTarget(t: string): string {
  return t
    .replace(/[`"']/g, '')
    .replace(/.*llm-wiki\//, '') // path assoluti tipo ~/Documents/llm-wiki/...
    .replace(/^\.\//, '')
    .trim();
}

function targetResolves(target: string, files: string[]): boolean {
  const t = normTarget(target);
  if (!t) return true; // niente da risolvere
  const base = t.split('/').pop()!;
  return files.some((f) => f === t || f.endsWith('/' + t) || f === base || f.endsWith('/' + base));
}

function detectBrokenPointers(facts: Fact[], allFiles: string[]): SyncCandidate[] {
  const out: SyncCandidate[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    if (f.kind !== 'pointer') continue;
    if (inSkipZone(f.path)) continue;
    if (targetResolves(f.value, allFiles)) continue;
    const groupKey = `pointer:${f.path}->${f.value}`;
    if (seen.has(groupKey)) continue;
    seen.add(groupKey);
    out.push({
      kind: 'sync-pointer',
      groupKey,
      title: `Puntatore rotto in ${f.path} → ${f.value}`,
      description:
        `${f.path} dichiara come fonte di verità "${f.value}", ma quel file non esiste ` +
        `in nessuno dei brain. Correggi il path o rimuovi il puntatore.\n\nRiga: ${f.raw?.line ?? ''}`,
      payload: { group_key: groupKey, source_path: f.path, target: f.value, store: f.store },
    });
  }
  return out;
}

// ── Dedup + insert (come brain_consolidator) ────────────────────────────────
async function alreadyProposed(userId: number, kind: string, groupKey: string): Promise<boolean> {
  const rows = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM brain_proposals
     WHERE user_id=$1 AND kind=$2 AND payload->>'group_key'=$3 AND status IN ('pending','rejected')`,
    [userId, kind, groupKey],
  );
  return (rows[0]?.c ?? 0) > 0;
}

async function insertCandidate(userId: number, c: SyncCandidate): Promise<void> {
  await query(
    `INSERT INTO brain_proposals(user_id, kind, title, description, payload)
     VALUES($1,$2,$3,$4,$5::jsonb)`,
    [userId, c.kind, c.title, c.description, JSON.stringify(c.payload)],
  );
}

export type SyncDetectionResult = {
  conflicts: SyncCandidate[];
  brokenPointers: SyncCandidate[];
  inserted: number;
  skipped: number;
};

export async function runSyncDetection(
  userId: number,
  opts: { dryRun?: boolean } = {},
): Promise<SyncDetectionResult> {
  const dryRun = opts.dryRun !== false; // default: dry-run, non scrive
  const facts = await collectAllFacts(userId);

  // Set di file noti (vault + memory) per risolvere i target dei puntatori.
  const allFiles: string[] = [];
  const primary = await getPrimaryVault(userId);
  if (primary?.path) allFiles.push(...(await listMdPaths(primary.path)));
  try {
    await fs.access(CLAUDE_MEMORY_ROOT);
    allFiles.push(...(await listMdPaths(CLAUDE_MEMORY_ROOT)));
  } catch {}

  const conflicts = detectConflicts(facts);
  const brokenPointers = detectBrokenPointers(facts, allFiles);
  const candidates = [...conflicts, ...brokenPointers];

  let inserted = 0;
  let skipped = 0;
  if (!dryRun) {
    for (const c of candidates) {
      if (await alreadyProposed(userId, c.kind, c.groupKey)) {
        skipped++;
        continue;
      }
      await insertCandidate(userId, c);
      inserted++;
    }
  }

  return { conflicts, brokenPointers, inserted, skipped };
}

// ── Smoke test ───────────────────────────────────────────────────────────────
// Dry-run:  npx tsx backend/src/sync/detect.ts [userId]
// Inserisci: npx tsx backend/src/sync/detect.ts [userId] --apply
const invokedDirectly = process.argv[1]?.endsWith('detect.ts');
if (invokedDirectly) {
  const userId = Number(process.argv[2] ?? 1);
  const apply = process.argv.includes('--apply');
  runSyncDetection(userId, { dryRun: !apply })
    .then((r) => {
      console.log(`Brain Sync detection (user ${userId}, ${apply ? 'APPLY' : 'dry-run'})`);
      console.log(`Conflitti: ${r.conflicts.length} | Puntatori rotti: ${r.brokenPointers.length}`);
      if (apply) console.log(`Inserite: ${r.inserted} | già presenti (skip): ${r.skipped}`);
      for (const c of [...r.conflicts, ...r.brokenPointers]) {
        console.log(`\n[${c.kind}] ${c.title}`);
        console.log(c.description.split('\n').map((l) => '   ' + l).join('\n'));
      }
      process.exit(0);
    })
    .catch((e) => {
      console.error('detection fallita:', e);
      process.exit(1);
    });
}
