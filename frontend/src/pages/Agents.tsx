import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Toggle, useToast } from '../components/ui';
import { useI18n } from '../i18n';

// Per-agent icon map. Drop new PNGs in `frontend/public/` and add here.
const AGENT_ICON: Record<string, string> = {
  brain_classifier: '/shield.png',
  link_weaver: '/brain-icon.png',
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
};

function pad(n: number) { return n.toString().padStart(2, '0'); }

export default function Agents() {
  const [items, setItems] = useState<Agent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  const { t } = useI18n();

  async function load() { setItems(await api.internalAgents()); }
  useEffect(() => { load(); }, []);

  async function toggle(a: Agent) {
    await api.updateInternalAgent(a.name, { enabled: !a.enabled });
    toast.push(`${a.title} ${!a.enabled ? 'enabled' : 'disabled'}`, !a.enabled ? 'on' : 'warn');
    load();
  }
  async function run(a: Agent, e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(a.name);
    try {
      await api.runInternalAgent(a.name);
      toast.push(`${a.title} run complete`, 'on');
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-gradient">{t('agents.title')}</h1>
        <p className="text-sm text-muted mt-1">{t('agents.subtitle')}</p>
      </div>

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
                onClick={() => nav(`/agents/${a.name}`)}
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
                <div onClick={() => nav(`/agents/${a.name}`)} className="flex items-start justify-between gap-3">
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
                  <Button variant="ghost" size="sm" onClick={() => nav(`/agents/${a.name}`)}>{t('agents.openDetail')}</Button>
                  <Button variant="ghost" size="sm" onClick={(e) => run(a, e)} disabled={busy === a.name}>{busy === a.name ? '…' : t('agents.runNow')}</Button>
                </div>
              </div>
            </div>
          </Card>
        ))}
        {items.length === 0 && <Card><div className="text-muted text-sm">{t('agents.noAgents')}</div></Card>}
      </div>
    </div>
  );
}
