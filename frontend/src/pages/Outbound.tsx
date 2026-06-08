import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Chip, useToast } from '../components/ui';
import { useWS } from '../ws';
import { Send, AlertCircle, X, MessageCircle, Mail, MessageSquare, Camera, Activity } from 'lucide-react';
import DataTable, { Column, ChipFilter } from '../components/DataTable';

type Channel = 'whatsapp' | 'email' | 'telegram' | 'instagram';
const CHANNEL_FALLBACK = { label: '—', icon: Activity, color: 'text-muted-foreground' };
type Status = 'sent' | 'error';

type Row = {
  id: number;
  ts: string;
  channel: Channel;
  status: Status;
  recipient: string | null;
  recipient_name: string | null;
  subject: string | null;
  body_preview: string;
  origin: string | null;
  error: string | null;
  meta: any;
};

const CHANNEL_META: Record<Channel, { label: string; icon: any; color: string }> = {
  whatsapp: { label: 'WhatsApp', icon: MessageCircle, color: 'text-emerald-300' },
  email: { label: 'Email', icon: Mail, color: 'text-sky-300' },
  telegram: { label: 'Telegram', icon: MessageSquare, color: 'text-blue-300' },
  instagram: { label: 'Instagram', icon: Camera, color: 'text-pink-300' },
};

function fmtDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Outbound() {
  const [openRow, setOpenRow] = useState<any | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [totals, setTotals] = useState<any>({ total: 0, errors: 0, whatsapp: 0, email: 0, telegram: 0, instagram: 0 });
  const toast = useToast();

  useWS((msg) => { if (msg?.type === 'outbound') setRefreshKey((k) => k + 1); });

  async function openDetail(row: Row) {
    try { setOpenRow(await api.outboundGet(row.id)); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  const columns: Column<Row>[] = [
    { key: 'ts', header: 'Quando', width: 'w-44', render: (r) => <span className="text-[10px] text-muted-foreground font-mono">{fmtDate(r.ts)}</span> },
    { key: 'channel', header: 'Canale', width: 'w-28', render: (r) => {
      const m = CHANNEL_META[r.channel] ?? CHANNEL_FALLBACK;
      const I = m.icon;
      return <span className="inline-flex items-center gap-1.5 text-xs"><I size={13} className={m.color} />{m.label}</span>;
    }},
    { key: 'status', header: 'Stato', width: 'w-24', render: (r) => r.status === 'sent'
      ? <Chip tone="on">✓ inviato</Chip>
      : <Chip tone="err"><AlertCircle size={10} className="inline mr-1 -mt-0.5" />errore</Chip>
    },
    { key: 'recipient', header: 'Destinatario', render: (r) => (
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{r.recipient_name || r.recipient || '—'}</div>
        {r.subject && <div className="text-[11px] text-muted-foreground truncate">{r.subject}</div>}
      </div>
    )},
    { key: 'body_preview', header: 'Contenuto', render: (r) => (
      <div className="text-xs text-muted-foreground line-clamp-2 max-w-[420px]">{r.body_preview}</div>
    )},
    { key: 'origin', header: 'Origine', width: 'w-32', render: (r) => r.origin ? (
      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${r.origin.startsWith('perk:') ? 'bg-accent/15 text-accent border border-accent/30' : r.origin.startsWith('subagent:') ? 'bg-accent2/15 text-accent2 border border-accent2/30' : r.origin === 'agent' ? 'bg-sky-500/15 text-sky-300 border border-sky-400/30' : 'bg-surface2 text-muted-foreground border border-border'}`}>
        {r.origin.length > 22 ? r.origin.slice(0, 19) + '…' : r.origin}
      </span>
    ) : <span className="text-muted-foreground">—</span> },
  ];

  const chipFilters: ChipFilter[] = [
    {
      key: 'channels',
      label: 'Canale',
      multi: true,
      options: [
        { value: 'whatsapp', label: <>WhatsApp <span className="opacity-60">({totals.whatsapp ?? 0})</span></>, tone: 'on' },
        { value: 'email', label: <>Email <span className="opacity-60">({totals.email ?? 0})</span></>, tone: 'accent2' },
        { value: 'telegram', label: <>Telegram <span className="opacity-60">({totals.telegram ?? 0})</span></>, tone: 'accent' },
        { value: 'instagram', label: <>Instagram <span className="opacity-60">({totals.instagram ?? 0})</span></>, tone: 'accent2' },
      ],
    },
    {
      key: 'statuses',
      label: 'Stato',
      multi: true,
      options: [
        { value: 'sent', label: 'inviato', tone: 'on' },
        { value: 'error', label: <>errore <span className="opacity-60">({totals.errors ?? 0})</span></>, tone: 'err' },
      ],
    },
  ];

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Send className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">Comunicazioni inviate</h1>
          <Chip>{totals.total ?? 0} record</Chip>
        </div>
      </div>

      <DataTable<Row>
        fetcher={async ({ q, page, pageSize, filters }) => {
          const r = await api.outboundList({
            channels: filters.channels, statuses: filters.statuses, q,
            limit: pageSize, offset: page * pageSize,
          });
          setTotals(r.totals ?? totals);
          return { rows: r.rows, total: r.total };
        }}
        columns={columns}
        chipFilters={chipFilters}
        searchPlaceholder="Cerca destinatario, oggetto, contenuto…"
        rowKey={(r) => r.id}
        onRowClick={openDetail}
        refreshKey={refreshKey}
        emptyText="Nessuna comunicazione inviata."
      />

      {openRow && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setOpenRow(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                {(() => { const M = CHANNEL_META[openRow.channel as Channel] ?? CHANNEL_FALLBACK; const I = M.icon; return <I size={18} className={M.color} />; })()}
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{openRow.recipient_name || openRow.recipient || '—'}</div>
                  <div className="text-[10px] text-muted-foreground font-mono truncate">{fmtDate(openRow.ts)} · {openRow.channel}</div>
                </div>
              </div>
              <button onClick={() => setOpenRow(null)} className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground hover:text-text"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto p-5 flex-1 space-y-3">
              {openRow.subject && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Oggetto</div>
                  <div className="text-sm font-medium">{openRow.subject}</div>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Destinatario</div>
                <div className="text-xs font-mono break-all">{openRow.recipient}</div>
                {openRow.recipient_name && <div className="text-xs text-muted-foreground">({openRow.recipient_name})</div>}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Origine</div>
                <div className="text-xs font-mono">{openRow.origin ?? '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Stato</div>
                <Chip tone={openRow.status === 'sent' ? 'on' : 'err'}>{openRow.status}</Chip>
              </div>
              {openRow.error && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Errore</div>
                  <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap break-all bg-red-500/5 border border-red-400/20 rounded-xl p-3">{openRow.error}</pre>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Contenuto</div>
                <pre className="text-sm whitespace-pre-wrap break-words bg-surface2/40 border border-border rounded-xl p-3">{openRow.body || '—'}</pre>
              </div>
              {openRow.meta && Object.keys(openRow.meta).length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground tracking-wider mb-1">Meta</div>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-surface2/40 border border-border rounded-xl p-3">{JSON.stringify(openRow.meta, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
