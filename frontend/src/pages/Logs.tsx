import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, Modal } from '../components/ui';
import { useI18n } from '../i18n';

type Row = {
  id: number; ts: string; kind: string; status: string; model: string;
  duration_ms: number; input_tokens: number; output_tokens: number;
  cache_creation_tokens: number; cache_read_tokens: number;
  cost_usd: number | null; num_turns: number; preview: string;
  meta: any; error: string | null;
};

const KIND_TONE: Record<string, 'on' | 'warn' | 'err' | 'default'> = {
  chat_turn: 'on',
  reflection: 'warn',
  proactive: 'default',
  voice_transcribe: 'default',
};

function fmtUsd(v: number | null | undefined) {
  if (v == null) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
function fmtNum(n: number | null | undefined) { return n == null ? '—' : Intl.NumberFormat().format(n); }

export default function Logs() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [kind, setKind] = useState<string>('');
  const [open, setOpen] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();

  async function load() {
    setLoading(true);
    try {
      const [r, s] = await Promise.all([api.logs(kind || undefined, 200), api.logStats()]);
      setRows(r); setStats(s);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [kind]);

  async function openDetail(id: number) {
    setOpen(await api.log(id));
  }

  const kinds = ['', 'chat_turn', 'reflection', 'proactive', 'voice_transcribe'];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gradient">{t('logs.title')}</h1>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>{loading ? '…' : t('logs.refresh')}</Button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><div className="text-xs text-muted uppercase">{t('logs.today')}</div><div className="text-2xl font-semibold mt-1">{fmtUsd(stats.today?.cost)}</div><div className="text-xs text-muted">{stats.today?.runs ?? 0} {t('logs.runs')}</div></Card>
          <Card><div className="text-xs text-muted uppercase">{t('logs.allTime')}</div><div className="text-2xl font-semibold mt-1">{fmtUsd(stats.allTime?.cost)}</div><div className="text-xs text-muted">{stats.allTime?.runs ?? 0} {t('logs.runs')}</div></Card>
          <Card><div className="text-xs text-muted uppercase">Reflection (today)</div><div className="text-2xl font-semibold mt-1">{fmtUsd((stats.byDay ?? []).filter((d: any) => d.kind === 'reflection' && d.day?.slice(0,10) === new Date().toISOString().slice(0,10)).reduce((a: number, x: any) => a + (x.cost || 0), 0))}</div><div className="text-xs text-muted">2-min cycle</div></Card>
          <Card><div className="text-xs text-muted uppercase">Chat (today)</div><div className="text-2xl font-semibold mt-1">{fmtUsd((stats.byDay ?? []).filter((d: any) => d.kind === 'chat_turn' && d.day?.slice(0,10) === new Date().toISOString().slice(0,10)).reduce((a: number, x: any) => a + (x.cost || 0), 0))}</div><div className="text-xs text-muted">user turns</div></Card>
        </div>
      )}

      <div className="flex items-center gap-2">
        {kinds.map((k) => (
          <Button key={k || 'all'} variant={kind === k ? 'primary' : 'ghost'} size="sm" onClick={() => setKind(k)}>
            {k || 'all'}
          </Button>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="text-xs uppercase text-muted bg-surface2/50">
            <tr>
              <th className="text-left px-4 py-2.5">{t('logs.time')}</th>
              <th className="text-left px-4 py-2.5">{t('logs.kind')}</th>
              <th className="text-left px-4 py-2.5">{t('logs.status')}</th>
              <th className="text-right px-4 py-2.5">In</th>
              <th className="text-right px-4 py-2.5">Out</th>
              <th className="text-right px-4 py-2.5">Cache</th>
              <th className="text-right px-4 py-2.5">{t('logs.cost')}</th>
              <th className="text-right px-4 py-2.5">{t('logs.turns')}</th>
              <th className="text-right px-4 py-2.5">ms</th>
              <th className="text-left px-4 py-2.5">{t('logs.preview')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border/40 hover:bg-surface2/40 cursor-pointer" onClick={() => openDetail(r.id)}>
                <td className="px-4 py-2 font-mono text-xs text-muted whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                <td className="px-4 py-2"><Chip tone={KIND_TONE[r.kind] ?? 'default'}>{r.kind}</Chip></td>
                <td className="px-4 py-2">{r.status === 'ok' ? <Chip tone="on">ok</Chip> : <Chip tone="err">{r.status}</Chip>}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtNum(r.input_tokens)}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtNum(r.output_tokens)}</td>
                <td className="px-4 py-2 text-right font-mono text-muted">{fmtNum((r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0))}</td>
                <td className="px-4 py-2 text-right font-mono">{fmtUsd(r.cost_usd ?? null)}</td>
                <td className="px-4 py-2 text-right font-mono">{r.num_turns ?? '—'}</td>
                <td className="px-4 py-2 text-right font-mono text-muted">{r.duration_ms}</td>
                <td className="px-4 py-2 text-muted truncate max-w-[280px]">{r.preview?.slice(0, 90) || '(empty)'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="text-center text-muted py-8">{t('logs.empty')}</td></tr>}
          </tbody>
        </table>
        </div>
      </Card>

      <Modal open={!!open} title={open ? `Run #${open.id} · ${open.kind}` : ''} onClose={() => setOpen(null)}>
        {open && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <Stat label="Cost" v={fmtUsd(open.cost_usd ?? null)} />
              <Stat label="Input tok" v={fmtNum(open.input_tokens)} />
              <Stat label="Output tok" v={fmtNum(open.output_tokens)} />
              <Stat label="Cache read" v={fmtNum(open.cache_read_tokens)} />
              <Stat label="Cache create" v={fmtNum(open.cache_creation_tokens)} />
              <Stat label="Turns" v={open.num_turns ?? '—'} />
              <Stat label="Duration" v={`${open.duration_ms} ms`} />
              <Stat label="Model" v={open.model ?? '—'} />
              <Stat label="Status" v={open.status} />
            </div>
            {open.error && <div className="text-err text-xs font-mono whitespace-pre-wrap bg-err/10 border border-err/30 rounded p-2">{open.error}</div>}
            <details>
              <summary className="cursor-pointer text-muted">Prompt ({(open.prompt ?? '').length} chars)</summary>
              <pre className="text-xs font-mono whitespace-pre-wrap bg-surface2 border border-border rounded p-3 mt-2 max-h-72 overflow-y-auto">{open.prompt}</pre>
            </details>
            <details open>
              <summary className="cursor-pointer text-muted">Result ({(open.result ?? '').length} chars)</summary>
              <pre className="text-xs font-mono whitespace-pre-wrap bg-surface2 border border-border rounded p-3 mt-2 max-h-72 overflow-y-auto">{open.result}</pre>
            </details>
            {open.meta && Object.keys(open.meta).length > 0 && (
              <details>
                <summary className="cursor-pointer text-muted">Meta</summary>
                <pre className="text-xs font-mono bg-surface2 border border-border rounded p-3 mt-2">{JSON.stringify(open.meta, null, 2)}</pre>
              </details>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: any }) {
  return (
    <div className="border border-border rounded-lg p-2 bg-surface2/40">
      <div className="text-[10px] uppercase text-muted tracking-wider">{label}</div>
      <div className="font-mono text-sm mt-0.5">{v}</div>
    </div>
  );
}
