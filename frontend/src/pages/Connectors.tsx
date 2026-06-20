import { useEffect, useState } from 'react';
import { api } from '../api';
import AccountsEditor from '../components/AccountsEditor';
import { Button, Card, Chip, Field, Input, Modal, Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useI18n } from '../i18n';
import { useWS } from '../ws';
import ConnectorIcon from '../components/ConnectorIcon';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal, Settings as SettingsIcon, Play, Smartphone, Volume2, RefreshCw, Link as LinkIcon, Cpu } from 'lucide-react';

export default function Connectors() {
  const [items, setItems] = useState<any[]>([]);
  const [externals, setExternals] = useState<any[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [waOpen, setWaOpen] = useState(false);
  const [waState, setWaState] = useState<any>({ status: 'idle' });

  const toast = useToast();
  const dlg = useDialog();
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
    if (!await dlg.confirm('Disconnettere WhatsApp? Sessione cancellata, dovrai riscansionare il QR.', { tone: 'danger', confirmLabel: 'Disconnetti' })) return;
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
  // Feedback dopo il redirect OAuth Spotify (?spotify=connected|error&msg=...).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get('spotify');
    if (!s) return;
    if (s === 'connected') toast.push('Spotify collegato ✓', 'on');
    else toast.push('Spotify: ' + (p.get('msg') || 'errore collegamento'), 'err');
    window.history.replaceState({}, '', '/connectors');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function refreshExt() { setExternals(await api.externalMcps(true)); toast.push(t('connectors.toastRefreshed'), 'on'); }

  // Salva la config e avvia il flow OAuth Spotify in una nuova scheda.
  async function connectSpotify(name: string) {
    try {
      await api.updateConnector(name, { config: draft });
      const { url } = await api.spotifyAuth();
      window.location.href = url;
    } catch (e: any) {
      toast.push(String(e?.message ?? e), 'err');
    }
  }

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
  async function testTts() {
    try {
      const r: any = await api.ttsTest();
      if (r?.ok) {
        if (r.fallback) toast.push(`Audio fallback testo (${r.error ?? 'TTS failed'})`, 'warn');
        else toast.push(`✓ Audio inviato (${r.bytes ?? 0}B ${r.ext ?? ''})`, 'on');
      } else {
        toast.push(`Errore TTS: ${r?.error ?? 'unknown'} — ${r?.hint ?? ''}`, 'err');
      }
    } catch (e: any) { toast.push(`Errore: ${e?.message ?? e}`, 'err'); }
  }

  return (
    <div className="space-y-5">
      {/* SVG defs consumed by `.connector-icon-grad svg path` so every
          ConnectorIcon paints with the violet → blue brand gradient. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <linearGradient id="connector-icon-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(var(--accent-2))" />
          </linearGradient>
        </defs>
      </svg>
      <h1 className="text-2xl font-semibold text-gradient">{t('connectors.title')}</h1>

      {/* === NATIVE === */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Cpu size={14} className="text-accent" />
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Nativi · super-agent</h2>
          <span className="text-[10px] text-muted-foreground/60">({items.length})</span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {items.map((c) => {
            const isOpen = editing === c.manifest.name;
            return (
              <Card key={c.manifest.name} className="p-3">
                <div className="flex items-center gap-5">
                  <ConnectorIcon name={c.manifest.name} title={c.manifest.title} size={18} className="shrink-0 connector-icon-grad" />
                  <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-semibold truncate">{c.manifest.title}</h3>
                    {c.manifest.name === 'imap' ? (
                      <>
                        <Chip tone="accent2">imap</Chip>
                        <Chip tone="accent">smtp</Chip>
                      </>
                    ) : (
                      <Chip>{c.manifest.name}</Chip>
                    )}
                    {c.manifest.schedule && (
                      <span className="text-[10px] text-muted-foreground font-mono ml-2">cron: {c.manifest.schedule}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Toggle checked={c.enabled} onChange={(v) => toggle(c.manifest.name, v)} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-surface2 text-muted-foreground hover:text-foreground transition" aria-label="Azioni">
                          <MoreHorizontal size={16} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel>{c.manifest.title}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {c.manifest.configSchema.length > 0 && (
                          <DropdownMenuItem onSelect={() => { setEditing(isOpen ? null : c.manifest.name); setDraft(c.config ?? {}); }}>
                            <SettingsIcon size={14} /> {isOpen ? 'Chiudi configurazione' : 'Configura'}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => run(c.manifest.name)}>
                          <Play size={14} /> Esegui ora
                        </DropdownMenuItem>
                        {c.manifest.name === 'whatsapp' && (
                          <DropdownMenuItem onSelect={() => setWaOpen(true)}>
                            <Smartphone size={14} /> Apri WhatsApp
                          </DropdownMenuItem>
                        )}
                        {c.manifest.name === 'tts' && (
                          <DropdownMenuItem onSelect={() => testTts()}>
                            <Volume2 size={14} /> Invia audio di prova
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {isOpen && (
                  <div className="mt-4 pt-4 border-t border-border/60 space-y-3">
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
                    {c.manifest.name === 'spotify' && (
                      <div className="rounded-lg border border-border/60 bg-surface2/40 p-3 text-xs text-muted-foreground space-y-2">
                        <div>1. Crea un'app su <span className="font-mono">developer.spotify.com/dashboard</span>, imposta come Redirect URI: <span className="font-mono break-all text-foreground">http://127.0.0.1:8787/api/connectors/spotify/callback</span></div>
                        <div>2. Salva Client ID/Secret qui sotto, poi collega l'account. Serve Spotify Premium + app aperta sul PC.</div>
                        <div className="flex items-center gap-2 pt-1">
                          <Button variant="primary" onClick={() => connectSpotify(c.manifest.name)}>Collega account Spotify</Button>
                          {c.state?.connectedAt && <Chip tone="on">collegato</Chip>}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" onClick={() => setEditing(null)}>{t('connectors.cancel')}</Button>
                      <Button onClick={() => save(c.manifest.name)}>{t('connectors.save')}</Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* === EXTERNAL === */}
      <div className="border-t border-border/40 pt-5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <LinkIcon size={14} className="text-accent2" />
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Esterni · MCP Claude Code</h2>
            <span className="text-[10px] text-muted-foreground/60">({externals.length})</span>
          </div>
          <button onClick={refreshExt} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md hover:bg-surface2 text-muted-foreground transition">
            <RefreshCw size={12} /> {t('connectors.refresh')}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {externals.length === 0 && (
            <Card className="p-3"><div className="text-muted-foreground text-sm">{t('connectors.noneDetected')}</div></Card>
          )}
          {externals.map((e) => (
            <Card key={e.serverName} className="p-3">
              <div className="flex items-center gap-5">
                <ConnectorIcon name={e.rawName} title={e.serverName} size={18} className="shrink-0 connector-icon-grad" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{e.rawName}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">mcp__{e.serverName}__*</div>
                </div>
                <Chip tone={e.status === 'connected' ? 'on' : e.status === 'needs_auth' ? 'warn' : 'err'}>
                  {e.status === 'connected' ? t('connectors.connected') : e.status === 'needs_auth' ? t('connectors.needsAuth') : t('connectors.error')}
                </Chip>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Modal open={waOpen} onClose={() => setWaOpen(false)} title="WhatsApp">
        <div className="text-center space-y-4">
          {waState.status === 'idle' && (
            <>
              <p className="text-muted-foreground text-sm">Avvia la sessione per ricevere messaggi WhatsApp. Verrà mostrato un QR code da scansionare con il tuo telefono.</p>
              <Button onClick={startWa}>Avvia sessione</Button>
            </>
          )}
          {waState.status === 'starting' && !waState.qr && (
            <>
              <p className="text-muted-foreground text-sm">Avvio in corso… in attesa del QR (15-30s).</p>
              <Button variant="ghost" onClick={startWa}>Forza ricarica</Button>
            </>
          )}
          {waState.qr && waState.status !== 'connected' && (
            <>
              <p className="text-sm">Apri WhatsApp → ⚙ Impostazioni → Dispositivi collegati → Collega un dispositivo. Scansiona:</p>
              <img src={waState.qr} alt="QR" className="mx-auto rounded-2xl border border-border bg-white p-2" />
              <p className="text-xs text-muted-foreground">QR aggiornato live. Se scade, attendi: ne arriva uno nuovo automaticamente.</p>
              <Button variant="ghost" size="sm" onClick={startWa}>Rigenera QR</Button>
            </>
          )}
          {waState.status === 'connected' && (
            <>
              <Chip tone="on">✅ Connesso</Chip>
              {waState.me && <p className="text-xs text-muted-foreground font-mono">{waState.me.jid}</p>}
              <p className="text-sm text-muted-foreground">Ricevi messaggi automaticamente. Li trovi nel brain in <code className="font-mono text-accent2">inbox/whatsapp/&lt;persona&gt;/</code> e nello stream live.</p>
              <Button variant="danger" onClick={logoutWa}>Disconnetti / resetta sessione</Button>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}
