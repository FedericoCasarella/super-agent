import { ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

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

export function Select({ className = '', ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...rest} className={`w-full bg-surface2/70 border border-border rounded-2xl px-4 py-2.5 text-text focus:outline-none focus:border-accent/60 focus:bg-surface2 focus:shadow-[0_0_0_4px_rgba(192,132,252,0.08)] ${className}`} />;
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
  return <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border backdrop-blur-sm ${tones[tone]}`}>{children}</span>;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="inline-flex items-center cursor-pointer">
      <input type="checkbox" aria-label={label} className="sr-only peer" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="w-12 h-6 bg-surface2 border border-border peer-checked:bg-gradient-to-r peer-checked:from-accent peer-checked:to-accent2 peer-checked:border-transparent peer-checked:shadow-[0_0_18px_-4px_rgba(192,132,252,0.6)] rounded-full relative transition-all duration-300 ease-out-expo">
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-text shadow-md transition-all duration-300 ease-out-expo ${checked ? 'translate-x-6' : ''}`} />
      </div>
    </label>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open, title, children, onClose, footer,
}: {
  open: boolean; title: string; children: ReactNode; onClose: () => void; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // a11y (sess.2939): Esc-to-close, focus trap, and focus restore — a modal with no
  // keyboard escape or focus management traps keyboard/screen-reader users.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key === 'Tab' && ref.current) {
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (f.length === 0) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    (ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current)?.focus();
    return () => { document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/70 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="glass border border-border rounded-xl3 p-6 w-full max-w-lg mx-4 ring-soft gradient-border animate-slide-up outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold mb-3 text-gradient">{title}</div>
        <div className="text-sm text-text/90">{children}</div>
        {footer && <div className="flex gap-2 justify-end mt-6">{footer}</div>}
      </div>
    </div>
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
