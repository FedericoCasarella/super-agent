// Goals — obiettivi di lungo periodo con piano approvabile, KPI e steward.
// Human-in-the-loop a 3 livelli:
//   1. Piano: l'agente genera milestones+azioni → pending_plan → l'utente
//      approva/scarta dalla UI (Roadmap → Obiettivi).
//   2. Azioni settimanali: lo steward propone sub-agent via agent_proposals
//      (keyboard Telegram ✅/❌ esistente) — mai spawn cieco.
//   3. KPI: aggiornati dall'utente (o proposti dallo steward nel report).

import { query } from '../db/index.js';
import { runClaude } from '../claude/runner.js';

export type GoalKpi = {
  id: string;
  name: string;
  unit?: string;
  target: number;
  current: number;
  history: { ts: string; value: number }[];
};

export type Milestone = {
  id: string;
  title: string;
  due?: string;
  status: 'pending' | 'in_progress' | 'done';
  area?: string;     // categoria: HR, Operativo, Relations, Marketing…
  order?: number;    // posizione in sequenza (0-based); pari = parallele
};

export type GoalPlan = {
  milestones: Milestone[];
  next_actions: { title: string; brief: string }[];
  // KPI proposti dall'agente insieme al piano — applicati al goal all'approvazione.
  kpis?: { name: string; unit?: string; target: number; current?: number }[];
  notes?: string;
};

export type Goal = {
  id: number;
  title: string;
  objective: string;
  deadline: string | null;
  status: 'draft' | 'active' | 'paused' | 'done' | 'archived';
  kpis: GoalKpi[];
  plan: GoalPlan | null;
  pending_plan: GoalPlan | null;
  last_review_at: string | null;
  created_at: string;
  updated_at: string;
};

function rid(): string {
  return Math.random().toString(36).slice(2, 9);
}

export async function listGoals(userId: number, includeArchived = false): Promise<Goal[]> {
  return await query<Goal>(
    `SELECT id::int, title, objective, deadline::text, status, kpis, plan, pending_plan, last_review_at, created_at, updated_at
     FROM goals WHERE user_id=$1 ${includeArchived ? '' : `AND status <> 'archived'`}
     ORDER BY (status='active') DESC, created_at DESC`,
    [userId],
  );
}

export async function getGoal(userId: number, id: number): Promise<Goal | null> {
  const rows = await query<Goal>(
    `SELECT id::int, title, objective, deadline::text, status, kpis, plan, pending_plan, last_review_at, created_at, updated_at
     FROM goals WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function createGoal(userId: number, p: { title: string; objective: string; deadline?: string | null }): Promise<Goal> {
  const rows = await query<{ id: number }>(
    `INSERT INTO goals(user_id, title, objective, deadline) VALUES($1,$2,$3,$4) RETURNING id::int`,
    [userId, p.title.slice(0, 200), p.objective.slice(0, 1000), p.deadline || null],
  );
  return (await getGoal(userId, rows[0].id))!;
}

export async function updateGoal(userId: number, id: number, p: Partial<{ title: string; objective: string; deadline: string | null; status: Goal['status'] }>): Promise<Goal | null> {
  const fields: string[] = [];
  const vals: any[] = [];
  let i = 2;
  if (p.title !== undefined) { fields.push(`title=$${++i}`); vals.push(p.title.slice(0, 200)); }
  if (p.objective !== undefined) { fields.push(`objective=$${++i}`); vals.push(p.objective.slice(0, 1000)); }
  if (p.deadline !== undefined) { fields.push(`deadline=$${++i}`); vals.push(p.deadline || null); }
  if (p.status !== undefined) { fields.push(`status=$${++i}`); vals.push(p.status); }
  if (fields.length) {
    await query(`UPDATE goals SET ${fields.join(', ')}, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, id, ...vals]);
  }
  return getGoal(userId, id);
}

// ── KPI ────────────────────────────────────────────────────────────────────

export async function upsertGoalKpi(userId: number, goalId: number, kpi: { id?: string; name: string; unit?: string; target: number; current?: number }): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g) return null;
  const kpis: GoalKpi[] = Array.isArray(g.kpis) ? g.kpis : [];
  const now = new Date().toISOString();
  const existing = kpi.id ? kpis.find((k) => k.id === kpi.id) : undefined;
  if (existing) {
    existing.name = kpi.name;
    existing.unit = kpi.unit;
    existing.target = Number(kpi.target);
    if (kpi.current !== undefined && Number(kpi.current) !== existing.current) {
      existing.current = Number(kpi.current);
      existing.history = [...(existing.history ?? []), { ts: now, value: existing.current }].slice(-100);
    }
  } else {
    const cur = Number(kpi.current ?? 0);
    kpis.push({
      id: rid(), name: kpi.name, unit: kpi.unit, target: Number(kpi.target),
      current: cur, history: [{ ts: now, value: cur }],
    });
  }
  await query(`UPDATE goals SET kpis=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(kpis)]);
  return getGoal(userId, goalId);
}

export async function deleteGoalKpi(userId: number, goalId: number, kpiId: string): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g) return null;
  const kpis = (Array.isArray(g.kpis) ? g.kpis : []).filter((k) => k.id !== kpiId);
  await query(`UPDATE goals SET kpis=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(kpis)]);
  return getGoal(userId, goalId);
}

// On-track: expected = target * elapsed/total (lineare). Ritorna ratio
// current/expected — la UI mappa: ≥0.95 in linea, 0.7-0.95 attenzione, <0.7 in ritardo.
export function paceFor(goal: Goal, kpi: GoalKpi): { expected: number; ratio: number | null } {
  if (!goal.deadline || !kpi.target) return { expected: kpi.target, ratio: null };
  const start = new Date(goal.created_at).getTime();
  const end = new Date(goal.deadline).getTime();
  const now = Date.now();
  if (end <= start) return { expected: kpi.target, ratio: null };
  const t = Math.max(0, Math.min(1, (now - start) / (end - start)));
  const expected = kpi.target * t;
  // Goal appena creato: expected ≈ 0 → ratio esplode. Sotto il 2% del
  // percorso il pace non è ancora significativo.
  if (expected < kpi.target * 0.02) return { expected, ratio: null };
  return { expected, ratio: kpi.current / expected };
}

// ── Piano: generazione LLM + approvazione ──────────────────────────────────

function parsePlanJson(raw: string): GoalPlan | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let parsed: any;
  try { parsed = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const plan: GoalPlan = {
    milestones: (parsed.milestones ?? []).slice(0, 12).map((m: any, i: number) => ({ id: rid(), title: String(m.title ?? '').slice(0, 200), due: m.due, status: 'pending' as const, area: m.area ? String(m.area).slice(0, 40) : undefined, order: m.order !== undefined ? Number(m.order) : i })),
    next_actions: (parsed.next_actions ?? []).slice(0, 6).map((x: any) => ({ title: String(x.title ?? '').slice(0, 150), brief: String(x.brief ?? '').slice(0, 600) })),
    kpis: (parsed.kpis ?? []).slice(0, 5).map((k: any) => ({ name: String(k.name ?? '').slice(0, 100), unit: k.unit ? String(k.unit).slice(0, 20) : undefined, target: Number(k.target ?? 0), current: k.current !== undefined ? Number(k.current) : undefined })).filter((k: any) => k.name && k.target),
    notes: parsed.notes ? String(parsed.notes).slice(0, 800) : undefined,
  };
  return plan.milestones.length ? plan : null;
}

const PLAN_JSON_SPEC = [
  `Rispondi SOLO con JSON valido:`,
  `{"kpis":[{"name":"...","unit":"...","target":N,"current":N}],"milestones":[{"title":"...","due":"YYYY-MM-DD","area":"Operativo|Marketing|Relations|HR|Vendite|Prodotto|Finance","order":N}],"next_actions":[{"title":"...","brief":"cosa fare concretamente questa settimana, self-contained"}],"notes":"<1-3 frasi di strategia>"}`,
  `Regole: 1-3 KPI misurabili (proponi TU le metriche giuste, con current = valore reale di oggi se lo conosci dal contesto, altrimenti 0); 4-8 milestones realistiche fino alla deadline. Per OGNI milestone assegna:`,
  `- "area": la funzione aziendale (es. Operativo, Marketing, Relations, Vendite, HR, Prodotto, Finance). Raggruppa le milestone affini sotto la stessa area.`,
  `- "order": l'ordine di esecuzione (0,1,2…). Milestone che possono partire in parallelo ricevono lo STESSO order; quelle in sequenza order crescente.`,
  `Infine 2-4 next_actions per la PRIMA settimana, concrete ed eseguibili da un sub-agent o dall'utente.`,
].join('\n');

async function generatePlanWithContext(userId: number, goalId: number, context?: string): Promise<{ ok: boolean; error?: string; goal?: Goal }> {
  const g = await getGoal(userId, goalId);
  if (!g) return { ok: false, error: 'goal non trovato' };
  const kpiLines = (g.kpis ?? []).map((k) => `- ${k.name}: ${k.current}/${k.target}${k.unit ? ` ${k.unit}` : ''}`).join('\n');
  const prompt = [
    `Sei il COO dell'utente. Obiettivo da pianificare:`,
    `TITOLO: ${g.title}`,
    `OBIETTIVO MISURABILE: ${g.objective}`,
    g.deadline ? `DEADLINE: ${g.deadline}` : `DEADLINE: non fissata`,
    kpiLines ? `KPI GIÀ DEFINITI (non riproporli):\n${kpiLines}` : '',
    context ? `\nINDICAZIONI DELL'UTENTE (incorporale nel piano):\n${context.slice(0, 1500)}` : '',
    '',
    `Se hai tool MCP (Flowspace, brain, calendario) usali per capire il contesto reale (clienti attuali, pipeline, capacità). Poi produci piano + KPI.`,
    '',
    PLAN_JSON_SPEC,
  ].filter(Boolean).join('\n');
  const res = await runClaude(userId, prompt, { timeoutMs: 240_000, kind: 'goal-plan', meta: { goalId } });
  if (!res.ok) return { ok: false, error: res.stderr || 'agent error' };
  const plan = parsePlanJson(res.text ?? '');
  if (!plan) return { ok: false, error: 'piano non parsabile' };
  await query(`UPDATE goals SET pending_plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(plan)]);
  return { ok: true, goal: (await getGoal(userId, goalId))! };
}

export async function generatePlan(userId: number, goalId: number, context?: string): Promise<{ ok: boolean; error?: string; goal?: Goal }> {
  return generatePlanWithContext(userId, goalId, context);
}

// Revisione conversazionale: l'utente discute il piano su Telegram, l'agente
// chiama questo con il feedback → nuovo pending_plan che lo incorpora.
export async function revisePlan(userId: number, goalId: number, feedback: string): Promise<{ ok: boolean; error?: string; goal?: Goal }> {
  const g = await getGoal(userId, goalId);
  if (!g) return { ok: false, error: 'goal non trovato' };
  const current = g.pending_plan ?? g.plan;
  // Nessun piano ancora? Il feedback diventa contesto per la PRIMA generazione
  // invece di fallire — l'agente può sempre chiamare revise senza pensarci.
  if (!current) return generatePlanWithContext(userId, goalId, feedback);
  const prompt = [
    `Sei il COO dell'utente. Stai rivedendo il piano dell'obiettivo "${g.title}" (${g.objective}${g.deadline ? `, deadline ${g.deadline}` : ''}).`,
    '',
    `PIANO ATTUALE:`,
    JSON.stringify({ kpis: current.kpis ?? [], milestones: current.milestones.map((m) => ({ title: m.title, due: m.due })), next_actions: current.next_actions, notes: current.notes }, null, 2),
    '',
    `FEEDBACK DELL'UTENTE (incorporalo, mantieni il resto che va bene):`,
    feedback.slice(0, 1500),
    '',
    PLAN_JSON_SPEC,
  ].join('\n');
  const res = await runClaude(userId, prompt, { timeoutMs: 240_000, kind: 'goal-plan-revise', meta: { goalId } });
  if (!res.ok) return { ok: false, error: res.stderr || 'agent error' };
  const plan = parsePlanJson(res.text ?? '');
  if (!plan) return { ok: false, error: 'piano non parsabile' };
  await query(`UPDATE goals SET pending_plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(plan)]);
  return { ok: true, goal: (await getGoal(userId, goalId))! };
}

// Approva il pending_plan → diventa il piano attivo, goal → active.
// Le next_actions diventano una agent_proposal (keyboard Telegram ✅/❌) così
// l'esecuzione resta a doppia approvazione.
export async function approvePlan(userId: number, goalId: number): Promise<{ ok: boolean; error?: string; goal?: Goal }> {
  const g = await getGoal(userId, goalId);
  if (!g) return { ok: false, error: 'goal non trovato' };
  if (!g.pending_plan) return { ok: false, error: 'nessun piano in attesa' };
  const plan = g.pending_plan;
  // Applica i KPI proposti dall'agente (merge per nome — non duplica, non
  // sovrascrive history di KPI esistenti).
  const kpis: GoalKpi[] = Array.isArray(g.kpis) ? g.kpis : [];
  const now = new Date().toISOString();
  for (const pk of plan.kpis ?? []) {
    if (kpis.some((k) => k.name.toLowerCase() === pk.name.toLowerCase())) continue;
    const cur = Number(pk.current ?? 0);
    kpis.push({ id: rid(), name: pk.name, unit: pk.unit, target: Number(pk.target), current: cur, history: [{ ts: now, value: cur }] });
  }
  await query(
    `UPDATE goals SET plan=$3::jsonb, kpis=$4::jsonb, pending_plan=NULL, status=CASE WHEN status='draft' THEN 'active' ELSE status END, updated_at=now()
     WHERE user_id=$1 AND id=$2`,
    [userId, goalId, JSON.stringify(plan), JSON.stringify(kpis)],
  );
  // Proponi le azioni della settimana 1 via agent_proposals esistente.
  if (plan.next_actions?.length) {
    try {
      const { createProposal } = await import('../sub_agents/index.js');
      await createProposal(
        userId,
        `Goal: ${g.title} — azioni settimana 1`,
        plan.notes ?? g.objective,
        plan.next_actions.map((a) => ({
          title: a.title,
          brief: a.brief,
          prompt: [
            `Contesto: stai lavorando all'obiettivo "${g.title}" (${g.objective}).`,
            `Azione da eseguire: ${a.title}`,
            `Dettagli: ${a.brief}`,
            `Usa i tool disponibili (brain, Flowspace, mail) per eseguire concretamente. Riporta cosa hai fatto e cosa serve dall'utente.`,
          ].join('\n'),
        })),
        { goalId },
      );
    } catch (e) { console.error('[goals] createProposal failed', e); }
  }
  return { ok: true, goal: (await getGoal(userId, goalId))! };
}

export async function rejectPlan(userId: number, goalId: number): Promise<{ ok: boolean }> {
  await query(`UPDATE goals SET pending_plan=NULL, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId]);
  return { ok: true };
}

export async function updateMilestone(userId: number, goalId: number, milestoneId: string, status: 'pending' | 'in_progress' | 'done'): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g?.plan) return g;
  const plan = g.plan;
  const m = plan.milestones.find((x) => x.id === milestoneId);
  if (m) m.status = status;
  await query(`UPDATE goals SET plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(plan)]);
  return getGoal(userId, goalId);
}

// Add a milestone to the (approved) plan. If no plan exists yet, seed one.
export async function addMilestone(userId: number, goalId: number, p: { title: string; due?: string; area?: string; order?: number }): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g) return null;
  const plan: GoalPlan = g.plan ?? { milestones: [], next_actions: [] };
  const order = p.order ?? (plan.milestones.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1);
  plan.milestones.push({ id: rid(), title: p.title.slice(0, 200), due: p.due, status: 'pending', area: p.area?.slice(0, 40), order });
  await query(`UPDATE goals SET plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(plan)]);
  return getGoal(userId, goalId);
}

// Edit a milestone's title/due/area/order (status uses updateMilestone).
export async function editMilestone(userId: number, goalId: number, milestoneId: string, patch: { title?: string; due?: string | null; area?: string | null; order?: number }): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g?.plan) return g;
  const m = g.plan.milestones.find((x) => x.id === milestoneId);
  if (!m) return g;
  if (patch.title !== undefined) m.title = patch.title.slice(0, 200);
  if (patch.due !== undefined) m.due = patch.due ?? undefined;
  if (patch.area !== undefined) m.area = patch.area ? patch.area.slice(0, 40) : undefined;
  if (patch.order !== undefined) m.order = patch.order;
  await query(`UPDATE goals SET plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(g.plan)]);
  return getGoal(userId, goalId);
}

export async function removeMilestone(userId: number, goalId: number, milestoneId: string): Promise<Goal | null> {
  const g = await getGoal(userId, goalId);
  if (!g?.plan) return g;
  g.plan.milestones = g.plan.milestones.filter((x) => x.id !== milestoneId);
  await query(`UPDATE goals SET plan=$3::jsonb, updated_at=now() WHERE user_id=$1 AND id=$2`, [userId, goalId, JSON.stringify(g.plan)]);
  return getGoal(userId, goalId);
}

// Hard-delete a goal (and its execution rows cascade-null via ON DELETE SET NULL).
export async function deleteGoal(userId: number, goalId: number): Promise<{ ok: boolean }> {
  await query(`DELETE FROM goals WHERE user_id=$1 AND id=$2`, [userId, goalId]);
  return { ok: true };
}
