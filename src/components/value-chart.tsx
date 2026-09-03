'use client';

/**
 * Total value against cumulative net deposits.
 *
 * The distance between the two lines is the money made or lost in pounds —
 * the figure people actually feel, as opposed to the percentage TWR reports.
 * Deposits are drawn as a step: money arrives on a day, it does not drift in.
 */
import {
  Area,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { axisProps, fullDate, gridProps, makeDateTick, money0, moneyShort, tooltipProps } from './chart-theme';

export interface ValuePoint {
  date: string;
  valueGbp: number;
  netDepositsGbp: number;
}

export function ValueChart({ data }: { data: ValuePoint[] }) {
  if (data.length < 2) {
    return <p className="px-4 py-8 text-center text-[12px] text-muted">Not enough history to plot.</p>;
  }
  const tick = makeDateTick(data.map((p) => p.date));
  const last = data.at(-1)!;
  const gain = last.valueGbp - last.netDepositsGbp;

  return (
    <div className="px-1 py-2 sm:px-2 sm:py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pb-2 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-3 rounded-sm bg-accent/40" /> Total value
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-ink-2)" strokeWidth="2" />
          </svg>
          Net deposits
        </span>
        <span className={`ml-auto tabular ${gain >= 0 ? 'text-up' : 'text-down'}`}>
          {gain >= 0 ? '+' : ''}
          {money0(gain)} above deposits
        </span>
      </div>
      <div className="h-44 sm:h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="date" {...axisProps} minTickGap={40} tickFormatter={tick} />
            <YAxis {...axisProps} tickFormatter={moneyShort} width={46} domain={['auto', 'auto']} />
            <Tooltip
              {...tooltipProps}
              labelFormatter={(d) => fullDate(String(d))}
              formatter={(v: number, key: string) => [
                money0(v),
                key === 'valueGbp' ? 'Total value' : 'Net deposits',
              ]}
            />
            <Area
              type="monotone"
              dataKey="valueGbp"
              stroke="var(--color-accent)"
              fill="var(--color-accent)"
              fillOpacity={0.18}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="netDepositsGbp"
              stroke="var(--color-ink-2)"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
