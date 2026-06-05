import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Input, useToast } from '../components/ui';
import { useDialog } from '../components/dialog';
import { Search, ChevronLeft, ChevronRight, Sparkles, Users as UsersIcon, ArrowUpDown, BrainCircuit, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import BrainLoading from '../components/BrainLoading';
import PersonGraphModal from '../components/PersonGraphModal';
import MarkdownView from '../components/MarkdownView';

type Person = {
  id: number; slug: string; name: string; aliases: string[]; emails: string[]; phones: string[];
  note_path: string | null; meta: any; updated_at: string; has_psy?: boolean;
};

type SortKey = 'name' | 'slug' | 'updated';

function fmtDate(s: string): string {
  return new Date(s).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function PeoplePage() {
  const [rows, setRows] = useState<Person[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [page, setPage] = useState(0);
  const [limit] = useState(25);
  const [sort, setSort] = useState<SortKey>('updated');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(false);
  const [dedupBusy, setDedupBusy] = useState(false);
  const [openPerson, setOpenPerson] = useState<Person | null>(null);
  const [psyPerson, setPsyPerson] = useState<Person | null>(null);
  const [psyNote, setPsyNote] = useState<any | null>(null);
  const [psyLoading, setPsyLoading] = useState(false);
  async function openPsy(p: Person) {
    setPsyPerson(p); setPsyNote(null); setPsyLoading(true);
    try { setPsyNote(await api.personPsyProfile(p.slug)); }
    catch (e: any) { setPsyNote({ error: String(e?.message ?? e) }); }
    finally { setPsyLoading(false); }
  }
  const toast = useToast();
  const dlg = useDialog();
  const nav = useNavigate();

  const offset = page * limit;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.people({ q, limit, offset, sort, dir });
      setRows(r.rows); setTotal(r.total);
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setLoading(false); }
  }, [q, limit, offset, sort, dir, toast]);

  useEffect(() => { load(); }, [load]);

  // Deep-link: ?slug=foo auto-opens the dossier when row is in current page.
  // If not in current page, query People API directly for that slug.
  const [sp, setSp] = useSearchParams();
  const deepSlug = sp.get('slug');
  useEffect(() => {
    if (!deepSlug) return;
    let cancelled = false;
    (async () => {
      const inPage = rows.find((p) => p.slug === deepSlug);
      if (inPage) { setOpenPerson(inPage); return; }
      try {
        const r = await api.people({ q: deepSlug, limit: 1 });
        if (!cancelled && r.rows?.[0]) setOpenPerson(r.rows[0]);
      } catch {}
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepSlug]);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

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

  const SortBtn = useMemo(() => function SortBtn({ col, label }: { col: SortKey; label: string }) {
    const active = sort === col;
    return (
      <button
        onClick={() => { if (active) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(col); setDir('asc'); } setPage(0); }}
        className={`inline-flex items-center gap-1 hover:text-text ${active ? 'text-text' : 'text-muted'}`}
      >
        {label}
        <ArrowUpDown size={11} className={active ? 'opacity-100' : 'opacity-40'} />
        {active && <span className="text-[9px] font-mono">{dir}</span>}
      </button>
    );
  }, [sort, dir]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <UsersIcon className="text-accent" size={22} />
          <h1 className="text-2xl font-semibold text-gradient">People</h1>
          <Chip>{total} record</Chip>
        </div>
        <Button onClick={dedupe} disabled={dedupBusy}>
          <Sparkles size={14} className="inline mr-1.5 -mt-0.5" />
          {dedupBusy ? 'Lancio…' : 'Bonifica duplicati'}
        </Button>
      </div>

      <Card>
        <div className="flex items-center gap-2 mb-3">
          <Search size={16} className="text-muted" />
          <Input
            placeholder="Cerca nome, alias, email, telefono…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            className="flex-1"
          />
          {qInput && <button onClick={() => setQInput('')} className="text-xs text-muted hover:text-text">×</button>}
        </div>

        {loading ? (
          <div className="py-12 flex justify-center"><BrainLoading size={80} label="Caricamento…" /></div>
        ) : rows.length === 0 ? (
          <div className="py-12 text-center text-muted text-sm">Nessuna persona trovata.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-muted border-b border-border">
                  <th className="py-2 pr-3"><SortBtn col="name" label="Nome" /></th>
                  <th className="py-2 pr-3"><SortBtn col="slug" label="Slug" /></th>
                  <th className="py-2 pr-3">Email</th>
                  <th className="py-2 pr-3">Telefoni</th>
                  <th className="py-2 pr-3">Alias</th>
                  <th className="py-2 pr-3"><SortBtn col="updated" label="Ultimo update" /></th>
                  <th className="py-2 pr-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} onClick={() => setOpenPerson(p)} className="border-b border-border/40 hover:bg-surface2/40 transition cursor-pointer">
                    <td className="py-2.5 pr-3 font-medium hover:text-accent">{p.name}</td>
                    <td className="py-2.5 pr-3"><span className="font-mono text-xs text-muted">{p.slug}</span></td>
                    <td className="py-2.5 pr-3 text-xs">
                      {(p.emails ?? []).slice(0, 2).map((e) => (
                        <div key={e} className="text-muted truncate max-w-[200px]">{e}</div>
                      ))}
                      {(p.emails?.length ?? 0) > 2 && <div className="text-[10px] text-muted/70">+{p.emails.length - 2}</div>}
                    </td>
                    <td className="py-2.5 pr-3 text-xs font-mono">
                      {(p.phones ?? []).slice(0, 2).map((ph) => <div key={ph} className="text-muted">{ph}</div>)}
                      {(p.phones?.length ?? 0) > 2 && <div className="text-[10px] text-muted/70">+{p.phones.length - 2}</div>}
                    </td>
                    <td className="py-2.5 pr-3 text-xs">
                      <div className="flex flex-wrap gap-1">
                        {(p.aliases ?? []).slice(0, 3).map((a) => (
                          <span key={a} className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-muted">{a}</span>
                        ))}
                        {(p.aliases?.length ?? 0) > 3 && <span className="text-[10px] text-muted/70">+{p.aliases.length - 3}</span>}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-muted font-mono">{fmtDate(p.updated_at)}</td>
                    <td className="py-2.5 pr-3" onClick={(e) => e.stopPropagation()}>
                      {p.has_psy && (
                        <button
                          onClick={() => openPsy(p)}
                          title="Profilo psicologico"
                          className="p-1.5 rounded-md hover:bg-surface2 text-accent hover:text-accent transition"
                        >
                          <BrainCircuit size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > limit && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
            <div className="text-xs text-muted">{offset + 1}–{Math.min(offset + limit, total)} di {total}</div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                <ChevronLeft size={14} />
              </Button>
              <span className="text-xs font-mono text-muted px-2">{page + 1} / {totalPages}</span>
              <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        )}
      </Card>

      {openPerson && (
        <PersonGraphModal slug={openPerson.slug} name={openPerson.name} onClose={() => setOpenPerson(null)} />
      )}

      {psyPerson && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setPsyPerson(null)}>
          <div onClick={(e) => e.stopPropagation()} className="bg-surface border border-border rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <BrainCircuit size={18} className="text-accent" />
                <div>
                  <div className="font-semibold text-sm">{psyPerson.name}</div>
                  <div className="text-[10px] text-muted font-mono">profilo psicologico</div>
                </div>
              </div>
              <button onClick={() => setPsyPerson(null)} className="p-1.5 rounded-md hover:bg-surface2 text-muted hover:text-text">
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto p-5 flex-1">
              {psyLoading ? (
                <div className="py-12 flex justify-center"><BrainLoading size={70} label="Carico profilo…" /></div>
              ) : psyNote?.error ? (
                <div className="text-sm text-red-400">{psyNote.error}</div>
              ) : psyNote?.content ? (
                <MarkdownView content={psyNote.content} />
              ) : (
                <div className="text-sm text-muted">Profilo non disponibile.</div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
