/**
 * Money-weighted return — XIRR (CLAUDE.md §7.2).
 *
 * With regular auto-invest contributions, MWR and TWR diverge materially, and
 * showing only one of them is the most common analytical error in retail
 * portfolio tools. This solves the standard XIRR equation:
 *
 *   0 = Σ cf_i / (1 + r)^(d_i / 365)
 *
 * Newton-Raphson converges in a handful of iterations on well-behaved flow
 * series and diverges spectacularly on the pathological ones — a large late
 * deposit, alternating signs, a near-total loss. Bisection is the fallback: it
 * is slower but cannot diverge, given a bracketing interval.
 *
 * Returns null rather than a number when no rate exists (all flows one sign) or
 * when no root can be bracketed. A null is displayed as "n/a"; a fabricated
 * figure would be worse.
 */
import type { IsoDate } from '../types';

export interface XirrFlow {
  date: IsoDate;
  /** Signed, GBP. Money into the portfolio is negative; value out is positive. */
  amount: number;
}

const DAYS_PER_YEAR = 365;
/** Rates below this imply losing more than everything, which is not solvable. */
const MIN_RATE = -0.999999;
const MAX_RATE = 1e6;

function npv(flows: Array<{ years: number; amount: number }>, rate: number): number {
  let acc = 0;
  for (const f of flows) acc += f.amount / Math.pow(1 + rate, f.years);
  return acc;
}

function dNpv(flows: Array<{ years: number; amount: number }>, rate: number): number {
  let acc = 0;
  for (const f of flows) acc += (-f.years * f.amount) / Math.pow(1 + rate, f.years + 1);
  return acc;
}

export interface XirrOptions {
  guess?: number;
  tolerance?: number;
  maxIterations?: number;
}

export function xirr(flows: XirrFlow[], options: XirrOptions = {}): number | null {
  const tolerance = options.tolerance ?? 1e-9;
  const maxIterations = options.maxIterations ?? 100;

  const cleaned = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  if (cleaned.length < 2) return null;

  const hasPositive = cleaned.some((f) => f.amount > 0);
  const hasNegative = cleaned.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return null; // no sign change: no rate exists

  const t0 = Date.parse(cleaned.reduce((a, b) => (a.date < b.date ? a : b)).date);
  const norm = cleaned.map((f) => ({
    years: (Date.parse(f.date) - t0) / 86_400_000 / DAYS_PER_YEAR,
    amount: f.amount,
  }));

  // ---- Newton-Raphson ----
  let rate = options.guess ?? 0.1;
  for (let i = 0; i < maxIterations; i++) {
    const value = npv(norm, rate);
    if (!Number.isFinite(value)) break;
    if (Math.abs(value) < tolerance) return rate;
    const slope = dNpv(norm, rate);
    if (!Number.isFinite(slope) || Math.abs(slope) < 1e-14) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= MIN_RATE || next > MAX_RATE) break;
    if (Math.abs(next - rate) < tolerance) return next;
    rate = next;
  }

  // ---- Bisection fallback ----
  return bisect(norm, tolerance);
}

function bisect(
  flows: Array<{ years: number; amount: number }>,
  tolerance: number,
): number | null {
  // Expand outwards from zero until the NPV changes sign.
  let lo = MIN_RATE + 1e-9;
  let hi = 1;
  let fLo = npv(flows, lo);
  let fHi = npv(flows, hi);

  let expansions = 0;
  while (Number.isFinite(fLo) && Number.isFinite(fHi) && fLo * fHi > 0 && expansions < 200) {
    hi = hi * 2 + 1;
    if (hi > MAX_RATE) return null;
    fHi = npv(flows, hi);
    expansions++;
  }
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return null;

  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(flows, mid);
    if (Math.abs(fMid) < tolerance || hi - lo < tolerance) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Build the flow series for a portfolio MWR: every external deposit and
 * withdrawal, plus the terminal market value as a synthetic inflow.
 *
 * Note the sign convention — deposits are money leaving the owner's pocket, so
 * they enter as negative. Getting this backwards produces a plausible-looking
 * number with the wrong sign, which is why it lives in one place.
 */
export function portfolioMwr(
  externalFlows: Array<{ date: IsoDate; depositGbp: number }>,
  terminal: { date: IsoDate; valueGbp: number },
  options: XirrOptions = {},
): number | null {
  const flows: XirrFlow[] = externalFlows.map((f) => ({
    date: f.date,
    amount: -f.depositGbp,
  }));
  flows.push({ date: terminal.date, amount: terminal.valueGbp });
  return xirr(flows, options);
}
