/**
 * Presentation formatting.
 *
 * This is the boundary where Decimals become strings. Nothing upstream of here
 * rounds, and nothing downstream of here does arithmetic.
 */
import type { Decimal } from './decimal';

const gbp0 = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
});
const gbp2 = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(value: Decimal | number | null | undefined, decimals: 0 | 2 = 0): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) return '—';
  return (decimals === 0 ? gbp0 : gbp2).format(n);
}

export function currency(
  value: Decimal | number | null | undefined,
  code: string,
  decimals = 2,
): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

export function percent(
  value: Decimal | number | null | undefined,
  decimals = 2,
  { signed = false }: { signed?: boolean } = {},
): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) return '—';
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(n);
  return formatted;
}

export function number(
  value: Decimal | number | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** Share quantities: trailing zeros stripped, fractions preserved. */
export function quantity(value: Decimal | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 6 }).format(n);
}

/** Direction, for colour. Green and red mean up and down and nothing else. */
export function direction(value: Decimal | number | null | undefined): 'up' | 'down' | 'flat' {
  if (value === null || value === undefined) return 'flat';
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'down';
}

export const directionClass = (value: Decimal | number | null | undefined): string =>
  ({ up: 'text-up', down: 'text-down', flat: 'text-muted' })[direction(value)];

/**
 * Data freshness. A number that is 20 minutes old, presented as live, is worse
 * than no number (§5), so this never rounds a delay down to "Live".
 */
export function delayLabel(delaySeconds: number | null | undefined): string {
  if (delaySeconds === null || delaySeconds === undefined) return 'Unknown age';
  if (delaySeconds <= 5) return 'Live';
  if (delaySeconds < 120) return `${delaySeconds}s delayed`;
  if (delaySeconds < 7200) return `${Math.round(delaySeconds / 60)} min delayed`;
  if (delaySeconds < 172_800) return `${Math.round(delaySeconds / 3600)}h delayed`;
  // Beyond a couple of days, hours stop being readable: "12,456h delayed" tells
  // you nothing, and the point of the badge is that the reader notices.
  const days = Math.round(delaySeconds / 86_400);
  if (days < 60) return `${days} days old`;
  return `${Math.round(days / 30)} months old`;
}

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return 'never';
  const then = typeof value === 'string' ? Date.parse(value) : value.getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(d)} ${months[Number(m) - 1]} ${y}`;
}

/**
 * An estimate with its uncertainty. Alpha of 4.2% ± 6.1% is a different claim
 * from alpha of 4.2%, and the second one is not true (§7.4).
 */
export function estimate(
  value: number | null | undefined,
  stderr: number | null | undefined,
  decimals = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const point = percent(value, decimals, { signed: true });
  if (stderr === null || stderr === undefined || !Number.isFinite(stderr)) return point;
  // 95% interval is roughly ±1.96 standard errors.
  return `${point} ± ${percent(1.96 * stderr, decimals)}`;
}

/** Whether an estimate is distinguishable from zero at 95%. */
export function isSignificant(tstat: number | null | undefined): boolean {
  return tstat !== null && tstat !== undefined && Math.abs(tstat) >= 1.96;
}
