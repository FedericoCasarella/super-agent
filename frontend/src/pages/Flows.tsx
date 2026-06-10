import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Chip, Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Plus, Workflow, Trash2 } from 'lucide-react';
import DataTable, { Column } from '../components/DataTable';

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
      <div className="flex items-center gap-3">
        <Workflow className="text-accent" size={22} />
        <h1 className="text-2xl font-semibold text-gradient">Flows</h1>
        <Chip>{items.length}</Chip>
      </div>

      <DataTable<FlowRow>
        persistKey="flows"
        refreshKey={items.length}
        fetcher={async ({ q, page, pageSize, filters, sort }) => {
          let rows = items;
          const state = filters.state ?? [];
          if (state.includes('on')) rows = rows.filter((r) => r.enabled);
          if (state.includes('off')) rows = rows.filter((r) => !r.enabled);
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
        rowKey={(f) => f.id}
        onRowClick={(f) => nav(`/flows/${f.id}`)}
        searchPlaceholder="Cerca per nome o descrizione…"
        chipFilters={[
          {
            key: 'state', label: 'Stato', multi: true,
            options: [
              { value: 'on',  label: 'Attivi',    tone: 'on' },
              { value: 'off', label: 'Disattivi', tone: 'warn' },
            ],
          },
        ]}
        columns={[
          { key: 'name', header: 'Nome', sortable: true, render: (f) => <span className="font-medium">{f.name}</span> },
          { key: 'description', header: 'Descrizione', render: (f) => <span className="text-xs text-muted-foreground line-clamp-2">{f.description ?? '—'}</span> },
          { key: 'created_at', header: 'Creato', sortable: true, width: 'w-44', render: (f) => <span className="text-xs text-muted-foreground font-mono">{new Date(f.created_at).toLocaleString('it-IT')}</span> },
          { key: 'enabled', header: 'Attivo', sortable: true, width: 'w-20', align: 'center', render: (f) => <Toggle checked={f.enabled} onChange={() => toggle(f)} /> },
          {
            key: 'actions', header: '', width: 'w-12', align: 'right',
            render: (f) => (
              <button onClick={(e) => { e.stopPropagation(); del(f); }} className="text-muted-foreground hover:text-red-300 p-1"><Trash2 size={13} /></button>
            ),
          },
        ] as Column<FlowRow>[]}
        emptyText="Nessun flow. Crea il primo."
        toolbar={<Button size="sm" onClick={create}><Plus size={14} /> Nuovo flow</Button>}
      />
    </div>
  );
}
