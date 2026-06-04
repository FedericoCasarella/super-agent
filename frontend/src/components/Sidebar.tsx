import { NavLink } from 'react-router-dom';
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { useAuth } from '../auth';
import { Button } from './ui';
import UsageGauge from './UsageGauge';
import ActiveAgentsBadge from './ActiveAgentsBadge';
import { useBranding } from '../branding';
import { api } from '../api';
import { useLiveData } from '../ws';
import {
  Activity, Plug, Brain, Map as MapIcon, ListChecks, Zap, Sparkles,
  Share2, ScrollText, Settings as SettingsIcon, LogOut, ChevronsLeft, ChevronsRight, MessageCircle, Users as UsersIcon, Send, Bot, Network as NetworkIcon, Workflow, Camera as IgIcon,
  type LucideIcon,
} from 'lucide-react';

type Props = {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
};

export default function Sidebar({ collapsed, mobileOpen, onToggleCollapse, onCloseMobile }: Props) {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  // Tasks running counter — WS-driven via team_task events, long fallback safety.
  const [tasksRunning, setTasksRunning] = useState(0);
  const loadTasksRunning = useCallback(async () => {
    try { const r = await api.teamTasksRunningCount(); setTasksRunning(r.running); } catch {}
  }, []);
  useLiveData(loadTasksRunning, { refreshOn: ['team_task'], fallbackMs: 120_000 });

  const items: { to: string; label: string; icon: LucideIcon; badge?: number }[] = [
    { to: '/', label: t('nav.live'), icon: Activity },
    { to: '/connectors', label: t('nav.connectors'), icon: Plug },
    { to: '/brain', label: t('nav.brain'), icon: Brain },
    { to: '/roadmap', label: t('nav.roadmap'), icon: MapIcon },
    { to: '/tasks', label: 'Tasks', icon: ListChecks, badge: tasksRunning > 0 ? tasksRunning : undefined },
    { to: '/agents', label: 'Agents', icon: Zap },
    { to: '/perks', label: 'Perks', icon: Sparkles },
    { to: '/whatsapp', label: 'WhatsApp', icon: MessageCircle },
    { to: '/instagram', label: 'Instagram', icon: IgIcon },
    { to: '/people', label: 'People', icon: UsersIcon },
    // { to: '/network', label: 'Network', icon: Share2 }, // hidden: needs server infra
    { to: '/teams', label: 'Teams', icon: NetworkIcon },
    { to: '/flows', label: 'Flows', icon: Workflow },
    { to: '/outbound', label: 'Inviati', icon: Send },
    { to: '/logs', label: 'Logs', icon: ScrollText },
    { to: '/settings', label: t('nav.settings'), icon: SettingsIcon },
  ];
  const widthClass = collapsed ? 'md:w-[72px]' : 'md:w-64';

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-bg/60 backdrop-blur-sm md:hidden animate-fade-in" onClick={onCloseMobile} />
      )}

      <aside
        className={[
          'glass border-r border-border flex flex-col gap-1 p-3 shrink-0 overflow-hidden',
          'fixed inset-y-0 left-0 z-40 w-64',
          'md:static md:h-screen md:translate-x-0 transition-transform duration-300 ease-out-expo',
          widthClass,
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
      >
        <div className={`flex items-center gap-3 px-2 py-3 animate-fade-in ${collapsed ? 'md:justify-center' : ''}`}>
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-2xl bg-accent/30 blur-xl animate-soft-pulse" />
            <img src={branding.logoDataUrl || '/rounded-image.png'} alt={branding.title} className="relative w-11 h-11 rounded-2xl ring-1 ring-white/10 shadow-lg object-cover" />
          </div>
          <div className={collapsed ? 'md:hidden' : ''}>
            <div className="text-base font-semibold tracking-tight text-gradient truncate">{branding.title}</div>
            {branding.subtitle && <div className="text-[10px] uppercase tracking-[0.18em] text-muted truncate">{branding.subtitle}</div>}
          </div>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-1 mt-2 pr-1 sidebar-scroll">
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <NavLink
                key={it.to}
                to={it.to}
                end
                onClick={onCloseMobile}
                title={collapsed ? it.label : undefined}
                style={{ animationDelay: `${i * 30}ms` }}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm transition-all duration-200 ease-out-expo animate-slide-up ${
                    collapsed ? 'md:justify-center md:px-0' : ''
                  } ${
                    isActive
                      ? 'bg-gradient-to-r from-accent/15 to-accent2/10 text-text border border-accent/30 shadow-[0_0_22px_-8px_rgba(192,132,252,0.6)]'
                      : 'text-muted hover:text-text hover:bg-surface2/60 hover:translate-x-0.5'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[3px] rounded-r-full bg-gradient-to-b from-accent to-accent2" />}
                    <Icon size={18} className={isActive ? 'text-accent2' : 'text-accent/70 group-hover:text-accent2'} />
                    <span className={`flex-1 ${collapsed ? 'md:hidden' : ''}`}>{it.label}</span>
                    {it.badge != null && (
                      <span className={`text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 animate-pulse ${collapsed ? 'md:hidden' : ''}`}>{it.badge}</span>
                    )}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="shrink-0 px-1 pt-4 border-t border-border/60 space-y-2">
          <ActiveAgentsBadge collapsed={collapsed} />
          <UsageGauge collapsed={collapsed} />
          {!collapsed && <div className="text-xs text-muted truncate font-medium px-1">{user?.name || user?.email}</div>}
          <Button variant="ghost" size="sm" className={`w-full ${collapsed ? 'md:px-2' : ''}`} onClick={logout}>
            {collapsed ? <LogOut size={16} /> : (<><LogOut size={14} className="inline mr-1.5 -mt-0.5" />{t('nav.logout')}</>)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:flex w-full"
            onClick={onToggleCollapse}
            title={collapsed ? t('nav.expand') : t('nav.collapseTip')}
          >
            {collapsed ? <ChevronsRight size={16} /> : (<><ChevronsLeft size={14} className="inline mr-1.5 -mt-0.5" />{t('nav.collapse')}</>)}
          </Button>
          <div className={`text-[10px] text-muted/70 text-center tracking-widest ${collapsed ? 'md:hidden' : ''}`}>v0.1.0</div>
        </div>
      </aside>
    </>
  );
}
