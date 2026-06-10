import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

// Static labels for every known path segment. Detail-page dynamic crumbs
// (es. team task name) are pushed via `useSetBreadcrumb` from inside the page.
const STATIC_LABELS: Record<string, string> = {
  '': 'Live',
  'connectors': 'Connettori',
  'brain': 'Brain',
  'roadmap': 'Roadmap',
  'tasks': 'Tasks',
  'team-tasks': 'Team task',
  'agents': 'Agents',
  'perks': 'Perks',
  'whatsapp': 'WhatsApp',
  'instagram': 'Instagram',
  'mail': 'Email',
  'people': 'People',
  'teams': 'Teams',
  'flows': 'Flows',
  'outbound': 'Inviati',
  'logs': 'Logs',
  'snapshots': 'Snapshot',
  'report': 'Report',
  'settings': 'Impostazioni',
  'network': 'Network',
};

export type Crumb = { label: string; to?: string };

type BreadcrumbsCtx = {
  override: Crumb[] | null;
  setOverride: (crumbs: Crumb[] | null) => void;
};

const Ctx = createContext<BreadcrumbsCtx>({ override: null, setOverride: () => {} });

export function BreadcrumbsProvider({ children }: { children: ReactNode }) {
  const [override, setOverride] = useState<Crumb[] | null>(null);
  return <Ctx.Provider value={{ override, setOverride }}>{children}</Ctx.Provider>;
}

// Page-level hook: call inside useEffect to push custom crumbs (es. dynamic
// title from a loaded record). Pass `null` to revert to the static path-based
// crumbs. The effect cleanup auto-clears on unmount.
export function useSetBreadcrumb(crumbs: Crumb[] | null) {
  const { setOverride } = useContext(Ctx);
  useEffect(() => {
    setOverride(crumbs);
    return () => setOverride(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(crumbs)]);
}

function deriveFromPath(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [{ label: STATIC_LABELS[''], to: '/' }];
  const out: Crumb[] = [];
  let cur = '';
  for (let i = 0; i < segments.length; i++) {
    cur += '/' + segments[i];
    const known = STATIC_LABELS[segments[i]];
    const isLast = i === segments.length - 1;
    out.push({ label: known ?? segments[i], to: isLast ? undefined : cur });
  }
  return out;
}

export function Breadcrumbs() {
  const { override } = useContext(Ctx);
  const location = useLocation();
  const crumbs = useMemo<Crumb[]>(() => override ?? deriveFromPath(location.pathname), [override, location.pathname]);
  if (!crumbs.length) return null;
  return (
    <nav aria-label="breadcrumb" className="flex items-center gap-1 text-sm min-w-0">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1 min-w-0">
            {i > 0 && <ChevronRight size={12} className="text-muted-foreground/50 shrink-0" />}
            {c.to && !last ? (
              <Link to={c.to} className="text-muted-foreground hover:text-foreground transition truncate">{c.label}</Link>
            ) : (
              <span className={`truncate ${last ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>{c.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
