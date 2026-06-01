import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input } from './ui';
import { api } from '../api';
import { useBranding } from '../branding';

async function fileToDataUrl(file: File, maxDim = 256): Promise<string> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: file.type });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  // Downscale via canvas for size budget
  const img = new Image();
  img.src = dataUrl;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  return cv.toDataURL('image/png', 0.92);
}

export default function BrandingEditor({ onSaved }: { onSaved?: (result?: any) => void }) {
  const { branding, reload } = useBranding();
  const [title, setTitle] = useState(branding.title);
  const [subtitle, setSubtitle] = useState(branding.subtitle ?? '');
  const [logo, setLogo] = useState<string | null>(branding.logoDataUrl);
  const [saving, setSaving] = useState(false);
  const [syncTelegram, setSyncTelegram] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTitle(branding.title); setSubtitle(branding.subtitle ?? ''); setLogo(branding.logoDataUrl); }, [branding]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setLogo(await fileToDataUrl(f)); }
    catch (err) { alert(String(err)); }
  }
  async function save() {
    setSaving(true);
    try {
      const r = await api.updateBranding({ title, subtitle, logoDataUrl: logo, syncTelegram });
      await reload();
      onSaved?.(r);
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <img src={logo || '/rounded-image.png'} alt="" className="w-16 h-16 rounded-2xl ring-1 ring-white/10 object-cover bg-surface2" />
        <div className="flex flex-col gap-2">
          <input ref={fileRef} type="file" accept="image/*" onChange={onPick} className="hidden" />
          <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>📷 Cambia logo</Button>
          {logo && <Button size="sm" variant="ghost" onClick={() => setLogo(null)}>Rimuovi</Button>}
        </div>
      </div>
      <Field label="Titolo app"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="super-agent" /></Field>
      <Field label="Sottotitolo (opz.)"><Input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="personal · brain" /></Field>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input type="checkbox" checked={syncTelegram} onChange={(e) => setSyncTelegram(e.target.checked)} className="w-4 h-4 accent-accent" />
        <span>Sincronizza anche nome + descrizione del bot Telegram <span className="text-[11px] text-muted/70">(foto profilo bot: cambiabile solo da @BotFather)</span></span>
      </label>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || !title.trim()}>{saving ? 'Salvo…' : 'Salva branding'}</Button>
      </div>
    </div>
  );
}
