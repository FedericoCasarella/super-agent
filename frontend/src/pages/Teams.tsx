import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Plus, Users, Trash2 } from 'lucide-react';
import DataTable, { Column } from '../components/DataTable';

type Team = { id: number; name: string; description: string | null; members_count?: number };
type Member = { agent_id: number; role: 'lead' | 'member'; reports_to: number | null; position: number; agent?: any };
type TeamFull = Team & { members: Member[] };
type Agent = { id: number; name: string; role: string | null; icon: string | null; color: string | null };

export default function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<TeamFull | null>(null);
  const toast = useToast();
  const dlg = useDialog();
  const nav = useNavigate();

  async function load() {
    try {
      const [t, a] = await Promise.all([api.teamsList(), api.customAgentsList()]);
      setTeams(t); setAgents(a);
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  useEffect(() => { load(); }, []);

  async function openTeam(t: Team) {
    try { setEditing(await api.teamGet(t.id)); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function createTeam() {
    const name = await dlg.prompt('Nome del team?', { title: 'Nuovo team', placeholder: 'es. Marketing crew' });
    if (!name) return;
    try {
      const t = await api.teamCreate({ name, description: '' });
      setEditing(await api.teamGet(t.id));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function saveTeam() {
    if (!editing) return;
    try {
      await api.teamUpdate(editing.id, { name: editing.name, description: editing.description });
      await api.teamSetMembers(editing.id, editing.members.map((m, i) => ({
        agent_id: m.agent_id, role: m.role, reports_to: m.reports_to, position: i,
      })));
      toast.push('Team salvato', 'on');
      setEditing(null); load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function deleteTeam(t: Team) {
    if (!await dlg.confirm(`Archiviare team "${t.name}"?`, { title: 'Conferma', tone: 'danger', confirmLabel: 'Archivia' })) return;
    try { await api.teamDelete(t.id); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  function addMember(agentId: number) {
    if (!editing) return;
    if (editing.members.some((m) => m.agent_id === agentId)) return;
    const role: 'lead' | 'member' = editing.members.length === 0 ? 'lead' : 'member';
    setEditing({ ...editing, members: [...editing.members, { agent_id: agentId, role, reports_to: null, position: editing.members.length, agent: agents.find((a) => a.id === agentId) }] });
  }
  function removeMember(agentId: number) {
    if (!editing) return;
    setEditing({ ...editing, members: editing.members.filter((m) => m.agent_id !== agentId).map((m) => ({ ...m, reports_to: m.reports_to === agentId ? null : m.reports_to })) });
  }
  function patchMember(agentId: number, patch: Partial<Member>) {
    if (!editing) return;
    setEditing({ ...editing, members: editing.members.map((m) => m.agent_id === agentId ? { ...m, ...patch } : m) });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Users className="text-accent" size={22} />
        <h1 className="text-2xl font-semibold text-gradient">Teams</h1>
        <Chip>{teams.length}</Chip>
      </div>

      <DataTable<Team>
        persistKey="teams"
        refreshKey={teams.length}
        fetcher={async ({ q, page, pageSize, sort }) => {
          let rows = teams;
          if (q) {
            const n = q.toLowerCase();
            rows = rows.filter((r) => r.name.toLowerCase().includes(n) || (r.description ?? '').toLowerCase().includes(n));
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
        rowKey={(t) => t.id}
        onRowClick={(t) => openTeam(t)}
        searchPlaceholder="Cerca per nome o descrizione…"
        columns={[
          { key: 'name', header: 'Nome', sortable: true, render: (t) => <span className="font-medium">{t.name}</span> },
          { key: 'description', header: 'Descrizione', render: (t) => <span className="text-xs text-muted-foreground line-clamp-2">{t.description ?? '—'}</span> },
          { key: 'members_count', header: 'Agenti', sortable: true, width: 'w-20', align: 'right', render: (t) => <span className="font-mono text-xs tabular-nums">{t.members_count ?? 0}</span> },
          {
            key: 'actions', header: '', width: 'w-12', align: 'right',
            render: (t) => (
              <button onClick={(e) => { e.stopPropagation(); deleteTeam(t); }} className="text-muted-foreground hover:text-red-300 p-1"><Trash2 size={13} /></button>
            ),
          },
        ] as Column<Team>[]}
        emptyText="Nessun team. Crea il primo."
        toolbar={
          <Button size="sm" onClick={createTeam}><Plus size={14} /> Nuovo team</Button>
        }
      />

      {editing && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setEditing(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <Card className="space-y-4">
              <div className="font-semibold text-lg">Edit team</div>

              <Field label="Nome">
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>

              <Field label="Descrizione">
                <Input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>

              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-2 font-semibold">Membri del team</div>
                <div className="space-y-2">
                  {editing.members.map((m) => {
                    const ag = agents.find((a) => a.id === m.agent_id);
                    return (
                      <div key={m.agent_id} className="flex items-center gap-3 border border-border rounded-xl p-3 bg-surface2/40">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm" style={{ background: (ag?.color ?? '#c084fc') + '22', border: `1px solid ${ag?.color ?? '#c084fc'}55` }}>
                          {ag?.icon || '🤖'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm truncate">{ag?.name ?? `#${m.agent_id}`}</div>
                          {ag?.role && <div className="text-xs text-muted-foreground truncate">{ag.role}</div>}
                        </div>
                        <select value={m.role} onChange={(e) => patchMember(m.agent_id, { role: e.target.value as any })} className="bg-surface2 border border-border rounded-md px-2 py-1 text-xs">
                          <option value="lead">Lead</option>
                          <option value="member">Member</option>
                        </select>
                        <select value={m.reports_to ?? ''} onChange={(e) => patchMember(m.agent_id, { reports_to: e.target.value ? Number(e.target.value) : null })} className="bg-surface2 border border-border rounded-md px-2 py-1 text-xs max-w-[140px]">
                          <option value="">no supervisor</option>
                          {editing.members.filter((x) => x.agent_id !== m.agent_id).map((x) => (
                            <option key={x.agent_id} value={x.agent_id}>↑ {agents.find((a) => a.id === x.agent_id)?.name ?? `#${x.agent_id}`}</option>
                          ))}
                        </select>
                        <button onClick={() => removeMember(m.agent_id)} className="text-muted-foreground hover:text-red-300 p-1"><Trash2 size={13} /></button>
                      </div>
                    );
                  })}
                  {editing.members.length === 0 && <div className="text-xs text-muted-foreground">Nessun membro. Aggiungi dal selettore qui sotto.</div>}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-2 font-semibold">Aggiungi membro</div>
                <div className="flex flex-wrap gap-2">
                  {agents.filter((a) => !editing.members.some((m) => m.agent_id === a.id)).map((a) => (
                    <button key={a.id} onClick={() => addMember(a.id)} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-border bg-surface2/60 hover:border-accent/40 text-xs">
                      <span>{a.icon || '🤖'}</span><span>{a.name}</span>
                    </button>
                  ))}
                  {agents.filter((a) => !editing.members.some((m) => m.agent_id === a.id)).length === 0 && <div className="text-xs text-muted-foreground">Tutti gli agenti sono già nel team.</div>}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3 border-t border-border">
                <Button variant="ghost" onClick={() => setEditing(null)}>Annulla</Button>
                <Button onClick={saveTeam}>Salva</Button>
              </div>
            </Card>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
