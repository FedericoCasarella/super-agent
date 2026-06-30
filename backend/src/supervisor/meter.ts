// Automation meter — rolling-7gg "% task ClickUp chiuse senza intervento
// manuale di Marco". Metrica-bussola del progetto Performa (baseline 0% →
// target 70% entro gennaio 2027).
//
// Definizione (concordata): una task conta come AUTO se la transizione verso il
// suo stato finale chiuso l'ha eseguita l'agente. Col token personale (pk_)
// ClickUp attribuisce ogni mossa a Marco, quindi l'unica prova che "l'ha fatto
// l'agente" è il ledger task_action_log. Il rate incrocia:
//   - denominatore: task realmente entrate in stato terminale negli ultimi 7gg
//     (API ClickUp, date_closed/date_done) — include ciò che chiude Marco;
//   - numeratore: quelle il cui stato finale combacia con una mossa dell'agente
//     registrata nel ledger nella stessa finestra.
//
// Oggi il braccio sposta solo a 'waiting feedback client' (non terminale), quindi
// il numeratore è 0 → rate 0%. Onesto: salirà quando l'agente chiuderà davvero.

import { query, setSetting } from '../db/index.js';
import { getRecentlyClosedTasks } from '../clickup/client.js';
import { listGoals, upsertGoalKpi } from '../goals/index.js';

const WINDOW_DAYS = 7;
const KPI_NAME = 'Task auto-chiuse (7gg)';
const KPI_TARGET = 70;

export type AutoCloseRate = {
  windowDays: number;
  closed: number;   // denominatore: task entrate in stato terminale nella finestra
  auto: number;     // numeratore: chiuse dall'agente (mossa nel ledger)
  rate: number;     // percentuale intera 0..100
  computedAt: string;
};

export async function computeAutoCloseRate(userId: number, windowDays = WINDOW_DAYS): Promise<AutoCloseRate> {
  const sinceMs = Date.now() - windowDays * 86_400_000;
  const closed = await getRecentlyClosedTasks(sinceMs);
  const base = { windowDays, computedAt: new Date().toISOString() };
  if (closed.length === 0) return { ...base, closed: 0, auto: 0, rate: 0 };

  const ids = closed.map((t) => t.id);
  // Mosse dell'agente nella finestra sulle task chiuse. Match esatto id+stato:
  // l'agente conta solo se ha mosso la task PROPRIO nello stato finale chiuso.
  const rows = await query<{ task_id: string; to_status: string }>(
    `SELECT task_id, to_status FROM task_action_log
     WHERE user_id=$1 AND ts >= now() - ($2::int * interval '1 day') AND task_id = ANY($3)`,
    [userId, windowDays, ids],
  );
  const agentMoves = new Set(rows.map((r) => `${r.task_id}|${r.to_status}`));
  const auto = closed.filter((t) => agentMoves.has(`${t.id}|${t.status}`)).length;
  const rate = Math.round((auto / closed.length) * 100);
  return { ...base, closed: closed.length, auto, rate };
}

// Trova il goal "automazione 70%" attivo dell'utente (match su titolo/obiettivo).
async function findAutomationGoal(userId: number) {
  const goals = await listGoals(userId);
  return goals.find(
    (g) => g.status === 'active' && /70\s*%|automa/i.test(`${g.title} ${g.objective}`),
  ) ?? null;
}

// Calcola il rate e lo scrive: nello storico KPI del goal (se esiste) + in una
// setting per visibilità anche senza goal. Chiamata dal cron giornaliero.
export async function updateAutoCloseKpi(userId: number): Promise<AutoCloseRate & { goalId: number | null }> {
  const r = await computeAutoCloseRate(userId);
  await setSetting(userId, 'automation_meter.latest', r);

  const goal = await findAutomationGoal(userId);
  if (!goal) {
    console.log(`[meter:u${userId}] rate=${r.rate}% (${r.auto}/${r.closed}) — nessun goal "70%" attivo, KPI non aggiornata`);
    return { ...r, goalId: null };
  }
  const existing = (goal.kpis ?? []).find((k) => k.name === KPI_NAME);
  await upsertGoalKpi(userId, goal.id, {
    id: existing?.id, name: KPI_NAME, unit: '%', target: KPI_TARGET, current: r.rate,
  });
  console.log(`[meter:u${userId}] rate=${r.rate}% (${r.auto}/${r.closed}) → goal #${goal.id} KPI aggiornata`);
  return { ...r, goalId: goal.id };
}
