'use client';

/**
 * Calendar-period returns, portfolio beside benchmark.
 *
 * Paired bars answer the question the heatmap cannot: not just "was March
 * good" but "was March good relative to the market". Each period's return is
 * compounded within the period, so the bars multiply back to the headline.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisProps, gridProps, pct0, signedPct2, tooltipProps } from './chart-theme';

export interface CalendarRow {
  period: string;
  portfolio: number;
  benchmark: number | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function periodTick(p: string): string {
  // '2026-03' → 'Mar 26'; '2026-Q1' → 'Q1 26'; '2026' → '2026'
  if (/^\d{4}-\d{2}$/.test(p)) return `${MONTHS[Number(p.slice(5, 7)) - 1]} ${p.slice(2, 4)}`;
  if (/^\d{4}-Q\d$/.test(p)) return `${p.slice(5)} ${p.slice(2, 4)}`;
  return p;
}

export function CalendarBarChart({
  rows,
  benchmarkLabel,
}: {
  rows: CalendarRow[];
  benchmarkLabel: string | null;
}) {
  if (rows.length === 0) {
    return <p className="px-4 py-8 text-center text-[12px] text-muted">No completed periods yet.</p>;
  }
  const hasBenchmark = benchmarkLabel !== null && rows.some((r) => r.benchmark !== null);

  return (
    <div className="px-1 py-2 sm:px-2 sm:py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-accent/80" /> Portfolio
        </span>
        {hasBenchmark && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-3 rounded-sm bg-muted/60" /> {benchmarkLabel}
          </span>
        )}
      </div>
      <div className="h-44 sm:h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="25%">
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="period" {...axisProps} tickFormatter={periodTick} minTickGap={12} interval="preserveStartEnd" />
            <YAxis {...axisProps} tickFormatter={pct0} width={42} domain={['auto', 'auto']} />
            <ReferenceLine y={0} stroke="var(--color-line-strong)" />
            <Tooltip
              {...tooltipProps}
              cursor={{ fill: 'var(--color-surface-2)' }}
              labelFormatter={(p) => periodTick(String(p))}
              formatter={(v: number, key: string) => [
                signedPct2(v),
                key === 'portfolio' ? 'Portfolio' : (benchmarkLabel ?? 'Benchmark'),
              ]}
            />
            <Bar dataKey="portfolio" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {rows.map((r) => (
                <Cell key={r.period} fill={r.portfolio < 0 ? 'var(--color-down)' : 'var(--color-up)'} fillOpacity={0.8} />
              ))}
            </Bar>
            {hasBenchmark && (
              <Bar dataKey="benchmark" fill="var(--color-muted)" fillOpacity={0.5} isAnimationActive={false} radius={[2, 2, 0, 0]} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
