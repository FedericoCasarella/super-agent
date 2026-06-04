import { createContext, useContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { useLiveData } from './ws';
import { AlertOctagon } from 'lucide-react';

// =====================================================================
// QuotaProvider — single global state for Claude session usage. Any
// component that triggers AI work reads `locked` and disables itself.
// A red banner pinned to the top of the page makes the freeze unmissable.
// =====================================================================

type QuotaState = {
  sessionPct: number;
  weekPct: number;
  locked: boolean;
  refresh: () => Promise<void>;
};

const Ctx = createContext<QuotaState>({ sessionPct: 0, weekPct: 0, locked: false, refresh: async () => {} });

export function QuotaProvider({ children }: { children: ReactNode }) {
  const [sessionPct, setSessionPct] = useState(0);
  const [weekPct, setWeekPct] = useState(0);
  const refresh = useCallback(async () => {
    try {
      const u: any = await api.usage();
      setSessionPct(Number(u?.sessionPct ?? u?.claudeCost?.sessionPct ?? 0));
      setWeekPct(Number(u?.weekPct ?? u?.claudeCost?.weekPct ?? 0));
    } catch {}
  }, []);
  // Re-pull on every `usage` WS push + safety fallback every 5 min.
  useLiveData(refresh, { refreshOn: ['usage'], fallbackMs: 300_000 });
  const locked = sessionPct >= 95;
  const value = useMemo(() => ({ sessionPct, weekPct, locked, refresh }), [sessionPct, weekPct, locked, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useQuota() { return useContext(Ctx); }

// Hook used by every "AI burner" button. Returns props you can spread onto a
// button — disables it + adds a tooltip explaining why.
export function useQuotaLock(): { locked: boolean; lockProps: { disabled?: boolean; title?: string } } {
  const { locked } = useQuota();
  return {
    locked,
    lockProps: locked
      ? { disabled: true, title: 'Bloccato: limite piano Claude raggiunto (>=95%). Rinnova per sbloccare.' }
      : {},
  };
}

// Pinned red banner — render once at the top of the layout. Hidden when not
// locked. zIndex high so dialogs/drawers don't cover it.
export function QuotaBanner() {
  const { locked, sessionPct } = useQuota();
  if (!locked) return null;
  return (
    <div
      role="alert"
      className="sticky top-0 z-[100] w-full bg-red-600/95 border-b border-red-300/40 text-white shadow-[0_4px_20px_rgba(239,68,68,0.45)]"
    >
      <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center gap-3">
        <AlertOctagon size={18} className="shrink-0 animate-pulse" />
        <div className="flex-1 text-sm font-medium leading-snug">
          <b>SISTEMA IN FERMO ({sessionPct}% piano Claude usato).</b>{' '}
          Per evitare perdite di dati / risposte incomplete / danneggiamenti al brain, ogni operazione AI è bloccata fino al rinnovo del piano.
        </div>
      </div>
    </div>
  );
}
