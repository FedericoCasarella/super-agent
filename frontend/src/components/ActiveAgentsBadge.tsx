import { useCallback, useState } from 'react';
import { api } from '../api';
import { useLiveData } from '../ws';
import { Activity } from 'lucide-react';

type Active = { kind: 'perk' | 'subagent'; name: string; title: string };

// Live badge: shows perks (internal agents) currently running + active sub-agents.
// Placed in sidebar above UsageGauge. Polls every 5s.
export default function ActiveAgentsBadge({ collapsed = false }: { collapsed?: boolean }) {
  const [items, setItems] = useState<Active[]>([]);

  const load = useCallback(async () => {
    try {
      const [perks, subs] = await Promise.all([
        api.internalAgents().catch(() => []),
        api.subAgentsActive().catch(() => []),
      ]);
      const out: Active[] = [];
      for (const p of perks as any[]) if (p.running) out.push({ kind: 'perk', name: p.name, title: p.title || p.name });
      for (const s of subs as any[]) if (s.status === 'running' || s.status === 'pending') out.push({ kind: 'subagent', name: String(s.id), title: s.title || `Sub-agent #${s.id}` });
      setItems(out);
    } catch {}
  }, []);
  useLiveData(load, { refreshOn: ['internal_agent', 'subagent'], fallbackMs: 120_000 });

  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <div className="px-1 py-1.5" title={items.map((i) => i.title).join('\n')}>
        <div className="flex items-center justify-center gap-1.5 px-2 py-1 rounded-full bg-accent/15 border border-accent/30">
          <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] font-semibold text-accent font-mono">{items.length}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-1 py-1.5">
      <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wider text-muted">
        <Activity size={10} className="text-accent" />
        <span>In esecuzione</span>
        <span className="ml-auto font-mono text-accent">{items.length}</span>
      </div>
      <div className="space-y-1">
        {items.slice(0, 5).map((i) => (
          <div
            key={`${i.kind}:${i.name}`}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/10 border border-accent/25"
            title={`${i.kind === 'perk' ? 'Perk' : 'Sub-agent'}: ${i.title}`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
            <span className="text-[11px] truncate flex-1">{i.title}</span>
            <span className="text-[9px] text-muted font-mono uppercase">{i.kind === 'perk' ? 'perk' : 'sub'}</span>
          </div>
        ))}
        {items.length > 5 && <div className="text-[10px] text-muted pl-1">+{items.length - 5} altri</div>}
      </div>
    </div>
  );
}
