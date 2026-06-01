import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useWS } from '../ws';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { AlarmClock, Moon, BellOff, Clock, MessageSquare, Hash, Zap, Activity, Coffee, Bot, Wrench, Plug } from 'lucide-react';
import Tooltip from '../components/Tooltip';
import { describeTool } from '../toolLabels';

function fmtRelative(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  if (absMin < 1) return diffMs >= 0 ? 'tra meno di 1m' : 'meno di 1m fa';
  if (absMin < 60) return diffMs >= 0 ? `tra ${absMin}m` : `${absMin}m fa`;
  const h = Math.floor(absMin / 60); const m = absMin % 60;
  const part = m ? `${h}h ${m}m` : `${h}h`;
  return diffMs >= 0 ? `tra ${part}` : `${part} fa`;
}

type Msg = { id?: number; ts: string; direction: 'in'|'out'|'system'; channel: string; content: string };

function Kpi({ icon, label, value, mono, highlight }: { icon: React.ReactNode; label: string; value: string; mono?: boolean; highlight?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 transition ${highlight ? 'border-accent/50 bg-accent/10' : 'border-border bg-surface2/40'}`}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted">
        {icon}<span className="truncate">{label}</span>
      </div>
      <div className={`text-base font-semibold mt-0.5 truncate ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

export default function Dashboard() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  type ToolEvt = { id?: number; name: string; brief: string | null; isMcp?: boolean; is_mcp?: boolean; server: string | null; ts: string | number };
  const [toolUses, setToolUses] = useState<ToolEvt[]>([]);
  const [toolFilter, setToolFilter] = useState<'all' | 'mcp' | 'native'>('all');
  const [hasMoreEvents, setHasMoreEvents] = useState(true);
  const [loadingMoreEvents, setLoadingMoreEvents] = useState(false);

  async function loadEvents(reset = false) {
    if (loadingMoreEvents) return;
    setLoadingMoreEvents(true);
    try {
      const cursor = reset || !toolUses.length ? undefined : (toolUses[toolUses.length - 1]?.id);
      const list = await api.toolEvents({ filter: toolFilter, cursor, limit: 50 });
      const normalized: ToolEvt[] = list.map((e: any) => ({ id: e.id, name: e.name, brief: e.brief, isMcp: !!e.is_mcp, server: e.server, ts: e.ts }));
      if (reset) setToolUses(normalized);
      else setToolUses((prev) => [...prev, ...normalized]);
      setHasMoreEvents(normalized.length === 50);
    } catch {}
    finally { setLoadingMoreEvents(false); }
  }
  useEffect(() => { loadEvents(true); /* eslint-disable-next-line */ }, [toolFilter]);
  const [agentState, setAgentState] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [activeAgents, setActiveAgents] = useState<any[]>([]);
  const sessionStartRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setNowTick((t) => t + 1), 5_000); return () => clearInterval(id); }, []);
  const toast = useToast();
  const { t } = useI18n();

  async function loadState() {
    try { setAgentState(await api.agentState()); } catch {}
    try { setStatus(await api.status()); } catch {}
    try { setActiveAgents(await api.subAgentsActive()); } catch {}
  }

  async function loadMsgs() { try { setMsgs(await api.messages(100)); } catch {} }
  useEffect(() => {
    loadMsgs();
    loadState();
    const idState = setInterval(loadState, 10_000);
    const idMsgs = setInterval(loadMsgs, 30_000); // refresh from server too
    return () => { clearInterval(idState); clearInterval(idMsgs); };
  }, []);

  async function wake() { await api.agentWake(); toast.push(t('dash.woken'), 'on'); loadState(); }

  const streamRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  function onStreamScroll() {
    const el = streamRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  useWS((msg) => {
    if (msg.type === 'message') setMsgs((prev) => [...prev, msg.payload]);
    if (msg.type === 'connector') setEvents((prev) => [msg.payload, ...prev].slice(0, 50));
    if (msg.type === 'subagent') loadState();
    if (msg.type === 'tool:use') {
      const p = msg.payload;
      if (toolFilter !== 'all' && (toolFilter === 'mcp') !== !!p.isMcp) return;
      const evt: ToolEvt = { id: undefined, name: p.name, brief: p.brief ?? null, isMcp: !!p.isMcp, server: p.server ?? null, ts: p.ts ?? Date.now() };
      setToolUses((prev) => [evt, ...prev]);
    }
  });

  // Derived KPIs
  void nowTick; // re-render every 30s to keep relative timers fresh
  const uptimeMs = Date.now() - sessionStartRef.current;
  const fmtUptime = (() => {
    const s = Math.floor(uptimeMs / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60); const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  })();
  const now = Date.now();
  const msg24h = msgs.filter((m) => now - new Date(m.ts).getTime() < 24 * 3600_000).length;
  const msg7d = msgs.filter((m) => now - new Date(m.ts).getTime() < 7 * 24 * 3600_000).length;
  const msg30d = msgs.filter((m) => now - new Date(m.ts).getTime() < 30 * 24 * 3600_000).length;
  const chatId = status?.telegram?.chatId ?? null;
  const running = activeAgents.filter((a) => a.status === 'running').length;
  const pending = activeAgents.filter((a) => a.status === 'pending').length;

  const sleepUntil = agentState?.sleep?.until ? new Date(agentState.sleep.until) : null;
  const quietUntil = agentState?.quiet?.until ? new Date(agentState.quiet.until) : null;

  return (
    <div className="space-y-4">
      {(() => {
        const isSleeping = !!sleepUntil;
        const isQuiet = !isSleeping && !!quietUntil;
        const isWorking = !isSleeping && !isQuiet && running > 0;
        const isIdle = !isSleeping && !isQuiet && !isWorking;
        const cfg = isSleeping
          ? { Icon: Moon, label: 'Agente in pausa', desc: <>Si risveglierà <span className="text-accent">{fmtRelative(sleepUntil!)}</span></>, sub: `Prossimo wake: ${sleepUntil!.toLocaleString()}` }
          : isQuiet
          ? { Icon: BellOff, label: 'Modalità silenziosa', desc: <>Silenzio fino a <span className="text-accent">{fmtRelative(quietUntil!)}</span></>, sub: `Fine: ${quietUntil!.toLocaleString()}` }
          : isWorking
          ? { Icon: Activity, label: `${running} agent${running > 1 ? 'i' : 'e'} in esecuzione`, desc: <>L'agente sta lavorando su {running} attività in parallelo</>, sub: pending ? `+ ${pending} in coda di partenza` : 'Conductor attivo · puoi vedere i dettagli sotto' }
          : { Icon: Coffee, label: 'Pronto', desc: <>Nessuna attività in corso</>, sub: 'Scrivimi su Telegram o lancia un task' };
        return (
          <Card className="relative overflow-hidden border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface">
            <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
            <div className="relative flex items-start gap-4 flex-wrap">
              <div className="w-12 h-12 rounded-2xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent shrink-0">
                <cfg.Icon size={22} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-accent font-semibold mb-1">
                  {cfg.label}
                  {isWorking && <span className="inline-block w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />}
                </div>
                <div className="text-lg font-semibold text-text">{cfg.desc}</div>
                <div className="text-sm text-muted mt-1">{cfg.sub}</div>
                {agentState?.sleep?.reason && isSleeping && (
                  <div className="text-xs text-muted mt-2 italic">Motivo: {agentState.sleep.reason}</div>
                )}
              </div>
              {(isSleeping || isQuiet || isIdle) && (
                <Button onClick={wake} className="shrink-0 self-start">
                  <AlarmClock size={16} className="inline mr-2 -mt-0.5" />{t('dash.wakeNow')}
                </Button>
              )}
            </div>

            {isWorking && activeAgents.length > 0 && (
              <div className="relative mt-4 pt-4 border-t border-accent/20 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">Cosa sta facendo ora</div>
                {activeAgents.map((a: any) => {
                  const isRunning = a.status === 'running';
                  const startTs = a.started_at ?? a.created_at;
                  const elapsedSec = startTs ? Math.floor((Date.now() - new Date(startTs).getTime()) / 1000) : 0;
                  const elapsed = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
                  return (
                    <div key={a.id} className={`flex items-start gap-3 p-3 rounded-2xl border ${isRunning ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface2/30'}`}>
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isRunning ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn'}`}>
                        <Bot size={18} className={isRunning ? 'animate-pulse' : ''} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{a.title || 'Sub-agent'}</span>
                          <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: isRunning ? 'var(--ok,#34d399)' : 'var(--warn,#fbbf24)' }}>
                            {isRunning ? `⚡ in corso · ${elapsed}` : '⏳ in coda'}
                          </span>
                        </div>
                        {a.brief && <div className="text-xs text-muted mt-0.5 line-clamp-2">{a.brief}</div>}
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted font-mono">
                          {a.input_tokens != null && <span>↓ {a.input_tokens.toLocaleString()} tok</span>}
                          {a.output_tokens != null && <span>↑ {a.output_tokens.toLocaleString()} tok</span>}
                          {a.cost_usd != null && <span>${Number(a.cost_usd).toFixed(4)}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="text-[10px] text-muted text-center pt-1">
                  Dettagli completi nella pagina <a href="/agents" className="text-accent hover:underline">Agents</a>
                </div>
              </div>
            )}
          </Card>
        );
      })()}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 flex flex-col h-[80vh]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('dash.liveStream')}</h2>
            <Chip tone="on"><span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 animate-pulse" />{t('dash.realtime')}</Chip>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
            <Kpi icon={<Clock size={14} />} label="Sessione" value={fmtUptime} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 24h" value={String(msg24h)} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 7gg" value={String(msg7d)} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 30gg" value={String(msg30d)} />
            <Kpi icon={<Zap size={14} />} label="Agenti" value={`${running}▸${pending}⏳`} highlight={running > 0} />
            <Kpi icon={<Hash size={14} />} label="Chat ID" value={chatId ? String(chatId) : '—'} mono />
          </div>
          <div
            ref={streamRef}
            onScroll={onStreamScroll}
            className="flex-1 overflow-y-auto space-y-2 pr-2 rounded-2xl"
            style={{
              backgroundColor: '#0a0a0c',
              backgroundImage: `linear-gradient(rgba(10,10,12,0.75), rgba(10,10,12,0.75)), url('/pattern-15-themed.svg')`,
              backgroundSize: 'auto, 33.33% auto',
              backgroundPosition: 'center, top left',
              backgroundRepeat: 'no-repeat, repeat',
              backgroundAttachment: 'local',
              padding: '0.75rem',
            }}
          >
            {msgs.length === 0 && <div className="text-muted text-sm">{t('dash.noMessages')}</div>}
            {msgs.map((m, i) => (
              <div key={m.id ?? i} className={`flex ${m.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap shadow-md ${
                  m.direction === 'in'
                    ? 'bg-surface2 border border-border text-text'
                    : m.direction === 'out'
                    ? 'border border-accent/40 text-text'
                    : 'border border-warn/40 text-warn'
                }`} style={
                  m.direction === 'out' ? { backgroundColor: '#2a1f3d' }
                  : m.direction === 'system' ? { backgroundColor: '#2a2210' }
                  : undefined
                }>
                  {m.content}
                  <div className="text-[10px] text-muted mt-1">{new Date(m.ts).toLocaleTimeString()}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="h-[80vh] flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Attività agente</h2>
            <Chip tone="on"><span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 animate-pulse" />live</Chip>
          </div>
          <div className="flex items-center gap-1 mb-3 bg-surface2/40 border border-border rounded-full p-1 w-fit">
            {(['all', 'mcp', 'native'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setToolFilter(f)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition ${toolFilter === f ? 'bg-accent text-bg' : 'text-muted hover:text-text'}`}
              >
                {f === 'all' ? 'Tutto' : f === 'mcp' ? 'MCP' : 'Native'}
              </button>
            ))}
            <button onClick={() => loadEvents(true)} className="ml-1 px-2 py-1 rounded-full text-xs text-muted hover:text-text" title="Ricarica">↻</button>
          </div>
          <div className="flex-1 overflow-y-auto -mr-2 pr-2">
            {toolUses.length === 0 && events.length === 0 && <div className="text-muted text-sm">Nessuna attività ancora.</div>}
            {toolUses.length > 0 && (
              <ul className="space-y-1.5">
                {toolUses.map((u, i) => {
                  const isMcp = u.isMcp ?? u.is_mcp ?? false;
                  const tsMs = typeof u.ts === 'string' ? new Date(u.ts).getTime() : u.ts;
                  const meta = describeTool(u.name, u.server ?? null, isMcp);
                  return (
                    <li key={u.id ?? i} className={`border rounded-xl p-2.5 text-xs ${isMcp ? 'border-accent2/30 bg-accent2/5' : 'border-border bg-surface2/40'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Tooltip content={
                            <div>
                              <div className="font-semibold mb-1">{meta.label}</div>
                              <div className="text-muted text-[11px]">{meta.desc}</div>
                              <div className="text-[10px] text-muted/70 mt-1 font-mono">{u.name}</div>
                            </div>
                          }>
                            <span className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-md ${isMcp ? 'bg-accent2/15 text-accent2' : 'bg-accent/15 text-accent'}`}>
                              {isMcp ? <Plug size={11} /> : <Wrench size={11} />}
                            </span>
                          </Tooltip>
                          <Tooltip content={meta.desc}>
                            <span className="font-semibold truncate">{meta.label}</span>
                          </Tooltip>
                        </div>
                        <span className="text-[9px] text-muted font-mono shrink-0">{new Date(tsMs).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {u.brief && (
                        <Tooltip content={u.brief}>
                          <span className="block text-muted mt-1 truncate font-mono text-[10px]">{u.brief}</span>
                        </Tooltip>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {hasMoreEvents && toolUses.length > 0 && (
              <button
                onClick={() => loadEvents(false)}
                disabled={loadingMoreEvents}
                className="w-full mt-3 py-2 rounded-xl border border-border bg-surface2/40 text-xs text-muted hover:text-text hover:border-accent/40 transition"
              >
                {loadingMoreEvents ? 'Carico…' : 'Carica più vecchie'}
              </button>
            )}
            {events.length > 0 && (
              <div className="mt-5">
                <div className="text-[10px] uppercase tracking-wider text-muted mb-2 font-semibold">{t('dash.connectorEvents')}</div>
                <ul className="space-y-2">
                  {events.map((e, i) => (
                    <li key={i} className="text-sm border border-border rounded-xl p-3 bg-surface2/40">
                      <div className="text-xs text-accent2 uppercase">{e.connector} · {e.kind}</div>
                      <pre className="text-xs text-muted whitespace-pre-wrap mt-1">{JSON.stringify(e.payload, null, 2).slice(0, 400)}</pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
