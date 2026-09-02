/**
 * Black-Scholes Greeks and portfolio aggregation (CLAUDE.md §7.11).
 *
 * Alpaca's indicative feed supplies IV and the Greeks for most contracts, and
 * those are used where present. Deep in-the-money contracts frequently come
 * back without them, so this is the fallback — and `greeks_source` records
 * which of the two produced any given row, because a provider Greek and a
 * computed one are not the same number and pretending otherwise hides errors.
 *
 * Conventions, stated once because mixing them is the usual source of nonsense:
 *   - `t` is in YEARS.
 *   - `vega` is per 1.00 of volatility (100 vol points). Divide by 100 for the
 *     per-1%-point figure most platforms display.
 *   - `theta` is per YEAR. Divide by 365 for per-calendar-day.
 *   - Greeks are per share, not per contract. Multiply by `multiplier`.
 */

/** Standard normal PDF. */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF via Hart's rational approximation.
 *
 * Accurate to roughly 1e-15 across the whole real line. The Abramowitz-Stegun
 * polynomial that usually appears in option code is only good to about 1e-7,
 * which is enough error to matter when back-solving implied volatility.
 */
export function normCdf(x: number): number {
  const z = Math.abs(x);
  let c: number;

  if (z > 37) {
    c = 0;
  } else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * b) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }

  return x > 0 ? 1 - c : c;
}

export type OptionRight = 'C' | 'P';

export interface BlackScholesInputs {
  /** Spot price of the underlying. */
  spot: number;
  strike: number;
  /** Time to expiry in years. */
  years: number;
  /** Continuously compounded risk-free rate, decimal. */
  rate: number;
  /** Annualised volatility, decimal (0.2 = 20%). */
  volatility: number;
  /** Continuous dividend yield, decimal. */
  dividendYield?: number;
  right: OptionRight;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** Per 1.00 of volatility. */
  vega: number;
  /** Per year. */
  theta: number;
  rho: number;
  d1: number;
  d2: number;
}

export function blackScholes(inputs: BlackScholesInputs): Greeks {
  const { spot: s, strike: k, years: t, rate: r, volatility: v, right } = inputs;
  const q = inputs.dividendYield ?? 0;

  // At or past expiry the option is its intrinsic value and every Greek except
  // delta collapses. Returning NaN here would poison the whole aggregation.
  if (t <= 0 || v <= 0) {
    const intrinsic = right === 'C' ? Math.max(s - k, 0) : Math.max(k - s, 0);
    const delta = right === 'C' ? (s > k ? 1 : 0) : s < k ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, vega: 0, theta: 0, rho: 0, d1: 0, d2: 0 };
  }

  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r - q + (v * v) / 2) * t) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;

  const discount = Math.exp(-r * t);
  const carry = Math.exp(-q * t);
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const pdf1 = normPdf(d1);

  const gamma = (carry * pdf1) / (s * v * sqrtT);
  const vega = s * carry * pdf1 * sqrtT;

  if (right === 'C') {
    return {
      price: s * carry * nd1 - k * discount * nd2,
      delta: carry * nd1,
      gamma,
      vega,
      theta:
        (-s * carry * pdf1 * v) / (2 * sqrtT) - r * k * discount * nd2 + q * s * carry * nd1,
      rho: k * t * discount * nd2,
      d1,
      d2,
    };
  }

  return {
    price: k * discount * normCdf(-d2) - s * carry * normCdf(-d1),
    delta: carry * (nd1 - 1),
    gamma,
    vega,
    theta:
      (-s * carry * pdf1 * v) / (2 * sqrtT) +
      r * k * discount * normCdf(-d2) -
      q * s * carry * normCdf(-d1),
    rho: -k * t * discount * normCdf(-d2),
    d1,
    d2,
  };
}

/**
 * Back-solve implied volatility from a mid price.
 *
 * Newton-Raphson on vega, with bisection as the fallback — the same pattern as
 * XIRR, and for the same reason: Newton is fast until vega goes to nearly zero
 * on a deep ITM or nearly-expired contract, at which point it flies off.
 */
export function impliedVolatility(
  marketPrice: number,
  inputs: Omit<BlackScholesInputs, 'volatility'>,
  options: { guess?: number; tolerance?: number; maxIterations?: number } = {},
): number | null {
  const tolerance = options.tolerance ?? 1e-8;
  const maxIterations = options.maxIterations ?? 100;

  const intrinsic =
    inputs.right === 'C'
      ? Math.max(inputs.spot * Math.exp(-(inputs.dividendYield ?? 0) * inputs.years) -
          inputs.strike * Math.exp(-inputs.rate * inputs.years), 0)
      : Math.max(inputs.strike * Math.exp(-inputs.rate * inputs.years) -
          inputs.spot * Math.exp(-(inputs.dividendYield ?? 0) * inputs.years), 0);

  // A price below intrinsic has no implied volatility; it is a bad quote.
  if (marketPrice < intrinsic - 1e-9 || inputs.years <= 0) return null;

  let v = options.guess ?? 0.3;
  for (let i = 0; i < maxIterations; i++) {
    const g = blackScholes({ ...inputs, volatility: v });
    const diff = g.price - marketPrice;
    if (Math.abs(diff) < tolerance) return v;
    if (g.vega < 1e-10) break;
    const next = v - diff / g.vega;
    if (!Number.isFinite(next) || next <= 0 || next > 10) break;
    v = next;
  }

  // Bisection over a generous volatility bracket.
  let lo = 1e-6;
  let hi = 10;
  const priceAt = (vol: number) => blackScholes({ ...inputs, volatility: vol }).price;
  if ((priceAt(lo) - marketPrice) * (priceAt(hi) - marketPrice) > 0) return null;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const diff = priceAt(mid) - marketPrice;
    if (Math.abs(diff) < tolerance || hi - lo < 1e-12) return mid;
    if ((priceAt(lo) - marketPrice) * diff < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/* ---------------- Portfolio aggregation ---------------- */

export interface OptionPosition {
  contractId: number;
  underlyingId: number;
  right: OptionRight;
  strike: number;
  /** Signed: negative for a short position. */
  contracts: number;
  multiplier: number;
  greeks: Greeks;
  underlyingSpot: number;
  /** Beta of the underlying against the benchmark (§7.11). */
  underlyingBeta: number;
  expiry: string;
  source: 'provider' | 'computed';
}

export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netRho: number;
  /** Delta in shares of the benchmark — the only cross-underlying delta figure
   *  that means anything (§7.11). */
  betaWeightedDelta: number;
  /** Notional exposure implied by delta, in the underlying's currency. */
  deltaNotional: number;
  vegaByExpiry: Array<{ expiry: string; vega: number }>;
  thetaPerDay: number;
  computedCount: number;
  providerCount: number;
}

export function aggregateGreeks(
  positions: OptionPosition[],
  benchmarkPrice: number,
): PortfolioGreeks {
  const scale = (p: OptionPosition) => p.contracts * p.multiplier;

  const vegaByExpiry = new Map<string, number>();
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;
  let netRho = 0;
  let betaWeightedDelta = 0;
  let deltaNotional = 0;
  let computedCount = 0;
  let providerCount = 0;

  for (const p of positions) {
    const n = scale(p);
    netDelta += p.greeks.delta * n;
    netGamma += p.greeks.gamma * n;
    netTheta += p.greeks.theta * n;
    netVega += p.greeks.vega * n;
    netRho += p.greeks.rho * n;
    deltaNotional += p.greeks.delta * n * p.underlyingSpot;

    // Beta-weighted delta: convert each position's delta exposure into
    // equivalent benchmark shares, so a 100-delta position in a 0.5-beta name
    // is not treated as equal to one in a 2.0-beta name.
    if (benchmarkPrice > 0) {
      betaWeightedDelta +=
        (p.greeks.delta * n * p.underlyingSpot * p.underlyingBeta) / benchmarkPrice;
    }

    vegaByExpiry.set(p.expiry, (vegaByExpiry.get(p.expiry) ?? 0) + p.greeks.vega * n);
    p.source === 'computed' ? computedCount++ : providerCount++;
  }

  return {
    netDelta,
    netGamma,
    netTheta,
    netVega,
    netRho,
    betaWeightedDelta,
    deltaNotional,
    thetaPerDay: netTheta / 365,
    vegaByExpiry: [...vegaByExpiry.entries()]
      .map(([expiry, vega]) => ({ expiry, vega }))
      .sort((a, b) => a.expiry.localeCompare(b.expiry)),
    computedCount,
    providerCount,
  };
}

/**
 * Delta and gamma across a ±20% move in the underlying (§7.11).
 *
 * The profile is what shows convexity: a position that looks delta-neutral at
 * spot can be sharply directional 10% away, and a single-point delta never
 * reveals that.
 */
export function riskProfile(
  positions: OptionPosition[],
  spotBy: Map<number, number>,
  steps = 21,
  range = 0.2,
): Array<{ shift: number; delta: number; gamma: number; value: number }> {
  const out: Array<{ shift: number; delta: number; gamma: number; value: number }> = [];

  for (let i = 0; i < steps; i++) {
    const shift = -range + (2 * range * i) / (steps - 1);
    let delta = 0;
    let gamma = 0;
    let value = 0;

    for (const p of positions) {
      const baseSpot = spotBy.get(p.underlyingId) ?? p.underlyingSpot;
      const spot = baseSpot * (1 + shift);
      const years = yearsUntil(p.expiry);
      const vol = impliedFromPosition(p);
      const g = blackScholes({
        spot,
        strike: p.strike,
        years,
        rate: 0.04,
        volatility: vol,
        right: p.right,
      });
      const n = p.contracts * p.multiplier;
      delta += g.delta * n;
      gamma += g.gamma * n;
      value += g.price * n;
    }

    out.push({ shift, delta, gamma, value });
  }

  return out;
}

function yearsUntil(expiry: string, from: Date = new Date()): number {
  const days = (Date.parse(expiry) - from.getTime()) / 86_400_000;
  return Math.max(days / 365, 1 / 365 / 24);
}

/** Recover the volatility implied by a position's stored Greeks. */
function impliedFromPosition(p: OptionPosition): number {
  if (p.greeks.vega <= 0 || p.greeks.gamma <= 0) return 0.3;
  // vega / (S² · T · gamma) = σ, from the standard identity vega = S²·T·σ·gamma.
  const years = yearsUntil(p.expiry);
  const implied = p.greeks.vega / (p.underlyingSpot ** 2 * years * p.greeks.gamma);
  return Number.isFinite(implied) && implied > 0.01 && implied < 5 ? implied : 0.3;
}
