/**
 * Time-weighted return (CLAUDE.md §7.2).
 *
 * TWR neutralises the timing and size of deposits, which is what makes it the
 * only correct basis for comparison against an index. It is not the return the
 * owner earned on their capital — that is MWR, in `xirr.ts`. Both are always
 * displayed together.
 *
 * Day-weight convention: w = 0, i.e. external flows are assumed to settle at
 * the END of the day and earn nothing on the day they arrive. This is applied
 * consistently everywhere in the codebase; changing it changes every historical
 * TWR figure, so it is a constant here rather than a per-call argument.
 */
import { Decimal, ONE, ZERO, divOrNull } from '../decimal';
import type { IsoDate } from '../types';

export const FLOW_DAY_WEIGHT = new Decimal(0);

export interface DailyPoint {
  date: IsoDate;
  /**
   * Market value at the close, GBP, including cash — or null when the portfolio
   * could not be fully valued that day (a missing price, a missing FX rate).
   *
   * Null matters. Treating an unvaluable day as a zero-value day turns a data
   * gap into a 100% loss and then chains it into every risk metric downstream,
   * which is a far worse outcome than a shorter return series.
   */
  marketValueGbp: Decimal | null;
  /** Net external flow that day (deposits - withdrawals), GBP. */
  netFlowGbp: Decimal;
}

export interface TwrPoint {
  date: IsoDate;
  dailyReturn: Decimal | null;
  /** Cumulative growth factor since inception, starting at 1. */
  cumulative: Decimal;
}

/**
 * r_t = (MV_t - MV_{t-1} - F_t) / (MV_{t-1} + F_t * w)
 *
 * A day whose denominator is zero (an empty account, or the first funded day)
 * yields null rather than 0: "no return" and "flat" are different facts, and
 * chaining a fabricated zero would understate volatility.
 */
export function dailyTwrSeries(points: DailyPoint[]): TwrPoint[] {
  const out: TwrPoint[] = [];
  let cumulative = ONE;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (i === 0) {
      out.push({ date: p.date, dailyReturn: null, cumulative });
      continue;
    }
    const prev = points[i - 1]!;
    if (p.marketValueGbp === null || prev.marketValueGbp === null) {
      // Either endpoint missing means no return can be computed for the day.
      out.push({ date: p.date, dailyReturn: null, cumulative });
      continue;
    }
    const denominator = prev.marketValueGbp.plus(p.netFlowGbp.times(FLOW_DAY_WEIGHT));
    const numerator = p.marketValueGbp.minus(prev.marketValueGbp).minus(p.netFlowGbp);
    const r = divOrNull(numerator, denominator);
    if (r) cumulative = cumulative.times(ONE.plus(r));
    out.push({ date: p.date, dailyReturn: r, cumulative });
  }

  return out;
}

/** Chain-link a set of periodic returns. Never sum them (§7.3). */
export function chainLink(returns: Array<Decimal | null>): Decimal {
  return returns.reduce<Decimal>((acc, r) => (r ? acc.times(ONE.plus(r)) : acc), ONE).minus(ONE);
}

export function annualise(totalReturn: Decimal, days: number): Decimal | null {
  if (days <= 0) return null;
  const growth = ONE.plus(totalReturn);
  if (growth.lessThanOrEqualTo(0)) return null; // total loss: no meaningful CAGR
  return new Decimal(Math.exp((Math.log(growth.toNumber()) * 365) / days)).minus(ONE);
}

/** Cumulative TWR between two dates, inclusive of `to`. */
export function twrBetween(series: TwrPoint[], from: IsoDate, to: IsoDate): Decimal {
  const window = series.filter((p) => p.date > from && p.date <= to);
  return chainLink(window.map((p) => p.dailyReturn));
}

export interface DrawdownPoint {
  date: IsoDate;
  drawdown: Decimal; // <= 0
}

export interface MaxDrawdown {
  depth: Decimal; // negative
  peakDate: IsoDate | null;
  troughDate: IsoDate | null;
  /** Date the previous peak was regained, or null if still under water. */
  recoveredDate: IsoDate | null;
  recoveryDays: number | null;
  underwaterDays: number | null;
}

export function drawdownSeries(series: TwrPoint[]): DrawdownPoint[] {
  let peak = ZERO;
  const out: DrawdownPoint[] = [];
  for (const p of series) {
    if (p.cumulative.greaterThan(peak)) peak = p.cumulative;
    out.push({
      date: p.date,
      drawdown: peak.isZero() ? ZERO : p.cumulative.div(peak).minus(ONE),
    });
  }
  return out;
}

export function maxDrawdown(series: TwrPoint[]): MaxDrawdown {
  let peak = ZERO;
  let peakDate: IsoDate | null = null;
  let worst = ZERO;
  let worstPeakDate: IsoDate | null = null;
  let troughDate: IsoDate | null = null;

  for (const p of series) {
    if (p.cumulative.greaterThan(peak)) {
      peak = p.cumulative;
      peakDate = p.date;
    }
    if (peak.isZero()) continue;
    const dd = p.cumulative.div(peak).minus(ONE);
    if (dd.lessThan(worst)) {
      worst = dd;
      worstPeakDate = peakDate;
      troughDate = p.date;
    }
  }

  let recoveredDate: IsoDate | null = null;
  if (worstPeakDate && troughDate) {
    const peakValue = series.find((p) => p.date === worstPeakDate)?.cumulative;
    if (peakValue) {
      recoveredDate =
        series.find((p) => p.date > troughDate! && p.cumulative.greaterThanOrEqualTo(peakValue))
          ?.date ?? null;
    }
  }

  const dayGap = (a: IsoDate | null, b: IsoDate | null) =>
    a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000) : null;

  return {
    depth: worst,
    peakDate: worstPeakDate,
    troughDate,
    recoveredDate,
    recoveryDays: dayGap(troughDate, recoveredDate),
    underwaterDays: dayGap(worstPeakDate, recoveredDate ?? series.at(-1)?.date ?? null),
  };
}
