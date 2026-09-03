'use client';

/**
 * Small multiples of rolling risk series — volatility, Sharpe, beta.
 *
 * The point of a rolling chart is the comparison between the right-hand edge
 * and the rest of it. A since-inception figure is one number; this shows
 * whether that number still describes the portfolio today.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisProps, fullDate, gridProps, makeDateTick, pct0, pct1, tooltipProps } from './chart-theme';

export interface RollingSeries {
  key: string;
  label: string;
  /** Window in trading days, for the caption. */
  window: number;
  dates: string[];
  values: Array<number | null>;
  format: 'percent' | 'ratio';
  /** A horizontal guide, e.g. 1.0 for beta. */
  reference?: number;
}

export function RollingChart({ series }: { series: RollingSeries[] }) {
  const usable = series.filter((s) => s.values.some((v) => v !== null));
  if (usable.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-[12px] text-muted">
        No rolling series yet — the shortest window needs 21 daily observations.
      </p>
    );
  }

  return (
    <div className="grid gap-x-4 gap-y-2 px-2 py-3 sm:grid-cols-2 xl:grid-cols-3">
      {usable.map((s) => {
        const data = s.dates.map((date, i) => ({ date, value: s.values[i] ?? null }));
        const latest = [...s.values].reverse().find((v) => v !== null) ?? null;
        const fmt = s.format === 'percent' ? pct1 : (v: number) => v.toFixed(2);
        const tick = makeDateTick(s.dates);
        return (
          <div key={s.key} className="min-w-0">
            <div className="flex items-baseline justify-between px-2 pb-1">
              <span className="text-[11px] text-muted">
                {s.label} <span className="text-[10px]">· {s.window}d rolling</span>
              </span>
              <span className="tabular text-[12px]">{latest === null ? '—' : fmt(latest)}</span>
            </div>
            <div className="h-28">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="date" {...axisProps} minTickGap={48} tickFormatter={tick} />
                  <YAxis
                    {...axisProps}
                    width={38}
                    tickFormatter={s.format === 'percent' ? pct0 : (v: number) => v.toFixed(1)}
                    domain={['auto', 'auto']}
                  />
                  {s.reference !== undefined && (
                    <ReferenceLine y={s.reference} stroke="var(--color-line-strong)" strokeDasharray="3 3" />
                  )}
                  <Tooltip
                    {...tooltipProps}
                    labelFormatter={(d) => fullDate(String(d))}
                    formatter={(v: number) => [fmt(v), s.label]}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    stroke="var(--color-accent)"
                    strokeWidth={1.5}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}
