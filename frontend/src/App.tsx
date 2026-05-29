import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import Sidebar from './components/Sidebar';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Connectors from './pages/Connectors';
import Brain from './pages/Brain';
import Settings from './pages/Settings';
import Roadmap from './pages/Roadmap';
import Logs from './pages/Logs';
import Tasks from './pages/Tasks';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import LiveAgents from './pages/LiveAgents';
import Network from './pages/Network';
import AuthPage from './pages/AuthPage';
import MessageSound from './components/MessageSound';

function BackendOffline({ onRetry }: { onRetry: () => Promise<void> }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-4">
        <div aria-hidden className="w-16 h-16 mx-auto rounded-2xl ring-1 ring-white/10 flex items-center justify-center text-3xl bg-gradient-to-br from-accent/20 to-accent2/20">🐙</div>
        <h1 className="text-lg font-semibold text-gradient">Polpo Brain non è raggiungibile</h1>
        <p className="text-sm text-muted">Il backend è offline o non risponde. Non è un problema di accesso — il tuo cervello è solo scollegato.</p>
        <button
          onClick={async () => { setRetrying(true); try { await onRetry(); } finally { setRetrying(false); } }}
          disabled={retrying}
          className="px-5 py-2.5 rounded-full bg-accent/90 hover:bg-accent text-bg font-medium text-sm transition disabled:opacity-50"
        >
          {retrying ? 'Riprovo…' : 'Riprova'}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { user, loading, backendDown, refresh: refreshAuth } = useAuth();
  const [status, setStatus] = useState<any>(null);
  const [collapsed, setCollapsed] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('sidebar_collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch {} }, [collapsed]);

  async function refresh() {
    if (!user) return;
    try { setStatus(await api.status()); } catch {}
  }
  useEffect(() => { refresh(); }, [user]);

  if (backendDown) return <BackendOffline onRetry={refreshAuth} />;
  if (loading) return <div className="h-full flex items-center justify-center text-muted">loading…</div>;
  if (!user) return <AuthPage />;
  if (!status) return <div className="h-full flex items-center justify-center text-muted">loading…</div>;
  if (!status.onboarded) return <Onboarding status={status} onDone={refresh} />;

  return (
    <div className="h-full flex">
      <MessageSound />
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        onCloseMobile={() => setMobileOpen(false)}
      />
      <main className="flex-1 min-w-0 overflow-y-auto">
        {/* Mobile top bar */}
        <div className="md:hidden sticky top-0 z-20 glass border-b border-border flex items-center justify-between px-4 py-2.5">
          <button
            onClick={() => setMobileOpen(true)}
            className="w-10 h-10 rounded-xl border border-border bg-surface2/70 flex items-center justify-center text-text hover:border-accent/50 transition"
            aria-label="Open menu"
          >
            <span className="text-lg">≡</span>
          </button>
          <div className="flex items-center gap-2">
            <div aria-hidden className="w-7 h-7 rounded-lg ring-1 ring-white/10 flex items-center justify-center text-base bg-gradient-to-br from-accent/20 to-accent2/20">🐙</div>
            <span className="text-sm font-semibold text-gradient">Polpo Brain</span>
          </div>
          <div className="w-10" />
        </div>

        <div className="p-4 sm:p-6 md:p-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/brain" element={<Brain />} />
            <Route path="/roadmap" element={<Roadmap />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/perks" element={<Agents />} />
            <Route path="/perks/:name" element={<AgentDetail />} />
            <Route path="/agents" element={<LiveAgents />} />
            <Route path="/live-agents" element={<Navigate to="/agents" replace />} />
            <Route path="/network" element={<Network />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
