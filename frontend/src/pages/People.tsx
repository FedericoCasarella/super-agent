import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Chip, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Sparkles, Users as UsersIcon, BrainCircuit, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import BrainLoading from '../components/BrainLoading';
import PersonGraphModal from '../components/PersonGraphModal';
import MarkdownView from '../components/MarkdownView';
import DataTable, { Column, ChipFilter } from '../components/DataTable';

type Person = {
  id: number; slug: string; name: string; aliases: string[]; emails: string[]; phones: string[];
  note_path: string | null; meta: any; updated_at: string; has_psy?: boolean;
};

function fmtDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function PeoplePage() {
  const [dedupBusy, setDedupBusy] = useState(false);
  const [openPerson, setOpenPerson] = useState<Person | null>(null);
  const [psyPerson, setPsyPerson] = useState<Person | null>(null);
  const [psyNote, setPsyNote] = useState<any | null>(null);
  const [psyLoading, setPsyLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const toast = useToast();
  const dlg = useDialog();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();

  // Deep-link: ?slug=foo auto-opens dossier.
  const deepSlug = sp.get('slug');
  useEffect(() => {
    if (!deepSlug) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.people({ q: deepSlug, limit: 1 });
        if (!cancelled && r.rows?.[0]) setOpenPerson(r.rows[0]);
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepSlug]);

  async function openPsy(p: Person) {
    setPsyPerson(p); setPsyNote(null); setPsyLoading(true);
    try { setPsyNote(await api.personPsyProfile(p.slug)); }
    catch (e: any) { setPsyNote({ error: String(e?.message ?? e) }); }
    finally { setPsyLoading(false); }
  }

  async function dedupe() {
    if (!await dlg.confirm('Lancia un sub-agent che troverà e unirà duplicati in People + brain.\n\nL\'esecuzione sarà tracciata nella pagina Agents. Procedo?', { title: 'Bonifica duplicati', tone: 'danger', confirmLabel: 'Lancia' })) return;
    setDedupBusy(true);
    try {
      const r = await api.peopleDedupeAgent();
      toast.push(`Sub-agent #${r.subAgentId} lanciato`, 'on');
      setTimeout(() => nav('/agents'), 600);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setDedupBusy(false); }
  }

  const columns: Column<Person>[] = [
    { key: 'name', header: 'Nome', sortable: true, render: (p) => <span className="font-medium hover:text-accent">{p.name}</span> },
    { key: 'slug', header: 'Slug', sortable: true, render: (p) => <span className="font-mono text-xs text-muted-foreground">{p.slug}</span> },
    { key: 'emails', header: 'Email', render: (p) => (
      <div className="text-xs">
        {(p.emails ?? []).slice(0, 2).map((e) => <div key={e} className="text-muted-foreground truncate max-w-[200px]">{e}</div>)}
        {(p.emails?.length ?? 0) > 2 && <div className="text-[10px] text-muted-foreground/70">+{p.emails.length - 2}</div>}
      </div>
    )},
    { key: 'phones', header: 'Telefoni', render: (p) => (
      <div className="text-xs font-mono">
        {(p.phones ?? []).slice(0, 2).map((ph) => <div key={ph} className="text-muted-foreground">{ph}</div>)}
        {(p.phones?.length ?? 0) > 2 && <div className="text-[10px] text-muted-foreground/70">+{p.phones.length - 2}</div>}
      </div>
    )},
    { key: 'aliases', header: 'Alias', render: (p) => (
      <div className="flex flex-wrap gap-1">
        {(p.aliases ?? []).slice(0, 3).map((a) => (
          <span key={a} className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted-foreground">{a}</span>
        ))}
        {(p.aliases?.length ?? 0) > 3 && <span className="text-[10px] text-muted-foreground/70">+{p.aliases.length - 3}</span>}
      </div>
    )},
    { key: 'updated', header: 'Ultimo update', sortable: true, render: (p) => <span className="text-xs text-muted-foreground font-mono">{fmtDate(p.updated_at)}</span> },
    { key: 'psy', header: '', width: 'w-10', render: (p) => p.has_psy ? (
      <button
        onClick={(e) => { e.stopPropagation(); openPsy(p); }}
        title="Profilo psicologico"
        className="p-1.5 rounded-md hover:bg-surface2 text-accent transition"
      >
        <BrainCircuit size={15} />
      </button>
    ) : null },
  ];

  const chipFilters: ChipFilter[] = [
    {
      key: 'has',
      label: 'Filtra',
      multi: true,
      options: [
        { value: 'emails', label: 'con email', tone: 'accent2' },
        { value: 'phones', label: 'con telefono', tone: 'accent' },
        { value: 'has_psy', label: 'con psy-profile', tone: 'on' },
      ],
    },
  ];

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="flex items-center gap-3 flex-wrap">
        <UsersIcon className="text-accent" size={22} />
        <h1 className="text-2xl font-semibold text-gradient">People</h1>
        <Chip>{total} record</Chip>
      </div>

      <DataTable<Person>
        persistKey="people"
        fetcher={async ({ q, page, pageSize, filters, sort }) => {
          const r = await api.people({
            q, limit: pageSize, offset: page * pageSize,
            sort: sort?.key as any, dir: sort?.dir,
          });
          // Apply chip filters client-side (backend doesn't have these yet).
          let rows = r.rows;
          const has = filters.has ?? [];
          if (has.includes('emails')) rows = rows.filter((p: Person) => (p.emails ?? []).length > 0);
          if (has.includes('phones')) rows = rows.filter((p: Person) => (p.phones ?? []).length > 0);
          if (has.includes('has_psy')) rows = rows.filter((p: Person) => p.has_psy);
          setTotal(r.total);
          return { rows, total: r.total };
        }}
        columns={columns}
        chipFilters={chipFilters}
        searchPlaceholder="Cerca nome, alias, email, telefono…"
        rowKey={(p) => p.id}
        onRowClick={(p) => setOpenPerson(p)}
        emptyText="Nessuna persona trovata."
        toolbar={
          <Button size="sm" onClick={dedupe} disabled={dedupBusy}>
            <Sparkles size={14} />
            {dedupBusy ? 'Lancio…' : 'Bonifica duplicati'}
          </Button>
        }
      />

      {openPerson && (
        <PersonGraphModal slug={openPerson.slug} name={openPerson.name} onClose={() => { setOpenPerson(null); if (deepSlug) { const next = new URLSearchParams(sp); next.delete('slug'); setSp(next, { replace: true }); } }} />
      )}

      {psyPerson && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setPsyPerson(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <BrainCircuit size={18} className="text-accent" />
                <div>
                  <div className="font-semibold text-sm">{psyPerson.name}</div>
                  <div className="text-[10px] text-muted-foreground font-mono">profilo psicologico</div>
                </div>
              </div>
              <button onClick={() => setPsyPerson(null)} className="p-1.5 rounded-md hover:bg-surface2 text-muted-foreground hover:text-text"><X size={16} /></button>
            </div>
            <div className="overflow-y-auto p-5 flex-1">
              {psyLoading ? (
                <div className="py-12 flex justify-center"><BrainLoading size={70} label="Carico profilo…" /></div>
              ) : psyNote?.error ? (
                <div className="text-sm text-red-400">{psyNote.error}</div>
              ) : psyNote?.content ? (
                <MarkdownView content={psyNote.content} />
              ) : (
                <div className="text-sm text-muted-foreground">Profilo non disponibile.</div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
