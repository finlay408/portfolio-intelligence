'use client';

/**
 * Cumulative TWR and drawdown.
 *
 * Recharts rather than D3 here: it is a standard time series, and the custom
 * work belongs in the RRG (§4). The drawdown panel sits underneath rather than
 * on a second axis, because a shared axis makes a 5% drawdown look like a 5%
 * return and they are not comparable quantities.
 */
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface PerformancePoint {
  date: string;
  /** Cumulative return since inception, as a decimal. */
  cumulative: number;
  /** Drawdown from the running peak, negative. */
  drawdown: number;
}

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`;

export function PerformanceChart({ data }: { data: PerformancePoint[] }) {
  if (data.length < 2) {
    return (
      <p className="px-4 py-8 text-center text-[12px] text-muted">
        Not enough history to plot. Run the backfill and recompute.
      </p>
    );
  }

  const axis = {
    stroke: 'var(--color-line)',
    tick: { fill: 'var(--color-muted)', fontSize: 10 },
  };
  const tooltip = {
    contentStyle: {
      background: 'var(--color-surface)',
      border: '1px solid var(--color-line)',
      borderRadius: 6,
      fontSize: 12,
    },
    labelStyle: { color: 'var(--color-muted)' },
  };

  return (
    <div className="px-2 py-3">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="date" {...axis} minTickGap={48} />
          <YAxis {...axis} tickFormatter={pct} width={46} />
          <Tooltip {...tooltip} formatter={(v: number) => [pct2(v), 'Cumulative TWR']} />
          <Line
            type="monotone"
            dataKey="cumulative"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <ResponsiveContainer width="100%" height={110}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="date" {...axis} minTickGap={48} hide />
          <YAxis {...axis} tickFormatter={pct} width={46} />
          <Tooltip {...tooltip} formatter={(v: number) => [pct2(v), 'Drawdown']} />
          <Area
            type="monotone"
            dataKey="drawdown"
            stroke="var(--color-down)"
            fill="var(--color-down)"
            fillOpacity={0.15}
            strokeWidth={1}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
