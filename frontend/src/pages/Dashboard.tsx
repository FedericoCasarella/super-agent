import { useEffect, useMemo, useRef, useState } from 'react';
import { api, auth } from '../api';
import { useWS } from '../ws';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useI18n } from '../i18n';

type Msg = { id?: number; ts: string; direction: 'in'|'out'|'system'; channel: string; content: string };

// Mappa reason backend → chiave i18n leggibile
const REASON_KEYS = new Set(['skip_no_change', 'fallback', 'user_quiet', 'scheduled_sleep']);

// Calcola uptime sessione (ms) → string formattata "Xh Ym" o "Xm Ys"
function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

export default function Dashboard() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [agentState, setAgentState] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [tasksCount, setTasksCount] = useState<{ open: number; inProgress: number; pending: number } | null>(null);
  const [sessionStart] = useState<number>(() => Date.now());
  const [now, setNow] = useState<number>(() => Date.now());
  const toast = useToast();
  const { t } = useI18n();

  async function loadState() { try { setAgentState(await api.agentState()); } catch {} }
  async function loadMe() { try { setMe(await auth.me()); } catch {} }
  async function loadTasksCount() {
    try {
      const all = await api.tasks();
      if (Array.isArray(all)) {
        setTasksCount({
          open: all.filter((tk: any) => tk.status !== 'done' && tk.status !== 'cancelled').length,
          inProgress: all.filter((tk: any) => tk.status === 'in_progress' || tk.status === 'running').length,
          pending: all.filter((tk: any) => tk.status === 'pending' || tk.status === 'scheduled').length,
        });
      }
    } catch {}
  }

  useEffect(() => {
    api.messages(100).then(setMsgs).catch(() => {});
    loadState();
    loadMe();
    loadTasksCount();
    const stateTick = setInterval(loadState, 15000);
    const tasksTick = setInterval(loadTasksCount, 30000);
    const clockTick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(stateTick); clearInterval(tasksTick); clearInterval(clockTick); };
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
  });

  const sleepUntil = agentState?.sleep?.until ? new Date(agentState.sleep.until) : null;
  const quietUntil = agentState?.quiet?.until ? new Date(agentState.quiet.until) : null;

  // KPI calcolati client-side dai msgs già caricati
  const msgs24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return msgs.filter((m) => new Date(m.ts).getTime() >= cutoff).length;
  }, [msgs]);
  const uptime = formatUptime(now - sessionStart);
  // auth.me() ritorna { user: {...} } — il chat_id Telegram potrebbe non essere esposto qui,
  // fallback su agentState (alcuni backend lo includono)
  const chatId = (me as any)?.user?.telegram_chat_id || (me as any)?.user?.chat_id || agentState?.chat_id || agentState?.telegram_chat_id || null;

  // Traduce reason backend snake_case → testo italiano leggibile
  const reasonText = (() => {
    const raw = agentState?.sleep?.reason || agentState?.quiet?.reason;
    if (!raw) return null;
    if (REASON_KEYS.has(raw)) return t(`dash.reason.${raw}` as any);
    return raw; // fallback: mostra raw se non mappato
  })();

  return (
    <div className="space-y-4">
      {(sleepUntil || quietUntil) && (
        <Card className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex flex-col gap-1 flex-1 min-w-0">
            <div className="flex items-center gap-3 text-sm flex-wrap">
              {quietUntil && <Chip tone="warn">{t('dash.quietUntil')} {quietUntil.toLocaleString()}</Chip>}
              {sleepUntil && <Chip>{t('dash.sleepingUntil')} {sleepUntil.toLocaleString()}</Chip>}
            </div>
            {reasonText && <div className="text-xs text-muted">{reasonText}</div>}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Button variant="ghost" size="sm" onClick={wake}>{t('dash.wakeNow')}</Button>
            <span className="text-[10px] text-muted">{t('dash.wakeNowSubtitle')}</span>
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 flex flex-col h-[80vh]">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-lg font-semibold">{t('dash.liveStream')}</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <Chip tone="on">{t('dash.realtime')}</Chip>
              <span title={t('dash.realtimeUptime')}><Chip tone="on">⏱ {uptime}</Chip></span>
              <span title={t('dash.realtimeMsgs24h')}><Chip tone="on">💬 {msgs24h} {t('dash.realtimeMsgs24h')}</Chip></span>
              {chatId && <span title={t('dash.realtimeChatId')}><Chip tone="on">📨 {String(chatId).slice(0, 12)}</Chip></span>}
              {tasksCount && (
                <span title={t('dash.realtimeTasks')}>
                  <Chip tone="on">📋 {tasksCount.inProgress}▶ · {tasksCount.pending}⏸ · {tasksCount.open}∑</Chip>
                </span>
              )}
            </div>
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
          <div className="mb-4">
            <h2 className="text-lg font-semibold">{t('dash.connectorEvents')}</h2>
            <p className="text-xs text-muted mt-1">{t('dash.connectorEventsSubtitle')}</p>
          </div>
          {events.length === 0 && <div className="text-muted text-sm">{t('dash.nothingYet')}</div>}
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
