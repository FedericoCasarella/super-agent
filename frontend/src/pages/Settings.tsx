import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Input, Textarea, Modal, Banner, Chip, Toggle, useToast } from '../components/ui';
import { useI18n, Lang } from '../i18n';

export default function Settings() {
  const [s, setS] = useState<any>(null);
  const [vault, setVault] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [profile, setProfile] = useState<any>({});
  const [business, setBusiness] = useState<any>({});
  const [token, setToken] = useState('');
  const [linkCode, setLinkCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [linkSecondsLeft, setLinkSecondsLeft] = useState<number>(0);
  const [unlinkConfirmOpen, setUnlinkConfirmOpen] = useState(false);

  async function load() {
    const data = await api.settings();
    setS(data);
    setVault(data.vault ?? '');
    setProfile(data.profile ?? {});
    setBusiness(data.business ?? {});
  }
  useEffect(() => { load(); }, []);

  const toast = useToast();
  const { t, lang, setLang } = useI18n();

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

  // H3 (sess.2818) — generate a one-time link code and start countdown.
  async function generateLinkCode() {
    try {
      const res = await api.telegramLinkCode();
      setLinkCode({ code: res.code, expires_at: res.expires_at });
      toast.push('Link code generated', 'on');
    } catch (e: any) {
      toast.push(e.message ?? 'failed', 'err');
    }
  }

  async function unlinkChat() {
    try {
      await api.telegramUnlink();
      setUnlinkConfirmOpen(false);
      setLinkCode(null);
      toast.push('Chat unlinked', 'warn');
      await load();
    } catch (e: any) {
      toast.push(e.message ?? 'failed', 'err');
    }
  }

  // Countdown ticker — runs only when a link code is active.
  useEffect(() => {
    if (!linkCode) { setLinkSecondsLeft(0); return; }
    const tick = () => {
      const ms = new Date(linkCode.expires_at).getTime() - Date.now();
      const secs = Math.max(0, Math.floor(ms / 1000));
      setLinkSecondsLeft(secs);
      if (secs === 0) setLinkCode(null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [linkCode]);

  if (!s) return <div className="text-muted">loading…</div>;

  const vaultChanged = vault && vault !== s.vault;

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-semibold">{t('settings.title')}</h1>

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

        {/* H3 (sess.2818) — chatId binding via one-time code. */}
        {!s.telegram?.chatId && s.telegram?.hasToken && (
          <div className="mb-4 p-3 rounded border border-border bg-surface-2">
            <div className="text-sm font-medium mb-1">{lang === 'it' ? 'Collega questa chat al bot' : 'Link this chat to the bot'}</div>
            <p className="text-xs text-muted mb-3">
              {lang === 'it'
                ? 'Genera un codice e invialo al bot Telegram come "/link CODICE" entro 10 minuti per autorizzare la chat.'
                : 'Generate a code and send it to your Telegram bot as "/link CODE" within 10 minutes to authorize the chat.'}
            </p>
            {!linkCode ? (
              <Button onClick={generateLinkCode}>{lang === 'it' ? 'Genera codice' : 'Generate code'}</Button>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <code className="text-2xl font-mono px-3 py-1 rounded bg-bg-2 tracking-widest">{linkCode.code}</code>
                  <Chip tone={linkSecondsLeft > 60 ? 'on' : 'warn'}>
                    {Math.floor(linkSecondsLeft / 60)}:{String(linkSecondsLeft % 60).padStart(2, '0')}
                  </Chip>
                </div>
                <div className="text-xs text-muted font-mono">{lang === 'it' ? 'Manda al bot' : 'Send to bot'}: /link {linkCode.code}</div>
                <Button variant="ghost" size="sm" onClick={generateLinkCode}>{lang === 'it' ? 'Rigenera' : 'Regenerate'}</Button>
              </div>
            )}
          </div>
        )}

        {/* Existing chat binding — offer unlink. */}
        {s.telegram?.chatId && (
          <div className="mb-4 flex items-center justify-between gap-3 p-3 rounded border border-border bg-surface-2">
            <div className="text-sm text-muted">
              {lang === 'it' ? 'Per cambiare chat o se sospetti compromissione del bot, scollega e ricollega.' : 'To change chat or if you suspect bot token leak, unlink and re-link.'}
            </div>
            <Button variant="danger" size="sm" onClick={() => setUnlinkConfirmOpen(true)}>{lang === 'it' ? 'Scollega chat' : 'Unlink chat'}</Button>
          </div>
        )}

        <Field label={t('settings.replaceToken')}><Input className="font-mono" placeholder="123456:ABC-…" value={token} onChange={(e) => setToken(e.target.value)} /></Field>
        <div className="mt-4 flex justify-end"><Button onClick={saveToken} disabled={!token}>{t('settings.updateToken')}</Button></div>
      </Card>

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

      <Modal
        open={unlinkConfirmOpen}
        title={lang === 'it' ? 'Scollega chat Telegram' : 'Unlink Telegram chat'}
        onClose={() => setUnlinkConfirmOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUnlinkConfirmOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={unlinkChat}>{lang === 'it' ? 'Scollega' : 'Unlink'}</Button>
          </>
        }
      >
        <Banner tone="warn">
          {lang === 'it'
            ? 'Il bot non risponderà più alla chat attuale. Dovrai generare un nuovo codice e ricollegare via "/link CODICE".'
            : 'The bot will stop responding to the current chat. You will need to generate a new code and re-link via "/link CODE".'}
        </Banner>
      </Modal>
    </div>
  );
}
