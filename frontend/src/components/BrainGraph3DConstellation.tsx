import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph3D, { ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';
import { api } from '../api';
import { useWS } from '../ws';
import BrainLoading from './BrainLoading';

const MRI_GREEN = '#39ff7a';
const MRI_DURATION_MS = 4200;

type Node = {
  id: string;
  title: string;
  kind: string;
  size: number;
  visibility?: 'protected' | 'public' | null;
  origin_email?: string | null;
  x?: number; y?: number; z?: number;
};
type Link = { source: string | Node; target: string | Node };

const KIND_COLOR: Record<string, string> = {
  person:   '#22d3ee',
  email:    '#c084fc',
  project:  '#34d399',
  note:     '#fbbf24',
  daily:    '#f0abfc',
  roadmap:  '#f97316',
  task:     '#a78bfa',
};
const DEFAULT_COLOR = '#c084fc';
const VIS_PROTECTED = '#d946ef';
const VIS_PUBLIC = '#67e8f9';

// Bounce easing: overshoots past 1 then settles — the "leggero rimbalzo".
function easeOutBack(x: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function originColor(email: string): string {
  return `hsl(${hashHue(email)}, 70%, 65%)`;
}
import { colorForNode as paletteColor } from '../brainColors';

// Cluster key = top folder of the relative path (id format: "<vault>::<rel>" or "<rel>").
// "agents/foo.md" → "agents", "Companies/Bora/note.md" → "companies", root files → "_misc".
function clusterOf(n: any): string {
  if (n?.__isRoot) return '_root';
  if (n?.__cluster) return n.__cluster;
  const id: string = String(n?.id ?? '');
  const rel = id.includes('::') ? id.split('::').slice(1).join('::') : id;
  const parts = rel.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0].toLowerCase() : '_misc';
}
function clusterColor(c: string): string {
  if (c === '_root') return '#ff5577';
  if (c === '_misc') return '#888aa0';
  return `hsl(${hashHue(c)}, 75%, 62%)`;
}

function colorFor(node: any): string {
  if (node.__isRoot) return '#ff6680';
  if (node.__isHub) return clusterColor(node.__cluster);
  if (node.origin_email) return originColor(node.origin_email);
  // Cluster color takes precedence over palette → cluster cohesion visible.
  return clusterColor(clusterOf(node));
}

// Build hub-of-cluster + root nodes, link every real node to its hub, every hub to root.
// Keeps original real nodes/links intact for click resolution.
function enhanceGraph(g: { nodes: any[]; links: any[]; origins?: string[]; vaults?: string[] }) {
  const realNodes = (g.nodes ?? []).map((n) => ({ ...n, __cluster: clusterOf(n) }));
  const clusters = Array.from(new Set(realNodes.map((n) => n.__cluster))).filter((c) => c !== '_root').sort();
  // Fibonacci sphere distribution → hubs spread evenly in 3D
  const dirs = new Map<string, [number, number, number]>();
  const N = Math.max(1, clusters.length);
  clusters.forEach((c, i) => {
    const phi = Math.acos(1 - 2 * (i + 0.5) / N);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    dirs.set(c, [
      Math.cos(theta) * Math.sin(phi),
      Math.sin(theta) * Math.sin(phi),
      Math.cos(phi),
    ]);
  });
  // Galaxy layout: root pinned at center, hubs pinned at Fibonacci directions.
  // d3's fx/fy/fz freeze a node's position — NOTHING (charge, links, custom
  // force) can move it. This guarantees:
  //   - BRAIN always at exact center
  //   - cluster hubs spread in 3D, fixed forever
  //   - cross-cluster wikilinks can't drag clusters together
  //
  // Radius = IMPORTANCE: clusters with more notes orbit CLOSER to the brain
  // (gravity metaphor), small ones drift to the outer shell. Gives depth
  // variety instead of everything pinned on one sphere surface.
  const countByCluster = new Map<string, number>();
  for (const n of realNodes) countByCluster.set(n.__cluster, (countByCluster.get(n.__cluster) ?? 0) + 1);
  const maxCount = Math.max(1, ...countByCluster.values());
  const R_NEAR = 250;  // biggest cluster
  const R_FAR = 540;   // smallest cluster
  const radiusFor = (c: string): number => {
    // sqrt scale → mid-size clusters don't all collapse to the outer edge
    const t = Math.sqrt((countByCluster.get(c) ?? 1) / maxCount);
    return R_FAR - (R_FAR - R_NEAR) * t;
  };
  const hubs = clusters.map((c) => {
    const d = dirs.get(c)!;
    const R = radiusFor(c);
    const x = d[0] * R, y = d[1] * R, z = d[2] * R;
    return {
      id: `__hub__:${c}`,
      title: c.toUpperCase(),
      kind: 'hub',
      size: 9,
      __isHub: true,
      __cluster: c,
      x, y, z,
      fx: x, fy: y, fz: z, // PINNED
    };
  });
  const root = {
    id: '__root__',
    title: 'BRAIN',
    kind: 'root',
    size: 16,
    __isRoot: true,
    __cluster: '_root',
    x: 0, y: 0, z: 0,
    fx: 0, fy: 0, fz: 0, // PINNED at origin
  };
  // STATIC neuron layout — NO force simulation (which made teardrop "imbuti").
  // Structure requested: BRAIN --1 synapse--> hub (macro-set node) --> every
  // child at the SAME distance from its hub, but on the OUTER hemisphere (the
  // side AWAY from the brain) so the children do NOT surround/englobe the hub —
  // the hub sits at the inner vertex, free, children fan outward like dendrites.
  // All equidistant (× shell). Pinned via fx/fy/fz so nothing drifts.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  // Per-cluster orthonormal basis: outward axis = hub direction, + 2 perps.
  const basis = new Map<string, { d: number[]; u: number[]; v: number[] }>();
  for (const c of clusters) {
    const d = dirs.get(c)!;
    const ref = Math.abs(d[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    let ux = d[1] * ref[2] - d[2] * ref[1];
    let uy = d[2] * ref[0] - d[0] * ref[2];
    let uz = d[0] * ref[1] - d[1] * ref[0];
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const vx = d[1] * uz - d[2] * uy;
    const vy = d[2] * ux - d[0] * uz;
    const vz = d[0] * uy - d[1] * ux;
    basis.set(c, { d, u: [ux, uy, uz], v: [vx, vy, vz] });
  }
  const idxInCluster = new Map<string, number>();
  for (const n of realNodes) {
    const b = basis.get(n.__cluster);
    if (!b) continue;
    const R = radiusFor(n.__cluster);
    const hx = b.d[0] * R, hy = b.d[1] * R, hz = b.d[2] * R;
    const m = countByCluster.get(n.__cluster) ?? 1;
    const j = idxInCluster.get(n.__cluster) ?? 0;
    idxInCluster.set(n.__cluster, j + 1);
    const shell = 150 + Math.sqrt(m) * 4.2;         // FAR from the hub — clear gap; all children equidistant
    // Narrow outward cap (cosA in [0.32,1] ≈ ≤70°) so children cluster well
    // away from the hub on the outward side — never lateral/behind it.
    const cosA = 1 - 0.68 * (j + 0.5) / m;           // 1 (straight out) → 0.32 (rim)
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const theta = GOLDEN * j;
    const lu = Math.cos(theta) * sinA, lv = Math.sin(theta) * sinA;
    n.x = n.fx = hx + (b.u[0] * lu + b.v[0] * lv + b.d[0] * cosA) * shell;
    n.y = n.fy = hy + (b.u[1] * lu + b.v[1] * lv + b.d[1] * cosA) * shell;
    n.z = n.fz = hz + (b.u[2] * lu + b.v[2] * lv + b.d[2] * cosA) * shell;
  }
  const extraLinks: any[] = [];
  for (const n of realNodes) extraLinks.push({ source: n.id, target: `__hub__:${n.__cluster}`, __synthetic: true });
  for (const h of hubs) extraLinks.push({ source: h.id, target: '__root__', __synthetic: true });
  // Render ONLY the star topology: BRAIN→hub spines + hub→child spokes. Drop the
  // intra-cluster wikilink web — it cluttered the clean neuron shape.
  const sameClusterLinks: any[] = [];
  return {
    nodes: [root, ...hubs, ...realNodes],
    links: [...sameClusterLinks, ...extraLinks],
    origins: g.origins ?? [],
    vaults: g.vaults ?? [],
    clusters,
    dirs,
  };
}

// Particles per node emitter (firing axons) — selectable density
const DENSITY_PRESETS: Record<string, number> = { low: 60, med: 180, high: 400 };
const DENSITY_LABEL: Record<string, string> = { low: 'L', med: 'M', high: 'H' };
const DENSITY_ORDER = ['low', 'med', 'high'] as const;
type Density = typeof DENSITY_ORDER[number];

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const label = text.length > 28 ? text.slice(0, 27) + '…' : text;
  const padX = 14, padY = 8, fontSize = 38;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const h = fontSize + padY * 2;
  canvas.width = w; canvas.height = h;
  ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(8,12,20,0.85)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, padX, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.18;
  sprite.scale.set(w * scale, h * scale, 1);
  return sprite;
}

export default function BrainGraph3DConstellation({
  onSelect, onDeselect,
  visibilityFilter = 'all',
  originFilter = 'all',
  vaultFilter = 'all',
  onOriginsChange,
  onVaultsChange,
  explorerOpen,
  onToggleExplorer,
  focusId,
  onGoalClick,
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
  focusId?: string | null;
  onGoalClick?: (goalId: number) => void;
}) {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[]; clusters?: string[]; dirs?: Map<string, [number, number, number]> }>({ nodes: [], links: [] });
  // degree map kept in a ref so nodeVisibility callback doesn't allocate.
  const degreeRef = useRef<Map<string, number>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // External focus (file-explorer click). When focusId changes, locate the
  // matching node and run the same camera zoom-to-node animation used by
  // intra-graph clicks. Wrapped in setTimeout so we wait for the simulation
  // to assign x/y/z if the user clicked before forces settled.
  useEffect(() => {
    if (!focusId) return;
    const fg: any = fgRef.current;
    if (!fg) return;
    let cancelled = false;
    function tryFocus(attempt: number) {
      if (cancelled) return;
      const n: any = (data.nodes as any[]).find((x) => x.id === focusId);
      if (!n || n.x == null) {
        if (attempt < 30) setTimeout(() => tryFocus(attempt + 1), 100);
        return;
      }
      setSelected(n.id);
      const dist = 130;
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      const ratio = 1 + dist / len;
      fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n, 1000);
    }
    tryFocus(0);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, data.nodes]);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // One-at-a-time bounce reveal (positions are static, so this just animates
  // each leaf's SCALE 0→overshoot→1 as it's born). State in refs → no React
  // re-renders. bornAt[i] = ms it started (-1 = not yet); nextReveal = how many
  // started; settled = full-scale prefix.
  const revealActiveRef = useRef(false);
  const bornAtRef = useRef<Float64Array>(new Float64Array(0));
  const nextRevealRef = useRef(0);
  const settledRef = useRef(0);
  const LS_READ = (k: string, d: string): string => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const LS_WRITE = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
  const [showLabels, setShowLabelsState] = useState<boolean>(() => LS_READ('brain_3d_labels', '1') !== '0');
  const setShowLabels = (next: boolean | ((v: boolean) => boolean)) => {
    setShowLabelsState((prev) => {
      const v = typeof next === 'function' ? (next as (v: boolean) => boolean)(prev) : next;
      LS_WRITE('brain_3d_labels', v ? '1' : '0');
      return v;
    });
  };
  // Particle field permanently disabled — only static line mode.
  const showParticles = false;
  const [density, setDensityState] = useState<Density>(() => {
    const v = LS_READ('brain_3d_density', 'med') as Density;
    return DENSITY_PRESETS[v] ? v : 'med';
  });
  const setDensity = (next: Density | ((v: Density) => Density)) => {
    setDensityState((prev) => {
      const v = typeof next === 'function' ? (next as (v: Density) => Density)(prev) : next;
      LS_WRITE('brain_3d_density', v);
      return v;
    });
  };
  const PER_NODE = DENSITY_PRESETS[density];
  useEffect(() => {
    const f = (fieldRef.current as any);
    if (f?.points) f.points.visible = showParticles;
  }, [showParticles]);
  const fieldRef = useRef<{
    points: THREE.Points;
    positions: Float32Array;
    colors: Float32Array;
    baseColors: Float32Array;
    sourceIdx: Int32Array;
    targetIdx: Int32Array;
    t: Float32Array;
    speed: Float32Array;
    curveAmp: Float32Array;
    curveAxis: Float32Array; // 3 floats per particle
  } | null>(null);
  const neighborsRef = useRef<Map<number, number[]>>(new Map());
  const focusIdxSetRef = useRef<Set<number> | null>(null);
  const focusDirtyRef = useRef<boolean>(false);
  const idToIdxRef = useRef<Map<string, number>>(new Map());
  // MRI active set: nodeId → { start, end } ms timestamps for envelope animation
  const mriRef = useRef<Map<string, { start: number; end: number }>>(new Map());
  // Halo objects added to active node groups (for cleanup)
  const haloRef = useRef<Map<string, THREE.Group>>(new Map());
  // Thunder effect: additive glow sprites flashing around just-read nodes
  // (lightning-in-clouds). Pool keyed by node id; lives in its own scene group.
  const thunderGroupRef = useRef<THREE.Group | null>(null);
  const thunderSpritesRef = useRef<Map<string, THREE.Sprite>>(new Map()); // keyed by cluster
  // Per-cluster bounding geom (centroid + radius) so a flash lights the whole
  // SECTOR of spheres, not a single node. Rebuilt on data change.
  const clusterGeomRef = useRef<Map<string, { x: number; y: number; z: number; r: number }>>(new Map());
  const [mriTick, setMriTick] = useState(0);
  useWS((msg) => {
    if (msg?.type !== 'brain:access') return;
    const p = msg.payload ?? {};
    if (!p.rel) return;
    // Only flash for the user's interactive chat turn — background perks
    // (reflection, consolidator, ingest, …) read notes constantly and would
    // make the brain strobe with "random" thunder when nothing user-facing
    // is happening.
    if (p.kind !== 'chat_turn') return;
    const rel = String(p.rel);
    const now = Date.now();
    // Match by exact <vault>::<rel> AND by rel-suffix fallback — graph may use a different
    // vault label than the emitter (e.g. legacy 'default' vs renamed primary).
    const ids = new Set<string>();
    if (p.vaultName) ids.add(`${p.vaultName}::${rel}`);
    for (const [nid] of idToIdxRef.current) {
      if (nid === rel || nid.endsWith(`::${rel}`)) ids.add(nid);
    }
    for (const id of ids) mriRef.current.set(id, { start: now, end: now + MRI_DURATION_MS });
    focusDirtyRef.current = true;
    setMriTick((t) => t + 1);
  });
  // Tick only when MRI active — skip otherwise to keep idle CPU low
  useEffect(() => {
    const iv = setInterval(() => {
      if (mriRef.current.size === 0) return;
      const now = Date.now();
      for (const [k, v] of mriRef.current) {
        if (v.end <= now) mriRef.current.delete(k);
      }
      setMriTick((t) => t + 1);
    }, 500);
    return () => clearInterval(iv);
  }, []);

  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setLoaded(false);
    api.brainGraphFiltered(visibilityFilter, originFilter, vaultFilter).then((g: any) => {
      const enhanced = enhanceGraph(g);
      revealActiveRef.current = true; // arm bounce reveal (build effect inits it)
      setData(enhanced as any);
      if (onOriginsChange) onOriginsChange(enhanced.origins ?? []);
      if (onVaultsChange) onVaultsChange(enhanced.vaults ?? []);
    }).catch(() => {}).finally(() => setLoaded(true));
  }, [visibilityFilter, originFilter, vaultFilter]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(100, Math.floor(r.width));
      const h = Math.max(100, Math.floor(r.height));
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  // Force layout — clusters as compact balls around each hub, hubs anchored
  // far apart on a Fibonacci sphere, root pinned at origin. Key insights:
  //
  // 1. Leaves orbit their hub DYNAMICALLY (follow hub position each tick), not
  //    a static direction → as hubs settle, leaves stay attached.
  // 2. Generic charge dropped HARD on leaves (-25) so they don't push their
  //    own siblings out of the cluster ball. Hubs/root get strong repulsion
  //    so clusters never overlap.
  // 3. Real wikilinks across clusters get strength 0.02 (≈zero) → they don't
  //    drag clusters together. Same-cluster wikilinks stay strong (0.5) →
  //    related notes tighten further inside the ball.
  // 4. Synthetic leaf→hub links short + strong → cluster cohesion.
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    try {
      const charge = fg.d3Force?.('charge');
      if (charge?.strength) {
        // Leaf charge -110 (was -25): the grappolo breathes — notes spread
        // inside the cluster ball instead of collapsing onto the hub.
        charge
          .strength((n: any) => n?.__isRoot ? -9000 : n?.__isHub ? -6000 : -110)
          .distanceMax(2200)
          .theta(0.9);
      }
      const link = fg.d3Force?.('link');
      if (link?.distance) {
        link.distance((l: any) => {
          const srcObj = typeof l.source === 'object' ? l.source : null;
          const tgtObj = typeof l.target === 'object' ? l.target : null;
          if (tgtObj?.__isRoot || srcObj?.__isRoot) return 380; // hub → root: long
          if (tgtObj?.__isHub || srcObj?.__isHub) return 95;    // leaf → hub: roomy orbit
          // Real wikilink: same-cluster = tight, cross-cluster = ignore distance
          const sc = srcObj?.__cluster;
          const tc = tgtObj?.__cluster;
          return sc && sc === tc ? 60 : 400;
        }).strength((l: any) => {
          const srcObj = typeof l.source === 'object' ? l.source : null;
          const tgtObj = typeof l.target === 'object' ? l.target : null;
          if (tgtObj?.__isHub || srcObj?.__isHub) return 0.7;   // leaf → hub: anchor (softer → more spread)
          if (tgtObj?.__isRoot || srcObj?.__isRoot) return 0.7;
          // Real wikilink: same cluster cohesion vs cross-cluster ≈zero so
          // clusters never get dragged into each other. Render link stays
          // visible (drawn from raw geometry), just doesn't apply force.
          const sc = srcObj?.__cluster;
          const tc = tgtObj?.__cluster;
          return sc && sc === tc ? 0.4 : 0;
        });
      }
      // Kill d3 center force — root is pinned at origin via fx/fy/fz already.
      const center = fg.d3Force?.('center');
      if (center?.strength) center.strength(0);
      // Bounding-sphere clamp: any leaf drifting past MAX_R gets pulled back
      // hard, so the entire graph stays INSIDE the wireframe globe. Hubs/root
      // are pinned via fx/fy/fz so they're skipped automatically.
      const MAX_R = 640;
      fg.d3Force?.('bound', (_alpha: number) => {
        const nodes = (data.nodes as any[]);
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (n.__isHub || n.__isRoot) continue; // pinned
          const x = n.x ?? 0, y = n.y ?? 0, z = n.z ?? 0;
          const r = Math.sqrt(x * x + y * y + z * z);
          if (r > MAX_R) {
            const k = MAX_R / r;
            n.x = x * k; n.y = y * k; n.z = z * k;
            // Damp outward velocity component
            n.vx = (n.vx ?? 0) * 0.3;
            n.vy = (n.vy ?? 0) * 0.3;
            n.vz = (n.vz ?? 0) * 0.3;
          }
        }
      });
      fg.d3ReheatSimulation?.();
      // One-shot camera framing so the whole sphere fits on screen.
      setTimeout(() => {
        try { fg.cameraPosition?.({ x: 0, y: 0, z: 1500 }, { x: 0, y: 0, z: 0 }, 800); } catch {}
      }, 100);
    } catch {}
  }, [data]);

  // Particle field DISABLED — no flowing dots between nodes
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    const scene = fg.scene();
    if (fieldRef.current) {
      scene.remove(fieldRef.current.points);
      fieldRef.current.points.geometry.dispose();
      (fieldRef.current.points.material as THREE.Material).dispose();
      fieldRef.current = null;
    }
    // Still need neighbor map for MRI focus highlighting
    const idToIdx = new Map<string, number>();
    data.nodes.forEach((n, i) => idToIdx.set(n.id, i));
    const neighbors = new Map<number, number[]>();
    for (let i = 0; i < data.nodes.length; i++) neighbors.set(i, []);
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as Node).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as Node).id : l.target;
      const si = idToIdx.get(s); const ti = idToIdx.get(t);
      if (si == null || ti == null) continue;
      neighbors.get(si)!.push(ti);
      neighbors.get(ti)!.push(si);
    }
    neighborsRef.current = neighbors;
    idToIdxRef.current = idToIdx;
    // Build degree map for LOD orphan hiding.
    const deg = new Map<string, number>();
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as Node).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as Node).id : l.target;
      deg.set(s, (deg.get(s) ?? 0) + 1);
      deg.set(t, (deg.get(t) ?? 0) + 1);
    }
    degreeRef.current = deg;
  }, [data, PER_NODE]);

  // Build focus index set + mark dirty whenever hover/select changes
  useEffect(() => {
    const focus = hover ?? selected;
    if (!focus) {
      focusIdxSetRef.current = null;
    } else {
      const set = new Set<number>();
      const idx = idToIdxRef.current.get(focus);
      if (idx != null) {
        set.add(idx);
        for (const n of (neighborsRef.current.get(idx) ?? [])) set.add(n);
      }
      focusIdxSetRef.current = set;
    }
    focusDirtyRef.current = true;
  }, [hover, selected, data]);

  // Animation loop — particles flow source→target along curved path, then respawn on new neighbor
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    // Per-cluster centroid + radius → a thunder flash lights the whole sector.
    {
      const acc = new Map<string, { sx: number; sy: number; sz: number; n: number }>();
      for (const n of data.nodes as any[]) {
        if (n.__isRoot) continue;
        const c = n.__cluster ?? '_misc';
        const a = acc.get(c) ?? { sx: 0, sy: 0, sz: 0, n: 0 };
        a.sx += n.x ?? 0; a.sy += n.y ?? 0; a.sz += n.z ?? 0; a.n++;
        acc.set(c, a);
      }
      const geom = new Map<string, { x: number; y: number; z: number; r: number }>();
      for (const [c, a] of acc) geom.set(c, { x: a.sx / a.n, y: a.sy / a.n, z: a.sz / a.n, r: 60 });
      for (const n of data.nodes as any[]) {
        if (n.__isRoot) continue;
        const c = n.__cluster ?? '_misc';
        const g = geom.get(c)!;
        const d = Math.hypot((n.x ?? 0) - g.x, (n.y ?? 0) - g.y, (n.z ?? 0) - g.z);
        if (d > g.r) g.r = d;
      }
      clusterGeomRef.current = geom;
    }
    // Auto-rotate ON (slow), edge particle animations OFF
    const ctrls0: any = fg.controls?.();
    if (ctrls0) { ctrls0.autoRotate = true; ctrls0.autoRotateSpeed = 0.04; }

    // Track user interaction to pause manual orbit
    const lastInteractRef = { current: 0 };
    const hoveringRef = { current: false };
    const dom: HTMLElement | undefined = fg.renderer?.()?.domElement;
    const onInteract = () => { lastInteractRef.current = performance.now(); };
    const onEnter = () => { hoveringRef.current = true; };
    const onLeave = () => { hoveringRef.current = false; };
    if (dom) {
      dom.addEventListener('pointerdown', onInteract);
      dom.addEventListener('wheel', onInteract, { passive: true });
      dom.addEventListener('pointerenter', onEnter);
      dom.addEventListener('pointerleave', onLeave);
    }

    let raf = 0;
    let stopped = false;
    let last = performance.now();
    let frameTick = 0;
    const loop = () => {
      if (stopped) return;
      const now = performance.now();
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      frameTick++;
      const f = fieldRef.current;
      const nbrs = neighborsRef.current;
      // Skip the entire particle simulation when synapse animation is off.
      if (showParticles && f && data.nodes.length > 0) {
        const { positions, colors, baseColors, sourceIdx, targetIdx, t, speed, curveAmp, curveAxis } = f;
        const nodes = data.nodes as any[];
        const totalP = sourceIdx.length;
        // MRI: compute envelope per active node, sweep expired
        const nowMs = Date.now();
        const G = new THREE.Color(MRI_GREEN);
        const mriEnv = new Map<number, number>(); // node idx → envelope (0..1)
        if (mriRef.current.size > 0) {
          for (const [k, v] of mriRef.current) {
            if (v.end <= nowMs) { mriRef.current.delete(k); continue; }
            const t01 = (nowMs - v.start) / (v.end - v.start);
            // Smooth pulse envelope: ease-in/out via sin
            const env = Math.sin(Math.max(0, Math.min(1, t01)) * Math.PI);
            const idx = idToIdxRef.current.get(k);
            if (idx != null) mriEnv.set(idx, env);
          }
          focusDirtyRef.current = true;
        }
        // Recolor particles each frame when MRI active OR focus dirty
        if (focusDirtyRef.current || mriEnv.size > 0) {
          const fset = focusIdxSetRef.current;
          for (let i = 0; i < totalP; i++) {
            const src = sourceIdx[i];
            const tgt = targetIdx[i];
            const eS = mriEnv.get(src) ?? 0;
            const eT = mriEnv.get(tgt) ?? 0;
            const e = Math.max(eS, eT);
            if (e > 0) {
              // Lerp baseColor → green by envelope, boost brightness
              const k = 1.0;
              const r = baseColors[i * 3]     * (1 - e) + G.r * e;
              const g = baseColors[i * 3 + 1] * (1 - e) + G.g * e;
              const b = baseColors[i * 3 + 2] * (1 - e) + G.b * e;
              colors[i * 3]     = r * k;
              colors[i * 3 + 1] = g * k;
              colors[i * 3 + 2] = b * k;
              continue;
            }
            const dim = fset ? (!(fset.has(src) || fset.has(tgt))) : false;
            const k = dim ? 0.1 : 1.0;
            colors[i * 3]     = baseColors[i * 3]     * k;
            colors[i * 3 + 1] = baseColors[i * 3 + 1] * k;
            colors[i * 3 + 2] = baseColors[i * 3 + 2] * k;
          }
          (f.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
          focusDirtyRef.current = false;
        }
        // Per-frame node mesh tint for MRI — solid green when active, restore otherwise (no halo/scale anim)
        if (mriRef.current.size > 0 || haloRef.current.size > 0) {
          const fgAny: any = fg;
          const gd = fgAny.graphData?.() ?? null;
          if (gd) {
            const activeIds = new Set(mriRef.current.keys());
            for (const n of gd.nodes) {
              const isActive = activeIds.has(n.id);
              const env = isActive ? 1 : 0;
              const obj = (n as any).__threeObj as THREE.Object3D | undefined;
              if (!obj) continue;
              // Solid green color when active, no scale/emissive/halo anim
              obj.traverse((c: any) => {
                if (c.isMesh && c.material) {
                  const mat: any = c.material;
                  if (!mat.userData.__baseColor) mat.userData.__baseColor = mat.color.clone();
                  mat.color.copy(env > 0 ? G : mat.userData.__baseColor);
                }
              });
              activeIds.delete(n.id);
            }
            // Cleanup halos whose node disappeared
            for (const stale of activeIds) {
              const halo = haloRef.current.get(stale);
              if (halo) {
                halo.parent?.remove(halo);
                halo.traverse((c: any) => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } });
                haloRef.current.delete(stale);
              }
            }
          }
        }
        for (let i = 0; i < totalP; i++) {
          t[i] += speed[i] * dt;
          if (t[i] >= 1) {
            // Reached target → become new source, pick new neighbor target
            const newSrc = targetIdx[i];
            const list = nbrs.get(newSrc) ?? [];
            const newTgt = list.length ? list[Math.floor(Math.random() * list.length)] : newSrc;
            sourceIdx[i] = newSrc;
            targetIdx[i] = newTgt;
            t[i] = 0;
            speed[i] = 0.18 + Math.random() * 0.32;
            curveAmp[i] = 0.15 + Math.random() * 0.45;
            const u = Math.random() * 2 - 1;
            const th = Math.random() * Math.PI * 2;
            const m = Math.sqrt(1 - u * u);
            curveAxis[i * 3]     = m * Math.cos(th);
            curveAxis[i * 3 + 1] = u;
            curveAxis[i * 3 + 2] = m * Math.sin(th);
          }
          const src = nodes[sourceIdx[i]];
          const tgt = nodes[targetIdx[i]];
          if (!src || src.x == null || !tgt || tgt.x == null) continue;
          // Lerp source → target
          const tt = t[i];
          const x = src.x + (tgt.x - src.x) * tt;
          const y = src.y + (tgt.y - src.y) * tt;
          const z = src.z + (tgt.z - src.z) * tt;
          // Add perpendicular curve (sin envelope so 0 at endpoints, max at middle)
          const offset = Math.sin(tt * Math.PI) * curveAmp[i];
          positions[i * 3]     = x + curveAxis[i * 3]     * offset;
          positions[i * 3 + 1] = y + curveAxis[i * 3 + 1] * offset;
          positions[i * 3 + 2] = z + curveAxis[i * 3 + 2] * offset;
        }
        (f.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      }
      // Manual perpetual camera orbit — independent of library render loop
      try {
        const ctrls: any = fg.controls?.();
        const cam = fg.camera?.();
        const target = ctrls?.target;
        const idleMs = performance.now() - lastInteractRef.current;
        if (cam && target && idleMs > 2000 && !hoveringRef.current) {
          const dx = cam.position.x - target.x;
          const dz = cam.position.z - target.z;
          const r = Math.hypot(dx, dz);
          if (r > 0.01) {
            const ang = Math.atan2(dz, dx) + 0.012 * dt;
            cam.position.x = target.x + Math.cos(ang) * r;
            cam.position.z = target.z + Math.sin(ang) * r;
            cam.lookAt(target);
          }
        }
        if (ctrls?.update) ctrls.update();
        // Goal satellites: slow orbital drift around the brain (tilted axis so
        // it doesn't read as a flat ring). Purely aesthetic.
        if (satGroupRef.current) {
          satGroupRef.current.rotation.y += 0.0006 * dt;
          satGroupRef.current.rotation.x = 0.18;
        }
        // LOD swap: far → sparse decimated cloud (few points, soft haze); near
        // → full node spheres. Hard threshold with hysteresis so it doesn't
        // flicker at the boundary. On show, sync cloud positions once (the sim
        // has usually stopped ticking by the time the user zooms out).
        {
          const tgt = ctrls?.target;
          const d = cam && tgt ? cam.position.distanceTo(tgt) : 0;
          const inst = instMeshRef.current;
          const cloud = cloudRef.current;
          const cur = farLodRef.current;
          const wantFar = cur ? d > 1750 : d > 2050; // hysteresis band — cloud only when really far
          if (wantFar !== cur && inst && cloud) {
            farLodRef.current = wantFar;
            inst.visible = !wantFar;
            cloud.visible = wantFar;
            if (linesRef.current) linesRef.current.visible = !wantFar;
            if (wantFar) {
              // one-time position sync from the (now static) nodes
              const cattr = cloud.geometry.getAttribute('position') as THREE.BufferAttribute;
              const carr = cattr.array as Float32Array;
              const idx = cloudIdxRef.current;
              const nodes2 = data.nodes as any[];
              for (let j = 0; j < idx.length; j++) {
                const n = nodes2[idx[j]];
                carr[j * 3] = n.x ?? 0; carr[j * 3 + 1] = n.y ?? 0; carr[j * 3 + 2] = n.z ?? 0;
              }
              cattr.needsUpdate = true;
            }
          }
        }
        // One-at-a-time bounce reveal. Positions are static → just animate each
        // leaf's SCALE 0 → overshoot → 1 as it's born. Only the live window
        // [settled, nextReveal) is touched per frame → cheap, no lag.
        {
          const inst = instMeshRef.current;
          const nodes = data.nodes as any[];
          const total = nodes.length;
          if (inst && revealActiveRef.current && settledRef.current < total) {
            const now = performance.now();
            const RATE = 850; // nodes born per second → visibly sequential
            const DUR = 420;  // ms per-node bounce
            const born = bornAtRef.current;
            let next = nextRevealRef.current;
            const toStart = Math.min(total, next + Math.ceil(RATE * dt));
            for (; next < toStart; next++) born[next] = now;
            nextRevealRef.current = next;
            let advanceTo = settledRef.current;
            let contiguous = true;
            for (let i = settledRef.current; i < next; i++) {
              const n = nodes[i];
              const baseR = n.__isRoot ? 16 : n.__isHub ? 9 : 2.6 + Math.sqrt(n.size ?? 1) * 0.9;
              const t0 = born[i];
              let s: number;
              if (t0 < 0) { s = 0; contiguous = false; }
              else {
                const age = now - t0;
                if (age >= DUR) { s = baseR; if (contiguous && i === advanceTo) advanceTo++; }
                else { s = baseR * easeOutBack(age / DUR); contiguous = false; }
              }
              tmpMat4.makeScale(s, s, s);
              tmpMat4.setPosition(n.x ?? 0, n.y ?? 0, n.z ?? 0);
              inst.setMatrixAt(i, tmpMat4);
            }
            settledRef.current = advanceTo;
            inst.instanceMatrix.needsUpdate = true;
            if (next >= total && advanceTo >= total) revealActiveRef.current = false;
          }
        }
        // ⚡ THUNDER — lightning-in-clouds glow around just-read nodes. Driven by
        // mriRef (filled on brain:access WS). Additive sprites flicker + fade
        // over MRI_DURATION_MS. Layout untouched; pure overlay light.
        {
          const sceneT = fg.scene?.();
          if (sceneT) {
            if (!thunderGroupRef.current) {
              const g = new THREE.Group(); g.name = 'brain-thunder'; g.renderOrder = 999;
              sceneT.add(g); thunderGroupRef.current = g;
            }
            const grp = thunderGroupRef.current!;
            const nowMs = Date.now();
            const sprites = thunderSpritesRef.current;       // keyed by cluster
            const nodes = data.nodes as any[];
            const cg = clusterGeomRef.current;
            // Collapse active read-nodes into their CLUSTERS → a flash lights the
            // whole sector, not one sphere. Latest start wins; count = intensity.
            const activeC = new Map<string, { start: number; end: number; count: number }>();
            for (const [id, v] of mriRef.current) {
              if (v.end <= nowMs) continue;
              const idx = idToIdxRef.current.get(id);
              const n = idx != null ? nodes[idx] : null;
              if (!n) continue;
              const c = n.__cluster ?? '_misc';
              const cur = activeC.get(c);
              if (!cur) activeC.set(c, { start: v.start, end: v.end, count: 1 });
              else { cur.count++; if (v.start > cur.start) { cur.start = v.start; cur.end = v.end; } }
            }
            // Drop sprites for clusters no longer flashing.
            for (const [c, spr] of sprites) {
              if (!activeC.has(c)) { grp.remove(spr); (spr.material as THREE.Material).dispose(); sprites.delete(c); }
            }
            // One big sector glow per active cluster.
            for (const [c, info] of activeC) {
              const geom = cg.get(c);
              if (!geom) continue;
              let spr = sprites.get(c);
              if (!spr) {
                const m = new THREE.SpriteMaterial({ map: cloudSprite, color: 0x39ff7a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
                spr = new THREE.Sprite(m);
                spr.userData.seed = (Math.abs(c.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0)) % 100);
                grp.add(spr); sprites.set(c, spr);
              }
              spr.position.set(geom.x, geom.y, geom.z);
              const t01 = Math.max(0, Math.min(1, (nowMs - info.start) / (info.end - info.start)));
              const env = Math.sin(t01 * Math.PI);                 // rise→fall
              const seed = spr.userData.seed as number;
              // Lightning: irregular sharp flashes riding the fade envelope.
              const flick = 0.3 + 0.7 * Math.pow(Math.abs(Math.sin(nowMs * 0.016 + seed)), 6);
              const intensity = Math.min(1, 0.55 + 0.18 * info.count);
              (spr.material as THREE.SpriteMaterial).opacity = env * flick * intensity * 0.8;
              const sc = geom.r * 2.6;                              // cover the whole sector
              spr.scale.set(sc, sc, 1);
            }
          }
        }
        const renderer = fg.renderer?.();
        const scene = fg.scene?.();
        if (renderer && scene && cam) renderer.render(scene, cam);
      } catch {}
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      if (dom) {
        dom.removeEventListener('pointerdown', onInteract);
        dom.removeEventListener('wheel', onInteract);
        dom.removeEventListener('pointerenter', onEnter);
        dom.removeEventListener('pointerleave', onLeave);
      }
      try {
        const ctrls: any = fg.controls?.();
        if (ctrls) ctrls.autoRotate = false;
      } catch {}
      // Tear down thunder sprites + group.
      try {
        const grp = thunderGroupRef.current;
        if (grp) {
          for (const [, spr] of thunderSpritesRef.current) { (spr.material as THREE.Material).dispose(); }
          thunderSpritesRef.current.clear();
          grp.parent?.remove(grp);
          thunderGroupRef.current = null;
        }
      } catch {}
    };
  }, [data]);

  const labelThreshold = useMemo(() => {
    if (!data.nodes.length) return Infinity;
    const sizes = data.nodes.map((n) => n.size ?? 1).sort((a, b) => b - a);
    const topN = Math.min(10, Math.max(3, Math.ceil(sizes.length * 0.15)));
    return sizes[topN - 1] ?? Infinity;
  }, [data]);

  // Focus set: focused node + 1-hop neighbors
  const focusSet = useMemo(() => {
    // Selection wins over hover — hovering a different node must NOT replace
    // the focused subgraph. Hover-only when nothing is selected.
    const focus = selected ?? hover;
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (s === focus) set.add(t as string);
      else if (t === focus) set.add(s as string);
    }
    return set;
  }, [hover, selected, data]);

  // Highlight focused subgraph in the instanced mesh + lines. Dim everything
  // outside the focus set so the hovered node + its neighbours stand out.
  useEffect(() => {
    const inst = instMeshRef.current;
    const lines = linesRef.current;
    if (!inst || !lines) return;
    const _c = new THREE.Color();
    const DIM = 0.12;
    const LINE_DIM = 0.05;
    const LINE_BRIGHT = 0.6;
    const nodes = data.nodes as any[];
    // Instance colors
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      _c.set(colorFor(n));
      const active = !focusSet || focusSet.has(n.id);
      if (!active) { _c.r *= DIM; _c.g *= DIM; _c.b *= DIM; }
      inst.setColorAt(i, _c);
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // Line per-vertex colors
    const colAttr = lines.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = colAttr.array as Float32Array;
    const idToNode = new Map(nodes.map((n) => [n.id, n]));
    for (let i = 0; i < data.links.length; i++) {
      const l: any = data.links[i];
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const tId = typeof l.target === 'object' ? l.target.id : l.target;
      const sN: any = idToNode.get(sId);
      const tN: any = idToNode.get(tId);
      const focusHit = focusSet && (focusSet.has(sId) && focusSet.has(tId));
      const k = focusSet ? (focusHit ? LINE_BRIGHT : LINE_DIM) : 0.35;
      _c.set(sN ? colorFor(sN) : '#888');
      arr[i * 6]     = _c.r * k; arr[i * 6 + 1] = _c.g * k; arr[i * 6 + 2] = _c.b * k;
      _c.set(tN ? colorFor(tN) : '#888');
      arr[i * 6 + 3] = _c.r * k; arr[i * 6 + 4] = _c.g * k; arr[i * 6 + 5] = _c.b * k;
    }
    colAttr.needsUpdate = true;
  }, [focusSet, data]);

  // Label-only extension; library owns the default sphere so onNodeHover fires reliably
  // =====================================================================
  // Single-draw-call GPU pipeline (Pixi/Obsidian style).
  // Nodes  → InstancedMesh (1 draw call for ALL N nodes)
  // Edges  → BufferGeometry of THREE.LineSegments (1 draw call for ALL links)
  // Per-frame work in onEngineTick = position copy, no allocations.
  // =====================================================================
  const sharedSphereGeom = useMemo(() => new THREE.SphereGeometry(1, 8, 6), []);
  const instMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const linesRef = useRef<THREE.LineSegments | null>(null);
  const tmpMat4 = useRef(new THREE.Matrix4()).current;
  // LOD cloud: from far we DON'T render all 700+ node spheres — we swap to a
  // sparse haze of a few sampled points per cluster. Fewer elements, reads as
  // a soft cloud. The sampled indices are kept in cloudIdxRef so onEngineTick
  // only updates those positions. Hard swap (no crossfade) at FAR distance.
  const cloudRef = useRef<THREE.Points | null>(null);
  const cloudIdxRef = useRef<number[]>([]);
  const farLodRef = useRef<boolean>(false);
  const cloudSprite = useMemo(() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; return tex;
  }, []);

  // ── GOAL SATELLITES: gli obiettivi orbitano lentamente fuori dalla sfera del
  // brain come pianeti. Cliccando un satellite la pagina brain apre il dettaglio
  // goal in un dialog (onGoalClick). Sfere glow nel 3D + pill DOM cliccabili.
  type GoalSat = { id: number; title: string; status: string };
  const [goalSats, setGoalSats] = useState<GoalSat[]>([]);
  const satGroupRef = useRef<THREE.Group | null>(null);
  const satMetaRef = useRef<Map<THREE.Object3D, GoalSat>>(new Map());
  useEffect(() => {
    let alive = true;
    import('../api').then(({ api }) => api.goalsList()).then((r: any) => {
      if (!alive) return;
      setGoalSats((r.rows ?? []).filter((g: any) => g.status !== 'archived').map((g: any) => ({ id: g.id, title: g.title, status: g.status })));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Build the instanced mesh + line geometry when graph data changes. Mounted
  // into force-graph's scene; force-graph still owns layout, we own draw.
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    const scene: THREE.Scene | undefined = fg.scene?.();
    if (!scene) return;
    // Cleanup previous
    if (instMeshRef.current) {
      scene.remove(instMeshRef.current);
      (instMeshRef.current.material as THREE.Material).dispose();
      instMeshRef.current = null;
    }
    if (linesRef.current) {
      scene.remove(linesRef.current);
      linesRef.current.geometry.dispose();
      (linesRef.current.material as THREE.Material).dispose();
      linesRef.current = null;
    }
    if (data.nodes.length === 0) return;
    // Globe wireframe — thin grid sphere wrapping the whole graph, gives the
    // "celestial map" look from the reference screenshots. Pure decoration,
    // 1 draw call, frustum-culled.
    {
      const SPHERE_R = 680;
      const geom = new THREE.SphereGeometry(SPHERE_R, 36, 24);
      const wf = new THREE.WireframeGeometry(geom);
      const mat = new THREE.LineBasicMaterial({ color: 0x4a5573, transparent: true, opacity: 0.13, depthWrite: false });
      const wire = new THREE.LineSegments(wf, mat);
      wire.frustumCulled = false;
      wire.name = 'brain-globe';
      // Remove old globe if any
      const old = scene.getObjectByName('brain-globe');
      if (old) scene.remove(old);
      scene.add(wire);
    }
    // Spine — thick glowing cylinders BRAIN → each hub. Lines can't have
    // width on most GPUs; cylinders can. Hubs are pinned (fx/fy/fz) so the
    // spine is static: build once per data change, no per-tick updates.
    {
      const old = scene.getObjectByName('brain-spine');
      if (old) scene.remove(old);
      const spine = new THREE.Group();
      spine.name = 'brain-spine';
      const yAxis = new THREE.Vector3(0, 1, 0);
      for (const n of data.nodes as any[]) {
        if (!n.__isHub) continue;
        const end = new THREE.Vector3(n.fx ?? n.x ?? 0, n.fy ?? n.y ?? 0, n.fz ?? n.z ?? 0);
        const len = end.length();
        if (len < 1) continue;
        const dir = end.clone().normalize();
        const color = new THREE.Color(clusterColor(n.__cluster));
        // Core beam
        const geom = new THREE.CylinderGeometry(1.4, 1.4, len, 6, 1, true);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false });
        const cyl = new THREE.Mesh(geom, mat);
        // Outer glow (wider, fainter)
        const glowGeom = new THREE.CylinderGeometry(3.2, 3.2, len, 6, 1, true);
        const glowMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false });
        const glow = new THREE.Mesh(glowGeom, glowMat);
        for (const m of [cyl, glow]) {
          m.position.copy(dir.clone().multiplyScalar(len / 2));
          m.quaternion.setFromUnitVectors(yAxis, dir);
        }
        spine.add(cyl, glow);
      }
      scene.add(spine);
    }
    // Instanced node mesh
    const mat = new THREE.MeshBasicMaterial({ vertexColors: false });
    const inst = new THREE.InstancedMesh(sharedSphereGeom, mat, data.nodes.length);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.Color();
    for (let i = 0; i < data.nodes.length; i++) {
      const n: any = data.nodes[i];
      col.set(colorFor(n));
      inst.setColorAt(i, col);
    }
    inst.instanceColor!.needsUpdate = true;
    inst.frustumCulled = false;
    // Reveal init: root + hubs show immediately at full scale; leaves start at
    // scale 0 and bounce in one at a time from the render loop. When no reveal
    // is armed (filter re-render) everything shows full.
    const N = data.nodes.length;
    const fixedCount = (data.nodes as any[]).filter((n) => n.__isHub || n.__isRoot).length;
    const revealOn = revealActiveRef.current;
    if (revealOn) {
      bornAtRef.current = new Float64Array(N).fill(-1);
      nextRevealRef.current = fixedCount;
      settledRef.current = fixedCount;
    }
    const _mat = new THREE.Matrix4();
    for (let i = 0; i < N; i++) {
      const n: any = data.nodes[i];
      const r = n.__isRoot ? 16 : n.__isHub ? 9 : 2.6 + Math.sqrt(n.size ?? 1) * 0.9;
      const s = (revealOn && !(n.__isHub || n.__isRoot)) ? 0 : r; // leaves hidden until born
      _mat.makeScale(s, s, s);
      _mat.setPosition(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      inst.setMatrixAt(i, _mat);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    scene.add(inst);
    instMeshRef.current = inst;
    // Decimated LOD cloud — sample a SUBSET of nodes (~1 in 6 leaves + every
    // hub/root) so from far the brain is a sparse haze, not 700 balls.
    {
      const oldCloud = scene.getObjectByName('brain-cloud');
      if (oldCloud) scene.remove(oldCloud);
      const STRIDE = 6;
      const idx: number[] = [];
      for (let i = 0; i < data.nodes.length; i++) {
        const n: any = data.nodes[i];
        if (n.__isHub || n.__isRoot || i % STRIDE === 0) idx.push(i);
      }
      cloudIdxRef.current = idx;
      const cPos = new Float32Array(idx.length * 3);
      const cCol = new Float32Array(idx.length * 3);
      const _cc = new THREE.Color();
      idx.forEach((ni, j) => {
        const n: any = data.nodes[ni];
        cPos[j * 3] = n.x ?? 0; cPos[j * 3 + 1] = n.y ?? 0; cPos[j * 3 + 2] = n.z ?? 0;
        _cc.set(colorFor(n)); cCol[j * 3] = _cc.r; cCol[j * 3 + 1] = _cc.g; cCol[j * 3 + 2] = _cc.b;
      });
      const cloudGeom = new THREE.BufferGeometry();
      cloudGeom.setAttribute('position', new THREE.BufferAttribute(cPos, 3).setUsage(THREE.DynamicDrawUsage));
      cloudGeom.setAttribute('color', new THREE.BufferAttribute(cCol, 3));
      const cloudMat = new THREE.PointsMaterial({
        size: 26, map: cloudSprite, vertexColors: true, transparent: true, opacity: 0.85,
        depthWrite: false, sizeAttenuation: true,
      });
      const cloud = new THREE.Points(cloudGeom, cloudMat);
      cloud.name = 'brain-cloud';
      cloud.frustumCulled = false;
      cloud.visible = false; // shown only when far (render loop toggles)
      scene.add(cloud);
      cloudRef.current = cloud;
    }
    // Lines geometry — 2 positions per link, all in one buffer.
    // Per-vertex colors → each segment gradients from source-node color to
    // target-node color (matches the connected node visually).
    const linkGeom = new THREE.BufferGeometry();
    const linePos = new Float32Array(data.links.length * 6);
    const lineCol = new Float32Array(data.links.length * 6);
    const idToNode = new Map(data.nodes.map((n: any) => [n.id, n]));
    const _c = new THREE.Color();
    for (let i = 0; i < data.links.length; i++) {
      const l: any = data.links[i];
      const sId = typeof l.source === 'object' ? l.source.id : l.source;
      const tId = typeof l.target === 'object' ? l.target.id : l.target;
      const sNode: any = idToNode.get(sId);
      const tNode: any = idToNode.get(tId);
      const dim = 0.35;
      _c.set(sNode ? colorFor(sNode) : '#888'); lineCol[i * 6]     = _c.r * dim; lineCol[i * 6 + 1] = _c.g * dim; lineCol[i * 6 + 2] = _c.b * dim;
      _c.set(tNode ? colorFor(tNode) : '#888'); lineCol[i * 6 + 3] = _c.r * dim; lineCol[i * 6 + 4] = _c.g * dim; lineCol[i * 6 + 5] = _c.b * dim;
      // Positions are STATIC (no sim) → fill once here so links show even though
      // onEngineTick won't fire.
      const o = i * 6;
      if (sNode) { linePos[o] = sNode.x ?? 0; linePos[o + 1] = sNode.y ?? 0; linePos[o + 2] = sNode.z ?? 0; }
      if (tNode) { linePos[o + 3] = tNode.x ?? 0; linePos[o + 4] = tNode.y ?? 0; linePos[o + 5] = tNode.z ?? 0; }
    }
    linkGeom.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    linkGeom.setAttribute('color', new THREE.BufferAttribute(lineCol, 3));
    const linkMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false });
    const lines = new THREE.LineSegments(linkGeom, linkMat);
    scene.add(lines);
    linesRef.current = lines;
    return () => {
      if (instMeshRef.current) { scene.remove(instMeshRef.current); (instMeshRef.current.material as THREE.Material).dispose(); instMeshRef.current = null; }
      if (linesRef.current) { scene.remove(linesRef.current); linesRef.current.geometry.dispose(); (linesRef.current.material as THREE.Material).dispose(); linesRef.current = null; }
      if (cloudRef.current) { scene.remove(cloudRef.current); cloudRef.current.geometry.dispose(); (cloudRef.current.material as THREE.Material).dispose(); cloudRef.current = null; }
      const sp = scene.getObjectByName('brain-spine');
      if (sp) scene.remove(sp);
    };
  }, [data, sharedSphereGeom]);

  // Build goal satellites on an orbital shell outside the globe. Rebuilt when
  // the goals list changes. Rotated slowly in the main render loop.
  useEffect(() => {
    const fg: any = fgRef.current;
    const scene: THREE.Scene | undefined = fg?.scene?.();
    if (!scene) return;
    const old = scene.getObjectByName('goal-satellites');
    if (old) { scene.remove(old); old.traverse((c: any) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); }
    satMetaRef.current = new Map();
    if (goalSats.length === 0) { satGroupRef.current = null; return; }
    const STATUS_COLOR: Record<string, number> = { active: 0x4fd1ff, draft: 0xb98bff, done: 0x34d399, paused: 0xfbbf24 };
    const ORBIT_R = 980;
    const group = new THREE.Group();
    group.name = 'goal-satellites';
    const N = goalSats.length;
    goalSats.forEach((g, i) => {
      // Fibonacci sphere → spread the satellites over the whole shell, not a ring.
      const phi = Math.acos(1 - 2 * (i + 0.5) / N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const dir = new THREE.Vector3(Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi));
      const pos = dir.clone().multiplyScalar(ORBIT_R);
      const color = STATUS_COLOR[g.status] ?? 0x9aa4c0;
      const colObj = new THREE.Color(color);
      const core = new THREE.Mesh(new THREE.SphereGeometry(11, 16, 12), new THREE.MeshBasicMaterial({ color }));
      core.position.copy(pos);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(22, 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false }));
      glow.position.copy(pos);
      group.add(core, glow);
      satMetaRef.current.set(core, g);

      // Orbit path — the satellite rotates around Y with the group, so its path
      // is a latitude circle at height y, radius = sqrt(x²+z²). Draw it as a
      // dashed ring so the orbit reads visually. computeLineDistances() is
      // required for the dash pattern.
      const y = pos.y;
      const ringR = Math.hypot(pos.x, pos.z);
      if (ringR > 1) {
        const SEG = 128;
        const pts: number[] = [];
        for (let s = 0; s <= SEG; s++) {
          const a = (s / SEG) * Math.PI * 2;
          pts.push(Math.cos(a) * ringR, y, Math.sin(a) * ringR);
        }
        const ringGeom = new THREE.BufferGeometry();
        ringGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const ringMat = new THREE.LineDashedMaterial({ color: colObj, transparent: true, opacity: 0.32, dashSize: 14, gapSize: 12, depthWrite: false });
        const ring = new THREE.Line(ringGeom, ringMat);
        ring.computeLineDistances();
        group.add(ring);
      }
    });
    scene.add(group);
    satGroupRef.current = group;
    return () => {
      const sg = scene.getObjectByName('goal-satellites');
      if (sg) { scene.remove(sg); sg.traverse((c: any) => { c.geometry?.dispose?.(); c.material?.dispose?.(); }); }
      satGroupRef.current = null;
    };
    // `data` in deps: the scene only exists once ForceGraph3D has mounted+built;
    // rebuilding when the graph data lands guarantees the scene is ready.
  }, [goalSats, data]);

  // Click + hover on InstancedMesh — raycast manually. Click (short press)
  // zooms to node and opens the note; pointermove sets hover state used to
  // render the floating label HTML overlay.
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    const renderer = fg.renderer?.();
    const dom: HTMLElement | undefined = renderer?.domElement;
    if (!dom) return;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let downAt = 0; let downX = 0; let downY = 0;
    let lastHoverIdx = -1;

    const mouseFromEvent = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };

    const raycastNode = (e: PointerEvent): number => {
      const inst = instMeshRef.current;
      const cam = fg.camera?.();
      if (!inst || !cam) return -1;
      mouseFromEvent(e);
      raycaster.setFromCamera(mouse, cam);
      const hits = raycaster.intersectObject(inst, false);
      return (hits.length && hits[0].instanceId != null) ? hits[0].instanceId : -1;
    };

    const onDown = (e: PointerEvent) => {
      downAt = performance.now(); downX = e.clientX; downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const dt = performance.now() - downAt;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (dt > 300 || moved > 4) return;
      const idx = raycastNode(e);
      if (idx < 0) {
        setSelected(null);
        setHover(null);
        onDeselect?.();
        // Also reset the camera framing so the focus animation fully unwinds.
        const cam = fg.camera?.();
        if (cam) {
          fg.cameraPosition({ x: cam.position.x, y: cam.position.y, z: cam.position.z }, undefined, 0);
        }
        return;
      }
      const n: any = (data.nodes as any[])[idx];
      if (!n) return;
      // Synthetic hub/root: zoom only, don't open as note.
      if (n.__isRoot || n.__isHub) {
        if (n.x != null) {
          const dist = n.__isRoot ? 600 : 280;
          const len = Math.hypot(n.x, n.y, n.z) || 1;
          const ratio = 1 + dist / len;
          fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n.__isRoot ? { x: 0, y: 0, z: 0 } : n, 900);
        }
        return;
      }
      setSelected(n.id);
      onSelect(n.id);
      if (n.x != null) {
        const dist = 130;
        const len = Math.hypot(n.x, n.y, n.z) || 1;
        const ratio = 1 + dist / len;
        fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n, 1000);
      }
    };
    // Pointermove throttled to ~25fps — enough for snappy hover, cheap on CPU.
    let lastMove = 0;
    const onMove = (e: PointerEvent) => {
      const t = performance.now();
      if (t - lastMove < 40) return;
      lastMove = t;
      const idx = raycastNode(e);
      if (idx !== lastHoverIdx) {
        lastHoverIdx = idx;
        const n: any = idx >= 0 ? (data.nodes as any[])[idx] : null;
        // Synthetic nodes hover separately (visualized via always-on chip).
        setHover(n && !n.__isRoot && !n.__isHub ? n.id : null);
      }
    };
    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointermove', onMove);
    return () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointermove', onMove);
    };
  }, [data, onSelect, onDeselect]);

  // Label overlay state — list of {id, title, x, y} computed by projecting
  // node world position to screen each animation frame. Rendered as absolute
  // HTML divs over the canvas.
  type LabelHit = { id: string; title: string; x: number; y: number; mode: 'hover' | 'zoom' | 'hub' | 'root' | 'goal'; color?: string; goalId?: number; status?: string; depth?: number };
  const [labels, setLabels] = useState<LabelHit[]>([]);
  useEffect(() => {
    let raf = 0;
    const tmpV = new THREE.Vector3();
    const tmpW = new THREE.Vector3();
    const ZOOM_THRESHOLD = 900;          // camera distance below which all labels appear
    const MAX_AUTO_LABELS = 120;         // cap so DOM stays light
    const loop = () => {
      const fg: any = fgRef.current;
      const cam = fg?.camera?.();
      const renderer = fg?.renderer?.();
      const dom: HTMLElement | undefined = renderer?.domElement;
      if (!cam || !dom) { raf = requestAnimationFrame(loop); return; }
      const rect = dom.getBoundingClientRect();
      const target = (fg.controls?.()?.target as THREE.Vector3) ?? new THREE.Vector3();
      const camDist = cam.position.distanceTo(target);
      const showAll = camDist < ZOOM_THRESHOLD;
      const out: LabelHit[] = [];
      // Project + return depth (smaller = closer to camera). Also reject if
      // the projected point falls outside the visible viewport.
      const project = (n: any): { x: number; y: number; depth: number } | null => {
        tmpV.set(n.x ?? 0, n.y ?? 0, n.z ?? 0).project(cam);
        if (tmpV.z > 1 || tmpV.z < -1) return null;
        const x = (tmpV.x * 0.5 + 0.5) * rect.width;
        const y = (-tmpV.y * 0.5 + 0.5) * rect.height;
        const PAD = 80;
        if (x < -PAD || x > rect.width + PAD || y < -PAD || y > rect.height + PAD) return null;
        return { x, y, depth: tmpV.z };
      };
      // Always-on hub + root pills — these visually mark each cluster center.
      for (const n of (data.nodes as any[])) {
        if (!n.__isHub && !n.__isRoot) continue;
        const p = project(n);
        if (!p) continue;
        out.push({
          id: n.id,
          title: n.title || n.id,
          x: p.x,
          y: p.y,
          mode: n.__isRoot ? 'root' : 'hub',
          color: n.__isRoot ? '#ff6680' : clusterColor(n.__cluster),
        });
      }
      // Goal satellites — always-on clickable pills projected from their LIVE
      // world position (the group rotates each frame). Color by status.
      if (satMetaRef.current.size > 0) {
        const STATUS_HEX: Record<string, string> = { active: '#4fd1ff', draft: '#b98bff', done: '#34d399', paused: '#fbbf24' };
        for (const [obj, g] of satMetaRef.current) {
          obj.getWorldPosition(tmpW);
          tmpV.copy(tmpW).project(cam);
          if (tmpV.z > 1 || tmpV.z < -1) continue;
          const x = (tmpV.x * 0.5 + 0.5) * rect.width;
          const y = (-tmpV.y * 0.5 + 0.5) * rect.height;
          // Clamp into viewport (with margin) instead of culling — a goal pill
          // near the edge should still be reachable, not vanish.
          const cx = Math.max(60, Math.min(rect.width - 60, x));
          const cy = Math.max(60, Math.min(rect.height - 60, y));
          out.push({ id: `goal-${g.id}`, title: g.title, x: cx, y: cy, mode: 'goal', goalId: g.id, status: g.status, color: STATUS_HEX[g.status] ?? '#9aa4c0', depth: tmpV.z });
        }
      }
      // Selected label — sticks until user clicks empty space.
      if (selected) {
        const n: any = (data.nodes as any[]).find((x: any) => x.id === selected);
        if (n) {
          const p = project(n);
          if (p) out.push({ id: n.id, title: n.title || n.id, x: p.x, y: p.y, mode: 'hover' });
        }
      }
      // Hover label (only if not the same as selected)
      if (hover && hover !== selected) {
        const n: any = (data.nodes as any[]).find((x: any) => x.id === hover);
        if (n) {
          const p = project(n);
          if (p) out.push({ id: n.id, title: n.title || n.id, x: p.x, y: p.y, mode: 'hover' });
        }
      }
      // Zoom labels — depth-sort closest first, viewport-clip, anti-overlap.
      if (showAll) {
        const projected: { n: any; p: { x: number; y: number; depth: number } }[] = [];
        for (const n of (data.nodes as any[])) {
          if (n.id === hover) continue;
          if (n.__isHub || n.__isRoot) continue; // already rendered as pills
          const p = project(n);
          if (!p) continue;
          projected.push({ n, p });
        }
        projected.sort((a, b) => a.p.depth - b.p.depth); // closer first
        const placed: { x: number; y: number }[] = [];
        const MIN_DIST = 36;                    // pixel spacing between labels
        let added = 0;
        for (const { n, p } of projected) {
          if (added >= MAX_AUTO_LABELS) break;
          let collide = false;
          for (const q of placed) {
            if (Math.hypot(p.x - q.x, p.y - q.y) < MIN_DIST) { collide = true; break; }
          }
          if (collide) continue;
          placed.push({ x: p.x, y: p.y });
          out.push({ id: n.id, title: n.title || n.id, x: p.x, y: p.y, mode: 'zoom' });
          added++;
        }
      }
      setLabels(out);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hover, selected, data]);

  // No-op: no simulation (cooldownTicks=0, nodes pinned). Positions are final +
  // static, so node matrices, links and the LOD cloud are all filled ONCE in the
  // build effect; the reveal animation owns the instance matrices from the
  // render loop. A stray tick must NOT rewrite them to full scale (it would skip
  // the bounce), so this stays empty.
  const onEngineTick = useCallback(() => {}, []);

  // Force-graph default per-node Mesh: suppress with an empty object. We're
  // drawing them ourselves via the InstancedMesh above.
  const nodeLabelExt = useMemo(() => {
    return (_node: any): THREE.Object3D => new THREE.Object3D();
  }, []);

  const nodeColorCb = useCallback((n: any) => {
    const v = mriRef.current.get(n.id);
    if (v && v.end > Date.now()) return MRI_GREEN;
    const base = colorFor(n);
    if (!focusSet) return base;
    return focusSet.has(n.id) ? base : '#181a24';
    // mriTick keeps this callback identity refreshing while MRI active
  }, [focusSet, mriTick]);

  // Force library re-application of nodeColor on focus or MRI change
  useEffect(() => {
    const fg: any = fgRef.current;
    // Only refresh when focus changes — mriTick handled by anim loop directly
    try { fg?.refresh?.(); } catch {}
  }, [hover, selected]);

  function mriEnvForLink(l: any): number {
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    const now = Date.now();
    function env(id: string): number {
      const v = mriRef.current.get(id);
      if (!v || v.end <= now) return 0;
      const t01 = (now - v.start) / (v.end - v.start);
      return Math.sin(Math.max(0, Math.min(1, t01)) * Math.PI);
    }
    return Math.max(env(sId), env(tId));
  }
  const linkColor = useCallback((l: any) => {
    const focus = hover ?? selected;
    const resolveNode = (ref: any): any => {
      if (ref && typeof ref === 'object') return ref;
      const i = idToIdxRef.current.get(ref);
      return i != null ? (data.nodes as any[])[i] : null;
    };
    const sNode0: any = resolveNode(l.source);
    const tNode0: any = resolveNode(l.target);
    // MRI pulse on edges disabled — was causing visible flicker along links.
    if (!focus) {
      const ref = sNode0 ?? tNode0;
      if (!ref) return 'rgba(192,132,252,0.4)';
      const c = new THREE.Color(colorFor(ref));
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.55)`;
    }
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s !== focus && t !== focus) {
      const ref = sNode0 ?? tNode0;
      if (!ref) return 'rgba(120,130,160,0.22)';
      const c = new THREE.Color(colorFor(ref));
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.28)`;
    }
    // hot link tinted by the other endpoint (neighbor) — vivid, not grey
    const sNode: any = typeof l.source === 'object' ? l.source : null;
    const tNode: any = typeof l.target === 'object' ? l.target : null;
    const other = sNode && sNode.id === focus ? tNode : sNode;
    const base = other ? colorFor(other) : '#7dd3fc';
    // convert hex → rgba w/ moderate alpha so particles overlay reads as glow
    const c = new THREE.Color(base);
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.55)`;
  }, [hover, selected, showParticles, data]);
  const linkWidthCb = useCallback((l: any) => {
    const focus = hover ?? selected;
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    const baseW = !focus ? (showParticles ? 0 : 0.25)
      : (sId === focus || tId === focus) ? 0.6
      : (showParticles ? 0 : 0.18);
    return baseW;
  }, [hover, selected, showParticles]);

  function zoom(factor: number) {
    const fg: any = fgRef.current;
    if (!fg) return;
    try {
      const cam = fg.camera();
      const cur = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      fg.cameraPosition({ x: cur.x * factor, y: cur.y * factor, z: cur.z * factor }, undefined, 280);
    } catch {}
  }

  return (
    <div ref={wrapRef} className="brain-graph-wrap absolute inset-0 overflow-hidden" style={{ background: '#02030a', borderRadius: 'inherit' }}>
      <style>{`
        .scene-container { overflow: hidden !important; border-radius: inherit !important; }
      `}</style>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center z-10"><BrainLoading size={140} label="Caricamento cervello…" /></div>
      )}
      {loaded && data.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm z-10">empty vault</div>
      )}
      <div className="absolute bottom-3 left-3 z-20 flex flex-col gap-1">
        <button
          onClick={() => zoom(0.78)}
          className="w-10 h-10 rounded-xl bg-surface2/70 border border-border text-text text-lg hover:border-accent/50 hover:bg-surface2 backdrop-blur transition flex items-center justify-center"
          title="Zoom in"
        >+</button>
        <button
          onClick={() => zoom(1.28)}
          className="w-10 h-10 rounded-xl bg-surface2/70 border border-border text-text text-lg hover:border-accent/50 hover:bg-surface2 backdrop-blur transition flex items-center justify-center"
          title="Zoom out"
        >−</button>
        <button
          onClick={() => setShowLabels((v) => !v)}
          className={`w-10 h-10 rounded-xl border backdrop-blur transition flex items-center justify-center text-xs font-semibold ${
            showLabels
              ? 'bg-accent/20 border-accent/60 text-accent'
              : 'bg-surface2/70 border-border text-muted-foreground hover:border-accent/50'
          }`}
          title={showLabels ? 'Nascondi nomi' : 'Mostra nomi'}
        >Aa</button>
        {onToggleExplorer && (
          <button
            onClick={onToggleExplorer}
            className={`w-10 h-10 rounded-xl border backdrop-blur transition flex items-center justify-center ${
              explorerOpen
                ? 'bg-accent/20 border-accent/60 text-accent'
                : 'bg-surface2/70 border-border text-muted-foreground hover:border-accent/50'
            }`}
            title={explorerOpen ? 'Nascondi file explorer' : 'Mostra file explorer'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h6l2 2h10v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"/><path d="M3 11h18"/></svg>
          </button>
        )}
      </div>
      {size && (
        <ForceGraph3D
          ref={fgRef as any}
          graphData={data as any}
          width={size.w}
          height={size.h}
          backgroundColor="#02030a"
          showNavInfo={false}
          nodeRelSize={2.6}
          nodeVal={(n: any) => (n.size ?? 1)}
          nodeColor={nodeColorCb}
          nodeOpacity={0.95}
          // Lower sphere LOD to cut triangle count ~4× — visually identical at
          // this zoom level, large win at high node counts.
          nodeThreeObject={nodeLabelExt}
          nodeThreeObjectExtend={false}
          nodeLabel={(n: any) => `<div style="font:500 11px Inter,system-ui; padding:6px 10px; background:rgba(8,16,28,0.92); border:1px solid #1f4a55; border-radius:8px; color:#e8e8f0;">${n.title}<div style="font-size:9px;color:#7a7a8c;margin-top:2px;">${n.id}</div></div>`}
          onEngineTick={onEngineTick}
          // Hide force-graph's own lines — we draw them ourselves via the
          // single LineSegments above (1 draw call instead of N).
          linkVisibility={false}
          linkColor={linkColor}
          linkOpacity={0}
          linkWidth={0}
          linkDirectionalParticles={0}
          // NOTE: force-graph's onBackgroundClick fires for every click that
          // doesn't hit a per-node Object3D. Our nodes live in an InstancedMesh
          // so force-graph sees zero hits → EVERY click triggers background,
          // including clicks ON nodes, immediately clearing selection. The
          // custom raycast in the pointer effect above is the canonical
          // handler; don't wire force-graph's events here.
          enableNodeDrag={false}
          enablePointerInteraction={false}
          // No simulation: positions are precomputed + pinned (static neuron
          // shells). Running d3 reshaped them into teardrop "imbuti" and added
          // the load lag. Final layout on frame 0.
          cooldownTicks={0}
          warmupTicks={0}
        />
      )}
      {/* Label overlay — absolute-positioned DOM, super cheap vs Three sprites. */}
      <div className="absolute inset-0 pointer-events-none select-none" style={{ overflow: 'hidden' }}>
        {labels.map((lab) => {
          // Goal satellite pill — clickable, opens the goal dialog in the brain
          // page. pointer-events-auto so the DOM click works (more reliable than
          // raycasting a tiny orbiting sphere).
          if (lab.mode === 'goal') {
            return (
              <button
                key={`goal-${lab.goalId}`}
                onClick={(e) => { e.stopPropagation(); onGoalClick?.(lab.goalId!); }}
                className="pointer-events-auto"
                style={{
                  position: 'absolute', left: lab.x, top: lab.y, transform: 'translate(-50%, -50%)',
                  fontFamily: 'Inter, system-ui, sans-serif', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.03em', padding: '4px 10px 4px 8px', borderRadius: 999,
                  background: `linear-gradient(135deg, ${lab.color}33, rgba(6,10,18,0.92))`,
                  border: `1.5px solid ${lab.color}`, color: '#fff',
                  boxShadow: `0 0 14px ${lab.color}88`, whiteSpace: 'nowrap', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  zIndex: 16, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis',
                }}
                title={lab.title}
              >
                <span style={{ width: 7, height: 7, borderRadius: 999, background: lab.color, boxShadow: `0 0 6px ${lab.color}`, flexShrink: 0 }} />
                🎯 {lab.title.length > 26 ? lab.title.slice(0, 25) + '…' : lab.title}
              </button>
            );
          }
          // Cluster-hub pill — always-on, vivid chip with cluster color border.
          if (lab.mode === 'hub') {
            return (
              <div
                key={`${lab.mode}-${lab.id}`}
                style={{
                  position: 'absolute',
                  left: lab.x,
                  top: lab.y,
                  transform: 'translate(-50%, -50%)',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  padding: '5px 11px',
                  borderRadius: 999,
                  background: `linear-gradient(135deg, ${lab.color}33, rgba(8,16,28,0.92))`,
                  border: `1.5px solid ${lab.color}`,
                  color: '#fff',
                  boxShadow: `0 0 12px ${lab.color}77, inset 0 0 4px ${lab.color}55`,
                  whiteSpace: 'nowrap',
                  zIndex: 15,
                }}
              >
                <span style={{ opacity: 0.7, marginRight: 6, fontSize: 9 }}>MOC</span>
                {lab.title}
              </div>
            );
          }
          // Root pill — fat central anchor label.
          if (lab.mode === 'root') {
            return (
              <div
                key={`${lab.mode}-${lab.id}`}
                style={{
                  position: 'absolute',
                  left: lab.x,
                  top: lab.y,
                  transform: 'translate(-50%, -50%)',
                  fontFamily: 'Inter, system-ui, sans-serif',
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: '0.08em',
                  padding: '7px 14px',
                  borderRadius: 8,
                  background: 'linear-gradient(135deg, rgba(255,102,128,0.35), rgba(8,16,28,0.92))',
                  border: '2px solid #ff6680',
                  color: '#fff',
                  boxShadow: '0 0 24px rgba(255,102,128,0.6)',
                  whiteSpace: 'nowrap',
                  zIndex: 18,
                }}
              >
                {lab.title}
              </div>
            );
          }
          return (
            <div
              key={`${lab.mode}-${lab.id}`}
              style={{
                position: 'absolute',
                left: lab.x,
                top: lab.y,
                transform: 'translate(-50%, calc(-100% - 12px))',
                fontFamily: 'Inter, system-ui, sans-serif',
                fontSize: lab.mode === 'hover' ? 12 : 10,
                fontWeight: lab.mode === 'hover' ? 600 : 500,
                lineHeight: 1,
                padding: lab.mode === 'hover' ? '5px 9px' : '3px 6px',
                borderRadius: 6,
                background: lab.mode === 'hover' ? 'rgba(8,16,28,0.95)' : 'rgba(8,16,28,0.65)',
                border: lab.mode === 'hover' ? '1px solid #4b6bff' : '1px solid rgba(120,140,180,0.25)',
                color: lab.mode === 'hover' ? '#e8e8f0' : 'rgba(220,225,240,0.85)',
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                boxShadow: lab.mode === 'hover' ? '0 4px 14px rgba(0,0,0,0.6)' : 'none',
                maxWidth: 260,
                zIndex: lab.mode === 'hover' ? 20 : 10,
              }}
            >
              {lab.title}
            </div>
          );
        })}
      </div>
    </div>
  );
}
