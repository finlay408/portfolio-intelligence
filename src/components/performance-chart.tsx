'use client';

/**
 * Cumulative TWR against the benchmark, with drawdown beneath.
 *
 * Recharts rather than D3 here: it is a standard time series, and the custom
 * work belongs in the RRG (§4). The drawdown panel sits underneath rather than
 * on a second axis, because a shared axis makes a 5% drawdown look like a 5%
 * return and they are not comparable quantities.
 *
 * Both lines are rebased to zero at the start of the selected window, so the
 * gap between them at the right-hand edge is the active return for the window
 * — the same number the "versus the index" figure reports.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PerformancePoint } from '@/lib/engine/windows';
import {
  SECONDARY_STROKES,
  axisProps,
  fullDate,
  gridProps,
  makeDateTick,
  pct0,
  signedPct2,
  tooltipProps,
} from './chart-theme';

export function PerformanceChart({
  data,
  benchmarkKeys,
}: {
  data: PerformancePoint[];
  /** Benchmark display names, in the order they should be drawn. */
  benchmarkKeys: string[];
}) {
  if (data.length < 2) {
    return (
      <p className="px-4 py-8 text-center text-[12px] text-muted">
        Not enough history in this window to plot.
      </p>
    );
  }

  const flat = data.map((p) => ({
    date: p.date,
    portfolio: p.portfolio,
    drawdown: p.drawdown,
    ...Object.fromEntries(benchmarkKeys.map((k, i) => [`b${i}`, p.benchmarks[k] ?? null])),
  }));
  const tick = makeDateTick(data.map((p) => p.date));
  const names: Record<string, string> = {
    portfolio: 'Portfolio',
    drawdown: 'Drawdown',
    ...Object.fromEntries(benchmarkKeys.map((k, i) => [`b${i}`, k])),
  };

  return (
    <div className="px-1 py-2 sm:px-2 sm:py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-[11px] text-muted">
        <LegendSwatch stroke="var(--color-accent)" label="Portfolio (TWR)" />
        {benchmarkKeys.map((k, i) => (
          <LegendSwatch key={k} stroke={SECONDARY_STROKES[i] ?? 'var(--color-muted)'} label={k} dashed={i > 0} />
        ))}
      </div>

      <div className="h-48 sm:h-60">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={flat} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={40} tickFormatter={tick} />
            <YAxis {...axisProps} tickFormatter={pct0} width={42} domain={['auto', 'auto']} />
            <ReferenceLine y={0} stroke="var(--color-line-strong)" />
            <Tooltip
              {...tooltipProps}
              labelFormatter={(d) => fullDate(String(d))}
              formatter={(v: number, key: string) => [signedPct2(v), names[key] ?? key]}
            />
            {benchmarkKeys.map((k, i) => (
              <Line
                key={k}
                type="monotone"
                dataKey={`b${i}`}
                stroke={SECONDARY_STROKES[i] ?? 'var(--color-muted)'}
                strokeWidth={1.25}
                strokeDasharray={i > 0 ? '3 3' : undefined}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            <Line
              type="monotone"
              dataKey="portfolio"
              stroke="var(--color-accent)"
              strokeWidth={1.75}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="h-20 sm:h-24">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={flat} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={40} hide />
            <YAxis {...axisProps} tickFormatter={pct0} width={42} />
            <Tooltip
              {...tooltipProps}
              labelFormatter={(d) => fullDate(String(d))}
              formatter={(v: number) => [signedPct2(v), 'Drawdown from peak']}
            />
            <Area
              type="monotone"
              dataKey="drawdown"
              stroke="var(--color-down)"
              fill="var(--color-down)"
              fillOpacity={0.15}
              strokeWidth={1}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LegendSwatch({ stroke, label, dashed }: { stroke: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden>
        <line
          x1="0"
          y1="3"
          x2="18"
          y2="3"
          stroke={stroke}
          strokeWidth="2"
          strokeDasharray={dashed ? '3 3' : undefined}
        />
      </svg>
      {label}
    </span>
  );
}
