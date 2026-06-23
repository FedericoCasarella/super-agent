import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, Textarea, Toggle, Modal, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useI18n } from '../i18n';
import { Calendar, Users as UsersIcon, PlayCircle, CheckCircle2, XCircle, Plus, AlertCircle, MoreHorizontal, Pencil, Play, Trash2, Bell, Bot, Wrench, Clock as ClockIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import DataTable, { Column, ChipFilter } from '../components/DataTable';
import { TeamTasksPanel } from './TeamTasks';

type Task = {
  id: number;
  name: string;
  cron: string;
  action_type: 'notify' | 'prompt' | 'tool';
  action_payload: any;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_result: string | null;
  created_at: string;
};

// Best-effort cron → human reader (it-IT). Covers the common patterns the
// user typically writes; falls back to the raw expression for the rest.
function humanizeCron(expr: string): string {
  if (!expr || typeof expr !== 'string') return '—';
  const e = expr.trim();
  const parts = e.split(/\s+/);
  if (parts.length !== 5) return e;
  const [min, hour, dom, mon, dow] = parts;
  const pad = (s: string) => (s.length === 1 ? `0${s}` : s);
  const time = /^\d+$/.test(min) && /^\d+$/.test(hour) ? `${pad(hour)}:${pad(min)}` : null;
  const DOW: Record<string, string> = { '0': 'domenica', '1': 'lunedì', '2': 'martedì', '3': 'mercoledì', '4': 'giovedì', '5': 'venerdì', '6': 'sabato', '7': 'domenica' };
  const MON: Record<string, string> = { '1': 'gennaio', '2': 'febbraio', '3': 'marzo', '4': 'aprile', '5': 'maggio', '6': 'giugno', '7': 'luglio', '8': 'agosto', '9': 'settembre', '10': 'ottobre', '11': 'novembre', '12': 'dicembre' };
  // every N minutes
  const mMin = /^\*\/(\d+)$/.exec(min);
  if (mMin && hour === '*' && dom === '*' && mon === '*' && dow === '*') return `Ogni ${mMin[1]} minuti`;
  // every N hours
  const mHr = /^\*\/(\d+)$/.exec(hour);
  if (min === '0' && mHr && dom === '*' && mon === '*' && dow === '*') return `Ogni ${mHr[1]} ore`;
  // daily at HH:MM
  if (time && dom === '*' && mon === '*' && dow === '*') return `Ogni giorno alle ${time}`;
  // weekly
  if (time && dom === '*' && mon === '*' && /^\d$/.test(dow)) return `Ogni ${DOW[dow]} alle ${time}`;
  if (time && dom === '*' && mon === '*' && /^\d-\d$/.test(dow)) {
    const [a, b] = dow.split('-');
    return `Da ${DOW[a]} a ${DOW[b]} alle ${time}`;
  }
  if (time && dom === '*' && mon === '*' && dow.includes(',')) {
    const names = dow.split(',').map((d) => DOW[d] ?? d).join(', ');
    return `Ogni ${names} alle ${time}`;
  }
  // monthly day N
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `Il ${dom} di ogni mese alle ${time}`;
  // yearly
  if (time && /^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === '*') return `Il ${dom} ${MON[mon] ?? mon} alle ${time}`;
  return e;
}

// Category accent — used as a left border on the task card. Driven by
// action_type primarily, with a hash-of-name fallback for visual variety.
function taskCategory(t: Task): { color: string; label: string; Icon: any } {
  if (t.action_type === 'notify') return { color: 'hsl(35,90%,55%)', label: 'Notifica', Icon: Bell };
  if (t.action_type === 'prompt') return { color: 'hsl(265,85%,65%)', label: 'Agente',   Icon: Bot };
  if (t.action_type === 'tool')   return { color: 'hsl(190,80%,55%)', label: 'Tool',     Icon: Wrench };
  return { color: 'hsl(220,15%,55%)', label: 'Task', Icon: ClockIcon };
}

function fmtAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'pochi secondi fa';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  const dd = Math.floor(h / 24);
  if (dd < 7) return `${dd}g fa`;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export default function Tasks() {
  const [items, setItems] = useState<Task[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [running, setRunning] = useState<Set<number>>(new Set());
  const toast = useToast();
  const dlg = useDialog();
  const { t } = useI18n();

  const PRESETS: { label: string; cron: string }[] = [
    { label: t('tasks.preset.5min'),   cron: '*/5 * * * *' },
    { label: t('tasks.preset.30min'),  cron: '*/30 * * * *' },
    { label: t('tasks.preset.hourly'), cron: '0 * * * *' },
    { label: t('tasks.preset.daily9'), cron: '0 9 * * *' },
    { label: t('tasks.preset.mon9'),   cron: '0 9 * * MON' },
    { label: t('tasks.preset.fri18'),  cron: '0 18 * * FRI' },
  ];

  const [name, setName] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [type, setType] = useState<'notify' | 'prompt' | 'tool'>('notify');
  const [text, setText] = useState('');
  const [promptText, setPromptText] = useState('');
  const [toolName, setToolName] = useState('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [toolNotify, setToolNotify] = useState(false);

  async function load() { setItems(await api.tasks()); }
  useEffect(() => { load(); }, []);

  function openCreate() {
    setEditing(null);
    setName(''); setCron('0 9 * * *'); setType('notify');
    setText(''); setPromptText(''); setToolName(''); setToolArgs('{}'); setToolNotify(false);
    setModalOpen(true);
  }
  function openEdit(t: Task) {
    setEditing(t);
    setName(t.name); setCron(t.cron); setType(t.action_type);
    setText(t.action_payload?.text ?? '');
    setPromptText(t.action_payload?.prompt ?? '');
    setToolName(t.action_payload?.tool ?? '');
    setToolArgs(JSON.stringify(t.action_payload?.args ?? {}, null, 2));
    setToolNotify(!!t.action_payload?.notify);
    setModalOpen(true);
  }

  function buildPayload() {
    if (type === 'notify') return { text };
    if (type === 'prompt') return { prompt: promptText };
    let args: any = {};
    try { args = JSON.parse(toolArgs || '{}'); } catch { throw new Error('tool args is not valid JSON'); }
    return { tool: toolName, args, notify: toolNotify };
  }

  async function save() {
    try {
      const payload = buildPayload();
      const data = { name, cron, action_type: type, action_payload: payload, enabled: true };
      if (editing) await api.taskUpdate(editing.id, data);
      else await api.taskCreate(data);
      toast.push(editing ? t('tasks.updated') : t('tasks.created'), 'on');
      setModalOpen(false);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function toggle(task: Task) {
    const next = !task.enabled;
    setItems((prev) => prev.map((x) => (x.id === task.id ? { ...x, enabled: next } : x))); // ottimistico
    try { await api.taskUpdate(task.id, { enabled: next }); }
    catch (e: any) {
      setItems((prev) => prev.map((x) => (x.id === task.id ? { ...x, enabled: task.enabled } : x))); // rollback
      toast.push(String(e?.message ?? e), 'err');
    }
    load();
  }
  async function remove(task: Task) {
    if (!await dlg.confirm(t('tasks.confirmDelete').replace('{name}', task.name), { tone: 'danger', confirmLabel: 'Elimina' })) return;
    await api.taskDelete(task.id);
    toast.push(t('tasks.deleted'), 'warn');
    load();
  }
  async function run(task: Task) {
    setRunning((s) => new Set(s).add(task.id));
    try {
      await api.taskRun(task.id);
      toast.push(t('tasks.ran').replace('{name}', task.name), 'on');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally {
      setRunning((s) => { const n = new Set(s); n.delete(task.id); return n; });
      load();
    }
  }

  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') === 'team' ? 'team' : 'scheduled') as 'scheduled' | 'team';
  const setTab = (v: 'scheduled' | 'team') => { const n = new URLSearchParams(sp); n.set('tab', v); setSp(n, { replace: true }); };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold text-gradient">Tasks</h1>
      </div>
      <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1 w-fit">
        <Button size="sm" variant={tab === 'scheduled' ? 'primary' : 'ghost'} onClick={() => setTab('scheduled')}>
          <Calendar size={13} className="inline mr-1 -mt-0.5" />Scheduled
        </Button>
        <Button size="sm" variant={tab === 'team' ? 'primary' : 'ghost'} onClick={() => setTab('team')}>
          <UsersIcon size={13} className="inline mr-1 -mt-0.5" />Team task
        </Button>
      </div>

      {tab === 'team' && <TeamTasksPanel />}

      {tab === 'scheduled' && (
        <DataTable<Task>
          persistKey="tasks.scheduled"
          fetcher={async ({ q, page, pageSize, filters, sort }) => {
            // Client-side: api.tasks() returns the full list — filter+slice here.
            const all = await api.tasks();
            let rows = all as Task[];
            const types: string[] = filters.type ?? [];
            if (types.length) rows = rows.filter((r) => types.includes(r.action_type));
            const states: string[] = filters.state ?? [];
            if (states.length) {
              rows = rows.filter((r) => (
                (states.includes('on') && r.enabled) ||
                (states.includes('off') && !r.enabled)
              ));
            }
            if (q) {
              const needle = q.toLowerCase();
              rows = rows.filter((r) =>
                r.name.toLowerCase().includes(needle) ||
                r.cron.toLowerCase().includes(needle) ||
                (r.last_result ?? '').toLowerCase().includes(needle)
              );
            }
            if (sort) {
              rows = [...rows].sort((a: any, b: any) => {
                const av = a[sort.key]; const bv = b[sort.key];
                if (av == null) return 1; if (bv == null) return -1;
                return sort.dir === 'asc' ? (av > bv ? 1 : -1) : (av > bv ? -1 : 1);
              });
            }
            const total = rows.length;
            const start = page * pageSize;
            return { rows: rows.slice(start, start + pageSize), total };
          }}
          refreshKey={items.map((x) => `${x.id}:${x.enabled ? 1 : 0}`).join(',') /* re-fetch su toggle/run/delete */}
          rowKey={(t) => t.id}
          searchPlaceholder="Cerca per nome, cron, ultimo risultato…"
          chipFilters={[
            {
              key: 'type', label: 'Tipo', multi: true,
              options: [
                { value: 'notify', label: 'Notifica', tone: 'warn' },
                { value: 'prompt', label: 'Agente', tone: 'accent' },
                { value: 'tool',   label: 'Tool',    tone: 'accent2' },
              ],
            },
            {
              key: 'state', label: 'Stato', multi: true,
              options: [
                { value: 'on',  label: 'Attivi',     tone: 'on' },
                { value: 'off', label: 'Disattivi',  tone: 'default' },
              ],
            },
          ]}
          columns={[
            {
              key: 'name', header: 'Nome', sortable: true,
              render: (task) => {
                const cat = taskCategory(task);
                return (
                  <div className="min-w-0">
                    <div className="font-medium truncate">{task.name}</div>
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold mt-0.5"
                      style={{ background: `${cat.color}22`, color: cat.color, border: `1px solid ${cat.color}55` }}
                    >
                      <cat.Icon size={10} /> {cat.label}
                    </span>
                  </div>
                );
              },
            },
            {
              key: 'cron', header: 'Schedule', sortable: true,
              render: (task) => (
                <div>
                  <div className="text-sm flex items-center gap-1.5">
                    <ClockIcon size={11} className="text-muted-foreground" />
                    {humanizeCron(task.cron)}
                  </div>
                  <div className="text-[10px] font-mono text-muted-foreground/60">{task.cron}</div>
                </div>
              ),
            },
            {
              key: 'created_at', header: 'Aggiunto', sortable: true, width: 'w-32',
              render: (task) => (
                <div className="text-xs">
                  <div>{fmtAgo(task.created_at)}</div>
                  <div className="text-[10px] text-muted-foreground/60 font-mono">
                    {new Date(task.created_at).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                  </div>
                </div>
              ),
            },
            {
              key: 'last_run_at', header: 'Ultimo esito', sortable: true, width: 'w-44',
              render: (task) => {
                if (!task.last_run_at) return <span className="text-[11px] text-muted-foreground/60">Mai eseguito</span>;
                const status = task.last_status === 'ok' ? { Icon: CheckCircle2, txt: 'riuscita',   cls: 'text-[hsl(var(--success))]' }
                             : task.last_status === 'cleared' ? { Icon: XCircle, txt: 'ignorata',   cls: 'text-muted-foreground' }
                             : task.last_status === 'sent' ? { Icon: Bell,        txt: 'notificata', cls: 'text-accent2' }
                             : { Icon: AlertCircle, txt: task.last_status ?? 'errore', cls: 'text-destructive' };
                return (
                  <div className="text-xs">
                    <div className={`inline-flex items-center gap-1 ${status.cls}`}>
                      <status.Icon size={12} /> {status.txt}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">{fmtAgo(task.last_run_at)}</div>
                  </div>
                );
              },
            },
            {
              key: 'enabled', header: 'Attivo', sortable: true, width: 'w-20', align: 'center',
              render: (task) => <Toggle checked={task.enabled} onChange={() => toggle(task)} />,
            },
            {
              key: 'actions', header: '', width: 'w-12', align: 'right',
              render: (task) => {
                const isRun = running.has(task.id);
                return (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-surface2 text-muted-foreground hover:text-foreground transition"
                        aria-label="Azioni"
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem onSelect={() => openEdit(task)}>
                        <Pencil size={14} /> {t('tasks.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => run(task)} disabled={isRun}>
                        {isRun
                          ? (<><span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" /> {t('tasks.running')}</>)
                          : (<><Play size={14} /> {t('tasks.runNow')}</>)
                        }
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => remove(task)} className="text-destructive focus:text-destructive focus:bg-destructive/10">
                        <Trash2 size={14} /> {t('tasks.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              },
            },
          ] as Column<Task>[]}
          emptyText={t('tasks.none')}
          toolbar={<Button size="sm" onClick={openCreate}><Plus size={14} /> {t('tasks.new')}</Button>}
        />
      )}

      <Modal
        open={modalOpen}
        title={editing ? t('tasks.editTitle').replace('{id}', String(editing.id)) : t('tasks.newTitle')}
        onClose={() => setModalOpen(false)}
        footer={<>
          <Button variant="ghost" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={!name || !cron}>{t('common.save')}</Button>
        </>}
      >
        <div className="space-y-3">
          <Field label={t('tasks.name')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('tasks.cron')}>
            <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
          </Field>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button key={p.cron} size="sm" variant="ghost" onClick={() => setCron(p.cron)}>{p.label}</Button>
            ))}
          </div>
          <Field label={t('tasks.action')}>
            <div className="flex gap-1">
              {(['notify', 'prompt', 'tool'] as const).map((k) => (
                <Button key={k} size="sm" variant={type === k ? 'primary' : 'ghost'} onClick={() => setType(k)}>{k}</Button>
              ))}
            </div>
          </Field>

          {type === 'notify' && (
            <Field label={t('tasks.notifyText')}>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          {type === 'prompt' && (
            <Field label={t('tasks.promptText')}>
              <Textarea value={promptText} onChange={(e) => setPromptText(e.target.value)} />
            </Field>
          )}
          {type === 'tool' && (
            <>
              <Field label={t('tasks.toolName')}>
                <Input className="font-mono" value={toolName} onChange={(e) => setToolName(e.target.value)} />
              </Field>
              <Field label={t('tasks.toolArgs')}>
                <Textarea className="font-mono" value={toolArgs} onChange={(e) => setToolArgs(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={toolNotify} onChange={(e) => setToolNotify(e.target.checked)} />
                {t('tasks.toolNotify')}
              </label>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
