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
import GoalGraph2D from '../components/GoalGraph2D';
import { Target, Sparkles, TrendingUp, CalendarDays, Bot, Send, Rocket, Clock, CheckCircle2, XCircle, Loader2, Plus, Pencil, Trash2, ChevronDown, ChevronRight, Layers, Pause, Play, X, ArrowLeft } from 'lucide-react';

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
  const [drawer, setDrawer] = useState<{ kind: 'agent' | 'kpi'; id: string } | null>(null);

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
      <div className="border border-border rounded-lg bg-surface2/50">
        <button className="w-full text-left p-2.5 flex items-start gap-2.5" onClick={() => setOpenAgent(isOpen ? null : a.id)}>
          <I size={14} className={`mt-0.5 shrink-0 ${a.status === 'running' ? 'animate-spin text-accent' : a.status === 'done' ? 'text-emerald-400' : a.status === 'error' ? 'text-red-400' : 'text-amber-300'}`} />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium truncate">{a.title}</div>
            <div className="flex items-center gap-2 mt-1">
              <Chip>{a.status}</Chip>
              <span className="text-[10px] text-muted-foreground font-mono">{new Date(when).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} {new Date(when).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
              {a.cost_usd != null && <span className="text-[10px] text-muted-foreground font-mono">${Number(a.cost_usd).toFixed(3)}</span>}
            </div>
          </div>
          <ChevronDown size={13} className={`mt-1 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (a.result || a.error) && (
          <div className="px-3 pb-3 text-[11px] whitespace-pre-wrap border-t border-border/60 pt-2.5 max-h-56 overflow-y-auto leading-relaxed">
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
      <div className={`relative border rounded-xl bg-surface2/40 p-4 overflow-hidden ${S.ring}`}>
        {/* area accent bar */}
        {hue != null && <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: `hsl(${hue},70%,55%)` }} />}
        <div className="flex items-start gap-3 pl-1.5">
          <button title="Cambia stato" onClick={() => cycleMs(m)} className={`mt-1 w-3.5 h-3.5 rounded-full shrink-0 ${S.dot} ring-2 ring-transparent hover:ring-foreground/20 hover:scale-110 transition`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1.5">
              {m.area && (
                <span className="text-[9px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full" style={{ background: `hsl(${hue},70%,55%,0.16)`, color: `hsl(${hue},75%,72%)`, border: `1px solid hsl(${hue},70%,55%,0.4)` }}>{m.area}</span>
              )}
              {m.due && <span className="text-[10px] text-muted-foreground font-mono inline-flex items-center gap-1"><CalendarDays size={10} />{m.due}</span>}
            </div>
            <div className={`text-sm font-medium leading-snug ${m.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>{m.title}</div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button title="Deploya agente" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-accent hover:bg-accent/10 transition" onClick={() => setDeployFor(m)}><Rocket size={14} /></button>
            <button title="Modifica" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface2 transition" onClick={() => setMsEdit(m)}><Pencil size={13} /></button>
            <button title="Elimina" className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition" onClick={() => delMs(m)}><Trash2 size={13} /></button>
          </div>
        </div>
        {(mAgents.length > 0 || mPending.length > 0) && (
          <div className="mt-3 space-y-1.5 pl-6">
            {mPending.map((p) => (
              <div key={`p${p.id}`} className="text-[11px] text-amber-300 flex items-start gap-1.5 rounded-lg bg-amber-500/10 border border-amber-400/20 px-2.5 py-1.5">
                <Clock size={12} className="mt-0.5 shrink-0" /><span>In attesa di ✅ su Telegram: {p.proposals.map((x) => x.title).join(', ')}</span>
              </div>
            ))}
            {mAgents.map((a) => <AgentRow key={a.id} a={a} />)}
          </div>
        )}
      </div>
    );
  }

  const daysLeft = goal.deadline ? Math.ceil((new Date(goal.deadline).getTime() - Date.now()) / 86_400_000) : null;

  const drawerAgent = drawer?.kind === 'agent' ? agents.find((a) => String(a.id) === drawer.id) ?? null : null;
  const drawerKpi = drawer?.kind === 'kpi' ? (goal.kpis ?? []).find((k) => k.id === drawer.id) ?? null : null;

  return (
    <div className={embedded ? 'relative w-full h-[82vh] overflow-hidden bg-[#0b0d14] rounded-xl' : 'relative -m-4 sm:-m-6 lg:-m-8 h-[calc(100dvh-3.5rem)] overflow-hidden bg-[#0b0d14]'}>
      {/* Full-bleed 2D graph — no cards, no borders */}
      <div className="absolute inset-0">
        <GoalGraph2D
          goalTitle={goal.title}
          kpis={(goal.kpis ?? []).map((k) => ({ id: k.id, name: k.name, unit: k.unit, target: k.target, current: k.current }))}
          milestones={(goal.plan?.milestones ?? []).map((m) => ({ id: m.id, title: m.title, area: m.area, status: m.status }))}
          agents={agents.map((a) => ({ id: a.id, title: a.title, status: a.status, milestoneId: a.milestone_id }))}
          storageKey={String(goalId)}
          onPick={(sel) => setDrawer(sel)}
        />
      </div>

      {/* Floating controls (no card chrome) */}
      <div className="absolute top-3 left-3 right-3 z-10 flex items-start gap-2 pointer-events-none">
        <button title={embedded ? 'Chiudi' : 'Torna alla Roadmap'} onClick={goBack} className="pointer-events-auto h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/60 backdrop-blur border border-white/10 text-foreground/80 hover:text-foreground hover:bg-bg/80 transition shrink-0">{embedded ? <X size={16} /> : <ArrowLeft size={16} />}</button>
        <div className="pointer-events-none min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gradient leading-tight truncate max-w-[50vw]">{goal.title}</h1>
            <Chip tone={STATUS_CHIP[goal.status]?.tone}>{STATUS_CHIP[goal.status]?.label ?? goal.status}</Chip>
          </div>
          {goal.pending_plan && <div className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-400/30 rounded-full px-2.5 py-0.5"><Sparkles size={11} /> Piano in attesa di ✅ Telegram</div>}
        </div>
        <div className="ml-auto flex items-center gap-2 pointer-events-auto shrink-0">
          {goal.status === 'active' && <button title="Pausa" onClick={() => setGoalStatus('paused')} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/60 backdrop-blur border border-white/10 text-foreground/80 hover:bg-bg/80 transition"><Pause size={15} /></button>}
          {goal.status === 'paused' && <button title="Riattiva" onClick={() => setGoalStatus('active')} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/60 backdrop-blur border border-white/10 text-foreground/80 hover:bg-bg/80 transition"><Play size={15} /></button>}
          <button title="Elimina obiettivo" onClick={delGoal} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/60 backdrop-blur border border-white/10 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition"><Trash2 size={15} /></button>
        </div>
      </div>

      {/* DRAWER — agente o KPI cliccato */}
      {drawer && (
          <div className="absolute top-0 right-0 bottom-0 z-30 w-full sm:w-[380px] bg-surface border-l border-border shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-200">
            <div className="sticky top-0 bg-surface/95 backdrop-blur border-b border-border px-4 py-3 flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold inline-flex items-center gap-1.5">{drawer.kind === 'agent' ? <><Bot size={13} /> Agente</> : <><TrendingUp size={13} /> KPI</>}</span>
              <button className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface2 transition" onClick={() => setDrawer(null)}><X size={15} /></button>
            </div>
            <div className="p-4">
              {drawerAgent && (
                <div>
                  <h3 className="font-semibold text-sm">{drawerAgent.title}</h3>
                  <div className="flex items-center gap-2 mt-2 mb-3 flex-wrap">
                    <Chip>{drawerAgent.status}</Chip>
                    {drawerAgent.cost_usd != null && <span className="text-[11px] text-muted-foreground font-mono">${Number(drawerAgent.cost_usd).toFixed(3)}</span>}
                    <span className="text-[11px] text-muted-foreground font-mono">{new Date(drawerAgent.ended_at ?? drawerAgent.started_at ?? drawerAgent.created_at).toLocaleString('it-IT')}</span>
                  </div>
                  {drawerAgent.brief && <div className="text-xs text-muted-foreground mb-3 italic">{drawerAgent.brief}</div>}
                  {(drawerAgent.result || drawerAgent.error)
                    ? <div className="text-xs whitespace-pre-wrap leading-relaxed border-t border-border/60 pt-3">{drawerAgent.error ? <span className="text-red-400">{drawerAgent.error}</span> : drawerAgent.result}</div>
                    : <div className="text-xs text-muted-foreground">Nessun risultato ancora.</div>}
                </div>
              )}
              {drawerKpi && (() => {
                const { expected, ratio } = pace(goal, drawerKpi);
                const badge = paceBadge(ratio);
                const pct = drawerKpi.target ? Math.min(100, Math.round((drawerKpi.current / drawerKpi.target) * 100)) : 0;
                const expectedPct = drawerKpi.target ? Math.min(100, Math.round((expected / drawerKpi.target) * 100)) : 0;
                return (
                  <div>
                    <h3 className="font-semibold text-sm">{drawerKpi.name}</h3>
                    <div className="flex items-end justify-between mt-2"><span className="text-3xl font-semibold tabular-nums">{drawerKpi.current}<span className="text-muted-foreground text-base font-normal">/{drawerKpi.target}{drawerKpi.unit ? ` ${drawerKpi.unit}` : ''}</span></span><span className={`text-xs font-medium ${badge.cls}`}>{badge.label}</span></div>
                    <div className="relative mt-3 h-2.5 rounded-full bg-surface2 overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))]" style={{ width: `${pct}%` }} />
                      {goal.deadline && <div className="absolute top-[-3px] bottom-[-3px] w-[2px] bg-foreground/70" style={{ left: `${expectedPct}%` }} />}
                    </div>
                    {goal.deadline && <div className="text-[11px] text-muted-foreground mt-2">atteso a oggi {expected.toFixed(1)}{drawerKpi.unit ? ` ${drawerKpi.unit}` : ''} · {pct}% del target</div>}
                    {(drawerKpi.history ?? []).length > 1 && <div className="mt-4"><div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Storico</div><MiniSpark points={(drawerKpi.history ?? []).map((h) => h.value)} /></div>}
                  </div>
                );
              })()}
            </div>
          </div>
      )}

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
