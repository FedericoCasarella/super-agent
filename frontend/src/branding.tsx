import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Branding = { title: string; subtitle: string | null; logoDataUrl: string | null };

const DEFAULT: Branding = { title: 'super-agent', subtitle: 'personal · brain', logoDataUrl: null };

const Ctx = createContext<{ branding: Branding; reload: () => Promise<void> }>({ branding: DEFAULT, reload: async () => {} });

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT);
  const reload = useCallback(async () => {
    try { setBranding(await api.branding()); } catch {}
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { try { document.title = branding.title || 'super-agent'; } catch {} }, [branding.title]);
  return <Ctx.Provider value={{ branding, reload }}>{children}</Ctx.Provider>;
}

export function useBranding() {
  return useContext(Ctx);
}
