import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useToast } from './ui';
import { useDialog } from './dialog';
import { useLiveData } from '../ws';

type Usage = {
  plan: { name: string; sessionLimitTokens: number; costBudgetUsd: number };
  usedTokens: number;
  costUsd: number;
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

// Confetti burst — 40 colored dots fall from top, rotate, fade out
function Confetti() {
  const COLORS = ['#c084fc', '#22d3ee', '#f0abfc', '#34d399', '#fbbf24', '#f87171'];
  const N = 40;
  const pieces = Array.from({ length: N }, (_, i) => {
    const left = Math.random() * 100;
    const delay = Math.random() * 0.4;
    const dur = 1.6 + Math.random() * 1.2;
    const rot = Math.random() * 360;
    const drift = (Math.random() - 0.5) * 200;
    const color = COLORS[i % COLORS.length];
    const w = 6 + Math.random() * 6;
    return { left, delay, dur, rot, drift, color, w };
  });
  return createPortal(
    <div className="fixed inset-0 z-[200] pointer-events-none overflow-hidden">
      <style>{`@keyframes confetti-fall { 0% { transform: translate(0,-30px) rotate(0deg); opacity: 1 } 100% { transform: translate(var(--dx),100vh) rotate(720deg); opacity: 0 } }`}</style>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: 'absolute', top: 0, left: `${p.left}%`,
          width: p.w, height: p.w * 0.4, background: p.color,
          borderRadius: 2,
          ['--dx' as any]: `${p.drift}px`,
          transform: `rotate(${p.rot}deg)`,
          animation: `confetti-fall ${p.dur}s cubic-bezier(0.3,0.8,0.6,1) ${p.delay}s both`,
        }} />
      ))}
    </div>,
    document.body,
  );
}

export default function UsageGauge({ collapsed = false }: { collapsed?: boolean }) {
  const [u, setU] = useState<Usage | null>(null);
  const [partyOn, setPartyOn] = useState(false);
  const prevTokensRef = useRef<number | null>(null);
  const toast = useToast();
  const dlg = useDialog();
  const load = useCallback(async () => {
    try {
      const next = await api.usage();
      const prev = prevTokensRef.current;
      // Reset detection: previously had cost burn, now ~0 (window expired)
      if (prev != null && prev >= 1 && (next.costUsd ?? 0) < 0.1) {
        toast.push('🎉 Piano resettato! Nuova sessione disponibile', 'on');
        setPartyOn(true);
        setTimeout(() => setPartyOn(false), 3500);
      }
      prevTokensRef.current = next.costUsd ?? 0;
      setU(next);
    } catch {}
  }, [toast]);
  // WS-driven — backend emits `usage` events when the cached value refreshes.
  // We still keep a 5min safety fallback so an idle tab eventually reconciles.
  useLiveData(load, { refreshOn: ['usage'], fallbackMs: 300_000 });
  // Re-render every minute to keep reset timer fresh
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 60_000); return () => clearInterval(id); }, []);
  if (!u) return null;
  // Cost-based gauge: matches Claude Code /cost % output (token mix has too many weighted
  // components — input/output/cache_read/cache_create — to track with a single token limit).
  const budget = u.plan.costBudgetUsd || 1;
  const pct = Math.min(1, (u.costUsd ?? 0) / budget);

  if (collapsed) {
    return (
      <>
        <div className="px-1 py-2" title={`${u.plan.name} · ${Math.round(pct * 100)}% · reset ${fmtReset(u.resetAt)}`}>
          <div className="h-1.5 rounded-full bg-surface2/80 overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all duration-700" style={{ width: `${pct * 100}%` }} />
          </div>
        </div>
        {partyOn && <Confetti />}
      </>
    );
  }

  async function calibrate() {
    const realPctStr = await dlg.prompt(
      `Calibra budget. Apri il TUI Claude → /cost → leggi il % attuale.\n\nCost speso (ccusage): $${(u!.costUsd ?? 0).toFixed(2)}\nBudget attuale stimato: $${(u!.plan.costBudgetUsd ?? 0).toFixed(2)}\n\nInserisci % reale mostrato in /cost (es. 37):`,
      { title: 'Sync con /cost', placeholder: 'es. 37', confirmLabel: 'Salva' },
    );
    if (!realPctStr) return;
    const realPct = parseFloat(realPctStr) / 100;
    if (!realPct || realPct <= 0 || realPct > 1) return;
    const newBudget = (u!.costUsd ?? 0) / realPct;
    if (!isFinite(newBudget) || newBudget <= 0) {
      await dlg.alert('Cost attuale è 0 — impossibile calibrare.', { tone: 'danger' });
      return;
    }
    try {
      await api.updatePlan({ name: u!.plan.name, costBudgetUsd: Math.round(newBudget * 100) / 100 });
      load();
    } catch (e: any) { await dlg.alert(`Errore: ${e.message}`, { tone: 'danger' }); }
  }

  return (
    <>
      <div className="px-1 py-2">
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
        <div className="text-[9px] text-muted mt-1 flex items-center justify-between">
          <span>Reset tra {fmtReset(u.resetAt)}</span>
          {(u.plan as any).manuallyCalibrated && <span className="text-emerald-300/70" title="Calibrato manualmente">✓ cal</span>}
        </div>
      </div>
      {partyOn && <Confetti />}
    </>
  );
}
