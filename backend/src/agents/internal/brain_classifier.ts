import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import { getVaultRoot } from '../../brain/vault.js';
import { query } from '../../db/index.js';
import type { InternalAgent, AgentReport } from './types.js';

// Heuristic classifier — deterministic, zero LLM cost.
// Marks `visibility: protected | public` in note frontmatter and brain_index.

const PROTECTED_KEYWORDS = [
  'password', 'iban', 'codice fiscale', 'partita iva', 'p.iva', 'tax id', 'ssn',
  'carta di credito', 'credit card', 'cvv', 'pin', 'api key', 'apikey', 'secret',
  'token', 'bearer', 'private', 'riservato', 'confidential', 'salary', 'stipendio',
  'compenso', 'pagamento ricevuto', 'contratto firmato', 'nda', 'medical', 'medico',
  'cartella clinica', 'diagnosis', 'therapist', 'psicologo',
];

const PROTECTED_PATH_PREFIXES = ['inbox/email/', 'meta/'];
const PROTECTED_KINDS = new Set(['email', 'roadmap']);

function classify(relPath: string, fm: any, content: string): 'protected' | 'public' {
  // Explicit user override always wins
  if (fm?.visibility === 'protected' || fm?.visibility === 'public') return fm.visibility;
  // Path-based defaults
  if (PROTECTED_PATH_PREFIXES.some((p) => relPath.startsWith(p))) return 'protected';
  if (PROTECTED_KINDS.has(fm?.kind)) return 'protected';
  // Keyword scan
  const hay = (content + ' ' + JSON.stringify(fm ?? {})).toLowerCase();
  for (const kw of PROTECTED_KEYWORDS) if (hay.includes(kw)) return 'protected';
  return 'public';
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await rec(full); continue; }
      if (e.name.endsWith('.md')) out.push(path.relative(root, full));
    }
  }
  await rec(root);
  return out;
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { scanned: 0, error: 'vault not configured' };

  const paths = await walk(root);
  let scanned = 0;
  let classified = 0;
  let protectedC = 0;
  let publicC = 0;
  let skipped = 0;
  let errors = 0;
  const sample: any[] = [];

  for (const rel of paths) {
    scanned++;
    try {
      const full = path.join(root, rel);
      const raw = await fs.readFile(full, 'utf8');
      const parsed = matter(raw);
      const verdict = classify(rel, parsed.data, parsed.content);
      const had = parsed.data.visibility;
      if (had !== verdict) {
        parsed.data.visibility = verdict;
        const newRaw = matter.stringify(parsed.content.trimEnd() + '\n', parsed.data);
        await fs.writeFile(full, newRaw, 'utf8');
        classified++;
        if (sample.length < 25) sample.push({ path: rel, from: had ?? null, to: verdict });
      } else {
        skipped++;
      }
      verdict === 'protected' ? protectedC++ : publicC++;
      await query(
        `UPDATE brain_index SET visibility=$1, updated_at=now() WHERE user_id=$2 AND path=$3`,
        [verdict, userId, rel]
      );
    } catch (e) {
      errors++;
      console.error('[brain_classifier]', rel, e);
    }
  }

  return {
    scanned, classified, skipped, errors,
    protected: protectedC, public: publicC,
    details: sample,
    durationMs: Date.now() - started,
  };
}

const agent: InternalAgent = {
  name: 'brain_classifier',
  title: 'Brain Classifier',
  description: 'Scans every note in the vault, classifies as protected or public (frontmatter + brain_index). Deterministic, no LLM cost. Heuristics: path prefix (inbox/email, meta) + kind (email, roadmap) + sensitive keywords (password, IBAN, contratto, ...).',
  defaultHour: 4,
  defaultMinute: 0,
  run,
  humanize(r, lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🛡 *Brain Classifier* — qualcosa è andato storto: ${r?.error ?? 'errore sconosciuto'}.`
        : `🛡 *Brain Classifier* — something went wrong: ${r?.error ?? 'unknown error'}.`;
    }
    const seconds = ((r.durationMs ?? 0) / 1000).toFixed(1);
    if (lang === 'it') {
      if (!r.classified) {
        return `🛡 *Brain Classifier* — controllate ${r.scanned} note del tuo brain, niente di nuovo da riclassificare (${r.protected ?? 0} protette · ${r.public ?? 0} pubbliche).`;
      }
      return `🛡 *Brain Classifier* — ho passato in rassegna ${r.scanned} note. Ne ho riclassificate ${r.classified}: ora ne hai ${r.protected ?? 0} private e ${r.public ?? 0} condivisibili. Tutto in ${seconds}s.`;
    }
    if (!r.classified) {
      return `🛡 *Brain Classifier* — checked ${r.scanned} notes, nothing new to reclassify (${r.protected ?? 0} private · ${r.public ?? 0} public).`;
    }
    return `🛡 *Brain Classifier* — went through ${r.scanned} notes. Reclassified ${r.classified}: now ${r.protected ?? 0} private and ${r.public ?? 0} shareable. Done in ${seconds}s.`;
  },
};

export default agent;
