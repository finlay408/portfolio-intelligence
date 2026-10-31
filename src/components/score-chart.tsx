'use client';

/**
 * The overview's one chart: you against the S&P 500 in pounds.
 *
 * Deliberately plainer than `PerformanceChart` — no grid, no drawdown panel,
 * two lines and a dot on each end — because on a phone the only question it
 * answers is "am I ahead or behind, and since when". Both lines start at zero
 * on the first day of the window, so the vertical gap at the right-hand edge
 * is the "vs S&P" figure printed above it. The full chart lives on /risk.
 */
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fullDate, makeDateTick, signedPct2, tooltipProps } from './chart-theme';

export interface ScorePoint {
  date: string;
  you: number;
  market: number | null;
}

const YOU = 'var(--color-ink)';
const MARKET = 'var(--color-accent)';

export function ScoreChart({ data, marketLabel }: { data: ScorePoint[]; marketLabel: string }) {
  if (data.length < 2) {
    return <p className="py-10 text-center text-[12px] text-muted">Not enough history in this window to plot.</p>;
  }
  const tick = makeDateTick(data.map((p) => p.date));
  const last = data.length - 1;
  const endDot =
    (colour: string) =>
    ({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) =>
      index === last && cx !== undefined && cy !== undefined ? (
        <circle key={index} cx={cx} cy={cy} r={4} fill={colour} />
      ) : (
        <g key={index} />
      );

  return (
    <div className="h-40 sm:h-52">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
          <XAxis
            dataKey="date"
            tickFormatter={tick}
            ticks={[data[0]!.date, data[last]!.date]}
            interval="preserveStartEnd"
            tick={{ fill: 'var(--color-muted)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis hide domain={['auto', 'auto']} />
          <ReferenceLine y={0} stroke="var(--color-line-strong)" strokeDasharray="3 4" />
          <Tooltip
            {...tooltipProps}
            labelFormatter={(d) => fullDate(String(d))}
            formatter={(v: number, key: string) => [signedPct2(v), key === 'you' ? 'You' : marketLabel]}
          />
          <Line
            type="monotone"
            dataKey="market"
            stroke={MARKET}
            strokeWidth={2}
            dot={endDot(MARKET)}
            activeDot={{ r: 3 }}
            connectNulls
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="you"
            stroke={YOU}
            strokeWidth={2.5}
            dot={endDot(YOU)}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ScoreLegend({ marketLabel }: { marketLabel: string }) {
  return (
    <div className="flex items-center gap-4 text-[12px]">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-[3px] w-3.5 rounded-full" style={{ background: YOU }} />
        You
      </span>
      <span className="inline-flex items-center gap-1.5 text-ink-2">
        <span className="h-[3px] w-3.5 rounded-full" style={{ background: MARKET }} />
        {marketLabel}
      </span>
    </div>
  );
}
