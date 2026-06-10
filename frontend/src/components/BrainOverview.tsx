import { useEffect, useState } from 'react';
import { api } from '../api';
import BrainLoading from './BrainLoading';

type Stats = {
  totals: { notes: number; files: number; bytes: number; vaults: number; updatedLast7Days: number; lastUpdate: string | null };
  vaults: { name: string; path: string; is_primary: boolean; bytes: number; files: number }[];
  byKind: { kind: string; n: number }[];
  byVisibility: { visibility: string | null; n: number }[];
  byOrigin: { origin_email: string | null; n: number }[];
};

const KIND_COLOR: Record<string, string> = {
  note: '#fbbf24',
  person: '#22d3ee',
  email: '#c084fc',
  project: '#34d399',
  daily: '#f0abfc',
  roadmap: '#f97316',
  task: '#a78bfa',
  attachment: '#94a3b8',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtAgo(ts: string | null): string {
  if (!ts) return 'mai';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s fa`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}g fa`;
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

export default function BrainOverview() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.brainStats().then(setStats).catch((e) => setErr(String(e?.message ?? e)));
  }, []);

  if (err) return <div className="text-sm text-red-300">Errore: {err}</div>;
  if (!stats) return <BrainLoading size={80} label="Caricamento…" />;

  const totalKind = stats.byKind.reduce((a, k) => a + k.n, 0) || 1;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Il tuo cervello</h2>
        <p className="text-xs text-muted-foreground mt-1">Panoramica · clicca un nodo nel grafo per leggere la nota</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="border border-border rounded-2xl p-3 bg-surface2/40">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Neuroni</div>
          <div className="text-2xl font-semibold mt-1">{stats.totals.notes.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">{stats.totals.files} file totali</div>
        </div>
        <div className="border border-border rounded-2xl p-3 bg-surface2/40">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Peso</div>
          <div className="text-2xl font-semibold mt-1">{fmtBytes(stats.totals.bytes)}</div>
          <div className="text-xs text-muted-foreground mt-1">{stats.totals.vaults} cervell{stats.totals.vaults === 1 ? 'o' : 'i'}</div>
        </div>
        <div className="border border-border rounded-2xl p-3 bg-surface2/40">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Attività 7gg</div>
          <div className="text-2xl font-semibold mt-1">{stats.totals.updatedLast7Days}</div>
          <div className="text-xs text-muted-foreground mt-1">note aggiornate</div>
        </div>
        <div className="border border-border rounded-2xl p-3 bg-surface2/40">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Ultimo update</div>
          <div className="text-2xl font-semibold mt-1">{fmtAgo(stats.totals.lastUpdate)}</div>
          <div className="text-xs text-muted-foreground mt-1">{stats.totals.lastUpdate ? new Date(stats.totals.lastUpdate).toLocaleString() : '—'}</div>
        </div>
      </div>

      {stats.vaults.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2 font-semibold">Cervelli collegati</div>
          <ul className="space-y-1.5">
            {stats.vaults.map((v) => (
              <li key={v.name} className="flex items-center justify-between gap-3 text-sm border border-border rounded-xl px-3 py-2 bg-surface2/30">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs">{v.is_primary ? '★' : '·'}</span>
                  <span className="font-medium truncate">{v.name}</span>
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-3 shrink-0">
                  <span>{v.files} file</span>
                  <span className="font-mono">{fmtBytes(v.bytes)}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {stats.byKind.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2 font-semibold">Per tipo</div>
          <div className="flex h-2 rounded-full overflow-hidden border border-border bg-surface2/30">
            {stats.byKind.map((k) => (
              <div key={k.kind} style={{ width: `${(k.n / totalKind) * 100}%`, background: KIND_COLOR[k.kind] ?? '#c084fc' }} title={`${k.kind}: ${k.n}`} />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">
            {stats.byKind.map((k) => (
              <div key={k.kind} className="flex items-center gap-1.5">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: KIND_COLOR[k.kind] ?? '#c084fc' }} />
                <span className="text-muted-foreground">{k.kind}</span>
                <span className="font-mono">{k.n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.byVisibility.some((v) => v.visibility) && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2 font-semibold">Visibilità</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {stats.byVisibility.map((v) => (
              <div key={String(v.visibility)} className="border border-border rounded-full px-2.5 py-1 bg-surface2/40">
                {v.visibility === 'public' ? '◇ pubblici' : v.visibility === 'protected' ? '◆ protetti' : '· non classificati'} · <span className="font-mono">{v.n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.byOrigin.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2 font-semibold">Note importate da peer</div>
          <ul className="space-y-1 text-xs">
            {stats.byOrigin.map((o) => (
              <li key={o.origin_email ?? 'none'} className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: `hsl(${hashHue(o.origin_email ?? '')}, 70%, 62%)` }} />
                <span className="truncate">{o.origin_email}</span>
                <span className="font-mono text-muted-foreground ml-auto">{o.n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-[10px] text-muted-foreground leading-relaxed pt-2 border-t border-border">
        ◇ cyan = pubblico · ◆ fuchsia = protetto (gestito dal Brain Classifier).<br />
        I particles tra nodi mostrano il flusso. Verde MRI = nodo letto dall'agente in tempo reale.
      </div>
    </div>
  );
}
