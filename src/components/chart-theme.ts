/**
 * Shared Recharts styling so every chart reads as one system.
 *
 * Colour is used for direction only (§12): the portfolio line is the accent,
 * benchmarks are muted greys, losses are red, and nothing else is coloured.
 */

export const axisProps = {
  stroke: 'var(--color-line)',
  tick: { fill: 'var(--color-muted)', fontSize: 10 },
  tickLine: false,
  axisLine: false,
} as const;

export const gridProps = {
  stroke: 'var(--color-line)',
  strokeDasharray: '2 4',
  vertical: false,
} as const;

export const tooltipProps = {
  contentStyle: {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-line)',
    borderRadius: 6,
    fontSize: 12,
    padding: '6px 10px',
    boxShadow: 'none',
  },
  labelStyle: { color: 'var(--color-muted)', marginBottom: 2 },
  itemStyle: { padding: 0 },
  cursor: { stroke: 'var(--color-line-strong)', strokeWidth: 1 },
} as const;

/** Muted tones for secondary series, darkest first. */
export const SECONDARY_STROKES = ['var(--color-ink-2)', 'var(--color-muted)'] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact date ticks that pick their own granularity from the span. */
export function makeDateTick(dates: string[]): (d: string) => string {
  const first = dates[0];
  const last = dates.at(-1);
  const spanDays =
    first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) : 0;
  return (d: string) => {
    const [y, m, day] = d.slice(0, 10).split('-');
    const month = MONTHS[Number(m) - 1] ?? m;
    if (spanDays <= 200) return `${Number(day)} ${month}`;
    return `${month} ${y!.slice(2)}`;
  };
}

export function fullDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export const pct0 = (v: number) => `${(v * 100).toFixed(0)}%`;
export const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
export const pct2 = (v: number) => `${(v * 100).toFixed(2)}%`;
export const signedPct2 = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

const gbp = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
});
export const money0 = (v: number) => gbp.format(v);
export const moneyShort = (v: number) =>
  Math.abs(v) >= 1000 ? `£${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : gbp.format(v);
