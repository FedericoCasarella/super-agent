export type BrainColors = {
  visibility: Record<string, string>;
  kind: Record<string, string>;
  default: string;
};

export const DEFAULT_BRAIN_COLORS: BrainColors = {
  visibility: { protected: '#d946ef', public: '#67e8f9' },
  kind: { person: '#22d3ee', email: '#c084fc', project: '#34d399', note: '#fbbf24', daily: '#f0abfc', roadmap: '#f97316', task: '#a78bfa', attachment: '#94a3b8', whatsapp: '#25d366' },
  default: '#c084fc',
};

// Module-level cache so all graph components read the same palette
let cache: BrainColors = { ...DEFAULT_BRAIN_COLORS };
const listeners = new Set<() => void>();
export function getBrainColors(): BrainColors { return cache; }
export function setBrainColors(c: BrainColors) { cache = c; for (const l of listeners) l(); }
export function subscribeBrainColors(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function colorForNode(node: any): string {
  if (node?.origin_email) {
    let h = 0; const s = String(node.origin_email);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360}, 70%, 65%)`;
  }
  if (node?.visibility && cache.visibility[node.visibility]) return cache.visibility[node.visibility];
  if (node?.kind && cache.kind[node.kind]) return cache.kind[node.kind];
  return cache.default;
}
