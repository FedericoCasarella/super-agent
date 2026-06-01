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
    <div className="flex items-center gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-[10px] text-muted">{hint}</div>}
      </div>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-10 h-8 rounded cursor-pointer bg-transparent border border-border"
      />
      <Input
        className="w-28 font-mono text-xs"
        value={value}
        onChange={(e) => { const v = e.target.value; if (/^#[0-9a-f]{0,6}$/i.test(v)) onChange(v); }}
        placeholder="#c084fc"
      />
    </div>
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
    <div className="space-y-4">
      <div>
        <div className="text-xs uppercase tracking-wider text-muted mb-2 font-semibold">Visibilità</div>
        {Object.entries(c.visibility).map(([k, v]) => (
          <ColorRow key={k} label={VIS_LABELS[k] ?? k} value={v} onChange={(x) => patch('visibility', k, x)} />
        ))}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-muted mb-2 font-semibold">Per categoria</div>
        {Object.entries(c.kind).map(([k, v]) => (
          <ColorRow key={k} label={KIND_LABELS[k] ?? k} value={v} onChange={(x) => patch('kind', k, x)} />
        ))}
      </div>
      <div>
        <div className="text-xs uppercase tracking-wider text-muted mb-2 font-semibold">Fallback</div>
        <ColorRow label="Default" hint="Usato quando il nodo non ha visibilità né kind noti" value={c.default} onChange={(x) => patch('default', null, x)} />
      </div>
      <div className="flex justify-between gap-2 pt-2 border-t border-border">
        <Button variant="ghost" size="sm" onClick={reset}>Ripristina default</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Salvo…' : 'Salva colori'}</Button>
      </div>
    </div>
  );
}
