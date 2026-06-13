// WA People Sync — ogni 6 ore collega le chat WhatsApp al CRM e al brain.
//   🔗 Auto-link: wa_messages senza person_slug → match sender_phone contro
//      people.phones (+ propagazione da wa_contacts.linked_person_slug).
//      Zero LLM, solo SQL.
//   🧠 Distillazione: per ogni persona con messaggi nuovi dal giro precedente,
//      riassume la conversazione e la appende alla nota persona nel vault
//      (sezione "Interazioni WhatsApp" — roll-up, non log integrale).
//   🧬 Psy refresh: le persone toccate ottengono il refresh del profilo
//      psicologico (riusa analyzePersonPsy di people_analyzer — ora il grafo
//      include i distillati WA, quindi il profilo li vede).
//   ⚠️ Contatti ricorrenti NON in CRM (≥5 msg nel periodo) → solo segnalati
//      nel report Telegram. MAI creati in automatico: decide l'utente.
// Watermark in settings (wa_people_sync_watermark) → mai rianalizza lo stesso
// messaggio. Cap 10 persone distillate per giro per tenere il costo fisso.

import { query, getSetting, setSetting } from '../../db/index.js';
import { getVaultRoot, readNote, writeNote } from '../../brain/vault.js';
import { runClaude } from '../../claude/runner.js';
import { analyzePersonPsy } from './people_analyzer.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

const WATERMARK_KEY = 'wa_people_sync_watermark';
const MAX_DISTILL_PER_RUN = 10;

// Normalize a phone for matching: digits only, no leading zeros/plus.
function normPhone(p: string): string {
  return String(p).replace(/[^0-9]/g, '').replace(/^0+/, '');
}

// ── Step 1: auto-link unlinked messages ────────────────────────────────────
async function autoLink(userId: number): Promise<{ linked: number; viaContacts: number }> {
  // 1a. Propagate explicit UI links (wa_contacts.linked_person_slug).
  const viaContactsRes = await query<{ c: number }>(
    `WITH upd AS (
       UPDATE wa_messages m SET person_slug = c.linked_person_slug
       FROM wa_contacts c
       WHERE m.user_id=$1 AND m.person_slug IS NULL
         AND c.user_id=m.user_id AND c.jid=m.chat_jid AND c.linked_person_slug IS NOT NULL
       RETURNING m.id
     ) SELECT count(*)::int AS c FROM upd`,
    [userId],
  );
  // 1b. Phone match against people.phones. Compare digits-only suffixes so
  // "+39 346 9934915", "393469934915" and "3469934915" all match.
  const phoneRes = await query<{ c: number }>(
    `WITH ppl AS (
       SELECT slug, regexp_replace(unnest(phones), '[^0-9]', '', 'g') AS ph
       FROM people WHERE user_id=$1
     ), upd AS (
       UPDATE wa_messages m SET person_slug = p.slug
       FROM ppl p
       WHERE m.user_id=$1 AND m.person_slug IS NULL AND m.is_group=false
         AND m.sender_phone IS NOT NULL AND length(p.ph) >= 9
         AND regexp_replace(m.sender_phone, '[^0-9]', '', 'g') LIKE '%' || right(p.ph, 10)
       RETURNING m.id
     ) SELECT count(*)::int AS c FROM upd`,
    [userId],
  );
  return { linked: phoneRes[0]?.c ?? 0, viaContacts: viaContactsRes[0]?.c ?? 0 };
}

// ── Step 2: find people with fresh messages since watermark ────────────────
type ActivePerson = { slug: string; name: string; msgs: { ts: string; from_me: boolean; text: string }[] };

async function findActivePeople(userId: number, sinceId: number): Promise<{ people: ActivePerson[]; maxId: number }> {
  const rows = await query<any>(
    `SELECT m.id, m.person_slug, p.name, m.from_me, m.text, m.ts
     FROM wa_messages m JOIN people p ON p.user_id=m.user_id AND p.slug=m.person_slug
     WHERE m.user_id=$1 AND m.id > $2 AND m.person_slug IS NOT NULL
       AND m.is_group=false AND length(m.text) > 0
     ORDER BY m.person_slug, m.ts ASC`,
    [userId, sinceId],
  );
  let maxId = sinceId;
  const bySlug = new Map<string, ActivePerson>();
  for (const r of rows) {
    maxId = Math.max(maxId, Number(r.id));
    const cur: ActivePerson = bySlug.get(r.person_slug) ?? { slug: r.person_slug, name: r.name, msgs: [] };
    cur.msgs.push({ ts: r.ts, from_me: r.from_me, text: String(r.text).slice(0, 500) });
    bySlug.set(r.person_slug, cur);
  }
  // Most active first; cap per-person transcript to last 60 messages.
  const people = [...bySlug.values()]
    .map((p) => ({ ...p, msgs: p.msgs.slice(-60) }))
    .sort((a, b) => b.msgs.length - a.msgs.length);
  return { people, maxId };
}

// ── Step 3: distill a conversation into the person's vault note ───────────
async function distillIntoNote(userId: number, p: ActivePerson): Promise<{ ok: boolean; error?: string }> {
  const transcript = p.msgs
    .map((m) => `[${new Date(m.ts).toLocaleString('it-IT')}] ${m.from_me ? 'IO' : p.name}: ${m.text}`)
    .join('\n');
  const prompt = [
    `Distilla questa conversazione WhatsApp con ${p.name} in un aggiornamento per il suo dossier.`,
    `Rispondi SOLO con JSON valido:`,
    `{"summary":"<2-4 frasi: di cosa avete parlato, decisioni, impegni presi, stato d'animo>","mood":"<1-3 parole sullo stato della relazione>","next_action":"<opzionale: prossima azione concreta, ometti se nessuna>"}`,
    ``,
    `CONVERSAZIONE (${p.msgs.length} messaggi):`,
    transcript,
  ].join('\n');
  try {
    const res = await runClaude(userId, prompt, { useMcp: false, timeoutMs: 90_000, kind: 'wa-people-sync', meta: { slug: p.slug } });
    if (!res.ok) return { ok: false, error: res.stderr?.slice(0, 150) ?? 'llm failed' };
    let s = (res.text ?? '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a === -1 || b <= a) return { ok: false, error: 'no JSON' };
    const d = JSON.parse(s.slice(a, b + 1));
    if (!d?.summary) return { ok: false, error: 'empty summary' };

    const rel = `people/${p.slug}.md`;
    const note = await readNote(userId, rel);
    const day = new Date().toISOString().slice(0, 10);
    const entry = [
      `- **${day}** (${p.msgs.length} msg): ${d.summary}${d.mood ? ` _[${d.mood}]_` : ''}${d.next_action ? `\n  - ➡️ ${d.next_action}` : ''}`,
    ].join('\n');
    const HEADER = '## Interazioni WhatsApp';
    let content = note?.content ?? `# ${p.name}\n`;
    if (content.includes(HEADER)) {
      // Prepend new entry right under the header (newest first).
      content = content.replace(HEADER, `${HEADER}\n${entry}`);
    } else {
      content = `${content.trimEnd()}\n\n${HEADER}\n${entry}\n`;
    }
    await writeNote(userId, rel, { ...(note?.data ?? { title: p.name, kind: 'person' }) }, content);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 150) };
  }
}

// ── Step 4: recurring contacts NOT in CRM (report-only) ───────────────────
async function findUnknownRecurring(userId: number, sinceId: number): Promise<{ phone: string; name: string | null; count: number }[]> {
  return await query<any>(
    `SELECT m.sender_phone AS phone, max(m.sender_name) AS name, count(*)::int AS count
     FROM wa_messages m
     WHERE m.user_id=$1 AND m.id > $2 AND m.person_slug IS NULL AND m.is_group=false
       AND m.from_me=false AND length(coalesce(m.sender_phone, '')) >= 6
     GROUP BY m.sender_phone HAVING count(*) >= 5
     ORDER BY count DESC LIMIT 5`,
    [userId, sinceId],
  );
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const root = await getVaultRoot(userId);
  if (!root) return { skipped: 1, error: 'vault non configurato', durationMs: Date.now() - started };

  // Watermark — first run starts from "now minus 48h" worth of messages, not
  // the whole history (bounded first-run cost).
  let sinceId = Number(await getSetting<number>(userId, WATERMARK_KEY) ?? 0) || 0;
  if (sinceId === 0) {
    const r = await query<{ id: number | null }>(
      `SELECT min(id)::bigint AS id FROM wa_messages WHERE user_id=$1 AND ts > now() - interval '48 hours'`,
      [userId],
    );
    sinceId = Number(r[0]?.id ?? 0) > 0 ? Number(r[0]!.id) - 1 : Number.MAX_SAFE_INTEGER;
    if (sinceId === Number.MAX_SAFE_INTEGER) {
      // No recent messages at all: set watermark to current max and exit clean.
      const mx = await query<{ id: number | null }>(`SELECT max(id)::bigint AS id FROM wa_messages WHERE user_id=$1`, [userId]);
      await setSetting(userId, WATERMARK_KEY, Number(mx[0]?.id ?? 0));
      return { linked: 0, distilled: 0, psy_refreshed: 0, durationMs: Date.now() - started };
    }
  }

  const { linked, viaContacts } = await autoLink(userId);
  const { people, maxId } = await findActivePeople(userId, sinceId);
  const unknown = await findUnknownRecurring(userId, sinceId);

  let distilled = 0, psyRefreshed = 0, errors = 0;
  const details: any[] = [];
  for (const p of people.slice(0, MAX_DISTILL_PER_RUN)) {
    const d = await distillIntoNote(userId, p);
    if (!d.ok) { errors++; details.push({ slug: p.slug, error: d.error }); continue; }
    distilled++;
    const psy = await analyzePersonPsy(userId, root, p.slug, p.name);
    if (psy.ok) psyRefreshed++;
    details.push({ slug: p.slug, msgs: p.msgs.length, psy: psy.ok });
  }

  // Advance watermark ONLY past what we actually processed.
  if (maxId > sinceId) await setSetting(userId, WATERMARK_KEY, maxId);

  return {
    linked: linked + viaContacts,
    active_people: people.length,
    distilled,
    psy_refreshed: psyRefreshed,
    unknown_recurring: unknown,
    skipped_over_cap: Math.max(0, people.length - MAX_DISTILL_PER_RUN),
    errors,
    details: details.slice(0, 20),
    durationMs: Date.now() - started,
  };
}

const agent: InternalAgent = {
  name: 'wa_people_sync',
  title: 'WA People Sync',
  description: 'Ogni 6 ore collega i messaggi WhatsApp alle persone del CRM (match per telefono, zero LLM), distilla le conversazioni nuove nella nota persona del brain e rinfresca il profilo psicologico di chi ha scritto. Segnala contatti ricorrenti non ancora in CRM — senza mai crearli da solo.',
  defaultHour: 6,
  defaultMinute: 0,
  defaultIntervalHours: 6,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `📱 *WA People Sync* — giro fallito: ${r?.error ?? 'errore'}.`
        : `📱 *WA People Sync* — run failed: ${r?.error ?? 'error'}.`;
    }
    const parts: string[] = [];
    if (r.linked) parts.push(`🔗 ${r.linked} messaggi collegati`);
    if (r.distilled) parts.push(`🧠 ${r.distilled} dossier aggiornati`);
    if (r.psy_refreshed) parts.push(`🧬 ${r.psy_refreshed} profili psy rinfrescati`);
    if (r.skipped_over_cap) parts.push(`⏭ ${r.skipped_over_cap} rimandate al prossimo giro`);
    const unknown = Array.isArray(r.unknown_recurring) ? r.unknown_recurring : [];
    if (!parts.length && !unknown.length) {
      return lang === 'it'
        ? `📱 *WA People Sync* — nessuna novità WhatsApp da collegare.`
        : `📱 *WA People Sync* — no new WhatsApp activity.`;
    }
    const lines = [`📱 *WA People Sync* — ${parts.join(' · ')}`];
    if (unknown.length) {
      lines.push('', '⚠️ *Contatti frequenti non in CRM:*');
      for (const u of unknown) lines.push(`• ${u.name ?? 'sconosciuto'} (${u.phone}) — ${u.count} msg`);
      lines.push('_Collegali da People o WhatsApp → link persona._');
    }
    return lines.join('\n');
  },
};

export default agent;
