import { useEffect, useState } from 'react';
import { api } from '../api';

type Usage = {
  plan: { name: string; sessionLimitTokens: number };
  usedTokens: number;
  resetAt: string | null;
};

function fmtReset(iso: string | null): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'pronto';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default function UsageGauge({ collapsed = false }: { collapsed?: boolean }) {
  const [u, setU] = useState<Usage | null>(null);
  async function load() { try { setU(await api.usage()); } catch {} }
  useEffect(() => { load(); const id = setInterval(load, 30_000); return () => clearInterval(id); }, []);
  // Re-render every minute to keep reset timer fresh
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(id); }, []);
  if (!u) return null;
  const limit = u.plan.sessionLimitTokens || 1;
  const pct = Math.min(1, u.usedTokens / limit);

  if (collapsed) {
    return (
      <div className="px-1 py-2" title={`${u.plan.name} · ${Math.round(pct * 100)}% · reset ${fmtReset(u.resetAt)}`}>
        <div className="h-1.5 rounded-full bg-surface2/80 overflow-hidden">
          <div className="h-full bg-accent rounded-full transition-all duration-700" style={{ width: `${pct * 100}%` }} />
        </div>
      </div>
    );
  }

  async function calibrate() {
    const realPctStr = prompt(`Calibra limite. Guarda nel TUI Claude (/cost) il % attuale e inseriscilo qui.\n\nTokens letti: ${u!.usedTokens.toLocaleString()}\nLimite attuale stimato: ${u!.plan.sessionLimitTokens.toLocaleString()}\n\nInserisci % reale (es. 28):`);
    if (!realPctStr) return;
    const realPct = parseFloat(realPctStr) / 100;
    if (!realPct || realPct <= 0 || realPct > 1) return;
    const newLimit = Math.round(u!.usedTokens / realPct);
    try {
      await api.updatePlan(u!.plan.name, newLimit);
      load();
    } catch (e: any) { alert(`Errore: ${e.message}`); }
  }

  return (
    <div className="px-1 py-2 cursor-pointer" onClick={calibrate} title="Click per calibrare il limite">
      <div className="text-[11px] font-semibold mb-1">
        Limiti piano <span className="text-muted font-normal">· {u.plan.name}</span>
      </div>
      <div className="text-[10px] text-muted mb-1.5">Sessione corrente</div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-surface2/80 overflow-hidden">
          <div className="h-full bg-accent rounded-full transition-all duration-700" style={{ width: `${pct * 100}%` }} />
        </div>
        <span className="text-[10px] text-muted font-mono shrink-0">{Math.round(pct * 100)}%</span>
      </div>
      <div className="text-[9px] text-muted mt-1">Reset tra {fmtReset(u.resetAt)}</div>
    </div>
  );
}
