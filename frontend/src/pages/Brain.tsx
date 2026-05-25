import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Chip, Input } from '../components/ui';
import BrainGraph3D from '../components/BrainGraph3D';
import BrainGraph3DConstellation from '../components/BrainGraph3DConstellation';
import MarkdownView from '../components/MarkdownView';

type Tab = 'graph' | 'list';
type View = '2d' | '3d';
type Filter = 'all' | 'public' | 'protected';

export default function Brain() {
  const [tab, setTab] = useState<Tab>('graph');
  const [view, setView] = useState<View>(() => (typeof localStorage !== 'undefined' && localStorage.getItem('brain_view') === '3d' ? '3d' : '2d'));
  useEffect(() => { try { localStorage.setItem('brain_view', view); } catch {} }, [view]);
  const [filter, setFilter] = useState<Filter>('all');
  const [originFilter, setOriginFilter] = useState<string>('all');
  const [origins, setOrigins] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [note, setNote] = useState<any | null>(null);

  async function reloadList() {
    if (q) setItems(await api.brainSearch(q));
    else setItems(await api.brainIndexFiltered(filter));
  }
  useEffect(() => { reloadList(); /* eslint-disable-next-line */ }, [filter]);

  async function open(p: string) { setNote(await api.brainNote(p)); }

  const FilterBar = (
    <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-full p-1">
      {(['all', 'public', 'protected'] as Filter[]).map((f) => (
        <Button key={f} size="sm" variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>
          {f === 'all' ? 'All' : f === 'public' ? '◇ Public' : '◆ Protected'}
        </Button>
      ))}
    </div>
  );
  const OriginBar = (
    <div className="flex items-center gap-1 bg-surface2/70 border border-border rounded-full p-1 flex-wrap">
      <Button size="sm" variant={originFilter === 'all' ? 'primary' : 'ghost'} onClick={() => setOriginFilter('all')}>Origini: tutte</Button>
      <Button size="sm" variant={originFilter === 'native' ? 'primary' : 'ghost'} onClick={() => setOriginFilter('native')}>Solo mie</Button>
      {origins.map((e) => (
        <Button key={e} size="sm" variant={originFilter === e ? 'primary' : 'ghost'} onClick={() => setOriginFilter(e)}>
          <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: `hsl(${[...e].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) % 360}, 70%, 62%)` }} />
          {e}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="space-y-5 h-full flex flex-col">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-semibold text-gradient">Brain</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {FilterBar}
          <div className="flex gap-1 bg-surface2/70 border border-border rounded-full p-1">
            <Button variant={tab === 'graph' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('graph')}>Graph</Button>
            <Button variant={tab === 'list' ? 'primary' : 'ghost'} size="sm" onClick={() => setTab('list')}>List</Button>
          </div>
          {tab === 'graph' && (
            <div className="flex gap-1 bg-surface2/70 border border-border rounded-full p-1">
              <Button size="sm" variant={view === '2d' ? 'primary' : 'ghost'} onClick={() => setView('2d')}>2D</Button>
              <Button size="sm" variant={view === '3d' ? 'primary' : 'ghost'} onClick={() => setView('3d')}>✦ 3D</Button>
            </div>
          )}
        </div>
      </div>
      {tab === 'graph' && OriginBar}

      {tab === 'graph' ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 flex-1 min-h-0">
          <Card className="lg:col-span-2 p-0 overflow-hidden h-[78vh] relative">
            {view === '3d' ? (
              <BrainGraph3DConstellation
                onSelect={open}
                onDeselect={() => setNote(null)}
                visibilityFilter={filter}
                originFilter={originFilter}
                onOriginsChange={setOrigins}
              />
            ) : (
              <BrainGraph3D
                onSelect={open}
                onDeselect={() => setNote(null)}
                visibilityFilter={filter}
                originFilter={originFilter}
                onOriginsChange={setOrigins}
              />
            )}
          </Card>
          <Card className="h-[78vh] overflow-y-auto">
            {!note ? (
              <div className="text-muted text-sm">
                <p>Click a node to inspect the note.</p>
                <p className="mt-3 text-xs">◇ cyan = public · ◆ fuchsia = protected (managed by the Brain Classifier agent).</p>
              </div>
            ) : (
              <div>
                <div className="text-xs text-muted font-mono mb-2 flex items-center gap-2">
                  {note.data?.visibility === 'protected' && <Chip tone="accent">◆ protected</Chip>}
                  {note.data?.visibility === 'public' && <Chip tone="accent2">◇ public</Chip>}
                  <span>{note.path}</span>
                </div>
                <h2 className="text-lg font-semibold mb-3">{note.title || note.path}</h2>
                <div className="flex flex-wrap gap-1 mb-3">
                  {(note.tags ?? []).map((t: string) => <Chip key={t}>{t}</Chip>)}
                </div>
                <MarkdownView content={note.content} onWikilinkClick={(t) => open(t.endsWith('.md') ? t : `${t}.md`)} />
              </div>
            )}
          </Card>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Input placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reloadList()} />
            <Button onClick={reloadList}>Search</Button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="max-h-[70vh] overflow-y-auto">
              {items.length === 0 && <div className="text-muted text-sm">Empty.</div>}
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
                      <div className="text-xs text-muted mt-1 font-mono truncate">{n.path}</div>
                      {n.summary && <div className="text-sm text-muted mt-1 line-clamp-2">{n.summary}</div>}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            <Card className="max-h-[70vh] overflow-y-auto">
              {!note ? <div className="text-muted text-sm">Select a note.</div> : (
                <div>
                  <div className="text-xs text-muted font-mono mb-2">{note.path}</div>
                  <h2 className="text-lg font-semibold mb-3">{note.title || note.path}</h2>
                  <MarkdownView content={note.content} onWikilinkClick={(t) => open(t.endsWith('.md') ? t : `${t}.md`)} />
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
