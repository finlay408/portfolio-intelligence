/**
 * Contribution and attribution (CLAUDE.md §7.3).
 *
 * Single-period contribution is straightforward: c_{i,t} = w_{i,t-1} · r_{i,t},
 * and those sum to the portfolio return for the day.
 *
 * Aggregating across time is where retail tools go wrong. Summing daily
 * contributions over a year does not reconcile to the compounded total return.
 * The identity that does hold is
 *
 *   Π(1 + r_t) - 1  =  Σ_t r_t · Π_{s<t}(1 + r_s)
 *
 * so each day's contribution is scaled by the cumulative growth factor up to
 * the START of that day before being summed. That is exact — the reconciliation
 * test passes to floating-point precision, not to "within 1bp".
 *
 * Anything the holdings do not explain (cash drag, fees, a price gap) is not
 * smeared across positions. It gets its own visible `residual` line.
 */
import { Decimal, ONE, ZERO, divOrZero } from '../decimal';
import type { IsoDate } from '../types';

export const RESIDUAL_KEY = '__residual__';

export interface InstrumentDay {
  instrumentId: number;
  /** Weight at the START of the day, as a fraction of portfolio value. */
  weightStart: Decimal;
  /** Local-currency price return for the day. */
  localReturn: Decimal;
  /** FX return of the quote currency against GBP for the day. */
  fxReturn: Decimal;
}

export interface PortfolioDay {
  date: IsoDate;
  /** Total portfolio return for the day, GBP, from the TWR series. */
  portfolioReturn: Decimal;
  instruments: InstrumentDay[];
}

export interface ContributionParts {
  total: Decimal;
  asset: Decimal;
  fx: Decimal;
  cross: Decimal;
}

const zeroParts = (): ContributionParts => ({
  total: ZERO,
  asset: ZERO,
  fx: ZERO,
  cross: ZERO,
});

function addParts(a: ContributionParts, b: ContributionParts): ContributionParts {
  return {
    total: a.total.plus(b.total),
    asset: a.asset.plus(b.asset),
    fx: a.fx.plus(b.fx),
    cross: a.cross.plus(b.cross),
  };
}

function scaleParts(p: ContributionParts, k: Decimal): ContributionParts {
  return {
    total: p.total.times(k),
    asset: p.asset.times(k),
    fx: p.fx.times(k),
    cross: p.cross.times(k),
  };
}

/** Split one instrument-day's contribution into asset, FX and cross terms. */
export function dayContribution(row: InstrumentDay): ContributionParts {
  const asset = row.weightStart.times(row.localReturn);
  const fx = row.weightStart.times(row.fxReturn);
  const cross = row.weightStart.times(row.localReturn.times(row.fxReturn));
  return { total: asset.plus(fx).plus(cross), asset, fx, cross };
}

export type Grouper = (instrumentId: number) => Array<{ key: string; weight: Decimal }>;

/** The trivial grouper: one bucket per instrument. */
export const byInstrument: Grouper = (id) => [{ key: String(id), weight: ONE }];

export interface AttributionResult {
  /** Group key -> contribution, chain-linked across the whole window. */
  groups: Map<string, ContributionParts>;
  /** Compounded portfolio return over the window. */
  totalReturn: Decimal;
  /** Sum of group contributions. Equals totalReturn by construction. */
  explained: Decimal;
  /** totalReturn - explained. Should be zero; kept so drift is visible. */
  reconciliationGap: Decimal;
  days: number;
}

/**
 * @param grouper maps an instrument to one or more buckets with weights.
 *   Themes use partial weights, so an instrument can land in two buckets at 0.6
 *   and 0.4. Weights that do not sum to 1 leave the remainder in `residual`,
 *   which is the honest treatment of an instrument tagged with only one theme
 *   at weight 0.5.
 */
export function attribute(days: PortfolioDay[], grouper: Grouper): AttributionResult {
  const groups = new Map<string, ContributionParts>();
  let growth = ONE; // Π(1 + r_s) for s < t

  const bump = (key: string, parts: ContributionParts) => {
    groups.set(key, addParts(groups.get(key) ?? zeroParts(), parts));
  };

  for (const day of days) {
    let explainedToday = ZERO;

    for (const row of day.instruments) {
      const parts = dayContribution(row);
      const buckets = grouper(row.instrumentId);
      let assigned = ZERO;
      for (const b of buckets) {
        if (b.weight.lessThanOrEqualTo(0)) continue;
        bump(b.key, scaleParts(scaleParts(parts, b.weight), growth));
        assigned = assigned.plus(b.weight);
      }
      const unassigned = ONE.minus(assigned);
      if (unassigned.greaterThan(0)) {
        bump(RESIDUAL_KEY, scaleParts(scaleParts(parts, unassigned), growth));
      }
      explainedToday = explainedToday.plus(parts.total);
    }

    // Cash drag, fees and anything else the holdings do not account for.
    const gap = day.portfolioReturn.minus(explainedToday);
    if (!gap.isZero()) {
      bump(RESIDUAL_KEY, scaleParts({ total: gap, asset: gap, fx: ZERO, cross: ZERO }, growth));
    }

    growth = growth.times(ONE.plus(day.portfolioReturn));
  }

  const totalReturn = growth.minus(ONE);
  const explained = [...groups.values()].reduce<Decimal>((a, p) => a.plus(p.total), ZERO);

  return {
    groups,
    totalReturn,
    explained,
    reconciliationGap: totalReturn.minus(explained),
    days: days.length,
  };
}

/* ---------------- Ready-made groupers ---------------- */

export interface InstrumentMeta {
  id: number;
  sector: string | null;
  /** A fund's look-through sector split, weights of any scale. Null for an equity. */
  sectorWeights?: Record<string, number> | null;
  country: string | null;
  currency: string;
  assetClass: string;
  revenueRegions: Record<string, number> | null;
  /** [{ themeId/name, weight }] with weights summing to <= 1. */
  themes: Array<{ key: string; weight: Decimal }>;
}

export function makeGroupers(meta: Map<number, InstrumentMeta>) {
  const single =
    (pick: (m: InstrumentMeta) => string | null): Grouper =>
    (id) => {
      const m = meta.get(id);
      const key = (m && pick(m)) || 'Unclassified';
      return [{ key, weight: ONE }];
    };

  /**
   * Split one instrument across several buckets. Weights are renormalised to
   * sum to 1 so that no instrument can contribute more or less than its own
   * return to the grid — that invariant is what makes attribution reconcile.
   */
  const spread = (
    weights: Record<string, number> | null | undefined,
    fallback: string,
  ): Array<{ key: string; weight: Decimal }> => {
    if (!weights || Object.keys(weights).length === 0) return [{ key: fallback, weight: ONE }];
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    if (total <= 0) return [{ key: fallback, weight: ONE }];
    return Object.entries(weights).map(([key, w]) => ({
      key,
      weight: divOrZero(new Decimal(w), new Decimal(total)),
    }));
  };

  return {
    /**
     * Funds are looked through to their holdings' sectors. An all-world tracker
     * is not one sector, and before the look-through existed it was the largest
     * "Unclassified" row in the grid — the position most in need of explaining,
     * explaining nothing.
     */
    sector: ((id) => {
      const m = meta.get(id);
      if (m?.sectorWeights && Object.keys(m.sectorWeights).length > 0) {
        return spread(m.sectorWeights, 'Unclassified');
      }
      return [{ key: m?.sector || 'Unclassified', weight: ONE }];
    }) as Grouper,
    /** Listing venue. Shown alongside, never instead of, revenue geography. */
    listingCountry: single((m) => m.country),
    currency: single((m) => m.currency),
    assetClass: single((m) => m.assetClass),
    theme: ((id) => meta.get(id)?.themes ?? [{ key: 'Untagged', weight: ONE }]) as Grouper,
    /**
     * True geographic exposure. An LSE-listed miner with 90% Chilean revenue is
     * not UK exposure, and this is the grouper that says so.
     */
    revenueGeography: ((id) =>
      spread(meta.get(id)?.revenueRegions, 'Unmapped')) as Grouper,
  };
}

/* ---------------- Calendar breakdown ---------------- */

export interface PeriodReturn {
  period: string;
  ret: Decimal;
  days: number;
}

/** Compound daily returns inside each calendar bucket (month, quarter, year). */
export function periodReturns(
  days: PortfolioDay[],
  keyOf: (d: IsoDate) => string,
): PeriodReturn[] {
  const buckets = new Map<string, { growth: Decimal; days: number }>();
  for (const d of days) {
    const key = keyOf(d.date);
    const cur = buckets.get(key) ?? { growth: ONE, days: 0 };
    cur.growth = cur.growth.times(ONE.plus(d.portfolioReturn));
    cur.days += 1;
    buckets.set(key, cur);
  }
  return [...buckets.entries()]
    .map(([period, v]) => ({ period, ret: v.growth.minus(ONE), days: v.days }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** Top and bottom contributors for a window. */
export function rankContributors(
  result: AttributionResult,
  limit = 5,
): { top: Array<[string, ContributionParts]>; bottom: Array<[string, ContributionParts]> } {
  const rows = [...result.groups.entries()].filter(([k]) => k !== RESIDUAL_KEY);
  const sorted = rows.sort((a, b) => b[1].total.comparedTo(a[1].total));
  return {
    top: sorted.slice(0, limit),
    bottom: sorted.slice(-limit).reverse(),
  };
}
