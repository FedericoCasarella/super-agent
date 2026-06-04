import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, Toggle, useToast } from '../components/ui';
import SearchSelect from '../components/SearchSelect';
import { fetchClaudeModels, fetchCustomAgents, fetchEmailAccounts, fetchPerks, fetchScheduledTasks, fetchTeams, fetchWaChats, fetchIgThreads } from '../components/searchSources';
import VariableTextarea from '../components/VariableTextarea';
import { varsForTriggers, type VarDef } from '../components/flowVariables';
import { useWS } from '../ws';
import { ArrowLeft, Bell, Bot, ClipboardList, Mail, MessageCircle, MessageSquare, Mic, Plus, Save, Trash2, Workflow, Play, Settings as Cog, Brain, ListChecks, Sparkles, Users as UsersIcon, Globe, Clock, X, Camera as IgIcon } from 'lucide-react';

type Trigger = { type: string; config: any };
type Step = { type: string; name?: string | null; config: any };
type Flow = { id: number; name: string; description: string | null; enabled: boolean; triggers: Trigger[]; steps: Step[] };

const TRIGGER_TYPES: { type: string; label: string; icon: any; color: string }[] = [
  { type: 'whatsapp.received',  label: 'WhatsApp ricevuto',     icon: MessageCircle,  color: '#25D366' },
  { type: 'instagram.received', label: 'Instagram DM ricevuto', icon: IgIcon,         color: '#E1306C' },
  { type: 'telegram.received',  label: 'Telegram ricevuto',     icon: MessageSquare,  color: '#26A5E4' },
  { type: 'email.received',     label: 'Email ricevuta',        icon: Mail,           color: '#EA4335' },
  { type: 'voice.received',     label: 'Voce ricevuta',         icon: Mic,            color: '#a78bfa' },
  { type: 'schedule.datetime',  label: 'Data/ora specifica',    icon: Clock,          color: '#fbbf24' },
  { type: 'schedule.cron',      label: 'Ricorrenza (cron)',     icon: Clock,          color: '#fbbf24' },
  { type: 'agent.finished',     label: 'Agente termina',        icon: Bot,            color: '#22d3ee' },
  { type: 'brain.node_added',   label: 'Nodo brain aggiunto',   icon: Brain,          color: '#a78bfa' },
  { type: 'task.triggered',     label: 'Task schedulato fire',  icon: ListChecks,     color: '#34d399' },
  { type: 'perk.fired',         label: 'Perk attivato',         icon: Sparkles,       color: '#f0abfc' },
  { type: 'team.fired',         label: 'Team attivato',         icon: UsersIcon,      color: '#c084fc' },
];

const STEP_TYPES: { type: string; label: string; icon: any; color: string }[] = [
  { type: 'agent.run',        label: 'Attiva agente con prompt',  icon: Bot,            color: '#22d3ee' },
  { type: 'telegram.notify',  label: 'Notifica Telegram',         icon: Bell,           color: '#26A5E4' },
  { type: 'team.run',         label: 'Attiva team',               icon: UsersIcon,      color: '#c084fc' },
  { type: 'email.send',       label: 'Invia email',               icon: Mail,           color: '#EA4335' },
  { type: 'whatsapp.send',    label: 'Invia WhatsApp',            icon: MessageCircle,  color: '#25D366' },
  { type: 'instagram.send',   label: 'Invia Instagram DM',        icon: IgIcon,         color: '#E1306C' },
  { type: 'brain.write_note', label: 'Scrivi nota nel brain',     icon: Brain,          color: '#a78bfa' },
  { type: 'delay',            label: 'Attesa (ms)',               icon: Clock,          color: '#fbbf24' },
  { type: 'webhook',          label: 'Webhook HTTP',              icon: Globe,          color: '#94a3b8' },
  { type: 'condition',        label: 'Condizione',                icon: ClipboardList,  color: '#f0abfc' },
];

function tMeta(t: string) { return TRIGGER_TYPES.find((x) => x.type === t) ?? { type: t, label: t, icon: Workflow, color: '#888' }; }
function sMeta(t: string) { return STEP_TYPES.find((x) => x.type === t) ?? { type: t, label: t, icon: Cog, color: '#888' }; }

function ConfigDrawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: any; footer?: any }) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-end bg-black/60 backdrop-blur-md" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border-l border-border h-full w-full max-w-md shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="font-semibold">{title}</div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface2 text-muted hover:text-text"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto p-5 flex-1 space-y-3">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-border bg-surface2/30 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function TriggerConfigForm({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  const c = trigger.config ?? {};
  const set = (k: string, v: any) => onChange({ ...trigger, config: { ...c, [k]: v } });
  // Set value + parallel `_label` for human display in trigger card chip.
  const setRef = (k: string, v: any, opt: any) => onChange({ ...trigger, config: { ...c, [k]: v, [`_${k}_label`]: opt?.label ?? null } });
  switch (trigger.type) {
    case 'whatsapp.received':
      return <Field label="Chat (opzionale, filtra)"><SearchSelect value={c.chat_jid} initialLabel={c._chat_jid_label ?? undefined} onChange={(v, opt) => setRef('chat_jid', v, opt)} fetchOptions={fetchWaChats} placeholder="Tutte le chat" /></Field>;
    case 'instagram.received':
      return <Field label="Thread (opzionale, filtra)"><SearchSelect value={c.thread_id} initialLabel={c._thread_id_label ?? undefined} onChange={(v, opt) => setRef('thread_id', v, opt)} fetchOptions={fetchIgThreads} placeholder="Tutti i thread" /></Field>;
    case 'telegram.received':
      return <Field label="Contiene testo (opzionale)"><Input value={c.contains ?? ''} onChange={(e) => set('contains', e.target.value || null)} placeholder="es. 'urgente'" /></Field>;
    case 'email.received':
      return <Field label="Account (opzionale)"><SearchSelect value={c.account} initialLabel={c._account_label ?? undefined} onChange={(v, opt) => setRef('account', v, opt)} fetchOptions={fetchEmailAccounts} placeholder="Tutti gli account" /></Field>;
    case 'schedule.datetime':
      return <Field label="Data e ora"><Input type="datetime-local" value={c.at ?? ''} onChange={(e) => set('at', e.target.value)} /></Field>;
    case 'schedule.cron':
      return <Field label="Espressione cron (5 campi)"><Input value={c.cron ?? ''} onChange={(e) => set('cron', e.target.value)} placeholder="0 9 * * MON" /></Field>;
    case 'agent.finished':
      return <Field label="Agente (opzionale)"><SearchSelect value={c.agent_name} initialLabel={c._agent_name_label ?? undefined} onChange={(v, opt) => setRef('agent_name', v, opt)} fetchOptions={fetchCustomAgents} placeholder="Qualsiasi agente" /></Field>;
    case 'brain.node_added':
      return <Field label="Tipo nodo (opzionale)"><Input value={c.kind ?? ''} onChange={(e) => set('kind', e.target.value || null)} placeholder="note / email / ..." /></Field>;
    case 'task.triggered':
      return <Field label="Task schedulato (opzionale)"><SearchSelect value={c.task_id} initialLabel={c._task_id_label ?? undefined} onChange={(v, opt) => setRef('task_id', v ? Number(v) : null, opt)} fetchOptions={fetchScheduledTasks} placeholder="Qualsiasi task" /></Field>;
    case 'perk.fired':
      return <Field label="Perk (opzionale)"><SearchSelect value={c.perk_name} initialLabel={c._perk_name_label ?? undefined} onChange={(v, opt) => setRef('perk_name', v, opt)} fetchOptions={fetchPerks} placeholder="Qualsiasi perk" /></Field>;
    case 'team.fired':
      return <Field label="Team (opzionale)"><SearchSelect value={c.team_id} initialLabel={c._team_id_label ?? undefined} onChange={(v, opt) => setRef('team_id', v ? Number(v) : null, opt)} fetchOptions={fetchTeams} placeholder="Qualsiasi team" /></Field>;
    default:
      return <div className="text-xs text-muted">Nessuna configurazione richiesta.</div>;
  }
}

function StepConfigForm({ step, onChange, vars }: { step: Step; onChange: (s: Step) => void; vars: VarDef[] }) {
  const c = step.config ?? {};
  const set = (k: string, v: any) => onChange({ ...step, config: { ...c, [k]: v } });
  const setRef = (k: string, v: any, opt: any) => onChange({ ...step, config: { ...c, [k]: v, [`_${k}_label`]: opt?.label ?? null } });
  const textareaCls = 'w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[120px] font-mono';
  switch (step.type) {
    case 'agent.run':
      return <>
        <Field label="Prompt per l'agente">
          <VariableTextarea value={c.prompt ?? ''} onChange={(v) => set('prompt', v)} vars={vars} placeholder="Usa il bottone 'var' per inserire campi dal trigger" />
        </Field>
        <Field label="Model (opzionale)"><SearchSelect value={c.model} initialLabel={c._model_label ?? undefined} onChange={(v, opt) => setRef('model', v, opt)} fetchOptions={fetchClaudeModels} placeholder="default" /></Field>
      </>;
    case 'telegram.notify':
      return <Field label="Messaggio">
        <VariableTextarea value={c.text ?? ''} onChange={(v) => set('text', v)} vars={vars} placeholder="Es. Nuovo WA da {{trigger.msg.sender_name}}: {{trigger.msg.text}}" />
      </Field>;
    case 'team.run':
      return <>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Team"><SearchSelect value={c.team_id} initialLabel={c._team_id_label ?? undefined} onChange={(v, opt) => setRef('team_id', v ? Number(v) : null, opt)} fetchOptions={fetchTeams} placeholder="Scegli team" /></Field>
          <Field label="O singolo agente"><SearchSelect value={c.agent_id} initialLabel={c._agent_id_label ?? undefined} onChange={(v, opt) => setRef('agent_id', v ? Number(v) : null, opt)} fetchOptions={fetchCustomAgents} placeholder="Scegli agente" /></Field>
        </div>
        <Field label="Titolo task"><Input value={c.title ?? ''} onChange={(e) => set('title', e.target.value)} /></Field>
        <Field label="Brief"><VariableTextarea value={c.prompt ?? ''} onChange={(v) => set('prompt', v)} vars={vars} /></Field>
      </>;
    case 'email.send':
      return <>
        <Field label="Account"><SearchSelect value={c.account} initialLabel={c._account_label ?? undefined} onChange={(v, opt) => setRef('account', v, opt)} fetchOptions={fetchEmailAccounts} placeholder="Scegli account" /></Field>
        <Field label="Destinatario"><Input value={c.to ?? ''} onChange={(e) => set('to', e.target.value)} /></Field>
        <Field label="Oggetto"><Input value={c.subject ?? ''} onChange={(e) => set('subject', e.target.value)} /></Field>
        <Field label="Corpo"><VariableTextarea value={c.body ?? ''} onChange={(v) => set('body', v)} vars={vars} /></Field>
      </>;
    case 'whatsapp.send':
      return <>
        <Field label="Chat"><SearchSelect value={c.chat_jid} initialLabel={c._chat_jid_label ?? undefined} onChange={(v, opt) => setRef('chat_jid', v, opt)} fetchOptions={fetchWaChats} placeholder="Scegli chat" /></Field>
        <Field label="Testo"><VariableTextarea value={c.text ?? ''} onChange={(v) => set('text', v)} vars={vars} /></Field>
      </>;
    case 'instagram.send':
      return <>
        <Field label="Thread"><SearchSelect value={c.thread_id} initialLabel={c._thread_id_label ?? undefined} onChange={(v, opt) => setRef('thread_id', v, opt)} fetchOptions={fetchIgThreads} placeholder="Scegli thread" /></Field>
        <Field label="Testo"><VariableTextarea value={c.text ?? ''} onChange={(v) => set('text', v)} vars={vars} /></Field>
      </>;
    case 'brain.write_note':
      return <>
        <Field label="Path (rel. al vault)"><Input value={c.path ?? ''} onChange={(e) => set('path', e.target.value)} placeholder="flows/output.md" /></Field>
        <Field label="Body"><VariableTextarea value={c.body ?? ''} onChange={(v) => set('body', v)} vars={vars} /></Field>
      </>;
    case 'delay':
      return <Field label="Attesa (ms)"><Input type="number" value={c.ms ?? 1000} onChange={(e) => set('ms', Number(e.target.value))} /></Field>;
    case 'webhook':
      return <>
        <Field label="URL"><Input value={c.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="https://..." /></Field>
        <Field label="Method"><Input value={c.method ?? 'POST'} onChange={(e) => set('method', e.target.value)} /></Field>
        <Field label="Body JSON"><VariableTextarea value={typeof c.body === 'string' ? c.body : JSON.stringify(c.body ?? {}, null, 2)} onChange={(v) => set('body', v)} vars={vars} /></Field>
      </>;
    case 'condition':
      return <Field label="Espressione"><Input value={c.expr ?? ''} onChange={(e) => set('expr', e.target.value)} placeholder="{{trigger.text}}" /></Field>;
    default:
      return null;
  }
}

// Insert "+" handle shown between step cards. Click → add a new step at that index.
function InsertHandle({ onClick }: { onClick: () => void }) {
  return (
    <div data-block className="flex flex-col items-center group" style={{ height: 56 }}>
      <div className="w-[2px] flex-1 bg-accent/55" />
      <button
        onClick={onClick}
        title="Inserisci step qui"
        className="w-6 h-6 -my-2 rounded-full bg-surface border-2 border-accent/60 text-accent hover:bg-accent/20 hover:scale-110 transition flex items-center justify-center shadow-lg opacity-70 group-hover:opacity-100 z-10"
      >
        <Plus size={12} strokeWidth={3} />
      </button>
      <div className="w-[2px] flex-1 bg-accent/55" />
    </div>
  );
}

// Compact preview of a step's config, shown in the diagram card.
function stepConfigPreview(s: Step): string {
  const c = s.config ?? {};
  switch (s.type) {
    case 'delay':           return c.ms ? `${c.ms} ms` : '';
    case 'telegram.notify': return String(c.text ?? '').slice(0, 50);
    case 'agent.run':       return String(c.prompt ?? '').slice(0, 50);
    case 'team.run':        return c.title ? `→ ${c.title}` : (c.prompt ? String(c.prompt).slice(0, 40) : '');
    case 'email.send':      return [c._account_label ?? c.account, c.to, c.subject].filter(Boolean).join(' · ').slice(0, 60);
    case 'whatsapp.send':   return [c._chat_jid_label ?? c.chat_jid, String(c.text ?? '').slice(0, 30)].filter(Boolean).join(' · ');
    case 'instagram.send':  return [c._thread_id_label ?? c.thread_id, String(c.text ?? '').slice(0, 30)].filter(Boolean).join(' · ');
    case 'brain.write_note':return c.path ?? '';
    case 'webhook':         return [c.method ?? 'POST', c.url].filter(Boolean).join(' ').slice(0, 60);
    case 'condition':       return String(c.expr ?? '').slice(0, 50);
    default:                return '';
  }
}

// =====================================================================
// FlowDiagram — renders trigger row + step column with curved SVG connectors
// =====================================================================
function FlowDiagram({
  triggers, steps, onAddTrigger, onAddStepAt, onEditTrigger, onEditStep,
  onDelTrigger, onDelStep, onMoveStep, tMeta, sMeta,
}: {
  triggers: Trigger[]; steps: Step[];
  onAddTrigger: () => void; onAddStepAt: (index: number) => void;
  onEditTrigger: (i: number) => void; onEditStep: (i: number) => void;
  onDelTrigger: (i: number) => void; onDelStep: (i: number) => void;
  onMoveStep: (i: number, dir: -1 | 1) => void;
  tMeta: (t: string) => { type: string; label: string; icon: any; color: string };
  sMeta: (t: string) => { type: string; label: string; icon: any; color: string };
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRowRef = useRef<HTMLDivElement | null>(null);
  const trigRefs = useRef<(HTMLDivElement | null)[]>([]);
  const addTrigRef = useRef<HTMLButtonElement | null>(null);
  const stepCenterRef = useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [svgBox, setSvgBox] = useState({ w: 0, h: 96, mergeX: 0 });

  // Recompute paths on layout changes
  useEffect(() => {
    function recompute() {
      const wrap = wrapRef.current; if (!wrap) return;
      const rowEl = triggerRowRef.current; if (!rowEl) return;
      // Wrapper sits inside an ancestor with CSS transform (pan/zoom) — getBoundingClientRect
      // returns transformed pixels. Normalise to unscaled layout coords via scale ratio so
      // SVG (which uses layout pixels) matches the visible card positions exactly.
      const wrapRect = wrap.getBoundingClientRect();
      const layoutW = wrap.offsetWidth;
      const scale = layoutW > 0 ? wrapRect.width / layoutW : 1;
      const toLayout = (rect: DOMRect) => ({
        cx: (rect.left + rect.width / 2 - wrapRect.left) / scale,
      });
      const h = 96;
      const stepRect = stepCenterRef.current?.getBoundingClientRect();
      const mergeX = stepRect ? toLayout(stepRect).cx : layoutW / 2;
      const anchors: number[] = [];
      for (const t of trigRefs.current) {
        if (!t) continue;
        anchors.push(toLayout(t.getBoundingClientRect()).cx);
      }
      if (addTrigRef.current) anchors.push(toLayout(addTrigRef.current.getBoundingClientRect()).cx);
      const cy = h * 0.55;
      const ds = anchors.map((x) => `M ${x} 0 C ${x} ${cy}, ${mergeX} ${cy}, ${mergeX} ${h}`);
      setPaths(ds);
      setSvgBox({ w: layoutW, h, mergeX });
    }
    // Double-call: once now, once after next paint, so refs are guaranteed laid out.
    recompute();
    const raf = requestAnimationFrame(recompute);
    const ro = new ResizeObserver(recompute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    if (triggerRowRef.current) ro.observe(triggerRowRef.current);
    window.addEventListener('resize', recompute);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', recompute); };
  }, [triggers.length, steps.length]);

  return (
    <div ref={wrapRef} className="relative flex flex-col items-center">
      {/* Triggers row */}
      <div ref={triggerRowRef} className="flex items-stretch gap-10">
        {triggers.map((t, i) => {
          const M = tMeta(t.type); const I = M.icon;
          return (
            <div
              key={i}
              ref={(el) => { trigRefs.current[i] = el; }}
              data-block
              className="w-[260px] rounded-2xl border-2 border-accent/40 bg-surface shadow-2xl ring-1 ring-accent/10 overflow-hidden"
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
                <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: M.color + '22', border: `1px solid ${M.color}55` }}><I size={14} style={{ color: M.color }} /></div>
                <div className="font-medium text-sm truncate flex-1">{M.label}</div>
                <button onClick={() => onDelTrigger(i)} className="text-muted hover:text-red-300 p-1"><Trash2 size={12} /></button>
              </div>
              <div className="px-3 py-2 text-xs text-muted">
                {Object.keys(t.config ?? {}).filter((k) => !k.startsWith('_')).map((k) => {
                  const label = t.config[`_${k}_label`];
                  const val = String(t.config[k]).slice(0, 24);
                  return label ? `${k}: ${label} (${val})` : `${k}: ${val}`;
                }).join('  ·  ') || 'nessun filtro'}
              </div>
              <button onClick={() => onEditTrigger(i)} className="w-full text-[10px] text-accent border-t border-border/60 py-1.5 hover:bg-surface2 transition uppercase tracking-wider font-semibold">configura</button>
            </div>
          );
        })}
        <button ref={addTrigRef} data-block onClick={onAddTrigger} className="w-[200px] rounded-2xl border-2 border-dashed border-accent/30 text-accent hover:bg-accent/5 flex flex-col items-center justify-center gap-1">
          <Plus size={18} /><span className="text-sm font-medium">Trigger</span>
        </button>
      </div>

      {/* SVG curved connectors trigger row → merge point */}
      {triggers.length > 0 && (
        <svg width={svgBox.w} height={svgBox.h} className="pointer-events-none -mb-px" style={{ display: 'block' }}>
          {paths.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="rgba(192,132,252,0.65)" strokeWidth={2} strokeLinecap="round" />
          ))}
        </svg>
      )}

      {/* Bridge: merge → first insert handle (handle has its own purple line, so skip extra bridge) */}

      {/* Steps + END appear after first trigger */}
      {triggers.length > 0 && (
        <div ref={stepCenterRef} className="flex flex-col items-center gap-0">
          {/* Insert handle BEFORE first step (top of step column) */}
          <InsertHandle onClick={() => onAddStepAt(0)} />
          {steps.map((s, i) => {
            const M = sMeta(s.type); const I = M.icon;
            return (
              <div key={i} className="flex flex-col items-center">
                <div data-block className="w-[300px] rounded-2xl border-2 border-accent2/40 bg-surface shadow-2xl ring-1 ring-accent2/10 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
                    <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: M.color + '22', border: `1px solid ${M.color}55` }}><I size={14} style={{ color: M.color }} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{s.name || M.label}</div>
                      <div className="text-[10px] text-muted font-mono truncate">{s.type}</div>
                    </div>
                    <button onClick={() => onMoveStep(i, -1)} className="text-muted hover:text-text p-0.5 text-xs">↑</button>
                    <button onClick={() => onMoveStep(i, 1)} className="text-muted hover:text-text p-0.5 text-xs">↓</button>
                    <button onClick={() => onDelStep(i)} className="text-muted hover:text-red-300 p-1"><Trash2 size={12} /></button>
                  </div>
                  {(() => { const p = stepConfigPreview(s); return p ? (
                    <div className="px-3 py-2 text-xs text-muted whitespace-pre-wrap break-words">{p}</div>
                  ) : null; })()}
                  <button onClick={() => onEditStep(i)} className="w-full text-[10px] text-accent2 border-t border-border/60 py-1.5 hover:bg-surface2 transition uppercase tracking-wider font-semibold">configura</button>
                </div>
                {/* Insert handle AFTER this step */}
                <InsertHandle onClick={() => onAddStepAt(i + 1)} />
              </div>
            );
          })}
          {steps.length === 0 && (
            <button data-block onClick={() => onAddStepAt(0)} className="w-[240px] rounded-2xl border-2 border-dashed border-accent2/40 text-accent2 hover:bg-accent2/5 py-4 flex items-center justify-center gap-2">
              <Plus size={16} /><span className="text-sm font-medium">Step</span>
            </button>
          )}
          {steps.length === 0 && <div className="w-[2px] h-6 bg-accent/55" />}
          <div data-block className="px-5 py-1.5 rounded-full bg-surface2 border-2 border-accent/40 ring-1 ring-accent/10 text-xs text-accent font-semibold uppercase tracking-wider">END</div>
        </div>
      )}
    </div>
  );
}

export default function FlowDetail() {
  const { id = '' } = useParams();
  const flowId = Number(id);
  const nav = useNavigate();
  const toast = useToast();
  const [flow, setFlow] = useState<Flow | null>(null);
  const [tab, setTab] = useState<'builder' | 'runs'>('builder');
  const [runs, setRuns] = useState<any[]>([]);
  const [openRun, setOpenRun] = useState<any | null>(null);
  // Drawers
  const [pickerOpen, setPickerOpen] = useState<'trigger' | 'step' | null>(null);
  const [stepInsertAt, setStepInsertAt] = useState<number | null>(null);
  const [editTrigger, setEditTrigger] = useState<number | null>(null);
  const [editStep, setEditStep] = useState<number | null>(null);
  // Pan/zoom of canvas
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const load = useCallback(async () => {
    try { setFlow(await api.flowGet(flowId)); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }, [flowId, toast]);
  const loadRuns = useCallback(async () => {
    try { setRuns(await api.flowRunsList(flowId)); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }, [flowId, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'runs') loadRuns(); }, [tab, loadRuns]);
  useWS((m) => { if (m?.type === 'flow') { load(); if (tab === 'runs') loadRuns(); } });

  async function saveAll() {
    if (!flow) return;
    try {
      await api.flowUpdate(flow.id, { name: flow.name, description: flow.description, enabled: flow.enabled });
      await api.flowSetTriggers(flow.id, flow.triggers);
      await api.flowSetSteps(flow.id, flow.steps);
      toast.push('Flow salvato', 'on');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function runNow() {
    try { const r = await api.flowRunNow(flowId, { manual: true }); toast.push(`Run #${r.run_id} avviato`, 'on'); setTab('runs'); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  function addTrigger(type: string) { if (!flow) return; setFlow({ ...flow, triggers: [...flow.triggers, { type, config: {} } as Trigger] }); setPickerOpen(null); setEditTrigger(flow.triggers.length); }
  function delTrigger(i: number) { if (!flow) return; setFlow({ ...flow, triggers: flow.triggers.filter((_, j) => j !== i) }); }
  function patchTrigger(i: number, t: Trigger) { if (!flow) return; setFlow({ ...flow, triggers: flow.triggers.map((x, j) => j === i ? t : x) }); }
  function addStep(type: string) {
    if (!flow) return;
    const at = stepInsertAt ?? flow.steps.length;
    const next = [...flow.steps];
    next.splice(at, 0, { type, config: {} } as Step);
    setFlow({ ...flow, steps: next });
    setPickerOpen(null);
    setStepInsertAt(null);
    setEditStep(at);
  }
  function delStep(i: number) { if (!flow) return; setFlow({ ...flow, steps: flow.steps.filter((_, j) => j !== i) }); }
  function patchStep(i: number, s: Step) { if (!flow) return; setFlow({ ...flow, steps: flow.steps.map((x, j) => j === i ? s : x) }); }
  function moveStep(i: number, dir: -1 | 1) {
    if (!flow) return;
    const j = i + dir;
    if (j < 0 || j >= flow.steps.length) return;
    const next = [...flow.steps];
    const [el] = next.splice(i, 1);
    next.splice(j, 0, el);
    setFlow({ ...flow, steps: next });
  }

  // Drag canvas pan
  function onCanvasDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }
  function onCanvasMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.x), y: dragRef.current.py + (e.clientY - dragRef.current.y) });
  }
  function onCanvasUp() { dragRef.current = null; }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = -e.deltaY / 800;
    setZoom((z) => Math.max(0.4, Math.min(2, z + delta)));
  }

  if (!flow) return <div className="text-muted p-6">Caricamento…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => nav('/flows')} className="text-muted hover:text-text"><ArrowLeft size={16} /></button>
        <Input value={flow.name} onChange={(e) => setFlow({ ...flow, name: e.target.value })} className="text-lg font-semibold !bg-transparent !border-transparent hover:!border-border focus:!border-accent max-w-xs" />
        <Chip tone={flow.enabled ? 'on' : 'warn'}>{flow.enabled ? 'attivo' : 'spento'}</Chip>
        <Toggle checked={flow.enabled} onChange={(v) => setFlow({ ...flow, enabled: v })} />
        <div className="ml-auto flex gap-2">
          <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-full p-1">
            <Button size="sm" variant={tab === 'builder' ? 'primary' : 'ghost'} onClick={() => setTab('builder')}><Workflow size={13} className="inline mr-1 -mt-0.5" />Builder</Button>
            <Button size="sm" variant={tab === 'runs' ? 'primary' : 'ghost'} onClick={() => setTab('runs')}><ClipboardList size={13} className="inline mr-1 -mt-0.5" />Execution logs</Button>
          </div>
          <Button size="sm" variant="ghost" onClick={runNow}><Play size={13} className="inline mr-1 -mt-0.5" />Run now</Button>
          <Button size="sm" onClick={saveAll}><Save size={13} className="inline mr-1 -mt-0.5" />Salva</Button>
        </div>
      </div>

      {tab === 'builder' && (
        <Card className="p-0 overflow-hidden h-[78vh] relative">
          <div
            ref={wrapRef}
            className="absolute inset-0 overflow-hidden cursor-grab active:cursor-grabbing"
            style={{ backgroundImage: 'radial-gradient(circle, rgba(200,200,230,0.18) 1px, transparent 1px)', backgroundSize: `${24 * zoom}px ${24 * zoom}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }}
            onMouseDown={onCanvasDown}
            onMouseMove={onCanvasMove}
            onMouseUp={onCanvasUp}
            onMouseLeave={onCanvasUp}
            onWheel={onWheel}
          >
            <div className="absolute left-1/2 top-12" style={{ transform: `translateX(-50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'top center' }}>
              <FlowDiagram
                triggers={flow.triggers}
                steps={flow.steps}
                onAddTrigger={() => setPickerOpen('trigger')}
                onAddStepAt={(idx) => { setStepInsertAt(idx); setPickerOpen('step'); }}
                onEditTrigger={setEditTrigger}
                onEditStep={setEditStep}
                onDelTrigger={delTrigger}
                onDelStep={delStep}
                onMoveStep={moveStep}
                tMeta={tMeta}
                sMeta={sMeta}
              />
            </div>

            {/* Zoom controls bottom-right */}
            <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1 bg-surface/80 border border-border rounded-xl p-1 backdrop-blur">
              <button onClick={() => setZoom((z) => Math.min(2, z + 0.1))} className="w-7 h-7 rounded-md hover:bg-surface2 text-sm">+</button>
              <button onClick={() => setZoom(1)} className="w-7 h-7 rounded-md hover:bg-surface2 text-[10px]">1:1</button>
              <button onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))} className="w-7 h-7 rounded-md hover:bg-surface2 text-sm">−</button>
              <button onClick={() => setPan({ x: 0, y: 0 })} className="w-7 h-7 rounded-md hover:bg-surface2 text-[10px]" title="Reset pan">⌂</button>
            </div>
          </div>
        </Card>
      )}

      {tab === 'runs' && (
        <Card className="space-y-2">
          {runs.length === 0 && <div className="text-muted text-sm">Nessuna esecuzione ancora.</div>}
          {runs.map((r) => (
            <button key={r.id} onClick={async () => setOpenRun(await api.flowRunGet(r.id))} className="w-full text-left p-3 rounded-xl border border-border/60 hover:border-accent/40 hover:bg-surface2/40 transition flex items-center gap-3">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${r.status === 'done' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-400/30' : r.status === 'error' ? 'bg-red-500/15 text-red-300 border border-red-400/30' : r.status === 'running' ? 'bg-accent/15 text-accent border border-accent/30 animate-pulse' : 'bg-surface2 text-muted border border-border'}`}>{r.status}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{r.trigger_type ?? '—'} · #{r.id}</div>
                <div className="text-[10px] text-muted font-mono">{new Date(r.created_at).toLocaleString('it-IT')}{r.duration_ms ? ` · ${r.duration_ms}ms` : ''}</div>
              </div>
            </button>
          ))}
        </Card>
      )}

      {/* Picker drawer for trigger or step type */}
      <ConfigDrawer open={!!pickerOpen} onClose={() => { setPickerOpen(null); setStepInsertAt(null); }} title={pickerOpen === 'trigger' ? 'Scegli un trigger' : 'Scegli uno step'}>
        <div className="space-y-2">
          {(pickerOpen === 'trigger' ? TRIGGER_TYPES : STEP_TYPES).map((m) => {
            const I = m.icon;
            return (
              <button key={m.type} onClick={() => (pickerOpen === 'trigger' ? addTrigger(m.type) : addStep(m.type))} className="w-full text-left flex items-center gap-3 p-3 rounded-xl border border-border/60 hover:border-accent/40 hover:bg-surface2/40 transition">
                <div className="w-8 h-8 rounded-md flex items-center justify-center" style={{ background: m.color + '22', border: `1px solid ${m.color}55` }}><I size={15} style={{ color: m.color }} /></div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{m.label}</div>
                  <div className="text-[10px] text-muted font-mono">{m.type}</div>
                </div>
              </button>
            );
          })}
        </div>
      </ConfigDrawer>

      {/* Trigger config drawer */}
      <ConfigDrawer
        open={editTrigger != null && !!flow?.triggers[editTrigger!]}
        onClose={() => setEditTrigger(null)}
        title="Configura trigger"
        footer={<>
          <Button variant="ghost" onClick={() => setEditTrigger(null)}>Annulla</Button>
          <Button onClick={() => { setEditTrigger(null); toast.push('Trigger aggiornato', 'on'); }}>Salva</Button>
        </>}
      >
        {editTrigger != null && flow?.triggers[editTrigger] && (
          <TriggerConfigForm trigger={flow.triggers[editTrigger]} onChange={(t) => patchTrigger(editTrigger!, t)} />
        )}
      </ConfigDrawer>

      {/* Step config drawer */}
      <ConfigDrawer
        open={editStep != null && !!flow?.steps[editStep!]}
        onClose={() => setEditStep(null)}
        title="Configura step"
        footer={<>
          <Button variant="ghost" onClick={() => setEditStep(null)}>Annulla</Button>
          <Button onClick={() => { setEditStep(null); toast.push('Step aggiornato', 'on'); }}>Salva</Button>
        </>}
      >
        {editStep != null && flow?.steps[editStep] && (
          <>
            <Field label="Nome (opzionale)"><Input value={flow.steps[editStep].name ?? ''} onChange={(e) => patchStep(editStep!, { ...flow!.steps[editStep!], name: e.target.value || null })} /></Field>
            <StepConfigForm step={flow.steps[editStep]} onChange={(s) => patchStep(editStep!, s)} vars={varsForTriggers(flow.triggers.map((t) => t.type))} />
          </>
        )}
      </ConfigDrawer>

      {openRun && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setOpenRun(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-5 py-3 border-b border-border flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm">Run #{openRun.id}</div>
                <div className="text-[10px] text-muted">{openRun.trigger_type} · {openRun.status}</div>
              </div>
              <button onClick={() => setOpenRun(null)} className="p-1.5 rounded-md hover:bg-surface2 text-muted"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto p-5 flex-1 space-y-2">
              {openRun.events?.map((e: any) => (
                <div key={e.id} className="text-xs border border-border/60 rounded-lg p-2 bg-surface2/30">
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono text-[10px] uppercase text-accent">{e.kind}</span>
                    <span className="text-[10px] text-muted font-mono">{new Date(e.ts).toLocaleTimeString('it-IT')}</span>
                  </div>
                  {e.content && <pre className="whitespace-pre-wrap break-all text-[11px] text-muted font-mono">{e.content.slice(0, 800)}</pre>}
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
