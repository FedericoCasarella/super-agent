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

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}
function originColor(email: string): string {
  return `hsl(${hashHue(email)}, 70%, 65%)`;
}
import { colorForNode as paletteColor } from '../brainColors';
function colorFor(node: any): string {
  if (node.origin_email) return originColor(node.origin_email);
  return paletteColor(node);
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
}: {
  onSelect: (id: string) => void;
  onDeselect?: () => void;
  visibilityFilter?: 'all' | 'public' | 'protected';
  originFilter?: string;
  vaultFilter?: string;
  onOriginsChange?: (origins: string[]) => void;
  onVaultsChange?: (vaults: string[]) => void;
}) {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] }>({ nodes: [], links: [] });
  // degree map kept in a ref so nodeVisibility callback doesn't allocate.
  const degreeRef = useRef<Map<string, number>>(new Map());
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
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
  const [mriTick, setMriTick] = useState(0);
  useWS((msg) => {
    if (msg?.type !== 'brain:access') return;
    const p = msg.payload ?? {};
    if (!p.rel) return;
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
      setData(g);
      if (onOriginsChange) onOriginsChange(g.origins ?? []);
      if (onVaultsChange) onVaultsChange(g.vaults ?? []);
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

  // Spread nodes via forces
  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg) return;
    try {
      const charge = fg.d3Force?.('charge');
      if (charge?.strength) charge.strength(-260).distanceMax(800);
      const link = fg.d3Force?.('link');
      if (link?.distance) link.distance(110);
      fg.d3ReheatSimulation?.();
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
    const focus = hover ?? selected;
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
    scene.add(inst);
    instMeshRef.current = inst;
    // Lines geometry — 2 positions per link, all in one buffer.
    const linkGeom = new THREE.BufferGeometry();
    const linePos = new Float32Array(data.links.length * 6);
    linkGeom.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    const linkMat = new THREE.LineBasicMaterial({ color: 0x778899, transparent: true, opacity: 0.35 });
    const lines = new THREE.LineSegments(linkGeom, linkMat);
    scene.add(lines);
    linesRef.current = lines;
    return () => {
      if (instMeshRef.current) { scene.remove(instMeshRef.current); (instMeshRef.current.material as THREE.Material).dispose(); instMeshRef.current = null; }
      if (linesRef.current) { scene.remove(linesRef.current); linesRef.current.geometry.dispose(); (linesRef.current.material as THREE.Material).dispose(); linesRef.current = null; }
    };
  }, [data, sharedSphereGeom]);

  // Per-frame position copy. Force-graph fires onEngineTick during simulation;
  // we read each node's x/y/z and write directly to the InstancedMesh matrix.
  // O(N) work, no allocations.
  const onEngineTick = useCallback(() => {
    const inst = instMeshRef.current;
    if (!inst) return;
    const nodes = data.nodes as any[];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const r = 1.5 + Math.sqrt(n.size ?? 1) * 0.5;
      tmpMat4.makeScale(r, r, r);
      tmpMat4.setPosition(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      inst.setMatrixAt(i, tmpMat4);
    }
    inst.instanceMatrix.needsUpdate = true;
    // Update line positions from links.
    const lines = linesRef.current;
    if (lines) {
      const attr = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const links = data.links as any[];
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        const s: any = typeof l.source === 'object' ? l.source : nodes.find((nn) => nn.id === l.source);
        const t: any = typeof l.target === 'object' ? l.target : nodes.find((nn) => nn.id === l.target);
        if (!s || !t) continue;
        const o = i * 6;
        arr[o] = s.x ?? 0; arr[o + 1] = s.y ?? 0; arr[o + 2] = s.z ?? 0;
        arr[o + 3] = t.x ?? 0; arr[o + 4] = t.y ?? 0; arr[o + 5] = t.z ?? 0;
      }
      attr.needsUpdate = true;
    }
  }, [data, tmpMat4]);

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

  function triggerMriDemo() {
    if (data.nodes.length === 0) return;
    // Simulate agent traversing brain: random walk along edges, MRI hops node→node
    let cur = 0, bestDeg = -1;
    for (let i = 0; i < data.nodes.length; i++) {
      const deg = (neighborsRef.current.get(i) ?? []).length;
      if (deg > bestDeg) { bestDeg = deg; cur = i; }
    }
    const walkLen = 8;
    const stepMs = 900; // gap between successive node activations
    const now = Date.now();
    const visited = new Set<number>();
    visited.add(cur);
    let prev = -1;
    for (let s = 0; s < walkLen; s++) {
      const node = data.nodes[cur];
      const off = s * stepMs;
      mriRef.current.set(node.id, { start: now + off, end: now + off + MRI_DURATION_MS });
      // Pick next: prefer unvisited neighbor, fallback random neighbor
      const nbrs = neighborsRef.current.get(cur) ?? [];
      if (nbrs.length === 0) break;
      const fresh = nbrs.filter((i) => !visited.has(i) && i !== prev);
      const pool = fresh.length ? fresh : nbrs;
      prev = cur;
      cur = pool[Math.floor(Math.random() * pool.length)];
      visited.add(cur);
    }
    focusDirtyRef.current = true;
    setMriTick((t) => t + 1);
  }

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
    <div ref={wrapRef} className="w-full h-full relative" style={{ background: '#02030a' }}>
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center z-10"><BrainLoading size={140} label="Caricamento cervello…" /></div>
      )}
      {loaded && data.nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm z-10">empty vault</div>
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
              : 'bg-surface2/70 border-border text-muted hover:border-accent/50'
          }`}
          title={showLabels ? 'Nascondi nomi' : 'Mostra nomi'}
        >Aa</button>
        <button
          onClick={triggerMriDemo}
          className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-400/60 text-emerald-300 hover:bg-emerald-500/30 backdrop-blur transition flex items-center justify-center text-xs font-semibold"
          title="Demo MRI animation"
        >MRI</button>
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
          onNodeHover={(n: any) => setHover(n?.id ?? null)}
          onNodeClick={(n: any) => {
            setSelected(n.id);
            onSelect(n.id);
            const fg: any = fgRef.current;
            if (fg && n.x != null) {
              const dist = 130;
              const len = Math.hypot(n.x, n.y, n.z) || 1;
              const ratio = 1 + dist / len;
              fg.cameraPosition({ x: n.x * ratio, y: n.y * ratio, z: n.z * ratio }, n, 1000);
            }
          }}
          onBackgroundClick={() => { setSelected(null); onDeselect?.(); }}
          enableNodeDrag
          cooldownTicks={Infinity}
          cooldownTime={Infinity}
          warmupTicks={80}
          d3AlphaDecay={0.04}
          d3VelocityDecay={0.5}
        />
      )}
    </div>
  );
}
