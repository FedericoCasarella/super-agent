import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Clock, MessageSquare, Search, Mic, Inbox, Sparkles } from 'lucide-react';

type Range = '7d' | '30d' | '90d' | 'all';

type ReportData = {
  range: Range;
  timeSaved: {
    totalMin: number;
    breakdown: {
      replies: { min: number; count: number; byChannel: Record<string, number> };
      brain_searches: { min: number; count: number };
      ingestion: { min: number; count: number };
      voice: { min: number; count: number; dur_min: number };
    };
  };
  radar: {
    axes: string[];
    prima: number[];
    adesso: number[];
    metrics: Record<string, any>;
  };
};

function fmtDuration(min: number): { value: string; unit: string } {
  if (min < 60) return { value: String(min), unit: 'min' };
  const h = Math.floor(min / 60);
  if (h < 24) return { value: `${h}h ${min % 60}m`, unit: 'tempo' };
  const d = Math.floor(h / 24);
  return { value: `${d}g ${h % 24}h`, unit: 'tempo' };
}

const RANGE_LABEL: Record<Range, string> = {
  '7d': 'Ultimi 7 giorni',
  '30d': 'Ultimi 30 giorni',
  '90d': 'Ultimi 90 giorni',
  'all': 'Da sempre',
};

export default function ReportPage() {
  const [range, setRange] = useState<Range>('30d');
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.report(range).then((r) => { if (!cancelled) setData(r as ReportData); }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const dur = useMemo(() => data ? fmtDuration(data.timeSaved.totalMin) : { value: '—', unit: '' }, [data]);

  return (
    <div className="space-y-5 max-w-7xl mx-auto p-1">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gradient flex items-center gap-2"><Sparkles size={22} className="text-accent" /> Report</h1>
          <p className="text-xs text-muted-foreground mt-1">Tempo che super-agent ti ha fatto risparmiare e progresso operativo.</p>
        </div>
        <Select value={range} onValueChange={(v: any) => setRange(v)}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Intervallo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Ultimi 7 giorni</SelectItem>
            <SelectItem value="30d">Ultimi 30 giorni</SelectItem>
            <SelectItem value="90d">Ultimi 90 giorni</SelectItem>
            <SelectItem value="all">Da sempre</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Hero — tempo totale */}
      <Card className="p-6 bg-gradient-to-br from-accent/10 via-transparent to-accent2/10 border-accent/30">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="h-16 w-16 rounded-2xl bg-accent/15 flex items-center justify-center shrink-0">
            <Clock className="text-accent" size={30} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Hai risparmiato — {RANGE_LABEL[range]}
            </div>
            <div className="text-4xl font-semibold mt-1 text-foreground tabular-nums">{loading ? '…' : dur.value}</div>
            <div className="text-xs text-muted-foreground mt-1">
              Invece di farlo a mano, super-agent ha gestito comunicazioni, ricerche e ingestion al posto tuo.
            </div>
          </div>
        </div>
      </Card>

      {/* Breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <BreakdownCard
          icon={<MessageSquare size={16} />}
          label="Risposte automatiche"
          min={data?.timeSaved.breakdown.replies.min ?? 0}
          sub={`${data?.timeSaved.breakdown.replies.count ?? 0} messaggi inviati`}
          tone="accent"
          detail={data ? Object.entries(data.timeSaved.breakdown.replies.byChannel).map(([c, n]) => `${c}: ${n}`).join(' · ') : ''}
        />
        <BreakdownCard
          icon={<Search size={16} />}
          label="Ricerche nel brain"
          min={data?.timeSaved.breakdown.brain_searches.min ?? 0}
          sub={`${data?.timeSaved.breakdown.brain_searches.count ?? 0} lookup`}
          tone="accent2"
        />
        <BreakdownCard
          icon={<Inbox size={16} />}
          label="Ingestion & sync"
          min={data?.timeSaved.breakdown.ingestion.min ?? 0}
          sub={`${data?.timeSaved.breakdown.ingestion.count ?? 0} messaggi processati`}
          tone="success"
        />
        <BreakdownCard
          icon={<Mic size={16} />}
          label="Trascrizioni voce"
          min={data?.timeSaved.breakdown.voice.min ?? 0}
          sub={`${data?.timeSaved.breakdown.voice.count ?? 0} clip · ${data?.timeSaved.breakdown.voice.dur_min ?? 0} min audio`}
          tone="accent"
        />
      </div>

      {/* Radar */}
      <Card className="p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-foreground">Prima vs adesso — aree chiave</h2>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/60" /> Prima (cold start)</span>
            <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full bg-accent" /> Adesso</span>
          </div>
        </div>
        {data && <RadarChart axes={data.radar.axes} prima={data.radar.prima} adesso={data.radar.adesso} />}
      </Card>
    </div>
  );
}

function BreakdownCard({ icon, label, min, sub, tone, detail }: { icon: JSX.Element; label: string; min: number; sub: string; tone: 'accent' | 'accent2' | 'success'; detail?: string }) {
  const dur = fmtDuration(min);
  const toneCls = tone === 'accent' ? 'text-accent bg-accent/10' : tone === 'accent2' ? 'text-accent2 bg-accent2/10' : 'text-[hsl(var(--success))] bg-[hsl(var(--success))]/10';
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className={`h-9 w-9 rounded-lg ${toneCls} flex items-center justify-center shrink-0`}>{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold tabular-nums mt-0.5">{dur.value}</div>
          <div className="text-[11px] text-muted-foreground truncate">{sub}</div>
          {detail && <div className="text-[10px] text-muted-foreground/70 truncate mt-0.5">{detail}</div>}
        </div>
      </div>
    </Card>
  );
}

// SVG radar — interactive hover dot reveals value. Polygon for PRIMA (muted)
// + polygon for ADESSO (accent), grid rings 0/2/4/6/8/10.
// Large outer padding so 8-axis labels never clip; tooltip is quadrant-aware
// (flips to keep it inside the viewBox no matter which dot you hover).
function RadarChart({ axes, prima, adesso }: { axes: string[]; prima: number[]; adesso: number[] }) {
  const SIZE = 620;
  const CENTER = SIZE / 2;
  const MARGIN = 140; // space reserved for axis labels around the chart
  const RADIUS = SIZE / 2 - MARGIN;
  const MAX = 10;
  const N = axes.length;
  const [hover, setHover] = useState<{ i: number; series: 'prima' | 'adesso' } | null>(null);

  function angleFor(i: number) { return (Math.PI * 2 * i) / N - Math.PI / 2; }
  function pointFor(value: number, i: number) {
    const angle = angleFor(i);
    const r = (Math.max(0, Math.min(MAX, value)) / MAX) * RADIUS;
    return { x: CENTER + r * Math.cos(angle), y: CENTER + r * Math.sin(angle), angle };
  }
  function axisEnd(i: number) {
    const angle = angleFor(i);
    return { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle), angle };
  }

  const rings = [2, 4, 6, 8, 10];
  const primaPts = prima.map((v, i) => pointFor(v, i));
  const adessoPts = adesso.map((v, i) => pointFor(v, i));
  const primaPath = primaPts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z';
  const adessoPath = adessoPts.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + ' Z';

  return (
    <div className="flex items-center justify-center w-full">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" style={{ maxWidth: 680 }}>
        {/* grid rings */}
        {rings.map((r) => (
          <polygon
            key={r}
            points={Array.from({ length: N }, (_, i) => {
              const a = angleFor(i);
              const rr = (r / MAX) * RADIUS;
              return `${CENTER + rr * Math.cos(a)},${CENTER + rr * Math.sin(a)}`;
            }).join(' ')}
            fill="none"
            stroke="hsl(var(--border))"
            strokeOpacity={0.4}
            strokeWidth={0.8}
          />
        ))}
        {/* ring scale labels (vertical axis) */}
        {rings.map((r) => (
          <text key={`l-${r}`} x={CENTER + 4} y={CENTER - (r / MAX) * RADIUS} fontSize="10" fill="hsl(var(--muted-foreground))" opacity={0.55}>{r}</text>
        ))}
        {/* axis lines */}
        {axes.map((_, i) => {
          const p = axisEnd(i);
          return <line key={i} x1={CENTER} y1={CENTER} x2={p.x} y2={p.y} stroke="hsl(var(--border))" strokeOpacity={0.5} strokeWidth={0.8} />;
        })}
        {/* PRIMA polygon */}
        <path d={primaPath} fill="hsl(var(--muted-foreground))" fillOpacity={0.18} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.7} strokeWidth={1.4} />
        {/* ADESSO polygon */}
        <path d={adessoPath} fill="hsl(var(--accent))" fillOpacity={0.28} stroke="hsl(var(--accent))" strokeWidth={1.8} />
        {/* dots PRIMA */}
        {primaPts.map((p, i) => (
          <circle
            key={`pp-${i}`}
            cx={p.x} cy={p.y} r={4}
            fill="hsl(var(--muted-foreground))"
            onMouseEnter={() => setHover({ i, series: 'prima' })}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        {/* dots ADESSO */}
        {adessoPts.map((p, i) => (
          <circle
            key={`ap-${i}`}
            cx={p.x} cy={p.y} r={5.5}
            fill="hsl(var(--accent))"
            stroke="hsl(var(--background))"
            strokeWidth={1.5}
            onMouseEnter={() => setHover({ i, series: 'adesso' })}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
        {/* axis labels — pushed outside the radius, anchor flipped by quadrant */}
        {axes.map((label, i) => {
          const p = axisEnd(i);
          const dx = p.x - CENTER;
          const dy = p.y - CENTER;
          const len = Math.hypot(dx, dy) || 1;
          const lx = p.x + (dx / len) * 30;
          const ly = p.y + (dy / len) * 30;
          const anchor = dx > 6 ? 'start' : dx < -6 ? 'end' : 'middle';
          return (
            <g key={`lab-${i}`}>
              <text x={lx} y={ly} fontSize="12" fontWeight={600} fill="hsl(var(--foreground))" textAnchor={anchor} dominantBaseline="middle">{label}</text>
              <text x={lx} y={ly + 15} fontSize="11" fill="hsl(var(--muted-foreground))" textAnchor={anchor} dominantBaseline="middle" className="tabular-nums">
                {prima[i]} → <tspan fill="hsl(var(--accent))" fontWeight={700}>{adesso[i]}</tspan>
              </text>
            </g>
          );
        })}
        {/* hover tooltip — quadrant-aware so it never clips */}
        {hover && (() => {
          const p = hover.series === 'prima' ? primaPts[hover.i] : adessoPts[hover.i];
          const value = hover.series === 'prima' ? prima[hover.i] : adesso[hover.i];
          const seriesLabel = hover.series === 'prima' ? 'Prima' : 'Adesso';
          const TW = 100, TH = 36;
          // Place tooltip on the SIDE of the dot that faces the center, so it
          // sits over the chart body (always visible) instead of off-canvas.
          const towardCenterX = CENTER - p.x; // >0 means center is to the right
          const towardCenterY = CENTER - p.y;
          const tx = towardCenterX >= 0 ? p.x + 10 : p.x - TW - 10;
          const ty = towardCenterY >= 0 ? p.y + 10 : p.y - TH - 10;
          return (
            <g pointerEvents="none">
              <rect x={tx} y={ty} width={TW} height={TH} rx={6} fill="hsl(var(--popover))" stroke="hsl(var(--border))" />
              <text x={tx + 10} y={ty + 8} fontSize="10" fill="hsl(var(--muted-foreground))" dominantBaseline="hanging">{seriesLabel}</text>
              <text x={tx + 10} y={ty + 22} fontSize="13" fontWeight={700} fill="hsl(var(--foreground))" dominantBaseline="hanging">
                {value} <tspan fill="hsl(var(--muted-foreground))" fontWeight={400} fontSize="11">/ 10</tspan>
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}
