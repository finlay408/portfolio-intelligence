'use client';

/**
 * Histogram of daily returns in the selected window, with the empirical 95%
 * one-day loss marked. This is what a VaR figure looks like before it is
 * reduced to one number: the left tail is the risk, and its shape is visible.
 */
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HistogramBin } from '@/lib/engine/windows';
import { axisProps, pct1, tooltipProps } from './chart-theme';

export function DistributionChart({
  bins,
  var95,
  observations,
}: {
  bins: HistogramBin[];
  var95: number | null;
  observations: number;
}) {
  if (bins.length < 2) {
    return <p className="px-4 py-8 text-center text-[12px] text-muted">Not enough days to bin.</p>;
  }
  const data = bins.map((b) => ({ mid: (b.from + b.to) / 2, count: b.count, from: b.from, to: b.to }));

  return (
    <div className="px-1 py-2 sm:px-2 sm:py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2 text-[11px] text-muted">
        <span>{observations} daily returns</span>
        {var95 !== null && (
          <span>
            95% of days lost less than <span className="tabular text-down">{pct1(Math.abs(var95))}</span>
          </span>
        )}
      </div>
      <div className="h-40 sm:h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap={1}>
            <XAxis
              dataKey="mid"
              {...axisProps}
              tickFormatter={pct1}
              type="number"
              domain={['dataMin', 'dataMax']}
              tickCount={7}
            />
            <YAxis {...axisProps} width={28} allowDecimals={false} />
            <ReferenceLine x={0} stroke="var(--color-line-strong)" />
            {var95 !== null && (
              <ReferenceLine
                x={var95}
                stroke="var(--color-down)"
                strokeDasharray="3 3"
                label={{ value: 'VaR 95%', fill: 'var(--color-down)', fontSize: 10, position: 'insideTopLeft' }}
              />
            )}
            <Tooltip
              {...tooltipProps}
              cursor={{ fill: 'var(--color-surface-2)' }}
              labelFormatter={(_, payload) => {
                const p = payload?.[0]?.payload as { from: number; to: number } | undefined;
                return p ? `${pct1(p.from)} to ${pct1(p.to)}` : '';
              }}
              formatter={(v: number) => [`${v} day${v === 1 ? '' : 's'}`, 'Count']}
            />
            <Bar dataKey="count" isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.mid < 0 ? 'var(--color-down)' : 'var(--color-up)'}
                  fillOpacity={0.55}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
