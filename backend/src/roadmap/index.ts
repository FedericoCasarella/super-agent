import { getSetting, setSetting } from '../db/index.js';

// =====================================================================
// Roadmap v2 — structured JSON model with horizons, strategy, KPIs, log.
// Stored as setting `roadmap_v2`. Legacy markdown `meta/business-roadmap.md` is
// preserved for the agent's text-based reasoning but the UI now reads JSON.
// =====================================================================
export type Status = 'pending' | 'in_progress' | 'done' | 'blocked' | 'parked';

export type Todo = {
  id: string;
  title: string;
  description?: string;
  status: Status;
  priority?: 'low' | 'med' | 'high';
  due?: string | null;       // ISO date
  created_at: string;
  updated_at?: string | null;
  completed_at?: string | null;
};

export type Kpi = {
  id: string;
  name: string;
  current: number;
  target: number;
  unit?: string;
  history?: { ts: string; value: number }[]; // optional series
};

export type LogEntry = { ts: string; text: string };

export type Strategy = {
  vision?: string;
  mission?: string;
  pillars?: string[];
  bets?: { title: string; rationale?: string }[];
};

export type Roadmap = {
  version: 2;
  updated_at: string;
  shortTerm: Todo[];   // ~4 weeks
  midTerm: Todo[];     // ~3 months
  longTerm: Todo[];    // ~12 months
  strategy: Strategy;
  kpis: Kpi[];
  log: LogEntry[];
};

const EMPTY: Roadmap = {
  version: 2,
  updated_at: new Date(0).toISOString(),
  shortTerm: [],
  midTerm: [],
  longTerm: [],
  strategy: {},
  kpis: [],
  log: [],
};

function nowIso() { return new Date().toISOString(); }
function rid(): string { return Math.random().toString(36).slice(2, 10); }

export async function getRoadmap(userId: number): Promise<Roadmap> {
  const r = await getSetting<Roadmap>(userId, 'roadmap_v2');
  if (!r) return { ...EMPTY };
  // Defensive defaults
  return {
    version: 2,
    updated_at: r.updated_at ?? nowIso(),
    shortTerm: Array.isArray(r.shortTerm) ? r.shortTerm : [],
    midTerm:   Array.isArray(r.midTerm)   ? r.midTerm   : [],
    longTerm:  Array.isArray(r.longTerm)  ? r.longTerm  : [],
    strategy:  r.strategy ?? {},
    kpis:      Array.isArray(r.kpis) ? r.kpis : [],
    log:       Array.isArray(r.log) ? r.log : [],
  };
}

export async function saveRoadmap(userId: number, patch: Partial<Roadmap>): Promise<Roadmap> {
  const cur = await getRoadmap(userId);
  const next: Roadmap = { ...cur, ...patch, version: 2, updated_at: nowIso() };
  await setSetting(userId, 'roadmap_v2', next);
  return next;
}

const HORIZONS = ['shortTerm', 'midTerm', 'longTerm'] as const;
type Horizon = typeof HORIZONS[number];

export async function addTodo(userId: number, horizon: Horizon, input: Partial<Todo>): Promise<Roadmap> {
  if (!HORIZONS.includes(horizon)) throw new Error('invalid horizon');
  const r = await getRoadmap(userId);
  const t: Todo = {
    id: input.id ?? rid(),
    title: String(input.title ?? '').trim(),
    description: input.description,
    status: input.status ?? 'pending',
    priority: input.priority,
    due: input.due ?? null,
    created_at: nowIso(),
  };
  if (!t.title) throw new Error('title required');
  r[horizon] = [...r[horizon], t];
  r.log.push({ ts: nowIso(), text: `+ [${horizon}] ${t.title}` });
  return await saveRoadmap(userId, r);
}

export async function updateTodo(userId: number, horizon: Horizon, id: string, patch: Partial<Todo>): Promise<Roadmap> {
  const r = await getRoadmap(userId);
  const list = r[horizon];
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('todo not found');
  const before = list[idx];
  const merged: Todo = { ...before, ...patch, id, updated_at: nowIso() };
  if (patch.status === 'done' && before.status !== 'done') merged.completed_at = nowIso();
  if (patch.status && patch.status !== 'done') merged.completed_at = null;
  r[horizon] = [...list.slice(0, idx), merged, ...list.slice(idx + 1)];
  if (patch.status && patch.status !== before.status) {
    r.log.push({ ts: nowIso(), text: `${before.status} → ${patch.status}: ${before.title}` });
  }
  return await saveRoadmap(userId, r);
}

export async function deleteTodo(userId: number, horizon: Horizon, id: string): Promise<Roadmap> {
  const r = await getRoadmap(userId);
  const list = r[horizon];
  const idx = list.findIndex((x) => x.id === id);
  if (idx < 0) return r;
  const t = list[idx];
  r[horizon] = [...list.slice(0, idx), ...list.slice(idx + 1)];
  r.log.push({ ts: nowIso(), text: `- [${horizon}] ${t.title}` });
  return await saveRoadmap(userId, r);
}

export async function moveTodo(userId: number, fromHorizon: Horizon, id: string, toHorizon: Horizon): Promise<Roadmap> {
  if (fromHorizon === toHorizon) return await getRoadmap(userId);
  const r = await getRoadmap(userId);
  const idx = r[fromHorizon].findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('todo not found');
  const t = r[fromHorizon][idx];
  r[fromHorizon] = [...r[fromHorizon].slice(0, idx), ...r[fromHorizon].slice(idx + 1)];
  r[toHorizon] = [...r[toHorizon], { ...t, updated_at: nowIso() }];
  r.log.push({ ts: nowIso(), text: `${fromHorizon} → ${toHorizon}: ${t.title}` });
  return await saveRoadmap(userId, r);
}

export async function setStrategy(userId: number, s: Partial<Strategy>): Promise<Roadmap> {
  const r = await getRoadmap(userId);
  r.strategy = { ...r.strategy, ...s };
  r.log.push({ ts: nowIso(), text: 'strategy updated' });
  return await saveRoadmap(userId, r);
}

export async function upsertKpi(userId: number, kpi: Partial<Kpi>): Promise<Roadmap> {
  const r = await getRoadmap(userId);
  const id = kpi.id ?? rid();
  const idx = r.kpis.findIndex((k) => k.id === id);
  const base = idx >= 0 ? r.kpis[idx] : ({ id, name: '', current: 0, target: 0, history: [] } as Kpi);
  const next: Kpi = {
    ...base,
    ...kpi,
    id,
    name: kpi.name ?? base.name,
    current: kpi.current ?? base.current,
    target: kpi.target ?? base.target,
    unit: kpi.unit ?? base.unit,
    history: [...(base.history ?? []), { ts: nowIso(), value: kpi.current ?? base.current }].slice(-50),
  };
  r.kpis = idx >= 0 ? [...r.kpis.slice(0, idx), next, ...r.kpis.slice(idx + 1)] : [...r.kpis, next];
  return await saveRoadmap(userId, r);
}

export async function deleteKpi(userId: number, id: string): Promise<Roadmap> {
  const r = await getRoadmap(userId);
  r.kpis = r.kpis.filter((k) => k.id !== id);
  return await saveRoadmap(userId, r);
}

// Stats for charts
export async function stats(userId: number) {
  const r = await getRoadmap(userId);
  const byHorizon = HORIZONS.map((h) => {
    const list = r[h];
    return {
      horizon: h,
      total: list.length,
      done: list.filter((t) => t.status === 'done').length,
      wip: list.filter((t) => t.status === 'in_progress').length,
      pending: list.filter((t) => t.status === 'pending').length,
      blocked: list.filter((t) => t.status === 'blocked').length,
      parked: list.filter((t) => t.status === 'parked').length,
    };
  });
  // Burn-down: completions per day last 30 days
  const cutoff = Date.now() - 30 * 86_400_000;
  const completions: Record<string, number> = {};
  for (const h of HORIZONS) {
    for (const t of r[h]) {
      if (t.completed_at && new Date(t.completed_at).getTime() >= cutoff) {
        const day = t.completed_at.slice(0, 10);
        completions[day] = (completions[day] ?? 0) + 1;
      }
    }
  }
  const burndown = Object.entries(completions).sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
  return { byHorizon, burndown, kpis: r.kpis };
}
