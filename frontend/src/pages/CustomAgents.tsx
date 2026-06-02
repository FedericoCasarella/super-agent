import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Plus, Bot, Trash2 } from 'lucide-react';

type Agent = {
  id: number; name: string; role: string | null; description: string | null;
  system_prompt: string; skills: string[]; model: string | null; icon: string | null; color: string | null;
};

const COMMON_SKILLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch',
  'mcp__super_agent__agent_brain_search',
  'mcp__super_agent__people_search', 'mcp__super_agent__people_get', 'mcp__super_agent__people_upsert',
  'mcp__super_agent__imap_search', 'mcp__super_agent__imap_propose_reply',
  'mcp__super_agent__agent_roadmap_get', 'mcp__super_agent__agent_roadmap_update',
  'mcp__super_agent__team_delegate',
];

export default function CustomAgentsPage() { return <CustomAgentsPanel />; }

export function CustomAgentsPanel() {
  const [items, setItems] = useState<Agent[]>([]);
  const [open, setOpen] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const dlg = useDialog();
  const nav = useNavigate();

  async function load() {
    try { setItems(await api.customAgentsList()); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  useEffect(() => { load(); }, []);

  async function save(a: Agent) {
    try {
      if (a.id) { await api.customAgentUpdate(a.id, a); toast.push('Aggiornato', 'on'); }
      else { await api.customAgentCreate(a); toast.push('Creato', 'on'); }
      setOpen(null); setCreating(false); load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function del(a: Agent) {
    if (!await dlg.confirm(`Archiviare "${a.name}"?`, { tone: 'danger', confirmLabel: 'Archivia' })) return;
    try { await api.customAgentDelete(a.id); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Chip>{items.length}</Chip>
        <Button variant="ghost" size="sm" onClick={() => nav('/teams')}>Teams</Button>
        <Button size="sm" onClick={() => { setCreating(true); setOpen({ id: 0 as any, name: '', role: '', description: '', system_prompt: '', skills: [], model: null, icon: null, color: null }); }}>
          <Plus size={14} className="inline mr-1 -mt-0.5" />Nuovo custom agent
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((a) => (
          <div key={a.id} onClick={() => { setCreating(false); setOpen(a); }} className="cursor-pointer hover:translate-y-[-2px] transition"><Card>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg shrink-0" style={{ background: (a.color ?? '#c084fc') + '22', border: `1px solid ${a.color ?? '#c084fc'}55` }}>
                  {a.icon || '🤖'}
                </div>
                <div className="min-w-0">
                  <div className="font-semibold truncate">{a.name}</div>
                  {a.role && <div className="text-xs text-muted truncate">{a.role}</div>}
                </div>
              </div>
              <button onClick={(e) => { e.stopPropagation(); del(a); }} className="text-muted hover:text-red-300 p-1"><Trash2 size={13} /></button>
            </div>
            {a.description && <p className="text-xs text-muted mt-2 line-clamp-2">{a.description}</p>}
            <div className="mt-2 flex flex-wrap gap-1">
              {(a.skills ?? []).slice(0, 4).map((s) => <span key={s} className="text-[9px] px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted font-mono">{s.replace(/^mcp__super_agent__/, '')}</span>)}
              {(a.skills?.length ?? 0) > 4 && <span className="text-[9px] text-muted">+{a.skills.length - 4}</span>}
            </div>
          </Card></div>
        ))}
        {items.length === 0 && <Card><div className="text-muted text-sm">Nessun agente. Crea il primo.</div></Card>}
      </div>

      {open && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => { setOpen(null); setCreating(false); }}>
          <div onClick={(e: any) => e.stopPropagation()} className="w-full max-w-2xl max-h-[90vh] overflow-y-auto"><Card>
            <div className="font-semibold text-lg mb-3">{creating ? 'Nuovo agente' : `Modifica ${open.name}`}</div>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nome"><Input value={open.name} onChange={(e) => setOpen({ ...open, name: e.target.value })} /></Field>
                <Field label="Ruolo"><Input value={open.role ?? ''} onChange={(e) => setOpen({ ...open, role: e.target.value })} placeholder="es. Lead Researcher" /></Field>
              </div>
              <Field label="Descrizione"><Input value={open.description ?? ''} onChange={(e) => setOpen({ ...open, description: e.target.value })} /></Field>
              <Field label="Model">
                <select value={open.model ?? ''} onChange={(e) => setOpen({ ...open, model: e.target.value || null })} className="w-full bg-surface2 border border-border rounded-lg px-2 py-1.5 text-sm">
                  <option value="">default</option>
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="claude-opus-4-7">claude-opus-4-7</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5</option>
                </select>
              </Field>
              <Field label="System prompt (chi è, come lavora, regole)">
                <textarea value={open.system_prompt} onChange={(e) => setOpen({ ...open, system_prompt: e.target.value })} className="w-full bg-surface2 border border-border rounded-lg px-3 py-2 text-sm font-mono min-h-[160px]" placeholder="Sei un copywriter esperto..." />
              </Field>
              <Field label="Skills (tool consentiti)">
                <div className="flex flex-wrap gap-1.5 max-h-[140px] overflow-y-auto border border-border rounded-lg p-2 bg-surface2/40">
                  {COMMON_SKILLS.map((s) => {
                    const active = (open.skills ?? []).includes(s);
                    return (
                      <button key={s} onClick={() => setOpen({ ...open, skills: active ? open.skills.filter((x) => x !== s) : [...(open.skills ?? []), s] })} className={`text-[10px] px-2 py-1 rounded-full font-mono ${active ? 'bg-accent/20 text-accent border border-accent/40' : 'bg-surface border border-border text-muted'}`}>
                        {s.replace(/^mcp__super_agent__/, '')}
                      </button>
                    );
                  })}
                </div>
              </Field>
              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <Button variant="ghost" onClick={() => { setOpen(null); setCreating(false); }}>Annulla</Button>
                <Button onClick={() => save(open)} disabled={!open.name || !open.system_prompt}>Salva</Button>
              </div>
            </div>
          </Card></div>
        </div>,
        document.body,
      )}
    </div>
  );
}
