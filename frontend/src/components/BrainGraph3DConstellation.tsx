import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import ForceGraph3D, { ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';
import { api } from '../api';
import { useWS } from '../ws';

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
function colorFor(node: any): string {
  if (node.origin_email)              return originColor(node.origin_email);
  if (node.visibility === 'protected') return VIS_PROTECTED;
  if (node.visibility === 'public')    return VIS_PUBLIC;
  return KIND_COLOR[node.kind] ?? DEFAULT_COLOR;
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
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [showLabels, setShowLabels] = useState<boolean>(() => typeof localStorage !== 'undefined' ? localStorage.getItem('brain_3d_labels') !== '0' : true);
  useEffect(() => { try { localStorage.setItem('brain_3d_labels', showLabels ? '1' : '0'); } catch {} }, [showLabels]);
  const [showParticles, setShowParticles] = useState<boolean>(() => typeof localStorage !== 'undefined' ? localStorage.getItem('brain_3d_particles') !== '0' : true);
  useEffect(() => { try { localStorage.setItem('brain_3d_particles', showParticles ? '1' : '0'); } catch {} }, [showParticles]);
  const [density, setDensity] = useState<Density>(() => {
    try { const v = localStorage.getItem('brain_3d_density') as Density; if (v && DENSITY_PRESETS[v]) return v; } catch {}
    return 'med';
  });
  useEffect(() => { try { localStorage.setItem('brain_3d_density', density); } catch {} }, [density]);
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
    if (!p.vaultName || !p.rel) return;
    const id = `${p.vaultName}::${p.rel}`;
    const now = Date.now();
    mriRef.current.set(id, { start: now, end: now + MRI_DURATION_MS });
    focusDirtyRef.current = true;
    setMriTick((t) => t + 1);
  });
  // Tick while MRI active so nodeColor callback re-runs + auto-clear
  useEffect(() => {
    const iv = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of mriRef.current) {
        if (v.end <= now) mriRef.current.delete(k);
      }
      setMriTick((t) => t + 1);
    }, 100);
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
        curveAmp[idx] = 0.15 + Math.random() * 0.45;
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
    // OrbitControls autoRotate as fallback (library may pause after cooldown)
    const ctrls0: any = fg.controls?.();
    if (ctrls0) { ctrls0.autoRotate = true; ctrls0.autoRotateSpeed = 0.12; }

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
        // Per-frame node mesh tint + halo for MRI
        if (mriRef.current.size > 0 || haloRef.current.size > 0) {
          const fgAny: any = fg;
          const gd = fgAny.graphData?.() ?? null;
          if (gd) {
            const activeIds = new Set(mriRef.current.keys());
            for (const n of gd.nodes) {
              const env = mriEnv.get(idToIdxRef.current.get(n.id) ?? -1) ?? 0;
              const obj = (n as any).__threeObj as THREE.Object3D | undefined;
              if (!obj) continue;
              // Mesh: hard-set green when active (library nodeColorCb also returns green); add emissive+scale
              obj.traverse((c: any) => {
                if (c.isMesh && c.material) {
                  const mat: any = c.material;
                  if (env > 0) {
                    mat.color.copy(G);
                    if ('emissive' in mat) {
                      if (!mat.userData.__baseEmissive) mat.userData.__baseEmissive = mat.emissive.clone();
                      mat.emissive.copy(G).multiplyScalar(0.8 + env * 2.5);
                    }
                  } else {
                    if (mat.userData.__baseEmissive && 'emissive' in mat) mat.emissive.copy(mat.userData.__baseEmissive);
                  }
                }
              });
              obj.scale.setScalar(env > 0 ? (1 + env * 3.5) : 1);
              // Composite halo: glow sprite + 3 concentric expanding rings
              let halo = haloRef.current.get(n.id);
              if (env > 0) {
                if (!halo) {
                  halo = new THREE.Group();
                  // Glow sprite (radial gradient texture)
                  const cv = document.createElement('canvas');
                  cv.width = 128; cv.height = 128;
                  const cx = cv.getContext('2d')!;
                  const grd = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
                  grd.addColorStop(0, 'rgba(150,255,200,1)');
                  grd.addColorStop(0.35, 'rgba(57,255,122,0.55)');
                  grd.addColorStop(1, 'rgba(57,255,122,0)');
                  cx.fillStyle = grd;
                  cx.fillRect(0, 0, 128, 128);
                  const tex = new THREE.CanvasTexture(cv);
                  const spriteMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
                  const glow = new THREE.Sprite(spriteMat);
                  glow.scale.set(40, 40, 1);
                  glow.userData.__role = 'glow';
                  halo.add(glow);
                  // Inner solid green disc for unmistakable presence
                  const coreMat = new THREE.SpriteMaterial({ color: MRI_GREEN, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
                  const core = new THREE.Sprite(coreMat);
                  core.scale.set(8, 8, 1);
                  core.userData.__role = 'core';
                  halo.add(core);
                  // 5 rings staggered
                  for (let k = 0; k < 5; k++) {
                    const ringGeo = new THREE.RingGeometry(3.5, 4.2, 64);
                    const ringMat = new THREE.MeshBasicMaterial({ color: MRI_GREEN, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
                    const ring = new THREE.Mesh(ringGeo, ringMat);
                    ring.userData.__role = 'ring';
                    ring.userData.__phase = k / 5;
                    halo.add(ring);
                  }
                  obj.add(halo);
                  haloRef.current.set(n.id, halo);
                }
                // Animate children
                try {
                  const camPos = fg.camera().position;
                  for (const child of halo.children) {
                    if (child.userData.__role === 'glow') {
                      const s = 14 + env * 60;
                      (child as THREE.Sprite).scale.set(s, s, 1);
                      ((child as THREE.Sprite).material as THREE.SpriteMaterial).opacity = Math.min(1, env * 1.4);
                    } else if (child.userData.__role === 'core') {
                      const s = 3 + env * 12;
                      (child as THREE.Sprite).scale.set(s, s, 1);
                      ((child as THREE.Sprite).material as THREE.SpriteMaterial).opacity = Math.min(1, env * 1.5);
                    } else if (child.userData.__role === 'ring') {
                      child.lookAt(camPos);
                      const phase = (env + child.userData.__phase) % 1;
                      const grow = 1 + phase * 11;
                      child.scale.setScalar(grow);
                      ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = (1 - phase) * env;
                    }
                  }
                } catch {}
              } else if (halo) {
                obj.remove(halo);
                halo.traverse((c: any) => { if (c.geometry) c.geometry.dispose(); if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); } });
                haloRef.current.delete(n.id);
              }
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
            const ang = Math.atan2(dz, dx) + 0.035 * dt;
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
    try { fg?.refresh?.(); } catch {}
  }, [hover, selected, mriTick]);

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
    const sNode0: any = typeof l.source === 'object' ? l.source : null;
    const tNode0: any = typeof l.target === 'object' ? l.target : null;
    const mriEnv = mriEnvForLink(l);
    if (mriEnv > 0) return `rgba(57,255,122,${(0.95 * mriEnv).toFixed(3)})`;
    if (!focus) {
      if (showParticles) return 'rgba(0,0,0,0)';
      // Line mode: tint by source node base color
      const ref = sNode0 ?? tNode0;
      if (!ref) return 'rgba(170,180,210,0.35)';
      const c = new THREE.Color(colorFor(ref));
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.55)`;
    }
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s !== focus && t !== focus) {
      if (showParticles) return 'rgba(0,0,0,0)';
      const ref = sNode0 ?? tNode0;
      if (!ref) return 'rgba(120,130,160,0.22)';
      const c = new THREE.Color(colorFor(ref));
      return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.30)`;
    }
    // hot link tinted by the other endpoint (neighbor) — vivid, not grey
    const sNode: any = typeof l.source === 'object' ? l.source : null;
    const tNode: any = typeof l.target === 'object' ? l.target : null;
    const other = sNode && sNode.id === focus ? tNode : sNode;
    const base = other ? colorFor(other) : '#7dd3fc';
    // convert hex → rgba w/ moderate alpha so particles overlay reads as glow
    const c = new THREE.Color(base);
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},0.55)`;
  }, [hover, selected, showParticles, mriTick]);
  const linkWidthCb = useCallback((l: any) => {
    const focus = hover ?? selected;
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    const mriEnv = mriEnvForLink(l);
    const baseW = !focus ? (showParticles ? 0 : 0.25)
      : (sId === focus || tId === focus) ? 0.6
      : (showParticles ? 0 : 0.18);
    if (mriEnv > 0) return baseW + (1.8 - baseW) * mriEnv; // lerp base → 1.8
    return baseW;
  }, [hover, selected, showParticles, mriTick]);

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
        <button
          onClick={() => setShowParticles((v) => !v)}
          className={`w-10 h-10 rounded-xl border backdrop-blur transition flex items-center justify-center text-xs font-semibold ${
            !showParticles
              ? 'bg-accent/20 border-accent/60 text-accent'
              : 'bg-surface2/70 border-border text-muted hover:border-accent/50'
          }`}
          title={showParticles ? 'Solo righe (no particelle)' : 'Mostra particelle'}
        >{showParticles ? '≈' : '╱'}</button>
        <button
          onClick={() => setDensity((d) => DENSITY_ORDER[(DENSITY_ORDER.indexOf(d) + 1) % DENSITY_ORDER.length])}
          disabled={!showParticles}
          className={`w-10 h-10 rounded-xl border backdrop-blur transition flex items-center justify-center text-xs font-semibold ${
            !showParticles
              ? 'bg-surface2/40 border-border text-muted/50 cursor-not-allowed'
              : 'bg-surface2/70 border-border text-text hover:border-accent/50'
          }`}
          title={`Densità particelle: ${density.toUpperCase()} (${DENSITY_PRESETS[density]}/nodo). Clicca per cambiare.`}
        >{DENSITY_LABEL[density]}</button>
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
          nodeResolution={16}
          nodeThreeObject={nodeLabelExt}
          nodeThreeObjectExtend={true}
          nodeLabel={(n: any) => `<div style="font:500 11px Inter,system-ui; padding:6px 10px; background:rgba(8,16,28,0.92); border:1px solid #1f4a55; border-radius:8px; color:#e8e8f0;">${n.title}<div style="font-size:9px;color:#7a7a8c;margin-top:2px;">${n.id}</div></div>`}
          linkColor={linkColor}
          linkOpacity={1}
          linkWidth={linkWidthCb}
          linkDirectionalParticles={(l: any) => {
            const focus = hover ?? selected;
            const sId = typeof l.source === 'object' ? l.source.id : l.source;
            const tId = typeof l.target === 'object' ? l.target.id : l.target;
            const now = Date.now();
            const mriS = mriRef.current.get(sId);
            const mriT = mriRef.current.get(tId);
            if ((mriS && mriS.end > now) || (mriT && mriT.end > now)) return 14;
            if (!focus) return 0;
            return (sId === focus || tId === focus) ? 10 : 0;
          }}
          linkDirectionalParticleSpeed={(l: any) => {
            const focus = hover ?? selected;
            const sId = typeof l.source === 'object' ? l.source.id : l.source;
            const tId = typeof l.target === 'object' ? l.target.id : l.target;
            const now = Date.now();
            const mriS = mriRef.current.get(sId);
            const mriT = mriRef.current.get(tId);
            if ((mriS && mriS.end > now) || (mriT && mriT.end > now)) return 0.014;
            if (!focus) return 0;
            return (sId === focus || tId === focus) ? 0.011 : 0;
          }}
          linkDirectionalParticleWidth={(l: any) => {
            const focus = hover ?? selected;
            const sId = typeof l.source === 'object' ? l.source.id : l.source;
            const tId = typeof l.target === 'object' ? l.target.id : l.target;
            const now = Date.now();
            const mriS = mriRef.current.get(sId);
            const mriT = mriRef.current.get(tId);
            if ((mriS && mriS.end > now) || (mriT && mriT.end > now)) return 3.2;
            if (!focus) return 0;
            return (sId === focus || tId === focus) ? 2.6 : 0;
          }}
          linkDirectionalParticleColor={(l: any) => {
            const focus = hover ?? selected;
            const sId = typeof l.source === 'object' ? l.source.id : l.source;
            const tId = typeof l.target === 'object' ? l.target.id : l.target;
            const now = Date.now();
            const mriS = mriRef.current.get(sId);
            const mriT = mriRef.current.get(tId);
            if ((mriS && mriS.end > now) || (mriT && mriT.end > now)) return MRI_GREEN;
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
