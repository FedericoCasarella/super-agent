// Goal Steward — il COO settimanale. Ogni venerdì 17:00 per ogni goal attivo:
//   1. misura il passo dei KPI (atteso vs reale, lineare sulla deadline)
//   2. raccoglie gli esiti dei sub-agent della settimana legati al goal
//   3. genera la review + le azioni proposte per la settimana successiva
//   4. le azioni NON partono: diventano una agent_proposal (keyboard Telegram
//      ✅/❌) — l'utente approva dal telefono
//   5. report Telegram con stato in linea / in ritardo per KPI
// Mai modifiche autonome a piano o KPI: lo steward propone, l'umano decide.

import { query } from '../../db/index.js';
import { runClaude } from '../../claude/runner.js';
import { listGoals, paceFor, type Goal } from '../../goals/index.js';
import { createProposal } from '../../sub_agents/index.js';
import type { InternalAgent, AgentReport, Lang } from './types.js';

function paceBadge(ratio: number | null): string {
  if (ratio == null) return '—';
  if (ratio >= 0.95) return '🟢 in linea';
  if (ratio >= 0.7) return '🟡 attenzione';
  return '🔴 in ritardo';
}

async function weekOutcomes(userId: number, goalTitle: string): Promise<string> {
  // Sub-agent della settimana il cui titolo/prompt cita il goal.
  const rows = await query<any>(
    `SELECT title, status, left(coalesce(result,''), 300) AS result
     FROM sub_agents
     WHERE user_id=$1 AND created_at > now() - interval '7 days'
       AND (title ILIKE $2 OR prompt ILIKE $2)
     ORDER BY created_at DESC LIMIT 10`,
    [userId, `%${goalTitle.slice(0, 40)}%`],
  );
  if (!rows.length) return '(nessun sub-agent collegato al goal questa settimana)';
  return rows.map((r: any) => `- [${r.status}] ${r.title}: ${r.result || '(senza risultato)'}`).join('\n');
}

async function reviewGoal(userId: number, g: Goal): Promise<{ ok: boolean; summary?: string; proposed?: number; error?: string }> {
  const kpiLines = (g.kpis ?? []).map((k) => {
    const { expected, ratio } = paceFor(g, k);
    return `- ${k.name}: ${k.current}/${k.target}${k.unit ? ` ${k.unit}` : ''} · atteso a oggi ${expected.toFixed(1)} · ${paceBadge(ratio)}`;
  }).join('\n');
  const milestones = (g.plan?.milestones ?? []).map((m) => `- [${m.status}] ${m.title}${m.due ? ` (due ${m.due})` : ''}`).join('\n');
  const outcomes = await weekOutcomes(userId, g.title);

  const prompt = [
    `Sei il COO. Review settimanale dell'obiettivo:`,
    `GOAL: ${g.title} — ${g.objective}${g.deadline ? ` (deadline ${g.deadline})` : ''}`,
    kpiLines ? `KPI:\n${kpiLines}` : 'KPI: nessuno definito',
    milestones ? `MILESTONES:\n${milestones}` : '',
    `ESITI SETTIMANA (sub-agent):\n${outcomes}`,
    '',
    `Se hai tool MCP (Flowspace, brain) verifica lo stato reale (pipeline, clienti, fatture).`,
    `Rispondi SOLO con JSON valido:`,
    `{"summary":"<3-5 frasi: come sta andando, cosa ha funzionato, dove siamo indietro e perché>","next_actions":[{"title":"...","brief":"azione concreta per la prossima settimana, self-contained"}]}`,
    `Regole: 2-4 next_actions, concrete. Se il goal è in linea e non serve spinta, anche 0 azioni va bene (array vuoto).`,
  ].filter(Boolean).join('\n');

  const res = await runClaude(userId, prompt, { timeoutMs: 240_000, kind: 'goal-steward', meta: { goalId: g.id } });
  if (!res.ok) return { ok: false, error: res.stderr || 'agent error' };
  let s = (res.text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return { ok: false, error: 'no JSON' };
  let parsed: any;
  try { parsed = JSON.parse(s.slice(a, b + 1)); } catch { return { ok: false, error: 'invalid JSON' }; }
  const actions = (parsed.next_actions ?? []).slice(0, 4)
    .map((x: any) => ({ title: String(x.title ?? '').slice(0, 150), brief: String(x.brief ?? '').slice(0, 600) }))
    .filter((x: any) => x.title);

  if (actions.length) {
    await createProposal(
      userId,
      `Goal: ${g.title} — azioni prossima settimana`,
      String(parsed.summary ?? '').slice(0, 400) || g.objective,
      actions.map((a2: any) => ({
        title: a2.title,
        brief: a2.brief,
        prompt: [
          `Contesto: obiettivo "${g.title}" (${g.objective}).`,
          `Azione: ${a2.title}`,
          `Dettagli: ${a2.brief}`,
          `Esegui concretamente con i tool disponibili. Riporta risultato e blocchi.`,
        ].join('\n'),
      })),
      { goalId: g.id },
    );
  }
  await query(`UPDATE goals SET last_review_at=now(), updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, g.id]);
  return { ok: true, summary: String(parsed.summary ?? ''), proposed: actions.length };
}

async function run(userId: number): Promise<AgentReport> {
  const started = Date.now();
  // Scheduler fires daily at 17:00 — the weekly review only runs on Friday.
  // `silent: true` tells the registry to skip the Telegram notify for the
  // other 6 days. A manual Run from the UI bypasses this (forced via env var
  // is overkill; just run it on Friday or trigger twice — first sets marker).
  const day = new Date().getDay(); // 0=dom, 5=ven
  if (day !== 5 && process.env.GOAL_STEWARD_ANY_DAY !== '1') {
    return { skipped: 1, silent: true, reason: 'not-friday', durationMs: Date.now() - started };
  }
  const goals = (await listGoals(userId)).filter((g) => g.status === 'active');
  // No active goals = nothing to review. Silent: don't ping the user with
  // "nessun obiettivo attivo" every Friday.
  if (!goals.length) return { skipped: 1, silent: true, durationMs: Date.now() - started };

  const reviews: any[] = [];
  let proposed = 0, errors = 0;
  for (const g of goals.slice(0, 5)) {
    const kpiBadges = (g.kpis ?? []).map((k) => `${k.name}: ${k.current}/${k.target} ${paceBadge(paceFor(g, k).ratio)}`);
    const r = await reviewGoal(userId, g);
    if (!r.ok) { errors++; reviews.push({ goal: g.title, error: r.error }); continue; }
    proposed += r.proposed ?? 0;
    reviews.push({ goal: g.title, kpis: kpiBadges, summary: r.summary, proposed: r.proposed });
  }
  return { goals: goals.length, proposed, errors, reviews, durationMs: Date.now() - started };
}

const agent: InternalAgent = {
  name: 'goal_steward',
  title: 'Goal Steward',
  description: 'Il COO settimanale: ogni venerdì misura i KPI di ogni obiettivo attivo (in linea / in ritardo rispetto alla deadline), raccoglie gli esiti dei sub-agent della settimana e propone le azioni della settimana successiva via Telegram (✅/❌). Non esegue mai nulla senza approvazione.',
  defaultHour: 17,
  defaultMinute: 0,
  run,
  humanize(r, lang: Lang, status) {
    if (status === 'error') {
      return lang === 'it'
        ? `🎯 *Goal Steward* — review fallita: ${r?.error ?? 'errore'}.`
        : `🎯 *Goal Steward* — review failed: ${r?.error ?? 'error'}.`;
    }
    if (r.skipped) {
      return lang === 'it'
        ? `🎯 *Goal Steward* — nessun obiettivo attivo. Creane uno da Roadmap → Obiettivi.`
        : `🎯 *Goal Steward* — no active goals.`;
    }
    const lines: string[] = [`🎯 *Review settimanale obiettivi* (${r.goals})`];
    for (const rev of (r.reviews ?? [])) {
      lines.push('', `*${rev.goal}*`);
      if (rev.error) { lines.push(`⚠️ review fallita: ${rev.error}`); continue; }
      for (const k of (rev.kpis ?? [])) lines.push(`• ${k}`);
      if (rev.summary) lines.push(rev.summary);
      if (rev.proposed) lines.push(`→ ${rev.proposed} azioni proposte (approva con i bottoni ✅/❌)`);
    }
    return lines.join('\n');
  },
};

export default agent;
