// Diagramma 2D del goal — SVG/DOM deterministico (niente force-graph: layout
// stabile, mai reshuffle, nodi sempre cliccabili). Goal al centro, hub KPI sopra
// e hub Agenti sotto, figli in riga. Icone lucide vere. Click su KPI/agente →
// onPick (la pagina apre il drawer).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Target, BarChart3, TrendingUp, Bot, CheckCircle2, Loader2, Clock, XCircle, RotateCcw, Plus, Minus, Check, FileText, FilePen } from 'lucide-react';

type Kpi = { id: string; name: string; unit?: string; target: number; current: number };
type Resource = { path: string; written: boolean };
type Agent = { id: number; title: string; status: string; milestoneId?: string | null; resources?: Resource[] };
type Milestone = { id: string; title: string; area?: string; status: string };

const C_GOAL = '#ff6680';
const C_KPI = '#34d399';
const C_AGENT = '#a78bfa';
const C_RES = '#60a5fa';
const C_MS = '#fbbf24';
// HEX palette only — colors get `${tone}55` hex-alpha suffixes in styles, so
// hsl()/rgb() strings would produce invalid values and the browser silently
// drops the whole background/border. Keep everything #rrggbb.
const MS_PALETTE = ['#fbbf24', '#38bdf8', '#f472b6', '#34d399', '#a78bfa', '#fb923c', '#22d3ee', '#facc15'];
function areaColor(area?: string): string {
  if (!area) return C_MS;
  let h = 0; for (let i = 0; i < area.length; i++) h = (h * 31 + area.charCodeAt(i)) | 0;
  return MS_PALETTE[Math.abs(h) % MS_PALETTE.length];
}

type Pos = { id: string; kind: 'goal' | 'hub' | 'kpi' | 'agent' | 'milestone' | 'resource'; label: string; sub?: string; tone: string; x: number; y: number; pickId?: string; status?: string; resPath?: string };

function AgentStatusIcon({ status, size, color }: { status?: string; size: number; color: string }) {
  const p = { size, style: { color } };
  if (status === 'done') return <CheckCircle2 {...p} />;
  if (status === 'running') return <Loader2 {...p} className="animate-spin" />;
  if (status === 'error' || status === 'cancelled') return <XCircle {...p} />;
  if (status === 'pending') return <Clock {...p} />;
  return <Bot {...p} />;
}

type View = { tx: number; ty: number; zoom: number };

export default function GoalGraph2D({ goalTitle, kpis, agents, milestones, onPick, onToggleMilestone, storageKey }: {
  goalTitle: string;
  kpis: Kpi[];
  agents: Agent[];
  milestones: Milestone[];
  onPick?: (sel: { kind: 'agent' | 'kpi' | 'resource'; id: string }) => void;
  onToggleMilestone?: (id: string, done: boolean) => void;
  storageKey?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [hover, setHover] = useState<string | null>(null);

  // Pan/zoom + override posizioni nodi, persistiti per-goal in localStorage.
  const STORE = storageKey ? `goalgraph:${storageKey}` : null;
  const loaded = useMemo(() => {
    if (!STORE) return null;
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
  }, [STORE]);
  const [view, setView] = useState<View>(() => loaded?.view ?? { tx: 0, ty: 0, zoom: 1 });
  const [overrides, setOverrides] = useState<Map<string, [number, number]>>(() => new Map(loaded?.overrides ? Object.entries(loaded.overrides) as [string, [number, number]][] : []));
  useEffect(() => {
    if (!STORE) return;
    const o: Record<string, [number, number]> = {};
    overrides.forEach((v, k) => { o[k] = v; });
    try { localStorage.setItem(STORE, JSON.stringify({ view, overrides: o })); } catch {}
  }, [view, overrides, STORE]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(360, Math.floor(r.height)) }); };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Layout in coordinate astratte (poi scalate a fit). Righe: KPI sopra, Agenti sotto.
  const { nodes, edges, scale } = useMemo(() => {
    const HUB_GAP = 180;   // goal → hub
    const CHILD_GAP = 210; // hub → riga figli (card quadrate, serve spazio)
    const COL = 200;       // passo orizzontale tra figli
    const ROW = 210;       // passo verticale se più righe
    const PER_ROW = 4;     // figli per riga prima di andare a capo

    const nd: Pos[] = [{ id: 'goal', kind: 'goal', label: goalTitle, tone: C_GOAL, x: 0, y: 0 }];
    const ed: { from: string; to: string }[] = [];

    const rowLayout = (items: { id: string; label: string; sub?: string; pickId: string; status?: string }[], hubId: string, hubY: number, dir: 1 | -1, tone: string, kind: 'kpi' | 'agent') => {
      items.forEach((it, i) => {
        const row = Math.floor(i / PER_ROW);
        const inRow = items.slice(row * PER_ROW, row * PER_ROW + PER_ROW);
        const idxInRow = i - row * PER_ROW;
        const x = (idxInRow - (inRow.length - 1) / 2) * COL;
        const y = hubY + dir * (CHILD_GAP + row * ROW);
        nd.push({ id: it.id, kind, label: it.label, sub: it.sub, tone, x, y, pickId: it.pickId, status: it.status });
        ed.push({ from: hubId, to: it.id });
      });
    };

    if (kpis.length) {
      const hubY = -HUB_GAP;
      nd.push({ id: 'kpihub', kind: 'hub', label: 'KPI', tone: C_KPI, x: 0, y: hubY });
      ed.push({ from: 'goal', to: 'kpihub' });
      rowLayout(kpis.map((k) => ({ id: `kpi:${k.id}`, label: k.name, sub: `${k.current}/${k.target}${k.unit ? ` ${k.unit}` : ''}`, pickId: k.id })), 'kpihub', hubY, -1, C_KPI, 'kpi');
    }
    // Bottom half: una COLONNA per milestone → i suoi agenti impilati sotto.
    // Agenti senza milestone finiscono in una colonna "Agenti" generale.
    const general = agents.filter((a) => !a.milestoneId);
    const columns: { key: string; node: Pos; items: Agent[] }[] = [];
    for (const m of milestones) {
      columns.push({
        key: `ms:${m.id}`,
        node: { id: `ms:${m.id}`, kind: 'milestone', label: m.title, sub: m.status, tone: areaColor(m.area), x: 0, y: 0, status: m.status },
        items: agents.filter((a) => a.milestoneId === m.id),
      });
    }
    if (general.length) columns.push({
      key: 'agentshub',
      node: { id: 'agentshub', kind: 'hub', label: 'Agenti', tone: C_AGENT, x: 0, y: 0 },
      items: general,
    });
    // Risorse: NON impilate sotto l'agente, ma distribuite a lato (gutter a
    // destra della colonna), ventaglio verticale centrato sull'agente. Larghezza
    // colonna VARIABILE: milestone restano compatte (200), solo le colonne con
    // risorse ricevono il gutter extra → il resto non si sparpaglia.
    // Milestone più LONTANE dal goal (uniforme) e più RAGGRUPPATE tra loro.
    const HEAD_Y = HUB_GAP + 90, AGENT_ROW = 200;
    const RES_DX = 215;   // offset orizzontale agente → risorse
    const RES_ROW = 96;   // passo verticale tra risorse
    const BASE_COLW = 184;
    // Lato del ventaglio risorse: colonne nella metà DESTRA ventagliano a
    // SINISTRA (verso il centro, lontano dal pannello stats); le altre a destra.
    // Le risorse occupano lo spazio verticalmente vuoto sotto la riga milestone,
    // quindi NON serve allargare le colonne: restano compatte.
    const sideOf = (ci: number) => (ci >= columns.length / 2 ? -1 : 1);
    const colCenter = (columns.length - 1) / 2 * BASE_COLW;
    columns.forEach((col, ci) => {
      const cx = ci * BASE_COLW - colCenter;
      const side = sideOf(ci);
      col.node.x = cx; col.node.y = HEAD_Y;
      nd.push(col.node);
      ed.push({ from: 'goal', to: col.key });
      let y = HEAD_Y + CHILD_GAP;
      col.items.forEach((a) => {
        const aid = `agent:${a.id}`;
        nd.push({ id: aid, kind: 'agent', label: a.title, sub: a.status, tone: C_AGENT, x: cx, y, pickId: String(a.id), status: a.status });
        ed.push({ from: col.key, to: aid });
        const ress = a.resources ?? [];
        // ventaglio verticale centrato sull'agente, sul lato scelto
        ress.forEach((r, ri) => {
          const rid = `res:${a.id}:${ri}`;
          const ry = y + (ri - (ress.length - 1) / 2) * RES_ROW;
          nd.push({ id: rid, kind: 'resource', label: r.path.split('/').pop() || r.path, sub: r.written ? 'scritto' : 'letto', tone: C_RES, x: cx + side * RES_DX, y: ry, resPath: r.path });
          ed.push({ from: aid, to: rid });
        });
        // avanza così che né l'agente né il suo ventaglio si sovrappongano al prossimo
        const resSpan = ress.length > 0 ? (ress.length - 1) * RES_ROW + 120 : 0;
        y += Math.max(AGENT_ROW, resSpan);
      });
    });

    // Fit-to-container. Tutto (card + posizioni) viene scalato insieme via un
    // transform, quindi includo la mezza-dimensione card nel bounding box così
    // le card non escono mai dai bordi né si sovrappongono.
    const HALF = 84; // mezza card (156/2) + margine
    const MARGIN = 16;
    const halfW = Math.max(1, ...nd.map((n) => Math.abs(n.x))) + HALF;
    const halfH = Math.max(1, ...nd.map((n) => Math.abs(n.y))) + HALF;
    const sc = Math.min(1, (size.w / 2 - MARGIN) / halfW, (size.h / 2 - MARGIN) / halfH);
    return { nodes: nd, edges: ed, scale: sc };
  }, [goalTitle, kpis, agents, milestones, size.w, size.h]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b); };
    for (const e of edges) { add(e.from, e.to); add(e.to, e.from); }
    return m;
  }, [edges]);

  // Misura le dimensioni reali (intrinseche, non scalate) di ogni card così le
  // linee terminano sul BORDO del rettangolo, non al centro.
  const nodeEls = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const [sizes, setSizes] = useState<Map<string, { w: number; h: number }>>(new Map());
  useEffect(() => {
    const m = new Map<string, { w: number; h: number }>();
    for (const n of nodes) { const el = nodeEls.current.get(n.id); if (el) m.set(n.id, { w: el.offsetWidth, h: el.offsetHeight }); }
    setSizes(m);
  }, [nodes]);
  const halfH = (id: string) => {
    const s = sizes.get(id);
    if (s) return s.h / 2;
    const k = nodeMap.get(id)?.kind;
    return k === 'goal' || k === 'hub' ? 24 : k === 'resource' ? 34 : k === 'milestone' ? 40 : 78; // fallback
  };
  // Posizione effettiva del nodo (override drag se presente, altrimenti layout).
  const posFinal = (id: string): { x: number; y: number } => {
    const o = overrides.get(id);
    if (o) return { x: o[0], y: o[1] };
    const n = nodeMap.get(id)!; return { x: n.x, y: n.y };
  };
  // Connettore smooth (bezier verticale) da bordo a bordo.
  // Connettore a gomito (ortogonale) con angoli leggermente arrotondati →
  // tracciato netto/angolare invece della curva morbida.
  const edgePath = (from: string, to: string): string => {
    const P = posFinal(from), C = posFinal(to);
    const dir = C.y >= P.y ? 1 : -1;
    const sx = P.x, sy = P.y + dir * halfH(from);
    const ex = C.x, ey = C.y - dir * halfH(to);
    const my = (sy + ey) / 2;
    if (Math.abs(ex - sx) < 1) return `M ${sx} ${sy} L ${ex} ${ey}`; // dritto
    const hsign = ex > sx ? 1 : -1;
    const r = Math.min(14, Math.abs(ex - sx) / 2, Math.abs(my - sy), Math.abs(ey - my));
    return [
      `M ${sx} ${sy}`,
      `L ${sx} ${my - dir * r}`,
      `Q ${sx} ${my} ${sx + hsign * r} ${my}`,
      `L ${ex - hsign * r} ${my}`,
      `Q ${ex} ${my} ${ex} ${my + dir * r}`,
      `L ${ex} ${ey}`,
    ].join(' ');
  };

  const eff = scale * view.zoom; // scala effettiva
  // Drag (pan sfondo + drag nodo) e soppressione click post-drag.
  const drag = useRef<{ kind: 'pan' | 'node'; id?: string; lx: number; ly: number; moved: boolean; captured: boolean; pid: number } | null>(null);
  const suppressClick = useRef(false);
  const onPointerDownBg = (e: React.PointerEvent) => {
    drag.current = { kind: 'pan', lx: e.clientX, ly: e.clientY, moved: false, captured: false, pid: e.pointerId };
  };
  const onPointerDownNode = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    drag.current = { kind: 'node', id, lx: e.clientX, ly: e.clientY, moved: false, captured: false, pid: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
    if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true;
    d.lx = e.clientX; d.ly = e.clientY;
    if (!d.moved) return;
    // Cattura il pointer SOLO quando inizia il drag — così un click puro non
    // viene mangiato dal pointer capture (altrimenti il drawer non si apriva).
    if (!d.captured) { try { wrapRef.current?.setPointerCapture(d.pid); } catch {} d.captured = true; }
    if (d.kind === 'pan') setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
    else if (d.id) {
      const cur = posFinal(d.id);
      const nx = cur.x + dx / eff, ny = cur.y + dy / eff;
      setOverrides((m) => { const n = new Map(m); n.set(d.id!, [nx, ny]); return n; });
    }
  };
  const onPointerUp = () => {
    if (drag.current?.kind === 'node' && drag.current.moved) suppressClick.current = true;
    drag.current = null;
  };
  const zoomBy = (f: number) => setView((v) => ({ ...v, zoom: Math.max(0.3, Math.min(3, v.zoom * f)) }));
  // Trackpad mac emette molti eventi wheel ravvicinati: fattore proporzionale a
  // deltaY con coefficiente piccolo → zoom dolce. Pinch (ctrlKey) ancora più lento.
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const k = e.ctrlKey ? 0.012 : 0.0022;
    const f = Math.exp(-e.deltaY * k);
    setView((v) => ({ ...v, zoom: Math.max(0.3, Math.min(3, v.zoom * f)) }));
  };
  const reset = () => { setOverrides(new Map()); setView({ tx: 0, ty: 0, zoom: 1 }); if (STORE) try { localStorage.removeItem(STORE); } catch {} };

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden cursor-grab active:cursor-grabbing select-none"
      onPointerDown={onPointerDownBg}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onWheel={onWheel}
      style={{
        backgroundColor: '#0b0d14',
        backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)',
        backgroundSize: `${24 * eff}px ${24 * eff}px`,
        backgroundPosition: `${view.tx}px ${view.ty}px`,
      }}
    >
      {/* scaled + panned layer */}
      <div className="absolute left-1/2 top-1/2" style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${eff})`, transformOrigin: '0 0' }}>
      {/* edges — smooth bezier verticali, da bordo a bordo */}
      <svg className="absolute pointer-events-none overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
        {edges.map((e, i) => {
          const lit = hover && (hover === e.from || hover === e.to);
          return <path key={i} d={edgePath(e.from, e.to)} fill="none" stroke={lit ? 'rgba(160,170,210,0.85)' : 'rgba(120,125,150,0.3)'} strokeWidth={lit ? 1.8 : 1.2} strokeLinecap="round" />;
        })}
      </svg>
      {/* nodes */}
      {nodes.map((n) => {
        const pf = posFinal(n.id);
        const x = pf.x, y = pf.y;
        const dim = hover && hover !== n.id && !neighbors.get(hover)?.has(n.id);
        const setRef = (el: HTMLDivElement | null) => { nodeEls.current.set(n.id, el); };
        const HubIcon = n.id === 'kpihub' ? BarChart3 : Bot;

        // ── RESOURCE: documento prodotto/letto da un agente. Click → anteprima.
        if (n.kind === 'resource') {
          const written = n.sub === 'scritto';
          return (
            <div
              key={n.id}
              ref={setRef}
              title={n.resPath}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onPointerDown={(e) => onPointerDownNode(e, n.id)}
              onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (onPick && n.resPath) onPick({ kind: 'resource', id: n.resPath }); }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 w-[190px] rounded-xl border flex items-start gap-2 px-2.5 py-2.5 transition cursor-grab active:cursor-grabbing ${dim ? 'opacity-30' : 'opacity-100'}`}
              style={{
                left: x, top: y,
                borderColor: `${n.tone}80`,
                background: `linear-gradient(155deg, ${n.tone}1f, ${n.tone}0a 60%, ${n.tone}05 100%), #0c0e15`,
                boxShadow: hover === n.id ? `0 0 0 1px ${n.tone}, 0 10px 30px -10px ${n.tone}88` : undefined,
              }}
            >
              <span className="h-7 w-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${n.tone}22`, border: `1px solid ${n.tone}55`, color: n.tone }}>{written ? <FilePen size={15} /> : <FileText size={15} />}</span>
              <div className="min-w-0 text-left">
                <div className="text-[11px] font-semibold leading-snug text-foreground break-all">{n.label}</div>
                <div className="text-[8px] uppercase tracking-wider mt-0.5" style={{ color: n.tone }}>{n.sub}</div>
              </div>
            </div>
          );
        }

        // ── KPI / AGENT / MILESTONE: card verticali coerenti (icona in box sopra,
        // titolo COMPLETO che va a capo, sotto valore/stato). Gradiente per tono.
        if (n.kind === 'kpi' || n.kind === 'agent' || n.kind === 'milestone') {
          const clickable = n.kind === 'kpi' || n.kind === 'agent';
          const Icon = n.kind === 'kpi'
            ? <TrendingUp size={24} />
            : n.kind === 'milestone'
              ? (n.status === 'done' ? <CheckCircle2 size={24} /> : n.status === 'in_progress' ? <Loader2 size={24} /> : <Clock size={24} />)
              : <AgentStatusIcon status={n.status} size={24} color={n.tone} />;
          const subText = n.kind === 'milestone'
            ? (n.status === 'in_progress' ? 'in corso' : n.status === 'done' ? 'completata' : 'da fare')
            : n.sub;
          return (
            <div
              key={n.id}
              ref={setRef}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onPointerDown={(e) => onPointerDownNode(e, n.id)}
              onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } if (clickable && onPick) onPick({ kind: n.kind as 'agent' | 'kpi', id: n.pickId! }); }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 w-[172px] min-h-[150px] rounded-2xl border flex flex-col items-center justify-center gap-2.5 px-3 py-4 text-center transition cursor-grab active:cursor-grabbing ${dim ? 'opacity-30' : 'opacity-100'}`}
              style={{
                left: x, top: y,
                borderColor: `${n.tone}99`,
                // gradiente colore SOPRA una base SOLIDA chiara (surface) → box
                // ben visibile e opaca, niente righe che traspaiono.
                background: `linear-gradient(155deg, ${n.tone}24, ${n.tone}10 55%, ${n.tone}05 100%), #0c0e15`,
                boxShadow: hover === n.id ? `0 0 0 1px ${n.tone}, 0 10px 30px -10px ${n.tone}88` : undefined,
              }}
            >
              {n.kind === 'milestone' && onToggleMilestone && (
                <button
                  title={n.status === 'done' ? 'Segna da fare' : 'Segna come fatta'}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onToggleMilestone(n.id.slice(3), n.status !== 'done'); }}
                  className="absolute top-2.5 right-2.5 h-6 w-6 rounded-md flex items-center justify-center border transition hover:scale-110 cursor-pointer"
                  style={{ borderColor: `${n.tone}99`, background: n.status === 'done' ? n.tone : `${n.tone}1a`, color: n.status === 'done' ? '#0c0e15' : n.tone }}
                >
                  {n.status === 'done' ? <Check size={15} strokeWidth={3} /> : null}
                </button>
              )}
              <span className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${n.tone}22`, border: `1px solid ${n.tone}55`, color: n.tone }}>{Icon}</span>
              <div className="text-[12px] font-semibold leading-snug text-foreground break-words">{n.label}</div>
              {subText && <div className={`leading-tight ${n.kind === 'milestone' ? 'text-[9px] uppercase tracking-wider' : 'text-[12px] font-bold tabular-nums'}`} style={{ color: n.tone }}>{subText}</div>}
            </div>
          );
        }

        // ── GOAL / HUB: pill (testo a capo, niente troncamento)
        return (
          <div
            key={n.id}
            ref={setRef}
            onMouseEnter={() => setHover(n.id)}
            onMouseLeave={() => setHover(null)}
            onPointerDown={(e) => onPointerDownNode(e, n.id)}
            className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-2 rounded-xl border px-3.5 py-2.5 ${n.kind === 'goal' ? 'max-w-[280px]' : 'max-w-[200px]'} transition cursor-grab active:cursor-grabbing ${dim ? 'opacity-30' : 'opacity-100'}`}
            style={{
              left: x, top: y,
              borderColor: n.tone,
              borderWidth: 2,
              background: `linear-gradient(155deg, ${n.tone}44, ${n.tone}14 90%), #1a1e2b`,
            }}
          >
            <span className="shrink-0" style={{ color: n.tone }}>{n.kind === 'goal' ? <Target size={18} /> : <HubIcon size={16} />}</span>
            <div className={`leading-tight break-words ${n.kind === 'goal' ? 'text-[14px] font-bold text-[#ffd7de]' : 'text-[12px] font-semibold uppercase tracking-wider text-foreground'}`}>{n.label}</div>
          </div>
        );
      })}
      </div>

      {/* Controlli (fuori dal layer scalato) */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1.5" onPointerDown={(e) => e.stopPropagation()}>
        <button title="Zoom +" onClick={() => zoomBy(1.2)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/70 backdrop-blur border border-white/10 text-foreground/80 hover:bg-bg/90 transition"><Plus size={16} /></button>
        <button title="Zoom −" onClick={() => zoomBy(0.83)} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/70 backdrop-blur border border-white/10 text-foreground/80 hover:bg-bg/90 transition"><Minus size={16} /></button>
        <button title="Rimetti a posto" onClick={reset} className="h-9 w-9 inline-flex items-center justify-center rounded-lg bg-bg/70 backdrop-blur border border-white/10 text-foreground/80 hover:bg-bg/90 transition"><RotateCcw size={15} /></button>
      </div>
    </div>
  );
}
