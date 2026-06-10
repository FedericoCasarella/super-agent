import { Link, useLocation } from 'react-router-dom';
import { useCallback, useState } from 'react';
import { useI18n } from '../i18n';
import { useAuth } from '../auth';
import { useBranding } from '../branding';
import { api } from '../api';
import { useLiveData } from '../ws';
import { usePageVisibility, type PageKey } from '../pageVisibility';
import {
  Sidebar as SbRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Activity, Plug, Brain, Map as MapIcon, ListChecks, Zap, Sparkles,
  Share2, ScrollText, Settings as SettingsIcon, LogOut, MessageCircle,
  Users as UsersIcon, Send, Bot, Network as NetworkIcon, Workflow,
  Camera as IgIcon, type LucideIcon, ChevronsUpDown, Archive,
} from 'lucide-react';

function humanizeIn(ms: number): string {
  if (ms <= 0) return 'a momenti';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `tra ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `tra ${h}h ${m ? `${m}m` : ''}`.trim();
}

export default function AppSidebar() {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const { branding } = useBranding();
  const [tasksRunning, setTasksRunning] = useState(0);
  const loadTasksRunning = useCallback(async () => {
    try { const r = await api.teamTasksRunningCount(); setTasksRunning(r.running); } catch {}
  }, []);
  useLiveData(loadTasksRunning, { refreshOn: ['team_task'], fallbackMs: 120_000 });

  // Claude session usage card data
  const [usage, setUsage] = useState<{ percent: number; resetIn: string | null; plan: string | null } | null>(null);
  const loadUsage = useCallback(async () => {
    try {
      const r: any = await api.usage();
      if (!r) return setUsage(null);
      const budget = r.plan?.costBudgetUsd ?? 0;
      const percent = budget > 0 ? Math.min(100, Math.round(((r.costUsd ?? 0) / budget) * 100)) : 0;
      const resetAt = r.resetAt ? new Date(r.resetAt) : null;
      const resetIn = resetAt ? humanizeIn(resetAt.getTime() - Date.now()) : null;
      setUsage({
        percent,
        resetIn,
        plan: r.plan?.name ?? null,
      });
    } catch {}
  }, []);
  useLiveData(loadUsage, { refreshOn: ['usage'], fallbackMs: 60_000 });

  const { isVisible } = usePageVisibility();
  const location = useLocation();
  type NavItem = { to: string; label: string; icon: LucideIcon; badge?: number; gate?: PageKey };
  const items: NavItem[] = ([
    { to: '/', label: t('nav.live'), icon: Activity },
    { to: '/connectors', label: t('nav.connectors'), icon: Plug },
    { to: '/brain', label: t('nav.brain'), icon: Brain },
    { to: '/roadmap', label: t('nav.roadmap'), icon: MapIcon },
    { to: '/tasks', label: 'Tasks', icon: ListChecks, badge: tasksRunning > 0 ? tasksRunning : undefined },
    { to: '/agents', label: 'Agents', icon: Zap },
    { to: '/perks', label: 'Perks', icon: Sparkles },
    { to: '/whatsapp', label: 'WhatsApp', icon: MessageCircle, gate: 'whatsapp' },
    { to: '/instagram', label: 'Instagram', icon: IgIcon, gate: 'instagram' },
    { to: '/people', label: 'People', icon: UsersIcon, gate: 'people' },
    { to: '/teams', label: 'Teams', icon: NetworkIcon, gate: 'teams' },
    { to: '/flows', label: 'Flows', icon: Workflow, gate: 'flows' },
    { to: '/outbound', label: 'Inviati', icon: Send, gate: 'outbound' },
    { to: '/logs', label: 'Logs', icon: ScrollText, gate: 'logs' },
    { to: '/snapshots', label: 'Snapshot', icon: Archive },
    { to: '/settings', label: t('nav.settings'), icon: SettingsIcon },
  ] as NavItem[]).filter((it) => !it.gate || isVisible(it.gate as PageKey));

  const initials = (user?.name || user?.email || 'U')
    .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

  return (
    <SbRoot variant="inset" collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div
            className="shadow shrink-0 overflow-hidden rounded-lg group-data-[collapsible=icon]:rounded-full"
            style={{ width: 36, height: 36, flex: '0 0 36px' }}
          >
            <img
              src={branding.logoDataUrl || '/rounded-image.png'}
              alt={branding.title}
              className="block w-full h-full object-cover"
              style={{ aspectRatio: '1 / 1' }}
            />
          </div>
          <div className="flex flex-col min-w-0 group-data-[collapsible=icon]:hidden">
            <span className="font-semibold text-sm tracking-tight truncate">{branding.title}</span>
            {branding.subtitle && (
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground truncate">
                {branding.subtitle}
              </span>
            )}
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigazione</SidebarGroupLabel>
          <SidebarMenu>
            {items.map((it) => {
              const Icon = it.icon;
              const isActive = it.to === '/' ? location.pathname === '/' : location.pathname.startsWith(it.to);
              return (
                <SidebarMenuItem key={it.to}>
                  <SidebarMenuButton asChild isActive={isActive} tooltip={it.label}>
                    <Link to={it.to}>
                      <Icon />
                      <span className="flex-1 text-left">{it.label}</span>
                      {it.badge != null && (
                        <span className="text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-[hsl(var(--success))]/20 text-[hsl(var(--success))]">
                          {it.badge}
                        </span>
                      )}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {usage && (
          <>
            {/* Expanded: full card with bar */}
            <Card className="group-data-[collapsible=icon]:hidden p-3 bg-sidebar-accent/40 border-sidebar-border">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
                <span>Claude • {usage.plan ?? 'Plan'}</span>
                <span className="font-mono">{usage.percent}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-primary transition-all duration-500"
                  style={{ width: `${usage.percent}%` }}
                />
              </div>
              {usage.resetIn && (
                <div className="mt-1.5 text-[10px] text-muted-foreground">Reset {usage.resetIn}</div>
              )}
            </Card>
            {/* Collapsed: gradient progress ring with % in center */}
            <div className="hidden group-data-[collapsible=icon]:flex items-center justify-center">
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="block focus:outline-none">
                      <UsageRing percent={usage.percent} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {usage.resetIn ? `Reset ${usage.resetIn}` : 'Nessuna scadenza nota'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </>
        )}

        {/* User popover — clicked-on avatar opens a panel with details + logout */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex items-center gap-2 rounded-md p-2 hover:bg-sidebar-accent transition-colors text-left group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-1">
              <Avatar className="h-8 w-8 rounded-full shrink-0">
                <AvatarImage src={(user as any)?.avatar_url ?? undefined} alt={user?.name || user?.email} />
                <AvatarFallback className="rounded-full text-xs flex items-center justify-center leading-none">{initials}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="text-sm font-medium truncate">{user?.name || 'User'}</div>
                <div className="text-[11px] text-muted-foreground truncate">{user?.email}</div>
              </div>
              <ChevronsUpDown className="ml-auto h-4 w-4 text-muted-foreground group-data-[collapsible=icon]:hidden" />
            </button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" sideOffset={8} className="w-60 p-0">
            <div className="p-3 flex items-center gap-2 border-b">
              <Avatar className="h-9 w-9 rounded-full shrink-0">
                <AvatarImage src={(user as any)?.avatar_url ?? undefined} alt={user?.name || user?.email} />
                <AvatarFallback className="rounded-full text-xs flex items-center justify-center leading-none">{initials}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{user?.name || 'User'}</div>
                <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
              </div>
            </div>
            <div className="p-1">
              <Link to="/settings" className="flex items-center gap-2 w-full px-3 py-1.5 rounded-sm text-sm hover:bg-accent/10">
                <SettingsIcon className="h-4 w-4" /> Impostazioni
              </Link>
              <Separator className="my-1" />
              <Button variant="ghost" size="sm" className="w-full justify-start text-destructive" onClick={logout}>
                <LogOut className="h-4 w-4" /> Esci
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </SidebarFooter>
      <SidebarRail />
    </SbRoot>
  );
}

// Gradient progress ring for the collapsed sidebar. SVG so it stays crisp at
// 32px. Uses an SVG <linearGradient> with the same stops as `bg-gradient-primary`
// so it visually matches the expanded bar.
function UsageRing({ percent }: { percent: number }) {
  const p = Math.max(0, Math.min(100, percent));
  const size = 34;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - p / 100);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
      <defs>
        <linearGradient id="usage-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="hsl(var(--primary))" />
          <stop offset="100%" stopColor="hsl(var(--accent))" />
        </linearGradient>
      </defs>
      {/* track */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} opacity={0.35} />
      {/* progress */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="url(#usage-ring-grad)"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 500ms ease' }}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fontSize="9"
        fontWeight={600}
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fill="hsl(var(--foreground))"
      >
        {p}%
      </text>
    </svg>
  );
}
