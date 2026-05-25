import { NavLink } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useAuth } from '../auth';
import { Button } from './ui';

type Props = {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapse: () => void;
  onCloseMobile: () => void;
};

export default function Sidebar({ collapsed, mobileOpen, onToggleCollapse, onCloseMobile }: Props) {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const items = [
    { to: '/', label: t('nav.live'), icon: '◉' },
    { to: '/connectors', label: t('nav.connectors'), icon: '⚙' },
    { to: '/brain', label: t('nav.brain'), icon: '✦' },
    { to: '/roadmap', label: t('nav.roadmap'), icon: '◆' },
    { to: '/tasks', label: 'Tasks', icon: '◷' },
    { to: '/agents', label: 'Agents', icon: '◈' },
    { to: '/logs', label: 'Logs', icon: '▤' },
    { to: '/settings', label: t('nav.settings'), icon: '⚒' },
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
          'glass border-r border-border flex flex-col gap-1 p-3 shrink-0',
          'fixed inset-y-0 left-0 z-40 w-64',
          'md:static md:translate-x-0 transition-transform duration-300 ease-out-expo',
          widthClass,
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        ].join(' ')}
      >
        <div className={`flex items-center gap-3 px-2 py-3 animate-fade-in ${collapsed ? 'md:justify-center' : ''}`}>
          <div className="relative shrink-0">
            <div className="absolute inset-0 rounded-2xl bg-accent/30 blur-xl animate-soft-pulse" />
            <img src="/rounded-image.png" alt="super-agent" className="relative w-11 h-11 rounded-2xl ring-1 ring-white/10 shadow-lg" />
          </div>
          <div className={collapsed ? 'md:hidden' : ''}>
            <div className="text-base font-semibold tracking-tight text-gradient">super-agent</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted">personal · brain</div>
          </div>
        </div>

        <nav className="flex flex-col gap-1 mt-2">
          {items.map((it, i) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
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
                  <span className={`text-base ${isActive ? 'text-accent2' : 'text-accent/70 group-hover:text-accent2'}`}>{it.icon}</span>
                  <span className={collapsed ? 'md:hidden' : ''}>{it.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto px-1 pt-4 border-t border-border/60 space-y-2">
          {!collapsed && <div className="text-xs text-muted truncate font-medium px-1">{user?.name || user?.email}</div>}
          <Button variant="ghost" size="sm" className={`w-full ${collapsed ? 'md:px-2' : ''}`} onClick={logout}>
            {collapsed ? '↩' : 'Logout'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:flex w-full"
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? '»' : '« Collapse'}
          </Button>
          <div className={`text-[10px] text-muted/70 text-center tracking-widest ${collapsed ? 'md:hidden' : ''}`}>v0.1.0</div>
        </div>
      </aside>
    </>
  );
}
