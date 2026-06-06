import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Chip, Modal } from '../components/ui';
import { useI18n } from '../i18n';
import DataTable, { Column, ChipFilter } from '../components/DataTable';

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
  const [stats, setStats] = useState<any>(null);
  const [open, setOpen] = useState<any | null>(null);
  const { t } = useI18n();

  useEffect(() => { api.logStats().then(setStats).catch(() => {}); }, []);

  const columns: Column<Row>[] = [
    { key: 'ts', header: t('logs.time'), width: 'w-44', render: (r) => <span className="font-mono text-xs text-muted whitespace-nowrap">{new Date(r.ts).toLocaleString()}</span> },
    { key: 'kind', header: t('logs.kind'), render: (r) => <Chip tone={KIND_TONE[r.kind] ?? 'default'}>{r.kind}</Chip> },
    { key: 'status', header: t('logs.status'), render: (r) => r.status === 'ok' ? <Chip tone="on">ok</Chip> : <Chip tone="err">{r.status}</Chip> },
    { key: 'input_tokens', header: 'In', align: 'right', render: (r) => <span className="font-mono">{fmtNum(r.input_tokens)}</span> },
    { key: 'output_tokens', header: 'Out', align: 'right', render: (r) => <span className="font-mono">{fmtNum(r.output_tokens)}</span> },
    { key: 'cache', header: 'Cache', align: 'right', render: (r) => <span className="font-mono text-muted">{fmtNum((r.cache_read_tokens ?? 0) + (r.cache_creation_tokens ?? 0))}</span> },
    { key: 'cost_usd', header: t('logs.cost'), align: 'right', render: (r) => <span className="font-mono">{fmtUsd(r.cost_usd ?? null)}</span> },
    { key: 'num_turns', header: t('logs.turns'), align: 'right', render: (r) => <span className="font-mono">{r.num_turns ?? '—'}</span> },
    { key: 'duration_ms', header: 'ms', align: 'right', render: (r) => <span className="font-mono text-muted">{r.duration_ms}</span> },
    { key: 'preview', header: t('logs.preview'), render: (r) => <span className="text-muted truncate block max-w-[280px]">{r.preview?.slice(0, 90) || '(empty)'}</span> },
  ];

  const chipFilters: ChipFilter[] = [
    {
      key: 'kind',
      label: 'Kind',
      multi: true,
      options: [
        { value: 'chat_turn', label: 'chat_turn', tone: 'on' },
        { value: 'reflection', label: 'reflection', tone: 'warn' },
        { value: 'proactive', label: 'proactive' },
        { value: 'voice_transcribe', label: 'voice' },
      ],
    },
    {
      key: 'status',
      label: 'Status',
      multi: true,
      options: [
        { value: 'ok', label: 'ok', tone: 'on' },
        { value: 'error', label: 'error', tone: 'err' },
        { value: 'timeout', label: 'timeout', tone: 'warn' },
      ],
    },
  ];

  async function openDetail(id: number) { setOpen(await api.log(id)); }

  return (
    <div className="space-y-5 h-full flex flex-col">
      <h1 className="text-2xl font-semibold text-gradient">{t('logs.title')}</h1>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card><div className="text-xs text-muted uppercase">{t('logs.today')}</div><div className="text-2xl font-semibold mt-1">{fmtUsd(stats.today?.cost)}</div><div className="text-xs text-muted">{stats.today?.runs ?? 0} {t('logs.runs')}</div></Card>
          <Card><div className="text-xs text-muted uppercase">{t('logs.allTime')}</div><div className="text-2xl font-semibold mt-1">{fmtUsd(stats.allTime?.cost)}</div><div className="text-xs text-muted">{stats.allTime?.runs ?? 0} {t('logs.runs')}</div></Card>
          <Card><div className="text-xs text-muted uppercase">Reflection (today)</div><div className="text-2xl font-semibold mt-1">{fmtUsd((stats.byDay ?? []).filter((d: any) => d.kind === 'reflection' && d.day?.slice(0,10) === new Date().toISOString().slice(0,10)).reduce((a: number, x: any) => a + (x.cost || 0), 0))}</div><div className="text-xs text-muted">2-min cycle</div></Card>
          <Card><div className="text-xs text-muted uppercase">Chat (today)</div><div className="text-2xl font-semibold mt-1">{fmtUsd((stats.byDay ?? []).filter((d: any) => d.kind === 'chat_turn' && d.day?.slice(0,10) === new Date().toISOString().slice(0,10)).reduce((a: number, x: any) => a + (x.cost || 0), 0))}</div><div className="text-xs text-muted">user turns</div></Card>
        </div>
      )}

      <DataTable<Row>
        fetcher={async ({ q, page, pageSize, filters }) => {
          const r = await api.logs({
            kinds: filters.kind, statuses: filters.status, q,
            limit: pageSize, offset: page * pageSize,
          });
          return r;
        }}
        columns={columns}
        chipFilters={chipFilters}
        searchPlaceholder="Cerca in prompt/result/error…"
        rowKey={(r) => r.id}
        onRowClick={(r) => openDetail(r.id)}
        emptyText="Nessun run."
      />

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
