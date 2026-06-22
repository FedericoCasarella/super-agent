// Goal Pursuit — il motore AUTONOMO PERPETUO degli obiettivi. Ogni mattina, per
// ogni goal attivo con piano approvato:
//   1. misura il passo dei KPI (atteso vs reale, lineare sulla deadline)
//   2. trova la milestone aperta più vicina + raccoglie gli esiti recenti
//   3. RAGIONA: se i KPI non soddisfano le aspettative, capisce perché e
//      CORREGGE la strategia — scrivendo tutto il ragionamento nel brain
//      (goals/<slug>/pursuit-log.md, append giornaliero)
//   4. propone le azioni del giorno come UN digest batch (agent_proposal →
//      keyboard Telegram ✅/❌). All'approvazione gli agenti partono, linkati al
//      goal/milestone, e riportano a utente + brain.
//   5. LOOP ogni giorno fino al conseguimento (tutti i KPI a target), deadline,
//      o pausa. Se M giorni senza progresso → escalation (chiede il tuo input).
//
// Human-in-the-loop: digest batch ✅/❌ (scelta utente). Mai spawn cieco. Mai
// modifiche autonome al piano/KPI — solo proposte + ragionamento nel brain.

import { query, getSetting, setSetting } from '../../db/index.js';
import { runClaude } from '../../claude/runner.js';
import { listGoals, paceFor, updateGoal, type Goal, type Milestone } from '../../goals/index.js';
import { createProposal } from '../../sub_agents/index.js';
import { appendNote } from '../../brain/vault.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

const MAX_ACTIONS_PER_DAY = 3;     // anti-runaway: max azioni proposte/giorno per goal
const STAGNANT_ESCALATE_DAYS = 5;  // giorni senza progresso KPI → escalation

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'goal';
}
function paceBadge(ratio: number | null): string {
  if (ratio == null) return '—';
  if (ratio >= 0.95) return '🟢';
  if (ratio >= 0.7) return '🟡';
  return '🔴';
}
function nearestOpenMilestone(g: Goal): Milestone | null {
  const open = (g.plan?.milestones ?? []).filter((m) => m.status !== 'done');
  if (!open.length) return null;
  return open.sort((a, b) => (a.order ?? 999) - (b.order ?? 999))[0];
}
function kpiSnapshot(g: Goal): Record<string, number> {
  const s: Record<string, number> = {};
  for (const k of g.kpis ?? []) s[k.id] = k.current;
  return s;
}

type PursuitState = { lastKpi?: Record<string, number>; stagnantDays?: number; lastDeployAt?: string };

async function recentOutcomes(userId: number, goalId: number): Promise<string> {
  const rows = await query<any>(
    `SELECT title, status, left(coalesce(result,''), 250) AS result
     FROM sub_agents WHERE user_id=$1 AND goal_id=$2 AND created_at > now() - interval '4 days'
     ORDER BY created_at DESC LIMIT 8`,
    [userId, goalId],
  );
  if (!rows.length) return '(nessun agente recente su questo goal)';
  return rows.map((r: any) => `- [${r.status}] ${r.title}: ${r.result || '(senza risultato)'}`).join('\n');
}

type GoalRun = {
  goal: string;
  done?: boolean;
  behind?: boolean;
  stagnant?: boolean;
  proposed?: number;
  summary?: string;
  skipped?: string;
  error?: string;
};

async function pursueGoal(userId: number, g: Goal): Promise<GoalRun> {
  // THROTTLE: se c'è già un digest in attesa per questo goal, non accumulare —
  // aspetta la decisione dell'utente (modello digest-batch).
  const pend = await query<{ id: number }>(
    `SELECT id FROM agent_proposals WHERE user_id=$1 AND goal_id=$2 AND status='pending' LIMIT 1`,
    [userId, g.id],
  );
  if (pend.length) return { goal: g.title, skipped: 'digest precedente ancora in attesa' };

  // CONSEGUIMENTO: tutti i KPI a target → goal done.
  const kpis = g.kpis ?? [];
  if (kpis.length && kpis.every((k) => k.target > 0 && k.current >= k.target)) {
    await updateGoal(userId, g.id, { status: 'done' });
    await appendNote(userId, `goals/${slugify(g.title)}/pursuit-log.md`,
      `## ${new Date().toISOString().slice(0, 10)} — 🏆 CONSEGUITO\nTutti i KPI a target. Obiettivo "${g.title}" raggiunto.`,
      { title: `Pursuit log — ${g.title}`, kind: 'goal-log', goal: g.title }).catch(() => {});
    return { goal: g.title, done: true, summary: 'Tutti i KPI a target — obiettivo conseguito 🏆' };
  }

  // Stato pursuit (progresso KPI giorno-su-giorno).
  const stateKey = `goal_pursuit_state:${g.id}`;
  const state = (await getSetting<PursuitState>(userId, stateKey)) ?? {};
  const snap = kpiSnapshot(g);
  const prev = state.lastKpi ?? {};
  const moved = Object.keys(snap).some((id) => (snap[id] ?? 0) !== (prev[id] ?? 0));
  const stagnantDays = moved ? 0 : (state.stagnantDays ?? 0) + 1;

  // Pace + ritardo.
  const kpiLines = kpis.map((k) => {
    const { expected, ratio } = paceFor(g, k);
    return `- ${k.name}: ${k.current}/${k.target}${k.unit ? ` ${k.unit}` : ''} · atteso ${expected.toFixed(1)} ${paceBadge(ratio)}`;
  });
  const behind = kpis.some((k) => { const r = paceFor(g, k).ratio; return r != null && r < 0.7; });
  const milestone = nearestOpenMilestone(g);
  const outcomes = await recentOutcomes(userId, g.id);
  const escalate = behind && stagnantDays >= STAGNANT_ESCALATE_DAYS;

  const prompt = [
    `Sei il direttore operativo autonomo dell'obiettivo. Ogni giorno spingi verso il conseguimento.`,
    `GOAL: ${g.title} — ${g.objective}${g.deadline ? ` (deadline ${g.deadline})` : ''}`,
    kpiLines.length ? `KPI (passo atteso vs reale):\n${kpiLines.join('\n')}` : 'KPI: nessuno',
    milestone ? `MILESTONE APERTA PIÙ VICINA: ${milestone.title}${milestone.area ? ` [${milestone.area}]` : ''}${milestone.due ? ` (due ${milestone.due})` : ''}` : 'MILESTONE: nessuna aperta',
    `ESITI RECENTI (agenti, ultimi giorni):\n${outcomes}`,
    behind ? `⚠️ SEI IN RITARDO sui KPI. Devi RAGIONARE sul perché e CORREGGERE la strategia, non ripetere ciò che non ha funzionato.` : `Sei in linea: scegli le azioni che mantengono/accelerano il passo.`,
    stagnantDays > 0 ? `⏳ KPI fermi da ${stagnantDays} giorni.` : '',
    `Se hai tool MCP (Flowspace, brain) verifica lo stato REALE (pipeline, clienti, fatture, metriche) prima di decidere.`,
    `Proponi le azioni di OGGI per avanzare la milestone aperta (max ${MAX_ACTIONS_PER_DAY}). Concrete, self-contained, NON ripetere azioni recenti già fatte.`,
    `Rispondi SOLO con JSON valido:`,
    `{"status_summary":"<2-3 frasi: dove siamo, cosa ha funzionato/no>","reasoning":"<perché siamo a questo punto; se in ritardo, la causa>","correction":"<se in ritardo: come cambi strategia; altrimenti stringa vuota>","actions":[{"title":"...","brief":"azione concreta di oggi, self-contained"}]}`,
    `Regole: 1-${MAX_ACTIONS_PER_DAY} azioni. Se davvero non serve agire oggi, actions vuoto.`,
  ].filter(Boolean).join('\n');

  const res = await runClaude(userId, prompt, { timeoutMs: 240_000, kind: 'goal-pursuit', meta: { goalId: g.id } });
  if (!res.ok) {
    await setSetting(userId, stateKey, { lastKpi: snap, stagnantDays, lastDeployAt: state.lastDeployAt });
    return { goal: g.title, behind, stagnant: escalate, error: res.stderr || 'agent error' };
  }

  let s = (res.text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  let parsed: any = {};
  if (a !== -1 && b > a) { try { parsed = JSON.parse(s.slice(a, b + 1)); } catch {} }
  const actions = (parsed.actions ?? []).slice(0, MAX_ACTIONS_PER_DAY)
    .map((x: any) => ({ title: String(x.title ?? '').slice(0, 150), brief: String(x.brief ?? '').slice(0, 600) }))
    .filter((x: any) => x.title);

  // BRAIN: registra ragionamento + correzione (sempre, anche senza azioni).
  const date = new Date().toISOString().slice(0, 10);
  const logBody = [
    `## ${date} ${behind ? '🔴 in ritardo' : '🟢 in linea'}${escalate ? ' · ⛔ stagnante' : ''}`,
    parsed.status_summary ? `**Stato:** ${parsed.status_summary}` : '',
    parsed.reasoning ? `**Ragionamento:** ${parsed.reasoning}` : '',
    parsed.correction ? `**Correzione strategia:** ${parsed.correction}` : '',
    kpiLines.length ? `**KPI:**\n${kpiLines.join('\n')}` : '',
    actions.length ? `**Azioni proposte oggi:**\n${actions.map((x: any) => `- ${x.title}`).join('\n')}` : '_Nessuna azione oggi._',
  ].filter(Boolean).join('\n');
  await appendNote(userId, `goals/${slugify(g.title)}/pursuit-log.md`, logBody,
    { title: `Pursuit log — ${g.title}`, kind: 'goal-log', goal: g.title }).catch(() => {});

  let proposed = 0;
  if (actions.length) {
    const reason = [
      parsed.status_summary ?? g.objective,
      parsed.correction ? `↻ Correzione: ${parsed.correction}` : '',
      escalate ? `⛔ KPI fermi da ${stagnantDays} giorni — serve la tua spinta.` : '',
    ].filter(Boolean).join('\n').slice(0, 500);
    await createProposal(
      userId,
      `🎯 ${g.title} — azioni di oggi (${date})`,
      reason,
      actions.map((x: any) => ({
        title: x.title,
        brief: x.brief,
        prompt: [
          `Contesto: obiettivo "${g.title}" (${g.objective}).`,
          milestone ? `Milestone: ${milestone.title}.` : '',
          `Azione: ${x.title}`,
          `Dettagli: ${x.brief}`,
          `Esegui concretamente con i tool disponibili. Al termine scrivi nel brain l'esito (nota o append) e riporta risultato + eventuali blocchi.`,
        ].filter(Boolean).join('\n'),
      })),
      { goalId: g.id, milestoneId: milestone?.id },
    );
    proposed = actions.length;
    state.lastDeployAt = new Date().toISOString();
  }

  await setSetting(userId, stateKey, { lastKpi: snap, stagnantDays, lastDeployAt: state.lastDeployAt });
  return { goal: g.title, behind, stagnant: escalate, proposed, summary: parsed.status_summary };
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  // Solo goal attivi CON piano approvato (il pursuit guida l'esecuzione, non la
  // pianificazione: il piano lo approva l'utente dalla Roadmap).
  const goals = (await listGoals(userId)).filter((g) => g.status === 'active' && g.plan);
  if (!goals.length) return { skipped: 1, silent: true, durationMs: Date.now() - started };

  const runs: GoalRun[] = [];
  let proposed = 0, errors = 0, done = 0;
  for (const g of goals.slice(0, 6)) {
    try {
      const r = await pursueGoal(userId, g);
      runs.push(r);
      proposed += r.proposed ?? 0;
      if (r.done) done++;
      if (r.error) errors++;
    } catch (e: any) {
      errors++; runs.push({ goal: g.title, error: String(e?.message ?? e) });
    }
  }
  // Se tutto è stato skippato (digest in attesa) e niente di nuovo → silenzioso.
  const anySignal = runs.some((r) => r.proposed || r.done || r.error || r.stagnant);
  return { goals: goals.length, proposed, done, errors, runs, silent: !anySignal, durationMs: Date.now() - started };
}

const agent: InternalAgent = {
  name: 'goal_pursuit',
  title: 'Goal Pursuit',
  description: 'Il motore autonomo perpetuo degli obiettivi: ogni mattina misura i KPI di ogni obiettivo attivo, ragiona e (se in ritardo) corregge la strategia scrivendo tutto nel brain, poi propone le azioni del giorno come digest ✅/❌ su Telegram. Deploya agenti ogni giorno fino al conseguimento. Mai esecuzione senza la tua approvazione.',
  defaultHour: 8,
  defaultMinute: 30,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it' ? `🎯 *Goal Pursuit* — errore: ${r?.error ?? 'sconosciuto'}.` : `🎯 *Goal Pursuit* — error.`;
    }
    if (r.skipped || !r.runs?.length) {
      return lang === 'it' ? `🎯 *Goal Pursuit* — nessun obiettivo attivo con piano.` : `🎯 *Goal Pursuit* — no active planned goals.`;
    }
    const lines: string[] = [`🎯 *Spinta giornaliera obiettivi*`];
    for (const rev of (r.runs as GoalRun[])) {
      lines.push('', `*${rev.goal}*`);
      if (rev.error) { lines.push(`⚠️ ${rev.error}`); continue; }
      if (rev.done) { lines.push(`🏆 conseguito!`); continue; }
      if (rev.skipped) { lines.push(`⏸️ ${rev.skipped}`); continue; }
      if (rev.summary) lines.push(rev.summary);
      if (rev.stagnant) lines.push(`⛔ KPI fermi — serve la tua spinta.`);
      if (rev.proposed) lines.push(`→ ${rev.proposed} azioni proposte oggi (✅/❌)`);
      else lines.push(`nessuna azione oggi.`);
    }
    return lines.join('\n');
  },
};

export default agent;
