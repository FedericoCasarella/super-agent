import { useEffect, useState } from 'react';
import { Button, Field, Input } from './ui';
import { api } from '../api';
import { DEFAULT_BRAIN_COLORS, setBrainColors, type BrainColors } from '../brainColors';

const KIND_LABELS: Record<string, string> = {
  person: 'Persona', email: 'Email', project: 'Progetto', note: 'Nota',
  daily: 'Daily', roadmap: 'Roadmap', task: 'Task', attachment: 'Allegato', whatsapp: 'WhatsApp',
};
const VIS_LABELS: Record<string, string> = { protected: 'Protetto', public: 'Pubblico' };

function ColorRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }) {
  return (
    <label
      className="flex flex-col gap-1.5 p-2.5 rounded-xl border border-border/60 bg-surface2/30 hover:border-accent/40 hover:bg-surface2/60 transition cursor-pointer"
      title="Clicca per cambiare colore"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{label}</span>
        {hint && <span className="text-[10px] text-muted truncate">{hint}</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className="relative shrink-0 inline-block w-7 h-7 rounded-md ring-1 ring-white/10" style={{ background: value }}>
          <input
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label={label}
          />
        </span>
        <Input
          className="flex-1 font-mono text-xs"
          value={value}
          onChange={(e) => { const v = e.target.value; if (/^#[0-9a-f]{0,6}$/i.test(v)) onChange(v); }}
          onClick={(e) => e.preventDefault()}
          placeholder="#c084fc"
        />
      </div>
    </label>
  );
}

export default function BrainColorsEditor({ onSaved }: { onSaved?: () => void }) {
  const [c, setC] = useState<BrainColors>(DEFAULT_BRAIN_COLORS);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.brainColors().then((x: BrainColors) => setC(x)).catch(() => {}); }, []);

  function patch(path: 'visibility' | 'kind' | 'default', key: string | null, value: string) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) return; // wait full hex
    if (path === 'default') setC({ ...c, default: value });
    else if (key) setC({ ...c, [path]: { ...c[path], [key]: value } });
  }

  async function save() {
    setSaving(true);
    try {
      const r = await api.updateBrainColors(c);
      if (r?.colors) { setC(r.colors); setBrainColors(r.colors); }
      onSaved?.();
    } finally { setSaving(false); }
  }
  function reset() { setC(DEFAULT_BRAIN_COLORS); }

  return (
    <div className="space-y-5">
      <section>
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2 font-semibold">Visibilità</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(c.visibility).map(([k, v]) => (
            <ColorRow key={k} label={VIS_LABELS[k] ?? k} value={v} onChange={(x) => patch('visibility', k, x)} />
          ))}
        </div>
      </section>
      <section>
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2 font-semibold">Per categoria</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {Object.entries(c.kind).map(([k, v]) => (
            <ColorRow key={k} label={KIND_LABELS[k] ?? k} value={v} onChange={(x) => patch('kind', k, x)} />
          ))}
        </div>
      </section>
      <section>
        <div className="text-[11px] uppercase tracking-wider text-muted mb-2 font-semibold">Fallback</div>
        <ColorRow label="Default" hint="Nodo senza visibilità né kind noti" value={c.default} onChange={(x) => patch('default', null, x)} />
      </section>
      <div className="flex justify-between gap-2 pt-3 border-t border-border">
        <Button variant="ghost" size="sm" onClick={reset}>Ripristina default</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Salvo…' : 'Salva colori'}</Button>
      </div>
    </div>
  );
}
