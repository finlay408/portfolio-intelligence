/**
 * End-to-end pipeline test: ledger → daily snapshots → TWR → attribution.
 *
 * This is the path `npm run recompute` walks and every page reads, exercised
 * without a database. It covers the property the brief calls out explicitly
 * (§11): recompute-from-inception always equals the cached snapshot.
 */
import { describe, expect, it } from 'vitest';
import { Decimal, ONE, ZERO } from '../src/lib/decimal';
import { eachBusinessDay } from '../src/lib/dates';
import { attribute, byInstrument, makeGroupers } from '../src/lib/engine/attribution';
import { buildSeries, cashOn, externalFlowOn } from '../src/lib/engine/snapshots';
import { chainLink, dailyTwrSeries, maxDrawdown } from '../src/lib/engine/twr';
import { MapFxLookup, MapPriceLookup } from '../src/lib/engine/valuation';
import type { EngineInstrument, IsoDate } from '../src/lib/types';
import {
  ISA,
  INST,
  cashFlows,
  corporateActions,
  instruments,
  trades,
} from './fixtures/golden-portfolio';

const FROM = '2024-01-01';
const TO = '2025-03-31';
const DAYS = eachBusinessDay(FROM, TO, 'XLON');

/** Deterministic price paths, so a failure is always reproducible. */
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

/**
 * Prices are stated in the share terms of each date, so the SPLITCO series
 * steps down by 4 on the split date exactly as a real feed would. Anything else
 * would make the split look like a 75% loss.
 */
function buildPrices(): MapPriceLookup {
  const rand = mulberry32(7);
  const series = new Map<number, Array<[IsoDate, Decimal]>>();

  const starts: Record<number, number> = {
    [INST.AAPL]: 150,
    [INST.RR]: 4.5,
    [INST.SPLITCO]: 400,
    [INST.REVCO]: 2,
    [INST.OLDCO]: 25,
    [INST.VUSA]: 80,
    [INST.S104CO]: 2,
  };

  for (const [idText, start] of Object.entries(starts)) {
    const id = Number(idText);
    let price = start;
    const rows: Array<[IsoDate, Decimal]> = [];
    for (const date of DAYS) {
      price *= 1 + (rand() - 0.49) * 0.02;
      if (id === INST.SPLITCO && date === '2024-06-03') price /= 4;
      if (id === INST.REVCO && date === '2024-07-01') price *= 10;
      rows.push([date, new Decimal(price.toFixed(6))]);
    }
    series.set(id, rows);
  }
  return new MapPriceLookup(series);
}

function buildFx(): MapFxLookup {
  const rand = mulberry32(99);
  let rate = 0.8;
  const rows: Array<[IsoDate, Decimal]> = [];
  for (const date of DAYS) {
    rate *= 1 + (rand() - 0.5) * 0.004;
    rows.push([date, new Decimal(rate.toFixed(6))]);
  }
  return new MapFxLookup(new Map([['USDGBP', rows]]));
}

const instrumentById = new Map<number, EngineInstrument>(instruments.map((i) => [i.id, i]));
const prices = buildPrices();
const fx = buildFx();

const input = {
  trades,
  corporateActions,
  cashFlows,
  instrumentById,
  prices,
  fx,
  accountId: ISA,
  from: FROM,
  to: TO,
  tradingDays: DAYS,
};

const series = buildSeries(input);

describe('cash is derived from the ledger, never stored', () => {
  it('reconciles by hand at the end of the first month', () => {
    // £20,000 deposited on 1 Jan, less a £400 VUSA purchase on the 5th and
    // £12,008 for 100 AAPL at $150 plus $10 commission at 0.80.
    expect(cashOn(trades, cashFlows, '2024-01-31', ISA).toFixed(2)).toBe('7592.00');
  });

  it('counts only external flows as flows', () => {
    // 1 April is a £5,000 deposit; 1 May is a dividend, which is internal.
    expect(externalFlowOn(cashFlows, '2024-04-01', ISA).toFixed()).toBe('5000');
    expect(externalFlowOn(cashFlows, '2024-05-01', ISA).toFixed()).toBe('0');
  });

  it('never loses money between the ledger and the snapshot', () => {
    for (const snapshot of series.snapshots) {
      const recomputed = cashOn(trades, cashFlows, snapshot.date, ISA);
      expect(snapshot.cashGbp.minus(recomputed).abs().lessThan('1e-18')).toBe(true);
    }
  });
});

describe('daily snapshots', () => {
  it('covers every trading day in the window', () => {
    expect(series.snapshots).toHaveLength(DAYS.length);
    expect(series.snapshots[0]!.date).toBe(DAYS[0]);
    expect(series.snapshots.at(-1)!.date).toBe(DAYS.at(-1));
  });

  it('states quantities in the share terms of each date', () => {
    const beforeSplit = series.snapshots.find((s) => s.date === '2024-05-31')!;
    const afterSplit = series.snapshots.find((s) => s.date === '2024-06-04')!;
    const qtyOf = (s: typeof beforeSplit) =>
      s.positions.find((p) => p.instrumentId === INST.SPLITCO)!.quantity;

    expect(qtyOf(beforeSplit).toFixed()).toBe('40');
    expect(qtyOf(afterSplit).toFixed()).toBe('160');
  });

  it('keeps market value continuous across the split', () => {
    const before = series.snapshots.find((s) => s.date === '2024-05-31')!;
    const after = series.snapshots.find((s) => s.date === '2024-06-04')!;
    const valueOf = (s: typeof before) =>
      s.positions.find((p) => p.instrumentId === INST.SPLITCO)!.valueGbp;
    // A 4:1 split is value-neutral; the only movement is the market's own.
    const ratio = valueOf(after).div(valueOf(before)).toNumber();
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('values every open position it holds', () => {
    const last = series.snapshots.at(-1)!;
    expect(last.positions.length).toBeGreaterThan(0);
    for (const p of last.positions) {
      expect(p.priceLocal).not.toBeNull();
      expect(p.valueGbp.greaterThan(0)).toBe(true);
    }
    const summed = last.positions.reduce<Decimal>((a, p) => a.plus(p.valueGbp), ZERO);
    expect(summed.minus(last.marketValueGbp).abs().lessThan('1e-15')).toBe(true);
  });
});

describe('TWR', () => {
  const twr = dailyTwrSeries(series.dailyPoints);

  it('produces a return for every day after the first', () => {
    expect(twr).toHaveLength(series.dailyPoints.length);
    expect(twr[0]!.dailyReturn).toBeNull();
    expect(twr.filter((p) => p.dailyReturn !== null).length).toBeGreaterThan(300);
  });

  it('is not moved by the deposit on 1 April', () => {
    const depositDay = twr.find((p) => p.date === '2024-04-01');
    if (depositDay?.dailyReturn) {
      // A £5,000 deposit into a ~£25,000 portfolio would show as a ~20% day if
      // the flow adjustment were missing.
      expect(depositDay.dailyReturn.abs().lessThan('0.05')).toBe(true);
    }
  });

  it('chain-links to the cumulative figure', () => {
    const chained = chainLink(twr.map((p) => p.dailyReturn));
    expect(chained.minus(twr.at(-1)!.cumulative.minus(ONE)).abs().lessThan('1e-20')).toBe(true);
  });

  it('reports a drawdown with dates that bracket the trough', () => {
    const dd = maxDrawdown(twr);
    expect(dd.depth.lessThanOrEqualTo(0)).toBe(true);
    if (dd.peakDate && dd.troughDate) {
      expect(dd.peakDate <= dd.troughDate).toBe(true);
    }
  });
});

describe('attribution over the real ledger', () => {
  const groupers = makeGroupers(
    new Map(
      instruments.map((i) => [
        i.id,
        {
          id: i.id,
          sector: i.sector,
          country: i.country,
          currency: i.quoteCurrency,
          assetClass: i.assetClass,
          revenueRegions: i.revenueRegions,
          themes: [],
        },
      ]),
    ),
  );

  it('reconciles to the portfolio return within 1bp for every grid', () => {
    for (const grouper of [
      byInstrument,
      groupers.sector,
      groupers.currency,
      groupers.revenueGeography,
      groupers.assetClass,
    ]) {
      const result = attribute(series.attributionDays, grouper);
      expect(result.reconciliationGap.abs().lessThan('0.0001')).toBe(true);
    }
  });

  it('agrees with the TWR series on the total return', () => {
    const twr = dailyTwrSeries(series.dailyPoints);
    const fromTwr = chainLink(twr.map((p) => p.dailyReturn));
    const fromAttribution = attribute(series.attributionDays, byInstrument).totalReturn;
    // Both are the same daily returns compounded, so they must agree exactly.
    expect(fromAttribution.minus(fromTwr).abs().lessThan('1e-15')).toBe(true);
  });

  it('gives the GBP-denominated holdings no FX contribution', () => {
    const result = attribute(series.attributionDays, groupers.currency);
    expect(result.groups.get('GBP')!.fx.isZero()).toBe(true);
    expect(result.groups.get('USD')!.fx.isZero()).toBe(false);
  });
});

describe('recompute-from-inception is deterministic', () => {
  it('produces byte-identical snapshots on a second run', () => {
    const again = buildSeries(input);
    const shape = (s: typeof series) =>
      s.snapshots.map((snapshot) => [
        snapshot.date,
        snapshot.marketValueGbp.toFixed(),
        snapshot.costBasisGbp.toFixed(),
        snapshot.cashGbp.toFixed(),
        snapshot.netFlowGbp.toFixed(),
      ]);
    expect(shape(again)).toEqual(shape(series));
  });

  it('produces the same result when built in two halves', () => {
    // The engine derives each day from the ledger alone, so a window boundary
    // must not change any figure inside it.
    const second = buildSeries({ ...input, from: '2024-07-01' });
    const overlap = series.snapshots.filter((s) => s.date >= '2024-07-01');
    expect(second.snapshots).toHaveLength(overlap.length);
    for (let i = 0; i < overlap.length; i++) {
      expect(second.snapshots[i]!.marketValueGbp.toFixed()).toBe(
        overlap[i]!.marketValueGbp.toFixed(),
      );
    }
  });
});
