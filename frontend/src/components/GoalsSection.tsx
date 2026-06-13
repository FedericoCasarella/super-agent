// Obiettivi (Goals) — dashboard READ-ONLY. Tutto il ciclo di vita avviene su
// Telegram: l'utente esprime l'obiettivo in chat → l'agente crea goal, genera
// piano + KPI e manda la keyboard ✅ Approva / ❌ Scarta → il piano si discute
// rispondendo in chat (goal_revise) → all'approvazione partono le proposte
// settimana 1 → il Goal Steward rivede ogni venerdì.
// Qui si guarda soltanto: KPI con pace atteso-vs-reale, milestones, stato.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip } from './ui';
import DataTable from './DataTable';
import { Target, Sparkles, TrendingUp, CalendarDays, Bot, Send } from 'lucide-react';

type GoalKpi = { id: string; name: string; unit?: string; target: number; current: number; history: { ts: string; value: number }[] };
type Milestone = { id: string; title: string; due?: string; status: 'pending' | 'in_progress' | 'done' };
type Plan = { milestones: Milestone[]; next_actions: { title: string; brief: string }[]; kpis?: any[]; notes?: string };
type Goal = {
  id: number; title: string; objective: string; deadline: string | null;
  status: 'draft' | 'active' | 'paused' | 'done' | 'archived';
  kpis: GoalKpi[]; plan: Plan | null; pending_plan: Plan | null;
  last_review_at: string | null; created_at: string;
};

// Pace lineare: atteso = target * tempo trascorso / tempo totale.
function pace(goal: Goal, kpi: GoalKpi): { expected: number; ratio: number | null } {
  if (!goal.deadline || !kpi.target) return { expected: kpi.target, ratio: null };
  const start = new Date(goal.created_at).getTime();
  const end = new Date(goal.deadline).getTime();
  if (end <= start) return { expected: kpi.target, ratio: null };
  const t = Math.max(0, Math.min(1, (Date.now() - start) / (end - start)));
  const expected = kpi.target * t;
  if (expected < kpi.target * 0.02) return { expected, ratio: null };
  return { expected, ratio: kpi.current / expected };
}
function paceBadge(ratio: number | null): { label: string; cls: string } {
  if (ratio == null) return { label: '—', cls: 'text-muted-foreground' };
  if (ratio >= 0.95) return { label: '🟢 in linea', cls: 'text-emerald-400' };
  if (ratio >= 0.7) return { label: '🟡 attenzione', cls: 'text-amber-400' };
  return { label: '🔴 in ritardo', cls: 'text-red-400' };
}

function MiniSpark({ points, color = '#34d399' }: { points: number[]; color?: string }) {
  if (points.length < 2) return null;
  const w = 90, h = 24;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  return <svg width={w} height={h} className="opacity-80"><path d={path} fill="none" stroke={color} strokeWidth="1.5" /></svg>;
}

const STATUS_CHIP: Record<Goal['status'], { label: string; tone?: any }> = {
  draft: { label: 'bozza' },
  active: { label: 'attivo', tone: 'on' },
  paused: { label: 'in pausa', tone: 'warn' },
  done: { label: 'completato', tone: 'on' },
  archived: { label: 'archiviato' },
};

export default function GoalsSection() {
  const nav = useNavigate();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const openGoal = openId != null ? goals.find((g) => g.id === openId) ?? null : null;

  useEffect(() => {
    let alive = true;
    const load = async () => { try { const r = await api.goalsList(); if (alive) setGoals(r.rows); } catch {} };
    load();
    const iv = setInterval(load, 30_000); // il lifecycle vive su Telegram → la UI si tiene fresca da sola
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Dettaglio read-only.
  function GoalDetail({ g, onClose }: { g: Goal; onClose: () => void }) {
    const plan = g.plan;
    const doneMs = plan?.milestones.filter((m) => m.status === 'done').length ?? 0;
    const totMs = plan?.milestones.length ?? 0;
    const msPct = totMs > 0 ? Math.round((doneMs / totMs) * 100) : 0;
    return (
      <div>
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-4 border-b border-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Target size={18} className="text-accent shrink-0" />
              <h2 className="text-lg font-semibold">{g.title}</h2>
              <Chip tone={STATUS_CHIP[g.status].tone}>{STATUS_CHIP[g.status].label}</Chip>
            </div>
            <div className="text-sm text-muted-foreground mt-1">{g.objective}</div>
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {g.deadline && (() => {
                const daysLeft = Math.ceil((new Date(g.deadline).getTime() - Date.now()) / 86_400_000);
                const tone = daysLeft < 0 ? 'text-red-400 border-red-400/30 bg-red-500/10'
                  : daysLeft <= 14 ? 'text-amber-300 border-amber-400/30 bg-amber-500/10'
                  : 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10';
                return (
                  <span className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-lg border ${tone}`}>
                    <CalendarDays size={14} className="shrink-0" />
                    <span className="leading-tight">
                      <span className="block text-[9px] uppercase tracking-wider opacity-70 font-semibold">Deadline</span>
                      <span className="text-xs font-semibold">
                        {new Date(g.deadline).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
                        <span className="opacity-70 font-normal"> · {daysLeft < 0 ? `scaduta da ${-daysLeft}g` : `${daysLeft}g rimasti`}</span>
                      </span>
                    </span>
                  </span>
                );
              })()}
              <span className="inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-lg border border-border bg-surface2/40 text-muted-foreground">
                <Bot size={14} className="text-accent shrink-0" />
                <span className="leading-tight">
                  <span className="block text-[9px] uppercase tracking-wider opacity-70 font-semibold">Review steward</span>
                  <span className="text-xs font-semibold text-foreground/90">
                    {g.last_review_at
                      ? `ultima ${new Date(g.last_review_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`
                      : 'venerdì 17:00'}
                  </span>
                </span>
              </span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Chiudi">✕</Button>
        </div>

        <div className="pt-4 space-y-4">
          {/* Piano in attesa di approvazione — si approva SU TELEGRAM */}
          {g.pending_plan && (
            <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 space-y-3">
              <div className="text-sm font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-accent" /> Piano proposto — approvalo da Telegram</div>
              {g.pending_plan.notes && <div className="text-xs text-muted-foreground border-l-2 border-accent/40 pl-2">{g.pending_plan.notes}</div>}
              {(g.pending_plan.kpis?.length ?? 0) > 0 && (
                <div className="rounded-lg bg-surface2/40 border border-border p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">KPI proposti</div>
                  {g.pending_plan.kpis!.map((k: any, i: number) => <div key={i} className="text-xs">• {k.name}: {k.current ?? 0} → {k.target}{k.unit ? ` ${k.unit}` : ''}</div>)}
                </div>
              )}
              <div className="space-y-1">
                {g.pending_plan.milestones.map((m, i) => (
                  <div key={m.id} className="flex items-center gap-2 text-xs">
                    <span className="w-4 h-4 rounded-full bg-accent/15 text-accent flex items-center justify-center text-[9px] font-semibold shrink-0">{i + 1}</span>
                    <span className="flex-1">{m.title}</span>
                    {m.due && <span className="text-[10px] text-muted-foreground font-mono shrink-0">{m.due}</span>}
                  </div>
                ))}
              </div>
              {g.pending_plan.next_actions?.length > 0 && (
                <div className="rounded-lg bg-surface2/40 border border-border p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Settimana 1</div>
                  {g.pending_plan.next_actions.map((a, i) => <div key={i} className="text-xs">• {a.title}</div>)}
                </div>
              )}
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
                <Send size={11} className="text-accent" />
                Approva con i bottoni ✅/❌ su Telegram, o rispondi in chat per discuterlo con l'agente.
              </div>
            </div>
          )}

          {/* KPI */}
          {(g.kpis ?? []).length > 0 && (
            <div className="rounded-xl border border-border bg-surface2/30 p-4">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5 mb-3"><TrendingUp size={12} /> Metriche</div>
              <div className="space-y-4">
                {(g.kpis ?? []).map((k) => {
                  const { expected, ratio } = pace(g, k);
                  const badge = paceBadge(ratio);
                  const pct = k.target ? Math.min(100, Math.round((k.current / k.target) * 100)) : 0;
                  const expectedPct = k.target ? Math.min(100, Math.round((expected / k.target) * 100)) : 0;
                  return (
                    <div key={k.id}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">{k.name}</span>
                        <span className={`text-xs ${badge.cls}`}>{badge.label}</span>
                      </div>
                      <div className="flex items-end justify-between mt-1">
                        <span className="text-xl font-semibold">{k.current}<span className="text-muted-foreground text-sm">/{k.target}{k.unit ? ` ${k.unit}` : ''}</span></span>
                        <MiniSpark points={(k.history ?? []).map((h) => h.value)} />
                      </div>
                      <div className="relative mt-2 h-2 rounded-full bg-surface2/80 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))] transition-all duration-700" style={{ width: `${pct}%` }} />
                        {g.deadline && <div className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-foreground/70" style={{ left: `${expectedPct}%` }} title={`Atteso a oggi: ${expected.toFixed(1)}`} />}
                      </div>
                      {g.deadline && <div className="text-[10px] text-muted-foreground mt-1 font-mono">atteso a oggi: {expected.toFixed(1)}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Milestones */}
          {plan && totMs > 0 && (
            <div className="rounded-xl border border-border bg-surface2/30 p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Milestones</div>
                <span className="text-xs font-mono text-muted-foreground">{doneMs}/{totMs}</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface2/80 overflow-hidden mb-3">
                <div className="h-full rounded-full bg-emerald-400/80 transition-all duration-700" style={{ width: `${msPct}%` }} />
              </div>
              <div className="space-y-1">
                {plan.milestones.map((m) => (
                  <div key={m.id} className="text-sm flex items-center gap-2.5 px-2 py-1.5">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${m.status === 'done' ? 'bg-emerald-400' : m.status === 'in_progress' ? 'bg-amber-400' : 'bg-muted-foreground/40'}`} />
                    <span className={`flex-1 ${m.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{m.title}</span>
                    {m.due && <span className="text-[10px] text-muted-foreground font-mono shrink-0">{m.due}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Stato vergine: né piano né pending → si fa tutto da Telegram */}
          {!plan && !g.pending_plan && (
            <div className="rounded-xl border border-border bg-surface2/30 p-5 text-center">
              <Send size={18} className="text-accent mx-auto mb-2" />
              <div className="text-sm">Piano non ancora generato.</div>
              <div className="text-xs text-muted-foreground mt-1">Scrivi all'agente su Telegram — genererà piano e KPI da approvare.</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <DataTable<Goal>
        persistKey="goals"
        refreshKey={goals.length + goals.reduce((s, g) => s + (g.pending_plan ? 1 : 0), 0)}
        fetcher={async ({ q, page, pageSize, filters, sort }) => {
          let rows = goals;
          if (q) {
            const t = q.toLowerCase();
            rows = rows.filter((g) => g.title.toLowerCase().includes(t) || g.objective.toLowerCase().includes(t));
          }
          const st = filters.status ?? [];
          if (st.length) rows = rows.filter((g) => st.includes(g.status));
          if (sort) {
            const dir = sort.dir === 'asc' ? 1 : -1;
            rows = [...rows].sort((a: any, b: any) => {
              if (sort.key === 'deadline') return (new Date(a.deadline ?? '2999-01-01').getTime() - new Date(b.deadline ?? '2999-01-01').getTime()) * dir;
              if (sort.key === 'kpi') {
                const worst = (g: Goal) => Math.min(...(g.kpis ?? []).map((k) => pace(g, k).ratio ?? 99), 99);
                return (worst(a) - worst(b)) * dir;
              }
              return String(a[sort.key] ?? '').localeCompare(String(b[sort.key] ?? '')) * dir;
            });
          }
          return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), total: rows.length };
        }}
        columns={[
          { key: 'title', header: 'Obiettivo', sortable: true, width: 'w-[280px] max-w-[280px]', render: (g) => (
            <div className="min-w-0 max-w-[280px]">
              <div className="font-medium truncate">{g.title}</div>
              <div className="text-[11px] text-muted-foreground truncate">{g.objective}</div>
            </div>
          )},
          { key: 'status', header: 'Stato', width: 'w-24', sortable: true, render: (g) => <Chip tone={STATUS_CHIP[g.status].tone}>{STATUS_CHIP[g.status].label}</Chip> },
          { key: 'kpi', header: 'KPI', sortable: true, render: (g) => (
            <div className="flex flex-wrap gap-x-3 gap-y-0.5">
              {(g.kpis ?? []).length === 0 && <span className="text-xs text-muted-foreground">—</span>}
              {(g.kpis ?? []).map((k) => {
                const badge = paceBadge(pace(g, k).ratio);
                return (
                  <span key={k.id} className="text-xs whitespace-nowrap">
                    {k.name} <span className="font-mono">{k.current}/{k.target}</span> <span className={badge.cls}>{badge.label.split(' ')[0]}</span>
                  </span>
                );
              })}
            </div>
          )},
          { key: 'plan', header: 'Piano', width: 'w-32', render: (g) => {
            if (g.pending_plan) return <Chip tone="warn">da approvare</Chip>;
            if (!g.plan) return <span className="text-xs text-muted-foreground">—</span>;
            const done = g.plan.milestones.filter((m) => m.status === 'done').length;
            return <span className="text-xs font-mono">{done}/{g.plan.milestones.length} milestones</span>;
          }},
          { key: 'deadline', header: 'Deadline', width: 'w-28', sortable: true, render: (g) => (
            <span className="text-xs font-mono text-muted-foreground">{g.deadline ? new Date(g.deadline).toLocaleDateString('it-IT') : '—'}</span>
          )},
        ]}
        chipFilters={[
          {
            key: 'status',
            label: 'Stato',
            multi: true,
            options: [
              { value: 'active', label: 'attivi', tone: 'on' },
              { value: 'draft', label: 'bozze' },
              { value: 'paused', label: 'in pausa', tone: 'warn' },
              { value: 'done', label: 'completati', tone: 'on' },
            ],
          },
        ]}
        searchPlaceholder="Cerca obiettivo…"
        rowKey={(g) => g.id}
        onRowClick={(g) => nav(`/goals/${g.id}`)}
        emptyText='Nessun obiettivo. Scrivi all&apos;agente su Telegram ("voglio portare Logiqo a 10 clienti AMPERA entro Q3") — creerà piano e KPI da approvare.'
      />

      {/* Detail modal — read-only */}
      {openGoal && createPortal(
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setOpenId(null)}>
          <div className="max-w-xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <Card>
              <GoalDetail g={openGoal} onClose={() => setOpenId(null)} />
            </Card>
          </div>
        </div>,
        document.body,
      )}
    </Card>
  );
}
