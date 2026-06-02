import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';

export type Option = { value: string; label: string; sublabel?: string };

type Props = {
  value: string | number | null | undefined;
  onChange: (v: string | null, opt: Option | null) => void;
  fetchOptions: (q: string) => Promise<Option[]>;
  placeholder?: string;
  allowClear?: boolean;
  // For display when value is set but not in current results
  initialLabel?: string;
};

// Async searchable dropdown. Debounced (250ms). Click outside to close.
export default function SearchSelect({ value, onChange, fetchOptions, placeholder = 'Cerca…', allowClear = true, initialLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Option[]>([]);
  const [loading, setLoading] = useState(false);
  const [labelCache, setLabelCache] = useState<string | null>(initialLabel ?? null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Close on outside click
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const t = setTimeout(async () => {
      try { setItems(await fetchOptions(q)); }
      catch { setItems([]); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, fetchOptions]);

  // When value set, try to resolve a human label by fetching with empty q.
  useEffect(() => {
    if (value == null || value === '') { setLabelCache(null); return; }
    if (labelCache && initialLabel === labelCache) return;
    // best-effort label resolution
    let cancelled = false;
    fetchOptions('').then((opts) => {
      if (cancelled) return;
      const hit = opts.find((o) => String(o.value) === String(value));
      if (hit) setLabelCache(hit.label);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const display = value != null && value !== '' ? (labelCache ?? String(value)) : '';

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 30); }}
        className="w-full flex items-center gap-2 bg-surface2 border border-border focus:border-accent rounded-lg px-3 py-2 text-sm hover:border-border/80 transition"
      >
        <span className={`flex-1 text-left truncate ${display ? '' : 'text-muted'}`}>{display || placeholder}</span>
        {allowClear && display && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange(null, null); setLabelCache(null); }}
            className="text-muted hover:text-red-300 p-0.5"
          ><X size={13} /></button>
        )}
        <ChevronDown size={14} className={`text-muted transition ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
            <Search size={14} className="text-muted shrink-0" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtra…"
              className="flex-1 bg-transparent outline-none text-sm"
              autoFocus
            />
            {loading && <Loader2 size={13} className="text-muted animate-spin shrink-0" />}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {!loading && items.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted text-center">Nessun risultato.</div>
            )}
            {items.map((o) => {
              const selected = String(value) === String(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onChange(o.value, o); setLabelCache(o.label); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm flex items-start gap-2 hover:bg-surface2/60 transition ${selected ? 'bg-accent/10' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{o.label}</div>
                    {o.sublabel && <div className="text-[10px] text-muted font-mono truncate">{o.sublabel}</div>}
                  </div>
                  {selected && <Check size={13} className="text-accent shrink-0 mt-0.5" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
