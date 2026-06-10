import { useRef, useState } from 'react';
import type { VarDef } from './flowVariables';
import { ChevronDown, Plus, X } from 'lucide-react';

type Props = {
  value: string;
  onChange: (v: string) => void;
  vars: VarDef[];
  placeholder?: string;
  minHeight?: number;
};

// Textarea + variable picker. Variables get inserted at cursor as `{{key}}`.
// Pre-existing tokens in the value are highlighted as accent chips below.
export default function VariableTextarea({ value, onChange, vars, placeholder, minHeight = 140 }: Props) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [q, setQ] = useState('');

  function insertAtCursor(key: string) {
    const token = `{{${key}}}`;
    const ta = taRef.current;
    if (!ta) { onChange((value ?? '') + token); setPickerOpen(false); return; }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    setPickerOpen(false);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + token.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  // Parse used tokens
  const used: string[] = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value ?? '')) !== null) used.push(m[1].trim());

  const filtered = q.trim()
    ? vars.filter((v) => v.key.toLowerCase().includes(q.toLowerCase()) || v.label.toLowerCase().includes(q.toLowerCase()))
    : vars;

  return (
    <div className="space-y-2">
      <div className="relative">
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full bg-surface2 border border-border focus:border-accent rounded-lg px-3 py-2 pr-9 text-sm font-mono outline-none transition"
          style={{ minHeight }}
        />
        {/* Insert variable button — corner inside textarea */}
        <button
          type="button"
          onClick={() => setPickerOpen((o) => !o)}
          title="Inserisci variabile"
          className="absolute top-2 right-2 inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-gradient-to-br from-accent2 to-accent text-white hover:opacity-90 shadow-md uppercase tracking-wider font-semibold"
        >
          <Plus size={11} /> var
          <ChevronDown size={10} className={pickerOpen ? 'rotate-180 transition' : 'transition'} />
        </button>

        {pickerOpen && (
          <div className="absolute z-30 top-10 right-2 w-72 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Cerca variabile…"
                className="w-full bg-transparent outline-none text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-y-auto">
              {filtered.length === 0 && <div className="px-3 py-4 text-xs text-muted-foreground text-center">Nessuna variabile.</div>}
              {filtered.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => insertAtCursor(v.key)}
                  className="w-full text-left px-3 py-2 hover:bg-surface2/60 transition flex flex-col gap-0.5"
                >
                  <div className="text-xs font-medium">{v.label}</div>
                  <div className="text-[10px] font-mono text-accent2">{`{{${v.key}}}`}</div>
                  {v.sample && <div className="text-[10px] text-muted-foreground truncate">es: {v.sample}</div>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {used.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {used.map((k, i) => {
            const known = vars.find((x) => x.key === k);
            return (
              <span
                key={i}
                className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${known ? 'bg-accent2/15 text-accent2 border-accent2/40' : 'bg-red-500/10 text-red-300 border-red-400/30'} font-mono`}
                title={known?.label ?? 'Variabile non riconosciuta'}
              >
                {`{{${k}}}`}
                <button
                  type="button"
                  onClick={() => onChange((value ?? '').replace(new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, ''), ''))}
                  className="hover:text-red-300"
                ><X size={9} /></button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
