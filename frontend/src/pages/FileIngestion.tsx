// File-ingestion — carica un file (anche grande, niente limite Telegram 20MB)
// con un prompt. Il backend lo salva su disco, l'agente lo legge dal path e lo
// elabora; a fine arriva un messaggio su Telegram dove prosegue la conversazione.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, useToast } from '../components/ui';
import { UploadCloud, FileText, Loader2, CheckCircle2, XCircle, Send, X } from 'lucide-react';

type Ingestion = {
  id: number; filename: string; size_bytes: number; prompt: string;
  status: 'processing' | 'done' | 'error'; result: string | null; error: string | null;
  created_at: string; done_at: string | null;
};

function fmtBytes(b: number) {
  const n = Number(b);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const STATUS: Record<Ingestion['status'], { label: string; tone: any; Icon: any }> = {
  processing: { label: 'in elaborazione', tone: 'warn', Icon: Loader2 },
  done: { label: 'completato', tone: 'on', Icon: CheckCircle2 },
  error: { label: 'errore', tone: 'err', Icon: XCircle },
};

export default function FileIngestionPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Ingestion[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() { try { setRows((await api.ingestList()).rows); } catch {} }
  useEffect(() => {
    load();
    // Poll while anything is processing so status flips live.
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  async function submit() {
    if (!file || !prompt.trim()) return;
    setBusy(true); setPct(0);
    try {
      const r = await api.ingestUpload(file, prompt.trim(), setPct);
      if (!r.ok) throw new Error(r.error || 'upload fallito');
      toast.push('File caricato — lo elaboro, ti scrivo su Telegram a fine', 'on');
      setFile(null); setPrompt(''); setPct(0);
      await load();
    } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
    finally { setBusy(false); }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) setFile(f);
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-gradient">File-ingestion</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Carica un file (anche grande) con un prompt. L'agente lo legge dal disco e lo elabora — a fine ti scrive su Telegram per continuare lì.
        </p>
      </div>

      <Card className="space-y-3">
        {/* Dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition ${drag ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50 bg-surface2/30'}`}
        >
          <input ref={fileRef} type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file ? (
            <div className="flex items-center justify-center gap-2 text-sm">
              <FileText size={16} className="text-accent" />
              <span className="font-medium">{file.name}</span>
              <span className="text-muted-foreground">· {fmtBytes(file.size)}</span>
              <button onClick={(e) => { e.stopPropagation(); setFile(null); }} className="text-muted-foreground hover:text-destructive"><X size={14} /></button>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground flex flex-col items-center gap-2">
              <UploadCloud size={26} className="text-accent" />
              Trascina un file qui o clicca per sceglierlo
            </div>
          )}
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Cosa deve farci l'agente? Es: estrai gli action items, riassumi per sezione, collega le persone citate al CRM…"
          className="w-full h-24 text-sm bg-surface2/60 border border-border rounded-lg p-3 resize-none focus:outline-none focus:border-primary/60"
        />

        {busy && pct > 0 && pct < 100 && (
          <div className="h-1.5 rounded-full bg-surface2/80 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-primary to-[hsl(var(--accent-2))] transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button disabled={!file || !prompt.trim() || busy} onClick={submit} className="gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {busy ? (pct < 100 ? `Caricamento ${pct}%` : 'Avvio…') : 'Carica ed elabora'}
          </Button>
        </div>
      </Card>

      {/* Storico */}
      <Card>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">Ingestioni recenti</div>
        {rows.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">Nessun file ingerito ancora.</div>}
        <div className="space-y-2">
          {rows.map((r) => {
            const S = STATUS[r.status];
            const I = S.Icon;
            return (
              <div key={r.id} className="border border-border rounded-xl bg-surface2/30 p-3">
                <div className="flex items-start gap-2.5">
                  <I size={15} className={`mt-0.5 shrink-0 ${r.status === 'processing' ? 'animate-spin text-amber-300' : r.status === 'done' ? 'text-emerald-400' : 'text-red-400'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{r.filename}</span>
                      <span className="text-[11px] text-muted-foreground">{fmtBytes(r.size_bytes)}</span>
                      <Chip tone={S.tone}>{S.label}</Chip>
                    </div>
                    <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">{r.prompt}</div>
                    {r.status === 'done' && r.result && (
                      <div className="text-xs mt-2 whitespace-pre-wrap border-l-2 border-emerald-400/40 pl-2">{r.result}</div>
                    )}
                    {r.status === 'error' && r.error && (
                      <div className="text-xs mt-2 text-red-400 whitespace-pre-wrap border-l-2 border-red-400/40 pl-2">{r.error}</div>
                    )}
                    <div className="text-[10px] text-muted-foreground mt-1.5 font-mono">{new Date(r.created_at).toLocaleString('it-IT')}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
