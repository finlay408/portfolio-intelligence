/**
 * The building blocks every page is made of, in the overview's scoreboard
 * style: a headline figure first, the S&P 500's equivalent beside it, and the
 * explanation one tap away rather than on the page.
 *
 * Server components throughout; the only client code is inside the charts
 * they wrap.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ScoreChart, ScoreLegend, type ScorePoint } from './score-chart';
import { Sparkline } from './sparkline';
import { WindowPicker } from './window-picker';
import { cn } from './ui/primitives';
import type { WindowKey } from '@/lib/engine/windows';
import { directionClass, percent, shortDate } from '@/lib/format';
import { macroTone, visibleChange, type MacroSpec } from '@/lib/market-views';
import type { MacroTile } from '@/lib/portfolio';

/** Percentage-point difference, e.g. "+1.8 pts". */
export const pts = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)} pts`;

/** The page's title, its window picker when it has one, and an optional action on the right. */
export function PageHead({
  title,
  window,
  basePath,
  action,
}: {
  title: string;
  window?: WindowKey;
  basePath?: string;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-3 pt-1">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[28px] font-semibold tracking-tight">{title}</h1>
        {action}
      </div>
      {window && basePath && <WindowPicker current={window} basePath={basePath} size="full" />}
    </div>
  );
}

/** A rounded panel with a tappable title linking to more detail, and a quiet meta line on the right. */
export function Section({
  id,
  title,
  href,
  meta,
  className,
  children,
}: {
  id?: string;
  title: string;
  href?: string;
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={cn('scroll-mt-16 space-y-3.5 rounded-2xl bg-surface p-4', className)}>
      <header className="flex items-baseline justify-between gap-3">
        {href ? (
          <Link href={href} className="text-[17px] font-semibold hover:text-accent">
            {title} <span className="text-muted">›</span>
          </Link>
        ) : (
          <h2 className="text-[17px] font-semibold">{title}</h2>
        )}
        {meta && <span className="truncate text-[11px] text-muted">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

/** One big number in a card of its own. */
export function Tile({
  label,
  value,
  valueTone,
  sub,
  href,
}: {
  label: string;
  value: string;
  valueTone?: string;
  sub?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span className="text-[12px] text-muted">{label}</span>
      <span className={cn('text-[28px] font-semibold leading-tight tracking-tight', valueTone)}>{value}</span>
      {sub && <span className="text-[12px] text-ink-2">{sub}</span>}
    </>
  );
  const className = 'flex flex-col gap-1 rounded-2xl bg-surface p-3.5';
  return href ? (
    <Link href={href} className={cn(className, 'active:bg-surface-2')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** A labelled figure inside a section, smaller than a tile. */
export function Figure({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone?: string;
  href?: string;
}) {
  const body = (
    <>
      <div className="text-[11px] tracking-wide text-muted">{label}</div>
      <div className={cn('text-[20px] font-semibold', tone)}>{value}</div>
    </>
  );
  return href ? <Link href={href}>{body}</Link> : <div>{body}</div>;
}

/** You as a bar, the index as a tick on the same scale. */
export function VersusBar({
  label,
  you,
  market,
  scale,
  format = (v) => percent(v, 1),
}: {
  label: string;
  you: number | null;
  market: number | null;
  /** The magnitude that fills the whole bar. */
  scale: number;
  format?: (v: number | null) => string;
}) {
  const pos = (v: number) => `${Math.min(100, (Math.abs(v) / scale) * 100)}%`;
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-[12px] text-ink-2">
        <span>{label}</span>
        <span>
          {format(you)} <span className="text-muted">vs S&amp;P</span> {format(market)}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-surface-2">
        {you !== null && <div className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: pos(you) }} />}
        {market !== null && <div className="absolute -top-1 h-4 w-0.5 bg-accent" style={{ left: pos(market) }} />}
      </div>
    </div>
  );
}

/** Horizontal scroll of in-page jump links, for long pages on a phone. */
export function JumpLinks({ items }: { items: Array<[href: string, label: string]> }) {
  return (
    <nav aria-label="Sections" className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 md:hidden">
      {items.map(([href, label]) => (
        <a key={href} href={href} className="shrink-0 rounded-full bg-surface px-3.5 py-2 text-[13px] text-ink">
          {label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The race: your cumulative return against the S&P 500 in pounds over the
 * window, with the three figures it is read by underneath.
 */
export function RaceCard({
  data,
  windowLabel,
  ret,
  mwr,
  marketRet,
  active,
  href,
}: {
  data: ScorePoint[];
  windowLabel: string;
  ret: { toNumber(): number } | number | null;
  mwr: number | null;
  marketRet: number | null | undefined;
  active: number | null | undefined;
  href?: string;
}) {
  const asNumber = ret === null ? null : typeof ret === 'number' ? ret : ret.toNumber();
  return (
    <section className="space-y-3 rounded-2xl bg-surface p-4">
      <div className="flex items-baseline justify-between">
        <ScoreLegend marketLabel="S&P 500 £" />
        <span className={cn('text-[14px] font-semibold', directionClass(active))}>{pts(active)}</span>
      </div>
      <ScoreChart data={data} marketLabel="S&P 500 £" />
      <div className="grid grid-cols-3 gap-2">
        <Figure label={`TWR · ${windowLabel}`} value={percent(asNumber, 1, { signed: true })} tone={directionClass(asNumber)} href={href} />
        <Figure label="MWR · all" value={percent(mwr, 1, { signed: true })} tone={directionClass(mwr)} href={href} />
        <Figure label={`S&P £ · ${windowLabel}`} value={percent(marketRet, 1, { signed: true })} tone="text-ink-2" />
      </div>
    </section>
  );
}

/** A FRED series: latest value, its ~1 month move coloured by impact, and where it has been. */
export function MacroCard({ spec, tile, tall }: { spec: MacroSpec; tile: MacroTile; tall?: boolean }) {
  const change = visibleChange(spec, tile.change);
  return (
    <div className="rounded-xl bg-surface-2/60 p-3">
      <div className="truncate text-[12px] text-muted">{spec.label}</div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn('font-semibold', tall ? 'text-[24px]' : 'text-[20px]')}>
          {tile.latest === null ? '—' : `${tile.latest.toFixed(spec.decimals)}${spec.unit}`}
        </span>
        <span className={cn('text-[12px]', macroTone(spec, change))}>
          {change === null ? '—' : `${change > 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(spec.decimals)}`}
        </span>
      </div>
      <Sparkline values={tile.recent} className={cn('mt-1', tall && 'h-10')} />
      {tall && tile.latestDate && <div className="mt-1 text-right text-[10px] text-muted">{shortDate(tile.latestDate)}</div>}
    </div>
  );
}

/**
 * Labelled bars on one shared scale, for weights: the bar is the share, the
 * number is the share. No colour, because a weight has no direction.
 */
export function WeightBars({
  rows,
  limit = 8,
}: {
  rows: Array<{ key: string; label: string; weight: number; href?: string }>;
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((a, r) => a + r.weight, 0);
  const max = Math.max(...shown.map((r) => r.weight), 1e-9);
  const all = rest > 0 ? [...shown, { key: '__rest', label: `${rows.length - limit} others`, weight: rest }] : shown;
  return (
    <ul className="space-y-2">
      {all.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,7.5rem)_1fr_3rem] items-center gap-3 text-[13px]">
          <span className={cn('truncate', r.key === '__rest' && 'text-muted')}>{r.label}</span>
          <span className="h-2 rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full bg-ink-2"
              style={{ width: `${(Math.min(r.weight, max) / max) * 100}%` }}
            />
          </span>
          <span className="text-right text-ink-2">{percent(r.weight, 1)}</span>
        </li>
      ))}
    </ul>
  );
}
