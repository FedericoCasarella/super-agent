import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Plus, Workflow, Trash2 } from 'lucide-react';

type FlowRow = { id: number; name: string; description: string | null; enabled: boolean; created_at: string };

export default function FlowsPage() {
  const [items, setItems] = useState<FlowRow[]>([]);
  const toast = useToast();
  const dlg = useDialog();
  const nav = useNavigate();

  async function load() {
    try { setItems(await api.flowsList()); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    const name = await dlg.prompt('Nome del flow?', { title: 'Nuovo flow', placeholder: 'es. Onboarding cliente' });
    if (!name) return;
    try { const f = await api.flowCreate({ name }); nav(`/flows/${f.id}`); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function toggle(f: FlowRow) {
    try { await api.flowUpdate(f.id, { enabled: !f.enabled }); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function del(f: FlowRow) {
    const ok = await dlg.confirm(`Archiviare il flow "${f.name}"?`, { title: 'Conferma archiviazione', tone: 'danger', confirmLabel: 'Archivia' });
    if (!ok) return;
    try { await api.flowDelete(f.id); load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Workflow className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">Flows</h1>
          <Chip>{items.length}</Chip>
        </div>
        <Button size="sm" onClick={create}><Plus size={14} className="inline mr-1 -mt-0.5" />Nuovo flow</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((f) => (
          <div key={f.id} className="cursor-pointer" onClick={() => nav(`/flows/${f.id}`)}>
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="font-semibold truncate">{f.name}</div>
                    <Chip tone={f.enabled ? 'on' : 'warn'}>{f.enabled ? 'attivo' : 'spento'}</Chip>
                  </div>
                  {f.description && <div className="text-xs text-muted line-clamp-2 mt-1">{f.description}</div>}
                  <div className="text-[10px] text-muted font-mono mt-2">creato {new Date(f.created_at).toLocaleString('it-IT')}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <Toggle checked={f.enabled} onChange={() => toggle(f)} />
                  <button onClick={() => del(f)} className="text-muted hover:text-red-300 p-1"><Trash2 size={13} /></button>
                </div>
              </div>
            </Card>
          </div>
        ))}
        {items.length === 0 && <Card><div className="text-muted text-sm">Nessun flow. Crea il primo.</div></Card>}
      </div>
    </div>
  );
}
