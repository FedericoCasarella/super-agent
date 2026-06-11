// Pannello proposte del Brain Consolidator — il perk notturno propone, QUI
// l'utente decide. Sheet laterale con lista pending, anteprima espandibile,
// Applica/Scarta singolo + Applica tutte. Ogni apply passa dal backend che
// crea uno snapshot di sicurezza prima di toccare il vault.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Chip, useToast } from './ui';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { GitMerge, FlaskConical, Scissors, Link2, Check, X, Loader2, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';

type Proposal = {
  id: number;
  kind: 'merge' | 'distill' | 'prune' | 'link';
  title: string;
  description: string | null;
  payload: any;
  status: string;
  created_at: string;
};

const KIND_META: Record<Proposal['kind'], { label: string; icon: any; cls: string }> = {
  merge:   { label: 'Unione',        icon: GitMerge,     cls: 'text-violet-400' },
  distill: { label: 'Distillazione', icon: FlaskConical, cls: 'text-emerald-400' },
  prune:   { label: 'Potatura',      icon: Scissors,     cls: 'text-amber-400' },
  link:    { label: 'Collegamento',  icon: Link2,        cls: 'text-sky-400' },
};

export default function BrainProposals({ onApplied }: { onApplied?: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      setRows((await api.brainProposals('pending')).rows);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(String(e?.message ?? e));
    }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { if (open) load(); }, [open]);

  async function apply(id: number) {
    setBusy(id);
    try {
      const r = await api.brainProposalApply(id);
      if (!r.ok) throw new Error(r.error || 'apply fallito');
      toast.push('Proposta applicata (snapshot di sicurezza creato)', 'on');
      setRows((p) => p.filter((x) => x.id !== id));
      onApplied?.();
    } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
    finally { setBusy(null); }
  }

  async function reject(id: number) {
    setBusy(id);
    try {
      await api.brainProposalReject(id);
      setRows((p) => p.filter((x) => x.id !== id));
    } catch (e: any) { toast.push(String(e?.message ?? e), 'err'); }
    finally { setBusy(null); }
  }

  async function applyAll() {
    setBusy('all');
    let ok = 0, ko = 0;
    for (const p of [...rows]) {
      try {
        const r = await api.brainProposalApply(p.id);
        if (r.ok) { ok++; setRows((prev) => prev.filter((x) => x.id !== p.id)); }
        else ko++;
      } catch { ko++; }
    }
    toast.push(`Applicate ${ok}${ko ? ` · ${ko} fallite` : ''}`, ko ? 'err' : 'on');
    onApplied?.();
    setBusy(null);
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="ghost" className="gap-1.5">
          <Sparkles size={14} className="text-accent" />
          Proposte
          {rows.length > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-semibold">
              {rows.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            🧠 Proposte del Consolidator
            {rows.length > 1 && (
              <Button size="sm" variant="ghost" className="ml-auto gap-1" disabled={busy !== null} onClick={applyAll}>
                {busy === 'all' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                Applica tutte
              </Button>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className="mt-4 space-y-3">
          {loadError && (
            <div className="text-sm text-destructive py-4 text-center border border-destructive/30 rounded-lg bg-destructive/5">
              Errore nel caricamento: {loadError}
            </div>
          )}
          {!loadError && rows.length === 0 && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Nessuna proposta in attesa.<br />
              Il Brain Consolidator gira di notte e propone qui consolidamenti del vault.
            </div>
          )}
          {rows.map((p) => {
            const meta = KIND_META[p.kind];
            const Icon = meta.icon;
            const isExp = expanded === p.id;
            return (
              <div key={p.id} className="border border-border rounded-xl bg-surface2/40 overflow-hidden">
                <div className="p-3">
                  <div className="flex items-start gap-2">
                    <Icon size={16} className={`${meta.cls} mt-0.5 shrink-0`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Chip>{meta.label}</Chip>
                        <span className="text-[11px] text-muted-foreground">{new Date(p.created_at).toLocaleDateString('it-IT')}</span>
                      </div>
                      <div className="text-sm font-medium mt-1">{p.title}</div>
                      {p.description && (
                        <button
                          onClick={() => setExpanded(isExp ? null : p.id)}
                          className="text-xs text-muted-foreground mt-1 flex items-center gap-1 hover:text-foreground"
                        >
                          {isExp ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          dettagli
                        </button>
                      )}
                      {isExp && (
                        <div className="text-xs text-muted-foreground mt-2 whitespace-pre-wrap border-l-2 border-border pl-2">
                          {p.description}
                          {(p.kind === 'merge' || p.kind === 'distill') && p.payload?.content && (
                            <details className="mt-2">
                              <summary className="cursor-pointer text-foreground/70">Anteprima nota risultante</summary>
                              <pre className="mt-1 text-[11px] whitespace-pre-wrap max-h-60 overflow-y-auto bg-surface2/60 rounded p-2">{String(p.payload.content).slice(0, 3000)}</pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-end gap-2 mt-2">
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => reject(p.id)} className="gap-1 text-muted-foreground">
                      <X size={13} /> Scarta
                    </Button>
                    <Button size="sm" disabled={busy !== null} onClick={() => apply(p.id)} className="gap-1">
                      {busy === p.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Applica
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
