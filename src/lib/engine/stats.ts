/**
 * Simple descriptive statistics on daily return series (CLAUDE.md §4.1, §7.4).
 *
 * This is the TypeScript half of the two-runtime split: volatility, Sharpe,
 * Sortino, Calmar, capture ratios and distribution shape. Anything requiring a
 * regression, a covariance matrix or a tail model lives in `analytics/` under
 * numpy/statsmodels — reimplementing those here would be a large source of
 * subtle error for no benefit.
 *
 * Returns are small ratios, so these operate on `number` rather than Decimal.
 */

export const TRADING_DAYS = 252;

export function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample variance (n-1). */
export function variance(xs: number[]): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

export function stdev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

export function annualisedVolatility(dailyReturns: number[]): number {
  return stdev(dailyReturns) * Math.sqrt(TRADING_DAYS);
}

/** Geometric annualised return from a daily series. */
export function annualisedReturn(dailyReturns: number[]): number {
  if (dailyReturns.length === 0) return Number.NaN;
  const growth = dailyReturns.reduce((a, r) => a * (1 + r), 1);
  if (growth <= 0) return Number.NaN;
  return Math.pow(growth, TRADING_DAYS / dailyReturns.length) - 1;
}

/**
 * @param dailyRiskFree daily risk-free rate — for a GBP portfolio this comes
 *   from SONIA or the UK 3-month gilt, never US T-bills (§7).
 */
export function sharpe(dailyReturns: number[], dailyRiskFree: number[] | number): number {
  const excess = toExcess(dailyReturns, dailyRiskFree);
  const sd = stdev(excess);
  if (!Number.isFinite(sd) || sd === 0) return Number.NaN;
  return (mean(excess) / sd) * Math.sqrt(TRADING_DAYS);
}

/** Downside deviation against a minimum acceptable return of 0. */
export function sortino(dailyReturns: number[], dailyRiskFree: number[] | number, mar = 0): number {
  const excess = toExcess(dailyReturns, dailyRiskFree);
  const downside = excess.filter((r) => r < mar).map((r) => (r - mar) ** 2);
  if (downside.length === 0) return Number.POSITIVE_INFINITY;
  const dd = Math.sqrt(downside.reduce((a, b) => a + b, 0) / excess.length);
  if (dd === 0) return Number.NaN;
  return (mean(excess) / dd) * Math.sqrt(TRADING_DAYS);
}

export function calmar(dailyReturns: number[], maxDrawdown: number): number {
  if (maxDrawdown === 0) return Number.NaN;
  return annualisedReturn(dailyReturns) / Math.abs(maxDrawdown);
}

function toExcess(returns: number[], rf: number[] | number): number[] {
  if (typeof rf === 'number') return returns.map((r) => r - rf);
  return returns.map((r, i) => r - (rf[i] ?? 0));
}

export function trackingError(portfolio: number[], benchmark: number[]): number {
  const active = portfolio.map((r, i) => r - (benchmark[i] ?? 0));
  return stdev(active) * Math.sqrt(TRADING_DAYS);
}

export function informationRatio(portfolio: number[], benchmark: number[]): number {
  const active = portfolio.map((r, i) => r - (benchmark[i] ?? 0));
  const te = stdev(active);
  if (!Number.isFinite(te) || te === 0) return Number.NaN;
  return (mean(active) / te) * Math.sqrt(TRADING_DAYS);
}

export interface CaptureRatios {
  upCapture: number;
  downCapture: number;
  upPeriods: number;
  downPeriods: number;
}

/**
 * Mean portfolio return in up vs down benchmark periods, as a ratio. Pass
 * monthly series for the conventional reading (§7.4).
 */
export function upDownCapture(portfolio: number[], benchmark: number[]): CaptureRatios {
  const up: Array<[number, number]> = [];
  const down: Array<[number, number]> = [];
  for (let i = 0; i < portfolio.length; i++) {
    const b = benchmark[i];
    if (b === undefined) continue;
    (b >= 0 ? up : down).push([portfolio[i]!, b]);
  }
  const ratio = (rows: Array<[number, number]>) => {
    if (rows.length === 0) return Number.NaN;
    const p = mean(rows.map((r) => r[0]));
    const b = mean(rows.map((r) => r[1]));
    return b === 0 ? Number.NaN : p / b;
  };
  return {
    upCapture: ratio(up),
    downCapture: ratio(down),
    upPeriods: up.length,
    downPeriods: down.length,
  };
}

/** Compound a daily series into calendar-period returns keyed by `keyOf`. */
export function toPeriodReturns(
  dates: string[],
  returns: number[],
  keyOf: (d: string) => string,
): { keys: string[]; values: number[] } {
  const buckets = new Map<string, number>();
  const order: string[] = [];
  for (let i = 0; i < returns.length; i++) {
    const key = keyOf(dates[i] ?? '');
    if (!buckets.has(key)) order.push(key);
    buckets.set(key, (buckets.get(key) ?? 1) * (1 + (returns[i] ?? 0)));
  }
  return { keys: order, values: order.map((k) => (buckets.get(k) ?? 1) - 1) };
}

/** Linear-interpolated percentile. `p` in [0,1]. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return Number.NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  if (sd === 0) return Number.NaN;
  const s = xs.reduce((a, x) => a + ((x - m) / sd) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * s;
}

/** Excess kurtosis (0 for a normal distribution). */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return Number.NaN;
  const m = mean(xs);
  const sd = stdev(xs);
  if (sd === 0) return Number.NaN;
  const s = xs.reduce((a, x) => a + ((x - m) / sd) ** 4, 0);
  return (
    ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s -
    (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
  );
}

export function rolling<T>(xs: number[], window: number, fn: (slice: number[]) => T): Array<T | null> {
  return xs.map((_, i) => (i + 1 < window ? null : fn(xs.slice(i + 1 - window, i + 1))));
}
