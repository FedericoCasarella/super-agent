import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './ui';
import { AlertCircle, Info, X } from 'lucide-react';

// Drop-in replacement for window.alert / confirm / prompt that uses our dark theme.
// All return Promises so callers can `await dialog.confirm('...')`.

type DialogKind = 'alert' | 'confirm' | 'prompt';
type DialogTone = 'info' | 'danger' | 'ok';

type DialogRequest = {
  id: number;
  kind: DialogKind;
  title?: string;
  message: string;
  tone?: DialogTone;
  confirmLabel?: string;
  cancelLabel?: string;
  placeholder?: string;
  defaultValue?: string;
  resolve: (v: any) => void;
};

type DialogApi = {
  alert: (message: string, opts?: { title?: string; tone?: DialogTone; confirmLabel?: string }) => Promise<void>;
  confirm: (message: string, opts?: { title?: string; tone?: DialogTone; confirmLabel?: string; cancelLabel?: string }) => Promise<boolean>;
  prompt: (message: string, opts?: { title?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; cancelLabel?: string }) => Promise<string | null>;
};

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used inside <DialogProvider>');
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const counter = useRef(0);

  const enqueue = useCallback(<T,>(partial: Omit<DialogRequest, 'id' | 'resolve'>): Promise<T> => {
    return new Promise<T>((resolve) => {
      counter.current += 1;
      setQueue((q) => [...q, { ...partial, id: counter.current, resolve }]);
    });
  }, []);

  const api: DialogApi = {
    alert: (message, opts) => enqueue<void>({ kind: 'alert', message, ...opts }),
    confirm: (message, opts) => enqueue<boolean>({ kind: 'confirm', message, ...opts }),
    prompt: (message, opts) => enqueue<string | null>({ kind: 'prompt', message, ...opts }),
  };

  const current = queue[0];

  function close(value: any) {
    if (!current) return;
    current.resolve(value);
    setQueue((q) => q.slice(1));
  }

  return (
    <DialogContext.Provider value={api}>
      {children}
      {current && <DialogOverlay req={current} onClose={close} />}
    </DialogContext.Provider>
  );
}

function DialogOverlay({ req, onClose }: { req: DialogRequest; onClose: (v: any) => void }) {
  const [value, setValue] = useState(req.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setValue(req.defaultValue ?? '');
    setTimeout(() => inputRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined); }
      if (e.key === 'Enter' && req.kind !== 'prompt') {
        // Prompt: Enter handled inside input
        e.preventDefault(); onClose(req.kind === 'confirm' ? true : undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id]);

  const tone = req.tone ?? (req.kind === 'confirm' ? 'danger' : 'info');
  const Icon = tone === 'danger' ? AlertCircle : Info;
  const iconColor = tone === 'danger' ? 'text-red-300' : tone === 'ok' ? 'text-emerald-300' : 'text-accent';
  const confirmLabel = req.confirmLabel ?? (req.kind === 'confirm' ? 'Conferma' : req.kind === 'prompt' ? 'OK' : 'OK');
  const cancelLabel = req.cancelLabel ?? 'Annulla';

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-fade-in" onClick={() => onClose(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)}>
      <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-md ring-1 ring-white/5 animate-slide-up">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-border">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${tone === 'danger' ? 'bg-red-500/15 border border-red-400/40' : tone === 'ok' ? 'bg-emerald-500/15 border border-emerald-400/40' : 'bg-accent/15 border border-accent/40'}`}>
              <Icon size={18} className={iconColor} />
            </div>
            <div className="min-w-0 flex-1">
              {req.title && <div className="font-semibold text-sm truncate">{req.title}</div>}
              <div className="text-sm text-text/90 whitespace-pre-wrap break-words">{req.message}</div>
            </div>
          </div>
          <button onClick={() => onClose(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)} className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground hover:text-text shrink-0"><X size={16} /></button>
        </div>
        {req.kind === 'prompt' && (
          <div className="px-5 py-4">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onClose(value); } }}
              placeholder={req.placeholder ?? ''}
              className="w-full bg-surface2 border border-border focus:border-accent rounded-lg px-3 py-2 text-sm outline-none transition"
              autoFocus
            />
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-surface2/30 rounded-b-2xl">
          {req.kind !== 'alert' && (
            <Button variant="ghost" onClick={() => onClose(req.kind === 'confirm' ? false : null)}>{cancelLabel}</Button>
          )}
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => onClose(req.kind === 'confirm' ? true : req.kind === 'prompt' ? value : undefined)}
          >{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
