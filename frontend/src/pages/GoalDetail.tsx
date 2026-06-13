// Pagina obiettivo — /goals/:id. Cockpit interattivo del goal:
// KPI con pace, e una ROADMAP ESECUTIVA delle milestone raggruppate per
// AREA (HR, Operativo, Marketing…) e ordinate in sequenza (stesso order =
// parallele). Ogni milestone è modificabile/eliminabile, mostra gli AGENTI
// che ci lavorano sotto (stato/costo/risultato) e ha un bottone per deployare
// un agente che la porta a termine (passa da approvazione Telegram).
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useSetBreadcrumb } from '../components/Breadcrumbs';
import { Target, Sparkles, TrendingUp, CalendarDays, Bot, Send, Rocket, Clock, CheckCircle2, XCircle, Loader2, Plus, Pencil, Trash2, ChevronDown, ChevronRight, Layers, Pause, Play } from 'lucide-react';

type GoalKpi = { id: string; name: string; unit?: string; target: number; current: number; history: { ts: string; value: number }[] };
type Milestone = { id: string; title: string; due?: string; status: 'pending' | 'in_progress' | 'done'; area?: string; order?: number };
type Plan = { milestones: Milestone[]; next_actions: { title: string; brief: string }[]; kpis?: any[]; notes?: string };
type Goal = {
  id: number; title: string; objective: string; deadline: string | null;
  status: string; kpis: GoalKpi[]; plan: Plan | null; pending_plan: Plan | null;
  last_review_at: string | null; created_at: string;
};
type SubAgent = { id: number; title: string; brief: string | null; status: string; cost_usd: number | null; created_at: string; started_at: string | null; ended_at: string | null; goal_id: number | null; milestone_id: string | null; result: string; error: string | null };
type Proposal = { id: number; title: string; proposals: { title: string; brief: string }[]; status: string; milestone_id: string | null; created_at: string };

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
function MiniSpark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 90, h = 24;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ');
  return <svg width={w} height={h} className="opacity-80"><path d={path} fill="none" stroke="#34d399" strokeWidth="1.5" /></svg>;
}
function areaHue(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
const MS_STATUS: Record<Milestone['status'], { dot: string; ring: string }> = {
  pending: { dot: 'bg-muted-foreground/40', ring: 'border-border' },
  in_progress: { dot: 'bg-amber-400', ring: 'border-amber-400/40' },
  done: { dot: 'bg-emerald-400', ring: 'border-emerald-400/40' },
};
const AGENT_ICON: Record<string, any> = { pending: Clock, running: Loader2, done: CheckCircle2, error: XCircle, cancelled: XCircle };
const STATUS_CHIP: Record<string, { label: string; tone?: any }> = {
  draft: { label: 'bozza' }, active: { label: 'attivo', tone: 'on' }, paused: { label: 'in pausa', tone: 'warn' },
  done: { label: 'completato', tone: 'on' }, archived: { label: 'archiviato' },
};

// Usabile sia come pagina /goals/:id sia EMBEDDED in un dialog (es. dal grafo
// brain). In modalità embedded passa `goalId` + `onClose`: salta breadcrumb e
// usa la X invece del back a /roadmap.
export default function GoalDetailPage({ goalId: goalIdProp, embedded, onClose }: { goalId?: number; embedded?: boolean; onClose?: () => void } = {}) {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const dlg = useDialog();
  const goalId = goalIdProp ?? Number(id);
  const [goal, setGoal] = useState<Goal | null>(null);
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [openAgent, setOpenAgent] = useState<number | null>(null);
  const [msEdit, setMsEdit] = useState<Milestone | 'new' | null>(null);
  const [deployFor, setDeployFor] = useState<Milestone | null>(null);

  useSetBreadcrumb(!embedded && goal ? [{ label: 'Roadmap', to: '/roadmap' }, { label: goal.title }] : null);
  const goBack = () => { if (onClose) onClose(); else nav('/roadmap'); };

  async function load() {
    try {
      const [g, ex] = await Promise.all([api.goalsList(), api.goalExecution(goalId)]);
      setGoal(g.rows.find((x: Goal) => x.id === goalId) ?? null);
      setAgents(ex.agents);
      setProposals(ex.proposals);
    } catch {}
  }
  useEffect(() => { load(); const iv = setInterval(load, 20_000); return () => clearInterval(iv); /* eslint-disable-next-line */ }, [goalId]);

  if (!goal) return <div className="text-sm text-muted-foreground py-10 text-center">Caricamento obiettivo…</div>;

  const plan = goal.plan;
  const milestones = (plan?.milestones ?? []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const doneMs = milestones.filter((m) => m.status === 'done').length;
  const totMs = milestones.length;
  const overallPct = totMs > 0 ? Math.round((doneMs / totMs) * 100) : 0;
  const totalCost = agents.reduce((s, a) => s + Number(a.cost_usd ?? 0), 0);

  // Raggruppa milestone per order-level (sequenza); più milestone con lo stesso
  // order = parallele → render affiancato.
  const levels = new Map<number, Milestone[]>();
  for (const m of milestones) {
    const o = m.order ?? 0;
    levels.set(o, [...(levels.get(o) ?? []), m]);
  }
  const orderedLevels = [...levels.entries()].sort((a, b) => a[0] - b[0]);

  const agentsForMs = (mid: string) => agents.filter((a) => a.milestone_id === mid);
  const pendingForMs = (mid: string) => proposals.filter((p) => p.status === 'pending' && p.milestone_id === mid);
  const generalAgents = agents.filter((a) => !a.milestone_id);

  async function cycleMs(m: Milestone) {
    const next = m.status === 'pending' ? 'in_progress' : m.status === 'in_progress' ? 'done' : 'pending';
    try { await api.goalMilestoneUpdate(goalId, m.id, { status: next }); await load(); } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
  }
  async function delMs(m: Milestone) {
    if (!await dlg.confirm(`Eliminare la milestone "${m.title}"?`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
    try { await api.goalMilestoneDelete(goalId, m.id); await load(); } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
  }
  async function delGoal() {
    if (!await dlg.confirm(`Eliminare l'obiettivo "${goal!.title}"? Irreversibile.`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
    try { await api.goalDelete(goalId); goBack(); } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
  }
  async function setGoalStatus(status: string) {
    try { await api.goalUpdate(goalId, { status }); await load(); } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
  }

  function AgentRow({ a }: { a: SubAgent }) {
    const I = AGENT_ICON[a.status] ?? Clock;
    const isOpen = openAgent === a.id;
    const when = a.ended_at ?? a.started_at ?? a.created_at;
    return (
      <div className="border border-border rounded-lg bg-surface2/40">
        <button className="w-full text-left p-2 flex items-start gap-2" onClick={() => setOpenAgent(isOpen ? null : a.id)}>
          <I size={13} className={`mt-0.5 shrink-0 ${a.status === 'running' ? 'animate-spin text-accent' : a.status === 'done' ? 'text-emerald-400' : a.status === 'error' ? 'text-red-400' : 'text-amber-300'}`} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{a.title}</div>
            <div className="flex items-center gap-2 mt-0.5">
              <Chip>{a.status}</Chip>
              <span className="text-[10px] text-muted-foreground font-mono">{new Date(when).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} {new Date(when).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
              {a.cost_usd != null && <span className="text-[10px] text-muted-foreground font-mono">${Number(a.cost_usd).toFixed(3)}</span>}
            </div>
          </div>
        </button>
        {isOpen && (a.result || a.error) && (
          <div className="px-2.5 pb-2.5 text-[11px] whitespace-pre-wrap border-t border-border/60 pt-2 max-h-56 overflow-y-auto">
            {a.error ? <span className="text-red-400">{a.error}</span> : a.result}
          </div>
        )}
      </div>
    );
  }

  function MsCard({ m }: { m: Milestone }) {
    const S = MS_STATUS[m.status];
    const mAgents = agentsForMs(m.id);
    const mPending = pendingForMs(m.id);
    const hue = m.area ? areaHue(m.area) : null;
    return (
      <div className={`border rounded-xl bg-surface2/30 p-3 ${S.ring}`}>
        <div className="flex items-start gap-2.5">
          <button title="Cambia stato" onClick={() => cycleMs(m)} className={`mt-1 w-3 h-3 rounded-full shrink-0 ${S.dot} hover:scale-125 transition`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {m.area && (
                <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full" style={{ background: `hsl(${hue},70%,55%,0.16)`, color: `hsl(${hue},75%,72%)`, border: `1px solid hsl(${hue},70%,55%,0.4)` }}>{m.area}</span>
              )}
              {m.due && <span className="text-[10px] text-muted-foreground font-mono">📅 {m.due}</span>}
            </div>
            <div className={`text-sm mt-1 ${m.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{m.title}</div>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button title="Deploya agente" className="p-1 text-muted-foreground hover:text-accent" onClick={() => setDeployFor(m)}><Rocket size={13} /></button>
            <button title="Modifica" className="p-1 text-muted-foreground hover:text-foreground" onClick={() => setMsEdit(m)}><Pencil size={12} /></button>
            <button title="Elimina" className="p-1 text-muted-foreground hover:text-destructive" onClick={() => delMs(m)}><Trash2 size={12} /></button>
          </div>
        </div>
        {(mAgents.length > 0 || mPending.length > 0) && (
          <div className="mt-2.5 space-y-1.5 pl-5">
            {mPending.map((p) => (
              <div key={`p${p.id}`} className="text-[11px] text-amber-300 flex items-center gap-1.5">
                <Clock size={11} /> in attesa di ✅ Telegram: {p.proposals.map((x) => x.title).join(', ')}
              </div>
            ))}
            {mAgents.map((a) => <AgentRow key={a.id} a={a} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Target size={20} className="text-accent shrink-0" />
            <h1 className="text-2xl font-semibold text-gradient">{goal.title}</h1>
            <Chip tone={STATUS_CHIP[goal.status]?.tone}>{STATUS_CHIP[goal.status]?.label ?? goal.status}</Chip>
          </div>
          <div className="text-sm text-muted-foreground mt-1">{goal.objective}</div>
        </div>
        <div className="flex items-center gap-1">
          {goal.status === 'active' && <Button size="sm" variant="ghost" onClick={() => setGoalStatus('paused')}><Pause size={13} className="inline mr-1 -mt-0.5" />Pausa</Button>}
          {goal.status === 'paused' && <Button size="sm" variant="ghost" onClick={() => setGoalStatus('active')}><Play size={13} className="inline mr-1 -mt-0.5" />Riattiva</Button>}
          <button title="Elimina obiettivo" className="p-2 text-muted-foreground hover:text-destructive" onClick={delGoal}><Trash2 size={15} /></button>
          <Button size="sm" variant="ghost" onClick={goBack}>{embedded ? '✕' : '← Roadmap'}</Button>
        </div>
      </div>

      {/* Meta pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {goal.deadline && (() => {
          const daysLeft = Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86_400_000);
          const tone = daysLeft < 0 ? 'text-red-400 border-red-400/30 bg-red-500/10' : daysLeft <= 14 ? 'text-amber-300 border-amber-400/30 bg-amber-500/10' : 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10';
          return (
            <span className={`inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-lg border ${tone}`}>
              <CalendarDays size={14} />
              <span className="leading-tight">
                <span className="block text-[9px] uppercase tracking-wider opacity-70 font-semibold">Deadline</span>
                <span className="text-xs font-semibold">{new Date(goal.deadline).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}<span className="opacity-70 font-normal"> · {daysLeft < 0 ? `scaduta da ${-daysLeft}g` : `${daysLeft}g`}</span></span>
              </span>
            </span>
          );
        })()}
        <span className="inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-lg border border-border bg-surface2/40 text-muted-foreground">
          <Bot size={14} className="text-accent" />
          <span className="leading-tight"><span className="block text-[9px] uppercase tracking-wider opacity-70 font-semibold">Review steward</span><span className="text-xs font-semibold text-foreground/90">{goal.last_review_at ? `ultima ${new Date(goal.last_review_at).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}` : 'venerdì 17:00'}</span></span>
        </span>
        <span className="inline-flex items-center gap-2 pl-2.5 pr-3 py-1.5 rounded-lg border border-border bg-surface2/40 text-muted-foreground">
          <Rocket size={14} className="text-accent" />
          <span className="leading-tight"><span className="block text-[9px] uppercase tracking-wider opacity-70 font-semibold">Agenti</span><span className="text-xs font-semibold text-foreground/90">{agents.length} attivi{totalCost > 0 ? ` · $${totalCost.toFixed(2)}` : ''}</span></span>
        </span>
      </div>

      {/* KPI */}
      {(goal.kpis ?? []).length > 0 && (
        <Card>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5 mb-3"><TrendingUp size={12} /> Metriche</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(goal.kpis ?? []).map((k) => {
              const { expected, ratio } = pace(goal, k);
              const badge = paceBadge(ratio);
              const pct = k.target ? Math.min(100, Math.round((k.current / k.target) * 100)) : 0;
              const expectedPct = k.target ? Math.min(100, Math.round((expected / k.target) * 100)) : 0;
              return (
                <div key={k.id}>
                  <div className="flex items-center justify-between"><span className="text-sm">{k.name}</span><span className={`text-xs ${badge.cls}`}>{badge.label}</span></div>
                  <div className="flex items-end justify-between mt-1"><span className="text-xl font-semibold">{k.current}<span className="text-muted-foreground text-sm">/{k.target}{k.unit ? ` ${k.unit}` : ''}</span></span><MiniSpark points={(k.history ?? []).map((h) => h.value)} /></div>
                  <div className="relative mt-2 h-2 rounded-full bg-surface2/80 overflow-hidden">
                    <div className="h-full rounded-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))]" style={{ width: `${pct}%` }} />
                    {goal.deadline && <div className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-foreground/70" style={{ left: `${expectedPct}%` }} title={`Atteso: ${expected.toFixed(1)}`} />}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Piano in attesa */}
      {goal.pending_plan && (
        <Card className="border-accent/40 bg-accent/5">
          <div className="text-sm font-semibold flex items-center gap-1.5 mb-2"><Sparkles size={14} className="text-accent" /> Piano proposto — approvalo da Telegram</div>
          <div className="space-y-1">{goal.pending_plan.milestones.map((m, i) => <div key={m.id} className="text-xs flex items-center gap-2"><span className="w-4 h-4 rounded-full bg-accent/15 text-accent flex items-center justify-center text-[9px] font-semibold shrink-0">{i + 1}</span><span className="flex-1">{m.title}</span></div>)}</div>
        </Card>
      )}

      {/* ROADMAP ESECUTIVA */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1.5"><Layers size={12} /> Roadmap esecutiva</div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-muted-foreground">{doneMs}/{totMs} · {overallPct}%</span>
            <Button size="sm" variant="ghost" onClick={() => setMsEdit('new')}><Plus size={13} className="inline mr-1 -mt-0.5" />Milestone</Button>
          </div>
        </div>
        <div className="h-1.5 rounded-full bg-surface2/80 overflow-hidden mb-4">
          <div className="h-full rounded-full bg-emerald-400/80 transition-all duration-700" style={{ width: `${overallPct}%` }} />
        </div>

        {totMs === 0 && <div className="text-xs text-muted-foreground py-4 text-center">Nessuna milestone. Aggiungine una o fai generare il piano all'agente da Telegram.</div>}

        <div className="space-y-3">
          {orderedLevels.map(([order, ms], li) => {
            const levelDone = ms.filter((m) => m.status === 'done').length;
            const levelPct = Math.round((levelDone / ms.length) * 100);
            const parallel = ms.length > 1;
            return (
              <div key={order} className="relative pl-6">
                {/* timeline spine */}
                <div className="absolute left-2 top-1 bottom-0 w-px bg-border" />
                <div className="absolute left-[3px] top-1 w-3.5 h-3.5 rounded-full bg-surface2 border-2 border-accent/60 flex items-center justify-center text-[8px] font-bold text-accent">{li + 1}</div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{parallel ? `Step ${li + 1} · ${ms.length} in parallelo` : `Step ${li + 1}`}</span>
                  {parallel && <span className="text-[10px] font-mono text-muted-foreground">{levelDone}/{ms.length} · {levelPct}%</span>}
                </div>
                <div className={parallel ? 'grid grid-cols-1 md:grid-cols-2 gap-2' : ''}>
                  {ms.map((m) => <MsCard key={m.id} m={m} />)}
                </div>
              </div>
            );
          })}
        </div>

        {/* Agenti non legati a una milestone */}
        {generalAgents.length > 0 && (
          <div className="mt-4 pt-3 border-t border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Agenti generali (non legati a milestone)</div>
            <div className="space-y-1.5">{generalAgents.map((a) => <AgentRow key={a.id} a={a} />)}</div>
          </div>
        )}
      </Card>

      {msEdit && <MilestoneDialog goalId={goalId} milestone={msEdit === 'new' ? null : msEdit} onClose={() => setMsEdit(null)} onSaved={() => { setMsEdit(null); load(); }} />}
      {deployFor && <DeployDialog goalId={goalId} milestone={deployFor} onClose={() => setDeployFor(null)} onSent={() => { setDeployFor(null); load(); }} />}
    </div>
  );
}

function MilestoneDialog({ goalId, milestone, onClose, onSaved }: { goalId: number; milestone: Milestone | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(milestone?.title ?? '');
  const [due, setDue] = useState(milestone?.due ?? '');
  const [area, setArea] = useState(milestone?.area ?? '');
  const [order, setOrder] = useState(String(milestone?.order ?? ''));
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const ord = order === '' ? undefined : Number(order);
      if (milestone) await api.goalMilestoneUpdate(goalId, milestone.id, { title: title.trim(), due: due || null, area: area || null, order: ord });
      else await api.goalMilestoneAdd(goalId, { title: title.trim(), due: due || undefined, area: area || undefined, order: ord });
      onSaved();
    } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); } finally { setBusy(false); }
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <Card className="max-w-md w-full" onClick={(e: any) => e.stopPropagation()}>
        <h3 className="font-semibold mb-3">{milestone ? 'Modifica milestone' : 'Nuova milestone'}</h3>
        <div className="space-y-3">
          <Field label="Titolo"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Primo cliente Track A firmato" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Area"><Input value={area} onChange={(e) => setArea(e.target.value)} placeholder="Vendite" /></Field>
            <Field label="Scadenza"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            <Field label="Step (order)"><Input type="number" value={order} onChange={(e) => setOrder(e.target.value)} placeholder="0" /></Field>
          </div>
          <div className="text-[10px] text-muted-foreground">Milestone con lo stesso <b>step</b> sono parallele; step crescente = in sequenza.</div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Annulla</Button>
            <Button size="sm" disabled={!title.trim() || busy} onClick={save}>{busy ? <Loader2 size={12} className="inline animate-spin mr-1" /> : null}Salva</Button>
          </div>
        </div>
      </Card>
    </div>,
    document.body,
  );
}

function DeployDialog({ goalId, milestone, onClose, onSent }: { goalId: number; milestone: Milestone; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  async function deploy() {
    if (!instruction.trim()) return;
    setBusy(true);
    try {
      const r = await api.goalMilestoneDeploy(goalId, milestone.id, instruction.trim());
      if (!r.ok) throw new Error(r.error || 'deploy fallito');
      toast.push('Agente proposto — approvalo su Telegram (✅/❌)', 'on');
      onSent();
    } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); } finally { setBusy(false); }
  }
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <Card className="max-w-md w-full" onClick={(e: any) => e.stopPropagation()}>
        <h3 className="font-semibold mb-1 flex items-center gap-2"><Rocket size={15} className="text-accent" /> Deploya agente</h3>
        <div className="text-xs text-muted-foreground mb-3">Milestone: <span className="text-foreground">{milestone.title}</span></div>
        <div className="space-y-3">
          <Field label="Cosa deve fare l'agente">
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} autoFocus
              placeholder="Es: contatta Mattia su WhatsApp, chiarisci chi fa il setting dei lead, riportami l'esito e scrivilo nel brain"
              className="w-full h-24 text-sm bg-surface2/60 border border-border rounded-lg p-2 resize-none focus:outline-none focus:border-primary/60" />
          </Field>
          <div className="text-[10px] text-muted-foreground">L'agente riporterà a te e scriverà l'esito nel brain. Parte solo dopo la tua ✅ su Telegram.</div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Annulla</Button>
            <Button size="sm" disabled={!instruction.trim() || busy} onClick={deploy}>{busy ? <Loader2 size={12} className="inline animate-spin mr-1" /> : <Send size={12} className="inline mr-1 -mt-0.5" />}Proponi su Telegram</Button>
          </div>
        </div>
      </Card>
    </div>,
    document.body,
  );
}
