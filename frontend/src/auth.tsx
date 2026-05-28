import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { auth } from './api';

type User = { id: number; email: string; name: string | null };
type Ctx = {
  user: User | null;
  loading: boolean;
  usersExist: boolean;
  login: (email: string, password: string) => Promise<void>;
  initialize: (email: string, password: string, name?: string) => Promise<{ claimedOrphans?: boolean }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [usersExist, setUsersExist] = useState(true);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const [me, boot] = await Promise.all([auth.me(), auth.bootstrap()]);
      setUser(me.user); setUsersExist(boot.usersExist);
    } catch { setUser(null); }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <AuthContext.Provider value={{
      user, loading, usersExist,
      async login(email, password) { const r = await auth.login(email, password); setUser(r.user); await refresh(); },
      async initialize(email, password, name) { const r = await auth.initialize(email, password, name); setUser(r.user); await refresh(); return { claimedOrphans: r.claimedOrphans }; },
      async logout() { await auth.logout(); setUser(null); await refresh(); },
      refresh,
    }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
