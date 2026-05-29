import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useWS } from '../ws';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { AlarmClock, Moon, BellOff, Clock, MessageSquare, Hash, Zap } from 'lucide-react';

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
  const [toolUses, setToolUses] = useState<Array<{ name: string; brief: string; isMcp: boolean; server: string | null; ts: number }>>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [activeAgents, setActiveAgents] = useState<any[]>([]);
  const sessionStartRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setNowTick((t) => t + 1), 30_000); return () => clearInterval(id); }, []);
  const toast = useToast();
  const { t } = useI18n();

  async function loadState() {
    try { setAgentState(await api.agentState()); } catch {}
    try { setStatus(await api.status()); } catch {}
    try { setActiveAgents(await api.subAgentsActive()); } catch {}
  }

  useEffect(() => {
    api.messages(100).then(setMsgs).catch(() => {});
    loadState();
    // WS drives live updates; this is just a slow safety-net poll for state the socket
    // does not push (sleep/quiet/status). Was 15s — redundant churn on top of the WS.
    const id = setInterval(loadState, 60000);
    return () => clearInterval(id);
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

  const { connected } = useWS((msg) => {
    if (msg.type === 'message') setMsgs((prev) => [...prev, msg.payload]);
    if (msg.type === 'connector') setEvents((prev) => [msg.payload, ...prev].slice(0, 50));
    if (msg.type === 'subagent') loadState();
    if (msg.type === 'tool:use') setToolUses((prev) => [msg.payload, ...prev].slice(0, 80));
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
      {(sleepUntil || quietUntil) && (
        <Card className="relative overflow-hidden border-accent/30 bg-gradient-to-br from-accent/10 via-surface to-surface">
          <div className="absolute -top-12 -right-12 w-48 h-48 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
          <div className="relative flex items-start gap-4 flex-wrap">
            <div className="w-12 h-12 rounded-2xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent shrink-0">
              {sleepUntil ? <Moon size={22} /> : <BellOff size={22} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-wider text-accent font-semibold mb-1">
                {sleepUntil ? 'Agente in pausa' : 'Modalità silenziosa'}
              </div>
              {sleepUntil && (
                <>
                  <div className="text-lg font-semibold text-text">
                    Si risveglierà <span className="text-accent">{fmtRelative(sleepUntil)}</span>
                  </div>
                  <div className="text-sm text-muted mt-1">
                    Prossimo wake: <span className="font-mono text-text">{sleepUntil.toLocaleString()}</span>
                  </div>
                </>
              )}
              {quietUntil && !sleepUntil && (
                <>
                  <div className="text-lg font-semibold text-text">
                    Silenzio fino a <span className="text-accent">{fmtRelative(quietUntil)}</span>
                  </div>
                  <div className="text-sm text-muted mt-1">
                    Fine: <span className="font-mono text-text">{quietUntil.toLocaleString()}</span>
                  </div>
                </>
              )}
              {quietUntil && sleepUntil && (
                <div className="text-xs text-muted mt-2">Quiet mode attivo fino a {quietUntil.toLocaleString()}</div>
              )}
              {agentState?.sleep?.reason && (
                <div className="text-xs text-muted mt-2 italic">Motivo: {agentState.sleep.reason}</div>
              )}
            </div>
            <Button onClick={wake} className="shrink-0 self-start">
              <AlarmClock size={16} className="inline mr-2 -mt-0.5" />{t('dash.wakeNow')}
            </Button>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 flex flex-col h-[80vh]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">{t('dash.liveStream')}</h2>
            <Chip tone={connected ? 'on' : 'default'}><span className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${connected ? 'bg-ok animate-pulse' : 'bg-muted'}`} />{connected ? t('dash.realtime') : 'offline'}</Chip>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
            <Kpi icon={<Clock size={14} />} label="Tab aperta" value={fmtUptime} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 24h" value={String(msg24h)} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 7gg" value={String(msg7d)} />
            <Kpi icon={<MessageSquare size={14} />} label="Msg 30gg" value={String(msg30d)} />
            <Kpi icon={<Zap size={14} />} label="Agenti" value={`${running}▸${pending}⏳`} highlight={running > 0} />
            <Kpi icon={<Hash size={14} />} label="Chat ID" value={chatId ? String(chatId) : '—'} mono />
          </div>
          <div ref={streamRef} onScroll={onStreamScroll} className="flex-1 overflow-y-auto space-y-2 pr-2">
            {msgs.length === 0 && <div className="text-muted text-sm">{t('dash.noMessages')}</div>}
            {msgs.map((m, i) => (
              <div key={m.id ?? i} className={`flex ${m.direction === 'in' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[78%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.direction === 'in'
                    ? 'bg-surface2 border border-border text-text'
                    : m.direction === 'out'
                    ? 'bg-accent/15 border border-accent/30 text-text'
                    : 'bg-warn/10 border border-warn/30 text-warn'
                }`}>
                  {m.content}
                  <div className="text-[10px] text-muted mt-1">{new Date(m.ts).toLocaleTimeString()}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card className="h-[80vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Attività agente</h2>
            <Chip tone="on"><span className="inline-block w-1.5 h-1.5 rounded-full bg-ok mr-1.5 animate-pulse" />live</Chip>
          </div>
          {toolUses.length === 0 && events.length === 0 && <div className="text-muted text-sm">Nessuna attività ancora.</div>}
          {toolUses.length > 0 && (
            <div className="mb-5">
              <div className="text-[10px] uppercase tracking-wider text-muted mb-2 font-semibold">Tool & MCP usati</div>
              <ul className="space-y-1.5">
                {toolUses.slice(0, 25).map((u, i) => (
                  <li key={i} className={`border rounded-xl p-2.5 text-xs ${u.isMcp ? 'border-accent2/30 bg-accent2/5' : 'border-border bg-surface2/40'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className={u.isMcp ? 'text-accent2' : 'text-accent'}>{u.isMcp ? '⌬' : '▸'}</span>
                        <span className="font-mono font-semibold truncate">{u.isMcp && u.server ? `${u.server}` : u.name.replace(/^mcp__/, '')}</span>
                        {u.isMcp && <span className="font-mono text-muted truncate">{u.name.split('__').slice(2).join('_') || ''}</span>}
                        {!u.isMcp && u.name && <span className="font-mono text-muted">{u.name}</span>}
                      </div>
                      <span className="text-[9px] text-muted font-mono shrink-0">{new Date(u.ts).toLocaleTimeString()}</span>
                    </div>
                    {u.brief && <div className="text-muted mt-1 truncate font-mono text-[10px]">{u.brief}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {events.length > 0 && (
            <div>
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
        </Card>
      </div>
    </div>
  );
}
