/**
 * Black-Scholes Greeks against published reference values (CLAUDE.md §11).
 *
 * Reference set A — Hull, *Options, Futures and Other Derivatives*, the worked
 * example in the Black-Scholes chapter: S=42, K=40, r=10%, σ=20%, T=0.5.
 * Published: call 4.76, put 0.81.
 *
 * Reference set B — the standard at-the-money case quoted in most option
 * texts: S=K=100, r=5%, σ=20%, T=1. Published: call 10.4506, put 5.5735,
 * delta 0.6368, gamma 0.018762, vega 37.524, theta −6.414/yr, rho 53.232.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateGreeks,
  blackScholes,
  impliedVolatility,
  normCdf,
  type OptionPosition,
} from '../src/lib/engine/greeks';

describe('normal CDF', () => {
  it('matches published values to 1e-12', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 15);
    expect(normCdf(1)).toBeCloseTo(0.8413447460685429, 12);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145705, 12);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normCdf(-2.5758293035489)).toBeCloseTo(0.005, 12);
  });

  it('is symmetric and bounded in the far tails', () => {
    expect(normCdf(8) + normCdf(-8)).toBeCloseTo(1, 14);
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(40)).toBe(1);
  });
});

describe("Hull's worked example: S=42, K=40, r=10%, sigma=20%, T=0.5", () => {
  const base = { spot: 42, strike: 40, years: 0.5, rate: 0.1, volatility: 0.2 };

  it('prices the call at 4.76', () => {
    expect(blackScholes({ ...base, right: 'C' }).price).toBeCloseTo(4.76, 2);
  });

  it('prices the put at 0.81', () => {
    expect(blackScholes({ ...base, right: 'P' }).price).toBeCloseTo(0.81, 2);
  });

  it('produces the published d1 and d2', () => {
    const g = blackScholes({ ...base, right: 'C' });
    expect(g.d1).toBeCloseTo(0.7693, 4);
    expect(g.d2).toBeCloseTo(0.6278, 4);
  });
});

describe('at-the-money reference: S=K=100, r=5%, sigma=20%, T=1', () => {
  const base = { spot: 100, strike: 100, years: 1, rate: 0.05, volatility: 0.2 };
  const call = blackScholes({ ...base, right: 'C' });
  const put = blackScholes({ ...base, right: 'P' });

  it('prices both legs', () => {
    expect(call.price).toBeCloseTo(10.4506, 4);
    expect(put.price).toBeCloseTo(5.5735, 4);
  });

  it('matches published delta, gamma, vega, theta and rho', () => {
    expect(call.delta).toBeCloseTo(0.6368, 4);
    expect(call.gamma).toBeCloseTo(0.018762, 6);
    expect(call.vega).toBeCloseTo(37.524, 3);
    expect(call.theta).toBeCloseTo(-6.414, 3);
    expect(call.rho).toBeCloseTo(53.2325, 4);
  });

  it('gives the put its own delta and rho but shares gamma and vega', () => {
    expect(put.delta).toBeCloseTo(-0.3632, 4);
    expect(put.gamma).toBeCloseTo(call.gamma, 12);
    expect(put.vega).toBeCloseTo(call.vega, 10);
    expect(put.rho).toBeCloseTo(-41.8905, 4);
  });

  it('satisfies put-call parity', () => {
    // C - P = S - K·e^(-rT)
    const parity = 100 - 100 * Math.exp(-0.05);
    expect(call.price - put.price).toBeCloseTo(parity, 10);
  });
});

describe('dividend yield', () => {
  it('reduces a call and raises a put', () => {
    const base = { spot: 100, strike: 100, years: 1, rate: 0.05, volatility: 0.2 };
    const withDiv = blackScholes({ ...base, dividendYield: 0.03, right: 'C' });
    const withoutDiv = blackScholes({ ...base, right: 'C' });
    expect(withDiv.price).toBeLessThan(withoutDiv.price);

    const putWithDiv = blackScholes({ ...base, dividendYield: 0.03, right: 'P' });
    const putWithout = blackScholes({ ...base, right: 'P' });
    expect(putWithDiv.price).toBeGreaterThan(putWithout.price);
  });
});

describe('degenerate inputs collapse to intrinsic rather than NaN', () => {
  it('handles expiry', () => {
    const g = blackScholes({
      spot: 110,
      strike: 100,
      years: 0,
      rate: 0.05,
      volatility: 0.2,
      right: 'C',
    });
    expect(g.price).toBe(10);
    expect(g.delta).toBe(1);
    expect(g.gamma).toBe(0);
    expect(Number.isNaN(g.theta)).toBe(false);
  });

  it('handles zero volatility', () => {
    const g = blackScholes({
      spot: 90,
      strike: 100,
      years: 1,
      rate: 0.05,
      volatility: 0,
      right: 'P',
    });
    expect(g.price).toBe(10);
    expect(Number.isFinite(g.delta)).toBe(true);
  });
});

describe('implied volatility', () => {
  it('round-trips a known volatility', () => {
    const inputs = { spot: 100, strike: 105, years: 0.5, rate: 0.04, right: 'C' as const };
    const price = blackScholes({ ...inputs, volatility: 0.27 }).price;
    expect(impliedVolatility(price, inputs)).toBeCloseTo(0.27, 8);
  });

  it('converges on a deep in-the-money contract where vega is near zero', () => {
    // The case Newton cannot handle, and the reason for the bisection fallback.
    const inputs = { spot: 200, strike: 50, years: 0.05, rate: 0.04, right: 'C' as const };
    const price = blackScholes({ ...inputs, volatility: 0.45 }).price;
    const iv = impliedVolatility(price, inputs);
    expect(iv).not.toBeNull();
    expect(blackScholes({ ...inputs, volatility: iv! }).price).toBeCloseTo(price, 6);
  });

  it('refuses a price below intrinsic rather than inventing a volatility', () => {
    const inputs = { spot: 150, strike: 100, years: 1, rate: 0.05, right: 'C' as const };
    expect(impliedVolatility(1, inputs)).toBeNull();
  });
});

describe('portfolio aggregation', () => {
  const make = (over: Partial<OptionPosition>): OptionPosition => ({
    contractId: 1,
    underlyingId: 1,
    right: 'C',
    strike: 100,
    contracts: 1,
    multiplier: 100,
    underlyingSpot: 100,
    underlyingBeta: 1,
    expiry: '2026-01-16',
    source: 'provider',
    greeks: blackScholes({
      spot: 100,
      strike: 100,
      years: 1,
      rate: 0.05,
      volatility: 0.2,
      right: 'C',
    }),
    ...over,
  });

  it('scales by contracts and multiplier', () => {
    const one = aggregateGreeks([make({ contracts: 1 })], 500);
    const three = aggregateGreeks([make({ contracts: 3 })], 500);
    expect(three.netDelta).toBeCloseTo(one.netDelta * 3, 10);
    // Per-share delta 0.6368 x 100 shares per contract x 3 contracts.
    expect(three.netDelta).toBeCloseTo(191.05, 1);
  });

  it('nets a short position against a long one', () => {
    const agg = aggregateGreeks([make({}), make({ contractId: 2, contracts: -1 })], 500);
    expect(agg.netDelta).toBeCloseTo(0, 10);
    expect(agg.netGamma).toBeCloseTo(0, 10);
  });

  it('beta-weights delta into benchmark share equivalents', () => {
    const lowBeta = aggregateGreeks([make({ underlyingBeta: 0.5 })], 500);
    const highBeta = aggregateGreeks([make({ underlyingBeta: 2 })], 500);
    expect(highBeta.betaWeightedDelta).toBeCloseTo(lowBeta.betaWeightedDelta * 4, 8);
    // 1 contract, delta 0.6368, spot 100, beta 1, SPX proxy at 500.
    const neutral = aggregateGreeks([make({})], 500);
    expect(neutral.betaWeightedDelta).toBeCloseTo((0.6368 * 100 * 100) / 500, 2);
  });

  it('buckets vega by expiry', () => {
    const agg = aggregateGreeks(
      [make({}), make({ contractId: 2, expiry: '2026-06-19' })],
      500,
    );
    expect(agg.vegaByExpiry).toHaveLength(2);
    expect(agg.vegaByExpiry[0]!.expiry).toBe('2026-01-16');
  });

  it('counts provider Greeks separately from computed ones', () => {
    const agg = aggregateGreeks(
      [make({}), make({ contractId: 2, source: 'computed' })],
      500,
    );
    expect(agg.providerCount).toBe(1);
    expect(agg.computedCount).toBe(1);
  });

  it('reports theta per day as well as per year', () => {
    const agg = aggregateGreeks([make({})], 500);
    expect(agg.thetaPerDay).toBeCloseTo(agg.netTheta / 365, 12);
  });
});
