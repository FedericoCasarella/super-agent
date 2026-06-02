import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Map as MapIcon, Plus, Trash2, CheckCircle2, Circle, Pause, AlertOctagon, Clock, Target, BarChart3, Lightbulb, X, Edit3 } from 'lucide-react';

type Status = 'pending' | 'in_progress' | 'done' | 'blocked' | 'parked';
type Horizon = 'shortTerm' | 'midTerm' | 'longTerm';

type Todo = {
  id: string; title: string; description?: string; status: Status;
  priority?: 'low' | 'med' | 'high';
  due?: string | null; created_at: string; updated_at?: string | null; completed_at?: string | null;
};
type Kpi = { id: string; name: string; current: number; target: number; unit?: string; history?: { ts: string; value: number }[] };
type Strategy = { vision?: string; mission?: string; pillars?: string[]; bets?: { title: string; rationale?: string }[] };
type Roadmap = {
  version: number; updated_at: string;
  shortTerm: Todo[]; midTerm: Todo[]; longTerm: Todo[];
  strategy: Strategy; kpis: Kpi[]; log: { ts: string; text: string }[];
};

const HORIZON_META: Record<Horizon, { label: string; sub: string; color: string }> = {
  shortTerm: { label: 'Breve termine', sub: '~ 4 settimane', color: '#22d3ee' },
  midTerm:   { label: 'Medio termine', sub: '~ 3 mesi',     color: '#a78bfa' },
  longTerm:  { label: 'Lungo termine', sub: '~ 12 mesi',    color: '#f0abfc' },
};

const STATUS_META: Record<Status, { label: string; color: string; Icon: any }> = {
  pending:     { label: 'da fare',     color: '#94a3b8', Icon: Circle },
  in_progress: { label: 'in corso',    color: '#fbbf24', Icon: Clock },
  done:        { label: 'fatto',       color: '#34d399', Icon: CheckCircle2 },
  blocked:     { label: 'bloccato',    color: '#f87171', Icon: AlertOctagon },
  parked:      { label: 'parcheggiato',color: '#cbd5e1', Icon: Pause },
};

function nextStatus(s: Status): Status {
  const cycle: Status[] = ['pending', 'in_progress', 'done', 'blocked', 'parked'];
  return cycle[(cycle.indexOf(s) + 1) % cycle.length];
}

export default function RoadmapPage() {
  const [data, setData] = useState<Roadmap | null>(null);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ horizon: Horizon; todo: Todo } | null>(null);
  const [creating, setCreating] = useState<Horizon | null>(null);
  const [stratOpen, setStratOpen] = useState(false);
  const [kpiOpen, setKpiOpen] = useState<Kpi | null>(null);
  const toast = useToast();
  const dlg = useDialog();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([api.roadmapGet(), api.roadmapStats()]);
      setData(r); setStats(s);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  async function cycleStatus(h: Horizon, t: Todo) {
    try { await api.roadmapUpdateTodo(h, t.id, { status: nextStatus(t.status) }); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function del(h: Horizon, t: Todo) {
    if (!await dlg.confirm(`Eliminare "${t.title}"?`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
    try { await api.roadmapDeleteTodo(h, t.id); load(); } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function move(h: Horizon, t: Todo, to: Horizon) {
    try { await api.roadmapMoveTodo(t.id, h, to); load(); } catch (e: any) { toast.push(e.message, 'err'); }
  }

  if (!data) return <div className="p-6 text-muted">Caricamento…</div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <MapIcon className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">Roadmap</h1>
          <Chip>{data.shortTerm.length + data.midTerm.length + data.longTerm.length} todo</Chip>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>{loading ? '…' : '↻'}</Button>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {(stats.byHorizon as any[]).map((h) => {
            const M = HORIZON_META[h.horizon as Horizon];
            const pct = h.total > 0 ? Math.round((h.done / h.total) * 100) : 0;
            return (
              <Card key={h.horizon}>
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: M.color }} />
                  <div className="text-xs uppercase tracking-wider text-muted font-semibold">{M.label}</div>
                </div>
                <div className="text-2xl font-semibold">{h.done}<span className="text-muted text-base">/{h.total}</span></div>
                <div className="mt-2 h-1.5 rounded-full bg-surface2/80 overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: M.color }} />
                </div>
                <div className="text-[10px] text-muted mt-1 font-mono">{pct}% completato</div>
              </Card>
            );
          })}
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={14} className="text-emerald-300" />
              <div className="text-xs uppercase tracking-wider text-muted font-semibold">Burn-down 30g</div>
            </div>
            <Sparkline points={(stats.burndown as any[]).map((b) => b.count)} color="#34d399" />
            <div className="text-[10px] text-muted mt-1 font-mono">{(stats.burndown as any[]).reduce((s, b) => s + b.count, 0)} chiusi ultimi 30 gg</div>
          </Card>
        </div>
      )}

      {/* Strategy */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2"><Lightbulb size={16} className="text-amber-300" /><h2 className="text-base font-semibold">Strategia</h2></div>
          <Button variant="ghost" size="sm" onClick={() => setStratOpen(true)}><Edit3 size={12} className="inline mr-1 -mt-0.5" />Modifica</Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className="p-3 rounded-xl bg-surface2/40 border border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">Vision</div>
            <div className="whitespace-pre-wrap">{data.strategy.vision || <span className="text-muted">—</span>}</div>
          </div>
          <div className="p-3 rounded-xl bg-surface2/40 border border-border">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1 font-semibold">Mission</div>
            <div className="whitespace-pre-wrap">{data.strategy.mission || <span className="text-muted">—</span>}</div>
          </div>
        </div>
        {(data.strategy.pillars?.length ?? 0) > 0 && (
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-1.5 font-semibold">Pilastri</div>
            <div className="flex flex-wrap gap-1.5">
              {data.strategy.pillars!.map((p, i) => <Chip key={i} tone="accent">{p}</Chip>)}
            </div>
          </div>
        )}
      </Card>

      {/* Horizons */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {(['shortTerm', 'midTerm', 'longTerm'] as Horizon[]).map((h) => {
          const M = HORIZON_META[h];
          const list = data[h];
          return (
            <Card key={h}>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: M.color }} />
                    <div className="font-semibold">{M.label}</div>
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">{M.sub} · {list.length} todo</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCreating(h)}><Plus size={13} /></Button>
              </div>
              <div className="space-y-1.5 max-h-[55vh] overflow-y-auto pr-1">
                {list.length === 0 && <div className="text-xs text-muted py-3 text-center">Nessun todo.</div>}
                {list.map((t) => {
                  const S = STATUS_META[t.status] ?? STATUS_META.pending;
                  const I = S.Icon;
                  return (
                    <div key={t.id} className="group p-2 rounded-lg border border-border/60 bg-surface2/30 hover:bg-surface2/60 transition flex items-start gap-2">
                      <button onClick={() => cycleStatus(h, t)} title={S.label} className="mt-0.5 shrink-0 hover:scale-110 transition" style={{ color: S.color }}>
                        <I size={16} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm ${t.status === 'done' ? 'line-through text-muted' : ''}`}>{t.title}</div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full font-semibold" style={{ background: S.color + '22', color: S.color, border: `1px solid ${S.color}55` }}>{S.label}</span>
                          {t.priority && t.priority !== 'low' && <span className={`text-[9px] uppercase px-1.5 py-0.5 rounded-full ${t.priority === 'high' ? 'bg-red-500/15 text-red-300 border border-red-400/30' : 'bg-amber-500/15 text-amber-300 border border-amber-400/30'}`}>{t.priority}</span>}
                          {t.due && <span className="text-[9px] text-muted font-mono">📅 {t.due}</span>}
                        </div>
                        {t.description && <div className="text-xs text-muted mt-1 line-clamp-2">{t.description}</div>}
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 transition flex flex-col gap-0.5">
                        <button onClick={() => setEditing({ horizon: h, todo: t })} className="text-muted hover:text-accent p-0.5"><Edit3 size={11} /></button>
                        <button onClick={() => del(h, t)} className="text-muted hover:text-red-300 p-0.5"><Trash2 size={11} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>

      {/* KPIs */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2"><Target size={16} className="text-cyan-300" /><h2 className="text-base font-semibold">KPI</h2></div>
          <Button size="sm" variant="ghost" onClick={() => setKpiOpen({ id: '', name: '', current: 0, target: 0 })}><Plus size={13} className="inline mr-1 -mt-0.5" />KPI</Button>
        </div>
        {data.kpis.length === 0 ? (
          <div className="text-xs text-muted py-3 text-center">Nessun KPI ancora. Aggiungine uno per tracciare metriche.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.kpis.map((k) => {
              const pct = k.target > 0 ? Math.min(100, Math.round((k.current / k.target) * 100)) : 0;
              const tone = pct >= 90 ? '#34d399' : pct >= 50 ? '#fbbf24' : '#f87171';
              return (
                <div key={k.id} className="p-3 rounded-xl bg-surface2/40 border border-border cursor-pointer hover:border-accent/30" onClick={() => setKpiOpen(k)}>
                  <div className="text-xs text-muted uppercase tracking-wider font-semibold">{k.name || 'kpi'}</div>
                  <div className="text-xl font-semibold mt-1">{k.current}<span className="text-muted text-sm">/{k.target}{k.unit ? ` ${k.unit}` : ''}</span></div>
                  <div className="mt-2 h-1.5 rounded-full bg-surface/80 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: tone }} />
                  </div>
                  {(k.history?.length ?? 0) > 1 && (
                    <div className="mt-2"><Sparkline points={(k.history ?? []).map((h) => h.value)} color={tone} small /></div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Activity log */}
      {data.log.length > 0 && (
        <Card>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold">Activity log</h2>
            <span className="text-[10px] text-muted font-mono">{data.log.length}</span>
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto text-xs">
            {data.log.slice(-50).reverse().map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-muted">
                <span className="font-mono shrink-0">{new Date(e.ts).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="flex-1">{e.text}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {creating && <TodoModal mode="create" horizon={creating} onClose={() => setCreating(null)} onSaved={() => { setCreating(null); load(); }} />}
      {editing && <TodoModal mode="edit" horizon={editing.horizon} initial={editing.todo} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onMove={(to) => move(editing.horizon, editing.todo, to)} />}
      {stratOpen && <StrategyModal strategy={data.strategy} onClose={() => setStratOpen(false)} onSaved={() => { setStratOpen(false); load(); }} />}
      {kpiOpen && <KpiModal initial={kpiOpen} onClose={() => setKpiOpen(null)} onSaved={() => { setKpiOpen(null); load(); }} />}
    </div>
  );
}

function Sparkline({ points, color, small }: { points: number[]; color: string; small?: boolean }) {
  if (points.length < 2) return <div className="text-[10px] text-muted">—</div>;
  const w = small ? 120 : 180, h = small ? 24 : 36;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = w / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${h - ((p - min) / range) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="block">
      <path d={d} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <path d={`${d} L ${w} ${h} L 0 ${h} Z`} fill={color + '22'} />
    </svg>
  );
}

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: any; footer?: any }) {
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="font-semibold text-sm">{title}</div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface2 text-muted hover:text-text"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto p-5 flex-1 space-y-3">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function TodoModal({ mode, horizon, initial, onClose, onSaved, onMove }: { mode: 'create' | 'edit'; horizon: Horizon; initial?: Todo; onClose: () => void; onSaved: () => void; onMove?: (to: Horizon) => void }) {
  const [t, setT] = useState<Partial<Todo>>(initial ?? { title: '', status: 'pending', priority: 'med' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    if (!t.title?.trim()) { toast.push('Titolo obbligatorio', 'err'); return; }
    setBusy(true);
    try {
      if (mode === 'create') await api.roadmapAddTodo(horizon, t);
      else await api.roadmapUpdateTodo(horizon, t.id!, t);
      toast.push('Salvato', 'on'); onSaved();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title={mode === 'create' ? `Nuovo todo · ${HORIZON_META[horizon].label}` : 'Modifica todo'} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Annulla</Button>
      <Button onClick={save} disabled={busy}>{busy ? '…' : 'Salva'}</Button>
    </>}>
      <Field label="Titolo"><Input value={t.title ?? ''} onChange={(e) => setT({ ...t, title: e.target.value })} autoFocus /></Field>
      <Field label="Descrizione">
        <textarea value={t.description ?? ''} onChange={(e) => setT({ ...t, description: e.target.value })} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[80px]" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Stato">
          <select value={t.status ?? 'pending'} onChange={(e) => setT({ ...t, status: e.target.value as Status })} className="w-full bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm">
            {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Priorità">
          <select value={t.priority ?? 'med'} onChange={(e) => setT({ ...t, priority: e.target.value as any })} className="w-full bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm">
            <option value="low">low</option>
            <option value="med">med</option>
            <option value="high">high</option>
          </select>
        </Field>
      </div>
      <Field label="Scadenza"><Input type="date" value={t.due ?? ''} onChange={(e) => setT({ ...t, due: e.target.value || null })} /></Field>
      {mode === 'edit' && onMove && (
        <Field label="Sposta in">
          <div className="flex gap-1">
            {(['shortTerm', 'midTerm', 'longTerm'] as Horizon[]).filter((h) => h !== horizon).map((h) => (
              <Button key={h} size="sm" variant="ghost" onClick={() => { onMove(h); onClose(); }}>{HORIZON_META[h].label}</Button>
            ))}
          </div>
        </Field>
      )}
    </Modal>
  );
}

function StrategyModal({ strategy, onClose, onSaved }: { strategy: Strategy; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState<Strategy>(strategy);
  const [pillarsText, setPillarsText] = useState((strategy.pillars ?? []).join('\n'));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function save() {
    setBusy(true);
    try {
      const pillars = pillarsText.split('\n').map((p) => p.trim()).filter(Boolean);
      await api.roadmapSetStrategy({ ...s, pillars });
      toast.push('Strategia salvata', 'on'); onSaved();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBusy(false); }
  }
  return (
    <Modal title="Strategia" onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>Annulla</Button>
      <Button onClick={save} disabled={busy}>{busy ? '…' : 'Salva'}</Button>
    </>}>
      <Field label="Vision (dove vuoi arrivare)"><textarea value={s.vision ?? ''} onChange={(e) => setS({ ...s, vision: e.target.value })} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[80px]" /></Field>
      <Field label="Mission (come ci arrivi)"><textarea value={s.mission ?? ''} onChange={(e) => setS({ ...s, mission: e.target.value })} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[80px]" /></Field>
      <Field label="Pilastri (uno per riga)"><textarea value={pillarsText} onChange={(e) => setPillarsText(e.target.value)} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[80px]" placeholder="Eccellenza prodotto&#10;Crescita organica&#10;Brand premium" /></Field>
    </Modal>
  );
}

function KpiModal({ initial, onClose, onSaved }: { initial: Kpi; onClose: () => void; onSaved: () => void }) {
  const [k, setK] = useState<Partial<Kpi>>(initial);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const dlg = useDialog();
  async function save() {
    if (!k.name?.trim()) { toast.push('Nome obbligatorio', 'err'); return; }
    setBusy(true);
    try { await api.roadmapUpsertKpi(k); toast.push('KPI salvato', 'on'); onSaved(); }
    catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!k.id) return;
    if (!await dlg.confirm(`Eliminare KPI "${k.name}"?`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
    try { await api.roadmapDeleteKpi(k.id); onSaved(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  return (
    <Modal title={k.id ? `KPI: ${k.name || '—'}` : 'Nuovo KPI'} onClose={onClose} footer={<>
      {k.id && <Button variant="danger" onClick={del}><Trash2 size={12} className="inline mr-1 -mt-0.5" />Elimina</Button>}
      <Button variant="ghost" onClick={onClose}>Annulla</Button>
      <Button onClick={save} disabled={busy}>{busy ? '…' : 'Salva'}</Button>
    </>}>
      <Field label="Nome"><Input value={k.name ?? ''} onChange={(e) => setK({ ...k, name: e.target.value })} placeholder="es. MRR" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Valore corrente"><Input type="number" value={k.current ?? 0} onChange={(e) => setK({ ...k, current: Number(e.target.value) })} /></Field>
        <Field label="Target"><Input type="number" value={k.target ?? 0} onChange={(e) => setK({ ...k, target: Number(e.target.value) })} /></Field>
      </div>
      <Field label="Unità (opzionale)"><Input value={k.unit ?? ''} onChange={(e) => setK({ ...k, unit: e.target.value })} placeholder="€ / utenti / %" /></Field>
    </Modal>
  );
}
