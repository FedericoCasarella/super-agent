import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Input, Textarea } from '../components/ui';
import BrandingEditor from '../components/BrandingEditor';

type Props = { status: any; onDone: () => void };

const steps = ['Branding', 'You', 'Business', 'Vault', 'Telegram'] as const;

export default function Onboarding({ status, onDone }: Props) {
  const [step, setStep] = useState(0);

  const [name, setName] = useState(status.profile?.name ?? '');
  const [role, setRole] = useState(status.profile?.role ?? '');
  const [tone, setTone] = useState(status.profile?.tone ?? 'short, direct, friendly');

  const [company, setCompany] = useState(status.business?.company ?? '');
  const [what, setWhat] = useState(status.business?.what ?? '');
  const [audience, setAudience] = useState(status.business?.audience ?? '');
  const [goals, setGoals] = useState(status.business?.goals ?? '');

  const [vaultPath, setVaultPath] = useState(status.vault ?? '');

  const [token, setToken] = useState('');
  const [tgMsg, setTgMsg] = useState('');
  const [tgChat, setTgChat] = useState<number | null>(status.telegram?.chatId ?? null);

  const pollRef = useRef<number | null>(null);
  function stopPolling() {
    if (pollRef.current != null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }
  useEffect(() => stopPolling, []); // cleanup on unmount

  async function next() {
    try {
      if (step === 0) { setStep(1); return; } // Branding step (saved via BrandingEditor own button)
      if (step === 1) { await api.setProfile({ name, role, tone }); setStep(2); return; }
      if (step === 2) { await api.setBusiness({ company, what, audience, goals }); setStep(3); return; }
      if (step === 3) { await api.setVault(vaultPath); setStep(4); return; }
      if (step === 4) {
        // If we already have a linked chat, finish immediately.
        if (tgChat) {
          stopPolling();
          // Re-fetch status one last time so App sees onboarded=true reliably
          try { await api.status(); } catch {}
          onDone();
          return;
        }
        // Otherwise save token and start polling.
        if (token) {
          const r = await api.setTelegram(token);
          setTgMsg(r.message);
          stopPolling();
          pollRef.current = window.setInterval(async () => {
            try {
              const s = await api.status();
              if (s.telegram?.chatId) {
                setTgChat(s.telegram.chatId);
                stopPolling();
              }
            } catch {}
          }, 2000);
          return;
        }
      }
    } catch (e: any) { alert(e.message); }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-2xl">
        {/* Step indicator — scrollable on mobile so it never wraps awkwardly */}
        <div className="mb-6 sm:mb-8 overflow-x-auto -mx-2 px-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-max">
            {steps.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div className={`h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs border ${i <= step ? 'bg-accent text-bg border-accent' : 'border-border text-muted-foreground'}`}>{i + 1}</div>
                <div className={`text-xs sm:text-sm whitespace-nowrap ${i === step ? 'text-text' : 'text-muted-foreground'}`}>{s}</div>
                {i < steps.length - 1 && <div className="w-6 sm:w-8 h-px bg-border" />}
              </div>
            ))}
          </div>
        </div>

        <Card>
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-lg sm:text-xl font-semibold">Personalizza l'app</h2>
              <p className="text-sm text-muted-foreground">Dai un nome e un logo alla tua istanza. Puoi cambiarli in qualsiasi momento dalle impostazioni.</p>
              <BrandingEditor />
            </div>
          )}
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-lg sm:text-xl font-semibold">Tell me about you</h2>
              <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Role"><Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Founder, dev, …" /></Field>
              <Field label="Preferred tone"><Input value={tone} onChange={(e) => setTone(e.target.value)} /></Field>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-lg sm:text-xl font-semibold">Your business</h2>
              <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} /></Field>
              <Field label="What you do"><Textarea value={what} onChange={(e) => setWhat(e.target.value)} /></Field>
              <Field label="Audience / clients"><Input value={audience} onChange={(e) => setAudience(e.target.value)} /></Field>
              <Field label="Current goals"><Textarea value={goals} onChange={(e) => setGoals(e.target.value)} /></Field>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-lg sm:text-xl font-semibold">Second-brain vault</h2>
              <p className="text-muted-foreground text-sm">Absolute path. Created if missing. Standard subfolders seeded (inbox, people, projects, daily, meta).</p>
              <Field label="Vault folder"><Input className="font-mono" value={vaultPath} onChange={(e) => setVaultPath(e.target.value)} placeholder="/Users/you/Documents/brain" /></Field>
            </div>
          )}
          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-lg sm:text-xl font-semibold">Link Telegram</h2>
              <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Open Telegram → <span className="text-text">@BotFather</span>.</li>
                <li>Send <span className="font-mono text-text">/newbot</span>, follow prompts.</li>
                <li>Paste token below.</li>
                <li>Open your bot → type <span className="font-mono text-text">/start</span> (or press Start) to link this chat.</li>
              </ol>
              <Field label="Bot token"><Input className="font-mono break-all" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC-…" /></Field>
              {tgMsg && <div className="text-sm text-accent">{tgMsg}</div>}
              {tgChat && <div className="text-sm text-ok">✓ Linked to chat {tgChat}</div>}
            </div>
          )}

          <div className="flex justify-between mt-8 gap-2">
            <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
            <Button onClick={next} disabled={step === 4 && !token && !tgChat}>
              {step === steps.length - 1 ? (tgChat ? 'Finish' : 'Save token') : 'Continue'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
