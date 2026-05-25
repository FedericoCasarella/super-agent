import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, Textarea, Toggle, Modal, useToast } from '../components/ui';

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
};

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 9:00', cron: '0 9 * * *' },
  { label: 'Mon 9:00', cron: '0 9 * * MON' },
  { label: 'Fri 18:00', cron: '0 18 * * FRI' },
];

export default function Tasks() {
  const [items, setItems] = useState<Task[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const toast = useToast();

  // form state
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
      toast.push(`Task ${editing ? 'updated' : 'created'}`, 'on');
      setModalOpen(false);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function toggle(t: Task) {
    await api.taskUpdate(t.id, { enabled: !t.enabled });
    toast.push(`${t.name} ${!t.enabled ? 'enabled' : 'disabled'}`, !t.enabled ? 'on' : 'warn');
    load();
  }
  async function remove(t: Task) {
    if (!confirm(`Delete "${t.name}"?`)) return;
    await api.taskDelete(t.id);
    toast.push('Deleted', 'warn');
    load();
  }
  async function run(t: Task) {
    await api.taskRun(t.id);
    toast.push(`Ran ${t.name}`, 'info');
    setTimeout(load, 1500);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Scheduled Tasks</h1>
        <Button onClick={openCreate}>+ New task</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.length === 0 && <Card><div className="text-muted text-sm">No tasks yet.</div></Card>}
        {items.map((t) => (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <div className="font-semibold truncate">{t.name}</div>
                  <Chip>{t.action_type}</Chip>
                </div>
                <div className="text-xs text-muted font-mono mt-1">{t.cron}</div>
                {t.last_run_at && (
                  <div className="text-xs text-muted mt-2">
                    last: {new Date(t.last_run_at).toLocaleString()} ·{' '}
                    <span className={t.last_status === 'ok' ? 'text-ok' : 'text-err'}>{t.last_status}</span>
                  </div>
                )}
                {t.last_result && <div className="text-xs text-muted mt-1 line-clamp-2">{t.last_result}</div>}
              </div>
              <Toggle checked={t.enabled} onChange={() => toggle(t)} />
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => openEdit(t)}>Edit</Button>
              <Button variant="ghost" size="sm" onClick={() => run(t)}>Run now</Button>
              <Button variant="danger" size="sm" onClick={() => remove(t)}>Delete</Button>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={modalOpen}
        title={editing ? `Edit task #${editing.id}` : 'New scheduled task'}
        onClose={() => setModalOpen(false)}
        footer={<>
          <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={!name || !cron}>Save</Button>
        </>}
      >
        <div className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily standup ping" /></Field>
          <Field label="Cron (5-field)">
            <Input className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * *" />
          </Field>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <Button key={p.cron} size="sm" variant="ghost" onClick={() => setCron(p.cron)}>{p.label}</Button>
            ))}
          </div>
          <Field label="Action">
            <div className="flex gap-1">
              {(['notify', 'prompt', 'tool'] as const).map((k) => (
                <Button key={k} size="sm" variant={type === k ? 'primary' : 'ghost'} onClick={() => setType(k)}>{k}</Button>
              ))}
            </div>
          </Field>

          {type === 'notify' && (
            <Field label="Message text (sent to Telegram)">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Buongiorno, check the roadmap." />
            </Field>
          )}
          {type === 'prompt' && (
            <Field label="Claude prompt (full advisor context auto-injected)">
              <Textarea value={promptText} onChange={(e) => setPromptText(e.target.value)} placeholder="Riassumi le email importanti di oggi e mandami le top 3 azioni." />
            </Field>
          )}
          {type === 'tool' && (
            <>
              <Field label="Tool name (e.g. agent_roadmap_get, imap_fetch_recent)">
                <Input className="font-mono" value={toolName} onChange={(e) => setToolName(e.target.value)} />
              </Field>
              <Field label="Args (JSON)">
                <Textarea className="font-mono" value={toolArgs} onChange={(e) => setToolArgs(e.target.value)} />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={toolNotify} onChange={(e) => setToolNotify(e.target.checked)} />
                Send result to Telegram
              </label>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
