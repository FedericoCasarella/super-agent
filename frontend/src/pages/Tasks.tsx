import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, Textarea, Toggle, Modal, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useI18n } from '../i18n';
import { Calendar, Users as UsersIcon, PlayCircle, CheckCircle2, XCircle, Plus, AlertCircle } from 'lucide-react';
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
    await api.taskUpdate(task.id, { enabled: !task.enabled });
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
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-gradient">Tasks</h1>
          <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1">
            <Button size="sm" variant={tab === 'scheduled' ? 'primary' : 'ghost'} onClick={() => setTab('scheduled')}>
              <Calendar size={13} className="inline mr-1 -mt-0.5" />Scheduled
            </Button>
            <Button size="sm" variant={tab === 'team' ? 'primary' : 'ghost'} onClick={() => setTab('team')}>
              <UsersIcon size={13} className="inline mr-1 -mt-0.5" />Team
            </Button>
          </div>
        </div>
        {tab === 'scheduled' && <Button onClick={openCreate}>{t('tasks.new')}</Button>}
      </div>

      {tab === 'team' && <TeamTasksPanel />}

      {tab === 'scheduled' && <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.length === 0 && <Card><div className="text-muted-foreground text-sm">{t('tasks.none')}</div></Card>}
        {items.map((task) => (
          <Card key={task.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-semibold truncate">{task.name}</div>
                  <Chip>{task.action_type}</Chip>
                </div>
                <div className="text-xs text-muted-foreground font-mono mt-1">{task.cron}</div>
                {/* Creazione reminder — quando l'utente l'ha aggiunto */}
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-2">
                  <Plus size={11} className="text-muted-foreground" />
                  <span>Aggiunto {fmtAgo(task.created_at)}</span>
                  <span className="text-muted-foreground/50">·</span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">{new Date(task.created_at).toLocaleString('it-IT')}</span>
                </div>
                {task.last_run_at && (
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-1">
                    <PlayCircle size={11} className="text-accent" />
                    <span>Ultima esecuzione: {fmtAgo(task.last_run_at)}</span>
                    {task.last_status === 'ok' ? (
                      <span className="inline-flex items-center gap-0.5 text-[hsl(var(--success))]">
                        <CheckCircle2 size={11} /> riuscita
                      </span>
                    ) : task.last_status === 'cleared' ? (
                      <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                        <XCircle size={11} /> ignorata
                      </span>
                    ) : task.last_status === 'sent' ? (
                      <span className="inline-flex items-center gap-0.5 text-accent2">
                        <CheckCircle2 size={11} /> notificata
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 text-destructive">
                        <AlertCircle size={11} /> {task.last_status}
                      </span>
                    )}
                  </div>
                )}
                {task.last_result && <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{task.last_result}</div>}
              </div>
              <Toggle checked={task.enabled} onChange={() => toggle(task)} />
            </div>
            <div className="mt-3 flex gap-2 flex-wrap">
              <Button variant="ghost" size="sm" onClick={() => openEdit(task)}>{t('tasks.edit')}</Button>
              <Button variant="ghost" size="sm" onClick={() => run(task)} disabled={running.has(task.id)}>
                {running.has(task.id) ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                    {t('tasks.running')}
                  </span>
                ) : t('tasks.runNow')}
              </Button>
              <Button variant="danger" size="sm" onClick={() => remove(task)}>{t('tasks.delete')}</Button>
            </div>
          </Card>
        ))}
      </div>
      </>}

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
