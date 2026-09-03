/**
 * Windowed performance (CLAUDE.md §7.4, §12).
 *
 * A since-inception Sharpe ratio describes the portfolio's whole life, not its
 * present. Every figure the overview leads with is therefore computed over a
 * selectable trailing window — 1M, 3M, 6M, YTD, 1Y, All — on the same
 * flow-adjusted TWR series, rebased to 1 at the start of the window.
 *
 * Windows are counted in trading days (observations), not calendar days, so a
 * "3M" window is the same number of returns whichever month it lands in and
 * matches the rolling windows the Python job uses (21 / 63 / 126 / 252).
 *
 * Benchmarks arrive as price levels rather than returns, because the portfolio
 * and the S&P 500 do not share a calendar: the portfolio has a snapshot on the
 * August bank holiday, SPY does not trade on Thanksgiving. Aligning levels by
 * carrying the last close forward onto the portfolio's dates is the only way
 * to compare like with like.
 */
import { Decimal, ONE } from '../decimal';
import type { IsoDate } from '../types';
import {
  annualisedReturn,
  annualisedVolatility,
  percentile,
  sharpe,
  sortino,
} from './stats';
import { drawdownSeries, maxDrawdown, type MaxDrawdown, type TwrPoint } from './twr';

export type WindowKey = '1m' | '3m' | '6m' | 'ytd' | '1y' | 'all';

export interface WindowSpec {
  key: WindowKey;
  label: string;
  /** Trailing observations, or null for a date-anchored window. */
  tradingDays: number | null;
  description: string;
}

export const WINDOWS: readonly WindowSpec[] = [
  { key: '1m', label: '1M', tradingDays: 21, description: 'last 21 trading days' },
  { key: '3m', label: '3M', tradingDays: 63, description: 'last 63 trading days' },
  { key: '6m', label: '6M', tradingDays: 126, description: 'last 126 trading days' },
  { key: 'ytd', label: 'YTD', tradingDays: null, description: 'since the start of the year' },
  { key: '1y', label: '1Y', tradingDays: 252, description: 'last 252 trading days' },
  { key: 'all', label: 'All', tradingDays: null, description: 'since inception' },
];

/** The overview opens on the recent past, not on inception. */
export const DEFAULT_WINDOW: WindowKey = '3m';

/** Fewer returns than this and an annualised figure is noise, so it is withheld. */
export const MIN_OBSERVATIONS_FOR_ANNUALISED = 20;

export function parseWindow(raw: string | string[] | undefined | null): WindowKey {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return WINDOWS.some((w) => w.key === value) ? (value as WindowKey) : DEFAULT_WINDOW;
}

export function windowSpec(key: WindowKey): WindowSpec {
  return WINDOWS.find((w) => w.key === key)!;
}

/**
 * The index of the point the window is rebased on. Its cumulative value is the
 * base; the returns that follow it are the window.
 */
export function anchorIndex(series: TwrPoint[], key: WindowKey): number {
  if (series.length === 0) return 0;
  const spec = windowSpec(key);
  if (spec.tradingDays !== null) return Math.max(0, series.length - 1 - spec.tradingDays);
  if (key === 'ytd') {
    const year = series.at(-1)!.date.slice(0, 4);
    const start = `${year}-01-01`;
    let idx = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i]!.date < start) idx = i;
      else break;
    }
    return idx;
  }
  return 0;
}

/**
 * Slice a TWR series to a window and rebase it so the anchor's cumulative is 1.
 * The anchor keeps its date but carries no return: it is the base, not a day.
 */
export function sliceWindow(series: TwrPoint[], key: WindowKey): TwrPoint[] {
  if (series.length === 0) return [];
  const start = anchorIndex(series, key);
  const base = series[start]!.cumulative;
  return series.slice(start).map((p, i) => ({
    date: p.date,
    dailyReturn: i === 0 ? null : p.dailyReturn,
    cumulative: base.isZero() ? p.cumulative : p.cumulative.div(base),
  }));
}

/* ---------------- Benchmarks as levels ---------------- */

export interface LevelPoint {
  date: IsoDate;
  level: number;
}

/**
 * Carry the last available level forward onto each requested date. Returns
 * null for dates before the first level.
 */
export function alignLevels(dates: IsoDate[], levels: LevelPoint[]): Array<number | null> {
  const out: Array<number | null> = [];
  let j = 0;
  let last: number | null = null;
  for (const date of dates) {
    while (j < levels.length && levels[j]!.date <= date) {
      last = levels[j]!.level;
      j++;
    }
    out.push(last);
  }
  return out;
}

/** Cumulative growth from the first date, and per-step returns, off aligned levels. */
export function levelsToCumulative(aligned: Array<number | null>): {
  cumulative: Array<number | null>;
  dailyReturn: Array<number | null>;
} {
  const base = aligned.find((v): v is number => v !== null && v > 0) ?? null;
  const cumulative = aligned.map((v) => (v === null || base === null ? null : v / base));
  const dailyReturn = aligned.map((v, i) => {
    const prev = i === 0 ? null : (aligned[i - 1] ?? null);
    return v === null || prev === null || prev === 0 ? null : v / prev - 1;
  });
  return { cumulative, dailyReturn };
}

/* ---------------- Summary statistics for a window ---------------- */

export interface BenchmarkWindow {
  /** Cumulative return of the benchmark over the window. */
  ret: number | null;
  /** Portfolio return minus benchmark return — the plain-language comparison. */
  active: number | null;
}

export interface WindowSummary {
  key: WindowKey;
  label: string;
  description: string;
  from: IsoDate | null;
  to: IsoDate | null;
  /** Number of daily returns actually in the window. */
  observations: number;
  ret: Decimal | null;
  annualisedReturn: number | null;
  volatility: number | null;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: MaxDrawdown | null;
  bestDay: number | null;
  worstDay: number | null;
  positiveDays: number | null;
  /** Empirical 95% one-day loss over the window, as a fraction (negative). */
  var95: number | null;
  benchmarks: Record<string, BenchmarkWindow>;
}

export interface WindowInputs {
  /** Benchmark levels, keyed by a display name such as "S&P 500 (GBP)". */
  benchmarks?: Record<string, LevelPoint[]>;
  /** Daily risk-free rate by date; missing dates are treated as zero. */
  riskFreeDaily?: Map<IsoDate, number>;
}

const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

export function summariseWindow(
  series: TwrPoint[],
  key: WindowKey,
  inputs: WindowInputs = {},
): WindowSummary {
  const spec = windowSpec(key);
  const rebased = sliceWindow(series, key);
  const returns = rebased
    .map((p) => p.dailyReturn)
    .filter((r): r is Decimal => r !== null)
    .map((r) => r.toNumber());
  const rf = rebased
    .filter((p) => p.dailyReturn !== null)
    .map((p) => inputs.riskFreeDaily?.get(p.date) ?? 0);

  const enough = returns.length >= MIN_OBSERVATIONS_FOR_ANNUALISED;
  const dates = rebased.map((p) => p.date);
  const portfolioReturn = rebased.length > 0 ? rebased.at(-1)!.cumulative.minus(ONE) : null;

  const benchmarks: Record<string, BenchmarkWindow> = {};
  for (const [name, levels] of Object.entries(inputs.benchmarks ?? {})) {
    const { cumulative } = levelsToCumulative(alignLevels(dates, levels));
    const last = cumulative.at(-1) ?? null;
    const first = cumulative[0] ?? null;
    const ret = last === null || first === null ? null : last / first - 1;
    benchmarks[name] = {
      ret,
      active: ret === null || portfolioReturn === null ? null : portfolioReturn.toNumber() - ret,
    };
  }

  return {
    key,
    label: spec.label,
    description: spec.description,
    from: rebased[0]?.date ?? null,
    to: rebased.at(-1)?.date ?? null,
    observations: returns.length,
    ret: portfolioReturn,
    annualisedReturn: enough ? finiteOrNull(annualisedReturn(returns)) : null,
    volatility: returns.length >= 2 ? finiteOrNull(annualisedVolatility(returns)) : null,
    sharpe: enough ? finiteOrNull(sharpe(returns, rf)) : null,
    sortino: enough ? finiteOrNull(sortino(returns, rf)) : null,
    maxDrawdown: rebased.length > 1 ? maxDrawdown(rebased) : null,
    bestDay: returns.length > 0 ? Math.max(...returns) : null,
    worstDay: returns.length > 0 ? Math.min(...returns) : null,
    positiveDays: returns.length > 0 ? returns.filter((r) => r > 0).length / returns.length : null,
    var95: enough ? finiteOrNull(percentile(returns, 0.05)) : null,
    benchmarks,
  };
}

/* ---------------- Chart series ---------------- */

export interface PerformancePoint {
  date: IsoDate;
  /** Portfolio cumulative return since the window anchor, as a decimal. */
  portfolio: number;
  drawdown: number;
  /** Benchmark cumulative returns over the same dates, by display name. */
  benchmarks: Record<string, number | null>;
}

export function performanceSeries(
  series: TwrPoint[],
  key: WindowKey,
  benchmarks: Record<string, LevelPoint[]> = {},
): PerformancePoint[] {
  const rebased = sliceWindow(series, key);
  if (rebased.length === 0) return [];
  const drawdowns = drawdownSeries(rebased);
  const dates = rebased.map((p) => p.date);
  const aligned = Object.fromEntries(
    Object.entries(benchmarks).map(([name, levels]) => [
      name,
      levelsToCumulative(alignLevels(dates, levels)).cumulative,
    ]),
  );
  return rebased.map((p, i) => ({
    date: p.date,
    portfolio: p.cumulative.minus(ONE).toNumber(),
    drawdown: drawdowns[i]?.drawdown.toNumber() ?? 0,
    benchmarks: Object.fromEntries(
      Object.entries(aligned).map(([name, cum]) => {
        const v = cum[i];
        return [name, v === null || v === undefined ? null : v - 1];
      }),
    ),
  }));
}

/* ---------------- Distribution ---------------- */

export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/** Equal-width bins over the daily returns in a window. */
export function histogram(returns: number[], bins = 24): HistogramBin[] {
  if (returns.length === 0) return [];
  const lo = Math.min(...returns);
  const hi = Math.max(...returns);
  if (lo === hi) return [{ from: lo, to: hi, count: returns.length }];
  // Symmetric about zero so the two tails are visually comparable.
  const extent = Math.max(Math.abs(lo), Math.abs(hi));
  const width = (2 * extent) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    from: -extent + i * width,
    to: -extent + (i + 1) * width,
    count: 0,
  }));
  for (const r of returns) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((r + extent) / width)));
    out[idx]!.count += 1;
  }
  return out;
}

/** Daily returns inside a window, as numbers, for the distribution chart. */
export function windowReturns(series: TwrPoint[], key: WindowKey): number[] {
  return sliceWindow(series, key)
    .map((p) => p.dailyReturn)
    .filter((r): r is Decimal => r !== null)
    .map((r) => r.toNumber());
}

/* ---------------- Calendar returns from levels ---------------- */

/**
 * Compound a level series into calendar-period returns, so a benchmark can sit
 * beside the portfolio's monthly heatmap. The first period is measured from
 * its own first level.
 */
export function periodReturnsFromLevels(
  levels: LevelPoint[],
  keyOf: (d: IsoDate) => string,
): Array<{ period: string; ret: number }> {
  if (levels.length === 0) return [];
  const out: Array<{ period: string; ret: number }> = [];
  let periodKey = keyOf(levels[0]!.date);
  let base = levels[0]!.level;
  let last = levels[0]!.level;
  for (const p of levels) {
    const k = keyOf(p.date);
    if (k !== periodKey) {
      out.push({ period: periodKey, ret: base > 0 ? last / base - 1 : 0 });
      periodKey = k;
      base = last;
    }
    last = p.level;
  }
  out.push({ period: periodKey, ret: base > 0 ? last / base - 1 : 0 });
  return out;
}

/** Convenience for pages: every window summarised at once, for the returns table. */
export function summariseAllWindows(series: TwrPoint[], inputs: WindowInputs = {}): WindowSummary[] {
  return WINDOWS.map((w) => summariseWindow(series, w.key, inputs));
}
