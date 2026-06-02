import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { Button, Card, Chip, Input, useToast } from '../components/ui';
import { useWS } from '../ws';
import { Search, Send, AlertCircle, X, MessageCircle, Mail, MessageSquare } from 'lucide-react';

type Channel = 'whatsapp' | 'email' | 'telegram';
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
};

function fmtDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Outbound() {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<any>({ total: 0, errors: 0, whatsapp: 0, email: 0, telegram: 0 });
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [openRow, setOpenRow] = useState<any | null>(null);
  const toast = useToast();

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.outboundList({
        channel: channel === 'all' ? undefined : channel,
        status: status === 'all' ? undefined : status,
        q: q || undefined,
        limit: 200,
      });
      setRows(r.rows); setTotals(r.totals);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }, [channel, status, q, toast]);

  useEffect(() => { load(); }, [load]);

  // Live append on new outbound events
  useWS((msg) => {
    if (msg?.type !== 'outbound') return;
    load();
  });

  async function openDetail(row: Row) {
    try { setOpenRow(await api.outboundGet(row.id)); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  const filters = useMemo(() => (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-full p-1">
        {(['all', 'whatsapp', 'email', 'telegram'] as const).map((c) => (
          <Button key={c} size="sm" variant={channel === c ? 'primary' : 'ghost'} onClick={() => setChannel(c)}>
            {c === 'all' ? 'Tutti' : CHANNEL_META[c].label} {c !== 'all' && <span className="ml-1 text-[10px] text-muted">{totals[c] ?? 0}</span>}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-full p-1">
        {(['all', 'sent', 'error'] as const).map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'primary' : 'ghost'} onClick={() => setStatus(s)}>
            {s === 'all' ? 'Stato' : s === 'sent' ? '✓ inviato' : `✗ errore (${totals.errors ?? 0})`}
          </Button>
        ))}
      </div>
    </div>
  ), [channel, status, totals]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Send className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">Comunicazioni inviate</h1>
          <Chip>{totals.total ?? 0} record</Chip>
        </div>
        {filters}
      </div>

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Search size={16} className="text-muted" />
          <Input
            placeholder="Cerca destinatario, oggetto, contenuto…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="flex-1"
          />
        </div>
        {loading ? (
          <div className="py-10 text-center text-muted text-sm">Caricamento…</div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center text-muted text-sm">Nessuna comunicazione inviata.</div>
        ) : (
          <div className="space-y-1">
            {rows.map((r) => {
              const meta = CHANNEL_META[r.channel];
              const Icon = meta.icon;
              const recipient = r.recipient_name || r.recipient || '—';
              return (
                <button
                  key={r.id}
                  onClick={() => openDetail(r)}
                  className="w-full text-left flex items-start gap-3 p-3 rounded-xl border border-border/60 hover:border-accent/40 hover:bg-surface2/40 transition"
                >
                  <Icon size={16} className={`mt-0.5 shrink-0 ${meta.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{recipient}</span>
                      {r.subject && <span className="text-xs text-muted truncate">· {r.subject}</span>}
                      {r.status === 'error' && (
                        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 border border-red-400/30">
                          <AlertCircle size={10} /> errore
                        </span>
                      )}
                      {r.origin && (
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${r.origin.startsWith('perk:') ? 'bg-accent/15 text-accent border border-accent/30' : r.origin.startsWith('subagent:') ? 'bg-accent2/15 text-accent2 border border-accent2/30' : r.origin === 'agent' ? 'bg-sky-500/15 text-sky-300 border border-sky-400/30' : 'bg-surface2 text-muted border border-border'}`}>
                          {r.origin.length > 28 ? r.origin.slice(0, 25) + '…' : r.origin}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted mt-1 line-clamp-2 break-words">{r.body_preview}</div>
                    {r.error && <div className="text-xs text-red-300 mt-1 font-mono line-clamp-1">{r.error}</div>}
                  </div>
                  <div className="text-[10px] text-muted font-mono shrink-0">{fmtDate(r.ts)}</div>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      {openRow && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setOpenRow(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                {(() => { const M = CHANNEL_META[openRow.channel as Channel]; const I = M.icon; return <I size={18} className={M.color} />; })()}
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{openRow.recipient_name || openRow.recipient || '—'}</div>
                  <div className="text-[10px] text-muted font-mono truncate">{fmtDate(openRow.ts)} · {openRow.channel}</div>
                </div>
              </div>
              <button onClick={() => setOpenRow(null)} className="p-1.5 rounded-md hover:bg-surface2 text-muted hover:text-text"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto p-5 flex-1 space-y-3">
              {openRow.subject && (
                <div>
                  <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Oggetto</div>
                  <div className="text-sm font-medium">{openRow.subject}</div>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Destinatario</div>
                <div className="text-xs font-mono break-all">{openRow.recipient}</div>
                {openRow.recipient_name && <div className="text-xs text-muted">({openRow.recipient_name})</div>}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Origine</div>
                <div className="text-xs font-mono">{openRow.origin ?? '—'}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Stato</div>
                <Chip tone={openRow.status === 'sent' ? 'on' : 'err'}>{openRow.status}</Chip>
              </div>
              {openRow.error && (
                <div>
                  <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Errore</div>
                  <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap break-all bg-red-500/5 border border-red-400/20 rounded-xl p-3">{openRow.error}</pre>
                </div>
              )}
              <div>
                <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Contenuto</div>
                <pre className="text-sm whitespace-pre-wrap break-words bg-surface2/40 border border-border rounded-xl p-3">{openRow.body || '—'}</pre>
              </div>
              {openRow.meta && Object.keys(openRow.meta).length > 0 && (
                <div>
                  <div className="text-[10px] uppercase text-muted tracking-wider mb-1">Meta</div>
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
