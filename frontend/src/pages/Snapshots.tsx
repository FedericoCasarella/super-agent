import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Archive, Camera, FolderOpen, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import DataTable, { Column } from '../components/DataTable';

type Snapshot = {
  id: number;
  vault_name: string;
  vault_path: string;
  snapshot_dir: string;
  file_count: number;
  size_bytes: number;
  neurons_count: number;
  links_count: number;
  duration_ms: number;
  trigger: 'cron' | 'manual';
  status: 'ok' | 'error';
  error: string | null;
  created_at: string;
};

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${(n / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}

function fmtDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Snapshots() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [running, setRunning] = useState(false);
  const [dirInput, setDirInput] = useState('');
  const [dirSaved, setDirSaved] = useState('');
  const toast = useToast();
  const dlg = useDialog();

  useEffect(() => {
    api.brainSnapshotDirGet().then((r) => { setDirInput(r.dir); setDirSaved(r.dir); }).catch(() => {});
  }, []);

  async function runNow() {
    setRunning(true);
    try {
      const r = await api.brainSnapshotRun();
      toast.push(`✓ ${r.snapshots.length} snapshot creati`, 'on');
      setRefreshKey((k) => k + 1);
    } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
    finally { setRunning(false); }
  }

  async function saveDir() {
    try {
      const r = await api.brainSnapshotDirSet(dirInput.trim());
      setDirSaved(r.dir);
      toast.push('Cartella aggiornata', 'on');
    } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
  }

  async function restore(s: Snapshot) {
    const ok = await dlg.confirm(
      `Ripristinare lo snapshot del ${fmtDate(s.created_at)}?\n\n` +
      `Il cervello "${s.vault_name}" verrà sovrascritto con questa copia (${s.file_count} file, ${fmtBytes(s.size_bytes)}).\n\n` +
      `Lo stato CORRENTE viene salvato automaticamente come snapshot di sicurezza, quindi puoi tornare indietro se serve.`,
      { tone: 'danger', confirmLabel: 'Ripristina' },
    );
    if (!ok) return;
    try {
      const r = await api.brainSnapshotRestore(s.id);
      if (r.ok) {
        toast.push(`✓ Ripristinati ${r.restored ?? 0} file. Snapshot di sicurezza #${r.safety_snapshot_id ?? '?'} creato.`, 'on');
        setRefreshKey((k) => k + 1);
      } else {
        toast.push(r.error ?? 'Errore ripristino', 'err');
      }
    } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
  }

  async function del(id: number) {
    if (!await dlg.confirm('Eliminare questo snapshot?\n\nVerrà rimossa anche la cartella copiata.', { tone: 'danger', confirmLabel: 'Elimina' })) return;
    try {
      await api.brainSnapshotDelete(id);
      toast.push('Snapshot eliminato', 'on');
      setRefreshKey((k) => k + 1);
    } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
  }

  const columns: Column<Snapshot>[] = [
    { key: 'created_at', header: 'Quando', width: 'w-44', render: (s) => (
      <span className="font-mono text-xs">{fmtDate(s.created_at)}</span>
    )},
    { key: 'vault_name', header: 'Cervello', render: (s) => (
      <div className="min-w-0">
        <div className="font-medium text-sm truncate">{s.vault_name}</div>
        <div className="text-[10px] text-muted-foreground font-mono truncate">{s.vault_path}</div>
      </div>
    )},
    { key: 'trigger', header: 'Origine', width: 'w-24', render: (s) => (
      <Badge variant={s.trigger === 'cron' ? 'secondary' : 'default'}>
        {s.trigger === 'cron' ? 'cron' : 'manuale'}
      </Badge>
    )},
    { key: 'neurons_count', header: 'Neuroni', align: 'right', width: 'w-24', render: (s) => (
      <span className="font-mono text-sm">{s.neurons_count.toLocaleString()}</span>
    )},
    { key: 'links_count', header: 'Collegamenti', align: 'right', width: 'w-28', render: (s) => (
      <span className="font-mono text-sm">{s.links_count.toLocaleString()}</span>
    )},
    { key: 'file_count', header: 'File', align: 'right', width: 'w-20', render: (s) => (
      <span className="font-mono text-sm">{s.file_count.toLocaleString()}</span>
    )},
    { key: 'size_bytes', header: 'Peso', align: 'right', width: 'w-24', render: (s) => (
      <span className="font-mono text-sm">{fmtBytes(s.size_bytes)}</span>
    )},
    { key: 'status', header: 'Stato', width: 'w-20', render: (s) => s.status === 'ok'
      ? <Badge variant="success">ok</Badge>
      : <Badge variant="destructive" title={s.error ?? ''}>error</Badge>
    },
    { key: 'actions', header: '', width: 'w-24', align: 'right', render: (s) => (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => restore(s)}
          title="Ripristina questo snapshot"
          disabled={s.status !== 'ok'}
        >
          <RotateCcw className="h-3.5 w-3.5 text-primary" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => del(s.id)} title="Elimina">
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
    )},
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6 h-full flex flex-col">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Archive className="h-5 w-5" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">Snapshot</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Backup nightly del vault. Ogni copia archiviata su disco, conteggia neuroni e collegamenti.
          </p>
        </div>
        <Button onClick={runNow} disabled={running}>
          <Camera className="h-4 w-4" />
          {running ? 'Sto creando…' : 'Crea snapshot ora'}
        </Button>
      </div>

      <Card>
        <div className="p-5 space-y-1.5">
          <Label htmlFor="snap-dir" className="text-xs uppercase tracking-wider text-muted-foreground">
            Cartella backup esterna
          </Label>
          <div className="flex items-center gap-2 flex-wrap">
            <Input
              id="snap-dir"
              value={dirInput}
              onChange={(e) => setDirInput(e.target.value)}
              placeholder="/Users/federico/Backups/super-agent"
              className="font-mono text-xs flex-1 min-w-[260px]"
            />
            <Button
              onClick={saveDir}
              disabled={!dirInput.trim() || dirInput.trim() === dirSaved}
              variant="outline"
              size="sm"
            >
              <FolderOpen className="h-4 w-4" /> Salva
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground pt-1">
            Cron <code className="font-mono text-foreground/80">0 0 * * *</code>. Default:{' '}
            <code className="font-mono text-foreground/80">~/.super-agent/snapshots/u&lt;id&gt;</code>
          </p>
        </div>
      </Card>

      <DataTable<Snapshot>
        persistKey="snapshots"
        fetcher={async ({ q: _q, page, pageSize }) => {
          const r = await api.brainSnapshots({ limit: pageSize, offset: page * pageSize });
          return { rows: r.rows, total: r.total };
        }}
        columns={columns}
        refreshKey={refreshKey}
        rowKey={(s) => s.id}
        emptyText="Nessuno snapshot ancora. Il primo verrà creato stanotte alle 00:00 oppure premi “Crea snapshot ora”."
      />
    </div>
  );
}
