import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useWS } from '../ws';
import { Button, Card, Chip, useToast } from '../components/ui';

type Msg = { id?: number; ts: string; direction: 'in'|'out'|'system'; channel: string; content: string };

export default function Dashboard() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const toast = useToast();

  async function loadState() { try { setAgentState(await api.agentState()); } catch {} }

  useEffect(() => {
    api.messages(100).then(setMsgs).catch(() => {});
    loadState();
    const t = setInterval(loadState, 15000);
    return () => clearInterval(t);
  }, []);

  async function wake() { await api.agentWake(); toast.push('Agent woken — reflection will run next tick', 'on'); loadState(); }

  const streamRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true); // user near bottom?
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
  });

  const sleepUntil = agentState?.sleep?.until ? new Date(agentState.sleep.until) : null;
  const quietUntil = agentState?.quiet?.until ? new Date(agentState.quiet.until) : null;

  return (
    <div className="space-y-4">
      {(sleepUntil || quietUntil) && (
        <Card className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm">
            {quietUntil && <Chip tone="warn">quiet until {quietUntil.toLocaleString()}</Chip>}
            {sleepUntil && <Chip>sleeping until {sleepUntil.toLocaleString()}</Chip>}
            {agentState?.sleep?.reason && <span className="text-muted text-xs">{agentState.sleep.reason}</span>}
          </div>
          <Button variant="ghost" size="sm" onClick={wake}>Wake now</Button>
        </Card>
      )}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <Card className="lg:col-span-2 flex flex-col h-[80vh]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Live stream</h2>
          <Chip tone="on">● realtime</Chip>
        </div>
        <div ref={streamRef} onScroll={onStreamScroll} className="flex-1 overflow-y-auto space-y-2 pr-2">
          {msgs.length === 0 && <div className="text-muted text-sm">No messages yet. Say hi on Telegram.</div>}
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
        <h2 className="text-lg font-semibold mb-4">Connector events</h2>
        {events.length === 0 && <div className="text-muted text-sm">Nothing yet.</div>}
        <ul className="space-y-2">
          {events.map((e, i) => (
            <li key={i} className="text-sm border border-border rounded-xl p-3 bg-surface2/40">
              <div className="text-xs text-accent2 uppercase">{e.connector} · {e.kind}</div>
              <pre className="text-xs text-muted whitespace-pre-wrap mt-1">{JSON.stringify(e.payload, null, 2)}</pre>
            </li>
          ))}
        </ul>
      </Card>
    </div>
    </div>
  );
}
