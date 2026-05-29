import { useState } from 'react';
import { Button, Card, Field, Input, Banner, useToast } from '../components/ui';
import { useAuth } from '../auth';

export default function AuthPage() {
  const { login, initialize, usersExist } = useAuth();
  const isFirstSetup = !usersExist;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  async function submit() {
    setLoading(true);
    try {
      if (isFirstSetup) {
        await initialize(email, password, name || undefined);
        toast.push('Polpo Brain initialized — welcome', 'on');
      } else {
        await login(email, password);
        toast.push('Signed in', 'on');
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
            <div aria-label="Polpo Brain" className="relative w-20 h-20 rounded-3xl ring-1 ring-white/10 shadow-2xl overflow-hidden bg-gradient-to-br from-accent/20 to-accent2/20">
              <img src="/polpo_brain_avatar.png" alt="Polpo Brain" className="w-full h-full object-cover" />
            </div>
          </div>
          <div>
            <div className="text-3xl font-semibold text-gradient">Polpo Brain</div>
            <div className="text-xs uppercase tracking-[0.22em] text-muted mt-1">personal AI · sovereign mind</div>
          </div>
        </div>
        <Card>
          {isFirstSetup ? (
            <div className="mb-5">
              <div className="text-lg font-semibold mb-1">Initialize your Polpo Brain</div>
              <div className="text-sm text-muted">Single-user instance. Set your credentials once — you won't be asked again.</div>
            </div>
          ) : (
            <div className="mb-5">
              <div className="text-lg font-semibold mb-1">Sign in</div>
              <div className="text-sm text-muted">Welcome back to your Polpo Brain.</div>
            </div>
          )}

          {isFirstSetup && (
            <div className="mb-4">
              <Banner tone="info">First boot — this account will own all existing onboarding, vault and message data on this instance.</Banner>
            </div>
          )}

          <div className="space-y-3">
            {isFirstSetup && (
              <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Mattia" /></Field>
            )}
            <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
            <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={isFirstSetup ? 'new-password' : 'current-password'} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          </div>
          <div className="mt-5">
            <Button className="w-full" onClick={submit} disabled={loading || !email || !password}>
              {loading ? '…' : isFirstSetup ? 'Initialize Polpo Brain' : 'Sign in'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
