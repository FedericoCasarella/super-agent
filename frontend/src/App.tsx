import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { QuotaBanner } from './quota';
import { usePageVisibility, type PageKey } from './pageVisibility';
import AppSidebar from './components/Sidebar';
import { SidebarProvider, SidebarTrigger, SidebarInset } from '@/components/ui/sidebar';
import { BreadcrumbsProvider, Breadcrumbs } from './components/Breadcrumbs';
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
import GoalDetailPage from './pages/GoalDetail';
import FileIngestionPage from './pages/FileIngestion';
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
import Mail from './pages/Mail';
import MessageSound from './components/MessageSound';
import BrainLoading from './components/BrainLoading';

// Rotating loading captions (cycle every 8s).
const LOADING_MESSAGES = [
  'Ci sto lavorando...',
  '"Ti rimanderò indietro, indietro nel futuro"',
  '"Che la forza sia con te"',
  '"Ci sei Jarvis?..."',
  '"Knock Knock"',
  '"Segui il bianconiglio"',
  'Sto costruendo la tua infrastruttura...',
  'Resuscito il brain',
  'Collego i neuroni',
];

export default function App() {
  // Backend liveness probe — runs BEFORE auth so the app is blocked behind a
  // full-screen overlay when the backend is unreachable (even on the auth
  // page). Once /api/ping resolves, the rest of the app mounts as usual.
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  // ONE probe loop that never dies. The old version had two effects: the
  // boot loop exited on first success, and the mid-session watchdog unmounted
  // itself the moment backendUp flipped to false — so after a single hiccup
  // (laptop sleep, backend reload, proxy 503) NOBODY retried and the overlay
  // stayed forever until a manual page reload.
  // Rules: down → retry every 2s; up → heartbeat every 10s; 2 consecutive
  // failures required before declaring down (one blip ≠ outage); a tab
  // wake-up (visibilitychange) probes immediately.
  useEffect(() => {
    let cancelled = false;
    let timer: any;
    let failStreak = 0;
    async function probe() {
      if (cancelled) return;
      let ok = false;
      try {
        const r = await fetch('/api/ping', { credentials: 'include' });
        ok = r.ok;
      } catch { ok = false; }
      if (cancelled) return;
      if (ok) {
        failStreak = 0;
        setBackendUp(true);
        timer = setTimeout(probe, 10_000);
      } else {
        failStreak++;
        // First-ever probe (boot) shows overlay immediately; mid-session we
        // tolerate one blip before flipping.
        setBackendUp((prev) => (prev === null ? false : failStreak >= 2 ? false : prev));
        timer = setTimeout(probe, 2000);
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        // Tab woke up from background/sleep — don't wait for the next tick.
        if (timer) clearTimeout(timer);
        probe();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (backendUp !== true) {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background">
        <BrainLoading size={140} messages={LOADING_MESSAGES} />
      </div>
    );
  }

  return <AppInner />;
}

function AppInner() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<any>(null);
  const [backendDown, setBackendDown] = useState(false);

  async function refresh() {
    if (!user) return;
    try {
      const s = await api.status();
      setStatus(s);
      setBackendDown(false);
    } catch {
      setBackendDown(true);
    }
  }
  useEffect(() => { refresh(); }, [user]);
  // Retry every 2s while the backend is unreachable. Cleared as soon as a
  // successful /status response lands.
  useEffect(() => {
    if (!user) return;
    if (status && !backendDown) return;
    const id = setInterval(() => { refresh(); }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, status, backendDown]);

  if (loading) return <div className="h-full flex items-center justify-center"><BrainLoading size={140} /></div>;
  if (!user) return <AuthPage />;
  if (!status) return (
    <div className="h-full flex items-center justify-center">
      <BrainLoading size={140} label={backendDown ? 'Backend non raggiungibile — riprovo…' : 'Connessione al backend…'} />
    </div>
  );
  if (!status.onboarded) return <Onboarding status={status} onDone={refresh} />;

  return (
    <SidebarProvider>
      <BreadcrumbsProvider>
      <MessageSound />
      <AppSidebar />
      <SidebarInset>
        {/* Topbar: sidebar toggle + breadcrumbs + theme switcher */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 backdrop-blur px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
          <Breadcrumbs />
          <div className="flex-1" />
          <ThemeSwitcher />
        </header>
        <QuotaBanner />
        {/* Full-bleed routes (own layout, no parent padding so they can fill
            the viewport exactly — e.g. the mail client 3-pane). */}
        <Routes>
          <Route path="/mail" element={<div className="overflow-hidden h-[calc(100dvh-56px)] md:h-[calc(100dvh-72px)]"><Mail /></div>} />
          <Route path="*" element={
            <div className="p-4 sm:p-6 lg:p-8 min-w-0">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/connectors" element={<Connectors />} />
                <Route path="/brain" element={<Brain />} />
                <Route path="/roadmap" element={<Roadmap />} />
                <Route path="/goals/:id" element={<GoalDetailPage />} />
                <Route path="/ingestion" element={<FileIngestionPage />} />
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
          } />
        </Routes>
      </SidebarInset>
      </BreadcrumbsProvider>
    </SidebarProvider>
  );
}
