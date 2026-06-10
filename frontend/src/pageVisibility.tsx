import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

// =====================================================================
// Page visibility — user-controlled which pages appear in the sidebar.
// Stored locally (per-device). Default state hides everything beyond the
// core stack so a first-time install looks clean; user opts pages in from
// Settings → Layout.
// =====================================================================

export type PageKey =
  | 'whatsapp' | 'instagram' | 'people' | 'teams'
  | 'flows' | 'outbound' | 'logs';

export const PAGE_META: Record<PageKey, { label: string; description: string }> = {
  whatsapp:  { label: 'WhatsApp',  description: 'Chat WA + auto-bonifica + suggerimenti AI' },
  instagram: { label: 'Instagram', description: 'DM Instagram + auto-responder' },
  people:    { label: 'People',    description: 'Rubrica persone arricchita dal brain' },
  teams:     { label: 'Teams',     description: 'Squadre di agenti orchestrati' },
  flows:     { label: 'Flows',     description: 'Trigger → step automazioni' },
  outbound:  { label: 'Inviati',   description: 'Log comunicazioni outbound' },
  logs:      { label: 'Logs',      description: 'Log raw agent + connector' },
};

const ALL_KEYS: PageKey[] = Object.keys(PAGE_META) as PageKey[];

const LS_KEY = 'page_visibility_v1';
const DEFAULT_VISIBLE: Record<PageKey, boolean> = {
  whatsapp: false,
  instagram: false,
  people: true,
  teams: false,
  flows: false,
  outbound: false,
  logs: false,
};

function readLS(): Record<PageKey, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_VISIBLE };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_VISIBLE };
    for (const k of ALL_KEYS) if (typeof parsed[k] === 'boolean') merged[k] = parsed[k];
    return merged;
  } catch { return { ...DEFAULT_VISIBLE }; }
}
function writeLS(state: Record<PageKey, boolean>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
}

type PageVisCtx = {
  visible: Record<PageKey, boolean>;
  isVisible: (k: PageKey) => boolean;
  toggle: (k: PageKey) => void;
  setAll: (next: Partial<Record<PageKey, boolean>>) => void;
};

const PageVisContext = createContext<PageVisCtx>({
  visible: { ...DEFAULT_VISIBLE },
  isVisible: () => true,
  toggle: () => {},
  setAll: () => {},
});

export function PageVisibilityProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState<Record<PageKey, boolean>>(() => readLS());
  // Persist on every change — side effects belong in useEffect, not in the
  // setState updater (StrictMode double-invokes updaters in dev which would
  // run writeLS twice and could mask the actual state transition).
  useEffect(() => { writeLS(visible); }, [visible]);
  // Cross-tab sync — react to other tabs' edits.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === LS_KEY) setVisible(readLS()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggle = useCallback((k: PageKey) => {
    setVisible((cur) => ({ ...cur, [k]: !cur[k] }));
  }, []);
  const setAll = useCallback((next: Partial<Record<PageKey, boolean>>) => {
    setVisible((cur) => ({ ...cur, ...next }));
  }, []);
  const isVisible = useCallback((k: PageKey) => visible[k] !== false, [visible]);
  const value = useMemo(() => ({ visible, isVisible, toggle, setAll }), [visible, isVisible, toggle, setAll]);
  return <PageVisContext.Provider value={value}>{children}</PageVisContext.Provider>;
}

export function usePageVisibility() { return useContext(PageVisContext); }
