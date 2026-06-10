import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useLiveData } from '../ws';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { Plus } from 'lucide-react';
import DataTable, { Column } from '../components/DataTable';

type Task = { id: number; team_id: number | null; agent_id: number | null; title: string; status: string; created_at: string };

export default function TeamTasksPage() { return <TeamTasksPanel />; }

export function TeamTasksPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{ title: string; prompt: string; team_id?: number; agent_id?: number }>({ title: '', prompt: '' });
  const toast = useToast();
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const [t, tm, ag] = await Promise.all([api.teamTasksList(), api.teamsList(), api.customAgentsList()]);
      setTasks(t); setTeams(tm); setAgents(ag);
    } catch (e: any) { toast.push(e.message, 'err'); }
  }, [toast]);
  useLiveData(load, { refreshOn: ['team_task', 'team_task_tokens'], fallbackMs: 120_000 });

  async function submit() {
    if (!draft.title || !draft.prompt || (!draft.team_id && !draft.agent_id)) return;
    try {
      const t = await api.teamTaskCreate(draft);
      setCreating(false); setDraft({ title: '', prompt: '' });
      toast.push(`Task #${t.id} avviato`, 'on');
      load(); nav(`/team-tasks/${t.id}`);
    } catch (e: any) { toast.push(e.message, 'err'); }
  }

  function statusChip(s: string) {
    const tone = s === 'done' ? 'on' : s === 'running' ? 'accent' : s === 'error' ? 'err' : s === 'cancelled' ? 'warn' : 'default';
    return <Chip tone={tone as any}>{s}</Chip>;
  }

  return (
    <div className="space-y-4">
      {creating && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setCreating(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <Card className="space-y-3">
              <div className="font-semibold text-lg">Nuovo task</div>
              <Field label="Titolo"><Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></Field>
              <Field label="Brief / prompt (self-contained: goal, contesto, deliverable, vincoli)">
                <textarea value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm min-h-[200px] font-mono" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Team (preferito)">
                  <select value={draft.team_id ?? ''} onChange={(e) => setDraft({ ...draft, team_id: e.target.value ? Number(e.target.value) : undefined, agent_id: undefined })} className="w-full bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm">
                    <option value="">— nessuno —</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Oppure singolo agente">
                  <select value={draft.agent_id ?? ''} onChange={(e) => setDraft({ ...draft, agent_id: e.target.value ? Number(e.target.value) : undefined, team_id: undefined })} className="w-full bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm">
                    <option value="">— nessuno —</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.icon || '🤖'} {a.name}</option>)}
                  </select>
                </Field>
              </div>
              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <Button variant="ghost" onClick={() => setCreating(false)}>Annulla</Button>
                <Button onClick={submit} disabled={!draft.title || !draft.prompt || (!draft.team_id && !draft.agent_id)}>Avvia</Button>
              </div>
            </Card>
          </div>
        </div>,
        document.body,
      )}

      <DataTable<Task>
        persistKey="tasks.team"
        fetcher={async ({ q, page, pageSize, filters, sort }) => {
          let rows = tasks;
          const states: string[] = filters.status ?? [];
          if (states.length) rows = rows.filter((r) => states.includes(r.status));
          if (q) {
            const n = q.toLowerCase();
            rows = rows.filter((r) => r.title.toLowerCase().includes(n) || String(r.id).includes(n));
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
        refreshKey={tasks.length}
        rowKey={(r) => r.id}
        searchPlaceholder="Cerca per titolo o #id…"
        onRowClick={(r) => nav(`/team-tasks/${r.id}`)}
        chipFilters={[
          {
            key: 'status', label: 'Stato', multi: true,
            options: [
              { value: 'running',   label: 'In corso',  tone: 'accent' },
              { value: 'done',      label: 'Completi',  tone: 'on' },
              { value: 'error',     label: 'Errori',    tone: 'err' },
              { value: 'cancelled', label: 'Annullati', tone: 'warn' },
              { value: 'pending',   label: 'In attesa', tone: 'default' },
            ],
          },
        ]}
        columns={[
          {
            key: 'title', header: 'Titolo', sortable: true,
            render: (r) => (
              <div className="min-w-0">
                <div className="font-medium truncate">{r.title}</div>
                <div className="text-[10px] text-muted-foreground font-mono">#{r.id}</div>
              </div>
            ),
          },
          {
            key: 'status', header: 'Stato', sortable: true, width: 'w-32',
            render: (r) => statusChip(r.status),
          },
          {
            key: 'created_at', header: 'Avviato', sortable: true, width: 'w-44',
            render: (r) => <span className="text-xs text-muted-foreground font-mono">{new Date(r.created_at).toLocaleString('it-IT')}</span>,
          },
        ] as Column<Task>[]}
        emptyText="Nessun task ancora."
        toolbar={<Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> Nuovo team task</Button>}
      />
    </div>
  );
}
