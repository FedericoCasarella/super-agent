import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Field, Input, Toggle, useToast } from '../components/ui';
import { useI18n } from '../i18n';

function pad(n: number) { return n.toString().padStart(2, '0'); }

const AGENT_ICON: Record<string, string> = {
  brain_classifier: '/shield.png',
  link_weaver: '/brain-icon.png',
};
const FALLBACK_ICON = '/rounded-image.png';

export default function AgentDetail() {
  const { name = '' } = useParams();
  const nav = useNavigate();
  const [agent, setAgent] = useState<any>(null);
  const [hour, setHour] = useState(0);
  const [minute, setMinute] = useState(0);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { t } = useI18n();

  async function load() {
    const all = await api.internalAgents();
    const a = all.find((x: any) => x.name === name);
    if (!a) { nav('/agents'); return; }
    setAgent(a); setHour(a.hour); setMinute(a.minute);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [name]);

  async function saveSchedule() {
    await api.updateInternalAgent(name, { hour, minute });
    toast.push(`Scheduled at ${pad(hour)}:${pad(minute)}`, 'on');
    load();
  }
  async function toggle() {
    await api.updateInternalAgent(name, { enabled: !agent.enabled });
    toast.push(`${agent.title} ${!agent.enabled ? 'enabled' : 'disabled'}`, !agent.enabled ? 'on' : 'warn');
    load();
  }
  async function toggleNotify() {
    const next = !agent.notify_on_run;
    await api.updateInternalAgent(name, { notify_on_run: next });
    toast.push(`Telegram notify ${next ? 'on' : 'off'}`, next ? 'on' : 'warn');
    load();
  }
  async function run() {
    setBusy(true);
    try {
      await api.runInternalAgent(name);
      toast.push(`${agent.title} run complete`, 'on');
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setBusy(false); }
  }

  if (!agent) return <div className="text-muted">{t('common.loading')}</div>;
  const r = agent.last_report ?? {};
  const stats: [string, any][] = [
    [t('agents.scanned'), r.scanned],
    [t('agents.classified'), r.classified],
    [`◆ ${t('agents.protected')}`, r.protected],
    [`◇ ${t('agents.public')}`, r.public],
    [t('agents.skipped'), r.skipped],
    [t('agents.errors'), r.errors],
    [t('agents.duration'), r.durationMs != null ? `${r.durationMs} ms` : null],
  ];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3 text-sm">
        <button onClick={() => nav('/agents')} className="text-muted hover:text-text transition">← {t('agents.title')}</button>
        <span className="text-muted">/</span>
        <span>{agent.title}</span>
      </div>

      <div className="flex items-stretch justify-between gap-5 flex-wrap min-h-[160px]">
        <div className="flex items-stretch gap-5 flex-1 min-w-0">
          <div className="relative shrink-0 self-stretch w-40 overflow-hidden rounded-3xl">
            <div className="absolute inset-0 bg-accent/30 blur-2xl animate-soft-pulse" />
            <img src={AGENT_ICON[name] ?? FALLBACK_ICON} alt={agent.title} className="relative h-full w-full rounded-3xl ring-1 ring-white/10 shadow-2xl object-cover" />
          </div>
          <div className="flex flex-col justify-center min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-semibold text-gradient">{agent.title}</h1>
              <Chip tone={agent.enabled ? 'on' : 'warn'}>{agent.enabled ? t('agents.on') : t('agents.off')}</Chip>
            </div>
            <p className="text-sm text-muted max-w-2xl">{agent.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Toggle checked={agent.enabled} onChange={toggle} />
          <Button onClick={run} disabled={busy}>{busy ? '…' : t('agents.runNow')}</Button>
        </div>
      </div>

      <Card>
        <h2 className="text-lg font-semibold mb-1">{t('agents.schedule')}</h2>
        <p className="text-sm text-muted mb-5">{t('agents.scheduleHint')}</p>
        <div className="flex items-center gap-4 flex-wrap">
          <Field label={t('agents.hour')}><Input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Math.max(0, Math.min(23, Number(e.target.value))))} className="font-mono text-center text-2xl w-24" /></Field>
          <span className="text-3xl text-muted mt-6">:</span>
          <Field label={t('agents.minute')}><Input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Math.max(0, Math.min(59, Number(e.target.value))))} className="font-mono text-center text-2xl w-24" /></Field>
          <div className="ml-auto self-end">
            <Button onClick={saveSchedule} disabled={hour === agent.hour && minute === agent.minute}>{t('agents.saveSchedule')}</Button>
          </div>
        </div>
        <div className="text-xs text-muted mt-4">{t('agents.nextFire')}: <span className="font-mono text-text">{pad(agent.hour)}:{pad(agent.minute)}</span> · {t('agents.daily')}</div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold mb-1">{t('agents.notifyTitle')}</h2>
            <p className="text-sm text-muted">{t('agents.notifyDesc')}</p>
          </div>
          <Toggle checked={!!agent.notify_on_run} onChange={toggleNotify} />
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">{t('agents.lastReport')}</h2>
          {agent.last_run_at && (
            <div className="text-xs text-muted">
              {new Date(agent.last_run_at).toLocaleString()} ·{' '}
              <span className={agent.last_status === 'ok' ? 'text-ok' : 'text-err'}>{agent.last_status}</span>
            </div>
          )}
        </div>
        {!agent.last_run_at && <div className="text-muted text-sm">{t('agents.neverRun')}</div>}
        {agent.last_run_at && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {stats.filter(([, v]) => v != null).map(([k, v]) => (
                <div key={k} className="border border-border rounded-2xl p-4 bg-surface2/40">
                  <div className="text-[10px] uppercase text-muted tracking-wider">{k}</div>
                  <div className="font-mono text-xl mt-1">{String(v)}</div>
                </div>
              ))}
            </div>
            {r.error && (
              <div className="mt-4 text-err text-xs font-mono whitespace-pre-wrap bg-err/10 border border-err/30 rounded-2xl p-3">{r.error}</div>
            )}
            {Array.isArray(r.details) && r.details.length > 0 && (
              <div className="mt-6">
                <h3 className="text-sm font-semibold mb-3">{t('agents.changes')} ({r.details.length})</h3>
                <div className="space-y-1 max-h-[50vh] overflow-y-auto pr-1">
                  {r.details.map((d: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-sm border border-border rounded-xl p-2.5 bg-surface2/30">
                      <span className="font-mono text-xs text-muted truncate flex-1">{d.path}</span>
                      <Chip>{d.from ?? '—'}</Chip>
                      <span className="text-muted">→</span>
                      <Chip tone={d.to === 'protected' ? 'err' : d.to === 'public' ? 'on' : 'default'}>{d.to}</Chip>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
