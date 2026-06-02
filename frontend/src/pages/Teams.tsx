import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { Plus, Users, Trash2, Edit3 } from 'lucide-react';

type Team = { id: number; name: string; description: string | null };
type Member = { agent_id: number; role: 'lead' | 'member'; reports_to: number | null; position: number; agent?: any };
type TeamFull = Team & { members: Member[] };
type Agent = { id: number; name: string; role: string | null; icon: string | null; color: string | null };

export default function Teams() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [editing, setEditing] = useState<TeamFull | null>(null);
  const toast = useToast();
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
    const name = prompt('Nome del team?');
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
    if (!confirm(`Archiviare team "${t.name}"?`)) return;
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Users className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">Teams</h1>
          <Chip>{teams.length}</Chip>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => nav('/custom-agents')}>Custom Agents</Button>
          <Button variant="ghost" size="sm" onClick={() => nav('/team-tasks')}>Task</Button>
          <Button size="sm" onClick={createTeam}><Plus size={14} className="inline mr-1 -mt-0.5" />Nuovo team</Button>
        </div>
      </div>

      {!editing && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {teams.map((t) => (
            <div key={t.id} onClick={() => openTeam(t)} className="cursor-pointer hover:translate-y-[-2px] transition"><Card>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate">{t.name}</div>
                  {t.description && <div className="text-xs text-muted line-clamp-2 mt-1">{t.description}</div>}
                </div>
                <div className="flex gap-1">
                  <button onClick={(e) => { e.stopPropagation(); openTeam(t); }} className="text-muted hover:text-accent p-1"><Edit3 size={13} /></button>
                  <button onClick={(e) => { e.stopPropagation(); deleteTeam(t); }} className="text-muted hover:text-red-300 p-1"><Trash2 size={13} /></button>
                </div>
              </div>
            </Card></div>
          ))}
          {teams.length === 0 && <Card><div className="text-muted text-sm">Nessun team. Crea il primo.</div></Card>}
        </div>
      )}

      {editing && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-lg">Edit team</div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>Annulla</Button>
              <Button onClick={saveTeam}>Salva</Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nome"><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Descrizione"><Input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
          </div>
          <div>
            <div className="text-xs uppercase text-muted tracking-wider mb-2">Membri del team</div>
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
                      {ag?.role && <div className="text-xs text-muted truncate">{ag.role}</div>}
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
                    <button onClick={() => removeMember(m.agent_id)} className="text-muted hover:text-red-300 p-1"><Trash2 size={13} /></button>
                  </div>
                );
              })}
              {editing.members.length === 0 && <div className="text-xs text-muted">Nessun membro. Aggiungi dal selettore qui sotto.</div>}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted tracking-wider mb-2">Aggiungi membro</div>
            <div className="flex flex-wrap gap-2">
              {agents.filter((a) => !editing.members.some((m) => m.agent_id === a.id)).map((a) => (
                <button key={a.id} onClick={() => addMember(a.id)} className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-border bg-surface2/60 hover:border-accent/40 text-xs">
                  <span>{a.icon || '🤖'}</span><span>{a.name}</span>
                </button>
              ))}
              {agents.filter((a) => !editing.members.some((m) => m.agent_id === a.id)).length === 0 && <div className="text-xs text-muted">Tutti gli agenti sono già nel team.</div>}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
