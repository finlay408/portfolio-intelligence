/**
 * Windowed performance: slicing, rebasing, benchmark alignment across
 * calendars, and the summary statistics the overview leads with.
 */
import { describe, expect, it } from 'vitest';
import { Decimal, ONE } from '../src/lib/decimal';
import { eachBusinessDay } from '../src/lib/dates';
import {
  alignLevels,
  anchorIndex,
  histogram,
  levelsToCumulative,
  parseWindow,
  performanceSeries,
  periodReturnsFromLevels,
  sliceWindow,
  summariseWindow,
  type LevelPoint,
} from '../src/lib/engine/windows';
import { dailyTwrSeries, type TwrPoint } from '../src/lib/engine/twr';

/** A TWR series from a list of daily returns, first point being the base. */
function seriesOf(returns: number[], start = '2025-01-01'): TwrPoint[] {
  const dates = eachBusinessDay(start, '2026-12-31', 'XLON').slice(0, returns.length + 1);
  const points = dates.map((date, i) => ({
    date,
    marketValueGbp: new Decimal(i === 0 ? 100 : 0),
    netFlowGbp: new Decimal(0),
  }));
  let value = new Decimal(100);
  for (let i = 1; i < points.length; i++) {
    value = value.times(ONE.plus(returns[i - 1]!));
    points[i]!.marketValueGbp = value;
  }
  return dailyTwrSeries(points);
}

describe('window selection', () => {
  it('parses known keys and falls back to the default', () => {
    expect(parseWindow('1y')).toBe('1y');
    expect(parseWindow(['6m'])).toBe('6m');
    expect(parseWindow('bogus')).toBe('3m');
    expect(parseWindow(undefined)).toBe('3m');
  });

  it('anchors a trailing window N observations back and clamps at inception', () => {
    const s = seriesOf(Array(100).fill(0.001));
    expect(anchorIndex(s, '1m')).toBe(100 - 21);
    expect(anchorIndex(s, '3m')).toBe(100 - 63);
    expect(anchorIndex(s, '1y')).toBe(0);
    expect(anchorIndex(s, 'all')).toBe(0);
  });

  it('anchors YTD on the last point of the previous year', () => {
    // Business days from 1 Dec 2025: the first January point is the anchor + 1.
    const s = seriesOf(Array(60).fill(0.001), '2025-12-01');
    const idx = anchorIndex(s, 'ytd');
    expect(s[idx]!.date < '2026-01-01').toBe(true);
    expect(s[idx + 1]!.date >= '2026-01-01').toBe(true);
  });
});

describe('rebasing', () => {
  it('rebases the anchor to 1 and keeps the window return exact', () => {
    const returns = [0.01, 0.02, -0.01, 0.03, 0.005, -0.02, 0.01, 0.0, 0.015, -0.005];
    const s = seriesOf(returns);
    const window = sliceWindow(s, '1m'); // 21 > 10 returns, so the whole series
    expect(window[0]!.cumulative.toNumber()).toBe(1);
    expect(window[0]!.dailyReturn).toBeNull();
    const expected = returns.reduce((a, r) => a * (1 + r), 1) - 1;
    expect(window.at(-1)!.cumulative.minus(ONE).toNumber()).toBeCloseTo(expected, 12);
  });

  it('a trailing window compounds only the returns inside it', () => {
    const returns = Array(30).fill(0.01);
    const s = seriesOf(returns);
    const window = sliceWindow(s, '1m');
    expect(window.length).toBe(22);
    expect(window.at(-1)!.cumulative.minus(ONE).toNumber()).toBeCloseTo(1.01 ** 21 - 1, 12);
  });
});

describe('benchmark alignment', () => {
  it('carries the last close forward across calendar gaps', () => {
    const levels: LevelPoint[] = [
      { date: '2025-01-02', level: 100 },
      { date: '2025-01-03', level: 102 },
      // 2025-01-06 missing: the benchmark did not trade
      { date: '2025-01-07', level: 105 },
    ];
    const aligned = alignLevels(['2025-01-01', '2025-01-02', '2025-01-06', '2025-01-07'], levels);
    expect(aligned).toEqual([null, 100, 102, 105]);
  });

  it('turns levels into cumulative growth from the first available level', () => {
    const { cumulative, dailyReturn } = levelsToCumulative([null, 100, 102, 105]);
    expect(cumulative).toEqual([null, 1, 1.02, 1.05]);
    expect(dailyReturn[0]).toBeNull();
    expect(dailyReturn[1]).toBeNull();
    expect(dailyReturn[2]).toBeCloseTo(0.02, 12);
    expect(dailyReturn[3]).toBeCloseTo(105 / 102 - 1, 12);
  });

  it('performance series carries both the portfolio and the benchmark from the same base', () => {
    const s = seriesOf([0.01, 0.01, 0.01, 0.01, 0.01]);
    const bench = s.map((p, i) => ({ date: p.date, level: 200 * 1.02 ** i }));
    const points = performanceSeries(s, 'all', { SPX: bench });
    expect(points[0]!.portfolio).toBe(0);
    expect(points[0]!.benchmarks.SPX).toBe(0);
    expect(points.at(-1)!.portfolio).toBeCloseTo(1.01 ** 5 - 1, 12);
    expect(points.at(-1)!.benchmarks.SPX).toBeCloseTo(1.02 ** 5 - 1, 12);
    expect(points.at(-1)!.drawdown).toBe(0);
  });
});

describe('window summary', () => {
  it('reports the active return against the benchmark', () => {
    const s = seriesOf(Array(40).fill(0.002));
    const bench = s.map((p, i) => ({ date: p.date, level: 100 * 1.001 ** i }));
    const summary = summariseWindow(s, '1m', { benchmarks: { SPX: bench } });
    expect(summary.observations).toBe(21);
    const pr = 1.002 ** 21 - 1;
    const br = 1.001 ** 21 - 1;
    expect(summary.ret!.toNumber()).toBeCloseTo(pr, 12);
    expect(summary.benchmarks.SPX!.ret).toBeCloseTo(br, 12);
    expect(summary.benchmarks.SPX!.active).toBeCloseTo(pr - br, 12);
  });

  it('withholds annualised figures on too few observations', () => {
    const s = seriesOf(Array(10).fill(0.002));
    const summary = summariseWindow(s, '3m');
    expect(summary.observations).toBe(10);
    expect(summary.sharpe).toBeNull();
    expect(summary.annualisedReturn).toBeNull();
    expect(summary.ret).not.toBeNull();
  });

  it('measures the drawdown inside the window, not since inception', () => {
    // A crash long ago, then a calm recent month.
    const returns = [-0.3, ...Array(40).fill(0.001)];
    const s = seriesOf(returns);
    const all = summariseWindow(s, 'all');
    const month = summariseWindow(s, '1m');
    expect(all.maxDrawdown!.depth.toNumber()).toBeCloseTo(-0.3, 12);
    expect(month.maxDrawdown!.depth.toNumber()).toBe(0);
  });

  it('uses the daily risk-free rate when supplied', () => {
    const returns = Array.from({ length: 40 }, (_, i) => 0.002 + (i % 2 === 0 ? 0.001 : -0.001));
    const s = seriesOf(returns);
    const rf = new Map(s.map((p) => [p.date, 0.002]));
    const zeroRf = summariseWindow(s, '1m');
    const withRf = summariseWindow(s, '1m', { riskFreeDaily: rf });
    // Subtracting a constant rate leaves the volatility alone and lowers the
    // ratio.
    expect(zeroRf.sharpe).toBeGreaterThan(0);
    expect(withRf.sharpe!).toBeLessThan(zeroRf.sharpe!);
    expect(withRf.volatility).toBeCloseTo(zeroRf.volatility!, 12);
  });
});

describe('distribution and calendar helpers', () => {
  it('bins returns symmetrically about zero', () => {
    const bins = histogram([-0.02, -0.01, 0, 0.01, 0.02], 4);
    expect(bins.length).toBe(4);
    expect(bins[0]!.from).toBeCloseTo(-0.02, 12);
    expect(bins.at(-1)!.to).toBeCloseTo(0.02, 12);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(5);
  });

  it('compounds levels into monthly returns measured from the prior month close', () => {
    const levels: LevelPoint[] = [
      { date: '2025-01-02', level: 100 },
      { date: '2025-01-31', level: 110 },
      { date: '2025-02-14', level: 120 },
      { date: '2025-02-28', level: 99 },
    ];
    const months = periodReturnsFromLevels(levels, (d) => d.slice(0, 7));
    expect(months.map((m) => m.period)).toEqual(['2025-01', '2025-02']);
    expect(months[0]!.ret).toBeCloseTo(0.1, 12);
    expect(months[1]!.ret).toBeCloseTo(-0.1, 12);
  });
});
