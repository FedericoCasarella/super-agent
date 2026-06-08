// Legacy `ui.tsx` — now re-exports shadcn components with back-compat wrappers
// so old pages keep working while we migrate. Source of truth lives in
// `src/components/ui/*.tsx`. Once a page is migrated, import directly from
// `@/components/ui/button` etc.
import { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode, createContext, useCallback, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button as SButton } from './ui/button';
import { Input as SInput } from './ui/input';
import { Textarea as STextarea } from './ui/textarea';
import { Card as SCard } from './ui/card';
import { Badge } from './ui/badge';
import { Switch as SSwitch } from './ui/switch';
import { Label as SLabel } from './ui/label';
import {
  Dialog as SDialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from './ui/dialog';

type LegacyVariant = 'primary' | 'ghost' | 'danger';
type LegacySize = 'sm' | 'md';
const VARIANT_MAP: Record<LegacyVariant, 'default' | 'ghost' | 'destructive'> = {
  primary: 'default', ghost: 'ghost', danger: 'destructive',
};
const SIZE_MAP: Record<LegacySize, 'sm' | 'default'> = { sm: 'sm', md: 'default' };

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: LegacyVariant; size?: LegacySize }) {
  return <SButton variant={VARIANT_MAP[variant]} size={SIZE_MAP[size]} className={className} {...rest} />;
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <SInput className={className} {...rest} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <STextarea className={className} {...rest} />;
}

export function Label({ children }: { children: ReactNode }) {
  return <SLabel className="mb-1.5 block text-xs uppercase tracking-wider text-muted-foreground">{children}</SLabel>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><Label>{label}</Label>{children}</div>;
}

export function Card({ className = '', children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <SCard className={`p-5 ${className}`} {...rest}>{children}</SCard>;
}

// Map legacy tones to shadcn Badge variants. `accent`/`accent2` lean on the
// gradient primary; success/warn/err use semantic tokens.
export function Chip({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'on' | 'warn' | 'err' | 'accent' | 'accent2';
  children: ReactNode;
}) {
  const map: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'; cls?: string }> = {
    default: { variant: 'secondary' },
    on: { variant: 'success' },
    warn: { variant: 'warning' },
    err: { variant: 'destructive' },
    accent: { variant: 'default', cls: 'bg-gradient-primary text-primary-foreground border-transparent' },
    accent2: { variant: 'default', cls: 'bg-[hsl(var(--accent-2))]/15 border-[hsl(var(--accent-2))]/40 text-[hsl(var(--accent-2))]' },
  };
  const { variant, cls } = map[tone];
  return (
    <Badge variant={variant} className={`rounded-full px-2.5 py-0.5 ${cls ?? ''}`}>
      {children}
    </Badge>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <SSwitch checked={checked} onCheckedChange={onChange} />;
}

export function Modal({
  open, title, children, onClose, footer,
}: {
  open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode;
}) {
  return (
    <SDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="text-sm">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </SDialog>
  );
}

type Tone = 'info' | 'on' | 'warn' | 'err';
type Toast = { id: number; tone: Tone; message: string };
type ToastCtx = { push: (message: string, tone?: Tone) => void };
const ToastContext = createContext<ToastCtx | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((p) => [...p, { id, tone, message }]);
    setTimeout(() => setItems((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);
  const tones: Record<Tone, string> = {
    info: 'border-primary/40 bg-primary/10 text-foreground',
    on: 'border-[hsl(var(--success))]/40 bg-[hsl(var(--success))]/10 text-foreground',
    warn: 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-foreground',
    err: 'border-destructive/40 bg-destructive/10 text-foreground',
  };
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      {createPortal(
        <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 max-w-sm">
          {items.map((t) => (
            <div key={t.id} className={`rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm ${tones[t.tone]}`}>
              {t.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function Banner({ tone = 'warn', children }: { tone?: 'warn' | 'err' | 'info'; children: ReactNode }) {
  const tones: Record<string, string> = {
    warn: 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/10 text-foreground',
    err: 'border-destructive/40 bg-destructive/10 text-foreground',
    info: 'border-primary/40 bg-primary/10 text-foreground',
  };
  return <div className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}
