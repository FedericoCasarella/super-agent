import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, RefreshCw, X, ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

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
  searchPlaceholder,
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
      // Strip HTML responses (404 default pages) — show concise message only.
      let msg = String(e?.message ?? e);
      if (/<!DOCTYPE|<html|<pre>/i.test(msg)) {
        const m = msg.match(/Cannot\s+\w+\s+\S+/i);
        msg = m ? m[0] : 'Errore di rete';
      }
      setErr(msg);
      setRows([]); setTotal(0);
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


  const showSearch = !!searchPlaceholder;

  return (
    <div className="space-y-3 flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 flex-wrap">
        {showSearch && (
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder={searchPlaceholder}
              className="pl-8"
            />
          </div>
        )}
        {activeFilterCount > 0 && (
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X size={12} className="inline mr-1 -mt-0.5" /> Reset ({activeFilterCount})
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={load} disabled={loading} title="Ricarica" className="ml-auto">
          <RefreshCw size={13} className={`${loading ? 'animate-spin' : ''}`} />
        </Button>
        {toolbar}
      </div>

      {chipFilters.map((f) => {
        const cur = filters[f.key] ?? [];
        return (
          <div key={f.key} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mr-1">{f.label}</span>
            {f.options.map((opt) => {
              const active = cur.includes(opt.value);
              return (
                <Badge
                  key={opt.value}
                  variant={active ? 'default' : 'outline'}
                  onClick={() => toggleFilter(f.key, opt.value, !!f.multi)}
                  className="cursor-pointer select-none"
                >
                  {opt.label}
                  {opt.count !== undefined && <span className="ml-1 opacity-60">{opt.count}</span>}
                </Badge>
              );
            })}
          </div>
        );
      })}

      <Card className="!p-0 overflow-hidden flex-1 min-h-0 flex flex-col">
        <div className="overflow-auto flex-1">
          <Table>
            <TableHeader className="sticky top-0 bg-card/95 backdrop-blur z-10">
              <TableRow>
                {columns.map((c) => {
                  const isSorted = sort?.key === c.key;
                  return (
                    <TableHead
                      key={c.key}
                      onClick={() => sortBy(c)}
                      className={`${c.width ?? ''} ${c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left'} ${c.sortable ? 'cursor-pointer hover:text-foreground' : ''}`}
                    >
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider">
                        {c.header}
                        {c.sortable && <ArrowUpDown size={9} className={isSorted ? 'text-primary' : 'opacity-40'} />}
                        {isSorted && <span className="text-[8px] text-primary">{sort!.dir === 'asc' ? '↑' : '↓'}</span>}
                      </span>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 && Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      <div className="h-3 rounded bg-muted animate-pulse" style={{ width: `${30 + ((i * c.key.length) % 50)}%` }} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!loading && err && (
                <TableRow><TableCell colSpan={columns.length} className="text-center text-destructive text-xs py-6">{err}</TableCell></TableRow>
              )}
              {!loading && !err && rows.length === 0 && (
                <TableRow><TableCell colSpan={columns.length} className="text-center text-muted-foreground text-xs py-8">{emptyText}</TableCell></TableRow>
              )}
              {rows.map((r) => (
                <TableRow
                  key={rowKey(r)}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  className={onRowClick ? 'cursor-pointer' : ''}
                >
                  {columns.map((c) => (
                    <TableCell key={c.key} className={c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}>
                      {c.render(r)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="border-t px-3 py-2 flex items-center justify-between text-xs text-muted-foreground">
          <div>
            {total > 0 ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} di ${total}` : '0'}
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(0); }}>
              <SelectTrigger className="h-7 w-[88px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}/pag</SelectItem>)}
              </SelectContent>
            </Select>
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
