import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, RefreshCw, X, ArrowUpDown } from 'lucide-react';
import { Button, Card, Input } from './ui';

// Generic server-paginated table with chip filters. One source of truth for
// recent-agents / perks / people / outbound / logs pages so they look + feel
// identical. Each consumer just supplies a fetcher + columns + chip filter
// definitions; pagination, sort, debounced search, and refresh are handled here.

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  width?: string;          // tailwind class e.g. "w-32"
  sortable?: boolean;
  align?: 'left' | 'right' | 'center';
};

export type ChipOption = { value: string; label: ReactNode; count?: number; tone?: 'default' | 'accent' | 'accent2' | 'on' | 'warn' | 'err' };

export type ChipFilter = {
  key: string;
  label: string;
  options: ChipOption[];
  multi?: boolean;
};

export type FetchParams = {
  q: string;
  page: number;
  pageSize: number;
  filters: Record<string, string[]>;
  sort?: { key: string; dir: 'asc' | 'desc' };
};

export type FetchResult<T> = { rows: T[]; total: number };

export default function DataTable<T>({
  fetcher,
  columns,
  chipFilters = [],
  searchPlaceholder = 'Cerca…',
  rowKey,
  onRowClick,
  refreshKey,
  pageSize: defaultPageSize = 25,
  emptyText = 'Nessun risultato.',
  toolbar,
  loadOnMount = true,
}: {
  fetcher: (params: FetchParams) => Promise<FetchResult<T>>;
  columns: Column<T>[];
  chipFilters?: ChipFilter[];
  searchPlaceholder?: string;
  rowKey: (r: T) => string | number;
  onRowClick?: (r: T) => void;
  refreshKey?: any;
  pageSize?: number;
  emptyText?: string;
  toolbar?: ReactNode;
  loadOnMount?: boolean;
}) {
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reqId = useRef(0);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => { setQ(qInput.trim()); setPage(0); }, 250);
    return () => clearTimeout(t);
  }, [qInput]);

  async function load() {
    const id = ++reqId.current;
    setLoading(true); setErr(null);
    try {
      const r = await fetcher({ q, page, pageSize, filters, sort: sort ?? undefined });
      if (id !== reqId.current) return; // stale
      setRows(r.rows ?? []);
      setTotal(r.total ?? 0);
    } catch (e: any) {
      if (id !== reqId.current) return;
      setErr(String(e?.message ?? e));
    }
    finally { if (id === reqId.current) setLoading(false); }
  }

  useEffect(() => {
    if (!loadOnMount && page === 0 && !q && Object.keys(filters).length === 0 && !sort) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, page, pageSize, JSON.stringify(filters), JSON.stringify(sort), refreshKey]);

  function toggleFilter(key: string, value: string, multi: boolean) {
    setPage(0);
    setFilters((prev) => {
      const cur = prev[key] ?? [];
      const has = cur.includes(value);
      let nextVals: string[];
      if (multi) {
        nextVals = has ? cur.filter((v) => v !== value) : [...cur, value];
      } else {
        nextVals = has ? [] : [value];
      }
      const next = { ...prev };
      if (nextVals.length) next[key] = nextVals; else delete next[key];
      return next;
    });
  }

  function clearFilters() {
    setFilters({});
    setQ(''); setQInput('');
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilterCount = useMemo(() => Object.values(filters).reduce((n, v) => n + v.length, 0), [filters]);

  function sortBy(col: Column<T>) {
    if (!col.sortable) return;
    setPage(0);
    setSort((cur) => {
      if (!cur || cur.key !== col.key) return { key: col.key, dir: 'asc' };
      if (cur.dir === 'asc') return { key: col.key, dir: 'desc' };
      return null;
    });
  }

  const toneClasses = (tone?: ChipOption['tone']) => {
    switch (tone) {
      case 'accent': return 'bg-accent/15 border-accent/40 text-accent';
      case 'accent2': return 'bg-accent2/15 border-accent2/40 text-accent2';
      case 'on': return 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300';
      case 'warn': return 'bg-amber-500/15 border-amber-400/40 text-amber-300';
      case 'err': return 'bg-red-500/15 border-red-400/40 text-red-300';
      default: return 'bg-surface2 border-border text-muted hover:text-text';
    }
  };

  return (
    <div className="space-y-3 flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-8"
          />
        </div>
        {activeFilterCount > 0 && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X size={12} className="inline mr-1 -mt-0.5" /> Reset ({activeFilterCount})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={load} disabled={loading} title="Ricarica">
          <RefreshCw size={13} className={`${loading ? 'animate-spin' : ''}`} />
        </Button>
        {toolbar}
      </div>

      {chipFilters.map((f) => {
        const cur = filters[f.key] ?? [];
        return (
          <div key={f.key} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-muted font-semibold mr-1">{f.label}</span>
            {f.options.map((opt) => {
              const active = cur.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  onClick={() => toggleFilter(f.key, opt.value, !!f.multi)}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition ${active ? toneClasses(opt.tone ?? 'accent') : 'bg-surface2/40 border-border text-muted hover:text-text'}`}
                >
                  {opt.label}
                  {opt.count !== undefined && <span className="ml-1 opacity-60">{opt.count}</span>}
                </button>
              );
            })}
          </div>
        );
      })}

      <Card className="!p-0 overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface/95 backdrop-blur z-10">
              <tr className="border-b border-border">
                {columns.map((c) => {
                  const isSorted = sort?.key === c.key;
                  return (
                    <th
                      key={c.key}
                      onClick={() => sortBy(c)}
                      className={`px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-semibold ${c.width ?? ''} ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'} ${c.sortable ? 'cursor-pointer hover:text-text' : ''}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {c.header}
                        {c.sortable && <ArrowUpDown size={9} className={isSorted ? 'text-accent' : 'opacity-40'} />}
                        {isSorted && <span className="text-[8px] text-accent">{sort!.dir === 'asc' ? '↑' : '↓'}</span>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && Array.from({ length: 8 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-border/40">
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-2">
                      <div className="h-3 rounded bg-surface2 animate-pulse" style={{ width: `${30 + ((i * c.key.length) % 50)}%` }} />
                    </td>
                  ))}
                </tr>
              ))}
              {!loading && err && (
                <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-red-400 text-xs">{err}</td></tr>
              )}
              {!loading && !err && rows.length === 0 && (
                <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-muted text-xs">{emptyText}</td></tr>
              )}
              {rows.map((r) => (
                <tr
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={`border-b border-border/40 ${onRowClick ? 'cursor-pointer hover:bg-surface2/50' : ''} transition`}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-3 py-2 flex items-center justify-between text-xs text-muted">
          <div>
            {total > 0 ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} di ${total}` : '0'}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={pageSize}
              onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
              className="bg-bg border border-border rounded px-2 py-0.5 text-xs"
            >
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}/pag</option>)}
            </select>
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading}>
              <ChevronLeft size={14} />
            </Button>
            <span>{page + 1} / {totalPages}</span>
            <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page + 1 >= totalPages || loading}>
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
