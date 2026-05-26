import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph3D, { ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';
import { api } from '../api';
import { useWS } from '../ws';

const MRI_GREEN = '#39ff7a';
const MRI_DURATION_MS = 4000;

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
function colorFor(node: any): string {
  if (node.origin_email)              return originColor(node.origin_email);
  if (node.visibility === 'protected') return VIS_PROTECTED;
  if (node.visibility === 'public')    return VIS_PUBLIC;
  return KIND_COLOR[node.kind] ?? DEFAULT_COLOR;
}

// Particles per node emitter (firing axons)
const PER_NODE = 400;

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
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [showLabels, setShowLabels] = useState<boolean>(() => typeof localStorage !== 'undefined' ? localStorage.getItem('brain_3d_labels') !== '0' : true);
  useEffect(() => { try { localStorage.setItem('brain_3d_labels', showLabels ? '1' : '0'); } catch {} }, [showLabels]);
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
  // MRI active set: nodeId → expiry ms timestamp
  const mriRef = useRef<Map<string, number>>(new Map());
  const [, setMriTick] = useState(0);
  useWS((msg) => {
    if (msg?.type !== 'brain:access') return;
    const p = msg.payload ?? {};
    if (!p.vaultName || !p.rel) return;
    const id = `${p.vaultName}::${p.rel}`;
    mriRef.current.set(id, Date.now() + MRI_DURATION_MS);
    focusDirtyRef.current = true;
    setMriTick((t) => t + 1);
  });
  // Tick while MRI active so nodeColor callback re-runs + auto-clear
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      let any = false;
      for (const [k, exp] of mriRef.current) {
        if (exp <= now) mriRef.current.delete(k);
        else any = true;
      }
      setMriTick((t) => t + 1);
      if (!any) return;
    }, 400);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    api.brainGraphFiltered(visibilityFilter, originFilter, vaultFilter).then((g: any) => {
      setData(g);
      if (onOriginsChange) onOriginsChange(g.origins ?? []);
      if (onVaultsChange) onVaultsChange(g.vaults ?? []);
    }).catch(() => {});
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

  // Build / rebuild particle field whenever data changes — particles flow node→node
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
    const N = data.nodes.length;
    if (N === 0) return;

    // Build neighbor map from links (index-based)
    const idToIdx = new Map<string, number>();
    data.nodes.forEach((n, i) => idToIdx.set(n.id, i));
    const neighbors = new Map<number, number[]>();
    for (let i = 0; i < N; i++) neighbors.set(i, []);
    for (const l of data.links) {
      const s = typeof l.source === 'object' ? (l.source as Node).id : l.source;
      const t = typeof l.target === 'object' ? (l.target as Node).id : l.target;
      const si = idToIdx.get(s); const ti = idToIdx.get(t);
      if (si == null || ti == null) continue;
      neighbors.get(si)!.push(ti);
      neighbors.get(ti)!.push(si);
    }
    neighborsRef.current = neighbors;

    const total = N * PER_NODE;
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const sourceIdx = new Int32Array(total);
    const targetIdx = new Int32Array(total);
    const t = new Float32Array(total);
    const speed = new Float32Array(total);
    const curveAmp = new Float32Array(total);
    const curveAxis = new Float32Array(total * 3);
    const tmp = new THREE.Color();

    for (let i = 0; i < N; i++) {
      const node = data.nodes[i] as any;
      tmp.set(colorFor(node));
      const nbrs = neighbors.get(i)!;
      for (let j = 0; j < PER_NODE; j++) {
        const idx = i * PER_NODE + j;
        sourceIdx[idx] = i;
        // Pick a target neighbor — fallback to self for isolated nodes
        targetIdx[idx] = nbrs.length ? nbrs[Math.floor(Math.random() * nbrs.length)] : i;
        t[idx] = Math.random();
        speed[idx] = 0.18 + Math.random() * 0.32; // seconds⁻¹
        curveAmp[idx] = 1.5 + Math.random() * 4;
        // random unit perpendicular axis
        const u = Math.random() * 2 - 1;
        const theta = Math.random() * Math.PI * 2;
        const m = Math.sqrt(1 - u * u);
        curveAxis[idx * 3]     = m * Math.cos(theta);
        curveAxis[idx * 3 + 1] = u;
        curveAxis[idx * 3 + 2] = m * Math.sin(theta);
        // initial position will be set by anim loop on first frame
        positions[idx * 3]     = 0;
        positions[idx * 3 + 1] = 0;
        positions[idx * 3 + 2] = 0;
        // color = source node tint
        colors[idx * 3]     = tmp.r;
        colors[idx * 3 + 1] = tmp.g;
        colors[idx * 3 + 2] = tmp.b;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 1.4,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    (points as any).raycast = () => {};
    scene.add(points);
    const baseColors = new Float32Array(colors); // copy for re-modulation on focus
    idToIdxRef.current = idToIdx;
    fieldRef.current = { points, positions, colors, baseColors, sourceIdx, targetIdx, t, speed, curveAmp, curveAxis };
    focusDirtyRef.current = true;
  }, [data]);

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
    // OrbitControls autoRotate as fallback (library may pause after cooldown)
    const ctrls0: any = fg.controls?.();
    if (ctrls0) { ctrls0.autoRotate = true; ctrls0.autoRotateSpeed = 0.4; }

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
    const loop = () => {
      if (stopped) return;
      const now = performance.now();
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      const f = fieldRef.current;
      const nbrs = neighborsRef.current;
      if (f && data.nodes.length > 0) {
        const { positions, colors, baseColors, sourceIdx, targetIdx, t, speed, curveAmp, curveAxis } = f;
        const nodes = data.nodes as any[];
        const totalP = sourceIdx.length;
        // MRI: sweep expired entries; if any active, mark dirty each frame
        const nowMs = Date.now();
        let mriActive = false;
        if (mriRef.current.size > 0) {
          for (const [k, exp] of mriRef.current) {
            if (exp <= nowMs) mriRef.current.delete(k);
            else mriActive = true;
          }
          if (mriActive) focusDirtyRef.current = true;
          else focusDirtyRef.current = true; // one extra pass after clear
        }
        if (focusDirtyRef.current) {
          const fset = focusIdxSetRef.current;
          const mriIdx = new Set<number>();
          if (mriRef.current.size) {
            for (const id of mriRef.current.keys()) {
              const idx = idToIdxRef.current.get(id);
              if (idx != null) mriIdx.add(idx);
            }
          }
          const G = new THREE.Color(MRI_GREEN);
          for (let i = 0; i < totalP; i++) {
            const src = sourceIdx[i];
            const tgt = targetIdx[i];
            if (mriIdx.has(src) || mriIdx.has(tgt)) {
              colors[i * 3]     = G.r;
              colors[i * 3 + 1] = G.g;
              colors[i * 3 + 2] = G.b;
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
            curveAmp[i] = 1.5 + Math.random() * 4;
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
      // Manual perpetual camera orbit around origin — pauses 2s after user interaction
      try {
        const ctrls: any = fg.controls?.();
        const cam = fg.camera?.();
        const target = ctrls?.target;
        const idleMs = performance.now() - lastInteractRef.current;
        if (ctrls) ctrls.autoRotate = !hoveringRef.current;
        if (cam && target && idleMs > 2000 && !hoveringRef.current) {
          // Rotate camera around target on Y axis at ~0.12 rad/sec
          const dx = cam.position.x - target.x;
          const dz = cam.position.z - target.z;
          const r = Math.hypot(dx, dz);
          if (r > 0.01) {
            const ang = Math.atan2(dz, dx) + 0.12 * dt;
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
  const nodeLabelExt = useMemo(() => {
    return (node: any): THREE.Object3D => {
      if (!(showLabels && (node.size ?? 1) >= labelThreshold)) return new THREE.Object3D();
      const color = colorFor(node);
      const r = 1.5 + Math.sqrt(node.size ?? 1) * 0.5;
      const sprite = makeLabelSprite(node.title || node.id, color);
      sprite.position.set(0, r + 3, 0);
      return sprite;
    };
  }, [labelThreshold, showLabels]);

  const nodeColorCb = useCallback((n: any) => {
    const exp = mriRef.current.get(n.id);
    if (exp && exp > Date.now()) return MRI_GREEN;
    const base = colorFor(n);
    if (!focusSet) return base;
    return focusSet.has(n.id) ? base : '#181a24';
  }, [focusSet]);

  const linkColor = useCallback((l: any) => {
    const focus = hover ?? selected;
    if (!focus) return 'rgba(0,0,0,0)';
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s !== focus && t !== focus) return 'rgba(0,0,0,0)';
    // hot link tinted by the other endpoint (neighbor) — vivid, not grey
    const sNode: any = typeof l.source === 'object' ? l.source : null;
    const tNode: any = typeof l.target === 'object' ? l.target : null;
    const other = sNode && sNode.id === focus ? tNode : sNode;
    const base = other ? colorFor(other) : '#7dd3fc';
    // convert hex → rgba w/ moderate alpha so particles overlay reads as glow
    const c = new THREE.Color(base);
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.55)`;
  }, [hover, selected]);
  const linkWidthCb = useCallback((l: any) => {
    const focus = hover ?? selected;
    if (!focus) return 0;
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return (s === focus || t === focus) ? 0.6 : 0;
  }, [hover, selected]);

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
      {data.nodes.length === 0 && (
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
          nodeResolution={16}
          nodeThreeObject={nodeLabelExt}
          nodeThreeObjectExtend={true}
          nodeLabel={(n: any) => `<div style="font:500 11px Inter,system-ui; padding:6px 10px; background:rgba(8,16,28,0.92); border:1px solid #1f4a55; border-radius:8px; color:#e8e8f0;">${n.title}<div style="font-size:9px;color:#7a7a8c;margin-top:2px;">${n.id}</div></div>`}
          linkColor={linkColor}
          linkOpacity={1}
          linkWidth={linkWidthCb}
          linkDirectionalParticles={(l: any) => {
            const focus = hover ?? selected;
            if (!focus) return 0;
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === focus || t === focus) ? 10 : 0;
          }}
          linkDirectionalParticleSpeed={(l: any) => {
            const focus = hover ?? selected;
            if (!focus) return 0;
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === focus || t === focus) ? 0.011 : 0;
          }}
          linkDirectionalParticleWidth={(l: any) => {
            const focus = hover ?? selected;
            if (!focus) return 0;
            const s = typeof l.source === 'object' ? l.source.id : l.source;
            const t = typeof l.target === 'object' ? l.target.id : l.target;
            return (s === focus || t === focus) ? 2.6 : 0;
          }}
          linkDirectionalParticleColor={(l: any) => {
            const focus = hover ?? selected;
            if (!focus) return '#ffffff';
            const sNode: any = typeof l.source === 'object' ? l.source : null;
            const tNode: any = typeof l.target === 'object' ? l.target : null;
            const other = sNode && sNode.id === focus ? tNode : sNode;
            return other ? colorFor(other) : '#7dd3fc';
          }}
          linkDirectionalParticleResolution={6}
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
        />
      )}
    </div>
  );
}
