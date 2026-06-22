import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, Chip, Input, Modal, Field, useToast } from '../components/ui';
import { Textarea } from '@/components/ui/textarea';
import { useDialog } from '../components/dialog';
import { Edit3, Save as SaveIcon, X as XIcon, Trash2, Eye } from 'lucide-react';
import BrainGraph3DConstellation from '../components/BrainGraph3DConstellation';
import MarkdownView from '../components/MarkdownView';
import BrainOverview from '../components/BrainOverview';
import BrainFileExplorer from '../components/BrainFileExplorer';
import BrainProposals from '../components/BrainProposals';
import GoalDetailPage from './GoalDetail';
import { createPortal } from 'react-dom';
import { FolderTree } from 'lucide-react';
import { useI18n } from '../i18n';
import { api as apiX } from '../api';

type Tab = 'graph' | 'list';
type Filter = 'all' | 'public' | 'protected';

export default function Brain() {
  const { t } = useI18n();
  const lsGet = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} };
  const [tab, setTab] = useState<Tab>(() => (lsGet('brain_tab', 'graph') === 'list' ? 'list' : 'graph'));
  useEffect(() => { lsSet('brain_tab', tab); }, [tab]);
  const [filter, setFilter] = useState<Filter>(() => {
    const v = lsGet('brain_filter', 'all');
    return (v === 'public' || v === 'protected' || v === 'all') ? v : 'all';
  });
  useEffect(() => { lsSet('brain_filter', filter); }, [filter]);
  const [originFilter, setOriginFilter] = useState<string>(() => lsGet('brain_origin', 'all'));
  useEffect(() => { lsSet('brain_origin', originFilter); }, [originFilter]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [vaultFilter, setVaultFilter] = useState<string>(() => lsGet('brain_vault', 'all'));
  useEffect(() => { lsSet('brain_vault', vaultFilter); }, [vaultFilter]);
  const [vaults, setVaults] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [graphKey, setGraphKey] = useState(0);
  const [nvName, setNvName] = useState('');
  const [nvPath, setNvPath] = useState('');
  const [nvSeed, setNvSeed] = useState(true);
  const [nvBusy, setNvBusy] = useState(false);
  const toast = useToast();
  const dlg = useDialog();
  async function createVault() {
    setNvBusy(true);
    try {
      await apiX.vaultsCreate({ name: nvName, path: nvPath, seed: nvSeed, makePrimary: false });
      toast.push('Cervello collegato', 'on');
      setCreateOpen(false); setNvName(''); setNvPath(''); setNvSeed(true);
      setGraphKey((k) => k + 1); // force graph re-mount → re-fetch vaults
      reloadList();
    } catch (e: any) { toast.push(e.message, 'err'); }
    finally { setNvBusy(false); }
  }
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [note, setNote] = useState<any | null>(null);
  const [explorerOpen, setExplorerOpen] = useState<boolean>(() => lsGet('brain_explorer_open', '0') === '1');
  useEffect(() => { lsSet('brain_explorer_open', explorerOpen ? '1' : '0'); }, [explorerOpen]);
  // Goal satellite clicked in the 3D graph → open its detail in a dialog
  // without leaving the brain page.
  const [openGoalId, setOpenGoalId] = useState<number | null>(null);

  async function reloadList() {
    if (q) setItems(await api.brainSearch(q));
    else setItems(await api.brainIndexFiltered(filter));
  }
  useEffect(() => { reloadList(); /* eslint-disable-next-line */ }, [filter]);

  async function open(p: string) { setNote(await api.brainNote(p)); }

  // Deep-link: ?note=<path> opens the note on mount and switches to list tab (panel visible).
  const [sp, setSp] = useSearchParams();
  useEffect(() => {
    const np = sp.get('note');
    if (!np) return;
    setTab('list');
    open(np).catch(() => {});
    // Strip param after consuming so refresh doesn't loop
    const next = new URLSearchParams(sp);
    next.delete('note');
    setSp(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const FilterBar = (
    <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1">
      {(['all', 'public', 'protected'] as Filter[]).map((f) => (
        <Button key={f} size="sm" variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>
          {f === 'all' ? t('brain.all') : f === 'public' ? `◇ ${t('brain.publicLbl')}` : `◆ ${t('brain.protectedLbl')}`}
        </Button>
      ))}
    </div>
  );
  const OriginBar = (
    <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1 flex-wrap">
      <Button size="sm" variant={originFilter === 'all' ? 'primary' : 'ghost'} onClick={() => setOriginFilter('all')}>{t('brain.originsAll')}</Button>
      <Button size="sm" variant={originFilter === 'native' ? 'primary' : 'ghost'} onClick={() => setOriginFilter('native')}>{t('brain.originsMine')}</Button>
      {origins.map((e) => (
        <Button key={e} size="sm" variant={originFilter === e ? 'primary' : 'ghost'} onClick={() => setOriginFilter(e)}>
          <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: `hsl(${[...e].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) % 360}, 70%, 62%)` }} />
          {e}
        </Button>
      ))}
    </div>
  );
  const VaultBar = vaults.length >= 1 ? (
    <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-md p-1 flex-wrap">
      <Button size="sm" variant={vaultFilter === 'all' ? 'primary' : 'ghost'} onClick={() => setVaultFilter('all')}>🧠 {t('brain.vaultAll')}</Button>
      {vaults.map((v) => (
        <Button key={v} size="sm" variant={vaultFilter === v ? 'primary' : 'ghost'} onClick={() => setVaultFilter(v)}>{v}</Button>
      ))}
    </div>
  ) : null;

  return (
    <div className="space-y-5 h-full flex flex-col">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-gradient">{t('brain.title2')}</h1>
        <div className="flex items-center gap-2">
          <BrainProposals onApplied={() => { setGraphKey((k) => k + 1); reloadList(); }} />
          <Button size="sm" variant="ghost" onClick={() => setCreateOpen(true)}>+ Cervello</Button>
        </div>
      </div>
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {VaultBar}
        </div>
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          {FilterBar}
          <div className="flex gap-1 bg-surface2/70 border border-border rounded-md p-1">
            <Button variant={tab === 'graph' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('graph')}>{t('brain.viewGraph')}</Button>
            <Button variant={tab === 'list' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('list')}>{t('brain.viewList')}</Button>
          </div>
        </div>
      </div>

      {tab === 'graph' ? (
        <div className="flex flex-col xl:flex-row gap-0 flex-1 min-h-0">
          {explorerOpen && (
            <Card className="h-[40vh] xl:h-[78vh] shrink-0 p-0 overflow-hidden xl:rounded-r-none xl:border-r-0">
              <BrainFileExplorer
                selectedPath={note?.path ?? null}
                onSelect={(p) => open(p)}
                onClose={() => setExplorerOpen(false)}
                onDelete={async (p) => {
                  if (!await dlg.confirm(`Eliminare la nota "${p}"?\n\nIrreversibile.`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
                  try {
                    await api.brainNoteDelete(p);
                    toast.push('Nota eliminata', 'on');
                    if (note?.path === p) setNote(null);
                    setGraphKey((k) => k + 1);
                    reloadList();
                  } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
                }}
              />
            </Card>
          )}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 flex-1 min-w-0">
          <Card className={`xl:col-span-2 !p-0 !overflow-hidden h-[55vh] xl:h-[78vh] relative isolate min-w-0 ${explorerOpen ? 'xl:rounded-l-none' : ''}`}>
            <BrainGraph3DConstellation
              key={`3d-${graphKey}`}
              onSelect={open}
              onDeselect={() => setNote(null)}
              visibilityFilter={filter}
              originFilter={originFilter}
              vaultFilter={vaultFilter}
              onOriginsChange={setOrigins}
              onVaultsChange={setVaults}
              explorerOpen={explorerOpen}
              onToggleExplorer={() => setExplorerOpen((v) => !v)}
              focusId={note?.path ?? null}
              onGoalClick={setOpenGoalId}
            />
          </Card>
          <Card className="h-[55vh] xl:h-[78vh] overflow-y-auto">
            {!note ? (
              <BrainOverview />
            ) : (
              <NotePane
                note={note}
                onOpenWikilink={(t) => open(t.endsWith('.md') ? t : `${t}.md`)}
                onSaved={(updated) => setNote(updated)}
                onDelete={async () => {
                  if (!await dlg.confirm(`Eliminare la nota "${note.path}"?\n\nQuesta azione è irreversibile.`, { tone: 'danger', confirmLabel: 'Elimina' })) return;
                  try { await api.brainNoteDelete(note.path); toast.push('Nota eliminata', 'on'); setNote(null); setGraphKey((k) => k + 1); reloadList(); }
                  catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
                }}
              />
            )}
          </Card>
          </div>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Input placeholder={t('brain.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reloadList()} />
            <Button onClick={reloadList}>{t('brain.searchBtn')}</Button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="max-h-[70vh] overflow-y-auto">
              {items.length === 0 && <div className="text-muted-foreground text-sm">Empty.</div>}
              <ul className="space-y-2">
                {items.map((n) => (
                  <li key={n.path}>
                    <button
                      className={`w-full text-left p-3 rounded-2xl border transition hover:translate-x-0.5 ${
                        n.visibility === 'protected'
                          ? 'border-accent/30 bg-accent/5 hover:border-accent/60'
                          : n.visibility === 'public'
                          ? 'border-accent2/30 bg-accent2/5 hover:border-accent2/60'
                          : 'border-border bg-surface2/40 hover:border-accent/50'
                      }`}
                      onClick={() => open(n.path)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium truncate">{n.title || n.path}</div>
                        <div className="flex items-center gap-1">
                          {n.visibility === 'protected' && <Chip tone="accent">◆</Chip>}
                          {n.visibility === 'public' && <Chip tone="accent2">◇</Chip>}
                          <Chip>{n.kind}</Chip>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 font-mono truncate">{n.path}</div>
                      {n.summary && <div className="text-sm text-muted-foreground mt-1 line-clamp-2">{n.summary}</div>}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="max-h-[70vh] overflow-y-auto">
              {!note ? <div className="text-muted-foreground text-sm">Select a note.</div> : (
                <div>
                  <div className="text-xs text-muted-foreground font-mono mb-2">{note.path}</div>
                  <h2 className="text-lg font-semibold mb-3">{note.title || note.path}</h2>
                  <MarkdownView content={note.content} onWikilinkClick={(t) => open(t.endsWith('.md') ? t : `${t}.md`)} />
                </div>
              )}
            </Card>
          </div>
        </>
      )}

      <Modal
        open={createOpen}
        title="Nuovo cervello"
        onClose={() => setCreateOpen(false)}
        footer={<>
          <Button variant="ghost" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={createVault} disabled={!nvName || !nvPath || nvBusy}>{nvBusy ? '…' : t('settings.vaultCreate')}</Button>
        </>}
      >
        <div className="space-y-3">
          <Field label={t('settings.vaultName')}><Input value={nvName} onChange={(e) => setNvName(e.target.value)} placeholder="work / personal / …" /></Field>
          <Field label={t('settings.vaultNewPath')}><Input className="font-mono" value={nvPath} onChange={(e) => setNvPath(e.target.value)} placeholder="/Users/you/brain-work" /></Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={nvSeed} onChange={(e) => setNvSeed(e.target.checked)} />
            {t('settings.vaultSeed')}
          </label>
        </div>
      </Modal>

      {/* Goal dialog — satellite clicked in the 3D graph. Reuses the full
          /goals/:id component embedded, no navigation away from Brain. */}
      {openGoalId != null && createPortal(
        <div className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-md flex items-center justify-center p-4" onClick={() => setOpenGoalId(null)}>
          <div className="max-w-5xl w-full max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <Card className="!p-5">
              <GoalDetailPage goalId={openGoalId} embedded onClose={() => setOpenGoalId(null)} />
            </Card>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Editable note pane: read-only markdown render by default, "Modifica" switches
// to a textarea with autosize + Cmd/Ctrl+S to save + Esc to cancel.
function NotePane({
  note,
  onOpenWikilink,
  onSaved,
  onDelete,
}: {
  note: any;
  onOpenWikilink: (target: string) => void;
  onSaved: (updated: any) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(note.content ?? '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(note.content ?? ''); setEditing(false); }, [note.path]);
  const dirty = draft !== (note.content ?? '');
  async function save() {
    setSaving(true);
    try {
      await api.brainNoteSave(note.path, draft, note.data ?? {});
      onSaved({ ...note, content: draft });
      toast.push('Salvato', 'on');
      setEditing(false);
    } catch (e: any) { toast.push(e?.message ?? 'Errore', 'err'); }
    finally { setSaving(false); }
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { setDraft(note.content ?? ''); setEditing(false); }
  }
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground font-mono flex items-center gap-2 min-w-0">
          {note.data?.visibility === 'protected' && <Chip tone="accent">◆ {t('brain.protectedLabel')}</Chip>}
          {note.data?.visibility === 'public' && <Chip tone="accent2">◇ {t('brain.publicLabel')}</Chip>}
          <span className="truncate">{note.path}</span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(note.content ?? ''); setEditing(false); }} disabled={saving}>
                <XIcon size={13} className="mr-1" /> Annulla
              </Button>
              <Button size="sm" onClick={save} disabled={saving || !dirty}>
                <SaveIcon size={13} className="mr-1" /> {saving ? 'Salvo…' : 'Salva'}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Edit3 size={13} className="mr-1" /> Modifica
              </Button>
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>
                <Trash2 size={13} className="mr-1" /> Elimina
              </Button>
            </>
          )}
        </div>
      </div>
      <h2 className="text-lg font-semibold mb-3">{note.title || note.path}</h2>
      <div className="flex flex-wrap gap-1 mb-3">
        {(note.tags ?? []).map((tag: string) => <Chip key={tag}>{tag}</Chip>)}
      </div>
      {editing ? (
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          className="flex-1 min-h-[60vh] font-mono text-sm"
          placeholder="Scrivi qui in markdown — Cmd/Ctrl+S per salvare, Esc per annullare"
        />
      ) : (
        <MarkdownView content={note.content} onWikilinkClick={onOpenWikilink} />
      )}
    </div>
  );
}
