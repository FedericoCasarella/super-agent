import { useEffect, useState } from 'react';
import { api } from '../api';
import AccountsEditor from '../components/AccountsEditor';
import { Button, Card, Chip, Field, Input, Modal, Toggle, useToast } from '../components/ui';
import { useI18n } from '../i18n';
import { useWS } from '../ws';
import ConnectorIcon from '../components/ConnectorIcon';

export default function Connectors() {
  const [items, setItems] = useState<any[]>([]);
  const [externals, setExternals] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [waOpen, setWaOpen] = useState(false);
  const [waState, setWaState] = useState<any>({ status: 'idle' });

  const toast = useToast();
  useWS((msg) => {
    if (msg.type === 'wa:qr') setWaState((s: any) => ({ ...s, status: 'qr', qr: msg.payload.qr }));
    if (msg.type === 'wa:connected') setWaState((s: any) => ({ ...s, status: 'connected', me: { jid: msg.payload.jid } }));
    if (msg.type === 'wa:closed') setWaState((s: any) => ({ ...s, status: 'idle', qr: undefined }));
  });
  async function loadWa() { try { setWaState(await api.waStatus()); } catch {} }
  async function startWa() {
    try { await api.waStart(); toast.push('Avvio WhatsApp…', 'on'); loadWa(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function logoutWa() {
    if (!confirm('Disconnettere WhatsApp? Sessione cancellata, dovrai riscansionare il QR.')) return;
    try { await api.waLogout(); toast.push('Disconnesso', 'warn'); loadWa(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  useEffect(() => {
    if (!waOpen) return;
    loadWa();
    const id = setInterval(loadWa, 1500);
    return () => clearInterval(id);
  }, [waOpen]);
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

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-gradient">{t('connectors.title')}</h1>
      <p className="text-muted text-sm">{t('connectors.intro')} <code className="font-mono text-text">backend/src/connectors/builtin/</code> {t('connectors.intro2')}</p>
      <h2 className="text-sm uppercase text-muted tracking-wider mt-2">{t('connectors.native')}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((c) => (
          <Card key={c.manifest.name}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <ConnectorIcon name={c.manifest.name} title={c.manifest.title} size={28} className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-semibold">{c.manifest.title}</h3>
                  {c.manifest.name === 'imap' ? (
                    <>
                      <Chip tone="accent2">imap</Chip>
                      <Chip tone="accent">smtp</Chip>
                    </>
                  ) : (
                    <Chip>{c.manifest.name}</Chip>
                  )}
                </div>
                <p className="text-sm text-muted mt-1">{c.manifest.description}</p>
                {c.manifest.schedule && <div className="text-xs text-muted mt-2">{t('connectors.schedule')}: <span className="font-mono">{c.manifest.schedule}</span></div>}
                </div>
              </div>
              <Toggle checked={c.enabled} onChange={(v) => toggle(c.manifest.name, v)} />
            </div>

            {editing === c.manifest.name ? (
              <div className="mt-4 space-y-3">
                {c.manifest.configSchema.map((f: any) => (
                  <Field key={f.key} label={f.label}>
                    {f.type === 'accounts' ? (
                      <AccountsEditor value={draft[f.key] ?? []} onChange={(v) => setDraft({ ...draft, [f.key]: v })} />
                    ) : f.type === 'boolean' ? (
                      <input
                        type="checkbox"
                        checked={!!draft[f.key]}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })}
                        className="w-4 h-4 rounded border-border bg-surface2 accent-accent"
                      />
                    ) : (
                      <Input
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        placeholder={f.placeholder}
                        value={draft[f.key] ?? ''}
                        onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" onClick={() => setEditing(null)}>{t('connectors.cancel')}</Button>
                  <Button onClick={() => save(c.manifest.name)}>{t('connectors.save')}</Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex gap-2">
                {c.manifest.configSchema.length > 0 && (
                  <Button variant="ghost" onClick={() => { setEditing(c.manifest.name); setDraft(c.config ?? {}); }}>{t('connectors.configure')}</Button>
                )}
                <Button variant="ghost" onClick={() => run(c.manifest.name)}>{t('connectors.runNowBtn')}</Button>
                {c.manifest.name === 'whatsapp' && (
                  <Button onClick={() => setWaOpen(true)}>📱 Apri WhatsApp</Button>
                )}
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
              <div className="flex items-center gap-3 min-w-0">
                <ConnectorIcon name={e.rawName} title={e.serverName} size={24} className="shrink-0" />
                <div className="min-w-0">
                  <div className="font-semibold">{e.rawName}</div>
                  <div className="text-xs text-muted font-mono truncate max-w-[26rem]">{e.url}</div>
                </div>
              </div>
              <Chip tone={e.status === 'connected' ? 'on' : e.status === 'needs_auth' ? 'warn' : 'err'}>
                {e.status === 'connected' ? t('connectors.connected') : e.status === 'needs_auth' ? t('connectors.needsAuth') : t('connectors.error')}
              </Chip>
            </div>
            <div className="text-xs text-muted mt-2 font-mono">mcp__{e.serverName}__*</div>
          </Card>
        ))}
      </div>

      <Modal open={waOpen} onClose={() => setWaOpen(false)} title="WhatsApp">
        <div className="text-center space-y-4">
          {waState.status === 'idle' && (
            <>
              <p className="text-muted text-sm">Avvia la sessione per ricevere messaggi WhatsApp. Verrà mostrato un QR code da scansionare con il tuo telefono.</p>
              <Button onClick={startWa}>Avvia sessione</Button>
            </>
          )}
          {waState.status === 'starting' && !waState.qr && (
            <>
              <p className="text-muted text-sm">Avvio in corso… in attesa del QR (15-30s).</p>
              <Button variant="ghost" onClick={startWa}>Forza ricarica</Button>
            </>
          )}
          {waState.qr && waState.status !== 'connected' && (
            <>
              <p className="text-sm">Apri WhatsApp → ⚙ Impostazioni → Dispositivi collegati → Collega un dispositivo. Scansiona:</p>
              <img src={waState.qr} alt="QR" className="mx-auto rounded-2xl border border-border bg-white p-2" />
              <p className="text-xs text-muted">QR aggiornato live. Se scade, attendi: ne arriva uno nuovo automaticamente.</p>
              <Button variant="ghost" size="sm" onClick={startWa}>Rigenera QR</Button>
            </>
          )}
          {waState.status === 'connected' && (
            <>
              <Chip tone="on">✅ Connesso</Chip>
              {waState.me && <p className="text-xs text-muted font-mono">{waState.me.jid}</p>}
              <p className="text-sm text-muted">Ricevi messaggi automaticamente. Li trovi nel brain in <code className="font-mono text-accent2">inbox/whatsapp/&lt;persona&gt;/</code> e nello stream live.</p>
              <Button variant="danger" onClick={logoutWa}>Disconnetti / resetta sessione</Button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
