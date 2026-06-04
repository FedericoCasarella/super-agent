import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { QuotaBanner } from './quota';
import { usePageVisibility, type PageKey } from './pageVisibility';

// Gate route content behind a page-visibility flag. Hidden pages redirect to
// the dashboard instead of rendering — keeps gated routes from being reachable
// via bookmarks until the user opts them in from Settings.
function Gated({ page, children }: { page: PageKey; children: ReactNode }) {
  const { isVisible } = usePageVisibility();
  if (!isVisible(page)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
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
import PeoplePage from './pages/People';
import WhatsApp from './pages/WhatsApp';
import InstagramPage from './pages/Instagram';
import Outbound from './pages/Outbound';
import FlowsPage from './pages/Flows';
import FlowDetail from './pages/FlowDetail';
import AgentsHub from './pages/AgentsHub';
import Teams from './pages/Teams';
import TeamTasks from './pages/TeamTasks';
import TeamTaskDetail from './pages/TeamTaskDetail';
import Network from './pages/Network';
import AuthPage from './pages/AuthPage';
import MessageSound from './components/MessageSound';
import BrainLoading from './components/BrainLoading';
import { useBranding } from './branding';

function MobileBrand() {
  const { branding } = useBranding();
  return (
    <>
      <img src={branding.logoDataUrl || '/rounded-image.png'} alt="" className="w-7 h-7 rounded-lg ring-1 ring-white/10 object-cover" />
      <span className="text-sm font-semibold text-gradient truncate max-w-[60vw]">{branding.title}</span>
    </>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<any>(null);
  const [collapsed, setCollapsed] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('sidebar_collapsed') === '1');
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { try { localStorage.setItem('sidebar_collapsed', collapsed ? '1' : '0'); } catch {} }, [collapsed]);

  async function refresh() {
    if (!user) return;
    try { setStatus(await api.status()); } catch {}
  }
  useEffect(() => { refresh(); }, [user]);

  if (loading) return <div className="h-full flex items-center justify-center"><BrainLoading size={140} /></div>;
  if (!user) return <AuthPage />;
  if (!status) return <div className="h-full flex items-center justify-center"><BrainLoading size={140} /></div>;
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
        <QuotaBanner />
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
            <MobileBrand />
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
            <Route path="/agents" element={<AgentsHub />} />
            <Route path="/whatsapp" element={<Gated page="whatsapp"><WhatsApp /></Gated>} />
            <Route path="/instagram" element={<Gated page="instagram"><InstagramPage /></Gated>} />
            <Route path="/people" element={<Gated page="people"><PeoplePage /></Gated>} />
            <Route path="/live-agents" element={<Navigate to="/agents" replace />} />
            <Route path="/network" element={<Network />} />
            <Route path="/logs" element={<Gated page="logs"><Logs /></Gated>} />
            <Route path="/outbound" element={<Gated page="outbound"><Outbound /></Gated>} />
            <Route path="/flows" element={<Gated page="flows"><FlowsPage /></Gated>} />
            <Route path="/flows/:id" element={<Gated page="flows"><FlowDetail /></Gated>} />
            <Route path="/custom-agents" element={<Navigate to="/agents?tab=custom" replace />} />
            <Route path="/teams" element={<Gated page="teams"><Teams /></Gated>} />
            <Route path="/team-tasks" element={<Navigate to="/tasks?tab=team" replace />} />
            <Route path="/team-tasks/:id" element={<TeamTaskDetail />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
