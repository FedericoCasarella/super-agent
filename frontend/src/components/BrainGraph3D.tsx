import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import { api } from '../api';
import BrainLoading from './BrainLoading';
import { useWS } from '../ws';

const MRI_GREEN = '#39ff7a';
const MRI_DURATION_MS = 4200;

type Node = { id: string; title: string; kind: string; tags: string[]; size: number; visibility?: 'protected' | 'public' | null; origin_email?: string | null; x?: number; y?: number };
type Link = { source: string | Node; target: string | Node };

// Theme gradient stops (inner-bright → outer-deep), tuned to software palette
type GradStops = [string, string, string];
const KIND_GRAD: Record<string, GradStops> = {
  person:   ['#cffafe', '#22d3ee', '#0e7490'],
  email:    ['#f5d0fe', '#c084fc', '#7c3aed'],
  project:  ['#bbf7d0', '#34d399', '#047857'],
  note:     ['#fef3c7', '#fbbf24', '#b45309'],
  daily:    ['#fae8ff', '#f0abfc', '#a21caf'],
  roadmap:  ['#fed7aa', '#f97316', '#9a3412'],
  task:     ['#ddd6fe', '#a78bfa', '#5b21b6'],
};
const DEFAULT_GRAD: GradStops = ['#f5d0fe', '#c084fc', '#7c3aed'];
const VIS_PROTECTED_GRAD: GradStops = ['#fae8ff', '#d946ef', '#86198f']; // fuchsia
const VIS_PUBLIC_GRAD:    GradStops = ['#cffafe', '#67e8f9', '#0e7490']; // cyan
const LINK_COLOR = 'rgba(45, 45, 50, 0.9)';    // pure dark gray, opaque
const LINK_HI    = 'rgba(125, 211, 252, 0.9)'; // cyan when highlighted
const LINK_DIM   = 'rgba(40, 40, 45, 0.5)';    // dark gray, dimmer when other nodes focused
const SYNAPSE    = '#7dd3fc';
const LABEL = 'rgba(220, 220, 230, 0.85)';
const LABEL_DIM = 'rgba(180, 180, 200, 0.45)';

// Stable hue per origin email
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function originColor(email: string): string {
  return `hsl(${hashHue(email)}, 70%, 62%)`;
}

// Lucide `brain` icon — paths only. Stroke recolored per peer hue. No background.
const BRAIN_PATHS = [
  'M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z',
  'M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z',
  'M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4',
  'M17.599 6.5a3 3 0 0 0 .399-1.375',
  'M6.003 5.125A3 3 0 0 0 6.401 6.5',
  'M3.477 10.896a4 4 0 0 1 .585-.396',
  'M19.938 10.5a4 4 0 0 1 .585.396',
  'M6 18a4 4 0 0 1-1.967-.516',
  'M19.967 17.484A4 4 0 0 1 18 18',
];
const brainImgCache = new Map<string, HTMLImageElement>();
function brainImageFor(color: string): HTMLImageElement {
  let img = brainImgCache.get(color);
  if (img) return img;
  const paths = BRAIN_PATHS.map((d) => `<path d="${d}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  img = new Image();
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  brainImgCache.set(color, img);
  return img;
}

export default function BrainGraph3D({
  onSelect, onDeselect,
  visibilityFilter = 'all',
  originFilter = 'all',
  vaultFilter = 'all',
  onOriginsChange,
  onVaultsChange,
  explorerOpen,
  onToggleExplorer,
}: {
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  visibilityFilter?: 'all' | 'public' | 'protected';
  originFilter?: string;
  vaultFilter?: string;
  onOriginsChange?: (origins: string[]) => void;
  onVaultsChange?: (vaults: string[]) => void;
  explorerOpen?: boolean;
  onToggleExplorer?: () => void;
}) {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] }>({ nodes: [], links: [] });
  const dataRef = useRef<{ nodes: Node[]; links: Link[] }>({ nodes: [], links: [] });
  useEffect(() => { dataRef.current = data; }, [data]);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });

  // MRI map: nodeId → expiry-ms. Lit when agent reads/writes a vault note via brain:access WS.
  const mriRef = useRef<Map<string, number>>(new Map());
  const [mriTick, setMriTick] = useState(0);
  useWS((msg) => {
    if (msg?.type !== 'brain:access') return;
    const p = msg.payload ?? {};
    if (!p.rel) return;
    const now = Date.now();
    const expire = now + MRI_DURATION_MS;
    const rel = String(p.rel);
    // Primary id format: <vault>::<rel>. Also match by rel-only for tolerance.
    const ids = new Set<string>();
    if (p.vaultName) ids.add(`${p.vaultName}::${rel}`);
    // Tolerant fallback: scan current graph for any node whose id endsWith rel
    for (const n of dataRef.current.nodes) {
      if (n.id === rel || n.id.endsWith(`::${rel}`)) ids.add(n.id);
    }
    for (const id of ids) mriRef.current.set(id, expire);
    setMriTick((t) => t + 1);
  });
  // Tick every ~80ms while MRI active to redraw fades
  useEffect(() => {
    if (mriRef.current.size === 0) return;
    const iv = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, end] of mriRef.current) {
        if (end <= now) { mriRef.current.delete(id); changed = true; }
      }
      setMriTick((t) => t + 1);
      if (changed && fgRef.current) (fgRef.current as any).refresh?.();
    }, 80);
    return () => clearInterval(iv);
  }, [mriTick]);

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    api.brainGraphFiltered(visibilityFilter, originFilter, vaultFilter).then((g) => {
      setData(g);
      if (onOriginsChange) onOriginsChange(g.origins ?? []);
      if (onVaultsChange) onVaultsChange((g as any).vaults ?? []);
    }).catch(() => {}).finally(() => setLoaded(true));
  }, [visibilityFilter, originFilter, vaultFilter]);

  // Obsidian-style layout:
  //   - connected nodes form an organic cluster near the center (regular
  //     forceLink + charge does this)
  //   - orphan nodes (zero links) are pushed onto an outer ring so they don't
  //     drift into the main brain or scatter randomly into space
  // Implemented as: per-node degree count → radial force per group.
  useEffect(() => {
    const fg = fgRef.current as any;
    if (!fg) return;
    try {
      const nodes = data.nodes as any[];
      const links = data.links as any[];
      if (!nodes.length) return;
      // Degree map
      const deg = new Map<string, number>();
      for (const l of links) {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        deg.set(s, (deg.get(s) ?? 0) + 1);
        deg.set(t, (deg.get(t) ?? 0) + 1);
      }
      const orphanCount = nodes.filter((n) => !deg.get(n.id)).length;
      // Ring radius scales with orphan count so they fit on a circle.
      const ringR = Math.max(800, 250 + Math.sqrt(Math.max(orphanCount, 1)) * 60);
      const charge = fg.d3Force('charge');
      if (charge?.strength) charge.strength(-520).distanceMax(900);
      const link = fg.d3Force('link');
      if (link?.distance) link.distance(160).strength(0.4);
      // Pull connected nodes toward center
      fg.d3Force('centerConnected', (alpha: number) => {
        for (const n of nodes) {
          if (!deg.get(n.id)) continue;
          const k = 0.05 * alpha;
          n.vx = (n.vx ?? 0) - (n.x ?? 0) * k;
          n.vy = (n.vy ?? 0) - (n.y ?? 0) * k;
        }
      });
      // Push orphan nodes outward to a ring; tangential drift keeps them
      // spread around it instead of clumping.
      fg.d3Force('orphanRing', (alpha: number) => {
        for (const n of nodes) {
          if (deg.get(n.id)) continue;
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          const r = Math.hypot(x, y) || 0.01;
          const k = 0.18 * alpha;
          // radial spring toward ringR
          const factor = (ringR - r) / r * k;
          n.vx = (n.vx ?? 0) + x * factor;
          n.vy = (n.vy ?? 0) + y * factor;
        }
      });
      // Collision so labels don't overlap
      fg.d3Force('collide', (alpha: number) => {
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          const ra = 14 + Math.sqrt(a.size ?? 1) * 1.6 + 28;
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            const rb = 14 + Math.sqrt(b.size ?? 1) * 1.6 + 28;
            const dx = (b.x ?? 0) - (a.x ?? 0);
            const dy = (b.y ?? 0) - (a.y ?? 0);
            const dist = Math.hypot(dx, dy) || 0.01;
            const minDist = ra + rb;
            if (dist < minDist) {
              const push = ((minDist - dist) / dist) * 0.6 * alpha;
              a.vx = (a.vx ?? 0) - dx * push;
              a.vy = (a.vy ?? 0) - dy * push;
              b.vx = (b.vx ?? 0) + dx * push;
              b.vy = (b.vy ?? 0) + dy * push;
            }
          }
        }
      });
      fg.d3ReheatSimulation?.();
    } catch {}
  }, [data]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect();
      setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // neighbor map for hover highlighting
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set());
      m.get(a)!.add(b);
    };
    for (const l of data.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as Node).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as Node).id;
      add(s, t); add(t, s);
    }
    return m;
  }, [data]);

  // Highlight links only on hover — clicking a node opens the side panel
  // without recoloring the entire graph.
  const active = hover;
  const hi = active ? new Set([active, ...(neighbors.get(active) ?? [])]) : null;

  const nodePaint = useCallback((node: any, ctx: CanvasRenderingContext2D, scale: number) => {
    if (node.x == null || node.y == null) return;
    // Foreign-origin nodes override theme color with a per-user hue
    const isForeign = !!node.origin_email;
    const stops: GradStops =
      node.visibility === 'protected' ? VIS_PROTECTED_GRAD
      : node.visibility === 'public'  ? VIS_PUBLIC_GRAD
      : (KIND_GRAD[node.kind] ?? DEFAULT_GRAD);
    const color = isForeign ? originColor(node.origin_email) : stops[1];
    const darkRim = isForeign ? `hsl(${hashHue(node.origin_email)}, 70%, 35%)` : stops[2];
    const r = (isForeign ? 5 : 4) + Math.sqrt(node.size) * 1.6;
    const dim = hi && !hi.has(node.id);

    ctx.save();
    ctx.globalAlpha = dim ? 0.3 : 1;

    // MRI pulse: green halo + brighter fill envelope when this node was just accessed
    const mriEnd = mriRef.current.get(node.id);
    if (mriEnd && mriEnd > Date.now()) {
      const remaining = mriEnd - Date.now();
      const phase = 1 - remaining / MRI_DURATION_MS; // 0→1
      // sin envelope: 0 → 1 → 0
      const env = Math.sin(phase * Math.PI);
      const haloR = r + (10 + env * 14) / scale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(57,255,122,${0.10 + 0.25 * env})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(node.x, node.y, haloR * 0.65, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(57,255,122,${0.5 + 0.5 * env})`;
      ctx.lineWidth = (1.5 + 1.5 * env) / scale;
      ctx.stroke();
    }
    void mriTick;

    if (isForeign) {
      // Foreign brain: lucide brain icon stroked in peer hue, NO background
      const img = brainImageFor(color);
      const size = r * 2.4;
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, node.x - size / 2, node.y - size / 2, size, size);
      } else {
        // First-paint fallback while SVG loads — small dot so node is visible
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r * 0.3, 0, Math.PI * 2);
        ctx.fill();
        // Trigger repaint when image is ready
        img.onload = () => {
          /* canvas-graph redraws on next sim tick; nothing else needed */
        };
      }
    } else {
      // Native: solid disc
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = darkRim;
      ctx.lineWidth = 1.2 / scale;
      ctx.stroke();
    }

    // Selection / hover ring
    if (selected === node.id || hover === node.id) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.4 / scale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 3 / scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Label — only show when zoomed in OR node is in focus
    const isFocused = hover === node.id || selected === node.id || hi?.has(node.id);
    const showLabel = isFocused || scale > 1.4;
    if (showLabel) {
      const label = (node.title || node.id);
      const trimmed = label.length > 32 ? label.slice(0, 31) + '…' : label;
      const fontSize = 11 / scale;
      ctx.save();
      ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const textW = ctx.measureText(trimmed).width;
      const padX = 5 / scale;
      const padY = 3 / scale;
      const boxX = node.x - textW / 2 - padX;
      const boxY = node.y + r + 4 / scale;
      // pill background for legibility
      ctx.fillStyle = isFocused ? 'rgba(19,19,26,0.96)' : 'rgba(19,19,26,0.78)';
      ctx.strokeStyle = isFocused ? color + 'cc' : 'rgba(40,40,55,0.6)';
      ctx.lineWidth = 0.6 / scale;
      const boxH = fontSize + padY * 2;
      const boxW = textW + padX * 2;
      const radius = boxH / 2;
      ctx.beginPath();
      ctx.moveTo(boxX + radius, boxY);
      ctx.lineTo(boxX + boxW - radius, boxY);
      ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + radius);
      ctx.lineTo(boxX + boxW, boxY + boxH - radius);
      ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - radius, boxY + boxH);
      ctx.lineTo(boxX + radius, boxY + boxH);
      ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - radius);
      ctx.lineTo(boxX, boxY + radius);
      ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = isFocused ? '#ffffff' : 'rgba(220,220,230,0.78)';
      ctx.fillText(trimmed, node.x, boxY + padY);
      ctx.restore();
    }
  }, [hi, hover, selected, mriTick]);

  const linkColor = useCallback((link: any) => {
    if (!hi) return LINK_COLOR;
    const s = typeof link.source === 'object' ? link.source.id : link.source;
    const t = typeof link.target === 'object' ? link.target.id : link.target;
    return hi.has(s) && hi.has(t) ? LINK_HI : LINK_DIM;
  }, [hi]);

  // Idle = dark gray everywhere. On hover, only the links touching the hovered
  // node light up cyan; the rest stay dark gray.
  const linkPaint = useCallback((link: any, ctx: CanvasRenderingContext2D, scale: number) => {
    const s = typeof link.source === 'object' ? link.source : null;
    const t = typeof link.target === 'object' ? link.target : null;
    if (!s || !t) return;
    const focus = hover ?? selected;
    const isHot = !!focus && (s.id === focus || t.id === focus);
    ctx.save();
    ctx.strokeStyle = isHot ? LINK_HI : LINK_COLOR;
    ctx.lineWidth = (isHot ? 1.4 : 0.7) / scale;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(t.x, t.y);
    ctx.stroke();
    ctx.restore();
  }, [hover, selected]);

  return (
    <div ref={wrapRef} className="w-full h-full relative" style={{ background: '#0f0f12' }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center z-10"><BrainLoading size={140} label="Caricamento cervello…" /></div>
      )}
      {loaded && data.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">empty vault</div>
      )}
      <ForceGraph2D
        ref={fgRef as any}
        graphData={data as any}
        width={size.w}
        height={size.h}
        backgroundColor="#0f0f12"
        nodeRelSize={4}
        nodeCanvasObject={nodePaint}
        nodePointerAreaPaint={(node: any, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 8, 0, Math.PI * 2);
          ctx.fill();
        }}
        linkColor={linkColor}
        linkCanvasObjectMode={() => 'replace'}
        linkCanvasObject={linkPaint}
        linkWidth={1.2}
        linkDirectionalParticles={(l: any) => {
          const focus = hover ?? selected;
          if (!focus) return 0;
          const s = typeof l.source === 'object' ? l.source.id : l.source;
          const t = typeof l.target === 'object' ? l.target.id : l.target;
          return (s === focus || t === focus) ? 5 : 0;
        }}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleWidth={3.5}
        linkDirectionalParticleColor={() => SYNAPSE}
        onNodeHover={(n: any) => setHover(n?.id ?? null)}
        onNodeClick={(n: any) => {
          setSelected(n.id);
          onSelect(n.id);
          const fg = fgRef.current;
          if (fg && n.x !== undefined) fg.centerAt(n.x, n.y, 600);
        }}
        onBackgroundClick={() => { setSelected(null); onDeselect?.(); }}
        cooldownTicks={200}
        d3VelocityDecay={0.3}
        enableNodeDrag
      />
    </div>
  );
}
