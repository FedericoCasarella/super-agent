import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ChevronRight, ChevronDown, File as FileIcon, Folder, FolderOpen, Search, X } from 'lucide-react';

// Obsidian-style file explorer. Renders vault files as a nested folder tree.
// Click a file → calls onSelect(relPath). Caller wires that to graph focus
// + preview pane. Persists expanded-folders + filter state in localStorage so
// the tree feels stable across sessions.

type TreeNode =
  | { kind: 'file'; name: string; path: string }
  | { kind: 'dir'; name: string; path: string; children: TreeNode[] };

function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { kind: 'dir', name: '', path: '', children: [] };
  for (const f of files) {
    // File id may be `<vault>::<relPath>` (multi-vault). Use vault name as
    // the top-level folder so the tree groups by vault. The leaf `path` keeps
    // the full id so backend /brain/note?path=... resolves correctly.
    const sepIdx = f.indexOf('::');
    const vault = sepIdx >= 0 ? f.slice(0, sepIdx) : null;
    const rel = sepIdx >= 0 ? f.slice(sepIdx + 2) : f;
    const parts = vault ? [vault, ...rel.split('/')] : rel.split('/');
    let cur = root as Extract<TreeNode, { kind: 'dir' }>;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const name = parts[i];
      if (isLast) {
        cur.children.push({ kind: 'file', name: name.replace(/\.md$/, ''), path: f });
      } else {
        let next = cur.children.find((c): c is Extract<TreeNode, { kind: 'dir' }> => c.kind === 'dir' && c.name === name);
        if (!next) {
          // Folder display path: just the cumulative segments (used for
          // expand/collapse state). NOT used for fetch.
          const segPath = parts.slice(0, i + 1).join('/');
          next = { kind: 'dir', name, path: segPath, children: [] };
          cur.children.push(next);
        }
        cur = next;
      }
    }
  }
  function sort(n: TreeNode) {
    if (n.kind === 'dir') {
      n.children.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      n.children.forEach(sort);
    }
  }
  sort(root);
  return (root as Extract<TreeNode, { kind: 'dir' }>).children;
}

function filterTree(nodes: TreeNode[], term: string): TreeNode[] {
  if (!term) return nodes;
  const t = term.toLowerCase();
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'file') {
      if (n.path.toLowerCase().includes(t) || n.name.toLowerCase().includes(t)) out.push(n);
    } else {
      const kids = filterTree(n.children, t);
      if (kids.length || n.name.toLowerCase().includes(t)) out.push({ ...n, children: kids });
    }
  }
  return out;
}

function lsGet(key: string, fallback: string[]): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set(fallback);
    return new Set(JSON.parse(raw));
  } catch { return new Set(fallback); }
}
function lsSet(key: string, s: Set<string>) { try { localStorage.setItem(key, JSON.stringify(Array.from(s))); } catch {} }

export default function BrainFileExplorer({
  selectedPath, onSelect, onClose,
}: {
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => lsGet('brain_tree_expanded', ['projects', 'people']));
  useEffect(() => { lsSet('brain_tree_expanded', expanded); }, [expanded]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.brainTree();
        if (!cancelled) setFiles(r.files ?? []);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-expand ancestors of the currently-selected path so it's visible
  // when caller focuses a node from the graph.
  useEffect(() => {
    if (!selectedPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      const parts = selectedPath.split('/');
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'));
      return next;
    });
  }, [selectedPath]);

  const tree = useMemo(() => filterTree(buildTree(files), q.trim()), [files, q]);
  const isExpanded = (p: string) => expanded.has(p) || q.trim().length > 0;
  function toggle(p: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  function renderNode(n: TreeNode, depth: number): JSX.Element {
    const pad = { paddingLeft: `${depth * 12 + 6}px` };
    if (n.kind === 'file') {
      const active = selectedPath === n.path;
      return (
        <button
          key={n.path}
          onClick={() => onSelect(n.path)}
          className={`w-full text-left text-xs py-1 pr-2 flex items-center gap-1.5 hover:bg-surface2 transition ${active ? 'bg-accent/15 text-accent' : 'text-text'}`}
          style={pad}
          title={n.path}
        >
          <FileIcon size={12} className="shrink-0 text-muted" />
          <span className="truncate">{n.name}</span>
        </button>
      );
    }
    const open = isExpanded(n.path);
    return (
      <div key={n.path}>
        <button
          onClick={() => toggle(n.path)}
          className="w-full text-left text-xs py-1 pr-2 flex items-center gap-1.5 hover:bg-surface2 transition text-muted"
          style={pad}
        >
          {open ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
          {open ? <FolderOpen size={12} className="shrink-0 text-accent2" /> : <Folder size={12} className="shrink-0 text-accent2" />}
          <span className="truncate font-medium">{n.name}</span>
        </button>
        {open && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-w-[240px] w-[280px]">
      <div className="p-2 border-b border-border flex items-center gap-1.5">
        <Search size={12} className="text-muted shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtra file…"
          className="flex-1 bg-transparent text-xs focus:outline-none placeholder:text-muted"
        />
        <button onClick={onClose} className="text-muted hover:text-text transition shrink-0" title="Chiudi">
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {loading && <div className="px-3 py-2 text-xs text-muted">Caricamento…</div>}
        {!loading && tree.length === 0 && <div className="px-3 py-2 text-xs text-muted">Nessun file.</div>}
        {!loading && tree.map((n) => renderNode(n, 0))}
      </div>
      <div className="border-t border-border px-2 py-1 text-[10px] text-muted">
        {files.length} file totali
      </div>
    </div>
  );
}
