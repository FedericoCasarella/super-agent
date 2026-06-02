import { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode, createContext, useCallback, useContext, useState } from 'react';
import { createPortal } from 'react-dom';

type Variant = 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-200 ease-out-expo active:scale-[0.96] hover:-translate-y-[1px] disabled:opacity-40 disabled:pointer-events-none disabled:hover:translate-y-0 ring-soft';
  const sizes: Record<Size, string> = { sm: 'px-3.5 py-1.5 text-xs', md: 'px-5 py-2.5 text-sm' };
  const variants: Record<Variant, string> = {
    primary: 'bg-gradient-to-r from-accent to-accent2 text-bg hover:shadow-lg hover:shadow-accent/30',
    ghost:   'bg-surface2/70 text-text border border-border hover:border-accent/50 hover:bg-surface2',
    danger:  'bg-err/15 text-err border border-err/30 hover:bg-err/25 hover:shadow-lg hover:shadow-err/20',
  };
  return <button {...rest} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} />;
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`w-full bg-surface2/70 border border-border rounded-2xl px-4 py-2.5 text-text placeholder:text-muted/70 focus:outline-none focus:border-accent/60 focus:bg-surface2 focus:shadow-[0_0_0_4px_rgba(192,132,252,0.08)] ${className}`} />;
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`w-full bg-surface2/70 border border-border rounded-2xl px-4 py-3 text-text placeholder:text-muted/70 focus:outline-none focus:border-accent/60 focus:bg-surface2 focus:shadow-[0_0_0_4px_rgba(192,132,252,0.08)] min-h-[88px] ${className}`} />;
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="text-xs uppercase tracking-wider text-muted mb-1.5 block">{children}</label>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><Label>{label}</Label>{children}</div>;
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`glass border border-border rounded-xl3 p-5 ring-soft gradient-border hover:border-accent/30 ${className}`}>{children}</div>;
}

export function Chip({ tone = 'default', children }: { tone?: 'default' | 'on' | 'warn' | 'err' | 'accent' | 'accent2'; children: ReactNode }) {
  const tones: Record<string, string> = {
    default: 'bg-surface2/70 border-border text-muted',
    on: 'bg-ok/10 border-ok/30 text-ok shadow-[0_0_18px_-4px_rgba(52,211,153,0.45)]',
    warn: 'bg-warn/10 border-warn/30 text-warn',
    err: 'bg-err/10 border-err/30 text-err',
    accent: 'bg-gradient-to-r from-accent/15 to-fuchsia-400/10 border-accent/40 text-accent shadow-[0_0_18px_-4px_rgba(192,132,252,0.5)]',
    accent2: 'bg-gradient-to-r from-accent2/15 to-sky-300/10 border-accent2/40 text-accent2 shadow-[0_0_18px_-4px_rgba(34,211,238,0.5)]',
  };
  return <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border backdrop-blur-md ${tones[tone]}`}>{children}</span>;
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="inline-flex items-center cursor-pointer">
      <input type="checkbox" className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="w-12 h-6 bg-surface2 border border-border peer-checked:bg-gradient-to-r peer-checked:from-accent peer-checked:to-accent2 peer-checked:border-transparent peer-checked:shadow-[0_0_18px_-4px_rgba(192,132,252,0.6)] rounded-full relative transition-all duration-300 ease-out-expo overflow-hidden">
        <div className={`absolute top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-text shadow-md transition-all duration-300 ease-out-expo ${checked ? 'left-[calc(100%-1.375rem)]' : 'left-[0.125rem]'}`} />
      </div>
    </label>
  );
}

export function Modal({
  open, title, children, onClose, footer,
}: {
  open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode;
}) {
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in" onClick={onClose} role="dialog" aria-modal="true">
      <div className="glass border border-border rounded-xl3 p-6 w-full max-w-lg mx-4 ring-soft gradient-border animate-slide-up max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="text-lg font-semibold mb-3 text-gradient">{title}</div>
        <div className="text-sm text-text/90">{children}</div>
        {footer && <div className="flex gap-2 justify-end mt-6">{footer}</div>}
      </div>
    </div>,
    document.body,
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
    info: 'bg-accent/15 border-accent/40 text-text',
    on: 'bg-ok/15 border-ok/40 text-text',
    warn: 'bg-warn/15 border-warn/40 text-text',
    err: 'bg-err/15 border-err/40 text-text',
  };
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm">
        {items.map((t) => (
          <div key={t.id} className={`rounded-2xl border px-4 py-3 text-sm shadow-2xl backdrop-blur-md animate-slide-up ${tones[t.tone]}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Banner({ tone = 'warn', children }: { tone?: 'warn' | 'err' | 'info'; children: ReactNode }) {
  const tones: Record<string, string> = {
    warn: 'bg-warn/10 border-warn/30 text-warn',
    err: 'bg-err/10 border-err/30 text-err',
    info: 'bg-accent/10 border-accent/30 text-accent',
  };
  return <div className={`rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}
