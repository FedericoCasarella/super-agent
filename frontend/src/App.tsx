import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { QuotaBanner } from './quota';
import { usePageVisibility, type PageKey } from './pageVisibility';
import AppSidebar from './components/Sidebar';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { Separator } from '@/components/ui/separator';

function Gated({ page, children }: { page: PageKey; children: ReactNode }) {
  const { isVisible } = usePageVisibility();
  if (!isVisible(page)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

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
import TeamTaskDetail from './pages/TeamTaskDetail';
import Network from './pages/Network';
import AuthPage from './pages/AuthPage';
import Snapshots from './pages/Snapshots';
import Report from './pages/Report';
import MessageSound from './components/MessageSound';
import BrainLoading from './components/BrainLoading';

export default function App() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<any>(null);

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
    <SidebarProvider>
      <MessageSound />
      <AppSidebar />
      <SidebarInset>
        {/* Topbar: sidebar toggle + page area + theme switcher */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 backdrop-blur px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <div className="flex-1" />
          <ThemeSwitcher />
        </header>
        <QuotaBanner />
        <div className="p-4 sm:p-6 lg:p-8 min-w-0">
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
            <Route path="/snapshots" element={<Snapshots />} />
            <Route path="/report" element={<Report />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
