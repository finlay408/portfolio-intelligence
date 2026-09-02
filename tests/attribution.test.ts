/**
 * Property test (CLAUDE.md §11): attribution always sums to total return.
 *
 * Every grid — theme, sector, geography, currency, position — must reconcile to
 * the compounded portfolio return to within 1bp. The chain-linked construction
 * makes it exact, so the assertions here are far tighter than 1bp; the 1bp
 * threshold is asserted separately as the contract the brief specifies.
 */
import { describe, expect, it } from 'vitest';
import { Decimal, ONE, ZERO } from '../src/lib/decimal';
import {
  RESIDUAL_KEY,
  attribute,
  byInstrument,
  dayContribution,
  makeGroupers,
  periodReturns,
  rankContributors,
  type InstrumentMeta,
  type PortfolioDay,
} from '../src/lib/engine/attribution';
import { monthKey, quarterKey } from '../src/lib/dates';

const d = (v: string | number) => new Decimal(v);
const ONE_BP = new Decimal('0.0001');

/** A deterministic pseudo-random walk, so failures are reproducible. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDays(count: number, seed = 42): PortfolioDay[] {
  const rand = mulberry32(seed);
  const ids = [1, 2, 3, 4, 5];
  const days: PortfolioDay[] = [];

  for (let i = 0; i < count; i++) {
    // Weights drift each day and always sum to 1 (fully invested, no cash).
    const raw = ids.map(() => 0.5 + rand());
    const total = raw.reduce((a, b) => a + b, 0);

    const instruments = ids.map((instrumentId, k) => ({
      instrumentId,
      weightStart: d(raw[k]! / total),
      localReturn: d((rand() - 0.5) * 0.04),
      fxReturn: d(instrumentId <= 2 ? (rand() - 0.5) * 0.012 : 0),
    }));

    const portfolioReturn = instruments
      .map(dayContribution)
      .reduce<Decimal>((a, p) => a.plus(p.total), ZERO);

    const date = new Date(Date.UTC(2024, 0, 2 + i)).toISOString().slice(0, 10);
    days.push({ date, portfolioReturn, instruments });
  }
  return days;
}

const meta = new Map<number, InstrumentMeta>([
  [1, { id: 1, sector: 'Information Technology', country: 'US', currency: 'USD', assetClass: 'equity', revenueRegions: { US: 0.6, EU: 0.4 }, themes: [{ key: 'Photonics', weight: ONE }] }],
  [2, { id: 2, sector: 'Industrials', country: 'GB', currency: 'USD', assetClass: 'equity', revenueRegions: { US: 0.5, APAC: 0.5 }, themes: [{ key: 'Defence', weight: d('0.6') }, { key: 'Photonics', weight: d('0.4') }] }],
  [3, { id: 3, sector: 'Industrials', country: 'GB', currency: 'GBP', assetClass: 'equity', revenueRegions: { UK: 0.2, LATAM: 0.8 }, themes: [{ key: 'Critical Minerals', weight: d('0.5') }] }],
  // A fund: no single sector, a look-through split instead. It must divide
  // across sector buckets without the grid ceasing to reconcile.
  [4, { id: 4, sector: null, sectorWeights: { Technology: 0.31, 'Financial Services': 0.17, Industrials: 0.11, Healthcare: 0.08, Cash: 0.0026 }, country: 'IE', currency: 'GBP', assetClass: 'etf', revenueRegions: { US: 1 }, themes: [] }],
  [5, { id: 5, sector: 'Health Care', country: 'US', currency: 'GBP', assetClass: 'equity', revenueRegions: null, themes: [{ key: 'Defence', weight: ONE }] }],
]);

const groupers = makeGroupers(meta);
const days = buildDays(504); // ~17 calendar months of consecutive days

describe('attribution reconciles to total return', () => {
  const grids = {
    position: byInstrument,
    sector: groupers.sector,
    'listing country': groupers.listingCountry,
    'revenue geography': groupers.revenueGeography,
    currency: groupers.currency,
    'asset class': groupers.assetClass,
    theme: groupers.theme,
  };

  for (const [name, grouper] of Object.entries(grids)) {
    it(`${name} grid reconciles within 1bp`, () => {
      const result = attribute(days, grouper);
      expect(result.reconciliationGap.abs().lessThan(ONE_BP)).toBe(true);
    });

    it(`${name} grid reconciles to floating-point precision, not just to 1bp`, () => {
      const result = attribute(days, grouper);
      expect(result.reconciliationGap.abs().lessThan('1e-20')).toBe(true);
    });
  }

  it('the compounded total is not the naive sum of daily returns', () => {
    const result = attribute(days, byInstrument);
    const naiveSum = days.reduce<Decimal>((a, day) => a.plus(day.portfolioReturn), ZERO);
    // If these were equal the chain-linking would be doing nothing.
    expect(result.totalReturn.minus(naiveSum).abs().greaterThan(ONE_BP)).toBe(true);
  });

  it('splits each contribution into asset, FX and cross terms that sum to the total', () => {
    const result = attribute(days, byInstrument);
    for (const [, parts] of result.groups) {
      const recombined = parts.asset.plus(parts.fx).plus(parts.cross);
      expect(recombined.minus(parts.total).abs().lessThan('1e-24')).toBe(true);
    }
  });

  it('assigns FX contribution only to the non-GBP holdings', () => {
    const result = attribute(days, byInstrument);
    // Instruments 3-5 have no FX movement in the fixture.
    for (const id of ['3', '4', '5']) {
      expect(result.groups.get(id)!.fx.isZero()).toBe(true);
    }
    expect(result.groups.get('1')!.fx.isZero()).toBe(false);
  });
});

describe('partial theme membership', () => {
  it('routes the unassigned share to residual rather than inventing a bucket', () => {
    const result = attribute(days, groupers.theme);
    // Instrument 3 is only 50% tagged and instrument 4 is untagged, so residual
    // must be non-trivial — and the grid must still reconcile.
    expect(result.groups.has(RESIDUAL_KEY)).toBe(true);
    expect(result.reconciliationGap.abs().lessThan('1e-20')).toBe(true);
  });

  it('honours the declared weights', () => {
    const single = attribute(days, (id) =>
      id === 2 ? [{ key: 'Defence', weight: d('0.6') }] : [],
    );
    const double = attribute(days, (id) =>
      id === 2 ? [{ key: 'Defence', weight: d('1') }] : [],
    );
    const ratio = single.groups.get('Defence')!.total.div(double.groups.get('Defence')!.total);
    expect(ratio.minus('0.6').abs().lessThan('1e-20')).toBe(true);
  });
});

describe('fund look-through', () => {
  it('spreads a fund across its holdings\' sectors instead of Unclassified', () => {
    const result = attribute(days, groupers.sector);
    // Instrument 4 is the only fund and has no scalar sector. If look-through
    // were not happening it would be the whole 'Unclassified' row.
    expect(result.groups.has('Unclassified')).toBe(false);
    expect(result.groups.has('Cash')).toBe(true);
    expect(result.reconciliationGap.abs().lessThan('1e-20')).toBe(true);
  });

  it('gives the fund exactly its own return, no more and no less', () => {
    // A fund's weights are renormalised, so the sum of its sector slices must
    // equal its position contribution. Anything else double-counts it.
    const positions = attribute(days, byInstrument);
    const fundOnly = attribute(days, (id) => (id === 4 ? groupers.sector(id) : []));
    const spread = [...fundOnly.groups]
      .filter(([key]) => key !== RESIDUAL_KEY)
      .reduce<Decimal>((a, [, p]) => a.plus(p.total), ZERO);
    expect(spread.minus(positions.groups.get('4')!.total).abs().lessThan('1e-20')).toBe(true);
  });

  it('falls back to the scalar sector when a fund has no breakdown', () => {
    const noWeights = new Map(meta);
    noWeights.set(4, { ...meta.get(4)!, sectorWeights: null, sector: 'Fixed Income' });
    const result = attribute(days, makeGroupers(noWeights).sector);
    expect(result.groups.has('Fixed Income')).toBe(true);
    expect(result.groups.has('Cash')).toBe(false);
  });
});

describe('cash drag and fees land in residual, not smeared across positions', () => {
  it('surfaces an unexplained gap as its own line', () => {
    const withDrag = days.map((day) => ({
      ...day,
      portfolioReturn: day.portfolioReturn.minus('0.00002'), // a fee, every day
    }));
    const result = attribute(withDrag, byInstrument);
    const residual = result.groups.get(RESIDUAL_KEY)!;
    expect(residual.total.lessThan(0)).toBe(true);
    expect(result.reconciliationGap.abs().lessThan('1e-20')).toBe(true);
  });
});

describe('calendar breakdowns', () => {
  it('compounds inside each month and chains across them', () => {
    const months = periodReturns(days, monthKey);
    expect(months.length).toBeGreaterThan(12);
    const chained = months.reduce<Decimal>((a, m) => a.times(ONE.plus(m.ret)), ONE).minus(ONE);
    const total = attribute(days, byInstrument).totalReturn;
    expect(chained.minus(total).abs().lessThan('1e-20')).toBe(true);
  });

  it('produces quarters that chain to the same total', () => {
    const quarters = periodReturns(days, quarterKey);
    const chained = quarters.reduce<Decimal>((a, q) => a.times(ONE.plus(q.ret)), ONE).minus(ONE);
    const total = attribute(days, byInstrument).totalReturn;
    expect(chained.minus(total).abs().lessThan('1e-20')).toBe(true);
  });
});

describe('contributor ranking', () => {
  it('excludes residual from top and bottom contributors', () => {
    const result = attribute(days, byInstrument);
    const { top, bottom } = rankContributors(result, 3);
    expect(top.map(([k]) => k)).not.toContain(RESIDUAL_KEY);
    expect(bottom.map(([k]) => k)).not.toContain(RESIDUAL_KEY);
    expect(top[0]![1].total.greaterThanOrEqualTo(bottom[0]![1].total)).toBe(true);
  });
});
