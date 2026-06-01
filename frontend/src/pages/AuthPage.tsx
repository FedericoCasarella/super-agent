import { useState } from 'react';
import { Button, Card, Field, Input, Banner, useToast } from '../components/ui';
import { useAuth } from '../auth';
import { useBranding } from '../branding';

export default function AuthPage() {
  const { login, register, usersExist } = useAuth();
  const { branding } = useBranding();
  const [mode, setMode] = useState<'login' | 'register'>(usersExist ? 'login' : 'register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [claim, setClaim] = useState(false);
  const toast = useToast();

  async function submit() {
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        toast.push('Logged in', 'on');
      } else {
        const r = await register(email, password, name || undefined);
        setClaim(!!r.claimedOrphans);
        toast.push(r.claimedOrphans ? 'Registered — claimed existing data' : 'Registered', 'on');
      }
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8 flex flex-col items-center gap-3 animate-slide-up">
          <div className="relative">
            <div className="absolute inset-0 rounded-3xl bg-accent/40 blur-2xl animate-soft-pulse" />
            <img src={branding.logoDataUrl || '/rounded-image.png'} alt={branding.title} className="relative w-20 h-20 rounded-3xl ring-1 ring-white/10 shadow-2xl object-cover" />
          </div>
          <div>
            <div className="text-3xl font-semibold text-gradient">{branding.title}</div>
            {branding.subtitle && <div className="text-xs uppercase tracking-[0.22em] text-muted mt-1">{branding.subtitle}</div>}
          </div>
        </div>
        <Card>
          <div className="flex gap-1 mb-5 bg-surface2 border border-border rounded-full p-1">
            <Button variant={mode === 'login' ? 'primary' : 'ghost'} size="sm" className="flex-1" onClick={() => setMode('login')}>Login</Button>
            <Button variant={mode === 'register' ? 'primary' : 'ghost'} size="sm" className="flex-1" onClick={() => setMode('register')}>Register</Button>
          </div>

          {!usersExist && mode === 'register' && (
            <div className="mb-4">
              <Banner tone="info">First user! Your account will claim any existing onboarding/vault/messages data.</Banner>
            </div>
          )}
          {claim && <div className="mb-4"><Banner tone="info">Existing data successfully claimed under your account.</Banner></div>}

          <div className="space-y-3">
            {mode === 'register' && (
              <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Federico" /></Field>
            )}
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
            <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          </div>
          <div className="mt-5">
            <Button className="w-full" onClick={submit} disabled={loading || !email || !password}>
              {loading ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
