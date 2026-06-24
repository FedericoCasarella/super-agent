// Brain Sync — Step 1: estrazione fatti dai 3 cervelli.
//
// Fondamenta per la detection (step 2). Questo modulo NON scrive nulla e NON
// propone: legge i tre store e restituisce una lista normalizzata di "fatti"
// confrontabili. Lo step 2 raggrupperà i fatti per `key` e segnalerà le
// divergenze come proposte in brain_proposals.
//
// Vincoli reali del codebase (scoperti 2026-06-24, vedi
// vault operativo/brain-sync-architecture.md):
//  - NON esiste una tabella `clients`: i clienti vivono in ClickUp e nei file
//    (vault `shopify/setup-tema.md`, memory `clients_quick_ref.md`). L'estrazione
//    dei fatti-cliente è demandata allo step 2 (parsing mirato + pass LLM).
//  - `task_status_seen` è globale (non per-utente): dà task_id + status correnti.
//  - `brain_index` non è vault-scoped (unique su user_id+path), quindi qui si
//    legge la memory .claude per path assoluto, senza dipendere dall'indice.
//  - `brain_proposals.kind` ha un CHECK (merge/distill/prune/link): le proposte
//    sync richiederanno una migration allo step 2.

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/index.js';
import { listVaults, createVault, getPrimaryVault } from '../brain/vaults.js';

export type SyncStore = 'db' | 'vault' | 'claude';
export type FactKind = 'task_state' | 'agent' | 'pointer' | 'date';

export type Fact = {
  kind: FactKind;
  key: string;        // chiave normalizzata dell'entità, per il match cross-store
  value: string;      // valore confrontabile
  store: SyncStore;
  path?: string;      // file relativo, se il fatto viene da un vault/memory
  updatedAt: string;  // ISO
  raw?: any;
};

// Posizione nota della memory .claude (2° cervello). Override via env per altre
// macchine / utenti.
export const CLAUDE_MEMORY_ROOT =
  process.env.CLAUDE_MEMORY_ROOT ??
  '/Users/marcoorsi/.claude/projects/-Users-marcoorsi/memory';

// ── Onboarding 2° vault (idempotente) ───────────────────────────────────────
// Registra la memory .claude come vault NON primario, così è visibile al resto
// del sistema (UI, future indicizzazioni). Il fact-extractor NON dipende da
// questa riga (legge per path assoluto): è un censimento, non un requisito.
// Idempotente: salta se la riga esiste già o se la cartella non c'è.
export async function ensureClaudeMemoryVault(userId: number): Promise<'created' | 'exists' | 'absent'> {
  const root = CLAUDE_MEMORY_ROOT;
  try {
    await fs.access(root);
  } catch {
    return 'absent';
  }
  const existing = await listVaults(userId);
  if (existing.some((v) => v.path === root || v.name === 'claude-memory')) return 'exists';
  await createVault(userId, 'claude-memory', root, { seed: false, makePrimary: false });
  return 'created';
}

// ── Fatti dal DB (memoria di lavoro) ────────────────────────────────────────
async function extractDbFacts(userId: number): Promise<Fact[]> {
  const facts: Fact[] = [];

  // Stati task dal supervisore. task_status_seen è globale (PK = task_id).
  const tasks = await query<{ task_id: string; status: string; since: string; last_seen: string }>(
    `SELECT task_id, status, since, last_seen FROM task_status_seen`,
  );
  for (const t of tasks) {
    facts.push({
      kind: 'task_state',
      key: `task:${t.task_id}`,
      value: t.status,
      store: 'db',
      updatedAt: t.last_seen ?? t.since,
      raw: { since: t.since },
    });
  }

  // Inventario agenti interni (per-utente).
  const agents = await query<{ name: string; enabled: boolean; updated_at: string }>(
    `SELECT name, enabled, updated_at FROM internal_agents WHERE user_id=$1`,
    [userId],
  );
  for (const a of agents) {
    facts.push({
      kind: 'agent',
      key: `agent:${a.name}`,
      value: a.enabled ? 'enabled' : 'disabled',
      store: 'db',
      updatedAt: a.updated_at,
      raw: {},
    });
  }

  return facts;
}

// ── Fatti dai file markdown (vault + memory .claude) ────────────────────────

type MdFile = { rel: string; raw: string; updatedAt: string };

async function walkMarkdown(root: string): Promise<MdFile[]> {
  const out: MdFile[] = [];
  async function walk(dir: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // salta .obsidian, .git, ecc.
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!e.name.endsWith('.md')) continue;
      try {
        const raw = await fs.readFile(full, 'utf8');
        const stat = await fs.stat(full);
        out.push({ rel: path.relative(root, full), raw, updatedAt: stat.mtime.toISOString() });
      } catch {
        // file sparito tra readdir e read: ignora
      }
    }
  }
  await walk(root);
  return out;
}

// Puntatore a una "fonte di verità" canonica altrove. I file usano frasi
// diverse per lo stesso concetto ("fonte di verità", "fonte autoritativa",
// "SOP completa", "non duplicare ... vedi"), quindi il trigger è largo ma il
// target deve comunque essere un path .md esplicito. Il fatto è (file → target).
const POINTER_TRIGGER = /(fonte (?:di verit[àa]|autoritativa|completa|unica)|sop completa|non duplicare|dettaglio completo|blueprint nel vault)/i;
const MD_PATH_RE = /([A-Za-z0-9_][A-Za-z0-9_./\- ]*\.md)/g;

function extractPointers(file: MdFile, store: SyncStore): Fact[] {
  const facts: Fact[] = [];
  for (const line of file.raw.split('\n')) {
    if (!POINTER_TRIGGER.test(line)) continue;
    for (const m of line.matchAll(MD_PATH_RE)) {
      const target = m[1].trim();
      // scarta auto-riferimenti (il file che punta a se stesso)
      if (target === file.rel || file.rel.endsWith(target)) continue;
      facts.push({
        kind: 'pointer',
        key: `pointer:${file.rel}->${target}`,
        value: target,
        store,
        path: file.rel,
        updatedAt: file.updatedAt,
        raw: { line: line.trim().slice(0, 200) },
      });
    }
  }
  return facts;
}

// Date target/deadline. Cattura "<mese> <anno>" italiano e ISO YYYY-MM-DD, ma
// SOLO su righe che parlano di scadenze: senza questo gate il regex pesca le
// date dentro i wikilink/filename (es. [[dreams/2026-06-19]]) generando
// centinaia di falsi positivi (verificato sul vault reale: 945 → ~decine).
// La chiave è coarse (per file): due date divergenti nello stesso file (es. il
// conflitto del target 70%) finiscono sotto la stessa key, pronte per lo step 2.
const MONTHS = 'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';
const DATE_RE = new RegExp(`\\b(?:(?:${MONTHS})\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})\\b`, 'gi');
const DEADLINE_KW = /(scadenz|deadline|target|entro|orizzonte|previst|go-?live|consegna|delivery|termine|obiettivo)/i;

function extractDates(file: MdFile, store: SyncStore): Fact[] {
  const facts: Fact[] = [];
  for (const line of file.raw.split('\n')) {
    if (!DEADLINE_KW.test(line)) continue;
    // ignora le date che sono solo dentro un wikilink o un path
    const cleaned = line.replace(/\[\[[^\]]*\]\]/g, '').replace(/`[^`]*`/g, '');
    for (const m of cleaned.matchAll(DATE_RE)) {
      facts.push({
        kind: 'date',
        key: `date:${file.rel}`,
        value: m[0].toLowerCase(),
        store,
        path: file.rel,
        updatedAt: file.updatedAt,
        raw: { context: line.trim().slice(0, 200) },
      });
    }
  }
  return facts;
}

async function extractMarkdownFacts(root: string, store: SyncStore): Promise<Fact[]> {
  const files = await walkMarkdown(root);
  const facts: Fact[] = [];
  for (const f of files) {
    facts.push(...extractPointers(f, store));
    facts.push(...extractDates(f, store));
  }
  return facts;
}

// ── Raccolta unificata ──────────────────────────────────────────────────────
export async function collectAllFacts(userId: number): Promise<Fact[]> {
  const facts: Fact[] = [];

  facts.push(...(await extractDbFacts(userId)));

  const primary = await getPrimaryVault(userId);
  if (primary?.path) {
    facts.push(...(await extractMarkdownFacts(primary.path, 'vault')));
  }

  try {
    await fs.access(CLAUDE_MEMORY_ROOT);
    facts.push(...(await extractMarkdownFacts(CLAUDE_MEMORY_ROOT, 'claude')));
  } catch {
    // memory .claude non presente su questa macchina
  }

  return facts;
}

// ── Smoke test ───────────────────────────────────────────────────────────────
// Esegui:           npx tsx backend/src/sync/facts.ts [userId]
// Con onboarding:   npx tsx backend/src/sync/facts.ts [userId] onboard
const invokedDirectly = process.argv[1]?.endsWith('facts.ts');
if (invokedDirectly) {
  const userId = Number(process.argv[2] ?? 1);
  const doOnboard = process.argv[3] === 'onboard';
  (doOnboard ? ensureClaudeMemoryVault(userId) : Promise.resolve('skip' as const))
    .then((r) => doOnboard && console.log(`Onboarding 2° vault (claude-memory): ${r}\n`))
    .then(() => collectAllFacts(userId))
    .then((facts) => {
      const byKind = facts.reduce<Record<string, number>>((a, f) => {
        a[`${f.store}/${f.kind}`] = (a[`${f.store}/${f.kind}`] ?? 0) + 1;
        return a;
      }, {});
      console.log(`Fatti estratti per user ${userId}: ${facts.length}`);
      console.log('Per store/tipo:', byKind);
      const dates = facts.filter((f) => f.kind === 'date');
      console.log(`\nEsempi date (${dates.length}):`);
      for (const d of dates.slice(0, 8)) console.log(`  [${d.path}] ${d.value} — "${d.raw?.context}"`);
      process.exit(0);
    })
    .catch((e) => {
      console.error('smoke test fallito:', e);
      process.exit(1);
    });
}
