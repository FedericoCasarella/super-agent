import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ForceGraph3D, { ForceGraphMethods } from 'react-force-graph-3d';
import * as THREE from 'three';
import { api } from '../api';
import { colorForNode } from '../brainColors';
import { X } from 'lucide-react';
import BrainLoading from './BrainLoading';
import MarkdownView from './MarkdownView';
import { Chip } from './ui';

type Props = { slug: string; name: string; onClose: () => void };

export default function PersonGraphModal({ slug, name, onClose }: Props) {
  const [data, setData] = useState<{ nodes: any[]; links: any[]; center: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [note, setNote] = useState<any | null>(null);
  const [noteLoading, setNoteLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function openNote(id: string) {
    setSelectedId(id);
    const rel = id.includes('::') ? id.split('::', 2)[1] : id;
    setNote(null);
    setNoteLoading(true);
    try {
      const n = await api.brainNote(rel);
      setNote(n);
    } catch { setNote({ error: 'Nota non trovata', path: rel }); }
    finally { setNoteLoading(false); }
  }

  useEffect(() => {
    api.personGraph(slug, 2).then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(200, Math.floor(r.width)), h: Math.max(200, Math.floor(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const fg: any = fgRef.current;
    if (!fg || !data?.center) return;
    // Tune forces ONCE before simulation runs; let dagMode position then settle silently.
    try {
      const charge = fg.d3Force?.('charge');
      if (charge?.strength) charge.strength(-220).distanceMax(500);
      const link = fg.d3Force?.('link');
      if (link?.distance) link.distance(100);
      const ctrls = fg.controls?.();
      if (ctrls) { ctrls.autoRotate = false; } // start steady
    } catch {}
  }, [data]);

  const centerNode = data?.nodes.find((n) => n.id === data.center);

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in" onClick={onClose}>
      <div
        className={`relative w-full ${note || noteLoading ? 'max-w-6xl' : 'max-w-4xl'} h-[85vh] rounded-3xl border border-border bg-bg overflow-hidden gradient-border flex flex-col transition-all duration-300`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="z-20 flex items-center justify-between px-5 py-3 bg-surface/95 backdrop-blur border-b border-border shrink-0">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wider text-accent font-semibold">Connessioni cervello</div>
            <h3 className="text-lg font-semibold truncate">{name}</h3>
            {data && <div className="text-[10px] text-muted font-mono">{data.nodes.length} nodi · {data.links.length} link</div>}
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-full bg-surface2 hover:bg-surface2/60 border border-border flex items-center justify-center text-muted hover:text-text transition">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 flex min-h-0">
        <div ref={wrapRef} className="relative flex-1 min-w-0" style={{ background: '#02030a' }}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center"><BrainLoading size={100} label="Calcolo grafo…" /></div>
          )}
          {!loading && data && data.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">
              Nessuna connessione trovata per <span className="font-mono ml-1">{slug}</span>
            </div>
          )}
          {!loading && size && data && data.nodes.length > 0 && (
            <ForceGraph3D
              ref={fgRef as any}
              graphData={data as any}
              width={size.w}
              height={size.h - 0}
              backgroundColor="#02030a"
              showNavInfo={false}
              nodeRelSize={4}
              nodeVal={(n: any) => n.id === data.center ? 14 : n.id === selectedId ? 10 : (n.size ?? 1.5)}
              nodeColor={(n: any) => n.id === selectedId ? '#fbbf24' : n.id === data.center ? '#39ff7a' : colorForNode(n)}
              nodeOpacity={0.95}
              nodeResolution={20}
              nodeLabel={(n: any) => `<div style="font:500 11px Inter; padding:6px 10px; background:rgba(8,16,28,0.92); border:1px solid #1f4a55; border-radius:8px; color:#e8e8f0;">${n.title || n.id}${n.id === data.center ? ' <span style=color:#39ff7a>★ centro</span>' : ''}${n.id === selectedId ? ' <span style=color:#fbbf24>● selezionato</span>' : ''}</div>`}
              linkColor={(l: any) => {
                const s = typeof l.source === 'object' ? l.source.id : l.source;
                const t = typeof l.target === 'object' ? l.target.id : l.target;
                if (selectedId && (s === selectedId || t === selectedId)) return 'rgba(251,191,36,0.85)';
                return (s === data.center || t === data.center) ? 'rgba(57,255,122,0.55)' : 'rgba(192,132,252,0.3)';
              }}
              linkWidth={(l: any) => {
                const s = typeof l.source === 'object' ? l.source.id : l.source;
                const t = typeof l.target === 'object' ? l.target.id : l.target;
                if (selectedId && (s === selectedId || t === selectedId)) return 2.2;
                return (s === data.center || t === data.center) ? 1.4 : 0.5;
              }}
              linkOpacity={1}
              linkDirectionalParticles={(l: any) => {
                const s = typeof l.source === 'object' ? l.source.id : l.source;
                const t = typeof l.target === 'object' ? l.target.id : l.target;
                if (selectedId && (s === selectedId || t === selectedId)) return 4;
                return (s === data.center || t === data.center) ? 3 : 0;
              }}
              linkDirectionalParticleSpeed={0.008}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleColor={(l: any) => {
                const s = typeof l.source === 'object' ? l.source.id : l.source;
                const t = typeof l.target === 'object' ? l.target.id : l.target;
                if (selectedId && (s === selectedId || t === selectedId)) return '#fbbf24';
                return '#39ff7a';
              }}
              enableNodeDrag
              cooldownTicks={80}
              warmupTicks={300}
              dagMode={'radialout' as any}
              dagLevelDistance={140}
              d3AlphaDecay={0.06}
              d3VelocityDecay={0.6}
              onNodeClick={(n: any) => openNote(n.id)}
              onEngineStop={() => {
                try {
                  const fg: any = fgRef.current;
                  fg?.zoomToFit?.(800, 80);
                  const ctrls = fg?.controls?.();
                  if (ctrls) { ctrls.autoRotate = true; ctrls.autoRotateSpeed = 0.35; }
                } catch {}
              }}
            />
          )}
          {centerNode && (
            <div className="absolute bottom-3 left-3 right-3 z-10 flex items-center gap-2 text-[10px] text-muted bg-bg/80 backdrop-blur rounded-xl border border-border px-3 py-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              <span>verde = nodo persona</span>
              <span className="text-muted/50">·</span>
              <span>click nodo per leggere nota</span>
            </div>
          )}
        </div>

        {(note || noteLoading) && (
          <div className="w-96 shrink-0 border-l border-border bg-surface/60 overflow-y-auto animate-fade-in">
            <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-border bg-surface/95 backdrop-blur">
              <div className="text-xs uppercase tracking-wider text-accent font-semibold">Nota</div>
              <button onClick={() => setNote(null)} className="text-muted hover:text-text"><X size={14} /></button>
            </div>
            <div className="p-4">
              {noteLoading && <BrainLoading size={60} label="Carico nota…" />}
              {!noteLoading && note?.error && (
                <div className="text-sm text-err">{note.error}</div>
              )}
              {!noteLoading && note && !note.error && (
                <>
                  <div className="text-[10px] text-muted font-mono mb-2 break-all">{note.path}</div>
                  <h4 className="font-semibold mb-2 text-base">{note.title || note.path}</h4>
                  {(note.tags ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-3">
                      {(note.tags as string[]).map((t) => <Chip key={t}>{t}</Chip>)}
                    </div>
                  )}
                  <div className="prose prose-invert prose-sm max-w-none">
                    <MarkdownView content={note.content ?? ''} />
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Silence unused import on Three for tree-shake correctness
void THREE;
