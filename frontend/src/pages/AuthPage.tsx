import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { useToast } from '../components/ui';
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
        toast.push('Accesso effettuato', 'on');
      } else {
        const r = await register(email, password, name || undefined);
        setClaim(!!r.claimedOrphans);
        toast.push(r.claimedOrphans ? 'Registrato — dati esistenti reclamati' : 'Registrato', 'on');
      }
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative">
      <div className="absolute inset-0 -z-10 bg-gradient-primary-soft" />
      <div className="absolute top-4 right-4">
        <ThemeSwitcher />
      </div>

      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src={branding.logoDataUrl || '/rounded-image.png'}
            alt={branding.title}
            className="w-20 h-20 rounded-2xl shadow-lg object-cover"
          />
          <div>
            <h1 className="text-3xl font-semibold tracking-tight bg-gradient-primary bg-clip-text text-transparent">
              {branding.title}
            </h1>
            {branding.subtitle && (
              <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground mt-1">
                {branding.subtitle}
              </p>
            )}
          </div>
        </div>

        <Card>
          <CardHeader className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'login' | 'register')}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login">Accedi</TabsTrigger>
                <TabsTrigger value="register">Registrati</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>

          <CardContent className="space-y-4">
            {!usersExist && mode === 'register' && (
              <div className="rounded-lg border bg-primary/10 text-foreground px-3 py-2 text-xs">
                Primo utente! Il tuo account reclamerà i dati di onboarding/vault/messaggi esistenti.
              </div>
            )}
            {claim && (
              <div className="rounded-lg border bg-primary/10 text-foreground px-3 py-2 text-xs">
                Dati esistenti reclamati con successo.
              </div>
            )}

            {mode === 'register' && (
              <div className="space-y-2">
                <Label htmlFor="name">Nome (opzionale)</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Federico" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>

            <Button className="w-full" onClick={submit} disabled={loading || !email || !password}>
              {loading ? 'Attendi…' : mode === 'login' ? 'Accedi' : 'Crea account'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
