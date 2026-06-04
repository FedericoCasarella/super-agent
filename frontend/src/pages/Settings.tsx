import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Input, Textarea, Modal, Banner, Chip, Toggle, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { useI18n, Lang } from '../i18n';
import { useAuth } from '../auth';
import BrainLoading from '../components/BrainLoading';
import BrandingEditor from '../components/BrandingEditor';
import BrainColorsEditor from '../components/BrainColorsEditor';
import { usePageVisibility, PAGE_META, type PageKey } from '../pageVisibility';
import { LayoutGrid } from 'lucide-react';

export default function Settings() {
  const [s, setS] = useState<any>(null);
  const [vault, setVault] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [profile, setProfile] = useState<any>({});
  const [business, setBusiness] = useState<any>({});
  const [token, setToken] = useState('');

  async function load() {
    const data = await api.settings();
    setS(data);
    setVault(data.vault ?? '');
    setProfile(data.profile ?? {});
    setBusiness(data.business ?? {});
  }
  useEffect(() => { load(); }, []);

  const toast = useToast();
  const dlg = useDialog();
  const { t, lang, setLang } = useI18n();
  const { deleteAccount } = useAuth();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  // ---------- Vaults ----------
  const [vaults, setVaults] = useState<any[]>([]);
  const [newVaultName, setNewVaultName] = useState('');
  const [newVaultPath, setNewVaultPath] = useState('');
  const [newVaultSeed, setNewVaultSeed] = useState(true);
  const [newVaultPrimary, setNewVaultPrimary] = useState(false);
  async function loadVaults() { try { setVaults(await api.vaultsList()); } catch {} }
  useEffect(() => { loadVaults(); }, []);
  async function createVault() {
    try {
      await api.vaultsCreate({ name: newVaultName, path: newVaultPath, seed: newVaultSeed, makePrimary: newVaultPrimary });
      toast.push(t('settings.vaultCreated'), 'on');
      setNewVaultName(''); setNewVaultPath(''); setNewVaultSeed(true); setNewVaultPrimary(false);
      await loadVaults(); await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function setPrimaryVault(id: number) {
    try { await api.vaultsSetPrimary(id); toast.push(t('settings.vaultPrimarySet'), 'on'); await loadVaults(); await load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }
  async function removeVault(v: any) {
    if (!await dlg.confirm(t('settings.confirmRemoveVault').replace('{name}', v.name), { tone: 'danger', confirmLabel: 'Rimuovi' })) return;
    try { await api.vaultsDelete(v.id); toast.push(t('settings.vaultRemoved'), 'warn'); await loadVaults(); await load(); }
    catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function doDeleteAccount() {
    if (!deletePassword) return;
    setDeleting(true);
    try {
      await deleteAccount(deletePassword);
      toast.push(lang === 'it' ? 'Account eliminato' : 'Account deleted', 'on');
    } catch (e: any) {
      toast.push(e.message, 'err');
      setDeleting(false);
    }
  }

  async function changeVault() {
    try {
      await api.updateVault(vault);
      setConfirmOpen(false);
      toast.push('Vault path changed', 'on');
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  }

  async function saveProfile() { await api.updateProfile(profile); toast.push('Profile saved', 'on'); await load(); }
  async function saveBusiness() { await api.updateBusiness(business); toast.push('Business saved', 'on'); await load(); }
  async function saveToken() {
    if (!token) return;
    await api.updateTelegram(token);
    setToken('');
    toast.push('Telegram token updated', 'on');
    await load();
  }

  if (!s) return <BrainLoading size={120} label="Caricamento…" />;

  const vaultChanged = vault && vault !== s.vault;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>

      <PageVisibilityCard />

      <Card>
        <h2 className="text-lg font-semibold mb-1">Branding app</h2>
        <p className="text-sm text-muted mb-4">Personalizza nome e logo. Visibile in sidebar, login e tab del browser.</p>
        <BrandingEditor onSaved={() => toast.push('Branding salvato', 'on')} />
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-1">Colori cervello (neuroni)</h2>
        <p className="text-sm text-muted mb-4">Personalizza i colori dei nodi nel grafo 3D per visibilità e categoria. Color picker o hex.</p>
        <BrainColorsEditor onSaved={() => toast.push('Colori salvati', 'on')} />
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-1">{t('settings.language')}</h2>
        <p className="text-sm text-muted mb-4">{t('settings.languageDesc')}</p>
        <div className="flex gap-2">
          {(['it','en'] as Lang[]).map((l) => (
            <Button
              key={l}
              variant={lang === l ? 'primary' : 'ghost'}
              size="sm"
              onClick={async () => { await setLang(l); toast.push(l === 'it' ? 'Lingua: Italiano' : 'Language: English', 'on'); }}
            >
              {l === 'it' ? '🇮🇹 Italiano' : '🇬🇧 English'}
            </Button>
          ))}
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold mb-1">{lang === 'it' ? 'Suono notifica' : 'Notification sound'}</h2>
            <p className="text-sm text-muted">{lang === 'it' ? 'Suona un chime in browser quando arriva un messaggio Telegram.' : 'Play a chime in the browser when a Telegram message arrives.'}</p>
          </div>
          <Toggle
            checked={s.sound_on_message !== false}
            onChange={async (v) => {
              await api.updateSound(v);
              toast.push(v ? (lang === 'it' ? 'Suono attivo' : 'Sound on') : (lang === 'it' ? 'Suono spento' : 'Sound off'), v ? 'on' : 'warn');
              await load();
            }}
          />
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-1">{t('settings.vaults')}</h2>
        <p className="text-sm text-muted mb-4">{t('settings.vaultsDesc')}</p>
        {vaults.length > 0 && (
          <ul className="space-y-2 mb-4">
            {vaults.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-3 border border-border rounded-2xl p-3 bg-surface2/40">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{v.name}</span>
                    {v.is_primary && <Chip tone="on">{t('settings.vaultPrimary')}</Chip>}
                  </div>
                  <div className="text-xs text-muted font-mono truncate">{v.path}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {!v.is_primary && <Button size="sm" variant="ghost" onClick={() => setPrimaryVault(v.id)}>{t('settings.vaultSetPrimary')}</Button>}
                  <Button size="sm" variant="danger" onClick={() => removeVault(v)} disabled={vaults.length === 1}>{t('settings.vaultRemove')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('settings.vaultName')}><Input value={newVaultName} onChange={(e) => setNewVaultName(e.target.value)} placeholder="work / personal / …" /></Field>
            <Field label={t('settings.vaultNewPath')}><Input className="font-mono" value={newVaultPath} onChange={(e) => setNewVaultPath(e.target.value)} placeholder="/Users/you/brain-work" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={newVaultSeed} onChange={(e) => setNewVaultSeed(e.target.checked)} />
            {t('settings.vaultSeed')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={newVaultPrimary} onChange={(e) => setNewVaultPrimary(e.target.checked)} />
            {t('settings.vaultPrimary')}
          </label>
          <div className="flex justify-end">
            <Button onClick={createVault} disabled={!newVaultName || !newVaultPath}>{t('settings.vaultCreate')}</Button>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-1">{t('settings.vault')}</h2>
        <p className="text-sm text-muted mb-4">{t('settings.vaultDesc')}</p>
        <Field label={t('settings.vaultPath')}>
          <Input className="font-mono" value={vault} onChange={(e) => setVault(e.target.value)} />
        </Field>
        <div className="text-xs text-muted mt-2">Current: <span className="font-mono text-text">{s.vault ?? '(none)'}</span></div>
        <div className="mt-4 flex gap-2 justify-end">
          <Button variant="ghost" onClick={() => setVault(s.vault ?? '')} disabled={!vaultChanged}>{t('common.reset')}</Button>
          <Button variant="danger" onClick={() => setConfirmOpen(true)} disabled={!vaultChanged}>{t('settings.changeVault')}</Button>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('settings.you')}</h2>
        <div className="space-y-3">
          <Field label={t('settings.name')}><Input value={profile.name ?? ''} onChange={(e) => setProfile({ ...profile, name: e.target.value })} /></Field>
          <Field label={t('settings.role')}><Input value={profile.role ?? ''} onChange={(e) => setProfile({ ...profile, role: e.target.value })} /></Field>
          <Field label={t('settings.tone')}><Input value={profile.tone ?? ''} onChange={(e) => setProfile({ ...profile, tone: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={saveProfile}>{t('common.save')}</Button></div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('settings.business')}</h2>
        <div className="space-y-3">
          <Field label={t('settings.company')}><Input value={business.company ?? ''} onChange={(e) => setBusiness({ ...business, company: e.target.value })} /></Field>
          <Field label={t('settings.what')}><Textarea value={business.what ?? ''} onChange={(e) => setBusiness({ ...business, what: e.target.value })} /></Field>
          <Field label={t('settings.audience')}><Input value={business.audience ?? ''} onChange={(e) => setBusiness({ ...business, audience: e.target.value })} /></Field>
          <Field label={t('settings.goals')}><Textarea value={business.goals ?? ''} onChange={(e) => setBusiness({ ...business, goals: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end"><Button onClick={saveBusiness}>{t('common.save')}</Button></div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold mb-1">{t('settings.telegram')}</h2>
        <p className="text-sm text-muted mb-3">
          {s.telegram?.chatId ? <>Chat: <Chip tone="on">{s.telegram.chatId}</Chip></> : <Chip tone="warn">{t('settings.notLinked')}</Chip>}
        </p>
        <Field label={t('settings.replaceToken')}><Input className="font-mono" placeholder="123456:ABC-…" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end"><Button onClick={saveToken} disabled={!token}>{t('settings.updateToken')}</Button></div>
      </Card>

      <Card className="border-err/40">
        <h2 className="text-lg font-semibold mb-1 text-err">{lang === 'it' ? 'Zona pericolo' : 'Danger zone'}</h2>
        <p className="text-sm text-muted mb-4">
          {lang === 'it'
            ? 'Eliminare l\'account rimuove tutti i tuoi dati dal database (settings, messaggi, brain index, persone, agent runs, task, richieste network). I file del vault sul filesystem restano dove sono — eliminali manualmente se vuoi.'
            : 'Deleting your account wipes all your data from the database (settings, messages, brain index, people, agent runs, tasks, network requests). Vault files on disk stay where they are — remove them manually if you want.'}
        </p>
        <div className="flex justify-end">
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            {lang === 'it' ? 'Elimina account' : 'Delete account'}
          </Button>
        </div>
      </Card>

      <Modal
        open={deleteOpen}
        title={lang === 'it' ? 'Confermi eliminazione account?' : 'Confirm account deletion?'}
        onClose={() => { setDeleteOpen(false); setDeletePassword(''); }}
        footer={<>
          <Button variant="ghost" onClick={() => { setDeleteOpen(false); setDeletePassword(''); }}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={doDeleteAccount} disabled={!deletePassword || deleting}>
            {deleting ? '…' : (lang === 'it' ? 'Sì, elimina definitivamente' : 'Yes, delete permanently')}
          </Button>
        </>}
      >
        <Banner tone="err">
          {lang === 'it'
            ? 'Operazione irreversibile. Tutti i dati associati al tuo account verranno cancellati immediatamente. Verrai disconnesso.'
            : 'This is irreversible. All data tied to your account will be wiped immediately. You will be logged out.'}
        </Banner>
        <div className="mt-4">
          <Field label={lang === 'it' ? 'Conferma con la tua password' : 'Confirm with your password'}>
            <Input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" />
          </Field>
        </div>
      </Modal>

      <Modal
        open={confirmOpen}
        title={t('settings.confirmVaultTitle')}
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={changeVault}>{t('settings.confirmSwitch')}</Button>
          </>
        }
      >
        <Banner tone="warn">{t('settings.confirmVaultBody')}</Banner>
        <div className="mt-4 text-xs text-muted space-y-1 font-mono">
          <div>{t('settings.from')}: {s.vault ?? '(none)'}</div>
          <div>{t('settings.to')}: {vault}</div>
        </div>
      </Modal>
    </div>
  );
}

// =====================================================================
// Layout card — toggles per-page in the sidebar. Locally stored.
// =====================================================================
function PageVisibilityCard() {
  const { visible, toggle } = usePageVisibility();
  const keys = Object.keys(PAGE_META) as PageKey[];
  return (
    <Card>
      <div className="flex items-start gap-3 mb-3">
        <LayoutGrid size={20} className="text-accent shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-semibold">Layout sidebar</h2>
          <p className="text-sm text-muted mt-0.5">
            Mostra / nascondi pagine intere. Disabilitate sono inaccessibili anche tramite URL diretto. Default: minimo
            essenziale così la barra resta pulita.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {keys.map((k) => {
          const meta = PAGE_META[k];
          const on = !!visible[k];
          return (
            <div
              key={k}
              className={`flex items-start gap-3 p-3 rounded-xl border transition ${
                on ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface2/30'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{meta.label}</div>
                <div className="text-xs text-muted mt-0.5">{meta.description}</div>
              </div>
              <Toggle checked={on} onChange={() => toggle(k)} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}
