import { useEffect, useState } from 'react';
import { api } from '../api';
import AccountsEditor from '../components/AccountsEditor';
import { Button, Card, Chip, Field, Input, Select, Toggle, useToast } from '../components/ui';
import { useI18n } from '../i18n';

export default function Connectors() {
  const [items, setItems] = useState<any[]>([]);
  const [externals, setExternals] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  // A connector is "configured" when every required field has a non-empty value.
  function isConfigured(c: any): boolean {
    const req = (c.manifest.configSchema as any[]).filter((f) => f.required);
    return req.every((f) => { const v = c.config?.[f.key]; return v != null && String(v).length > 0; });
  }
  // Disable Save while any required field in the current draft is still empty.
  function draftMissingRequired(c: any): boolean {
    return (c.manifest.configSchema as any[])
      .filter((f) => f.required)
      .some((f) => { const v = draft[f.key]; return v == null || String(v).length === 0; });
  }

  const toast = useToast();
  const { t } = useI18n();

  async function load() {
    const [conns, exts] = await Promise.all([api.connectors(), api.externalMcps().catch(() => [])]);
    setItems(conns); setExternals(exts);
  }
  useEffect(() => { load(); }, []);
  async function refreshExt() { setExternals(await api.externalMcps(true)); toast.push(t('connectors.toastRefreshed'), 'on'); }

  async function toggle(name: string, enabled: boolean) {
    await api.updateConnector(name, { enabled });
    toast.push((enabled ? t('connectors.toastEnabled') : t('connectors.toastDisabled')).replace('{name}', name), enabled ? 'on' : 'warn');
    load();
  }
  async function save(name: string) {
    await api.updateConnector(name, { config: draft });
    setEditing(null);
    toast.push(t('connectors.toastSaved').replace('{name}', name), 'on');
    load();
  }
  async function run(name: string) {
    await api.runConnector(name);
    toast.push(t('connectors.toastTickStarted').replace('{name}', name), 'info');
  }
  // Live test of the current draft config — honest feedback instead of a blind "saved".
  async function test(name: string) {
    toast.push(`Testing ${name}…`, 'info');
    try {
      const r = await api.testConnector(name, draft);
      if (r.ok) toast.push(r.detail || 'OK', 'on');
      else toast.push(`✗ ${r.error || 'failed'}`, 'err');
    } catch (e: any) {
      toast.push(`✗ ${String(e?.message ?? e)}`, 'err');
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-gradient">{t('connectors.title')}</h1>
      <p className="text-muted text-sm">{t('connectors.intro')} <code className="font-mono text-text">backend/src/connectors/builtin/</code> {t('connectors.intro2')}</p>
      <h2 className="text-sm uppercase text-muted tracking-wider mt-2">{t('connectors.native')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((c) => (
          <Card key={c.manifest.name}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold">{c.manifest.title}</h3>
                  {c.manifest.name === 'imap' ? (
                    <>
                      <Chip tone="accent2">imap</Chip>
                      <Chip tone="accent">smtp</Chip>
                    </>
                  ) : (
                    <Chip>{c.manifest.name}</Chip>
                  )}
                  {c.manifest.configSchema.length > 0 && (
                    isConfigured(c)
                      ? <Chip tone="on">✓ configured</Chip>
                      : <Chip tone="warn">⚠ needs config</Chip>
                  )}
                </div>
                <p className="text-sm text-muted mt-1">{c.manifest.description}</p>
                {c.manifest.schedule && <div className="text-xs text-muted mt-2">{t('connectors.schedule')}: <span className="font-mono">{c.manifest.schedule}</span></div>}
              </div>
              <Toggle checked={c.enabled} onChange={(v) => toggle(c.manifest.name, v)} label={`Abilita/disabilita ${c.manifest.title}`} />
            </div>

            {editing === c.manifest.name ? (
              <div className="mt-4 space-y-3">
                {c.manifest.configSchema.map((f: any) => (
                  <Field key={f.key} label={f.required ? `${f.label} *` : f.label}>
                    {f.type === 'accounts' ? (
                      <AccountsEditor value={draft[f.key] ?? []} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                    ) : f.type === 'select' ? (
                      <Select
                        value={draft[f.key] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      >
                        <option value="" disabled>{f.placeholder ?? '—'}</option>
                        {(f.options ?? []).map((opt: string) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </Select>
                    ) : f.type === 'password' ? (
                      <div className="relative">
                        <Input
                          type={reveal[f.key] ? 'text' : 'password'}
                          placeholder={f.placeholder}
                          value={draft[f.key] ?? ''}
                          onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                          className="pr-12"
                        />
                        <button
                          type="button"
                          onClick={() => setReveal({ ...reveal, [f.key]: !reveal[f.key] })}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text text-sm"
                          aria-label={reveal[f.key] ? 'Hide' : 'Reveal'}
                        >
                          {reveal[f.key] ? '🙈' : '👁'}
                        </button>
                      </div>
                    ) : f.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={!!draft[f.key]}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })}
                        className="w-4 h-4 rounded border-border bg-surface2 accent-accent"
                      />
                    ) : (
                      <Input
                        type={f.type === 'number' ? 'number' : 'text'}
                        placeholder={f.placeholder}
                        value={draft[f.key] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={() => setEditing(null)}>{t('connectors.cancel')}</Button>
                  {c.testable && (
                    <Button variant="ghost" disabled={draftMissingRequired(c)} onClick={() => test(c.manifest.name)}>Test</Button>
                  )}
                  <Button disabled={draftMissingRequired(c)} onClick={() => save(c.manifest.name)}>{t('connectors.save')}</Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex gap-2">
                {c.manifest.configSchema.length > 0 && (
                  <Button variant="ghost" onClick={() => { setEditing(c.manifest.name); setDraft(c.config ?? {}); }}>{t('connectors.configure')}</Button>
                )}
                <Button variant="ghost" onClick={() => run(c.manifest.name)}>{t('connectors.runNowBtn')}</Button>
              </div>
            )}
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between mt-8">
        <div>
          <h2 className="text-sm uppercase text-muted tracking-wider">{t('connectors.externalTitle')}</h2>
          <p className="text-xs text-muted">{t('connectors.externalDesc')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={refreshExt}>{t('connectors.refresh')}</Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {externals.length === 0 && <Card><div className="text-muted text-sm">{t('connectors.noneDetected')}</div></Card>}
        {externals.map((e) => (
          <Card key={e.serverName}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">{e.rawName}</div>
                <div className="text-xs text-muted font-mono truncate max-w-[26rem]">{e.url}</div>
              </div>
              <Chip tone={e.status === 'connected' ? 'on' : e.status === 'needs_auth' ? 'warn' : 'err'}>
                {e.status === 'connected' ? t('connectors.connected') : e.status === 'needs_auth' ? t('connectors.needsAuth') : t('connectors.error')}
              </Chip>
            </div>
            <div className="text-xs text-muted mt-2 font-mono">mcp__{e.serverName}__*</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
