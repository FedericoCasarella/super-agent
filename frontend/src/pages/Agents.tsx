import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Toggle, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { usePerkCooldown } from '../hooks/usePerkCooldown';
import { useLiveData } from '../ws';
import DataTable from '../components/DataTable';

// Per-agent icon map. Drop new PNGs in `frontend/public/` and add here.
const AGENT_ICON: Record<string, string> = {
  brain_classifier: '/shield.png',
  link_weaver: '/brain-icon.png',
  people_analyzer: '/people-analyzer.png',
  vault_dreamer: '/garden.png',
  vault_librarian: '/axe.png',
  vault_gardener: '/dreamer.png',
};
const FALLBACK_ICON = '/rounded-image.png';

type Agent = {
  id: number;
  name: string;
  title: string;
  description: string;
  enabled: boolean;
  hour: number;
  minute: number;
  notify_on_run: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_report: any;
  running?: boolean;
};

function pad(n: number) { return n.toString().padStart(2, '0'); }

export default function Agents() {
  const [items, setItems] = useState<Agent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { left: cdLeft, start: cdStart, clear: cdClear } = usePerkCooldown(60);
  const toast = useToast();
  const nav = useNavigate();
  const { t } = useI18n();

  const load = useCallback(async () => { setItems(await api.internalAgents()); }, []);
  useLiveData(load, { refreshOn: ['internal_agent'], fallbackMs: 120_000 });
  // Ref to dodge stale-closure inside DataTable fetcher.
  const itemsRef = useRef<Agent[]>([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  async function toggle(a: Agent) {
    await api.updateInternalAgent(a.name, { enabled: !a.enabled });
    toast.push(`${a.title} ${!a.enabled ? 'enabled' : 'disabled'}`, !a.enabled ? 'on' : 'warn');
    load();
  }
  async function run(a: Agent, e: React.MouseEvent) {
    e.stopPropagation();
    if (a.running) {
      toast.push(`⏳ ${a.title} ancora in esecuzione`, 'warn');
      return;
    }
    const left = cdLeft(a.name);
    if (left > 0) {
      toast.push(`⏳ ${a.title} riattivabile tra ${left}s`, 'warn');
      return;
    }
    if (busy === a.name) return;
    setBusy(a.name);
    // Optimistic: start cooldown immediately so reload during long-running execution still locks UI
    cdStart(a.name);
    try {
      await api.runInternalAgent(a.name);
      toast.push(`${a.title} attivato`, 'on');
      await load();
    } catch (e: any) {
      toast.push(e.message, 'err');
      cdClear(a.name); // failed → release lock
    }
    finally { setBusy(null); }
  }

  const [view, setView] = useState<'grid' | 'table'>(() => (localStorage.getItem('perks_view') === 'table' ? 'table' : 'grid'));
  useEffect(() => { localStorage.setItem('perks_view', view); }, [view]);

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gradient">{t('agents.title')}</h1>
          <p className="text-sm text-muted mt-1">{t('agents.subtitle')}</p>
        </div>
        <div className="flex gap-1 bg-surface2/70 border border-border rounded-full p-1">
          <Button size="sm" variant={view === 'grid' ? 'primary' : 'ghost'} onClick={() => setView('grid')}>Card</Button>
          <Button size="sm" variant={view === 'table' ? 'primary' : 'ghost'} onClick={() => setView('table')}>Tabella</Button>
        </div>
      </div>

      {view === 'table' ? (
        <DataTable<Agent>
          fetcher={async ({ q, page, pageSize, filters }) => {
            // Client-side filter/paginate (perks list is small).
            let rows = itemsRef.current;
            if (q) {
              const t = q.toLowerCase();
              rows = rows.filter((a) => a.title.toLowerCase().includes(t) || a.name.toLowerCase().includes(t) || (a.description ?? '').toLowerCase().includes(t));
            }
            const state = filters.state ?? [];
            if (state.includes('on')) rows = rows.filter((a) => a.enabled);
            if (state.includes('off')) rows = rows.filter((a) => !a.enabled);
            if (state.includes('running')) rows = rows.filter((a) => a.running);
            if (state.includes('notify')) rows = rows.filter((a) => a.notify_on_run);
            const total = rows.length;
            return { rows: rows.slice(page * pageSize, (page + 1) * pageSize), total };
          }}
          columns={[
            { key: 'icon', header: '', width: 'w-12', render: (a) => <img src={AGENT_ICON[a.name] ?? FALLBACK_ICON} className="w-8 h-8 rounded-lg object-cover" /> },
            { key: 'title', header: 'Perk', render: (a) => (
              <div className="min-w-0">
                <div className="font-medium truncate">{a.title}</div>
                <div className="text-[11px] text-muted truncate max-w-[420px]">{a.description}</div>
              </div>
            )},
            { key: 'schedule', header: 'Orario', width: 'w-24', render: (a) => <span className="font-mono text-xs">{pad(a.hour)}:{pad(a.minute)}</span> },
            { key: 'enabled', header: 'Stato', width: 'w-24', render: (a) => a.enabled ? <Chip tone="on">on</Chip> : <Chip>off</Chip> },
            { key: 'last_run_at', header: 'Ultima esec.', width: 'w-44', render: (a) => a.last_run_at ? (
              <div className="text-xs">
                <div className="text-muted">{new Date(a.last_run_at).toLocaleString()}</div>
                <div className={a.last_status === 'ok' ? 'text-ok' : 'text-err'}>{a.last_status}</div>
              </div>
            ) : <span className="text-muted">—</span> },
            { key: 'actions', header: '', width: 'w-32', align: 'right', render: (a) => (
              <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1 justify-end">
                <Toggle checked={a.enabled} onChange={() => toggle(a)} />
                <Button size="sm" variant="ghost" onClick={(e) => run(a, e)} disabled={!!a.running || busy === a.name || cdLeft(a.name) > 0}>
                  {a.running ? '⏳' : cdLeft(a.name) > 0 ? `${cdLeft(a.name)}s` : 'Run'}
                </Button>
              </div>
            )},
          ]}
          chipFilters={[
            {
              key: 'state',
              label: 'Filtra',
              multi: true,
              options: [
                { value: 'on', label: 'attivi', tone: 'on' },
                { value: 'off', label: 'disattivi' },
                { value: 'running', label: 'in esec.', tone: 'accent' },
                { value: 'notify', label: 'notifica', tone: 'accent2' },
              ],
            },
          ]}
          searchPlaceholder="Cerca perk…"
          rowKey={(a) => a.id}
          onRowClick={(a) => nav(`/perks/${a.name}`)}
          emptyText={t('agents.noAgents')}
          refreshKey={items.length}
        />
      ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((a) => (
          <Card
            key={a.id}
            className="cursor-pointer hover:translate-y-[-2px] p-0 overflow-hidden group"
          >
            <div className="flex flex-col md:flex-row md:items-stretch md:min-h-[200px]">
              {/* Icon: banner top on mobile, full-height side on md+ */}
              <div
                className="relative shrink-0 overflow-hidden md:self-stretch md:w-44 h-40 md:h-auto"
                onClick={() => nav(`/perks/${a.name}`)}
              >
                <div className="absolute inset-0 bg-accent/25 blur-2xl animate-soft-pulse" />
                <img
                  src={AGENT_ICON[a.name] ?? FALLBACK_ICON}
                  alt={a.title}
                  className="relative h-full w-full object-cover transition-transform duration-500 ease-out-expo group-hover:scale-[1.04]"
                />
                {/* Theme gradient overlay for depth */}
                <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-bg/85 via-bg/20 to-transparent md:bg-gradient-to-r md:from-transparent md:via-transparent md:to-bg/40" />
                {/* Status dot top-right of image */}
                <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase tracking-wider backdrop-blur-md bg-bg/50 border border-white/10">
                  <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? 'bg-ok shadow-[0_0_8px_rgba(52,211,153,0.7)]' : 'bg-muted'}`} />
                  <span className={a.enabled ? 'text-ok' : 'text-muted'}>{a.enabled ? t('agents.on') : t('agents.off')}</span>
                </div>
              </div>

              {/* Content column */}
              <div className="flex-1 min-w-0 p-5 flex flex-col">
                <div onClick={() => nav(`/perks/${a.name}`)} className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg sm:text-xl font-semibold text-gradient">{a.title}</h3>
                    <p className="text-sm text-muted line-clamp-2 mt-1">{a.description}</p>
                  </div>
                  <div onClick={(e) => e.stopPropagation()} className="shrink-0">
                    <Toggle checked={a.enabled} onChange={() => toggle(a)} />
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 text-xs flex-wrap">
                  <span className="inline-flex items-center gap-1.5 font-mono px-2.5 py-1 rounded-full border border-border bg-surface2/60 whitespace-nowrap">
                    <span className="text-accent2">◷</span> {pad(a.hour)}:{pad(a.minute)} {t('agents.daily')}
                  </span>
                  {a.notify_on_run && <Chip tone="on">🔔 {t('agents.notify')}</Chip>}
                </div>
                {a.last_run_at && (
                  <div className="mt-2 text-xs text-muted truncate">
                    {t('agents.last')}: {new Date(a.last_run_at).toLocaleString()} · <span className={a.last_status === 'ok' ? 'text-ok' : 'text-err'}>{a.last_status}</span>
                  </div>
                )}
                <div className="mt-auto pt-4 flex gap-2 flex-wrap">
                  <Button variant="ghost" size="sm" onClick={() => nav(`/perks/${a.name}`)}>{t('agents.openDetail')}</Button>
                  <Button variant="ghost" size="sm" onClick={(e) => run(a, e)} disabled={!!a.running || busy === a.name || cdLeft(a.name) > 0}>
                    {a.running ? '⏳ In esecuzione…' : busy === a.name ? 'Attivando…' : cdLeft(a.name) > 0 ? `Riattivabile in ${cdLeft(a.name)}s` : 'Attiva il Perk'}
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        ))}
        {items.length === 0 && <Card><div className="text-muted text-sm">{t('agents.noAgents')}</div></Card>}
      </div>
      )}
    </div>
  );
}
