// Chief of Staff — briefing mattutino proattivo.
// Ogni mattina (default 07:00) raccoglie il contesto operativo dell'utente
// (mail 24h, WhatsApp non risposti, CRM che si raffredda, task del giorno) dal
// DB, poi lascia che l'agente integri calendario e Flowspace via MCP e
// componga UN briefing decisionale: decisioni da prendere oggi, bozze pronte,
// relazioni che si raffreddano, scadenze. L'utente risponde dai bottoni/chat.
// Trigger manuale: comando Telegram /goal.

import { query } from '../../db/index.js';
import { runClaude } from '../../claude/runner.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

async function gatherContext(userId: number): Promise<string> {
  const blocks: string[] = [];

  // Mail inbound ultime 24h (non bonificate per prime, poi resto)
  try {
    const mails = await query<any>(
      `SELECT account_label, from_name, from_addr, subject, preview, seen, ts
       FROM mail_messages
       WHERE user_id=$1 AND direction='in' AND trashed_at IS NULL AND ts > now() - interval '24 hours'
       ORDER BY seen ASC, ts DESC LIMIT 25`,
      [userId],
    );
    if (mails.length) {
      blocks.push(`MAIL ULTIME 24H (${mails.length}, prima le non lette):\n` + mails.map((m: any) =>
        `- [${m.seen ? 'letta' : 'NON LETTA'}] ${m.from_name || m.from_addr} · "${m.subject ?? '(no subject)'}" · ${String(m.preview ?? '').slice(0, 120)}`
      ).join('\n'));
    }
  } catch {}

  // WhatsApp: ultimi messaggi in entrata senza risposta successiva (per chat)
  try {
    const wa = await query<any>(
      `WITH last_msg AS (
         SELECT DISTINCT ON (chat_jid) chat_jid, sender_name, person_slug, text, ts, from_me
         FROM wa_messages
         WHERE user_id=$1 AND is_group=false AND ts > now() - interval '48 hours'
         ORDER BY chat_jid, ts DESC
       )
       SELECT * FROM last_msg WHERE from_me=false ORDER BY ts DESC LIMIT 15`,
      [userId],
    );
    if (wa.length) {
      blocks.push(`WHATSAPP IN ATTESA DI RISPOSTA (ultimo messaggio della chat è loro, 48h):\n` + wa.map((m: any) =>
        `- ${m.sender_name || m.chat_jid}${m.person_slug ? ` (${m.person_slug})` : ''}: "${String(m.text).slice(0, 140)}" · ${new Date(m.ts).toLocaleString('it-IT')}`
      ).join('\n'));
    }
  } catch {}

  // CRM: persone "calde" che si stanno raffreddando (nessun touch da 14-60gg)
  try {
    const cooling = await query<any>(
      `SELECT slug, name, updated_at
       FROM people
       WHERE user_id=$1 AND updated_at BETWEEN now() - interval '60 days' AND now() - interval '14 days'
       ORDER BY updated_at DESC LIMIT 10`,
      [userId],
    );
    if (cooling.length) {
      blocks.push(`CRM — RELAZIONI CHE SI RAFFREDDANO (nessuna interazione da 14-60gg):\n` + cooling.map((p: any) =>
        `- ${p.name} (${p.slug}) · ultimo touch ${new Date(p.updated_at).toLocaleDateString('it-IT')}`
      ).join('\n'));
    }
  } catch {}

  // Task schedulati di oggi
  try {
    const tasks = await query<any>(
      `SELECT name, cron, action_type FROM scheduled_tasks
       WHERE user_id=$1 AND enabled=true ORDER BY name LIMIT 20`,
      [userId],
    );
    if (tasks.length) {
      blocks.push(`TASK SCHEDULATI ATTIVI:\n` + tasks.map((t: any) => `- ${t.name} (${t.cron})`).join('\n'));
    }
  } catch {}

  // Sub-agent ancora in esecuzione (lavoro in corso da ieri)
  try {
    const subs = await query<any>(
      `SELECT title, status, created_at FROM sub_agents
       WHERE user_id=$1 AND status IN ('running','pending') ORDER BY created_at DESC LIMIT 8`,
      [userId],
    );
    if (subs.length) {
      blocks.push(`SUB-AGENT IN CORSO:\n` + subs.map((s: any) => `- [${s.status}] ${s.title}`).join('\n'));
    }
  } catch {}

  return blocks.join('\n\n') || '(nessun dato locale nelle ultime 24h)';
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  const ctx = await gatherContext(userId);
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  const prompt = [
    `Sei il Chief of Staff dell'utente. È mattina (${today}). Prepara IL briefing operativo del giorno.`,
    ``,
    `CONTESTO LOCALE (già raccolto dal sistema):`,
    ctx,
    ``,
    `PASSI OBBLIGATORI (usa i tool MCP disponibili):`,
    `1. Calendario: se hai un tool Google Calendar, leggi gli eventi di OGGI e domani mattina.`,
    `2. Flowspace: se hai tool Flowspace, controlla task in scadenza oggi/scaduti e fatture in attesa.`,
    `3. Se un tool non è disponibile o fallisce, salta senza segnalare l'errore nel briefing.`,
    ``,
    `Poi componi il briefing in questo formato ESATTO (markdown Telegram, niente preamboli):`,
    ``,
    `🌅 **Briefing — ${today}**`,
    ``,
    `**⚡ Decisioni oggi** (max 3 — SOLO cose che richiedono una scelta dell'utente, con la tua raccomandazione secca)`,
    `**📅 Agenda** (eventi calendario di oggi, orario + titolo; ometti la sezione se vuota)`,
    `**✉️ Da rispondere** (max 4 tra mail/WA che meritano risposta OGGI, con suggerimento di 1 riga ciascuna)`,
    `**🧊 Si raffredda** (max 2 relazioni CRM da riscaldare, con micro-azione proposta)`,
    `**⏰ Scadenze** (task/fatture in scadenza; ometti se vuota)`,
    ``,
    `Regole: asciutto, zero filler, ogni riga azionabile. Se una sezione è vuota OMETTILA.`,
    `Se non c'è davvero niente di rilevante, scrivi solo: "🌅 Giornata pulita — nessuna decisione urgente."`,
    `Chiudi SEMPRE con: "Rispondi col numero della decisione per approvarla, o scrivimi cosa cambiare."`,
  ].join('\n');

  try {
    const res = await runClaude(userId, prompt, { timeoutMs: 240_000, kind: 'chief-of-staff' });
    if (!res.ok) return { error: res.stderr || 'agent error', durationMs: Date.now() - started };
    const briefing = (res.text ?? '').trim();
    if (!briefing) return { error: 'briefing vuoto', durationMs: Date.now() - started };
    return { briefing, durationMs: Date.now() - started };
  } catch (e: any) {
    return { error: String(e?.message ?? e), durationMs: Date.now() - started };
  }
}

const agent: InternalAgent = {
  name: 'chief_of_staff',
  title: 'Chief of Staff',
  description: 'Briefing mattutino proattivo: legge mail, WhatsApp, CRM, task, calendario e Flowspace e propone le decisioni del giorno via Telegram. Trigger manuale col comando /goal.',
  defaultHour: 7,
  defaultMinute: 0,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🌅 *Chief of Staff* — briefing fallito: ${r?.error ?? 'errore'}.`
        : `🌅 *Chief of Staff* — briefing failed: ${r?.error ?? 'error'}.`;
    }
    // Il report È il briefing — humanize lo consegna direttamente.
    return String(r?.briefing ?? '🌅 Giornata pulita — nessuna decisione urgente.');
  },
};

export default agent;
