'use client';

/**
 * Allocation donut with its legend.
 *
 * Deliberately monochrome: the palette rule (§12) reserves colour for
 * direction, so the slices step through opacities of the accent rather than a
 * categorical rainbow. The legend carries the numbers; the ring carries the
 * shape.
 */
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { pct1, tooltipProps } from './chart-theme';

export interface AllocationRow {
  key: string;
  label: string;
  weight: number;
}

const MAX_SLICES = 7;

export function AllocationDonut({ rows, title }: { rows: AllocationRow[]; title?: string }) {
  const sorted = [...rows].filter((r) => r.weight > 0).sort((a, b) => b.weight - a.weight);
  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);
  const data = tail.length
    ? [...head, { key: '__other', label: `Other (${tail.length})`, weight: tail.reduce((a, r) => a + r.weight, 0) }]
    : head;

  if (data.length === 0) {
    return <p className="px-4 py-8 text-center text-[12px] text-muted">No holdings.</p>;
  }

  const opacity = (i: number) => 0.95 - (i / Math.max(1, data.length - 1)) * 0.7;

  return (
    <div className="flex items-center gap-3 px-3 py-3">
      <div className="h-28 w-28 shrink-0 sm:h-32 sm:w-32">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={data}
              dataKey="weight"
              nameKey="label"
              innerRadius="62%"
              outerRadius="100%"
              paddingAngle={1.5}
              stroke="var(--color-surface)"
              strokeWidth={1}
              isAnimationActive={false}
            >
              {data.map((d, i) => (
                <Cell key={d.key} fill="var(--color-accent)" fillOpacity={opacity(i)} />
              ))}
            </Pie>
            <Tooltip {...tooltipProps} formatter={(v: number, name: string) => [pct1(v), name]} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="min-w-0 flex-1 space-y-1">
        {title && <li className="text-[10px] uppercase tracking-wide text-muted">{title}</li>}
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-sm bg-accent"
              style={{ opacity: opacity(i) }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="tabular text-ink-2">{pct1(d.weight)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
