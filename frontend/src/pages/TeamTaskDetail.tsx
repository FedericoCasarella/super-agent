import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ForceGraph2D from 'react-force-graph-2d';
import { api } from '../api';
import { Button, Card, Chip, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useWS, useLiveData } from '../ws';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import MarkdownView from '../components/MarkdownView';

type Event = {
  id: number; ts: string; from_agent_id: number | null; to_agent_id: number | null;
  kind: string; content: string | null; meta: any;
};

const KIND_COLOR: Record<string, string> = {
  start: '#a78bfa', delegate: '#22d3ee', report: '#34d399',
  finish: '#34d399', tool: '#fbbf24', message: '#cbd5e1', error: '#f87171',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
function truncateText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

export default function TeamTaskDetail() {
  const { id = '' } = useParams();
  const taskId = Number(id);
  const nav = useNavigate();
  const [task, setTask] = useState<any | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const toast = useToast();
  const dlg = useDialog();
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const zoomedRef = useRef(false);
  const [size, setSize] = useState({ w: 600, h: 480 });

  const load = useCallback(async () => {
    try {
      const r = await api.teamTaskGet(taskId);
      setTask(r.task); setEvents(r.events);
      if (!agents.length) setAgents(await api.customAgentsList());
    } catch (e: any) { toast.push(e.message, 'err'); }
  }, [taskId, agents.length, toast]);

  useLiveData(load, { refreshOn: ['team_task', 'team_task_tokens', 'tool_use'], fallbackMs: 60_000, deps: [taskId] });

  // Live tool feed — every tool_use emitted by an agent running inside THIS task.
  type LiveTool = { ts: number; name: string; brief: string; agent_id: number | null; kind: string | null };
  const [liveFeed, setLiveFeed] = useState<LiveTool[]>([]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  // Token tally per agent (mutated via ref to avoid graph re-render on every event).
  type TokTally = { in: number; out: number; cacheRead: number; cacheCreate: number };
  const tokensRef = useRef<Map<number | 'all', TokTally>>(new Map());
  const [tokensTick, setTokensTick] = useState(0); // throttled rerender pulse (1s)
  const pulseTimers = useRef<Map<number, number>>(new Map());
  const liveDirtyRef = useRef(false);
  useWS((m) => {
    if (m?.type === 'team_task' && m.payload?.taskId === taskId) load();
    if (m?.type === 'tool:use') {
      const p = m.payload ?? {};
      const meta = p.meta ?? {};
      if (meta.task_id !== taskId) return;
      const aid = meta.agent_id ?? null;
      setLiveFeed((prev) => {
        const next = [...prev, { ts: p.ts ?? Date.now(), name: p.name, brief: p.brief ?? '', agent_id: aid, kind: p.kind ?? null }];
        return next.slice(-200);
      });
      if (aid) {
        const prev = pulseTimers.current.get(aid);
        if (prev) window.clearTimeout(prev);
        pulseTimers.current.set(aid, window.setTimeout(() => { pulseTimers.current.delete(aid); liveDirtyRef.current = true; }, 1500));
        liveDirtyRef.current = true;
      }
    }
    if (m?.type === 'team_task_tokens') {
      const p = m.payload ?? {};
      if (p.taskId !== taskId) return;
      const aid = p.agentId ?? 'all';
      const cur = tokensRef.current.get(aid) ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      cur.in += p.in ?? 0;
      cur.out += p.out ?? 0;
      cur.cacheRead += p.cacheRead ?? 0;
      cur.cacheCreate += p.cacheCreate ?? 0;
      tokensRef.current.set(aid, cur);
      // Also accumulate task-level totals
      const all = tokensRef.current.get('all') ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
      all.in += p.in ?? 0;
      all.out += p.out ?? 0;
      all.cacheRead += p.cacheRead ?? 0;
      all.cacheCreate += p.cacheCreate ?? 0;
      tokensRef.current.set('all', all);
      liveDirtyRef.current = true;
    }
  });
  // Coalesce all live updates into a single 1s tick — graph won't re-mount on each WS message.
  useEffect(() => {
    const iv = setInterval(() => { if (liveDirtyRef.current) { liveDirtyRef.current = false; setTokensTick((t) => t + 1); } }, 1000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' }); }, [liveFeed.length]);

  // Pricing (Anthropic public input/output cost per million tokens, Sonnet-class)
  function costFromTokens(t: TokTally): number {
    const inUsd = (t.in / 1_000_000) * 3;
    const outUsd = (t.out / 1_000_000) * 15;
    const cacheReadUsd = (t.cacheRead / 1_000_000) * 0.3;
    const cacheCreateUsd = (t.cacheCreate / 1_000_000) * 3.75;
    return inUsd + outUsd + cacheReadUsd + cacheCreateUsd;
  }
  const taskTotals = tokensRef.current.get('all') ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
  const taskCostLive = costFromTokens(taskTotals);
  const totalTokens = taskTotals.in + taskTotals.out + taskTotals.cacheRead + taskTotals.cacheCreate;

  useEffect(() => {
    function onResize() {
      const el = wrapRef.current;
      if (!el) return;
      setSize({ w: el.clientWidth, h: el.clientHeight });
    }
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Build graph: nodes = agents involved, links = delegate/report edges aggregated.
  // Memo so ForceGraph2D doesn't re-init on every live update.
  const graphData = useMemo(() => {
  const involved = new Set<number>();
  for (const e of events) { if (e.from_agent_id) involved.add(e.from_agent_id); if (e.to_agent_id) involved.add(e.to_agent_id); }
  // Per-agent stats
  const stats = new Map<number, { delegates: number; reports: number; errors: number; lastTs: number }>();
  for (const e of events) {
    const ts = new Date(e.ts).getTime();
    for (const aid of [e.from_agent_id, e.to_agent_id]) {
      if (!aid) continue;
      const s = stats.get(aid) ?? { delegates: 0, reports: 0, errors: 0, lastTs: 0 };
      if (e.kind === 'delegate') s.delegates++;
      if (e.kind === 'report' || e.kind === 'finish') s.reports++;
      if (e.kind === 'error') s.errors++;
      if (ts > s.lastTs) s.lastTs = ts;
      stats.set(aid, s);
    }
  }
  // Active = agent appears in last 10s of events AND task still running
  const lastEventTs = events.length ? new Date(events[events.length - 1].ts).getTime() : 0;
  const taskRunning = task?.status === 'running';
  const nodes = [...involved].map((aid) => {
    const ag = agents.find((a) => a.id === aid);
    const s = stats.get(aid) ?? { delegates: 0, reports: 0, errors: 0, lastTs: 0 };
    return {
      id: String(aid),
      agent_id: aid,
      name: ag?.name ?? `agent #${aid}`,
      role: ag?.role ?? '',
      model: ag?.model ?? '',
      color: ag?.color ?? '#c084fc',
      delegates: s.delegates, reports: s.reports, errors: s.errors,
      lastEventTs: s.lastTs,
    };
  });
  const edgeMap = new Map<string, { source: string; target: string; count: number; kinds: Set<string> }>();
  for (const e of events) {
    if (!e.from_agent_id || !e.to_agent_id || e.from_agent_id === e.to_agent_id) continue;
    const key = `${e.from_agent_id}->${e.to_agent_id}`;
    const cur = edgeMap.get(key) ?? { source: String(e.from_agent_id), target: String(e.to_agent_id), count: 0, kinds: new Set() };
    cur.count++; cur.kinds.add(e.kind);
    edgeMap.set(key, cur);
  }
  return { nodes, links: [...edgeMap.values()] };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, agents]);
  // Map for dynamic node lookup (tokens + active live) — recomputed each render
  const _taskRunning = task?.status === 'running';
  const _lastEventTs = events.length ? new Date(events[events.length - 1].ts).getTime() : 0;
  const livePerAgent = (aid: number) => {
    const t = tokensRef.current.get(aid) ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
    const pulse = pulseTimers.current.has(aid);
    const node = graphData.nodes.find((n: any) => n.agent_id === aid);
    return { tokens: t.in + t.out, active: pulse || (_taskRunning && (_lastEventTs - (node?.lastEventTs ?? 0)) < 10_000) };
  };
  // Reference tokensTick to suppress unused-var warning + ensure node painter has fresh closure
  void tokensTick;

  function agentName(id: number | null) {
    if (!id) return 'system';
    return agents.find((a) => a.id === id)?.name ?? `agent #${id}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => nav('/team-tasks')} className="text-muted-foreground hover:text-text"><ArrowLeft size={16} /></button>
        <h1 className="text-xl font-semibold truncate">{task?.title ?? 'Loading…'}</h1>
        {task && <Chip tone={task.status === 'done' ? 'on' : task.status === 'running' ? 'accent' : task.status === 'error' ? 'err' : 'default'}>{task.status}</Chip>}
        <div className="ml-auto flex gap-2 items-center">
          {/* Token + cost widget */}
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-surface2/60 border border-border text-xs">
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[9px] uppercase text-muted-foreground tracking-wider">tokens</span>
              <span className="font-mono font-semibold tabular-nums">{totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens}</span>
            </span>
            <span className="w-px h-3 bg-border" />
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[9px] uppercase text-muted-foreground tracking-wider">costo</span>
              <span className="font-mono font-semibold tabular-nums text-emerald-300">${(task?.cost_usd ?? taskCostLive).toFixed(4)}</span>
            </span>
            {task?.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
          </div>
          <Button variant="ghost" size="sm" onClick={load}><RefreshCw size={13} /></Button>
          {task?.status === 'running' && (
            <Button variant="danger" size="sm" onClick={async () => {
              if (!await dlg.confirm('Interrompere il task? Tutti gli agenti in esecuzione verranno killati.', { title: 'Interrompi task', tone: 'danger', confirmLabel: 'Interrompi' })) return;
              try { await api.teamTaskCancel(taskId); toast.push('Task interrotto', 'warn'); load(); }
              catch (e: any) { toast.push(e.message, 'err'); }
            }}>⏹ Interrompi</Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div ref={wrapRef} className="lg:col-span-2 h-[60vh]"><Card className="p-0 overflow-hidden h-full">
          {graphData.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">In attesa di eventi…</div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              width={size.w}
              height={size.h}
              graphData={graphData as any}
              backgroundColor="#0a0a0f"
              cooldownTicks={120}
              d3AlphaDecay={0.04}
              onEngineStop={() => {
                // Fire only ONCE — engine can re-settle on data change and would reset user pan/zoom.
                if (zoomedRef.current) return;
                zoomedRef.current = true;
                try { fgRef.current?.zoomToFit(500, 100); } catch {}
              }}
              linkColor={(l: any) => l.kinds?.has('error') ? '#f8717177' : '#a78bfa66'}
              linkWidth={(l: any) => Math.min(1 + Math.log(l.count + 1), 4)}
              linkDirectionalArrowLength={7}
              linkDirectionalArrowRelPos={0.92}
              linkDirectionalArrowColor={(l: any) => l.kinds?.has('error') ? '#f87171' : '#a78bfa'}
              nodePointerAreaPaint={(n: any, color, ctx) => {
                if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
                const W = 196, H = 88;
                ctx.fillStyle = color;
                ctx.fillRect(n.x - W / 2, n.y - H / 2, W, H);
              }}
              onRenderFramePre={(ctx, globalScale) => {
                if (!Number.isFinite(globalScale) || globalScale <= 0) return;
                // Dotted grid — small dots at intersections
                const G = 36;
                const alpha = Math.min(0.40, 0.18 + globalScale * 0.05);
                const t = ctx.getTransform();
                if (!t.a || !t.d) return;
                const w = size.w / t.a, h = size.h / t.d;
                const cx = -t.e / t.a, cy = -t.f / t.d;
                if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w) || !Number.isFinite(h)) return;
                ctx.save();
                ctx.fillStyle = `rgba(200,200,230,${alpha})`;
                const r = Math.max(0.9, 1.4 / globalScale);
                const x0 = Math.floor(cx / G) * G;
                const y0 = Math.floor(cy / G) * G;
                for (let x = x0; x < cx + w + G; x += G) {
                  for (let y = y0; y < cy + h + G; y += G) {
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fill();
                  }
                }
                ctx.restore();
              }}
              nodeCanvasObject={(n: any, ctx) => {
                // Guard: force layout assigns x/y on first ticks; skip until finite.
                if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return;
                const live = livePerAgent(n.agent_id);
                const isActive = live.active;
                const tokensLabel = live.tokens >= 1000 ? `${(live.tokens / 1000).toFixed(1)}K` : String(live.tokens);
                // Rectangular card — Sales Director / Lead Hunter style
                const W = 196, H = 88, R = 12;
                const x = n.x - W / 2, y = n.y - H / 2;
                const color = n.color ?? '#c084fc';
                // Outer glow on active
                if (isActive) {
                  ctx.save();
                  ctx.shadowColor = color;
                  ctx.shadowBlur = 18;
                  ctx.strokeStyle = color;
                  ctx.lineWidth = 1.6;
                  roundRect(ctx, x, y, W, H, R);
                  ctx.stroke();
                  ctx.restore();
                }
                // Opaque solid fill — hides grid behind the card
                ctx.fillStyle = '#10101a';
                roundRect(ctx, x, y, W, H, R);
                ctx.fill();
                // Subtle gradient tint on top
                const grd = ctx.createLinearGradient(x, y, x, y + H);
                grd.addColorStop(0, color + '33');
                grd.addColorStop(1, color + '11');
                ctx.fillStyle = grd;
                roundRect(ctx, x, y, W, H, R);
                ctx.fill();
                // Border
                ctx.strokeStyle = color + 'cc';
                ctx.lineWidth = 1.2;
                ctx.stroke();
                // Name (top-left)
                ctx.fillStyle = '#f3f4f6';
                ctx.font = '600 13px Inter, system-ui, sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                const nameMax = W - 80;
                ctx.fillText(truncateText(ctx, n.name, nameMax), x + 12, y + 10);
                // Role (smaller, under name)
                if (n.role) {
                  ctx.fillStyle = 'rgba(220,220,230,0.7)';
                  ctx.font = '500 10px Inter, system-ui, sans-serif';
                  ctx.fillText(truncateText(ctx, n.role, nameMax), x + 12, y + 28);
                }
                // Separator line between header and footer rows
                ctx.strokeStyle = color + '33';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.moveTo(x + 10, y + H - 36);
                ctx.lineTo(x + W - 10, y + H - 36);
                ctx.stroke();
                // Model row (left of separator-line area)
                if (n.model) {
                  ctx.fillStyle = 'rgba(180,180,200,0.7)';
                  ctx.font = '500 9px ui-monospace, SFMono-Regular, monospace';
                  ctx.textBaseline = 'middle';
                  ctx.fillText(truncateText(ctx, n.model, W - 24), x + 12, y + H - 25);
                }
                ctx.textBaseline = 'top';
                // Status badge top-right
                const badge = isActive ? 'ACTIVE' : (n.errors > 0 ? 'ERR' : 'IDLE');
                const badgeColor = isActive ? '#22d3ee' : (n.errors > 0 ? '#f87171' : '#94a3b8');
                ctx.font = '700 8.5px Inter, system-ui, sans-serif';
                const bw = ctx.measureText(badge).width + 10;
                const bx = x + W - bw - 8, by = y + 8;
                ctx.fillStyle = badgeColor + '33';
                roundRect(ctx, bx, by, bw, 14, 7);
                ctx.fill();
                ctx.strokeStyle = badgeColor + 'aa';
                ctx.lineWidth = 0.8;
                ctx.stroke();
                ctx.fillStyle = badgeColor;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(badge, bx + bw / 2, by + 7.5);
                // Token counter — bottom-left
                ctx.fillStyle = isActive ? '#22d3ee' : 'rgba(220,220,235,0.9)';
                ctx.font = '700 11px ui-monospace, monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(`◇ ${tokensLabel} tok`, x + 12, y + H - 14);
                // Stats bottom-right
                ctx.fillStyle = 'rgba(180,180,200,0.8)';
                ctx.font = '500 10px ui-monospace, monospace';
                ctx.textAlign = 'right';
                const statsStr = `↓${n.delegates} ↑${n.reports}${n.errors ? ` ⚠${n.errors}` : ''}`;
                ctx.fillText(statsStr, x + W - 12, y + H - 14);
              }}
            />
          )}
        </Card></div>

        <Card className="h-[60vh] overflow-hidden flex flex-col p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold inline-flex items-center gap-2 text-sm">
              🟢 Live activity
              {task?.status === 'running' && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-400/30 uppercase tracking-wider">streaming</span>}
              <span className="text-xs text-muted-foreground font-mono">({liveFeed.length})</span>
            </div>
            {liveFeed.length > 0 && <Button size="sm" variant="ghost" onClick={() => setLiveFeed([])}>clear</Button>}
          </div>
          <div ref={feedRef} className="flex-1 overflow-y-auto space-y-1">
            {liveFeed.length === 0 ? (
              <div className="text-xs text-muted-foreground py-3">
                {task?.status === 'running' ? 'Aspetto attività dagli agenti…' : 'Nessuna attività live (task non in esecuzione).'}
              </div>
            ) : liveFeed.map((t, i) => {
              const ag = agents.find((a) => a.id === t.agent_id);
              const mcp = t.name.startsWith('mcp__');
              const cleanName = mcp ? t.name.replace(/^mcp__[^_]+__/, '') : t.name;
              return (
                <div key={i} className="flex items-start gap-2 text-xs border border-border/40 rounded-lg p-2 bg-surface2/30">
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-12">{new Date(t.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  {ag && (
                    <span className="px-1.5 py-0.5 rounded-full font-semibold text-[9px] uppercase tracking-wider shrink-0" style={{ background: (ag.color ?? '#c084fc') + '22', color: ag.color ?? '#c084fc', border: `1px solid ${ag.color ?? '#c084fc'}55` }}>
                      {ag.name}
                    </span>
                  )}
                  <span className={`font-mono text-[10px] shrink-0 ${mcp ? 'text-accent2' : 'text-accent'}`}>{cleanName}</span>
                  {t.brief && <span className="text-muted-foreground whitespace-pre-wrap break-all flex-1 min-w-0 font-mono">{t.brief}</span>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-semibold">Brief</div>
        <div className="text-sm whitespace-pre-wrap break-words p-3 rounded-xl bg-surface2/40 border border-border mb-3 max-h-[30vh] overflow-y-auto">{task?.prompt}</div>
        {task?.result && (
          <>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2 font-semibold">Risultato</div>
            <div className="p-3 rounded-xl bg-surface2/40 border border-border text-sm mb-3">
              <MarkdownView content={task.result} />
            </div>
          </>
        )}
        {task?.error && (
          <div className="text-xs text-red-300 font-mono whitespace-pre-wrap break-all bg-red-500/5 border border-red-400/30 rounded-xl p-3 mb-3">{task.error}</div>
        )}
        <div className="font-semibold mb-2">Storico interazioni ({events.length})</div>
        <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
          {events.map((e) => (
            <div key={e.id} className="flex items-start gap-2 text-sm border border-border/60 rounded-xl p-2.5 bg-surface2/30">
              <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ background: (KIND_COLOR[e.kind] ?? '#888') + '22', color: KIND_COLOR[e.kind] ?? '#888', border: `1px solid ${(KIND_COLOR[e.kind] ?? '#888')}55` }}>
                {e.kind}
              </span>
              <div className="text-xs text-muted-foreground shrink-0 font-mono">{agentName(e.from_agent_id)} → {agentName(e.to_agent_id)}</div>
              <div className="text-xs flex-1 min-w-0 whitespace-pre-wrap break-words">{(e.content ?? '').slice(0, 600)}</div>
              <div className="text-[10px] text-muted-foreground font-mono shrink-0">{new Date(e.ts).toLocaleTimeString('it-IT')}</div>
            </div>
          ))}
          {events.length === 0 && <div className="text-muted-foreground text-sm">Nessun evento.</div>}
        </div>
      </Card>
    </div>
  );
}
