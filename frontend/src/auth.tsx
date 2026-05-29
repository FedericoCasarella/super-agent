import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { auth, ApiError } from './api';

type User = { id: number; email: string; name: string | null };
type Ctx = {
  user: User | null;
  loading: boolean;
  usersExist: boolean;
  backendDown: boolean;
  login: (email: string, password: string) => Promise<void>;
  initialize: (email: string, password: string, name?: string) => Promise<{ claimedOrphans?: boolean }>;
  logout: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [usersExist, setUsersExist] = useState(true);
  const [loading, setLoading] = useState(true);
  const [backendDown, setBackendDown] = useState(false);

  async function refresh() {
    try {
      const [me, boot] = await Promise.all([auth.me(), auth.bootstrap()]);
      setUser(me.user); setUsersExist(boot.usersExist); setBackendDown(false);
    } catch (e) {
      // Distinguish "backend unreachable / server error" from "not logged in".
      // Without this, a down backend renders the login form ("Welcome back") and
      // an outage masquerades as broken auth (sess.2939 login-outage RCA).
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 0 || status >= 500) { setBackendDown(true); }
      else { setUser(null); setBackendDown(false); }
    }
    finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  return (
    <AuthContext.Provider value={{
      user, loading, usersExist, backendDown,
      async login(email, password) { const r = await auth.login(email, password); setUser(r.user); await refresh(); },
      async initialize(email, password, name) { const r = await auth.initialize(email, password, name); setUser(r.user); await refresh(); return { claimedOrphans: r.claimedOrphans }; },
      async logout() { await auth.logout(); setUser(null); await refresh(); },
      async deleteAccount(password: string) { await auth.deleteAccount(password); setUser(null); await refresh(); },
      refresh,
    }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
