import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { useWS } from '../ws';

type SubAgent = {
  id: number; title: string; brief: string | null; prompt: string; status: string;
  result: string | null; error: string | null; cost_usd: number | null;
  input_tokens: number | null; output_tokens: number | null; num_turns: number | null;
  actions: Array<{ name: string; brief: string; ts: number }>;
  started_at: string | null; ended_at: string | null; created_at: string;
};

type Proposal = {
  id: number; title: string; reason: string | null; status: string; created_at: string;
  proposals: { title: string; brief: string; prompt: string }[];
};

const STATUS_TONE: Record<string, 'on' | 'warn' | 'err' | 'default' | 'accent'> = {
  pending: 'default',
  running: 'on',
  done: 'on',
  error: 'err',
  cancelled: 'warn',
  approved: 'on',
  denied: 'err',
};

function fmtAgo(ts: string | null): string {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s fa`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h fa`;
  return `${Math.floor(h / 24)}d fa`;
}

function fmtDur(start: string | null, end: string | null): string {
  if (!start) return '—';
  const s = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  if (s < 1000) return `${s}ms`;
  const sec = Math.floor(s / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export default function LiveAgents() {
  const { t: _t } = useI18n();
  const toast = useToast();
  const [agents, setAgents] = useState<SubAgent[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [open, setOpen] = useState<SubAgent | null>(null);

  async function refresh() {
    try {
      const [a, p, s] = await Promise.all([api.subAgentsList(), api.proposalsList(), api.subAgentsStats()]);
      setAgents(a);
      setProposals(p.filter((x: Proposal) => x.status === 'pending'));
      setStats(s);
    } catch (e: any) { toast.push(e.message, 'err'); }
  }

  useEffect(() => { refresh(); const iv = setInterval(refresh, 5000); return () => clearInterval(iv); }, []);

  useWS((msg) => {
    if (msg?.type !== 'subagent') return;
    refresh();
  });

  async function approve(p: Proposal) {
    try { await api.proposalApprove(p.id); toast.push('Approvato', 'on'); refresh(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function deny(p: Proposal) {
    try { await api.proposalDeny(p.id); toast.push('Rifiutato', 'warn'); refresh(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function cancel(a: SubAgent) {
    try { await api.subAgentCancel(a.id); toast.push('Annullato', 'warn'); refresh(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  const active = agents.filter((a) => a.status === 'running' || a.status === 'pending');
  const recent = agents.filter((a) => a.status !== 'running' && a.status !== 'pending').slice(0, 30);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gradient">Agenti Live</h1>
        <Button size="sm" variant="ghost" onClick={refresh}>↻</Button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div className="border border-border rounded-2xl p-3 bg-surface2/40">
            <div className="text-[10px] uppercase tracking-wide text-muted">Totale agenti</div>
            <div className="text-2xl font-semibold mt-1">{stats.totals?.n ?? 0}</div>
          </div>
          <div className="border border-border rounded-2xl p-3 bg-surface2/40">
            <div className="text-[10px] uppercase tracking-wide text-muted">Token in</div>
            <div className="text-2xl font-semibold mt-1 font-mono">{(stats.totals?.in_tok ?? 0).toLocaleString()}</div>
          </div>
          <div className="border border-border rounded-2xl p-3 bg-surface2/40">
            <div className="text-[10px] uppercase tracking-wide text-muted">Token out</div>
            <div className="text-2xl font-semibold mt-1 font-mono">{(stats.totals?.out_tok ?? 0).toLocaleString()}</div>
          </div>
          <div className="border border-border rounded-2xl p-3 bg-surface2/40">
            <div className="text-[10px] uppercase tracking-wide text-muted">Turni</div>
            <div className="text-2xl font-semibold mt-1 font-mono">{stats.totals?.turns ?? 0}</div>
          </div>
          <div className="border border-border rounded-2xl p-3 bg-surface2/40">
            <div className="text-[10px] uppercase tracking-wide text-muted">Costo</div>
            <div className="text-2xl font-semibold mt-1 font-mono">${Number(stats.totals?.cost ?? 0).toFixed(4)}</div>
          </div>
        </div>
      )}

      {stats?.topTools?.length > 0 && (
        <Card>
          <div className="text-[10px] uppercase tracking-wide text-muted mb-3 font-semibold">Tool più usati</div>
          <div className="flex flex-wrap gap-2 text-xs">
            {stats.topTools.map((t: any) => (
              <div key={t.name} className="border border-border rounded-full px-2.5 py-1 bg-surface2/40">
                <span className="font-mono">{t.name}</span> · <span className="text-muted">{t.n}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {proposals.length > 0 && (
        <Card className="border-accent2/40 bg-accent2/5">
          <div className="text-xs uppercase text-accent2 mb-3 font-semibold">In attesa di approvazione ({proposals.length})</div>
          <div className="space-y-3">
            {proposals.map((p) => (
              <div key={p.id} className="border border-border rounded-2xl p-4 bg-surface2/40">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div>
                    <div className="font-semibold">{p.title}</div>
                    {p.reason && <div className="text-sm text-muted mt-1">{p.reason}</div>}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" onClick={() => approve(p)}>✅ Sì</Button>
                    <Button size="sm" variant="ghost" onClick={() => deny(p)}>❌ No</Button>
                  </div>
                </div>
                <ul className="text-sm space-y-1 mt-2 pl-3 border-l border-border">
                  {p.proposals.map((s, i) => (
                    <li key={i}><span className="font-medium">{s.title}</span> — <span className="text-muted">{s.brief}</span></li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div className="text-xs uppercase text-muted mb-3 font-semibold">In esecuzione ({active.length})</div>
        {active.length === 0 ? (
          <div className="text-muted text-sm">Nessun agent attivo.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {active.map((a) => (
              <button key={a.id} onClick={() => setOpen(a)} className="text-left border border-accent/30 bg-accent/5 hover:border-accent/60 rounded-2xl p-3 transition">
                <div className="flex items-center justify-between mb-1">
                  <div className="font-medium">{a.title}</div>
                  <Chip tone={STATUS_TONE[a.status] ?? 'default'}>{a.status === 'running' ? '⚡ in corso' : '⏳ in coda'}</Chip>
                </div>
                {a.brief && <div className="text-sm text-muted line-clamp-2">{a.brief}</div>}
                <div className="text-xs text-muted mt-2 flex justify-between">
                  <span>Avviato {fmtAgo(a.started_at ?? a.created_at)}</span>
                  <span>{fmtDur(a.started_at ?? a.created_at, null)}</span>
                </div>
                <div className="mt-2 text-right">
                  <Button size="sm" variant="ghost" onClick={(e: any) => { e.stopPropagation(); cancel(a); }}>Annulla</Button>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <div className="text-xs uppercase text-muted mb-3 font-semibold">Recenti ({recent.length})</div>
        {recent.length === 0 ? (
          <div className="text-muted text-sm">Niente da mostrare.</div>
        ) : (
          <ul className="space-y-2">
            {recent.map((a) => (
              <li key={a.id}>
                <button onClick={() => setOpen(a)} className="w-full text-left border border-border rounded-2xl p-3 hover:border-accent/40 bg-surface2/30 transition">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium truncate">{a.title}</div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Chip tone={STATUS_TONE[a.status] ?? 'default'}>{a.status}</Chip>
                      <span className="text-xs text-muted">{fmtAgo(a.ended_at ?? a.created_at)}</span>
                    </div>
                  </div>
                  {a.brief && <div className="text-xs text-muted mt-1 truncate">{a.brief}</div>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {open && (
        <div className="fixed inset-0 bg-bg/80 backdrop-blur z-50 flex items-center justify-center p-4" onClick={() => setOpen(null)}>
          <div className="max-w-3xl w-full max-h-[85vh] overflow-y-auto" onClick={(e: any) => e.stopPropagation()}><Card>
            <div className="flex items-start justify-between mb-3 gap-3">
              <div>
                <h2 className="text-lg font-semibold">{open.title}</h2>
                {open.brief && <div className="text-sm text-muted mt-1">{open.brief}</div>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Chip tone={STATUS_TONE[open.status] ?? 'default'}>{open.status}</Chip>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>✕</Button>
              </div>
            </div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-xs mb-4">
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Durata</div><div className="font-mono mt-1">{fmtDur(open.started_at, open.ended_at)}</div></div>
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Costo</div><div className="font-mono mt-1">{open.cost_usd != null ? `$${Number(open.cost_usd).toFixed(4)}` : '—'}</div></div>
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Token in</div><div className="font-mono mt-1">{open.input_tokens?.toLocaleString() ?? '—'}</div></div>
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Token out</div><div className="font-mono mt-1">{open.output_tokens?.toLocaleString() ?? '—'}</div></div>
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Turni</div><div className="font-mono mt-1">{open.num_turns ?? '—'}</div></div>
              <div className="border border-border rounded-xl p-2"><div className="text-muted">Creato</div><div className="font-mono mt-1">{fmtAgo(open.created_at)}</div></div>
            </div>

            {open.actions?.length > 0 && (
              <div className="mb-4">
                <div className="text-xs text-muted mb-2 font-semibold uppercase">Azioni eseguite ({open.actions.length})</div>
                <ol className="text-xs space-y-1 max-h-60 overflow-y-auto border border-border rounded-xl p-2 bg-surface2/30">
                  {open.actions.map((a, i) => (
                    <li key={i} className="flex items-start gap-2 font-mono">
                      <span className="text-muted w-6 shrink-0 text-right">{i + 1}.</span>
                      <span className="text-accent shrink-0">{a.name}</span>
                      <span className="text-muted truncate">{a.brief}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <details className="mb-3"><summary className="text-xs text-muted cursor-pointer">Prompt completo</summary><pre className="text-xs bg-surface2/40 border border-border rounded-xl p-3 mt-2 whitespace-pre-wrap overflow-auto max-h-64">{open.prompt}</pre></details>
            {open.error && <div className="text-sm border border-red-400/40 bg-red-400/10 rounded-xl p-3 mb-3 text-red-300"><div className="font-semibold mb-1">Errore</div><pre className="whitespace-pre-wrap text-xs">{open.error}</pre></div>}
            {open.result && (
              <div>
                <div className="text-xs text-muted mb-1">Risultato</div>
                <pre className="text-sm bg-surface2/40 border border-border rounded-xl p-3 whitespace-pre-wrap overflow-auto max-h-96">{open.result}</pre>
              </div>
            )}
          </Card></div>
        </div>
      )}
    </div>
  );
}
